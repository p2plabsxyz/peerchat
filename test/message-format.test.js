import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { applyInlineFormatting, readHeading, splitCodeFences } from "../lib/message-format.js";

describe("message formatting", () => {
  it("splits fenced code from prose, dropping the language name", () => {
    assert.deepEqual(splitCodeFences("look:\n```js\nconst a = 1\n  return a\n```\nthen"), [
      { code: false, text: "look:" },
      { code: true, text: "const a = 1\n  return a" },
      { code: false, text: "then" }
    ]);
    // Unclosed, it stays as typed.
    assert.deepEqual(splitCodeFences("a ``` b"), [{ code: false, text: "a ``` b" }]);
  });

  it("reads #, ## and ### as headings, and nothing else", () => {
    assert.deepEqual(readHeading("# One"), { level: 1, text: "One" });
    assert.deepEqual(readHeading("### Three"), { level: 3, text: "Three" });
    assert.equal(readHeading("#### Four").level, 0);
    assert.equal(readHeading("#hashtag").level, 0);
  });

  it("formats bold, both italics and strikethrough", () => {
    assert.equal(
      applyInlineFormatting("**b** *i* _u_ ~s~"),
      "<strong>b</strong> <em>i</em> <em>u</em> <del>s</del>"
    );
  });

  it("reads nothing inside code, and marks the code as copyable", () => {
    assert.equal(
      applyInlineFormatting("`**c**`"),
      '<code class="msg-inline-code" title="Click to copy">**c**</code>'
    );
  });

  // Stray marks are everywhere in plain writing: sums, file names, footnotes.
  it("leaves marks that do not pair, or sit inside a word, as they are", () => {
    assert.equal(applyInlineFormatting("snake_case_name, 5 * 3 * 2, and a*b"), "snake_case_name, 5 * 3 * 2, and a*b");
  });

  it("wires copying and keeps closing marks out of links", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /textNode\.innerHTML = linkify\(msg\.message, msg\);\s+wireCodeCopy\(textNode\);/);
    assert.match(app, /const url = m\[0\]\.replace\(\/\[\.,;:!\?'"\*~\]\+\$\/, ""\) \|\| m\[0\];/);
  });
});
