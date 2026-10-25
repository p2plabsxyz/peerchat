// A profile or room picture over 1 MB was refused, which turned most photos
// straight off a phone away, though the picture is shrunk to 369px before it
// is kept.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

describe("a profile or room picture", () => {
  it("may be a photo straight off a phone", () => {
    assert.match(app, /const MAX_PICTURE_FILE_BYTES = 30 \* 1024 \* 1024;/);
    assert.doesNotMatch(app, /Image must be under 1 MB/);
  });

  it("is still shrunk before it is kept", () => {
    assert.match(app, /function resizeImage\(file, maxPx = 369\)/);
    assert.match(app, /resolve\(c\.toDataURL\("image\/jpeg", 0\.8\)\);/);
  });
});
