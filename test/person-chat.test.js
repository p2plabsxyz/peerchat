// Someone already chatting with ada pressed Message on ada@mobile and sent a
// second request, to the same person, instead of opening the chat they had.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chatWithPerson } from "../lib/person-chat.js";

const withAda = { roomKey: "a", dmWith: "0a0a0a0a", partnerName: "ada", members: ["0a0a0a0a", "0b0b0b0b", "0c0c0c0c"] };
const withSam = { roomKey: "s", dmWith: "0d0d0d0d", partnerName: "Sam", members: ["0d0d0d0d"] };

describe("messaging someone's other device", () => {
  it("opens the chat that device is already in, with the same person", () => {
    assert.equal(chatWithPerson([withSam, withAda], "0b0b0b0b", "ada@mobile"), withAda);
    assert.equal(chatWithPerson([withAda], "0B0B0B0B", "Ada@desktop2"), withAda);
    // The other way round: a chat with the phone, and its desktop.
    const withPhone = { ...withAda, dmWith: "0b0b0b0b", partnerName: "ada@mobile" };
    assert.equal(chatWithPerson([withPhone], "0a0a0a0a", "ada"), withPhone);
  });

  it("asks as before for a device in no chat, or under someone else's name", () => {
    assert.equal(chatWithPerson([withAda], "0e0e0e0e", "ada@mobile"), null);
    // Your own phone in your chat with ada is not ada's.
    assert.equal(chatWithPerson([withAda], "0c0c0c0c", "grace@mobile"), null);
    // The person themselves is the chat's own, found by who it is with.
    assert.equal(chatWithPerson([withAda], "0a0a0a0a", "ada"), null);
  });

  it("is where the page looks, for a device picked from a list", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const open = app.slice(app.indexOf("async function openDM("), app.indexOf("async function removeRoomMember("));
    assert.match(open, /directRoomWith\(peerId, peerKey\) \|\|\s+\(peerKey \? null : isOwnId\(peerId\) \? chatWithYourself\(\) : chatWithPersonOf\(peerId, peerUsername\)\)/);
    // One chat with yourself, whichever of your devices you press Message on.
    assert.match(app, /function chatWithYourself\(\) \{\s+return Object\.values\(S\.rooms\)\.find\(\(room\) => room\.isDM && room\.dmWith && isOwnId\(room\.dmWith\) && !room\.pendingAcceptance\)/);
    const find = app.slice(app.indexOf("function chatWithPersonOf("), app.indexOf("async function openDM("));
    assert.match(find, /if \(isOwnId\(peerId\)\) return null;/);
    assert.match(find, /!room\.pendingAcceptance && !room\.blockedByPeer && !isOwnId\(room\.dmWith\)/);
  });
});
