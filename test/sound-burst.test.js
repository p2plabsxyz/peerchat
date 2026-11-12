// Coming back to many messages at once played the message sound once per
// message, many times in a row. A burst now sounds once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createSoundGate, CHAT_SOUND_GAP_MS } from "../lib/sound-gate.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

describe("sounds for a burst of messages", () => {
  it("sound once for fifty messages that arrive together, and again after", () => {
    let now = 1000;
    const gate = createSoundGate(CHAT_SOUND_GAP_MS, () => now);
    let played = 0;
    for (let i = 0; i < 50; i++) {
      if (gate.allow()) played++;
      now += 10;
    }
    assert.equal(played, 1);
    now += CHAT_SOUND_GAP_MS;
    assert.equal(gate.allow(), true);
  });

  it("still sound for each message of a live chat", () => {
    let now = 0;
    const gate = createSoundGate(CHAT_SOUND_GAP_MS, () => now);
    const played = [0, 2000, 4000, 9000].filter((at) => {
      now = at;
      return gate.allow();
    });
    assert.equal(played.length, 4);
  });

  it("hold every incoming sound to the gate, never a send", () => {
    assert.match(app, /if \(type !== "send" && !incomingSound\.allow\(\)\) return;/);
    // Every sound goes through playSound.
    assert.doesNotMatch(app.replace(/function playSound[\s\S]*?\n\}\n/, ""), /createBufferSource|new Audio\(`\.\/assets\/sound/);
  });
});
