import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { forwardableText, forwardTexts } from "../lib/forwarding.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("forwarding messages", () => {
  it("forwards a message's words, never a file, a picture or a notice", () => {
    assert.equal(forwardableText({ id: "a", message: "hello there" }), "hello there");
    assert.equal(forwardableText({ id: "b", message: "hyper://abc/photo.png", fileName: "photo.png", fileEnc: true }), null);
    assert.equal(forwardableText({ id: "c", message: "hyper://abc/old.pdf", fileName: "old.pdf" }), null);
    assert.equal(forwardableText({ id: "d", type: "system", text: "Bob joined" }), null);
    assert.equal(forwardableText({ id: "e", message: "   " }), null);
    assert.equal(forwardableText(null), null);
  });

  it("sends the picked messages in the order they were written", () => {
    const messages = [
      { id: "late", message: "second", timestamp: 20 },
      { id: "file", message: "hyper://x/a.png", fileName: "a.png", timestamp: 5 },
      { id: "early", message: "first", timestamp: 10 },
      { id: "unpicked", message: "not this", timestamp: 1 },
    ];
    assert.deepEqual(forwardTexts(messages, new Set(["late", "early", "file", "gone"])), ["first", "second"]);
    assert.deepEqual(forwardTexts(undefined, new Set(["a"])), []);
  });

  it("marks a forwarded message on the way out, keeps the mark from peers, and shows it", async () => {
    const p2p = await read("p2p.js");
    assert.match(p2p, /const forwarded = body\.forwarded === true;/);
    assert.match(p2p, /\.\.\.\(forwarded && \{ fwd: true \}\),\n {8}\};/);
    assert.match(p2p, /\.\.\.\(forwarded && \{ forwarded: true \}\),/);
    // Synced history and live messages from a peer both keep it.
    assert.equal(p2p.match(/\.\.\.\(msg\.fwd === true && \{ fwd: true \}\),/g)?.length, 2);
    assert.match(p2p, /if \(entry\.fwd === true\) out\.forwarded = true;/);

    const app = await read("app.js");
    assert.match(app, /if \(msg\.forwarded\) \{\s+const forwarded = document\.createElement\("div"\);\s+forwarded\.className = "msg-forwarded";\s+forwarded\.textContent = "Forwarded";/);
    assert.match(app, /chat\.sendMessage\(targetRoomKey, \{ message: text, forwarded: true \}\)/);
    assert.match(app, /if \(action === "select"\) startSelecting\(msg\);/);

    const html = await read("index.html");
    assert.match(html, /<button data-action="select">Select<\/button>/);
    assert.match(html, /<div id="forward-modal" class="modal">/);
    assert.match(html, /<button type="button" id="select-forward" class="btn-sm" disabled>Forward<\/button>/);
    const css = await read("styles.css");
    assert.match(css, /\.msg-forwarded \{\s+font-style: italic;/);
  });
});
