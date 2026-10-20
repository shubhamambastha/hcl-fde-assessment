# Solution Design: Integration Health for Brightline HR

## 1. Problem

Ops hears about broken integrations from customer tickets, days late. They want a **morning view of which integrations need attention, and why**. Marcus left "unhealthy" undefined, so the core of the work is defining it as explicit, tunable rules.

## 2. What the data shows

The seed data has 60 rows: 5 integrations × 12 requests, one every 5 minutes from 09:00 to 09:55. There is no tenant ID and no timezone.

- **Greenhouse ATS:** 5 timeouts (`status_code: null`, 30 s) + 1×500 = 6/12 failing → *unhealthy*
- **ADP Payroll:** 5×500 from 09:05; last 2 requests succeeded → *unhealthy, critical*
- **DocuSign:** 4×429; ~690 ms is its usual latency → *degraded*
- **Slack, Workday:** one 5xx each, both at 09:30 → *healthy (isolated)*

**The starter helper is wrong.** `compute_error_rate` drops timeouts entirely, so **Greenhouse reads 14.3% instead of 50%** and looks healthier than ADP. `average_latency_ms` hides the slow tail. I replaced both calculations, added a regression test, and kept the loader.

## 3. Assumptions (questions for Marcus)

1. *Real requests or probes?* The 5-minute cadence looks like a probe. **Assumed: real requests**, ~12/h.
2. *Are 429s and timeouts retried?* **Assumed: yes**, so DocuSign is amber. If not, one config change makes it red.
3. *Is there a tenant ID?* Without one, "Greenhouse is down" and "one customer's key expired" look the same. **This is the biggest data gap.**
4. *Which integrations are critical?* **Payroll.** *Timezone?* **UTC.**
5. *Who acts?* 5xx and timeouts → Ops; 401/403 → Customer Success; 400, 422 and 429 → Engineering.

## 4. Approach

A batch job of pure functions, with every threshold in `config/thresholds.jsonc`:

```
load (check config; reject + count bad rows) → classify each request
  (success | timeout | server_error | auth | client_error | rate_limited | unknown)
→ aggregate per integration → evaluate rules (worst signal wins) → CLI · JSON · HTML · optional LLM summary
```

Statuses, worst first: `unhealthy` > `degraded` > `insufficient_data` > `healthy`. Each comes with a reason, such as "50% of requests failing (6/12): 5 timeouts, 1 5xx error, since 09:05". **The overall picture is the status counts**, worst first. At 200 integrations it becomes counts by category plus a separate status for the critical integrations.

| Signal | Amber / Red | Why |
|---|---|---|
| Failures (5xx, timeout, 401/403, 4xx) ÷ **all** requests | ≥ 1% / ≥ 5% | Production-scale values: 15% of payroll failing must be red. Small samples are handled by a separate rule requiring **at least 2 failures** (at 12 req/h, a single failure is already 8.3%), not by loosening the rate. |
| Auth (401/403) | any / via failure rule | Credentials don't fail at random, so one 401 is enough to flag, without waiting for a second failure. |
| 429s, tracked separately | ≥ 10% / ≥ 50% | An early warning, not a failure, as long as retries work. |
| p95 vs the integration's **own** normal | ≥ 2× / ≥ 4× | 700 ms is normal for DocuSign but bad for Slack. Needs ≥ 10 successful requests. The seed baselines came from this same hour, so this rule can't fire on the seed data; the tests cover it. |
| Volume vs expected | < 50% / < 20% | Catches drops that error rates miss. Expected volume counts only the time the logs actually cover, across all integrations. A 24 h window over 1 h of data raises no false alarm, but one integration going quiet still does. |
| Silence | red after max(15 min, 3 missed requests) | No traffic means no errors to catch. Only applies where traffic is expected. |
| < 10 requests, no rule fired | `insufficient_data` | Never show green without evidence. |

**Timeouts and 5xx both count as failures**, because either way the sync didn't happen. They are labelled separately because the fixes differ. A timeout's 30 s is the client's cutoff, not a real latency, so it is left out of p95.

## 5. Rejected alternatives

- **Weighted 0–100 score.** "62/100" gives ops nothing to act on. The worst signal plus a reason does.
- **Single error-rate threshold.** It misses silence, misreads 429s, and goes red on a single failure.
- **Global latency threshold.** DocuSign would be permanently red. Comparing each integration to its own normal measures change, not slowness.
- **5-minute buckets, or last 15 min vs earlier.** On this data each 5-minute bucket holds one request (0% or 100%), and the last 15 minutes holds only 3. I use the whole hour instead: onset is the first failure, and recovery is shown when the last few requests succeed.
- **Leaving 401/403 out of the failure rate.** Without tenant IDs, one tenant's expired key looks the same as our app's credentials being revoked, and in that case red is right. With tenant IDs, auth failures from a single tenant would go to Customer Success and stay amber.
- **Letting criticality change the status.** Red must mean the same thing for every integration. Criticality sets **priority** only: sort order now, paging later.
- **Letting the LLM decide health.** That would be neither reproducible nor testable. Rules decide and the LLM only narrates. The report still ships if the LLM call fails.
- **A database or web app.** Not needed for a morning view. A static HTML page has nothing to host or secure.
- **Staying in the starter's Python.** There was little to reuse: about 50 lines, with the main calculation wrong. TypeScript is my fastest stack, and Node 22.18+ runs `.ts` files without a build step.

## 6. Production shape

- **Compute hourly, then send a morning digest** of the last 24 h compared against a trailing 7-day normal. For now, the normal values are fixed numbers in the config.
- **The monitor must not fail silently.** The config is validated at startup, because one misspelled `minFailures` would otherwise turn every integration green. If the logs are stale, the report shows a "this report is historical" banner. With `--as-of now`, a dead log feed makes every integration show as silent, and the report says "suspect the log pipeline".
- **Real-time alerts** reuse the same rules over 15 minutes, only for critical integrations turning unhealthy.

## 7. With more time, data or budget

1. **Tenant IDs**, to separate "integration broken" from "N tenants broken".
2. **History in Postgres**: real baselines, trends, "failing since yesterday", and alert acknowledgement.
3. **Threshold tuning**: replay 4–8 weeks of logs against support tickets, and keep the values that caught real incidents early without extra noise.
4. **Cross-integration correlation**: Slack and Workday failed in the same minute, which hints at a cause on our side (network egress, DNS). Two failures are too few to flag on.
5. **Scale** (200 integrations, millions of requests a day): the same rules, run on 5-minute counts and t-digest latency summaries. The dashboard timeline would also switch to 5-minute buckets.
