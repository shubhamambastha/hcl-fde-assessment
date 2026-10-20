// Parse + validate raw log rows. Port of starter `load_logs`, but bad rows are
// rejected and counted instead of crashing or being silently skipped.
import { readFileSync } from "node:fs";
import type { Config } from "./evaluate.ts";

export type LogRow = {
  integration: string;
  timestamp: Date;
  status: string;
  statusCode: number | null;
  latencyMs: number | null;
};

export type Rejected = { index: number; reason: string };
export type LoadResult = { rows: LogRow[]; rejected: Rejected[] };

// Seed timestamps carry no zone; we assume UTC so output is the same on every machine.
function parseTime(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(v);
  const d = new Date(hasZone ? v : v + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseLogs(raw: unknown): LoadResult {
  const list = (raw as { logs?: unknown })?.logs;
  if (!Array.isArray(list)) throw new Error('Log file must be an object with a "logs" array');

  const rows: LogRow[] = [];
  const rejected: Rejected[] = [];
  list.forEach((r: any, index) => {
    const timestamp = parseTime(r?.timestamp);
    if (typeof r?.integration !== "string" || !r.integration) return rejected.push({ index, reason: "missing integration" });
    if (!timestamp) return rejected.push({ index, reason: "missing or invalid timestamp" });
    if (typeof r.status !== "string") return rejected.push({ index, reason: "missing status" });
    rows.push({
      integration: r.integration,
      timestamp,
      status: r.status,
      statusCode: typeof r.status_code === "number" ? r.status_code : null,
      latencyMs: typeof r.latency_ms === "number" ? r.latency_ms : null,
    });
  });
  return { rows, rejected };
}

export function loadLogs(path: string): LoadResult {
  return parseLogs(JSON.parse(readFileSync(path, "utf8")));
}

// Config is JSON with whole-line `//` comments (.jsonc). Only full comment lines are stripped,
// so a "//" inside a string value can never be mistaken for a comment.
export function loadConfig(path: string): Config {
  return validateConfig(JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "")));
}

const NUMBERS = ["windowMinutes", "minRequests", "minFailures", "silentAfterMinutes"] as const;
const BANDS = ["failureRatePct", "rateLimitedPct", "p95VsBaseline", "volumeVsExpected"] as const;
const INTEGRATION_KEYS = ["critical", "expectedPerHour", "baselineP95Ms"];

// A misspelled key must stop the run, not quietly switch a rule off: a typo in `minFailures`
// alone would otherwise turn every integration green. All problems are reported at once.
export function validateConfig(raw: any): Config {
  const errors: string[] = [];
  const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const known = new Set<string>([...NUMBERS, ...BANDS, "integrations"]);

  for (const k of Object.keys(raw ?? {})) if (!known.has(k)) errors.push(`unknown key "${k}"`);
  for (const k of NUMBERS) if (!isNum(raw?.[k])) errors.push(`"${k}" must be a number >= 0`);
  if (isNum(raw?.windowMinutes) && raw.windowMinutes <= 0) errors.push(`"windowMinutes" must be > 0`);
  if (isNum(raw?.minFailures) && raw.minFailures < 1) errors.push(`"minFailures" must be >= 1`);

  for (const k of BANDS) {
    const b = raw?.[k];
    for (const extra of Object.keys(b ?? {})) {
      if (extra !== "degraded" && extra !== "unhealthy") errors.push(`${k}: unknown key "${extra}"`);
    }
    if (!isNum(b?.degraded) || !isNum(b?.unhealthy)) {
      errors.push(`${k} needs numeric "degraded" and "unhealthy"`);
    } else if (k === "volumeVsExpected" ? b.degraded < b.unhealthy : b.degraded > b.unhealthy) {
      // Volume: lower is worse, so the red line sits below the amber line. Everything else: higher is worse.
      errors.push(k === "volumeVsExpected"
        ? `${k}: "unhealthy" must be <= "degraded" (lower volume is worse)`
        : `${k}: "degraded" must be <= "unhealthy"`);
    }
  }

  if (typeof raw?.integrations !== "object" || raw.integrations === null || Array.isArray(raw.integrations)) {
    errors.push(`"integrations" must be an object`);
  } else {
    for (const [name, ic] of Object.entries<any>(raw.integrations)) {
      for (const k of Object.keys(ic ?? {})) {
        if (!INTEGRATION_KEYS.includes(k)) errors.push(`integrations."${name}": unknown key "${k}" (allowed: ${INTEGRATION_KEYS.join(", ")})`);
      }
      if (ic?.critical !== undefined && typeof ic.critical !== "boolean") errors.push(`integrations."${name}".critical must be true or false`);
      for (const k of ["expectedPerHour", "baselineP95Ms"]) {
        if (ic?.[k] !== undefined && !(isNum(ic[k]) && ic[k] > 0)) errors.push(`integrations."${name}".${k} must be a number > 0`);
      }
    }
  }

  if (errors.length) throw new Error(`Invalid config:\n  - ${errors.join("\n  - ")}`);
  return raw as Config;
}
