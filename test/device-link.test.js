// One person on several devices: the labels, the name everyone sees, and the
// proof that lets only the person's own devices rename each other.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkProfileProof,
  createLink,
  displayName,
  linkId,
  makeProfileProof,
  makeTransfer,
  mergeLabels,
  nextLabel,
  normalizeLabel,
  normalizeTransfer,
} from "../lib/device-link.js";

describe("device labels", () => {
  it("shows the label after the name, and nothing on the device the name was made on", () => {
    assert.equal(displayName("ada", ""), "ada");
    assert.equal(displayName("ada", "mobile"), "ada@mobile");
    assert.equal(displayName("ada", "desktop2"), "ada@desktop2");
    assert.equal(displayName("ada", "evil label"), "ada");
    // A long name gives way to the label, within the 50 characters peers keep.
    const long = displayName("a".repeat(50), "desktop12");
    assert.equal(long.length, 50);
    assert.ok(long.endsWith("@desktop12"));
    assert.equal(normalizeLabel("Desktop1"), "desktop1");
    assert.equal(normalizeLabel("tablet"), "");
  });

  it("gives the one phone 'mobile' and numbers desktops", () => {
    const fromDesktop = { ...createLink("desktop"), labels: [] };
    assert.equal(nextLabel(fromDesktop, "mobile"), "mobile");
    assert.equal(nextLabel(fromDesktop, "desktop"), "desktop1");
    assert.equal(nextLabel({ ...fromDesktop, labels: ["mobile", "desktop1"] }, "desktop"), "desktop2");

    const fromPhone = { ...createLink("mobile"), labels: [] };
    assert.equal(nextLabel(fromPhone, "desktop"), "desktop");
    assert.equal(nextLabel({ ...fromPhone, labels: ["desktop"] }, "desktop"), "desktop2");
    assert.deepEqual(mergeLabels(["desktop2", "mobile"], ["mobile", "bad", "desktop1"]), ["desktop1", "desktop2", "mobile"]);
  });
});

describe("profile proof", () => {
  it("is the same bytes PeerSky Mobile makes", () => {
    // The same vector is in PeerSky Mobile's test/protocol/peerchat-devices.test.mjs.
    const fixed = { key: "0f".repeat(32), origin: "desktop", labels: ["mobile", "desktop1"] };
    const proof = makeProfileProof(fixed, { username: "ada", bio: "hi there", avatar: "data:image/png;base64,AAAA", at: 1750000000000 });
    assert.equal(proof.id, "148e442780792da6ee08d733108a2207");
    assert.deepEqual(proof.labels, ["desktop1", "mobile"]);
    assert.equal(proof.mac, "5d3454c2ce05fa2be61a73cc473ce1e2ae10f6a6099ab57cea95d38b3615ee64");
  });

  const link = { ...createLink("desktop"), labels: ["mobile"] };
  const profile = { username: "ada", bio: "hi", avatar: "data:image/png;base64,AAAA", at: 1234 };

  it("is accepted with the same link and picture", () => {
    const proof = makeProfileProof(link, profile);
    assert.equal(proof.id, linkId(link));
    assert.equal(proof.name, "ada");
    assert.equal(checkProfileProof(link, proof, profile.avatar), true);
  });

  it("is refused with another link, another picture, or any field changed", () => {
    const proof = makeProfileProof(link, profile);
    assert.equal(checkProfileProof(createLink("desktop"), proof, profile.avatar), false);
    assert.equal(checkProfileProof(link, proof, "data:image/png;base64,BBBB"), false);
    assert.equal(checkProfileProof(link, { ...proof, name: "mallory" }, profile.avatar), false);
    assert.equal(checkProfileProof(link, { ...proof, at: proof.at + 1 }, profile.avatar), false);
    assert.equal(checkProfileProof(link, { ...proof, labels: ["desktop9"] }, profile.avatar), false);
    assert.equal(checkProfileProof(link, { ...proof, mac: "00".repeat(32) }, profile.avatar), false);
    assert.equal(checkProfileProof(link, null, profile.avatar), false);
  });

  it("is never made for a name the profile rules refuse", () => {
    assert.equal(makeProfileProof(link, { ...profile, username: "ada@mobile" }), null);
    assert.equal(makeProfileProof(null, profile), null);
  });
});

describe("transfer", () => {
  const link = createLink("desktop");
  const room = { roomKey: "aa".repeat(32), name: "Room", isDM: false };
  const dm = { roomKey: "bb".repeat(32), name: "Ann", isDM: true, dmWith: "0a0b0c0d" };

  it("keeps the rooms, the link, the profile and the label", () => {
    const transfer = makeTransfer({ link, label: "mobile", profile: { username: "ada", bio: "", avatar: null, at: 5 }, rooms: [{ ...room, joinedAt: 77 }, dm, room] });
    assert.equal(transfer.rooms[0].joinedAt, 77);
    assert.equal(transfer.rooms[1].joinedAt, 0);
    assert.equal(transfer.label, "mobile");
    assert.equal(transfer.link.key, link.key);
    assert.deepEqual(transfer.profile, { username: "ada", bio: "", avatar: null, at: 5 });
    assert.deepEqual(transfer.rooms.map((r) => r.roomKey), [room.roomKey, dm.roomKey]);
    assert.equal(transfer.rooms[1].dmWith, "0a0b0c0d");
  });

  it("refuses a bad link, a bad label or another version, and drops bad rooms", () => {
    const good = { version: 1, label: "mobile", link, profile: { username: "ada" }, rooms: [room] };
    assert.ok(normalizeTransfer(good));
    assert.equal(normalizeTransfer({ ...good, version: 2 }), null);
    assert.equal(normalizeTransfer({ ...good, label: "phone" }), null);
    assert.equal(normalizeTransfer({ ...good, link: { key: "short" } }), null);
    const rooms = normalizeTransfer({ ...good, rooms: [{ roomKey: "zz" }, { ...dm, dmWith: "not-an-id" }, room] }).rooms;
    assert.deepEqual(rooms.map((r) => r.roomKey), [room.roomKey]);
    assert.equal(normalizeTransfer({ ...good, profile: { username: "no@symbols" } }).profile, null);
    assert.equal(normalizeTransfer({ ...good, profile: { username: "ada", avatar: "javascript:alert(1)" } }).profile.avatar, null);
  });
});
