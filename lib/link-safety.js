// Flags links that look like a scam so the preview can say so.
//
// Deliberately heuristics rather than a blocklist. Phishing domains are
// disposable by design and a bundled list is stale within hours, which is
// exactly the window that matters. These signals stay true no matter how new
// the domain is.
//
// Judged by the reader at render time, never carried on the wire. A sender
// could strip a flag they set themselves, the same reason media is screened
// again on arrival.
//
// Mirror of app/peerchat/link-safety.mjs in peersky-mobile. Keep them in step.

export const LINK_OK = "ok";
// A shortener is not dishonest, it just hides the destination. Calling that a
// scam would teach people to scroll past the warning that does matter.
export const LINK_OPAQUE = "opaque";
export const LINK_SUSPICIOUS = "suspicious";

const HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

// Hides where a link actually goes.
const SHORTENERS = new Set([
  "bit.ly", "buff.ly", "cutt.ly", "goo.gl", "is.gd", "ow.ly", "rb.gy",
  "rebrand.ly", "shorte.st", "shorturl.at", "t.co", "t.ly", "tinyurl.com",
]);

// Reads as a filename, so the link looks like a download. Kept to two on
// purpose: flagging every cheap TLD would warn on far too much that is fine.
const RISKY_TLDS = new Set(["mov", "zip"]);

// Names worth impersonating, flagged only when they turn up somewhere other
// than the real domain.
const IMPERSONATED = [
  "amazon", "apple", "binance", "coinbase", "facebook", "google", "instagram",
  "metamask", "microsoft", "netflix", "paypal", "steam", "whatsapp",
];

// So paypal.co.uk reads as the real paypal instead of an impersonation.
const MULTIPART_SUFFIXES = new Set([
  "ac.uk", "co.in", "co.jp", "co.nz", "co.uk", "co.za", "com.au", "com.br",
  "com.mx", "com.sg", "gov.uk", "net.au", "org.au", "org.uk",
]);

function registrableDomain(hostname) {
  const labels = hostname.split(".");
  if (labels.length < 3) return hostname;
  const lastTwo = labels.slice(-2).join(".");
  return MULTIPART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

// React Native ships a regex shim for URL, not the real parser, and its
// password getter matches greedily across the path. Parse the bit we need
// here so a phone and a laptop reach the same verdict.
const AUTHORITY_RE = /^(https?):\/\/([^/?#]*)/i;

function parseHttpUrl(rawUrl) {
  const match = AUTHORITY_RE.exec(String(rawUrl || "").trim());
  if (!match) return null;
  const authority = match[2];
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at);
  const hostAndPort = at === -1 ? authority : authority.slice(at + 1);
  const hostname = hostAndPort.startsWith("[")
    ? hostAndPort.slice(0, hostAndPort.indexOf("]") + 1)
    : hostAndPort.split(":")[0];
  if (!hostname) return null;
  return { userinfo, hostname: hostname.toLowerCase() };
}

function isAddressHost(hostname) {
  if (hostname.startsWith("[")) return true;
  // A bare number is still an address. http://2130706433/ resolves the same as
  // http://127.0.0.1/ and is a favourite way to hide one.
  return /^\d+$/.test(hostname) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

export function extractFirstLink(text) {
  if (typeof text !== "string" || !text) return "";
  HTTP_URL_RE.lastIndex = 0;
  const match = HTTP_URL_RE.exec(text);
  if (!match) return "";
  return match[0].replace(/[)\]},.;:"'!?]+$/g, "");
}

// Returns { level, reasons }. Reasons are plain enough to show a reader as is.
export function assessLink(rawUrl) {
  const reasons = [];
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return { level: LINK_OK, reasons };
  const { hostname } = parsed;

  // Anything left of an @ is ignored by the browser, so the link can read as
  // one site and land on another. The oldest trick there is.
  if (parsed.userinfo) {
    reasons.push("the address is written to look like a different site");
  }

  if (isAddressHost(hostname)) {
    reasons.push("it points at a bare IP address instead of a site name");
  }

  // Punycode renders as characters that look like ordinary letters.
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) {
    reasons.push("the name uses characters that imitate ordinary letters");
  }

  const tld = hostname.split(".").pop() || "";
  if (RISKY_TLDS.has(tld)) {
    reasons.push(`a ".${tld}" address is easily mistaken for a file`);
  }

  const registrable = registrableDomain(hostname);
  const owner = registrable.split(".")[0];
  if (!IMPERSONATED.includes(owner)) {
    // Match whole labels, so applecart.com is left alone while
    // secure-paypal.xyz and paypal.com.login.xyz are not.
    const tokens = new Set(hostname.split(/[.-]/));
    const brand = IMPERSONATED.find((name) => tokens.has(name));
    if (brand) reasons.push(`it says "${brand}" but is not ${brand}'s real site`);
  }

  if (reasons.length > 0) return { level: LINK_SUSPICIOUS, reasons };
  if (SHORTENERS.has(registrable)) {
    return { level: LINK_OPAQUE, reasons: ["a shortened link hides where it goes"] };
  }
  return { level: LINK_OK, reasons };
}

// One line, because a wall of warning text just gets scrolled past.
export function describeLinkRisk(assessment) {
  const level = assessment?.level;
  if (level !== LINK_SUSPICIOUS && level !== LINK_OPAQUE) return "";
  const [first] = assessment.reasons;
  if (level === LINK_OPAQUE) return `Careful: ${first}.`;
  return first ? `Possible scam: ${first}.` : "This link may be a scam.";
}

export function warnAboutLink(rawUrl) {
  return describeLinkRisk(assessLink(rawUrl));
}
