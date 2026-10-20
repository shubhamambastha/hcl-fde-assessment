import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadLogs, parseLogs, type LogRow } from "../src/load.ts";
import { classify } from "../src/classify.ts";
import { aggregateOne } from "../src/aggregate.ts";
import { evaluate, type Config } from "../src/evaluate.ts";
import { buildReport, defaultAsOf } from "../src/report.ts";

const baseCfg: Config = JSON.parse(readFileSync("config/thresholds.json", "utf8"));
const T0 = Date.parse("2026-08-04T09:00:00Z");
const ASOF = new Date(T0 + 55 * 60000);

// 12 requests, one every 5 min, outcome per slot: "ok" | "500" | "429" | "401" | "422" | "timeout"
function rows(name: string, slots: string[], latency = 100): LogRow[] {
  return slots.map((s, i) => ({
    integration: name,
    timestamp: new Date(T0 + i * 5 * 60000),
    status: s === "ok" ? "success" : s === "timeout" ? "timeout" : "error",
    statusCode: s === "ok" ? 200 : s === "timeout" ? null : Number(s),
    latencyMs: s === "timeout" ? 30000 : latency,
  }));
}
const ok = (n: number) => Array(n).fill("ok");
const health = (r: LogRow[], cfg: Config = baseCfg, name = r[0]?.integration ?? "X") =>
  evaluate(aggregateOne(name, r), cfg, ASOF);

describe("classify", () => {
  it("treats a null-code timeout as a timeout, not as missing data", () => {
    expect(classify(rows("X", ["timeout"])[0])).toBe("timeout");
  });
  it("separates 429, auth, validation and 5xx", () => {
    expect(["429", "401", "403", "422", "503"].map((c) => classify(rows("X", [c])[0])))
      .toEqual(["rate_limited", "auth", "auth", "client_error", "server_error"]);
  });
  it("trusts the HTTP code over the status string, and flags unknown statuses", () => {
    expect(classify({ ...rows("X", ["ok"])[0], status: "success", statusCode: 500 })).toBe("server_error");
    expect(classify({ ...rows("X", ["ok"])[0], status: "weird", statusCode: null })).toBe("unknown");
  });
});

describe("seed data end to end", () => {
  const report = buildReport(loadLogs("data/integration_logs.json"), baseCfg, defaultAsOf(loadLogs("data/integration_logs.json")));
  const by = Object.fromEntries(report.integrations.map((h) => [h.integration, h]));

  it("detects every planted scenario", () => {
    expect(by["Greenhouse ATS Sync"].status).toBe("unhealthy");
    expect(by["ADP Payroll Sync"].status).toBe("unhealthy");
    expect(by["DocuSign Envelope API"].status).toBe("degraded");
    expect(by["Slack Notifications"].status).toBe("healthy");
    expect(by["Workday Directory Sync"].status).toBe("healthy");
  });
  it("regression: Greenhouse is 50% failing, not the 14.3% the starter helper reported", () => {
    expect(by["Greenhouse ATS Sync"].stats.failureRatePct).toBe(50);
    expect(by["Greenhouse ATS Sync"].reasons[0]).toContain("5 timeouts");
  });
  it("sorts worst first, critical first within a status", () => {
    expect(report.integrations[0].integration).toBe("ADP Payroll Sync");
  });
});

describe("edge cases", () => {
  it("one isolated failure stays green, with a note", () => {
    const h = health(rows("X", [...ok(6), "500", ...ok(5)]));
    expect(h.status).toBe("healthy");
    expect(h.notes.join()).toContain("isolated");
  });

  it("1 failure in 2 requests is not shown as 50% red", () => {
    const h = health(rows("New", ["500", "ok"]), { ...baseCfg, integrations: {} });
    expect(h.status).toBe("insufficient_data");
  });

  it("2 of 2 failing is red even at low volume", () => {
    const h = health(rows("New", ["500", "500"]), { ...baseCfg, integrations: {} });
    expect(h.status).toBe("unhealthy");
  });

  it("all timeouts is unhealthy", () => {
    expect(health(rows("X", Array(12).fill("timeout"))).status).toBe("unhealthy");
  });

  it("zero traffic for an expected integration is unhealthy (silent failure)", () => {
    const h = evaluate(aggregateOne("ADP Payroll Sync", []), baseCfg, ASOF);
    expect(h.status).toBe("unhealthy");
    expect(h.reasons[0]).toContain("No requests");
  });

  it("logs that stop mid-window are caught as silence", () => {
    const h = health(rows("ADP Payroll Sync", ok(5))); // last request 09:20, asOf 09:55
    expect(h.status).toBe("unhealthy");
    expect(h.reasons.join()).toContain("No requests since 09:20");
  });

  it("volume drop without silence is caught", () => {
    // 5 requests in the last 25 min vs 12 expected
    const r = rows("ADP Payroll Sync", ok(12)).slice(7);
    expect(health(r).reasons.join()).toContain("Volume dropped");
  });

  it("a single auth failure surfaces and routes to Customer Success", () => {
    const h = health(rows("Slack Notifications", [...ok(11), "401"]));
    expect(h.status).toBe("degraded");
    expect(h.owners.join()).toContain("Customer Success");
  });

  it("p95 latency is judged against the integration's own baseline", () => {
    const docusign = health(rows("DocuSign Envelope API", ok(12), 700)); // slow, but normal for DocuSign
    const slack = health(rows("Slack Notifications", ok(12), 700)); // 4.4x Slack's normal
    expect(docusign.status).toBe("healthy");
    expect(slack.status).toBe("unhealthy");
  });

  it("thresholds come from config: raising the bar changes the verdict", () => {
    const adp = rows("ADP Payroll Sync", [..."ok 500 ok 500 ok 500 ok 500 ok 500 ok ok".split(" ")]);
    expect(health(adp).status).toBe("unhealthy");
    expect(health(adp, { ...baseCfg, failureRatePct: { degraded: 5, unhealthy: 50 } }).status).toBe("degraded");
  });

  it("at production volume: 1.5% failing is amber, 15% failing is red", () => {
    const volume = (failures: number) => Array.from({ length: 1000 }, (_, i) => ({
      integration: "ADP Payroll Sync",
      timestamp: new Date(T0 + (i * 55 * 60000) / 1000),
      status: i < failures ? "error" : "success",
      statusCode: i < failures ? 500 : 200,
      latencyMs: 200,
    }));
    const cfg = { ...baseCfg, integrations: {} };
    expect(health(volume(15), cfg).status).toBe("degraded");
    expect(health(volume(150), cfg).status).toBe("unhealthy");
  });

  it("stale data gets a loud banner even when --as-of defaults to the newest log", () => {
    const load = loadLogs("data/integration_logs.json");
    const fresh = buildReport(load, baseCfg, ASOF, new Date(ASOF.getTime() + 5 * 60000));
    const stale = buildReport(load, baseCfg, ASOF, new Date(ASOF.getTime() + 3 * 86400000));
    expect(fresh.overall.warnings.join()).not.toContain("historical");
    expect(stale.overall.warnings[0]).toContain("3 days old");
  });

  it("does not crash on hundreds of thousands of rows", () => {
    const many = { logs: Array.from({ length: 200_000 }, (_, i) => ({
      integration: "Slack Notifications", timestamp: new Date(T0 + i).toISOString(), status: "success", status_code: 200, latency_ms: 100,
    })) };
    const load = parseLogs(many);
    expect(() => buildReport(load, baseCfg, defaultAsOf(load))).not.toThrow();
  });

  it("malformed rows are rejected and reported, not silently dropped", () => {
    const load = parseLogs({ logs: [{ integration: "X", status: "success" }, { timestamp: "2026-08-04T09:00:00" }] });
    expect(load.rows).toHaveLength(0);
    const report = buildReport(load, baseCfg, ASOF);
    expect(report.overall.warnings.join()).toContain("2 log row(s) rejected");
    expect(report.overall.warnings.join()).toContain("log pipeline");
  });
});
