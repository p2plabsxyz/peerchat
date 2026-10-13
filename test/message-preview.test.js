// What a message reads as in one line, on the chat list and in search
// results: a picture is "Photo", a video "Video" and any other file its name,
// never the address its sealed copy is kept at (lib/message-preview.js).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fileKind, lastMessageOf, previewNeedsName, previewText } from "../lib/message-preview.js";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const app = read("app.js");
const p2p = read("p2p.js");

const DRIVE = "hyper://" + "a".repeat(52) + "/";
const SEALED = DRIVE + "1760000000000-0123456789abcdef.bin";
const file = (fileName, extra = {}) => ({ message: SEALED, fileName, fileSize: 10, fileEnc: true, ...extra });

describe("a message in one line", () => {
  it("names a picture, a video and any other file, never by their address", () => {
    assert.equal(previewText(file("beach.jpg")), "Photo");
    assert.equal(previewText(file("IMG_0042.HEIC")), "Photo");
    assert.equal(previewText(file("clip.mov")), "Video");
    assert.equal(previewText(file("notes.pdf")), "notes.pdf");
    // An upload from before files were sealed is shown the same way.
    assert.equal(previewText({ message: DRIVE + "1700000000000-old.png", fileName: "old.png" }), "Photo");
  });

  it("reads words as they were written, a pasted link included", () => {
    assert.equal(previewText({ message: "See you Sunday" }), "See you Sunday");
    assert.equal(previewText({ message: DRIVE + "index.html" }), DRIVE + "index.html");
    // A file name on something that is not an upload does not make it one,
    // as in the chat itself.
    assert.equal(previewText({ message: "hello", fileName: "x.png" }), "hello");
    assert.equal(previewText(null), "");
  });

  it("says File for a last message kept as only a sealed file's address", () => {
    assert.equal(previewText({ message: SEALED }), "File");
    assert.ok(previewNeedsName({ message: SEALED }));
    assert.ok(previewNeedsName({ message: DRIVE + "1700000000000-old.png" }));
    assert.equal(previewNeedsName({ message: "Photo" }), false);
    assert.equal(previewNeedsName({ message: "see " + SEALED }), false);
    assert.equal(previewNeedsName(null), false);
  });

  it("keeps the last message the chat list shows by name, with who sent it and when", () => {
    const msg = { ...file("clip.webm"), id: "m1", sender: "ce11ce11", senderName: "Test Cal", timestamp: 1234 };
    assert.deepEqual(lastMessageOf(msg), { sender: "ce11ce11", senderName: "Test Cal", message: "Video", timestamp: 1234 });
    assert.equal(lastMessageOf({ ...msg, message: "x".repeat(300), fileName: undefined }).message.length, 120);
  });

  it("knows pictures and videos as the chat shows them", () => {
    // The patterns app.js renders by, taken from its source and run.
    const literal = (label) => {
      const raw = app.match(new RegExp(`${label}[^/]*?(/\\\\\\..+?/i)`))?.[1];
      assert.ok(raw, `could not find the ${label} pattern`);
      // eslint-disable-next-line no-eval
      return eval(raw);
    };
    const image = literal("function isImageFile");
    const video = literal("function isVideoFile");
    for (const ext of ["jpg", "jpeg", "png", "gif", "webp", "svg", "avif", "heic", "heif",
                       "mp4", "webm", "mov", "ogg", "m4v", "mkv", "avi", "3gp", "pdf", "zip", "txt"]) {
      const name = `holiday.${ext}`;
      const shown = image.test(name) ? "image" : video.test(name) ? "video" : "file";
      assert.equal(fileKind(name), shown, `${ext} shows as ${shown}`);
    }
  });

  it("is what the chat list shows, kept that way by the backend and the page", () => {
    assert.match(app, /: \$\{previewText\(r\.lastMessage\)\}`/);
    assert.match(app, /if \(!isSystem && msgText\) room\.lastMessage = lastMessageOf\(msg\);/);
    assert.match(p2p, /if \(!isSystem && !isReaction && msgText\) room\.lastMessage = lastMessageOf\(msg\);/);
    // Kept from before: read again from the chat's log when it opens.
    assert.match(p2p, /room\.lastMessage = lastMessageOf\(feedEntryToMsg\(lastEntry, roomKey\)\);/);
  });
});
