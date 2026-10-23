import { withTempDirectory, write } from "./helpers/fixtures.mjs";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const posturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "posture.mjs");

const withRoot = (run) => withTempDirectory("dd-posture-", run);


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

// Claude Code 2.1.277+ reads AGENTS.md directly when no CLAUDE.md sits on the
// path — so an app that mentions the system in AGENTS.md alone is wired.
test("wired: an AGENTS.md with no CLAUDE.md anywhere on its path loads directly (Claude Code 2.1.277+)", () => {
  withRoot((root) => {
    seedWorkspace(root);
    rmSync(join(root, "apps/healthy/CLAUDE.md"));
    const d = JSON.parse(posture(root).stdout);
    const healthy = d.results.find((x) => x.app === "apps/healthy");
    const wired = healthy.rows.find((r) => r.check === "wired");
    assert.equal(wired.pass, true);
    assert.match(wired.note, /loads AGENTS\.md directly/);
  });
});

// The user-scope ~/.claude/CLAUDE.md sits on the walk for every repo under
// $HOME, and Claude Code exempts it. Without the exemption the pass path above
// is reachable only from /tmp fixtures.
test("wired: the user-scope ~/.claude/CLAUDE.md is not a blocker for a repo under HOME", () => {
  withRoot((home) => {
    write(home, ".claude/CLAUDE.md", "# personal rules\n");
    const root = join(home, "SITES", "repo");
    seedWorkspace(root);
    rmSync(join(root, "apps/healthy/CLAUDE.md"));
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync(process.execPath, [posturePath, root, "--json"], { encoding: "utf8", env });
    const d = JSON.parse(r.stdout);
    const healthy = d.results.find((x) => x.app === "apps/healthy");
    const wired = healthy.rows.find((r) => r.check === "wired");
    assert.equal(wired.pass, true, wired.note);
    // ...while a real ancestor CLAUDE.md in that same HOME still blocks.
    write(home, "CLAUDE.md", "@AGENTS.md\n");
    const r2 = spawnSync(process.execPath, [posturePath, root, "--json"], { encoding: "utf8", env });
    const wired2 = JSON.parse(r2.stdout).results.find((x) => x.app === "apps/healthy").rows.find((x) => x.check === "wired");
    assert.equal(wired2.pass, false);
    assert.match(wired2.note, /never loads/);
  });
});

// The planted negative from a real monorepo: the same app under a stub-pair
// root (CLAUDE.md = "@AGENTS.md") differs ONLY in the ancestor file, and now
// the engine attaches only nested files named CLAUDE.md — the app's AGENTS.md
// is dead content. An implementation that merely checks "AGENTS.md exists"
// passes both cases above and fails this one.
test("wired: an ancestor CLAUDE.md keeps Claude on the CLAUDE.md path, so an unstubbed nested AGENTS.md never loads", () => {
  withRoot((root) => {
    seedWorkspace(root);
    rmSync(join(root, "apps/healthy/CLAUDE.md"));
    write(root, "CLAUDE.md", "@AGENTS.md\n");
    const d = JSON.parse(posture(root).stdout);
    const healthy = d.results.find((x) => x.app === "apps/healthy");
    const wired = healthy.rows.find((r) => r.check === "wired");
    assert.equal(wired.pass, false);
    assert.match(wired.note, /never loads/);
    assert.match(wired.note, /CLAUDE\.md/);
  });
});

test("multi-brand posture: blend-suspect fails, brand rows judge each system (#9)", () => {
  const SHELL_DESIGN = `---\nname: "shell"\ncolors:\n  surface.canvas: "#0f0d15"\n---\n\n## Overview\nshell only\n`;
  withRoot((root) => {
    seedWorkspace(root);
    write(root, "apps/healthy/design/brands.json", JSON.stringify({
      neo: { surfaces: ["src/neo"], system: "design/neo/DESIGN.md" },
      ttr: { surfaces: ["src/shared/TtrHero.tsx"], system: null },
    }));
    // App-level file still claims a primary -> the funnels blend, caught.
    let d = JSON.parse(posture(root).stdout);
    let healthy = d.results.find((x) => x.app === "apps/healthy");
    const brandsRow = healthy.rows.find((r) => r.check === "brands");
    assert.equal(brandsRow.pass, false);
    assert.match(brandsRow.note, /one brand crowned over the others/);
    // Shell-only app file + derived, referenced brand system -> all green.
    write(root, "apps/healthy/design/DESIGN.md", SHELL_DESIGN);
    write(root, "apps/healthy/design/neo/DESIGN.md", GOOD_DESIGN);
    write(root, "apps/healthy/design/README.md", "registry: design/neo/DESIGN.md is neo's system\n");
    d = JSON.parse(posture(root).stdout);
    healthy = d.results.find((x) => x.app === "apps/healthy");
    assert.equal(healthy.rows.find((r) => r.check === "brands").pass, true);
    assert.equal(healthy.rows.find((r) => r.check === "brand:neo").pass, true);
    const ttr = healthy.rows.find((r) => r.check === "brand:ttr");
    assert.equal(ttr.pass, null, "registered-underived is INFO, not failure");
    assert.match(ttr.note, /registered, underived/);
    // An unreferenced brand system is unreachable -> that brand fails.
    write(root, "apps/healthy/design/README.md", "registry mentions nothing\n");
    d = JSON.parse(posture(root).stdout);
    healthy = d.results.find((x) => x.app === "apps/healthy");
    const neo = healthy.rows.find((r) => r.check === "brand:neo");
    assert.equal(neo.pass, false);
    assert.match(neo.note, /unreachable/);
  });
});

test("@brand budget keys without a parent floor get flagged in enforced (adversarial)", () => {
  withRoot((root) => {
    seedWorkspace(root);
    write(root, "apps/healthy/design/brands.json", JSON.stringify({
      neo: { surfaces: ["styles"], system: null },
    }));
    write(root, ".github/workflows/design.yml",
      "run: node scan.mjs . --fail-on=color=10,apps/healthy@neo:color=5\n");
    let d = JSON.parse(posture(root).stdout);
    let healthy = d.results.find((x) => x.app === "apps/healthy");
    assert.match(healthy.rows.find((r) => r.check === "enforced").note, /no apps\/healthy:<detector> parent floor/);
    // With the floor present, no flag.
    write(root, ".github/workflows/design.yml",
      "run: node scan.mjs . --fail-on=color=10,apps/healthy:color=8,apps/healthy@neo:color=5\n");
    d = JSON.parse(posture(root).stdout);
    healthy = d.results.find((x) => x.app === "apps/healthy");
    const note = healthy.rows.find((r) => r.check === "enforced").note;
    assert.doesNotMatch(note, /parent floor/);
  });
});
