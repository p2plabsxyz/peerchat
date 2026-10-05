import { PassThrough } from "stream";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import {
  checkContent as moderationCheckContent,
  initModeration,
  checkMessage as moderationCheck,
  isKicked as moderationIsKicked,
} from "./moderation.js";
import {
  peerSharesRoom,
  sharedRoomsFromTopics,
  soleKeyFor,
  topicHex,
} from "./routing.js";
import { attachChatTransport } from "./transport.js";
import {
  decodeMessagePayload,
  encodeMessagePayload,
  extractFirstHttpUrl,
  resolveLinkPreview,
  sanitizePreview,
} from "./lib/link-preview.js";
import b4a from "b4a";

export const CHAT_STORAGE = "peersky-chat-rooms.json";

const MAX_SENDER_LEN = 200;
const MAX_MSG_LEN = 64 * 1024;
const MAX_NAME_LEN = 80;
const MAX_BIO_LEN = 300;
const MAX_LINK_LEN = 512;
const MAX_AVATAR_B64 = 1_400_000;
const MAX_FILE_NAME_LEN = 200;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const KEEPALIVE_MS = 15_000;
const PING_MS = 25_000;
const SEEN_CAP = 10_000;
const PERSIST_DELAY_MS = 2_000;
const MAX_BLOCKED_PEERS = 500;
// Comfortably under the 256 KB a receiver will accept, on this side and on mobile.
const MEMBERS_LIST_MAX_BYTES = 192 * 1024;
const DM_CONTROL_TYPES = new Set(["dm-invite", "dm-accept", "dm-reject", "dm-blocked"]);

import { earliestRoomCreatedAt } from "./lib/room-created-at.js";
import {
  acceptsCreatorKey,
  addRoomBan,
  isPeerBannedFromRoom,
  isRoomCreatorConnection,
  normalizeCreatorKey,
  normalizeRoomBans,
  removeRoomBan,
  resolveCreatorKey,
} from "./lib/room-moderation.js";
import {
  checkProfileProof,
  createLink,
  displayName,
  linkId,
  makeProfileProof,
  makeTransfer,
  mergeLabels,
  nextLabel,
  normalizeLabel,
  normalizeLink,
  normalizeSharedRooms,
  normalizeTransfer,
} from "./lib/device-link.js";
import { checkRoomProof, roomProof } from "./lib/room-proof.js";

// Left next to the chat file by a restore from another of this person's
// devices, and taken on the next start. See importChatTransfer.
export const CHAT_INCOMING = "peerchat-incoming.json";

const DEFAULT_ROOM_MODERATION = {
  abuseFilter: true,
  nsfwFilter: true,
  spamRateLimit: 10,
};

function sanitizeRoomModeration(input) {
  if (!input || typeof input !== "object") return { ...DEFAULT_ROOM_MODERATION };
  const out = { ...DEFAULT_ROOM_MODERATION };
  if (input.abuseFilter === false) out.abuseFilter = false;
  if (input.nsfwFilter === false) out.nsfwFilter = false;
  if (typeof input.spamRateLimit === "number") {
    out.spamRateLimit = Math.max(1, Math.min(50, Math.floor(input.spamRateLimit)));
  }
  return out;
}

const roomFeeds = {};
const openingFeeds = new Map();
const roomSseClients = {};
const globalSseClients = [];
const joinedRooms = new Set();
// Peers whose profile carried a proof made with the link: this person's other
// devices. Saved, so their messages are still this person's after a restart,
// before they have been seen again.
const siblingIds = new Set();
const MAX_SIBLINGS = 16;
const discoveryKeys = new Map();
const seenIds = new Set();
const rateCounters = new Map();
const decryptedMessageCache = new Map();
const chatTransports = new WeakMap();
const pendingPeers = new WeakMap();

let peers = [];
// Away from PeerSky: the screen locked, the computer asleep or idle, or another
// app in front for a while. PeerSky works that out and says so here, and each
// person in a room with us hears it. A phone in the background says the same.
let localIdle = false;
// Who said they are away, by short id. A group still counts them as online;
// their own dot says which.
const idlePeers = new Set();
const MAX_PRESENCE_FRAMES_PER_WINDOW = 30;
let localId = "";
let localKey = "";
let safeStore = null;
let dataPath = null;
let activeRoom = null;
let persistTimer = null;
let peerCountTimer = null;

let chatSdk = null;

// device.label: this device's fixed label after the name ("mobile",
// "desktop1"), empty on the device the name was made on. link: the secret the
// person's devices share. See lib/device-link.js.
// leftRooms: rooms this device left or was removed from, by when. Another of
// the person's devices offering one back is ignored until it is joined again
// here, so leaving a room on one device sticks.
let savedData = { profile: {}, rooms: {}, peerProfiles: {}, blockedPeers: {}, device: { label: "" }, link: null, leftRooms: {} };
const MAX_LEFT_ROOMS = 1000;

function isValidRoomKey(k) {
  return typeof k === "string" && /^[a-f0-9]{64}$/i.test(k);
}

function clamp(s, max) {
  return (typeof s === "string" ? s : "").slice(0, max);
}

const USERNAME_ALLOWED_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;

function parseProfileUsername(raw) {
  if (typeof raw !== "string") return "";
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length > 50 || !USERNAME_ALLOWED_RE.test(t)) return null;
  return t;
}

// The name everyone sees: the profile name with this device's fixed label.
function myName() {
  return displayName(savedData.profile?.username || "", savedData.device?.label);
}

function normPeerId(id) {
  return clamp(String(id ?? ""), MAX_SENDER_LEN).toLowerCase();
}

// Blocking closes direct messages only. A blocked peer stays visible in any
// room you share, the same as every other messenger.
function isPeerBlocked(peerId) {
  const id = normPeerId(peerId);
  return !!id && !!savedData.blockedPeers?.[id];
}

function listBlockedPeers() {
  return Object.values(savedData.blockedPeers || {})
    .sort((a, b) => (b.blockedAt || 0) - (a.blockedAt || 0));
}

function sanitizeBlockedPeers(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const entry of Object.values(raw)) {
    const peerId = normPeerId(entry?.peerId);
    if (!peerId || peerId === normPeerId(localId)) continue;
    out[peerId] = {
      peerId,
      username: clamp(entry?.username, MAX_NAME_LEN) || peerId,
      blockedAt: Number.isFinite(entry?.blockedAt) ? entry.blockedAt : Date.now(),
    };
    if (Object.keys(out).length >= MAX_BLOCKED_PEERS) break;
  }
  return out;
}

function normalizePersistedDmIds() {
  let changed = false;
  for (const r of Object.values(savedData.rooms)) {
    if (r.isDM && r.dmWith) {
      const n = normPeerId(r.dmWith);
      if (n !== r.dmWith) { r.dmWith = n; changed = true; }
    }
  }
  const pend = savedData.pendingDMs;
  if (pend) {
    for (const p of Object.values(pend)) {
      if (p.fromId) {
        const n = normPeerId(p.fromId);
        if (n !== p.fromId) { p.fromId = n; changed = true; }
      }
    }
  }
  if (changed) persistData();
}

function sanitizeAvatar(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return null;
  if (!v.startsWith("data:image/")) return null;
  if (v.length > MAX_AVATAR_B64) return null;
  return v;
}

function checkRate(key) {
  const now = Date.now();
  const e = rateCounters.get(key);
  if (!e || now > e.r) {
    rateCounters.set(key, { c: 1, r: now + RATE_WINDOW_MS });
    return true;
  }
  if (e.c >= RATE_MAX) return false;
  e.c++;
  return true;
}

function trackId(id) {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  if (seenIds.size > SEEN_CAP) seenIds.delete(seenIds.values().next().value);
  return true;
}

// The swarm topic is announced to DHT nodes in the clear, so it must not be
// the room key or anything the message key can be derived from. Topic and
// message key are separate KDF outputs over the same secret.
const TOPIC_CONTEXT = "peersky-chat:topic:";
const MESSAGE_KEY_CONTEXT = "peersky-chat:key:";
// Pre-separation derivation, when the room key was itself the topic. Kept for
// decryption only so history written by older builds stays readable.
const LEGACY_MESSAGE_KEY_CONTEXT = "peersky-chat:";

export function deriveTopic(roomKey) {
  return createHash("sha256").update(TOPIC_CONTEXT + roomKey).digest();
}

export function deriveMessageKey(roomKey) {
  return createHash("sha256").update(MESSAGE_KEY_CONTEXT + roomKey).digest();
}

function deriveLegacyMessageKey(roomKey) {
  return createHash("sha256").update(LEGACY_MESSAGE_KEY_CONTEXT + roomKey).digest();
}

export function encryptMsg(text, roomKey) {
  const k = deriveMessageKey(roomKey);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  let ct = c.update(text, "utf8", "hex");
  ct += c.final("hex");
  return { ct, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

function openMsg(ct, iv, tag, key) {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  let pt = d.update(ct, "hex", "utf8");
  pt += d.final("utf8");
  return pt;
}

export function decryptMsg(ct, iv, tag, roomKey) {
  try {
    return openMsg(ct, iv, tag, deriveMessageKey(roomKey));
  } catch (err) {
    try {
      // GCM authentication means this only opens genuine pre-separation
      // ciphertext, never a forgery.
      return openMsg(ct, iv, tag, deriveLegacyMessageKey(roomKey));
    } catch {
      throw err;
    }
  }
}

function enc4disk(v) {
  if (!safeStore?.isEncryptionAvailable?.()) return v;
  try { return safeStore.encryptString(v).toString("base64"); } catch { return v; }
}

function dec4disk(v) {
  if (!safeStore?.isEncryptionAvailable?.()) return v;
  try { return safeStore.decryptString(Buffer.from(v, "base64")); } catch { return v; }
}

const DATA_VERSION = 1;

function loadData() {
  if (!dataPath) return;
  try {
    if (!existsSync(dataPath)) return;
    const raw = JSON.parse(readFileSync(dataPath, "utf8"));

    if (raw.rooms) {
      savedData.profile = raw.profile || {};
      savedData.peerProfiles = raw.peerProfiles || {};
      savedData.pendingDMs = raw.pendingDMs || {};
      savedData.blockedPeers = sanitizeBlockedPeers(raw.blockedPeers);
      savedData.device = { label: normalizeLabel(raw.device?.label) };
      // Kept like the room keys. On another computer the keychain cannot open
      // it, and the transfer that brought this file carries it again.
      savedData.link = raw.link && typeof raw.link.key === "string"
        ? normalizeLink({ ...raw.link, key: dec4disk(raw.link.key) })
        : null;
      savedData.leftRooms = sanitizeLeftRooms(raw.leftRooms);
      if (savedData.link && Array.isArray(raw.siblings)) {
        for (const id of raw.siblings.slice(0, MAX_SIBLINGS)) {
          if (typeof id === "string" && /^[0-9a-f]{8,64}$/i.test(id)) siblingIds.add(id.toLowerCase());
        }
      }
      for (const [id, r] of Object.entries(raw.rooms)) {
        savedData.rooms[id] = { ...r, roomKey: dec4disk(r.roomKey) };
      }
    } else {
      for (const [id, r] of Object.entries(raw)) {
        savedData.rooms[id] = { ...r, roomKey: dec4disk(r.roomKey) };
      }
    }

    // Rooms created before configurable moderation carry no settings. Without a
    // backfill they report null, which the UI shows as "Default settings" and
    // which every filter reads as "not disabled", so the room looks unconfigured
    // and unconfigurable at the same time.
    for (const room of Object.values(savedData.rooms)) {
      if (!room.moderation) room.moderation = { ...DEFAULT_ROOM_MODERATION };
    }

    if ((raw.v || 0) < DATA_VERSION) persistData();
    normalizePersistedDmIds();
  } catch (err) {
    console.error("[chat] Load failed:", err.message);
  }
}

function sanitizeLeftRooms(raw) {
  const out = {};
  const entries = Object.entries(raw && typeof raw === "object" ? raw : {})
    .filter(([roomKey, at]) => isValidRoomKey(roomKey) && Number.isSafeInteger(at) && at > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LEFT_ROOMS);
  for (const [roomKey, at] of entries) out[roomKey.toLowerCase()] = at;
  return out;
}

function markRoomLeft(roomKey) {
  savedData.leftRooms = sanitizeLeftRooms({ ...(savedData.leftRooms || {}), [roomKey]: Date.now() });
}

function clearRoomLeft(roomKey) {
  if (savedData.leftRooms?.[roomKey]) delete savedData.leftRooms[roomKey];
}

function persistData() {
  if (!dataPath) return;
  try {
    const out = {
      v: DATA_VERSION,
      profile: savedData.profile,
      peerProfiles: savedData.peerProfiles,
      pendingDMs: savedData.pendingDMs || {},
      blockedPeers: savedData.blockedPeers || {},
      device: { label: savedData.device?.label || "" },
      link: savedData.link ? { ...savedData.link, key: enc4disk(savedData.link.key) } : null,
      leftRooms: savedData.leftRooms || {},
      siblings: [...siblingIds].slice(0, MAX_SIBLINGS),
      rooms: {},
    };
    for (const [id, r] of Object.entries(savedData.rooms)) {
      out.rooms[id] = { ...r, roomKey: enc4disk(r.roomKey) };
    }
    writeFileSync(dataPath, JSON.stringify(out, null, 2), "utf8");
  } catch (err) {
    console.error("[chat] Save failed:", err.message);
  }
}

function debouncePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistData();
  }, PERSIST_DELAY_MS);
}

function prunePeers() {
  const n = peers.length;
  peers = peers.filter((p) => !p.conn.destroyed);
  return peers.length !== n;
}

function sendPeerCount() {
  prunePeers();
  const n = new Set(peers.map((peer) => peer.fullId || peer.id)).size;
  for (const streams of Object.values(roomSseClients)) {
    for (const s of streams) {
      try { s.write(`event: peersCount\ndata: ${n}\n\n`); } catch {}
    }
  }
  broadcastGlobal("peersCount", { count: n });
}

function broadcastPeerCountNow() {
  if (peerCountTimer) { clearTimeout(peerCountTimer); peerCountTimer = null; }
  sendPeerCount();
}

function broadcastPeerCountDelayed() {
  if (peerCountTimer) clearTimeout(peerCountTimer);
  peerCountTimer = setTimeout(() => { peerCountTimer = null; sendPeerCount(); }, 3000);
}

function relayToMatchingPeers(payload, matches) {
  const dead = [];
  const delivered = new Set();
  for (let i = peers.length - 1; i >= 0; i--) {
    if (peers[i].conn.destroyed) { dead.push(i); continue; }
    if (!matches(peers[i])) continue;
    const identity = peers[i].fullId || peers[i].id;
    if (delivered.has(identity)) continue;
    try {
      writeToConnection(peers[i].conn, payload);
      delivered.add(identity);
    } catch {
      dead.push(i);
    }
  }
  if (dead.length) {
    peers = peers.filter((_, i) => !dead.includes(i));
    broadcastPeerCountDelayed();
  }
}

// A room's key never goes over the wire. Frames name a room by its topic, which
// only means something to someone who already holds the key. The two
// exceptions hand a key over on purpose: a direct-message invite, sent to the
// one person it is with, and the rooms one person's devices pass between
// themselves.
const KEY_HANDOFF_TYPES = new Set(["dm-invite", "link-rooms"]);

function wireTopic(roomKey) {
  return topicHex(deriveTopic(roomKey.toLowerCase()));
}

function toWire(frame) {
  if (!frame || typeof frame !== "object" || KEY_HANDOFF_TYPES.has(frame.type)) return frame;
  const out = { ...frame };
  if ("roomKey" in out) {
    if (isValidRoomKey(out.roomKey)) out.room = wireTopic(out.roomKey);
    delete out.roomKey;
  }
  if (out.type === "profile" && Array.isArray(out.rooms)) {
    out.rooms = out.rooms.filter(isValidRoomKey).map(wireTopic);
  }
  return out;
}

// The other way: a room a peer names by topic is one of ours or nothing, and a
// key it names outright is ignored outside the two handoffs.
function fromWire(frame) {
  if (!frame || typeof frame !== "object") return null;
  if (KEY_HANDOFF_TYPES.has(frame.type) || frame.type === "topics") return frame;
  delete frame.roomKey;
  if ("room" in frame) {
    const roomKey = typeof frame.room === "string" ? discoveryKeys.get(frame.room.toLowerCase()) : "";
    if (!roomKey) return null;
    frame.roomKey = roomKey;
    delete frame.room;
  }
  if (frame.type === "profile" && Array.isArray(frame.rooms)) {
    frame.rooms = frame.rooms
      .map((topic) => (typeof topic === "string" ? discoveryKeys.get(topic.toLowerCase()) : ""))
      .filter(Boolean);
  }
  return frame;
}

function writeToConnection(conn, payload) {
  const transport = chatTransports.get(conn);
  if (!transport) throw new Error("Chat transport is not open");
  const wire = String(payload).split("\n").map((line) => {
    if (!line) return line;
    try { return JSON.stringify(toWire(JSON.parse(line))); } catch { return ""; }
  }).join("\n");
  return transport.send(wire);
}

function relayToRoom(roomKey, payload) {
  relayToMatchingPeers(
    payload,
    (peer) => peerSharesRoom(peer, roomKey) && !isPeerRemovedFromRoom(roomKey, peer),
  );
}

/**
 * Removing people from a room, mirroring mobile so the two agree on the wire.
 *
 * Only whoever made the room can do it, and a removal is checked against the
 * connection it arrived on rather than anything claimed in the payload. See
 * lib/room-moderation.js for why the short creator id is not good enough.
 */
function isRoomCreator(roomKey) {
  const room = savedData.rooms?.[roomKey];
  if (!room) return false;
  const creatorKey = resolveCreatorKey(roomKey, room.creatorKey);
  // A room made before any of this has no key on record. Its host is still its
  // host locally, which is what lets them fill the key in.
  return creatorKey ? creatorKey === localKey : room.isHost === true;
}

function isPeerRemovedFromRoom(roomKey, peer) {
  const bans = savedData.rooms?.[roomKey]?.bans;
  if (!bans?.length) return false;
  return isPeerBannedFromRoom(bans, { peerId: peer.id, connectionKey: peer.fullId });
}

/**
 * By id alone, for the member list and for history somebody else relays.
 *
 * Weaker than the connection check: a ban held by key cannot be matched against
 * an id, so it only catches what the room already knows about them.
 */
function isPeerIdRemovedFromRoom(roomKey, peerId) {
  const bans = savedData.rooms?.[roomKey]?.bans;
  if (!bans?.length) return false;
  return isPeerBannedFromRoom(bans, { peerId });
}

/**
 * The line in the room saying somebody was removed.
 *
 * Written by each peer that honours the removal rather than relayed, so it
 * appears exactly where the removal took effect and cannot be forged by
 * somebody who is not the creator.
 */
function appendRemovalNotice(roomKey, peerId, username) {
  const room = savedData.rooms?.[roomKey];
  const name = clamp(username, MAX_NAME_LEN) ||
    room?.members?.[peerId]?.username ||
    savedData.peerProfiles?.[peerId]?.username ||
    peerId;
  // By name, because "the creator" tells nobody in the room who that was.
  const by = isRoomCreator(roomKey)
    ? (myName() || localId)
    : (room?.createdByName || room?.createdBy || "whoever made the room");
  return appendToFeed(roomKey, {
    id: `removed-${roomKey}-${peerId}-${Date.now()}`,
    type: "system",
    moderationNotice: true,
    text: `${name} was removed from the room by ${by}`,
    ts: Date.now(),
  }).catch(() => {});
}

function isRemovedFromRoom(roomKey) {
  const bans = savedData.rooms?.[roomKey]?.bans;
  if (!bans?.length || isRoomCreator(roomKey)) return false;
  return isPeerBannedFromRoom(bans, { peerId: localId, connectionKey: localKey });
}

function sendRoomBans(conn, roomKey) {
  if (!isRoomCreator(roomKey)) return;
  try {
    writeToConnection(conn, JSON.stringify({
      type: "room-bans",
      roomKey,
      bans: normalizeRoomBans(savedData.rooms?.[roomKey]?.bans),
    }) + "\n");
  } catch {}
}

function broadcastRoomBans(roomKey) {
  if (!isRoomCreator(roomKey)) return;
  for (const peer of peers) {
    if (!peer.conn.destroyed && peerSharesRoom(peer, roomKey)) sendRoomBans(peer.conn, roomKey);
  }
}

/**
 * Whether the peer on this connection has been removed from one room.
 *
 * One connection carries every room two people share, so a removal stops that
 * room and leaves the rest alone. Destroying the connection instead took them
 * offline everywhere the two of you met, and it threw away the removal notice
 * still queued on it, so they never learned why. Nothing of that room is
 * relayed to them, nothing of theirs is read, and no history is sent, which is
 * what being out of a room means when there is no server to shut a door.
 */
function connectionRemovedFrom(conn, roomKey) {
  const peer = peerForConnection(conn) || pendingPeers.get(conn);
  return !!peer && isPeerRemovedFromRoom(roomKey, peer);
}

// Direct-message frames go to one key, never to a short id: whoever the
// conversation is bound to.
function relayToKey(key, payload) {
  if (!key) return;
  relayToMatchingPeers(payload, (peer) => peer.fullId === key);
}

// Whether a frame about a conversation came from the person it is with: the
// key it is bound to, or, before it is bound, the short id it was written for.
function dmFromThem(room, remoteId, fullId) {
  if (!room?.isDM || normPeerId(room.dmWith) !== normPeerId(remoteId)) return false;
  return !room.dmWithKey || room.dmWithKey === fullId;
}

function peerForConnection(conn) {
  return peers.find((peer) => peer.conn === conn);
}

function connectionSharesRoom(conn, roomKey) {
  // Pending peers count: a join can arrive before activation, and dropping it
  // would leave us without the join time history sync needs.
  return peerSharesRoom(peerForConnection(conn) || pendingPeers.get(conn), roomKey);
}

function broadcastGlobal(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead = [];
  for (let i = 0; i < globalSseClients.length; i++) {
    try { globalSseClients[i].write(frame); } catch { dead.push(i); }
  }
  for (let i = dead.length - 1; i >= 0; i--) globalSseClients.splice(dead[i], 1);
}

function roomUpdatePayload(roomKey) {
  const room = savedData.rooms[roomKey];
  if (!room) return null;
  return {
    roomKey,
    name: room.name || roomKey.slice(0, 8) + "...",
    bio: room.bio || "",
    avatar: room.avatar || null,
    isDM: !!room.isDM,
    dmWith: room.dmWith || null,
    pendingAcceptance: !!room.pendingAcceptance,
    blockedByPeer: !!room.blockedByPeer,
    createdBy: room.createdBy || "",
    createdByName: room.createdByName || "",
    isCreator: isRoomCreator(roomKey),
    removedByCreator: isRemovedFromRoom(roomKey),
    bans: normalizeRoomBans(room.bans),
    isPinned: !!room.isPinned,
    isMuted: !!room.isMuted,
    unreadCount: room.unreadCount || 0,
    unreadMentions: room.unreadMentions || 0,
    lastMessage: room.lastMessage || null,
    moderation: room.moderation || null,
  };
}

function emitRoomUpdate(roomKey) {
  const payload = roomUpdatePayload(roomKey);
  if (payload) broadcastGlobal("room-update", payload);
}

async function appendToFeed(roomKey, entry) {
  const feed = roomFeeds[roomKey];
  if (!feed) throw new Error("Feed not initialized");
  await feed.append(entry);
}

function messageCacheKey(roomKey, msgId) {
  return `${roomKey}:${msgId}`;
}

function cacheDecryptedMessage(roomKey, msgId, plaintext) {
  if (!msgId || typeof plaintext !== "string") return;
  decryptedMessageCache.set(messageCacheKey(roomKey, msgId), plaintext);
}

function consumeCachedDecryptedMessage(roomKey, msgId) {
  if (!msgId) return null;
  const key = messageCacheKey(roomKey, msgId);
  if (!decryptedMessageCache.has(key)) return null;
  const plaintext = decryptedMessageCache.get(key);
  decryptedMessageCache.delete(key);
  return plaintext;
}

function isModerationNoticeEntry(entry) {
  return entry?.moderationNotice === true ||
    (entry?.type === "system" && typeof entry.id === "string" && entry.id.startsWith("mod-"));
}

// A preview is untrusted peer data riding the encrypted payload, so the
// receiver filters it independently (README: "your node still filters their
// messages independently"). A flagged preview drops only the card; the message
// itself still lands.
export function dropFlaggedPreview(payload, roomModeration) {
  if (!payload?.preview) return payload;
  const previewText = [payload.preview.title, payload.preview.description].filter(Boolean).join(" ");
  if (!previewText) return payload;
  if (moderationCheckContent(previewText, roomModeration).flagged) {
    return { text: payload.text, preview: null };
  }
  return payload;
}

function feedEntryToMsg(entry, roomKey) {
  if (entry.type === "system") {
    const out = { id: entry.id, type: "system", text: entry.text, timestamp: entry.ts };
    if (entry.moderationNotice) out.moderationNotice = true;
    return out;
  }
  if (entry.type === "reaction") {
    return { id: entry.id, type: "reaction", msgId: entry.msgId, emoji: entry.emoji, sender: entry.sender, senderName: entry.sn || entry.sender, timestamp: entry.ts };
  }
  if (entry.ct && entry.iv && entry.tag) {
    const raw = consumeCachedDecryptedMessage(roomKey, entry.id) ?? decryptMsg(entry.ct, entry.iv, entry.tag, roomKey);
    const payload = dropFlaggedPreview(
      decodeMessagePayload(raw),
      savedData.rooms[roomKey]?.moderation || null,
    );
    const out = {
      id: entry.id,
      sender: entry.sender,
      senderName: entry.sn || entry.sender,
      message: payload.text,
      timestamp: entry.ts,
      replyTo: entry.replyTo || null,
    };
    if (payload.preview) out.preview = payload.preview;
    if (entry.fileName) out.fileName = entry.fileName;
    if (entry.fileSize != null) out.fileSize = entry.fileSize;
    if (entry.fileEnc === true) out.fileEnc = true;
    if (entry.fwd === true) out.forwarded = true;
    return out;
  }
  return {
    id: entry.id || null,
    sender: entry.sender,
    senderName: entry.sn || entry.sender,
    message: entry.message,
    timestamp: entry.timestamp || entry.ts,
    replyTo: entry.replyTo || null,
  };
}

// When a peer joined the room, from their own join announcement. Null until it
// arrives, which is why an unknown peer gets no history here.
function peerJoinedAt(conn, rk) {
  const peer = peerForConnection(conn) || pendingPeers.get(conn);
  const at = peer && savedData.rooms[rk]?.members?.[peer.id]?.joinedAt;
  return Number.isFinite(at) ? at : null;
}

async function syncRoomHistoryTo(conn, rk) {
  if (!connectionSharesRoom(conn, rk)) return;
  if (connectionRemovedFrom(conn, rk)) return;
  const feed = roomFeeds[rk];
  if (!feed || !feed.length) return;
  // Sending history the receiver will discard costs every member bandwidth and
  // battery, multiplied by room size. The join announcement re-triggers this.
  const since = peerJoinedAt(conn, rk);
  if (since === null) return;
  const len = feed.length;
  for (let i = 0; i < len; i++) {
    try {
      if (conn.destroyed) return;
      if (!connectionSharesRoom(conn, rk)) return;
      const e = await feed.get(i);
      if (isModerationNoticeEntry(e)) continue;
      if (Number.isFinite(e?.ts) && e.ts < since) continue;
      const syncType = e.type === "system" ? "sync-system" : e.type === "reaction" ? "sync-reaction" : "sync";
      const ok = writeToConnection(conn, JSON.stringify({ type: syncType, roomKey: rk, ...e }) + "\n");
      if (!ok) {
        const drained = await Promise.race([
          new Promise((r) => conn.once("drain", () => r(true))),
          new Promise((r) => setTimeout(() => r(false), 5000)),
        ]);
        if (!drained || conn.destroyed) return;
      }
    } catch {}
  }
}


function decryptIncomingChat(msg, label) {
  if (!msg.ct || !msg.iv || !msg.tag) {
    console.warn(`[chat] Dropping ${label}: missing encrypted payload`);
    return { ok: false, plaintext: "" };
  }

  try {
    return { ok: true, plaintext: decryptMsg(msg.ct, msg.iv, msg.tag, msg.roomKey) };
  } catch (err) {
    console.warn(`[chat] Dropping ${label}: decrypt failed (${err.message})`);
    return { ok: false, plaintext: "" };
  }
}

function moderationSystemText(peerName, modResult) {
  if (modResult.action === "kick") {
    return `\uD83D\uDEAB ${peerName} was auto-kicked (${modResult.reason})`;
  }
  if (modResult.action === "final-warn") {
    return `\uD83D\uDEA8 Final warning for ${peerName} (${modResult.reason})`;
  }
  return `\u26A0\uFE0F ${peerName}: message filtered (${modResult.reason})`;
}

function appendModerationNotice(roomKey, sourceId, peerName, modResult, ts) {
  const sysId = `mod-${sourceId || Date.now()}-${Math.random().toString(36).slice(2)}`;
  return appendToFeed(roomKey, {
    id: sysId,
    type: "system",
    moderationNotice: true,
    text: moderationSystemText(peerName, modResult),
    ts: ts || Date.now(),
  }).catch(() => {});
}

// Every room this device is in, by topic, each with a proof that it holds the
// key, made for this connection alone. The other side opens a room to us when
// the proof checks out, and nothing else does it: anyone watching the DHT knows
// the topics. Sent before anything about a room goes out on a connection, so a
// peer always has our proof ahead of our join.
const MAX_SHARED_TOPICS = 512;

function topicsFrameFor(conn) {
  const rooms = [];
  for (const [topic, roomKey] of discoveryKeys) {
    const proof = roomProof(roomKey, conn.handshakeHash, conn.publicKey);
    if (proof) rooms.push({ topic, proof });
    if (rooms.length === MAX_SHARED_TOPICS) break;
  }
  return JSON.stringify({ type: "topics", rooms }) + "\n";
}

function shareTopics(conn) {
  try { writeToConnection(conn, topicsFrameFor(conn)); } catch {}
}

function sharePresence(conn) {
  const frame = { type: "presence", state: localIdle ? "idle" : "active" };
  try { writeToConnection(conn, JSON.stringify(frame) + "\n"); } catch {}
}

/**
 * Whether the person is away from PeerSky. Only peers in a room with us hear
 * it: anyone who knows one of our topics gets as far as a connection, and
 * whether we are at the computer is not theirs to know. An older build drops
 * the frame, since it names no room and carries no message.
 */
export function setPresenceIdle(idle) {
  const next = idle === true;
  if (next === localIdle) return;
  localIdle = next;
  for (const peer of peers) {
    if (peer.rooms.length && !peer.conn.destroyed) sharePresence(peer.conn);
  }
}

// A budget of its own, so a burst of room traffic on connecting cannot crowd
// out the one frame that says where someone is.
function takePresenceFrame(peer, now = Date.now()) {
  if (!peer.presenceRate || now >= peer.presenceRate.resetsAt) {
    peer.presenceRate = { count: 1, resetsAt: now + RATE_WINDOW_MS };
    return true;
  }
  if (peer.presenceRate.count >= MAX_PRESENCE_FRAMES_PER_WINDOW) return false;
  peer.presenceRate.count += 1;
  return true;
}

// The ones online that said they are away.
function idleOnlineIds(onlineIds) {
  return onlineIds.filter((id) => idlePeers.has(id));
}

// Everything about rooms a peer has just proved it is in: our profile, each
// room's details and removals, who is in it, our join, and what they missed.
function shareRoomsWith(conn, roomKeys) {
  if (!roomKeys.length) return;
  shareProfile(conn, roomKeys);
  // Room details before the removals, because they carry the creator key and a
  // removal is only believed from the connection whose key that is. Sent
  // first, the list arrived before there was anything to check it against and
  // was dropped, so somebody who left and rejoined found the room open again.
  for (const rk of roomKeys) {
    sendRoomMeta(conn, rk);
    sendRoomBans(conn, rk);
  }
  shareMembers(conn, roomKeys);
  announceJoins(conn, roomKeys);
  (async () => {
    for (const rk of roomKeys) await syncRoomHistoryTo(conn, rk);
    if (!conn.destroyed) {
      try { writeToConnection(conn, JSON.stringify({ type: "sync-done" }) + "\n"); } catch {}
    }
  })().catch(() => {});
}

function shareProfile(conn, roomKeys = peerForConnection(conn)?.rooms || []) {
  if (!savedData.profile?.username) return;
  const sharedRooms = roomKeys.filter((rk) => connectionSharesRoom(conn, rk));
  if (!sharedRooms.length) return;
  // The proof lets the person's other devices take a new name from this one.
  // Anyone else just sees the name with its label.
  const proof = savedData.link ? makeProfileProof(savedData.link, savedData.profile, localKey) : null;
  try {
    writeToConnection(conn, JSON.stringify({
      type: "profile", peerId: localId,
      username: myName(),
      bio: savedData.profile.bio || "",
      avatar: savedData.profile.avatar || null,
      rooms: sharedRooms,
      ...(proof ? { device: savedData.device?.label || "", link: proof } : {}),
    }) + "\n");
  } catch {}
}

function reshareProfile() {
  savedData.peerProfiles[localId] = {
    username: myName(),
    bio: savedData.profile?.bio || "",
    avatar: savedData.profile?.avatar || null,
    updatedAt: Date.now(),
  };
  for (const p of peers) {
    if (!p.conn.destroyed) shareProfile(p.conn, p.rooms);
  }
  broadcastGlobal("profile-update", {
    peerId: localId,
    username: myName(),
    bio: savedData.profile?.bio || "",
    avatar: savedData.profile?.avatar || null,
  });
}

// A profile from another of this person's devices: the labels it knows, and
// its name, bio and picture when they were set after ours.
function takeSiblingProfile(proof, avatar) {
  const labels = mergeLabels(savedData.link.labels, proof.labels);
  const labelsChanged = labels.join() !== mergeLabels(savedData.link.labels).join();
  if (labelsChanged) savedData.link = { ...savedData.link, labels };
  const ourAt = Number.isSafeInteger(savedData.profile?.at) ? savedData.profile.at : 0;
  const newer = proof.at > ourAt;
  if (newer) {
    savedData.profile = {
      ...savedData.profile,
      username: proof.name,
      bio: proof.bio,
      avatar: sanitizeAvatar(avatar),
      at: proof.at,
    };
  }
  if (!labelsChanged && !newer) return;
  persistData();
  if (newer) reshareProfile();
}

function sendRoomMeta(conn, rk) {
  if (!connectionSharesRoom(conn, rk)) return;
  const room = savedData.rooms[rk];
  if (!room || !roomFeeds[rk]) return;

  // Don't send if it's just a placeholder and we aren't the host
  const hasRealName = room.name && room.name !== rk.slice(0, 8) + "...";
  if (!hasRealName && !room.isHost) return;

  try {
    writeToConnection(conn, JSON.stringify({
      type: "room-meta",
      roomKey: rk,
      name: room.name || "",
      bio: room.bio || "",
      link: room.link || "",
      avatar: room.avatar || null,
      createdAt: Number.isSafeInteger(room.createdAt) ? room.createdAt : 0,
      createdBy: room.createdBy || (room.isHost ? localId : ""),
      // Announced by the creator alone. A peer passing this along cannot prove
      // it, so the other side will not take it from them.
      creatorKey: room.isHost ? localKey : "",
      createdByName: room.createdByName || (room.isHost ? (myName() || localId) : ""),
      moderation: room.moderation || null,
    }) + "\n");
  } catch {}
}

// Packed by size, not by count. One frame carrying every member's data-url
// picture passes the receive cap once roughly nine of them have one, and an
// oversized line is dropped whole, so the room quietly stops filling in.
function shareMembers(conn, roomKeys = peerForConnection(conn)?.rooms || []) {
  for (const rk of roomKeys) {
    const room = savedData.rooms[rk];
    if (!room || !room.members || !roomFeeds[rk]) continue;
    if (connectionRemovedFrom(conn, rk)) continue;

    let members = {};
    let bytes = 0;
    const flush = () => {
      if (Object.keys(members).length === 0) return;
      try {
        writeToConnection(conn, JSON.stringify({ type: "members-list", roomKey: rk, members }) + "\n");
      } catch {}
      members = {};
      bytes = 0;
    };

    for (const [peerId, m] of Object.entries(room.members)) {
      if (!peerId || !m?.username) continue;
      let entry = {
        username: m.username,
        bio: m.bio || "",
        avatar: m.avatar || null,
        ...(Number.isFinite(m.joinedAt) ? { joinedAt: m.joinedAt } : {}),
      };
      let size = peerId.length + JSON.stringify(entry).length;
      if (size > MEMBERS_LIST_MAX_BYTES) {
        // One picture too big to travel on its own. Send the person without it
        // rather than dropping them from the room.
        entry = { ...entry, avatar: null };
        size = peerId.length + JSON.stringify(entry).length;
      }
      if (bytes + size > MEMBERS_LIST_MAX_BYTES) flush();
      members[peerId] = entry;
      bytes += size;
    }
    flush();
  }
}

// A peer reports when it joined; trust it for history scope only (a peer can
// always run a client that ignores this) but never accept a future timestamp.
function announcedJoinTs(ts) {
  const now = Date.now();
  return Number.isFinite(ts) && ts > 0 && ts <= now ? ts : now;
}

// Announcing before onboarding sets a name would publish the peer id as the
// display name, and peers write that into their feed permanently.
function announceRoomJoin(roomKey) {
  const uname = myName();
  const room = savedData.rooms[roomKey];
  if (!uname || !room) return;

  const joinTs = room.joinedAt || room.createdAt || Date.now();
  if (!room.joinedAt) { room.joinedAt = joinTs; debouncePersist(); }
  const joinId = `${wireTopic(roomKey)}-${localId}-join-${joinTs}`;
  // Ids used to start with the room key, which then went out with every join.
  // A join already noted under the old id is not noted twice.
  const notedBefore = seenIds.has(`${roomKey}-${localId}-join-${joinTs}`);
  if (roomFeeds[roomKey] && !notedBefore && trackId(joinId)) {
    appendToFeed(roomKey, { id: joinId, type: "system", text: `${uname} joined`, ts: joinTs }).catch(() => {});
  }
  relayToRoom(roomKey, JSON.stringify({
    type: "join", roomKey,
    peerId: localId,
    username: uname,
    bio: savedData.profile?.bio || "",
    avatar: savedData.profile?.avatar || null,
    id: joinId,
    ts: joinTs,
  }) + "\n");
}

function announceJoins(conn, roomKeys = peerForConnection(conn)?.rooms || []) {
  const uname = myName();
  if (!uname) return;
  for (const rk of roomKeys) {
    const room = savedData.rooms[rk];
    if (!room || !roomFeeds[rk]) continue;
    const joinTs = room.joinedAt || room.createdAt || Date.now();
    if (!room.joinedAt) { room.joinedAt = joinTs; debouncePersist(); }
    const joinId = `${wireTopic(rk)}-${localId}-join-${joinTs}`;
    try {
      writeToConnection(conn, JSON.stringify({
        type: "join", roomKey: rk,
        peerId: localId,
        username: uname,
        bio: savedData.profile?.bio || "",
        avatar: savedData.profile?.avatar || null,
        id: joinId,
        ts: joinTs,
      }) + "\n");
    } catch {}
  }
}

/**
 * Forget a room on this device: its topic, its feed, its readers and its
 * record. No leave announcement, because callers either send their own or are
 * dropping a room nobody else ever joined.
 */
async function dropRoomLocally(sdk, roomKey) {
  // The record goes first and the topic after, so a caller that does not wait
  // still sees the room gone on the very next line.
  for (const stream of roomSseClients[roomKey] || []) { try { stream.end(); } catch {} }
  delete roomSseClients[roomKey];
  delete roomFeeds[roomKey];
  joinedRooms.delete(roomKey);
  for (const [discoveryKey, mappedRoomKey] of discoveryKeys) {
    if (mappedRoomKey === roomKey) discoveryKeys.delete(discoveryKey);
  }
  delete savedData.rooms[roomKey];
  if (activeRoom === roomKey) activeRoom = null;
  markRoomLeft(roomKey);
  persistData();

  try {
    await sdk.leave(deriveTopic(roomKey));
  } catch (error) {
    console.warn(`[chat] Leave ${roomKey.slice(0, 8)}: ${error.message}`);
  }
}

/** The room this device already keeps for a conversation with one person. */
function findDirectRoomKey(peerId) {
  const wanted = normPeerId(peerId);
  if (!wanted) return "";
  for (const [rk, room] of Object.entries(savedData.rooms)) {
    if (room.isDM && normPeerId(room.dmWith) === wanted) return rk;
  }
  return "";
}

function dmInviteFrame(roomKey, room) {
  return JSON.stringify({
    type: "dm-invite", roomKey,
    fromId: localId,
    fromUsername: myName() || localId,
    fromAvatar: savedData.profile?.avatar || null,
    fromBio: savedData.profile?.bio || "",
    toId: room.dmWith,
  }) + "\n";
}

// An invite carries the conversation's key, so it goes to one key: the one the
// conversation is bound to, or before that the only key connected behind the
// short id it was written for, which it is then bound to.
function sendDMInvite(conn, roomKey, room, remoteId, fullId) {
  if (!room?.isDM || normPeerId(room.dmWith) !== normPeerId(remoteId)) return;
  const key = room.dmWithKey || soleKeyFor(peers, remoteId);
  if (!key || key !== fullId) return;
  if (!room.dmWithKey) {
    room.dmWithKey = key;
    debouncePersist();
  }
  try { writeToConnection(conn, dmInviteFrame(roomKey, room)); } catch {}
}

// Invites still waiting on the person behind this connection. One already
// accepted is never sent again: the other side holds its key.
function shareDMInvites(conn, remoteId, fullId) {
  for (const [rk, room] of Object.entries(savedData.rooms)) {
    if (room.isDM && room.pendingAcceptance) sendDMInvite(conn, rk, room, remoteId, fullId);
  }
}

// A desktop restored from another desktop starts with a copy of that
// desktop's store, so a feed opened there by name is the same hypercore as
// the other desktop's. Both appending to it would fork it, and hypercore then
// freezes the core for good. PeerSky gives such a desktop a network key of
// its own, so a device whose key is not its store's own keeps its room feeds
// under that key, starting from what the copy already held.
let feedSuffixFor = null;

function roomFeedSuffix(sdk) {
  if (feedSuffixFor?.sdk !== sdk) {
    feedSuffixFor = {
      sdk,
      suffix: (async () => {
        try {
          const own = await sdk.corestore.createKeyPair("noise");
          if (own?.publicKey && sdk.publicKey && !b4a.equals(own.publicKey, sdk.publicKey)) {
            return b4a.toString(sdk.publicKey, "hex").slice(0, 16);
          }
        } catch {}
        return "";
      })(),
    };
  }
  return feedSuffixFor.suffix;
}

async function openRoomFeed(sdk, roomKey) {
  const suffix = await roomFeedSuffix(sdk);
  const feed = sdk.corestore.get({ name: suffix ? `chat-${roomKey}-${suffix}` : "chat-" + roomKey, valueEncoding: "json" });
  await feed.ready();
  if (suffix && feed.length === 0) await copyRoomFeed(sdk, roomKey, feed);
  return feed;
}

async function copyRoomFeed(sdk, roomKey, feed) {
  // Read only: the other desktop still writes the original.
  const copied = sdk.corestore.get({ name: "chat-" + roomKey, valueEncoding: "json" });
  try {
    await copied.ready();
    for (let i = 0; i < copied.length; i++) {
      const entry = await copied.get(i, { wait: false }).catch(() => null);
      if (entry) await feed.append(entry);
    }
  } catch (error) {
    console.warn(`[chat] Copy of ${roomKey.slice(0, 8)}: ${error.message}`);
  } finally {
    await copied.close().catch(() => {});
  }
}

async function joinRoom(sdk, roomKey) {
  // The feed before anyone hears we are in the room. A peer starts sending the
  // moment our proof reaches it, and whatever came in while there was nowhere
  // to keep it was dropped. The first message of a new direct conversation,
  // sent the instant it was accepted, never showed up.
  let feedError = null;
  try {
    await openFeed(sdk, roomKey);
  } catch (error) {
    feedError = error;
  }
  // Left while the feed was opening.
  if (!savedData.rooms[roomKey]) return;

  if (!joinedRooms.has(roomKey)) {
    // Advertise the room even when its feed would not open. A damaged or
    // temporarily unavailable local feed must not make the peer invisible.
    const topic = deriveTopic(roomKey);
    const discoveryKey = topicHex(topic);
    discoveryKeys.set(discoveryKey, roomKey);
    try {
      sdk.join(topic, { client: true, server: true });
      joinedRooms.add(roomKey);
    } catch (error) {
      discoveryKeys.delete(discoveryKey);
      throw error;
    }

    // Proofs are made per connection, so each peer gets its own frame.
    for (const peer of peers) {
      if (!peer.conn.destroyed) shareTopics(peer.conn);
    }

    try {
      await sdk.swarm.flush();
    } catch (error) {
      console.warn(`[chat] Discovery flush ${roomKey.slice(0, 8)}: ${error.message}`);
    }
  }

  if (feedError) throw feedError;
}

// One opening per room, and a second join waits for all of it, not just the
// open. Two joins at once would both copy a restored desktop's history in, and
// both listen for appends.
function openFeed(sdk, roomKey) {
  if (!roomFeeds[roomKey] && !openingFeeds.has(roomKey)) {
    openingFeeds.set(roomKey, setUpFeed(sdk, roomKey).finally(() => openingFeeds.delete(roomKey)));
  }
  return openingFeeds.get(roomKey);
}

async function setUpFeed(sdk, roomKey) {
  const feed = await openRoomFeed(sdk, roomKey);
  roomFeeds[roomKey] = feed;

  for (let i = 0; i < feed.length; i++) {
    try { const e = await feed.get(i); if (e.id) seenIds.add(e.id); } catch {}
  }

  feed.on("append", async () => {
    try {
      const entry = await feed.get(feed.length - 1);
      const msg = feedEntryToMsg(entry, roomKey);

      for (const s of roomSseClients[roomKey] || []) {
        try { s.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {}
      }

      broadcastGlobal("message", { roomKey, ...msg });

      const room = savedData.rooms[roomKey];
      if (room) {
        const isSystem = msg.type === "system";
        const isReaction = msg.type === "reaction";
        if (!isSystem && !isReaction && room.isDM && room.pendingAcceptance && room.dmWith && msg.sender &&
            normPeerId(msg.sender) === normPeerId(room.dmWith)) {
          room.pendingAcceptance = false;
          debouncePersist();
          emitRoomUpdate(roomKey);
        }
        const msgText = typeof msg.message === "string" ? msg.message : "";
        if (!isSystem && !isReaction && msgText) {
          room.lastMessage = {
            sender: msg.sender,
            senderName: msg.senderName,
            message: msgText.slice(0, 120),
            timestamp: msg.timestamp,
          };
        }
        if (isReaction && msg.emoji) {
          room.lastMessage = {
            sender: msg.sender,
            senderName: msg.senderName,
            message: `reacted ${msg.emoji}`,
            timestamp: msg.timestamp,
          };
        }

        if (!isSystem && !isReaction && roomKey !== activeRoom && msg.sender !== localId) {
          room.unreadCount = (room.unreadCount || 0) + 1;
          const uname = savedData.profile?.username;
          if (uname && msgText.includes("@" + uname)) {
            room.unreadMentions = (room.unreadMentions || 0) + 1;
          }
        }
        if (isReaction && roomKey !== activeRoom && msg.sender !== localId) {
          room.unreadCount = (room.unreadCount || 0) + 1;
        }
        emitRoomUpdate(roomKey);
        debouncePersist();
      }
    } catch (err) {
      console.error("[chat] Append error:", err.message);
    }
  });
}

// A room as another of this person's devices takes it, with its key. Null for
// one not worth having there: one this device was removed from, and a direct
// conversation the other person has not accepted or has blocked, which would
// only send them a second request.
function sharedRoomEntry(roomKey) {
  const room = savedData.rooms[roomKey];
  if (!room || !isValidRoomKey(roomKey) || isRemovedFromRoom(roomKey)) return null;
  if (room.isDM && (room.pendingAcceptance || room.blockedByPeer || !room.dmWith)) return null;
  return {
    roomKey,
    name: room.name,
    bio: room.bio,
    link: room.link,
    isDM: !!room.isDM,
    dmWith: room.dmWith || "",
    createdAt: room.createdAt,
    joinedAt: room.joinedAt || 0,
    createdBy: room.createdBy || (room.isHost ? localId : ""),
    createdByName: room.createdByName || "",
    creatorKey: room.creatorKey || (room.isHost ? localKey : ""),
  };
}

function sharedRoomEntries() {
  return Object.keys(savedData.rooms).map(sharedRoomEntry).filter(Boolean);
}

// For a transfer to another of this person's devices: the link, the label
// the other device takes, the profile and every room with its key. The link is
// made here the first time, which makes this the device the name was made on.
// Null until a name is set.
export function exportChatTransfer({ targetType = "desktop" } = {}) {
  if (!savedData.profile?.username) return null;
  if (!savedData.link) savedData.link = createLink("desktop");
  const rooms = sharedRoomEntries();
  // Kept as given, so the next desktop is not given the same label.
  const label = nextLabel(savedData.link, targetType === "mobile" ? "mobile" : "desktop");
  savedData.link = { ...savedData.link, labels: mergeLabels(savedData.link.labels, [label]) };
  persistData();
  return makeTransfer({
    link: savedData.link,
    label,
    profile: savedData.profile,
    rooms,
  });
}

// Puts a transfer from another of this person's devices in place and returns
// the rooms it added. A device holding another link, or none, takes the
// person's link, name and the label it was given. One already holding this
// link keeps its label and takes the name only when it is newer. adopt: this
// device was just made from the one that sent it (a desktop restored from
// another desktop), so it takes its label even though it has the link.
function applyChatTransfer(transfer, { adopt = false } = {}) {
  const sameLink = !!savedData.link && linkId(savedData.link) === linkId(transfer.link);
  // Devices proven with another link are not this person's.
  if (!sameLink) siblingIds.clear();
  if (!sameLink || adopt) {
    savedData.link = { ...transfer.link, labels: mergeLabels(transfer.link.labels, [transfer.label]) };
    savedData.device = { label: transfer.label };
    if (transfer.profile) {
      savedData.profile = { ...savedData.profile, ...transfer.profile, createdAt: savedData.profile?.createdAt || Date.now() };
    }
  } else {
    savedData.link = { ...savedData.link, labels: mergeLabels(savedData.link.labels, transfer.link.labels) };
    const ourAt = Number.isSafeInteger(savedData.profile?.at) ? savedData.profile.at : 0;
    if (transfer.profile && transfer.profile.at > ourAt) savedData.profile = { ...savedData.profile, ...transfer.profile };
  }

  const added = addRooms(transfer.rooms);
  persistData();
  return added;
}

// Adds rooms from another of this person's devices and returns the new ones.
// A room left here stays left.
function addRooms(rooms) {
  const added = [];
  for (const room of rooms) {
    const existing = savedData.rooms[room.roomKey];
    if (existing) {
      // A copied chat file carries keys the keychain here cannot open.
      existing.roomKey = room.roomKey;
      if (room.creatorKey && !existing.creatorKey) existing.creatorKey = room.creatorKey;
      continue;
    }
    if (savedData.leftRooms?.[room.roomKey]) continue;
    savedData.rooms[room.roomKey] = {
      roomKey: room.roomKey,
      isHost: !!room.creatorKey && room.creatorKey === localKey,
      name: room.name || room.roomKey.slice(0, 8) + "...",
      bio: room.bio,
      link: room.link,
      createdAt: room.createdAt || Date.now(),
      ...(room.joinedAt ? { joinedAt: room.joinedAt } : {}),
      createdBy: room.createdBy,
      createdByName: room.createdByName,
      isPinned: false, isMuted: false,
      unreadCount: 0, unreadMentions: 0,
      lastMessage: null, members: {},
      moderation: { ...DEFAULT_ROOM_MODERATION },
      creatorKey: room.creatorKey,
      bans: [],
      ...(room.isDM ? { isDM: true, dmWith: room.dmWith } : {}),
    };
    added.push(room.roomKey);
  }
  return added;
}

async function joinAddedRooms(added, why) {
  if (!chatSdk) return;
  for (const roomKey of added) {
    await joinRoom(chatSdk, roomKey).catch((error) => {
      console.error(`[chat] Join from ${why} ${roomKey.slice(0, 8)}: ${error.message}`);
    });
    announceRoomJoin(roomKey);
    emitRoomUpdate(roomKey);
  }
}

// Rooms are offered only to a peer whose profile proved, on its own
// connection, that it is another of this person's devices.
function siblingFor(conn) {
  const entry = peerForConnection(conn) || pendingPeers.get(conn);
  return entry?.sibling ? entry : null;
}

function sendRoomsToSibling(conn, rooms) {
  if (!rooms.length || !siblingFor(conn)) return;
  try { writeToConnection(conn, JSON.stringify({ type: "link-rooms", rooms }) + "\n"); } catch {}
}

// A room joined here goes to this person's other devices that are online.
// The rest get it with every room the next time they connect.
function offerRoomToSiblings(roomKey) {
  const entry = sharedRoomEntry(roomKey);
  if (!entry) return;
  for (const peer of peers) {
    if (peer.sibling && !peer.conn.destroyed) sendRoomsToSibling(peer.conn, [entry]);
  }
}

async function takeSiblingRooms(list) {
  const added = addRooms(normalizeSharedRooms(list));
  if (!added.length) return;
  persistData();
  await joinAddedRooms(added, "your other device");
}

// A transfer taken while PeerChat runs, as when a phone sends its rooms to
// this desktop. The new rooms are joined straight away.
export async function importChatTransfer(raw, options = {}) {
  const transfer = normalizeTransfer(raw);
  if (!transfer) return { ok: false, added: 0 };
  const added = applyChatTransfer(transfer, options);
  await joinAddedRooms(added, "transfer");
  reshareProfile();
  return { ok: true, added: added.length, label: savedData.device?.label || "" };
}

function takeIncomingTransfer() {
  if (!dataPath) return;
  const incomingPath = dataPath.replace(/[^/\\]+$/, CHAT_INCOMING);
  if (!existsSync(incomingPath)) return;
  try {
    const transfer = normalizeTransfer(JSON.parse(readFileSync(incomingPath, "utf8")));
    if (transfer) applyChatTransfer(transfer, { adopt: true });
  } catch (err) {
    console.error("[chat] Incoming transfer failed:", err.message);
  }
  try { unlinkSync(incomingPath); } catch {}
}

export function initChat(sdk, options = {}) {
  if (options.safeStorage) safeStore = options.safeStorage;
  if (options.storagePath) dataPath = options.storagePath;
  localId = sdk.publicKey ? b4a.toString(sdk.publicKey, "hex").slice(0, 8).toLowerCase() : "local";
  // The whole key. The eight characters above are a label; a removal is checked
  // against this. See lib/room-moderation.js.
  localKey = sdk.publicKey ? b4a.toString(sdk.publicKey, "hex").toLowerCase() : "";

  initModeration().catch((e) => console.warn("[chat] Moderation blocklist load failed:", e.message));

  // PeerSky makes the SDK again after a backup or a transfer closes the
  // stores for a copy. The last one's topics and feeds went with it, so every
  // room is joined again on this one. Without this the rooms were never
  // announced again, and nothing could be sent or heard until a restart.
  if (chatSdk && chatSdk !== sdk) {
    joinedRooms.clear();
    for (const roomKey of Object.keys(roomFeeds)) delete roomFeeds[roomKey];
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      persistData();
    }
  }

  loadData();
  chatSdk = sdk;
  takeIncomingTransfer();

  // A room this device made under another key, as on a desktop restored from
  // another desktop, is not this device's to run: the creator key says who is.
  for (const room of Object.values(savedData.rooms || {})) {
    if (room?.isHost && room.creatorKey && room.creatorKey !== localKey) room.isHost = false;
  }

  // After loadData, not before it: there are no rooms to walk until the file
  // has been read. A room made before any of this has no creator key on record,
  // and the device that made it is the only one that can fill that in.
  let filledCreatorKey = false;
  for (const room of Object.values(savedData.rooms || {})) {
    if (!room || room.isDM) continue;
    if (room.isHost && !room.creatorKey) {
      room.creatorKey = localKey;
      filledCreatorKey = true;
    }
    room.bans = normalizeRoomBans(room.bans);
  }
  if (filledCreatorKey) persistData();

  // Unref'd so a peer-count heartbeat never keeps a process alive on its own.
  setInterval(() => {
    if (globalSseClients.length > 0) sendPeerCount();
  }, 10_000).unref?.();

  // Nothing listens for the swarm's topic changes. Anyone can announce a
  // topic, so being found under one opens nothing, and our proofs already go
  // out when a connection opens, when we join a room, when a peer opens one
  // with us, and on every ping. The LAN swarm reports a change on every mDNS
  // sighting, and answering each with a frame of proofs ran through the other
  // side's control budget, which then dropped the proof for a new room.

  sdk.swarm.on("connection", (conn, info = {}) => {
    const remoteId = conn.remotePublicKey
      ? b4a.toString(conn.remotePublicKey, "hex").slice(0, 8).toLowerCase()
      : "peer";
    const fullId = conn.remotePublicKey
      ? b4a.toString(conn.remotePublicKey, "hex").toLowerCase()
      : remoteId;

    // Found under one of our topics, or arriving without any (server-side
    // connections do). Either way it starts in no room: rooms open one by one
    // as the peer proves it holds their keys.
    const foundUnderOurs = sharedRoomsFromTopics(info.topics, discoveryKeys).length > 0;
    const isChat = foundUnderOurs || (!info.topics?.length && discoveryKeys.size > 0);

    if (!isChat) {
      conn.on("error", () => {});
      return;
    }

    // Found again under another topic: the connection already has its chat.
    if (chatTransports.has(conn)) return;

    conn.on("error", (e) => console.error(`[chat] Peer [${remoteId}]:`, e.message));

    let buf = "";
    let active = false;
    let pingTimer = null;
    const peer = { conn, id: remoteId, fullId, rooms: [], lan: !!info.lan, handshake: false };
    pendingPeers.set(conn, peer);

    // Protomux fires onopen synchronously when the remote open frame is
    // already buffered - before chatTransports.set below has run - and every
    // writeToConnection in activatePeer would then throw into silent catches
    // (no topics, profile, meta or join announcements for this peer). Defer
    // activation one tick so the transport is always registered first.
    // onopen can fire synchronously, before chatTransports.set below; activate
    // a tick later and only once the channel is open on both ends.
    const transport = attachChatTransport(conn, handleChatData, {
      onopen: () => setImmediate(() => {
        const t = chatTransports.get(conn);
        if (!t) return;
        t.ready().then(() => activatePeer()).catch(() => {});
      }),
      onclose: deactivatePeer,
    });
    if (!transport) {
      pendingPeers.delete(conn);
      return;
    }
    chatTransports.set(conn, transport);

    function activatePeer() {
      if (active || conn.destroyed) return;
      active = true;
      pendingPeers.delete(conn);
      peers.push(peer);
      broadcastPeerCountNow();
      broadcastGlobal("peer-status", { peerId: remoteId, isOnline: true });
      // Whether they are away comes again on this connection, once a room
      // opens on it. Until then they are taken as here, which is also all an
      // older build that never says can be.
      if (idlePeers.delete(remoteId)) broadcastGlobal("peer-idle", { peerId: remoteId, idle: false });

      // Our proofs, and any invite waiting on this person. Nothing about a
      // room goes out here: a room opens when the peer proves it holds the key,
      // and everything about it goes then (shareRoomsWith).
      shareTopics(conn);
      shareDMInvites(conn, remoteId, fullId);

      pingTimer = setInterval(() => {
        if (conn.destroyed) { clearInterval(pingTimer); return; }
        try { writeToConnection(conn, JSON.stringify({ type: "ping" }) + "\n"); } catch {}
        // Idempotent re-announce; heals any lost activation-time frame.
        shareTopics(conn);
      }, PING_MS);
    }

    function deactivatePeer() {
      pendingPeers.delete(conn);
      if (!active) return;
      active = false;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      peers = peers.filter((candidate) => candidate.conn !== conn);
      broadcastPeerCountDelayed();
      const stillConnected = peers.some((candidate) =>
        candidate.id === remoteId && !candidate.conn.destroyed
      );
      if (!stillConnected) {
        broadcastGlobal("peer-status", { peerId: remoteId, isOnline: false });
      }
    }

    function handleChatData(raw) {
      buf += raw.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          if (line.length > MAX_MSG_LEN * 4) continue;
          const msg = fromWire(JSON.parse(line));
          if (!msg) continue;

          if (
            msg.roomKey &&
            !DM_CONTROL_TYPES.has(msg.type) &&
            !connectionSharesRoom(conn, msg.roomKey)
          ) continue;

          // Scoped to the one-to-one room, not the peer, so a block never
          // silences someone in a room you both belong to.
          if (msg.roomKey && !DM_CONTROL_TYPES.has(msg.type)) {
            const dmRoom = savedData.rooms[msg.roomKey];
            if (dmRoom?.isDM && normPeerId(dmRoom.dmWith) === remoteId && isPeerBlocked(remoteId)) continue;
          }

          if (msg.type === "ping") {
            try { writeToConnection(conn, JSON.stringify({ type: "pong" }) + "\n"); } catch {}
            continue;
          }
          if (msg.type === "pong") continue;

          if (msg.type === "topics") {
            const peerEntry = peerForConnection(conn) || pendingPeers.get(conn);
            if (peerEntry && Array.isArray(msg.rooms)) {
              peerEntry.handshake = true;
              const added = [];
              for (const entry of msg.rooms.slice(0, MAX_SHARED_TOPICS)) {
                const topic = typeof entry?.topic === "string" ? entry.topic.toLowerCase() : "";
                // Unknown topics resolve to nothing, and a known one opens only
                // with a proof made with its key for this connection.
                const rk = discoveryKeys.get(topic);
                if (!rk || peerSharesRoom(peerEntry, rk)) continue;
                if (!checkRoomProof(rk, conn.handshakeHash, conn.remotePublicKey, entry.proof)) continue;
                peerEntry.rooms.push(rk);
                added.push(rk);
              }
              if (added.length) {
                // Our proofs before anything of ours about these rooms, or the
                // other side drops our join as coming from outside the room.
                // Every time, not once: one of these may be a room we joined
                // after the last frame of proofs went out on this connection.
                // The other side ignores rooms already open, so it settles.
                shareTopics(conn);
                shareRoomsWith(conn, added);
                if (!peerEntry.presenceShared) {
                  peerEntry.presenceShared = true;
                  sharePresence(conn);
                }
                broadcastPeerCountNow();
              }
            }
            continue;
          }

          // Whether they are away, from someone in a room with us.
          if (msg.type === "presence") {
            const entry = peerForConnection(conn);
            if (!entry?.rooms.length || !takePresenceFrame(entry)) continue;
            const idle = msg.state === "idle";
            if (idle === idlePeers.has(remoteId)) continue;
            if (idle) idlePeers.add(remoteId);
            else idlePeers.delete(remoteId);
            broadcastGlobal("peer-idle", { peerId: remoteId, idle });
            continue;
          }

          if (msg.type === "profile") {
            if (msg.link && savedData.link && savedData.profile?.username &&
                checkProfileProof(savedData.link, msg.link, msg.avatar || null, fullId)) {
              if (!siblingIds.has(remoteId) && siblingIds.size < MAX_SIBLINGS) {
                siblingIds.add(remoteId);
                persistData();
              }
              const entry = peerForConnection(conn) || pendingPeers.get(conn);
              const first = entry && !entry.sibling;
              if (entry) entry.sibling = true;
              takeSiblingProfile(msg.link, msg.avatar || null);
              // Every room this device is in, once per connection.
              if (first) sendRoomsToSibling(conn, sharedRoomEntries());
            }
            if (msg.username) {
              const uname = clamp(msg.username, 50);
              const ubio = clamp(msg.bio, MAX_BIO_LEN);
              const uavatar = sanitizeAvatar(msg.avatar);
              savedData.peerProfiles[remoteId] = { username: uname, bio: ubio, avatar: uavatar, updatedAt: Date.now() };
              for (const room of Object.values(savedData.rooms)) {
                if (dmFromThem(room, remoteId, fullId)) {
                  room.name = uname;
                  room.bio = ubio || "";
                  room.avatar = uavatar;
                }
              }

              const peerEntry = peerForConnection(conn);
              const peerRoomKeys = Array.isArray(msg.rooms)
                ? msg.rooms.filter((rk) =>
                    isValidRoomKey(rk) &&
                    savedData.rooms[rk] &&
                    peerSharesRoom(peerEntry, rk)
                  )
                : (peerEntry?.rooms || []);
              for (const rk of peerRoomKeys) {
                const room = savedData.rooms[rk];
                if (!room) continue;
                if (!room.members) room.members = {};
                // Who they are, not when they joined. A room opens by proof and
                // the profile goes out with it, ahead of the join, so taking
                // the moment we heard it as their join time cut off what was
                // said between their join and their proof (the first message
                // in a direct message just accepted), and made the join look
                // like a reconnect, so nobody saw them arrive.
                room.members[remoteId] = {
                  ...(room.members[remoteId] || {}),
                  username: uname, bio: ubio, avatar: uavatar,
                };
              }
              debouncePersist();
              broadcastGlobal("member-update", { peerId: remoteId, username: uname, bio: ubio, avatar: uavatar, isOnline: true, rooms: peerRoomKeys });
            }
            continue;
          }

          if (msg.type === "join") {
            if (!msg.roomKey || !msg.peerId) continue;
            const joinPeerId = remoteId || msg.peerId;
            // Block join using the connection-level peer identity, not the self-reported body.
            if (moderationIsKicked(joinPeerId, msg.roomKey)) continue;
            const joinName = clamp(msg.username, 50) ||
              savedData.rooms[msg.roomKey]?.members?.[joinPeerId]?.username ||
              savedData.peerProfiles?.[joinPeerId]?.username ||
              joinPeerId;
            const room = savedData.rooms[msg.roomKey];
            // Announcing a join does not undo a removal.
            if (room && isPeerBannedFromRoom(room.bans, { peerId: joinPeerId, connectionKey: fullId })) continue;
            const alreadyKnownMember = !!(room?.members?.[joinPeerId]?.joinedAt);
            const knownJoin = room?.members?.[joinPeerId]?.joinedAt;
            const announcedJoin = announcedJoinTs(msg.ts);
            if (room) {
              if (!room.members) room.members = {};
              room.members[joinPeerId] = {
                ...(room.members[joinPeerId] || {}),
                username: joinName,
                bio: clamp(msg.bio, MAX_BIO_LEN),
                avatar: sanitizeAvatar(msg.avatar),
                // This person's other device is in the room as of when the
                // person joined it, so the history since then goes to it too.
                joinedAt: knownJoin != null && !(siblingIds.has(joinPeerId) && announcedJoin < knownJoin)
                  ? knownJoin
                  : announcedJoin,
              };
              debouncePersist();
              broadcastGlobal("member-update", { peerId: joinPeerId, username: joinName, bio: clamp(msg.bio, MAX_BIO_LEN), avatar: sanitizeAvatar(msg.avatar), isOnline: true, rooms: [msg.roomKey] });
            }

            const sysId = msg.id || `${wireTopic(msg.roomKey)}-${joinPeerId}-join-${msg.ts || Date.now()}`;
            if (roomFeeds[msg.roomKey] && !alreadyKnownMember && trackId(sysId)) {
              appendToFeed(msg.roomKey, { id: sysId, type: "system", text: `${joinName} joined`, ts: msg.ts || Date.now() }).catch(() => {});
            }

            // Explicitly send the meta back to the peer who just joined
            sendRoomMeta(conn, msg.roomKey); 
            syncRoomHistoryTo(conn, msg.roomKey).then(() => {
              if (!conn.destroyed) {
                try { writeToConnection(conn, JSON.stringify({ type: "sync-done" }) + "\n"); } catch {}
              }
            }).catch(() => {});
            continue;
          }

          if (msg.type === "dm-invite") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (msg.toId && normPeerId(msg.toId) !== normPeerId(localId)) continue;
            if (isPeerBlocked(remoteId)) {
              // Tell them rather than dropping it silently, so the request does
              // not sit there looking like it is still pending.
              try {
                writeToConnection(conn, JSON.stringify({
                  type: "dm-blocked", roomKey: msg.roomKey, fromId: localId,
                }) + "\n");
              } catch {}
              continue;
            }
            // A key we already hold as something other than a conversation
            // with this person is not theirs to name.
            const claimed = savedData.rooms[msg.roomKey];
            if (claimed && !dmFromThem(claimed, remoteId, fullId)) continue;
            if (claimed) {
              try {
                writeToConnection(conn, JSON.stringify({
                  type: "dm-accept", roomKey: msg.roomKey,
                  fromId: localId, fromUsername: myName() || localId,
                  fromAvatar: savedData.profile?.avatar || null,
                  fromBio: savedData.profile?.bio || "",
                }) + "\n");
              } catch {}
              continue;
            }

            // Both of us pressed Message before either invite landed, so there
            // are two keys for one conversation. Keys are random, so the lower
            // one is an answer both sides reach alone: whoever holds the other
            // drops it, and an unaccepted room has nothing in it to lose.
            const ours = findDirectRoomKey(remoteId);
            if (ours) {
              if (!savedData.rooms[ours]?.pendingAcceptance || ours < msg.roomKey) {
                sendDMInvite(conn, ours, savedData.rooms[ours], remoteId, fullId);
                continue;
              }
              dropRoomLocally(sdk, ours).catch(() => {});
            }
            const fromName = clamp(msg.fromUsername, MAX_NAME_LEN) || remoteId;
            const fromAvatar = sanitizeAvatar(msg.fromAvatar);
            const fromBio = clamp(msg.fromBio, MAX_BIO_LEN);
            if (!savedData.pendingDMs) savedData.pendingDMs = {};
            if (!savedData.pendingDMs[msg.roomKey]) {
              savedData.pendingDMs[msg.roomKey] = {
                // The key it came from, which the answer goes back to and the
                // conversation is bound to once accepted.
                roomKey: msg.roomKey, fromId: remoteId, fromKey: fullId,
                fromUsername: fromName, fromAvatar, fromBio,
                receivedAt: Date.now(),
              };
              persistData();
            }
            broadcastGlobal("dm-invite", {
              roomKey: msg.roomKey, fromId: remoteId, fromUsername: fromName,
              fromAvatar, fromBio,
            });
            continue;
          }

          // Rooms another of this person's devices is in. Only from a peer that
          // proved it is one on this connection; anything else is dropped.
          if (msg.type === "link-rooms") {
            if (siblingFor(conn) && savedData.link && Array.isArray(msg.rooms)) {
              takeSiblingRooms(msg.rooms).catch((error) => {
                console.error(`[chat] Rooms from your other device: ${error.message}`);
              });
            }
            continue;
          }

          if (msg.type === "dm-accept") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!dmFromThem(room, remoteId, fullId)) continue;
            const acceptName = clamp(msg.fromUsername, MAX_NAME_LEN) || remoteId;
            const acceptAvatar = sanitizeAvatar(msg.fromAvatar);
            const acceptBio = clamp(msg.fromBio, MAX_BIO_LEN);
            room.avatar = acceptAvatar;
            room.bio = acceptBio || "";
            room.pendingAcceptance = false;
            room.blockedByPeer = false;
            if (!room.dmWithKey) room.dmWithKey = fullId;
            debouncePersist();
            offerRoomToSiblings(msg.roomKey);
            broadcastGlobal("dm-accepted", {
              roomKey: msg.roomKey, fromId: remoteId, fromUsername: acceptName,
              fromAvatar: acceptAvatar, fromBio: acceptBio,
            });
            continue;
          }

          if (msg.type === "dm-blocked") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!dmFromThem(room, remoteId, fullId)) continue;
            room.pendingAcceptance = false;
            room.blockedByPeer = true;
            debouncePersist();
            broadcastGlobal("dm-blocked", { roomKey: msg.roomKey, fromId: remoteId });
            continue;
          }

          if (msg.type === "dm-reject") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!dmFromThem(room, remoteId, fullId)) continue;
            broadcastGlobal("dm-rejected", {
              roomKey: msg.roomKey, fromId: remoteId,
              fromUsername: clamp(msg.fromUsername, MAX_NAME_LEN) || remoteId,
            });
            continue;
          }

          // Removed by whoever made the room. Nothing they send counts,
          // including a removal list of their own, so this sits above every
          // handler below.
          if (msg.roomKey && isValidRoomKey(msg.roomKey)) {
            const peerRecord = peerForConnection(conn);
            if (peerRecord && isPeerRemovedFromRoom(msg.roomKey, peerRecord)) continue;
          }

          // The removal list, from the creator and nobody else. It carries no
          // message id and no encrypted body, so a build that predates this
          // drops it at its first check rather than making anything of it.
          if (msg.type === "room-bans") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!room) continue;
            if (!isRoomCreatorConnection({
              roomKey: msg.roomKey,
              storedKey: room.creatorKey,
              connectionKey: fullId,
            })) continue;

            // Their list replaces ours outright: they are the record.
            const before = new Set(normalizeRoomBans(room.bans).map((ban) => ban.id));
            room.bans = normalizeRoomBans(msg.bans);
            for (const ban of room.bans) {
              if (!before.has(ban.id)) appendRemovalNotice(msg.roomKey, ban.id, ban.name);
            }
            // Anyone the creator let back in stops being filtered out.
            for (const id of Object.keys(room.members || {})) {
              if (isPeerBannedFromRoom(room.bans, { peerId: id })) delete room.members[id];
            }
            persistData();
            emitRoomUpdate(msg.roomKey);
            continue;
          }

          if (msg.type === "room-meta") {
            const room = savedData.rooms[msg.roomKey];
            if (!room) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (room.isDM) { emitRoomUpdate(msg.roomKey); continue; }

            const incomingName = clamp(msg.name, MAX_NAME_LEN);
            const currentIsPlaceholder = !room.name || room.name === msg.roomKey?.slice(0, 8) + "...";
            const incomingIsPlaceholder = !incomingName || incomingName === msg.roomKey?.slice(0, 8) + "...";

            let updated = false;

            // Only accept name if ours is a placeholder AND incoming is real
            if (currentIsPlaceholder && !incomingIsPlaceholder) {
              room.name = incomingName;
              updated = true;
            }

            // Only fill bio/link/avatar/creator if currently missing - prevents spoofing
            if (msg.bio && !room.bio) { room.bio = clamp(msg.bio, MAX_BIO_LEN); updated = true; }
            if (msg.link && !room.link) { room.link = clamp(msg.link, MAX_LINK_LEN) || ""; updated = true; }
            if (msg.avatar && !room.avatar) {
              room.avatar = sanitizeAvatar(msg.avatar);
              if (room.avatar) updated = true;
            }
            // The room cannot have been created after the first person in it,
            // so the earliest anyone reports wins. Without this every device
            // showed the day it joined.
            const earliestCreatedAt = earliestRoomCreatedAt(room.createdAt, msg.createdAt);
            if (earliestCreatedAt && earliestCreatedAt !== room.createdAt) {
              room.createdAt = earliestCreatedAt;
              updated = true;
            }
            if (msg.createdBy && !room.createdBy) { room.createdBy = clamp(msg.createdBy, MAX_SENDER_LEN); updated = true; }
            // Only from the creator, and only once. The connection is what
            // proves it: whoever announces has to be the key they announce.
            if (acceptsCreatorKey({
              roomKey: msg.roomKey,
              storedKey: room.creatorKey,
              createdBy: room.createdBy,
              announcedKey: msg.creatorKey,
              connectionKey: fullId,
            })) {
              room.creatorKey = normalizeCreatorKey(msg.creatorKey);
              updated = true;
            }
            if (msg.createdByName && !room.createdByName) { room.createdByName = clamp(msg.createdByName, 50); updated = true; }

            // The host owns the room's moderation settings, so mirror whatever
            // they send and never let a remote peer rewrite our own when we are
            // the host. `room.isHost` is about us, not the sender.
            if (msg.moderation && !room.isHost) {
              const next = sanitizeRoomModeration(msg.moderation);
              if (JSON.stringify(next) !== JSON.stringify(room.moderation)) {
                room.moderation = next;
                updated = true;
              }
            }

            if (updated) {
              debouncePersist();
              emitRoomUpdate(msg.roomKey);
            }
            continue;
          }

          if (msg.type === "request-room-meta") {
            if (msg.roomKey && moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (msg.roomKey && savedData.rooms[msg.roomKey]) {
              sendRoomMeta(conn, msg.roomKey);
            }
            continue;
          }

          if (msg.type === "leave") {
            if (msg.roomKey && msg.peerId) {
              if (moderationIsKicked(remoteId, msg.roomKey)) continue;
              const leaveName = clamp(msg.username, 50) || msg.peerId;
              const room = savedData.rooms[msg.roomKey];
              if (room?.members?.[msg.peerId]) {
                delete room.members[msg.peerId];
              }
              const sysId = msg.id || `${wireTopic(msg.roomKey)}-${msg.peerId}-left-${msg.ts || Date.now()}`;
              if (roomFeeds[msg.roomKey] && trackId(sysId)) {
                appendToFeed(msg.roomKey, { id: sysId, type: "system", text: `${leaveName} left`, ts: msg.ts || Date.now() }).catch(() => {});
              }
              debouncePersist();
              broadcastGlobal("member-leave", {
                roomKey: msg.roomKey, peerId: msg.peerId,
                username: leaveName,
              });
            }
            continue;
          }

          if (msg.type === "members-list") {
            if (!msg.roomKey || !savedData.rooms[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!room.members) room.members = {};
            const incoming = msg.members || {};
            // Only merge new member profiles, never blindly delete based on incomplete lists
            for (const [peerId, m] of Object.entries(incoming)) {
              // Somebody removed is not in the room, so a list relayed by
              // anyone who has not heard yet cannot put them back into it.
              if (isPeerBannedFromRoom(room.bans, { peerId })) continue;
              if (!room.members[peerId]) room.members[peerId] = m;
            }
            debouncePersist();
            continue;
          }

          if (msg.type === "sync-done") {
            broadcastGlobal("sync-complete", {});
            continue;
          }

          if (msg.type === "sync-reaction") {
            if (!msg.id || !msg.roomKey || !msg.msgId || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const _srRoom = savedData.rooms[msg.roomKey];
            if (_srRoom && !_srRoom.isHost && _srRoom.joinedAt && msg.ts && msg.ts < _srRoom.joinedAt) continue;
            if (!trackId(msg.id)) continue;
            appendToFeed(msg.roomKey, {
              type: "reaction", id: msg.id, msgId: clamp(msg.msgId, 64),
              emoji: clamp(msg.emoji, 10), sender: clamp(msg.sender, MAX_SENDER_LEN),
              sn: clamp(msg.sn, 50), ts: msg.ts || Date.now(),
            }).catch(() => {});
            continue;
          }

          if (msg.type === "sync-system") {
            if (!msg.id || !msg.roomKey || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const _sysRoom = savedData.rooms[msg.roomKey];
            if (_sysRoom && !_sysRoom.isHost && _sysRoom.joinedAt && msg.ts && msg.ts < _sysRoom.joinedAt) continue;
            if (!trackId(msg.id)) continue;
            const _sysRoomMod = savedData.rooms[msg.roomKey]?.moderation || null;
            const sysModeration = moderationCheckContent(msg.text, _sysRoomMod);
            if (sysModeration.flagged) {
              appendModerationNotice(msg.roomKey, msg.id, "Synced history", {
                action: "warn",
                reason: sysModeration.reason,
              }, msg.ts);
              continue;
            }
            appendToFeed(msg.roomKey, { id: msg.id, type: "system", text: msg.text, ts: msg.ts || Date.now() }).catch(() => {});
            continue;
          }

          // A removed person's old messages can still reach us through somebody
          // else's history sync, which is how they kept appearing afterwards.
          if ((msg.type === "sync" || msg.type === "sync-reaction") && msg.roomKey && msg.sender &&
              isPeerIdRemovedFromRoom(msg.roomKey, normPeerId(msg.sender))) continue;

          if (msg.type === "sync") {
            if (!msg.id || !msg.roomKey || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const _syncRoom = savedData.rooms[msg.roomKey];
            if (_syncRoom && !_syncRoom.isHost && _syncRoom.joinedAt && msg.ts && msg.ts < _syncRoom.joinedAt) continue;
            if (!trackId(msg.id)) continue;
            const decrypted = decryptIncomingChat(msg, "synced message");
            if (!decrypted.ok) continue;
            const _syncRoomMod = savedData.rooms[msg.roomKey]?.moderation || null;
            const syncedPayload = dropFlaggedPreview(decodeMessagePayload(decrypted.plaintext), _syncRoomMod);
            const syncModeration = moderationCheckContent(syncedPayload.text, _syncRoomMod);
            if (syncModeration.flagged) {
              const syncPeerName = clamp(msg.sn, 50) || clamp(msg.sender, MAX_SENDER_LEN) || remoteId;
              appendModerationNotice(msg.roomKey, msg.id, syncPeerName, {
                action: "warn",
                reason: syncModeration.reason,
              }, msg.ts);
              continue;
            }
            cacheDecryptedMessage(msg.roomKey, msg.id, syncedPayload.preview ? decrypted.plaintext : syncedPayload.text);
            appendToFeed(msg.roomKey, {
              id: msg.id, sender: clamp(msg.sender, MAX_SENDER_LEN), sn: clamp(msg.sn, 50),
              ct: msg.ct, iv: msg.iv, tag: msg.tag, ts: msg.ts,
              ...(msg.replyTo && { replyTo: msg.replyTo }),
              ...(msg.fileName && { fileName: clamp(msg.fileName, MAX_FILE_NAME_LEN) }),
              ...(msg.fileSize != null && { fileSize: msg.fileSize }), ...(msg.fileEnc === true && { fileEnc: true }),
              ...(msg.fwd === true && { fwd: true }),
            }).catch(() => {});
            continue;
          }

          if (msg.type === "reaction") {
            if (!msg.id || !msg.roomKey || !msg.msgId || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (!trackId(msg.id)) continue;
            appendToFeed(msg.roomKey, {
              type: "reaction", id: msg.id, msgId: clamp(msg.msgId, 64),
              emoji: clamp(msg.emoji, 10), sender: remoteId,
              sn: clamp(msg.sn, 50) || remoteId, ts: msg.ts || Date.now(),
            }).catch(() => {});
            continue;
          }

          if (!msg.id || !msg.roomKey || !roomFeeds[msg.roomKey]) continue;
          if (moderationIsKicked(remoteId, msg.roomKey)) continue;
          if (!trackId(msg.id)) continue;

          let moderatedPlaintext = "";
          try {
            const decrypted = decryptIncomingChat(msg, "peer message");
            if (!decrypted.ok) continue;
            const _peerRoomMod = savedData.rooms[msg.roomKey]?.moderation || null;
            const payload = dropFlaggedPreview(decodeMessagePayload(decrypted.plaintext), _peerRoomMod);
            moderatedPlaintext = payload.preview ? decrypted.plaintext : payload.text;
            const modResult = moderationCheck(remoteId, msg.roomKey, payload.text, undefined, {
              roomModeration: _peerRoomMod,
            });
            if (!modResult.allowed) {
              const peerName = clamp(msg.sn, 50) || savedData.peerProfiles[remoteId]?.username || remoteId;
              appendModerationNotice(msg.roomKey, msg.id, peerName, modResult, msg.ts);
              continue;
            }
          } catch (modErr) {
            console.warn("[chat] Moderation check error:", modErr.message);
            // On error, allow the message through rather than silently dropping
          }
          cacheDecryptedMessage(msg.roomKey, msg.id, moderatedPlaintext);
          appendToFeed(msg.roomKey, {
            id: msg.id, sender: remoteId, sn: clamp(msg.sn, 50) || remoteId,
            ct: msg.ct, iv: msg.iv, tag: msg.tag, ts: msg.ts,
            ...(msg.replyTo && { replyTo: msg.replyTo }),
            ...(msg.fileName && { fileName: clamp(msg.fileName, MAX_FILE_NAME_LEN) }),
            ...(msg.fileSize != null && { fileSize: msg.fileSize }), ...(msg.fileEnc === true && { fileEnc: true }),
            ...(msg.fwd === true && { fwd: true }),
          }).catch((e) => console.error("[chat] Peer msg error:", e.message));

          const room = savedData.rooms[msg.roomKey];
          if (room) {
            if (!room.members) room.members = {};
            room.members[remoteId] = {
              username: msg.sn || savedData.peerProfiles[remoteId]?.username || remoteId,
              joinedAt: room.members[remoteId]?.joinedAt || Date.now(),
            };
            debouncePersist();
          }
        } catch {}
      }
    }

    conn.on("close", () => {
      deactivatePeer();
    });
  });

  // Install the connection listeners before joining. A discovered LAN peer can
  // connect immediately, especially when both instances run on the same host.
  for (const roomKey of Object.keys(savedData.rooms)) {
    joinRoom(sdk, roomKey).catch((error) => {
      console.error(`[chat] Auto-join ${roomKey.slice(0, 8)}: ${error.message}`);
    });
  }
}

function respond(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleChatRequest(req, sdk) {
  const urlObj = new URL(req.url);
  const action = urlObj.searchParams.get("action");
  const roomKey = urlObj.searchParams.get("roomKey");

  try {
    if (req.method === "POST") {
      if (action === "create-key") {
        const body = await req.json().catch(() => ({}));
        if (body.avatar != null && body.avatar !== "" && sanitizeAvatar(body.avatar) === null) {
          return respond(400, { error: "Invalid room image" });
        }
        const key = randomBytes(32).toString("hex");
        savedData.rooms[key] = {
          roomKey: key, isHost: true,
          name: clamp(body.name, MAX_NAME_LEN) || "New Room",
          bio: clamp(body.bio, MAX_BIO_LEN),
          link: clamp(body.link, MAX_LINK_LEN) || "",
          avatar: sanitizeAvatar(body.avatar),
          createdAt: Date.now(),
          createdBy: localId,
          // The whole key, because the short creator id above is a label and a
          // removal has to be checked against something that cannot be ground
          // out. See lib/room-moderation.js.
          creatorKey: localKey,
          bans: [],
          createdByName: myName() || localId,
          isPinned: false, isMuted: false,
          unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {},
          moderation: sanitizeRoomModeration(body.moderation),
        };
        persistData();
        return respond(200, { roomKey: key });
      }

      if (action === "join-dm") {
        const body = await req.json().catch(() => ({}));
        const toId = clamp(body.toId, MAX_SENDER_LEN);
        const toUsername = clamp(body.toUsername, MAX_NAME_LEN) || toId;
        const toAvatar = sanitizeAvatar(body.toAvatar);
        const toBio = clamp(body.toBio, MAX_BIO_LEN);
        if (!toId) return respond(400, { error: "toId required" });
        const toIdNorm = normPeerId(toId);
        // One conversation per person, found by who it is with. The key used to
        // be sha256 of the two peer ids, and those are public: anybody who knew
        // both could derive it, join the topic and read the whole conversation
        // along with its media. A room key is a secret, so it is minted like
        // any other room's and handed over on the connection instead.
        const dmRoomKey = findDirectRoomKey(toIdNorm) || randomBytes(32).toString("hex");
        if (isPeerBlocked(toIdNorm)) return respond(403, { error: "Unblock this person before messaging them." });
        // Asking again clears it. A block that could never be retried would
        // make the other side's unblock meaningless, and if they are still
        // blocking us the answer comes straight back.
        const retried = savedData.rooms[dmRoomKey];
        if (retried?.blockedByPeer) {
          retried.blockedByPeer = false;
          retried.pendingAcceptance = true;
          persistData();
        }
        if (!savedData.rooms[dmRoomKey]) {
          savedData.rooms[dmRoomKey] = {
            roomKey: dmRoomKey, isHost: false, isDM: true,
            dmWith: toIdNorm,
            name: toUsername, bio: toBio || "", avatar: toAvatar || null,
            createdAt: Date.now(),
            createdBy: localId,
            createdByName: myName() || localId,
            isPinned: false, isMuted: false,
            unreadCount: 0, unreadMentions: 0,
            lastMessage: null, members: {},
            pendingAcceptance: true,
          };
          persistData();
        }
        await joinRoom(sdk, dmRoomKey).catch(() => {});
        // To the one key behind that short id, bound from here on. With nobody
        // there yet, or two keys sharing it, it waits: the invite goes out when
        // they connect, if they are then the only one.
        const room = savedData.rooms[dmRoomKey];
        const toKey = room.dmWithKey || soleKeyFor(peers, toIdNorm);
        if (toKey) {
          if (!room.dmWithKey) {
            room.dmWithKey = toKey;
            persistData();
          }
          relayToKey(toKey, dmInviteFrame(dmRoomKey, room));
        }
        return respond(200, { roomKey: dmRoomKey });
      }

      if (action === "block-peer") {
        const body = await req.json().catch(() => ({}));
        const peerId = normPeerId(body.peerId);
        if (!peerId) return respond(400, { error: "peerId required" });
        if (peerId === normPeerId(localId)) return respond(400, { error: "You cannot block yourself." });

        if (!savedData.blockedPeers) savedData.blockedPeers = {};
        const existing = savedData.blockedPeers[peerId];
        savedData.blockedPeers[peerId] = {
          peerId,
          username: clamp(body.username, MAX_NAME_LEN) || existing?.username || peerId,
          blockedAt: existing?.blockedAt ?? Date.now(),
        };
        const ids = Object.keys(savedData.blockedPeers);
        while (ids.length > MAX_BLOCKED_PEERS) delete savedData.blockedPeers[ids.shift()];

        // Drop any request they already had waiting.
        if (savedData.pendingDMs) {
          for (const [key, pending] of Object.entries(savedData.pendingDMs)) {
            if (normPeerId(pending.fromId) === peerId) delete savedData.pendingDMs[key];
          }
        }
        persistData();
        return respond(200, { blockedPeers: listBlockedPeers(), pendingDMs: savedData.pendingDMs || {} });
      }

      if (action === "remove-room-member") {
        const body = await req.json().catch(() => ({}));
        const rk = body.roomKey;
        if (!rk || !isValidRoomKey(rk)) return respond(400, { error: "Invalid room key" });
        const room = savedData.rooms[rk];
        if (!room) return respond(404, { error: "Room not found" });
        if (room.isDM) return respond(400, { error: "There is nobody to remove from a direct message." });
        if (!isRoomCreator(rk)) {
          return respond(403, { error: "Only the person who made this room can remove people from it." });
        }

        const peerId = normPeerId(body.peerId);
        if (!peerId) return respond(400, { error: "peerId required" });
        if (peerId === normPeerId(localId)) {
          return respond(400, { error: "You cannot remove yourself from your own room." });
        }

        // Their full key if they are here to take it from, so the removal
        // catches that person rather than anyone sharing their first eight.
        const connected = peers.find((peer) => peer.id === peerId && peerSharesRoom(peer, rk));
        const removedName = room.members?.[peerId]?.username ||
          savedData.peerProfiles?.[peerId]?.username || "";
        // The name goes with the removal, for anyone in the room who never met them.
        room.bans = addRoomBan(room.bans, { id: peerId, key: connected?.fullId || "", name: removedName });
        if (room.members?.[peerId]) delete room.members[peerId];

        appendRemovalNotice(rk, peerId, removedName);
        broadcastRoomBans(rk);
        persistData();
        emitRoomUpdate(rk);
        return respond(200, { bans: room.bans });
      }

      if (action === "restore-room-member") {
        const body = await req.json().catch(() => ({}));
        const rk = body.roomKey;
        if (!rk || !isValidRoomKey(rk)) return respond(400, { error: "Invalid room key" });
        const room = savedData.rooms[rk];
        if (!room) return respond(404, { error: "Room not found" });
        if (!isRoomCreator(rk)) {
          return respond(403, { error: "Only the person who made this room can let people back in." });
        }

        room.bans = removeRoomBan(room.bans, body.peerId);
        broadcastRoomBans(rk);
        persistData();
        emitRoomUpdate(rk);
        return respond(200, { bans: room.bans });
      }

      if (action === "unblock-peer") {
        const body = await req.json().catch(() => ({}));
        const peerId = normPeerId(body.peerId);
        if (!peerId || !savedData.blockedPeers?.[peerId]) {
          return respond(404, { error: "That person is not blocked." });
        }
        delete savedData.blockedPeers[peerId];
        persistData();
        return respond(200, { blockedPeers: listBlockedPeers() });
      }

      if (action === "accept-dm") {
        const body = await req.json().catch(() => ({}));
        const dmRoomKey = body.roomKey;
        if (!dmRoomKey || !isValidRoomKey(dmRoomKey)) return respond(400, { error: "Invalid room key" });
        if (!savedData.pendingDMs) savedData.pendingDMs = {};
        const pending = savedData.pendingDMs[dmRoomKey];
        if (!pending) return respond(404, { error: "No pending DM invite" });
        const peerNorm = normPeerId(pending.fromId);
        // Bound to the key the invite came from. A request kept from before
        // keys were recorded falls back to the only key behind the short id.
        const fromKey = pending.fromKey || soleKeyFor(peers, peerNorm);
        savedData.rooms[dmRoomKey] = {
          roomKey: dmRoomKey, isHost: false, isDM: true,
          dmWith: peerNorm,
          ...(fromKey && { dmWithKey: fromKey }),
          name: pending.fromUsername, bio: pending.fromBio || "",
          avatar: pending.fromAvatar || null,
          createdAt: pending.receivedAt || Date.now(),
          createdBy: peerNorm, createdByName: pending.fromUsername,
          isPinned: false, isMuted: false,
          unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {},
          pendingAcceptance: false,
        };
        delete savedData.pendingDMs[dmRoomKey];
        clearRoomLeft(dmRoomKey);
        persistData();
        await joinRoom(sdk, dmRoomKey).catch(() => {});
        offerRoomToSiblings(dmRoomKey);
        const acceptMsg = JSON.stringify({
          type: "dm-accept", roomKey: dmRoomKey,
          fromId: localId, fromUsername: myName() || localId,
          fromAvatar: savedData.profile?.avatar || null,
          fromBio: savedData.profile?.bio || "",
        }) + "\n";
        relayToKey(fromKey, acceptMsg);
        return respond(200, { roomKey: dmRoomKey });
      }

      if (action === "reject-dm") {
        const body = await req.json().catch(() => ({}));
        const dmRoomKey = body.roomKey;
        if (!dmRoomKey || !isValidRoomKey(dmRoomKey)) return respond(400, { error: "Invalid room key" });
        if (!savedData.pendingDMs) savedData.pendingDMs = {};
        const pending = savedData.pendingDMs[dmRoomKey];
        if (!pending) return respond(404, { error: "No pending DM invite" });
        const peerNorm = normPeerId(pending.fromId);
        delete savedData.pendingDMs[dmRoomKey];
        persistData();
        const rejectMsg = JSON.stringify({
          type: "dm-reject", roomKey: dmRoomKey,
          fromId: localId, fromUsername: myName() || localId,
        }) + "\n";
        relayToKey(pending.fromKey || soleKeyFor(peers, peerNorm), rejectMsg);
        return respond(200, { ok: true });
      }

      if (action === "join") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const isNew = !savedData.rooms[roomKey];
        if (isNew) {
          savedData.rooms[roomKey] = {
            roomKey, isHost: false,
            name: roomKey.slice(0, 8) + "...",
            bio: "", createdAt: Date.now(),
            createdBy: "", createdByName: "",
            isPinned: false, isMuted: false,
            unreadCount: 0, unreadMentions: 0,
            lastMessage: null, members: {},
            // Filters stay on until the host's room-meta arrives with the real
            // settings. Starting permissive would leak content the host chose
            // to filter during the window before meta lands.
            moderation: { ...DEFAULT_ROOM_MODERATION },
            // Learned from the creator when they announce it, never assumed.
            creatorKey: "",
            bans: [],
          };
          persistData();
        }
        clearRoomLeft(roomKey);
        await joinRoom(sdk, roomKey);

        const room = savedData.rooms[roomKey];
        if (room && !room.joinedAt) { room.joinedAt = Date.now(); debouncePersist(); }
        announceRoomJoin(roomKey);
        offerRoomToSiblings(roomKey);

        if (isNew) {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (savedData.rooms[roomKey]?.name !== roomKey.slice(0, 8) + "...") break;
          }
          if (savedData.rooms[roomKey]) emitRoomUpdate(roomKey);
        }

        return respond(200, { message: "Joined", identity: localId, room });
      }

      if (action === "react") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        if (!roomFeeds[roomKey]) return respond(404, { error: "Room not found" });
        const body = await req.json();
        if (!body.msgId) return respond(400, { error: "Missing msgId" });
        const id = randomBytes(16).toString("hex");
        if (!trackId(id)) return respond(200, { ok: true });
        const emoji = clamp(body.emoji || "", 10);
        const entry = {
          type: "reaction", id, msgId: clamp(body.msgId, 64), emoji,
          sender: localId, sn: myName() || localId, ts: Date.now(),
        };
        await appendToFeed(roomKey, entry);
        relayToRoom(roomKey, JSON.stringify({ ...entry, roomKey }) + "\n");
        return respond(200, { ok: true });
      }

      if (action === "send") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        if (!roomFeeds[roomKey]) return respond(404, { error: "Room not found" });
        if (!checkRate(roomKey)) return respond(429, { error: "Rate limited" });

        const body = await req.json();
        const message = clamp(body.message, MAX_MSG_LEN);
        if (!message) return respond(400, { error: "Empty message" });

        const _sendRoom = savedData.rooms[roomKey];
        const _sendRoomMod = _sendRoom?.moderation || null;

        // A block closes the conversation both ways, so neither side can send.
        if (_sendRoom?.isDM && _sendRoom.blockedByPeer) {
          return respond(403, { error: "This person blocked your direct messages." });
        }
        if (_sendRoom?.isDM && isPeerBlocked(_sendRoom.dmWith)) {
          return respond(403, { error: "Unblock this person before messaging them." });
        }

        const modResult = moderationCheck(localId, roomKey, message, undefined, {
          allowKick: false,
          checkSpam: false,
          roomModeration: _sendRoomMod,
        });

        if (!modResult.allowed) {
          return respond(403, {
            error: `Message blocked: ${modResult.reason}`,
            moderation: true,
            action: modResult.action,
            blockedUntil: modResult.blockedUntil,
            remainingMs: modResult.remainingMs,
          });
        }
        const id = randomBytes(16).toString("hex");
        if (!trackId(id)) return respond(200, { message: "Duplicate" });

        let preview = null;
        if (savedData.profile?.linkPreview !== false) {
          const previewUrl = extractFirstHttpUrl(message);
          if (previewUrl && !moderationCheckContent(previewUrl, _sendRoomMod).flagged) {
            try {
              const resolved = await resolveLinkPreview(previewUrl, { timeoutMs: 1500 });
              const previewText = `${resolved?.title || ""} ${resolved?.description || ""}`;
              if (resolved && !moderationCheckContent(previewText, _sendRoomMod).flagged) {
                preview = sanitizePreview(resolved);
              }
            } catch {
              // Preview metadata is optional; a fetch failure never blocks the message.
            }
          }
        }

        const payload = encodeMessagePayload(message, preview);
        const { ct, iv, tag } = encryptMsg(payload, roomKey);
        const ts = Date.now();
        const sn = myName() || localId;
        const replyTo = body.replyTo ? {
          id: clamp(body.replyTo.id, 64),
          sender: clamp(body.replyTo.sender, MAX_SENDER_LEN),
          sn: clamp(body.replyTo.sn, 50),
          text: clamp(body.replyTo.text, 200),
        } : null;
        let fileName = null;
        let fileSize = null;
        if (body.fileName != null && String(body.fileName).trim() !== "") {
          fileName = clamp(String(body.fileName), MAX_FILE_NAME_LEN);
        }
        if (typeof body.fileSize === "number" && Number.isFinite(body.fileSize) && body.fileSize >= 0) {
          fileSize = Math.floor(body.fileSize);
        }
        const fileEnc = body.fileEnc === true && !!fileName;
        // Sent on from another chat: shown as forwarded on every side. A build
        // without this shows it as an ordinary message.
        const forwarded = body.forwarded === true;
        const entry = {
          id, sender: localId, sn, ct, iv, tag, ts,
          ...(replyTo && { replyTo }),
          ...(fileName && { fileName }),
          ...(fileSize != null && fileName && { fileSize }),
          ...(fileEnc && { fileEnc: true }),
          ...(forwarded && { fwd: true }),
        };

        cacheDecryptedMessage(roomKey, id, payload);
        await appendToFeed(roomKey, entry);
        relayToRoom(roomKey, JSON.stringify({ ...entry, roomKey }) + "\n");
        return respond(200, {
          message: "Sent",
          sent: {
            id, sender: localId, senderName: sn, message, timestamp: ts, replyTo: replyTo || null, roomKey,
            ...(preview && { preview }),
            ...(fileName && { fileName }),
            ...(fileSize != null && { fileSize }),
            ...(fileEnc && { fileEnc: true }),
            ...(forwarded && { forwarded: true }),
          },
        });
      }

      if (action === "save-profile") {
        const body = await req.json();
        if (body.avatar != null && body.avatar !== "" && sanitizeAvatar(body.avatar) === null) {
          return respond(400, { error: "Invalid profile image" });
        }
        const parsedName = parseProfileUsername(body.username ?? "");
        if (parsedName === null) {
          return respond(400, { error: "Username may only contain letters, numbers, and spaces (max 50 characters)." });
        }
        const nextUsername = parsedName || savedData.profile?.username || "";
        if (!nextUsername) {
          return respond(400, { error: "Username required." });
        }
        const nextAvatar = body.avatar !== undefined
          ? sanitizeAvatar(body.avatar)
          : savedData.profile?.avatar || null;
        const nextBio = clamp(body.bio, MAX_BIO_LEN);
        // When the name, bio or picture were set, so the person's other devices
        // take the newest. Toggling a setting leaves it alone, or a device that
        // missed a rename would send the old name back as the newest.
        const profileChanged = nextUsername !== savedData.profile?.username ||
          nextBio !== (savedData.profile?.bio || "") ||
          (nextAvatar || null) !== (savedData.profile?.avatar || null);
        savedData.profile = {
          username: nextUsername,
          bio: nextBio,
          avatar: nextAvatar,
          at: profileChanged ? Date.now() : (savedData.profile?.at || 0),
          createdAt: savedData.profile?.createdAt || Date.now(),
          notifications: body.notifications !== undefined ? !!body.notifications : (savedData.profile?.notifications ?? true),
          linkPreview: body.linkPreview !== undefined ? !!body.linkPreview : (savedData.profile?.linkPreview ?? true),
        };
        savedData.peerProfiles[localId] = {
          username: myName(),
          bio: savedData.profile.bio || "",
          avatar: savedData.profile.avatar || null,
          updatedAt: Date.now(),
        };
        for (const room of Object.values(savedData.rooms)) {
          if (room.isHost && room.createdBy === localId) {
            room.createdByName = myName() || localId;
          }
        }
        persistData();

        for (const p of peers) {
          if (!p.conn.destroyed) shareProfile(p.conn, p.rooms);
        }
        for (const rk of joinedRooms) announceRoomJoin(rk);
        broadcastGlobal("profile-update", {
          peerId: localId,
          username: myName(),
          bio: savedData.profile.bio || "",
          avatar: savedData.profile.avatar || null,
        });

        return respond(200, {
          ok: true,
          profile: { ...savedData.profile, id: localId, device: savedData.device?.label || "", displayName: myName() },
        });
      }

      if (action === "update-room") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const room = savedData.rooms[roomKey];
        if (!room) return respond(404, { error: "Room not found" });
        const body = await req.json();
        if (body.name !== undefined) room.name = clamp(body.name, MAX_NAME_LEN);
        if (body.bio !== undefined) room.bio = clamp(body.bio, MAX_BIO_LEN);
        if (body.isPinned !== undefined) room.isPinned = !!body.isPinned;
        if (body.isMuted !== undefined) room.isMuted = !!body.isMuted;
        persistData();
        emitRoomUpdate(roomKey);
        return respond(200, { ok: true });
      }

      if (action === "delete-room") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const leaveTs = Date.now();
        const leaveId = `${wireTopic(roomKey)}-${localId}-left-${leaveTs}`;
        const leaveMsg = JSON.stringify({
          type: "leave", peerId: localId,
          username: myName() || localId, roomKey,
          id: leaveId, ts: leaveTs,
        }) + "\n";
        relayToRoom(roomKey, leaveMsg);
        await dropRoomLocally(sdk, roomKey);
        return respond(200, { ok: true });
      }

      if (action === "mark-read") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const room = savedData.rooms[roomKey];
        if (room) {
          room.unreadCount = 0;
          room.unreadMentions = 0;
          room.lastReadTs = Date.now();
          persistData();
        }
        return respond(200, { ok: true });
      }

      if (action === "set-active") {
        activeRoom = roomKey && isValidRoomKey(roomKey) ? roomKey : null;
        if (activeRoom) {
          const room = savedData.rooms[activeRoom];
          if (room) { room.unreadCount = 0; room.unreadMentions = 0; persistData(); }
        }
        return respond(200, { ok: true });
      }

      if (action === "request-meta") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });

        // Ensure the room exists locally before broadcasting (prevents spam amplification)
        if (!savedData.rooms[roomKey]) return respond(403, { error: "Not a member of this room" });

        const requestMsg = JSON.stringify({
          type: "request-room-meta", roomKey
        }) + "\n";
        relayToRoom(roomKey, requestMsg);
        return respond(200, { ok: true });
      }
    }

    if (req.method === "GET") {
      if (action === "get-profile") {
        return respond(200, {
          id: localId,
          username: savedData.profile?.username || "",
          device: savedData.device?.label || "",
          displayName: myName(),
          bio: savedData.profile?.bio || "",
          avatar: savedData.profile?.avatar || null,
          createdAt: savedData.profile?.createdAt || 0,
          notifications: savedData.profile?.notifications ?? true,
          linkPreview: savedData.profile?.linkPreview ?? true,
          blockedPeers: listBlockedPeers(),
          // This person's other devices, whose messages are theirs too.
          siblings: [...siblingIds],
        });
      }

      if (action === "net-status") {
        return respond(200, {
          peers: peers.map((p) => ({ id: p.id, rooms: p.rooms, lan: !!p.lan, handshake: !!p.handshake })),
          pending: pendingPeers.size,
        });
      }

      if (action === "get-rooms") {
        const rooms = [];
        for (const [k, r] of Object.entries(savedData.rooms)) {
          rooms.push({
            roomKey: k,
            // A direct chat with another of this person's devices is a chat
            // with themselves.
            name: r.isDM && r.dmWith && siblingIds.has(String(r.dmWith).slice(0, 8).toLowerCase())
              ? "You"
              : r.name || k.slice(0, 8) + "...",
            bio: r.bio || "",
            link: r.link || "",
            avatar: r.avatar || null,
            isHost: !!r.isHost,
            isDM: !!r.isDM,
            dmWith: r.dmWith || null,
            pendingAcceptance: !!r.pendingAcceptance,
            blockedByPeer: !!r.blockedByPeer,
            isPinned: !!r.isPinned,
            isMuted: !!r.isMuted,
            createdAt: r.createdAt || 0,
            createdBy: r.createdBy || "",
            createdByName: r.createdByName || "",
            isCreator: isRoomCreator(k),
            removedByCreator: isRemovedFromRoom(k),
            bans: normalizeRoomBans(r.bans),
            lastMessage: r.lastMessage || null,
            unreadCount: r.unreadCount || 0,
            unreadMentions: r.unreadMentions || 0,
            lastReadTs: r.lastReadTs || 0,
            members: r.members || {},
            moderation: r.moderation || null,
          });
        }
        prunePeers();
        const onlinePeers = [...new Set(peers.map((p) => p.id))];
        return respond(200, { rooms, peerProfiles: savedData.peerProfiles || {}, onlinePeers, idlePeers: idleOnlineIds(onlinePeers), pendingDMs: savedData.pendingDMs || {}, blockedPeers: listBlockedPeers() });
      }

      if (action === "get-history") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const feed = roomFeeds[roomKey];
        if (!feed) {
          if (savedData.rooms[roomKey]) return respond(200, { messages: [] });
          return respond(404, { error: "Room not found" });
        }
        const room = savedData.rooms[roomKey];
        const joinedAt = (room && !room.isHost && room.joinedAt) ? room.joinedAt : 0;
        const messages = [];
        const dedupIds = new Set();
        for (let i = 0; i < feed.length; i++) {
          try {
            const msg = feedEntryToMsg(await feed.get(i), roomKey);
            if (msg.id && dedupIds.has(msg.id)) continue;
            if (msg.id) dedupIds.add(msg.id);
            if (joinedAt && msg.timestamp && msg.timestamp < joinedAt) continue;
            messages.push(msg);
          } catch {}
        }
        messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        return respond(200, { messages });
      }

      if (action === "receive") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const feed = roomFeeds[roomKey];
        if (!feed) return respond(404, { error: "Room not found" });

        const stream = new PassThrough();
        stream.write(`event: identity\ndata: ${JSON.stringify({ id: localId })}\n\n`);
        const _rcvRoom = savedData.rooms[roomKey];
        const _rcvJoinedAt = (_rcvRoom && !_rcvRoom.isHost && _rcvRoom.joinedAt) ? _rcvRoom.joinedAt : 0;
        for (let i = 0; i < feed.length; i++) {
          try {
            const _entry = feedEntryToMsg(await feed.get(i), roomKey);
            if (_rcvJoinedAt && _entry.timestamp && _entry.timestamp < _rcvJoinedAt) continue;
            stream.write(`data: ${JSON.stringify(_entry)}\n\n`);
          } catch {}
        }
        const hb = setInterval(() => { try { stream.write("event: heartbeat\ndata: {}\n\n"); } catch {} }, KEEPALIVE_MS);
        if (!roomSseClients[roomKey]) roomSseClients[roomKey] = [];
        roomSseClients[roomKey].push(stream);
        stream.on("close", () => {
          clearInterval(hb);
          roomSseClients[roomKey] = (roomSseClients[roomKey] || []).filter((s) => s !== stream);
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }

      if (action === "receive-all") {
        const stream = new PassThrough();
        stream.write(`event: identity\ndata: ${JSON.stringify({ id: localId })}\n\n`);

        prunePeers();
        const peerCount = new Set(peers.map((peer) => peer.fullId || peer.id)).size;
        stream.write(`event: peersCount\ndata: ${JSON.stringify({ count: peerCount })}\n\n`);

        const onlineIds = [...new Set(peers.map((p) => p.id))];
        stream.write(`event: online-peers\ndata: ${JSON.stringify({ peers: onlineIds, idle: idleOnlineIds(onlineIds) })}\n\n`);

        for (const k of Object.keys(savedData.rooms)) {
          const p = roomUpdatePayload(k);
          if (p) stream.write(`event: room-update\ndata: ${JSON.stringify(p)}\n\n`);
        }

        if (savedData.pendingDMs) {
          for (const [rk, dm] of Object.entries(savedData.pendingDMs)) {
            stream.write(`event: dm-invite\ndata: ${JSON.stringify({
              roomKey: rk, fromId: dm.fromId, fromUsername: dm.fromUsername,
              fromAvatar: dm.fromAvatar || null, fromBio: dm.fromBio || "",
            })}\n\n`);
          }
        }

        const hb = setInterval(() => { try { stream.write("event: heartbeat\ndata: {}\n\n"); } catch {} }, KEEPALIVE_MS);
        globalSseClients.push(stream);
        stream.on("close", () => {
          clearInterval(hb);
          const idx = globalSseClients.indexOf(stream);
          if (idx !== -1) globalSseClients.splice(idx, 1);
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }
    }

    return respond(400, { error: "Unknown action" });
  } catch (err) {
    console.error("[chat] Request error:", err);
    return respond(500, { error: "Internal error" });
  }
}
