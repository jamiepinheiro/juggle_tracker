"""Draw labels on a grid of frames for visual QA. usage: viz_labels.py data/<video> out.jpg start step [labels_subdir]"""
import sys, glob, os, cv2, numpy as np
vid, out, start, step = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
ldir = os.path.join(vid, sys.argv[5] if len(sys.argv) > 5 else "labels")
FR = sorted(glob.glob(f"{vid}/frames/*.jpg"))[start::step][:24]
tiles = []
for p in FR:
    img = cv2.imread(p); h, w = img.shape[:2]
    lp = os.path.join(ldir, os.path.basename(p)[:-4] + ".txt")
    for line in open(lp) if os.path.exists(lp) else []:
        _, cx, cy, bw, bh = map(float, line.split()[:5])
        cv2.rectangle(img, (int((cx - bw/2)*w), int((cy - bh/2)*h)), (int((cx + bw/2)*w), int((cy + bh/2)*h)), (0, 0, 255), 3)
    cv2.putText(img, os.path.basename(p), (10, 40), 0, 1.2, (0, 0, 255), 3)
    tiles.append(cv2.resize(img, (480, 270)))
while len(tiles) % 4: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(out, np.vstack([np.hstack(tiles[i:i+4]) for i in range(0, len(tiles), 4)]))
