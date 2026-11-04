import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeRows, codexRows, projectOf, usageTables } from '../src/usage-report.ts';

const HOME = '/home/u';
const line = (session, ts, project, output, cost, cacheRead = 0) => JSON.stringify({
  timestamp: ts, session_id: session, transcript_path: `/home/u/.claude/projects/${project}/${session}.jsonl`,
  input_tokens: 10, output_tokens: output, cache_write_tokens: 0, cache_read_tokens: cacheRead, estimated_cost_usd: cost,
});

test('projectOf removes the encoded home from the transcript folder', () => {
  assert.equal(projectOf('/home/u/.claude/projects/-home-u-orca-workspaces-hud-wave2/s.jsonl', HOME), 'orca-workspaces-hud-wave2');
  assert.equal(projectOf('/home/u/.claude/projects/-home-u/s.jsonl', HOME), '~');
  assert.equal(projectOf('/home/u/.claude/projects/-srv-x/s.jsonl', HOME), '-srv-x');
});

test('the ledger holds running totals: each line counts its difference, on its own day', () => {
  const text = [
    line('s1', '2026-11-01T10:00:00', '-home-u-a', 100, 1.0, 1000),
    line('s2', '2026-11-01T11:00:00', '-home-u-b', 50, 0.5),
    line('s1', '2026-11-02T10:00:00', '-home-u-a', 300, 2.5, 4000),
    'broken',
  ].join('\n');
  const rows = claudeRows(text, HOME);
  assert.deepEqual(rows.map((r) => [r.project, r.day, r.output, r.cache, Number(r.cost.toFixed(2))]), [
    ['a', '2026-11-01', 100, 1000, 1],
    ['b', '2026-11-01', 50, 0, 0.5],
    ['a', '2026-11-02', 200, 3000, 1.5],
  ]);
  assert.equal(rows[2].input, 0, 'an unchanged total adds nothing');
});

test('a total that goes down starts a new count', () => {
  const rows = claudeRows([line('s', '2026-11-01T10:00:00', 'p', 500, 5), line('s', '2026-11-01T11:00:00', 'p', 40, 0.4)].join('\n'), HOME);
  assert.deepEqual(rows.map((r) => r.output), [500, 40]);
});

test('Codex rows: tokens per cwd and day, input without the cached part, cost "subscription"', () => {
  const rows = codexRows([
    JSON.stringify({ cwd: '/home/u/src/x', day: '2026-11-02', input_tokens: 1000, cached_input_tokens: 800, output_tokens: 30, total_tokens: 1030 }),
    JSON.stringify({ cwd: '/tmp', day: 'bad' }),
  ].join('\n'), HOME);
  assert.deepEqual(rows, [{ source: 'codex', project: 'src/x', day: '2026-11-02', input: 200, output: 30, cache: 800, cost: null }]);
});

test('Codex rows: the codex-usage --tokens line shape, two accounts in one cwd and day are added', () => {
  // The line shape of fdectl codex-usage --tokens (fdectl#138), as measured on minipc.
  const line = (account, input, cached, output) => JSON.stringify({ account, cwd: '/home/u/w/a', day: '2026-11-03',
    input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });
  const rows = codexRows([line('a@x', 300, 120, 40), line('b@x', 100, 100, 5)].join('\n'), HOME);
  const text = usageTables(rows, '2026-11-01').join('\n');
  assert.match(text, /codex {3}w\/a +180 +45 +220 +subscription/);
  assert.match(text, /codex {3}2026-11-03 +180 +45 +220 +subscription/);
});

test('usageTables groups by project and by day, from the first day on', () => {
  const rows = [
    ...claudeRows([line('s1', '2026-10-01T10:00:00', '-home-u-old', 999, 9), line('s2', '2026-11-01T10:00:00', '-home-u-a', 100, 1),
      line('s3', '2026-11-02T10:00:00', '-home-u-a', 50, 2)].join('\n'), HOME),
    ...codexRows(JSON.stringify({ cwd: '/home/u/x', day: '2026-11-02', input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }), HOME),
  ];
  const text = usageTables(rows, '2026-11-01').join('\n');
  assert.ok(!text.includes('old'), 'days before the first day are left out');
  assert.match(text, /claude {2}a +20 +150 +0 +\$3\.00/);
  assert.match(text, /codex {3}x +5 +1 +0 +subscription/);
  assert.match(text, /claude {2}2026-11-02 +10 +50 +0 +\$2\.00/);
  assert.match(text, /claude {2}2026-11-01 +10 +100 +0 +\$1\.00/);
});
