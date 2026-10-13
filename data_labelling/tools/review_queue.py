"""Pick the frames most worth hand-checking, and precompute the hints label.html shows.

usage: review_queue.py data/<video> <weights.pt> [n_hard] [n_random]
Writes, in data/<video>/:
  predictions.json   model boxes per frame (conf >= 0.15), shown as dashed hints in Boxes mode
  model_throws.json  throws the counter flags on those predictions, shown in Throws mode
  review_queue.json  {frames: [{n, why}], ...}. First, if throws.labels.json exists: frames from the
                     climb of each hand-tapped throw the counter missed (the ball is there but the
                     model doesn't see it). Then the frames where the model and the auto-labels
                     disagree or the model is unsure, interleaved with a uniform random sample. The
                     random ones are tagged so they can serve as a clean test set.
"""
import glob, json, os, random, subprocess, sys
import numpy as np
from ultralytics import YOLO

VID, W = sys.argv[1], sys.argv[2]
N_HARD = int(sys.argv[3]) if len(sys.argv) > 3 else 250
N_RAND = int(sys.argv[4]) if len(sys.argv) > 4 else 60
FPS = 30
DEVICE = os.environ.get("DEVICE", "mps")  # DEVICE=cpu while something else is training on the GPU
FR = sorted(glob.glob(f"{VID}/frames/*.jpg"))
model = YOLO(W)

preds, shape = {}, None
for i in range(0, len(FR), 8):
    for k, r in enumerate(model.predict(FR[i:i + 8], imgsz=640, conf=0.15, device=DEVICE, verbose=False)):
        shape = r.orig_shape
        preds[i + k] = [[round(v, 5) for v in b] + [round(c, 3)]
                        for b, c in zip(r.boxes.xywhn.tolist(), r.boxes.conf.tolist())]
    if i % 800 == 0:
        print(f"predict {i}/{len(FR)}", flush=True)
json.dump(preds, open(f"{VID}/predictions.json", "w"))

# throws the app would count on these predictions (same counter as the browser)
h, w = shape
dets = {"fps": FPS, "frames": [[{"x": p[0], "y": p[1], "size": min(p[2] * w, p[3] * h) / h, "score": p[4]}
                                 for p in preds[i] if p[4] >= 0.35] for i in range(len(FR))]}
tmp = f"{VID}/.dets_tmp.json"
json.dump(dets, open(tmp, "w"))
subprocess.run(["node", "../model/tools/run_counter.mjs", tmp, f"{VID}/.throws_tmp.json"], check=True, capture_output=True)
frames = json.load(open(f"{VID}/.throws_tmp.json"))
json.dump({"times": [round(f / FPS, 3) for f in frames]}, open(f"{VID}/model_throws.json", "w"))
os.remove(tmp); os.remove(f"{VID}/.throws_tmp.json")


CFG = json.load(open("data/videos.json")).get(os.path.basename(VID.rstrip("/")), {})
NEG = CFG.get("neg", [])


def labels(n):
    if any(a <= n < b for a, b in NEG) and not os.path.exists(f"{VID}/labels_manual/{n + 1:05d}.txt"):
        return np.zeros((0, 4))  # no juggling here: auto labels are junk
    for sub in ("labels_manual", "labels"):
        p = f"{VID}/{sub}/{n + 1:05d}.txt"
        if os.path.exists(p):
            return np.array([[float(v) for v in l.split()[1:5]] for l in open(p) if l.strip()]).reshape(-1, 4)
    return np.zeros((0, 4))


def score(n):
    L, P = labels(n), np.array(preds[n]).reshape(-1, 5)
    sure, unsure = P[P[:, 4] >= 0.4], P[P[:, 4] < 0.4]
    def unmatched(A, B):
        return sum(1 for a in A if not len(B) or np.min(np.hypot(B[:, 0] - a[0], B[:, 1] - a[1])) > 0.6 * max(a[2], 0.02))
    return unmatched(L, sure) + unmatched(sure, L) + 0.5 * len(unsure)


# throws you tapped that the counter missed: label the ball on its way up to the apex
missed = []
tp = f"{VID}/throws.labels.json"
model_times = [f / FPS for f in frames]
taken = set()
if os.path.exists(tp):
    taps = [t for seg in json.load(open(tp))["segments"] for t in seg.get("taps", [])]
    for t in taps:
        if any(abs(t - m) <= 0.35 for m in model_times):
            continue
        for dt in (-0.3, -0.15, 0.0):     # climbing towards the apex, and the apex itself
            n = round((t + dt) * FPS)
            if 0 <= n < len(FR) and all(abs(n - m) >= 3 for m in taken):
                missed.append({"n": n, "why": "missed-throw"}); taken.add(n)

scores = sorted(((score(n), n) for n in range(len(FR))), reverse=True)
hard = []
for s, n in scores:
    if s <= 0 or len(hard) >= N_HARD:
        break
    if all(abs(n - m) >= 10 for m in taken):  # spread out: neighbours are near-duplicates
        hard.append({"n": n, "why": "disagree"}); taken.add(n)
rng = random.Random(0)
pool = [n for n in range(len(FR)) if all(abs(n - m) >= 5 for m in taken)]
rand = [{"n": n, "why": "random"} for n in sorted(rng.sample(pool, min(N_RAND, len(pool))))]
queue = []
for i, item in enumerate(hard):  # every 5th item is a random frame, so stopping early still samples both
    queue.append(item)
    if i % 4 == 3 and rand:
        queue.append(rand.pop(0))
queue += rand
queue = missed + queue
json.dump({"frames": queue, "model": W}, open(f"{VID}/review_queue.json", "w"))
print(f"queue: {len(queue)} frames ({len(missed)} from missed throws, {len(hard)} hard), model throws: {len(frames)}")
