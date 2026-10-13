// Back-to-back messages from one person, shown together under one name.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GROUP_GAP_MS, joinsGroup } from "../lib/message-groups.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const NOON = new Date(2026, 9, 12, 12, 0).getTime();

describe("grouping messages", () => {
  it("joins messages from one person a little apart", () => {
    assert.equal(joinsGroup({ sender: "aa", ts: NOON }, { sender: "aa", ts: NOON + 30_000 }), true);
    assert.equal(joinsGroup({ sender: "self", ts: NOON }, { sender: "self", ts: NOON + GROUP_GAP_MS - 1 }), true);
  });

  it("starts a new group for another person, a long gap, a new day or a message out of order", () => {
    assert.equal(joinsGroup({ sender: "aa", ts: NOON }, { sender: "bb", ts: NOON + 1000 }), false);
    assert.equal(joinsGroup({ sender: "aa", ts: NOON }, { sender: "aa", ts: NOON + GROUP_GAP_MS }), false);
    const lateNight = new Date(2026, 9, 12, 23, 59).getTime();
    assert.equal(joinsGroup({ sender: "aa", ts: lateNight }, { sender: "aa", ts: lateNight + 2 * 60_000 }), false);
    assert.equal(joinsGroup({ sender: "aa", ts: NOON + 1000 }, { sender: "aa", ts: NOON }), false);
    assert.equal(joinsGroup({ sender: "", ts: NOON }, { sender: "", ts: NOON }), false);
    assert.equal(joinsGroup(null, { sender: "aa", ts: NOON }), false);
  });

  it("is applied to the history and to each new message, against what is shown just before", () => {
    assert.match(app, /const el = makeMsgEl\(m\);\s*groupWithPrevious\(container\.lastElementChild, el\);\s*container\.appendChild\(el\);/);
    assert.match(app, /el = makeMsgEl\(msg\);\s*el\.classList\.add\("msg-animate"\);\s*groupWithPrevious\(container\.lastElementChild, el\);/);
    assert.match(app, /el\.dataset\.sender = self \? "self" : \(msg\.sender \|\| ""\);/);
  });

  it("shows the name once, keeps the bubbles close and leaves off only a repeated time", () => {
    assert.match(styles, /\.message\.msg-grouped > \.msg-header \{ display: none; \}/);
    assert.match(styles, /\.message\.msg-followed \{ margin-bottom: 2px; \}/);
    assert.match(styles, /\.message\.msg-same-time > \.msg-time \{ display: none; \}/);
    assert.match(app, /if \(time\(prev\) === time\(el\)\) prev\.classList\.add\("msg-same-time"\);/);
  });
});

describe("a picture on its own", () => {
  it("gets a bubble that fits it", () => {
    assert.match(app, /textNode\.firstElementChild\.matches\("\.msg-file-img"\)[^\n]*\n\s*bubble\.classList\.add\("msg-bubble-media"\);/);
    assert.match(styles, /\.msg-bubble\.msg-bubble-media \{ padding: 4px;/);
    assert.match(styles, /\.msg-bubble-media \.msg-file-img \{ margin-top: 0;/);
  });
});
