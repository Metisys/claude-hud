import { createHash } from 'node:crypto';
import { displayLabel } from './utils/sanitize.ts';

// Usage per account (fdectl#124). Two sources, both answers of collector probes:
//   relay.state  GET /_relay/state of the token relay: per Claude token, the last
//                anthropic-ratelimit-unified-* values, and whether the token is parked after a 429.
//   codex.usage  the cached output of `codex-usage` on minipc: one JSON line per Codex account.

/** One usage window of one account, as of `at`. */
export interface AccountWindow {
  /** 0-100. 0 when the window reset after `at`. Null when the source has no value. */
  percent: number | null;
  resetAt: Date | null;
  /** When the window reaches 100 % at the recent rate (forecast.ts). Null when it is not on track to. */
  fullAt?: Date | null;
}

export interface AccountUsage {
  /** Short name: the relay token name without CLAUDE_CODE_OAUTH_TOKEN_, or the Codex email. */
  name: string;
  /** Data time in ms: the relay's unified_at_epoch (else unified_at), or the Codex record time. Null when unknown. */
  at: number | null;
  fiveHour: AccountWindow;
  sevenDay: AccountWindow;
  /** The relay picks this token first for the current session. */
  served?: boolean;
  /** Seconds until the relay uses this token again after a 429. 0 when it is usable. */
  blockedForS?: number;
  /** Codex: the reason when the account has no windows, e.g. "workspace_member_credits_depleted". */
  limitReached?: string | null;
  /** Codex: the newest model error of the account (e.g. "no credits") when no later turn succeeded. `at` is in ms. */
  unavailable?: { reason: string; at: number } | null;
}

const TOKEN_PREFIX = 'CLAUDE_CODE_OAUTH_TOKEN_';
const NAME_MAX = 40;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};
const percentOf = (value: number | null): number | null => (value === null ? null : Math.min(100, Math.max(0, Math.round(value))));
const dateOf = (seconds: number | null): Date | null => (seconds !== null && seconds > 0 ? new Date(seconds * 1000) : null);

/** A window whose reset is before `now` reset after its record: nothing of it is used yet. */
function windowOf(percent: number | null, resetAt: Date | null, now: number): AccountWindow {
  if (percent !== null && resetAt && resetAt.getTime() <= now) return { percent: 0, resetAt: null };
  return { percent, resetAt };
}

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const FUTURE_SLACK_MS = 60_000;

/**
 * The relay's data time in ms. `unified_at_epoch` (Unix seconds) has a time zone. `unified_at` is the
 * relay host's local time with no zone, so it is correct only when the HUD runs in the same zone.
 * Relays from before fdectl 2026-11-04 send only `unified_at`.
 */
function relayTimeOf(token: Record<string, unknown>, now: number): number | null {
  const epoch = finite(token.unified_at_epoch);
  // A time after now (e.g. milliseconds sent as seconds) would stop the forecast taking new samples.
  return epoch !== null && epoch > 0 && epoch * 1000 <= now + FUTURE_SLACK_MS ? epoch * 1000 : timeOf(token.unified_at);
}

/**
 * The index of the token that the relay tries first for this session, as the relay's Pool.order does:
 * the `x-relay-prefer` token when it names a loaded token, else SHA-256 of the session id (the first 8
 * bytes, big-endian) modulo the token count. In that ring, the first usable token comes first.
 */
export function servedIndex(names: string[], usable: boolean[], sessionId: string | null, prefer: string | null): number | null {
  if (names.length === 0) return null;
  let start: number;
  if (prefer && names.includes(prefer)) start = names.indexOf(prefer);
  else if (sessionId) start = Number(BigInt(`0x${createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 16)}`) % BigInt(names.length));
  else return null;
  for (let step = 0; step < names.length; step++) {
    const index = (start + step) % names.length;
    if (usable[index]) return index;
  }
  return start;
}

/**
 * The Claude accounts from the relay.state answer, or null when the relay did not answer or no token
 * has window values yet. Then the HUD shows the stdin rate_limits as before.
 */
export function parseRelayAccounts(answer: unknown, sessionId: string | null, now: number): AccountUsage[] | null {
  if (!isObject(answer) || !isObject(answer.state) || !Array.isArray(answer.state.tokens)) return null;
  const tokens = answer.state.tokens.filter(isObject);
  const names = tokens.map((token) => (typeof token.var === 'string' ? token.var : ''));
  const prefer = typeof answer.prefer === 'string' ? answer.prefer : null;
  const served = servedIndex(names, tokens.map((token) => token.usable !== false), sessionId?.trim() || null, prefer);
  const accounts = tokens.map((token, index): AccountUsage | null => {
    const unified = isObject(token.unified) ? token.unified : {};
    const window = (name: string): AccountWindow => {
      const used = finite(unified[`${name}-utilization`]);
      return windowOf(percentOf(used === null ? null : used * 100), dateOf(finite(unified[`${name}-reset`])), now);
    };
    const name = displayLabel(names[index].startsWith(TOKEN_PREFIX) ? names[index].slice(TOKEN_PREFIX.length) : names[index], NAME_MAX);
    if (!name) return null;
    return {
      name,
      at: relayTimeOf(token, now),
      fiveHour: window('5h'),
      sevenDay: window('7d'),
      served: index === served,
      blockedForS: Math.max(0, finite(token.blocked_for_s) ?? 0),
    };
  }).filter((account): account is AccountUsage => account !== null);
  const anyWindow = accounts.some((a) => a.fiveHour.percent !== null || a.sevenDay.percent !== null);
  return anyWindow ? accounts : null;
}

export interface CodexUsage {
  accounts: AccountUsage[];
  /** When the collector last read codex-usage, in ms. */
  fetchedAt: number;
}

function unavailableOf(state: unknown): AccountUsage['unavailable'] {
  if (!isObject(state) || !isObject(state.unavailable)) return null;
  const reason = typeof state.unavailable.reason === 'string' ? displayLabel(state.unavailable.reason, 40) : '';
  const at = finite(state.unavailable.at);
  return reason && at !== null ? { reason, at } : null;
}

/**
 * The Codex accounts from the codex.usage answer, or null. The answer is { at, text, homes, served }:
 * `text` has one JSON line per account with its Codex home, `homes` the unavailable state of each home
 * on this host, and `served` the home that this session uses.
 */
export function parseCodexUsage(answer: unknown, now: number): CodexUsage | null {
  if (!isObject(answer) || typeof answer.text !== 'string') return null;
  const fetchedAt = finite(answer.at);
  if (fetchedAt === null) return null;
  const homes = isObject(answer.homes) ? answer.homes : {};
  const served = typeof answer.served === 'string' ? answer.served : null;
  const accounts: AccountUsage[] = [];
  for (const line of answer.text.split('\n')) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(record)) continue;
    const window = (value: unknown): AccountWindow => (isObject(value)
      ? windowOf(percentOf(finite(value.used_percent)), dateOf(finite(value.resets_at)), now)
      : { percent: null, resetAt: null });
    const name = displayLabel(typeof record.account === 'string' ? record.account : 'unknown', NAME_MAX);
    const home = typeof record.home === 'string' ? record.home : null;
    accounts.push({
      name,
      at: timeOf(record.recorded_at),
      fiveHour: window(record.primary),
      sevenDay: window(record.secondary),
      limitReached: typeof record.limit_reached === 'string' ? displayLabel(record.limit_reached, 60) || null : null,
      served: home !== null && home === served,
      unavailable: home !== null && Object.hasOwn(homes, home) ? unavailableOf(homes[home]) : null,
    });
  }
  return { accounts, fetchedAt };
}

/** What the account lines show. */
export interface AccountsView {
  /** Null when the relay did not answer: then the usage line shows the stdin rate_limits. */
  claude: AccountUsage[] | null;
  codex: CodexUsage | null;
}
