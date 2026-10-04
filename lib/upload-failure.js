// What a failed attachment upload says. A full disk comes back in the
// system's own words (ENOSPC), so that one is said plainly, with the file's
// name, now that PeerChat sets no size limit of its own.
export function describeUploadFailure(fileName, detail) {
  const text = String(detail || "").trim();
  if (/ENOSPC|no space left|not enough (free )?space/i.test(text)) {
    return `There is not enough free space on this computer to share ${fileName}.`;
  }
  return `Upload failed: ${text || "try again."}`;
}
