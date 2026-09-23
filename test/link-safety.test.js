// A scam link only has to fool a reader once, so this covers both halves: the
// tricks that must be caught, and the ordinary links that must stay quiet. A
// warning nobody trusts is worse than none.
//
// Mirrors test/platform/peerchat-link-safety.test.mjs in peersky-mobile.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assessLink,
  describeLinkRisk,
  extractFirstLink,
  LINK_OK,
  LINK_OPAQUE,
  LINK_SUSPICIOUS,
  warnAboutLink,
} from "../lib/link-safety.js";

const SAFE = [
  "https://example.com/page",
  "https://github.com/p2plabsxyz/peerchat",
  "https://en.wikipedia.org/wiki/Phishing",
  "https://news.ycombinator.com",
  "https://cdn.jsdelivr.net/npm/thing",
  "https://example.com:8443/thing",
  // The real brands, including one behind a two part suffix and one on a
  // subdomain. Warning on these would be the fastest way to be ignored.
  "https://www.paypal.com/signin",
  "https://paypal.co.uk/signin",
  "https://support.apple.com/en-us",
  "https://mail.google.com/mail/u/0",
  "https://amazon.in/deal",
];

describe("link safety", () => {
  it("leaves ordinary links alone", () => {
    for (const url of SAFE) {
      assert.equal(assessLink(url).level, LINK_OK, url);
      assert.equal(warnAboutLink(url), "", url);
    }
  });

  it("flags a username stuffed in front of the real host", () => {
    assert.equal(assessLink("http://paypal.com@evil.example/login").level, LINK_SUSPICIOUS);
    assert.match(warnAboutLink("http://user:pass@evil.example/"), /look like a different site/);
  });

  it("flags a bare address instead of a site name", () => {
    assert.equal(assessLink("http://192.168.1.1/admin").level, LINK_SUSPICIOUS);
    assert.equal(assessLink("http://[::1]:8080/").level, LINK_SUSPICIOUS);
    // http://2130706433/ is 127.0.0.1 written as one number.
    assert.equal(assessLink("http://2130706433/").level, LINK_SUSPICIOUS);
  });

  it("flags a name built from lookalike characters", () => {
    assert.match(warnAboutLink("https://xn--pypal-4ve.com/login"), /imitate ordinary letters/);
  });

  it("flags an address that reads as a filename", () => {
    assert.match(warnAboutLink("https://invoice-march.zip/open"), /mistaken for a file/);
    assert.match(warnAboutLink("https://holiday.mov/watch"), /mistaken for a file/);
  });

  it("flags a brand name outside the real domain", () => {
    for (const url of [
      "https://paypal.com.secure-login.xyz/verify",
      "https://secure-paypal.xyz",
      "https://my-amazon-deals.ru/offer",
      "HTTPS://PayPal.COM.login.xyz/a",
    ]) {
      assert.equal(assessLink(url).level, LINK_SUSPICIOUS, url);
    }
  });

  it("matches a brand as a whole label, not a substring", () => {
    // applecart is a word, not Apple. Substring matching would warn on it.
    assert.equal(assessLink("https://applecart.com").level, LINK_OK);
    // Paths are left alone on purpose. Plenty of honest links mention a brand
    // after the host, and flagging those would drown out the real warnings.
    assert.equal(assessLink("https://evil.com/paypal/login").level, LINK_OK);
  });

  it("calls a shortener opaque rather than a scam", () => {
    const assessment = assessLink("https://bit.ly/3abcdef");
    assert.equal(assessment.level, LINK_OPAQUE);
    assert.match(describeLinkRisk(assessment), /^Careful: /);
    assert.match(warnAboutLink("https://secure-paypal.xyz"), /^Possible scam: /);
  });

  it("ignores anything that is not an http link", () => {
    for (const value of ["", "not a url", "ftp://files.example.com", "hyper://abc", null, undefined, 42]) {
      assert.equal(assessLink(value).level, LINK_OK, String(value));
    }
  });

  it("does not mistake a path for credentials", () => {
    // React Native's URL shim reads a password out of ':' and '@' anywhere in
    // the string, which would warn on both of these. The shared parser must
    // not, or the two apps would disagree about the same link.
    assert.equal(assessLink("https://example.com/path:x@y").level, LINK_OK);
    assert.equal(assessLink("https://example.com/?to=a:b@c.com").level, LINK_OK);
  });

  it("pulls the first link out of a message without its punctuation", () => {
    assert.equal(extractFirstLink("look at https://example.com/a, then rest"), "https://example.com/a");
    assert.equal(extractFirstLink("(https://example.com/b)"), "https://example.com/b");
    assert.equal(extractFirstLink("two https://one.example and https://two.example"), "https://one.example");
    assert.equal(extractFirstLink("no links here"), "");
    assert.equal(extractFirstLink(""), "");
  });

  it("says nothing when there is nothing to warn about", () => {
    assert.equal(describeLinkRisk(null), "");
    assert.equal(describeLinkRisk({ level: LINK_OK, reasons: [] }), "");
  });
});
