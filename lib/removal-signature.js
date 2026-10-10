// A room's removal list, signed by whoever made the room.
//
// A list used to count only when it came over the creator's own connection.
// Nobody else could pass it on, since a list forwarded by somebody else could
// have been changed on the way. In a room bigger than one device's handful of
// connections most members never meet the creator, so a removal never reached
// them and the person removed went on talking to them.
//
// Signed with the creator's key, a list can come from anyone. Whoever receives
// it checks the signature against the creator key the room already trusts
// (pinned in the app for P2P Republic, or learned from the creator), and a
// newer version replaces an older one. So a removal spreads through the whole
// room, whether the creator is online or not.
//
// PeerSky Mobile keeps the same rules in backend/peerchat/removal-signature.mjs.
// Both have to agree on every byte.
import b4a from "b4a";
import crypto from "hypercore-crypto";

import { normalizeRoomBans } from "./room-moderation.js";

const LABEL = "peersky-chat/2 removals";
const HEX_64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;

/** What is signed: the room by its topic, the list's version, and the list. */
export function removalsMessage(topic, version, bans) {
  const entries = normalizeRoomBans(bans).map((ban) => [ban.id, ban.key, ban.at, ban.name]);
  return `${LABEL}\n${topic}\n${version}\n${JSON.stringify(entries)}`;
}

/** The version a list, as kept or as received, says it is, and its signature. */
export function normalizeSignedRemovals(value) {
  const v = Number.isSafeInteger(value?.v) && value.v > 0 ? value.v : 0;
  const sig = typeof value?.sig === "string" && SIGNATURE.test(value.sig) ? value.sig : "";
  return { v, sig };
}

/** Later than the last version, and from the clock where it can be. */
export function nextRemovalsVersion(previous, now = Date.now()) {
  const last = Number.isSafeInteger(previous) && previous > 0 ? previous : 0;
  return Math.max(now, last + 1);
}

/** The creator's signature over the list, or "" when these keys cannot make one. */
export function signRemovals({ topic, version, bans, keyPair }) {
  if (!HEX_64.test(topic || "") || !Number.isSafeInteger(version) || version <= 0) return "";
  if (!keyPair?.secretKey) return "";
  try {
    const signature = crypto.sign(b4a.from(removalsMessage(topic, version, bans)), keyPair.secretKey);
    return b4a.toString(signature, "hex");
  } catch {
    return "";
  }
}

/** Whether this list, at the version it carries, was signed with the creator key. */
export function checkSignedRemovals({ topic, creatorKey, bans, signed }) {
  const { v, sig } = normalizeSignedRemovals(signed);
  if (!v || !sig || !HEX_64.test(creatorKey || "") || !HEX_64.test(topic || "")) return false;
  try {
    return crypto.verify(
      b4a.from(removalsMessage(topic, v, bans)),
      b4a.from(sig, "hex"),
      b4a.from(creatorKey, "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * The key pair behind this device's network key, which is what the room knows
 * its creator by. Only a pair whose public half is that key will do: anything
 * else would make signatures nobody can check.
 */
export function pickSigningKeyPair(publicKeyHex, candidates) {
  for (const pair of candidates) {
    if (!pair?.publicKey || !pair?.secretKey) continue;
    if (b4a.toString(pair.publicKey, "hex").toLowerCase() === publicKeyHex) return pair;
  }
  return null;
}
