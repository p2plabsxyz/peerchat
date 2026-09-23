// Photos and videos never reach the text filters, so this is what decides
// whether explicit media gets into a room at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";

import {
  describeTooManyFiles,
  EXPLICIT_THRESHOLD,
  isTooManyFiles,
  MAX_UPLOAD_BATCH,
  MEDIA_ALLOWED,
  MEDIA_BLOCKED,
  MEDIA_UNSCANNED,
  normalizeMediaVerdict,
  screenUploadBatch,
  verdictFromPredictions,
  videoSampleTimes,
} from "../lib/media-moderation.js";

describe("media moderation", () => {
  it("refuses the explicit classes and lets the rest through", () => {
    const at = (className, probability) => [{ className, probability }];
    assert.equal(verdictFromPredictions(at("Porn", 0.97)), MEDIA_BLOCKED);
    assert.equal(verdictFromPredictions(at("Hentai", 0.8)), MEDIA_BLOCKED);
    assert.equal(verdictFromPredictions(at("Neutral", 0.99)), MEDIA_ALLOWED);
    assert.equal(verdictFromPredictions(at("Drawing", 0.99)), MEDIA_ALLOWED);

    // Sexy is swimwear and underwear. Refusing it would refuse a beach photo.
    assert.equal(verdictFromPredictions(at("Sexy", 0.99)), MEDIA_ALLOWED);

    // Just under the line is not a refusal; the model is not that certain.
    assert.equal(verdictFromPredictions(at("Porn", EXPLICIT_THRESHOLD - 0.01)), MEDIA_ALLOWED);
    assert.equal(verdictFromPredictions(at("Porn", EXPLICIT_THRESHOLD)), MEDIA_BLOCKED);
  });

  it("says nothing rather than allowing when there is nothing to go on", () => {
    assert.equal(verdictFromPredictions([]), MEDIA_UNSCANNED);
    assert.equal(verdictFromPredictions(null), MEDIA_UNSCANNED);
    assert.equal(normalizeMediaVerdict("clean"), MEDIA_UNSCANNED);
  });

  it("stops the whole batch when one file is refused", () => {
    const ok = [{ fileName: "a.png", verdict: MEDIA_ALLOWED }, { fileName: "b.png", verdict: MEDIA_UNSCANNED }];
    assert.equal(screenUploadBatch(ok).allowed, true);

    const bad = [...ok, { fileName: "c.png", verdict: MEDIA_BLOCKED }];
    const decision = screenUploadBatch(bad);
    assert.equal(decision.allowed, false);
    assert.equal(decision.blocked.length, 1);
    assert.match(decision.reason, /c\.png/);

    // With more than one refusal the message stops naming files.
    const worse = screenUploadBatch([...bad, { fileName: "d.png", verdict: MEDIA_BLOCKED }]);
    assert.equal(worse.blocked.length, 2);
    assert.doesNotMatch(worse.reason, /c\.png/);
  });

  it("bounds how many files one send may carry", () => {
    assert.equal(isTooManyFiles(MAX_UPLOAD_BATCH), false);
    assert.equal(isTooManyFiles(MAX_UPLOAD_BATCH + 1), true);
    assert.match(describeTooManyFiles(40), new RegExp(`${MAX_UPLOAD_BATCH}`));
  });

  it("samples a video away from its first and last frame", () => {
    const times = videoSampleTimes(60, 4);
    assert.equal(times.length, 4);
    assert.ok(times[0] > 0, "a clip that opens on black tells you nothing");
    assert.ok(times.at(-1) < 60, "nor does the cut at the end");
    assert.deepEqual([...times].sort((a, b) => a - b), times);

    // A clip shorter than the sample count is not sampled more than once a second.
    assert.equal(videoSampleTimes(2, 8).length, 2);
    assert.deepEqual(videoSampleTimes(0), [0]);
    assert.deepEqual(videoSampleTimes(NaN), [0]);
  });

  it("keeps the model and the library local to the app", async () => {
    const scanner = await readFile(new URL("../lib/media-scanner.js", import.meta.url), "utf8");

    // PeerChat has no build step and a room should not need the open web to
    // decide what it accepts.
    assert.doesNotMatch(scanner, /https?:\/\//);
    assert.match(scanner, /nsfw-model\/model\.json/);

    // 5 MB has no business loading on a startup that never attaches a file.
    assert.match(scanner, /if \(!modelPromise\)/);

    const model = await stat(new URL("../lib/nsfw-model/group1-shard1of1", import.meta.url));
    assert.ok(model.size > 1_000_000, "the weights are missing");
  });

  it("checks every file before uploading any of them", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const handler = app.slice(app.indexOf('$("file-input")?.addEventListener'), app.indexOf("async function uploadAndSendFile"));

    // Scan all, decide once, then upload. Uploading as we go would leave half
    // a batch in the room when the third file is refused.
    const scanAt = handler.indexOf("scanMediaFile");
    const uploadAt = handler.indexOf("uploadAndSendFile");
    assert.ok(scanAt > -1 && uploadAt > scanAt, "the upload must come after the scan");
    assert.match(handler, /screenUploadBatch/);
    assert.match(handler, /isTooManyFiles/);
  });
});
