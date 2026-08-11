#!/usr/bin/env node
/*
  design-drift scanner — dependency-free.

  Finds the places a codebase reinvents its own design system: raw colour
  literals, one-off Tailwind arbitrary values, and — the point of this tool —
  CLUSTERS of near-identical values that reveal the scale nobody ever defined.

  It NEVER edits files. Every hit is a lead to confirm by reading the code, not
  a verdict.

  The clustering is what separates this from `grep`. Knowing you have 1,000
  arbitrary values is not actionable. Knowing that `text-[]` uses nine distinct
  sizes and that five steps would cover 94% of them IS — because it names the
  scale you are missing and tells you what to collapse into it.

  Usage:
    node scan.mjs [root] [--json] [--no-color]
                  [--only=color,arbitrary] [--skip=nearcolor]
                  [--exclude=path] [--vendor=glob] [--top=N]

  Detectors (--only / --skip take these ids):
    color       raw hex / rgb() / hsl() literals in source
    arbitrary   Tailwind arbitrary values, e.g. text-[14px], p-[13px]
    scale       clusters of arbitrary values that imply a missing scale
    nearcolor   colour literals close enough that they should be one token

  Suppressing confirmed-intentional hits, in source comments:
    design-drift-ignore [ids…]            suppress hits on the same line
    design-drift-ignore-next-line [ids…]  suppress hits on the next line
    design-drift-ignore-file [ids…]       suppress hits in the whole file
  Without ids the directive suppresses every detector; with ids only those.

  Vendored code (pasted-in shadcn/ui, components/ui) is counted SEPARATELY and
  never mixed into the first-party totals: a defect there may be upstream's, and
  fixing it gets reverted on the next paste.
*/

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const DETECTORS = ["color", "arbitrary", "palette", "scale", "nearcolor", "orphan"];

const SOURCE_EXT = new Set([".tsx", ".ts", ".jsx", ".js", ".css", ".scss", ".astro", ".vue", ".svelte"]);
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "out", "coverage",
  ".turbo", ".vercel", "storybook-static", "__snapshots__",
  // Git worktrees hold a full copy of the repo per branch. Descending into them
  // is not merely slow, it is WRONG: findings from other branches get counted as
  // if they were the current tree, and shared values are counted once per
  // worktree, inflating every total. Measured on one monorepo: 2,094,521 files
  // walked, of which 2,041,146 were worktree copies — a 40x amplification over
  // the ~6k files that actually matter.
  ".claude", ".worktrees", "worktrees",
  ".cache", ".venv", "venv", "__pycache__", "vendor", "target",
]);

// Files that are ALLOWED to hold raw colour values — that is their job.
const TOKEN_FILE = /(^|[\\/])(tokens?|theme|palette|colors?|globals|design-system)[.\-\w]*\.(css|scss|ts|js|json)$/i;
// Pasted-in component libraries: counted, but reported apart from first-party.
const VENDOR_DEFAULT = [/[\\/]shadcn[\\/]/i, /[\\/]components[\\/]ui[\\/]/i, /[\\/]magicui[\\/]/i, /[\\/]vendor[\\/]/i];

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith("-")) || ".");
const asJson = args.includes("--json");
const noColor = args.includes("--no-color") || asJson || !process.stdout.isTTY;

const flagList = (name) =>
  args
    .filter((a) => a.startsWith(`--${name}=`))
    .flatMap((a) => a.slice(name.length + 3).split(","))
    .map((s) => s.trim())
    .filter(Boolean);

const flagNum = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const only = flagList("only");
const skip = flagList("skip");
const excludes = flagList("exclude");
const vendorGlobs = flagList("vendor").map((g) => new RegExp(g.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"), "i"));
const TOP = flagNum("top", 8);
// --full dumps the complete inventory (every colour, every arbitrary value,
// every palette utility, with counts) under findings.*.all. Used by
// propose.mjs to cluster — the human report's top-N is not enough data.
const FULL = args.includes("--full");
// How close two px values must be to count as the same intended step, and how
// much a proposed scale must actually collapse before the cluster is worth
// reporting at all.
const TOLERANCE_PX = flagNum("tolerance-px", 1);
const MIN_REDUCTION = flagNum("min-reduction", 30);
// Report-only by default (exit 0) so a scan never breaks someone's flow.
//
//   --fail-on=0                     fail on any hit at all
//   --fail-on=500                   one ceiling over the combined total
//   --fail-on=color=2474,palette=3121   a ceiling PER DETECTOR
//
// Per-detector is what makes this a real ratchet. A single combined ceiling is
// gameable in the direction that matters least: delete 100 colour literals,
// add 100 palette utilities, total unchanged, gate green, codebase no better.
// Each detector holding its own line means every category can only go down.
// A budget key is `<detector>` (whole tree) or `<region>:<detector>` (only
// hits under that directory), e.g. `apps/web:color=120`. Region budgets are
// what let one monorepo app ratchet down without being hostage to a sibling's
// backlog (#2). Only the occurrence detectors can be region-scoped: `orphan`
// resolves names across the whole tree (a var used in one app may be defined
// in another), so slicing it by directory would manufacture false orphans.
const REGION_DETECTORS = ["color", "arbitrary", "palette"];
let HIT_FILES = null; // set by analyse(); see the region-budget note there
const regionCount = (id, region) =>
  HIT_FILES?.[id] === undefined ? undefined : HIT_FILES[id].filter((f) => f.startsWith(region + "/")).length;

// Brand scopes (#9). A brand is rarely one directory: the case that forced
// this was a funnel brand whose surfaces were individual FILES scattered
// across shared component dirs — no directory-prefix budget could fence it.
// design/brands.json (per app) is the machine-readable half of the brand
// registry: { "<brand>": { "surfaces": ["dir-or-file", …],
// "system": "design/<brand>/DESIGN.md" | null } }. system:null registers a
// brand so its colours are ATTRIBUTED (not another brand's drift) before its
// page ships. Budget keys reach brands with '@': `@<brand>:color=N` when
// scanning the app itself, `<unit>@<brand>:color=N` from a workspace root.
function loadBrands(appDir) {
  const p = join(appDir, "design", "brands.json");
  if (!existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`design-drift: ${p} is not valid JSON (${e.message}) — a broken brand registry must not silently un-fence its brands`);
    process.exit(2);
  }
  for (const [name, b] of Object.entries(parsed)) {
    if (!Array.isArray(b?.surfaces) || b.surfaces.length === 0 || b.surfaces.some((s) => typeof s !== "string" || s === "")) {
      console.error(`design-drift: brands.json brand '${name}' needs a non-empty surfaces array of paths`);
      process.exit(2);
    }
    // Surfaces are normalized and MUST exist (as real files or dirs, not
    // symlinks). Found by adversarial review: a single trailing slash made a
    // surface match nothing, the brand tallied 0, and --tighten cemented the
    // 0 as a forever-green ceiling — the exact silent un-fencing the loud-
    // failure invariant forbids.
    b.surfaces = b.surfaces.map((s) => s.replace(/^\.\//, "").replace(/\/+$/, ""));
    for (const s of b.surfaces) {
      if (s === "" || s.startsWith("/") || s.split("/").includes("..")) {
        console.error(`design-drift: brands.json brand '${name}' surface '${s}' is degenerate — use app-relative paths`);
        process.exit(2);
      }
      let st = null;
      try {
        st = lstatSync(join(appDir, s));
      } catch {}
      if (!st || (!st.isFile() && !st.isDirectory())) {
        console.error(
          `design-drift: brands.json brand '${name}' surface '${s}' does not exist under ${appDir}` +
            " — a mistyped surface would tally nothing and always pass",
        );
        process.exit(2);
      }
    }
    if (b.system !== null && typeof b.system !== "string") {
      console.error(`design-drift: brands.json brand '${name}' needs system: <path> or null (registered, underived)`);
      process.exit(2);
    }
  }
  return parsed;
}
// A hit belongs to a surface that is a directory (prefix + "/") or the exact
// file. Surfaces are app-relative; `rel` makes them scan-root-relative.
const brandCount = (id, surfaces, rel) =>
  HIT_FILES?.[id] === undefined
    ? undefined
    : HIT_FILES[id].filter((f) => surfaces.some((s) => {
        const full = rel ? `${rel}/${s}` : s;
        return f === full || f.startsWith(full + "/");
      })).length;
function parseBudgetKey(key, flag) {
  const at = key.lastIndexOf(":");
  const region = at === -1 ? null : key.slice(0, at).replace(/^\.\//, "").replace(/\/+$/, "");
  const id = at === -1 ? key : key.slice(at + 1);
  if (!DETECTORS.includes(id)) {
    console.error(
      `design-drift: bad ${flag} budget key '${key}'\n` +
        `  expected <detector> or <region>:<detector> with detector in: ${DETECTORS.join(", ")}`,
    );
    process.exit(2);
  }
  if (region !== null) {
    if (!REGION_DETECTORS.includes(id)) {
      console.error(
        `design-drift: ${flag} cannot region-scope '${id}' — name resolution is\n` +
          `  whole-tree (a definition may live outside the region), so a regional\n` +
          `  count would be fiction. Region budgets: ${REGION_DETECTORS.join(", ")}.`,
      );
      process.exit(2);
    }
    // '@' names a brand from <unit>/design/brands.json (#9): `@hov:color=N`
    // scanning the app itself, `apps/x@hov:color=N` from a workspace root.
    // Every failure is loud — a missing registry or unknown brand must never
    // become a budget that fences nothing.
    if (region.includes("@")) {
      // A directory literally containing '@' (pnpm/yarn scope-mirroring dirs
      // like packages/@acme/ui) predates brand keys and wins: if the whole
      // region exists as a real directory, it is a plain region, not a brand
      // reference — pre-v0.4.0 configs keep working unchanged.
      let literal = null;
      try {
        literal = lstatSync(join(root, region));
      } catch {}
      if (literal?.isDirectory()) return { region, id, brand: undefined };
      const at2 = region.indexOf("@");
      const unit = region.slice(0, at2).replace(/\/+$/, "");
      const name = region.slice(at2 + 1);
      const appDir = unit === "" ? root : join(root, unit);
      if (unit !== "") {
        let unitStat = null;
        try {
          unitStat = lstatSync(appDir);
        } catch {}
        if (!unitStat?.isDirectory()) {
          console.error(`design-drift: ${flag} brand key '${region}' — unit '${unit}' is not a directory under ${root}`);
          process.exit(2);
        }
      }
      const brands = loadBrands(appDir);
      if (!brands) {
        console.error(`design-drift: ${flag} brand key '${region}' — no design/brands.json in ${appDir}`);
        process.exit(2);
      }
      if (!brands[name]) {
        console.error(
          `design-drift: ${flag} brand key '${region}' — brand '${name}' is not in ${appDir}/design/brands.json (has: ${Object.keys(brands).join(", ")})`,
        );
        process.exit(2);
      }
      return { region, id, brand: { unit, name, surfaces: brands[name].surfaces } };
    }
    // A region that matches nothing budgets zero hits and passes forever.
    // Zero-run-green is the failure mode a ratchet exists to prevent, so every
    // degenerate form is a hard error, never a silent pass: an absent or
    // mistyped directory, an empty/'.' region (no relative path starts with
    // "/"), and a symlink — the walker does not follow symlinks, so a
    // symlinked region would read 0 while its real target keeps drifting.
    if (region === "" || region === "." || region.startsWith("/") || region.split("/").includes("..")) {
      console.error(
        `design-drift: ${flag} region '${region}' is degenerate — use a root-relative directory like apps/web`,
      );
      process.exit(2);
    }
    let regionStat = null;
    try {
      regionStat = lstatSync(join(root, region));
    } catch {}
    if (!regionStat?.isDirectory()) {
      console.error(
        `design-drift: ${flag} region '${region}' is not a real directory under ${root}\n` +
          "  (regions are root-relative paths; symlinks are not walked; a typo here\n" +
          "   would budget nothing and always pass)",
      );
      process.exit(2);
    }
  }
  return { region, id };
}
function parseFailOn(raw) {
  if (raw === null) return null;
  if (/^\d+$/.test(raw)) return { total: Number(raw) };
  const per = [];
  for (const part of raw.split(",")) {
    const eq = part.lastIndexOf("=");
    const k = eq === -1 ? part.trim() : part.slice(0, eq).trim();
    const v = eq === -1 ? "" : part.slice(eq + 1).trim();
    if (!/^\d+$/.test(v)) {
      console.error(
        `design-drift: bad --fail-on budget '${part}'\n` +
          `  expected a number, or <key>=<number> with key = <detector> or <region>:<detector>`,
      );
      process.exit(2);
    }
    const { region, id, brand } = parseBudgetKey(k, "--fail-on");
    const key = region === null ? id : `${region}:${id}`;
    // One key, one ceiling. v0.1.x silently kept the LAST duplicate; an
    // enforcement spec where two numbers claim the same key is a mistake
    // (merge leftovers, usually) and gets said out loud, not resolved quietly.
    if (per.some((e) => e.key === key)) {
      console.error(`design-drift: duplicate --fail-on key '${key}' — one key, one ceiling`);
      process.exit(2);
    }
    per.push({ key, region, id, brand, budget: Number(v) });
  }
  return { per };
}
const failOnRaw = args.find((a) => a.startsWith("--fail-on="));
const FAIL_ON = parseFailOn(failOnRaw ? failOnRaw.slice("--fail-on=".length) : null);

const enabled = (id) => (only.length ? only.includes(id) : true) && !skip.includes(id);

const c = (code, s) => (noColor ? s : `[${code}m${s}[0m`);
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const red = (s) => c(31, s);
const yellow = (s) => c(33, s);
const cyan = (s) => c(36, s);

// ---------------------------------------------------------------- collection

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir — skip rather than abort the whole scan
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (excludes.some((x) => full.includes(x))) continue;
      walk(full, out);
    } else if (e.isFile() && SOURCE_EXT.has(extname(e.name))) {
      if (excludes.some((x) => full.includes(x))) continue;
      out.push(full);
    }
  }
  return out;
}

const isVendor = (rel) =>
  VENDOR_DEFAULT.some((re) => re.test(rel)) || vendorGlobs.some((re) => re.test(rel));

// ------------------------------------------------------------------ matching

// Hex must be a full 3/4/6/8-digit token. The trailing boundary rejects any
// following letter or digit, not just hex digits: `#abcdef123` (id fragment)
// still misses, and so do hex-valid PREFIXES of ordinary words — multi-repo
// validation (2026-08-07) found `/#features` counted as colour `#fea` and a
// Jest `describe("#accessRequests…")` counted as `#acce`. A real CSS colour is
// never followed by a letter, so the wider boundary costs nothing.
const HEX = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g;

/** Reject `#NNNN` written with no hex letter — it is a number, not a colour.
 *
 *  Comment stripping already removes `// see #1419`, but a reference inside a
 *  STRING survives it: `describe('handles the edge case (#1387)', …)`, and so
 *  does prose in JSX — one audited monorepo ships its office's street address
 *  (a `#NNNN` suite number) 46 times across legal pages and email templates.
 *  Measured on that repo: 73 occurrences over 13 values were issue numbers or
 *  that suite number, and the 74th (an issue reference added by one unrelated
 *  commit) is what pushed its CI ratchet over budget.
 *
 *  Scoped to length 4 on purpose. Four-digit `#RGBA` is rare in real CSS and
 *  all-decimal `#RGBA` rarer still, whereas issue and street numbers are
 *  overwhelmingly four digits. THREE-digit stays as-is: `#000`, `#333`, `#666`
 *  and `#999` are ordinary greys, so the same rule there would delete real
 *  drift. That leaves `#456`-shaped references as a known residual — comment
 *  stripping catches them everywhere except inside a string. */
const isNumericReference = (body) => body.length === 4 && !/[a-f]/i.test(body);
// /i (#29): RGB()/HSL() calls were invisible to counting — a coverage gap
// in occurrence detection itself, shipped as its own release because fixing
// it CHANGES COUNTS (re-baseline budgets in the consuming pin-bump PR).
const FUNC_COLOR = /\b(rgba?|hsla?)\(\s*[0-9.]/gi;

// Context class per colour hit (#10). The safe migration substitution differs
// per class, and two classes are var-FATAL: an SVG presentation attribute
// (`fill="var(--x)"` is invalid and paints black) and any string a component
// does math on (canvas fillStyle, hex+alpha concat) — those need consumer
// changes, not call-site substitution. Line-based heuristics, deliberately
// coarse: the tag pre-sorts a migration plan; references/migration.md in the
// skill carries the per-class recipes and caveats. Checked most-specific
// first.
// Both spellings per attribute: hyphenated (HTML/SVG source) AND camelCase —
// React requires stopColor/floodColor/lightingColor in JSX, which is exactly
// where SVG gradients get authored (found by adversarial review: the
// hyphen-only pattern made svg-attr dead code for those three in .tsx).
const SVG_PAINT_ATTR =
  /(?:fill|stroke|stop-color|stopColor|flood-color|floodColor|lighting-color|lightingColor)\s*=\s*["']$/;
function classifyContext(line, idx) {
  const before = line.slice(0, idx);
  if (/-\[[^\]]*$/.test(before)) return "utility"; // Tailwind arbitrary: -[#hex]/N → -token/N
  if (SVG_PAINT_ATTR.test(before)) return "svg-attr"; // var() invalid — needs CSS fill or component change
  if (/\bstyle\s*=\s*(?:["'][^"']*|\{\{[^}]*)$/.test(before)) return "style-attr"; // inline style → var()
  if (/[{,(\s][\w-]+\s*:\s*["'`]?[^;{}"'`]*$/.test(before)) return "css-value"; // CSS decl / style object → var()
  // `prop` means a JSX/HTML attribute, so it requires an OPEN TAG on the line
  // (`<Tag attr="` — a `<` with no closing `>` after it). Without that,
  // `ident='#hex'` is a JS assignment (`ctx.fillStyle='…'`, `let bg='…'`)
  // whose consumers may do string math — the read-the-consumer class.
  if (/[A-Za-z][\w-]*=["']$/.test(before) && /<[A-Za-z][^>]*$/.test(before)) return "prop";
  if (/["'`]/.test(before.slice(-40))) return "string"; // bare string/template — assume the code does math on it
  return "other";
}
// Tailwind arbitrary value with a unit-bearing number: text-[14px], p-[1.5rem].
// Requires a leading boundary so `data-[state=open]` and `w-[var(--x)]` miss.
const ARBITRARY = /(?:^|[\s"'`:])(-?[a-z]+(?:-[a-z]+)*)-\[(-?\d*\.?\d+)(px|rem|em|%)\]/g;

// Raw Tailwind palette utilities — bg-gray-500, text-blue-600, divide-gray-200.
// These bypass semantic tokens entirely while looking like idiomatic Tailwind,
// which is why they are easy to miss and end up the LARGEST drift category:
// 3,053 occurrences across 367 files in the first monorepo scanned, more than
// raw colour literals and arbitrary values combined.
//
// The prefix/colour/step decomposition is adapted from lint_hardcodes.py in
// plugin87/ux-ui-agent-skills (MIT, per that project's README).
const TW_PREFIX =
  "(?:bg|text|border|ring|ring-offset|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder|shadow)";
const TW_HUE =
  "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
// Tailwind's default type scale, for the type-scale contrast measure (#24).
const TW_TEXT_PX = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36, "5xl": 48, "6xl": 60, "7xl": 72, "8xl": 96, "9xl": 128 };
const TW_TEXT_SIZE = /\btext-(xs|sm|base|lg|xl|[2-9]xl)\b/g;

// CSS <time> literals for the motion census (#24). The lookbehind keeps the
// tail of an identifier ("v2s") and a decimal's own tail out; \b after the
// unit keeps "2spin" out.
const TIME_ALL = /(?<![\w.-])([\d.]+)(ms|s)\b/g;
const TIME_ONE = /(?<![\w.-])([\d.]+)(ms|s)\b/;

const PALETTE = new RegExp(`(?<![\\w-])(${TW_PREFIX})-(${TW_HUE})-(50|[1-9]00|950)\\b`, "g");

// A value reached THROUGH a token is not a hardcode. `var(--x, #fff)` is a
// fallback, `theme(colors.brand)` is a lookup. Without this the colour detector
// punishes exactly the code that is doing the right thing.
const TOKEN_CTX = /var\(--|theme\(|tokens?[./]|--[\w-]+\s*:/;

// The mirror image of every other detector here: those find raw values that
// should be tokens, this finds token NAMES that resolve to nothing — a typo'd
// var, a token renamed or deleted out from under its callers, or a component
// pasted in from a different design system. Idea ported from
// validate_theme_refs.py in plugin87/ux-ui-agent-skills (MIT).
const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)/g;
// Definitions appear in three shapes and ALL must be collected. A CSS `--x: v`,
// the JSX inline-style form `style={{ "--x": v }}` where the quote sits between
// the name and the colon, and Next.js's next/font convention where the name is
// a quoted VALUE on a `variable:` key — `Inter({ variable: "--font-sans" })` —
// which the framework turns into a real definition on <html>. Missing the
// second reported 40% of a real codebase's variables as orphaned; missing the
// third made 2 of 3 "unresolved" names on a stock Next.js app false positives
// (multi-repo validation, 2026-08-07).
const VAR_DEF = /(--[A-Za-z0-9_-]+)\s*["']?\s*:/g;
const VAR_DEF_NEXT_FONT = /\bvariable\s*:\s*["'](--[A-Za-z0-9_-]+)["']/g;

// ------------------------------------------------- declared tokens (#264)
// Token/theme files are EXCLUDED from the colour drift count — a value declared
// there is the system, not drift. But that same exclusion starved the proposer:
// multi-repo validation (2026-08-07) showed it deriving "brand" from third-party
// badge colours and canvas swatches while the repo's real palette sat in the
// excluded files. So token files now yield a separate `declaredTokens` inventory
// (name, raw value, resolved hex) that the proposer reads FIRST. The drift
// numbers do not move: declarations are collected alongside, never added to
// findings.color.
//
// Three declaration shapes, one per convention that validation actually hit:
//   --primary: 222.2 47.4% 11.2%;      shadcn bare-HSL custom property
//   almostBlack: "#111319",            theme.ts object literal (outline)
//   $brand: #0366d6;                   SCSS variable (excalidraw-adjacent)
const DECL_CSS_VAR = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+?)\s*(?:;|$)/g;
const DECL_OBJ_HEX = /\b([A-Za-z][A-Za-z0-9_]*)\s*:\s*["'](#[0-9a-fA-F]{3,8})["']/g;
const DECL_SCSS_VAR = /(\$[A-Za-z0-9_-]+)\s*:\s*([^;]+?)\s*;/g;
// A theme's SEMANTIC layer usually references its primitives instead of
// restating hex: `text: colors.almostBlack` or `background: colors.white`
// (outline's buildLightTheme). Those semantic NAMES — text, background, link —
// are exactly the ones role-matching needs, and the literal-hex regex above
// never sees them. Captured as a reference (the trailing identifier) and
// resolved ONE hop against the same file's literal declarations.
const DECL_OBJ_REF = /\b([A-Za-z][A-Za-z0-9_]*)\s*:\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*[,;}]/g;

/** Content-based token-file detection (#272). Filename lists lose to the next
 *  boilerplate's convention — MakerKit ships the whole shadcn theme in
 *  `shadcn-ui.css`, which matched nothing in TOKEN_FILE and left one app's
 *  declared violet primary invisible while the tool named a 45-file side app's
 *  navy as the monorepo brand. A stylesheet DOMINATED by custom-property
 *  declarations is a token file whatever it is called. Floors are deliberate:
 *  >=10 declarations AND >=50% of meaningful lines, so a component stylesheet
 *  that happens to define three locals never flips (a flip silently moves its
 *  literals out of the drift count).  */
function isTokenContent(text, rel) {
  if (!/\.(css|scss)$/i.test(rel)) return false;
  let decls = 0, meaningful = 0;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t || t === "{" || t === "}" || t.startsWith("/*") || t.startsWith("*") || t.startsWith("//")) continue;
    meaningful++;
    if (/^--[A-Za-z0-9_-]+\s*:/.test(t)) decls++;
  }
  return decls >= 10 && decls / meaningful >= 0.5;
}

// Dark-mode blocks (#272). `.dark`, data-attribute variants, and
// prefers-color-scheme wrappers each start a dark context; declarations inside
// carry mode:"dark". Light and dark variants of one name are SEPARATE tokens,
// never overrides — first-wins flattening is how one app's dark-declared brand
// (#39ff14, declared dark) got shadowed by its light-mode emerald.
const DARK_OPENER = /(^|[\s,])(\.dark\b|\[data-(theme|mode)=["']?dark["']?\])[^{}]*\{|@media[^{]*prefers-color-scheme:\s*dark/;

// Test files never name a brand: their literals are fixtures and assertions,
// not shipped UI. The drift count keeps them (a test literal is still worth
// counting); the proposer weights by SHIPPED uses only, so a colour that
// appears solely in tests carries zero derivation weight — outline's
// status.success came from `#00ff00` in *.test.ts before this existed.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])__(tests|mocks)__([\\/]|$)/i;

/** Resolve a declared raw value to `#rrggbb`, or null when it is not a colour
 *  this scanner can settle (a `var()` alias, a gradient, a length). Handles
 *  hex (3/4/6/8-digit), `rgb()`/`rgba()`, `hsl()`/`hsla()` in comma or space
 *  syntax, and the shadcn convention of a BARE `H S% L%` triple. */
function resolveDeclaredColor(raw) {
  const v = raw.trim();
  const hexM = v.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hexM) {
    let h = hexM[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6) return null;
    return `#${h.toLowerCase()}`;
  }
  const toHex = (r, g, b) =>
    "#" + [r, g, b].map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0")).join("");
  const rgbM = v.match(/^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)/i);
  if (rgbM) {
    const chan = (s) => (s.endsWith("%") ? (parseFloat(s) / 100) * 255 : parseFloat(s));
    return toHex(chan(rgbM[1]), chan(rgbM[2]), chan(rgbM[3]));
  }
  // oklch(L C H) — the shadcn/Tailwind-v4 default since 2025, live in this
  // very harness's repos (#272). L accepts % or 0..1; hue in degrees; alpha
  // ignored. OKLab -> LMS -> linear sRGB (Björn Ottosson's published
  // matrices), gamma-encoded and clamped to sRGB gamut.
  const okM = v.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)$/i);
  if (okM) {
    const L = parseFloat(okM[1]) / (okM[2] === "%" ? 100 : 1);
    const C = parseFloat(okM[3]);
    const H = (parseFloat(okM[4]) * Math.PI) / 180;
    const a = C * Math.cos(H), bb = C * Math.sin(H);
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
    const s_ = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
    const lr = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
    const lg = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
    const lb = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
    const gam = (c) => {
      const x = Math.max(0, Math.min(1, c));
      return (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255;
    };
    return toHex(gam(lr), gam(lg), gam(lb));
  }
  const hslBody =
    v.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/i) ||
    v.match(/^([\d.]+)(?:deg)?\s+([\d.]+)%\s+([\d.]+)%$/);
  if (hslBody) {
    const h = parseFloat(hslBody[1]) / 360, s = parseFloat(hslBody[2]) / 100, l = parseFloat(hslBody[3]) / 100;
    if (s === 0) return toHex(l * 255, l * 255, l * 255);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return toHex(f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255);
  }
  return null;
}
// Injected at runtime by the framework and never present in source. Reporting
// these would drown the real signal.
const VAR_FRAMEWORK = /^--(tw|radix|shiki|vaul|sonner|cmdk|embla|reach|chakra|mantine|next)-/;
// Tailwind v4 generates `--color-<hue>-<step>` for its whole default palette from
// `@theme`, so those resolve at build time with no definition in source.
const VAR_TW_THEME = new RegExp(`^--color-${TW_HUE.slice(3, -1)}-(50|[1-9]00|950)$`);
// `var(--color-${key})` is a legitimate dynamic lookup (shadcn's Chart does this
// from chartConfig). The regex can only capture the static prefix, so a name
// ending in `-` is a truncated construction, never a real reference.
const isConstructedVar = (name) => name.endsWith("-");

// The id list is bounded to HORIZONTAL whitespace. Allowing \s here let a
// file-level directive on its own line swallow the next line's code as its id
// list ("const c" parsed as two detector ids), so it suppressed nothing while
// looking like it worked — a silent no-op, the worst kind of bug in an ignore
// mechanism. Newline ends the list.
const IDS = "(?:[ \\t]+([A-Za-z][\\w,]*(?:[ \\t]+[A-Za-z][\\w,]*)*))?";
const IGNORE_LINE = new RegExp(`design-drift-ignore(?!-)${IDS}`);
const IGNORE_NEXT = new RegExp(`design-drift-ignore-next-line${IDS}`);
const IGNORE_FILE = new RegExp(`design-drift-ignore-file${IDS}`);

const parseIds = (raw) =>
  raw ? raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : null; // null = all

/** Blank out comment bodies before matching.
 *
 *  Two reasons. Correctness: a value in a comment is not shipped, so it is not
 *  drift. And precision: `#162` in "see PR #162" is three valid hex digits, and
 *  the first self-scan of this very repo reported it as a colour.
 *
 *  `//` only opens a comment at line start or after whitespace, which is what
 *  keeps `https://…` from being treated as one. */
function stripComments(line) {
  return line
    .replace(/<!--.*?(-->|$)/g, " ")
    .replace(/\/\*.*?(\*\/|$)/g, " ")
    .replace(/(^|\s)\/\/.*$/, "$1")
    .replace(/^\s*\*.*$/, " "); // jsdoc continuation line
}

const suppressed = (ids, id) => ids !== undefined && (ids === null || ids.includes(id));

function scanFile(abs) {
  const rel = relative(root, abs).split(sep).join("/");
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");

  const fileIgnore = (() => {
    const m = text.match(IGNORE_FILE);
    return m ? parseIds(m[1]) : undefined;
  })();

  const hits = { color: [], arbitrary: [], palette: [], varRefs: [], varDefs: [], declared: [], fontSizes: [], motion: [], touch: [] };
  const isTokenFile = TOKEN_FILE.test(rel) || isTokenContent(text, rel);
  const isTestFile = TEST_FILE.test(rel);
  // Dark-block context for declared tokens: track brace depth; a dark opener
  // marks the depth it opened at, and everything until that depth closes is
  // mode:"dark". Theme files are structurally simple CSS, which is what makes
  // line-based brace counting sufficient here.
  let braceDepth = 0, darkAt = -1;
  // Carry-over buffers for value lists and JSX tags that wrap onto following
  // lines — line-at-a-time scanning otherwise reads prettier's default
  // formatting as "no motion, no buttons". Both are hard-capped at 8 lines:
  // an unterminated carry is dropped without a claim, never guessed at.
  let motionCarry = null;
  let touchCarry = null;

  let nextIgnore;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineIgnore = (() => {
      // IGNORE_NEXT is a superstring of IGNORE_LINE — test the specific one first.
      if (IGNORE_NEXT.test(line)) return undefined;
      const m = line.match(IGNORE_LINE);
      return m ? parseIds(m[1]) : undefined;
    })();
    const active = nextIgnore;
    nextIgnore = undefined;
    const nm = line.match(IGNORE_NEXT);
    if (nm) nextIgnore = parseIds(nm[1]);

    const off = (id) =>
      suppressed(fileIgnore, id) || suppressed(lineIgnore, id) || suppressed(active, id);

    // Directives are read from the raw line above (they live in comments);
    // detectors run against code only.
    const code = stripComments(line);

    for (const m of code.matchAll(VAR_DEF)) hits.varDefs.push(m[1]);
    for (const m of code.matchAll(VAR_DEF_NEXT_FONT)) hits.varDefs.push(m[1]);
    if (!off("orphan")) {
      for (const m of code.matchAll(VAR_REF)) {
        hits.varRefs.push({ line: i + 1, name: m[1], text: line.trim().slice(0, 120) });
      }
    }

    if (!off("palette")) {
      for (const m of code.matchAll(PALETTE)) {
        hits.palette.push({
          line: i + 1,
          value: `${m[1]}-${m[2]}-${m[3]}`,
          hue: m[2],
          text: line.trim().slice(0, 120),
        });
      }
    }

    // Type-scale samples (#24): Tailwind size classes, arbitrary text-[N],
    // and plain font-size declarations, all normalized to px. clamp()/var()
    // never match (the number must follow immediately), so fluid scales are
    // simply not sampled rather than mis-read. off() so a bench file marked
    // design-drift-ignore-file stops feeding the census — its sizes are
    // exploration, not shipped hierarchy.
    if (!isTokenFile && !off("typescale")) {
      for (const m of code.matchAll(TW_TEXT_SIZE)) hits.fontSizes.push(TW_TEXT_PX[m[1]]);
      for (const m of code.matchAll(/\btext-\[([\d.]+)(px|rem)\]/g)) {
        hits.fontSizes.push(m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]));
      }
      for (const m of code.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)) {
        hits.fontSizes.push(m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]));
      }
    }

    // Motion durations (#24): the census of every duration that ships.
    // Sources, in order, each blanking what it consumed so nothing counts
    // twice: longhand *-duration props (every <time> is a duration), React
    // inline-style camelCase longhand with real units in a quoted string,
    // shorthand transition:/animation: (first <time> per comma segment — the
    // CSS grammar makes the second one a delay), duration-ish custom-property
    // definitions, then Tailwind duration utilities on whatever text remains.
    // Token files are IN scope (the issue names declared --transition tokens
    // as a source). A shorthand whose value list wraps onto following lines
    // (transition:\n  color .2s,\n  ...) is carried to its ;/} terminator and
    // parsed once, attributed to the opener line — the fleet reproduced
    // wrapped multi-property transitions reading as zero motion. Framer-
    // motion's unitless `duration: 0.3` stays deliberately unsampled — JS
    // animation config, not CSS — rather than guessed at.
    if (!off("motion")) {
      const extractMotion = (text, lineNo, srcLine) => {
        let rest = text;
        const pushMs = (num, unit) =>
          hits.motion.push({
            line: lineNo,
            ms: Math.round(parseFloat(num) * (unit === "s" ? 1000 : 1)),
            text: srcLine.trim().slice(0, 120),
          });
        const eat = (re, take) => {
          rest = rest.replace(re, (...m) => {
            take(m);
            return " ".repeat(m[0].length);
          });
        };
        eat(/\b(?:transition|animation)-duration\s*:\s*([^;{}"'\n]*)/gi, (m) => {
          for (const t of m[1].matchAll(TIME_ALL) || []) pushMs(t[1], t[2]);
        });
        eat(/\b(?:transition|animation)Duration\s*:\s*["']([^"']*)["']/g, (m) => {
          for (const t of m[1].matchAll(TIME_ALL) || []) pushMs(t[1], t[2]);
        });
        eat(/\b(?:transition|animation)\s*:\s*([^;{}"'\n]*)/gi, (m) => {
          for (const seg of m[1].split(",")) {
            const t = seg.match(TIME_ONE);
            if (t) pushMs(t[1], t[2]);
          }
        });
        eat(/--[\w-]*(?:duration|transition|motion)[\w-]*\s*:\s*([\d.]+)(ms|s)\b/gi, (m) => pushMs(m[1], m[2]));
        for (const t of rest.matchAll(/(?<!-)\bduration-(\d+)\b/g)) {
          hits.motion.push({ line: lineNo, ms: +t[1], text: srcLine.trim().slice(0, 120) });
        }
        for (const t of rest.matchAll(/(?<!-)\bduration-\[([\d.]+)(ms|s)\]/g)) pushMs(t[1], t[2]);
      };
      if (motionCarry) {
        motionCarry.text += " " + code;
        motionCarry.budget -= 1;
        if (/[;}]/.test(code)) {
          extractMotion(motionCarry.text, motionCarry.line, motionCarry.src);
          motionCarry = null;
        } else if (motionCarry.budget <= 0) motionCarry = null;
      } else if (/\b(?:transition|animation)(?:-duration)?\s*:[^;{}]*$/i.test(code)) {
        motionCarry = { text: code, line: i + 1, src: line, budget: 8 };
      } else {
        extractMotion(code, i + 1, line);
      }
    }


    // Touch targets (#24): explicit heights on interactive elements, same-tag
    // window. The window runs from the opener to its real `>` — an arrow
    // function's `=>` never terminates it — so an icon's h-4 inside a button
    // can never masquerade as the button's height. A tag whose attributes
    // wrap onto following lines (prettier's default past a couple of props)
    // is carried to its `>` and measured once, attributed to the opener line.
    // Test files excluded: a fixture button is not a shipped target.
    //
    // Effective height follows CSS resolution: min-height beats max-height
    // beats height. A max-h cap SMALLER than the declared height binds the
    // box, so it must WIN the arithmetic, not lose it (the fleet reproduced
    // h-20 max-h-6 reading as 80px "safe"; the real box is 24px). When only
    // an unbounded side is visible — a floor under 44, a cap at or over 44 —
    // the real height is unknowable and NO claim is recorded. A bare
    // comparison `>` inside a prop expression still truncates the window;
    // that residual only drops sources and is accepted as rare. Inline <a>
    // stays out of scope: WCAG 2.5.8 exempts targets in text flow.
    if (!isTestFile && !off("touch")) {
      const tagEnd = (str, from) => {
        let gt = str.indexOf(">", from);
        while (gt > 0 && str[gt - 1] === "=") gt = str.indexOf(">", gt + 1);
        return gt;
      };
      const measureTag = (win, lineNo, srcLine) => {
        const hard = [], floors = [], caps = [];
        const put = (kind, v) => (kind === "min" ? floors : kind === "max" ? caps : hard).push(v);
        for (const m of win.matchAll(/\b(min-h|max-h|h|size)-(\d+(?:\.5)?)\b/g)) {
          put(m[1] === "min-h" ? "min" : m[1] === "max-h" ? "max" : "h", parseFloat(m[2]) * 4);
        }
        for (const m of win.matchAll(/\b(min-h|max-h|h|size)-\[([\d.]+)(px|rem)\]/g)) {
          put(m[1] === "min-h" ? "min" : m[1] === "max-h" ? "max" : "h", m[3] === "rem" ? parseFloat(m[2]) * 16 : parseFloat(m[2]));
        }
        for (const m of win.matchAll(/(?<![\w-])(min-|max-)?height:\s*["']?([\d.]+)(?:px)?["']?(?![\w.])/g)) {
          put(m[1] === "min-" ? "min" : m[1] === "max-" ? "max" : "h", parseFloat(m[2]));
        }
        for (const m of win.matchAll(/\b(min|max)Height:\s*["']?([\d.]+)(?:px)?["']?(?![\w.])/g)) {
          put(m[1], parseFloat(m[2]));
        }
        let eff;
        if (hard.length) {
          eff = Math.max(...hard);
          if (caps.length) eff = Math.min(eff, Math.min(...caps));
          if (floors.length) eff = Math.max(eff, Math.max(...floors));
        } else if (floors.length) {
          const fl = Math.max(...floors);
          if (fl < 44) return; // floor only bounds from below: height unknown
          eff = fl;
        } else if (caps.length) {
          const cap = Math.min(...caps);
          if (cap >= 44) return; // cap only bounds from above: height unknown
          eff = cap;
        } else return;
        hits.touch.push({ line: lineNo, px: eff, text: srcLine.trim().slice(0, 120) });
      };
      if (touchCarry) {
        touchCarry.text += " " + code;
        touchCarry.budget -= 1;
        const gt = tagEnd(touchCarry.text, touchCarry.at);
        if (gt !== -1) {
          measureTag(touchCarry.text.slice(touchCarry.at, gt), touchCarry.line, touchCarry.src);
          touchCarry = null;
        } else if (touchCarry.budget <= 0) touchCarry = null;
      }
      if (!touchCarry) {
        const starts = new Set();
        for (const m of code.matchAll(/<button\b/gi)) starts.add(m.index);
        for (const m of code.matchAll(/role=["']button["']/g)) {
          // backtrack to the nearest OPENING tag — `</div` must never anchor
          // a window (the fleet's hijack repro)
          let lt = code.lastIndexOf("<", m.index);
          while (lt !== -1 && !/[A-Za-z]/.test(code[lt + 1] || "")) {
            lt = lt > 0 ? code.lastIndexOf("<", lt - 1) : -1;
          }
          if (lt !== -1) starts.add(lt);
        }
        for (const at of [...starts].sort((a, b) => a - b)) {
          const gt = tagEnd(code, at);
          if (gt !== -1) measureTag(code.slice(at, gt), i + 1, line);
          else touchCarry = { text: code, at, line: i + 1, src: line, budget: 8 };
        }
      }
    }    if (!isTokenFile && !off("color") && !TOKEN_CTX.test(code)) {
      for (const m of code.matchAll(HEX)) {
        if (isNumericReference(m[1])) continue;
        hits.color.push({
          line: i + 1,
          value: `#${m[1].toLowerCase()}`,
          kind: "hex",
          // classify against the comment-stripped text the match indexes into
          ctx: classifyContext(code, m.index),
          test: isTestFile,
          text: line.trim().slice(0, 120),
        });
      }
      for (const m of code.matchAll(FUNC_COLOR)) {
        // Notation identity (#12): rgba(57,255,20,.15) IS #39ff14 — resolve
        // the full call so notation variants join one identity and token
        // matching can see them. FUNC_COLOR stays the occurrence driver
        // (identical hit sites by construction); resolution is best-effort
        // on the flat-args call extracted from the tail, and anything with
        // nested parens or junk keeps the legacy "rgba()" bucket.
        let value = m[1].toLowerCase() + "()";
        const call = code.slice(m.index).match(/^(rgba?|hsla?)\(([^()]*)\)/i);
        if (call) {
          const hex = resolveDeclaredColor(`${call[1]}(${call[2]})`);
          if (hex) {
            const args = call[2].split(/[\s,/]+/).filter(Boolean);
            let alpha = null;
            if (args.length > 3) {
              const a = args[3].endsWith("%") ? parseFloat(args[3]) / 100 : parseFloat(args[3]);
              if (Number.isFinite(a) && a < 1) alpha = +a.toFixed(2);
            }
            value = alpha !== null ? `${hex}@${alpha}` : hex;
          }
        }
        hits.color.push({
          line: i + 1,
          value,
          kind: "func",
          ctx: classifyContext(code, m.index),
          test: isTestFile,
          text: line.trim().slice(0, 120),
        });
      }
    }
    if (isTokenFile) {
      // Declared-token extraction (#264): the drift detectors above deliberately
      // skip this file; the declarations feed the proposer instead. Unresolvable
      // values (var() aliases, gradients, lengths) are recorded with hex: null so
      // the count of declarations stays honest, and skipped downstream.
      if (darkAt === -1 && DARK_OPENER.test(code)) darkAt = braceDepth;
      const mode = darkAt === -1 ? "light" : "dark";
      for (const m of code.matchAll(DECL_CSS_VAR)) {
        // A pure `var(--x)` value is an ALIAS — the Tailwind v4 @theme bridge
        // pattern (`--color-success: var(--success)`) declares ~20 of these in
        // every modern shadcn app. Captured as a reference and resolved one
        // hop in analyse(), same-file only (#276 — before this, aliases sat
        // at hex null, and an older cross-file merge once backfilled one with
        // ANOTHER app's value, poisoning a design decision).
        const aliasM = m[2].trim().match(/^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/);
        if (aliasM) {
          hits.declared.push({ line: i + 1, name: m[1], raw: m[2].trim(), cssRef: aliasM[1], hex: null, mode });
        } else {
          hits.declared.push({ line: i + 1, name: m[1], raw: m[2].trim(), hex: resolveDeclaredColor(m[2]), mode });
        }
      }
      for (const m of code.matchAll(DECL_OBJ_HEX)) {
        hits.declared.push({ line: i + 1, name: m[1], raw: m[2], hex: resolveDeclaredColor(m[2]), mode });
      }
      for (const m of code.matchAll(DECL_SCSS_VAR)) {
        hits.declared.push({ line: i + 1, name: m[1], raw: m[2].trim(), hex: resolveDeclaredColor(m[2]), mode });
      }
      for (const m of code.matchAll(DECL_OBJ_REF)) {
        // hex: null here; analyse() resolves the reference one hop against this
        // same file's literal declarations after the whole file is collected.
        hits.declared.push({ line: i + 1, name: m[1], raw: m[2], ref: m[2], hex: null, mode });
      }
      braceDepth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
      if (darkAt !== -1 && braceDepth <= darkAt) darkAt = -1;
    }
    if (!off("arbitrary")) {
      for (const m of code.matchAll(ARBITRARY)) {
        hits.arbitrary.push({
          line: i + 1,
          prop: m[1],
          num: Number(m[2]),
          unit: m[3],
          value: `${m[1]}-[${m[2]}${m[3]}]`,
          text: line.trim().slice(0, 120),
        });
      }
    }
  }
  return { rel, vendor: isVendor(rel), hits };
}

// ------------------------------------------------------------------ analysis

// Decimal places to keep per unit. Rounding every unit to an integer (the first
// version did) silently destroys fractional scales: 0.14em..0.35em all became
// "0", and a rem type scale collapsed to a list of duplicate 1s and 2s. The
// synthetic tests never caught it because they only used px.
const PRECISION = { px: 0, rem: 3, em: 3, "%": 1 };
const roundTo = (n, digits) => Number(n.toFixed(digits));

/** Fewest scale steps covering `values` such that every value is within
 *  `tolerance` of a step. Greedy over sorted values — for a one-dimensional
 *  cover this is optimal and it keeps the output stable and explainable. */
function coveringScale(values, tolerance, unit) {
  const digits = PRECISION[unit] ?? 3;
  const sorted = [...values].sort((a, b) => a - b);
  const steps = [];
  let i = 0;
  while (i < sorted.length) {
    const anchor = sorted[i];
    let j = i;
    while (j < sorted.length && sorted[j] - anchor <= tolerance * 2) j++;
    const bucket = sorted.slice(i, j);
    steps.push(roundTo(bucket.reduce((a, b) => a + b, 0) / bucket.length, digits));
    i = j;
  }
  // Rounding can merge two adjacent steps into the same number; a scale with a
  // repeated step is not a scale.
  return [...new Set(steps)];
}

function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((ch) => ch + ch).join("");
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Straight RGB Euclidean distance. Not perceptually uniform (OKLab would be),
 *  but for "are these two greys the same token?" it is more than good enough and
 *  keeps this file dependency-free. */
function colorDistance(a, b) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function analyse(files) {
  const empty = () => ({ color: [], arbitrary: [], palette: [], varRefs: [], declared: [] });
  const scope = { first: empty(), vendor: empty() };
  for (const f of files) {
    if (!f) continue;
    const bucket = f.vendor ? scope.vendor : scope.first;
    for (const kind of ["color", "arbitrary", "palette"]) {
      for (const h of f.hits[kind]) bucket[kind].push({ ...h, file: f.rel });
    }
    for (const h of f.hits.varRefs) bucket.varRefs.push({ ...h, file: f.rel });
    for (const h of f.hits.declared || []) bucket.declared.push({ ...h, file: f.rel });
  }

  // One rel-path entry per hit, kept out of the JSON report: this backs the
  // region budgets (`apps/web:color=120`), which need "how many hits under
  // this directory" at enforcement and tighten time. Same semantics as the
  // global occurrence count — test files included.
  // Mirrors the enabled() gating on the report sections: a region budget on a
  // detector that did not run must error exactly like a global one.
  HIT_FILES = {};
  for (const id of REGION_DETECTORS) {
    if (enabled(id)) HIT_FILES[id] = scope.first[id].map((h) => h.file);
  }

  // Type-scale contrast (#24, the taste_audit measure): largest-heading ÷
  // body size. Under 2.0 the hierarchy reads timid. INFO only — a
  // measurement of what ships, never a budget.
  const fontCounts = new Map();
  for (const f of files) {
    if (!f) continue;
    for (const px of f.hits.fontSizes || []) fontCounts.set(px, (fontCounts.get(px) || 0) + 1);
  }
  const fontTotal = [...fontCounts.values()].reduce((a, b) => a + b, 0);
  let typescale = null;
  if (fontTotal >= 20 && fontCounts.size >= 4) {
    const bodyCandidates = [...fontCounts.entries()].filter(([px]) => px >= 12 && px <= 20);
    const body = bodyCandidates.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const largest = Math.max(...[...fontCounts.entries()].filter(([, n]) => n >= 2).map(([px]) => px));
    if (body && Number.isFinite(largest)) {
      const ratio = +(largest / body).toFixed(2);
      typescale = {
        body,
        largest,
        ratio,
        samples: fontTotal,
        verdict: ratio < 2 ? "timid — the largest heading is under 2x body; the hierarchy whispers" : "healthy contrast",
        top: [...fontCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([px, n]) => ({ px, count: n })),
      };
    }
  }

  // Motion durations (#24): the shipped census against the 150-400ms
  // interaction band the issue names. INFO only, floor of 5 samples — below
  // that a band claim is noise. Vendor files excluded: their motion is not
  // yours to retime.
  const motionHits = [];
  for (const f of files) {
    if (!f || f.vendor) continue;
    for (const h of f.hits.motion || []) motionHits.push({ ...h, file: f.rel });
  }
  let motion = null;
  if (motionHits.length >= 5) {
    const counts = new Map();
    for (const h of motionHits) counts.set(h.ms, (counts.get(h.ms) || 0) + 1);
    motion = {
      samples: motionHits.length,
      distinct: counts.size,
      inBand: motionHits.filter((h) => h.ms >= 150 && h.ms <= 400).length,
      under: motionHits.filter((h) => h.ms > 0 && h.ms < 150).length,
      over: motionHits.filter((h) => h.ms > 400).length,
      disabled: motionHits.filter((h) => h.ms === 0).length,
      top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ms, n]) => ({ ms, count: n })),
      overExamples: motionHits.filter((h) => h.ms > 400).slice(0, 5).map((h) => ({ ms: h.ms, at: `${h.file}:${h.line}` })),
    };
  }

  // Touch targets (#24): 44px Apple HIG, 24px the WCAG 2.5.8 hard floor.
  // Renders when there is something to point at, or enough clean samples to
  // say so; one or two all-fine samples say nothing. Vendor excluded.
  const touchHits = [];
  for (const f of files) {
    if (!f || f.vendor) continue;
    for (const h of f.hits.touch || []) touchHits.push({ ...h, file: f.rel });
  }
  let touch = null;
  {
    const under44 = touchHits.filter((h) => h.px < 44);
    if (under44.length || touchHits.length >= 3) {
      touch = {
        samples: touchHits.length,
        under44: under44.length,
        under24: touchHits.filter((h) => h.px < 24).length,
        min: Math.min(...touchHits.map((h) => h.px)),
        examples: under44.slice(0, 5).map((h) => ({ px: h.px, at: `${h.file}:${h.line}`, text: h.text })),
      };
    }
  }

  const report = { root, scanned: files.filter(Boolean).length, findings: {} };
  if (typescale) report.findings.typescale = typescale;
  if (motion) report.findings.motion = motion;
  if (touch) report.findings.touch = touch;

  if (enabled("color")) {
    const hits = scope.first.color;
    const distinct = new Map();
    for (const h of hits) {
      // Every value goes in, hex and `rgba()`/`hsl()` alike, because this map
      // backs the human report's counts as well as the inventory. Only hex is
      // CLUSTERABLE, but that filtering belongs downstream, where propose.mjs
      // drops anything hexToRgb() cannot parse — doing it here would understate
      // the reported totals. (Until 2026-08-07 this read as an if/else with two
      // identical branches under a comment claiming non-hex was excluded, which
      // it never was.)
      //
      // `shipped` excludes test-file occurrences. The drift COUNT keeps them —
      // a fixture literal is still worth knowing about — but the proposer
      // weights by shipped uses only, so a colour living solely in tests can
      // never name a brand (#264).
      const e = distinct.get(h.value) || { count: 0, shipped: 0 };
      e.count += 1;
      if (!h.test) e.shipped += 1;
      distinct.set(h.value, e);
    }
    const ranked = [...distinct.entries()].sort((a, b) => b[1].count - a[1].count);
    // Context-class tallies (#10): how much of the drift is one-substitution
    // work (utility, css-value, style-attr) vs consumer-dependent (prop) vs
    // var-fatal (svg-attr, string). Pre-sorts a migration before anyone greps.
    const contexts = {};
    for (const h of hits) contexts[h.ctx] = (contexts[h.ctx] || 0) + 1;
    // Colour-dense files (#16): one file carrying most of the drift with
    // hundreds of distinct values is almost never drift — it is a palette,
    // theme registry, or data file (a real app hid 565 of 567 'drift' hits in
    // its theme-exploration bench, and the residual clustering minted four
    // phantom accents from it). The scanner cannot decide, but it can point.
    const perFile = new Map();
    for (const h of hits) {
      const e = perFile.get(h.file) || { occurrences: 0, values: new Set() };
      e.occurrences += 1;
      e.values.add(h.value);
      perFile.set(h.file, e);
    }
    // distinct > 100 already implies the file has 100+ hits, so no separate
    // total-hits floor is needed (a floor here read as if it did work).
    // Stylesheets are exempt from BOTH clauses: in a plain-CSS app the one
    // stylesheet holds ~all colour BY CONSTRUCTION and its literals are real
    // drift, not a palette (a real scan nearly mislabelled exactly that), and
    // a genuinely token-declaring stylesheet is already caught upstream by
    // token-file detection. The exemption covers stylesheet-as-code too:
    // vanilla-extract .css.ts and styled-components *.styles.ts are styling
    // surfaces, not data. What remains — a config module or JSON holding most
    // of the colour — is the palette/bench signal, at >100 distinct on
    // ordinary share or >=30 distinct when the file is share-dominant.
    const STYLESHEET = /(\.(css|scss|sass|less|styl)(\.(ts|js))?|\.styles\.[jt]sx?)$/i;
    const denseFiles = [...perFile.entries()]
      .filter(
        ([file, e]) =>
          !STYLESHEET.test(file) &&
          ((e.occurrences / hits.length > 0.5 && e.values.size > 100) ||
            (e.occurrences / hits.length >= 0.9 && e.values.size >= 30)),
      )
      .map(([file, e]) => ({ file, occurrences: e.occurrences, distinct: e.values.size }));
    report.findings.color = {
      occurrences: hits.length,
      files: new Set(hits.map((h) => h.file)).size,
      distinct: distinct.size,
      vendorOccurrences: scope.vendor.color.length,
      contexts,
      ...(denseFiles.length ? { denseFiles } : {}),
      top: ranked.slice(0, TOP).map(([value, e]) => ({ value, count: e.count })),
      examples: hits.slice(0, 5).map((h) => ({ at: `${h.file}:${h.line}`, text: h.text })),
      ...(FULL
        ? {
            all: ranked.map(([value, e]) => ({ value, count: e.count, shipped: e.shipped })),
            // FULL only: the per-hit migration plan — every site with its
            // context class, ready to sort by file or by class.
            sites: hits.map((h) => ({ file: h.file, line: h.line, value: h.value, ctx: h.ctx, test: h.test })),
          }
        : {}),
    };
  }

  if (FULL) {
    // Declared design tokens from first-party token/theme files (#264): the
    // proposer's primary evidence tier. First declaration of a name wins (a
    // `.dark` block re-declaring `--background` is an override, recorded as a
    // count, not modeled); refs = how many var() call sites reach the name,
    // which is the closest thing a declaration has to a use count.
    const refCounts = new Map();
    for (const r of scope.first.varRefs) refCounts.set(r.name, (refCounts.get(r.name) || 0) + 1);
    // One-hop reference resolution, same file only: `text: colors.almostBlack`
    // takes the hex that `almostBlack: "#111319"` declared earlier in the same
    // file. One hop and one file on purpose — chasing imports would need a
    // module graph, and the semantic layer that matters for role names sits
    // beside its primitives in every theme file validation has met.
    const literalByFileAndName = new Map();
    for (const d of scope.first.declared) {
      if (d.hex && !d.ref && !d.cssRef) literalByFileAndName.set(`${d.file} ${d.mode || "light"} ${d.name}`, d.hex);
    }
    // One hop, SAME FILE only — cross-file resolution is the exact backfill
    // poisoning that #276 buries. CSS aliases are mode-aware: a .dark alias
    // prefers the .dark literal and falls back to :root (cascade reality);
    // JS references live in single-mode files and resolve as light.
    const resolveRef = (file, mode, refName) =>
      literalByFileAndName.get(`${file} ${mode} ${refName}`) ??
      literalByFileAndName.get(`${file} light ${refName}`) ??
      null;
    // Keyed by (file, mode, name): light and dark variants of one token are
    // SEPARATE entries (#272 — first-wins flattening shadowed one app's
    // dark-declared matrix brand behind its light emerald), and so are two
    // APPS' same-named tokens — a workspace legitimately declares ten
    // different `--primary`s, and collapsing them cross-file is the blending
    // bug at the token level (caught by the refusal test: only the first
    // app's theme survived, so a 2-app workspace looked single-themed).
    // Re-declaration within one file+mode is still an override count.
    const byName = new Map();
    for (const d of scope.first.declared) {
      const mode = d.mode || "light";
      const refName = d.ref || d.cssRef;
      const hex = refName ? resolveRef(d.file, mode, refName) : d.hex;
      const key = `${d.file} ${mode} ${d.name}`;
      const existing = byName.get(key);
      if (existing) {
        existing.overrides += 1;
        // A resolved entry beats an unresolved one for the same name — a
        // reference that resolves is better evidence than a first-seen alias
        // that didn't.
        if (!existing.hex && hex) {
          existing.hex = hex;
          existing.raw = refName ? `ref:${refName}` : d.raw;
        }
        continue;
      }
      byName.set(key, {
        name: d.name,
        mode,
        raw: refName ? `ref:${refName}` : d.raw,
        hex,
        file: d.file,
        line: d.line,
        refs: refCounts.get(d.name) || 0,
        overrides: 0,
      });
    }
    report.findings.declaredTokens = [...byName.values()].sort((a, b) => b.refs - a.refs || a.name.localeCompare(b.name));
  }

  {
    // Workspace detection (#272): a MANIFEST decides, never directory names —
    // a plain repo with an apps/ folder is not a workspace, and refusing to
    // propose there would be a false positive (the planted negative in the
    // work-spec). Units are top-level apps/* and packages/* dirs that carry a
    // package.json.
    const manifest =
      (existsSync(join(root, "pnpm-workspace.yaml")) && "pnpm-workspace.yaml") ||
      (existsSync(join(root, "turbo.json")) && "turbo.json") ||
      (existsSync(join(root, "lerna.json")) && "lerna.json") ||
      (existsSync(join(root, "package.json")) &&
        (() => {
          try {
            return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ? "package.json workspaces" : null;
          } catch {
            return null;
          }
        })()) ||
      null;
    const units = [];
    if (manifest) {
      for (const top of ["apps", "packages"]) {
        const dir = join(root, top);
        if (!existsSync(dir)) continue;
        try {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && existsSync(join(dir, e.name, "package.json"))) units.push(`${top}/${e.name}`);
          }
        } catch {}
      }
    }
    report.findings.workspace = { detected: Boolean(manifest && units.length), manifest, units };
    // Per-unit occurrence tallies, so introducing a region budget starts from
    // a measured number instead of a guess: copy the unit's count into
    // `--fail-on=<unit>:<detector>=<n>` (or add it with a generous ceiling and
    // let --tighten snap it to the actual).
    if (report.findings.workspace.detected) {
      report.findings.workspace.regions = Object.fromEntries(
        units.map((u) => [
          u,
          Object.fromEntries(
            Object.keys(HIT_FILES).map((id) => [id, HIT_FILES[id].filter((f) => f.startsWith(u + "/")).length]),
          ),
        ]),
      );
      // Brand tallies (#9): units with a design/brands.json get `unit@brand`
      // rows — the introduction numbers for @brand budget keys, file-shaped
      // surfaces included.
      for (const u of units) {
        const brands = loadBrands(join(root, u));
        if (!brands) continue;
        for (const [name, b] of Object.entries(brands)) {
          report.findings.workspace.regions[`${u}@${name}`] = Object.fromEntries(
            Object.keys(HIT_FILES).map((id) => [id, brandCount(id, b.surfaces, u)]),
          );
        }
      }
    }
  }

  if (enabled("arbitrary")) {
    const hits = scope.first.arbitrary;
    const distinct = new Map();
    // Keep the structured form (prop/num/unit) so propose can rebuild scales
    // without re-parsing the string.
    const byKey = new Map();
    for (const h of hits) {
      distinct.set(h.value, (distinct.get(h.value) || 0) + 1);
      const k = `${h.prop}|${h.unit}|${h.num}`;
      if (!byKey.has(k)) byKey.set(k, { prop: h.prop, unit: h.unit, num: h.num, count: 0 });
      byKey.get(k).count++;
    }
    const ranked = [...distinct.entries()].sort((a, b) => b[1] - a[1]);
    report.findings.arbitrary = {
      occurrences: hits.length,
      files: new Set(hits.map((h) => h.file)).size,
      distinct: distinct.size,
      vendorOccurrences: scope.vendor.arbitrary.length,
      top: ranked.slice(0, TOP).map(([value, count]) => ({ value, count })),
      examples: hits.slice(0, 5).map((h) => ({ at: `${h.file}:${h.line}`, text: h.text })),
      ...(FULL
        ? {
            all: ranked.map(([value, count]) => ({ value, count })),
            structured: [...byKey.values()].sort((a, b) => b.count - a.count),
          }
        : {}),
    };
  }

  if (enabled("palette")) {
    const hits = scope.first.palette;
    const distinct = new Map();
    const hues = new Map();
    for (const h of hits) {
      distinct.set(h.value, (distinct.get(h.value) || 0) + 1);
      hues.set(h.hue, (hues.get(h.hue) || 0) + 1);
    }
    const ranked = [...distinct.entries()].sort((a, b) => b[1] - a[1]);
    const rankedHues = [...hues.entries()].sort((a, b) => b[1] - a[1]);
    report.findings.palette = {
      occurrences: hits.length,
      files: new Set(hits.map((h) => h.file)).size,
      distinct: distinct.size,
      distinctHues: hues.size,
      vendorOccurrences: scope.vendor.palette.length,
      top: ranked.slice(0, TOP).map(([value, count]) => ({ value, count })),
      hues: rankedHues.slice(0, TOP).map(([hue, count]) => ({ hue, count })),
      examples: hits.slice(0, 5).map((h) => ({ at: `${h.file}:${h.line}`, text: h.text })),
      ...(FULL
        ? {
            all: ranked.map(([value, count]) => ({ value, count })),
            allHues: rankedHues.map(([hue, count]) => ({ hue, count })),
          }
        : {}),
    };
  }

  // The headline detector: which properties are reinventing a scale, and what
  // scale would replace them.
  if (enabled("scale")) {
    const byProp = new Map();
    for (const h of scope.first.arbitrary) {
      const key = `${h.prop}|${h.unit}`;
      if (!byProp.has(key)) byProp.set(key, []);
      byProp.get(key).push(h.num);
    }
    const clusters = [];
    for (const [key, nums] of byProp) {
      const [prop, unit] = key.split("|");
      const distinct = [...new Set(nums)];
      // Fewer than 4 variants is not a scale problem. The floor was 3 until
      // multi-repo validation (2026-08-07) produced a "scale" from three
      // single-use values in three unrelated contexts — a <kbd> hint, a blog
      // caption, and an @vercel/og title — averaging 10px and 12px into a
      // synthetic step. Three data points spanning three call sites is a
      // coincidence; four distinct values is the floor where repetition of
      // intent becomes more likely than accident.
      if (distinct.length < 4) continue;
      const tolerance = unit === "px" ? TOLERANCE_PX : 0.0625;
      const steps = coveringScale(distinct, tolerance, unit);
      const reduction = Math.round((1 - steps.length / distinct.length) * 100);
      // A weak collapse is noise, not a finding. 29 distinct widths from 3px to
      // 600px collapsing to 26 is legitimate layout variety, and reporting it
      // buries the real signal (8 tracking values collapsing to 2).
      if (reduction < MIN_REDUCTION) continue;
      clusters.push({
        prop,
        unit,
        occurrences: nums.length,
        distinctValues: distinct.sort((a, b) => a - b),
        proposedScale: steps,
        collapse: `${distinct.length} → ${steps.length}`,
        reduction,
      });
    }
    clusters.sort((a, b) => b.occurrences - a.occurrences);
    report.findings.scale = { clusters: clusters.slice(0, TOP * 2) };
  }

  if (enabled("orphan")) {
    // A definition ANYWHERE resolves a reference everywhere — CSS cascade does
    // not care which file it came from, and vendored code legitimately defines
    // variables the app consumes. So defs are global while refs stay
    // first-party (we only report drift we own).
    const defined = new Set();
    for (const f of files) {
      if (!f) continue;
      for (const name of f.hits.varDefs) defined.add(name);
    }
    const unresolved = new Map();
    for (const r of scope.first.varRefs) {
      if (
        defined.has(r.name) ||
        VAR_FRAMEWORK.test(r.name) ||
        VAR_TW_THEME.test(r.name) ||
        isConstructedVar(r.name)
      ) {
        continue;
      }
      if (!unresolved.has(r.name)) unresolved.set(r.name, { name: r.name, count: 0, at: [] });
      const e = unresolved.get(r.name);
      e.count++;
      if (e.at.length < 3) e.at.push(`${r.file}:${r.line}`);
    }
    report.findings.orphan = {
      definitions: defined.size,
      references: new Set(scope.first.varRefs.map((r) => r.name)).size,
      unresolved: unresolved.size,
      occurrences: [...unresolved.values()].reduce((n, e) => n + e.count, 0),
      top: [...unresolved.values()].sort((a, b) => b.count - a.count).slice(0, TOP),
    };
  }

  if (enabled("nearcolor")) {
    const distinct = new Map();
    for (const h of scope.first.color) {
      if (h.kind !== "hex") continue;
      distinct.set(h.value, (distinct.get(h.value) || 0) + 1);
    }
    const values = [...distinct.keys()].filter((v) => hexToRgb(v));
    const pairs = [];
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const d = colorDistance(values[i], values[j]);
        if (d > 0 && d <= 12) {
          pairs.push({
            a: values[i], aCount: distinct.get(values[i]),
            b: values[j], bCount: distinct.get(values[j]),
            distance: Math.round(d * 10) / 10,
          });
        }
      }
    }
    pairs.sort((x, y) => (y.aCount + y.bCount) - (x.aCount + x.bCount));
    report.findings.nearcolor = { pairs: pairs.slice(0, TOP * 2), distinctColors: values.length };
  }

  return report;
}

// -------------------------------------------------------------------- output

function render(r) {
  const out = [];
  out.push(bold(`design-drift  ${r.root}`));
  out.push(dim(`${r.scanned} source files scanned`));
  out.push("");

  const f = r.findings;

  if (f.color) {
    out.push(bold("colour literals") + dim("  (raw values outside token/theme files)"));
    if (!f.color.occurrences) out.push(dim("  none"));
    else {
      out.push(`  ${red(f.color.occurrences)} occurrences · ${f.color.files} files · ${yellow(f.color.distinct)} distinct values`);
      if (f.color.vendorOccurrences) out.push(dim(`  (+${f.color.vendorOccurrences} in vendored code — separate decision, not counted above)`));
      for (const t of f.color.top) out.push(`    ${String(t.count).padStart(5)}  ${t.value}`);
      for (const d of f.color.denseFiles || []) {
        out.push(
          yellow(`  ⚠ ${d.file} holds ${d.occurrences} of the ${f.color.occurrences} hits (${d.distinct} distinct)`) +
            dim(" — that is a palette/theme/data file, not drift: if its colours are content, mark it design-drift-ignore-file; if it declares your tokens, name it so the token-file detection matches"),
        );
      }
    }
    out.push("");
  }

  if (f.arbitrary) {
    out.push(bold("arbitrary Tailwind values") + dim("  (one-off values with no scale behind them)"));
    if (!f.arbitrary.occurrences) out.push(dim("  none"));
    else {
      out.push(`  ${red(f.arbitrary.occurrences)} occurrences · ${f.arbitrary.files} files · ${yellow(f.arbitrary.distinct)} distinct values`);
      if (f.arbitrary.vendorOccurrences) out.push(dim(`  (+${f.arbitrary.vendorOccurrences} in vendored code)`));
      for (const t of f.arbitrary.top) out.push(`    ${String(t.count).padStart(5)}  ${t.value}`);
    }
    out.push("");
  }

  if (f.palette) {
    out.push(bold("raw palette utilities") + dim("  (bg-gray-500 etc — bypass semantic tokens entirely)"));
    if (!f.palette.occurrences) out.push(dim("  none"));
    else {
      out.push(`  ${red(f.palette.occurrences)} occurrences · ${f.palette.files} files · ${yellow(f.palette.distinct)} distinct · ${f.palette.distinctHues} hues`);
      if (f.palette.vendorOccurrences) out.push(dim(`  (+${f.palette.vendorOccurrences} in vendored code)`));
      for (const t of f.palette.top) out.push(`    ${String(t.count).padStart(5)}  ${t.value}`);
      out.push(dim(`      hues in play: ${f.palette.hues.map((h) => `${h.hue}(${h.count})`).join(" ")}`));
    }
    out.push("");
  }

  if (f.scale) {
    out.push(bold("missing scales") + dim("  ← the actionable one: what to define, and what it collapses"));
    if (!f.scale.clusters.length) out.push(dim("  none — no property has enough spread to imply a scale"));
    for (const cl of f.scale.clusters) {
      out.push(`  ${cyan(cl.prop)} ${dim(`(${cl.unit})`)} — ${cl.occurrences} uses, ${cl.collapse} values (${cl.reduction}% fewer)`);
      out.push(dim(`      in use:   ${cl.distinctValues.join(", ")}`));
      out.push(`      ${bold("scale:")}    ${cl.proposedScale.join(", ")}`);
    }
    out.push("");
  }

  if (f.orphan) {
    out.push(bold("unresolved tokens") + dim("  (var(--x) with no --x: anywhere — typo, rename, or foreign paste)"));
    if (!f.orphan.unresolved) out.push(dim(`  none — all ${f.orphan.references} referenced variables resolve`));
    else {
      out.push(`  ${red(f.orphan.unresolved)} unresolved of ${f.orphan.references} referenced · ${f.orphan.occurrences} uses · ${f.orphan.definitions} definitions found`);
      for (const e of f.orphan.top) out.push(`    ${String(e.count).padStart(5)}  ${e.name}  ${dim(e.at[0])}`);
      out.push(dim("      a local `style={{'--x': …}}` definition counts — confirm before renaming"));
    }
    out.push("");
  }

  if (f.typescale) {
    const t = f.typescale;
    out.push(bold("type-scale contrast") + dim("  (largest heading ÷ body — under 2.0 reads timid)"));
    out.push(`  body ${t.body}px · largest ${t.largest}px · ratio ${yellow(t.ratio)} — ${t.verdict}`);
    out.push(dim(`    sizes in use: ${t.top.map((e) => `${e.px}px(${e.count})`).join(" ")} · ${t.samples} samples`));
    out.push("");
  }

  if (f.motion) {
    const m = f.motion;
    out.push(bold("motion durations") + dim("  (census vs the 150-400ms interaction band)"));
    out.push(
      `  ${m.samples} durations · ${m.distinct} distinct · ${m.inBand} in band · ${m.under} under 150ms · ${m.over ? yellow(m.over) : 0} over 400ms` +
        (m.disabled ? dim(` · ${m.disabled} disabled (0)`) : ""),
    );
    out.push(dim(`    in use: ${m.top.map((e) => `${e.ms}ms(${e.count})`).join(" ")}`));
    for (const e of m.overExamples) out.push(dim(`      ${e.ms}ms  ${e.at}`));
    out.push("");
  }

  if (f.touch) {
    const t = f.touch;
    out.push(bold("touch targets") + dim("  (explicit heights on interactive elements — 44px Apple HIG, 24px WCAG 2.5.8)"));
    if (!t.under44) out.push(dim(`  all ${t.samples} explicitly-sized interactive elements are 44px or taller`));
    else {
      out.push(`  ${t.samples} explicitly sized · ${yellow(t.under44)} under 44px · ${t.under24 ? red(t.under24) : 0} under 24px · smallest ${t.min}px`);
      for (const e of t.examples) out.push(dim(`      ${String(e.px).padStart(3)}px  ${e.at}`));
    }
    out.push("");
  }

  if (f.nearcolor) {
    out.push(bold("near-duplicate colours") + dim("  (close enough to be one token)"));
    if (!f.nearcolor.pairs.length) out.push(dim("  none"));
    for (const p of f.nearcolor.pairs) {
      out.push(`  ${p.a} ${dim(`(${p.aCount}×)`)} ≈ ${p.b} ${dim(`(${p.bCount}×)`)}  ${dim(`Δ${p.distance}`)}`);
    }
    out.push("");
  }

  // Per-unit tallies (#14): the numbers an operator copies when introducing a
  // region budget — previously JSON-only, which forced a --json detour.
  if (f.workspace?.regions && Object.keys(f.workspace.regions).length) {
    out.push(bold("workspace regions") + dim("  (per-unit counts — region-budget introduction numbers)"));
    for (const [unit, counts] of Object.entries(f.workspace.regions)) {
      const cells = Object.entries(counts)
        .map(([id, n]) => `${id} ${n}`)
        .join(" · ");
      out.push(`  ${cyan(unit)}  ${cells}`);
    }
    out.push("");
  }

  // Migration triage (#10): what kind of work the colour drift actually is.
  if (f.color?.contexts && f.color.occurrences) {
    const c = f.color.contexts;
    const order = ["utility", "css-value", "style-attr", "prop", "string", "svg-attr", "other"];
    const line = order.filter((k) => c[k]).map((k) => `${k} ${c[k]}`).join(" · ");
    out.push(dim(`colour contexts: ${line}`));
    const careful = (c["svg-attr"] || 0) + (c.string || 0) + (c.prop || 0) + (c.other || 0);
    if (careful) {
      out.push(
        dim(
          `  ⚠ ${careful} sites are NOT plain var() substitutions — svg attributes reject var();` +
            ` strings, props and unclassified sites depend on the consumer (canvas, concatenation)`,
        ),
      );
    }
    out.push("");
  }

  if (r.git) {
    out.push(
      dim(
        `measured ${r.root} @ ${r.git.sha}${r.git.dirty ? ` (+${r.git.dirty} uncommitted)` : ""}` +
          (r.git.inProgress ? "  ⚠ rebase/merge IN PROGRESS — is this the tree you mean?" : ""),
      ),
    );
  }
  out.push(dim("Every hit is a lead. Confirm at the file:line before changing anything."));
  return out.join("\n");
}

// ---------------------------------------------------------------------- main

const bad = [...only, ...skip].filter((id) => !DETECTORS.includes(id));
if (bad.length) {
  console.error(`design-drift: unknown detector(s): ${bad.join(", ")}\n  known: ${DETECTORS.join(", ")}`);
  process.exit(2);
}

let stat;
try {
  stat = statSync(root);
} catch {
  console.error(`design-drift: cannot read ${root}`);
  process.exit(2);
}
if (!stat.isDirectory()) {
  console.error(`design-drift: ${root} is not a directory`);
  process.exit(2);
}

// A measurement that names its input cannot be silently pointed at the wrong
// tree (#11): budgets were once tightened against a mid-rebase tree whose
// real edits sat in an autostash, and nothing in the output said so.
function gitState(dir) {
  const run = (...a) => {
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const sha = run("rev-parse", "--short", "HEAD");
  if (sha === null) return null;
  const dirty = (run("status", "--porcelain") || "").split("\n").filter(Boolean).length;
  const gitDir = run("rev-parse", "--git-dir");
  const inProgress =
    gitDir !== null &&
    ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"].some((f) =>
      existsSync(join(resolve(dir, gitDir), f)),
    );
  return { sha, dirty, inProgress };
}

const report = analyse(walk(root).map(scanFile));
report.totalOccurrences = ["color", "arbitrary", "palette"]
  .reduce((n, k) => n + (report.findings[k]?.occurrences || 0), 0);
const git = gitState(root);
if (git) report.git = git;
console.log(asJson ? JSON.stringify(report, null, 2) : render(report));

// --tighten=<file>: the one-way ratchet as a command. Reads the file's
// --fail-on=<spec> (global and region keys alike), lowers every budget to the
// measured actual, and REFUSES when any actual exceeds its budget: absorbing
// an increase is the anti-feature (the planted negative in the work-spec).
// Born of doing this by hand three times in one day of migrations. The one
// sanctioned raise is --bump, below (#2).
const tightenPath = (() => {
  const a = args.find((x) => x.startsWith("--tighten="));
  return a ? a.slice("--tighten=".length) : null;
})();
const bumpRaw = (() => {
  const a = args.find((x) => x.startsWith("--bump="));
  return a ? a.slice("--bump=".length) : null;
})();
if (tightenPath || bumpRaw !== null) {
  // The ratchet writes numbers into a reviewed file — it must say what tree
  // produced them, and a mid-operation tree is almost never the one you mean.
  // Provenance goes to STDOUT (a successful tighten stays stderr-silent, for
  // wrappers that treat any stderr as failure); the warning is stderr's job.
  if (report.git) {
    const g = report.git;
    console.log(
      `design-drift: measuring ${root} @ ${g.sha}${g.dirty ? ` (+${g.dirty} uncommitted)` : ""}`,
    );
    if (g.inProgress) {
      console.error(
        "design-drift: WARNING — a rebase/merge is IN PROGRESS in this tree; " +
          "actuals measured now may not include the changes you think are here.",
      );
    }
  }
  const measuredT = (id) =>
    id === "orphan" ? report.findings.orphan?.unresolved : report.findings[id]?.occurrences;
  // Region keys read through the same tally the gate enforces, so tighten can
  // never write a number the gate would disagree with.
  const actualFor = ({ key, region, id, brand }) => {
    const n = brand
      ? brandCount(id, brand.surfaces, brand.unit)
      : region === null
        ? measuredT(id)
        : regionCount(id, region);
    if (n === undefined) {
      console.error(`design-drift: budget names '${key}' but that detector did not run`);
      process.exit(2);
    }
    return n;
  };
  if (!tightenPath) {
    console.error("design-drift: --bump needs --tighten=<file> to name the budget file it edits");
    process.exit(2);
  }
  let content;
  try {
    content = readFileSync(tightenPath, "utf8");
  } catch {
    console.error(`design-drift: --tighten cannot read ${tightenPath}`);
    process.exit(2);
  }
  // Comment lines cannot hold the active budget: a staged/commented spec above
  // the real one must never be the one the tool edits (found by adversarial
  // review — the region grammar widened the match enough to catch prose).
  // Identical copies of the live spec (matrix jobs) all move together via
  // replaceAll; two DIFFERENT specs are ambiguous and refuse loudly rather
  // than silently maintaining whichever came first.
  const ENTRY = "(?:[A-Za-z0-9@_./-]+:)?[a-z]+=\\d+";
  const specRe = new RegExp(`--fail-on=(${ENTRY}(?:,${ENTRY})*)`, "g");
  const distinctSpecs = new Set();
  let specSites = 0;
  for (const line of content.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(specRe)) {
      distinctSpecs.add(m[1]);
      specSites += 1;
    }
  }
  if (distinctSpecs.size === 0) {
    console.error(`design-drift: --tighten found no per-detector --fail-on=<spec> in ${tightenPath}`);
    process.exit(2);
  }
  if (distinctSpecs.size > 1) {
    console.error(
      `design-drift: ${tightenPath} holds ${distinctSpecs.size} DIFFERENT --fail-on specs:\n` +
        [...distinctSpecs].map((s) => `    --fail-on=${s}`).join("\n") +
        "\n  tighten/bump maintain exactly one budget line — align the copies or split the file.",
    );
    process.exit(2);
  }
  const spec = [...distinctSpecs][0];
  const entries = [];
  for (const p of spec.split(",")) {
    const eq = p.lastIndexOf("=");
    const parsedKey = parseBudgetKey(p.slice(0, eq), "--tighten");
    const key = parsedKey.region === null ? parsedKey.id : `${parsedKey.region}:${parsedKey.id}`;
    if (entries.some((e) => e.key === key)) {
      console.error(`design-drift: duplicate budget key '${key}' in ${tightenPath} — one key, one ceiling`);
      process.exit(2);
    }
    entries.push({ key, ...parsedKey, budget: Number(p.slice(eq + 1)) });
  }
  const buildSpec = (next) => next.map((e) => `${e.key}=${e.budget}`).join(",");

  // --bump=<key>=<n> --reason="…": the ONE sanctioned way a budget goes up
  // (#2). Tighten refuses increases by design, so a raise needs its own verb —
  // distinct in the file's history, and unreviewable without a reason.
  if (bumpRaw !== null) {
    const reason = (() => {
      const a = args.find((x) => x.startsWith("--reason="));
      return a ? a.slice("--reason=".length).trim() : "";
    })();
    if (!reason) {
      console.error(
        "design-drift: --bump requires --reason=\"…\" — an unexplained budget\n" +
          "  increase is exactly the silent regression the ratchet exists to prevent.",
      );
      process.exit(2);
    }
    const eq = bumpRaw.lastIndexOf("=");
    if (eq === -1 || !/^\d+$/.test(bumpRaw.slice(eq + 1))) {
      console.error("design-drift: --bump expects <key>=<number>");
      process.exit(2);
    }
    const target = Number(bumpRaw.slice(eq + 1));
    const parsed = parseBudgetKey(bumpRaw.slice(0, eq), "--bump");
    const bumpKey = parsed.region === null ? parsed.id : `${parsed.region}:${parsed.id}`;
    const entry = entries.find((e) => e.key === bumpKey);
    if (!entry) {
      console.error(
        `design-drift: --bump key '${bumpKey}' is not in the file's --fail-on spec.\n` +
          "  New budget lines are added by hand (reviewed in the PR that adds them);\n" +
          "  bump only raises what already exists.",
      );
      process.exit(2);
    }
    if (target <= entry.budget) {
      console.error(
        `design-drift: --bump ${bumpKey} ${entry.budget} -> ${target} is not an increase — use --tighten to lower`,
      );
      process.exit(2);
    }
    const actual = actualFor({ key: bumpKey, ...parsed });
    if (target < actual) {
      console.error(
        `design-drift: --bump target ${target} is below the measured ${actual} — the gate would stay red.\n` +
          "  Bump to at least the actual, or fix the drift instead.",
      );
      process.exit(2);
    }
    const old = entry.budget;
    entry.budget = target;
    const newSpec = buildSpec(entries);
    let out = content.replaceAll(`--fail-on=${spec}`, `--fail-on=${newSpec}`);
    // The reason outlives the terminal: a dated comment lands directly above
    // the budget line, so `git blame` answers "why did this go up" forever.
    // If the budget sits inside a shell continuation (`node scan.mjs . \` +
    // args on following lines), the comment climbs above the whole command —
    // a comment inside a continuation chain would truncate the command.
    const stamp = new Date().toISOString().slice(0, 10);
    const lines = out.split("\n");
    const at = lines.findIndex((l) => !/^\s*#/.test(l) && l.includes(`--fail-on=${newSpec}`));
    if (at !== -1) {
      let insert = at;
      while (insert > 0 && /\\\s*$/.test(lines[insert - 1])) insert -= 1;
      const indent = (lines[insert].match(/^\s*/) || [""])[0];
      lines.splice(insert, 0, `${indent}# design-drift bump ${bumpKey} ${old} -> ${target} (${stamp}): ${reason}`);
      out = lines.join("\n");
    }
    writeFileSync(tightenPath, out);
    console.log(`design-drift: bumped ${bumpKey} ${old} -> ${target} in ${tightenPath}\n  reason: ${reason}`);
    process.exit(0);
  }

  const over = [];
  const next = entries.map((e) => {
    const actual = actualFor(e);
    if (actual > e.budget) over.push(`${e.key} ${actual} > ${e.budget}`);
    return { key: e.key, budget: Math.min(e.budget, actual) };
  });
  if (over.length) {
    console.error(
      `design-drift: --tighten refused — drift EXCEEDS budget (${over.join(", ")}).\n` +
        "  A tighten that absorbs an increase is a ratchet that turns backwards. Fix the drift first.\n" +
        "  Deliberate trade (new vendored surface)? That is --bump=<key>=<n> --reason=\"…\".",
    );
    process.exit(1);
  }
  const newSpec = buildSpec(next);
  if (newSpec === spec) {
    console.log(`design-drift: --tighten — already tight (${spec})`);
    process.exit(0);
  }
  writeFileSync(tightenPath, content.replaceAll(`--fail-on=${spec}`, `--fail-on=${newSpec}`));
  const sites = specSites > 1 ? ` (${specSites} sites)` : "";
  console.log(`design-drift: tightened ${tightenPath}${sites}\n  ${spec}\n  -> ${newSpec}`);
  process.exit(0);
}

if (FAIL_ON !== null) {
  // `orphan` counts unresolved names rather than occurrences; every other
  // detector counts hits. Both are "how much drift is there", so both can be
  // budgeted — just read the right field.
  const measured = (id) =>
    id === "orphan"
      ? report.findings.orphan?.unresolved
      : report.findings[id]?.occurrences;

  const over = [];
  if (FAIL_ON.total !== undefined) {
    if (report.totalOccurrences > FAIL_ON.total) {
      over.push(`total ${report.totalOccurrences} > ${FAIL_ON.total}`);
    }
  } else {
    for (const { key, region, id, brand, budget } of FAIL_ON.per) {
      const n = brand
        ? brandCount(id, brand.surfaces, brand.unit)
        : region === null
          ? measured(id)
          : regionCount(id, region);
      if (n === undefined) {
        console.error(`design-drift: budget names '${key}' but that detector did not run (--only/--skip?)`);
        process.exit(2);
      }
      if (n > budget) over.push(`${key} ${n} > ${budget}`);
    }
  }

  if (over.length) {
    console.error(
      `design-drift: budget exceeded — ${over.join(", ")}\n` +
        "  Drift went UP. Either fix the new hits, or if this is a deliberate\n" +
        "  trade, raise that budget in the same commit so the increase is reviewed.",
    );
    process.exit(1);
  }
}
