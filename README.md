# Integration Health: Brightline HR

This tool turns integration request logs into a morning health report. For each integration it shows one status (**unhealthy / degraded / insufficient data / healthy**), the reasons for it, and who should look.
The design and its reasoning are in [docs/SOLUTION_DESIGN.md](docs/SOLUTION_DESIGN.md). The original brief is in [docs/case-study-brief.md](docs/case-study-brief.md).

## Run it

Requires Node.js **22.18+** (check with `node -v`). It runs TypeScript directly, with no build step. On Node 20 it fails at startup.

```bash
npm install
npm run report          # CLI table + out/report.json + out/dashboard.html
npm test                # 28 tests: edge cases, seed-data scenarios, config validation
npm run typecheck
npm run summary         # same report plus the optional AI summary (needs ANTHROPIC_API_KEY)
```

**Dashboard:** there is no frontend server or build. `npm run report` writes `out/dashboard.html`, a single static page with no scripts or external assets. Open the file directly in a browser (`open out/dashboard.html` on macOS). `out/` is gitignored, so run the report first.

Options:

```bash
node src/main.ts [logs.json] [--config config/thresholds.jsonc] [--as-of <ISO>|now] [--out dir] [--summary]
```

- `--as-of`: the end of the window. It defaults to the newest log line because the seed data is historical. Use `now` in production, so a dead log feed also shows up as silence. Either way, if the newest log is older than `silentAfterMinutes`, a banner says the report is historical. On the seed data that banner always shows, which is expected: the logs are from August 2026.
- `--summary`: adds an AI-written morning note (Claude) to the CLI and dashboard. It needs `ANTHROPIC_API_KEY`. If the call fails, the rule-based report still ships and a one-line notice explains why.

## Change a threshold live

Every number is in `config/thresholds.jsonc`. The failure-rate defaults are degraded ≥ 1% and unhealthy ≥ 5%, and only apply once there are at least 2 failures. For example, to treat 429s as unhealthy above 25%:

```json
"rateLimitedPct": { "degraded": 10, "unhealthy": 25 }
```

Then run `npm run report` again. DocuSign goes from degraded to unhealthy.

To show a 24-hour view, set `"windowMinutes": 1440`. Expected volume only counts the time the logs actually cover, so the 1-hour seed data gives the same verdicts and no false volume alarms.

The config is checked at startup. A misspelled or missing key, or levels in the wrong order, stops the run with a clear error and no report. Without that check, a typo would silently switch a rule off.

## Output on the seed data

| Integration | Status | Why |
|---|---|---|
| ADP Payroll Sync *(critical)* | ✖ unhealthy | 41.7% failing (5×500) since 09:05; last 2 OK, may be recovering |
| Greenhouse ATS Sync | ✖ unhealthy | 50% failing: 5 timeouts + 1×500 since 09:05 |
| DocuSign Envelope API | ▲ degraded | 33% rate-limited (4×429), no hard failures |
| Slack Notifications | ● healthy | 1 isolated 500 at 09:30 (below the 2-failure threshold) |
| Workday Directory Sync | ● healthy | 1 isolated 503 at 09:30 |

## Layout

```
config/thresholds.jsonc  all thresholds, per-integration baselines, criticality
src/load.ts              parse + validate logs (bad rows rejected and reported); load + check config
src/classify.ts          one outcome per request + owner per outcome
src/aggregate.ts         per-integration metrics for the window
src/evaluate.ts          rules → status + reasons; roll-up
src/report.ts            pure pipeline (rows + config + asOf → report)
src/render.ts            CLI table and static HTML
src/summarise.ts         optional LLM narration of the computed report
src/main.ts              CLI entry point
tests/health.test.ts     Vitest suite
docs/                    SOLUTION_DESIGN.md (design + trade-offs), case-study-brief.md (original brief)
integration_utils.py     original starter helper (Python), kept for reference, not used
```

The starter helpers were ported as follows. `load_logs` became `load.ts`, with validation added. `summarize_integrations` became `aggregate.ts`. `compute_error_rate` was **fixed**: it dropped timeouts, so Greenhouse showed 14.3% instead of 50%. `average_latency_ms` was replaced by p50/p95. The language switched from Python to TypeScript because there was little to reuse (see [docs/SOLUTION_DESIGN.md](docs/SOLUTION_DESIGN.md) §5).

## Known limitations

- **No tenant ID in the logs**, so one customer's expired credentials and a provider outage look the same. This is the first data ask.
- **Baselines are static config values, set from the seed hour itself.** As a result, the latency rule can't fire on the seed data, and it only runs where there are ≥ 10 successful requests (Slack and Workday). It is exercised by tests, not by the seed data. Production would use a trailing 7-day baseline.
- **Small samples.** At 12 requests per hour, rates move in 8.3% steps. The 2-failure gate and the `insufficient_data` status reduce false alarms but can't remove them.
- **Timestamps are assumed to be UTC**, since the seed data has no zone.
- **The overall colour is the worst single status.** That works for 5 integrations. At 200 the counts line is the real summary (see [docs/SOLUTION_DESIGN.md](docs/SOLUTION_DESIGN.md) §4).
- **Batch only.** There is no scheduler, alert delivery, history or acknowledgement state. Cron plus this CLI is the v1 deployment.
- **The LLM summary is untested against a live key here.** The no-key path is tested: it skips cleanly. The prompt forbids changing statuses or inventing numbers, but the text isn't verified against the report.
