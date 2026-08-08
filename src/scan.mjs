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
    const { region, id } = parseBudgetKey(k, "--fail-on");
    const key = region === null ? id : `${region}:${id}`;
    // One key, one ceiling. v0.1.x silently kept the LAST duplicate; an
    // enforcement spec where two numbers claim the same key is a mistake
    // (merge leftovers, usually) and gets said out loud, not resolved quietly.
    if (per.some((e) => e.key === key)) {
      console.error(`design-drift: duplicate --fail-on key '${key}' — one key, one ceiling`);
      process.exit(2);
    }
    per.push({ key, region, id, budget: Number(v) });
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
const FUNC_COLOR = /\b(rgba?|hsla?)\(\s*[0-9.]/g;
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

  const hits = { color: [], arbitrary: [], palette: [], varRefs: [], varDefs: [], declared: [] };
  const isTokenFile = TOKEN_FILE.test(rel) || isTokenContent(text, rel);
  const isTestFile = TEST_FILE.test(rel);
  // Dark-block context for declared tokens: track brace depth; a dark opener
  // marks the depth it opened at, and everything until that depth closes is
  // mode:"dark". Theme files are structurally simple CSS, which is what makes
  // line-based brace counting sufficient here.
  let braceDepth = 0, darkAt = -1;

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

    if (!isTokenFile && !off("color") && !TOKEN_CTX.test(code)) {
      for (const m of code.matchAll(HEX)) {
        if (isNumericReference(m[1])) continue;
        hits.color.push({ line: i + 1, value: `#${m[1].toLowerCase()}`, kind: "hex", test: isTestFile, text: line.trim().slice(0, 120) });
      }
      for (const m of code.matchAll(FUNC_COLOR)) {
        hits.color.push({ line: i + 1, value: m[1].toLowerCase() + "()", kind: "func", test: isTestFile, text: line.trim().slice(0, 120) });
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

  const report = { root, scanned: files.filter(Boolean).length, findings: {} };

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
    report.findings.color = {
      occurrences: hits.length,
      files: new Set(hits.map((h) => h.file)).size,
      distinct: distinct.size,
      vendorOccurrences: scope.vendor.color.length,
      top: ranked.slice(0, TOP).map(([value, e]) => ({ value, count: e.count })),
      examples: hits.slice(0, 5).map((h) => ({ at: `${h.file}:${h.line}`, text: h.text })),
      ...(FULL ? { all: ranked.map(([value, e]) => ({ value, count: e.count, shipped: e.shipped })) } : {}),
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

  if (f.nearcolor) {
    out.push(bold("near-duplicate colours") + dim("  (close enough to be one token)"));
    if (!f.nearcolor.pairs.length) out.push(dim("  none"));
    for (const p of f.nearcolor.pairs) {
      out.push(`  ${p.a} ${dim(`(${p.aCount}×)`)} ≈ ${p.b} ${dim(`(${p.bCount}×)`)}  ${dim(`Δ${p.distance}`)}`);
    }
    out.push("");
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

const report = analyse(walk(root).map(scanFile));
report.totalOccurrences = ["color", "arbitrary", "palette"]
  .reduce((n, k) => n + (report.findings[k]?.occurrences || 0), 0);
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
  const measuredT = (id) =>
    id === "orphan" ? report.findings.orphan?.unresolved : report.findings[id]?.occurrences;
  // Region keys read through the same tally the gate enforces, so tighten can
  // never write a number the gate would disagree with.
  const actualFor = ({ key, region, id }) => {
    const n = region === null ? measuredT(id) : regionCount(id, region);
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
    for (const { key, region, id, budget } of FAIL_ON.per) {
      const n = region === null ? measured(id) : regionCount(id, region);
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
