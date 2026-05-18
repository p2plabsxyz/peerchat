import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_MSGS_PER_WINDOW,
  WINDOW_MS,
  KICK_THRESHOLD,
  ROOM_REJOIN_COOLDOWN_MS,
  TRACKER_IDLE_TTL_MS,
  checkSpam,
  checkAbuse,
  checkNSFW,
  checkContent,
  checkAdultDomains,
  getAdultDomains,
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

const ROOM = "a".repeat(64);
const PEER = "peer1234";

describe("Moderation Engine", () => {
  beforeEach(() => {
    resetAll();
  });

  describe("checkSpam", () => {
    it("should allow messages under the rate limit", () => {
      const now = 1000000;
      for (let i = 0; i < MAX_MSGS_PER_WINDOW; i++) {
        assert.equal(checkSpam(PEER, ROOM, now + i), false);
      }
    });

    it("should flag spam when burst exceeds MAX_MSGS_PER_WINDOW", () => {
      const now = 1000000;
      for (let i = 0; i < MAX_MSGS_PER_WINDOW; i++) {
        checkSpam(PEER, ROOM, now + i);
      }
      // The next message should be flagged as spam
      assert.equal(checkSpam(PEER, ROOM, now + MAX_MSGS_PER_WINDOW), true);
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
      // peerA is now at the limit — next message is spam
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
      assert.equal(checkAbuse("great game last night!").flagged, false);
      assert.equal(checkAbuse("let's kill this bug in the code").flagged, false);
    });

    it("should not flag empty messages", () => {
      assert.equal(checkAbuse("").flagged, false);
      assert.equal(checkAbuse(null).flagged, false);
    });
  });

  describe("checkNSFW", () => {
    it("should flag messages with explicit keywords", () => {
      assert.equal(checkNSFW("check out pornhub").flagged, true);
      assert.equal(checkNSFW("xxx content here").flagged, true);
      assert.equal(checkNSFW("nsfw content ahead").flagged, true);
    });

    it("should flag hentai references", () => {
      assert.equal(checkNSFW("watching hentai").flagged, true);
    });

    it("should not flag normal messages", () => {
      assert.equal(checkNSFW("hello world").flagged, false);
      assert.equal(checkNSFW("this is a great project").flagged, false);
      assert.equal(checkNSFW("let me analyze this data").flagged, false);
    });

    it("should avoid broad sexual false positives", () => {
      assert.equal(checkNSFW("same-sex marriage equality").flagged, false);
      assert.equal(checkNSFW("sexual harassment training").flagged, false);
      assert.equal(checkNSFW("that was a kick ass demo").flagged, false);
      assert.equal(checkNSFW("Dick joined the meeting").flagged, false);
    });

    it("should flag nude singular and explicit sexual context", () => {
      assert.equal(checkNSFW("send nude").flagged, true);
      assert.equal(checkNSFW("want sex").flagged, true);
      assert.equal(checkNSFW("sexual content").flagged, true);
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

    it("should load the fetched NSFW hosts list", () => {
      resetAll();
      const domains = getAdultDomains();
      assert.ok(domains.size > 1000);
      assert.equal(domains.has("pornhub.com"), true);
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
      recordViolation(PEER, ROOM);
      const action = recordViolation(PEER, ROOM);
      assert.equal(action, "final-warn");
      assert.equal(getViolations(PEER, ROOM), 2);
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
      const result = checkMessage(PEER, ROOM, "you retard");
      assert.equal(result.allowed, false);
      assert.equal(result.action, "warn");
      assert.ok(result.reason.includes("abusive"));
    });

    it("should block NSFW messages", () => {
      const result = checkMessage(PEER, ROOM, "check out this pornhub video");
      assert.equal(result.allowed, false);
      // Could be flagged by either NSFW keyword or adult domain — both are valid
      assert.ok(!result.allowed);
    });

    it("should block adult domain links", () => {
      const result = checkMessage(PEER, ROOM, "go to https://xvideos.com/latest");
      assert.equal(result.allowed, false);
      // xvideos.com matches NSFW keyword pattern first, which is still correct behavior
      assert.ok(result.reason.length > 0, "should have a reason");
    });

    it("should escalate through warn -> final-warn -> kick", () => {
      // 1st violation: warn
      const r1 = checkMessage(PEER, ROOM, "you retard");
      assert.equal(r1.action, "warn");

      // 2nd violation: final-warn
      const r2 = checkMessage(PEER, ROOM, "go die");
      assert.equal(r2.action, "final-warn");

      // 3rd violation: kick
      const r3 = checkMessage(PEER, ROOM, "kys loser");
      assert.equal(r3.action, "kick");
    });

    it("should block all messages from a kicked peer", () => {
      // Trigger kick
      for (let i = 0; i < KICK_THRESHOLD; i++) {
        checkMessage(PEER, ROOM, "you retard");
      }

      // Even clean messages should be blocked now
      const result = checkMessage(PEER, ROOM, "hello nice weather");
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("temporarily blocked"));
      assert.equal(typeof result.remainingMs, "number");
      assert.equal(typeof result.blockedUntil, "number");
    });

    it("should block spam bursts", () => {
      const now = 1000000;
      // Send MAX_MSGS_PER_WINDOW clean messages
      for (let i = 0; i < MAX_MSGS_PER_WINDOW; i++) {
        const r = checkMessage(PEER, ROOM, "hello", now + i);
        assert.equal(r.allowed, true);
      }
      // The next one should be flagged as spam
      const result = checkMessage(PEER, ROOM, "one more", now + MAX_MSGS_PER_WINDOW);
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes("spam"));
    });

    it("NSFW-triggered kick flow: 3 NSFW violations -> kick + rejoin blocked", () => {
      const now = 1000000;

      // Space violations apart to avoid spam detection
      // 3 NSFW violations
      const r1 = checkMessage(PEER, ROOM, "nsfw stuff", now);
      assert.equal(r1.action, "warn");

      const r2 = checkMessage(PEER, ROOM, "hentai content", now + WINDOW_MS + 100);
      assert.equal(r2.action, "final-warn");

      const r3 = checkMessage(PEER, ROOM, "xxx images", now + (WINDOW_MS * 2) + 200);
      assert.equal(r3.action, "kick");
      assert.equal(r3.remainingMs, ROOM_REJOIN_COOLDOWN_MS);
      assert.equal(r3.blockedUntil, now + (WINDOW_MS * 2) + 200 + ROOM_REJOIN_COOLDOWN_MS);

      // Peer should be blocked from the room
      const afterKick = now + (WINDOW_MS * 2) + 300;
      assert.equal(isKicked(PEER, ROOM, afterKick), true);
      assert.equal(getKickStatus(PEER, ROOM, afterKick).remainingMs, ROOM_REJOIN_COOLDOWN_MS - 100);

      // Even clean messages should be blocked
      const r4 = checkMessage(PEER, ROOM, "sorry about that", afterKick + 1000);
      assert.equal(r4.allowed, false);
      assert.equal(r4.remainingMs, ROOM_REJOIN_COOLDOWN_MS - 1100);

      // After cooldown, peer should be allowed back with violations reset
      const afterCooldown = afterKick + ROOM_REJOIN_COOLDOWN_MS;
      assert.equal(isKicked(PEER, ROOM, afterCooldown), false);
      assert.equal(getViolations(PEER, ROOM), 0);
    });

    it("should support content-only moderation without tracking violations", () => {
      const result = checkContent("go to https://xvideos.com/latest");
      assert.equal(result.flagged, true);
      assert.equal(getViolations(PEER, ROOM), 0);
    });

    it("should kick the local user after repeated local content violations", () => {
      const now = 1000000;

      const r1 = checkMessage(PEER, ROOM, "you retard", now, {
        allowKick: true,
        checkSpam: false,
      });
      assert.equal(r1.allowed, false);
      assert.equal(r1.action, "warn");

      const r2 = checkMessage(PEER, ROOM, "you retard", now + 1, {
        allowKick: true,
        checkSpam: false,
      });
      assert.equal(r2.allowed, false);
      assert.equal(r2.action, "final-warn");

      const r3 = checkMessage(PEER, ROOM, "you retard", now + 2, {
        allowKick: true,
        checkSpam: false,
      });
      assert.equal(r3.allowed, false);
      assert.equal(r3.action, "kick");
      assert.equal(typeof r3.blockedUntil, "number");

      assert.equal(isKicked(PEER, ROOM, now + 3), true);
      assert.equal(checkMessage(PEER, ROOM, "hello", now + 4, {
        allowKick: true,
        checkSpam: false,
      }).allowed, false);
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
});
