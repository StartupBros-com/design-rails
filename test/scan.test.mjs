import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "scan.mjs");

function withTempProject(run) {
  const project = mkdtempSync(join(tmpdir(), "design-drift-"));
  try {
    return run(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function write(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function scan(root, ...args) {
  const result = spawnSync("node", [scriptPath, root, "--json", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("rejects a missing scan root instead of reporting a clean scan", () => {
  const result = spawnSync("node", [scriptPath, join(tmpdir(), "design-drift-does-not-exist"), "--json"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read/);
});

test("rejects an unknown detector rather than silently scanning nothing", () => {
  const result = spawnSync("node", [scriptPath, tmpdir(), "--only=nope"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown detector/);
});

test("counts colour literals and reports distinct values", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000";\nconst b = "#ff0000";\nconst c = "rgba(0,0,0,.5)";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 3);
    assert.equal(r.findings.color.distinct, 2); // #ff0000 and rgba()
    assert.equal(r.findings.color.top[0].value, "#ff0000");
    assert.equal(r.findings.color.top[0].count, 2);
  });
});

test("a longer hex-like string is not counted as a colour", () => {
  // The regression this guards: /#[0-9a-f]{6}/ happily matches the first six
  // chars of a commit SHA or a URL fragment.
  withTempProject((root) => {
    write(root, "src/a.tsx", `const sha = "#abcdef1234567890";\nconst id = "#deadbeefcafe";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 0);
  });
});

test("reports a var() that no file defines", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `<a style={{ color: "var(--brand-primary)" }} />`);
    const r = scan(root);
    assert.equal(r.findings.orphan.unresolved, 1);
    assert.equal(r.findings.orphan.top[0].name, "--brand-primary");
  });
});

test("a definition in any file resolves a reference in another", () => {
  // CSS does not care which file a variable came from, so defs are global —
  // including from vendored code, which legitimately defines vars the app uses.
  withTempProject((root) => {
    write(root, "src/theme.css", `:root { --brand-primary: #ff0000; }`);
    write(root, "src/a.tsx", `<a style={{ color: "var(--brand-primary)" }} />`);
    write(root, "packages/ui/src/shadcn/x.css", `.x { --vendor-token: 1px; }`);
    write(root, "src/b.tsx", `<b style={{ width: "var(--vendor-token)" }} />`);
    const r = scan(root);
    assert.equal(r.findings.orphan.unresolved, 0);
  });
});

test("a JSX inline-style definition counts as a definition", () => {
  // Regression: only matching CSS `--x:` reported 40% of a real codebase's
  // variables as orphaned, because the quote in `{"--x": v}` sits between the
  // name and the colon.
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      `<div style={{ "--bar-width": w }}><span style={{ width: "var(--bar-width)" }} /></div>`,
    );
    const r = scan(root);
    assert.equal(r.findings.orphan.unresolved, 0);
  });
});

test("framework-injected and build-generated variables are not orphans", () => {
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      [
        `<a style={{ x: "var(--tw-ring-color)" }} />`,
        `<b style={{ x: "var(--radix-popper-anchor-width)" }} />`,
        `<c style={{ x: "var(--color-gray-200)" }} />`,   // Tailwind v4 @theme
        `<d style={{ x: "var(--color-neutral-950)" }} />`,
      ].join("\n"),
    );
    const r = scan(root);
    assert.equal(r.findings.orphan.unresolved, 0);
  });
});

test("a dynamically constructed var name is not reported", () => {
  // `var(--color-${key})` can only be captured as its static prefix; reporting
  // the truncated name is always wrong.
  withTempProject((root) => {
    write(root, "src/a.tsx", "const s = `var(--color-${key})`;");
    const r = scan(root);
    assert.equal(r.findings.orphan.unresolved, 0);
  });
});

test("a real custom token is still caught next to the exempted ones", () => {
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      `<a style={{ x: "var(--color-gray-200)", y: "var(--color-brand-200)" }} />`,
    );
    const r = scan(root);
    assert.equal(r.findings.orphan.unresolved, 1, "the Tailwind one is exempt, the custom one is not");
    assert.equal(r.findings.orphan.top[0].name, "--color-brand-200");
  });
});

test("detects raw Tailwind palette utilities and groups them by hue", () => {
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      `<a className="bg-gray-500 text-blue-600 divide-gray-200 border-red-400" />
       <b className="bg-gray-500" />`,
    );
    const r = scan(root);
    assert.equal(r.findings.palette.occurrences, 5);
    assert.equal(r.findings.palette.top[0].value, "bg-gray-500");
    assert.equal(r.findings.palette.top[0].count, 2);
    assert.equal(r.findings.palette.distinctHues, 3); // gray, blue, red
  });
});

test("semantic and non-palette utilities are not flagged as palette drift", () => {
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      `<a className="bg-primary text-muted-foreground p-4 bg-gray-1000 text-blue" />`,
    );
    const r = scan(root);
    assert.equal(r.findings.palette.occurrences, 0, "only real palette-step utilities count");
  });
});

test("a colour reached through a token is not a hardcode", () => {
  // var(--x, #fff) is a fallback and theme() is a lookup — flagging those
  // punishes exactly the code doing the right thing.
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "var(--brand, #ffffff)";\nconst b = "#ff0000";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 1);
    assert.equal(r.findings.color.top[0].value, "#ff0000");
  });
});

test("--fail-on accepts per-detector budgets and holds each line independently", () => {
  // The reason per-detector exists: a single combined ceiling is gameable in
  // the direction that matters least — swap 1 colour literal for 1 palette
  // utility and a total budget never notices.
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000";\n<b className="bg-gray-500 text-blue-600" />`);
    // color=1, palette=2
    const exact = spawnSync("node", [scriptPath, root, "--json", "--fail-on=color=1,palette=2"], { encoding: "utf8" });
    assert.equal(exact.status, 0, "at budget is not over budget");

    const tight = spawnSync("node", [scriptPath, root, "--json", "--fail-on=color=1,palette=1"], { encoding: "utf8" });
    assert.equal(tight.status, 1, "palette over its own budget fails");
    assert.match(tight.stderr, /palette 2 > 1/);
    assert.doesNotMatch(tight.stderr, /color/, "a detector within budget is not reported");
  });
});

test("--fail-on can budget the orphan detector, which counts unresolved not occurrences", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `<a style={{ color: "var(--nope-one)", background: "var(--nope-two)" }} />`);
    const ok = spawnSync("node", [scriptPath, root, "--json", "--fail-on=orphan=2"], { encoding: "utf8" });
    assert.equal(ok.status, 0);
    const bad = spawnSync("node", [scriptPath, root, "--json", "--fail-on=orphan=1"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /orphan 2 > 1/);
  });
});

test("a malformed or unknown budget is rejected loudly, not ignored", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000";`);
    for (const bad of ["--fail-on=nosuch=1", "--fail-on=color=abc", "--fail-on=color"]) {
      const r = spawnSync("node", [scriptPath, root, "--json", bad], { encoding: "utf8" });
      assert.equal(r.status, 2, `${bad} should be a usage error`);
      assert.match(r.stderr, /bad --fail-on budget/);
    }
  });
});

test("budgeting a detector that was skipped is a usage error, not a silent pass", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000";`);
    const r = spawnSync("node", [scriptPath, root, "--json", "--skip=color", "--fail-on=color=0"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /did not run/);
  });
});

test("--fail-on turns the scan into a gate, and is off by default", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000";`);
    const clean = spawnSync("node", [scriptPath, root, "--json"], { encoding: "utf8" });
    assert.equal(clean.status, 0, "report-only by default");

    const gated = spawnSync("node", [scriptPath, root, "--json", "--fail-on=0"], { encoding: "utf8" });
    assert.equal(gated.status, 1);
    // A bare number still means "one ceiling over the combined total" — the
    // per-detector form is additive, not a replacement.
    assert.match(gated.stderr, /budget exceeded — total 1 > 0/);

    const budgeted = spawnSync("node", [scriptPath, root, "--json", "--fail-on=99"], { encoding: "utf8" });
    assert.equal(budgeted.status, 0, "a budget above the count passes");
  });
});

test("values inside comments are not drift", () => {
  // Found by scanning this repo with the tool itself: "see PR #162" is three
  // valid hex digits and was reported as a colour.
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      [
        `// see PR #162 for why`,
        `/* legacy palette was #ff0000 */`,
        `<a className="p-[13px]" /> {/* was p-[7px] */}`,
      ].join("\n"),
    );
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 0, "no colours outside comments");
    assert.equal(r.findings.arbitrary.occurrences, 1, "only the live class counts, not the commented one");
    assert.equal(r.findings.arbitrary.top[0].value, "p-[13px]");
  });
});

test("a protocol-relative URL does not start a comment", () => {
  // The naive fix (split on "//") would eat the rest of any line containing a
  // URL, silently hiding real hits after it.
  withTempProject((root) => {
    write(root, "src/a.tsx", `const u = "https://x.com/a"; const c = "#ff0000";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 1);
    assert.equal(r.findings.color.top[0].value, "#ff0000");
  });
});

test("an ignore directive still works even though it lives in a comment", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000"; // design-drift-ignore color`);
    write(root, "src/b.tsx", `const b = "#00ff00";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 1);
    assert.equal(r.findings.color.top[0].value, "#00ff00");
  });
});

test("token and theme files are allowed to hold raw colour values", () => {
  withTempProject((root) => {
    write(root, "src/theme.css", `:root { --brand: #ff0000; --alt: #00ff00; }`);
    write(root, "src/tokens.ts", `export const brand = "#ff0000";`);
    write(root, "src/Button.tsx", `const x = "#0000ff";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 1, "only the component hit should count");
    assert.equal(r.findings.color.top[0].value, "#0000ff");
  });
});

test("counts Tailwind arbitrary values but not data-attribute selectors", () => {
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      `<div className="text-[14px] p-[13px] data-[state=open]:block w-[var(--x)] gap-[1.5rem]" />`,
    );
    const r = scan(root);
    const vals = r.findings.arbitrary.top.map((t) => t.value).sort();
    assert.deepEqual(vals, ["gap-[1.5rem]", "p-[13px]", "text-[14px]"]);
    assert.equal(r.findings.arbitrary.occurrences, 3);
  });
});

test("derives the missing scale from a cluster of near-identical values", () => {
  // The headline behaviour: five font sizes within 5px of each other are one
  // scale nobody defined, and the tool must say what that scale is.
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      [
        `<a className="text-[10px]" />`,
        `<b className="text-[11px]" />`,
        `<c className="text-[13px]" />`,
        `<d className="text-[14px]" />`,
        `<e className="text-[15px]" />`,
      ].join("\n"),
    );
    const r = scan(root);
    const cluster = r.findings.scale.clusters.find((c) => c.prop === "text");
    assert.ok(cluster, "expected a text cluster");
    assert.deepEqual(cluster.distinctValues, [10, 11, 13, 14, 15]);
    assert.ok(
      cluster.proposedScale.length < cluster.distinctValues.length,
      "a proposed scale must actually collapse the values",
    );
    assert.ok(cluster.reduction > 0);
  });
});

test("keeps precision for fractional units instead of rounding them to zero", () => {
  // Regression, visible only on real data: the proposed scale was rounded to
  // integers regardless of unit, so a tracking scale of 0.14em..0.35em printed
  // as "0, 0" and a rem type scale printed as duplicate 1s and 2s.
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      [0.14, 0.18, 0.2, 0.22, 0.24, 0.25, 0.3, 0.35]
        .map((v) => `<a className="tracking-[${v}em]" />`)
        .join("\n"),
    );
    const r = scan(root);
    const cl = r.findings.scale.clusters.find((c) => c.prop === "tracking");
    assert.ok(cl, "expected a tracking cluster");
    assert.ok(cl.proposedScale.every((s) => s > 0), `scale must not round to zero: ${cl.proposedScale}`);
    assert.equal(new Set(cl.proposedScale).size, cl.proposedScale.length, "no duplicate steps");
    assert.equal(cl.proposedScale.length, cl.collapse.split(" → ")[1] * 1);
  });
});

test("ignores a weak collapse that is layout variety rather than a missing scale", () => {
  // 12 widths spread from 40px to 600px are legitimately different sizes; a
  // 12→11 "scale" is noise that buries the real findings.
  withTempProject((root) => {
    const widths = [40, 90, 140, 200, 260, 320, 380, 440, 500, 560, 600, 640];
    write(root, "src/a.tsx", widths.map((v) => `<a className="w-[${v}px]" />`).join("\n"));
    const r = scan(root);
    assert.equal(r.findings.scale.clusters.find((c) => c.prop === "w"), undefined);
  });
});

test("--min-reduction lowers the bar for reporting a cluster", () => {
  withTempProject((root) => {
    const widths = [40, 90, 140, 200, 260, 320, 380, 440, 500, 560, 600, 640];
    write(root, "src/a.tsx", widths.map((v) => `<a className="w-[${v}px]" />`).join("\n"));
    const r = scan(root, "--min-reduction=1", "--tolerance-px=40");
    assert.ok(r.findings.scale.clusters.find((c) => c.prop === "w"), "a looser bar surfaces it");
  });
});

test("does not invent a scale for fewer than three distinct values", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `<a className="text-[14px]" /><b className="text-[16px]" />`);
    const r = scan(root);
    assert.equal(r.findings.scale.clusters.length, 0);
  });
});

test("flags near-duplicate colours and leaves distant ones alone", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a="#f5f5f5"; const b="#f6f6f6"; const c="#000000";`);
    const r = scan(root);
    const pair = r.findings.nearcolor.pairs[0];
    assert.ok(pair, "expected a near-duplicate pair");
    assert.deepEqual([pair.a, pair.b].sort(), ["#f5f5f5", "#f6f6f6"]);
    assert.ok(
      !r.findings.nearcolor.pairs.some((p) => p.a === "#000000" || p.b === "#000000"),
      "black is not a near-duplicate of an off-white",
    );
  });
});

test("vendored code is counted separately and never mixed into first-party totals", () => {
  withTempProject((root) => {
    write(root, "packages/ui/src/shadcn/button.tsx", `const v = "#ff0000";`);
    write(root, "apps/web/Button.tsx", `const v = "#00ff00";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 1, "first-party count excludes vendored");
    assert.equal(r.findings.color.vendorOccurrences, 1);
    assert.equal(r.findings.color.top[0].value, "#00ff00");
  });
});

test("ignore directives suppress a line, the next line, and a whole file", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000"; // design-drift-ignore`);
    write(root, "src/b.tsx", `// design-drift-ignore-next-line\nconst b = "#ff0000";`);
    write(root, "src/c.tsx", `// design-drift-ignore-file\nconst c = "#ff0000";\nconst d = "#00ff00";`);
    write(root, "src/d.tsx", `const e = "#0000ff";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 1, "only the unsuppressed file should report");
    assert.equal(r.findings.color.top[0].value, "#0000ff");
  });
});

test("a scoped ignore suppresses only the named detector", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `<a className="p-[13px]" data-x="#ff0000" /> {/* design-drift-ignore color */}`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 0, "colour was ignored by name");
    assert.equal(r.findings.arbitrary.occurrences, 1, "arbitrary was not named, so it still reports");
  });
});

test("a file directive on its own line does not swallow the next line as its id list", () => {
  // Regression: the id capture used \s, so `// design-drift-ignore-file` on its
  // own line consumed the following line's code and parsed "const c" as two
  // detector ids — the directive then matched no detector and silently
  // suppressed nothing while appearing to work.
  withTempProject((root) => {
    write(root, "src/c.tsx", `// design-drift-ignore-file\nconst c = "#ff0000";\nconst d = "#00ff00";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 0, "an unscoped file directive suppresses every detector");
  });
});

test("a scoped file directive suppresses only the named detector", () => {
  withTempProject((root) => {
    write(root, "src/c.tsx", `// design-drift-ignore-file color\nconst c = "#ff0000";\n<a className="p-[13px]" />`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 0);
    assert.equal(r.findings.arbitrary.occurrences, 1);
  });
});

test("--skip and --only select detectors", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#ff0000";\n<b className="p-[13px]" />`);
    const skipped = scan(root, "--skip=color");
    assert.equal(skipped.findings.color, undefined);
    assert.ok(skipped.findings.arbitrary);

    const onlyColor = scan(root, "--only=color");
    assert.ok(onlyColor.findings.color);
    assert.equal(onlyColor.findings.arbitrary, undefined);
  });
});

test("a four-digit number reference in a string is not counted as a colour", () => {
  // Regression from a real repo, and the reason its CI ratchet went red: comment
  // stripping handles `// see #1419`, but the same reference inside a STRING
  // survives it, and so does prose in JSX — one audited repo ships its own postal address
  // 46 times ("100 1st Ave N, #2706, St. Petersburg") plus issue references in
  // test titles — 73 phantom "colour" occurrences over 13 values.
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      [
        `describe('demoteEcholessRecognition (#1387)', () => {});`,
        `const addr = "100 1st Ave N, #2706, St. Petersburg, FL 33701";`,
        `export const Legal = () => <p>Suite #2706, see issue #1419</p>;`,
        `const real = "#1a2b";`, // 4-digit WITH a hex letter is a real #RGBA
      ].join("\n"),
    );
    const r = scan(root, "--full");
    const counts = Object.fromEntries(r.findings.color.all.map((v) => [v.value, v.count]));
    for (const phantom of ["#1387", "#2706", "#1419"]) {
      assert.equal(counts[phantom], undefined, `${phantom} must not count as a colour`);
    }
    assert.equal(counts["#1a2b"], 1, "a 4-digit hex with a letter is still a colour");
  });
});

test("three-digit greys stay counted — the numeric-reference rule is length-4 only", () => {
  // The same "all digits, must be a number" rule at length 3 would delete #000,
  // #333 and #666, which are ordinary greys and real drift. Narrowing the rule
  // to length 4 is the whole reason it is safe.
  withTempProject((root) => {
    write(root, "src/a.css", `a{color:#000}b{color:#333}c{color:#666}d{color:#999}`);
    const r = scan(root, "--full");
    assert.equal(r.findings.color.occurrences, 4);
    const counts = Object.fromEntries(r.findings.color.all.map((v) => [v.value, v.count]));
    for (const grey of ["#000", "#333", "#666", "#999"]) {
      assert.equal(counts[grey], 1, `${grey} is a colour, not a reference`);
    }
  });
});

test("a hex-valid word prefix after # is not a colour", () => {
  // Multi-repo validation, 2026-08-07: `/#features` in a URL counted as colour
  // #fea, and Jest's describe("#accessRequests…") counted as #acce — both are
  // hex-valid PREFIXES of ordinary words. A real CSS colour is never followed
  // by a letter, so the trailing boundary rejects them; the same tokens
  // followed by CSS punctuation stay counted.
  withTempProject((root) => {
    write(
      root,
      "src/a.tsx",
      [
        `const nav = { href: "/#features" };`,
        `describe("#accessRequests.create", () => {});`,
        `const real = "#fea";`, // same 3 hex digits, string-delimited: a colour
      ].join("\n"),
    );
    const r = scan(root, "--full");
    const counts = Object.fromEntries(r.findings.color.all.map((v) => [v.value, v.count]));
    assert.equal(counts["#fea"], 1, "the delimited #fea is a colour, counted once — not three times");
    assert.equal(counts["#acce"], undefined, "#acce from a describe title must not count");
    assert.equal(r.findings.color.occurrences, 1);
  });
});

test("next/font variable declarations count as CSS-variable definitions", () => {
  // Next.js's font helpers declare `variable: "--font-sans"` and the framework
  // materializes the definition at runtime. On a stock Next.js app this shape
  // was 2 of 3 reported "unresolved" names — 67% of the orphan finding was
  // false (multi-repo validation, 2026-08-07).
  withTempProject((root) => {
    write(
      root,
      "app/layout.tsx",
      `const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });`,
    );
    write(root, "src/uses.css", `body { font-family: var(--font-sans); } a { color: var(--truly-missing); }`);
    const r = scan(root);
    const names = (r.findings.orphan?.top || []).map((o) => o.name);
    assert.ok(!names.includes("--font-sans"), "--font-sans is defined via next/font");
    assert.ok(names.includes("--truly-missing"), "a genuinely undefined var still reports");
  });
});

test("three single-use values in unrelated contexts do not become a scale", () => {
  // Multi-repo validation, 2026-08-07: text-[10px] (a <kbd> hint), text-[12px]
  // (a blog caption) and text-[80px] (an OG-image title) — three one-offs from
  // three files — proposed a synthetic 11px/80px "scale". The distinct-value
  // floor is 4: three data points spanning three call sites is a coincidence.
  withTempProject((root) => {
    write(root, "src/a.tsx", `<kbd className="text-[10px]" />`);
    write(root, "src/b.tsx", `<p className="text-[12px]" />`);
    write(root, "src/c.tsx", `<h1 className="text-[80px]" />`);
    const r = scan(root);
    const cluster = (r.findings.scale?.clusters || []).find((c) => c.prop === "text");
    assert.equal(cluster, undefined, "3 distinct one-offs must not propose a scale");
  });
});

test("token files yield declaredTokens without moving the drift numbers", () => {
  // The planted negative for #264's wrong implementation: un-excluding token
  // files from the SCANNER would inflate every drift count with declared
  // values — the exact confusion the exclusion exists to prevent. Declarations
  // must surface in declaredTokens AND leave findings.color untouched.
  withTempProject((root) => {
    write(
      root,
      "styles/globals.css",
      [
        `:root {`,
        `  --primary: 222.2 47.4% 11.2%;`, // shadcn bare-HSL triple
        `  --background: 0 0% 100%;`,
        `  --ring: var(--primary);`, // alias — resolves one hop (#276)
        `}`,
        `.dark { --background: 222.2 84% 4.9%; }`, // override: first wins
      ].join("\n"),
    );
    write(root, "theme/theme.ts", `export const colors = { almostBlack: "#111319", brand: '#0366d6' };`);
    write(root, "styles/palette.scss", `$danger: #ed2651;\n$muted: hsl(210, 10%, 50%);`);
    write(
      root,
      "src/app.tsx",
      [
        `const a = "var(--primary)";`,
        `const b = "var(--primary)";`,
        `const c = "var(--primary)";`,
        `const raw = "#123456";`, // own line: TOKEN_CTX suppression is per-line
      ].join("\n"),
    );
    const r = scan(root, "--full");

    // Drift count sees ONLY the raw literal in app source.
    assert.equal(r.findings.color.occurrences, 1, "declared values must not count as drift");

    const byKey = Object.fromEntries(r.findings.declaredTokens.map((d) => [`${d.mode} ${d.name}`, d]));
    assert.equal(byKey["light --primary"].hex, "#0f172a", "shadcn bare-HSL resolves (222.2 47.4% 11.2% = slate-900)");
    assert.equal(byKey["light --background"].hex, "#ffffff");
    // #272: a .dark re-declaration is a SEPARATE dark-mode token now, not an
    // override of the light one — flattening is how the matrix brand got lost.
    assert.equal(byKey["light --background"].overrides, 0, "dark variant is not an override");
    assert.equal(byKey["dark --background"].hex, "#020817", ".dark declaration carries mode:dark, resolved");
    const byName = Object.fromEntries(
      r.findings.declaredTokens.filter((d) => d.mode === "light").map((d) => [d.name, d]),
    );
    assert.equal(byName["--ring"].hex, "#0f172a", "a var() alias resolves one hop same-file (#276)");
    assert.equal(byName["almostBlack"].hex, "#111319", "theme.ts object literal");
    assert.equal(byName["brand"].hex, "#0366d6");
    assert.equal(byName["$danger"].hex, "#ed2651", "SCSS variable");
    assert.equal(byName["$muted"].hex, "#737f8c", "hsl() function value resolves");
    assert.ok(byName["--primary"].refs >= 1, "var(--primary) call sites counted as refs");
  });
});

test("a custom-property-dominated stylesheet is a token file whatever its name (#272)", () => {
  // MakerKit ships the whole shadcn theme as `shadcn-ui.css` — a name matching
  // nothing in TOKEN_FILE. Content decides: dominated by declarations = token
  // file (declarations extracted, nothing counted as drift). The floor is the
  // planted negative: a component stylesheet with a FEW custom props must not
  // flip, or its literals silently leave the drift count.
  withTempProject((root) => {
    const theme = [":root {"];
    for (let i = 0; i < 15; i++) theme.push(`  --tone-${i}: #1${i.toString(16)}2c5${i.toString(16)};`);
    theme.push("}");
    write(root, "styles/shadcn-ui.css", theme.join("\n"));
    const component = ["/* a busy component sheet with a few locals */", ".card {", "  --pad: 4px;", "  --lift: 2px;", "  --tint: #abcdef;"];
    for (let i = 0; i < 40; i++) component.push(`  margin-${i % 2 ? "top" : "left"}: ${i}px;`);
    component.push("  color: #123123;", "}");
    write(root, "src/card.css", component.join("\n"));
    const r = scan(root, "--full");
    const declaredFiles = new Set(r.findings.declaredTokens.map((d) => d.file));
    assert.ok(declaredFiles.has("styles/shadcn-ui.css"), "shadcn-ui.css recognized by content");
    assert.ok(!declaredFiles.has("src/card.css"), "a few locals do not flip a component sheet");
    const values = r.findings.color.all.map((v) => v.value);
    assert.ok(!values.includes("#102c50"), "theme values are not drift");
    assert.ok(values.includes("#123123"), "component literals still count as drift");
  });
});

test("oklch() declarations resolve to sRGB hex (#272)", () => {
  // Anchors are the published OKLCH coordinates of the sRGB primaries; the
  // conversion must land within one RGB step of each.
  withTempProject((root) => {
    write(
      root,
      "styles/theme.css",
      [
        ":root {",
        "  --red: oklch(62.8% 0.25768 29.234);",
        "  --green: oklch(86.64% 0.294827 142.4953);",
        "  --blue: oklch(45.2% 0.31321 264.052);",
        "  --white: oklch(100% 0 0);",
        "  --broken: oklch(banana);",
        "}",
      ].join("\n"),
    );
    const r = scan(root, "--full");
    const byName = Object.fromEntries(r.findings.declaredTokens.map((d) => [d.name, d.hex]));
    const near = (got, want) => {
      const g = parseInt(got.slice(1), 16), w = parseInt(want.slice(1), 16);
      const d = Math.max(
        Math.abs(((g >> 16) & 255) - ((w >> 16) & 255)),
        Math.abs(((g >> 8) & 255) - ((w >> 8) & 255)),
        Math.abs((g & 255) - (w & 255)),
      );
      assert.ok(d <= 1, `${got} not within 1 step of ${want}`);
    };
    near(byName["--red"], "#ff0000");
    near(byName["--green"], "#00ff00");
    near(byName["--blue"], "#0000ff");
    assert.equal(byName["--white"], "#ffffff");
    assert.equal(byName["--broken"], null, "malformed oklch resolves null, not garbage");
  });
});

test("workspace root with a manifest is detected; bare apps/ dir is not (#272)", () => {
  withTempProject((root) => {
    write(root, "pnpm-workspace.yaml", `packages:\n  - "apps/*"\n`);
    write(root, "apps/web/package.json", `{"name":"web"}`);
    write(root, "apps/admin/package.json", `{"name":"admin"}`);
    write(root, "apps/web/src/a.tsx", `const c = "#123456";`);
    const r = scan(root);
    assert.equal(r.findings.workspace.detected, true);
    assert.deepEqual(r.findings.workspace.units.sort(), ["apps/admin", "apps/web"]);
  });
  // The planted negative: directory NAMES must not trigger detection.
  withTempProject((root) => {
    write(root, "apps/web/package.json", `{"name":"web"}`);
    write(root, "apps/web/src/a.tsx", `const c = "#123456";`);
    const r = scan(root);
    assert.equal(r.findings.workspace.detected, false, "apps/ without a workspace manifest is not a workspace");
  });
});

test("test-file colour occurrences count as drift but carry zero shipped weight", () => {
  withTempProject((root) => {
    write(root, "src/real.tsx", `const a = "#ff0000"; const b = "#ff0000";`);
    // NOT "color.test.ts": a test file whose name starts with colour/theme/token
    // words matches TOKEN_FILE and skips the colour detector entirely.
    write(root, "src/auth.test.ts", `expect(x).toBe("#ff0000"); expect(y).toBe("#00ff00");`);
    write(root, "src/__tests__/fixture.ts", `const f = "#00ff00";`);
    const r = scan(root, "--full");
    const byValue = Object.fromEntries(r.findings.color.all.map((v) => [v.value, v]));
    assert.equal(byValue["#ff0000"].count, 3, "drift count includes the test occurrence");
    assert.equal(byValue["#ff0000"].shipped, 2, "shipped excludes it");
    assert.equal(byValue["#00ff00"].count, 2);
    assert.equal(byValue["#00ff00"].shipped, 0, "a test-only colour ships nowhere");
  });
});

test("a css var() alias resolves one hop, same file, mode-aware (#276)", () => {
  // The Tailwind v4 @theme bridge: --color-success: var(--success). Before
  // this, aliases sat at hex null — and an older cross-file merge once
  // backfilled one with ANOTHER app's value, poisoning a recorded design
  // decision. Same-file resolution with a light fallback; never cross-file.
  withTempProject((root) => {
    write(
      root,
      "styles/theme.css",
      [
        ":root {",
        "  --success: #16a249;",
        "  --color-success: var(--success);",
        "  --ghost: var(--never-declared);",
        "}",
        ".dark {",
        "  --success: #39ff14;",
        "  --color-success: var(--success);",
        "  --lonely-dark: var(--only-light);",
        "}",
        ":root { --only-light: #abcdef; }",
      ].join("\n"),
    );
    // A DIFFERENT file declaring the same name the ghost references — must
    // never be used (the planted negative: cross-file resolution rebuilds the
    // poisoning this exists to bury).
    write(root, "styles/other-theme.css", `:root { --never-declared: #ff0000; }`);
    const r = scan(root, "--full");
    const byKey = Object.fromEntries(r.findings.declaredTokens.map((d) => [`${d.mode} ${d.name}`, d]));
    assert.equal(byKey["light --color-success"].hex, "#16a249", "light alias takes the light literal");
    assert.equal(byKey["light --color-success"].raw, "ref:--success");
    assert.equal(byKey["dark --color-success"].hex, "#39ff14", "dark alias prefers the dark literal");
    assert.equal(byKey["light --ghost"].hex, null, "alias to an undeclared var stays null — NEVER cross-file");
    assert.equal(byKey["dark --lonely-dark"].hex, "#abcdef", "dark alias falls back to the :root literal");
  });
});

test("--tighten lowers budgets to actuals and refuses to absorb an increase (#261)", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `const a = "#111111"; const b = "#222222"; const c = "#333333";`);
    write(
      root,
      "ci.yml",
      ["jobs:", "  gate:", "    run: |", "      node scan.mjs . \\", "        --fail-on=color=10,arbitrary=5"].join("\n"),
    );
    const ci = join(root, "ci.yml");
    // Actuals: color=3, arbitrary=0 — both under budget, tighten rewrites.
    const r1 = spawnSync(process.execPath, [scriptPath, root, `--tighten=${ci}`], { encoding: "utf8" });
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(readFileSync(ci, "utf8"), /--fail-on=color=3,arbitrary=0/, "budgets lowered to actuals");
    // Idempotent second run.
    const r2 = spawnSync(process.execPath, [scriptPath, root, `--tighten=${ci}`], { encoding: "utf8" });
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /already tight/);
    // The planted negative: drift ABOVE budget must refuse, file untouched.
    write(root, "src/b.tsx", `const d = "#444444"; const e = "#555555"; const f = "#666666"; const g = "#777777";`);
    const before = readFileSync(ci, "utf8");
    const r3 = spawnSync(process.execPath, [scriptPath, root, `--tighten=${ci}`], { encoding: "utf8" });
    assert.equal(r3.status, 1, "refuses when actual exceeds budget");
    assert.match(r3.stderr, /refused/);
    assert.equal(readFileSync(ci, "utf8"), before, "file untouched on refusal — a ratchet never turns backwards");
  });
});

test("never descends into git worktrees", () => {
  // Regression, found only by running against a real monorepo: worktrees hold a
  // full copy of the repo per branch, so descending into them counts other
  // branches' code as the current tree's and multiplies every total. Unit tests
  // on synthetic fixtures all passed while the tool was unusable in practice.
  withTempProject((root) => {
    write(root, ".claude/worktrees/feat-x/src/a.tsx", `const a = "#ff0000";`);
    write(root, ".worktrees/other/src/b.tsx", `const b = "#ff0000";`);
    write(root, "src/real.tsx", `const c = "#00ff00";`);
    const r = scan(root);
    assert.equal(r.scanned, 1, "only the real source file should be scanned");
    assert.equal(r.findings.color.occurrences, 1);
    assert.equal(r.findings.color.top[0].value, "#00ff00");
  });
});

test("skips node_modules and build output", () => {
  withTempProject((root) => {
    write(root, "node_modules/pkg/index.tsx", `const a = "#ff0000";`);
    write(root, ".next/static/x.js", `const a = "#ff0000";`);
    write(root, "src/a.tsx", `const a = "#00ff00";`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 1);
    assert.equal(r.scanned, 1);
  });
});

test("reports cleanly on a project with no drift", () => {
  withTempProject((root) => {
    write(root, "src/a.tsx", `export const A = () => <div className="p-4 text-sm" />;`);
    const r = scan(root);
    assert.equal(r.findings.color.occurrences, 0);
    assert.equal(r.findings.arbitrary.occurrences, 0);
    assert.equal(r.findings.scale.clusters.length, 0);
    assert.equal(r.findings.nearcolor.pairs.length, 0);
  });
});
