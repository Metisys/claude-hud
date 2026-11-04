import * as fs from 'node:fs';
import * as path from 'node:path';
import { displayLabel } from './utils/sanitize.ts';

// `hud usage` (fdectl#124): cost and tokens per repository or worktree, and per day.
//
// Claude rows come from the ecc cost-tracker ledger, ~/.claude/metrics/costs.jsonl. Each line holds the
// running totals of one session, so the use between two lines of a session is their difference, and it
// counts on the day of the later line. The project is the transcript's folder under ~/.claude/projects,
// which is the session's cwd with each character other than a letter or a digit changed to `-`.
//
// Codex rows come from `codex-usage --tokens` on minipc: one JSON line per cwd and day. Codex has no
// cost on a subscription, so the cost column says "subscription". No token is converted to a price.

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const NAME_MAX = 60;

export interface UsageRow {
  source: 'claude' | 'codex';
  project: string;
  day: string;
  input: number;
  output: number;
  cache: number;
  /** USD, or null for Codex. */
  cost: number | null;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const pad2 = (n: number): string => String(n).padStart(2, '0');
const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** The project name of a transcript path: its folder name without the encoded home prefix. */
export function projectOf(transcriptPath: string, home: string): string {
  const folder = path.basename(path.dirname(transcriptPath));
  const encodedHome = home.replace(/[^A-Za-z0-9]/g, '-');
  const name = folder.startsWith(`${encodedHome}-`) ? folder.slice(encodedHome.length + 1) : folder === encodedHome ? '~' : folder;
  return displayLabel(name, NAME_MAX) || '?';
}

/** The Claude rows of the ledger text: the use of each session between its lines, by project and day. */
export function claudeRows(text: string, home: string): UsageRow[] {
  const last = new Map<string, { input: number; output: number; cache: number; cost: number }>();
  const rows: UsageRow[] = [];
  for (const line of text.split('\n')) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null || typeof entry.session_id !== 'string' || typeof entry.transcript_path !== 'string') continue;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    const now = { input: count(entry.input_tokens), output: count(entry.output_tokens),
      cache: count(entry.cache_read_tokens) + count(entry.cache_write_tokens), cost: count(entry.estimated_cost_usd) };
    const before = last.get(entry.session_id);
    last.set(entry.session_id, now);
    // A total that went down is a new count (a resumed or cleared session): all of it is new use.
    const delta = (key: keyof typeof now): number => (before && now[key] >= before[key] ? now[key] - before[key] : now[key]);
    rows.push({ source: 'claude', project: projectOf(entry.transcript_path, home), day: localDay(at),
      input: delta('input'), output: delta('output'), cache: delta('cache'), cost: delta('cost') });
  }
  return rows;
}

/** The Codex rows of `codex-usage --tokens`: {cwd, day, input_tokens, cached_input_tokens, output_tokens, total_tokens} per line. */
export function codexRows(text: string, home: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const line of text.split('\n')) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null || typeof entry.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) continue;
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : '?';
    const relative = cwd === home ? '~' : cwd.startsWith(`${home}/`) ? cwd.slice(home.length + 1) : cwd;
    const cached = count(entry.cached_input_tokens);
    rows.push({ source: 'codex', project: displayLabel(relative, NAME_MAX) || '?', day: entry.day,
      input: Math.max(0, count(entry.input_tokens) - cached), output: count(entry.output_tokens), cache: cached, cost: null });
  }
  return rows;
}

function group(rows: UsageRow[], key: (row: UsageRow) => string): UsageRow[] {
  const groups = new Map<string, UsageRow>();
  for (const row of rows) {
    const name = `${row.source}\0${key(row)}`;
    const sum = groups.get(name) ?? { ...row, project: row.project, input: 0, output: 0, cache: 0, cost: row.cost === null ? null : 0 };
    sum.input += row.input;
    sum.output += row.output;
    sum.cache += row.cache;
    if (sum.cost !== null) sum.cost += row.cost ?? 0;
    groups.set(name, sum);
  }
  return [...groups.values()];
}

const tokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const cost = (row: UsageRow): string => (row.cost === null ? 'subscription' : `$${row.cost.toFixed(2)}`);

function table(header: string[], body: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 || i === 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)];
}

const row = (r: UsageRow, name: string): string[] => [r.source, name, tokens(r.input), tokens(r.output), tokens(r.cache), cost(r)];
const total = (r: UsageRow): number => r.input + r.output + r.cache;

/** The two tables of `hud usage`, for the days from `since` (YYYY-MM-DD) on. */
export function usageTables(rows: UsageRow[], since: string): string[] {
  const recent = rows.filter((r) => r.day >= since);
  const byProject = group(recent, (r) => r.project)
    .sort((a, b) => a.source.localeCompare(b.source) || (b.cost ?? 0) - (a.cost ?? 0) || total(b) - total(a));
  const byDay = group(recent, (r) => r.day).sort((a, b) => b.day.localeCompare(a.day) || a.source.localeCompare(b.source));
  const header = ['source', '', 'input', 'output', 'cache', 'cost'];
  return [
    `Usage from ${since}. cache = cache read + cache write (Claude), cached input (Codex).`,
    '',
    'By repository or worktree',
    ...table(header.map((h, i) => (i === 1 ? 'project' : h)), byProject.map((r) => row(r, r.project))),
    '',
    'By day',
    ...table(header.map((h, i) => (i === 1 ? 'day' : h)), byDay.map((r) => row(r, r.day))),
  ];
}

/** Reads the ledger; null when it is missing or too large. */
export function readLedger(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_LEDGER_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export { localDay };
