import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { buildInviteUrl, parseInvite, INVITE_BASE } from "../lib/invite.js";

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
