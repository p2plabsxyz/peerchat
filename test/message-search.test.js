// Searching messages from the chat list: what is looked for and how a result
// reads (lib/message-search.js), the backend's search over every chat's
// history (search-messages in p2p.js), and the page that shows it.
//
// The backend runs as a desktop with its own copy of p2p.js (see desktops.mjs),
// its rooms' logs in memory. A test client connected to it in one room checks
// that a search sends nothing to anyone.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import b4a from "b4a";
import crypto from "hypercore-crypto";

import { attachChatTransport } from "../transport.js";
import { roomRotates } from "../lib/key-chain.js";
import { encodeMessagePayload } from "../lib/link-preview.js";
import {
  findMatch,
  newestHits,
  queryMatcher,
  roomMatchesQuery,
  SEARCH_QUERY_MAX,
  SEARCH_RESULT_LIMIT,
  SEARCH_SCAN_PER_ROOM,
  searchableText,
  searchHit,
  searchQuery,
  searchTimeLabel,
  snippetAround,
} from "../lib/message-search.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";
import { chatCaller, loadDesktop, memoryStore, writeChatFile } from "./desktops.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const app = read("app.js");
const html = read("index.html");
const styles = read("styles.css");

const DRIVE = "hyper://" + "a".repeat(52) + "/";
const SEALED = DRIVE + "1760000000000-0123456789abcdef.bin";
const NOON = new Date(2026, 9, 13, 12, 0).getTime();

describe("what a search looks for", () => {
  it("takes what was typed, trimmed and cut at a hundred characters", () => {
    assert.equal(searchQuery("  chapter four  "), "chapter four");
    assert.equal(searchQuery("x".repeat(150)).length, SEARCH_QUERY_MAX);
    assert.equal(searchQuery("   "), "");
    assert.equal(searchQuery(undefined), "");
    assert.equal(queryMatcher(""), null);
  });

  it("finds words whatever their case, and reads every character as typed", () => {
    const text = "Chapter Four is done (finally) for $5?";
    assert.deepEqual(findMatch(text, queryMatcher("chapter four")), { start: 0, end: 12 });
    assert.deepEqual(findMatch(text, queryMatcher("(FINALLY)")), { start: 21, end: 30 });
    assert.deepEqual(findMatch(text, queryMatcher("$5?")), { start: 35, end: 38 });
    assert.equal(findMatch(text, queryMatcher("chapter five")), null);
    assert.equal(findMatch("", queryMatcher("a")), null);
  });

  it("finds a file by its name, never by the address it is kept at", () => {
    const picture = { id: "p", message: SEALED, fileName: "beach-day.jpg", fileEnc: true };
    assert.equal(searchableText(picture), "beach-day.jpg");
    assert.equal(searchHit(picture, queryMatcher("hyper")), null);
    assert.equal(searchHit(picture, queryMatcher("0123456789abcdef")), null);
    assert.equal(searchHit(picture, queryMatcher("beach")).fileName, "beach-day.jpg");
    // A link somebody pasted is words, and is found as written.
    assert.equal(searchableText({ message: DRIVE + "index.html" }), DRIVE + "index.html");
    assert.equal(searchableText({ type: "system", text: "Test Bea joined" }), "");
    assert.equal(searchableText({ type: "reaction", emoji: "👍" }), "");
    assert.equal(searchableText(null), "");
  });

  it("shows the words around a match on one line, cut short at either end", () => {
    const text = "We met on Sunday at the library and talked\nabout chapter four for an hour, then everyone went home happy and full of snacks, with plans for the next meeting and the book after that";
    const match = findMatch(text, queryMatcher("chapter four"));
    const snippet = snippetAround(text, match);
    assert.equal(snippet.match, "chapter four");
    assert.ok(snippet.before.startsWith("…"));
    assert.ok(snippet.before.endsWith("talked about "), snippet.before);
    assert.ok(snippet.before.length <= 26);
    assert.ok(snippet.after.endsWith("…"));
    assert.doesNotMatch(snippet.before + snippet.after, /\n/);
    // Short enough to show whole.
    assert.deepEqual(snippetAround("see chapter four", findMatch("see chapter four", queryMatcher("four"))), {
      before: "see chapter ", match: "four", after: "",
    });
  });

  it("finds a chat by its name, and by its key only once enough of it is typed", () => {
    const room = { roomKey: "0f".repeat(32), name: "Book Club" };
    assert.ok(roomMatchesQuery(room, "book"));
    assert.ok(roomMatchesQuery(room, "CLUB"));
    assert.equal(roomMatchesQuery(room, "f"), false);
    assert.equal(roomMatchesQuery(room, "0f0f"), false);
    assert.ok(roomMatchesQuery(room, "0f0f0f0f"));
    assert.equal(roomMatchesQuery(room, ""), false);
  });

  it("keeps the newest matches, each once", () => {
    const hits = [
      { roomKey: "r1", id: "a", timestamp: 1 },
      { roomKey: "r1", id: "b", timestamp: 3 },
      { roomKey: "r2", id: "a", timestamp: 2 },
      { roomKey: "r1", id: "b", timestamp: 3 },
      { roomKey: "r1", id: "", timestamp: 9 },
    ];
    assert.deepEqual(newestHits(hits).map((hit) => `${hit.roomKey}:${hit.id}`), ["r1:b", "r2:a", "r1:a"]);
    assert.equal(newestHits(hits, 1).length, 1);
  });

  it("says when a message was sent: a time today, Yesterday, a weekday, then a date", () => {
    assert.match(searchTimeLabel(NOON - 60_000, NOON), /\d/);
    assert.doesNotMatch(searchTimeLabel(NOON - 60_000, NOON), /Yesterday/);
    assert.equal(searchTimeLabel(NOON - 86_400_000, NOON), "Yesterday");
    const weekday = searchTimeLabel(NOON - 3 * 86_400_000, NOON);
    assert.equal(weekday, new Date(NOON - 3 * 86_400_000).toLocaleDateString([], { weekday: "long" }));
    assert.match(searchTimeLabel(NOON - 40 * 86_400_000, NOON), /\d/);
    assert.equal(searchTimeLabel(0, NOON), "");
  });
});

// A room key whose messages are sealed with the key itself, as in a room made
// before keys rotated, so its log can be written before the desktop starts.
function plainRoomKey(seed) {
  for (let i = 0; ; i++) {
    const key = createHash("sha256").update(`${seed}:${i}`).digest("hex");
    if (!roomRotates(key)) return key;
  }
}

const OTHER = "ce11ce11";
const BOOKS = plainRoomKey("books");
const LATE = plainRoomKey("late");
const BEFORE = plainRoomKey("moved-from");
const AFTER = plainRoomKey("moved-to");
const BIG = plainRoomKey("big");
const NOW = Date.now();
const JOINED = NOW - 3_600_000;

function room(roomKey, name, extra = {}) {
  return {
    roomKey, name, bio: "", link: "", avatar: null, isHost: false,
    createdAt: NOW - 86_400_000, joinedAt: NOW - 86_400_000,
    createdBy: OTHER, createdByName: "Test Cal", creatorKey: "",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [], ...extra,
  };
}

describe("searching every chat from the chat list", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "peerchat-search-"));
  const keyPair = crypto.keyPair();
  const myId = b4a.toString(keyPair.publicKey, "hex").slice(0, 8);
  const swarm = new EventEmitter();
  swarm.flush = async () => {};
  const logs = new Map();
  const sdk = { publicKey: keyPair.publicKey, swarm, corestore: memoryStore(logs, keyPair), join() {}, leave: async () => {} };
  const links = [];
  let mod;
  let call;
  let sent = {};

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const eventually = async (check, what) => {
    for (let i = 0; i < 200; i++) {
      const value = await check();
      if (value) return value;
      await sleep(25);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const search = (q) => call("search-messages", "POST", { q });
  const lastOf = async (roomKey) => (await call("get-rooms", "GET")).rooms.find((r) => r.roomKey === roomKey)?.lastMessage;

  // A message as the log keeps it, sealed with the room's key.
  function entry(roomKey, text, ts, extra = {}) {
    const { ct, iv, tag } = mod.encryptMsg(encodeMessagePayload(text), roomKey, ts);
    return { id: randomBytes(16).toString("hex"), sender: OTHER, sn: "Test Cal", ct, iv, tag, ts, ...extra };
  }
  const log = (roomKey) => {
    if (!logs.has(`chat-${roomKey}`)) logs.set(`chat-${roomKey}`, []);
    return logs.get(`chat-${roomKey}`);
  };

  before(async () => {
    mod = await loadDesktop("message-search");
    call = chatCaller(mod, sdk);

    // Logs written before the desktop starts, as a desktop that ran before
    // has them.
    const picture = entry(BOOKS, SEALED, NOW - 50_000, { fileName: "beach-day.jpg", fileSize: 2048, fileEnc: true });
    log(BOOKS).push(entry(BOOKS, "Chapter four is done", NOW - 60_000), picture);
    log(LATE).push(entry(LATE, "chapter four from before I joined", JOINED - 60_000), entry(LATE, "Chapter four, after I came in", JOINED + 60_000));
    log(BEFORE).push(entry(BEFORE, "chapter four in the old room", NOW - 120_000));
    // More than one search reads of a chat: the oldest are past its newest.
    log(BIG).push(...Array.from({ length: SEARCH_SCAN_PER_ROOM + 20 }, (_, i) =>
      entry(BIG, i < 20 ? `ancient note ${i}` : `note ${i}`, NOW - 7_200_000 + i)));

    writeChatFile(path.join(dir, "chat.json"), "Test Bea", {
      // Its last message kept as the picture's address, as before file names.
      [BOOKS]: room(BOOKS, "Book club", { lastMessage: { sender: OTHER, senderName: "Test Cal", message: SEALED, timestamp: picture.ts } }),
      [LATE]: room(LATE, "Late room", { joinedAt: JOINED }),
      [BEFORE]: room(BEFORE, "Club two", { movedTo: { to: AFTER } }),
      [AFTER]: room(AFTER, "Club two", { movedFrom: BEFORE }),
      [BIG]: room(BIG, "Big room"),
    });
    mod.initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair });
    await eventually(async () => {
      const { rooms } = await call("get-rooms", "GET");
      return rooms.length === 4;
    }, "the rooms to load");
  });

  after(async () => {
    for (const pair of links) await pair.close().catch(() => {});
    await sleep(2_500);
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds messages in every chat, newest first, with the chat, sender, words and time", async () => {
    const club = (await call("create-key", "POST", { name: "Reading circle" })).roomKey;
    await call("join", "POST", {}, club);
    sent = {
      text: (await call("send", "POST", { message: "Who has chapter four? Bring it on Sunday" }, club)).sent,
    };
    const { query, results } = await search("  CHAPTER four ");
    assert.equal(query, "CHAPTER four");
    assert.deepEqual(results.map((hit) => hit.roomKey), [club, BOOKS, AFTER, LATE]);
    const [newest] = results;
    assert.equal(newest.id, sent.text.id);
    assert.equal(newest.sender, myId);
    assert.equal(newest.senderName, "Test Bea");
    assert.equal(newest.timestamp, sent.text.timestamp);
    assert.deepEqual(newest.snippet, { before: "Who has ", match: "chapter four", after: "? Bring it on Sunday" });
    for (let i = 1; i < results.length; i++) assert.ok(results[i - 1].timestamp >= results[i].timestamp);
  });

  it("finds a picture by its name, and nothing by the address it is kept at", async () => {
    const { results } = await search("beach");
    assert.equal(results.length, 1);
    assert.equal(results[0].roomKey, BOOKS);
    assert.equal(results[0].fileName, "beach-day.jpg");
    assert.equal(results[0].snippet.match, "beach");
    assert.deepEqual((await search("hyper")).results, []);
    assert.deepEqual((await search("0123456789abcdef")).results, []);
    assert.deepEqual((await search("   ")).results, []);
  });

  it("leaves out what came before this device joined, as the chat does", async () => {
    const found = (await search("chapter four")).results.filter((hit) => hit.roomKey === LATE);
    assert.equal(found.length, 1);
    assert.equal(found[0].snippet.match, "Chapter four");
    assert.ok(found[0].timestamp > JOINED);
  });

  it("finds a moved room's messages from before the move under the room it went to", async () => {
    const found = (await search("old room")).results;
    assert.equal(found.length, 1);
    assert.equal(found[0].roomKey, AFTER);
  });

  it("reads each chat's newest entries and gives back the newest fifty matches", async () => {
    const { results } = await search("note");
    assert.equal(results.length, SEARCH_RESULT_LIMIT);
    assert.equal(results[0].snippet.match, "note");
    assert.match(results[0].snippet.after, new RegExp(` ${SEARCH_SCAN_PER_ROOM + 19}$`));
    assert.deepEqual((await search("ancient")).results, []);
  });

  it("sends nothing to anyone while it searches", async () => {
    const peer = crypto.keyPair();
    const pair = await securePair({ clientKeyPair: peer });
    links.push(pair);
    const frames = [];
    let buffer = "";
    swarm.emit("connection", pair.serverStream, { topics: [Buffer.from(wireRoom(BOOKS), "hex")] });
    const transport = await new Promise((opened) => {
      const t = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) if (line) { try { frames.push(JSON.parse(line)); } catch {} }
      }, { onopen: () => opened(t) });
    });
    transport.send(topicsFrame(pair.clientStream, [BOOKS]));
    await eventually(() => frames.some((frame) => frame.room === wireRoom(BOOKS)), "the room to open on the connection");
    // Settled: nothing new for a while.
    let count = -1;
    while (count !== frames.length) {
      count = frames.length;
      await sleep(300);
    }

    for (const q of ["chapter four", "beach", "Book club", "note"]) await search(q);
    await sleep(500);
    // Only the keepalive a connection sends every 25 seconds may come.
    const after = frames.slice(count).filter((frame) => !["ping", "pong", "topics"].includes(frame.type));
    assert.deepEqual(after, []);
    transport.close();
  });

  it("shows a picture, a video and a file in the chat list by name, not by address", async () => {
    // Read again from the log when the desktop started.
    await eventually(async () => (await lastOf(BOOKS))?.message === "Photo", "the kept address to show as a photo");

    const club = (await call("get-rooms", "GET")).rooms.find((r) => r.name === "Reading circle").roomKey;
    const file = (fileName) => ({ message: SEALED, fileName, fileSize: 10, fileEnc: true });
    for (const [fileName, shown] of [["sunset.PNG", "Photo"], ["clip.mp4", "Video"], ["notes.pdf", "notes.pdf"]]) {
      await call("send", "POST", file(fileName), club);
      await eventually(async () => (await lastOf(club))?.message === shown, `${fileName} to show as ${shown}`);
    }
    const last = await lastOf(club);
    assert.equal(last.sender, myId);
    assert.doesNotMatch(JSON.stringify(last), /hyper:\/\//);
    await call("send", "POST", { message: "plain words" }, club);
    await eventually(async () => (await lastOf(club))?.message === "plain words", "words to show as written");
  });
});

describe("the chat list's search on the page", () => {
  it("asks for rooms and messages", () => {
    assert.match(html, /id="room-search" placeholder="Search rooms and messages"/);
    // In the body: PeerSky logs the address of every request it handles.
    assert.match(read("chat-api.js"), /searchMessages: \(query\) => apiRequest\("search-messages", \{ body: \{ q: query \} \}\)/);
  });

  it("lists matching chats first, then messages, from the backend's search of every chat", () => {
    const render = app.slice(app.indexOf("function renderHomeSearch("), app.indexOf("function searchHeading("));
    assert.ok(render.indexOf('searchHeading("Chats")') < render.indexOf('searchHeading("Messages")'));
    assert.match(render, /roomMatchesQuery\(r, query\)/);
    assert.match(app, /results = \(await chat\.searchMessages\(query\)\)\.results/);
    assert.match(app, /\$\("room-search"\)\?\.addEventListener\("input", \(\) => scheduleHomeSearch\(\)\);/);
    // Only the answer for what the box says now is shown.
    assert.match(app, /if \(homeQuery\(\) === query\) Object\.assign\(homeSearch/);
  });

  it("shows each message with its chat, sender, words around the match and time", () => {
    const hit = app.slice(app.indexOf("function makeSearchHitEl("), app.indexOf("async function openFoundMessage("));
    assert.match(hit, /esc\(name\)/);
    assert.match(hit, /esc\(sender\)/);
    assert.match(hit, /\$\{esc\(before\)\}<mark>\$\{esc\(match\)\}<\/mark>\$\{esc\(after\)\}/);
    assert.match(hit, /searchTimeLabel\(hit\.timestamp\)/);
    assert.match(hit, /addEventListener\("click", \(\) => openFoundMessage\(hit\)\)/);
    // Not a data-msg-id: scrollToMsg looks those up in the whole page.
    assert.doesNotMatch(hit, /msgId/);
    assert.match(styles, /#room-list mark \{/);
  });

  it("opens the chat at the message and picks it out", () => {
    const open = app.slice(app.indexOf("async function openFoundMessage("), app.indexOf("function resetMessageSearch("));
    assert.match(open, /await openRoom\(hit\.roomKey\)/);
    assert.match(open, /closeMessageSearchPanel\(\)/);
    assert.match(open, /holdInView\(container, el\)/);
    assert.match(open, /el\.classList\.add\("msg-found"\)/);
    assert.match(styles, /\.message\.msg-found \.msg-bubble \{ animation: msgFound/);
  });

  it("clears with Escape", () => {
    assert.match(app, /if \(document\.activeElement === roomSearch && roomSearch\.value\) \{\s*roomSearch\.value = "";\s*scheduleHomeSearch\(\);/);
  });
});

describe("searching inside a chat", () => {
  it("finds a file by its name, not its address", () => {
    const match = app.slice(app.indexOf("function messageMatchesSearch("), app.indexOf("function renderMessages("));
    assert.match(match, /searchableText\(m\)/);
  });

  // Picking a message the search found used to close the search and take the
  // chat back to its newest message, away from the one picked.
  it("stays open while a message it found is picked, with the message in view", () => {
    const clicks = app.slice(app.indexOf("// A search inside a chat stays open"), app.indexOf('$("room-search")?.addEventListener'));
    assert.doesNotMatch(clicks, /closeMessageSearchPanel/);
    const select = app.slice(app.indexOf("function startSelecting("), app.indexOf("function stopSelecting("));
    assert.doesNotMatch(select, /resetMessageSearch|closeMessageSearchPanel/);
    assert.match(select, /renderMessages\(S\.activeRoom, false\);/);
    assert.match(select, /scrollIntoView\(\{ block: "nearest" \}\)/);
    // A message arriving while searching does not move the reader either.
    const append = app.slice(app.indexOf("function appendMessage("), app.indexOf("function patchRoomsForPeer("));
    assert.match(append, /if \(messageSearchQuery\.trim\(\)\) \{\s*renderMessages\(roomKey, false\);/);
  });
});
