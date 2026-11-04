import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsage, parseRelayAccounts, servedIndex } from '../src/accounts.ts';

// The expected pins come from the relay's own Pool.pin (Python: SHA-256, first 8 bytes big-endian, modulo).
test('servedIndex matches the relay pin for a session', () => {
  const two = ['A', 'B'];
  const three = ['A', 'B', 'C'];
  assert.equal(servedIndex(two, [true, true], 'session-1', null), 0);
  assert.equal(servedIndex(two, [true, true], 'session-2', null), 1);
  assert.equal(servedIndex(three, [true, true, true], 'session-2', null), 2);
  assert.equal(servedIndex(three, [true, true, true], 'session-1', null), 1);
  assert.equal(servedIndex(three, [true, true, true], 'f64d06b4-0e5a-4197-a2c4-4302d22875ff', null), 2);
});

test('servedIndex: a preference names the first token; a parked token is passed', () => {
  assert.equal(servedIndex(['A', 'B'], [true, true], 'session-1', 'B'), 1, 'the preference replaces the pin');
  assert.equal(servedIndex(['A', 'B'], [true, true], 'session-2', 'X'), 1, 'an unknown name keeps the pin');
  assert.equal(servedIndex(['A', 'B', 'C'], [true, false, true], 'session-1', null), 2, 'the pin B is parked: the next usable token');
  assert.equal(servedIndex(['A', 'B'], [false, false], 'session-2', null), 1, 'all parked: the pin');
  assert.equal(servedIndex(['A', 'B'], [true, true], null, null), null, 'no session, no preference: unknown');
});

const NOW = Date.parse('2026-11-04T12:00:00Z');
const at = (iso) => Date.parse(iso) / 1000;
const relay = (tokens, prefer = null) => ({ state: { tokens }, prefer });

test('parseRelayAccounts reads the unified values of each token', () => {
  const accounts = parseRelayAccounts(relay([
    { var: 'CLAUDE_CODE_OAUTH_TOKEN_GAO', usable: true, blocked_for_s: 0, unified_at: '2026-11-04T11:59:00',
      unified: { '5h-utilization': '0.17', '5h-reset': String(at('2026-11-04T15:00:00Z')), '7d-utilization': '0.984', '7d-reset': String(at('2026-11-08T00:00:00Z')) } },
    { var: 'CLAUDE_CODE_OAUTH_TOKEN_GAO2', usable: false, blocked_for_s: 3600, unified: {} },
  ], 'CLAUDE_CODE_OAUTH_TOKEN_GAO2'), 'session-1', NOW);
  assert.equal(accounts.length, 2);
  const [gao, gao2] = accounts;
  assert.equal(gao.name, 'GAO');
  assert.equal(gao.fiveHour.percent, 17);
  assert.equal(gao.sevenDay.percent, 98);
  assert.equal(gao.fiveHour.resetAt.toISOString(), '2026-11-04T15:00:00.000Z');
  assert.equal(gao2.name, 'GAO2');
  assert.equal(gao2.fiveHour.percent, null);
  assert.equal(gao2.blockedForS, 3600);
  assert.equal(gao.served, true, 'GAO2 is preferred but parked, so GAO serves');
  assert.equal(gao2.served, false);
});

test('parseRelayAccounts: a window that reset after the record is at 0', () => {
  const [account] = parseRelayAccounts(relay([{ var: 'T', unified: { '5h-utilization': '0.5', '5h-reset': String(at('2026-11-04T11:00:00Z')) } }]), null, NOW);
  assert.equal(account.fiveHour.percent, 0);
});

test('parseRelayAccounts is null when the relay did not answer or has no window values', () => {
  assert.equal(parseRelayAccounts({ state: null, prefer: null }, 's', NOW), null);
  assert.equal(parseRelayAccounts(null, 's', NOW), null);
  assert.equal(parseRelayAccounts(relay([{ var: 'T', usable: true, calls: 3 }]), 's', NOW), null, 'a relay without unified values');
});

test('parseCodexUsage reads one account per line', () => {
  const text = [
    JSON.stringify({ account: 'a@x', recorded_at: '2026-11-04T11:00:00Z', primary: { used_percent: 20, resets_at: at('2026-11-04T14:00:00Z') },
      secondary: { used_percent: 92.4, resets_at: at('2026-11-06T00:00:00Z') }, limit_reached: null }),
    JSON.stringify({ account: 'b@x', recorded_at: '2026-11-04T10:00:00Z', primary: { used_percent: 70, resets_at: at('2026-11-04T11:00:00Z') },
      secondary: null }),
    JSON.stringify({ account: 'c@x', primary: null, secondary: null, limit_reached: 'workspace_member_credits_depleted' }),
    'not json',
  ].join('\n');
  const usage = parseCodexUsage({ at: NOW - 1000, text }, NOW);
  assert.equal(usage.fetchedAt, NOW - 1000);
  assert.deepEqual(usage.accounts.map((a) => [a.name, a.fiveHour.percent, a.sevenDay.percent, a.limitReached ?? null]), [
    ['a@x', 20, 92, null],
    ['b@x', 0, null, null],
    ['c@x', null, null, 'workspace_member_credits_depleted'],
  ]);
  assert.equal(usage.accounts[0].at, Date.parse('2026-11-04T11:00:00Z'));
  assert.equal(parseCodexUsage(null, NOW), null);
});
