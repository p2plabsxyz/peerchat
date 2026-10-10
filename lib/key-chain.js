// Room keys that rotate, so a stolen key cannot read old messages.
//
// A room's key does three things: it names the room, finds its people, and
// proves a device is in it. It used to seal every message as well, for the
// room's whole life, so anyone who got hold of it, from a forwarded invite or a
// lost device, could read every message they could get a copy of, past and
// future.
//
// A room made on this version still has a key for those three things, but its
// messages are sealed with keys from a chain next to it:
//
// - Time is counted in hours from the Unix epoch.
// - The chain starts with 32 random bytes, made by whoever makes the room or
//   opens the direct message, for the hour it was made.
// - Each hour's secret is an HMAC of the hour before's. Going back from a
//   secret to an earlier one is not possible.
// - An hour's message key is an HMAC of that hour's secret.
// - Somebody joining is given the current hour's secret, never an earlier one,
//   so a newcomer, or anyone holding a stolen invite or a stolen current key,
//   cannot read anything sealed before it. A device keeps the earliest secret
//   it was given, so its own history stays readable on it.
//
// Rooms made before this have no chain and seal with their room key as they
// always did; older builds can only read those. A room whose key carries the
// mark below has a chain, so the key alone says so, without trusting anyone.
//
// PeerSky Mobile keeps the same rules in backend/peerchat/key-chain.mjs. Both
// have to agree on every byte.
import { createHash, createHmac, randomBytes } from "crypto";

export const KEY_HOUR_MS = 60 * 60 * 1000;
const ROTATES_CONTEXT = "peersky-chat/3 rotates:";
const NEXT_LABEL = "peersky-chat/3 next hour";
const MESSAGE_LABEL = "peersky-chat/3 message key";
const HEX_64 = /^[0-9a-f]{64}$/;
// The latest hour worked out for each chain, so a room open for months does
// not hash forward from its first hour on every message.
const cursors = new Map();
const MAX_CURSORS = 256;

export function hourOf(ts = Date.now()) {
  return Math.floor(ts / KEY_HOUR_MS);
}

/** Whether a room's key marks it as one whose messages use a key chain. */
export function roomRotates(roomKey) {
  if (typeof roomKey !== "string" || !HEX_64.test(roomKey)) return false;
  const digest = createHash("sha256").update(ROTATES_CONTEXT + roomKey).digest();
  return digest[0] === 0 && digest[1] === 0;
}

/** A new room key that carries the mark: about 65,000 tries, a few dozen ms. */
export function makeRotatingRoomKey(random = randomBytes) {
  for (;;) {
    const key = Buffer.from(random(32)).toString("hex");
    if (roomRotates(key)) return key;
  }
}

/** The start of a new room's chain, for the hour it is made in. */
export function newKeyChain(now = Date.now(), random = randomBytes) {
  return { first: hourOf(now), secret: Buffer.from(random(32)).toString("hex") };
}

export function normalizeKeyChain(value) {
  const first = value?.first;
  const secret = typeof value?.secret === "string" ? value.secret.toLowerCase() : "";
  if (!Number.isSafeInteger(first) || first < 0 || !HEX_64.test(secret)) return null;
  return { first, secret };
}

function step(secret) {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(NEXT_LABEL).digest("hex");
}

/** The secret for one hour, or null for an hour before the chain starts here. */
export function chainSecretAt(chain, hour) {
  const start = normalizeKeyChain(chain);
  if (!start || !Number.isSafeInteger(hour) || hour < start.first) return null;
  const id = `${start.first}:${start.secret}`;
  let cursor = cursors.get(id);
  if (!cursor || cursor.hour > hour) cursor = { hour: start.first, secret: start.secret };
  let { hour: at, secret } = cursor;
  while (at < hour) {
    secret = step(secret);
    at += 1;
  }
  cursors.delete(id);
  cursors.set(id, { hour: at, secret });
  if (cursors.size > MAX_CURSORS) cursors.delete(cursors.keys().next().value);
  return secret;
}

/** The key one hour's messages are sealed with. */
export function messageKeyAt(chain, hour) {
  const secret = chainSecretAt(chain, hour);
  return secret ? createHmac("sha256", Buffer.from(secret, "hex")).update(MESSAGE_LABEL).digest() : null;
}

/** What a joining member is given: the current hour and its secret, nothing older. */
export function currentKeyGift(chain, now = Date.now()) {
  const hour = hourOf(now);
  const secret = chainSecretAt(chain, hour);
  return secret ? { e: hour, secret } : null;
}

/**
 * The chain to keep when somebody in the room hands one over. A device with no
 * chain takes it, as long as the hour is about now: an honest member gives the
 * current hour, and a far one is not worth trusting. A device that already has
 * one keeps its own, and only says whether the two agree.
 */
export function takeKeyGift(current, gift, now = Date.now()) {
  const hour = gift?.e;
  const secret = typeof gift?.secret === "string" ? gift.secret.toLowerCase() : "";
  if (!Number.isSafeInteger(hour) || !HEX_64.test(secret)) return { chain: current, taken: false };
  const held = normalizeKeyChain(current);
  if (held) return { chain: held, taken: false, agrees: chainSecretAt(held, hour) === secret };
  const nowHour = hourOf(now);
  if (hour < nowHour - 2 || hour > nowHour + 1) return { chain: null, taken: false };
  return { chain: { first: hour, secret }, taken: true };
}

/** For this person's own other devices: the earlier of two starts of one chain. */
export function earlierKeyChain(current, offered) {
  const held = normalizeKeyChain(current);
  const other = normalizeKeyChain(offered);
  if (!other) return held;
  if (!held) return other;
  if (other.first >= held.first) return held;
  // Only when it really is the same chain: forward from theirs lands on ours.
  return chainSecretAt(other, held.first) === held.secret ? other : held;
}
