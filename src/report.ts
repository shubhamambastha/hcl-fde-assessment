// Pure pipeline: rows + config + asOf -> report. No I/O, so tests drive it directly.
import type { LoadResult, LogRow } from "./load.ts";
import { aggregate } from "./aggregate.ts";
import { evaluate, rollup, type Config, type Health, type Overall } from "./evaluate.ts";

export type Report = {
  generatedAt: string;
  asOf: string;
  windowStart: string;
  windowMinutes: number;
  overall: Overall;
  integrations: Health[];
  summary?: { text: string; model: string };
};

// Loops, not Math.max(...rows): spreading ~100k+ arguments overflows the call stack.
function newestLog(rows: LogRow[]): Date | null {
  let t = -Infinity;
  for (const r of rows) if (r.timestamp.getTime() > t) t = r.timestamp.getTime();
  return Number.isFinite(t) ? new Date(t) : null;
}

function oldestLog(rows: LogRow[]): Date | null {
  let t = Infinity;
  for (const r of rows) if (r.timestamp.getTime() < t) t = r.timestamp.getTime();
  return Number.isFinite(t) ? new Date(t) : null;
}

function age(minutes: number): string {
  if (minutes < 120) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

// `now` is the wall clock; injectable so tests are deterministic.
export function buildReport({ rows, rejected }: LoadResult, cfg: Config, asOf: Date, now = new Date()): Report {
  const windowStart = new Date(asOf.getTime() - cfg.windowMinutes * 60000);
  const stats = aggregate(rows, windowStart, asOf, Object.keys(cfg.integrations));
  // Expected volume only counts the part of the window the logs span. Coverage is global, from ALL
  // integrations: per-integration coverage would excuse one that went quiet and then sent a single request.
  const oldest = oldestLog(rows);
  const coveredMinutes = oldest
    ? Math.max(0, (asOf.getTime() - Math.max(windowStart.getTime(), oldest.getTime())) / 60000)
    : cfg.windowMinutes;
  const { overall, sorted } = rollup(stats.map((s) => evaluate(s, cfg, asOf, coveredMinutes)));

  // The monitor must not fail silently: whatever --as-of says, old data gets a loud banner.
  const newest = newestLog(rows);
  const staleFor = newest ? (now.getTime() - newest.getTime()) / 60000 : Infinity;
  if (staleFor > cfg.silentAfterMinutes) {
    overall.warnings.unshift(newest
      ? `Newest log is from ${newest.toISOString().slice(0, 16).replace("T", " ")} UTC (${age(staleFor)} old): this report is historical, not current. If that is unexpected, check the log pipeline.`
      : "No log rows at all: check the log pipeline before trusting this report.");
  }
  if (rejected.length) {
    overall.warnings.push(`${rejected.length} log row(s) rejected as malformed (${[...new Set(rejected.map((r) => r.reason))].join("; ")})`);
  }
  return {
    generatedAt: now.toISOString(),
    asOf: asOf.toISOString(),
    windowStart: windowStart.toISOString(),
    windowMinutes: cfg.windowMinutes,
    overall,
    integrations: sorted,
  };
}

// Seed data is historical, so by default the window ends at the newest log line (and the stale
// banner says so). In production pass --as-of now, so a dead feed also shows up as per-integration silence.
export function defaultAsOf(load: LoadResult): Date {
  return newestLog(load.rows) ?? new Date();
}
