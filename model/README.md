# model

The YOLO11n juggling-ball detector: training, evaluation and releases. Also here:

- `web/counter.js`, the reference throw counter. The iOS app and the Claude plugin port it.
- A browser demo that runs both.

```
current -> releases/r3     the release every app uses (committed symlink)
releases/<version>/        downloaded or exported models (gitignored)
fetch.sh                   download a release from GitHub
release.sh                 export a trained model and publish it as a GitHub release
tools/                     training, export and evaluation scripts
web/                       browser demo + inspector, and counter.js
experiments/               audio / pose counting experiments (see experiments/RESULTS.md)
tests/                     counter unit tests (npm test)
runs/, eval/, pretrained/  training output, detection dumps, stock Ultralytics weights (gitignored)
```

## Releases

Every model is a GitHub release named `model-<version>` with three assets:

| Asset | Used by |
|---|---|
| `ball.onnx` | Claude plugin and browser demo. 640×384 input, since webcams are 16:9. |
| `BallModel.mlpackage.zip` | iOS app. 640×640 input, since the phone may be in portrait. NMS is left out because exporting with it fails on current torch/coremltools; the app decodes the raw output. |
| `ball.pt` | Ultralytics weights, for fine-tuning or re-exporting. |

```bash
model/fetch.sh            # download the release model/current points to (or: model/fetch.sh r3)
model/release.sh r4 runs/r4/weights/best.pt   # export + upload model-r4, point current at it
```

`fetch.sh` reads the repo from the `origin` remote, or from `JUGGLE_REPO=<owner>/<repo>`.
`release.sh` needs the GitHub CLI (`gh`), logged in. To publish a release that's already exported
in `releases/<version>/`, leave out the weights: `model/release.sh r3`. After a release, commit
the `current` link and rebuild the iOS app.

The shipped release is **r3**: YOLO11n trained on frames from `IMG_0736` and `IMG_0737`. Run
through the iOS app's pipeline (`ios/eval/run.sh`):

| Video | Throws counted / labelled | Runs / attempts | Error |
|---|---|---|---|
| `IMG_0736` | 43 / 38 | 9 / 9 | 7 |
| `IMG_0737` (labelled first 124 s) | 125 / 145 | 23 / 23 | 34 |
| `IMG_0738` (not in training) | 35 / 41 | 5 / 5 | 6 |

Error is the per-attempt miscounts plus any throws counted outside an attempt.

## Setup

One Python environment at the repo root serves `model/` and `data_labelling/`:

```bash
python3.11 -m venv .venv && .venv/bin/pip install -r model/requirements.txt   # from the repo root
cd model && npm install          # onnxruntime-web for the browser demo; node for the counter tools
```

Run the scripts below from `model/`. They find the labelled data in `../data_labelling/data`.
Stock Ultralytics weights (`yolo11n.pt` etc.) download into `pretrained/` the first time they're
used.

## Training

1. Build the dataset in `data_labelling/` (`tools/build_dataset.py`).
2. `../.venv/bin/python tools/train.py <run> [epochs] [init.pt]` fine-tunes YOLO11n with heavy
   colour/scale augmentation. Output goes to `runs/<run>/weights/best.pt`.
3. Score it (below), then `./release.sh <version> runs/<run>/weights/best.pt`.

`tools/selftrain.py <video_dir> <weights.pt>` is an optional second round. Confident predictions
that agree across neighbouring frames are merged into the auto labels (`labels_r2/`).

## Evaluation

- `tools/eval_clean.py ../data_labelling/data/<video> <weights.pt> ...` gives precision and recall
  against the hand-checked boxes, including the unbiased random sample.
- `tools/eval_kaggle.py <weights.pt>` gives detection on the held-out Kaggle clips (other people,
  rooms and balls).
- `tools/dump_dets.py model <weights> out.json [conf] [frames_glob]` then
  `node tools/eval_counts.mjs out.json <throws.labels.json>` scores the counter against hand-tapped
  throws. `tools/run_counter.mjs` replays detections through `web/counter.js`.
- `tools/plot_traj.py` plots ball height over time, where every throw is an arc.
- `../ios/eval/run.sh <video.MOV> ...` runs the iOS app's exact detector, engine and counter on
  a video.
- `npm test` runs the counter's unit tests on synthetic cascades.

## Browser demo

```bash
npm run vendor && npm run serve   # http://localhost:5173
```

`index.html` counts live from the webcam, or exactly from a video file (**Count a video file**),
and keeps run history in localStorage. A run ends after 1.5 s with no throw.

`inspect.html` runs the same model and counter and shows what they decide:

- Every detection, with its confidence, including those under the threshold.
- A trail for each tracked ball.
- A live height-over-time chart with counted throws and dropped duplicate apexes.
- A log of every throw, with the rule that counted it.
- Sliders for the threshold and the minimum climb.

## Experiments

`experiments/` tests whether audio (catch sounds) or pose (wrist flicks) helps count throws.
Results are in [`experiments/RESULTS.md`](experiments/RESULTS.md). The scripts need
`../data_labelling/data/audio/<video>.wav`, made with `ffmpeg -i <video> -ac 1 <video>.wav`. They
also need detection dumps in `eval/` from `tools/dump_video_dets.py`.
