"""Ensemble of vision apexes, catch sounds and wrist flicks (each shifted to apex time).
  vote2:      vision throws + any moment where audio AND pose agree (within `win`) and vision doesn't
  gap+vote2:  rhythm gap-filling with audio+pose agreements only
Parameters come from the train videos (audio_params.json, pose thr/lag); scored on all three."""
import json, sys, io, contextlib
import numpy as np
from scipy.signal import find_peaks
with contextlib.redirect_stdout(io.StringIO()):   # the sibling scripts print their own results on import
    sys.path.insert(0, "experiments")
    from audio_count import flux, taps, match, in_labelled, FPS as AFPS
    import fusion
    from fusion_gap import gapfill
    import pose_count

A = json.load(open("experiments/audio_params.json"))
PTHR, PLAG = 1.5, 0.3


def agree(a, b, win=0.15):
    return [(x + min(b, key=lambda y: abs(y - x))) / 2 for x in a if b and min(abs(y - x) for y in b) <= win]


tot = {}
for v in ["IMG_0736", "IMG_0737", "IMG_0738"]:
    tr, segs = taps(v)
    pk, _ = find_peaks(flux(v, *A["band"]), height=A["thr"], distance=int(0.2 * AFPS))
    aud = in_labelled([p / AFPS - A["lag"] for p in pk], segs)
    pose = in_labelled(pose_count.events(v, PTHR, PLAG), segs)
    vis = in_labelled(fusion.vision(v), segs)
    ap = agree(aud, pose)
    vote2 = sorted(vis + [t for t in ap if all(abs(t - u) > 0.3 for u in vis)])
    gapv, _ = gapfill(vis, ap, tol=0.2)
    gapp, _ = gapfill(vis, pose, tol=0.2)
    for name, pred in (("vision", vis), ("+pose gaps", gapp), ("vote2", vote2), ("gap+vote2", gapv)):
        tp = match(pred, tr); P, R = tp / max(len(pred), 1), tp / len(tr)
        t = tot.setdefault(name, [0, 0, 0]); t[0] += tp; t[1] += len(pred); t[2] += len(tr)
        print(f"{v} {name:11s} counted {len(pred):3d}/{len(tr)}  precision {P:.2f} recall {R:.2f} F1 {2 * P * R / (P + R):.3f}")
print("-- all three videos pooled")
for name, (tp, p, t) in tot.items():
    P, R = tp / p, tp / t
    print(f"   {name:11s} precision {P:.3f} recall {R:.3f} F1 {2 * P * R / (P + R):.3f}")
