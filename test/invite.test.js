import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  buildDirectInviteUrl,
  buildInviteUrl,
  parseDirectInvite,
  parseInvite,
  INVITE_BASE,
} from "../lib/invite.js";

const roomKey = () => randomBytes(32).toString("hex");

describe("invite links", () => {
  it("builds a peersky:// link that round-trips", () => {
    const key = roomKey();
    const url = buildInviteUrl(key);
    assert.ok(url.startsWith(INVITE_BASE), url);
    assert.equal(parseInvite(url), key);
  });

  // The key rides in the fragment so it is never part of a resource path.
  it("keeps the key in the fragment", () => {
    const key = roomKey();
    assert.equal(buildInviteUrl(key), `${INVITE_BASE}#room=${key}`);
  });

  it("accepts a bare fragment or query, as pasted", () => {
    const key = roomKey();
    assert.equal(parseInvite(`#room=${key}`), key);
    assert.equal(parseInvite(`?room=${key}`), key);
    assert.equal(parseInvite(`${INVITE_BASE}?room=${key}`), key);
  });

  it("normalises case so the key matches stored rooms", () => {
    const key = roomKey();
    assert.equal(parseInvite(`#room=${key.toUpperCase()}`), key);
    assert.equal(buildInviteUrl(key.toUpperCase()), `${INVITE_BASE}#room=${key}`);
  });

  it("refuses anything that is not a 64-hex room key", () => {
    for (const bad of ["", "#room=", "#room=nope", `#room=${"a".repeat(63)}`,
                       `#room=${"a".repeat(65)}`, `#room=${"g".repeat(64)}`, INVITE_BASE]) {
      assert.equal(parseInvite(bad), "", `should reject: ${bad}`);
    }
    for (const bad of [null, undefined, 42, "", "short"]) {
      assert.equal(buildInviteUrl(bad), "", `should not build from: ${bad}`);
    }
  });

  it("ignores other params in the fragment", () => {
    const key = roomKey();
    assert.equal(parseInvite(`#room=${key}&from=bob`), key);
    assert.equal(parseInvite(`#other=1`), "");
  });
});

// A personal invite says who to ask, not how to get in. The person on the other
// end still accepts, declines or blocks, which is what makes it safe to put on
// a screen for a stranger to scan.
describe("personal invite links", () => {
  const PEER = "a1b2c3d4";
  const ROOM = "ab".repeat(32);

  it("round-trips", () => {
    const url = buildDirectInviteUrl(PEER);
    assert.equal(url, `peersky://p2p/peerchat/#dm=${PEER}`);
    assert.equal(parseDirectInvite(url), PEER);
    assert.equal(parseDirectInvite(`#dm=${PEER.toUpperCase()}`), PEER);
    assert.equal(parseDirectInvite(PEER), PEER);
  });

  it("takes only an 8 character peer id", () => {
    for (const bad of ["nothex!!", ROOM, "", null]) {
      assert.equal(buildDirectInviteUrl(bad), "");
    }
    assert.equal(parseDirectInvite("#dm=nothex!!"), "");
    assert.equal(parseDirectInvite(""), "");
  });

  // A room key is a capability and a peer id is not, so neither may be read as
  // the other.
  it("keeps rooms and people apart", () => {
    assert.equal(parseDirectInvite(buildInviteUrl(ROOM)), "");
    assert.equal(parseInvite(buildDirectInviteUrl(PEER)), "");
  });
});
