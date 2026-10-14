import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  forwardableFile,
  forwardableText,
  forwardGapMs,
  forwardItems,
  forwardTexts,
  isForwardable,
} from "../lib/forwarding.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("forwarding messages", () => {
  it("forwards a message's words as text, never a file's link or a notice", () => {
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

  it("forwards a file or picture too, with the key it was sealed with", () => {
    const picture = { id: "p", message: "hyper://abc/photo", fileName: "photo.png", fileSize: 9, fileEnc: true, fileKey: "k".repeat(64) };
    assert.deepEqual(forwardableFile(picture), { url: "hyper://abc/photo", fileName: "photo.png", fileSize: 9, fileKey: "k".repeat(64), roomKey: "" });
    // From a room before it moved, sealed with that room's key.
    assert.equal(forwardableFile({ ...picture, fileKey: undefined, roomKey: "r".repeat(64) }).roomKey, "r".repeat(64));
    assert.equal(forwardableFile({ id: "o", message: "hyper://abc/old.pdf", fileName: "old.pdf" }), null);
    assert.equal(forwardableFile({ id: "n", type: "system", text: "Bob joined" }), null);
    assert.ok(isForwardable(picture));
    assert.ok(isForwardable({ id: "t", message: "hello" }));
    assert.equal(isForwardable({ id: "n", type: "system", text: "Bob joined" }), false);
  });

  it("forwards words and files in the order they were written", () => {
    const messages = [
      { id: "late", message: "second", timestamp: 20 },
      { id: "file", message: "hyper://x/a", fileName: "a.png", fileEnc: true, timestamp: 15 },
      { id: "early", message: "first", timestamp: 10 },
      { id: "notice", type: "system", text: "Bob joined", timestamp: 12 },
    ];
    assert.deepEqual(forwardItems(messages, new Set(["late", "file", "early", "notice"])).map((item) => item.text || item.file.fileName), ["first", "a.png", "second"]);
  });

  it("spaces forwarded messages out under the chat's spam limit", () => {
    // The limit counts over ten seconds; two short of it leaves room to type.
    assert.equal(forwardGapMs(10), 1250);
    assert.equal(forwardGapMs(5), 3334);
    assert.equal(forwardGapMs(15), 770);
    assert.equal(forwardGapMs(2), 10000);
    assert.equal(forwardGapMs(undefined), 1250);
    for (const limit of [3, 5, 10, 15, 50]) {
      // Sent this far apart, any ten seconds holds fewer than the limit.
      assert.ok(Math.floor(10_000 / forwardGapMs(limit)) + 1 < limit);
    }
  });

  it("marks a forwarded message on the way out, keeps the mark from peers, and shows it", async () => {
    const p2p = await read("p2p.js");
    assert.match(p2p, /const forwarded = body\.forwarded === true;/);
    assert.match(p2p, /\.\.\.\(forwarded && \{ fwd: true \}\),\n {10}\.\.\.\(signed \|\| \{\}\),\n {8}\};/);
    // Signed with the rest, so nobody on the way can add or drop it.
    assert.match(p2p, /\{ topic: wireTopic\(roomKey\), id, ts, e, sn, \.\.\.outside, fwd: forwarded \}/);
    assert.match(p2p, /\.\.\.\(forwarded && \{ forwarded: true \}\),/);
    // History, live and passed-on messages from a peer all keep it, from the
    // signed header when there is one.
    assert.match(p2p, /\.\.\.\(header\.fwd === true && \{ fwd: true \}\),/);
    assert.match(p2p, /if \(entry\.fwd === true\) out\.forwarded = true;/);

    const app = await read("app.js");
    assert.match(app, /if \(msg\.forwarded\) \{\s+const forwarded = document\.createElement\("div"\);\s+forwarded\.className = "msg-forwarded";\s+forwarded\.textContent = "Forwarded";/);
    assert.match(app, /chat\.sendMessage\(targetRoomKey, \{ message: item\.text, forwarded: true \}\)/);
    // A file goes out sealed for the chat it goes to, through the same screen
    // and upload as one picked from the computer, marked as forwarded.
    assert.match(app, /screenAndUploadFiles\(\[await forwardedFile\(item\.file, fromRoom\)\], \{ roomKey: targetRoomKey, forwarded: true \}\)/);
    assert.match(app, /\.\.\.\(forwarded && \{ forwarded: true \}\),/);
    assert.match(app, /if \(action === "select"\) startSelecting\(msg\);/);

    const html = await read("index.html");
    assert.match(html, /<button data-action="select">Select<\/button>/);
    assert.match(html, /<div id="forward-modal" class="modal">/);
    assert.match(html, /<button type="button" id="select-forward" class="btn-sm" disabled>Forward<\/button>/);
    const css = await read("styles.css");
    assert.match(css, /\.msg-forwarded \{\s+font-style: italic;/);
  });
});
