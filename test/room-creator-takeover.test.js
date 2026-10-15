// Who made a room, when somebody in it says they did. A device that joined from
// a bare room key used to take the first member who said "I made it" on their
// own connection for the creator, for good: a proof from the real creator was
// refused afterwards, and whatever that member signed counted, details, removal
// lists and moves alike. A key shown with the secret that made the room's key
// now replaces one that was only announced, and what that one signed goes with
// it. An invite can say who made the room from the start. Over real
// connections.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { checkCreatorProof, makeCreatorRoomKey, signMove } from "../lib/room-move.js";
import { newKeyChain } from "../lib/key-chain.js";
import { signRoomDetails } from "../lib/room-details.js";
import { signRemovals } from "../lib/removal-signature.js";
import { PRE_JOINED_ROOM_KEY } from "../rooms.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const keyOf = (keyPair) => keyPair.publicKey.toString("hex");
const idOf = (keyPair) => keyOf(keyPair).slice(0, 8);
const DEVICE = pair(91);
const CREATOR = pair(92);
// A member who says they made the rooms below.
const ELI = pair(93);
// Members who pass on what the creator signed.
const BEN = pair(94);
const CORA = pair(95);
const FAY = pair(96);
// Members Eli turned a room against: removed one, moved a room away from the other.
const GUS = pair(97);
const HAL = pair(98);
const INVITE = "peersky://p2p/peerchat/";
// A version far past any clock, as a fake creator can sign.
const HUGE = 9_000_000_000_000_000;
const FILTERS_OFF = { abuseFilter: false, nsfwFilter: false, spamRateLimit: 50 };
const DEFAULT_FILTERS = { abuseFilter: true, nsfwFilter: true, spamRateLimit: 10 };

const joinedTopics = [];
const leftTopics = [];
const swarm = new EventEmitter();
swarm.flush = async () => {};
const feeds = new Map();
function fakeFeed() {
  const feed = new EventEmitter();
  feed.entries = [];
  Object.defineProperty(feed, "length", { get: () => feed.entries.length });
  feed.ready = async () => {};
  feed.get = async (index) => feed.entries[index];
  feed.append = async (entry) => { feed.entries.push(entry); feed.emit("append"); };
  return feed;
}
const sdk = {
  publicKey: DEVICE.publicKey,
  corestore: {
    get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name),
    createKeyPair: async (name) => (name === "noise" ? DEVICE : crypto.keyPair()),
  },
  join(topic) { joinedTopics.push(topic.toString("hex")); },
  leave: async (topic) => { leftTopics.push(topic.toString("hex")); },
  swarm,
};

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
};
const rooms = () => call("get-rooms", "GET");
const roomOf = async (roomKey) => (await rooms()).rooms.find((room) => room.roomKey === roomKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const open = [];
async function connect(keyPair, roomKeys) {
  const pair = await securePair({ clientKeyPair: keyPair });
  const peer = { pair, frames: [] };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: roomKeys.map(deriveTopic) });
  let buffer = "";
  await new Promise((opened) => {
    peer.transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line) { try { peer.frames.push(JSON.parse(line)); } catch {} }
      }
    }, { onopen: opened });
  });
  peer.send = (frame) => peer.transport.send(JSON.stringify(frame) + "\n");
  peer.send({ ...JSON.parse(topicsFrame(pair.clientStream, roomKeys)), pass: true, move: true });
  peer.of = (type, roomKey) => peer.frames.filter((frame) => frame.type === type && (!roomKey || frame.room === wireRoom(roomKey)));
  peer.close = async () => { try { peer.transport.close(); } catch {} await pair.close().catch(() => {}); };
  await eventually(() => peer.of("room-meta")[0] || peer.of("sync-done")[0], "the rooms opening");
  return peer;
}

// What the page hears, as it does from receive-all.
const events = [];
let eventReader = null;
async function watchEvents() {
  const res = await handleChatRequest({ url: "hyper://chat?action=receive-all", method: "GET" }, sdk);
  eventReader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    for (;;) {
      const { value, done } = await eventReader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop();
      for (const block of blocks) {
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (event && data) { try { events.push({ event, data: JSON.parse(data) }); } catch {} }
      }
    }
  })().catch(() => {});
}

const signedDetails = (roomKey, keyPair, fields) => signRoomDetails({
  topic: wireRoom(roomKey), name: "Club", bio: "", link: "", avatar: "",
  moderation: DEFAULT_FILTERS, keyPair, ...fields,
});
const signedList = (roomKey, keyPair, v, bans) => ({ v, sig: signRemovals({ topic: wireRoom(roomKey), version: v, bans, keyPair }) });
const banOf = (keyPair, name) => ({ id: idOf(keyPair), key: keyOf(keyPair), at: Date.now(), name });

// Rooms the creator made, which this device is in, written up front.
const CLUB = makeCreatorRoomKey(keyOf(CREATOR));
const TRIP = makeCreatorRoomKey(keyOf(CREATOR));
const CAMP = makeCreatorRoomKey(keyOf(CREATOR));
const DOCK = makeCreatorRoomKey(keyOf(CREATOR));
// Where Eli moved DOCK, before this device started.
const ELSEWHERE = makeCreatorRoomKey(keyOf(ELI));
const DOCK_MOVE = signMove({
  fromTopic: wireRoom(DOCK.roomKey), topicOf: wireRoom, to: ELSEWHERE.roomKey, proof: ELSEWHERE.creatorProof,
  chain: newKeyChain(), at: Date.now() - 60_000, keyPair: ELI,
});
// Rooms Eli, taken for the creator, turned against the members who could set
// them right: ROOK with Gus removed, VALE moved away before Hal was seen in it.
// MOOR is an ordinary room they connect through.
const MOOR = makeCreatorRoomKey(keyOf(CREATOR));
const ROOK = makeCreatorRoomKey(keyOf(CREATOR));
const VALE = makeCreatorRoomKey(keyOf(CREATOR));
const VALE_AWAY = makeCreatorRoomKey(keyOf(ELI));
const VALE_MOVE = signMove({
  fromTopic: wireRoom(VALE.roomKey), topicOf: wireRoom, to: VALE_AWAY.roomKey, proof: VALE_AWAY.creatorProof,
  chain: newKeyChain(), at: Date.now() - 60_000, keyPair: ELI,
});
// Rooms joined from invites here.
const HIKE = makeCreatorRoomKey(keyOf(CREATOR));
const LAKE = makeCreatorRoomKey(keyOf(CREATOR));
const PARK = makeCreatorRoomKey(keyOf(CREATOR));
const DIRECT = "e5".repeat(32);
let dir;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-creator-takeover-"));
  const theirs = (roomKey, name, fields = {}) => ({
    roomKey, name, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 120_000, joinedAt: Date.now() - 60_000,
    isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [], creatorKey: "", createdBy: "", createdByName: "",
    moderation: { ...DEFAULT_FILTERS }, ...fields,
  });
  // Eli said he made CAMP and DOCK, with details he signed, and moved DOCK.
  const elisCamp = {
    creatorKey: keyOf(ELI), createdBy: idOf(ELI), moderation: { ...FILTERS_OFF },
    details: signedDetails(CAMP.roomKey, ELI, { v: HUGE, name: "Camp", moderation: FILTERS_OFF }),
  };
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
    rooms: {
      [CLUB.roomKey]: theirs(CLUB.roomKey, "Club"),
      [TRIP.roomKey]: theirs(TRIP.roomKey, "Trip"),
      [CAMP.roomKey]: theirs(CAMP.roomKey, "Camp", elisCamp),
      [DOCK.roomKey]: theirs(DOCK.roomKey, "Dock", { creatorKey: keyOf(ELI), createdBy: idOf(ELI), movedTo: DOCK_MOVE }),
      [ELSEWHERE.roomKey]: theirs(ELSEWHERE.roomKey, "Dock", {
        creatorKey: keyOf(ELI), createdBy: idOf(ELI), creatorProof: ELSEWHERE.creatorProof,
        chain: DOCK_MOVE.chain, movedFrom: DOCK.roomKey,
      }),
      [MOOR.roomKey]: theirs(MOOR.roomKey, "Moor"),
      [ROOK.roomKey]: theirs(ROOK.roomKey, "Rook", { creatorKey: keyOf(ELI), createdBy: idOf(ELI), bans: [banOf(GUS, "Gus")] }),
      [VALE.roomKey]: theirs(VALE.roomKey, "Vale", { creatorKey: keyOf(ELI), createdBy: idOf(ELI), movedTo: VALE_MOVE }),
      [VALE_AWAY.roomKey]: theirs(VALE_AWAY.roomKey, "Vale", {
        creatorKey: keyOf(ELI), createdBy: idOf(ELI), creatorProof: VALE_AWAY.creatorProof,
        chain: VALE_MOVE.chain, movedFrom: VALE.roomKey,
      }),
      [PRE_JOINED_ROOM_KEY]: theirs(PRE_JOINED_ROOM_KEY, "P2P Republic"),
      [DIRECT]: theirs(DIRECT, "Cora", { isDM: true, dmWith: idOf(CORA), dmWithKey: keyOf(CORA) }),
    },
  }));
  initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
  await watchEvents();
  await eventually(() => joinedTopics.includes(wireRoom(ELSEWHERE.roomKey)), "the rooms joined at start");
});

after(async () => {
  for (const peer of open) await peer.close();
  await eventReader?.cancel().catch(() => {});
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a member who says they made a room", () => {
  const topic = wireRoom(CLUB.roomKey);
  let eli, ben, fay;

  before(async () => {
    eli = await connect(ELI, [CLUB.roomKey]);
    ben = await connect(BEN, [CLUB.roomKey]);
    fay = await connect(FAY, [CLUB.roomKey]);
  });

  it("is not named as its creator by anyone else", async () => {
    ben.send({ type: "room-meta", room: topic, name: "Club", createdByName: "Cora" });
    await sleep(300);
    assert.equal((await roomOf(CLUB.roomKey)).createdByName, "");
  });

  it("is taken for its creator while nobody shows otherwise, as before", async () => {
    eli.send({ type: "room-meta", room: topic, name: "Club", createdBy: idOf(ELI), creatorKey: keyOf(ELI), createdByName: "Eli" });
    eli.send({ type: "room-meta", room: topic, name: "Owned", details: signedDetails(CLUB.roomKey, ELI, { v: HUGE, name: "Owned", moderation: FILTERS_OFF }) });
    const bans = [banOf(CORA, "Cora")];
    eli.send({ type: "room-bans", room: topic, bans, signed: signedList(CLUB.roomKey, ELI, HUGE, bans) });
    const room = await eventually(async () => {
      const listed = await roomOf(CLUB.roomKey);
      return listed.name === "Owned" && listed.bans.length === 1 ? listed : null;
    }, "what Eli signed");
    assert.equal(room.createdBy, idOf(ELI));
    assert.equal(room.createdByName, "Eli");
    assert.deepEqual(room.moderation, FILTERS_OFF);
  });

  it("keeps what the creator signed, passed on meanwhile, waiting rather than dropping it", async () => {
    // Older versions than Eli's, which a fake creator can make any number.
    ben.send({ type: "room-meta", room: topic, name: "Club", details: signedDetails(CLUB.roomKey, CREATOR, { v: 2000, name: "Real club", moderation: { ...DEFAULT_FILTERS, spamRateLimit: 12 } }) });
    const bans = [banOf(ELI, "Eli")];
    ben.send({ type: "room-bans", room: topic, bans, signed: signedList(CLUB.roomKey, CREATOR, 1500, bans) });
    await sleep(300);
    // Neither checks out against the key held, so neither is taken yet.
    const room = await roomOf(CLUB.roomKey);
    assert.equal(room.name, "Owned");
    assert.deepEqual(room.bans.map((ban) => ban.id), [idOf(CORA)]);
  });

  it("puts the key shown with the secret in place of the announced one, and drops what that one signed", async () => {
    ben.send({ type: "room-meta", room: topic, name: "Club", creatorKey: keyOf(CREATOR), creatorProof: CLUB.creatorProof });
    const room = await eventually(async () => {
      const listed = await roomOf(CLUB.roomKey);
      return listed.createdBy === idOf(CREATOR) ? listed : null;
    }, "the creator key shown");
    // What waited is taken now, whatever version Eli's claimed.
    assert.equal(room.name, "Real club");
    assert.deepEqual(room.moderation, { ...DEFAULT_FILTERS, spamRateLimit: 12 });
    // Eli's list is gone, and the creator's, which removes Eli, is the list.
    assert.deepEqual(room.bans.map((ban) => ban.id), [idOf(ELI)]);
    assert.equal(room.createdByName, "");
    // And it goes on through the room with the secret.
    const meta = await eventually(() => fay.of("room-meta", CLUB.roomKey).find((frame) => frame.creatorProof), "the secret passed on");
    assert.equal(meta.creatorKey, keyOf(CREATOR));
  });

  it("takes nothing more signed with the announced key, from anyone", async () => {
    const cora = await connect(CORA, [CLUB.roomKey]);
    cora.send({ type: "room-meta", room: topic, name: "Owned", details: signedDetails(CLUB.roomKey, ELI, { v: HUGE + 1, name: "Owned again", moderation: FILTERS_OFF }) });
    const bans = [banOf(BEN, "Ben")];
    cora.send({ type: "room-bans", room: topic, bans, signed: signedList(CLUB.roomKey, ELI, HUGE + 1, bans) });
    const next = makeCreatorRoomKey(keyOf(ELI));
    cora.send({ type: "room-moved", room: topic, moves: [signMove({ fromTopic: topic, topicOf: wireRoom, to: next.roomKey, proof: next.creatorProof, chain: newKeyChain(), at: Date.now(), keyPair: ELI })] });
    await sleep(400);
    const room = await roomOf(CLUB.roomKey);
    assert.equal(room.name, "Real club");
    assert.deepEqual(room.bans.map((ban) => ban.id), [idOf(ELI)]);
    assert.equal((await rooms()).movedRooms[CLUB.roomKey], undefined);
  });

  it("is named only by the creator's own connection", async () => {
    ben.send({ type: "room-meta", room: topic, name: "Club", createdByName: "Ben" });
    await sleep(200);
    assert.equal((await roomOf(CLUB.roomKey)).createdByName, "");
    const creator = await connect(CREATOR, [CLUB.roomKey]);
    creator.send({ type: "room-meta", room: topic, name: "Real club", createdByName: "Dev" });
    await eventually(async () => (await roomOf(CLUB.roomKey)).createdByName === "Dev", "the creator's own name");
  });
});

describe("a move made by a member taken for the creator", () => {
  const topic = wireRoom(TRIP.roomKey);
  let eli, ben, theirs;

  before(async () => {
    ben = await connect(BEN, [TRIP.roomKey]);
    eli = await connect(ELI, [TRIP.roomKey]);
    eli.send({ type: "room-meta", room: topic, name: "Trip", createdBy: idOf(ELI), creatorKey: keyOf(ELI) });
    await eventually(async () => (await roomOf(TRIP.roomKey)).createdBy === idOf(ELI), "Eli taken for the creator");
  });

  it("is followed while nobody shows otherwise, as before", async () => {
    const next = makeCreatorRoomKey(keyOf(ELI));
    await sleep(5);
    const hop = signMove({ fromTopic: topic, topicOf: wireRoom, to: next.roomKey, proof: next.creatorProof, chain: newKeyChain(), at: Date.now(), keyPair: ELI });
    eli.send({ type: "room-moved", room: topic, moves: [hop] });
    await eventually(async () => (await rooms()).movedRooms[TRIP.roomKey] === next.roomKey, "the move followed");
    theirs = next.roomKey;
    await eventually(() => joinedTopics.includes(wireRoom(theirs)), "the room Eli made joined");
    await call("set-active", "POST", {}, theirs);
  });

  it("is undone once the creator's key is shown: the room it made is left, and the page goes back", async () => {
    const seen = events.length;
    ben.send({ type: "room-meta", room: topic, name: "Trip", creatorKey: keyOf(CREATOR), creatorProof: TRIP.creatorProof });
    await eventually(async () => (await roomOf(TRIP.roomKey))?.createdBy === idOf(CREATOR), "the creator key shown");
    const listed = await rooms();
    assert.equal(listed.movedRooms[TRIP.roomKey], undefined);
    assert.equal(listed.rooms.some((room) => room.roomKey === theirs), false);
    await eventually(() => leftTopics.includes(wireRoom(theirs)), "the room Eli made left");
    const back = await eventually(() => events.slice(seen).find((e) => e.event === "room-moved" && e.data.from === theirs), "the page sent back");
    assert.equal(back.data.to, TRIP.roomKey);
    // Ben is not told: undoing it here is nobody else's business.
    assert.equal(ben.frames.filter((frame) => frame.type === "room-moved").length, 1);
  });
});

// A member taken for the creator can remove the very people who could set
// the room right, or move it away from them. Their proof still counts.
describe("a member taken for the creator who turned the room against the others", () => {
  it("is set right by the secret from a member they removed here", async () => {
    const gus = await connect(GUS, [MOOR.roomKey, ROOK.roomKey]);
    gus.send({ type: "room-meta", room: wireRoom(ROOK.roomKey), name: "Rook", creatorKey: keyOf(CREATOR), creatorProof: ROOK.creatorProof });
    const room = await eventually(async () => {
      const listed = await roomOf(ROOK.roomKey);
      return listed?.createdBy === idOf(CREATOR) ? listed : null;
    }, "the creator key shown by a member Eli removed");
    // Eli's removal of Gus went with Eli.
    assert.deepEqual(room.bans, []);
  });

  it("is set right by the secret from a member held out of the room Eli moved, who is let in", async () => {
    const hal = await connect(HAL, [MOOR.roomKey, VALE.roomKey]);
    // Held out: Vale had moved before this device saw Hal in it.
    await sleep(200);
    assert.equal(hal.of("room-meta", VALE.roomKey).length, 0);
    hal.send({ type: "room-meta", room: wireRoom(VALE.roomKey), name: "Vale", creatorKey: keyOf(CREATOR), creatorProof: VALE.creatorProof });
    await eventually(async () => (await roomOf(VALE.roomKey))?.createdBy === idOf(CREATOR), "the creator key shown by a member held out");
    assert.equal((await rooms()).movedRooms[VALE.roomKey], undefined);
    await eventually(() => hal.of("room-meta", VALE.roomKey)[0], "Hal let into the room");
  });
});

describe("an invite that says who made the room", () => {
  const linkFor = (room, creator, proof) =>
    `${INVITE}#room=${room}` + (creator ? `&creator=${creator}` : "") + (proof ? `&proof=${proof}` : "");

  it("starts a room joined from it with that creator, so what they signed counts at once", async () => {
    const link = linkFor(HIKE.roomKey, keyOf(CREATOR), HIKE.creatorProof);
    const joining = call("join", "POST", { invite: link }, HIKE.roomKey);
    await eventually(() => joinedTopics.includes(wireRoom(HIKE.roomKey)), "the room joined");
    assert.equal((await roomOf(HIKE.roomKey)).createdBy, idOf(CREATOR));
    // A list the creator signed, from somebody who is not the creator, before
    // anybody in the room has said who made it.
    const cora = await connect(CORA, [HIKE.roomKey]);
    const bans = [banOf(ELI, "Eli")];
    cora.send({ type: "room-bans", room: wireRoom(HIKE.roomKey), bans, signed: signedList(HIKE.roomKey, CREATOR, 1000, bans) });
    cora.send({ type: "room-meta", room: wireRoom(HIKE.roomKey), name: "Hike", details: signedDetails(HIKE.roomKey, CREATOR, { v: 10, name: "Hike" }) });
    await eventually(async () => (await roomOf(HIKE.roomKey)).bans.length === 1, "the list taken");
    assert.equal((await joining).message, "Joined");
    // Its own invite says so too.
    assert.equal((await call("invite-link", "GET", null, HIKE.roomKey)).link, link);
  });

  it("says nothing about who made it when its secret does not make the room's key", async () => {
    // HIKE's secret, for another room.
    const joining = call("join", "POST", { invite: linkFor(LAKE.roomKey, keyOf(CREATOR), HIKE.creatorProof) }, LAKE.roomKey);
    await eventually(() => joinedTopics.includes(wireRoom(LAKE.roomKey)), "the room joined");
    const cora = await connect(CORA, [LAKE.roomKey]);
    cora.send({ type: "room-meta", room: wireRoom(LAKE.roomKey), name: "Lake" });
    await joining;
    assert.equal((await roomOf(LAKE.roomKey)).createdBy, "");
    assert.equal((await call("invite-link", "GET", null, LAKE.roomKey)).link, linkFor(LAKE.roomKey));
  });

  it("names a creator without the secret only until the secret shows another", async () => {
    const joining = call("join", "POST", { invite: linkFor(PARK.roomKey, keyOf(ELI)) }, PARK.roomKey);
    await eventually(() => joinedTopics.includes(wireRoom(PARK.roomKey)), "the room joined");
    assert.equal((await roomOf(PARK.roomKey)).createdBy, idOf(ELI));
    assert.equal((await call("invite-link", "GET", null, PARK.roomKey)).link, linkFor(PARK.roomKey, keyOf(ELI)));
    const ben = await connect(BEN, [PARK.roomKey]);
    ben.send({ type: "room-meta", room: wireRoom(PARK.roomKey), name: "Park", creatorKey: keyOf(CREATOR), creatorProof: PARK.creatorProof });
    await joining;
    await eventually(async () => (await roomOf(PARK.roomKey)).createdBy === idOf(CREATOR), "the creator key shown");
  });

  it("puts its creator in place of an announced one in a room here already, and drops what that one signed", async () => {
    assert.equal((await roomOf(CAMP.roomKey)).createdBy, idOf(ELI));
    const answer = await call("join", "POST", { invite: linkFor(CAMP.roomKey, keyOf(CREATOR), CAMP.creatorProof) }, CAMP.roomKey);
    assert.equal(answer.message, "Joined");
    const room = await roomOf(CAMP.roomKey);
    assert.equal(room.createdBy, idOf(CREATOR));
    // Eli's details named the room and turned the filters off. The room is
    // as a new join has it until the creator's own details come.
    assert.deepEqual(room.moderation, DEFAULT_FILTERS);
    assert.equal(room.name, `${CAMP.roomKey.slice(0, 8)}...`);
  });

  it("undoes a move the announced creator made, and opens the room it came from", async () => {
    assert.equal((await rooms()).movedRooms[DOCK.roomKey], ELSEWHERE.roomKey);
    const answer = await call("join", "POST", { invite: linkFor(DOCK.roomKey, keyOf(CREATOR), DOCK.creatorProof) }, DOCK.roomKey);
    assert.equal(answer.room.roomKey, DOCK.roomKey);
    const listed = await rooms();
    assert.equal(listed.movedRooms[DOCK.roomKey], undefined);
    assert.ok(listed.rooms.some((room) => room.roomKey === DOCK.roomKey));
    assert.equal(listed.rooms.some((room) => room.roomKey === ELSEWHERE.roomKey), false);
    await eventually(() => leftTopics.includes(wireRoom(ELSEWHERE.roomKey)), "the room Eli made left");
  });

  it("is what Copy invite gives: with the secret for a room made here, the key alone for P2P Republic and a direct message", async () => {
    const { roomKey } = await call("create-key", "POST", { name: "Made here" });
    const made = new URLSearchParams((await call("invite-link", "GET", null, roomKey)).link.split("#")[1]);
    assert.equal(made.get("room"), roomKey);
    assert.equal(made.get("creator"), keyOf(DEVICE));
    assert.ok(checkCreatorProof(roomKey, keyOf(DEVICE), made.get("proof")));
    assert.equal((await call("invite-link", "GET", null, PRE_JOINED_ROOM_KEY)).link, linkFor(PRE_JOINED_ROOM_KEY));
    assert.equal((await call("invite-link", "GET", null, DIRECT)).link, linkFor(DIRECT));
    // A room shown its creator with the secret passes both on.
    assert.equal((await call("invite-link", "GET", null, CLUB.roomKey)).link, linkFor(CLUB.roomKey, keyOf(CREATOR), CLUB.creatorProof));
  });
});
