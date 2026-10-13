"""Score labels or models against hand-checked boxes (labels_manual) at the app's threshold.
A prediction matches a hand box when their centres are within 0.6 of the box size.
usage: eval_clean.py ../data_labelling/data/<video> [weights.pt ...]   (random = the unbiased random-sample frames)"""
import glob, json, os, sys
import numpy as np
from ultralytics import YOLO
from paths import DATA

VID = sys.argv[1]
queue = json.load(open(f"{VID}/review_queue.json"))["frames"]
why = {f["n"]: f["why"] for f in queue}
manual = {int(os.path.basename(p)[:-4]) - 1: p for p in glob.glob(f"{VID}/labels_manual/*.txt")}
cfg = json.load(open(os.path.join(DATA, "videos.json"))).get(os.path.basename(VID), {})


def load(p):
    return np.array([[float(v) for v in l.split()[1:5]] for l in open(p) if l.strip()]).reshape(-1, 4) if os.path.exists(p) else np.zeros((0, 4))


def score(pairs):
    tp = fp = fn = 0
    for truth, pred in pairs:
        used = set()
        for p in pred:
            d = [np.hypot(t[0] - p[0], (t[1] - p[1]) * 9 / 16) if i not in used else 9 for i, t in enumerate(truth)]
            if len(d) and min(d) < 0.6 * max(truth[int(np.argmin(d))][2], 0.02):
                used.add(int(np.argmin(d))); tp += 1
            else:
                fp += 1
        fn += len(truth) - len(used)
    return f"precision {tp / max(tp + fp, 1):.3f}  recall {tp / max(tp + fn, 1):.3f}  (tp {tp}, fp {fp}, fn {fn})"


for subset in ("all", "random"):
    frames = sorted(n for n in manual if subset == "all" or why.get(n) == "random")
    truth = [load(manual[n]) for n in frames]
    auto = [np.zeros((0, 4)) if any(a <= n + 1 < b for a, b in cfg.get("neg", [])) else load(f"{VID}/labels/{n + 1:05d}.txt") for n in frames]
    print(f"[{subset}: {len(frames)} frames, {sum(map(len, truth))} hand boxes]")
    print(f"  auto labels   {score(zip(truth, auto))}")
    for w in sys.argv[2:]:
        m = YOLO(w)
        preds = [r.boxes.xywhn.cpu().numpy() for r in m.predict([f"{VID}/frames/{n + 1:05d}.jpg" for n in frames], imgsz=640, conf=0.35, device="mps", verbose=False)]
        print(f"  {w.split('/')[-3]:12s}  {score(zip(truth, preds))}")
