// Attachment UI belongs to uploads only. Every upload sets fileName; a pasted
// URL never does, so it renders as a plain link the reader can copy.
export function attachmentKind(text, msg) {
  if (!msg?.fileName) return null;
  const t = typeof text === "string" ? text.trim() : "";
  if (!/^hyper:\/\//i.test(t) || /\s/.test(t)) return null;
  return msg.fileEnc === true ? "encrypted" : "upload";
}
