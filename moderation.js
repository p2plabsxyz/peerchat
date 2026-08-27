export const MAX_MSGS_PER_WINDOW = 10;
export const WINDOW_MS = 10_000;
export const WARNING_THRESHOLD = 1;
export const KICK_THRESHOLD = 3;
export const FINAL_WARN_THRESHOLD = KICK_THRESHOLD - 1;
export const ROOM_REJOIN_COOLDOWN_MS = 5 * 60_000;
export const TRACKER_IDLE_TTL_MS = 30 * 60_000;

// peerId:roomKey -> message timestamps
const spamTracker = new Map();

// peerId:roomKey -> violation count
const violationTracker = new Map();

// peerId:roomKey -> last violation timestamp
const violationTouchedAt = new Map();

// peerId:roomKey -> kick timestamp
const kickList = new Map();

let lastCleanupAt = 0;

const THREAT_PATTERNS = [
  /\bkys\b/i,
  /\bkill\s*your\s*self\b/i,
  /\bgo\s*die\b/i,
  /\bshoot\s*up\b/i,
  /\brape\s*(you|u|her|him|them)\b/i,
  /\bi('?ll|m\s*going\s*to)\s*(rape|murder|stalk)\b/i,
  /\bstfu\b/i,
];

let _badWords = new Set();
let _badWordsReady = false;
let _badWordsLoadPromise = null;
const BAD_WORDS_URL = new URL("./lib/bad-words.txt", import.meta.url);

function parseBadWordsList(text) {
  const words = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const word = raw.trim().toLowerCase();
    if (word && /^[a-z0-9'.\-]+$/i.test(word)) {
      words.add(word);
    }
  }
  return words;
}

export async function initBadWords() {
  if (_badWordsReady) return;
  if (_badWordsLoadPromise) return _badWordsLoadPromise;
  _badWordsLoadPromise = (async () => {
    try {
      if (typeof fetch === "function") {
        const res = await fetch(BAD_WORDS_URL.href);
        if (res.ok) {
          _badWords = parseBadWordsList(await res.text());
          return;
        }
      }
    } catch {
    }

    const getBuiltinModule = globalThis.process?.getBuiltinModule;
    if (typeof getBuiltinModule === "function") {
      try {
        const fs = getBuiltinModule("fs");
        const { fileURLToPath } = getBuiltinModule("url");
        const text = await fs.promises.readFile(fileURLToPath(BAD_WORDS_URL), "utf8");
        _badWords = parseBadWordsList(text);
      } catch (err) {
        console.warn("[Moderation] Failed to load bad-words list.", err.message);
      }
    }
  })().finally(() => {
    _badWordsReady = true;
    _badWordsLoadPromise = null;
  });
  return _badWordsLoadPromise;
}

export function getBadWords() {
  return _badWords;
}

export function setBadWords(words) {
  _badWords = words;
  _badWordsReady = true;
}


const URL_RE = /(?:https?:\/\/|hyper:\/\/)?(?:www\.)?([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,})(?:[\/\?#][^\s]*)?/gi;
const HOSTS_LIST_URL = new URL("./lib/adult-domains.hosts", import.meta.url);
const WORD_SPLIT_RE = /[a-z0-9']+/gi;
const LOCALHOST_IP_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1)$/i;
const HOSTS_DOMAIN_RE = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/i;

// Loaded adult-domain blocklist
let _adultDomains = new Set();
let _domainsReady = false;
let _domainsLoadPromise = null;

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
    if (domain.startsWith("www.")) target.add(domain.slice(4));
  }
}

// Load the adult-domain blocklist once at startup.
export async function initModeration() {
  const tasks = [];

  if (!_domainsReady) {
    if (!_domainsLoadPromise) {
      _domainsLoadPromise = (async () => {
        try {
          if (typeof fetch === "function") {
            const res = await fetch(HOSTS_LIST_URL.href);
            if (res.ok) {
              addHostsDomains(_adultDomains, await res.text());
              return;
            }
          }
        } catch {
        }

        const getBuiltinModule = globalThis.process?.getBuiltinModule;
        if (typeof getBuiltinModule === "function") {
          try {
            const fs = getBuiltinModule("fs");
            const { fileURLToPath } = getBuiltinModule("url");
            const hostsText = await fs.promises.readFile(fileURLToPath(HOSTS_LIST_URL), "utf8");
            addHostsDomains(_adultDomains, hostsText);
          } catch (err) {
            console.warn("[Moderation] Failed to load adult domain blocklist. Domain filtering is disabled.", err.message);
          }
        }
      })().finally(() => {
        _domainsReady = true;
        _domainsLoadPromise = null;
      });
    }
    tasks.push(_domainsLoadPromise);
  }

  tasks.push(initBadWords());
  await Promise.all(tasks);
}

export function getAdultDomains() {
  return _adultDomains;
}

export function setAdultDomains(domains) {
  _adultDomains = domains;
  _domainsReady = true;
}

function getDomainSuffixes(domain) {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  const suffixes = [];
  for (let i = 0; i < parts.length - 1; i++) {
    suffixes.push(parts.slice(i).join("."));
  }
  return suffixes;
}

function peerRoomKey(peerId, roomKey) {
  return `${peerId}:${roomKey}`;
}

// Drop stale spam, violation, and kick state.
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
      violationTracker.delete(key);
      violationTouchedAt.delete(key);
    }
  }
}

function maybeCleanupModerationState(now) {
  const ts = now ?? Date.now();
  if (ts - lastCleanupAt < WINDOW_MS) return;
  cleanupModerationState(ts);
  lastCleanupAt = ts;
}

// Return true when a peer hits the spam threshold.
export function checkSpam(peerId, roomKey, now, spamLimit) {
  const key = peerRoomKey(peerId, roomKey);
  const ts = now ?? Date.now();
  maybeCleanupModerationState(ts);
  const limit = (typeof spamLimit === "number" && spamLimit > 0) ? spamLimit : MAX_MSGS_PER_WINDOW;

  let window = spamTracker.get(key);
  if (!window) {
    window = [];
    spamTracker.set(key, window);
  }

  // Slide the window - remove timestamps older than WINDOW_MS
  const cutoff = ts - WINDOW_MS;
  while (window.length > 0 && window[0] <= cutoff) {
    window.shift();
  }

  // Record this message
  window.push(ts);

  return window.length >= limit;
}

// Threats and targeted harassment only. Kept separate from the shared word
// list so the two room toggles can gate different things; checkAbuse still
// covers both for callers that want the combined check.
export function checkThreats(text) {
  if (!text) return { flagged: false, reason: "" };

  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, reason: "abusive language" };
    }
  }
  return { flagged: false, reason: "" };
}

export function checkAbuse(text) {
  if (!text) return { flagged: false, reason: "" };

  const threat = checkThreats(text);
  if (threat.flagged) return threat;

  const words = text.match(WORD_SPLIT_RE);
  if (words) {
    for (const w of words) {
      if (_badWords.has(w.toLowerCase())) {
        return { flagged: true, reason: "abusive language" };
      }
    }
  }
  return { flagged: false, reason: "" };
}

export function checkNSFW(text) {
  if (!text) return { flagged: false, reason: "" };

  const words = text.match(WORD_SPLIT_RE);
  if (words) {
    for (const w of words) {
      if (_badWords.has(w.toLowerCase())) {
        return { flagged: true, reason: "NSFW content" };
      }
    }
  }
  return { flagged: false, reason: "" };
}

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

// Run content filters without changing moderation state.
// roomMod is optional: { abuseFilter, nsfwFilter, spamRateLimit }
export function checkContent(text, roomMod) {
  // The two toggles gate different things. Abuse covers threats and targeted
  // harassment; NSFW covers the shared word list. Both used to scan that list,
  // so turning off either one on its own changed nothing and the room looked
  // like it was ignoring its own settings.
  if (roomMod?.abuseFilter !== false) {
    const threat = checkThreats(text);
    if (threat.flagged) return threat;
  }

  if (roomMod?.nsfwFilter !== false) {
    const nsfw = checkNSFW(text);
    if (nsfw.flagged) return nsfw;
  }

  const adultDomain = checkAdultDomains(text);
  if (adultDomain.flagged) {
    return { flagged: true, reason: `adult domain link (${adultDomain.domain})` };
  }

  return { flagged: false, reason: "" };
}

// Record a violation and return the escalation action.
export function recordViolation(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  const ts = now ?? Date.now();
  maybeCleanupModerationState(ts);

  const count = (violationTracker.get(key) || 0) + 1;
  violationTracker.set(key, count);
  violationTouchedAt.set(key, ts);

  if (count >= KICK_THRESHOLD) return "kick";
  if (count >= FINAL_WARN_THRESHOLD) return "final-warn";
  if (count >= WARNING_THRESHOLD) return "warn";
  return "warn";
}

export function getViolations(peerId, roomKey) {
  return violationTracker.get(peerRoomKey(peerId, roomKey)) || 0;
}

export function resetViolations(peerId, roomKey) {
  const key = peerRoomKey(peerId, roomKey);
  violationTracker.delete(key);
  violationTouchedAt.delete(key);
}

export function isKicked(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  maybeCleanupModerationState(now);
  const kickedAt = kickList.get(key);
  if (kickedAt == null) return false;

  const ts = now ?? Date.now();
  if (ts - kickedAt >= ROOM_REJOIN_COOLDOWN_MS) {
    kickList.delete(key);
    violationTracker.delete(key);
    violationTouchedAt.delete(key);
    return false;
  }
  return true;
}

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
    violationTracker.delete(key);
    violationTouchedAt.delete(key);
    return null;
  }
  return { kickedAt, blockedUntil, remainingMs };
}

export function addKick(peerId, roomKey, now) {
  const ts = now ?? Date.now();
  maybeCleanupModerationState(ts);
  kickList.set(peerRoomKey(peerId, roomKey), ts);
}

// Main moderation check for a message.
export function checkMessage(peerId, roomKey, text, now, options = {}) {
  const shouldCheckSpam = options.checkSpam !== false;
  const shouldTrackViolations = options.trackViolations !== false;
  const shouldAllowKick = options.allowKick !== false;
  const roomMod = options.roomModeration || null;
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

  // Check active kick first.
  const kickStatus = shouldAllowKick ? getKickStatus(peerId, roomKey, ts) : null;
  if (kickStatus) {
    return { allowed: false, reason: "temporarily blocked from this room", action: "kick", ...kickStatus };
  }

  // Then check spam.
  if (shouldCheckSpam && checkSpam(peerId, roomKey, ts, roomMod?.spamRateLimit)) {
    return blockedResult("spam (too many messages)", violationAction());
  }

  // Then check content.
  const content = checkContent(text, roomMod);
  if (content.flagged) {
    return blockedResult(content.reason, violationAction());
  }

  return { allowed: true, reason: "", action: "none" };
}

// Test helper.
export function resetAll() {
  spamTracker.clear();
  violationTracker.clear();
  violationTouchedAt.clear();
  kickList.clear();
  lastCleanupAt = 0;
  _adultDomains = new Set();
  _domainsReady = false;
  _domainsLoadPromise = null;
  _badWords = new Set();
  _badWordsReady = false;
  _badWordsLoadPromise = null;
}
