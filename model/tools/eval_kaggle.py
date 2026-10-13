"""Detection precision/recall on the held-out Kaggle clips (whole clips never trained on).
A detection matches a tracked ball if its centre is within 1.5 ball-sizes.
usage: eval_kaggle.py <weights.pt> [device]"""
import glob, json, sys
import numpy as np
from ultralytics import YOLO
from paths import DATA
W = sys.argv[1]; dev = sys.argv[2] if len(sys.argv) > 2 else "mps"
clips = json.load(open(f"{DATA}/kaggle/clips.json"))
files = [p for cid, c in clips.items() if c["split"] == "val" for p in sorted(glob.glob(f"{DATA}/kaggle/frames/{cid}_*.jpg"))]
m = YOLO(W); tp = fp = fn = 0
for i in range(0, len(files), 16):
    for p, r in zip(files[i:i + 16], m.predict(files[i:i + 16], imgsz=640, conf=0.35, device=dev, verbose=False)):
        T = np.array([[float(v) for v in l.split()[1:5]] for l in open(p.replace("/frames/", "/labels/")[:-4] + ".txt")]).reshape(-1, 4)
        P = r.boxes.xywhn.cpu().numpy(); used = set()
        for q in P:
            d = [np.hypot(t[0] - q[0], t[1] - q[1]) if j not in used else 9 for j, t in enumerate(T)]
            if len(d) and min(d) < 1.5 * max(T[int(np.argmin(d))][3], 0.01):
                used.add(int(np.argmin(d))); tp += 1
            else: fp += 1
        fn += len(T) - len(used)
print(f"{W}: held-out Kaggle clips {len(files)} frames: precision {tp / max(tp + fp, 1):.3f} recall {tp / max(tp + fn, 1):.3f} (tp {tp} fp {fp} fn {fn})")
