// Formatting in a message, the same marks the phone reads: fenced code blocks,
// headings (#, ## and ###), inline `code`, **bold**, *italic* or _italic_,
// and ~struck out~. Pure string work, so the rules can be tested without a
// page; app.js turns the result into HTML.

// A fence opens with ``` (a language name after it is allowed and dropped)
// and closes with the next ```. An unclosed fence stays as typed.
const FENCE = /```[^\n`]*\n?([\s\S]*?)```/g;
const HEADING = /^(#{1,3})[ \t]+(\S.*)$/;

/**
 * The message as alternating prose and code. The line breaks either side of
 * a fence belong to the fence, so they are not shown as blank lines.
 */
export function splitCodeFences(text) {
  const value = typeof text === "string" ? text : "";
  const parts = [];
  let cursor = 0;
  for (const match of value.matchAll(FENCE)) {
    pushProse(parts, value.slice(cursor, match.index));
    parts.push({ code: true, text: match[1].replace(/\n$/, "") });
    cursor = match.index + match[0].length;
  }
  pushProse(parts, value.slice(cursor));
  return parts.length ? parts : [{ code: false, text: "" }];
}

function pushProse(parts, text) {
  const prose = text.replace(/^\n/, "").replace(/\n$/, "");
  if (prose.trim()) parts.push({ code: false, text: prose });
}

/** 1 to 3 for a heading line, with its text; 0 for anything else. */
export function readHeading(line) {
  const match = String(line || "").match(HEADING);
  return match ? { level: match[1].length, text: match[2] } : { level: 0, text: String(line || "") };
}

/**
 * Bold, italic, struck out and inline code, on text that is already escaped
 * for HTML. Code goes first and is put back last, so nothing inside it is
 * read as formatting. Marks pair only when they open and close on a
 * non-space, and an underscore only at a word's edge, so snake_case, sums
 * like 5 * 3, and file names stay as they are.
 */
export function applyInlineFormatting(escapedText) {
  const codes = [];
  const held = escapedText.replace(/`([^`\n]+)`/g, (match, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const formatted = held
    .replace(/\*\*(?=[^\s*])([^\n]*?[^\s*])\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w~])~(?=[^\s~])([^~\n]*?[^\s~])~(?![\w~])/g, "$1<del>$2</del>");
  return formatted.replace(/\u0000(\d+)\u0000/g, (match, index) => (
    `<code class="msg-inline-code" title="Click to copy">${codes[Number(index)]}</code>`
  ));
}
