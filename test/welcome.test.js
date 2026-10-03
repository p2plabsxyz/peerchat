// The first time PeerChat opens on a computer it shows what the phone app
// shows: four points, the questions people ask and the rules, then I understand.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { PEERCHAT_WELCOME, WELCOME_POINTS, WELCOME_QUESTIONS, WELCOME_RULES } from "../lib/welcome-content.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("the PeerChat welcome", () => {
  it("has the phone's points, worded for a computer", () => {
    assert.equal(WELCOME_POINTS.length, 4);
    assert.match(WELCOME_POINTS[0], /straight from your computer to theirs, end to end encrypted/);
    assert.match(WELCOME_POINTS[2], /Keep PeerSky open so friends can reach you/);
    assert.match(WELCOME_POINTS[3], /Any local network will do/);
    assert.ok(PEERCHAT_WELCOME.points.every((point) => !point.icon), "numbered, as on the phone");
  });

  it("asks about the phone from a computer, as the phone asks about desktop", () => {
    const questions = WELCOME_QUESTIONS.map(({ q }) => q);
    assert.ok(questions.includes("Is it on my phone too?"));
    assert.ok(questions.includes("How does it work without internet?"));
    assert.ok(questions.includes("How does it compare with WhatsApp, Telegram or Signal?"));
    assert.ok(questions.includes("Can I use it on my phone and my computer?"));
    // In PeerChat's own words, not another chat app's FAQ word for word.
    assert.ok(!questions.some((q) => /iPhone and Android|computer too|available on desktop|different from|really free|why does it matter|multiple devices/i.test(q)));
    const answer = (q) => WELCOME_QUESTIONS.find((item) => item.q === q).a;
    assert.match(answer("Is it on my phone too?"), /iPhone, iPad and Android/);
    assert.match(answer("Can I send big files?"), /any size your computer has room for/);
    assert.match(answer("How does it work without internet?"), /Any local network will do/);
    assert.match(answer("Can I use it on my phone and my computer?"), /ada@mobile or ada@desktop1/);
    for (const { q, a } of WELCOME_QUESTIONS) {
      assert.match(q, /\?$/);
      assert.doesNotMatch(`${q} ${a}`, /—|honestly/i);
    }
  });

  it("shows the rules right above the button, and the button agrees to them", () => {
    assert.equal(WELCOME_RULES.length, 5);
    assert.match(WELCOME_RULES[0], /No sexual content or nudity, ever/);
    assert.equal(PEERCHAT_WELCOME.action, "I understand");
    assert.match(PEERCHAT_WELCOME.rules.note, /Clicking I understand means you agree to these rules/);
  });

  it("comes before the app, once per computer", async () => {
    const html = await read("index.html");
    assert.ok(html.indexOf('src="./app-welcome.js"') < html.indexOf('src="./app.js"'));
    const welcome = await read("lib/welcome.js");
    assert.match(welcome, /localStorage\.setItem\(storageKey\(welcome\.id\), "seen"\)/);
    assert.match(welcome, /"Questions people ask"/);
    assert.match(welcome, /"The rules"/);
  });
});
