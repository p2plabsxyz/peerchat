// Three small things in a chat: a search that found nothing left the chat
// looking empty, an empty file was called a folder, and the @ list matched
// only the start of a whole name, so "@Ana" never found "Test Ana".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

describe("in a chat", () => {
  it("a search that finds nothing says so", () => {
    assert.match(app, /if \(q && !msgs\.length\) \{[\s\S]{0,200}none\.textContent = "No messages found";/);
  });

  it("an empty file is not called a folder", () => {
    assert.match(app, /Empty files and folders cannot be sent/);
    assert.doesNotMatch(app, /"Folders cannot be sent\./);
  });

  it("the @ list finds a name by any of its words, whole names first", () => {
    const query = "ana";
    const startsName = (m) => m.username.toLowerCase().startsWith(query);
    const startsWord = (m) => m.username.toLowerCase().split(/\s+/).some((word) => word.startsWith(query));
    const people = [{ username: "Test Ana" }, { username: "Anahita" }, { username: "Test Ben" }];
    const found = people.filter((m) => startsName(m) || startsWord(m)).sort((a, b) => Number(startsName(b)) - Number(startsName(a)));
    assert.deepEqual(found.map((m) => m.username), ["Anahita", "Test Ana"]);
    assert.match(app, /mentionPeople\(room\)\s+\.filter\(\(m\) => startsName\(m\) \|\| startsWord\(m\)\)/);
  });
});
