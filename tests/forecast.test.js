import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STATE_FILE, forecastFull, resolveAccounts } from '../src/forecast.ts';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-11-04T10:00:00Z');
const RESET = new Date(T0 + 4 * 60 * MIN);
const obs = (at, percent, resetAt = RESET) => ({ key: 'claude:GAO:fiveHour', at, percent, resetAt, lookbackMs: 60 * MIN });

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hud-forecast-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the rate across status-line runs gives the time the window is full', () => withDir(async (dir) => {
  assert.deepEqual(forecastFull(dir, [obs(T0, 40)], T0), [null], 'one sample has no rate');
  assert.deepEqual(forecastFull(dir, [obs(T0 + 5 * MIN, 45)], T0 + 5 * MIN), [null], 'under 10 minutes is too short');
  // 20 % in 20 minutes: 1 % per minute, 40 % left at T0+20m.
  const [full] = forecastFull(dir, [obs(T0 + 20 * MIN, 60)], T0 + 20 * MIN);
  assert.equal(full.toISOString(), new Date(T0 + 60 * MIN).toISOString());
  const state = JSON.parse(await readFile(path.join(dir, STATE_FILE), 'utf8'));
  assert.equal(state['claude:GAO:fiveHour'].samples.length, 3, 'the state is kept in data/');
}));

test('a value at the same data time adds no sample', () => withDir(async (dir) => {
  forecastFull(dir, [obs(T0, 40)], T0);
  forecastFull(dir, [obs(T0, 40)], T0 + 15 * MIN);
  const state = JSON.parse(await readFile(path.join(dir, STATE_FILE), 'utf8'));
  assert.equal(state['claude:GAO:fiveHour'].samples.length, 1);
}));

test('no forecast when the window resets first, when use stops, or after a new reset', () => withDir(async (dir) => {
  forecastFull(dir, [obs(T0, 10)], T0);
  assert.deepEqual(forecastFull(dir, [obs(T0 + 30 * MIN, 12)], T0 + 30 * MIN), [null], 'full after the reset');
  assert.deepEqual(forecastFull(dir, [obs(T0 + 40 * MIN, 12)], T0 + 40 * MIN), [null], '2 % in 40 minutes still ends after the reset');
  const newReset = new Date(RESET.getTime() + 5 * 60 * MIN);
  assert.deepEqual(forecastFull(dir, [obs(T0 + 50 * MIN, 80, newReset)], T0 + 50 * MIN), [null], 'a new window starts without samples');
}));

test('samples older than the lookback do not count', () => withDir(async (dir) => {
  const late = new Date(T0 + 5 * 60 * MIN);
  forecastFull(dir, [obs(T0, 0, late)], T0);
  forecastFull(dir, [obs(T0 + 50 * MIN, 50, late)], T0 + 50 * MIN);
  // At T0+90m the lookback starts at T0+30m: only 50 -> 60 over 40 minutes counts (0.25 %/min).
  const [full] = forecastFull(dir, [obs(T0 + 90 * MIN, 60, late)], T0 + 90 * MIN);
  assert.equal(full.toISOString(), new Date(T0 + 90 * MIN + 160 * MIN).toISOString());
}));

test('resolveAccounts adds the forecast to each window of the relay and Codex accounts', () => withDir(async (dir) => {
  const reset = String(RESET.getTime() / 1000);
  const relay = (at, used) => ({ state: { tokens: [{ var: 'CLAUDE_CODE_OAUTH_TOKEN_GAO', usable: true,
    unified_at: new Date(at).toISOString(), unified: { '5h-utilization': String(used), '5h-reset': reset } }] }, prefer: null });
  resolveAccounts({ relay: relay(T0, 0.4) }, 's', dir, T0);
  const view = resolveAccounts({ relay: relay(T0 + 20 * MIN, 0.6), codex: null }, 's', dir, T0 + 20 * MIN);
  assert.equal(view.claude[0].fiveHour.fullAt.toISOString(), new Date(T0 + 60 * MIN).toISOString());
  assert.equal(view.codex, null);
}));

test('the data time, not the render time, places a sample', () => withDir(async (dir) => {
  forecastFull(dir, [obs(T0, 40)], T0 + 5 * MIN);
  // 20 % in the 20 minutes between the two measurements: full at T0+60m, whenever the renders ran.
  const [full] = forecastFull(dir, [obs(T0 + 20 * MIN, 60)], T0 + 30 * MIN);
  assert.equal(full.toISOString(), new Date(T0 + 60 * MIN).toISOString());
}));

test('an account that stopped has no forecast', () => withDir(async (dir) => {
  forecastFull(dir, [obs(T0, 40)], T0);
  // Rising 1 %/min until T0+20m, then no new value: full would be T0+60m.
  assert.ok(forecastFull(dir, [obs(T0 + 20 * MIN, 60)], T0 + 20 * MIN)[0]);
  assert.deepEqual(forecastFull(dir, [obs(T0 + 20 * MIN, 60)], T0 + 61 * MIN), [null], 'the forecast time is past');
}));

test('a newest sample older than the lookback gives no forecast', () => withDir(async (dir) => {
  const late = new Date(T0 + 20 * 60 * MIN);
  forecastFull(dir, [obs(T0, 10, late)], T0);
  forecastFull(dir, [obs(T0 + 20 * MIN, 12, late)], T0 + 20 * MIN);
  assert.deepEqual(forecastFull(dir, [obs(T0 + 20 * MIN, 12, late)], T0 + 90 * MIN), [null]);
}));
