// A room's details, signed by the person who made the room, so they can change
// them and everyone in the room takes the change.
//
// A room's name, description, link and picture used to be taken once, from
// anyone, and never again: each only filled in what a device did not have yet,
// so the creator could not change them. Its filters came from anyone, every
// time. Signed by the creator, the details can come from anyone in the room
// and be checked against the creator key, which the room key itself vouches
// for (lib/room-move.js), and the newest version wins.
//
// What is signed:
//   "peersky-chat/4 room details\n" + topic + "\n" +
//   JSON.stringify([version, name, description, link, picture hash,
//                   abuse filter, profanity filter, spam limit])
// The picture hash is the SHA-256 of the picture's data URL, or "" for none.
// The picture itself still travels once, in the room details beside these.
//
// Everyone keeps the signed details exactly as they came and passes them on
// like that, so they check out on every device, whatever each one makes of
// them for showing.
//
// PeerSky Mobile keeps the same rules in backend/peerchat/room-details.mjs.
// Both have to agree on every byte.
import { createHash } from "crypto";
import b4a from "b4a";
import crypto from "hypercore-crypto";

const DETAILS_LABEL = "peersky-chat/4 room details";
const HEX_64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
// Far above what either app lets anyone type, so each keeps what the other sends.
const MAX_NAME = 400;
const MAX_BIO = 2000;
const MAX_LINK = 2048;

/** The SHA-256 of a room picture's data URL, or "" for none. */
export function avatarHash(avatar) {
  return typeof avatar === "string" && avatar ? createHash("sha256").update(avatar).digest("hex") : "";
}

/** Signed room details, checked for shape, or null. */
export function normalizeRoomDetails(value) {
  if (!value || typeof value !== "object") return null;
  const { v, name, bio, link, avatar, moderation, sig } = value;
  if (!Number.isSafeInteger(v) || v <= 0) return null;
  if (typeof name !== "string" || name.length > MAX_NAME) return null;
  if (typeof bio !== "string" || bio.length > MAX_BIO) return null;
  if (typeof link !== "string" || link.length > MAX_LINK) return null;
  if (typeof avatar !== "string" || (avatar && !HEX_64.test(avatar))) return null;
  if (!moderation || typeof moderation !== "object") return null;
  const { abuseFilter, nsfwFilter, spamRateLimit } = moderation;
  if (typeof abuseFilter !== "boolean" || typeof nsfwFilter !== "boolean") return null;
  if (!Number.isSafeInteger(spamRateLimit) || spamRateLimit < 1 || spamRateLimit > 50) return null;
  if (typeof sig !== "string" || !SIGNATURE.test(sig)) return null;
  return { v, name, bio, link, avatar, moderation: { abuseFilter, nsfwFilter, spamRateLimit }, sig };
}

export function roomDetailsMessage(topic, { v, name, bio, link, avatar, moderation }) {
  return DETAILS_LABEL + "\n" + topic + "\n" + JSON.stringify([
    v, name, bio, link, avatar,
    moderation.abuseFilter, moderation.nsfwFilter, moderation.spamRateLimit,
  ]);
}

/**
 * The creator's signature on a room's details, as they will travel, or null.
 * avatar is the picture's data URL; what is signed is its hash.
 */
export function signRoomDetails({ topic, v, name, bio, link, avatar, moderation, keyPair }) {
  if (!HEX_64.test(topic || "") || !keyPair?.secretKey) return null;
  const details = {
    v,
    name: typeof name === "string" ? name : "",
    bio: typeof bio === "string" ? bio : "",
    link: typeof link === "string" ? link : "",
    avatar: avatarHash(avatar),
    moderation: {
      abuseFilter: moderation?.abuseFilter !== false,
      nsfwFilter: moderation?.nsfwFilter !== false,
      spamRateLimit: moderation?.spamRateLimit,
    },
    sig: "0".repeat(128),
  };
  if (!normalizeRoomDetails(details)) return null;
  try {
    const sig = b4a.toString(crypto.sign(b4a.from(roomDetailsMessage(topic, details)), keyPair.secretKey), "hex");
    return normalizeRoomDetails({ ...details, sig });
  } catch {
    return null;
  }
}

/** Whether these details were signed by this creator key, for this room. */
export function checkRoomDetails({ topic, creatorKey, details }) {
  const signed = normalizeRoomDetails(details);
  const creator = typeof creatorKey === "string" ? creatorKey.toLowerCase() : "";
  if (!signed || !HEX_64.test(creator) || !HEX_64.test(topic || "")) return false;
  try {
    return crypto.verify(
      b4a.from(roomDetailsMessage(topic, signed)),
      b4a.from(signed.sig, "hex"),
      b4a.from(creator, "hex"),
    );
  } catch {
    return false;
  }
}

/** The version a device signs next: now, unless its last was later. */
export function nextDetailsVersion(held, now = Date.now()) {
  const last = normalizeRoomDetails(held)?.v || 0;
  return Math.max(now, last + 1);
}
