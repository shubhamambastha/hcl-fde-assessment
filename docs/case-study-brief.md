# FDE Take-Home Case Study: API Integration Health

## Before you start

This exercise mirrors a real Forward Deployed Engineer (FDE) engagement: a customer brings you a genuine but partially-specified problem, and you're expected to (1) clarify/assume what's needed, (2) propose a solution, (3) build a working version of it, and (4) present and defend your approach to the customer (in this case, our panel).

**What we're evaluating:** how you handle ambiguity, the soundness of your design judgment, your ability to build a working solution under real constraints, how clearly you communicate your reasoning, and how you respond when your approach is challenged. We are **not** grading for a "perfect" or exhaustive solution — a well-reasoned, appropriately-scoped solution with clearly stated trade-offs is exactly what we want to see.

## The customer

**Brightline HR** is an HR platform that integrates with several third-party systems (payroll, e-signature, ATS, directory sync, notifications) on behalf of its customers. Their Head of Platform Ops, Marcus Webb, reached out with the following ask:

> "We only find out an integration is broken when a customer files a support ticket — usually days after it started failing. We have request logs for each integration. I want something our ops team can glance at each morning that tells them which integrations are actually healthy and which ones need attention, without them having to dig through raw logs.
>
> What counts as 'unhealthy' is honestly a judgment call — that's part of what I'm hoping you can help us figure out."

**Note:** Marcus's ask is intentionally incomplete. You will need to decide things like: what error rate (and over what window) is worth flagging, how to weigh error rate against latency, how to roll up multiple integrations into an overall health picture, and how often this should refresh. **Document whatever assumptions you make.**

## What we're providing you

- A seed dataset of realistic (synthetic) request logs across 5 integrations over about an hour.
- A minimal starter repository scaffold with basic error-rate and latency helpers, so you're not starting from a completely blank page.
- *(See `starter_kit/` alongside this brief.)*

## What you have full freedom on

- **Language/stack** — use whatever you're most productive in.
- **Scope** — you decide what's in v1 versus "future work." A smaller, well-reasoned scope beats an ambitious, half-finished one.
- **Exact thresholds** — pick reasonable defaults and state your reasoning; there's no single "correct" number we're looking for.

## Time expectation

We expect this to take **roughly 3-4 focused hours**, with a full week of calendar time to fit it in. If you're well past 4-5 hours, **stop** — use your README to describe what you'd tackle next.

## Required deliverables

1. **`SOLUTION_DESIGN.md`** (1-2 pages): the problem restated in your own words, your assumptions, your proposed approach, the trade-offs you considered, and what you'd do with more time/data/budget.
2. **Working implementation** — should run end-to-end against the provided dataset and produce a clear "here's the health of each integration, and why" view.
3. **`README.md`** — how to run it, known limitations.

## Optional bonus track (not required, never penalized if skipped)

You're welcome to explore an AI-powered enhancement — for example, using an LLM to turn a set of raw health metrics into a short, plain-English incident summary an ops person could read at a glance (e.g., "Greenhouse ATS Sync is failing roughly half its requests this hour, mostly due to timeouts rather than explicit errors"). This is a **plus signal**, not a gate.

## What happens after you submit

We'll review your submission ahead of a **30-45 minute live session**: a walkthrough of your design doc and a short demo, followed by Q&A, including "what if..." questions and the occasional new constraint introduced mid-conversation.

## Submission

Send us a link to your repository (or a zip archive) containing your code, `SOLUTION_DESIGN.md`, and `README.md`.
