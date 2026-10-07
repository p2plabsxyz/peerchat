// "@Akhilesh@mobile" was read as "@Akhilesh" with "@mobile" after it, so the
// phone's name was never a mention and a click opened the desktop's profile.
// "@Akhilesh how are you" was the other way round: the whole sentence was the
// name. Mentions are read against the names the room knows now.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { findMentions, mentionQueryStart, mentionsPerson, personName } from "../lib/mentions.js";

const names = (text, known) => findMentions(text, known).map((m) => text.slice(m.start, m.end));

describe("reading mentions", () => {
  it("takes a device label as part of the name", () => {
    const known = ["Akhilesh", "Akhilesh@mobile", "Akhilesh@desktop2"];
    assert.deepEqual(names("@Akhilesh@mobile hi", known), ["@Akhilesh@mobile"]);
    assert.deepEqual(names("hey @Akhilesh@desktop2 and @Akhilesh", known), ["@Akhilesh@desktop2", "@Akhilesh"]);
    assert.equal(findMentions("@akhilesh@MOBILE", known)[0].name, "Akhilesh@mobile");
  });

  it("stops at the end of the name", () => {
    assert.deepEqual(names("hey @Akhilesh how are you", ["Akhilesh"]), ["@Akhilesh"]);
    assert.deepEqual(names("hi @Harshal Atre welcome", ["Harshal", "Harshal Atre"]), ["@Harshal Atre"]);
  });

  it("leaves addresses and names nobody here has alone", () => {
    assert.deepEqual(names("mail a@Harshal and @Unknown", ["Harshal"]), []);
    assert.deepEqual(names("@Akhilesh@mobile", ["mobile"]), []);
  });

  it("names the person, whichever device was named", () => {
    assert.equal(personName("Akhilesh@mobile"), "Akhilesh");
    assert.equal(personName("Akhilesh@desktop12"), "Akhilesh");
    assert.equal(personName("Akhilesh Thite"), "Akhilesh Thite");
  });
});

describe("who a mention reaches", () => {
  const room = ["Akhilesh", "Akhilesh@mobile", "Akhilesh Thite", "Sam"];

  it("reaches every device of the person named", () => {
    assert.equal(mentionsPerson("@Akhilesh@mobile look", room, ["Akhilesh", "Akhilesh"]), true);
    assert.equal(mentionsPerson("@Akhilesh look", room, ["Akhilesh", "Akhilesh@mobile"]), true);
    assert.equal(mentionsPerson("@Akhilesh@desktop2 look", [], ["Akhilesh", "Akhilesh@mobile"]), true);
  });

  it("does not reach someone whose name is only the start of another's", () => {
    assert.equal(mentionsPerson("@Akhilesh Thite look", room, ["Akhilesh", "Akhilesh"]), false);
    assert.equal(mentionsPerson("@Sam look", room, ["Akhilesh", "Akhilesh@mobile"]), false);
    assert.equal(mentionsPerson("mail me a@Akhilesh", room, ["Akhilesh", "Akhilesh"]), false);
  });
});

describe("typing a mention", () => {
  it("finds the start past a device label's @", () => {
    assert.equal(mentionQueryStart("hi @Akhilesh@mo"), 3);
    assert.equal(mentionQueryStart("@Akhilesh@"), 0);
    assert.equal(mentionQueryStart("hi @Akh"), 3);
  });

  it("finds nothing in an address", () => {
    assert.equal(mentionQueryStart("mail a@b"), -1);
    assert.equal(mentionQueryStart("no mention"), -1);
  });
});

describe("the app uses those rules", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const p2p = readFileSync(new URL("../p2p.js", import.meta.url), "utf8");

  it("styles, counts and completes mentions with them", () => {
    assert.match(app, /findMentions\(escapedPlain, /);
    assert.match(app, /mentionsPerson\(message, roomMentionNames\(roomKey\)/);
    assert.equal(app.match(/mentionQueryStart\(before\)/g)?.length, 2);
    assert.doesNotMatch(app, /MENTION_IN_ESCAPED_TEXT_RE/);
    assert.match(p2p, /mentionsPerson\(msgText, /);
    assert.doesNotMatch(p2p, /msgText\.includes\("@" \+ uname\)/);
  });
});
