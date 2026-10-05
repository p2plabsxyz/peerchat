import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  MAX_ROOM_BANS,
  acceptsCreatorKey,
  addRoomBan,
  isPeerBannedFromRoom,
  isRoomCreatorConnection,
  normalizeCreatorKey,
  normalizeRoomBans,
  peerIdForCreatorKey,
  removeRoomBan,
  resolveCreatorKey,
} from "../lib/room-moderation.js";

const ROOM = "ab".repeat(32);
const CREATOR = "c0ffee11" + "a".repeat(56);
const IMPOSTOR = "c0ffee11" + "b".repeat(56);
const SOMEONE = "d00dfeed" + "c".repeat(56);

describe("room creator moderation", () => {
  it("takes a creator key as 64 hex characters or not at all", () => {
    assert.equal(normalizeCreatorKey(CREATOR.toUpperCase()), CREATOR);
    assert.equal(normalizeCreatorKey("c0ffee11"), "");
    assert.equal(normalizeCreatorKey("z".repeat(64)), "");
    assert.equal(peerIdForCreatorKey(CREATOR), "c0ffee11");
  });

  // The short id in a room record is 32 bits. Someone can grind a key that
  // starts the same way in minutes, so it is a label, never the thing a
  // removal is checked against.
  it("does not mistake the short id for being the creator", () => {
    assert.equal(peerIdForCreatorKey(IMPOSTOR), peerIdForCreatorKey(CREATOR));
    assert.equal(
      isRoomCreatorConnection({ roomKey: ROOM, storedKey: CREATOR, connectionKey: IMPOSTOR }),
      false,
    );
    assert.equal(
      isRoomCreatorConnection({ roomKey: ROOM, storedKey: CREATOR, connectionKey: CREATOR }),
      true,
    );
    assert.equal(
      isRoomCreatorConnection({ roomKey: ROOM, storedKey: "", connectionKey: CREATOR }),
      false,
    );
  });

  // Anyone can claim to know who made a room. Only one peer can prove it, by
  // being on the other end of the connection the claim arrived on.
  it("takes a creator key from the creator and nobody else", () => {
    const base = { roomKey: ROOM, storedKey: "", createdBy: "c0ffee11" };

    assert.equal(acceptsCreatorKey({ ...base, announcedKey: CREATOR, connectionKey: CREATOR }), true);
    assert.equal(acceptsCreatorKey({ ...base, announcedKey: CREATOR, connectionKey: SOMEONE }), false);
    assert.equal(acceptsCreatorKey({ ...base, announcedKey: SOMEONE, connectionKey: SOMEONE }), false);
    assert.equal(
      acceptsCreatorKey({
        roomKey: ROOM, storedKey: CREATOR, createdBy: "c0ffee11",
        announcedKey: IMPOSTOR, connectionKey: IMPOSTOR,
      }),
      false,
    );
  });

  it("keeps removals once each, by key where there is one", () => {
    const bans = normalizeRoomBans([
      { id: "c0ffee11", at: 1 },
      { key: CREATOR, at: 2 },
      { id: "nothex!!", at: 3 },
      { id: "d00dfeed", at: 0 },
    ]);

    assert.equal(bans.length, 2);
    assert.equal(bans.find((ban) => ban.id === "c0ffee11").key, CREATOR);
    assert.equal(bans.find((ban) => ban.id === "d00dfeed").key, "");
  });

  // A device that joins after somebody was removed never met them, and said
  // "c0ffee11 was removed" with only eight letters of their key to go on.
  it("carries the name the creator knew them by", () => {
    const bans = addRoomBan([], { id: "c0ffee11", at: 5, name: "  Bob   Smith " });
    assert.equal(bans[0].name, "Bob Smith");
    const relayed = normalizeRoomBans(JSON.parse(JSON.stringify(bans)));
    assert.equal(relayed[0].name, "Bob Smith");
    assert.equal(normalizeRoomBans([...relayed, { key: CREATOR, at: 6 }]).find((ban) => ban.id === "c0ffee11").name, "Bob Smith");
    // Only what a profile name may be: nothing else rides in on it.
    for (const name of ["<b>Bob</b>", "Bob\u202e", "x".repeat(51), 42, null]) {
      assert.equal(normalizeRoomBans([{ id: "c0ffee11", at: 1, name }])[0].name, "");
    }
  });

  it("bounds the list so relaying cannot grow it forever", () => {
    const many = Array.from({ length: MAX_ROOM_BANS + 50 }, (_, index) => ({
      id: index.toString(16).padStart(8, "0"),
      at: index + 1,
    }));
    assert.equal(normalizeRoomBans(many).length, MAX_ROOM_BANS);
  });

  it("catches the key it removed and nobody else", () => {
    const bans = addRoomBan([], { key: CREATOR, at: 5 });
    assert.equal(isPeerBannedFromRoom(bans, { connectionKey: CREATOR }), true);
    assert.equal(isPeerBannedFromRoom(bans, { connectionKey: IMPOSTOR }), false);
    assert.equal(isPeerBannedFromRoom(bans, { connectionKey: SOMEONE }), false);
  });

  // Somebody can be removed while they are offline, and all the room remembers
  // of them then is the short id.
  it("catches whoever turns up with a short id it removed", () => {
    const bans = addRoomBan([], { id: "c0ffee11", at: 5 });
    assert.equal(isPeerBannedFromRoom(bans, { connectionKey: CREATOR }), true);
    assert.equal(isPeerBannedFromRoom(bans, { connectionKey: IMPOSTOR }), true);
    assert.equal(isPeerBannedFromRoom(bans, { peerId: "d00dfeed" }), false);
  });

  it("removes nobody from an empty list, and takes a removal back", () => {
    assert.equal(isPeerBannedFromRoom([], { connectionKey: CREATOR }), false);
    assert.equal(isPeerBannedFromRoom(null, { connectionKey: CREATOR }), false);
    const bans = addRoomBan([], { key: CREATOR, at: 5 });
    assert.deepEqual(removeRoomBan(bans, "c0ffee11"), []);
    assert.equal(removeRoomBan(bans, "d00dfeed").length, 1);
  });

  it("drops garbage rather than storing it", () => {
    assert.deepEqual(normalizeRoomBans("not a list"), []);
    assert.deepEqual(normalizeRoomBans([null, 3, { id: 12 }]), []);
    assert.deepEqual(addRoomBan([], { id: "nope" }), []);
    assert.equal(resolveCreatorKey(ROOM, ""), "");
  });
});

describe("room creator moderation, wired up", () => {
  it("checks a removal against the connection it arrived on", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");

    assert.match(p2p, /localKey = sdk\.publicKey \? b4a\.toString\(sdk\.publicKey, "hex"\)\.toLowerCase\(\) : ""/);
    assert.match(p2p, /isRoomCreatorConnection\(\{[\s\S]{0,160}connectionKey: fullId,/);
    assert.match(p2p, /acceptsCreatorKey\(\{[\s\S]{0,220}connectionKey: fullId,/);
    // Their list replaces ours outright: they are the record.
    assert.match(p2p, /room\.bans = normalizeRoomBans\(msg\.bans\)/);
  });

  it("counts nothing a removed peer sends, including a removal list", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
    const banCheck = p2p.indexOf("if (peerRecord && isPeerRemovedFromRoom(msg.roomKey, peerRecord)) continue;");
    const banHandler = p2p.indexOf('if (msg.type === "room-bans")');
    assert.ok(banCheck > -1 && banHandler > -1);
    assert.ok(banCheck < banHandler, "the check has to sit above every handler");
  });

  // A removal stops one room, and a connection carries every room two people
  // share. Destroying it took them offline everywhere the two of you met, and
  // threw away the removal notice still queued on it, so they never learned why.
  it("stops the room without stopping the connection", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");

    // Nothing of that room reaches them: no relay, no member list, no history.
    assert.match(p2p, /peerSharesRoom\(peer, roomKey\) && !isPeerRemovedFromRoom\(roomKey, peer\)/);
    const share = p2p.slice(p2p.indexOf("function shareMembers"), p2p.indexOf("function announceJoins"));
    assert.match(share, /if \(connectionRemovedFrom\(conn, rk\)\) continue;/);
    const sync = p2p.slice(p2p.indexOf("async function syncRoomHistoryTo"), p2p.indexOf("async function syncHistoryTo"));
    assert.match(sync, /if \(connectionRemovedFrom\(conn, rk\)\) return;/);

    // And nothing anywhere takes the connection down over a room ban.
    assert.doesNotMatch(p2p, /dropRemovedPeer/);
    assert.doesNotMatch(p2p, /enforceRoomBans/);
  });

  it("gives them the creator key before the list it has to be checked against", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
    // Everything about a room goes out in one place, once the peer proves it
    // holds the key.
    const opening = p2p.slice(p2p.indexOf("function shareRoomsWith("), p2p.indexOf("function shareProfile("));
    assert.ok(opening.includes("sendRoomBans(conn, rk)"));

    // The other way round, the list arrived with nothing to check it against
    // and was dropped, so leaving and rejoining reopened the room.
    assert.ok(opening.indexOf("sendRoomMeta(conn, rk)") < opening.indexOf("sendRoomBans(conn, rk)"));
  });

  it("lets only the creator remove, and never themselves", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
    const action = p2p.slice(
      p2p.indexOf('if (action === "remove-room-member")'),
      p2p.indexOf('if (action === "restore-room-member")'),
    );
    assert.match(action, /if \(!isRoomCreator\(rk\)\)/);
    assert.match(action, /cannot remove yourself/);
    assert.match(action, /nobody to remove from a direct message/);
    assert.match(action, /key: connected\?\.fullId \|\| ""/);
  });

  // The key belongs to the room you made, not to every room you are in. On the
  // join path instead, everyone joining a room would have believed they made it.
  it("records the creator key when a room is made and nowhere else", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");

    const create = p2p.slice(p2p.indexOf('if (action === "create-key")'), p2p.indexOf('if (action === "join-dm")'));
    assert.match(create, /roomKey: key, isHost: true/);
    assert.match(create, /creatorKey: localKey/);

    assert.equal((p2p.match(/creatorKey: localKey,/g) || []).length, 1, "only the room being created gets it");
    // A room you joined learns it from the creator, and never assumes it.
    const join = p2p.slice(p2p.indexOf("roomKey, isHost: false,"));
    assert.match(join.slice(0, join.indexOf("};")), /creatorKey: "",/);
  });

  // Three things went wrong the first time this shipped, and all three are
  // about a removal being a fact the room keeps rather than one delete.
  it("filters a removed member out of the list, not just deletes them once", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const list = app.slice(app.indexOf("const renderMemberList ="), app.indexOf("openModal(\"room-info-modal\")"));

    // The list is rebuilt from what peers relay, so deleting the stored entry
    // only lasted until the next member list arrived from somebody else.
    assert.match(list, /const removed = new Set\(\(room\.bans \|\| \[\]\)\.map\(\(ban\) => ban\.id\)\)/);
    assert.match(list, /if \(removed\.has\(id\)\) continue;/);
  });

  it("says a removal out loud in the room, on every peer that honours it", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
    assert.match(p2p, /function appendRemovalNotice\(roomKey, peerId, username\)/);
    // By name: "the creator" tells nobody in the room who that was.
    assert.match(p2p, /was removed from the room by \$\{by\}/);
    assert.match(p2p, /room\?\.createdByName \|\| room\?\.createdBy \|\| "whoever made the room"/);

    // The creator says it when they do it.
    const action = p2p.slice(p2p.indexOf('if (action === "remove-room-member")'), p2p.indexOf('if (action === "restore-room-member")'));
    assert.match(action, /appendRemovalNotice\(rk, peerId, removedName\)/);

    // Everyone else says it when the removal reaches them, and only for bans
    // that are new to them rather than the whole list every time.
    const receive = p2p.slice(p2p.indexOf('if (msg.type === "room-bans")'), p2p.indexOf('if (msg.type === "room-meta")'));
    assert.match(receive, /const before = new Set\(/);
    assert.match(receive, /if \(!before\.has\(ban\.id\)\) appendRemovalNotice/);
  });

  it("keeps a removed person out of somebody else's history sync", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
    assert.match(p2p, /isPeerIdRemovedFromRoom\(msg\.roomKey, normPeerId\(msg\.sender\)\)\) continue;/);

    // Above the sync handlers, or their messages are appended before it looks.
    const guard = p2p.indexOf("isPeerIdRemovedFromRoom(msg.roomKey, normPeerId(msg.sender))");
    const syncHandler = p2p.indexOf('if (msg.type === "sync") {');
    assert.ok(guard > -1 && syncHandler > -1 && guard < syncHandler);
  });

  it("fills a creator key in on the device that made the room", async () => {
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");
    const init = p2p.slice(p2p.indexOf("export function initChat("), p2p.indexOf('sdk.swarm.on("connection"'));

    assert.match(init, /if \(room\.isHost && !room\.creatorKey\) \{\n\s+room\.creatorKey = localKey;/);
    // And after the file has been read, or there are no rooms to walk yet.
    assert.ok(init.indexOf("loadData();") < init.indexOf("room.creatorKey = localKey"));
    assert.match(init, /if \(filledCreatorKey\) persistData\(\);/);
  });

  it("offers removing to the creator alone", async () => {
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const p2p = await readFile(new URL("../p2p.js", import.meta.url), "utf8");

    assert.match(app, /room\.isCreator && id !== S\.profile\?\.id/);
    // And it says what it means before doing it.
    assert.match(app, /will not be able to come back/);
    assert.match(app, /You were removed from this room by/);

    // The key itself never reaches the renderer. Nothing on screen needs it,
    // and the one thing that did was copying it out to pin, which is done.
    assert.doesNotMatch(p2p, /creatorKey: resolveCreatorKey/);
    assert.doesNotMatch(app, /creatorKey/);
  });

  // P2P Republic predates all of this and its own record names a device whose
  // storage is long gone, so nothing announced could settle who moderates it.
  it("pins a creator key for P2P Republic in the source", async () => {
    const { PRE_JOINED_ROOM_KEY } = await import("../rooms.js");
    const pinned = resolveCreatorKey(PRE_JOINED_ROOM_KEY, "");
    assert.match(pinned, /^[a-f0-9]{64}$/);

    // Nothing stored locally and nothing announced can move it.
    assert.equal(resolveCreatorKey(PRE_JOINED_ROOM_KEY, "ff".repeat(32)), pinned);
    assert.equal(
      acceptsCreatorKey({
        roomKey: PRE_JOINED_ROOM_KEY, storedKey: "", createdBy: "",
        announcedKey: "ab".repeat(32), connectionKey: "ab".repeat(32),
      }),
      false,
    );
    assert.equal(
      isRoomCreatorConnection({ roomKey: PRE_JOINED_ROOM_KEY, storedKey: "", connectionKey: pinned }),
      true,
    );
  });
});
