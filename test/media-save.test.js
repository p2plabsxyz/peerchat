import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Saving from the media viewer opened two save dialogs on desktop: the first
// one's write was refused, and the handler fell back to a download link, which
// asked again. A save now shows one dialog, and a download link only when no
// dialog could open at all.
describe("saving from the media viewer", () => {
  it("asks once, and falls back to a download link only when no dialog opened", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const start = app.indexOf('$("media-viewer-dl")?.addEventListener');
    const handler = app.slice(start, app.indexOf("});", start));
    assert.ok(start > 0, "the media viewer has a download button");
    assert.match(handler, /const handle = await pickSaveFile\(fname\);\s+if \(handle === false\) return;\s+if \(handle\) \{\s+const writable = await handle\.createWritable\(\);\s+await writable\.write\(blob\);\s+await writable\.close\(\);\s+return;\s+\}/);
    // No second try at the dialog, and no catch that turns a failed write
    // into a download.
    assert.doesNotMatch(handler, /showSaveFilePicker/);
    assert.doesNotMatch(handler, /catch \(pickErr\)/);
  });
});
