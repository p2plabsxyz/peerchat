import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import {
  buildDirectInviteUrl,
  buildInviteUrl,
  inviteNamesCreator,
  isDirectRoomFor,
  parseDirectInvite,
  parseInvite,
  parseRoomInvite,
  splitDirectPeer,
  INVITE_BASE,
} from "../lib/invite.js";

const roomKey = () => randomBytes(32).toString("hex");
// checkCreatorProof from lib/room-move.js, which the backend passes in. That
// file needs the npm packages, and this suite runs without them in CI, so the
// same bytes are worked out here. test/room-move.test.js pins them.
const checkCreatorProof = (room, creator, proof) =>
  createHash("sha256").update(`peersky-chat/4 room\n${creator}\n${proof}`).digest("hex") === room;

// The creator vector from test/room-move.test.js (creator seed 0x21). The same
// link and the same result are in PeerSky Mobile's invite test, so if either
// app changes a byte of the link, both fail.
const SHARED_ROOM = "7fb72ca22e0efb0506a7402bf3d3a1548e2b7244b9ff2d8cb3fb3a063851d932";
const SHARED_CREATOR = "884b8857f4eaa1613c61504db34d4beaf346517a0e31de3cddd4d9b4201d9d0b";
const SHARED_PROOF = "00000000000000000000000000000000000000000000000000000000000172fd";
const SHARED_LINK = "peersky://p2p/peerchat/#room=7fb72ca22e0efb0506a7402bf3d3a1548e2b7244b9ff2d8cb3fb3a063851d932&creator=884b8857f4eaa1613c61504db34d4beaf346517a0e31de3cddd4d9b4201d9d0b&proof=00000000000000000000000000000000000000000000000000000000000172fd";

describe("an invite that says who made the room", () => {
  it("is the same link in both apps", () => {
    assert.equal(buildInviteUrl(SHARED_ROOM, SHARED_CREATOR, SHARED_PROOF), SHARED_LINK);
    assert.deepEqual(parseRoomInvite(SHARED_LINK, checkCreatorProof), {
      roomKey: SHARED_ROOM,
      creatorKey: SHARED_CREATOR,
      creatorProof: SHARED_PROOF,
    });
    // An older build reads the room alone.
    assert.equal(parseInvite(SHARED_LINK), SHARED_ROOM);
    assert.equal(new URLSearchParams(SHARED_LINK.split("#")[1]).get("room"), SHARED_ROOM);
  });

  it("carries the creator only as a whole key, and the proof only with it", () => {
    assert.equal(buildInviteUrl(SHARED_ROOM, SHARED_CREATOR), `${INVITE_BASE}#room=${SHARED_ROOM}&creator=${SHARED_CREATOR}`);
    assert.equal(buildInviteUrl(SHARED_ROOM, "", SHARED_PROOF), `${INVITE_BASE}#room=${SHARED_ROOM}`);
    assert.equal(buildInviteUrl(SHARED_ROOM, "884b8857", SHARED_PROOF), `${INVITE_BASE}#room=${SHARED_ROOM}`);
    assert.equal(buildInviteUrl(SHARED_ROOM, SHARED_CREATOR, "nope"), `${INVITE_BASE}#room=${SHARED_ROOM}&creator=${SHARED_CREATOR}`);
    // Lowercase, whatever it was given.
    assert.equal(buildInviteUrl(SHARED_ROOM.toUpperCase(), SHARED_CREATOR.toUpperCase(), SHARED_PROOF.toUpperCase()), SHARED_LINK);
  });

  it("drops the creator too when the proof does not make the room's key", () => {
    const none = { roomKey: SHARED_ROOM, creatorKey: "", creatorProof: "" };
    const other = "ab".repeat(32);
    assert.deepEqual(parseRoomInvite(`#room=${SHARED_ROOM}&creator=${other}&proof=${SHARED_PROOF}`, checkCreatorProof), none);
    assert.deepEqual(parseRoomInvite(`#room=${SHARED_ROOM}&creator=${SHARED_CREATOR}&proof=${"00".repeat(32)}`, checkCreatorProof), none);
    assert.deepEqual(parseRoomInvite(`#room=${SHARED_ROOM}&creator=${SHARED_CREATOR}&proof=short`, checkCreatorProof), none);
    assert.deepEqual(parseRoomInvite(`#room=${SHARED_ROOM}&creator=${SHARED_CREATOR}&proof=`, checkCreatorProof), none);
    // Nothing to check it with is not a check.
    assert.deepEqual(parseRoomInvite(SHARED_LINK), none);
    assert.deepEqual(parseRoomInvite(SHARED_LINK, () => "yes"), none);
  });

  it("keeps a creator that comes without a proof, and only a whole key", () => {
    assert.deepEqual(parseRoomInvite(`#room=${SHARED_ROOM}&creator=${SHARED_CREATOR.toUpperCase()}`, checkCreatorProof), {
      roomKey: SHARED_ROOM, creatorKey: SHARED_CREATOR, creatorProof: "",
    });
    for (const creator of ["884b8857", "zz".repeat(32), ""]) {
      assert.deepEqual(parseRoomInvite(`#room=${SHARED_ROOM}&creator=${creator}`, checkCreatorProof), {
        roomKey: SHARED_ROOM, creatorKey: "", creatorProof: "",
      });
    }
    // A proof with no creator is nothing.
    assert.deepEqual(parseRoomInvite(`#room=${SHARED_ROOM}&proof=${SHARED_PROOF}`, checkCreatorProof), {
      roomKey: SHARED_ROOM, creatorKey: "", creatorProof: "",
    });
  });

  it("needs a room, as before", () => {
    const none = { roomKey: "", creatorKey: "", creatorProof: "" };
    assert.deepEqual(parseRoomInvite(`#creator=${SHARED_CREATOR}&proof=${SHARED_PROOF}`, checkCreatorProof), none);
    assert.deepEqual(parseRoomInvite("", checkCreatorProof), none);
    assert.deepEqual(parseRoomInvite(null, checkCreatorProof), none);
    assert.deepEqual(parseRoomInvite(buildDirectInviteUrl(SHARED_CREATOR), checkCreatorProof), none);
  });

  it("is told apart from a plain one before anything is checked", () => {
    assert.equal(inviteNamesCreator(SHARED_LINK), true);
    assert.equal(inviteNamesCreator(`#room=${SHARED_ROOM}&creator=${SHARED_CREATOR}`), true);
    assert.equal(inviteNamesCreator(buildInviteUrl(SHARED_ROOM)), false);
    assert.equal(inviteNamesCreator(`#creator=${SHARED_CREATOR}`), false);
    assert.equal(inviteNamesCreator(""), false);
  });
});

describe("invite links", () => {
  it("builds a peersky:// link that round-trips", () => {
    const key = roomKey();
    const url = buildInviteUrl(key);
    assert.ok(url.startsWith(INVITE_BASE), url);
    assert.equal(parseInvite(url), key);
  });

  // The key rides in the fragment so it is never part of a resource path.
  it("keeps the key in the fragment", () => {
    const key = roomKey();
    assert.equal(buildInviteUrl(key), `${INVITE_BASE}#room=${key}`);
  });

  it("accepts a bare fragment or query, as pasted", () => {
    const key = roomKey();
    assert.equal(parseInvite(`#room=${key}`), key);
    assert.equal(parseInvite(`?room=${key}`), key);
    assert.equal(parseInvite(`${INVITE_BASE}?room=${key}`), key);
  });

  it("normalises case so the key matches stored rooms", () => {
    const key = roomKey();
    assert.equal(parseInvite(`#room=${key.toUpperCase()}`), key);
    assert.equal(buildInviteUrl(key.toUpperCase()), `${INVITE_BASE}#room=${key}`);
  });

  it("refuses anything that is not a 64-hex room key", () => {
    for (const bad of ["", "#room=", "#room=nope", `#room=${"a".repeat(63)}`,
                       `#room=${"a".repeat(65)}`, `#room=${"g".repeat(64)}`, INVITE_BASE]) {
      assert.equal(parseInvite(bad), "", `should reject: ${bad}`);
    }
    for (const bad of [null, undefined, 42, "", "short"]) {
      assert.equal(buildInviteUrl(bad), "", `should not build from: ${bad}`);
    }
  });

  it("ignores other params in the fragment", () => {
    const key = roomKey();
    assert.equal(parseInvite(`#room=${key}&from=bob`), key);
    assert.equal(parseInvite(`#other=1`), "");
  });
});

// A personal invite says who to ask, not how to get in. The person on the other
// end still accepts, declines or blocks, which is what makes it safe to put on
// a screen for a stranger to scan.
describe("personal invite links", () => {
  const PEER = "a1b2c3d4";
  const KEY = `${PEER}${"5e".repeat(28)}`;
  const ROOM = "ab".repeat(32);

  it("carry the whole key and round-trip", () => {
    const url = buildDirectInviteUrl(KEY);
    assert.equal(url, `peersky://p2p/peerchat/#dm=${KEY}`);
    assert.equal(parseDirectInvite(url), KEY);
    assert.equal(parseDirectInvite(`#dm=${KEY.toUpperCase()}`), KEY);
    assert.equal(buildDirectInviteUrl(KEY.toUpperCase()), url);
  });

  // Links already shared carry the peer id. They keep working.
  it("still open an older link with only the peer id", () => {
    assert.equal(parseDirectInvite(`peersky://p2p/peerchat/#dm=${PEER}`), PEER);
    assert.equal(parseDirectInvite(`#dm=${PEER.toUpperCase()}`), PEER);
    assert.equal(parseDirectInvite(PEER), PEER);
  });

  it("are made only from a whole key", () => {
    for (const bad of [PEER, "nothex!!", `${KEY}0`, "", null]) {
      assert.equal(buildDirectInviteUrl(bad), "");
    }
    assert.equal(parseDirectInvite("#dm=nothex!!"), "");
    assert.equal(parseDirectInvite(""), "");
  });

  it("read as the peer id everything shows and the key behind it", () => {
    assert.deepEqual(splitDirectPeer(KEY.toUpperCase()), { id: PEER, key: KEY });
    assert.deepEqual(splitDirectPeer(PEER), { id: PEER, key: "" });
    assert.deepEqual(splitDirectPeer("nothex!!"), { id: "", key: "" });
    assert.deepEqual(splitDirectPeer(null), { id: "", key: "" });
  });

  // A link opens the conversation already there, unless that one is with
  // someone else whose key starts the same way.
  it("open only the conversation with the key they name", () => {
    const bound = { isDM: true, dmWith: PEER, dmWithKey: KEY, pendingAcceptance: false };
    const other = { ...bound, dmWithKey: `${PEER}${"77".repeat(28)}` };
    const waiting = { isDM: true, dmWith: PEER, dmWithKey: null, pendingAcceptance: true };
    const older = { isDM: true, dmWith: PEER, pendingAcceptance: false };

    assert.equal(isDirectRoomFor(bound, KEY), true);
    assert.equal(isDirectRoomFor(other, KEY), false);
    // A request that went to no key yet is asked again, to this one.
    assert.equal(isDirectRoomFor(waiting, KEY), false);
    // A conversation from before keys were kept is the one with that id.
    assert.equal(isDirectRoomFor(older, KEY), true);
    // An older link only has the id to go by.
    for (const room of [bound, other, waiting, older]) assert.equal(isDirectRoomFor(room, PEER), true);
    assert.equal(isDirectRoomFor({ ...bound, isDM: false }, KEY), false);
    assert.equal(isDirectRoomFor({ ...bound, dmWith: "ffffffff" }, KEY), false);
  });

  // A room key is a capability and a person's key is not, so neither may be
  // read as the other.
  it("keep rooms and people apart", () => {
    assert.equal(parseDirectInvite(buildInviteUrl(ROOM)), "");
    assert.equal(parseInvite(buildDirectInviteUrl(KEY)), "");
    // Both are 64 hex, so a bare one is the room key it always was.
    assert.equal(parseDirectInvite(ROOM), "");
    assert.equal(parseInvite(`#room=${ROOM}`), ROOM);
  });
});

// A link opened in a tab that already shows PeerChat only changes the part
// after the #, so the page is not loaded again. The invite was read at load
// and nowhere else, so nothing happened.
describe("an invite opened while PeerChat is open", () => {
  it("is read when the address changes, and opened once", async () => {
    const { readFile } = await import("node:fs/promises");
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /addEventListener\("hashchange", \(\) => \{\s*\/\/[^\n]*\n\s*if \(takeInviteFromAddress\(\) && S\.profile\?\.username\) void consumeInvite\(\);/);
    // Wiped from the address as soon as it is read, so history does not keep it.
    const take = app.slice(app.indexOf("function takeInviteFromAddress()"), app.indexOf("takeInviteFromAddress();"));
    assert.match(take, /history\.replaceState\(null, "", location\.pathname \+ location\.search\)/);
    // Taken before it is used, so the same link never opens twice.
    const consume = app.slice(app.indexOf("async function consumeInvite()"), app.indexOf("async function init()"));
    assert.ok(consume.indexOf("pendingInvite = null") < consume.indexOf("chat.joinRoom(invite, inviteLink)"));
    assert.ok(consume.indexOf('pendingInviteLink = ""') < consume.indexOf("chat.joinRoom(invite, inviteLink)"));
  });

  // The link can say who made the room. The page never holds the creator key:
  // the backend reads it from the link and checks it, and builds the link to copy.
  it("goes to the backend whole, from the address and from the join box", async () => {
    const { readFile } = await import("node:fs/promises");
    const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
    const api = await readFile(new URL("../chat-api.js", import.meta.url), "utf8");
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    const take = app.slice(app.indexOf("function takeInviteFromAddress()"), app.indexOf("takeInviteFromAddress();"));
    assert.match(take, /pendingInviteLink = room \? location\.hash : "";/);
    // A room here already is joined again only when the link says who made it.
    const consume = app.slice(app.indexOf("async function consumeInvite()"), app.indexOf("async function init()"));
    assert.match(consume, /if \(!S\.rooms\[invite\] \|\| inviteNamesCreator\(inviteLink\)\)/);
    // The join box takes a link as well as a key.
    const join = app.slice(app.indexOf('$("join-room-form")'), app.indexOf('$("message-input")?.addEventListener("focus"'));
    assert.match(join, /const key = bareKey \? pasted\.toLowerCase\(\) : parseInvite\(pasted\);/);
    assert.match(join, /await chat\.joinRoom\(key, bareKey \? "" : pasted\);/);
    assert.match(html, /id="join-room-key" placeholder="Paste an invite link or room key" maxlength="512"/);
    // In the body, never the address, which PeerSky writes to its log.
    assert.match(api, /joinRoom: \(roomKey, invite = ""\) => apiRequest\("join", invite \? \{ roomKey, body: \{ invite \} \} : \{ roomKey, post: true \}\)/);
    // Copy invite copies the link the backend builds.
    const info = app.slice(app.indexOf('const inviteBtn = $("ri-copy-invite");'), app.indexOf('$("ri-copy-key").onclick'));
    assert.match(info, /chat\.inviteLink\(inviteRoom\)/);
    assert.doesNotMatch(app, /creatorKey|creatorProof/);
  });
});
