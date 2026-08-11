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

import { spawnSync } from "node:child_process";
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
  const ctx = { canvas: "#ffffff", ink: "#111114", roles: null, logo: null };
  try {
    const c = JSON.parse(readFileSync(tokensPath, "utf8"));
    const prim = c.primitive || {};
    const val = (k, fb) => prim[k]?.$value || fb;
    ctx.canvas = val("canvas", ctx.canvas);
    ctx.ink = val("ink", ctx.ink);
    // The full brand, so a candidate is judged IN COMBINATION with every
    // other role the app ships — a swatch beside a lone button reproduces
    // judging-hex-in-prose one level up (operator finding).
    ctx.roles = {
      canvas: ctx.canvas,
      elevated: val("canvas-elevated", ctx.canvas),
      hairline: val("hairline", "#dddddd"),
      ink: ctx.ink,
      inkMute: val("ink-mute", "#666a70"),
      brand: val("brand", "#4466dd"),
    };
  } catch {}
  // Brand asset: design/assets/logo.svg, inlined when small. Absent is fine —
  // the scene falls back to a wordmark in the brand colour.
  try {
    const logoPath = join(root, "design", "assets", "logo.svg");
    const svg = readFileSync(logoPath, "utf8");
    if (svg.length < 64 * 1024 && /<svg[\s>]/.test(svg)) ctx.logo = svg;
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
    const roleM = body.match(/^Role:\s*([a-zA-Z-]+)\s*$/m);
    const role = roleM ? roleM[1] : null;
    const recM = body.match(/^Recommend:\s*([A-Za-z0-9_-]+)\s*(?:—|-|:)\s*(.+)$/m);
    const recommend = recM ? { option: recM[1], reason: recM[2].trim() } : null;
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
      .replace(/^Role:.*$/m, "")
      .replace(/^Recommend:.*$/m, "")
      .trim();
    decisions.push({ title, slug: slugify(title), kind, role, recommend, context, options, evidence, blockStart: start });
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

// The brand scene: a composed mini-page from the app's CURRENT tokens with
// the candidate colour(s) substituted into the role under decision. One
// variable, constant context — the combination view real decisions need.
function sampleScene(colors, ctx, role) {
  const r = { ...ctx.roles };
  if (role && colors[0]) {
    const slot = { "ink-mute": "inkMute", "canvas-elevated": "elevated" }[role] || role;
    if (slot in r) r[slot] = colors[0];
  }
  // Multi-colour option with no single role: a neutral composition — the
  // candidates fill tint / panel / border in order.
  const comp = !role && colors.length >= 2;
  const tint = comp ? colors[0] : r.elevated;
  const panel = comp ? colors[1] : r.canvas;
  const compBorder = comp ? colors[2] || r.hairline : r.hairline;
  const logo = ctx.logo
    ? `<span class="logo">${ctx.logo}</span>`
    : `<strong style="color:${r.brand};font-size:15px">◆ Brand</strong>`;
  return `
    <div class="scene" style="background:${r.canvas};color:${r.ink};border:1px solid ${r.hairline}">
      <div class="scene-h" style="border-bottom:1px solid ${r.hairline}">${logo}
        <span style="color:${r.inkMute};font-size:12.5px">Products&ensp;Pricing&ensp;Docs</span></div>
      <h3 style="color:${r.ink};margin:.7rem 0 .25rem;font-size:17px">Every colour, in company</h3>
      <p style="color:${r.inkMute};margin:0 0 .6rem;font-size:13.5px">Body copy in the muted ink, beside
        <a style="color:${r.brand}" href="#">a brand link</a>, so the candidate is judged against the palette it will live with.</p>
      <div style="background:${tint};border:1px solid ${compBorder};border-radius:8px;padding:.6rem .8rem;margin-bottom:.6rem">
        <div style="background:${panel};border:1px solid ${compBorder};border-radius:6px;padding:.45rem .6rem;font-size:12.5px;color:${r.inkMute}">A card on a tinted panel — where neutrals earn their keep.</div>
      </div>
      <button style="background:${r.brand};color:${pickText(r.brand)};border:none;border-radius:6px;padding:7px 16px;font-weight:600">Call to action</button>
      <div class="swatches">${colors.map((x) => `<span class="sw" style="background:${x}" title="${x}"></span><code>${x}</code>`).join(" ")}</div>
    </div>`;
}

// The palette strip: the brand as it stands, named — context above every choice.
function paletteStrip(ctx) {
  if (!ctx.roles) return "";
  const names = { canvas: "canvas", elevated: "elevated", hairline: "hairline", ink: "ink", inkMute: "ink-mute", brand: "brand" };
  return `<div class="strip"><strong>The brand today:</strong> ${Object.entries(ctx.roles)
    .map(([k, v]) => `<span class="sw" style="background:${v}"></span><code>${names[k]}&thinsp;${v}</code>`)
    .join(" ")}</div>`;
}

function sampleRole(colors, ctx, role) {
  if (ctx.roles) return sampleScene(colors, ctx, role);
  const c = colors[0] || "#888888";
  return `
    <div class="ctx" style="background:${ctx.canvas};color:${ctx.ink}">
      <button style="background:${c};color:${pickText(c)};border:none;border-radius:6px;padding:8px 18px;font-weight:600">Call to action</button>
      <p style="margin:10px 0 0">Body text on the app canvas, with <a style="color:${c}" href="#">a link in the candidate colour</a>.</p>
      <div class="swatches">${colors.map((x) => `<span class="sw" style="background:${x}" title="${x}"></span><code>${x}</code>`).join(" ")}</div>
    </div>`;
}

// WCAG relative luminance + contrast ratio — the objective half of a
// recommendation. A tool cannot have taste, but it can measure, and the
// measurements belong ON the page (operator finding: a decision page
// without a best-practice read leaves the human doing the designer's
// arithmetic by eye).
function relLum(hex) {
  const h = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const n = parseInt(h, 16);
  const ch = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
function contrastRatio(a, b) {
  const la = relLum(a);
  const lb = relLum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
// Metrics per option: text roles get canvas contrast + the AA verdict WITH
// its headroom (a 4.53:1 pass has 0.03 to spare and dies on the first
// tinted surface); every candidate gets perceptibility vs the role's
// CURRENT value (≈1.0:1 means nobody will see the change).
function metricsRow(colors, ctx, role) {
  if (!ctx.roles || !colors.length) return "";
  const c = colors[0];
  const bits = [];
  const textRole = role && /ink|text/.test(role);
  if (textRole) {
    const cr = contrastRatio(c, ctx.roles.canvas);
    const aa = cr >= 4.5;
    bits.push(
      `contrast on canvas ${cr.toFixed(2)}:1 — AA body ${aa ? `PASS (headroom ${(cr - 4.5).toFixed(2)})` : "FAIL"}`,
    );
  }
  const slot = role ? ({ "ink-mute": "inkMute", "canvas-elevated": "elevated" }[role] || role) : null;
  const current = slot && ctx.roles[slot];
  if (current && current.toLowerCase() !== c.toLowerCase()) {
    const d = contrastRatio(c, current);
    bits.push(`vs current ${current}: ${d.toFixed(2)}:1 ${d < 1.1 ? "(imperceptible)" : d < 1.3 ? "(subtle)" : "(visible)"}`);
  }
  return bits.length ? `<div class="metrics">Measured: ${bits.join(" · ")}</div>` : "";
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
    <section class="option${d.recommend && d.recommend.option === o.name ? " recommended" : ""}">
      <h2>Option <code>${esc(o.name)}</code>${d.recommend && d.recommend.option === o.name ? ' <span class="recbadge">recommended</span>' : ""}</h2>
      ${d.kind === "chart" ? sampleChart(o.colors, ctx.canvas) : ""}
      ${sampleRole(o.colors, ctx, d.role)}
      ${metricsRow(o.colors, ctx, d.role)}
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
  .scene{border-radius:10px;padding:.9rem 1rem;margin:.6rem 0}
  .scene-h{display:flex;justify-content:space-between;align-items:center;padding-bottom:.5rem}
  .scene .logo svg{height:20px;width:auto}
  .strip{background:#f6f6f6;border-radius:8px;padding:.6rem .8rem;font-size:12.5px;margin:.6rem 0}
  .option.recommended{border:2px solid #2f7d4f;box-shadow:0 1px 6px rgba(47,125,79,.18)}
  .recbadge{background:#2f7d4f;color:#fff;border-radius:99px;font-size:11px;padding:2px 9px;vertical-align:middle;font-weight:600}
  .recommendation{background:#eef7f1;border:1px solid #bfe0cc;border-radius:8px;padding:.7rem 1rem;margin:.8rem 0;font-size:14px}
  .metrics{font-size:12px;color:#4a4f57;background:#f8f8f8;border-radius:6px;padding:.35rem .6rem;margin-top:.5rem}
</style>
${paletteStrip(ctx)}
<h1>${esc(d.title)} <small>[open]</small></h1>
<p>${esc(d.context)}</p>
<div class="options">${opts}</div>
${d.recommend ? `<div class="recommendation"><strong>Recommendation: <code>${esc(d.recommend.option)}</code></strong> — ${esc(d.recommend.reason)}</div>` : ""}
<div class="evidence"><strong>Evidence</strong><ul>${d.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>
<p>Record with: <code>node decide.mjs ${esc(appName)} --record ${esc(d.slug)}=&lt;option&gt; --rationale="…"</code></p>
`;
}

// One UNIFIED page per operator moment (the compound-engineering convention:
// a single reviewable artifact, not one tab per item). Per-decision pages
// stay as the durable, slug-addressed, PR-diffable artifacts; the index is
// what a human actually opens. Markup mirrors renderPage's body.
function renderIndex(decisions, ctx, appName) {
  const section = (d) => {
    const opts = d.options
      .map(
        (o) => `
    <section class="option${d.recommend && d.recommend.option === o.name ? " recommended" : ""}">
      <h2>Option <code>${esc(o.name)}</code>${d.recommend && d.recommend.option === o.name ? ' <span class="recbadge">recommended</span>' : ""}</h2>
      ${d.kind === "chart" ? sampleChart(o.colors, ctx.canvas) : ""}
      ${sampleRole(o.colors, ctx, d.role)}
      ${metricsRow(o.colors, ctx, d.role)}
      <p class="desc">${esc(o.desc)}</p>
    </section>`,
      )
      .join("\n");
    return `
<section id="${esc(d.slug)}">
<h2 class="dtitle">${esc(d.title)} <small>[open]</small></h2>
<p>${esc(d.context)}</p>
<div class="options">${opts}</div>
${d.recommend ? `<div class="recommendation"><strong>Recommendation: <code>${esc(d.recommend.option)}</code></strong> — ${esc(d.recommend.reason)}</div>` : ""}
<div class="evidence"><strong>Evidence</strong><ul>${d.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>
<p>Record with: <code>node decide.mjs ${esc(appName)} --record ${esc(d.slug)}=&lt;option&gt; --rationale="…"</code></p>
</section>`;
  };
  const n = decisions.length;
  const nav =
    n > 1
      ? `<nav><ul>${decisions.map((d) => `<li><a href="#${esc(d.slug)}">${esc(d.title)}</a></li>`).join("")}</ul></nav>`
      : "";
  return `<!doctype html>
<meta charset="utf-8">
<title>${n} open design decision${n === 1 ? "" : "s"} — ${esc(appName)}</title>
<style>
  body{font:15px/1.5 system-ui;margin:2rem auto;max-width:920px;padding:0 1rem;color:#1a1a1a}
  .options{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1.2rem}
  .option{border:1px solid #ddd;border-radius:10px;padding:1rem}
  .ctx{border-radius:8px;padding:14px;margin:.6rem 0}
  .sw{display:inline-block;width:22px;height:22px;border-radius:4px;vertical-align:middle;border:1px solid rgba(0,0,0,.15)}
  .swatches{margin-top:10px}
  .evidence{background:#f6f6f6;border-radius:8px;padding:.8rem 1rem;font-size:13.5px}
  svg{width:100%;height:auto;margin-bottom:.4rem}
  code{background:#f2f2f2;padding:1px 5px;border-radius:4px}
  .scene{border-radius:10px;padding:.9rem 1rem;margin:.6rem 0}
  .scene-h{display:flex;justify-content:space-between;align-items:center;padding-bottom:.5rem}
  .scene .logo svg{height:20px;width:auto}
  .strip{background:#f6f6f6;border-radius:8px;padding:.6rem .8rem;font-size:12.5px;margin:.6rem 0}
  .option.recommended{border:2px solid #2f7d4f;box-shadow:0 1px 6px rgba(47,125,79,.18)}
  .recbadge{background:#2f7d4f;color:#fff;border-radius:99px;font-size:11px;padding:2px 9px;vertical-align:middle;font-weight:600}
  .recommendation{background:#eef7f1;border:1px solid #bfe0cc;border-radius:8px;padding:.7rem 1rem;margin:.8rem 0;font-size:14px}
  .metrics{font-size:12px;color:#4a4f57;background:#f8f8f8;border-radius:6px;padding:.35rem .6rem;margin-top:.5rem}
  section[id]{border-top:2px solid #eee;margin-top:2rem;padding-top:.6rem}
  .dtitle{font-size:1.35rem}
</style>
<h1>${n} open design decision${n === 1 ? "" : "s"} — ${esc(appName)}</h1>
${paletteStrip(ctx)}
${nav}
${decisions.map(section).join("\n")}`;
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
// An [open] decision whose options did not parse is a formatting slip, and a
// page with zero options is unusable — the first dogfood run wrote three of
// them with a clean exit because the author dropped the literal word
// "Option". Refuse loudly instead; the human sees the grammar, not a shrug.
const optionless = decisions.filter((d) => d.options.length === 0);
if (optionless.length) {
  console.error(
    `design-drift decide: ${optionless.length} open decision(s) parsed ZERO options:\n` +
      optionless.map((d) => `    ### Decision: ${d.title}`).join("\n") +
      "\n  options must match:  - **Option <name>:** <description with #hex>\n" +
      "  (the literal word 'Option' is part of the grammar)",
  );
  process.exit(2);
}
const ctx = appContext();
mkdirSync(outDir, { recursive: true });
for (const d of decisions) {
  const p = join(outDir, `${d.slug}.html`);
  writeFileSync(p, renderPage(d, ctx, appName));
  console.log(`design-drift decide: wrote ${p} (${d.options.length} options, kind=${d.kind})`);
}
const indexPath = join(outDir, "index.html");
writeFileSync(indexPath, renderIndex(decisions, ctx, appName));
console.log(`design-drift decide: wrote ${indexPath} — the ONE page to open (${decisions.length} open decision${decisions.length === 1 ? "" : "s"})`);

// --open (#20): best-effort launch of the unified page. Openers fail silently
// on some hosts (WSL interop wedges), so the path above ALWAYS prints and an
// opener failure is never an error.
if (args.includes("--open")) {
  const candidates =
    process.platform === "darwin"
      ? [["open", [indexPath]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", indexPath]]]
        : [["xdg-open", [indexPath]], ["wslview", [indexPath]]];
  let opened = false;
  for (const [cmd, argv] of candidates) {
    const r = spawnSync(cmd, argv, { stdio: "ignore", timeout: 5000 });
    if (r.status === 0) {
      opened = true;
      break;
    }
  }
  if (!opened) console.log("design-drift decide: no opener worked here — open the index path above by hand");
}
