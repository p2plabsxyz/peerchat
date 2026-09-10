import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachmentKind } from "../lib/render-rules.js";

const DRIVE = "hyper://" + "e".repeat(52) + "/";

describe("attachmentKind", () => {
  it("renders a pasted hyper:// file URL as a plain link", () => {
    assert.equal(attachmentKind(DRIVE + "docs/report.pdf", {}), null);
    assert.equal(attachmentKind(DRIVE + "photo.png", { fileSize: 10 }), null);
  });

  it("renders a pasted web image link as a plain link", () => {
    assert.equal(attachmentKind("https://example.com/cat.png", {}), null);
  });

  it("shows the card for an unencrypted upload", () => {
    assert.equal(attachmentKind(DRIVE + "abc/1-old.png", { fileName: "old.png", fileSize: 10 }), "upload");
  });

  it("shows the encrypted card for a sealed upload", () => {
    assert.equal(attachmentKind(DRIVE + "1-0123456789abcdef.bin", { fileName: "report.pdf", fileEnc: true }), "encrypted");
  });

  it("never treats a URL inside prose as an attachment, even from an uploader", () => {
    assert.equal(attachmentKind("see " + DRIVE + "x.bin", { fileName: "x.bin", fileEnc: true }), null);
  });

  it("requires a hyper:// URL for the card", () => {
    assert.equal(attachmentKind("https://example.com/x.pdf", { fileName: "x.pdf" }), null);
    assert.equal(attachmentKind("", { fileName: "x.pdf" }), null);
    assert.equal(attachmentKind(undefined, { fileName: "x.pdf" }), null);
  });
});
