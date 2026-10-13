"""Catch-sound probe, v2: align to frame-accurate vision apexes (counter on r3 detections) that
match a hand tap, and look per frequency band. Also: periodicity of the audio inside juggling
segments vs the tapped throw interval. usage: audio_probe2.py out.png"""
import os, sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from paths import DATA
import json, subprocess, sys
import numpy as np, librosa
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

SR, HOP = 22050, 128
BANDS = {"low 60-400 Hz": (60, 400), "mid 400-2k": (400, 2000), "high 2k-8k": (2000, 8000)}
VIDS = ["IMG_0736", "IMG_0737", "IMG_0738"]


def apexes(v):
    out = subprocess.run(["node", "-e", f'''
import("./web/counter.js").then(({{JuggleCounter}}) => {{
  const {{fps, frames}} = JSON.parse(require("fs").readFileSync("eval/r3_{v[4:]}.json"));
  const c = new JuggleCounter(); const t = []; c.onThrow = (e) => t.push(e.t);
  frames.forEach((d, i) => c.update(d, i / fps)); console.log(JSON.stringify(t)); }});'''], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


fig, axes = plt.subplots(2, 3, figsize=(18, 7))
rng = np.random.default_rng(0)
for col, v in enumerate(VIDS):
    y, _ = librosa.load(f"{DATA}/audio/{v}.wav", sr=SR)
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=1024)
    fps = SR / HOP
    segs = json.load(open(f"{DATA}/{v}/throws.labels.json"))["segments"]
    taps = np.array([t for s in segs for t in s["taps"]])
    ap = [a for a in apexes(v) if len(taps) and np.min(np.abs(taps - a)) < 0.35]   # confirmed throws
    lags = np.arange(-int(1.0 * fps), int(1.0 * fps) + 1)
    ax = axes[0, col]
    for name, (lo, hi) in BANDS.items():
        band = S[(freqs >= lo) & (freqs < hi)].sum(0)
        flux = np.maximum(0, np.diff(np.log1p(band), prepend=0))     # onset = rise in band energy
        flux = (flux - flux.mean()) / (flux.std() + 1e-9)
        trig = lambda ts: np.mean([flux[int(t * fps) + lags] for t in ts if lags[0] <= -int(t * fps) or True
                                   if 0 <= int(t * fps) + lags[0] and int(t * fps) + lags[-1] < len(flux)], 0)
        m = trig(ap)
        rand = [rng.uniform(s["start"], s["end"]) for s in segs if s["end"] for _ in range(max(s["count"], 1) * 3)]
        b = trig(rand)
        ax.plot(lags / fps, m, label=f"{name} (peak {lags[np.argmax(m)] / fps:+.2f}s, z {(m.max() - b.mean()) / (b.std() + 1e-9):.1f})")
        print(f"{v} {name:14s} n={len(ap)} peak {lags[np.argmax(m)] / fps:+.2f}s  height {m.max():.2f}  random {b.mean():.2f}±{b.std():.2f}")
    ax.axvline(0, color="k", lw=0.8); ax.set_title(f"{v}: audio around vision apexes"); ax.legend(fontsize=8); ax.set_xlabel("s from apex")
    # periodicity: autocorrelation of broadband flux inside juggling segments
    full = np.maximum(0, np.diff(np.log1p(S.sum(0)), prepend=0))
    ac_in = []
    for s in segs:
        if not s["end"] or s["end"] - s["start"] < 2: continue
        x = full[int(s["start"] * fps):int(s["end"] * fps)]; x = x - x.mean()
        a = np.correlate(x, x, "full")[len(x) - 1:]; ac_in.append(a[: int(1.5 * fps)] / (a[0] + 1e-9))
    ax2 = axes[1, col]
    if ac_in:
        L = min(map(len, ac_in)); ac = np.mean([a[:L] for a in ac_in], 0)
        ax2.plot(np.arange(L) / fps, ac)
    gaps = np.diff(taps); gaps = gaps[(gaps > 0.15) & (gaps < 1)]
    ax2.axvline(np.median(gaps), color="tab:red", label=f"median tap interval {np.median(gaps):.2f}s")
    ax2.set_title(f"{v}: audio autocorrelation in juggling segments"); ax2.legend(); ax2.set_xlabel("lag (s)"); ax2.set_ylim(-0.3, 0.6)
fig.tight_layout(); fig.savefig(sys.argv[1], dpi=75)
