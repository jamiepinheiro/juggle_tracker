"""Can catch sounds count throws on their own? Peak-pick band-limited spectral flux, shift each
event back by the catch delay, and match to hand taps (0.35 s). Tune on 0736+0737, test on 0738.
Also report how many hand taps the vision counter missed but the audio caught."""
import os, sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from paths import DATA
import json, subprocess
import numpy as np, librosa
from scipy.signal import find_peaks

SR, HOP = 22050, 128
FPS = SR / HOP
TRAIN, TEST = ["IMG_0736", "IMG_0737"], ["IMG_0738"]


def flux(v, lo, hi):
    y, _ = librosa.load(f"{DATA}/audio/{v}.wav", sr=SR)
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=HOP))
    f = librosa.fft_frequencies(sr=SR, n_fft=1024)
    x = np.maximum(0, np.diff(np.log1p(S[(f >= lo) & (f < hi)].sum(0)), prepend=0))
    x = np.convolve(x, np.ones(3) / 3, "same")
    return (x - np.median(x)) / (np.percentile(x, 90) - np.median(x) + 1e-9)


def taps(v):
    segs = json.load(open(f"{DATA}/{v}/throws.labels.json"))["segments"]
    return np.array(sorted(t for s in segs for t in s["taps"])), segs


def match(pred, truth, tol=0.35):
    used, tp = set(), 0
    for p in pred:
        d = [abs(t - p) if i not in used else 9 for i, t in enumerate(truth)]
        if d and min(d) <= tol: used.add(int(np.argmin(d))); tp += 1
    return tp


def in_labelled(times, segs):
    end = max((s["end"] or s["start"]) for s in segs) + 1
    return [t for t in times if t <= end]


def score(vids, band, thr, lag):
    TP = P = T = 0
    for v in vids:
        x = flux(v, *band); tr, segs = taps(v)
        pk, _ = find_peaks(x, height=thr, distance=int(0.2 * FPS))
        pred = in_labelled([p / FPS - lag for p in pk], segs)
        TP += match(pred, tr); P += len(pred); T += len(tr)
    return TP / max(P, 1), TP / T, 2 * TP / (P + T)


best = None
for band in [(60, 400), (400, 2000), (2000, 8000), (400, 8000)]:
    for thr in [2, 3, 4, 5, 6, 8, 10]:
        for lag in [0.2, 0.25, 0.3]:
            p, r, f1 = score(TRAIN, band, thr, lag)
            if not best or f1 > best[0]: best = (f1, band, thr, lag, p, r)
f1, band, thr, lag, p, r = best
print(f"best on train: band {band} thr {thr} lag {lag}: precision {p:.2f} recall {r:.2f} F1 {f1:.2f}")
p, r, f1 = score(TEST, band, thr, lag)
print(f"held-out IMG_0738: precision {p:.2f} recall {r:.2f} F1 {f1:.2f}")
json.dump({"band": band, "thr": thr, "lag": lag}, open("experiments/audio_params.json", "w"))
