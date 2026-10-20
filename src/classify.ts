// Every request lands in exactly one outcome. Different outcomes mean different
// root causes and different owners, which is what makes a reason actionable.
import type { LogRow } from "./load.ts";

export type Outcome = "success" | "timeout" | "server_error" | "auth" | "client_error" | "rate_limited" | "unknown";
export type FailureOutcome = Exclude<Outcome, "success">;

const NOUN: Record<FailureOutcome, [string, string]> = {
  timeout: ["timeout", "timeouts"],
  server_error: ["5xx error", "5xx errors"],
  auth: ["auth failure (401/403)", "auth failures (401/403)"],
  client_error: ["4xx validation error", "4xx validation errors"],
  rate_limited: ["rate-limited request (429)", "rate-limited requests (429)"],
  unknown: ["unrecognised failure", "unrecognised failures"],
};

export const label = (k: FailureOutcome, n: number) => `${n} ${NOUN[k][n === 1 ? 0 : 1]}`;

export const OWNER: Record<FailureOutcome, string> = {
  timeout: "Ops / provider",
  server_error: "Ops / provider",
  auth: "Customer Success (tenant credentials)",
  client_error: "Engineering (our payload)",
  rate_limited: "Engineering (quota / backoff)",
  unknown: "Ops (check log format)",
};

export function classify(row: LogRow): Outcome {
  // Timeouts have no HTTP code: the starter helper dropped them entirely.
  if (row.status === "timeout") return "timeout";
  const c = row.statusCode;
  if (c !== null) {
    if (c >= 200 && c < 300) return "success";
    if (c === 429) return "rate_limited";
    if (c === 401 || c === 403) return "auth";
    if (c >= 400 && c < 500) return "client_error";
    if (c >= 500) return "server_error";
  }
  if (row.status === "success") return "success";
  return "unknown";
}
