import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

// Downloading a picture or video, from the picture viewer and from a message's
// menu. It is one download through the browser's own, which PeerSky asks about
// and lists with its other downloads. Saving from the viewer once opened two
// save dialogs: the first one's write was refused, and the handler fell back
// to a download link, which asked again. There is no dialog of the page's own
// now, so there is nothing to fall back from.
describe("downloading a picture or video", () => {
  it("downloads once from the viewer, under the name it was sent with", () => {
    const handler = between('$("media-viewer-dl")?.addEventListener', "});");
    assert.ok(handler, "the media viewer has a download button");
    assert.match(handler, /let fname = overlay\.dataset\.fileName \|\| "";/);
    // A sealed one is already opened for the chat to show it.
    assert.match(handler, /if \(fname && \/\^blob:\/i\.test\(src\)\) \{\s*downloadFrom\(src, fname\);/);
    assert.match(handler, /downloadBlob\(blob, fname\);/);
    assert.doesNotMatch(handler, /pickSaveFile|showSaveFilePicker|createWritable/);
    assert.match(html, /id="media-viewer-dl" class="media-viewer-dl" title="Download"/);
  });

  it("is offered in a message's menu for a file, where Copy Text is not", () => {
    assert.match(html, /<button data-action="download" style="display:none">Download<\/button>/);
    const menu = between("function showMsgMenu(", "\n}\n");
    assert.match(menu, /const file = !!attachmentKind\(msg\.message, msg\);/);
    assert.match(menu, /\[data-action="download"\]'\)\.style\.display = file \? "" : "none";/);
    assert.match(menu, /\[data-action="copy-msg"\]'\)\.style\.display = file \? "none" : "";/);
    assert.match(app, /if \(action === "download"\) downloadAttachment\(msg\);/);
  });

  it("opens a sealed picture or video here and saves that, never the sealed bytes", () => {
    const save = between("async function saveMediaFile(", "\n}\n");
    assert.match(save, /if \(roomKey\) \{\s*downloadFrom\(await resolveDecryptedUrl\(url, roomKey, name\), name\);/);
    assert.match(save, /downloadBlob\(await resp\.blob\(\), name\);/);
    const attachment = between("function downloadAttachment(", "\n}\n");
    // The key it was sealed with, as the chat opens it.
    assert.match(attachment, /const roomKey = kind === "encrypted" \? \(msg\.fileKey \|\| msg\.roomKey \|\| S\.activeRoom\) : null;/);
    assert.match(attachment, /return saveMediaFile\(\{ url, fileName: msg\.fileName, roomKey \}\);/);
    // Any other file goes the way its own download button saves it.
    assert.match(attachment, /if \(fileKind\(msg\.fileName\) === "file"\) return downloadHyperFile\(url, msg\.fileName, roomKey\);/);
    const download = between("function downloadFrom(", "\n}\n");
    assert.match(download, /a\.href = href;/);
    assert.match(download, /a\.download = sanitizeDownloadFilename\(fileName\);/);
    assert.match(between("function downloadBlob(", "\n}\n"), /downloadFrom\(href, fileName\);/);
  });

  it("knows the name of what the viewer shows", () => {
    assert.match(app, /data-file-name="\$\{esc\(name\)\}"/);
    assert.match(app, /if \(fileName\) el\.dataset\.fileName = fileName;/);
    assert.match(app, /openMediaViewer\(img\.src, tag === "video" \? "video" : "image", imgHint, fileName\);/);
    assert.match(app, /overlay\.dataset\.fileName = fileName;/);
  });
});
