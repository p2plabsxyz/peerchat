// Runs the vendored models over an image or a video's frames: nsfwjs for
// explicit pictures and the safety model (lib/safety-model.js) for gore and
// graphic violence. The models and the libraries are all in lib/ rather than
// on a CDN: PeerChat has no build step, and a room should not need the open web
// to decide what it will accept.
import {
  MEDIA_ALLOWED,
  MEDIA_UNSCANNED,
  combineMediaVerdicts,
  isRefusedMedia,
  verdictFromPredictions,
  verdictFromSafety,
  videoSampleTimes,
} from "./media-moderation.js";

const MODEL_PATH = new URL("./nsfw-model/model.json", import.meta.url).href;
const LIBRARY_PATH = new URL("./nsfwjs.min.js", import.meta.url).href;
const TF_CORE_PATH = new URL("./tf-core.min.js", import.meta.url).href;
const SAFETY_SCRIPT_PATH = new URL("./safety-model.js", import.meta.url).href;
const SAFETY_MANIFEST_PATH = new URL("./safety-model/manifest.json", import.meta.url).href;
// No extension, like nsfwjs's weights: PeerSky serves an app's files only of the
// types it knows, and a file with none.
const SAFETY_WEIGHTS_PATH = new URL("./safety-model/weights", import.meta.url).href;
// What both vendored models were trained at.
const INPUT_SIZE = 224;

let modelPromise = null;
let safetyPromise = null;

function loadScript(src, loaded) {
  if (loaded()) return Promise.resolve(loaded());
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => (loaded() ? resolve(loaded()) : reject(new Error(`${src} did not load`)));
    script.onerror = () => reject(new Error(`${src} did not load`));
    document.head.appendChild(script);
  });
}

// Deliberately lazy. Most sessions never attach a file, and 5 MB of model has
// no business loading on startup.
export function loadMediaModel() {
  if (!modelPromise) {
    modelPromise = loadScript(LIBRARY_PATH, () => globalThis.nsfwjs)
      .then((nsfwjs) => nsfwjs.load(MODEL_PATH, { size: INPUT_SIZE }))
      .catch((error) => {
        modelPromise = null;
        throw error;
      });
  }
  return modelPromise;
}

// TensorFlow.js keeps one engine per page, on the global object, and nsfwjs
// brings its own copy with the CPU and WebGL backends in it. tf-core is the
// same version, 4.22.0, without backends: loaded after nsfwjs it runs on that
// engine and its backends, so the page holds one TensorFlow.js.
export function loadSafetyModel() {
  if (!safetyPromise) {
    safetyPromise = loadMediaModel()
      .then(() => loadScript(TF_CORE_PATH, () => globalThis.tf?.conv2d && globalThis.tf))
      .then(() => loadScript(SAFETY_SCRIPT_PATH, () => globalThis.createSafetyModel))
      .then(async (createSafetyModel) => {
        const [manifest, weights] = await Promise.all([
          fetch(SAFETY_MANIFEST_PATH).then((response) => response.json()),
          fetch(SAFETY_WEIGHTS_PATH).then((response) => response.arrayBuffer()),
        ]);
        return createSafetyModel(globalThis.tf, manifest, new Uint8Array(weights));
      })
      .catch((error) => {
        safetyPromise = null;
        throw error;
      });
  }
  return safetyPromise;
}

// Both models, or the nsfwjs one alone when the safety model cannot load: a
// picture is still checked for what that one knows.
async function loadModels() {
  const nsfw = await loadMediaModel();
  const safety = await loadSafetyModel().catch((error) => {
    console.warn("[PeerChat] the violent or graphic picture check could not start:", error?.message || error);
    return null;
  });
  return { nsfw, safety };
}

function drawToCanvas(source, width, height, quality = "low") {
  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = quality;
  context.drawImage(source, 0, 0, width, height, 0, 0, INPUT_SIZE, INPUT_SIZE);
  return canvas;
}

// nsfwjs is judged on the canvas it always had. The safety model learned from
// smoothly shrunk pictures, and a canvas's default shrink gave a gory photo
// little more than half the score the original model gives it.
async function classifySource(models, source, width, height) {
  const [predictions, safety] = await Promise.all([
    models.nsfw.classify(drawToCanvas(source, width, height)),
    models.safety ? models.safety.classify(drawToCanvas(source, width, height, "high")).catch(() => null) : null,
  ]);
  return combineMediaVerdicts(verdictFromPredictions(predictions), verdictFromSafety(safety));
}

async function scanImage(models, objectUrl) {
  const image = new Image();
  image.src = objectUrl;
  await image.decode();
  return classifySource(models, image, image.naturalWidth, image.naturalHeight);
}

async function scanVideo(models, objectUrl) {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = objectUrl;
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("video metadata could not be read"));
  });

  // Any refused frame condemns the clip, so this stops at the first one
  // rather than decoding the rest.
  for (const time of videoSampleTimes(video.duration)) {
    await new Promise((resolve, reject) => {
      video.onseeked = resolve;
      video.onerror = () => reject(new Error("video frame could not be read"));
      video.currentTime = time;
    });
    const verdict = await classifySource(models, video, video.videoWidth, video.videoHeight);
    if (isRefusedMedia(verdict)) return verdict;
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
    const models = await loadModels();
    return kind === "image" ? await scanImage(models, objectUrl) : await scanVideo(models, objectUrl);
  } catch {
    return MEDIA_UNSCANNED;
  }
}

// Kept in step with isImageFile and isVideoFile in app.js.
const IMAGE_EXT = /\.(?:avif|gif|heic|heif|jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(?:3gp|avi|m4v|mkv|mov|mp4|ogg|webm)$/i;

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
    const models = await loadModels();
    objectUrl = URL.createObjectURL(file);
    return isImage ? await scanImage(models, objectUrl) : await scanVideo(models, objectUrl);
  } catch {
    return MEDIA_UNSCANNED;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
