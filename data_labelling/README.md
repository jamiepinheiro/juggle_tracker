# data_labelling

Turns juggling videos into YOLO training data for `model/`, plus ground-truth throw counts. Most
labels come out automatically. A browser tool fixes the ones that matter.

Run everything from this folder with the repo's Python environment (setup in
[`../model/README.md`](../model/README.md)): `../.venv/bin/python tools/<script>.py ...`.

```
tools/        auto-labelling, review queue, dataset builder, QA helpers, label server
web/          the labelling tool (label.html)
data/         videos, frames and labels (gitignored except the files listed below)
```

## Data layout

```
data/videos.json                  per-video settings (committed)
data/videos/<video>.MOV|.mp4      source videos; an .mp4 copy is what the labelling tool plays
data/<video>/frames/00001.jpg     extracted frames
data/<video>/labels/              automatic ball boxes (YOLO format)
data/<video>/labels_manual/       hand-checked ball boxes (committed)
data/<video>/throws.labels.json   hand-tapped throws (committed)
data/ds/                          the built YOLO dataset that model/ trains on
data/kaggle/                      frames + labels imported from the Kaggle "Juggling" dataset
```

`videos.json` holds each video's settings:

- `neg`: frame ranges with no juggling. Auto labels there are junk, so those frames become
  negatives.
- `val`: a contiguous held-out block.
- `stride`: training uses every Nth frame.

## Adding a video

1. Extract frames:
   `ffmpeg -i data/videos/IMG_xxxx.MOV -vf scale=960:-2 -q:v 3 data/IMG_xxxx/frames/%05d.jpg`.
   For the labelling tool, also make a playable copy:
   `ffmpeg -i data/videos/IMG_xxxx.MOV -vf scale=960:-2 data/videos/IMG_xxxx.mp4`.
2. `tools/probe_teacher.py data/IMG_xxxx` runs a large pretrained COCO detector (YOLO11x, "sports
   ball") to propose boxes. Once a ball model exists, skip this and pass that model to step 3.
3. `tools/autolabel.py data/IMG_xxxx [ball.pt]` combines several sources:
   - the teacher and student boxes;
   - colour blobs (the blue beanbags);
   - motion blobs (background subtraction, which catches the white side).

   Anything on the person's segmentation mask is dropped. Boxes are kept only if they persist
   across neighbouring frames. The colour range (`93–104` hue) is tuned for blue balls, so adjust
   it for other colours. `tools/drop_static.py` drops boxes on static scenery, such as bookshelf spines.
4. Add the video to `data/videos.json`.
5. Optionally, label by hand (below).
6. `tools/build_dataset.py [labels_subdir]` builds `data/ds/` from every video in `videos.json`.
   It uses hand-checked boxes ahead of auto labels, and adds the Kaggle clips if they're imported.
   Then train in `model/`.

`tools/import_kaggle.py <dataset_root> <weights.pt>` imports the Kaggle "Juggling" dataset
(smeschke, MIT). It gives other people, rooms and balls. Whole clips are held out for validation.

## Labelling by hand

```bash
../.venv/bin/python tools/label_server.py      # http://localhost:5175/label.html
```

The server saves straight into `data/<video>/`. Pick a project video from the dropdown.

- **Ball boxes** help the detector most.
  - `tools/review_queue.py data/<video> <weights.pt>` builds the queue. It picks frames where the
    model and the auto labels disagree, frames where the model is unsure, and a random sample.
  - Each frame is pre-filled, with the model's suggestions drawn dashed. Fix the boxes and press
    Enter.
  - Saved frames go to `labels_manual/`. `build_dataset.py` puts the random-sample ones in
    validation, so the model is scored on clean labels.
- **Throws** are the ground truth for the counter.
  - Tap J at the top of each arc. Taps go to `throws.labels.json`.
  - Press M to overlay the model's throws, and X to jump to the next disagreement.

QA helpers:

- `tools/viz_labels.py` draws a grid of labelled frames.
- `tools/sheet.py` makes a contact sheet of detections against tapped throws.
