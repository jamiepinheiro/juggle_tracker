"""Do wrist flicks mark throws? A throw is a fast upward wrist motion ending at release; the apex
follows ~lag later. Peak-pick upward wrist speed (either hand), shift to apex, match to taps.
Tune on 0736+0737, test on 0738; then use it to fill rhythm gaps in the vision count."""
import os, sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from paths import DATA
import json, sys
import numpy as np
from scipy.signal import find_peaks, savgol_filter
sys.path.insert(0, "experiments")
from audio_count import taps, match, in_labelled
import fusion
from fusion_gap import gapfill

FPS = 30
TRAIN, TEST = ["IMG_0736", "IMG_0737"], ["IMG_0738"]


def wrist_speed(v):
    P = json.load(open(f"{DATA}/{v}/pose.json"))
    n = len(P); out = []
    for kp in (9, 10):                       # COCO left / right wrist
        y = np.full(n, np.nan)
        for i in range(n):
            p = P[str(i)]
            if p and p[kp][2] > 0.3: y[i] = p[kp][1]
        idx = np.arange(n); ok = ~np.isnan(y)
        if ok.sum() < 10: out.append(np.zeros(n)); continue
        y = np.interp(idx, idx[ok], y[ok])
        y = savgol_filter(y, 7, 2)
        out.append(np.maximum(0, -np.gradient(y) * FPS))   # upward speed, frame-heights per s
    return out


def events(v, thr, lag):
    ev = []
    for s in wrist_speed(v):
        pk, _ = find_peaks(s, height=thr, distance=int(0.25 * FPS))
        ev += [p / FPS + lag for p in pk]
    return sorted(ev)


def score(vids, thr, lag):
    TP = P = T = 0
    for v in vids:
        tr, segs = taps(v); pred = in_labelled(events(v, thr, lag), segs)
        TP += match(pred, tr); P += len(pred); T += len(tr)
    p, r = TP / max(P, 1), TP / T
    return p, r, 2 * p * r / max(p + r, 1e-9)


best = max(((score(TRAIN, thr, lag), thr, lag) for thr in [0.5, 0.8, 1.0, 1.5, 2.0, 2.5, 3.0]
            for lag in [0.1, 0.2, 0.3, 0.4]), key=lambda x: x[0][2])
(p, r, f1), thr, lag = best
print(f"pose only, best on train: thr {thr} lag {lag}: precision {p:.2f} recall {r:.2f} F1 {f1:.2f}")
p, r, f1 = score(TEST, thr, lag)
print(f"pose only, held-out IMG_0738: precision {p:.2f} recall {r:.2f} F1 {f1:.2f}")
for v in TRAIN + TEST:
    tr, segs = taps(v)
    vis = in_labelled(fusion.vision(v), segs)
    fused, added = gapfill(vis, in_labelled(events(v, thr, lag), segs), tol=0.2)
    for name, pred in (("vision", vis), ("+pose gaps", fused)):
        tp = match(pred, tr); P, R = tp / max(len(pred), 1), tp / len(tr)
        print(f"  {v} {name:10s} counted {len(pred):3d}/{len(tr)}  precision {P:.2f} recall {R:.2f} F1 {2 * P * R / (P + R):.3f}")
