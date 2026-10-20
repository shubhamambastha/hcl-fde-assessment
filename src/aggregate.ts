// Per-integration metrics for one window. Replaces starter `compute_error_rate`
// (which left timeouts out of both numerator and denominator: Greenhouse read 14% instead of 50%)
// and `average_latency_ms` (a mean over successes hides the tail; we use p50/p95).
import type { LogRow } from "./load.ts";
import { classify, type Outcome } from "./classify.ts";

export type Stats = {
  integration: string;
  total: number;
  counts: Record<Outcome, number>;
  hardFailures: number; // everything except success and 429
  failureRatePct: number; // hardFailures / total: every request is in the denominator
  rateLimitedPct: number;
  successes: number;
  p50Ms: number | null; // latency over successful requests only (a timeout's 30s is the client cap, not a measurement)
  p95Ms: number | null;
  firstFailure: Date | null;
  lastSeen: Date | null;
  trailingSuccesses: number;
  timeline: { t: Date; outcome: Outcome }[];
};

const emptyCounts = (): Record<Outcome, number> => ({
  success: 0, timeout: 0, server_error: 0, auth: 0, client_error: 0, rate_limited: 0, unknown: 0,
});

// Nearest-rank percentile: no interpolation, so the result is always a latency that actually happened.
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);

export function aggregateOne(integration: string, rows: LogRow[]): Stats {
  const timeline = rows
    .map((r) => ({ t: r.timestamp, outcome: classify(r), latency: r.latencyMs }))
    .sort((a, b) => a.t.getTime() - b.t.getTime());
  const counts = emptyCounts();
  for (const e of timeline) counts[e.outcome]++;

  const hardFailures = timeline.length - counts.success - counts.rate_limited;
  const latencies = timeline
    .filter((e) => e.outcome === "success" && e.latency !== null)
    .map((e) => e.latency as number)
    .sort((a, b) => a - b);
  let trailingSuccesses = 0;
  for (let i = timeline.length - 1; i >= 0 && timeline[i].outcome === "success"; i--) trailingSuccesses++;

  return {
    integration,
    total: timeline.length,
    counts,
    hardFailures,
    failureRatePct: pct(hardFailures, timeline.length),
    rateLimitedPct: pct(counts.rate_limited, timeline.length),
    successes: counts.success,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    firstFailure: timeline.find((e) => e.outcome !== "success" && e.outcome !== "rate_limited")?.t ?? null,
    lastSeen: timeline.at(-1)?.t ?? null,
    trailingSuccesses,
    timeline: timeline.map(({ t, outcome }) => ({ t, outcome })),
  };
}

// `expected` names come from config so an integration with zero rows still gets a (silent) entry.
export function aggregate(rows: LogRow[], windowStart: Date, asOf: Date, expected: string[]): Stats[] {
  // One pass over the rows, not one pass per integration.
  const groups = new Map<string, LogRow[]>(expected.map((n) => [n, []]));
  for (const r of rows) {
    if (r.timestamp <= windowStart || r.timestamp > asOf) continue;
    const g = groups.get(r.integration);
    if (g) g.push(r);
    else groups.set(r.integration, [r]);
  }
  return [...groups].map(([n, rs]) => aggregateOne(n, rs));
}
