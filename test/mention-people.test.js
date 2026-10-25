// @ in a direct chat offered your own devices and could leave out the person
// the chat is with: it went by the chat's member list, which can hold your
// other devices and miss theirs. A direct chat now offers that person's
// devices only, and no room offers yours.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const source = (name) => {
  const start = app.indexOf(`function ${name}(`);
  return app.slice(start, app.indexOf("\n}\n", start) + 2);
};

function mentionPeopleWith(S) {
  const context = { S };
  vm.createContext(context);
  vm.runInContext(["peerIdEq", "isOwnId", "mentionPeople"].map(source).join("\n"), context);
  // Out of the page's own realm, so its arrays compare as plain ones here.
  return (room) => Array.from(context.mentionPeople(room), (m) => m.username);
}

const ANA = "ab".repeat(32);
const S = {
  profile: { id: "aaaa1111", siblings: ["aaaa2222"] },
  peerProfiles: {
    bbbb1111: { username: "Test Ana", person: ANA },
    bbbb2222: { username: "Test Ana@desktop", person: ANA },
    cccc1111: { username: "Test Stranger" },
  },
};

describe("who @ offers", () => {
  it("in a direct chat, the other person's devices only, with the person it is with first", () => {
    const people = mentionPeopleWith(S)({
      isDM: true,
      dmWith: "bbbb1111",
      name: "Test Ana",
      members: {
        aaaa2222: { username: "Test Cai@desktop" },
        bbbb2222: { username: "Test Ana@desktop" },
        cccc1111: { username: "Test Stranger" },
      },
    });
    assert.deepEqual(people, ["Test Ana", "Test Ana@desktop"]);
  });

  it("in a chat with your own devices, nobody", () => {
    const people = mentionPeopleWith(S)({ isDM: true, dmWith: "aaaa2222", members: { aaaa2222: { username: "Test Cai@desktop" } } });
    assert.deepEqual(people, []);
  });

  it("in a group, everyone but you and your other devices", () => {
    const people = mentionPeopleWith(S)({
      members: {
        aaaa1111: { username: "Test Cai" },
        aaaa2222: { username: "Test Cai@desktop" },
        cccc1111: { username: "Test Stranger" },
        bbbb1111: { username: "Test Ana" },
      },
    });
    assert.deepEqual(people.sort(), ["Test Ana", "Test Stranger"]);
  });

  it("keeps a person's key when their profile changes while the page is open", () => {
    assert.match(app, /S\.peerProfiles\[peerId\] = \{ \.\.\.S\.peerProfiles\[peerId\], username, bio, avatar: peerAvatar, updatedAt: Date\.now\(\) \};/);
    assert.match(app, /const candidates = mentionPeople\(room\)/);
  });
});
