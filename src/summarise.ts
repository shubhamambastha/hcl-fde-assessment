// Optional: an LLM turns the computed report into a short morning note.
// The model only narrates. Statuses and numbers are decided by rules and passed in as facts.
import Anthropic from "@anthropic-ai/sdk";
import type { Report } from "./report.ts";

const MODEL = "claude-opus-5-5";

const SYSTEM = `You write the morning integration-health note for an HR platform's ops team.
You are given a JSON health report computed by deterministic rules.
Write at most 5 short sentences of plain text (no markdown, no bullet points).
Lead with what needs attention, worst first, and say who should look (from "owners").
Use each integration's status exactly as given; never upgrade or downgrade it.
Only use numbers and times that appear in the report; do not invent causes beyond the reasons given.
If everything is healthy, say so in one sentence.`;

// Only the facts the narrative needs, so the model is not tempted by raw timelines.
export function factsFor(report: Report) {
  return {
    window: `${report.windowStart.slice(11, 16)}-${report.asOf.slice(11, 16)} UTC`,
    overall: report.overall,
    integrations: report.integrations.map((h) => ({
      name: h.integration,
      status: h.status,
      critical: h.critical,
      reasons: h.reasons,
      notes: h.notes,
      owners: h.owners,
      requests: h.stats.total,
      failureRatePct: Math.round(h.stats.failureRatePct * 10) / 10,
    })),
  };
}

export async function summarise(report: Report): Promise<{ text: string; model: string }> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY (or an `ant auth login` profile)
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(factsFor(report)) }],
  });
  if (response.stop_reason === "refusal") throw new Error("model declined to summarise");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  if (!text) throw new Error("empty summary");
  return { text, model: response.model };
}
