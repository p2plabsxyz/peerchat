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
