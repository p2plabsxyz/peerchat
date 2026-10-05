import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createQrMatrix } from "../lib/qrcode-matrix.js";
import { buildDirectInviteUrl } from "../lib/invite.js";
import { buildDirectory, collapseMembers } from "../lib/members.js";

const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

describe("find people", () => {
  it("draws a real QR code for a personal invite", () => {
    const url = buildDirectInviteUrl("a1b2c3d4");
    const matrix = createQrMatrix(url, "M");

    assert.ok(matrix.length >= 21, "a QR code is at least 21 modules a side");
    assert.ok(matrix.every((row) => row.length === matrix.length), "it has to be square");
    // Finder pattern: the top left corner is a filled 7x7 block with a ring.
    assert.equal(matrix[0].slice(0, 7).every(Boolean), true);
    assert.equal(matrix[1][1], false);
  });

  it("offers your own code, and says what scanning it does", () => {
    assert.match(html, /id="discover-btn"/);
    assert.match(html, /id="discover-qr"/);
    assert.match(app, /buildDirectInviteUrl\(S\.profile\?\.id \|\| ""\)/);
    // It is a request, not a way in, and the window says so.
    assert.match(html, /sends you a message request/);
    assert.match(html, /nothing happens until you say so/);
    assert.match(html, /No directory is kept anywhere/);
  });

  it("searches the welcome room's own member list", () => {
    const directory = app.slice(app.indexOf("function discoverDirectory("), app.indexOf("function renderDiscoverList("));

    assert.match(directory, /S\.rooms\[PRE_JOINED_ROOM_KEY\]/);
    // Same rules as the member list, from the same helper, so the two cannot
    // drift apart again.
    assert.match(directory, /buildDirectory\(\{/);
    assert.match(directory, /selfId: S\.profile\?\.id/);
    assert.match(directory, /bans: room\?\.bans/);
    const memberList = app.slice(app.indexOf("const renderMemberList = "), app.indexOf("const countEl = "));
    assert.match(memberList, /collapseMembers\(rows\)/);
  });

  it("lists nobody until a name is typed", () => {
    const list = app.slice(app.indexOf("function renderDiscoverList("), app.indexOf('$("discover-btn")'));
    assert.match(list, /if \(!query\) return;/);
    assert.ok(list.indexOf("if (!query) return;") < list.indexOf("discoverDirectory(query)"));
    assert.match(html, /Type a name to find someone in Peer-to-Peer Republic/);
  });

  it("shows one row per person, not one per device", () => {
    // The same name from two devices is one person. Whichever is online is the
    // one worth offering, because that is the one who can be reached.
    const found = buildDirectory({
      members: {
        aaaaaaaa: { username: "Akhilesh" },
        bbbbbbbb: { username: "Akhilesh" },
        cccccccc: { username: "Akhilesh T" },
      },
      onlinePeers: new Set(["bbbbbbbb"]),
    });

    assert.deepEqual(found.map((person) => person.id), ["bbbbbbbb", "cccccccc"]);
  });

  it("leaves out you, and anyone the creator removed", () => {
    const found = buildDirectory({
      members: {
        aaaaaaaa: { username: "Me" },
        bbbbbbbb: { username: "Removed" },
        cccccccc: { username: "Still here" },
      },
      bans: [{ id: "bbbbbbbb" }],
      selfId: "aaaaaaaa",
    });

    assert.deepEqual(found.map((person) => person.username), ["Still here"]);
  });

  it("searches by name, and puts whoever is online first", () => {
    const members = {
      aaaaaaaa: { username: "Akhilesh" },
      bbbbbbbb: { username: "Steve" },
      cccccccc: { username: "Akhilesh T" },
    };
    const onlinePeers = new Set(["cccccccc"]);

    assert.deepEqual(
      buildDirectory({ members, onlinePeers }).map((person) => person.username),
      ["Akhilesh T", "Akhilesh", "Steve"],
    );
    assert.deepEqual(
      buildDirectory({ members, onlinePeers, query: " AKHI " }).map((person) => person.username),
      ["Akhilesh T", "Akhilesh"],
    );
    assert.deepEqual(buildDirectory({ members, query: "nobody" }), []);
  });

  it("keeps your own row when somebody else shares your name", () => {
    const collapsed = collapseMembers([
      { id: "bbbbbbbb", username: "Akhilesh", online: true, self: false },
      { id: "aaaaaaaa", username: "Akhilesh", online: false, self: true },
    ]);

    assert.deepEqual(collapsed.map((member) => member.id), ["aaaaaaaa"]);
  });

  it("stays a card on the page rather than becoming the page", () => {
    const content = css.slice(css.indexOf(".modal-content {"), css.indexOf(".modal-content > form"));

    // A full directory plus the QR code ran past the top and bottom of the
    // window, taking the modal's own edges and its Close button with it.
    assert.match(content, /max-height: 86vh/);
    assert.match(content, /overflow-y: auto/);

    // The long list shrinks to whatever the card has left rather than pushing
    // it past the window, so one scrollbar does the job instead of a scrollbar
    // inside a scrollbar.
    const list = css.slice(css.indexOf(".discover-list {"), css.indexOf(".discover-list {") + 320);
    assert.match(list, /flex: 1 1 auto; min-height: 0; overflow-y: auto/);
  });

  it("treats a personal link as a request, not a room to join", () => {
    const take = app.slice(app.indexOf("function takeInviteFromAddress()"), app.indexOf("takeInviteFromAddress();"));
    assert.match(take, /const person = parseDirectInvite\(location\.hash\)/);
    const consume = app.slice(app.indexOf("async function consumeInvite()"), app.indexOf("async function init()"));
    // Handled before the room path, and your own code does nothing.
    assert.ok(consume.indexOf("if (directInvite)") < consume.indexOf("if (!invite) return;"));
    assert.match(consume, /directInvite !== S\.profile\?\.id/);
    assert.match(consume, /openDM\(directInvite, name\)/);
    // The key is still wiped from the address bar either way.
    assert.match(take, /if \(!room && !person\) return false;/);
    assert.match(take, /history\.replaceState/);
  });
});
