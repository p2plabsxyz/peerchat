// Invite links, shared with mobile.
//
//   peersky://p2p/peerchat/#room=<64 hex room key>   a room
//   peersky://p2p/peerchat/#dm=<8 hex peer id>       one person
//
// A room key is the capability for that room, so anyone holding the link is in,
// and callers must strip it from the address bar once consumed. A peer id is
// not a capability: it only says who to ask, and the person on the other end
// still has to accept the request.
const ROOM_KEY_RE = /^[a-f0-9]{64}$/i;
const PEER_ID_RE = /^[a-f0-9]{8}$/i;

export const INVITE_BASE = "peersky://p2p/peerchat/";

export function buildInviteUrl(roomKey) {
  if (typeof roomKey !== "string" || !ROOM_KEY_RE.test(roomKey)) return "";
  return `${INVITE_BASE}#room=${roomKey.toLowerCase()}`;
}

// Accepts a full invite URL, a bare "#room=…" fragment, or a "?room=…" query.
export function parseInvite(input) {
  if (typeof input !== "string" || !input) return "";
  const tail = input.match(/[#?]([^#?]*)$/)?.[1] ?? input;
  let key;
  try {
    key = new URLSearchParams(tail).get("room") || "";
  } catch {
    return "";
  }
  return ROOM_KEY_RE.test(key) ? key.toLowerCase() : "";
}

/**
 * A link that asks one person for a direct message.
 *
 * Handing this out is not handing out access: it starts a request, which they
 * can accept, decline or block. That is what makes it safe to put on a screen
 * as a QR code for somebody across the room to scan.
 */
export function buildDirectInviteUrl(peerId) {
  if (typeof peerId !== "string" || !PEER_ID_RE.test(peerId)) return "";
  return `${INVITE_BASE}#dm=${peerId.toLowerCase()}`;
}

/** Accepts the link, a bare fragment, or a plain peer id. */
export function parseDirectInvite(input) {
  if (typeof input !== "string" || !input) return "";
  if (PEER_ID_RE.test(input.trim())) return input.trim().toLowerCase();
  const tail = input.match(/[#?]([^#?]*)$/)?.[1] ?? input;
  let id;
  try {
    id = new URLSearchParams(tail).get("dm") || "";
  } catch {
    return "";
  }
  return PEER_ID_RE.test(id) ? id.toLowerCase() : "";
}
