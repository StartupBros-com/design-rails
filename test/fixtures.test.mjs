import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";

import { withTempDirectory, write } from "./helpers/fixtures.mjs";

for (const prefix of ["dd-decide-", "dd-posture-", "dd-propose-", "design-drift-"]) {
  test(`temporary fixture preserves ${prefix} prefix, result and recursive cleanup`, () => {
    let root;
    const result = {};
    assert.equal(withTempDirectory(prefix, (directory) => {
      root = directory;
      assert.ok(basename(root).startsWith(prefix));
      assert.equal(write(root, "nested/fixture.txt", "original"), undefined);
      write(root, "nested/fixture.txt", "replacement µ");
      assert.equal(readFileSync(join(root, "nested/fixture.txt"), "utf8"), "replacement µ");
      write(root, "nested/bytes.bin", Buffer.from([0, 255, 10]));
      assert.deepEqual(readFileSync(join(root, "nested/bytes.bin")), Buffer.from([0, 255, 10]));
      return result;
    }), result);
    assert.equal(existsSync(root), false);
  });
}

test("callback exception identity survives recursive cleanup", () => {
  let root;
  const failure = new Error("fixture failure");
  assert.throws(() => withTempDirectory("dd-error-", (directory) => {
    root = directory;
    write(root, "nested/fixture.txt", "created before failure");
    throw failure;
  }), (error) => error === failure);
  assert.equal(existsSync(root), false);
});

test("Promise results do not defer the synchronous cleanup contract", async () => {
  let root;
  const result = Promise.resolve("done");
  const returned = withTempDirectory("dd-promise-", (directory) => {
    root = directory;
    return result;
  });
  assert.equal(returned, result);
  assert.equal(existsSync(root), false);
  assert.equal(await returned, "done");
});

test("write failures propagate and the temporary directory is still removed", () => {
  let root;
  assert.throws(() => withTempDirectory("dd-write-error-", (directory) => {
    root = directory;
    write(root, "file", "not a directory");
    write(root, "file/child", "cannot write");
  }));
  assert.equal(existsSync(root), false);
});
