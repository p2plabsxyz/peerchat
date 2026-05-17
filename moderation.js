export const MAX_MSGS_PER_WINDOW = 10;
export const WINDOW_MS = 10_000;
export const WARNING_THRESHOLD = 1;
export const KICK_THRESHOLD = 3;
export const ROOM_REJOIN_COOLDOWN_MS = 5 * 60_000;
export const TRACKER_IDLE_TTL_MS = 30 * 60_000;

/**
 * peerId:roomKey → array of message timestamps (sliding window)
 * @type {Map<string, number[]>}
 */
const spamTracker = new Map();

/**
 * peerId:roomKey → cumulative violation count
 * @type {Map<string, number>}
 */
const violationTracker = new Map();

/**
 * peerId:roomKey -> last violation timestamp
 * @type {Map<string, number>}
 */
const violationTouchedAt = new Map();

/**
 * peerId:roomKey → timestamp when the peer was kicked
 * @type {Map<string, number>}
 */
const kickList = new Map();

let lastCleanupAt = 0;

const ABUSE_PATTERNS = [
  // Slurs and hate speech
  /\bn[i1!][g9]{1,2}[e3]r\b/i,
  /\bn[i1!][g9]{1,2}[a@]\b/i,
  /\bf[a@][g9]{1,2}[o0]t\b/i,
  /\bf[a@][g9]\b/i,
  /\btr[a@]nn(?:y|ie)\b/i,
  /\br[e3]t[a@]rd(?:ed)?\b/i,
  /\bk[i1!]ke\b/i,
  /\bsp[i1!]c\b/i,
  /\bch[i1!]nk\b/i,
  /\bw[e3]tb[a@]ck\b/i,
  /\bcunt\b/i,
  // Direct harassment
  /\bkys\b/i,
  /\bkill\s*your\s*self\b/i,
  /\bgo\s*die\b/i,
  /\bshoot\s*up\b/i,
  /\brape\s*(you|u|her|him|them)\b/i,
  /\bi('?ll|m\s*going\s*to)\s*(rape|murder|stalk)\b/i,
  // Common profanity
  /\bf+u+c+k+\b/i,
  /\bfuck\s*(you|u|off|ing|er|ed)\b/i,
  /\bsh[i1!]+t+\b/i,
  /\bb[i1!]tch\b/i,
  /\bass\s*hole\b/i,
  /\bdamn\s*(you|it)\b/i,
  /\bstfu\b/i,
  /\bwtf\b/i,
  /\bmotherf/i,
  /\bdick\s*head\b/i,
  /\bdouche\s*bag\b/i,
  /\bwh[o0]re\b/i,
  /\bslut\b/i,
  /\bbastard\b/i,
];

const NSFW_PATTERNS = [
  /\bp[o0]rn(?:o|ography|hub)?\b/i,
  /\bhentai\b/i,
  /\bxxx\b/i,
  /\bxvideos?\b/i,
  /\bxnxx\b/i,
  /\bxhamster\b/i,
  /\bredtube\b/i,
  /\byouporn\b/i,
  /\bbrazzers\b/i,
  /\bonlyfans\.com\b/i,
  /\bchaturbate\b/i,
  /\blivejasmin\b/i,
  /\bstripchat\b/i,
  /\bmasturbat(?:e|ion|ing)\b/i,
  /\bejaculat(?:e|ion|ing)\b/i,
  /\borgasm\b/i,
  /\banal\s*sex\b/i,
  /\bblowjob\b/i,
  /\bcumshot\b/i,
  /\bdeepthroat\b/i,
  /\bgangbang\b/i,
  /\bhardcore\s*sex\b/i,
  /\bnude(?:s|z)?\b/i,
  /\bnsfw\b/i,
  /\bdick\s*pic\b/i,
  // Body / sexual terms
  /\bboob(?:s|ies)?\b/i,
  /\btit(?:s|ties)\b/i,
  /\b(?:dick|cock|pussy)\s*(?:pic|pics|photo|photos|video|videos)\b/i,
  /\bsext(?:ing)?\b/i,
  /\bsexual\s+(?:content|chat|image|images|photo|photos|video|videos|message|messages|acts?)\b/i,
  /\b(?:have|having|had|want|wants|wanted)\s+sex\b/i,
  /\berotic\b/i,
  /\bfetish\b/i,
  /\bstripper\b/i,
  /\bhooker\b/i,
  /\bprostitut/i,
  /\bhorny\b/i,
  /\bjerk\s*off\b/i,
  /\bfap\b/i,
];


const URL_RE = /(?:https?:\/\/|hyper:\/\/)?(?:www\.)?([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,})(?:[\/\?#][^\s]*)?/gi;
const HOSTS_LIST_URL = new URL("./lib/adult-domains.hosts", import.meta.url);
const LOCALHOST_IP_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)$/i;
const HOSTS_DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/i;

/** @type {Set<string>|null} */
let _adultDomains = null;

function readAdultHostsFile() {
  if (typeof XMLHttpRequest !== "undefined") {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", HOSTS_LIST_URL.href, false);
      xhr.send(null);
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 0) {
        return xhr.responseText || "";
      }
    } catch {
      // Fall through to Node-style file loading when available.
    }
  }

  const getBuiltinModule = globalThis.process?.getBuiltinModule;
  if (typeof getBuiltinModule === "function") {
    try {
      const fs = getBuiltinModule("fs");
      const { fileURLToPath } = getBuiltinModule("url");
      return fs.readFileSync(fileURLToPath(HOSTS_LIST_URL), "utf8");
    } catch {
      // The caller will use an empty domain set if the hosts file is unavailable.
    }
  }

  return "";
}

function addHostsDomains(target, hostsText) {
  for (const rawLine of hostsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    const domain = (parts.length >= 2 && LOCALHOST_IP_RE.test(parts[0])
      ? parts[1]
      : parts[0]).toLowerCase();

    if (!HOSTS_DOMAIN_RE.test(domain)) continue;

    target.add(domain);
    if (domain.startsWith("www.")) {
      target.add(domain.slice(4));
    }
  }
}

/**
 * Load the adult domain blocklist.
 * @returns {Set<string>}
 */
export function getAdultDomains() {
  if (_adultDomains) return _adultDomains;

  _adultDomains = new Set();
  addHostsDomains(_adultDomains, readAdultHostsFile());

  return _adultDomains;
}

/**
 * Inject a custom domain set (useful for testing).
 * @param {Set<string>} domains
 */
export function setAdultDomains(domains) {
  _adultDomains = domains;
}

function getDomainSuffixes(domain) {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  const suffixes = [];
  for (let i = 0; i < parts.length - 1; i++) {
    suffixes.push(parts.slice(i).join("."));
  }
  return suffixes;
}


/**
 * Composite key for per-peer-per-room tracking.
 */
function peerRoomKey(peerId, roomKey) {
  return `${peerId}:${roomKey}`;
}

/**
 * Evict stale moderation bookkeeping.
 * @param {number} [now]
 */
export function cleanupModerationState(now) {
  const ts = now ?? Date.now();

  const spamCutoff = ts - WINDOW_MS;
  for (const [key, window] of spamTracker.entries()) {
    while (window.length > 0 && window[0] <= spamCutoff) {
      window.shift();
    }
    if (window.length === 0) spamTracker.delete(key);
  }

  const violationCutoff = ts - TRACKER_IDLE_TTL_MS;
  for (const [key, touchedAt] of violationTouchedAt.entries()) {
    if (touchedAt <= violationCutoff) {
      violationTouchedAt.delete(key);
      violationTracker.delete(key);
    }
  }

  for (const [key, kickedAt] of kickList.entries()) {
    if (ts - kickedAt >= ROOM_REJOIN_COOLDOWN_MS) {
      kickList.delete(key);
    }
  }
}

function maybeCleanupModerationState(now) {
  const ts = now ?? Date.now();
  if (ts - lastCleanupAt < WINDOW_MS) return;
  cleanupModerationState(ts);
  lastCleanupAt = ts;
}

/**
 * Check if a peer is sending messages too fast (spam burst detection).
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 * @returns {boolean} true if the message should be considered spam
 */
export function checkSpam(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  const ts = now ?? Date.now();
  maybeCleanupModerationState(ts);

  let window = spamTracker.get(key);
  if (!window) {
    window = [];
    spamTracker.set(key, window);
  }

  // Slide the window — remove timestamps older than WINDOW_MS
  const cutoff = ts - WINDOW_MS;
  while (window.length > 0 && window[0] <= cutoff) {
    window.shift();
  }

  // Record this message
  window.push(ts);

  return window.length > MAX_MSGS_PER_WINDOW;
}

/**
 * Check message text for abusive language.
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string }}
 */
export function checkAbuse(text) {
  if (!text) return { flagged: false, reason: "" };
  for (const pattern of ABUSE_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, reason: "abusive language" };
    }
  }
  return { flagged: false, reason: "" };
}

/**
 * Check message text for NSFW content.
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string }}
 */
export function checkNSFW(text) {
  if (!text) return { flagged: false, reason: "" };
  for (const pattern of NSFW_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, reason: "NSFW content" };
    }
  }
  return { flagged: false, reason: "" };
}

/**
 * Check if the message contains any adult domain links.
 * @param {string} text
 * @returns {{ flagged: boolean, domain: string }}
 */
export function checkAdultDomains(text) {
  if (!text) return { flagged: false, domain: "" };

  const domains = getAdultDomains();
  let match;
  // Reset lastIndex for global regex
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    const domain = match[1]?.toLowerCase();
    if (!domain) continue;

    for (const candidate of getDomainSuffixes(domain)) {
      if (domains.has(candidate)) {
        return { flagged: true, domain: candidate };
      }
    }
  }
  return { flagged: false, domain: "" };
}

/**
 * Check message text for content violations without changing moderation state.
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string }}
 */
export function checkContent(text) {
  const abuse = checkAbuse(text);
  if (abuse.flagged) return abuse;

  const nsfw = checkNSFW(text);
  if (nsfw.flagged) return nsfw;

  const adultDomain = checkAdultDomains(text);
  if (adultDomain.flagged) {
    return { flagged: true, reason: `adult domain link (${adultDomain.domain})` };
  }

  return { flagged: false, reason: "" };
}


/**
 * Record a violation for a peer in a room. Returns the escalation action.
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 * @returns {'warn' | 'final-warn' | 'kick'}
 */
export function recordViolation(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  const ts = now ?? Date.now();
  maybeCleanupModerationState(ts);

  const count = (violationTracker.get(key) || 0) + 1;
  violationTracker.set(key, count);
  violationTouchedAt.set(key, ts);

  if (count >= KICK_THRESHOLD) return "kick";
  if (count >= KICK_THRESHOLD - 1) return "final-warn";
  return "warn";
}

/**
 * Get the current violation count for a peer in a room.
 * @param {string} peerId
 * @param {string} roomKey
 * @returns {number}
 */
export function getViolations(peerId, roomKey) {
  return violationTracker.get(peerRoomKey(peerId, roomKey)) || 0;
}

/**
 * Reset violations for a peer in a room.
 * @param {string} peerId
 * @param {string} roomKey
 */
export function resetViolations(peerId, roomKey) {
  const key = peerRoomKey(peerId, roomKey);
  violationTracker.delete(key);
  violationTouchedAt.delete(key);
}

/**
 * Check if a peer is currently kicked from a room (within cooldown).
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 * @returns {boolean}
 */
export function isKicked(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  maybeCleanupModerationState(now);
  const kickedAt = kickList.get(key);
  if (kickedAt == null) return false;

  const ts = now ?? Date.now();
  if (ts - kickedAt >= ROOM_REJOIN_COOLDOWN_MS) {
    // Cooldown expired — remove from kick list
    kickList.delete(key);
    return false;
  }
  return true;
}

/**
 * Get the active room block timing for a peer, if any.
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 * @returns {{ kickedAt: number, blockedUntil: number, remainingMs: number } | null}
 */
export function getKickStatus(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  maybeCleanupModerationState(now);
  const kickedAt = kickList.get(key);
  if (kickedAt == null) return null;

  const ts = now ?? Date.now();
  const blockedUntil = kickedAt + ROOM_REJOIN_COOLDOWN_MS;
  const remainingMs = Math.max(0, blockedUntil - ts);
  if (remainingMs <= 0) {
    kickList.delete(key);
    return null;
  }
  return { kickedAt, blockedUntil, remainingMs };
}

/**
 * Add a peer to the kick list for a room.
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 */
export function addKick(peerId, roomKey, now) {
  const ts = now ?? Date.now();
  maybeCleanupModerationState(ts);
  kickList.set(peerRoomKey(peerId, roomKey), ts);
}

// ---------------------------------------------------------------------------
// Orchestrator — single entry point for message checks
// ---------------------------------------------------------------------------

/**
 * Run all moderation checks against a message.
 * @param {string} peerId  – sender's peer ID
 * @param {string} roomKey – room the message is in
 * @param {string} text    – plaintext message content
 * @param {number} [now]   – optional timestamp override (for testing)
 * @param {{ checkSpam?: boolean, trackViolations?: boolean, allowKick?: boolean }} [options]
 * @returns {{ allowed: boolean, reason: string, action: 'none' | 'warn' | 'final-warn' | 'kick', blockedUntil?: number, remainingMs?: number }}
 */
export function checkMessage(peerId, roomKey, text, now, options = {}) {
  const shouldCheckSpam = options.checkSpam !== false;
  const shouldTrackViolations = options.trackViolations !== false;
  const shouldAllowKick = options.allowKick !== false;
  const ts = now ?? Date.now();
  maybeCleanupModerationState(ts);

  const violationAction = () => {
    if (!shouldTrackViolations) return "warn";
    const action = recordViolation(peerId, roomKey, ts);
    return action === "kick" && !shouldAllowKick ? "final-warn" : action;
  };

  const blockedResult = (reason, action) => {
    if (action === "kick" && shouldAllowKick) {
      addKick(peerId, roomKey, ts);
      return { allowed: false, reason, action, ...getKickStatus(peerId, roomKey, ts) };
    }
    return { allowed: false, reason, action };
  };

  // 1. Is the peer currently kicked?
  const kickStatus = shouldAllowKick ? getKickStatus(peerId, roomKey, ts) : null;
  if (kickStatus) {
    return { allowed: false, reason: "temporarily blocked from this room", action: "kick", ...kickStatus };
  }

  // 2. Spam check
  if (shouldCheckSpam && checkSpam(peerId, roomKey, ts)) {
    return blockedResult("spam (too many messages)", violationAction());
  }

  // 3. Abuse check
  const content = checkContent(text);
  if (content.flagged) {
    return blockedResult(content.reason, violationAction());
  }

  return { allowed: true, reason: "", action: "none" };
}

// ---------------------------------------------------------------------------
// Reset all state (for testing)
// ---------------------------------------------------------------------------

/**
 * Clear all moderation state. Intended for tests only.
 */
export function resetAll() {
  spamTracker.clear();
  violationTracker.clear();
  violationTouchedAt.clear();
  kickList.clear();
  lastCleanupAt = 0;
  _adultDomains = null;
}
