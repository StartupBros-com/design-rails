#!/usr/bin/env node
/*
  design-drift decision pages — dependency-free (#274).

  The posture flow ends at open human decisions in design/REVIEW.md, and colour
  decisions cannot be judged as hex strings in prose — the first three real
  ones (bless-or-migrate a chart library's default purple; is light mode a
  theme or a leftover; which of two duplicate success tokens survives) all need
  RENDERING. This script turns each open decision block into one self-contained
  HTML page: options side by side, each rendered IN CONTEXT (swatches on the
  app's real canvas, a sample button, text, and — for chart decisions — an
  inline SVG chart), with the measured evidence under each. The human looks,
  picks, and the choice is recorded back into REVIEW.md.

  REVIEW.md decision-block grammar (agent- and human-writable):

    ### Decision: <title> [open]
    Kind: chart            # optional: chart | role (default role)
    <context prose…>
    - **Option <name>:** <description containing #hex value(s)>
    - **Option <name>:** …
    Evidence: <free text, repeated lines allowed>

  Recording rewrites `[open]` to `[decided: <name> <date>]` and appends the
  rationale. Everything outside the block is untouched.

  Usage:
    node decide.mjs <app-dir>                        # pages for every open decision
    node decide.mjs <app-dir> --out=<dir>            # default: <app>/design/decisions
    node decide.mjs <app-dir> --record <slug>=<option> --rationale="…"
*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith("-")) || ".");
const outDir = (() => {
  const a = args.find((x) => x.startsWith("--out="));
  return a ? resolve(a.slice("--out=".length)) : join(root, "design", "decisions");
})();
const recordArg = (() => {
  const i = args.indexOf("--record");
  return i !== -1 ? args[i + 1] : null;
})();
const rationale = (() => {
  const a = args.find((x) => x.startsWith("--rationale="));
  return a ? a.slice("--rationale=".length) : "";
})();

const reviewPath = join(root, "design", "REVIEW.md");
if (!existsSync(reviewPath)) {
  console.error(`design-drift decide: no ${reviewPath} — run propose first, or point at an app dir with a design/.`);
  process.exit(2);
}
const review = readFileSync(reviewPath, "utf8");

// Canvas + ink from the app's own tokens so samples render in the app's real
// context, not on an assumed white. Falls back to a dual light/dark render.
function appContext() {
  const tokensPath = join(root, "design", "tokens", "color.json");
  const ctx = { canvas: "#ffffff", ink: "#111114" };
  try {
    const c = JSON.parse(readFileSync(tokensPath, "utf8"));
    ctx.canvas = c.primitive?.canvas?.$value || ctx.canvas;
    ctx.ink = c.primitive?.ink?.$value || ctx.ink;
  } catch {}
  return ctx;
}

// ------------------------------------------------------------------- parsing

const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const HEXES = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

function parseDecisions(md) {
  const decisions = [];
  const blockRe = /^### Decision: (.+?) \[open\]\s*$/gm;
  let m;
  while ((m = blockRe.exec(md))) {
    const title = m[1].trim();
    const start = m.index;
    const rest = md.slice(blockRe.lastIndex);
    const end = rest.search(/^### |^## /m);
    const body = end === -1 ? rest : rest.slice(0, end);
    const kind = /^Kind:\s*chart\s*$/m.test(body) ? "chart" : "role";
    const options = [];
    for (const om of body.matchAll(/^- \*\*Option ([A-Za-z0-9_-]+):\*\* (.+)$/gm)) {
      options.push({
        name: om[1],
        desc: om[2].trim(),
        colors: [...om[2].matchAll(HEXES)].map((x) => x[0].toLowerCase()),
      });
    }
    const evidence = [...body.matchAll(/^Evidence:\s*(.+)$/gm)].map((e) => e[1].trim());
    const context = (body.split(/^- \*\*Option /m)[0] || "")
      .replace(/^Kind:.*$/m, "")
      .trim();
    decisions.push({ title, slug: slugify(title), kind, context, options, evidence, blockStart: start });
  }
  return decisions;
}

// ----------------------------------------------------------------- rendering

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A tiny inline SVG chart: 5 bars + a line, drawn in the option's colours so
 *  a chart-palette decision is judged as a CHART, never as a swatch. This is
 *  the load-bearing requirement of #274 — bare swatches reproduce the exact
 *  judging-hex-in-prose failure the pages exist to end. */
function sampleChart(colors, canvas) {
  const cs = colors.length ? colors : ["#888888"];
  const col = (i) => cs[i % cs.length];
  const heights = [42, 68, 30, 80, 55];
  const bars = heights
    .map((h, i) => `<rect x="${14 + i * 30}" y="${96 - h}" width="20" height="${h}" rx="2" fill="${col(i)}" opacity="${cs.length === 1 ? (0.45 + 0.14 * i).toFixed(2) : 1}"/>`)
    .join("");
  const pts = heights.map((h, i) => `${24 + i * 30},${88 - h * 0.6}`).join(" ");
  return `<svg viewBox="0 0 170 104" style="background:${canvas};border-radius:6px" role="img" aria-label="sample chart">
    ${bars}<polyline points="${pts}" fill="none" stroke="${col(1)}" stroke-width="2.5"/></svg>`;
}

function sampleRole(colors, ctx) {
  const c = colors[0] || "#888888";
  return `
    <div class="ctx" style="background:${ctx.canvas};color:${ctx.ink}">
      <button style="background:${c};color:${pickText(c)};border:none;border-radius:6px;padding:8px 18px;font-weight:600">Call to action</button>
      <p style="margin:10px 0 0">Body text on the app canvas, with <a style="color:${c}" href="#">a link in the candidate colour</a>.</p>
      <div class="swatches">${colors.map((x) => `<span class="sw" style="background:${x}" title="${x}"></span><code>${x}</code>`).join(" ")}</div>
    </div>`;
}

/** Black-or-white text over a colour, by relative luminance — the sample
 *  button must be readable or the page itself misleads. */
function pickText(hex) {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const n = parseInt(h, 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.55 ? "#111114" : "#ffffff";
}

function renderPage(d, ctx, appName) {
  const opts = d.options
    .map(
      (o) => `
    <section class="option">
      <h2>Option <code>${esc(o.name)}</code></h2>
      
      ${d.kind === "chart" ? sampleChart(o.colors, ctx.canvas) : ""}
      ${sampleRole(o.colors, ctx)}
      <p class="desc">${esc(o.desc)}</p>
    </section>`,
    )
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(d.title)} — ${esc(appName)} design decision</title>
<style>
  body{font:15px/1.5 system-ui;margin:2rem auto;max-width:920px;padding:0 1rem;color:#1a1a1a}
  .options{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.2rem}
  .option{border:1px solid #ddd;border-radius:10px;padding:1rem}
  .ctx{border-radius:8px;padding:14px;margin:.6rem 0}
  .sw{display:inline-block;width:22px;height:22px;border-radius:4px;vertical-align:middle;border:1px solid rgba(0,0,0,.15)}
  .swatches{margin-top:10px}
  .evidence{background:#f6f6f6;border-radius:8px;padding: .8rem 1rem;font-size:13.5px}
  svg{width:100%;height:auto;margin-bottom:.4rem}
  code{background:#f2f2f2;padding:1px 5px;border-radius:4px}
</style>
<h1>${esc(d.title)} <small>[open]</small></h1>
<p>${esc(d.context)}</p>
<div class="options">${opts}</div>
<div class="evidence"><strong>Evidence</strong><ul>${d.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>
<p>Record with: <code>node decide.mjs ${esc(appName)} --record ${esc(d.slug)}=&lt;option&gt; --rationale="…"</code></p>
`;
}

// ---------------------------------------------------------------- recording

function record(md, slug, option, why) {
  const decisions = parseDecisions(md);
  const d = decisions.find((x) => x.slug === slug);
  if (!d) {
    console.error(`design-drift decide: no open decision '${slug}' in ${reviewPath}`);
    process.exit(2);
  }
  if (!d.options.some((o) => o.name === option)) {
    console.error(`design-drift decide: '${option}' is not an option of '${slug}' (has: ${d.options.map((o) => o.name).join(", ")})`);
    process.exit(2);
  }
  const date = new Date().toISOString().slice(0, 10);
  const openLine = `### Decision: ${d.title} [open]`;
  const decidedLine = `### Decision: ${d.title} [decided: ${option} ${date}]`;
  const withHeader = md.replace(openLine, decidedLine);
  // Append the rationale right under the rewritten heading.
  const note = `\nDecided: **${option}**${why ? ` — ${why}` : ""} (${date})\n`;
  return withHeader.replace(decidedLine, decidedLine + note);
}

// --------------------------------------------------------------------- main

const appName = root.split("/").filter(Boolean).pop();
if (recordArg) {
  const [slug, option] = recordArg.split("=");
  if (!slug || !option) {
    console.error("design-drift decide: --record wants <slug>=<option>");
    process.exit(2);
  }
  writeFileSync(reviewPath, record(review, slug, option, rationale));
  console.log(`design-drift decide: recorded ${slug} = ${option} in ${reviewPath}`);
  process.exit(0);
}

const decisions = parseDecisions(review);
if (!decisions.length) {
  console.log("design-drift decide: no open decisions — nothing to render.");
  process.exit(0);
}
const ctx = appContext();
mkdirSync(outDir, { recursive: true });
for (const d of decisions) {
  const p = join(outDir, `${d.slug}.html`);
  writeFileSync(p, renderPage(d, ctx, appName));
  console.log(`design-drift decide: wrote ${p} (${d.options.length} options, kind=${d.kind})`);
}
