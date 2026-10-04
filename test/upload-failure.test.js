import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { describeUploadFailure } from "../lib/upload-failure.js";

// PeerChat sets no size limit of its own now, as in Keet, so the one that
// stops a big file is the disk. It answered in the system's words.
describe("a failed upload", () => {
  it("says plainly when the computer is out of space", () => {
    assert.equal(
      describeUploadFailure("film.mov", "ENOSPC: no space left on device, write"),
      "There is not enough free space on this computer to share film.mov.",
    );
    assert.equal(describeUploadFailure("a.zip", "the drive did not take it"), "Upload failed: the drive did not take it");
  });

  it("is not refused for its size before it is tried", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    assert.doesNotMatch(app, /MAX_ATTACHMENT_BYTES|too big to send/);
    assert.match(app, /alert\(describeUploadFailure\(file\.name, err\.message\)\)/);
    const crypto = await readFile(new URL("../lib/attachment-crypto.js", import.meta.url), "utf8");
    assert.doesNotMatch(crypto, /MAX_ATTACHMENT_BYTES/);
  });
});
