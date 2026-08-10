const ROOM_KEY_RE = /^[a-f0-9]{64}$/i;

function normalizeRoomKey(roomKey) {
  if (typeof roomKey !== "string" || !ROOM_KEY_RE.test(roomKey)) return "";
  return roomKey.toLowerCase();
}

function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function roomKeyFromTopic(topic) {
  if (typeof topic === "string") return normalizeRoomKey(topic);
  if (!topic) return "";

  if (typeof topic.toString === "function") {
    const hex = topic.toString("hex");
    if (normalizeRoomKey(hex)) return hex.toLowerCase();
  }

  if (ArrayBuffer.isView(topic)) {
    return normalizeRoomKey(
      bytesToHex(new Uint8Array(topic.buffer, topic.byteOffset, topic.byteLength))
    );
  }

  if (topic instanceof ArrayBuffer) {
    return normalizeRoomKey(bytesToHex(new Uint8Array(topic)));
  }

  return "";
}

export function sharedRoomsFromTopics(topics, localRooms) {
  const local = new Set(
    [...(localRooms || [])].map(normalizeRoomKey).filter(Boolean)
  );
  const shared = [];
  const seen = new Set();

  for (const topic of topics || []) {
    const roomKey = roomKeyFromTopic(topic);
    if (!roomKey || !local.has(roomKey) || seen.has(roomKey)) continue;
    seen.add(roomKey);
    shared.push(roomKey);
  }

  return shared;
}

export function peerSharesRoom(peer, roomKey) {
  const normalized = normalizeRoomKey(roomKey);
  return !!normalized && !!peer && Array.isArray(peer.rooms) &&
    peer.rooms.some((candidate) => normalizeRoomKey(candidate) === normalized);
}

export function peerMatchesIdentity(peer, identity) {
  const wanted = String(identity || "").toLowerCase();
  if (!wanted || !peer) return false;
  return [peer.id, peer.fullId]
    .filter(Boolean)
    .some((candidate) => String(candidate).toLowerCase() === wanted);
}

export function addedRooms(previousRooms, nextRooms) {
  const previous = new Set(
    (previousRooms || []).map(normalizeRoomKey).filter(Boolean)
  );
  return (nextRooms || [])
    .map(normalizeRoomKey)
    .filter((roomKey) => roomKey && !previous.has(roomKey));
}
