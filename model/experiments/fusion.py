"""Vision + audio fusion: keep every vision throw; add an audio catch (shifted back to its apex)
only when vision has no throw within `near` s AND it falls inside a run vision already confirmed
(between vision throws less than `bridge` s apart, padded by `pad`). Reports per video."""
import json, subprocess, sys
import numpy as np
from scipy.signal import find_peaks
sys.path.insert(0, "experiments")
from audio_count import flux, taps, match, in_labelled, FPS

A = json.load(open("experiments/audio_params.json"))


def vision(v):
    out = subprocess.run(["node", "-e", f'''
import("./web/counter.js").then(({{JuggleCounter}}) => {{
  const {{fps, frames}} = JSON.parse(require("fs").readFileSync("eval/r3_{v[4:]}.json"));
  const c = new JuggleCounter(); const t = []; c.onThrow = (e) => t.push(e.t);
  frames.forEach((d, i) => c.update(d, i / fps)); console.log(JSON.stringify(t)); }});'''], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def fuse(vis, aud, near=0.3, bridge=2.5, pad=1.0):
    vis = sorted(vis)
    runs, cur = [], None
    for t in vis:
        if cur and t - cur[1] <= bridge: cur[1] = t
        else:
            cur = [t, t]; runs.append(cur)
    inside = lambda t: any(a - pad <= t <= b + pad for a, b in runs)
    add = [t for t in aud if inside(t) and all(abs(t - u) > near for u in vis)]
    return sorted(vis + add), add


rows = []
for v in ["IMG_0736", "IMG_0737", "IMG_0738"]:
    tr, segs = taps(v)
    x = flux(v, *A["band"])
    pk, _ = find_peaks(x, height=A["thr"], distance=int(0.2 * FPS))
    aud = in_labelled([p / FPS - A["lag"] for p in pk], segs)
    vis = in_labelled(vision(v), segs)
    fused, added = fuse(vis, aud)
    for name, pred in (("vision", vis), ("audio", aud), ("fused", fused)):
        tp = match(pred, tr)
        print(f"{v} {name:7s} counted {len(pred):3d}  taps {len(tr):3d}  precision {tp / max(len(pred), 1):.2f}  recall {tp / len(tr):.2f}")
    print(f"         audio added {len(added)}, of which {match(added, [t for t in tr if all(abs(t - u) > 0.35 for u in vis)])} were real missed throws")
