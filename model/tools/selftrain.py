"""Round-2 labels: merge confident model predictions with the auto-labels.

The auto-labeller misses most balls held in hands; a model trained on its labels still finds many
of them. Predictions that agree with a neighbouring frame are added to the label set.
usage: selftrain.py <data_labelling/data/<video>> <weights.pt> [conf]  -> writes <video>/labels_r2/
"""
import glob, os, sys
import numpy as np
from ultralytics import YOLO

VID, weights = sys.argv[1], sys.argv[2]
conf = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
FR = sorted(glob.glob(f"{VID}/frames/*.jpg"))
model = YOLO(weights)

preds = []
for i in range(0, len(FR), 16):
    for r in model.predict(FR[i:i + 16], imgsz=640, conf=conf, device="mps", verbose=False):
        preds.append(r.boxes.xywhn.cpu().numpy())


def load(p):
    lp = f"{VID}/labels/" + os.path.basename(p)[:-4] + ".txt"
    rows = [list(map(float, l.split()[1:5])) for l in open(lp)] if os.path.exists(lp) else []
    return np.array(rows).reshape(-1, 4)


os.makedirs(f"{VID}/labels_r2", exist_ok=True)
added = 0
for t, p in enumerate(FR):
    boxes = load(p)
    nb = [preds[k] for k in (t - 1, t + 1) if 0 <= k < len(preds)]
    for b in preds[t]:
        size = max(b[2], b[3] * 9 / 16)
        near_label = len(boxes) and np.min(np.hypot(boxes[:, 0] - b[0], boxes[:, 1] - b[1])) < size
        near_prev = any(len(n) and np.min(np.hypot(n[:, 0] - b[0], n[:, 1] - b[1])) < 3 * size for n in nb)
        if not near_label and near_prev:
            boxes = np.vstack([boxes, b[None]])
            added += 1
    with open(f"{VID}/labels_r2/" + os.path.basename(p)[:-4] + ".txt", "w") as f:
        for x, y, w, h in boxes:
            f.write(f"0 {x:.5f} {y:.5f} {w:.5f} {h:.5f}\n")
print("added", added, "boxes from model predictions")
