import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { collectLoadedMedia, restoreLoadedMedia } from "../lib/kept-media.js";

// Just enough of an element: attributes, data- fields, and swapping places.
function element(attrs = {}, dataset = {}) {
  const el = {
    attrs: { ...attrs },
    dataset: { ...dataset },
    replacedWith: null,
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    replaceWith(other) { this.replacedWith = other; },
  };
  return el;
}

// A rebuilt pane used to give every picture an empty element that had to
// fetch, decrypt, be screened and load again, collapsing its bubble each time.
describe("kept media", () => {
  it("puts a loaded picture back in place of the empty one made for the same file", () => {
    const loadedPicture = element({ src: "blob:one" }, { mediaKey: "hyper://drive/one.jpg" });
    const stillLoading = element({}, { mediaKey: "hyper://drive/two.jpg" });
    const kept = collectLoadedMedia([loadedPicture, stillLoading]);
    assert.deepEqual([...kept.keys()], ["hyper://drive/one.jpg"]);

    const emptyOne = element({ "data-enc-src": "hyper://drive/one.jpg" });
    const emptyTwo = element({ "data-enc-src": "hyper://drive/two.jpg" });
    restoreLoadedMedia([emptyOne, emptyTwo], kept);
    assert.equal(emptyOne.replacedWith, loadedPicture);
    // Not loaded yet, so it loads in the new pane as before.
    assert.equal(emptyTwo.replacedWith, null);
  });

  it("brings back a large picture someone opened, and one off a drive", () => {
    const opened = element({ src: "blob:big" }, { mediaKey: "hyper://drive/big.png" });
    const offDrive = element({ src: "hyper://drive/plain.gif" }, { mediaKey: "hyper://drive/plain.gif", screened: "1" });
    const kept = collectLoadedMedia([opened, offDrive]);

    const card = element({ "data-file-url": "hyper://drive/big.png", "data-large-type": "image" });
    const fresh = element({ src: "hyper://drive/plain.gif" });
    restoreLoadedMedia([card, fresh], kept);
    assert.equal(card.replacedWith, opened);
    assert.equal(fresh.replacedWith, offDrive);
  });

  it("uses each loaded element once, when one file shows twice", () => {
    const loaded = element({ src: "blob:one" }, { mediaKey: "hyper://drive/one.jpg" });
    const kept = collectLoadedMedia([loaded]);
    const first = element({ "data-enc-src": "hyper://drive/one.jpg" });
    const second = element({ "data-enc-src": "hyper://drive/one.jpg" });
    restoreLoadedMedia([first, second], kept);
    assert.equal(first.replacedWith, loaded);
    assert.equal(second.replacedWith, null);
  });
});
