# Experiments: does audio or pose help count throws?

Ground truth: hand-tapped throws (`data/<video>/throws.labels.json`). There are 40 in IMG_0736,
145 in the first 124 s of IMG_0737 and 41 in IMG_0738. Scores match each counted throw to a tap
within 0.35 s. Thresholds and lags were tuned on IMG_0736 + IMG_0737 only. **IMG_0738 is held out**:
a new room, evening light and different clothes. Vision = round-3 detector + `web/counter.js`.

## Audio: is there a catch sound? (`audio_probe2.py`)

Yes. Aligned to frame-accurate vision apexes, every video shows a sharp sound **0.21–0.34 s after
the apex**, 7–16 standard deviations above random moments, in all frequency bands. Further peaks
repeat at the juggling rhythm. Taps are too jittery (±0.1 s) to show it; vision apexes are needed.

Audio alone (`audio_count.py`, 2–8 kHz spectral flux, peak-picked, shifted back 0.25 s): F1 0.79
on the tuning videos and 0.81 held out (precision 0.68, recall 1.00). It catches throws vision
can't see, but it also counts other sounds.

## Pose: do wrist flicks mark throws? (`pose_extract.py`, `pose_count.py`)

YOLO11n-pose wrists, smoothed upward wrist speed, peak-picked, shifted 0.3 s to the apex.
Alone: F1 0.92 on the tuning videos and 0.80 held out.

## Combining (`fusion.py`, `fusion_gap.py`, `ensemble.py`)

| method | precision | recall | F1 (pooled) | F1 held-out 0738 |
|---|---|---|---|---|
| vision (shipped) | 0.950 | 0.845 | 0.895 | 0.895 |
| + every audio event inside vision runs | — | — | worse | 0.86 |
| + audio filling rhythm gaps | — | — | ≈ same | 0.897 |
| + wrist flicks filling rhythm gaps | 0.927 | 0.894 | 0.910 | 0.909 |
| **+ moments where audio AND pose agree (vote2)** | **0.941** | **0.925** | **0.933** | **0.927** |

The winner keeps every vision throw. It adds a throw wherever a catch sound and a wrist flick
agree within 0.15 s and vision has nothing within 0.3 s. Requiring both non-vision signals keeps
precision high, and recovers throws the camera loses (balls out of frame or blurred against the
body). On IMG_0738 it counts 41 of 41 tapped throws, against 35 for vision alone.

Caveats: one held-out video (41 throws), so the gain is about 6 throws. Audio was a phone mic in a
quiet room; a laptop mic, music or talking could hurt it.
