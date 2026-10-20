// Output only: CLI table and a single static HTML page. No logic decided here.
import type { Report } from "./report.ts";
import { hhmm, type Status } from "./evaluate.ts";
import type { Outcome } from "./classify.ts";

const ICON: Record<Status, string> = { unhealthy: "✖", degraded: "▲", insufficient_data: "?", healthy: "●" };
const WORD: Record<Status, string> = { unhealthy: "UNHEALTHY", degraded: "DEGRADED", insufficient_data: "NO DATA", healthy: "HEALTHY" };
const pctStr = (n: number) => `${Math.round(n * 10) / 10}%`;

export function renderCli(r: Report): string {
  const out: string[] = [];
  out.push(`Integration health, window ${hhmm(new Date(r.windowStart))}-${hhmm(new Date(r.asOf))} UTC (${r.windowMinutes} min)`);
  out.push(`Overall: ${ICON[r.overall.status]} ${WORD[r.overall.status]}  (${r.overall.headline})`);
  for (const w of r.overall.warnings) out.push(`! ${w}`);
  if (r.summary) out.push("", r.summary.text);
  for (const h of r.integrations) {
    const s = h.stats;
    out.push("");
    out.push(`${ICON[h.status]} ${WORD[h.status].padEnd(10)} ${h.integration}${h.critical ? "  [critical]" : ""}`);
    out.push(`    ${s.total} req | fail ${pctStr(s.failureRatePct)} | 429 ${pctStr(s.rateLimitedPct)} | p50 ${s.p50Ms ?? "-"} ms | p95 ${s.p95Ms ?? "-"} ms`);
    for (const x of h.reasons) out.push(`    - ${x}`);
    for (const x of h.notes) out.push(`    · ${x}`);
    if (h.owners.length) out.push(`    → ${h.owners.join("; ")}`);
  }
  return out.join("\n");
}

const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CELL: Record<Outcome, string> = {
  success: "ok", rate_limited: "warn", timeout: "bad timeout",
  server_error: "bad", auth: "bad", client_error: "bad", unknown: "bad",
};

export function renderHtml(r: Report): string {
  const cards = r.integrations.map((h) => {
    const s = h.stats;
    const cells = s.timeline
      .map((e) => `<span class="cell ${CELL[e.outcome]}" title="${hhmm(e.t)} ${e.outcome.replace("_", " ")}"></span>`)
      .join("");
    const list = (items: string[], cls: string) => (items.length ? `<ul class="${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    return `<article class="card s-${h.status}">
  <header><h2>${esc(h.integration)}</h2>${h.critical ? '<span class="tag">critical</span>' : ""}
    <span class="pill s-${h.status}"><span aria-hidden="true">${ICON[h.status]}</span> ${WORD[h.status]}</span></header>
  ${list(h.reasons, "reasons")}${list(h.notes, "notes")}
  ${h.owners.length ? `<p class="owner">Who looks: ${esc(h.owners.join("; "))}</p>` : ""}
  <dl class="metrics">
    <div><dt>Requests</dt><dd>${s.total}</dd></div>
    <div><dt>Failing</dt><dd>${pctStr(s.failureRatePct)}</dd></div>
    <div><dt>429s</dt><dd>${pctStr(s.rateLimitedPct)}</dd></div>
    <div><dt>p50 / p95</dt><dd>${s.p50Ms ?? "–"} / ${s.p95Ms ?? "–"} ms</dd></div>
  </dl>
  <div class="timeline" role="img" aria-label="Request outcomes in time order">${cells || '<span class="empty">no requests</span>'}</div>
</article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Integration Health</title>
<style>
:root{color-scheme:light;--bg:#fcfcfb;--card:#fff;--line:#e4e3df;--text:#0b0b0b;--muted:#52514e;
  --good:#0ca30c;--warn:#fab219;--bad:#d03b3b;--none:#8a8984;--good-ink:#006300;--warn-ink:#8a5a00;--bad-ink:#a8201f}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#1a1a19;--card:#242422;--line:#3a3936;
  --text:#f0efec;--muted:#c3c2b7;--good-ink:#5ed25e;--warn-ink:#fab219;--bad-ink:#ff8a80}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#1a1a19;--card:#242422;--line:#3a3936;--text:#f0efec;--muted:#c3c2b7;
  --good-ink:#5ed25e;--warn-ink:#fab219;--bad-ink:#ff8a80}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 16px}
.banner{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px 16px;margin-bottom:16px}
.banner.warn{border-color:var(--warn)}.summary{white-space:pre-wrap}.summary small{color:var(--muted)}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--none);border-radius:10px;padding:14px 16px}
.card.s-healthy{border-left-color:var(--good)}.card.s-degraded{border-left-color:var(--warn)}.card.s-unhealthy{border-left-color:var(--bad)}
.card header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
h2{font-size:16px;margin:0;flex:1 1 auto}
.pill{font-size:12px;font-weight:700;letter-spacing:.03em;padding:2px 8px;border-radius:999px;border:1px solid currentColor}
.pill.s-healthy{color:var(--good-ink)}.pill.s-degraded{color:var(--warn-ink)}.pill.s-unhealthy{color:var(--bad-ink)}.pill.s-insufficient_data{color:var(--muted)}
.tag{font-size:11px;text-transform:uppercase;color:var(--muted);border:1px dashed var(--muted);border-radius:4px;padding:0 5px}
ul{margin:10px 0 0;padding-left:18px}.notes{color:var(--muted);font-size:13.5px;margin-top:4px}
.owner{font-size:13px;color:var(--muted);margin:8px 0 0}
.metrics{display:grid;grid-template-columns:repeat(4,auto);gap:4px 14px;margin:12px 0 10px;font-size:13px}
.metrics dt{color:var(--muted);font-size:11.5px}.metrics dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600}
.timeline{display:flex;gap:2px;flex-wrap:wrap}
.cell{width:16px;height:16px;border-radius:3px;background:var(--none)}
.cell.ok{background:var(--good)}.cell.warn{background:var(--warn)}.cell.bad{background:var(--bad)}
.cell.timeout{background:repeating-linear-gradient(45deg,var(--bad) 0 3px,var(--card) 3px 5px)}
.empty{color:var(--muted);font-size:13px}
.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12.5px;margin:18px 0 0;align-items:center}
.legend .cell{display:inline-block;vertical-align:middle;margin-right:4px}
footer{color:var(--muted);font-size:12.5px;margin-top:20px}
@media (max-width:420px){.metrics{grid-template-columns:repeat(2,auto)}}
</style></head>
<body><main>
<h1><span aria-hidden="true">${ICON[r.overall.status]}</span> Integration health: ${WORD[r.overall.status]}</h1>
<p class="sub">${esc(r.overall.headline)} · window ${hhmm(new Date(r.windowStart))}–${hhmm(new Date(r.asOf))} UTC on ${r.asOf.slice(0, 10)} · generated ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC</p>
${r.overall.warnings.map((w) => `<div class="banner warn">⚠ ${esc(w)}</div>`).join("")}
${r.summary ? `<div class="banner summary"><strong>Morning summary</strong> <small>(AI-written from the computed report; statuses come from rules, not the model)</small>\n${esc(r.summary.text)}</div>` : ""}
<section class="grid">
${cards}
</section>
<div class="legend"><span><span class="cell ok"></span>success</span><span><span class="cell warn"></span>rate-limited (429)</span>
<span><span class="cell bad"></span>error (5xx / auth / 4xx)</span><span><span class="cell timeout"></span>timeout</span><span>One square = one request, oldest first. Hover for time.</span></div>
<footer>Statuses are rule-based (config/thresholds.jsonc). Sorted worst first, critical integrations first within a status.</footer>
</main></body></html>
`;
}
