// A room that moves to a new key when somebody is removed from it, and a room
// key that says who made the room.
//
// A room's key is its invite: whoever holds it can find the room, prove they
// are in it, and read it. Removing somebody stops every honest device talking to
// them, but they still hold the key, so with a modified app they could come back
// under a new name and read on. So when the person who made a room removes
// somebody, the room moves to a new key, and only the people still in it hear
// the new one.
//
// Two pieces make that safe without a server:
//
// - Who made a room. A room made on this version has a key made from its
//   creator's key and a secret:
//     sha256("peersky-chat/4 room\n" + creator key + "\n" + secret)
//   Anyone in the room can be shown the creator key and the secret and check
//   them against the room key they hold, so the creator key no longer has to
//   come over the creator's own connection. That is what lets a removal, or a
//   move, be checked by people who never meet the creator. The secret is as
//   private as the room key: with the creator key, which is public, it gives
//   the room key.
//
// - The move. The creator signs where the room goes:
//     "peersky-chat/4 moved\n" + old topic + "\n" + new topic + "\n" + when +
//     "\n" + the new chain's first hour + "\n" + sha256 of its secret
//   The new key is made the same way, so it says who made it too, and its
//   chain travels with the move, so everyone moved reads the same hours.
//
// A move goes on only to somebody this device saw in the room before the move
// was made, by key, not by the short id anyone can grind a key to match. So the
// person removed cannot come back under a new key and be handed the new room.
//
// PeerSky Mobile keeps the same rules in backend/peerchat/room-move.mjs. Both
// have to agree on every byte.
import { createHash, randomBytes } from "crypto";
import b4a from "b4a";
import crypto from "hypercore-crypto";

import { normalizeKeyChain, roomRotates } from "./key-chain.js";

const ROOM_LABEL = "peersky-chat/4 room";
const MOVE_LABEL = "peersky-chat/4 moved";
const HEX_64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
// Enough for the people a device meets in a busy room. The ones it saw longest
// ago go first.
export const MAX_KNOWN_KEYS = 2000;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function hex64(value) {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  return HEX_64.test(text) ? text : "";
}

/** The room key a creator key and a secret make, or "" for anything else. */
export function roomKeyFromCreator(creatorKey, secret) {
  const creator = hex64(creatorKey);
  const proof = hex64(secret);
  if (!creator || !proof) return "";
  return sha256(`${ROOM_LABEL}\n${creator}\n${proof}`);
}

/**
 * A new room key that says who made it and carries the mark for a key chain:
 * about 65,000 tries, a little over a tenth of a second.
 */
export function makeCreatorRoomKey(creatorKey, random = randomBytes) {
  if (!hex64(creatorKey)) throw new Error("A room needs its creator's key.");
  for (;;) {
    const creatorProof = b4a.toString(random(32), "hex");
    const roomKey = roomKeyFromCreator(creatorKey, creatorProof);
    if (roomRotates(roomKey)) return { roomKey, creatorProof };
  }
}

/** Whether this creator key and secret make this room key. */
export function checkCreatorProof(roomKey, creatorKey, secret) {
  const key = hex64(roomKey);
  return !!key && roomKeyFromCreator(creatorKey, secret) === key;
}

/** What the creator signs when a room moves. */
export function moveMessage(fromTopic, toTopic, at, chain) {
  const start = normalizeKeyChain(chain);
  return `${MOVE_LABEL}\n${fromTopic}\n${toTopic}\n${at}\n${start.first}\n${sha256(start.secret)}`;
}

/**
 * A move as kept or received: the new key, the secret that says who made it,
 * its chain, when, and the signature. Null when any of it is missing.
 */
export function normalizeMove(value) {
  const to = hex64(value?.to);
  const proof = hex64(value?.proof);
  const chain = normalizeKeyChain(value?.chain);
  const at = Number.isSafeInteger(value?.at) && value.at > 0 ? value.at : 0;
  const sig = typeof value?.sig === "string" && SIGNATURE.test(value.sig.toLowerCase()) ? value.sig.toLowerCase() : "";
  if (!to || !proof || !chain || !at || !sig) return null;
  return { to, proof, chain, at, sig };
}

/** The creator's signed move to a new key, or null when these keys cannot sign one. */
export function signMove({ fromTopic, topicOf, to, proof, chain, at, keyPair }) {
  const start = normalizeKeyChain(chain);
  if (!hex64(fromTopic) || !hex64(to) || !start || !keyPair?.secretKey) return null;
  if (!Number.isSafeInteger(at) || at <= 0) return null;
  try {
    const message = moveMessage(fromTopic, topicOf(to), at, start);
    const sig = b4a.toString(crypto.sign(b4a.from(message), keyPair.secretKey), "hex");
    return normalizeMove({ to, proof, chain: start, at, sig });
  } catch {
    return null;
  }
}

/**
 * Whether a move was signed by the room's creator, to a key the same creator
 * made. topicOf turns a room key into its topic, as the room names it.
 */
export function checkMove({ fromTopic, creatorKey, move, topicOf }) {
  const hop = normalizeMove(move);
  const creator = hex64(creatorKey);
  if (!hop || !creator || !hex64(fromTopic)) return false;
  if (!roomRotates(hop.to) || !checkCreatorProof(hop.to, creator, hop.proof)) return false;
  try {
    return crypto.verify(
      b4a.from(moveMessage(fromTopic, topicOf(hop.to), hop.at, hop.chain)),
      b4a.from(hop.sig, "hex"),
      b4a.from(creator, "hex"),
    );
  } catch {
    return false;
  }
}

/** Who a device has seen in a room, by key: when it first and last saw each. */
export function normalizeKnownKeys(value) {
  const entries = [];
  for (const [key, seen] of Object.entries(value && typeof value === "object" ? value : {})) {
    const first = Array.isArray(seen) ? seen[0] : 0;
    const last = Array.isArray(seen) ? seen[1] : 0;
    if (!hex64(key) || !Number.isSafeInteger(first) || first <= 0 || !Number.isSafeInteger(last) || last < first) continue;
    entries.push([key.toLowerCase(), [first, last]]);
  }
  entries.sort((a, b) => b[1][1] - a[1][1]);
  return Object.fromEntries(entries.slice(0, MAX_KNOWN_KEYS));
}

/** Notes a key seen in the room now. True when the record changed. */
export function noteKnownKey(known, key, now = Date.now()) {
  const id = hex64(key);
  if (!id || !known) return false;
  const seen = known[id];
  if (seen) {
    if (now - seen[1] < 60_000) return false;
    seen[1] = Math.max(seen[1], now);
    return true;
  }
  known[id] = [now, now];
  const keys = Object.keys(known);
  if (keys.length > MAX_KNOWN_KEYS) {
    // The ones seen longest ago go, a tenth at a time, so this runs rarely.
    keys.sort((a, b) => known[a][1] - known[b][1]);
    for (const old of keys.slice(0, Math.ceil(MAX_KNOWN_KEYS / 10))) delete known[old];
  }
  return true;
}

/** Whether this device saw this key in the room before a time. */
export function knownBefore(known, key, at) {
  const seen = known?.[hex64(key)];
  return Array.isArray(seen) && seen[0] < at;
}
