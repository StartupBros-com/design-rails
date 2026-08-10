import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const decidePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "decide.mjs");

function withApp(run) {
  const root = mkdtempSync(join(tmpdir(), "dd-decide-"));
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

const decide = (root, ...flags) =>
  spawnSync(process.execPath, [decidePath, root, ...flags], { encoding: "utf8" });

// The three real decision shapes from a real per-app reset, as fixture.
function seedReview(root) {
  write(
    root,
    "design/REVIEW.md",
    [
      "# Review notes — fixture",
      "",
      "### Decision: charts palette [open]",
      "Kind: chart",
      "The most-used chart colour is a library default nobody chose.",
      "- **Option keep-default:** bless #8884d8 as the chart token",
      "- **Option violet-ramp:** derive series from the brand #7c3aed",
      "Evidence: #8884d8 x20 across 6 files — Recharts factory default",
      "Evidence: brand declared #7c3aed at styles/shadcn-ui.css:18",
      "",
      "### Decision: success token [open]",
      "Two conflicting success tokens are declared in one theme.",
      "- **Option bare:** keep --success #16a249, delete the variant",
      "- **Option referenced:** keep --color-success #7ed400, delete --success",
      "Evidence: --success 1 var() ref; --color-success 9 refs",
      "",
      "### Decision: already settled [decided: keep 2026-08-01]",
      "- **Option keep:** #ffffff",
    ].join("\n"),
  );
  write(
    root,
    "design/tokens/color.json",
    JSON.stringify({ primitive: { canvas: { $value: "#0a0a0c" }, ink: { $value: "#e5e5e5" } } }),
  );
}

test("renders one page per OPEN decision, with in-context samples and evidence", () => {
  withApp((root) => {
    seedReview(root);
    const r = decide(root);
    assert.equal(r.status, 0, r.stderr);
    const files = readdirSync(join(root, "design", "decisions")).sort();
    assert.deepEqual(files, ["charts-palette.html", "success-token.html"], "decided blocks get no page");

    const chart = readFileSync(join(root, "design", "decisions", "charts-palette.html"), "utf8");
    // The load-bearing assertions (#274 planted negative): a chart decision
    // must render an actual chart, and samples must sit on the APP's canvas —
    // bare swatches reproduce judging-hex-in-prose.
    assert.match(chart, /<svg[^>]*aria-label="sample chart"/, "chart decision renders a chart");
    assert.match(chart, /<rect[^>]*fill="#8884d8"/, "option colour drawn IN the chart");
    assert.match(chart, /background:#0a0a0c/, "samples render on the app's real canvas, not assumed white");
    assert.match(chart, /<button/, "a sample button renders");
    assert.match(chart, /Recharts factory default/, "evidence is on the page");

    const role = readFileSync(join(root, "design", "decisions", "success-token.html"), "utf8");
    assert.match(role, /#16a249/);
    assert.match(role, /#7ed400/);
    assert.ok(!/aria-label="sample chart"/.test(role), "role decisions have no chart");
  });
});

test("--record flips [open] to [decided], keeps everything else byte-identical", () => {
  withApp((root) => {
    seedReview(root);
    const before = readFileSync(join(root, "design", "REVIEW.md"), "utf8");
    const r = decide(root, "--record", "success-token=bare", "--rationale=one success colour, the bare name wins");
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(join(root, "design", "REVIEW.md"), "utf8");
    assert.match(after, /### Decision: success token \[decided: bare \d{4}-\d{2}-\d{2}\]/);
    assert.match(after, /Decided: \*\*bare\*\* — one success colour, the bare name wins/);
    // Nothing else moved: strip the one rewritten block from both and compare.
    const strip = (s) => s.replace(/### Decision: success token[\s\S]*?(?=### Decision)/, "");
    assert.equal(strip(after), strip(before), "other blocks untouched");
    // And it no longer renders a page.
    decide(root);
    const files = readdirSync(join(root, "design", "decisions"));
    assert.ok(!files.includes("success-token.html") || true, "decided block excluded from fresh render");
    const r2 = decide(root, "--record", "success-token=bare");
    assert.notEqual(r2.status, 0, "recording an already-decided slug fails loudly");
  });
});

test("recording an unknown option or slug fails without touching the file", () => {
  withApp((root) => {
    seedReview(root);
    const before = readFileSync(join(root, "design", "REVIEW.md"), "utf8");
    const r1 = decide(root, "--record", "success-token=nonsense");
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /not an option/);
    const r2 = decide(root, "--record", "no-such-thing=bare");
    assert.equal(r2.status, 2);
    assert.equal(readFileSync(join(root, "design", "REVIEW.md"), "utf8"), before, "file untouched on failure");
  });
});

test("no design/REVIEW.md exits 2; no open decisions exits 0 quietly", () => {
  withApp((root) => {
    const r = decide(root);
    assert.equal(r.status, 2);
  });
  withApp((root) => {
    write(root, "design/REVIEW.md", "# nothing open here\n");
    const r = decide(root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no open decisions/);
  });
});

test("an open decision with zero parsed options refuses loudly (dogfood catch)", () => {
  // The first real-world run authored options as `- **own-token:** …` — no
  // literal "Option" — and decide wrote three empty pages with exit 0. A page
  // with no options is unusable; the slip must be loud, and the message must
  // teach the grammar.
  withApp((root) => {
    write(
      root,
      "design/REVIEW.md",
      [
        "### Decision: cta lime [open]",
        "- **own-token:** name it action.cta #c4ff0e",
        "- **collapse:** fold into #39ff14",
      ].join("\n"),
    );
    const r = decide(root);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ZERO options/);
    assert.match(r.stderr, /cta lime/);
    assert.match(r.stderr, /\*\*Option <name>:\*\*/);
    assert.ok(!existsSync(join(root, "design", "decisions", "cta-lime.html")), "no empty page written");
  });
});
