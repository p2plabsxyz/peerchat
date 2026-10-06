import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * A conversation with one person has a secret of its own.
 *
 * It used to be sha256 of the two 8-character peer ids. Those are public: they
 * are in every member list and on every personal invite code, so anybody who
 * knew both could work out the key, join the topic and read the conversation
 * along with its attachments.
 */
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
const about = await readFile(new URL("../about.html", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

describe("direct message keys", () => {
  it("has no way left to compute one from public ids", () => {
    assert.doesNotMatch(app, /:dm:/);
    assert.doesNotMatch(p2p, /:dm:/);
    assert.doesNotMatch(app, /function dmRoomKey/);
  });

  it("mints one, and reuses the conversation that already exists", () => {
    const action = p2p.slice(
      p2p.indexOf('if (action === "join-dm")'),
      p2p.indexOf('if (action === "block-peer")'),
    );

    assert.match(action, /findDirectRoomKey\(toIdNorm\) \|\| randomBytes\(32\)\.toString\("hex"\)/);
    // The renderer never picks the key, so nothing on that side can weaken it.
    assert.doesNotMatch(action, /body\.roomKey/);

    // One conversation per person, found by who it is with.
    const lookup = p2p.slice(p2p.indexOf("function findDirectRoomKey"), p2p.indexOf("function shareDMInvites"));
    assert.match(lookup, /room\.isDM && normPeerId\(room\.dmWith\) === wanted/);
    assert.match(app, /isDirectRoomFor\(room, peerKey \|\| peerId\)/);
  });

  it("takes an invite on the strength of the connection, not the key", () => {
    const invite = p2p.slice(
      p2p.indexOf('if (msg.type === "dm-invite")'),
      p2p.indexOf('if (msg.type === "dm-accept")'),
    );

    // The handshake already proved who they are; a key we hold as something
    // else, or as a conversation bound to another key, is not theirs to name.
    assert.match(invite, /if \(claimed && !dmFromThem\(claimed, remoteId, fullId\)\) continue;/);
    // A request remembers the key it came from, so the answer goes back there.
    assert.match(invite, /fromKey: fullId/);
    // Both sides opening one at once converge without another round trip.
    assert.match(invite, /ours < msg\.roomKey/);
    assert.match(invite, /dropRoomLocally\(sdk, ours\)/);
  });

  it("says so in the README and in About", () => {
    for (const doc of [about, readme]) {
      assert.doesNotMatch(doc, /derived (deterministically )?from both peer/i);
      assert.match(doc, /own (random )?room key/i);
    }
    // And is honest that an older conversation keeps the old key.
    assert.match(about, /Conversations started before this keep that key/);
    assert.match(readme, /keep their derived key/);
  });
});
