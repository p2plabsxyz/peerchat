import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { earliestRoomCreatedAt } from "../lib/room-created-at.js";

const APRIL = Date.UTC(2026, 3, 19);
const SEPTEMBER = Date.UTC(2026, 8, 26);
const NOW = Date.UTC(2026, 8, 27);

// A room whose messages start in April read as created in September on a device
// that joined then, because nothing shared the date and each one stamped its own
// join.
describe("room created date", () => {
  it("keeps the earliest date anybody reports", () => {
    assert.equal(earliestRoomCreatedAt(SEPTEMBER, APRIL, NOW), APRIL);
    assert.equal(earliestRoomCreatedAt(APRIL, SEPTEMBER, NOW), APRIL);
    assert.equal(earliestRoomCreatedAt(0, APRIL, NOW), APRIL);
  });

  it("ignores a date in the future", () => {
    assert.equal(earliestRoomCreatedAt(SEPTEMBER, NOW + 86400000, NOW), SEPTEMBER);
    assert.equal(earliestRoomCreatedAt(0, NOW + 86400000, NOW), 0);
  });

  it("leaves what we had alone when told nothing sensible", () => {
    for (const bad of [undefined, 0, -5, "April", null]) {
      assert.equal(earliestRoomCreatedAt(APRIL, bad, NOW), APRIL);
    }
  });

  it("sends the date and keeps the earliest, same as mobile", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
    const meta = p2p.slice(p2p.indexOf('type: "room-meta"'), p2p.indexOf("function shareRoomMeta"));

    assert.match(meta, /createdAt: Number\.isSafeInteger\(room\.createdAt\) \? room\.createdAt : 0/);
    assert.match(p2p, /earliestRoomCreatedAt\(room\.createdAt, msg\.createdAt\)/);
  });
});
