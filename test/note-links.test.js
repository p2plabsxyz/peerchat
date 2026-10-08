// A P2PMD note is shared as hs://<key>. The phone made it a link; desktop left
// it as plain text, to be copied out by hand.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const linkify = app.slice(app.indexOf("function linkifyLine(text) {"), app.indexOf("function codeBlockHtml("));
const pattern = new RegExp(linkify.match(/const re = \/(.+)\/gi;/)[1], "gi");

describe("a note's link in a message", () => {
  it("is a link like the other addresses", () => {
    const key = "hs://s000" + "a1".repeat(32);
    assert.deepEqual(`open ${key} to edit`.match(pattern), [key]);
    assert.deepEqual("see hyper://abc and https://example.com".match(pattern), ["hyper://abc", "https://example.com"]);
  });
});
