"""Is there a catch/throw sound? Average the audio onset envelope around each hand-tapped throw
(taps are at the apex) and compare with random times. A real catch thump shows up as a peak at a
consistent lag. usage: audio_probe.py out.png"""
import os, sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from paths import DATA
import json, sys
import numpy as np, librosa
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

VIDS = ["IMG_0736", "IMG_0737", "IMG_0738"]
HOP, SR = 256, 22050
fig, axes = plt.subplots(1, 3, figsize=(18, 4), sharey=True)
rng = np.random.default_rng(0)
for ax, v in zip(axes, VIDS):
    y, _ = librosa.load(f"{DATA}/audio/{v}.wav", sr=SR)
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    env = (env - np.median(env)) / (np.percentile(env, 95) - np.median(env) + 1e-9)
    fps = SR / HOP
    segs = json.load(open(f"{DATA}/{v}/throws.labels.json"))["segments"]
    taps = [t for s in segs for t in s["taps"]]
    lags = np.arange(-int(1.0 * fps), int(1.0 * fps) + 1)
    def trig(times):
        rows = [env[int(t * fps) + lags] for t in times if 0 <= int(t * fps) + lags[0] and int(t * fps) + lags[-1] < len(env)]
        return np.mean(rows, 0), len(rows)
    m, n = trig(taps)
    # baseline: random times inside the labelled segments (same juggling context, unaligned)
    rand = [rng.uniform(s["start"], s["end"]) for s in segs if s["end"] for _ in range(max(s["count"], 1))]
    b, _ = trig(rand)
    ax.plot(lags / fps, m, label=f"around taps (n={n})")
    ax.plot(lags / fps, b, label="random times in segments", alpha=0.7)
    ax.axvline(0, color="k", lw=0.8); ax.set_title(v); ax.set_xlabel("seconds from tap (apex)"); ax.legend()
    pk = lags[np.argmax(m)] / fps
    print(f"{v}: peak at {pk:+.2f}s, height {m.max():.2f} vs baseline mean {b.mean():.2f} (std {b.std():.2f})")
axes[0].set_ylabel("onset strength (normalised)")
fig.tight_layout(); fig.savefig(sys.argv[1], dpi=80)
