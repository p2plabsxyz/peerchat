import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MSGS_PER_WINDOW,
  WINDOW_MS,
  FINAL_WARN_THRESHOLD,
  KICK_THRESHOLD,
  ROOM_REJOIN_COOLDOWN_MS,
  TRACKER_IDLE_TTL_MS,
  checkSpam,
  checkAbuse,
  checkNSFW,
  checkContent,
  checkAdultDomains,
  getAdultDomains,
  initModeration,
  initBadWords,
  getBadWords,
  setBadWords,
  checkMessage,
  recordViolation,
  getViolations,
  resetViolations,
  isKicked,
  getKickStatus,
  addKick,
  cleanupModerationState,
  resetAll,
  setAdultDomains,
} from "../moderation.js";

const TEST_BAD_WORDS = new Set([
  "fuck", "shit", "ass", "bitch", "damn", "bastard", "asshole",
  "dick", "cunt", "whore", "slut", "retard", "retarded", "faggot",
  "nigger", "nigga", "chink", "wetback", "kike", "spic",
  "porn", "porno", "pornography", "xxx", "hentai", "nude",
  "masturbate", "ejaculate", "orgasm", "blowjob", "cumshot",
  "deepthroat", "gangbang", "erotic", "fetish", "hooker",
  "prostitute", "horny", "boobs", "cock", "pussy",
  "wtf", "motherfucker", "dickhead",
]);

const ROOM = "a".repeat(64);
const PEER = "peer1234";

describe("Moderation Engine", () => {
  beforeEach(() => {
    resetAll();
    setBadWords(TEST_BAD_WORDS);
  });

  describe("checkSpam", () => {
    it("should allow messages under the rate limit", () => {
      const now = 1000000;
      for (let i = 0; i < MAX_MSGS_PER_WINDOW - 1; i++) {
        assert.equal(checkSpam(PEER, ROOM, now + i), false);
      }
    });

    it("should flag spam when burst reaches MAX_MSGS_PER_WINDOW", () => {
      const now = 1000000;
      for (let i = 0; i < MAX_MSGS_PER_WINDOW - 1; i++) {
        checkSpam(PEER, ROOM, now + i);
      }
      assert.equal(checkSpam(PEER, ROOM, now + MAX_MSGS_PER_WINDOW - 1), true);
    });

    it("should allow messages after the window slides past", () => {
      const now = 1000000;
      // Fill the window
      for (let i = 0; i < MAX_MSGS_PER_WINDOW; i++) {
        checkSpam(PEER, ROOM, now + i);
      }
      // Wait for window to expire
      const afterWindow = now + WINDOW_MS + 1;
      assert.equal(checkSpam(PEER, ROOM, afterWindow), false);
    });

    it("should track peers independently", () => {
      const now = 1000000;
      for (let i = 0; i < MAX_MSGS_PER_WINDOW; i++) {
        checkSpam("peerA", ROOM, now);
      }
      // peerA is now at the limit - next message is spam
      assert.equal(checkSpam("peerA", ROOM, now), true);
      // peerB should still be fine
      assert.equal(checkSpam("peerB", ROOM, now), false);
    });

    it("should track rooms independently", () => {
      const now = 1000000;
      const room2 = "b".repeat(64);
      for (let i = 0; i < MAX_MSGS_PER_WINDOW; i++) {
        checkSpam(PEER, ROOM, now);
      }
      assert.equal(checkSpam(PEER, ROOM, now), true);
      assert.equal(checkSpam(PEER, room2, now), false);
    });
  });

  describe("checkAbuse", () => {
    it("should flag messages with slurs", () => {
      const result = checkAbuse("you are a retard");
      assert.equal(result.flagged, true);
      assert.equal(result.reason, "abusive language");
    });

    it("should flag common profanity from bad-words list", () => {
      assert.equal(checkAbuse("what the fuck").flagged, true);
      assert.equal(checkAbuse("you bitch").flagged, true);
      assert.equal(checkAbuse("piece of shit").flagged, true);
    });

    it("should flag 'kys' messages", () => {
      const result = checkAbuse("just kys");
      assert.equal(result.flagged, true);
    });

    it("should flag threat messages", () => {
      const result = checkAbuse("go die already");
      assert.equal(result.flagged, true);
    });

    it("should not flag normal messages", () => {
      assert.equal(checkAbuse("hello how are you").flagged, false);
      assert.equal(checkAbuse("great game last night").flagged, false);
    });

    it("should not flag empty messages", () => {
      assert.equal(checkAbuse("").flagged, false);
      assert.equal(checkAbuse(null).flagged, false);
    });
  });

  describe("checkNSFW", () => {
    it("should flag messages with explicit keywords", () => {
      assert.equal(checkNSFW("check out porn").flagged, true);
      assert.equal(checkNSFW("xxx content here").flagged, true);
    });

    it("should flag hentai references", () => {
      assert.equal(checkNSFW("watching hentai").flagged, true);
    });

    it("should not flag normal messages", () => {
      assert.equal(checkNSFW("hello world").flagged, false);
      assert.equal(checkNSFW("this is a great project").flagged, false);
      assert.equal(checkNSFW("let me analyze this data").flagged, false);
    });

    it("should flag nude and explicit terms from bad-words list", () => {
      assert.equal(checkNSFW("send nude").flagged, true);
      assert.equal(checkNSFW("orgasm sounds").flagged, true);
      assert.equal(checkNSFW("erotic stories").flagged, true);
    });
  });

  describe("checkAdultDomains", () => {
    beforeEach(() => {
      // Use a small test set to avoid loading the full file
      setAdultDomains(new Set([
        "pornhub.com", "xvideos.com", "onlyfans.com", "chaturbate.com",
        "xnxx.com", "redtube.com",
      ]));
    });

    it("should flag messages containing adult domain URLs", () => {
      const result = checkAdultDomains("check this out https://pornhub.com/video");
      assert.equal(result.flagged, true);
      assert.equal(result.domain, "pornhub.com");
    });

    it("should flag bare domain mentions", () => {
      const result = checkAdultDomains("go to xvideos.com");
      assert.equal(result.flagged, true);
      assert.equal(result.domain, "xvideos.com");
    });

    it("should flag subdomains of adult domains", () => {
      const result = checkAdultDomains("go to www.pornhub.com");
      assert.equal(result.flagged, true);
      assert.equal(result.domain, "pornhub.com");
    });

    it("should flag deep subdomains of adult domains", () => {
      setAdultDomains(new Set(["adult.example.com"]));
      const result = checkAdultDomains("go to https://assets.media.adult.example.com/video");
      assert.equal(result.flagged, true);
      assert.equal(result.domain, "adult.example.com");
    });

    it("should load the fetched NSFW hosts list", async () => {
      resetAll();
      await initModeration();
      const domains = getAdultDomains();
      assert.ok(domains.size > 1000);
      assert.equal(domains.has("pornhub.com"), true);
    });

    it("should load the bad-words list via initModeration", async () => {
      resetAll();
      await initModeration();
      const words = getBadWords();
      assert.ok(words.size > 500, "bad-words list should have over 500 entries");
      assert.equal(words.has("fuck"), true);
      assert.equal(words.has("shit"), true);
    });

    it("should not flag normal domains", () => {
      assert.equal(checkAdultDomains("visit github.com").flagged, false);
      assert.equal(checkAdultDomains("https://google.com/search").flagged, false);
    });

    it("should not flag empty messages", () => {
      assert.equal(checkAdultDomains("").flagged, false);
      assert.equal(checkAdultDomains(null).flagged, false);
    });
  });

  describe("recordViolation / escalation", () => {
    it("should return 'warn' on first violation", () => {
      const action = recordViolation(PEER, ROOM);
      assert.equal(action, "warn");
      assert.equal(getViolations(PEER, ROOM), 1);
    });

    it("should return 'final-warn' on second violation", () => {
      for (let i = 1; i < FINAL_WARN_THRESHOLD; i++) recordViolation(PEER, ROOM);
      const action = recordViolation(PEER, ROOM);
      assert.equal(action, "final-warn");
      assert.equal(getViolations(PEER, ROOM), FINAL_WARN_THRESHOLD);
    });

    it("should return 'kick' on third violation", () => {
      recordViolation(PEER, ROOM);
      recordViolation(PEER, ROOM);
      const action = recordViolation(PEER, ROOM);
      assert.equal(action, "kick");
      assert.equal(getViolations(PEER, ROOM), KICK_THRESHOLD);
    });

    it("should continue returning 'kick' on subsequent violations", () => {
      for (let i = 0; i < KICK_THRESHOLD; i++) recordViolation(PEER, ROOM);
      const action = recordViolation(PEER, ROOM);
      assert.equal(action, "kick");
    });

    it("should reset violations correctly", () => {
      recordViolation(PEER, ROOM);
      recordViolation(PEER, ROOM);
      resetViolations(PEER, ROOM);
      assert.equal(getViolations(PEER, ROOM), 0);
      assert.equal(recordViolation(PEER, ROOM), "warn");
    });
  });

  describe("isKicked / addKick / cooldown", () => {
    it("should not be kicked by default", () => {
      assert.equal(isKicked(PEER, ROOM), false);
    });

    it("should be kicked after addKick", () => {
      const now = 1000000;
      addKick(PEER, ROOM, now);
      assert.equal(isKicked(PEER, ROOM, now + 1000), true);
    });

    it("should remain kicked during cooldown", () => {
      const now = 1000000;
      addKick(PEER, ROOM, now);
      // Check at half the cooldown period
      assert.equal(isKicked(PEER, ROOM, now + ROOM_REJOIN_COOLDOWN_MS / 2), true);
    });

    it("should not be kicked after cooldown expires", () => {
      const now = 1000000;
      addKick(PEER, ROOM, now);
      assert.equal(isKicked(PEER, ROOM, now + ROOM_REJOIN_COOLDOWN_MS), false);
    });

    it("should not affect other peers", () => {
      const now = 1000000;
      addKick("peerA", ROOM, now);
      assert.equal(isKicked("peerA", ROOM, now + 1000), true);
      assert.equal(isKicked("peerB", ROOM, now + 1000), false);
    });
  });

  describe("checkMessage (orchestrator)", () => {
    beforeEach(() => {
      setAdultDomains(new Set(["pornhub.com", "xvideos.com"]));
    });

    it("should allow clean messages", () => {
      const result = checkMessage(PEER, ROOM, "Hello, how are you?");
      assert.equal(result.allowed, true);
      assert.equal(result.action, "none");
    });

    it("should block abusive messages with warn action", () => {
      const result = checkMessage(PEER, ROOM, "you fuck");
      assert.equal(result.allowed, false);
      assert.equal(result.action, "warn");
      assert.ok(result.reason.includes("abusive"));
    });

    it("should block NSFW messages", () => {
      const result = checkMessage(PEER, ROOM, "check out this porn");
      assert.equal(result.allowed, false);
      assert.ok(!result.allowed);
    });

    it("should block adult domain links", () => {
      const result = checkMessage(PEER, ROOM, "go to https://xvideos.com/latest");
      assert.equal(result.allowed, false);
      // xvideos.com matches NSFW keyword pattern first, which is still correct behavior
      assert.ok(result.reason.length > 0, "should have a reason");
    });

    it("should escalate through warn -> final-warn -> kick", () => {
      const r1 = checkMessage(PEER, ROOM, "you fuck");
      assert.equal(r1.action, "warn");

      const r2 = checkMessage(PEER, ROOM, "go die");
      assert.equal(r2.action, "final-warn");

      const r3 = checkMessage(PEER, ROOM, "kys");
      assert.equal(r3.action, "kick");
    });

    it("should block all messages from a kicked peer", () => {
      for (let i = 0; i < KICK_THRESHOLD; i++) {
        checkMessage(PEER, ROOM, "you fuck");
      }

      const result = checkMessage(PEER, ROOM, "hello nice weather");
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("temporarily blocked"));
      assert.equal(typeof result.remainingMs, "number");
      assert.equal(typeof result.blockedUntil, "number");
    });

    it("should block spam bursts", () => {
      const now = 1000000;
      for (let i = 0; i < MAX_MSGS_PER_WINDOW - 1; i++) {
        const r = checkMessage(PEER, ROOM, "hello", now + i);
        assert.equal(r.allowed, true);
      }
      const result = checkMessage(PEER, ROOM, "one more", now + MAX_MSGS_PER_WINDOW - 1);
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("spam"));
    });

    it("NSFW-triggered kick flow: 3 NSFW violations -> kick + rejoin blocked", () => {
      const now = 1000000;

      const r1 = checkMessage(PEER, ROOM, "porn stuff", now);
      assert.equal(r1.action, "warn");

      const r2 = checkMessage(PEER, ROOM, "hentai content", now + WINDOW_MS + 100);
      assert.equal(r2.action, "final-warn");

      const r3 = checkMessage(PEER, ROOM, "xxx images", now + (WINDOW_MS * 2) + 200);
      assert.equal(r3.action, "kick");
      assert.equal(r3.remainingMs, ROOM_REJOIN_COOLDOWN_MS);
      assert.equal(r3.blockedUntil, now + (WINDOW_MS * 2) + 200 + ROOM_REJOIN_COOLDOWN_MS);

      const afterKick = now + (WINDOW_MS * 2) + 300;
      assert.equal(isKicked(PEER, ROOM, afterKick), true);
      assert.equal(getKickStatus(PEER, ROOM, afterKick).remainingMs, ROOM_REJOIN_COOLDOWN_MS - 100);

      const r4 = checkMessage(PEER, ROOM, "sorry about that", afterKick + 1000);
      assert.equal(r4.allowed, false);
      assert.equal(r4.remainingMs, ROOM_REJOIN_COOLDOWN_MS - 1100);

      const afterCooldown = afterKick + ROOM_REJOIN_COOLDOWN_MS;
      assert.equal(isKicked(PEER, ROOM, afterCooldown), false);
      assert.equal(getViolations(PEER, ROOM), 0);
    });

    it("should support content-only moderation without tracking violations", () => {
      const result = checkContent("go to https://xvideos.com/latest");
      assert.equal(result.flagged, true);
      assert.equal(getViolations(PEER, ROOM), 0);
    });

    it("should avoid kicking the local user when allowKick is false", () => {
      const now = 1000000;

      const r1 = checkMessage(PEER, ROOM, "you fuck", now, {
        allowKick: false,
        checkSpam: false,
      });
      assert.equal(r1.allowed, false);
      assert.equal(r1.action, "warn");

      const r2 = checkMessage(PEER, ROOM, "you fuck", now + 1, {
        allowKick: false,
        checkSpam: false,
      });
      assert.equal(r2.allowed, false);
      assert.equal(r2.action, "final-warn");

      const r3 = checkMessage(PEER, ROOM, "you fuck", now + 2, {
        allowKick: false,
        checkSpam: false,
      });
      assert.equal(r3.allowed, false);
      assert.equal(r3.action, "final-warn");
      assert.equal(r3.blockedUntil, undefined);

      assert.equal(isKicked(PEER, ROOM, now + 3), false);
      assert.equal(checkMessage(PEER, ROOM, "hello", now + 4, {
        allowKick: false,
        checkSpam: false,
      }).allowed, true);
    });

    it("should let moderation bookkeeping be cleaned up after it is stale", () => {
      const now = 1000000;
      assert.equal(checkSpam(PEER, ROOM, now), false);
      recordViolation(PEER, ROOM, now);
      addKick(PEER, ROOM, now);

      cleanupModerationState(now + TRACKER_IDLE_TTL_MS + ROOM_REJOIN_COOLDOWN_MS + 1);

      assert.equal(getViolations(PEER, ROOM), 0);
      assert.equal(isKicked(PEER, ROOM, now + TRACKER_IDLE_TTL_MS + ROOM_REJOIN_COOLDOWN_MS + 1), false);
      assert.equal(checkSpam(PEER, ROOM, now + TRACKER_IDLE_TTL_MS + ROOM_REJOIN_COOLDOWN_MS + 2), false);
    });
  });

  describe("configurable room moderation (roomModeration option)", () => {
    beforeEach(() => {
      setAdultDomains(new Set(["pornhub.com", "xvideos.com"]));
    });

    it("should allow threat-pattern text when abuseFilter is disabled", () => {
      const result = checkMessage(PEER, ROOM, "kys", undefined, {
        checkSpam: false,
        roomModeration: { abuseFilter: false },
      });
      assert.equal(result.allowed, true);
    });

    it("should allow bad-word text when both content filters are disabled", () => {
      const result = checkMessage(PEER, ROOM, "check out this porn", undefined, {
        checkSpam: false,
        roomModeration: { abuseFilter: false, nsfwFilter: false },
      });
      assert.equal(result.allowed, true);
    });

    it("should still block adult domains when both content filters are disabled", () => {
      const result = checkMessage(PEER, ROOM, "go to https://xvideos.com/latest", undefined, {
        checkSpam: false,
        roomModeration: { abuseFilter: false, nsfwFilter: false },
      });
      assert.equal(result.allowed, false);
    });

    it("should trigger spam at 5 messages when spamRateLimit is 5", () => {
      const now = 1000000;
      for (let i = 0; i < 4; i++) {
        const r = checkMessage(PEER, ROOM, "hello", now + i, {
          roomModeration: { spamRateLimit: 5 },
        });
        assert.equal(r.allowed, true);
      }
      const result = checkMessage(PEER, ROOM, "one more", now + 4, {
        roomModeration: { spamRateLimit: 5 },
      });
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("spam"));
    });

    it("should fall back to the default spam limit when spamRateLimit is invalid", () => {
      const now = 1000000;
      for (let i = 0; i < MAX_MSGS_PER_WINDOW - 1; i++) {
        const r = checkMessage(PEER, ROOM, "hello", now + i, {
          roomModeration: { spamRateLimit: -1 },
        });
        assert.equal(r.allowed, true);
      }
      const result = checkMessage(PEER, ROOM, "one more", now + MAX_MSGS_PER_WINDOW - 1, {
        roomModeration: { spamRateLimit: -1 },
      });
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("spam"));
    });

    it("should allow abuse text via checkContent when abuseFilter is off", () => {
      assert.equal(checkContent("kys").flagged, true);
      assert.equal(checkContent("kys", { abuseFilter: false }).flagged, false);
    });

    it("should allow NSFW text via checkContent when both filters are off", () => {
      assert.equal(checkContent("check out this porn").flagged, true);
      assert.equal(checkContent("check out this porn", { abuseFilter: false, nsfwFilter: false }).flagged, false);
    });

    it("should still flag adult domains via checkContent when filters are off", () => {
      assert.equal(checkContent("go to https://pornhub.com", { abuseFilter: false, nsfwFilter: false }).flagged, true);
    });
  });
});
