import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stickToBottom } from "../lib/scroll.js";

// A scroll container with the browser's clamping, driven by a manual frame
// queue and clock so the loop's decisions are deterministic.
class Box {
  constructor(height, client = 500) { this.scrollHeight = height; this.clientHeight = client; this.isConnected = true; this._top = 0; }
  get scrollTop() { return this._top; }
  set scrollTop(v) { this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); }
  scrollTo({ top }) { this.scrollTop = top; }
  get max() { return this.scrollHeight - this.clientHeight; }
}

function harness() {
  const frames = [];
  let t = 0;
  return {
    opts: { raf: (cb) => frames.push(cb), now: () => t },
    tick() { for (const cb of frames.splice(0)) cb(); },
    advance(ms) { t += ms; },
    get pending() { return frames.length; },
  };
}

describe("stickToBottom", () => {
  it("follows the bottom while content keeps growing", () => {
    const h = harness();
    const box = new Box(2000);
    stickToBottom(box, h.opts);
    assert.equal(box.scrollTop, box.max);
    h.tick();
    box.scrollHeight = 2600;
    h.tick();
    assert.equal(box.scrollTop, box.max);
  });

  // The bug: a reader scrolling up while media was still loading got pulled
  // back down every frame, then once more at the deadline.
  it("stops the moment the user scrolls up and never yanks at the deadline", () => {
    const h = harness();
    const box = new Box(2000);
    stickToBottom(box, h.opts);
    h.tick();

    box.scrollTop = 200;         // user scrolls up to read
    box.scrollHeight = 3000;     // images keep landing below
    h.tick();
    assert.equal(box.scrollTop, 200);

    h.advance(2000);             // past the 1500ms budget
    h.tick();
    h.tick();
    assert.equal(box.scrollTop, 200);
    assert.equal(h.pending, 0, "loop must have ended");
  });

  it("does not mistake a height shrink for user input", () => {
    const h = harness();
    const box = new Box(2000);
    stickToBottom(box, h.opts);
    h.tick();
    box.scrollHeight = 1500;     // placeholder replaced by something smaller
    h.tick();
    box.scrollHeight = 1800;
    h.tick();
    assert.equal(box.scrollTop, box.max);
    assert.equal(h.pending, 1, "still following");
  });

  it("yields to the user in smooth mode too", () => {
    const h = harness();
    const box = new Box(2000);
    stickToBottom(box, { ...h.opts, smooth: true });
    h.tick();
    box.scrollTop = 100;
    box.scrollHeight = 2800;
    h.tick();
    assert.equal(box.scrollTop, 100);
    assert.equal(h.pending, 0);
  });

  it("settles an idle reader at the bottom when the budget ends", () => {
    const h = harness();
    const box = new Box(2000);
    stickToBottom(box, h.opts);
    h.tick();
    h.advance(1600);
    box.scrollHeight = 2100;
    h.tick();
    assert.equal(box.scrollTop, box.max);
    assert.equal(h.pending, 0);
  });

  it("lets a newer watch on the same container supersede an older one", () => {
    const h = harness();
    const box = new Box(2000);
    stickToBottom(box, h.opts);
    stickToBottom(box, h.opts);
    h.tick();
    assert.equal(h.pending, 1, "only the newest loop keeps running");
  });
});
