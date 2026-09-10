import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { DecryptedUrlCache, RoomRefs } from "../lib/attachment-cache.js";

const roomKey = () => randomBytes(32).toString("hex");
const tick = () => new Promise((r) => setImmediate(r));

describe("RoomRefs", () => {
  it("hands out a stable opaque id per room that round-trips", () => {
    const refs = new RoomRefs();
    const key = roomKey();
    const id = refs.ref(key);
    assert.equal(refs.ref(key), id);
    assert.equal(refs.key(id), key);
    assert.notEqual(refs.ref(roomKey()), id);
  });

  it("puts nothing from the room key into the id", () => {
    const refs = new RoomRefs();
    const key = roomKey();
    const id = refs.ref(key);
    assert.match(id, /^[a-f0-9]{8}$/);
    assert.ok(!key.includes(id));
  });

  it("returns null for an id it never issued", () => {
    assert.equal(new RoomRefs().key("deadbeef"), null);
  });

  it("never issues the same id twice even if the random source repeats", () => {
    const seq = ["aaaaaaaa", "aaaaaaaa", "bbbbbbbb"];
    const refs = new RoomRefs(() => seq.shift());
    assert.notEqual(refs.ref(roomKey()), refs.ref(roomKey()));
  });
});

describe("DecryptedUrlCache", () => {
  it("loads each attachment once per room", async () => {
    const cache = new DecryptedUrlCache(() => {});
    const key = roomKey();
    let loads = 0;
    const load = async () => { loads++; return "blob:1"; };
    assert.equal(await cache.get("hyper://x/a.bin", key, load), "blob:1");
    assert.equal(await cache.get("hyper://x/a.bin", key, load), "blob:1");
    assert.equal(loads, 1);
  });

  it("revokes every blob URL for a room when it is left, and nothing else", async () => {
    const revoked = [];
    const cache = new DecryptedUrlCache((u) => revoked.push(u));
    const left = roomKey(), stay = roomKey();
    await cache.get("hyper://x/1.bin", left, async () => "blob:left-1");
    await cache.get("hyper://x/2.bin", left, async () => "blob:left-2");
    await cache.get("hyper://x/3.bin", stay, async () => "blob:stay");

    assert.equal(cache.revokeRoom(left), 2);
    await tick();
    assert.deepEqual(revoked.sort(), ["blob:left-1", "blob:left-2"]);
    assert.equal(cache.size, 1);
    assert.equal(await cache.get("hyper://x/3.bin", stay, async () => "wrong"), "blob:stay");
  });

  it("revokes a load that was still in flight when the room was left", async () => {
    const revoked = [];
    const cache = new DecryptedUrlCache((u) => revoked.push(u));
    const key = roomKey();
    let finish;
    cache.get("hyper://x/slow.bin", key, () => new Promise((r) => { finish = r; }));
    await tick(); // loader has started; the room is left mid-download
    cache.revokeRoom(key);
    finish("blob:late");
    await tick();
    assert.deepEqual(revoked, ["blob:late"]);
  });

  it("evicts a failed load so the next attempt retries", async () => {
    const cache = new DecryptedUrlCache(() => {});
    const key = roomKey();
    await assert.rejects(() => cache.get("hyper://x/a.bin", key, async () => { throw new Error("net"); }));
    assert.equal(cache.size, 0);
    assert.equal(await cache.get("hyper://x/a.bin", key, async () => "blob:ok"), "blob:ok");
  });

  it("revoking an unknown room is a no-op", () => {
    assert.equal(new DecryptedUrlCache(() => {}).revokeRoom(roomKey()), 0);
  });
});
