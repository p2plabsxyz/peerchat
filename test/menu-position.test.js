import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { menuPosition } from "../lib/menu-position.js";

// A 140x130 menu, about the size of a chat's options, in an 1000x800 window.
const view = { width: 140, height: 130, viewportWidth: 1000, viewportHeight: 800 };

describe("menuPosition", () => {
  it("opens below and to the right of the pointer when it fits", () => {
    assert.deepEqual(menuPosition({ ...view, x: 300, y: 200 }), { left: 300, top: 200 });
  });

  it("opens above the pointer for a chat at the bottom of the list", () => {
    // Below, it would end at 890 in an 800 tall window: the last options cut off.
    assert.deepEqual(menuPosition({ ...view, x: 300, y: 760 }), { left: 300, top: 630 });
  });

  it("keeps a margin from the bottom edge before flipping", () => {
    assert.equal(menuPosition({ ...view, x: 300, y: 662 }).top, 662);
    assert.equal(menuPosition({ ...view, x: 300, y: 663 }).top, 533);
  });

  it("opens to the left of the pointer at the right edge", () => {
    assert.deepEqual(menuPosition({ ...view, x: 950, y: 200 }), { left: 810, top: 200 });
    assert.deepEqual(menuPosition({ ...view, x: 990, y: 790 }), { left: 850, top: 660 });
  });

  it("never goes past an edge when it fits neither above nor below", () => {
    const tall = { ...view, height: 700 };
    assert.deepEqual(menuPosition({ ...tall, x: 300, y: 400 }), { left: 300, top: 8 });
    assert.deepEqual(menuPosition({ ...view, height: 900, x: 300, y: 400 }), { left: 300, top: 8 });
    assert.deepEqual(menuPosition({ ...view, x: 2, y: 2 }), { left: 8, top: 8 });
  });
});
