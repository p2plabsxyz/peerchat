import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

// A request used to open a modal over everything the moment it landed, and a
// second one replaced the first with no way back to the earlier one.
describe("message requests", () => {
  it("queues behind a line in the sidebar instead of taking the screen", () => {
    const handler = app.slice(app.indexOf('es.addEventListener("dm-invite"'), app.indexOf('es.addEventListener("dm-accepted"'));

    assert.doesNotMatch(handler, /openModal\("dm-invite-modal"\)/);
    assert.match(handler, /renderRequestsButton\(\)/);
    assert.match(html, /id="requests-btn"/);
    // Hidden until somebody is actually waiting.
    assert.match(app, /button\.hidden = count === 0;/);
  });

  it("keeps the count in step from one place", () => {
    const render = app.slice(app.indexOf("function renderRoomList()"), app.indexOf("const list = $(\"room-list\")"));
    assert.match(render, /renderRequestsButton\(\);/);
    // The old single-request modal and its state are gone.
    assert.doesNotMatch(app, /_dmiRoomKey/);
    assert.doesNotMatch(html, /dm-invite-modal/);
  });

  it("shows every request, and lets one be blocked", () => {
    const list = app.slice(app.indexOf("function renderRequestsList()"), app.indexOf("async function blockRequest("));
    assert.match(list, /Object\.entries\(S\.pendingDMs \|\| \{\}\)/);
    assert.match(list, /Nobody is waiting/);
    assert.match(list, /blockRequest\(roomKey, invite\)/);

    const block = app.slice(app.indexOf("async function blockRequest("), app.indexOf('$("requests-btn")?.addEventListener'));
    assert.match(block, /chat\.blockPeer\(\{ peerId: invite\.fromId/);
    // It says what it will do, and it is reversible.
    assert.match(block, /cannot send another/);
    assert.match(block, /unblock them in Settings/);
  });

  // Answering one request is not finishing with the window: closing it meant
  // reopening it for the next person waiting.
  it("leaves the window open and the rest on screen", async () => {
    for (const action of ["async function acceptDM(", "async function rejectDM("]) {
      const body = app.slice(app.indexOf(action), app.indexOf("} catch", app.indexOf(action)));
      assert.doesNotMatch(body, /closeAllModals\(\)/);
      assert.match(body, /renderRequestsList\(\)/);
    }

    // A name and three answers shared one row, so a long name squeezed the
    // buttons until the words wrapped a letter at a time.
    const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
    const row = css.slice(css.indexOf(".request-row {"), css.indexOf(".request-block"));
    assert.match(row, /flex-direction: column/);
    assert.match(row, /\.request-actions \{ display: flex/);
    assert.match(app, /actions\.className = "request-actions"/);
  });
});
