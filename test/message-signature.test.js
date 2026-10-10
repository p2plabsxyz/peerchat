// Every message and reaction is signed by whoever wrote it, so it can come
// through anyone and still prove its author.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "hypercore-crypto";

import {
  messageHeader,
  readSignedMessage,
  readSignedReaction,
  signMessage,
  signReaction,
} from "../lib/message-signature.js";

// The same vector is in PeerSky Mobile's test/protocol/peerchat-message-signature.test.mjs.
// If either app changes a byte of what is signed, both of these fail.
const AUTHOR = crypto.keyPair(Buffer.alloc(32, 1));
const TOPIC = "2a1988aeeff0404ef0edef440f2f2e7864f15ff8543b9f7693b69db182bbf653";
const SEALED = { ct: "c0ffee", iv: "00112233445566778899aabb", tag: "0123456789abcdef0123456789abcdef" };
const MESSAGE_SIGNATURE = "162e3146af18d3b84344d3b3fa260fa503c930fe6c8ef86e925817de766bb32d" +
  "54216601a0410c39c96b69c21a9082e611b3da46fb9b606827dd8c1adf2ce90c";
const REACTION_SIGNATURE = "dcc5a8910e03054aeaecd8c212fce9f4d3bdd404f55cb81a1119ec344d5657ae" +
  "b8338629ffaf74592b76cf0978439e5b9ec0d99a7a4c3596aa0671c4e6d62701";

describe("signed messages", () => {
  it("signs over the same bytes as the phone", () => {
    const message = signMessage({ topic: TOPIC, id: "m1", ts: 1790000000000, e: 497659, sn: "Ada", fwd: false }, SEALED, AUTHOR);
    assert.equal(message.ak, "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c");
    assert.equal(message.h, `{"v":1,"room":"${TOPIC}","id":"m1","ts":1790000000000,"e":497659,"sn":"Ada"}`);
    assert.equal(message.as, MESSAGE_SIGNATURE);

    const reaction = signReaction({ topic: TOPIC, id: "r1", ts: 1790000000001, msgId: "m1", emoji: "\u{1F525}", sn: "Ada" }, AUTHOR);
    assert.equal(reaction.h, `{"v":1,"room":"${TOPIC}","id":"r1","ts":1790000000001,"msgId":"m1","emoji":"\u{1F525}","sn":"Ada"}`);
    assert.equal(reaction.as, REACTION_SIGNATURE);

    // In a room made before keys rotated, the reply and file details sit next
    // to the body, so the header carries them and the signature covers them.
    assert.equal(messageHeader({
      topic: TOPIC, id: "m2", ts: 1790000000002, sn: "Ada",
      replyTo: { id: "m1", sender: "8a88e3dd", sn: "Ada", text: "hi" },
      fileName: "a.png", fileSize: 3, fileEnc: true, fwd: true,
    }), `{"v":1,"room":"${TOPIC}","id":"m2","ts":1790000000002,"sn":"Ada",` +
      '"replyTo":{"id":"m1","sender":"8a88e3dd","sn":"Ada","text":"hi"},"fileName":"a.png","fileSize":3,"fileEnc":true,"fwd":true}');
  });

  it("counts a signature that does not fit what arrived for nothing", () => {
    const signed = signMessage({ topic: TOPIC, id: "m1", ts: 1790000000000, e: 497659, sn: "Ada" }, SEALED, AUTHOR);
    const frame = { id: "m1", e: 497659, ...SEALED, ...signed };
    assert.equal(readSignedMessage(frame, TOPIC).authorId, "8a88e3dd");

    assert.equal(readSignedMessage({ ...frame, ct: "c0ffef" }, TOPIC), false);
    assert.equal(readSignedMessage({ ...frame, h: frame.h.replace("Ada", "Eve") }, TOPIC), false);
    assert.equal(readSignedMessage({ ...frame, id: "m9" }, TOPIC), false);
    assert.equal(readSignedMessage({ ...frame, e: 497660 }, TOPIC), false);
    assert.equal(readSignedMessage(frame, "cd".repeat(32)), false);
    assert.equal(readSignedMessage({ ...frame, ak: Buffer.from(crypto.keyPair().publicKey).toString("hex") }, TOPIC), false);
    // Nothing signed at all is what an older build sends.
    assert.equal(readSignedMessage({ id: "m1", ...SEALED }, TOPIC), null);

    const reaction = { id: "r1", ...signReaction({ topic: TOPIC, id: "r1", ts: 1, msgId: "m1", emoji: "x", sn: "Ada" }, AUTHOR) };
    assert.equal(readSignedReaction(reaction, TOPIC).header.emoji, "x");
    assert.equal(readSignedReaction({ ...reaction, h: reaction.h.replace('"x"', '"y"') }, TOPIC), false);
    assert.equal(readSignedReaction({ id: "r1", msgId: "m1", emoji: "x" }, TOPIC), null);
  });
});
