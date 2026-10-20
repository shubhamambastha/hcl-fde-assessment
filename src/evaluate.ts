// Rules -> one status per integration, worst signal wins, every status explained.
// Deliberately no weighted score: "5 timeouts since 09:05" is actionable, "62/100" is not.
import { label, OWNER, type FailureOutcome } from "./classify.ts";
import type { Stats } from "./aggregate.ts";

export type Status = "unhealthy" | "degraded" | "insufficient_data" | "healthy";
type Band = { degraded: number; unhealthy: number };

export type IntegrationConfig = { critical?: boolean; expectedPerHour?: number; baselineP95Ms?: number };
export type Config = {
  windowMinutes: number;
  minRequests: number;
  minFailures: number;
  failureRatePct: Band;
  rateLimitedPct: Band;
  p95VsBaseline: Band;
  volumeVsExpected: Band; // lower is worse
  silentAfterMinutes: number;
  integrations: Record<string, IntegrationConfig>;
};

export type Health = {
  integration: string;
  status: Status;
  critical: boolean;
  reasons: string[]; // why it is not healthy (or why it is)
  notes: string[]; // context that did not change the status
  owners: string[];
  stats: Stats;
};

export const SEVERITY: Record<Status, number> = { unhealthy: 3, degraded: 2, insufficient_data: 1, healthy: 0 };

export const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const r1 = (n: number) => Math.round(n * 10) / 10;

function failureBreakdown(s: Stats, kinds: FailureOutcome[]): string {
  return kinds.filter((k) => s.counts[k] > 0).map((k) => label(k, s.counts[k])).join(", ");
}

const HARD: FailureOutcome[] = ["timeout", "server_error", "auth", "client_error", "unknown"];

export function evaluate(s: Stats, cfg: Config, asOf: Date): Health {
  const ic = cfg.integrations[s.integration];
  const flags: { level: Status; reason: string }[] = [];
  const notes: string[] = [];
  const flag = (level: Status, reason: string) => flags.push({ level, reason });
  const band = (value: number, b: Band) => (value >= b.unhealthy ? "unhealthy" : value >= b.degraded ? "degraded" : null);

  // 1. Silence: the failure an error-rate check can never see. Only meaningful when we expect
  // traffic, and "too quiet" scales with cadence: 3 missed beats, never less than silentAfterMinutes.
  const perHour = ic?.expectedPerHour;
  const silentFor = s.lastSeen ? (asOf.getTime() - s.lastSeen.getTime()) / 60000 : Infinity;
  const silent = !!perHour && silentFor > Math.max(cfg.silentAfterMinutes, (3 * 60) / perHour);
  if (silent) {
    flag("unhealthy", s.lastSeen
      ? `No requests since ${hhmm(s.lastSeen)} (${Math.round(silentFor)} min silent)`
      : `No requests at all in the last ${cfg.windowMinutes} min`);
  }

  // 2. Volume drop vs what this integration normally sends.
  const expected = ic?.expectedPerHour !== undefined ? (ic.expectedPerHour * cfg.windowMinutes) / 60 : undefined;
  if (expected && s.total > 0) {
    const ratio = s.total / expected;
    const level = ratio < cfg.volumeVsExpected.unhealthy ? "unhealthy" : ratio < cfg.volumeVsExpected.degraded ? "degraded" : null;
    if (level) flag(level, `Volume dropped to ${s.total} requests (expected ~${Math.round(expected)})`);
  }

  // 3. Hard failure rate, gated by an absolute count so 1 blip in a small sample is not a red card.
  if (s.hardFailures >= cfg.minFailures) {
    const level = band(s.failureRatePct, cfg.failureRatePct);
    if (level) {
      const since = s.firstFailure ? `, since ${hhmm(s.firstFailure)}` : "";
      flag(level, `${r1(s.failureRatePct)}% of requests failing (${s.hardFailures}/${s.total}): ${failureBreakdown(s, HARD)}${since}`);
    }
  } else if (s.hardFailures > 0) {
    const t = s.timeline.filter((e) => e.outcome !== "success" && e.outcome !== "rate_limited").map((e) => hhmm(e.t));
    notes.push(`${failureBreakdown(s, HARD)} at ${t.join(", ")}: isolated, below the ${cfg.minFailures}-failure threshold`);
  }

  // 4. Auth never "flakes": one 401/403 means someone's credentials are broken.
  if (s.counts.auth > 0) flag("degraded", `${s.counts.auth} auth failure(s): a tenant's credentials likely expired or were revoked`);

  // 5. Throttling: an early warning, kept separate from hard failures.
  if (s.counts.rate_limited >= cfg.minFailures) {
    const level = band(s.rateLimitedPct, cfg.rateLimitedPct);
    if (level) flag(level, `${r1(s.rateLimitedPct)}% of requests rate-limited (${s.counts.rate_limited}/${s.total} got 429)`);
  }

  // 6. Latency against this integration's own normal, not a global number.
  if (!ic?.baselineP95Ms) {
    notes.push("No latency baseline configured, so latency is not judged");
  } else if (s.successes < cfg.minRequests) {
    if (s.total > 0 && !flags.length) notes.push(`Only ${s.successes} successful requests, too few to judge p95 latency`);
  } else if (s.p95Ms !== null) {
    const level = band(s.p95Ms / ic.baselineP95Ms, cfg.p95VsBaseline);
    if (level) flag(level, `p95 latency ${s.p95Ms} ms is ${r1(s.p95Ms / ic.baselineP95Ms)}x its normal ${ic.baselineP95Ms} ms`);
  }

  if (!ic) notes.push("Not in config: no expected volume or latency baseline yet, so only error rules apply");

  let status: Status = flags.reduce<Status>((w, f) => (SEVERITY[f.level] > SEVERITY[w] ? f.level : w), "healthy");
  const reasons = flags.map((f) => f.reason);

  // Never call something green without evidence.
  if (status === "healthy" && s.total < cfg.minRequests) {
    status = "insufficient_data";
    reasons.push(`Only ${s.total} requests in window (need ${cfg.minRequests} to judge)`);
  }
  if (status === "healthy") {
    const lat = s.p95Ms !== null ? `, p95 ${s.p95Ms} ms` : "";
    reasons.push(`${s.successes}/${s.total} requests succeeded${lat}`);
  }
  if (status !== "healthy" && !silent && s.trailingSuccesses >= 2) {
    notes.push(`Last ${s.trailingSuccesses} requests succeeded: may be recovering, confirm on next refresh`);
  }

  const owners = [...new Set((Object.keys(OWNER) as FailureOutcome[])
    .filter((k) => s.counts[k] > 0 && status !== "healthy")
    .map((k) => OWNER[k]))];
  if (silent) owners.unshift("Ops (connector / log pipeline)");

  return { integration: s.integration, status, critical: !!ic?.critical, reasons, notes, owners, stats: s };
}

export type Overall = { status: Status; counts: Record<Status, number>; headline: string; warnings: string[] };

// Worst status wins; critical integrations sort first within a status.
// Criticality changes priority, not the health verdict.
export function rollup(healths: Health[]): { overall: Overall; sorted: Health[] } {
  const sorted = [...healths].sort((a, b) =>
    SEVERITY[b.status] - SEVERITY[a.status] ||
    Number(b.critical) - Number(a.critical) ||
    b.stats.failureRatePct - a.stats.failureRatePct ||
    a.integration.localeCompare(b.integration));
  const counts: Record<Status, number> = { unhealthy: 0, degraded: 0, insufficient_data: 0, healthy: 0 };
  for (const h of healths) counts[h.status]++;
  const warnings: string[] = [];
  if (healths.length && healths.every((h) => h.stats.total === 0)) {
    warnings.push("No logs from ANY integration in the window: suspect the log pipeline before blaming providers");
  }
  const headline = (Object.keys(counts) as Status[]).filter((k) => counts[k]).map((k) => `${counts[k]} ${k.replace("_", " ")}`).join(", ");
  return { overall: { status: sorted[0]?.status ?? "insufficient_data", counts, headline, warnings }, sorted };
}
