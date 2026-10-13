"""Rhythm gap-filling: inside a vision run, if two consecutive vision throws are ~k beats apart
(k >= 2, beat = median spacing in that run), add the audio events that land near the missing beat
positions. Everything else from audio is ignored."""
import json, sys
import numpy as np
from scipy.signal import find_peaks
sys.path.insert(0, "experiments")
import fusion
from audio_count import flux, taps, match, in_labelled, FPS

A = json.load(open("experiments/audio_params.json"))


def gapfill(vis, aud, tol=0.18, bridge=2.5):
    vis = sorted(vis); added = []
    runs, cur = [], [vis[0]] if vis else []
    for t in vis[1:]:
        if t - cur[-1] <= bridge: cur.append(t)
        else: runs.append(cur); cur = [t]
    if cur: runs.append(cur)
    for run in runs:
        if len(run) < 3: continue
        beat = float(np.median(np.diff(run)))
        for a, b in zip(run, run[1:]):
            k = round((b - a) / beat)
            if k < 2 or abs((b - a) / beat - k) > 0.35: continue
            for j in range(1, k):                    # each missing beat: take the nearest audio event
                slot = a + j * (b - a) / k
                cand = [x for x in aud if abs(x - slot) <= tol]
                if cand: added.append(min(cand, key=lambda x: abs(x - slot)))
    return sorted(vis + added), added


for v in ["IMG_0736", "IMG_0737", "IMG_0738"]:
    tr, segs = taps(v)
    pk, _ = find_peaks(flux(v, *A["band"]), height=A["thr"], distance=int(0.2 * FPS))
    aud = in_labelled([p / FPS - A["lag"] for p in pk], segs)
    vis = in_labelled(fusion.vision(v), segs)
    fused, added = gapfill(vis, aud)
    for name, pred in (("vision", vis), ("gap-fill", fused)):
        tp = match(pred, tr); P, R = tp / max(len(pred), 1), tp / len(tr)
        print(f"{v} {name:8s} counted {len(pred):3d}/{len(tr)} taps  precision {P:.2f}  recall {R:.2f}  F1 {2 * P * R / (P + R):.3f}")
    print(f"         added {len(added)}, real {match(added, [t for t in tr if all(abs(t - u) > 0.35 for u in vis)])}")
