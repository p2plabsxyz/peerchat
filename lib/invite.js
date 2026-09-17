// Invite links carry the room key, which is the capability for the room.
// Callers must strip it from the address bar once consumed.
const ROOM_KEY_RE = /^[a-f0-9]{64}$/i;

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
