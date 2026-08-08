import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const proposePath = join(dir, "propose.mjs");
const scanPath = join(dir, "scan.mjs");

function withTemp(run) {
  const root = mkdtempSync(join(tmpdir(), "dd-propose-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function propose(root, ...flags) {
  return spawnSync(process.execPath, [proposePath, root, ...flags], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

// A tiny but realistic fixture: enough distinct colours and type sizes for the
// proposer to have something to cluster, without needing a whole monorepo.
function seedFixture(root) {
  write(
    root,
    "src/a.tsx",
    [
      // neutrals
      `const canvas = "#f9f9f9";`,
      `const canvas2 = "#fafafa";`,
      `const canvas3 = "#ffffff";`,
      `const ink = "#111114";`,
      `const ink2 = "#0a0a0c";`,
      `const mute = "#6c7086";`,
      `const hair = "#e5e7eb";`,
      // brand + status
      `const brand = "#182c56";`,
      `const brand2 = "#1a1a2e";`,
      `const danger = "#f73e49";`,
      `const danger2 = "#ef4444";`,
      `const ok = "#22c55e";`,
      `const warn = "#fbbf24";`,
      `const info = "#3b82f6";`,
      // type scale noise
      `<a className="text-[10px] text-[11px] text-[12px] text-[14px] text-[16px] text-[18px] text-[24px]" />`,
      `<b className="leading-[16px] leading-[20px] leading-[24px] leading-[28px]" />`,
      // palette pressure
      `<c className="bg-gray-500 text-blue-600 text-red-500 bg-green-500" />`,
    ].join("\n"),
  );
}

test("--full dump includes the complete colour inventory, not just top-N", () => {
  withTemp((root) => {
    seedFixture(root);
    const r = spawnSync(process.execPath, [scanPath, root, "--json", "--full"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.ok(d.findings.color.all, "--full must emit findings.color.all");
    assert.ok(d.findings.color.all.length >= d.findings.color.top.length);
    assert.ok(d.findings.arbitrary.structured, "--full must emit structured arbitrary values");
  });
});

test("propose writes DESIGN.md + three DTCG token files", () => {
  withTemp((root) => {
    seedFixture(root);
    const out = join(root, "design");
    const r = propose(root, `--out=${out}`, "--name=fixture", "--clusters=8");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const md = readFileSync(join(out, "DESIGN.md"), "utf8");
    assert.match(md, /^name: "fixture"$/m);
    assert.match(md, /surface\.canvas/);
    assert.match(md, /action\.primary/);

    const color = JSON.parse(readFileSync(join(out, "tokens", "color.json"), "utf8"));
    assert.ok(color.primitive, "primitive tier required");
    assert.ok(color.semantic, "semantic tier required");
    // Every primitive is a real hex the fixture shipped.
    for (const [k, v] of Object.entries(color.primitive)) {
      assert.match(v.$value, /^#[0-9a-fA-F]{6}$/, `${k} must be a 6-digit hex`);
      assert.equal(v.$type, "color");
    }
    // Semantic tokens reference primitives, they do not restate raw values.
    const brand = color.semantic?.action?.primary;
    assert.ok(brand, "action.primary semantic role");
    assert.match(brand.$value, /^\{color\.primitive\./);

    const type = JSON.parse(readFileSync(join(out, "tokens", "typography.json"), "utf8"));
    assert.ok(Object.keys(type).some((k) => k.startsWith("size-")), "type scale emitted");
  });
});

test("frontmatter is Google-spec shaped: literal primary, every value quoted, every value real", () => {
  // Three planted negatives live in this one test, each killing a distinct
  // wrong emitter:
  //  - the OLD emitter (tokens in prose + sibling JSON only) has no colors: in
  //    frontmatter at all — the primary assertion fails on it;
  //  - an emitter that writes `primary: #182c56` UNQUOTED yields a YAML comment
  //    (null value) — the quoted-line regex fails on it;
  //  - an emitter that writes cluster centroids emits plausible hexes that
  //    appear nowhere in the fixture — the membership check fails on it.
  withTemp((root) => {
    seedFixture(root);
    const r = propose(root, "--name=specshape", "--clusters=8");
    assert.equal(r.status, 0, r.stderr);
    const md = r.stdout;

    const fm = md.split("\n---\n")[0];
    assert.match(fm, /^version: "alpha"$/m);
    assert.match(fm, /^name: "specshape"$/m);

    // colors: block — every entry exactly `  key: "#rrggbb"`, quoted.
    const colorsBlock = fm.match(/^colors:\n((?: {2}\S.*\n?)+)/m);
    assert.ok(colorsBlock, "colors: block present in frontmatter");
    const entries = colorsBlock[1].trimEnd().split("\n");
    assert.ok(entries.length >= 4, `at least 4 colour tokens, got ${entries.length}`);
    const fixtureSrc = readFileSync(join(root, "src", "a.tsx"), "utf8").toLowerCase();
    let sawPrimary = false;
    for (const line of entries) {
      const m = line.match(/^ {2}([a-z0-9.-]+): "(#[0-9a-f]{6})"$/);
      assert.ok(m, `colour entry must be quoted 6-digit hex: ${JSON.stringify(line)}`);
      assert.ok(
        fixtureSrc.includes(m[2]),
        `${m[1]} = ${m[2]} must be a value the fixture actually ships`,
      );
      if (m[1] === "primary") sawPrimary = true;
    }
    assert.ok(sawPrimary, "literal `primary` key present (missing-primary rule)");

    // The component references tokens, never restates raw values.
    assert.match(fm, /^ {4}backgroundColor: "\{colors\.primary\}"$/m);
    assert.match(fm, /^ {4}textColor: "\{colors\.[a-z0-9.-]+\}"$/m);
  });
});

test("body sections appear in the spec's canonical order, custom sections after", () => {
  withTemp((root) => {
    seedFixture(root);
    const r = propose(root, "--name=order", "--clusters=8");
    assert.equal(r.status, 0, r.stderr);
    const body = r.stdout.split("\n---\n").slice(1).join("\n---\n");
    const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

    const canonical = ["Overview", "Colors", "Typography", "Layout", "Components", "Do's and Don'ts"];
    const present = canonical.filter((h) => headings.includes(h));
    assert.ok(present.length >= 5, `expected most canonical sections, saw: ${headings.join(", ")}`);
    const idx = present.map((h) => headings.indexOf(h));
    for (let i = 1; i < idx.length; i++) {
      assert.ok(idx[i] > idx[i - 1], `${present[i]} must come after ${present[i - 1]}`);
    }
    // Custom sections must not interleave with the canonical run.
    const lastCanonical = Math.max(...idx);
    for (const h of headings) {
      if (!canonical.includes(h)) {
        assert.ok(
          headings.indexOf(h) > lastCanonical,
          `custom section "${h}" must come after the canonical sections`,
        );
      }
    }
  });
});

test("measured colours with zero assignable roles refuse to emit (the false-clean trap)", () => {
  // `designmd lint` scores an empty frontmatter identically to a compliant one
  // (live-verified, v0.4.0), so an emitter that writes a token-free DESIGN.md
  // produces a file that PASSES the official linter while declaring nothing.
  // These four hexes sit in the chroma dead band [0.05, 0.06) — too saturated
  // for isNeutral, too grey for isChromatic — so no role predicate claims them
  // and the guard is the only thing standing between that palette and a
  // lint-clean empty file.
  const report = JSON.stringify({
    scanned: 1,
    findings: {
      color: {
        all: [
          { value: "#00152c", count: 9 },
          { value: "#002337", count: 7 },
          { value: "#003142", count: 5 },
          { value: "#003837", count: 3 },
        ],
      },
      scale: { clusters: [] },
    },
  });
  const r = spawnSync(process.execPath, [proposePath, "--stdin", "--name=deadband"], {
    encoding: "utf8",
    input: report,
  });
  assert.equal(r.status, 1, `expected refusal exit 1, got ${r.status}\n${r.stdout}`);
  assert.match(r.stderr, /refusing to emit/);
  assert.ok(!r.stdout.includes("## Overview"), "no DESIGN.md body may be emitted");
});

test("status colours are claimed before brand, so a high-use red becomes danger not primary", () => {
  // The regression that made brand=#f73e49 and danger=empty on the first live run.
  withTemp((root) => {
    seedFixture(root);
    const out = join(root, "design");
    const r = propose(root, `--out=${out}`, "--clusters=10");
    assert.equal(r.status, 0, r.stderr);
    const color = JSON.parse(readFileSync(join(out, "tokens", "color.json"), "utf8"));
    const prim = color.primitive;
    // Red-ward cluster must land on the red primitive (danger), not brand.
    assert.ok(prim.red, "red primitive assigned");
    assert.match(prim.red.$value, /^#(f73e49|ef4444)$/i);
    // Brand should be the navy, not the red.
    if (prim.brand) {
      assert.ok(
        !/^#(f73e49|ef4444|ff0000)$/i.test(prim.brand.$value),
        "brand must not be the danger red",
      );
    }
    // danger semantic points at the red primitive.
    assert.equal(color.semantic.status.danger.$value, "{color.primitive.red}");
  });
});

test("a cluster is represented by its most-used colour, not the one nearest the centroid", () => {
  // The bug this pins down shipped silently because the invariant everyone
  // checks — "every token is a real member, never an invented blend" — stayed
  // true the whole time. Snapping to the member nearest the usage-weighted
  // centroid picks a colour that is real and almost unused: on one audited monorepo,
  // surface.canvas came out #f4f4f5 (1 use) for a 423-use cluster holding
  // #ffffff (130), and action.primary #2a2a4e (3 uses) while #182c56 — the
  // most-used literal in the repo at 140 — got no role at all. Adopting that
  // means migrating 130 call sites onto a value nothing ships.
  //
  // Reproducing it needs the dominant colour at a cluster ENDPOINT. A weighted
  // centroid sits on top of the dominant colour when that colour is also
  // central, which is why a naive fixture passes under both rules. Here
  // #ffffff (40 uses, L=1.0) is the extreme, #e0e0e0/#d0d0d0 (55 uses between
  // them) drag the centroid down to L=0.933, and #e8e8e8 — used exactly once —
  // lands 0.002 from it. Nearest-centroid therefore crowns the 1-use colour.
  withTemp((root) => {
    const rep = (hex, n, tag) =>
      Array.from({ length: n }, (_, i) => `const ${tag}${i} = "${hex}";`).join("\n");
    write(
      root,
      "src/a.tsx",
      [
        rep("#ffffff", 40, "w"),
        rep("#e0e0e0", 30, "m"),
        rep("#d0d0d0", 25, "d"),
        `const centroidMagnet = "#e8e8e8";`,
        // The chromatics need real weight, not one use each. Seeding scores
        // minDistance x log(count), so single-use hues lose the contest to a
        // 30-use grey, a grey gets seeded, and the greys split into two
        // clusters — at which point the centroid never moves and this test
        // passes against the very bug it exists to catch.
        rep("#f73e49", 20, "r"),
        rep("#22c55e", 20, "g"),
        rep("#3b82f6", 20, "b"),
      ].join("\n"),
    );
    write(root, "src/b.tsx", `<a className="text-[12px] text-[14px] text-[16px]" />`);
    const r = propose(root, "--clusters=4");
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /surface\.canvas:\*\* `#ffffff`/,
      "canvas must be the 40-use white, not the 1-use colour nearest the centroid",
    );
    assert.ok(
      !r.stdout.includes("`#e8e8e8`"),
      "a 1-use colour must never be emitted as a role's value",
    );
  });
});

test("shadcn bare-HSL declarations name the primary (#264 AC1)", () => {
  // taxonomy's failure shape: the whole palette lives as bare `H S% L%` triples
  // in a token file, invisible to every raw-literal regex. The declared tier
  // must read them, resolve them, and win by NAME. 222.2 47.4% 11.2% is
  // shadcn's stock slate-900 primary = #0f172a.
  withTemp((root) => {
    write(
      root,
      "styles/globals.css",
      [
        `:root {`,
        `  --primary: 222.2 47.4% 11.2%;`,
        `  --background: 0 0% 100%;`,
        `  --foreground: 222.2 47.4% 11.2%;`,
        `  --destructive: 0 100% 50%;`,
        `}`,
      ].join("\n"),
    );
    write(root, "src/app.tsx", `const x = "var(--primary)";\nconst greys = "#ababab";\nconst g2 = "#ababab";`);
    const r = propose(root, "--name=shadcnfix");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^  primary: "#0f172a"$/m, "declared --primary wins, HSL resolved");
    assert.match(r.stdout, /^  surface\.canvas: "#ffffff"$/m, "--background is canvas");
    assert.match(r.stdout, /^  status\.danger: "#ff0000"$/m, "--destructive is danger");
    assert.match(r.stdout, /declared as `--primary` in styles\/globals\.css/, "prose carries provenance");
  });
});

test("a declared brand beats a residual literal with 3x the uses (#264 AC2)", () => {
  // outline's failure shape: GitHub's badge purple (#8250df, 12 raw uses in a
  // plugin dir) outweighed the real brand #0366d6 declared in theme.ts. The
  // declared NAME must win regardless of the frequency imbalance.
  withTemp((root) => {
    write(root, "shared/styles/theme.ts", `export const colors = { brand: "#0366d6", almostBlack: "#111319" };`);
    const badge = Array.from({ length: 12 }, (_, i) => `const b${i} = "#8250df";`).join("\n");
    write(root, "plugins/github/badges.ts", badge);
    write(root, "src/page.tsx", `const bg = "#ffffff"; const t = "#222222"; const warn = "#fbbf24";`);
    const r = propose(root, "--name=declbeats");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^  primary: "#0366d6"$/m, "declared brand wins over the 12-use badge purple");
    assert.match(r.stdout, /declared as `brand` in shared\/styles\/theme\.ts/);
    // The badge purple is still real shipped colour — it may appear as an
    // accent, but never as the brand.
    assert.ok(!/primary: "#8250df"/.test(r.stdout), "badge purple must not be primary");
  });
});

test("a semantic layer of REFERENCES resolves one hop to name the roles (#264, outline shape)", () => {
  // outline's theme.ts declares primitives (`accent: "#0366d6"`) and then a
  // semantic layer of references (`text: colors.almostBlack`, `link:
  // colors.accent`). The literal-hex extractor alone never sees the semantic
  // names, and `accent` must not be trusted directly (shadcn's --accent is a
  // muted background) — only `link`/`selected` referencing it reveal the
  // brand. This is the fix's own motivating example, end to end.
  withTemp((root) => {
    write(
      root,
      "shared/styles/theme.ts",
      [
        `const colors = {`,
        `  accent: "#0366d6",`,
        `  almostBlack: "#111319",`,
        `  slateDark: "#394351",`,
        `  white: "#ffffff",`,
        `  danger: "#ed2651",`,
        `  success: "#3ad984",`,
        `};`,
        `export const buildLightTheme = () => ({`,
        `  background: colors.white,`,
        `  text: colors.almostBlack,`,
        `  textSecondary: colors.slateDark,`,
        `  link: colors.accent,`,
        `  selected: colors.accent,`,
        // Decoys, all real names from outline's theme.ts, each of which claimed
        // a global role before the component/surface/bare-name guards existed:
        `  accentText: colors.white,`, // text-ON-accent, not the page ink
        `  noticeSuccessText: colors.almostBlack,`, // a notice's text, not success
        `  buttonNeutralBorder: colors.slateDark,`, // a button's border, not the hairline
        `});`,
      ].join("\n"),
    );
    write(root, "src/page.tsx", `const a = "#ababab"; const b = "#cdcdcd";`);
    const r = propose(root, "--name=refhop");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^  primary: "#0366d6"$/m, "link/selected -> colors.accent names the brand");
    assert.match(r.stdout, /^  text\.primary: "#111319"$/m, "text -> almostBlack is ink, not accentText's white");
    assert.match(r.stdout, /^  text\.secondary: "#394351"$/m, "textSecondary (camelCase) -> slateDark");
    assert.match(r.stdout, /^  surface\.canvas: "#ffffff"$/m, "background -> white, by provenance not coincidence");
    assert.match(r.stdout, /^  status\.danger: "#ed2651"$/m);
    assert.match(r.stdout, /^  status\.success: "#3ad984"$/m, "bare `success` beats noticeSuccessText");
    assert.ok(!/text\.primary: "#ffffff"/.test(r.stdout), "accentText must not claim ink");
    assert.ok(!/border\.default: "#394351"/.test(r.stdout), "buttonNeutralBorder must not claim the hairline");
  });
});

test("theme modes are separate systems: --mode selects, the other mode is named (#272)", () => {
  // One real app's shape: light declares emerald, .dark declares the matrix
  // green that IS the brand. Default (light) must not hide the dark system;
  // --mode=dark must derive it.
  withTemp((root) => {
    write(
      root,
      "styles/shadcn-ui.css",
      [
        ":root {",
        ...Array.from({ length: 12 }, (_, i) => `  --pad-${i}: #f${i.toString(16)}f${i.toString(16)}f${i.toString(16)};`),
        "  --primary: #059669;",
        "  --background: #ffffff;",
        "}",
        ".dark {",
        "  --primary: #39ff14;",
        "  --background: #0a0a0a;",
        "}",
      ].join("\n"),
    );
    write(root, "src/app.tsx", `const a = "var(--primary)"; const g1 = "#ababab";\nconst g2 = "#cdcdcd";`);
    const light = propose(root, "--name=modes");
    assert.equal(light.status, 0, light.stderr);
    assert.match(light.stdout, /^  primary: "#059669"$/m, "default derives the light system");
    assert.match(light.stdout, /### Mode divergence/, "the dark system is named, not hidden");
    assert.match(light.stdout, /--primary: #39ff14/, "divergent dark primary cited");
    const dark = propose(root, "--name=modes", "--mode=dark");
    assert.equal(dark.status, 0, dark.stderr);
    assert.match(dark.stdout, /^  primary: "#39ff14"$/m, "--mode=dark derives the matrix brand");
    assert.match(dark.stdout, /^  surface\.canvas: "#0a0a0a"$/m, "dark canvas is the near-black");
  });
});

test("a workspace with two themed units refuses a blended DESIGN.md (#272)", () => {
  withTemp((root) => {
    write(root, "pnpm-workspace.yaml", `packages:\n  - "apps/*"\n`);
    write(root, "apps/web/package.json", `{"name":"web"}`);
    write(root, "apps/admin/package.json", `{"name":"admin"}`);
    write(root, "apps/web/styles/theme.css", `:root { --primary: #182c56; --background: #ffffff; }`);
    write(root, "apps/admin/styles/theme.css", `:root { --primary: #39ff14; --background: #0a0a0a; }`);
    write(root, "apps/web/src/a.tsx", `const a = "#ababab"; const b = "#cdcdcd";`);
    const r = propose(root, "--name=blend");
    assert.equal(r.status, 3, `expected refusal exit 3, got ${r.status}\n${r.stdout.slice(0, 200)}`);
    assert.match(r.stderr, /refusing to blend/);
    assert.match(r.stderr, /apps\/admin/, "refusal names the themed units");
    assert.match(r.stderr, /apps\/web/);
    const forced = propose(root, "--name=blend", "--allow-blended");
    assert.equal(forced.status, 0, "--allow-blended restores old behaviour: " + forced.stderr);
    // Pointing at ONE app is the blessed path and must not refuse.
    const single = propose(join(root, "apps", "admin"), "--name=admin");
    assert.equal(single.status, 0, single.stderr);
    assert.match(single.stdout, /^  primary: "#182c56"|^  primary: "#39ff14"$/m);
  });
});

test("a declared VARIANT never claims the base role, whatever its refs say", () => {
  // Measured on a real monorepo: `--color-success-muted` (a tint from another
  // app, more var() call sites) stole status.success from the real
  // `--success: #16a249`. Variant words disqualify a name from base roles.
  withTemp((root) => {
    write(
      root,
      "styles/globals.css",
      [
        `:root {`,
        `  --success: #16a249;`,
        `  --color-success-muted: #2d4a1a;`,
        `  --primary: #182c56;`,
        `}`,
      ].join("\n"),
    );
    // Give the muted variant MORE refs than the base.
    write(
      root,
      "src/app.tsx",
      [
        `const a = "var(--color-success-muted)";`,
        `const b = "var(--color-success-muted)";`,
        `const c = "var(--color-success-muted)";`,
        `const d = "var(--success)";`,
        `const raw1 = "#ababab";`,
        `const raw2 = "#cdcdcd";`,
      ].join("\n"),
    );
    const r = propose(root, "--name=variants");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^  status\.success: "#16a249"$/m, "the base --success wins");
    assert.ok(!/status\.success: "#2d4a1a"/.test(r.stdout), "the muted variant must not");
  });
});

test("colours living only in test files cannot name a brand (#264 AC3)", () => {
  // outline's other failure shape: status.success = #00ff00 sourced entirely
  // from *.test.ts assertions. With zero shipped weight and nothing declared,
  // the proposer must refuse rather than crown a fixture.
  withTemp((root) => {
    write(
      root,
      "server/auth.test.ts",
      `expect(a).toBe("#00ff00"); expect(b).toBe("#ff00ff"); expect(c).toBe("#00ffff"); expect(d).toBe("#ffaa00");`,
    );
    write(root, "server/more.test.ts", `expect(e).toBe("#123456"); expect(f).toBe("#654321");`);
    const r = propose(root, "--name=testonly");
    assert.equal(r.status, 1, `expected refusal, got ${r.status}\nstdout: ${r.stdout.slice(0, 300)}`);
    assert.match(r.stderr, /ONLY in test files/, "the refusal names the cause");
    assert.ok(!r.stdout.includes("## Overview"), "nothing emitted");
  });
});

test("a role the assigner declined is absent from EVERY artifact, tokens included", () => {
  // Multi-repo validation, 2026-08-07: tokens/color.json silently backfilled
  // surface.elevated with the canvas primitive while the same run's DESIGN.md
  // frontmatter omitted the role and its prose said "no confident assignment —
  // pick manually". Two artifacts from one run must not disagree about what
  // the system contains. The seedFixture has no elevated-surface cluster, so
  // the role goes unassigned — and must stay unassigned everywhere.
  withTemp((root) => {
    seedFixture(root);
    const out = join(root, "design");
    const r = propose(root, `--out=${out}`, "--clusters=8");
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(out, "DESIGN.md"), "utf8");
    const fm = md.split("\n---\n")[0];
    assert.ok(!/^\s+surface\.elevated:/m.test(fm), "frontmatter omits the unassigned role");
    const color = JSON.parse(readFileSync(join(out, "tokens", "color.json"), "utf8"));
    assert.equal(color.semantic?.surface?.elevated, undefined, "tokens must not backfill it either");
    assert.equal(color.semantic?.border?.default, undefined, "hairline unassigned → absent, not aliased");
    assert.ok(color.semantic?.surface?.canvas, "assigned roles still emit");
  });
});

test("4-digit hex shorthands are rejected, not promoted to accents", () => {
  withTemp((root) => {
    write(root, "src/a.tsx", `const a="#2706"; const b="#f9f9f9"; const c="#111114"; const d="#182c56"; const e="#f73e49"; const f="#22c55e"; const g="#3b82f6"; const h="#fbbf24";`);
    write(root, "src/b.tsx", `<a className="text-[12px] text-[14px] text-[16px]" />`);
    const out = join(root, "design");
    const r = propose(root, `--out=${out}`, "--clusters=6");
    assert.equal(r.status, 0, r.stderr);
    const color = JSON.parse(readFileSync(join(out, "tokens", "color.json"), "utf8"));
    for (const v of Object.values(color.primitive)) {
      assert.notEqual(v.$value.toLowerCase(), "#2706");
      assert.match(v.$value, /^#[0-9a-fA-F]{6}$/);
    }
  });
});

test("pure black and pure white are never emitted as accents", () => {
  withTemp((root) => {
    seedFixture(root);
    // Force pure black/white into the inventory at high count.
    write(root, "src/z.tsx", `const a="#000000"; const b="#000000"; const c="#ffffff"; const d="#ffffff";`);
    const out = join(root, "design");
    const r = propose(root, `--out=${out}`, "--clusters=10");
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(join(out, "DESIGN.md"), "utf8");
    // Accents section should not list #000000 / #ffffff.
    const accentBlock = md.split("### Accents")[1]?.split("## ")[0] || "";
    assert.ok(
      !/#000000|#ffffff|#000\b|#fff\b/i.test(accentBlock),
      "pure black/white must not appear as accents",
    );
  });
});

test("with no signal, propose exits 2 rather than writing an empty system", () => {
  withTemp((root) => {
    write(root, "src/a.tsx", `export const ok = true;`);
    const r = propose(root, `--out=${join(root, "design")}`);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not enough signal/);
  });
});

test("default (no --out) prints DESIGN.md to stdout and does not write files", () => {
  withTemp((root) => {
    seedFixture(root);
    const r = propose(root, "--name=stdout-test", "--clusters=6");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^name: "stdout-test"$/m);
    // No design/ dir created next to the fixture.
    assert.equal(
      spawnSync("test", ["-d", join(root, "design")]).status,
      1,
    );
  });
});
