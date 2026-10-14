// Invite links, shared with mobile.
//
//   peersky://p2p/peerchat/#room=<64 hex room key>   a room
//   peersky://p2p/peerchat/#room=<room key>&creator=<64 hex>&proof=<64 hex>
//                                                     a room, and who made it
//   peersky://p2p/peerchat/#dm=<64 hex public key>   one person
//
// A room key is the capability for that room, so anyone holding the link is in,
// and callers must strip it from the address bar once consumed. A person's key
// is not a capability: it only says who to ask, and the person on the other end
// still has to accept the request. Links made before carried the 8 hex peer id
// the member list shows, and still open.
//
// creator is the key of whoever made the room, when the inviting device knows
// it, and proof the secret that made the room's key out of it (lib/room-move.js),
// when it holds one that checks out. A device that joins from the link knows who
// made the room from the start, instead of taking it from whoever in the room
// says so first. The proof is as private as the room key. An older build reads
// room and ignores the rest.
const ROOM_KEY_RE = /^[a-f0-9]{64}$/i;
const PEER_ID_RE = /^[a-f0-9]{8}$/i;
const PEER_KEY_RE = /^[a-f0-9]{64}$/i;
const HEX_64_RE = /^[a-f0-9]{64}$/i;

export const INVITE_BASE = "peersky://p2p/peerchat/";

export function buildInviteUrl(roomKey, creatorKey = "", creatorProof = "") {
  if (typeof roomKey !== "string" || !ROOM_KEY_RE.test(roomKey)) return "";
  const creator = typeof creatorKey === "string" && HEX_64_RE.test(creatorKey) ? creatorKey.toLowerCase() : "";
  // Only with the creator it shows.
  const proof = creator && typeof creatorProof === "string" && HEX_64_RE.test(creatorProof) ? creatorProof.toLowerCase() : "";
  return `${INVITE_BASE}#room=${roomKey.toLowerCase()}` +
    (creator ? `&creator=${creator}` : "") +
    (proof ? `&proof=${proof}` : "");
}

// What comes after the # or ?, or the whole of it.
function inviteParams(input) {
  if (typeof input !== "string" || !input) return null;
  const tail = input.match(/[#?]([^#?]*)$/)?.[1] ?? input;
  try {
    return new URLSearchParams(tail);
  } catch {
    return null;
  }
}

// Accepts a full invite URL, a bare "#room=…" fragment, or a "?room=…" query.
export function parseInvite(input) {
  const key = inviteParams(input)?.get("room") || "";
  return ROOM_KEY_RE.test(key) ? key.toLowerCase() : "";
}

/**
 * A room invite with who made the room, when the link says.
 *
 * checkProof(roomKey, creatorKey, proof) says whether the secret makes the
 * room's key out of the creator key: checkCreatorProof in lib/room-move.js.
 * It is passed in because the page reads this file too, and the page has no
 * hashing of its own to do it with. A proof that does not check out, or that
 * nothing checked, drops the creator as well, as if the link had neither:
 * whoever made the link put the wrong key in it.
 */
export function parseRoomInvite(input, checkProof = null) {
  const roomKey = parseInvite(input);
  if (!roomKey) return { roomKey: "", creatorKey: "", creatorProof: "" };
  const params = inviteParams(input);
  const creator = params.get("creator") || "";
  const proof = params.get("proof") || "";
  const creatorKey = HEX_64_RE.test(creator) ? creator.toLowerCase() : "";
  // An empty proof is still one that does not check out.
  if (!params.has("proof")) return { roomKey, creatorKey, creatorProof: "" };
  if (!creatorKey) return { roomKey, creatorKey: "", creatorProof: "" };
  const creatorProof = proof.toLowerCase();
  const proven = HEX_64_RE.test(proof) && typeof checkProof === "function" &&
    checkProof(roomKey, creatorKey, creatorProof) === true;
  return proven ? { roomKey, creatorKey, creatorProof } : { roomKey, creatorKey: "", creatorProof: "" };
}

/** Whether a room invite names who made the room, before anything is checked. */
export function inviteNamesCreator(input) {
  return !!parseInvite(input) && HEX_64_RE.test(inviteParams(input).get("creator") || "");
}

/**
 * A link that asks one person for a direct message.
 *
 * It carries their whole public key. The 8 character id everything shows is
 * only the start of it: among millions of people some keys start the same
 * way, and one can be made to on purpose. The whole key names one person.
 *
 * Handing this out is not handing out access: it starts a request, which they
 * can accept, decline or block. That is what makes it safe to put on a screen
 * as a QR code for somebody across the room to scan.
 */
export function buildDirectInviteUrl(peerKey) {
  if (typeof peerKey !== "string" || !PEER_KEY_RE.test(peerKey)) return "";
  return `${INVITE_BASE}#dm=${peerKey.toLowerCase()}`;
}

/**
 * Accepts the link, a bare fragment, or a plain peer id, and gives the whole
 * key, or the peer id an older link carries. A plain 64 hex value is a room
 * key, so a person's key has to come as dm=.
 */
export function parseDirectInvite(input) {
  if (typeof input !== "string" || !input) return "";
  if (PEER_ID_RE.test(input.trim())) return input.trim().toLowerCase();
  const tail = input.match(/[#?]([^#?]*)$/)?.[1] ?? input;
  let peer;
  try {
    peer = new URLSearchParams(tail).get("dm") || "";
  } catch {
    return "";
  }
  return PEER_KEY_RE.test(peer) || PEER_ID_RE.test(peer) ? peer.toLowerCase() : "";
}

/**
 * Who a direct link names: the peer id everything shows them by, and their
 * whole key when the link has it. An older link gives only the peer id.
 */
export function splitDirectPeer(peer) {
  const value = typeof peer === "string" ? peer.toLowerCase() : "";
  if (PEER_KEY_RE.test(value)) return { id: value.slice(0, 8), key: value };
  if (PEER_ID_RE.test(value)) return { id: value, key: "" };
  return { id: "", key: "" };
}

/**
 * Whether a direct room is the conversation with the person a link names.
 *
 * A room bound to another key is with someone else whose key starts the same
 * way. A request not yet bound to any key is not either: asking again sends it
 * to the key in the link. Nothing can be written in a request until it is
 * accepted, so nothing meant for one person goes to another.
 */
export function isDirectRoomFor(room, peer) {
  const { id, key } = splitDirectPeer(peer);
  if (!id || !room?.isDM || room.dmWith !== id) return false;
  if (!key) return true;
  return room.dmWithKey ? room.dmWithKey === key : !room.pendingAcceptance;
}
