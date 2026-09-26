import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PEER_PRESENCE_GRACE_MS, createPresenceHold } from "../lib/presence.js";

// Hyperswarm redials all the time, and so does a phone waking or a laptop
// opening its lid. Acting on every offline event made the peer count and the
// online dots blink, which in a busy room never stops.
describe("createPresenceHold", () => {
  it("keeps a peer who comes straight back", () => {
    const hold = createPresenceHold();
    hold.offline("peer-1", 1000);
    assert.equal(hold.isHeld("peer-1", 1100), true);

    hold.online("peer-1");
    assert.equal(hold.isHeld("peer-1", 1100), false);
    assert.deepEqual(hold.heldIds(1100), []);
  });

  it("lets go of a peer who really left", () => {
    const hold = createPresenceHold();
    hold.offline("peer-1", 1000);

    assert.equal(hold.isHeld("peer-1", 1000 + PEER_PRESENCE_GRACE_MS - 1), true);
    assert.equal(hold.isHeld("peer-1", 1000 + PEER_PRESENCE_GRACE_MS), false);
    assert.deepEqual(hold.prune(1000 + PEER_PRESENCE_GRACE_MS), ["peer-1"]);
  });

  it("reports only the peers that actually dropped", () => {
    const hold = createPresenceHold({ graceMs: 1000 });
    hold.offline("a", 0);
    hold.offline("b", 500);

    assert.deepEqual(hold.prune(999), []);
    assert.deepEqual(hold.prune(1000), ["a"]);
    // "b" went offline at 500, so its grace runs to 1500.
    assert.deepEqual(hold.prune(1400), []);
    assert.deepEqual(hold.prune(1500), ["b"]);
    assert.deepEqual(hold.prune(2000), []);
  });

  it("says when to look again", () => {
    const hold = createPresenceHold({ graceMs: 1000 });
    assert.equal(hold.nextExpiryAt(0), null);

    hold.offline("a", 0);
    hold.offline("b", 400);
    assert.equal(hold.nextExpiryAt(0), 1000);

    hold.prune(1000);
    assert.equal(hold.nextExpiryAt(1000), 1400);
  });

  // The server sends a full list of who is online, and one taken mid-redial
  // would otherwise undo the hold.
  it("hands back who to add to a fresh snapshot", () => {
    const hold = createPresenceHold({ graceMs: 1000 });
    hold.offline("a", 0);
    hold.offline("b", 0);
    hold.online("b");

    assert.deepEqual(hold.heldIds(500), ["a"]);
    assert.deepEqual(hold.heldIds(1000), []);
  });

  it("does not wait on someone who chose to leave", () => {
    const hold = createPresenceHold();
    hold.offline("a", 0);
    hold.forget("a");
    assert.equal(hold.isHeld("a", 100), false);
    assert.equal(hold.nextExpiryAt(100), null);
  });

  it("ignores a missing peer id", () => {
    const hold = createPresenceHold();
    hold.offline("", 0);
    hold.offline(null, 0);
    assert.equal(hold.nextExpiryAt(0), null);
  });
});
