import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Each device has its own key, so a chat with your own phone had two sides
// and its messages showed as someone else's. They are yours now, as in a
// chat with yourself elsewhere.
describe("messages from your own devices", () => {
  it("keeps the devices proven with the link, across a restart", async () => {
    const p2p = await read("p2p.js");
    assert.match(p2p, /if \(!siblingIds\.has\(remoteId\) && siblingIds\.size < MAX_SIBLINGS\) \{\s+siblingIds\.add\(remoteId\);\s+persistData\(\);/);
    assert.match(p2p, /siblings: \[\.\.\.siblingIds\]\.slice\(0, MAX_SIBLINGS\),/);
    // Only with a link to prove them by, and none from another person's link.
    assert.match(p2p, /if \(savedData\.link && Array\.isArray\(raw\.siblings\)\) \{/);
    assert.match(p2p, /if \(!sameLink\) siblingIds\.clear\(\);/);
    assert.match(p2p, /blockedPeers: listBlockedPeers\(\),\s+\/\/ [^\n]*\n\s+siblings: \[\.\.\.siblingIds\],/);
  });

  it("shows them as yours and calls a chat with one of them You", async () => {
    const p2p = await read("p2p.js");
    const app = await read("app.js");
    // One name for it wherever a room goes out: the list and every update.
    assert.match(p2p, /function shownRoomName\(roomKey, room\) \{\s+if \(room\.isDM && room\.dmWith && siblingIds\.has\(normPeerId\(room\.dmWith\)\.slice\(0, 8\)\)\) return "You";/);
    assert.match(p2p, /name: shownRoomName\(k, r\),/);
    assert.match(app, /function makeMsgEl\(msg\) \{\s+const self = isOwnId\(msg\.sender\);/);
    assert.match(app, /room\.name = isOwnId\(peerId\) \? "You" : username;/);
    // Not unread, and no sound, for what you wrote elsewhere.
    assert.match(app, /if \(!isSystem && !isOwnId\(msg\.sender\)\) \{\s+if \(rk !== S\.activeRoom\) \{\s+room\.unreadCount/);
  });
});
