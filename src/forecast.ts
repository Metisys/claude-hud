import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCodexUsage, parseRelayAccounts, type AccountUsage, type AccountWindow, type AccountsView } from './accounts.ts';

// When does a usage window reach 100 %? From the recent use rate of that window.
//
// The rate needs earlier values, and each status-line run is a new process. So each run adds the
// current value of each window to data/usage-rate.json, as [data time, percent]. The data time is
// when the source measured the value (the relay's unified_at, the Codex record time), not the render
// time, so many renders of one value add one sample. A new reset time starts the window again.
//
// rate = (newest percent - oldest percent in the lookback) / (time between them)
// full = newest time + (100 - newest percent) / rate
//
// No forecast when the rate is not positive, when the samples span less than MIN_SPAN_MS, when the
// window resets before it is full, or when the newest sample is older than the lookback or the
// forecast time is already past (the account stopped).

export const STATE_FILE = 'usage-rate.json';
const MIN_SPAN_MS = 10 * 60 * 1000;
const MAX_SAMPLES = 120;
// A window that no render saw for this long is removed from the file.
const FORGET_MS = 8 * 24 * 60 * 60 * 1000;

export interface Observation {
  /** One window of one account, for example "claude:GAO:5h". */
  key: string;
  /** Data time in ms. */
  at: number;
  percent: number;
  resetAt: Date | null;
  /** How far back the rate looks. */
  lookbackMs: number;
}

interface WindowState {
  reset: number | null;
  samples: Array<[number, number]>;
  seen: number;
}

type State = Record<string, WindowState>;

function readState(file: string): State {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const state: State = Object.create(null);
    for (const [key, entry] of Object.entries(value as Record<string, Partial<WindowState>>)) {
      if (!entry || !Array.isArray(entry.samples)) continue;
      const samples = entry.samples.filter((s): s is [number, number] => Array.isArray(s) && s.length === 2
        && Number.isFinite(s[0]) && Number.isFinite(s[1]));
      state[key] = { reset: Number.isFinite(entry.reset) ? entry.reset as number : null, samples, seen: Number.isFinite(entry.seen) ? entry.seen as number : 0 };
    }
    return state;
  } catch {
    return {};
  }
}

function writeState(file: string, state: State): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // A read-only home only costs the forecast.
  }
}

/** The time each window is full, parallel to `observations`. Adds each observation to the state file. */
export function forecastFull(dataDir: string, observations: Observation[], now: number): Array<Date | null> {
  if (observations.length === 0) return [];
  const file = path.join(dataDir, STATE_FILE);
  const state = readState(file);
  const result = observations.map((o) => {
    const reset = o.resetAt ? o.resetAt.getTime() : null;
    let entry = state[o.key];
    if (!entry || entry.reset !== reset) entry = { reset, samples: [], seen: now };
    entry.seen = now;
    const last = entry.samples.at(-1);
    if (!last || o.at > last[0]) entry.samples.push([o.at, o.percent]);
    entry.samples = entry.samples.filter(([at]) => at >= o.at - o.lookbackMs).slice(-MAX_SAMPLES);
    state[o.key] = entry;

    const [first, newest] = [entry.samples[0], entry.samples.at(-1)!];
    const span = newest[0] - first[0];
    if (span < MIN_SPAN_MS || newest[1] >= 100) return null;
    const rate = (newest[1] - first[1]) / span;
    if (!(rate > 0)) return null;
    const full = newest[0] + (100 - newest[1]) / rate;
    // An account that stopped has an old newest sample, and its forecast is in the past: no forecast.
    if (full <= now || now - newest[0] > o.lookbackMs) return null;
    return reset !== null && full >= reset ? null : new Date(full);
  });
  for (const [key, entry] of Object.entries(state)) if (now - entry.seen > FORGET_MS) delete state[key];
  writeState(file, state);
  return result;
}

const HOUR_MS = 60 * 60 * 1000;
// The 5h window looks back 1 hour, the 7d window 24 hours.
const LOOKBACK_MS = { fiveHour: HOUR_MS, sevenDay: 24 * HOUR_MS } as const;

/** The account view of a render: the parsed probe answers, with the forecast of each window. */
export function resolveAccounts(
  answers: { relay?: unknown; codex?: unknown },
  sessionId: string | null,
  dataDir: string,
  now: number,
): AccountsView {
  const claude = answers.relay === undefined ? null : parseRelayAccounts(answers.relay, sessionId, now);
  const codex = answers.codex === undefined ? null : parseCodexUsage(answers.codex, now);
  const windows: Array<{ window: AccountWindow; key: string; at: number; lookbackMs: number }> = [];
  const add = (source: string, account: AccountUsage): void => {
    if (account.at === null) return;
    for (const name of ['fiveHour', 'sevenDay'] as const) {
      const window = account[name];
      if (window.percent !== null && window.resetAt) {
        windows.push({ window, key: `${source}:${account.name}:${name}`, at: account.at, lookbackMs: LOOKBACK_MS[name] });
      }
    }
  };
  claude?.forEach((account) => add('claude', account));
  codex?.accounts.forEach((account) => add('codex', account));
  const full = forecastFull(dataDir, windows.map(({ window, key, at, lookbackMs }) => (
    { key, at, percent: window.percent!, resetAt: window.resetAt, lookbackMs })), now);
  windows.forEach(({ window }, index) => { window.fullAt = full[index]; });
  return { claude, codex };
}
