import { PRE_JOINED_ROOM_KEY } from "../rooms.js";

/**
 * Who may remove people from a room, and who has been removed.
 *
 * Wire contract, shared with mobile. Removals travel as
 *   { type: "room-bans", roomKey, bans: [{ id, key, at }] }
 * and carry no message id and no encrypted body, so a build that predates this
 * drops them at its first check rather than making anything of them.
 *
 * There is no server, so "removed" can only mean what every honest client
 * agrees to do. What keeps that from being a free-for-all is that hyperswarm's
 * handshake already told both sides who the other is, so a removal is checked
 * against the connection it arrived on, with no signing to build.
 *
 * A room's own record of its creator is the first 8 characters of that key.
 * Thirty-two bits is short enough to grind a matching key for in minutes, so it
 * is a label, never the thing a removal is checked against. The full key is.
 */

const CREATOR_KEY_PATTERN = /^[a-f0-9]{64}$/;
const PEER_ID_PATTERN = /^[a-f0-9]{8}$/;
// Well past what a real room needs, and small enough that a peer cannot grow
// one unboundedly by relaying.
export const MAX_ROOM_BANS = 512;

/**
 * Creator keys that ship with the app.
 *
 * P2P Republic existed before any of this, so its record carries only the short
 * creator id, and nothing announced over the network could be trusted to fill
 * the rest in. Pinning it settles that for every copy at once.
 *
 * A public key is public. It is what peers hand each other on every connection,
 * and pinning only works if it ships, so this belongs in the source.
 */
export const PINNED_CREATOR_KEYS = Object.freeze({
  // Read off the device that runs P2P Republic with scripts/creator-key.mjs.
  // It does not match the room's recorded createdBy, which is from a storage
  // the device no longer has: the pin is what decides, and it overrides
  // anything stored or announced.
  [PRE_JOINED_ROOM_KEY]: "42430624a528ba7d4951b351e6615b8513646f0fe1ab76372024fa4ab7e23d60",
});

export function normalizeCreatorKey(value) {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CREATOR_KEY_PATTERN.test(key) ? key : "";
}

/** The short id that key would appear as in a room record or a member list. */
export function peerIdForCreatorKey(creatorKey) {
  return normalizeCreatorKey(creatorKey).slice(0, 8);
}

/** A pinned key always wins. Nothing over the network can replace it. */
export function resolveCreatorKey(roomKey, storedKey) {
  return normalizeCreatorKey(PINNED_CREATOR_KEYS[roomKey]) || normalizeCreatorKey(storedKey);
}

/**
 * Whether a room may take this as its creator key.
 *
 * Only from the creator: the announcement has to arrive on a connection whose
 * own public key is the key being announced. Anyone can claim to know who made
 * a room; only one peer can prove it.
 */
export function acceptsCreatorKey({ roomKey, storedKey, createdBy, announcedKey, connectionKey }) {
  if (resolveCreatorKey(roomKey, storedKey)) return false;

  const announced = normalizeCreatorKey(announcedKey);
  if (!announced) return false;
  if (announced !== normalizeCreatorKey(connectionKey)) return false;

  const shortId = typeof createdBy === "string" ? createdBy.trim().toLowerCase() : "";
  if (PEER_ID_PATTERN.test(shortId) && shortId !== peerIdForCreatorKey(announced)) return false;

  return true;
}

/** Whether a removal that arrived on this connection is the creator's. */
export function isRoomCreatorConnection({ roomKey, storedKey, connectionKey }) {
  const creatorKey = resolveCreatorKey(roomKey, storedKey);
  return creatorKey !== "" && creatorKey === normalizeCreatorKey(connectionKey);
}

/**
 * The removals for one room.
 *
 * By full key where the creator had a connection to take it from, and by short
 * id otherwise, because somebody can be removed while they are offline and the
 * room only remembers the short one for them.
 */
export function normalizeRoomBans(value) {
  if (!Array.isArray(value)) return [];

  const byId = new Map();
  for (const entry of value) {
    const key = normalizeCreatorKey(entry?.key);
    const id = key
      ? peerIdForCreatorKey(key)
      : typeof entry?.id === "string"
        ? entry.id.trim().toLowerCase()
        : "";
    if (!PEER_ID_PATTERN.test(id)) continue;

    const at = Number.isSafeInteger(entry?.at) && entry.at > 0 ? entry.at : 0;
    const existing = byId.get(id);
    // A full key is worth more than a short id, so it wins the slot.
    if (existing && (!key || existing.key)) continue;
    byId.set(id, { id, key, at });

    if (byId.size >= MAX_ROOM_BANS) break;
  }

  return [...byId.values()];
}

export function addRoomBan(bans, { id, key, at = Date.now() }) {
  const normalizedKey = normalizeCreatorKey(key);
  const normalizedId = normalizedKey
    ? peerIdForCreatorKey(normalizedKey)
    : typeof id === "string"
      ? id.trim().toLowerCase()
      : "";
  if (!PEER_ID_PATTERN.test(normalizedId)) return normalizeRoomBans(bans);

  return normalizeRoomBans([
    { id: normalizedId, key: normalizedKey, at },
    ...(Array.isArray(bans) ? bans : []),
  ]);
}

export function removeRoomBan(bans, id) {
  const normalizedId = typeof id === "string" ? id.trim().toLowerCase() : "";
  return normalizeRoomBans(bans).filter((ban) => ban.id !== normalizedId);
}

/**
 * Whether this peer has been removed from the room.
 *
 * A full key is checked against the connection, which cannot be faked. A ban
 * held only by short id is checked against that, which can be, so it is a best
 * effort against somebody who has not been seen since.
 */
export function isPeerBannedFromRoom(bans, { peerId, connectionKey }) {
  const key = normalizeCreatorKey(connectionKey);
  const id = key
    ? peerIdForCreatorKey(key)
    : typeof peerId === "string"
      ? peerId.trim().toLowerCase()
      : "";
  if (!PEER_ID_PATTERN.test(id)) return false;

  for (const ban of normalizeRoomBans(bans)) {
    if (ban.id !== id) continue;
    // Removed by key: only that exact key is out, so somebody who happens to
    // share the short id is not caught by it.
    if (ban.key) return ban.key === key;
    return true;
  }

  return false;
}
