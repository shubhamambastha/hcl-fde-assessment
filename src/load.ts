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
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}
