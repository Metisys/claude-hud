import type { AccountUsage, AccountWindow } from '../accounts.ts';
import type { Frame } from './frame.ts';
import { critical, dim, formatQuotaPercent, label, quotaBar } from './colors.ts';
import { formatAgo, formatResetTime, wallClock } from './time.ts';

// One line per account (fdectl#124): `Claude ▶ GAO  5h ███░░ 30% (2h 10m, full in 1h 5m) │ 7d … (4d 14h, at Nov 9 04:10)`.
// `▶` marks the account that serves this session. A window that is on track to reach 100 % before
// it resets shows `full in` and takes the red pace colour.

// Codex values older than this show their age: minipc did not answer the last refreshes.
const CODEX_STALE_MS = 2 * 60 * 1000;

// The 7d window also shows its reset as a local wall-clock time (`4d 14h, at Nov 9 04:10`), so the
// user can plan the week. The 5h window keeps the countdown only.
function windowText(f: Frame, name: string, w: AccountWindow, reset: 'relative' | 'both'): string {
  const colors = f.config?.colors;
  const display = f.config?.display;
  const pace = w.fullAt ? 'critical' : null;
  const percent = formatQuotaPercent(w.percent, colors, display?.usageValue ?? 'percent', pace);
  const notes = [
    formatResetTime(w.resetAt, reset, wallClock(display), f.now),
    w.fullAt ? critical(`full in ${formatResetTime(w.fullAt, 'relative', wallClock(display), f.now) || '0m'}`, colors) : '',
  ].filter(Boolean);
  const bar = display?.usageBarEnabled ?? true ? `${quotaBar(w.percent ?? 0, f.barWidth, colors, pace)} ` : '';
  return `${label(name, colors)} ${bar}${percent}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
}

function accountLine(f: Frame, source: string, account: AccountUsage, nameWidth: number): string {
  const colors = f.config?.colors;
  const marker = account.served ? '▶' : ' ';
  const head = `${label(source, colors)} ${marker} ${account.name.padEnd(nameWidth)}`;
  const parts: string[] = [];
  if (account.fiveHour.percent === null && account.sevenDay.percent === null) {
    parts.push(account.limitReached ? critical(`limit: ${account.limitReached}`, colors) : label('no window data', colors));
  } else {
    parts.push(windowText(f, '5h', account.fiveHour, 'relative'), windowText(f, '7d', account.sevenDay, 'both'));
  }
  if (account.blockedForS && account.blockedForS > 0) {
    parts.push(critical(`parked ${formatResetTime(new Date(f.now + account.blockedForS * 1000), 'relative', wallClock(f.config?.display), f.now)}`, colors));
  }
  return `${head} ${parts.join(` ${label('│', colors)} `)}`;
}

/** The account lines: Claude accounts from the relay, then Codex accounts. Empty when both are off or have no data. */
export function accountLines(f: Frame): string[] {
  const view = f.accounts;
  if (!view) return [];
  const claude = view.claude ?? [];
  const codex = view.codex?.accounts ?? [];
  const width = Math.max(0, ...[...claude, ...codex].map((a) => a.name.length));
  const lines = claude.map((account) => accountLine(f, 'Claude', account, width));
  const codexLines = codex.map((account) => accountLine(f, 'Codex ', account, width));
  if (view.codex && codexLines.length > 0 && f.now - view.codex.fetchedAt > CODEX_STALE_MS) {
    codexLines[codexLines.length - 1] += ` ${dim(`(minipc ${formatAgo(f.now - view.codex.fetchedAt)})`)}`;
  }
  return [...lines, ...codexLines];
}
