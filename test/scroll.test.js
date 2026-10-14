import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { holdInView, shouldScrollToUnread, stickToBottom } from "../lib/scroll.js";

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

// A message opened from a search goes to the middle of the pane and stays
// there while pictures above it load.
describe("holdInView", () => {
  const message = (offsetTop, offsetHeight = 60) => ({ offsetTop, offsetHeight, isConnected: true });

  it("puts the message in the middle and keeps it there as content above grows", () => {
    const h = harness();
    const box = new Box(4000);
    const el = message(1800);
    holdInView(box, el, h.opts);
    assert.equal(box.scrollTop, 1800 - (500 - 60) / 2);
    h.tick();
    box.scrollHeight = 4300;     // a picture above it loads
    el.offsetTop = 2100;
    h.tick();
    assert.equal(box.scrollTop, 2100 - (500 - 60) / 2);
    assert.equal(h.pending, 1);
  });

  it("stops the moment the user scrolls, and when its time is up", () => {
    const h = harness();
    const box = new Box(4000);
    const el = message(1800);
    holdInView(box, el, h.opts);
    h.tick();
    box.scrollTop = 600;         // the reader scrolls away
    h.tick();
    box.scrollHeight = 4300;
    el.offsetTop = 2100;
    h.tick();
    assert.equal(box.scrollTop, 600);
    assert.equal(h.pending, 0);

    const again = harness();
    holdInView(box, el, again.opts);
    again.advance(2000);
    again.tick();
    assert.equal(again.pending, 0, "the loop ends after its budget");
  });

  it("takes over from stickToBottom, and gives way to a later one", () => {
    const h = harness();
    const box = new Box(4000);
    stickToBottom(box, h.opts);
    holdInView(box, message(1000), h.opts);
    h.tick();
    assert.equal(box.scrollTop, 1000 - (500 - 60) / 2, "the bottom does not pull it back");
    stickToBottom(box, h.opts);
    h.tick();
    assert.equal(h.pending, 1, "only the newest loop keeps running");
  });
});

// Opening a room with a couple of unread messages jumped to the divider above
// them, which pulls the reader up from the message they came to see even though
// it was already on screen.
describe("shouldScrollToUnread", () => {
  it("goes to the divider when the unread run starts off screen", () => {
    assert.equal(
      shouldScrollToUnread({ dividerTop: 100, scrollHeight: 3000, clientHeight: 500 }),
      true,
    );
  });

  it("stays at the newest message when the whole run already fits there", () => {
    // Bottom sits at 2500, and the divider is below it, so the unread messages
    // are in view without moving.
    assert.equal(
      shouldScrollToUnread({ dividerTop: 2700, scrollHeight: 3000, clientHeight: 500 }),
      false,
    );
  });

  it("stays put when the divider is exactly on the last screen", () => {
    assert.equal(
      shouldScrollToUnread({ dividerTop: 2500, scrollHeight: 3000, clientHeight: 500 }),
      false,
    );
  });

  it("stays put when the pane does not scroll at all", () => {
    assert.equal(
      shouldScrollToUnread({ dividerTop: 40, scrollHeight: 400, clientHeight: 500 }),
      false,
    );
  });

  it("has no opinion without a divider", () => {
    assert.equal(shouldScrollToUnread({ scrollHeight: 3000, clientHeight: 500 }), false);
    assert.equal(
      shouldScrollToUnread({ dividerTop: -1, scrollHeight: 3000, clientHeight: 500 }),
      false,
    );
  });
});
