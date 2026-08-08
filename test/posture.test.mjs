import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const posturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "posture.mjs");

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "dd-posture-"));
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

const posture = (root, ...flags) =>
  spawnSync(process.execPath, [posturePath, root, "--json", ...flags], { encoding: "utf8" });

const GOOD_DESIGN = `---\nname: "x"\ncolors:\n  primary: "#182c56"\n---\n\n## Overview\nok\n`;

function seedWorkspace(root) {
  write(root, "pnpm-workspace.yaml", `packages:\n  - "apps/*"\n`);
  // healthy: system + wiring + UI
  write(root, "apps/healthy/package.json", `{"name":"healthy"}`);
  write(root, "apps/healthy/styles/x.css", `.a{}`);
  write(root, "apps/healthy/design/DESIGN.md", GOOD_DESIGN);
  write(root, "apps/healthy/AGENTS.md", "## Design system\nRead design/DESIGN.md first.\n");
  write(root, "apps/healthy/CLAUDE.md", "@AGENTS.md\n");
  // naked: UI, no system, no wiring
  write(root, "apps/naked/package.json", `{"name":"naked"}`);
  write(root, "apps/naked/components/a.tsx", `export const A = () => <a className="text-blue-600" />;`);
  write(root, "apps/naked/AGENTS.md", "no design here\n");
  // api-only: no UI — exempt entirely
  write(root, "apps/api-only/package.json", `{"name":"api"}`);
  write(root, "apps/api-only/src/server.ts", `export {};`);
  // enforcement at repo root
  write(root, ".github/workflows/design.yml", "run: node scan.mjs . --fail-on=color=10\n");
}

test("workspace posture: healthy passes, naked fails the right rows, api-only is exempt", () => {
  withRoot((root) => {
    seedWorkspace(root);
    const r = posture(root);
    assert.equal(r.status, 1, "one failing app fails the run");
    const d = JSON.parse(r.stdout);
    const apps = Object.fromEntries(d.results.map((x) => [x.app, Object.fromEntries(x.rows.map((row) => [row.check, row]))]));

    assert.ok(apps["apps/healthy"], "healthy app checked");
    for (const c of ["exists", "valid", "wired", "enforced"]) {
      assert.equal(apps["apps/healthy"][c].pass, true, `healthy ${c}`);
    }
    assert.equal(apps["apps/healthy"].followed.pass, null, "followed is INFO, never pass/fail");

    assert.equal(apps["apps/naked"].exists.pass, false);
    assert.equal(apps["apps/naked"].wired.pass, false);
    assert.match(apps["apps/naked"].wired.note, /inert/, "the wired failure explains the stake");

    assert.ok(!apps["apps/api-only"], "an app with no UI is exempt, not failed");
  });
});

test("enforced recognizes the pinned-npx invocation, not just scan.mjs", () => {
  // Found by dogfooding: the reference monorepo switched its gate to
  // `npx github:…design-rails#<sha>" scan . --fail-on=…` and posture reported
  // every app unenforced — the tool called its own gate missing.
  withRoot((root) => {
    seedWorkspace(root);
    write(
      root,
      ".github/workflows/design.yml",
      [
        "env:",
        "  DESIGN_RAILS_REF: 0123456789abcdef0123456789abcdef01234567",
        "run: |",
        '  npx -y "github:StartupBros-com/design-rails#${DESIGN_RAILS_REF}" scan . \\',
        "    --fail-on=color=10",
      ].join("\n"),
    );
    const d = JSON.parse(posture(root).stdout);
    const healthy = d.results.find((x) => x.app === "apps/healthy");
    assert.equal(healthy.rows.find((r) => r.check === "enforced").pass, true);
  });
});

test("a design-rails mention without a scan verb is not enforcement", () => {
  withRoot((root) => {
    seedWorkspace(root);
    write(
      root,
      ".github/workflows/design.yml",
      "run: echo design-rails is great # --fail-on=color=10 in prose\n",
    );
    const d = JSON.parse(posture(root).stdout);
    const healthy = d.results.find((x) => x.app === "apps/healthy");
    assert.equal(healthy.rows.find((r) => r.check === "enforced").pass, false);
  });
});

test("a root-level blend is itself a posture failure at a workspace root", () => {
  withRoot((root) => {
    seedWorkspace(root);
    write(root, "design/DESIGN.md", GOOD_DESIGN);
    const d = JSON.parse(posture(root).stdout);
    const rootResult = d.results.find((x) => x.app === ".");
    assert.ok(rootResult, "root checked");
    assert.equal(rootResult.rows[0].pass, false);
    assert.match(rootResult.rows[0].note, /no app owns/);
  });
});

test("the empty-frontmatter trap fails valid even when the file exists", () => {
  withRoot((root) => {
    seedWorkspace(root);
    write(root, "apps/healthy/design/DESIGN.md", `---\nname: "x"\n---\n\n## Overview\nprose only\n`);
    const d = JSON.parse(posture(root).stdout);
    const healthy = d.results.find((x) => x.app === "apps/healthy");
    const valid = healthy.rows.find((r) => r.check === "valid");
    assert.equal(valid.pass, false);
    assert.match(valid.note, /lint-clean-but-empty/);
  });
});

test("wired requires BOTH the mention and a CLAUDE.md for Claude Code to load", () => {
  withRoot((root) => {
    seedWorkspace(root);
    rmSync(join(root, "apps/healthy/CLAUDE.md"));
    const d = JSON.parse(posture(root).stdout);
    const healthy = d.results.find((x) => x.app === "apps/healthy");
    const wired = healthy.rows.find((r) => r.check === "wired");
    assert.equal(wired.pass, false);
    assert.match(wired.note, /no CLAUDE\.md/);
  });
});
