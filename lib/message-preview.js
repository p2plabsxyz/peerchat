// What a message reads as in one line: on the chat list, and in search
// results. A picture is "Photo", a video "Video" and any other file its name,
// never the address the file is kept at, which means nothing to anyone and
// opens only sealed bytes. Anything else reads as it was written.
import { attachmentKind } from "./render-rules.js";

// Kept in step with isImageFile and isVideoFile in app.js, which decide how a
// file shows in the chat.
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|svg|avif|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|ogg|m4v|mkv|avi|3gp)$/i;

// Where PeerChat keeps a sealed file: a time and random hex, so the address
// alone says nothing of what the file is.
const SEALED_FILE_URL = /^hyper:\/\/[^/\s]+\/\d+-[0-9a-f]{16}\.bin$/i;

export function fileKind(name) {
  if (IMAGE_EXT.test(name || "")) return "image";
  if (VIDEO_EXT.test(name || "")) return "video";
  return "file";
}

export function fileLabel(name) {
  const kind = fileKind(name);
  return kind === "image" ? "Photo" : kind === "video" ? "Video" : name;
}

export function previewText(msg) {
  if (!msg) return "";
  const text = typeof msg.message === "string" ? msg.message : "";
  if (attachmentKind(text, msg)) return fileLabel(msg.fileName);
  // A preview kept from before previews named files holds only the address.
  if (SEALED_FILE_URL.test(text.trim())) return "File";
  return text;
}

// A chat's last message, as the chat list keeps it.
export function lastMessageOf(msg) {
  return {
    sender: msg.sender,
    senderName: msg.senderName,
    message: previewText(msg).slice(0, 120),
    timestamp: msg.timestamp,
  };
}

// A kept last message that is only an address, as every file's was before
// previews named files. Read again from the chat's history, it gets its name.
export function previewNeedsName(last) {
  return typeof last?.message === "string" && /^hyper:\/\/\S+$/i.test(last.message.trim());
}
