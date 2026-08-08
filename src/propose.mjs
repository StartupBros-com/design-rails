#!/usr/bin/env node
/*
  design-drift proposer — dependency-free.

  Turns a scan of an EXISTING messy codebase into a coherent design-system
  proposal: a Google-spec DESIGN.md (google-labs-code/design.md, spec "alpha" —
  tokens in YAML frontmatter, rationale in prose) plus DTCG token files. It
  does not invent a brand. It consolidates what the code already does.

  Verify emitted output with the official CLI (network, dev-time only):
    npx -y -p @google/design.md designmd lint <out>/DESIGN.md
  and know its limits, all live-verified against v0.4.0: an EMPTY frontmatter
  lints 0-findings (this script's own guard covers that), and `export` drops
  typography lineHeight — tokens/*.json stays the lossless artifact.

  The hard part this exists to own is colour clustering. Everything else is
  already measured by scan.mjs (type/spacing scales, palette-utility hue counts,
  unresolved tokens). The colour step — 500 distinct hex values → a small set of
  semantic roles — is the piece no OSS tool points at a codebase's raw literals.

  Method sources (judgment, not code):
    - pbakaus/impeccable skill/reference/extract.md  (rule-of-3, prim→sem)
    - pbakaus/impeccable skill/reference/colorize.md (roles, not swatches; OKLCH)
    - murphytrueman/design-system-ops knowledge-notes/token-architecture.md
      (primitive / semantic / component tiers, DTCG)

  Usage:
    node propose.mjs <repo>                  # runs scan --json --full itself
    node scan.mjs <repo> --json --full | node propose.mjs --stdin
    node propose.mjs <repo> --out=design/    # write files (default: print only)
    node propose.mjs <repo> --name=myapp    # project name in the header
    node propose.mjs <repo> --clusters=N     # target colour-cluster count

  It NEVER edits application source. It only writes under --out when asked, and
  only DESIGN.md + tokens/*.json. Migration is a separate step.
*/

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fromStdin = args.includes("--stdin");
const outDir = (() => {
  const a = args.find((x) => x.startsWith("--out="));
  return a ? a.slice("--out=".length) : null;
})();
const projectName = (() => {
  const a = args.find((x) => x.startsWith("--name="));
  return a ? a.slice("--name=".length) : "project";
})();
const clusterTarget = (() => {
  const a = args.find((x) => x.startsWith("--clusters="));
  const n = a ? Number(a.slice("--clusters=".length)) : 12;
  return Number.isFinite(n) && n >= 4 && n <= 40 ? n : 12;
})();
// Which theme mode's declarations feed the declared tier. Default light; a
// brand whose identity lives in dark mode (a matrix-green-on-black members
// area, say) regenerates with --mode=dark. The other mode's divergent roles
// are named in the output either way, so neither run hides the other.
const themeMode = (() => {
  const a = args.find((x) => x.startsWith("--mode="));
  const v = a ? a.slice("--mode=".length) : "light";
  if (v !== "light" && v !== "dark") {
    console.error(`design-drift propose: --mode must be light or dark, got '${v}'`);
    process.exit(2);
  }
  return v;
})();
const allowBlended = args.includes("--allow-blended");
const root = resolve(args.find((a) => !a.startsWith("-")) || ".");

// ---------------------------------------------------------------- colour math
// OKLab (Björn Ottosson) — perceptually uniform, so "close" means "looks close".
// Straight RGB Euclidean distance is what nearcolor uses for cheap near-dup
// detection; clustering a whole palette needs something that treats a light
// blue and a light green as more different than two greys of similar L.

function hexToRgb(hex) {
  let h = hex.slice(1);
  // 3-digit CSS shorthand only. 4-digit is RGBA shorthand and almost always a
  // false positive from a scan (observed: "#2706" landing as an "accent"), and
  // 8-digit keeps the RGB portion.
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function rgbToOklab([r, g, b]) {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

const oklabDist = (p, q) =>
  Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);

// ---------------------------------------------------------------- clustering

/**
 * Weighted farthest-point clustering in OKLab, then assign every colour to its
 * nearest seed. Popular colours are preferred as seeds so the resulting palette
 * is anchored on what the codebase already uses most, not on outliers.
 *
 * This is not k-means — k-means needs iteration and a random init, both of
 * which make the output non-deterministic across runs. Farthest-point is stable
 * given a fixed seed-selection rule, which matters for a tool whose output is
 * supposed to be reviewable.
 */
function clusterColors(inventory, k) {
  // inventory: [{value: "#rrggbb", count: N}, ...]  hex only
  const points = [];
  for (const { value, count } of inventory) {
    const rgb = hexToRgb(value);
    if (!rgb) continue;
    points.push({ hex: value, count, rgb, lab: rgbToOklab(rgb) });
  }
  if (points.length === 0) return [];
  if (points.length <= k) {
    return points.map((p) => ({
      hex: p.hex,
      count: p.count,
      members: [p],
      lab: p.lab,
    }));
  }

  // Seed 1: the single most-used colour.
  const byCount = [...points].sort((a, b) => b.count - a.count);
  const seeds = [byCount[0]];
  const seedSet = new Set([byCount[0].hex]);

  // Subsequent seeds: maximise (min-distance-to-existing-seeds) × log(count+1).
  // The log keeps a rare neon outlier from beating a moderately-used brand colour.
  while (seeds.length < k) {
    let best = null, bestScore = -1;
    for (const p of points) {
      if (seedSet.has(p.hex)) continue;
      let minD = Infinity;
      for (const s of seeds) minD = Math.min(minD, oklabDist(p.lab, s.lab));
      const score = minD * Math.log1p(p.count);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) break;
    seeds.push(best);
    seedSet.add(best.hex);
  }

  // Assign every point to nearest seed; centroid = usage-weighted mean in OKLab,
  // then snap back to the member hex closest to that centroid (so every proposed
  // token is a colour the codebase already ships, never an invented blend).
  const buckets = seeds.map((s) => ({ seed: s, members: [] }));
  for (const p of points) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const d = oklabDist(p.lab, seeds[i].lab);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    buckets[bi].members.push(p);
  }

  return buckets
    .filter((b) => b.members.length)
    .map((b) => {
      const total = b.members.reduce((n, m) => n + m.count, 0);
      const mean = { L: 0, a: 0, b: 0 };
      for (const m of b.members) {
        const w = m.count / total;
        mean.L += m.lab.L * w;
        mean.a += m.lab.a * w;
        mean.b += m.lab.b * w;
      }
      // Snap to the most-USED real member, not the one nearest the centroid.
      //
      // Nearest-to-centroid looks right and is wrong: the centroid is a
      // usage-weighted mean, so on the first audited monorepo it landed beside colours shipping
      // once or twice and handed them the role. `surface.canvas` came out as
      // #f4f4f5 (1 use) for a 423-use cluster containing #ffffff (130), and
      // `action.primary` as #2a2a4e (3 uses) while #182c56 — the single
      // most-used literal in the repo at 140 — was assigned no role at all.
      // Every token was still a real member, so the "never an invented blend"
      // invariant held while the palette it produced was unusable: adopting it
      // means migrating 130 call sites onto a value nothing ships.
      //
      // Popularity is the signal the role heuristics below already assume ("a
      // colour used 300 times is a de-facto brand commitment"). Distance to
      // the centroid only breaks ties, which keeps the choice deterministic
      // when two members are equally used.
      let rep = b.members[0], rc = -1, rd = Infinity;
      for (const m of b.members) {
        const d = oklabDist(m.lab, mean);
        if (m.count > rc || (m.count === rc && d < rd)) {
          rc = m.count;
          rd = d;
          rep = m;
        }
      }
      // Classify on the SAME colour that gets emitted. A role name is a claim
      // about the token that ships ("status.info is blue"), so asking it of the
      // cluster centroid instead lets the two disagree: the centroid of a
      // teal-through-blue cluster answers for a colour no file contains, and on
      // one repo that handed status.info to a teal while the blue it emitted sat
      // in accents. The centroid's only job is breaking ties above.
      return {
        hex: rep.hex,
        count: total,
        members: b.members.sort((a, b) => b.count - a.count),
        lab: rep.lab,
        chroma: Math.hypot(rep.lab.a, rep.lab.b),
        hue: Math.atan2(rep.lab.b, rep.lab.a), // radians, -π..π
      };
    })
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- role assign
// colorize.md: "Build roles, not a bag of swatches" — canvas, elevated, text,
// action/focus/selection, borders, success/warning/error/info.
//
// Heuristics, not magic. Every assignment is explained in the DESIGN.md so a
// human can override it. Popularity is the strongest signal a raw literal has —
// but a DECLARED token's NAME beats popularity outright: someone already wrote
// `--primary:` or `brand:` next to that value, and no frequency count argues
// with a person who named the thing (#264 — before this tier existed, the
// proposer crowned GitHub's badge purple as one repo's brand while the real
// `#0366d6` sat in its theme.ts, excluded as a token file; reaching that value
// took BOTH the name tier and one-hop reference resolution, because the theme
// names it `accent` — a word this matcher must not trust directly, shadcn
// uses it for a muted background — and only `link: colors.accent` /
// `selected: colors.accent` reveal it as the interactive brand).

/** Map a declared token NAME to a role slot, or null. Conservative on purpose:
 *  an unmapped name (shadcn's `--accent` is a muted background, `--ring` is a
 *  focus outline) falls through to nothing rather than guessing. On-colours
 *  (`--primary-foreground`) map to nothing too — text.on-action is derived,
 *  not name-matched — EXCEPT the page-level pair: bare `foreground` is ink,
 *  `muted-foreground`/`secondary-foreground`-style names are muted text. */
function normalizeTokenName(rawName) {
  return rawName
    .replace(/^(--|\$)/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // camelCase → camel-Case (textSecondary)
    .toLowerCase()
    .split(/[-_.]+/)
    .filter((p) => p && p !== "color" && p !== "colors" && p !== "default");
}

function roleForTokenName(rawName) {
  const parts = normalizeTokenName(rawName);
  const has = (w) => parts.includes(w);
  const SURFACE_WORDS = ["primary", "secondary", "destructive", "accent", "card", "popover", "background", "tertiary", "success", "warning", "info", "action", "button"];
  // A COMPONENT-scoped colour never names a base role: `buttonNeutralBorder`
  // is that button's border, `noticeSuccessText` is that notice's text — both
  // real names from one measured theme.ts, both of which claimed global roles
  // until this guard existed.
  const COMPONENT_WORDS = ["button", "input", "table", "notice", "toast", "badge", "tooltip", "modal", "menu", "chip", "tag", "avatar", "checkbox", "radio", "slider", "scrollbar"];
  if (COMPONENT_WORDS.some(has)) return null;
  if (has("foreground") || has("fg") || has("ink") || has("on")) {
    if (has("muted")) return "inkMute";
    if (SURFACE_WORDS.some(has)) return null; // an on-colour for some surface
    return "ink";
  }
  // A VARIANT never names the base role: `--color-success-muted` is not the
  // success colour, it is a derived tint — and on one measured monorepo it
  // out-reffed the real `--success` and stole the role until this guard
  // existed. (muted-FOREGROUND is already handled above, where muted is the
  // point, not a variant.)
  if (["muted", "subtle", "hover", "active", "container", "light", "dark", "soft"].some(has)) return null;
  if (has("background") || has("bg") || has("canvas")) return "canvas";
  if (has("destructive") || has("danger") || has("error")) return "error";
  if (has("success") || has("positive")) return "success";
  if (has("warning") || has("caution") || has("attention")) return "warning";
  if (has("info")) return "info";
  if (has("border") || has("divider") || has("hairline")) return "hairline";
  if (has("card") || has("elevated") || has("panel")) return "elevated";
  if (has("primary") || has("brand")) return "primary";
  // `link` and `selected` are the classic interactive-brand names in themes
  // that never say "primary" — outline declares `link: colors.accent` and
  // `selected: colors.accent`, and that accent IS its brand. Deliberately NOT
  // matched: bare `accent` (shadcn's `--accent` is a muted background — the
  // ecosystems disagree about the word, so only its usage sites disambiguate).
  if (has("link") || has("selected")) return "primary";
  // `textSecondary` is muted text and must win BEFORE the surface-pairing
  // guard ("secondary" doubles as a surface word); `accentText`-style pairings
  // are text-ON-a-surface, not the page ink, and fall to the guard.
  if (has("text")) {
    if (has("secondary") || has("tertiary")) return "inkMute";
    if (SURFACE_WORDS.some(has)) return null;
    return "ink";
  }
  return null;
}

/** The declared tier: assign roles from token/theme-file declarations by NAME.
 *  Each winner becomes a pseudo-cluster carrying its provenance; refs (var()
 *  call sites) break ties between competing declarations for the same role.
 *  Returns a partial roles map that assignRoles() treats as settled. */
function assignDeclaredRoles(declaredTokens) {
  const pre = {};
  const candidates = (declaredTokens || []).filter((d) => d.hex);
  for (const d of candidates) {
    const role = roleForTokenName(d.name);
    if (!role) continue;
    // A BARER name beats a more-qualified one, then refs break ties: outline
    // declares both `success` and (via other paths) success-adjacent compounds;
    // the person who wrote the single-word name was naming the system's colour,
    // the compound was naming a use of it.
    const spec = normalizeTokenName(d.name).length;
    const existing = pre[role];
    if (existing) {
      const exSpec = normalizeTokenName(existing.declared.name).length;
      if (exSpec < spec || (exSpec === spec && existing.declared.refs >= d.refs)) continue;
    }
    const rgb = hexToRgb(d.hex);
    if (!rgb) continue;
    const lab = rgbToOklab(rgb);
    pre[role] = {
      hex: d.hex,
      count: d.refs,
      members: [{ hex: d.hex, count: d.refs }],
      lab,
      chroma: Math.hypot(lab.a, lab.b),
      hue: Math.atan2(lab.b, lab.a),
      declared: { name: d.name, file: d.file, refs: d.refs, raw: d.raw },
    };
  }
  return pre;
}

function assignRoles(clusters, pre = {}) {
  const unused = new Set(clusters.map((_, i) => i));
  const take = (pred, fallbackIdx = null) => {
    let best = null, bestScore = -1;
    for (const i of unused) {
      const c = clusters[i];
      const s = pred(c);
      if (s !== null && s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    if (best === null && fallbackIdx !== null && unused.has(fallbackIdx)) best = fallbackIdx;
    if (best === null) return null;
    unused.delete(best);
    return clusters[best];
  };

  // 0.05, not 0.04: real UI "greys" are tinted, and the tighter bar rejected
  // them. Measured in OKLab — Tailwind gray-500 #6b7280 = 0.023, slate-500
  // #64748b = 0.041, one repo's muted text #6f7592 = 0.045, while its brand navy
  // #182c56 = 0.080. At 0.04 the whole slate family reads as chromatic and
  // text.secondary goes unassigned. 0.05 admits the greys by 0.005 and still
  // leaves the brand 0.030 clear on the other side, so the line sits six times
  // further from the value it must keep out than from the ones it must let in.
  //
  // Note the deliberate gap against isChromatic below: chroma in [0.05, 0.06)
  // is neither, and gets no role from either predicate. That band is narrower
  // than it was, not wider.
  const isNeutral = (c) => c.chroma < 0.05;
  const isChromatic = (c) => c.chroma >= 0.06;
  // Hue windows in OKLab a/b angle. Approximate, good enough for role picking.
  const hueNear = (c, target, width = 0.6) => {
    let d = Math.abs(c.hue - target);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d < width;
  };

  // A role settled by the declared tier is settled: `pre.<role> ||` short-
  // circuits before take(), so no residual cluster is consumed for it and the
  // heuristics below only ever fill the gaps the declarations left.
  //
  // Neutrals first — these are structural and must not be stolen by status/brand.
  //
  // 1. Canvas: very light neutral. L > 0.93 keeps mid-greys out of "elevated".
  const canvas = pre.canvas || take((c) => (isNeutral(c) && c.lab.L > 0.93 ? c.count * c.lab.L : null));
  // 2. Ink / text-primary: darkest neutral. Exclude pure black if a near-black
  //    with more character is available — pure #000 is rarely a brand ink.
  const ink = pre.ink || take((c) => {
    if (!isNeutral(c) || c.lab.L >= 0.35) return null;
    // Prefer near-blacks that aren't pure #000/#fff endpoints when possible.
    const endpoint = c.hex === "#000000" || c.hex === "#000" ? 0.5 : 1;
    return c.count * (1 - c.lab.L) * endpoint;
  });
  // 3. Hairline BEFORE elevated: mid-light greys are borders, not surfaces.
  //    Getting this order wrong is what made #cecece land as "elevated" on the
  //    first live run.
  const hairline = pre.hairline || take((c) =>
    isNeutral(c) && c.lab.L > 0.72 && c.lab.L <= 0.93 ? c.count : null,
  );
  // 4. Elevated: remaining very-light neutral (card/panel fill).
  const elevated = pre.elevated || take((c) => (isNeutral(c) && c.lab.L > 0.88 ? c.count * c.lab.L : null));
  // 5. Ink-secondary / muted text.
  const inkMute = pre.inkMute || take((c) =>
    isNeutral(c) && c.lab.L > 0.35 && c.lab.L <= 0.72 ? c.count : null,
  );

  // Status BEFORE brand. A high-use red is almost always danger, not the brand
  // primary — and if we pick brand first it steals the red and leaves danger
  // empty (observed on the first audited repo: brand=#f73e49, danger=unassigned).
  const error = pre.error || take((c) =>
    isChromatic(c) && hueNear(c, 0.5 /* ~red */, 0.7) ? c.count * c.chroma : null,
  );
  const success = pre.success || take((c) =>
    isChromatic(c) && hueNear(c, 2.4 /* ~green */, 0.7) ? c.count * c.chroma : null,
  );
  const warning = pre.warning || take((c) =>
    isChromatic(c) && hueNear(c, 1.2 /* ~amber/yellow */, 0.6) ? c.count * c.chroma : null,
  );
  const info = pre.info || take((c) =>
    isChromatic(c) && hueNear(c, -2.5 /* ~blue */, 0.7) ? c.count * c.chroma : null,
  );

  // Brand / action: most-used remaining chromatic. Status hues are already
  // claimed, so a navy or indigo workhorse wins over a leftover red.
  const primary = pre.primary || take((c) =>
    isChromatic(c) && c.lab.L > 0.2 && c.lab.L < 0.8
      ? c.count * (0.5 + c.chroma)
      : null,
  );

  // Accents: leftover CHROMATIC colours only. A stranded neutral or pure black
  // is not an accent — it is either an unassigned structural colour or noise.
  const accents = [...unused]
    .map((i) => clusters[i])
    .filter((c) => isChromatic(c))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  return { canvas, elevated, hairline, ink, inkMute, primary, error, success, warning, info, accents };
}

// ---------------------------------------------------------------- emitters

function dtcgColor(hex, description) {
  return {
    $type: "color",
    $value: hex,
    ...(description ? { $description: description } : {}),
  };
}

function dtcgDimension(value, unit, description) {
  return {
    $type: "dimension",
    $value: `${value}${unit}`,
    ...(description ? { $description: description } : {}),
  };
}

function buildTokens(roles, scales, meta) {
  // Primitive tier: every proposed colour, named by role. Semantic tier aliases
  // the primitives so a theme remap only has to re-point the aliases.
  // (design-system-ops token-architecture.md: "Nothing else in the system should
  // define a raw colour that is not declared first as a primitive.")
  const prim = {};
  const put = (name, cluster, why) => {
    if (!cluster) return null;
    const key = name.replace(/\./g, "-");
    prim[key] = dtcgColor(
      cluster.hex,
      cluster.declared
        ? `declared as ${cluster.declared.name} in ${cluster.declared.file}`
        : `${why} · ${cluster.count} uses across ${cluster.members.length} near-identical values`,
    );
    return key;
  };

  const pCanvas = put("canvas", roles.canvas, "lightest high-use neutral");
  const pElevated = put("canvas-elevated", roles.elevated, "next-lightest neutral surface");
  const pHairline = put("hairline", roles.hairline, "mid-light neutral border");
  const pInk = put("ink", roles.ink, "darkest high-use neutral");
  const pInkMute = put("ink-mute", roles.inkMute, "mid-dark neutral for secondary text");
  const pPrimary = put("brand", roles.primary, "most-used mid-lightness chromatic");
  const pError = put("red", roles.error, "most-used red-ward chromatic");
  const pSuccess = put("green", roles.success, "most-used green-ward chromatic");
  const pWarning = put("amber", roles.warning, "most-used amber/yellow chromatic");
  const pInfo = put("blue", roles.info, "most-used blue-ward chromatic");
  roles.accents.forEach((c, idx) =>
    put("accent-" + (idx + 1), c, "leftover high-use chromatic #" + (idx + 1)),
  );

  const ref = (key) => (key ? { $type: "color", $value: `{color.primitive.${key}}` } : null);
  const semantic = {};
  const setSem = (path, key, description) => {
    if (!key) return;
    const parts = path.split(".");
    let cur = semantic;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = {
      ...ref(key),
      $description: description,
    };
  };
  // A role the assigner declined stays absent in EVERY artifact. The earlier
  // `pElevated || pCanvas`-style fallbacks made tokens/color.json silently
  // declare surface.elevated while DESIGN.md's own frontmatter omitted it and
  // its prose said "no confident assignment — pick manually" — two artifacts
  // from one run disagreeing about what the system contains (caught by
  // multi-repo validation, 2026-08-07). text.on-action is the one deliberate
  // assumption, and only when the same assumption already stands in the
  // frontmatter as button-primary's textColor.
  setSem("surface.canvas", pCanvas, "Page background");
  setSem("surface.elevated", pElevated, "Raised surface (card, panel)");
  setSem("text.primary", pInk, "Primary body/heading text");
  setSem("text.secondary", pInkMute, "Secondary / muted text");
  const onKeyTok = textOnPrimaryKey(roles);
  if (onKeyTok === "surface.canvas") {
    setSem("text.on-action", pCanvas, "Text on a filled action (assumption — mirrors button-primary; review)");
  } else if (onKeyTok === "text.primary") {
    setSem("text.on-action", pInk, "Text on a filled action (assumption — mirrors button-primary; review)");
  }
  setSem("border.default", pHairline, "Default hairline border");
  setSem("action.primary", pPrimary, "Primary action / brand accent");
  setSem("status.danger", pError, "Error / destructive");
  setSem("status.success", pSuccess, "Success / positive");
  setSem("status.warning", pWarning, "Warning / caution");
  setSem("status.info", pInfo, "Informational");

  // Spacing + type from the scanner's scale proposals.
  const spacePrim = {};
  const typePrim = {};
  for (const cl of scales) {
    if (cl.prop === "text" && (cl.unit === "px" || cl.unit === "rem")) {
      cl.proposedScale.forEach((v, i) => {
        typePrim[`size-${i + 1}`] = dtcgDimension(v, cl.unit, `Derived from ${cl.collapse} text-${cl.unit} values`);
      });
    }
    if (cl.prop === "leading" && cl.unit === "px") {
      cl.proposedScale.forEach((v, i) => {
        typePrim[`leading-${i + 1}`] = dtcgDimension(v, "px", `Derived from ${cl.collapse} leading-px values`);
      });
    }
    if (cl.prop === "tracking" && (cl.unit === "em" || cl.unit === "px")) {
      cl.proposedScale.forEach((v, i) => {
        typePrim[`tracking-${i + 1}`] = {
          $type: "dimension",
          $value: `${v}${cl.unit}`,
          $description: `Derived from ${cl.collapse} tracking values`,
        };
      });
    }
    // Generic spacing from p/m/gap/w/h if the collapse was strong.
    if (["p", "m", "gap", "px", "py", "pt", "pb", "pl", "pr", "mx", "my"].includes(cl.prop) && cl.reduction >= 30) {
      cl.proposedScale.forEach((v) => {
        const key = `space-${v}${cl.unit === "px" ? "" : cl.unit}`;
        if (!spacePrim[key]) {
          spacePrim[key] = dtcgDimension(v, cl.unit, `Derived from ${cl.prop} ${cl.collapse}`);
        }
      });
    }
  }

  return {
    color: {
      $description: `Primitive and semantic colour tokens derived from ${meta.project} on ${meta.date}. Values are colours the codebase already ships — nothing was invented.`,
      primitive: prim,
      semantic,
    },
    typography: {
      $description: `Type scale derived from observed font-size / leading / tracking clusters in ${meta.project}.`,
      ...typePrim,
    },
    spacing: {
      $description: `Spacing scale derived from observed padding/margin/gap clusters in ${meta.project}.`,
      ...spacePrim,
    },
  };
}

// ---------------------------------------------- Google DESIGN.md frontmatter
// Target format: google-labs-code/design.md (spec version "alpha", Apache-2.0).
// Tokens live in YAML frontmatter as the machine-readable source of truth;
// prose explains why. Verified live against @google/design.md v0.4.0
// (2026-08-07 bake-off): dotted token keys resolve as literal names, a literal
// `primary` key is required to satisfy the missing-primary rule, and — the trap
// this emitter guards against — a frontmatter with NO token sections lints
// 0-findings, indistinguishable from a compliant file. Lint-clean is necessary,
// never sufficient; the structural self-check in main() is the real gate.

/** Always-quoted YAML scalar. An unquoted `#` starts a YAML comment and
 *  silently nulls everything after it — with hex colours that is every value
 *  in the file, so quoting is correctness here, not style. */
const yq = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Assigned colour roles as ordered [key, cluster] pairs. `primary` leads and
 *  aliases the brand role — the spec's missing-primary rule wants the literal
 *  name, and agents reading the file look for it first. */
function specColorEntries(roles) {
  const out = [];
  if (roles.primary) out.push(["primary", roles.primary]);
  const named = [
    ["surface.canvas", roles.canvas],
    ["surface.elevated", roles.elevated],
    ["text.primary", roles.ink],
    ["text.secondary", roles.inkMute],
    ["border.default", roles.hairline],
    ["action.primary", roles.primary],
    ["status.danger", roles.error],
    ["status.success", roles.success],
    ["status.warning", roles.warning],
    ["status.info", roles.info],
  ];
  for (const [k, c] of named) if (c) out.push([k, c]);
  roles.accents.forEach((c, i) => out.push([`accent-${i + 1}`, c]));
  return out;
}

/** Text colour to pair with the primary action: canvas on a dark primary, ink
 *  on a light one, judged by the OKLab L we already carry. Returns the colors.*
 *  key so the component references a token (and the token is not orphaned),
 *  or null when the needed neutral was never assigned — no invented values. */
function textOnPrimaryKey(roles) {
  if (!roles.primary) return null;
  const dark = roles.primary.lab.L < 0.6;
  if (dark && roles.canvas) return "surface.canvas";
  if (!dark && roles.ink) return "text.primary";
  return null;
}

function buildFrontmatter(roles, scales, meta) {
  const colors = specColorEntries(roles);
  const textScale = scales.find((s) => s.prop === "text" && (s.unit === "px" || s.unit === "rem"));
  const roundScale = scales.find((s) => s.prop === "rounded" && s.unit === "px");
  const space = scales.filter(
    (s) => ["p", "m", "gap", "px", "py", "pt", "pb", "pl", "pr", "mx", "my"].includes(s.prop) && s.reduction >= 30,
  );
  const onKey = textOnPrimaryKey(roles);

  const lines = [];
  lines.push(`---`);
  lines.push(`# Generated by design-drift propose (target: google-labs-code/design.md,`);
  lines.push(`# spec "alpha"). Do not hand-edit values without re-running the proposer —`);
  lines.push(`# the source of truth is the codebase, and these are a snapshot of it.`);
  lines.push(`version: ${yq("alpha")}`);
  lines.push(`name: ${yq(meta.project)}`);
  lines.push(`description: ${yq(`Derived from a design-drift scan of ${meta.files} files on ${meta.date}. Every value already ships in first-party source.`)}`);

  const omitted = [];
  if (colors.length) {
    lines.push(`colors:`);
    for (const [k, c] of colors) lines.push(`  ${k}: ${yq(c.hex)}`);
  } else {
    omitted.push(["colors", "no colour literals measured in this codebase"]);
  }

  if (textScale) {
    lines.push(`typography:`);
    textScale.proposedScale.forEach((v, i) => {
      lines.push(`  size-${i + 1}:`);
      lines.push(`    fontSize: ${yq(`${v}${textScale.unit}`)}`);
    });
  } else {
    omitted.push(["typography", "no clusterable font-size signal in the scan"]);
  }

  if (roundScale) {
    lines.push(`rounded:`);
    roundScale.proposedScale.forEach((v, i) => lines.push(`  r-${i + 1}: ${yq(`${v}px`)}`));
  } else {
    omitted.push(["rounded", "no clusterable border-radius signal in the scan"]);
  }

  if (space.length) {
    lines.push(`spacing:`);
    const seen = new Set();
    for (const s of space) {
      for (const v of s.proposedScale) {
        const key = `space-${v}${s.unit === "px" ? "" : s.unit}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`  ${key}: ${yq(`${v}${s.unit}`)}`);
      }
    }
  } else {
    omitted.push(["spacing", "no spacing cluster collapsed >=30% — nothing measured to declare"]);
  }

  if (roles.primary && onKey) {
    lines.push(`components:`);
    lines.push(`  button-primary:`);
    lines.push(`    backgroundColor: ${yq("{colors.primary}")}`);
    lines.push(`    textColor: ${yq(`{colors.${onKey}}`)}`);
  } else {
    omitted.push(["components", "components are not measured by the scanner; the button-primary contrast probe needs both a primary and a matching neutral"]);
  }

  if (omitted.length) {
    lines.push(`omitted:`);
    for (const [section, reason] of omitted) {
      lines.push(`  - section: ${yq(section)}`);
      lines.push(`    reason: ${yq(reason)}`);
    }
  }
  lines.push(`---`);
  return { lines, colorCount: colors.length };
}

function buildDesignMd(roles, scales, _tokens, meta, paletteHues) {
  const lines = [];
  const role = (label, cluster) => {
    if (!cluster) return `- **${label}:** _(no confident assignment — pick manually)_`;
    if (cluster.declared) {
      const d = cluster.declared;
      const refs = d.refs ? `, ${d.refs} var() call site${d.refs === 1 ? "" : "s"}` : "";
      return `- **${label}:** \`${cluster.hex}\` (declared as \`${d.name}\` in ${d.file}${refs})`;
    }
    const alts = cluster.members
      .slice(1, 4)
      .map((m) => `${m.hex}×${m.count}`)
      .join(", ");
    return `- **${label}:** \`${cluster.hex}\` (derived from ${cluster.count} uses${alts ? `; near: ${alts}` : ""})`;
  };

  const fm = buildFrontmatter(roles, scales, meta);
  lines.push(...fm.lines);
  lines.push(``);
  lines.push(`## Overview`);
  lines.push(``);
  lines.push(`Derived from the codebase as it is, not from a brand deck. Every colour`);
  lines.push(`below is a value already shipping somewhere in first-party source; every`);
  lines.push(`scale is a collapse of values the code already uses. The YAML front matter`);
  lines.push(`above is the machine-readable truth; this prose is the why. Review the`);
  lines.push(`assignments, rename freely, then commit. Migration is a separate step.`);
  lines.push(``);
  lines.push(`Evidence comes in two tiers, and each role names its tier: a role`);
  lines.push(`"declared as \`--x\` in <file>" was already tokenized by a person and wins`);
  lines.push(`outright; a role "derived from N uses" is this tool's clustering of raw`);
  lines.push(`literals, weighted by shipped (non-test) occurrences.`);
  lines.push(``);
  lines.push(`## Colors`);
  lines.push(``);
  lines.push(`### Roles`);
  lines.push(``);
  lines.push(`Built as roles, not a bag of swatches (impeccable/colorize.md). Each role`);
  lines.push(`is the highest-use colour matching a lightness/chroma/hue heuristic; the`);
  lines.push(`"near" list is what the cluster absorbed and can be deleted once the role`);
  lines.push(`token is adopted.`);
  lines.push(``);
  lines.push(role("surface.canvas", roles.canvas));
  lines.push(role("surface.elevated", roles.elevated));
  lines.push(role("text.primary (ink)", roles.ink));
  lines.push(role("text.secondary (ink-mute)", roles.inkMute));
  lines.push(role("border.default (hairline)", roles.hairline));
  lines.push(role("action.primary (brand)", roles.primary));
  lines.push(role("status.danger", roles.error));
  lines.push(role("status.success", roles.success));
  lines.push(role("status.warning", roles.warning));
  lines.push(role("status.info", roles.info));
  if (roles.accents.length) {
    lines.push(``);
    lines.push(`### Accents (unassigned high-use chromatics)`);
    lines.push(``);
    roles.accents.forEach((c, i) => lines.push(role(`accent-${i + 1}`, c)));
  }
  if (meta.modeNotes?.length) {
    lines.push(``);
    lines.push(`### Mode divergence`);
    lines.push(``);
    lines.push(`This system was derived from the **${meta.mode}** theme. The other mode`);
    lines.push(`declares different values for role-named tokens — it is a distinct`);
    lines.push(`system, not a tint of this one:`);
    lines.push(``);
    for (const n of meta.modeNotes) lines.push(`- ${n}`);
    lines.push(``);
    lines.push(`Regenerate with \`--mode=${meta.mode === "light" ? "dark" : "light"}\` to derive it.`);
  }
  lines.push(``);
  lines.push(`### Tailwind palette pressure`);
  lines.push(``);
  if (paletteHues?.length) {
    lines.push(`Raw \`bg-gray-500\` / \`text-blue-600\` style utilities, by hue. This is the`);
    lines.push(`largest drift category and the reason a semantic palette has to exist —`);
    lines.push(`${paletteHues.length} hues in play means there is no palette, only an`);
    lines.push(`accumulation. Collapse toward the roles above.`);
    lines.push(``);
    for (const h of paletteHues.slice(0, 12)) {
      lines.push(`- **${h.hue}:** ${h.count} uses`);
    }
  } else {
    lines.push(`_(no raw palette utilities detected)_`);
  }
  lines.push(``);
  lines.push(`## Typography`);
  lines.push(``);
  const textScale = scales.find((s) => s.prop === "text" && (s.unit === "px" || s.unit === "rem"));
  const leadScale = scales.find((s) => s.prop === "leading");
  const trackScale = scales.find((s) => s.prop === "tracking");
  if (textScale) {
    lines.push(`### Size scale (${textScale.unit})`);
    lines.push(``);
    lines.push(`Collapsed ${textScale.collapse} (${textScale.reduction}% fewer).`);
    lines.push(``);
    lines.push(`| Step | Value |`);
    lines.push(`| --- | --- |`);
    textScale.proposedScale.forEach((v, i) => lines.push(`| size-${i + 1} | ${v}${textScale.unit} |`));
    lines.push(``);
    lines.push(`In use today: ${textScale.distinctValues.join(", ")}`);
    lines.push(``);
  }
  if (leadScale) {
    lines.push(`### Leading (${leadScale.unit})`);
    lines.push(``);
    lines.push(`Collapsed ${leadScale.collapse}. Proposed: ${leadScale.proposedScale.map((v) => v + leadScale.unit).join(", ")}`);
    lines.push(``);
  }
  if (trackScale) {
    lines.push(`### Tracking (${trackScale.unit})`);
    lines.push(``);
    lines.push(`Collapsed ${trackScale.collapse}. Proposed: ${trackScale.proposedScale.map((v) => v + trackScale.unit).join(", ")}`);
    lines.push(``);
  }
  if (!textScale && !leadScale && !trackScale) {
    lines.push(`_(no strong type-scale clusters — the codebase may already be on a scale, or type is too sparse to cluster)_`);
    lines.push(``);
  }
  lines.push(`## Layout`);
  lines.push(``);
  const space = scales.filter(
    (s) => ["p", "m", "gap", "px", "py", "pt", "pb", "pl", "pr"].includes(s.prop) && s.reduction >= 30,
  );
  if (space.length) {
    lines.push(`Spacing derived from padding/margin/gap clusters with ≥30% collapse:`);
    lines.push(``);
    for (const s of space.slice(0, 6)) {
      lines.push(`- **${s.prop} (${s.unit}):** ${s.collapse} → ${s.proposedScale.join(", ")}`);
    }
  } else {
    lines.push(`_(no strong spacing clusters at the 30% threshold — consider a 4px base by convention)_`);
  }
  lines.push(``);
  const onKey = textOnPrimaryKey(roles);
  if (roles.primary && onKey) {
    lines.push(`## Components`);
    lines.push(``);
    lines.push(`One component is declared, and it is an ASSUMPTION, not a measurement: the`);
    lines.push(`scanner does not extract components. \`button-primary\` pairs the primary`);
    lines.push(`with \`{colors.${onKey}}\` so \`designmd lint\` has a real fore/background pair`);
    lines.push(`to run its WCAG AA contrast rule against. If your primary buttons pair`);
    lines.push(`differently, correct the front matter — the contrast check follows it.`);
    lines.push(``);
  }
  lines.push(`## Do's and Don'ts`);
  lines.push(``);
  lines.push(`Grounded in what the scan actually found, not generic advice:`);
  lines.push(``);
  lines.push(`- **Do** reach every colour through a token above. **Don't** add a raw hex,`);
  lines.push(`  \`rgb()\`, or \`hsl()\` literal — the scan that produced this file is also a`);
  lines.push(`  CI ratchet, and new literals fail it.`);
  if (paletteHues?.length) {
    lines.push(`- **Don't** use raw Tailwind palette utilities (\`bg-gray-500\`-style).`);
    lines.push(`  ${paletteHues.length} hues are in play today; collapse toward the roles above.`);
  }
  lines.push(`- **Don't** introduce a near-duplicate of an existing token (the "near" lists`);
  lines.push(`  under Colors are the duplicates already being paid for).`);
  lines.push(`- **Do** treat every assignment as a proposal carrying its evidence —`);
  lines.push(`  override any of them before adopting, then re-run the proposer.`);
  lines.push(``);
  lines.push(`## Token files`);
  lines.push(``);
  lines.push(`Machine-readable companions (W3C DTCG 2025.10 shape):`);
  lines.push(``);
  lines.push(`- \`tokens/color.json\` — primitive + semantic colour tiers`);
  lines.push(`- \`tokens/typography.json\` — size / leading / tracking`);
  lines.push(`- \`tokens/spacing.json\` — space scale`);
  lines.push(``);
  lines.push(`These stay authoritative for typography detail: the spec CLI's export drops`);
  lines.push(`\`lineHeight\` silently (verified against @google/design.md v0.4.0), so the`);
  lines.push(`leading/tracking scales here exist ONLY in prose and in \`tokens/\`.`);
  lines.push(``);
  lines.push(`Primitive tokens hold raw values. Semantic tokens reference primitives by`);
  lines.push(`\`{color.primitive.<name>}\` so a theme remap only rewrites the aliases.`);
  lines.push(``);
  lines.push(`## Provenance and next steps`);
  lines.push(``);
  lines.push(`Not a brand exercise (no fonts, voice, illustration, motion) and not a`);
  lines.push(`migration (no application source was edited). Then:`);
  lines.push(``);
  lines.push(`1. Review role assignments — especially \`action.primary\` and the status colours.`);
  lines.push(`2. Verify: \`npx -y -p @google/design.md designmd lint DESIGN.md\` (0 errors).`);
  lines.push(`3. Commit this directory.`);
  lines.push(`4. Point Style Dictionary / Tailwind at \`tokens/\` (or hand-write the bridge).`);
  lines.push(`5. Migrate call sites; re-run \`design-drift\` and lower the CI ratchet budgets`);
  lines.push(`   in the same PR as the cleanup so the floor only moves down.`);
  lines.push(``);
  return lines.join("\n");
}

// ------------------------------------------------------------------- main

function loadReport() {
  if (fromStdin) {
    const raw = readFileSync(0, "utf8");
    return JSON.parse(raw);
  }
  const scanPath = join(__dirname, "scan.mjs");
  const r = spawnSync(process.execPath, [scanPath, root, "--json", "--full"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error("design-drift propose: scan failed\n" + (r.stderr || r.stdout));
    process.exit(r.status || 1);
  }
  return JSON.parse(r.stdout);
}

const report = loadReport();
const colorAll = (report.findings.color?.all || []).filter((c) => /^#[0-9a-fA-F]{3,8}$/.test(c.value));
const scales = report.findings.scale?.clusters || [];
const paletteHues = report.findings.palette?.allHues || report.findings.palette?.hues || [];
const declaredAll = (report.findings.declaredTokens || []).filter((d) => d.hex);
const declaredTokens = declaredAll.filter((d) => (d.mode || "light") === themeMode);

// Workspace refusal (#272): a monorepo with two or more independently-themed
// units gets NO blended DESIGN.md — the blend is a system no app owns (the
// dogfood run named a 45-file side app's navy as a 10-app monorepo's brand).
// Point the proposer at one app, or pass --allow-blended to insist.
const ws = report.findings.workspace;
if (ws?.detected && !allowBlended) {
  const unitOf = (f) => {
    const m = (f || "").match(/^((apps|packages)\/[^/]+)\//);
    return m ? m[1] : null;
  };
  const themedUnits = [...new Set(declaredAll.map((d) => unitOf(d.file)).filter(Boolean))];
  if (themedUnits.length >= 2) {
    console.error(
      "design-drift propose: this is a workspace (" + ws.manifest + ") with " +
        themedUnits.length + " independently-themed units — refusing to blend them " +
        "into one DESIGN.md that no app owns.\n  themed units: " + themedUnits.join(", ") +
        "\n  Run per app (node propose.mjs <root>/" + themedUnits[0] + " …) or pass --allow-blended.",
    );
    process.exit(3);
  }
}

// Residual literals are weighted by SHIPPED uses — test-file occurrences carry
// zero derivation weight (#264). `?? c.count` keeps --stdin reports from older
// scanners (and synthetic test fixtures) working unchanged.
const shippedColors = colorAll
  .map((c) => ({ value: c.value, count: c.shipped ?? c.count }))
  .filter((c) => c.count > 0);

if (colorAll.length < 4 && scales.length === 0 && declaredTokens.length === 0) {
  console.error(
    "design-drift propose: not enough signal to propose a system " +
      `(${colorAll.length} hex colours, ${scales.length} scale clusters, ` +
      `${declaredTokens.length} declared tokens). ` +
      "Is this the right repo, or is it already clean?",
  );
  process.exit(2);
}

const clusters = shippedColors.length ? clusterColors(shippedColors, clusterTarget) : [];
const declaredRoles = assignDeclaredRoles(declaredTokens);
const roles = assignRoles(clusters, declaredRoles);
// The other mode's divergent role declarations are surfaced, not hidden: a
// --mode=light run of a dark-identity brand must SAY the dark system exists.
const otherMode = themeMode === "light" ? "dark" : "light";
const modeNotes = [];
for (const d of declaredAll) {
  if ((d.mode || "light") !== otherMode) continue;
  const role = roleForTokenName(d.name);
  if (!role) continue;
  const assigned = roles[role];
  if (!assigned || assigned.hex === d.hex) continue;
  modeNotes.push(`${otherMode} mode declares \`${d.name}: ${d.hex}\` — differs from the ${themeMode} value above`);
  if (modeNotes.length >= 6) break;
}

const meta = {
  project: projectName,
  date: new Date().toISOString().slice(0, 10),
  files: report.scanned,
  mode: themeMode,
  modeNotes,
};
// False-clean guard. `designmd lint` cannot catch an underpopulated file — a
// frontmatter with zero token sections lints 0-findings, identical to a
// compliant one (verified live, v0.4.0). So if colours were MEASURED but the
// role pass assigned none, refuse to emit: the output would read as a passing
// design system while declaring nothing. A repo with genuinely no colours is
// different and fine — colors goes into `omitted` with its reason.
if (colorAll.length >= 4 && specColorEntries(roles).length === 0) {
  const testOnly = shippedColors.length === 0 && declaredTokens.length === 0;
  console.error(
    "design-drift propose: measured " + colorAll.length + " colours but assigned zero roles — " +
      "refusing to emit a token-free DESIGN.md (it would lint clean while declaring nothing). " +
      (testOnly
        ? "Every measured colour lives ONLY in test files, and a test fixture must not name a brand."
        : "This is a proposer defect or a pathological palette; inspect with --clusters."),
  );
  process.exit(1);
}

const tokens = buildTokens(roles, scales, meta);
const designMd = buildDesignMd(roles, scales, tokens, meta, paletteHues);

if (outDir) {
  const abs = resolve(outDir);
  mkdirSync(join(abs, "tokens"), { recursive: true });
  writeFileSync(join(abs, "DESIGN.md"), designMd);
  writeFileSync(join(abs, "tokens", "color.json"), JSON.stringify(tokens.color, null, 2) + "\n");
  writeFileSync(join(abs, "tokens", "typography.json"), JSON.stringify(tokens.typography, null, 2) + "\n");
  writeFileSync(join(abs, "tokens", "spacing.json"), JSON.stringify(tokens.spacing, null, 2) + "\n");
  console.error(`design-drift propose: wrote ${abs}/{DESIGN.md,tokens/}`);
} else {
  // Default: print DESIGN.md to stdout, summary of tokens to stderr so a pipe
  // gets a clean document.
  console.log(designMd);
  console.error(
    `design-drift propose: ${clusters.length} colour clusters from ${colorAll.length} hex values; ` +
      `${Object.keys(tokens.color.primitive).length} primitive colour tokens. ` +
      `Re-run with --out=<dir> to write DESIGN.md + tokens/.`,
  );
}
