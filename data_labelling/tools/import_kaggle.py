"""Turn the Kaggle 'Juggling' dataset (smeschke, MIT) into YOLO training data.

The dataset has ~156 clips with a per-frame x,y for every ball (tracking_data/*.csv, columns
x0,y0,x1,y1,...). Labels are points, so each box needs a size: per clip, the median size of our
current model's detections that land on a tracked point (fallback 2.2% of frame height).
Every Nth frame is kept; whole clips are held out for validation (val clips are never trained on).
usage: import_kaggle.py <dataset_root> <weights.pt> [stride] [n_val_clips]
writes data/kaggle/{frames,labels}/<id>_<frame>.{jpg,txt}, data/kaggle/clips.json
"""
import csv, glob, json, os, random, re, sys
import cv2
import numpy as np
from ultralytics import YOLO

ROOT, W = sys.argv[1], sys.argv[2]
STRIDE = int(sys.argv[3]) if len(sys.argv) > 3 else 90
N_VAL = int(sys.argv[4]) if len(sys.argv) > 4 else 16
OUT = "data/kaggle"
idof = lambda p: re.search(r"_id_?(\d+)", os.path.basename(p)).group(1)
trk = {idof(p): p for p in glob.glob(f"{ROOT}/juggling_dataset/tracking_data/*.csv")}
vids = {idof(p): p for p in glob.glob(f"{ROOT}/juggling_dataset/source_videos/*")}
ids = sorted(vids.keys() & trk.keys())
random.Random(0).shuffle(ids)
val = set(ids[:N_VAL])
model = YOLO(W)
os.makedirs(f"{OUT}/frames", exist_ok=True); os.makedirs(f"{OUT}/labels", exist_ok=True)
clips, base_hits, base_total = {}, 0, 0
for k, cid in enumerate(ids):
    rows = [[float(x) for x in r] for r in list(csv.reader(open(trk[cid])))[1:]]
    cap = cv2.VideoCapture(vids[cid])
    frames = []
    for f in range(STRIDE // 2, len(rows), STRIDE):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, im = cap.read()
        if ok: frames.append((f, im))
    if not frames: continue
    H, Wd = frames[0][1].shape[:2]
    res = model.predict([im for _, im in frames], imgsz=640, conf=0.25, device="mps", verbose=False)
    sizes, hits, total, pts_all = [], 0, 0, []
    for (f, im), r in zip(frames, res):
        P = r.boxes.xywh.cpu().numpy()
        r_ = rows[f]
        pts = [(r_[2 * b], r_[2 * b + 1]) for b in range(len(r_) // 2)]
        pts = [(x, y) for x, y in pts if 0 <= x < Wd and 0 <= y < H]
        uniq = []
        for p in pts:                                        # balls stacked in a hand share a point
            if all(np.hypot(p[0] - q[0], p[1] - q[1]) > 4 for q in uniq): uniq.append(p)
        for x, y in uniq:
            d = np.hypot(P[:, 0] - x, P[:, 1] - y) if len(P) else np.array([])
            if len(d) and d.min() < 0.04 * H:
                hits += 1; j = int(d.argmin()); sizes.append(float(min(P[j, 2], P[j, 3])))
        total += len(uniq); pts_all.append((f, im, uniq))
    size = float(np.median(sizes)) if len(sizes) >= 5 else 0.022 * H
    if cid not in val: base_hits += hits; base_total += total
    for f, im, uniq in pts_all:
        name = f"{cid}_{f:05d}"
        cv2.imwrite(f"{OUT}/frames/{name}.jpg", im, [cv2.IMWRITE_JPEG_QUALITY, 92])
        with open(f"{OUT}/labels/{name}.txt", "w") as fh:
            for x, y in uniq:
                fh.write(f"0 {x / Wd:.5f} {y / H:.5f} {size / Wd:.5f} {size / H:.5f}\n")
    clips[cid] = {"split": "val" if cid in val else "train", "frames": len(pts_all), "size_px": round(size, 1),
                  "size_from": "model" if len(sizes) >= 5 else "default", "w": Wd, "h": H,
                  "baseline_recall": round(hits / max(total, 1), 3)}
    if k % 20 == 0:
        print(f"{k}/{len(ids)} clips", flush=True)
json.dump(clips, open(f"{OUT}/clips.json", "w"), indent=1)
n = sum(c["frames"] for c in clips.values())
print(f"clips {len(clips)} ({len(val)} val), frames {n}, boxes sized by model in "
      f"{sum(c['size_from'] == 'model' for c in clips.values())} clips; current model finds "
      f"{base_hits}/{base_total} = {base_hits / max(base_total, 1):.2f} of tracked balls zero-shot")
