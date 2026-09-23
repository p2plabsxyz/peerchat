// Runs the vendored nsfwjs model over an image or a video's frames. The model
// and the library are both in lib/ rather than on a CDN: PeerChat has no build
// step, and a room should not need the open web to decide what it will accept.
import {
  MEDIA_ALLOWED,
  MEDIA_BLOCKED,
  MEDIA_UNSCANNED,
  verdictFromPredictions,
  videoSampleTimes,
} from "./media-moderation.js";

const MODEL_PATH = new URL("./nsfw-model/model.json", import.meta.url).href;
const LIBRARY_PATH = new URL("./nsfwjs.min.js", import.meta.url).href;
// What the vendored MobileNetV2 was trained at.
const INPUT_SIZE = 224;

let modelPromise = null;

function loadLibrary() {
  if (globalThis.nsfwjs) return Promise.resolve(globalThis.nsfwjs);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LIBRARY_PATH;
    script.onload = () => (globalThis.nsfwjs ? resolve(globalThis.nsfwjs) : reject(new Error("nsfwjs did not load")));
    script.onerror = () => reject(new Error("nsfwjs did not load"));
    document.head.appendChild(script);
  });
}

// Deliberately lazy. Most sessions never attach a file, and 5 MB of model has
// no business loading on startup.
export function loadMediaModel() {
  if (!modelPromise) {
    modelPromise = loadLibrary()
      .then((nsfwjs) => nsfwjs.load(MODEL_PATH, { size: INPUT_SIZE }))
      .catch((error) => {
        modelPromise = null;
        throw error;
      });
  }
  return modelPromise;
}

function drawToCanvas(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  canvas.getContext("2d").drawImage(source, 0, 0, width, height, 0, 0, INPUT_SIZE, INPUT_SIZE);
  return canvas;
}

async function classifyCanvas(model, canvas) {
  return verdictFromPredictions(await model.classify(canvas));
}

async function scanImage(model, objectUrl) {
  const image = new Image();
  image.src = objectUrl;
  await image.decode();
  return classifyCanvas(model, drawToCanvas(image, image.naturalWidth, image.naturalHeight));
}

async function scanVideo(model, objectUrl) {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = objectUrl;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("video metadata could not be read"));
  });

  // Any explicit frame condemns the clip, so this stops at the first one
  // rather than decoding the rest.
  for (const time of videoSampleTimes(video.duration)) {
    await new Promise((resolve, reject) => {
      video.onseeked = resolve;
      video.onerror = () => reject(new Error("video frame could not be read"));
      video.currentTime = time;
    });
    const verdict = await classifyCanvas(model, drawToCanvas(video, video.videoWidth, video.videoHeight));
    if (verdict === MEDIA_BLOCKED) return MEDIA_BLOCKED;
  }
  return MEDIA_ALLOWED;
}

/**
 * Screens something that has already been fetched and decrypted, for the
 * receiving side. The sending side can be stripped out by anyone running a
 * modified build, which is exactly why the text filters check inbound messages
 * too, and why this exists.
 */
export async function scanMediaUrl(objectUrl, kind) {
  if (kind !== "image" && kind !== "video") return MEDIA_UNSCANNED;
  try {
    const model = await loadMediaModel();
    return kind === "image" ? await scanImage(model, objectUrl) : await scanVideo(model, objectUrl);
  } catch {
    return MEDIA_UNSCANNED;
  }
}

const IMAGE_EXT = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(?:m4v|mov|mp4|ogg|webm)$/i;

// A file the model cannot read is not a file the model can judge, so it comes
// back unscanned rather than allowed.
export async function scanMediaFile(file) {
  const type = file?.type || "";
  const name = file?.name || "";
  // file.type is empty for a lot of picked files, so the extension is the
  // reliable signal. Without this an explicit image with no MIME type sailed
  // straight past the upload check and was only caught on the way back in.
  const isImage = type.startsWith("image/") || (!type && IMAGE_EXT.test(name));
  const isVideo = type.startsWith("video/") || (!type && VIDEO_EXT.test(name));
  if (!isImage && !isVideo) return MEDIA_UNSCANNED;
  // Animated formats decode to one frame here, which is the frame that matters.
  if (type === "image/svg+xml" || /\.svg$/i.test(name)) return MEDIA_UNSCANNED;

  let objectUrl = "";
  try {
    const model = await loadMediaModel();
    objectUrl = URL.createObjectURL(file);
    return isImage ? await scanImage(model, objectUrl) : await scanVideo(model, objectUrl);
  } catch {
    return MEDIA_UNSCANNED;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
