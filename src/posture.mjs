#!/usr/bin/env node
/*
  design-drift posture — dependency-free (#272 checklist, executable form).

  The product question, as a pass/fail table: is this codebase's design-system
  posture right? Five checks per app:

    exists    design/DESIGN.md at APP scope (a monorepo-root system is a FAIL:
              a blend is a system no app owns)
    valid     frontmatter carries real colour tokens (structural; the official
              `designmd lint` is the deeper manual pass — remember it scores an
              EMPTY frontmatter clean, which is why this check exists at all)
    wired     the app's agent instructions name design/DESIGN.md, and CLAUDE.md
              exists so Claude Code loads them (@AGENTS.md pointer counts) — a
              DESIGN.md no agent reads is inert; that exact miss survived two
              days of tooling work on the repo that motivated this tool
    followed  INFO: the app's current raw-colour / palette-utility counts —
              the trend line migrations move
    enforced  a CI workflow runs the scanner with --fail-on budgets

  At a workspace root (manifest-detected) every unit with UI files is checked;
  a single app dir is checked alone. Exit 1 if any app FAILs a non-INFO check.

  Usage:
    node posture.mjs <app-or-workspace-root> [--json]
*/

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith("-")) || ".");
const asJson = args.includes("--json");

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

function workspaceUnits(r) {
  const manifest =
    existsSync(join(r, "pnpm-workspace.yaml")) ||
    existsSync(join(r, "turbo.json")) ||
    existsSync(join(r, "lerna.json"));
  if (!manifest) return null;
  const units = [];
  const appsDir = join(r, "apps");
  if (existsSync(appsDir)) {
    for (const e of readdirSync(appsDir, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(appsDir, e.name, "package.json"))) units.push(join(appsDir, e.name));
    }
  }
  return units;
}

/** UI-bearing = has a styles dir or any .tsx source; a pure API/worker app is
 *  exempt from design posture rather than failed for lacking a system. */
function bearsUi(app) {
  if (existsSync(join(app, "styles"))) return true;
  const stack = ["components", "app", "src"].map((d) => join(app, d)).filter(existsSync);
  let depth = 0;
  while (stack.length && depth < 4000) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      depth++;
      if (e.isFile() && e.name.endsWith(".tsx")) return true;
      if (e.isDirectory() && e.name !== "node_modules") stack.push(join(dir, e.name));
    }
  }
  return false;
}

function checkApp(app, repoRoot) {
  const rows = [];
  const designMd = join(app, "design", "DESIGN.md");
  const exists = existsSync(designMd);
  rows.push({ check: "exists", pass: exists, note: exists ? "design/DESIGN.md" : "no design/DESIGN.md — derive with propose.mjs" });

  let valid = false;
  if (exists) {
    const md = read(designMd) || "";
    const fm = md.split("\n---\n")[0];
    const colorLines = [...fm.matchAll(/^ {2}[a-z0-9.-]+: "#[0-9a-fA-F]{6}"$/gm)];
    valid = /^colors:$/m.test(fm) && colorLines.length >= 1;
  }
  rows.push({
    check: "valid",
    pass: valid,
    note: valid
      ? "frontmatter carries colour tokens"
      : exists
        ? "frontmatter has no colour tokens (the lint-clean-but-empty trap)"
        : "n/a — no file",
  });

  const agents = read(join(app, "AGENTS.md")) || "";
  const claudeMd = read(join(app, "CLAUDE.md"));
  const mentions = /design\/DESIGN\.md/.test(agents) || /design\/DESIGN\.md/.test(claudeMd || "");
  const claudeLoads = claudeMd !== null;
  const wired = mentions && claudeLoads;
  rows.push({
    check: "wired",
    pass: wired,
    note: wired
      ? "AGENTS.md names it; CLAUDE.md present"
      : !mentions
        ? "agent instructions never mention design/DESIGN.md — the file is inert"
        : "no CLAUDE.md — Claude Code will not load the instructions (add an @AGENTS.md pointer)",
  });

  // Brand scopes (#9): an app with design/brands.json is a multi-brand
  // surface, and its posture is judged per brand. The check that would have
  // caught the original blend: a brands registry alongside an app-level
  // DESIGN.md that still claims a `primary` is one brand crowned over the
  // others — the app file's job is the shared shell.
  const brandsPath = join(app, "design", "brands.json");
  if (existsSync(brandsPath)) {
    let brands = null;
    try {
      brands = JSON.parse(read(brandsPath) || "");
    } catch {
      rows.push({ check: "brands", pass: false, note: "design/brands.json is not valid JSON — a broken registry fences nothing" });
    }
    if (brands) {
      const appFm = exists ? (read(designMd) || "").split("\n---\n")[0] : "";
      const claimsBrand = /^ {2}(primary|action\.primary):/m.test(appFm);
      rows.push({
        check: "brands",
        pass: !claimsBrand,
        note: claimsBrand
          ? `brands.json declares ${Object.keys(brands).length} brands but the app-level DESIGN.md still claims a primary — one brand crowned over the others; keep the app file to shared shell`
          : `${Object.keys(brands).length} brands registered; app-level file is shell-only`,
      });
      for (const [name, b] of Object.entries(brands)) {
        if (b.system === null) {
          rows.push({ check: `brand:${name}`, pass: null, note: "registered, underived — colours attributed; derive when its page ships" });
          continue;
        }
        const sysPath = join(app, b.system);
        const sysExists = existsSync(sysPath);
        const sysFm = sysExists ? (read(sysPath) || "").split("\n---\n")[0] : "";
        const sysValid = /^colors:$/m.test(sysFm) && /^ {2}[a-z0-9.-]+: "#[0-9a-fA-F]{6}"$/m.test(sysFm);
        const sysMentioned = agents.includes(b.system) || (read(join(app, "design", "README.md")) || "").includes(b.system);
        const pass = sysExists && sysValid && sysMentioned;
        rows.push({
          check: `brand:${name}`,
          pass,
          note: pass
            ? b.system
            : !sysExists
              ? `${b.system} missing — derive it`
              : !sysValid
                ? `${b.system} has no colour tokens in frontmatter`
                : `${b.system} not referenced by AGENTS.md or design/README.md — unreachable`,
        });
      }
    }
  }

  // INFO: current drift counts, app-scoped.
  const scan = spawnSync(process.execPath, [join(__dirname, "scan.mjs"), app, "--json", "--only=color,palette"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let followedNote = "scan failed";
  if (scan.status === 0) {
    try {
      const f = JSON.parse(scan.stdout).findings;
      followedNote = `raw colours ${f.color?.occurrences ?? "?"}, palette utilities ${f.palette?.occurrences ?? "?"} — the trend migrations move`;
    } catch {}
  }
  rows.push({ check: "followed", pass: null, note: followedNote });

  let enforced = false;
  let enforcedNote = "no workflow runs the scanner with --fail-on";
  const relApp = relative(repoRoot, app).split(sep).join("/");
  const wfDir = join(repoRoot, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const e of readdirSync(wfDir)) {
      const wf = read(join(wfDir, e)) || "";
      // The scanner is invoked either as a file (`node …/scan.mjs`) or as the
      // packaged verb (`npx github:…/design-rails#<pin>" scan`, `design-rails
      // scan`). Requiring the literal `scan.mjs` made posture report its OWN
      // gate as missing the moment a repo switched to the pinned-npx form —
      // found by dogfooding the v0.2.0 switch on the reference monorepo.
      const runsScanner = /scan\.mjs/.test(wf) || /design-rails[^\n]*\bscan\b/.test(wf);
      if (runsScanner && /--fail-on=/.test(wf)) {
        enforced = true;
        enforcedNote = "CI runs the scanner with budgets";
        // @brand keys resolve their scope through brands.json — a file a
        // later PR can quietly narrow. A plain parent floor for the app
        // (apps/x:color=N, its scope a literal string in the reviewed CI
        // file) bounds that move, so brand keys WITHOUT one get flagged.
        if (relApp && wf.includes(`${relApp}@`) && !wf.includes(`${relApp}:`)) {
          enforcedNote +=
            ` — but @brand keys for ${relApp} have no ${relApp}:<detector> parent floor;` +
            " a narrowed brands.json would un-fence them silently";
        }
        break;
      }
    }
  }
  rows.push({
    check: "enforced",
    pass: enforced,
    note: enforcedNote,
  });
  return rows;
}

const units = workspaceUnits(root);
const results = [];
if (units) {
  // A system at the WORKSPACE root is the blend no app owns.
  if (existsSync(join(root, "design", "DESIGN.md"))) {
    results.push({
      app: ".",
      rows: [{ check: "exists", pass: false, note: "root design/DESIGN.md is a blended system no app owns — delete it, go per-app" }],
    });
  }
  for (const u of units) {
    if (!bearsUi(u)) continue;
    results.push({ app: u.slice(root.length + 1), rows: checkApp(u, root) });
  }
} else {
  // Single app: the enforcing repo root may be above; walk up to a .git.
  let repoRoot = root;
  while (repoRoot !== "/" && !existsSync(join(repoRoot, ".git"))) repoRoot = dirname(repoRoot);
  results.push({ app: ".", rows: checkApp(root, repoRoot) });
}

let failed = false;
for (const r of results) {
  for (const row of r.rows) if (row.pass === false) failed = true;
}

if (asJson) {
  console.log(JSON.stringify({ root, results, failed }, null, 2));
} else {
  for (const r of results) {
    console.log(`\n${r.app}`);
    for (const row of r.rows) {
      const mark = row.pass === null ? "·" : row.pass ? "✓" : "✗";
      console.log(`  ${mark} ${row.check.padEnd(9)} ${row.note}`);
    }
  }
  console.log(failed ? "\nposture: FAIL — fix the ✗ rows above" : "\nposture: PASS");
}
process.exit(failed ? 1 : 0);
