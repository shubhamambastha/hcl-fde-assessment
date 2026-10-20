# Solution Design: Integration Health for Brightline HR

## 1. Problem

Ops learns that an integration is broken from customer tickets, days late. They need a **morning view that shows, per integration, whether it is healthy or needs attention, and why**, phrased so someone knows what to do. Marcus left "unhealthy" undefined. Turning that judgment into explicit, tunable rules is the core of the work.

## 2. What the data shows

There are 60 rows: 5 integrations × 12 requests, one every 5 minutes from 09:00 to 09:55. There is no tenant ID and no timezone. The planted cases:

- **Greenhouse ATS:** 5 timeouts (`status_code: null`, 30 s) + 1×500 = 6/12 failing → *unhealthy*
- **ADP Payroll:** 5×500 from 09:05; the last 2 requests succeeded → *unhealthy, critical*
- **DocuSign:** 4×429; ~690 ms latency is normal for it → *degraded*
- **Slack, Workday:** one 5xx each, both at 09:30 → *healthy (isolated)*

**The starter helper is wrong.** `compute_error_rate` drops timeouts from both the numerator and the denominator, so **Greenhouse reads 14.3% instead of 50%** and looks better than ADP. `average_latency_ms` averages only successes, which hides the slow tail. I kept the loader and summary shape, replaced both calculations, and added a regression test.

## 3. Assumptions (questions for Marcus)

1. *Real requests or scheduled probes?* The 5-minute cadence looks like a probe. **Assumed: real requests**, ~12 per hour.
2. *Are 429s and timeouts retried?* **Assumed: yes**, so DocuSign is amber. If envelopes are being dropped, one config value turns it red.
3. *Do logs carry a tenant ID?* Without one, "Greenhouse is down" and "one customer's key expired" look the same. **This is the biggest data gap.**
4. *Which integrations are critical?* **Assumed: payroll.**
5. *Timezone?* **Assumed: UTC.**
6. *Who acts on what?* 5xx and timeouts go to Ops; 401/403 to Customer Success; 400/422 and 429 to Engineering.

## 4. Approach

A batch job made of pure functions. Every threshold lives in `config/thresholds.jsonc`.

```
logs → load (reject + count bad rows) → classify each request
     (success | timeout | server_error | auth | client_error | rate_limited | unknown)
     → aggregate per integration (failure %, 429 %, p50/p95 of successes, first failure, last seen)
     → evaluate rules → status + reasons + owner (worst signal wins)
     → roll up → CLI · report.json · dashboard.html · optional LLM summary
```

Statuses, worst first: `unhealthy` > `degraded` > `insufficient_data` > `healthy`. Each status comes with a reason, for example "50% of requests failing (6/12): 5 timeouts, 1 5xx error, since 09:05". **The overall picture is the counts** ("2 unhealthy, 1 degraded, 2 healthy"), with the worst integrations listed first. A single overall colour works for five integrations, but at 200 something is always red. At that size the roll-up becomes counts by category plus a separate status for the critical integrations.

| Signal | Degraded | Unhealthy | Why |
|---|---|---|---|
| Failures (5xx, timeout, 401/403, 4xx) ÷ **all** requests | ≥ 1% | ≥ 5% | Set for production volume, where 15% of payroll failing must be red. The rule only fires after **≥ 2 failures**, because at 12 req/h a single blip is 8.3%. These are two separate settings: I don't loosen the rate thresholds to compensate for small samples. |
| Auth (401/403) | any | via the rate rule | Credentials don't fail at random. One 401 means something is broken now, so it skips the 2-failure minimum. |
| 429s, tracked separately | ≥ 10% | ≥ 50% | An early warning, not a failure, as long as retries work. |
| p95 vs the integration's **own** normal | ≥ 2× | ≥ 4× | 700 ms is normal for DocuSign and bad for Slack. Needs ≥ 10 successful requests. On the seed data the "normal" values came from this same hour, so this rule cannot fire here; only the tests exercise it. |
| Volume vs expected | < 50% | < 20% | Catches drops that error rates miss. |
| Silence | n/a | > max(15 min, 3 missed beats) | Zero traffic produces zero errors. Applies only where traffic is expected. |
| < 10 requests and nothing fired | `insufficient_data` | | Never show green without evidence. |

**Timeouts and 5xx both count as failures**, because the sync didn't happen either way. They are labelled separately because the fixes differ. A timeout's 30 s is the client's cap, not a real latency, so it is left out of p95. Otherwise one problem would raise two flags.

## 5. Rejected alternatives

| Rejected | Why |
|---|---|
| Weighted 0–100 score | "62/100" gives ops nothing to act on. Worst signal plus a reason does, and it is auditable. |
| A single error-rate threshold | Misses silence, misreads 429s, and goes red on one blip. |
| A global latency threshold | Would keep DocuSign permanently red. A per-integration normal measures change, not slowness. |
| 5-minute buckets, or last 15 min vs earlier, on the seed data | One request per bucket means every bucket is 0% or 100%, and the last 15 minutes holds only 3 requests. I use the whole hour. Onset comes from the first failure, recovery from "last N succeeded". |
| Leaving 401/403 out of the failure rate | Without tenant IDs, one tenant's expired key looks the same as our app's own credentials being revoked. If every call returns 401, red is right. With tenant IDs, failures concentrated in one tenant go to Customer Success and the integration stays amber. |
| Letting criticality change the status | Red must mean the same thing everywhere. Criticality sets **priority**: sort order now, paging vs. digest later. |
| Letting the LLM decide health | Neither reproducible nor testable. Rules decide, the LLM only narrates the JSON, and the report ships even if the LLM call fails. |
| A database or web app | Not needed for "what's broken this morning". A static HTML file has nothing to host or secure. |
| Staying in the starter's Python | Little to reuse: about 50 lines, and the central calculation was wrong. TypeScript is the stack I can build and defend fastest, and Node 22.18+ runs `.ts` with no build step. |

## 6. Production shape

- **Compute hourly; send a morning digest** covering the last 24 h against a trailing 7-day normal (by hour of day). In this version the "normal" values are fixed numbers in config.
- **The monitor must not fail silently.** If the newest log is older than the silence threshold by the wall clock, every report shows a "this report is historical" banner. In production, run with `--as-of now`. Then a dead log feed also shows every integration as silent, with the message "suspect the log pipeline before blaming providers".
- **Real-time alerts** reuse the same rules over a 15-minute window, only for critical integrations that are unhealthy.

## 7. With more time, data or budget

1. **Tenant IDs**, to separate "integration broken" from "N tenants broken".
2. **History in Postgres** for real baselines, trends, "failing since yesterday 14:00", and alert acknowledgement.
3. **Tune thresholds:** replay 4–8 weeks of logs against support tickets, and pick per-integration values that would have caught each real incident early without extra noise.
4. **Cross-integration correlation:** Slack and Workday failed in the same minute, which hints at a problem on our side (network egress, DNS). Two data points is too few to flag today.
5. **Scale (200 integrations, millions of requests a day):** same rules, run on pre-aggregated 5-minute counts and latency summaries (t-digest) instead of raw rows. The dashboard timeline switches to 5-minute buckets.
