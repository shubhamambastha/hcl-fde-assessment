// Batch entry point: node src/main.ts [logs.json] [--config path] [--as-of ISO|now] [--out dir] [--summary]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, loadLogs } from "./load.ts";
import { buildReport, defaultAsOf } from "./report.ts";
import { renderCli, renderHtml } from "./render.ts";
import { summarise } from "./summarise.ts";
import type { Config } from "./evaluate.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "config/thresholds.jsonc" },
    "as-of": { type: "string" },
    out: { type: "string", default: "out" },
    summary: { type: "boolean", default: false },
  },
});

let cfg: Config;
try {
  cfg = loadConfig(values.config);
} catch (e) {
  console.error(`${values.config}: ${(e as Error).message}`);
  process.exit(1);
}
const load = loadLogs(positionals[0] ?? "data/integration_logs.json");
const asOfArg = values["as-of"];
const asOf = !asOfArg ? defaultAsOf(load) : asOfArg === "now" ? new Date() : new Date(asOfArg);
if (Number.isNaN(asOf.getTime())) throw new Error(`Invalid --as-of: ${asOfArg}`);

const report = buildReport(load, cfg, asOf);
if (values.summary) {
  try {
    report.summary = await summarise(report);
  } catch (e) {
    // The summary is optional; the rule-based report must still ship.
    console.error(`(LLM summary skipped: ${(e as Error).message})`);
  }
}

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, "report.json"), JSON.stringify(report, null, 2));
writeFileSync(join(values.out, "dashboard.html"), renderHtml(report));
console.log(renderCli(report));
console.log(`\nWrote ${join(values.out, "report.json")} and ${join(values.out, "dashboard.html")}`);
