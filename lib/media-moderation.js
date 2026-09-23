// Photos and videos never reach the text filters. An attachment's message is
// only its hyper:// URL, so the word list and the domain blocklist look at the
// link and never at the picture.
//
// This runs before an upload leaves the sender, so explicit media never enters
// the room feed at all. It is not a guarantee: someone running a modified build
// can skip it. It is the same trade the text filters make, and it stops the
// ordinary case, which is what the room actually suffers from.

export const MEDIA_ALLOWED = "allowed";
export const MEDIA_BLOCKED = "blocked";
export const MEDIA_UNSCANNED = "unscanned";

// Anything at or above this on the explicit classes refuses the upload. The
// model is not certain enough to go lower without refusing swimwear.
export const EXPLICIT_THRESHOLD = 0.6;
export const EXPLICIT_CLASSES = new Set(["Porn", "Hentai"]);

// How many files one send may carry. Chosen so an accidental select-all in a
// photo folder does not push a hundred uploads into a room.
export const MAX_UPLOAD_BATCH = 10;

// Frames sampled across a video. A clip is explicit if any sampled frame is.
export const VIDEO_FRAME_SAMPLES = 8;

const VERDICTS = new Set([MEDIA_ALLOWED, MEDIA_BLOCKED, MEDIA_UNSCANNED]);

export function normalizeMediaVerdict(value) {
  return VERDICTS.has(value) ? value : MEDIA_UNSCANNED;
}

// nsfwjs returns five classes with probabilities. Only the two explicit ones
// refuse; Sexy covers swimwear and underwear, which is not what this is for.
export function verdictFromPredictions(predictions, threshold = EXPLICIT_THRESHOLD) {
  if (!Array.isArray(predictions) || predictions.length === 0) return MEDIA_UNSCANNED;
  for (const prediction of predictions) {
    if (!EXPLICIT_CLASSES.has(prediction?.className)) continue;
    if (Number(prediction?.probability) >= threshold) return MEDIA_BLOCKED;
  }
  return MEDIA_ALLOWED;
}

export function describeBlockedUpload(fileName) {
  const name = fileName ? `"${fileName}"` : "That file";
  return `${name} looks explicit, so it was not sent. Rooms are shared with people who did not ask to see it.`;
}

// Says what to do with a batch before any of it is uploaded: one refusal stops
// the whole send, so a user never gets half a batch through.
export function screenUploadBatch(results) {
  const blocked = (results || []).filter((entry) => normalizeMediaVerdict(entry?.verdict) === MEDIA_BLOCKED);
  if (blocked.length === 0) return { allowed: true, blocked: [], reason: "" };
  return {
    allowed: false,
    blocked,
    reason: describeBlockedUpload(blocked.length === 1 ? blocked[0].fileName : ""),
  };
}

export function isTooManyFiles(count, max = MAX_UPLOAD_BATCH) {
  return Number(count) > max;
}

export function describeTooManyFiles(count, max = MAX_UPLOAD_BATCH) {
  return `Pick up to ${max} files at a time. You chose ${count}.`;
}

// Evenly spaced, skipping the very first and last frame: a lot of clips open on
// black and end on a cut, and neither tells you anything.
export function videoSampleTimes(duration, samples = VIDEO_FRAME_SAMPLES) {
  const length = Number(duration);
  if (!Number.isFinite(length) || length <= 0) return [0];
  const count = Math.max(1, Math.min(samples, Math.ceil(length)));
  const step = length / (count + 1);
  return Array.from({ length: count }, (_, index) => Number((step * (index + 1)).toFixed(3)));
}
