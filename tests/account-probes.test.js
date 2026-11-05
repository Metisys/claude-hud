import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CODEX_CACHE_MS, codexCommand, codexHomeState, codexHomeStates, codexServedHome, codexSessionHome, codexUsage, createProbes, readRelayState,
  refreshCodexUsage, relayPrefer } from '../collector.mjs';

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
  assert.deepEqual(codexCommand([], 'macbook.local'), ['ssh', ['-o', 'RemoteCommand=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'minipc', 'codex-usage']]);
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
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')), { at: 42, text: '{"account":"a"}\n', homes: {} });
  assert.equal(fs.existsSync(`${cache}.refresh`), false, 'the marker is removed');
  assert.equal(await refreshCodexUsage(cache, [process.execPath, ['-e', 'process.exit(255)']], () => 99), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(cache, 'utf8')), { at: 42, text: '{"account":"a"}\n', homes: {} }, 'minipc did not answer: the old values stay');
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

// ---- Codex homes: the rollout lines as Codex 0.164 writes them on minipc (2026-11-04).
const T = (iso) => Date.parse(iso);
const meta = (account) => ({ timestamp: '2026-11-04T00:00:00Z', type: 'session_meta', payload: { id: 's', creator_account_id: account } });
const turn = (iso, error = null) => ({ timestamp: iso, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: error ? null : 'ok', error } });
const NO_CREDITS = { message: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.', codex_error_info: 'usage_limit_exceeded' };
const NOT_SUPPORTED = { message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error',
  message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", code: 'model_not_found' } }), codex_error_info: 'other' };

function rollout(home, name, lines) {
  const dir = path.join(home, 'sessions', '2026', '11', name.slice(17, 19));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

async function withHomes(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-codex-homes-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('codexHomeState: the newest unavailable error shows until a later turn succeeds', () => withHomes(async (dir) => {
  const home = path.join(dir, 'a');
  rollout(home, '2026-11-04T12-00-00-a', [meta('A'), turn('2026-11-04T04:00:00Z'), turn('2026-11-04T04:21:00Z', NO_CREDITS)]);
  assert.deepEqual(codexHomeState(home), { account: 'A', unavailable: { reason: 'no credits', at: T('2026-11-04T04:21:00Z') } });
  rollout(home, '2026-11-05T10-00-00-b', [meta('A'), turn('2026-11-05T02:00:00Z', NOT_SUPPORTED)]);
  assert.deepEqual(codexHomeState(home).unavailable, { reason: 'model not supported', at: T('2026-11-05T02:00:00Z') });
  rollout(home, '2026-11-05T11-00-00-c', [meta('A'), turn('2026-11-05T03:00:00Z')]);
  assert.equal(codexHomeState(home).unavailable, null, 'a later successful turn clears it');
  assert.equal(codexHomeState(path.join(dir, 'missing')), null);
}));

test('codexHomeState: other errors, and turns of another account in the home, change nothing', () => withHomes(async (dir) => {
  const home = path.join(dir, 'b');
  rollout(home, '2026-11-04T12-00-00-a', [meta('B'), turn('2026-11-04T04:00:00Z', NO_CREDITS), turn('2026-11-04T05:00:00Z', { message: 'stream disconnected' })]);
  // Orca links the ~/.codex rollout files into each managed home: a linked file of account A is not B's.
  const other = rollout(path.join(dir, 'codex'), '2026-11-05T12-00-00-x', [meta('A'), turn('2026-11-05T04:00:00Z')]);
  const linked = path.join(home, 'sessions', '2026', '11', '05', path.basename(other));
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.linkSync(other, linked);
  assert.deepEqual(codexHomeState(home), { account: 'B', unavailable: { reason: 'no credits', at: T('2026-11-04T04:00:00Z') } });
  assert.deepEqual(codexHomeState(path.join(dir, 'codex')), { account: 'A', unavailable: null }, 'a home of linked files only is its own');
}));

test('codexHomeStates and codexServedHome: by CODEX_HOME, else ~/.codex, else the account of the session home', () => withHomes(async (dir) => {
  const codex = path.join(dir, '.codex');
  const managed = path.join(dir, 'managed', 'home');
  rollout(codex, '2026-11-04T12-00-00-a', [meta('A'), turn('2026-11-04T04:00:00Z')]);
  rollout(managed, '2026-11-04T12-00-00-b', [meta('B'), turn('2026-11-04T04:00:00Z', NOT_SUPPORTED)]);
  const text = [codex, managed, '/not/on/this/host'].map((home, i) => JSON.stringify({ account: `${i}@x`, home })).join('\n');
  const states = codexHomeStates(text);
  assert.deepEqual(Object.keys(states), [codex, managed]);
  assert.equal(codexServedHome(states, codexSessionHome({ HOME: dir })), codex);
  assert.equal(codexServedHome(states, codexSessionHome({ HOME: dir, CODEX_HOME: '~/managed/home' })), managed);
  const seat = path.join(dir, 'seat', 'codex-home');
  rollout(seat, '2026-11-03T12-00-00-s', [meta('A'), turn('2026-11-03T04:00:00Z')]);
  assert.equal(codexServedHome(states, codexSessionHome({ HOME: dir, CODEX_HOME: seat })), codex, 'a seat home with its own copy of login A');
  assert.equal(codexServedHome(states, path.join(dir, 'empty')), null);
}));

test('the codex.usage probe sends the unavailable state and the served home, never the account ids', () => withHomes(async (dir) => {
  const cache = path.join(dir, 'codex-usage.json');
  const home = path.join(dir, '.codex');
  fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), text: '', homes: { [home]: { account: 'A', unavailable: { reason: 'no credits', at: 5 } } } }));
  const ask = createProbes({ cwd: null, argv: [], env: { HOME: dir }, codexCache: cache });
  const answer = (await ask(['codex.usage']))['codex.usage'];
  assert.deepEqual(answer.homes, { [home]: { unavailable: { reason: 'no credits', at: 5 } } });
  assert.equal(answer.served, home);
}));
