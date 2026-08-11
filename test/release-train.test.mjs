import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const hardenedSha = "08f7d22f3a5b59b1658ab2e96a20d0d3c352869c";
const retiredSha = "c981b872ebf650805200ad72c8b7142232f8b3f6";
const expectedWorkflow = `name: Release train

# Announce-only Tool Drop train, shared across the whole hov catalog.
# All logic lives in hov-marketplace (the catalog announces itself);
# identity is the workflow's OIDC token — no shared secret, no per-repo
# scoping. Bump the pin when the reusable workflow changes.

on:
  release:
    types: [published, edited]

permissions:
  contents: read
  id-token: write

jobs:
  announce:
    uses: StartupBros-com/hov-marketplace/.github/workflows/hov-tool-drop-announce.yml@${hardenedSha} # fix: bind Tool Drop intent to the promoted release
`;

function validateReleaseTrain(workflow) {
  assert.equal(
    workflow,
    expectedWorkflow,
    "release train must exactly match the hardened Tool Drop policy",
  );
}

test("checked-in release train is the canonical hardened policy", () => {
  const workflow = readFileSync(join(repo, ".github/workflows/release-train.yml"), "utf8");
  validateReleaseTrain(workflow);
});

test("retired Tool Drop workflow pin is rejected", () => {
  const retired = expectedWorkflow.replace(hardenedSha, retiredSha);
  assert.throws(() => validateReleaseTrain(retired), /exactly match/);
});

test("a blessed-pin decoy cannot hide a wrong announce target", () => {
  const decoy = expectedWorkflow.replace(
    "jobs:\n  announce:\n    uses: StartupBros-com/",
    `jobs:\n  decoy:\n    # blessed pin @${hardenedSha}\n` +
      `    uses: StartupBros-com/hov-marketplace/.github/workflows/hov-tool-drop-announce.yml@${hardenedSha}\n` +
      "  announce:\n    uses: attacker/",
  );
  assert.match(decoy, new RegExp(hardenedSha));
  assert.match(decoy, /jobs:\n  decoy:/);
  assert.match(decoy, /\n  announce:\n    uses: attacker\//);
  assert.throws(() => validateReleaseTrain(decoy), /exactly match/);
});
