import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldRerenderMessages } from "../lib/message-sync.js";

// The pane is rebuilt from scratch, so every image in it is thrown away and
// fetched again. Rebuilding when there is nothing new is a picture that blinks
// every two seconds.
describe("shouldRerenderMessages", () => {
  it("leaves a pane alone when it is already showing everything", () => {
    assert.equal(
      shouldRerenderMessages({ freshCount: 12, bufferedCount: 12, domCount: 12 }),
      false,
    );
  });

  // The bug: the raw history carries reactions and empty entries that never
  // reach the pane, so one reaction made the room look permanently behind.
  it("does not mistake reactions in the history for missing messages", () => {
    // Twelve drawn, plus reactions, against a buffer of twelve.
    assert.equal(
      shouldRerenderMessages({ freshCount: 12, bufferedCount: 12, domCount: 12 }),
      false,
    );
  });

  it("rebuilds when a message really did arrive", () => {
    assert.equal(
      shouldRerenderMessages({ freshCount: 13, bufferedCount: 12, domCount: 12 }),
      true,
    );
  });

  it("rebuilds when the pane lost elements it should have", () => {
    assert.equal(
      shouldRerenderMessages({ freshCount: 12, bufferedCount: 12, domCount: 4 }),
      true,
    );
  });

  it("does not fight a search that is showing a subset", () => {
    assert.equal(
      shouldRerenderMessages({ freshCount: 12, bufferedCount: 12, domCount: 2, searching: true }),
      false,
    );
    // Something new still gets through.
    assert.equal(
      shouldRerenderMessages({ freshCount: 13, bufferedCount: 12, domCount: 2, searching: true }),
      true,
    );
  });

  it("leaves an empty room alone", () => {
    assert.equal(
      shouldRerenderMessages({ freshCount: 0, bufferedCount: 0, domCount: 0 }),
      false,
    );
  });
});

// Each rebuild of the pane collapsed every picture and opened it again. Two
// things rebuilt it for nothing whenever a connection came up, and a rebuild
// now keeps the pictures that had loaded.
describe("rebuilding the pane", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

  it("does not rebuild for the reactions in a room's raw history", () => {
    const refresh = app.slice(app.indexOf("async function refreshActiveRoom()"), app.indexOf("async function refreshActiveRoom()") + 1200);
    assert.match(refresh, /fresh\.filter\(chatMessageRenders\)\.length > _existing\.length/);
  });

  it("does not rebuild for a name that did not change", () => {
    assert.match(app, /if \(peerIdEq\(m\.sender, peerId\) && m\.senderName !== username\) \{ m\.senderName = username; changed = true; \}/);
  });

  it("puts loaded pictures back before the scroll is set", () => {
    const render = app.slice(app.indexOf("function renderMessages("), app.indexOf("function mergeWithHistory("));
    assert.ok(render.indexOf("collectLoadedMedia(") < render.indexOf('container.innerHTML = "";'));
    assert.ok(render.indexOf("restoreLoadedMedia(") < render.indexOf("if (scrollToBottom) {"));
    // Each picture says which file it shows, decrypted, off a drive or opened by hand.
    assert.match(app, /el\.removeAttribute\("data-enc-src"\);\s+el\.dataset\.mediaKey = url;/);
    assert.match(app, /if \(!el\.dataset\.mediaKey\) el\.dataset\.mediaKey = el\.getAttribute\("src"\) \|\| "";/);
    assert.match(app, /el\.className = 'msg-file-img';\s+el\.dataset\.mediaKey = url;/);
  });
});

// A chat opened while another one's history was still loading got that
// history, and kept it until a reload: a direct message showing P2P Republic.
// The functions are taken from app.js and run against stand-ins for the page.
describe("the chat open after a load", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const group = "a".repeat(64);
  const dm = "b".repeat(64);

  function load(name, globals) {
    const start = app.search(new RegExp(`(async )?function ${name}\\(`));
    const source = app.slice(start, app.indexOf("\n}\n", start) + 2);
    const names = Object.keys(globals);
    return new Function(...names, `${source}\nreturn ${name};`)(...names.map((key) => globals[key]));
  }

  function page() {
    const elements = new Map();
    return (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", src: "" });
      return elements.get(id);
    };
  }

  it("keeps a chat's history out of the one opened while it loaded", async () => {
    const S = {
      activeRoom: group,
      rooms: { [group]: { name: "P2P Republic" }, [dm]: { name: "Ada" } },
      messages: { [dm]: [{ id: "hi" }] },
    };
    const painted = [];
    const refreshActiveRoom = load("refreshActiveRoom", {
      S,
      $: page(),
      loadRooms: async () => {},
      renderRoomList: () => {},
      avatar: () => "",
      chat: {
        // The person opens the direct message while the group's history loads.
        getHistory: async (roomKey) => {
          S.activeRoom = dm;
          return { messages: roomKey === group ? [{ id: "g1" }, { id: "g2" }] : [] };
        },
      },
      chatMessageRenders: () => true,
      extractReactions: (_roomKey, list) => list,
      mergeWithHistory: (kept, fresh) => [...kept, ...fresh.filter((m) => !kept.some((k) => k.id === m.id))],
      renderMessages: (roomKey) => { if (roomKey === S.activeRoom) painted.push(roomKey); },
      updateRoomPeerCount: () => {},
    });

    await refreshActiveRoom();
    assert.deepEqual(S.messages[dm].map((m) => m.id), ["hi"]);
    assert.deepEqual(S.messages[group].map((m) => m.id), ["g1", "g2"]);
    assert.deepEqual(painted, []);
  });

  it("does not put one chat's name and picture on another", async () => {
    const S = { activeRoom: group, rooms: {} };
    const $ = page();
    $("chat-room-name").textContent = "Ada";
    let tick = null;
    const refreshRoomHeader = load("refreshRoomHeader", {
      S,
      $,
      setInterval: (callback) => { tick = callback; return 1; },
      clearInterval: () => {},
      // The group's name arrives after the direct message was opened.
      loadRooms: async () => {
        S.rooms[group] = { name: "P2P Republic", avatar: "republic.png" };
        S.activeRoom = dm;
      },
      renderRoomList: () => {},
      avatar: (name) => `picture of ${name}`,
    });

    refreshRoomHeader(group);
    await tick();
    assert.equal($("chat-room-name").textContent, "Ada");
    assert.equal($("chat-room-avatar").src, "");
  });
});
