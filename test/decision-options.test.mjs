import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const decidePath = fileURLToPath(new URL("../src/decide.mjs", import.meta.url));

for (const palette of [false, true]) {
  test(`individual and index option cards agree byte-for-byte (palette=${palette})`, () => {
    const root = mkdtempSync(join(tmpdir(), "dr-options-"));
    try {
      mkdirSync(join(root, "design", "tokens"), { recursive: true });
      if (palette) {
        writeFileSync(join(root, "design", "tokens", "color.json"), JSON.stringify({
          primitive: {
            canvas: { $value: "#ffffff" },
            ink: { $value: "#182c56" },
            "ink-mute": { $value: "#65758b" },
            brand: { $value: "#f73e49" },
          },
        }));
      }
      writeFileSync(join(root, "design", "REVIEW.md"), [
        "### Decision: chart [open]",
        "Kind: chart",
        "Recommend: ramp — show the brand",
        "- **Option ramp:** #abc then #4466dd <chart> & contrast",
        "- **Option plain:** #8884d8",
        "### Decision: muted [open]",
        "Role: ink-mute",
        "Recommend: keep — retain measured contrast",
        "- **Option change:** #6f7592",
        "- **Option keep:** #65758b <body> & copy",
        "### Decision: empty [open]",
        "- **Option text:** no colour <tag> & text",
      ].join("\n"));
      const result = spawnSync(process.execPath, [decidePath, root], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const output = join(root, "design", "decisions");
      const cards = (html) => [...html.matchAll(/<section class="option(?: recommended)?">[\s\S]*?<\/section>/g)].map((m) => m[0]);
      const indexCards = cards(readFileSync(join(output, "index.html"), "utf8"));
      const pages = ["chart", "muted", "empty"].map((slug) => readFileSync(join(output, `${slug}.html`), "utf8"));
      assert.deepEqual(indexCards, pages.flatMap(cards));
      assert.equal(indexCards.length, 5);
      assert.equal(indexCards.filter((card) => card.includes('class="option recommended"')).length, 2);
      assert.equal(indexCards.filter((card) => card.includes('aria-label="sample chart"')).length, 2);
      assert.match(indexCards[0], /&lt;chart&gt; &amp; contrast/);
      assert.match(indexCards[3], /&lt;body&gt; &amp; copy/);
      assert.match(indexCards[4], /no colour &lt;tag&gt; &amp; text/);
      if (palette) {
        assert.match(indexCards[2], /contrast on canvas 4\.53:1/);
        assert.match(indexCards[3], /contrast on canvas 4\.70:1/);
      } else {
        assert.match(indexCards[2], /candidate colour/);
        assert.doesNotMatch(indexCards.join(""), /contrast on canvas/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
