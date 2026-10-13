"""Contact sheet of frames in a time range with model detections and hand taps marked, for checking
disagreements. usage: sheet.py data/<video> dets.json start_s end_s out.jpg [step] [taps.labels.json]"""
import json, sys
import cv2, numpy as np
vid, dets, a, b, out = sys.argv[1], json.load(open(sys.argv[2])), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
step = int(sys.argv[6]) if len(sys.argv) > 6 else 2
taps = []
if len(sys.argv) > 7:
    taps = [t for s in json.load(open(sys.argv[7]))["segments"] for t in s["taps"]]
fps = dets["fps"]; tiles = []
for f in range(int(a * fps), int(b * fps) + 1, step):
    im = cv2.imread(f"{vid}/frames/{f + 1:05d}.jpg")
    H, W = im.shape[:2]
    for d in dets["frames"][f]:
        cv2.circle(im, (int(d["x"] * W), int(d["y"] * H)), int(d["size"] * H / 2) + 6, (0, 255, 0), 3)
    tapped = any(abs(t - f / fps) <= step / fps / 2 for t in taps)
    cv2.putText(im, f"{f / fps:.2f}s" + ("  TAP" if tapped else ""), (10, 50), 0, 1.6, (0, 0, 255) if tapped else (255, 255, 255), 4)
    tiles.append(cv2.resize(im, (320, 180)))
while len(tiles) % 6: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i + 6]) for i in range(0, len(tiles), 6)]))
