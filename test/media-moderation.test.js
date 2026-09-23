// Photos and videos never reach the text filters, so this is what decides
// whether explicit media gets into a room at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";

import {
  describeTooManyFiles,
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
  it("refuses a photo however the model divides up its score", () => {
    const at = (scores) => Object.entries(scores).map(([className, probability]) => ({ className, probability }));

    // Clearly explicit.
    assert.equal(verdictFromPredictions(at({ Porn: 0.97, Neutral: 0.03 })), MEDIA_BLOCKED);
    assert.equal(verdictFromPredictions(at({ Hentai: 0.8, Neutral: 0.2 })), MEDIA_BLOCKED);

    // Nudity usually lands here, which is most of what actually gets posted.
    assert.equal(verdictFromPredictions(at({ Sexy: 0.85, Neutral: 0.15 })), MEDIA_BLOCKED);

    // And the case that made this necessary: a split where no single class
    // looks decisive on its own but the photo is plainly not safe.
    assert.equal(verdictFromPredictions(at({ Porn: 0.3, Sexy: 0.45, Neutral: 0.25 })), MEDIA_BLOCKED);
    assert.equal(verdictFromPredictions(at({ Porn: 0.25, Hentai: 0.25, Neutral: 0.5 })), MEDIA_BLOCKED);

    // Ordinary photos still go through.
    assert.equal(verdictFromPredictions(at({ Neutral: 0.99, Sexy: 0.01 })), MEDIA_ALLOWED);
    assert.equal(verdictFromPredictions(at({ Drawing: 0.95, Neutral: 0.05 })), MEDIA_ALLOWED);

    // A beach photo scores some Sexy without being nudity.
    assert.equal(verdictFromPredictions(at({ Sexy: 0.5, Neutral: 0.45, Drawing: 0.05 })), MEDIA_ALLOWED);
  });

  it("can be tuned without editing the rule", () => {
    const split = [{ className: "Sexy", probability: 0.5 }, { className: "Neutral", probability: 0.5 }];
    assert.equal(verdictFromPredictions(split), MEDIA_ALLOWED);
    assert.equal(verdictFromPredictions(split, { combined: 0.4 }), MEDIA_BLOCKED);
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
    // Anchor on the real call, not the bare name, so a comment cannot fool it.
    const scanAt = handler.indexOf("await scanMediaFile(file)");
    const uploadAt = handler.indexOf("await uploadAndSendFile(file)");
    assert.ok(scanAt > -1 && uploadAt > scanAt, "the upload must come after the scan");
    assert.match(handler, /screenUploadBatch/);
    assert.match(handler, /isTooManyFiles/);
  });

  it("detects an image by its extension when the file has no MIME type", async () => {
    const scanner = await readFile(new URL("../lib/media-scanner.js", import.meta.url), "utf8");
    const fn = scanner.slice(scanner.indexOf("export async function scanMediaFile"));

    // A picked file often arrives with an empty file.type. Gating on that alone
    // let an explicit image with no MIME type past the upload check, and it was
    // only caught on the way back in.
    assert.match(fn, /!type && IMAGE_EXT\.test\(name\)/);
    assert.match(fn, /!type && VIDEO_EXT\.test\(name\)/);
    assert.match(scanner, /IMAGE_EXT = .*jpe\?g/);
  });

  it("does not hide the sender's own media back to them", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const hydrate = app.slice(app.indexOf("function hydrateEncryptedMedia"), app.indexOf("function legacyAttachmentHtml"));

    // The sender already screened it on the way out, so re-checking on their own
    // screen only means seeing their own picture hidden from them.
    assert.match(app, /function isOwnMessageMedia\(el\)/);
    assert.match(app, /el\.closest\("\.msg-right"\)/);
    assert.match(hydrate, /own \? \(el\.src = src\) : screenIncomingMedia/);
    assert.match(hydrate, /if \(isOwnMessageMedia\(el\)\) continue/);
  });

  it("funnels every way in through the same screen", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

    // Drag-and-drop used to call uploadAndSendFile directly and skip the screen
    // entirely. Now the picker and the drop path share one function, and the
    // upload call lives only inside it.
    assert.match(app, /async function screenAndUploadFiles\(selected\)/);
    const drop = app.slice(app.indexOf('msgArea.addEventListener("drop"'), app.indexOf("$(\"set-avatar-input\")"));
    assert.match(drop, /screenAndUploadFiles\(\[\.\.\.\(e\.dataTransfer\?\.files \|\| \[\]\)\]\)/);
    assert.doesNotMatch(drop, /uploadAndSendFile\(/);
    // ... and it takes every dropped file, not just the first.
    assert.doesNotMatch(drop, /files\?\.\[0\]/);
    assert.equal((app.match(/await uploadAndSendFile\(file\)/g) || []).length, 1, "uploads happen in exactly one place");

    // A profile or room picture is broadcast to every peer, so both go through
    // the check too, before they are even resized.
    for (const input of ["set-avatar-input", "new-room-avatar-input"]) {
      const handler = app.slice(app.indexOf(`$("${input}")?.addEventListener`));
      const guard = handler.indexOf("await refuseIfExplicit(file)");
      const resize = handler.indexOf("await resizeImage(file)");
      assert.ok(guard > -1 && guard < resize, `${input} must be screened before it is resized`);
    }
  });

  it("refuses a dropped folder instead of uploading an empty entry", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const fn = app.slice(app.indexOf("async function screenAndUploadFiles"), app.indexOf("async function refuseIfExplicit"));

    // There is no directory upload. A dropped folder arrives as a 0-byte
    // pseudo-file, not its contents, so it is filtered out and named as such.
    assert.match(fn, /filter\(\(file\) => file && file\.size > 0\)/);
    assert.match(fn, /Folders cannot be sent/);
  });

  it("keeps what renders and what is screened in step", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const scanner = await readFile(new URL("../lib/media-scanner.js", import.meta.url), "utf8");

    // Pull the real regex literals out and run filenames through them, rather
    // than comparing token lists: jpe?g and jpg|jpeg spell the same thing.
    const literal = (src, label) => {
      const raw = src.match(new RegExp(`${label}[^/]*?(/\\\\\\..+?/i)`))?.[1];
      assert.ok(raw, `could not find the ${label} pattern`);
      // eslint-disable-next-line no-eval
      return eval(raw);
    };
    const renderImage = literal(app, "function isImageFile");
    const renderVideo = literal(app, "function isVideoFile");
    const screenImage = literal(scanner, "IMAGE_EXT =");
    const screenVideo = literal(scanner, "VIDEO_EXT =");

    // A format that renders but is not recognised by the screener uploads
    // unchecked. That is exactly how heic slipped past.
    const candidates = ["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif",
                        "mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp", "ogg"];
    for (const ext of candidates) {
      const name = `holiday.${ext}`;
      if (renderImage.test(name) && ext !== "svg") {
        assert.ok(screenImage.test(name), `${ext} renders as an image but is never screened`);
      }
      if (renderVideo.test(name)) {
        assert.ok(screenVideo.test(name), `${ext} renders as video but is never screened`);
      }
    }

    // An iPhone writes these by default, so leaving them out missed the
    // commonest photo on the platform.
    for (const ext of ["heic", "heif", "avif"]) {
      assert.ok(screenImage.test(`photo.${ext}`), `${ext} must be screened`);
    }
  });

  it("screens what arrived, not only what is sent", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const scanner = await readFile(new URL("../lib/media-scanner.js", import.meta.url), "utf8");

    // The sending side can be stripped out by anyone running a modified build,
    // which is why the text filters check inbound messages too.
    assert.match(scanner, /export async function scanMediaUrl/);
    const hydrate = app.slice(app.indexOf("async function screenIncomingMedia"), app.indexOf("function hydrateEncryptedMedia"));
    assert.match(hydrate, /await scanMediaUrl\(src, kind\)/);

    // The picture must not be shown before the verdict is in.
    assert.ok(hydrate.indexOf("scanMediaUrl") < hydrate.indexOf("el.src = src"));
    assert.match(hydrate, /MEDIA_BLOCKED/);

    // Both the encrypted and the plain path go through it.
    const hydrateBody = app.slice(app.indexOf("function hydrateEncryptedMedia"), app.indexOf("function legacyAttachmentHtml"));
    assert.equal((hydrateBody.match(/screenIncomingMedia/g) || []).length, 2);
  });
});
