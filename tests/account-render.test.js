// The account lines (fdectl#124): per-account bars from the relay and codex-usage, rendered through renderLines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLines } from '../src/render/index.ts';
import { mergeConfig } from '../src/config.ts';

// The 7d reset shows a local wall-clock time: fix the timezone so the expected text is stable.
process.env.TZ = 'UTC';
const NOW = new Date(2026, 10, 4, 12, 0).getTime();
const MIN = 60 * 1000;
const from = (ms) => new Date(NOW + ms);
const plain = (s) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

function ctx(accounts, config = {}) {
  return {
    stdin: { model: { display_name: 'Opus' }, cwd: '/home/u/dev/p', context_window: { context_window_size: 200000, used_percentage: 45 } },
    transcript: { tools: [], agents: [], todos: [] },
    claudeMdCount: 0, rulesCount: 0, mcpCount: 0, hooksCount: 0, costTotals: null, outputSpeed: null, gitStatus: null,
    usageData: { fiveHour: 30, sevenDay: 10, fiveHourResetAt: from(90 * MIN), sevenDayResetAt: from(3000 * MIN) },
    memoryUsage: null, extraLabel: null, accounts,
    config: mergeConfig({ display: { showAccountUsage: true, showCodexUsage: true }, ...config }),
  };
}
const lines = (c) => renderLines(c, 200, NOW).map(plain);
const win = (percent, resetMin, fullMin = null) => ({ percent, resetAt: from(resetMin * MIN), fullAt: fullMin === null ? null : from(fullMin * MIN) });
const claude = [
  { name: 'GAO', at: NOW, served: false, blockedForS: 0, fiveHour: win(17, 120), sevenDay: win(12, 5000) },
  { name: 'GAO2', at: NOW, served: true, blockedForS: 0, fiveHour: win(60, 200, 70), sevenDay: win(98, 600) },
];

test('the relay accounts replace the stdin usage, one line each, with the served marker', () => {
  const out = lines(ctx({ claude, codex: null }));
  assert.equal(out.length, 4);
  assert.match(out[1], /^Context .*45%$/, 'the usage part leaves the context line');
  assert.ok(!out.join('\n').includes('Usage'), 'no stdin usage');
  assert.match(out[2], /^Claude   GAO  5h .* 17% \(2h\) │ 7d .* 12% \(3d 11h, at [^)]+\)$/);
  assert.match(out[3], /^Claude ▶ GAO2 5h .* 60% ▲ \(3h 20m, full in 1h 10m\) │ 7d .* 98% \(10h, at [^)]+\)$/);
});

test('without relay data the stdin usage shows as before, with no error line', () => {
  const out = lines(ctx({ claude: null, codex: null }));
  assert.equal(out.length, 2);
  assert.match(out[1], /Usage .*30%/);
});

test('Codex accounts show their windows, a limit, and the age of old values', () => {
  const codex = { fetchedAt: NOW - 10 * MIN, accounts: [
    { name: 'a@x', at: NOW, fiveHour: win(20, 100), sevenDay: win(92, 3000), limitReached: null },
    { name: 'b@x', at: NOW, fiveHour: { percent: null, resetAt: null }, sevenDay: { percent: null, resetAt: null }, limitReached: 'workspace_member_credits_depleted' },
  ] };
  const out = lines(ctx({ claude: null, codex }));
  assert.match(out[1], /Usage .*30%/, 'Codex lines do not replace the Claude usage');
  assert.match(out[2], /^Codex    a@x 5h .* 20% .* │ 7d .* 92%/);
  assert.match(out[3], /^Codex    b@x limit: workspace_member_credits_depleted \(minipc 10m ago\)$/);
  const fresh = lines(ctx({ claude: null, codex: { ...codex, fetchedAt: NOW - 30 * 1000 } }));
  assert.ok(!fresh.join('\n').includes('ago'), 'fresh values show no age');
});

test('a Codex account shows the served marker and why it cannot serve models', () => {
  const codex = { fetchedAt: NOW, accounts: [
    { name: 'gao@x', at: NOW, served: true, fiveHour: win(0, 100), sevenDay: win(2, 3000), limitReached: null, unavailable: null },
    { name: 'gao2@x', at: NOW, served: false, fiveHour: win(0, 100), sevenDay: win(2, 3000), limitReached: null,
      unavailable: { reason: 'model not supported', at: NOW - 20 * MIN } },
  ] };
  const out = lines(ctx({ claude: null, codex }));
  assert.match(out[2], /^Codex  ▶ gao@x  5h .* 0% .* │ 7d .* 2% \([^)]+\)$/);
  assert.match(out[3], /^Codex    gao2@x 5h .* │ 7d .* 2% \([^)]+\) │ unavailable: model not supported 20m ago$/);
});

test('a parked token shows how long the relay keeps it parked', () => {
  const out = lines(ctx({ claude: [{ ...claude[0], blockedForS: 3600 }], codex: null }));
  assert.match(out[2], /│ parked 1h$/);
});

test('the compact layout puts the account lines after its one line', () => {
  const out = lines(ctx({ claude, codex: null }, { lineLayout: 'compact' }));
  assert.equal(out.length, 3);
  assert.ok(!out[0].includes('Usage'));
  assert.match(out[2], /^Claude ▶ GAO2/);
});

test('the 7d window adds its reset as a local wall-clock time; the 5h window keeps the countdown only', () => {
  const out = lines(ctx({ claude: [{ ...claude[0], sevenDay: win(46, 6600, 1800) }], codex: null }, { display: { showAccountUsage: true, hourCycle: 'h23' } }));
  // NOW is 2026-11-04 12:00 UTC; 6600 min later is 2026-11-09 02:00 UTC.
  const date = new Date(Date.UTC(2026, 10, 9)).toLocaleDateString([], { month: 'short', day: 'numeric' });
  assert.match(out[2], /5h .* 17% \(2h\) │/, 'the 5h window has no wall-clock time');
  assert.match(out[2], new RegExp(`│ 7d .* 46% ▲ \\(4d 14h, at ${date} 02:00, full in 1d 6h\\)$`));
  const codex = { fetchedAt: NOW, accounts: [{ name: 'a@x', at: NOW, fiveHour: win(20, 100), sevenDay: win(46, 6600), limitReached: null }] };
  const parked = lines(ctx({ claude: [{ ...claude[0], blockedForS: 3600, sevenDay: win(46, 6600) }], codex }, { display: { showAccountUsage: true, showCodexUsage: true, hourCycle: 'h23' } }));
  assert.match(parked[2], new RegExp(`7d .* 46% \\(4d 14h, at ${date} 02:00\\) │ parked 1h$`), 'a parked row shows it too');
  assert.match(parked[3], new RegExp(`^Codex .* 7d .* 46% \\(4d 14h, at ${date} 02:00\\)$`), 'a Codex row shows it too');
});
