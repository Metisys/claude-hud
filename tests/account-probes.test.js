import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CODEX_CACHE_MS, codexCommand, codexUsage, readRelayState, refreshCodexUsage, relayPrefer } from '../collector.mjs';

async function serve(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/_relay/state`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('readRelayState returns the state JSON', () => serve((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ tokens: [{ var: 'T', unified: { '5h-utilization': '0.1' } }] }));
}, async (url) => {
  assert.deepEqual(await readRelayState(url), { tokens: [{ var: 'T', unified: { '5h-utilization': '0.1' } }] });
}));

test('readRelayState gives up after its timeout, with null', () => serve(() => { /* never answers */ }, async (url) => {
  const start = Date.now();
  assert.equal(await readRelayState(url, 200), null);
  assert.ok(Date.now() - start < 1500, 'the status line does not wait for a hung relay');
}));

test('readRelayState is null when nothing listens or the answer is not JSON', async () => {
  assert.equal(await readRelayState('http://127.0.0.1:9/_relay/state', 300), null);
  await serve((req, res) => res.end('<html>'), async (url) => assert.equal(await readRelayState(url), null));
});

test('relayPrefer reads x-relay-prefer from ANTHROPIC_CUSTOM_HEADERS', () => {
  assert.equal(relayPrefer({ ANTHROPIC_CUSTOM_HEADERS: 'x-other: 1\nx-relay-prefer: CLAUDE_CODE_OAUTH_TOKEN_GAO2' }), 'CLAUDE_CODE_OAUTH_TOKEN_GAO2');
  assert.equal(relayPrefer({ ANTHROPIC_CUSTOM_HEADERS: 'X-Relay-Prefer:GAO' }), 'GAO');
  assert.equal(relayPrefer({}), null);
});

test('codexCommand runs codex-usage locally on minipc and through ssh elsewhere', () => {
  assert.deepEqual(codexCommand(['--tokens'], 'minipc'), ['codex-usage', ['--tokens']]);
  // The ssh command names the program by its path: a command run through ssh on minipc has no ~/.local/bin on PATH.
  assert.deepEqual(codexCommand([], 'macbook.local'), ['ssh', ['-o', 'RemoteCommand=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'minipc', '.local/bin/codex-usage']]);
  assert.deepEqual(codexCommand(['--tokens'], 'macbook.local')[1].slice(-2), ['.local/bin/codex-usage', '--tokens']);
});

async function withCache(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-codex-'));
  try {
    await fn(path.join(dir, 'codex-usage.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('codexUsage returns the cache at once and starts one refresh when it is old', () => withCache(async (cache) => {
  const now = 1_000_000_000;
  const started = [];
  const refresh = (file) => started.push(file);
  assert.equal(codexUsage(cache, { now, refresh }), null, 'no cache yet');
  assert.equal(started.length, 1, 'a missing cache starts a refresh');
  assert.equal(codexUsage(cache, { now: now + 1000, refresh }), null);
  assert.equal(started.length, 1, 'a running refresh is not started again');

  fs.writeFileSync(cache, JSON.stringify({ at: now, text: '{"account":"a"}\n' }));
  fs.rmSync(`${cache}.refresh`);
  assert.deepEqual(codexUsage(cache, { now: now + 1000, refresh }), { at: now, text: '{"account":"a"}\n' });
  assert.equal(started.length, 1, 'a fresh cache starts nothing');
  assert.deepEqual(codexUsage(cache, { now: now + CODEX_CACHE_MS, refresh }), { at: now, text: '{"account":"a"}\n' }, 'the old values still show');
  assert.equal(started.length, 2, 'an old cache starts a refresh');
}));

test('refreshCodexUsage writes the output, and keeps the old cache when the command fails', () => withCache(async (cache) => {
  fs.writeFileSync(`${cache}.refresh`, '1');
  assert.equal(await refreshCodexUsage(cache, [process.execPath, ['-e', 'console.log(JSON.stringify({account:"a"}))']], () => 42), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')), { at: 42, text: '{"account":"a"}\n' });
  assert.equal(fs.existsSync(`${cache}.refresh`), false, 'the marker is removed');
  assert.equal(await refreshCodexUsage(cache, [process.execPath, ['-e', 'process.exit(255)']], () => 99), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')), { at: 42, text: '{"account":"a"}\n' }, 'minipc did not answer: the old values stay');
}));

test('a refresh marker older than the refresh limit is taken as dead', () => withCache(async (cache) => {
  const started = [];
  fs.writeFileSync(`${cache}.refresh`, '1');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${cache}.refresh`, old, old);
  codexUsage(cache, { now: Date.now(), refresh: (file) => started.push(file) });
  assert.equal(started.length, 1);
}));

test('only `hud usage` gets the codex.tokens probe and the cost ledger', async () => {
  const { createProbes, logicPaths, claudePaths, probesToStart } = await import('../collector.mjs');
  const render = createProbes({ cwd: null, argv: [], env: {} });
  assert.deepEqual(await render(['codex.tokens']), {}, 'a render cannot start ssh for the token table');
  const usage = createProbes({ cwd: null, argv: [], env: {}, codexTokens: true });
  assert.ok('codex.tokens' in await usage(['codex.tokens']), '`hud usage` has it');
  const paths = claudePaths({}, '/home/u');
  assert.equal(logicPaths(paths, null).costs, null);
  assert.equal(logicPaths(paths, null, { costs: true }).costs, '/home/u/.claude/metrics/costs.jsonl');
  const setting = (section, key) => ({ 'display.showAccountUsage': true })[`${section}.${key}`];
  assert.ok(probesToStart(setting).includes('relay.state'), 'the relay request starts with the cage');
  assert.ok(!probesToStart(() => undefined).includes('relay.state'));
});
