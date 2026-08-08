import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json and plugin.json versions move in lockstep (#3)", () => {
  // v0.1.1 shipped with plugin.json 0.1.1 and package.json 0.1.0 — a release
  // PR bumped one and not the other, and nothing failed. This is that check.
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(repo, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(
    pkg.version,
    plugin.version,
    `package.json ${pkg.version} != plugin.json ${plugin.version} — bump both in the release PR`,
  );
});
