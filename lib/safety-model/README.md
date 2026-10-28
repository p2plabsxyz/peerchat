# The safety model

`manifest.json` and `weights` hold image-safety-classifier-s, which
`lib/safety-model.js` runs to say how likely a picture is to show gore or graphic
violence. PeerChat refuses or hides a picture whose NSFL score is 0.3 or more
(`GRAPHIC_THRESHOLD` in `lib/media-moderation.js`).

- The model: [image-safety-classifier-s](https://huggingface.co/OwenElliott/image-safety-classifier-s)
  by Owen Elliott, revision 015042b, MIT License. Three classes: NSFL, NSFW and
  SFW. It takes a 224 by 224 picture.
- It is SwiftFormer-S, trained from the
  [SwiftFormer](https://github.com/Amshaker/SwiftFormer) ImageNet weights,
  Apache License 2.0.
- `lib/tf-core.min.js` is `dist/tf-core.min.js` from the npm package
  `@tensorflow/tfjs-core@4.22.0`, Apache License 2.0. It is the TensorFlow.js
  that nsfwjs brings, without backends, so the model runs on nsfwjs's engine.

## How the files were made

```sh
node scripts/build-safety-model.mjs model.safetensors
```

from the model's `model.safetensors` at that revision. The script folds every
batch norm, layer scale and the attention scale into the convolution or matrix
next to it, and averages the two heads, so the forward pass is plain
convolutions and matrix products. Tensors of 65 values or more are stored as
16-bit floats and the rest as 32-bit, in the order the forward pass uses them:
11 MB, half the original.

`weights` has no extension because PeerSky serves an app's files only of the
types it knows, and a file with none.

## How close it stays to the original

Over 324 pictures, ordinary photos and screenshots among them, no class
probability moved more than 0.004 from the original model run in ONNX Runtime,
and no picture changed sides of the 0.3 line. `test/safety-model.test.js` checks
two generated pictures against the original's answers on every run.

8-bit weights would have been 6 MB, but they moved scores by up to 0.14, which
is enough to carry a picture near the line across it.
