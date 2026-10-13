"""Auto-label juggling balls in extracted frames.

Combines weak signals into YOLO-format labels:
  1. teacher (optional): large pretrained COCO detector, class 'sports ball' (probe_teacher.py).
     Once a ball model exists, the student below is far better and this can be skipped.
  2. student (optional): a ball model trained on earlier videos, confident boxes only
  3. color: saturated-blue blobs outside the person segmentation mask
  4. motion: background-subtraction blobs outside the person mask (catches the white side)
  5. temporal: a candidate must have a nearby candidate in an adjacent frame
usage: autolabel.py data/<video> [student.pt]
Writes data/<video>/labels/<frame>.txt and data/<video>/candidates.json.
"""
import glob, json, os, sys
import cv2
import numpy as np
from ultralytics import YOLO

VID = sys.argv[1]
FR = sorted(glob.glob(f"{VID}/frames/*.jpg"))
tpath = f"{VID}/teacher.json"
teacher = {os.path.basename(k): v for k, v in json.load(open(tpath)).items()} if os.path.exists(tpath) else {}
seg = YOLO("../model/pretrained/yolo11x-seg.pt")
student = YOLO(sys.argv[2]) if len(sys.argv) > 2 else None


def person_mask(results, shape):
    m = np.zeros(shape[:2], np.uint8)
    if results.masks is None:
        return m
    for cls, poly in zip(results.boxes.cls.tolist(), results.masks.xy):
        if int(cls) == 0 and len(poly) > 2:
            cv2.fillPoly(m, [poly.astype(np.int32)], 255)
    return m


BALL = 40  # typical ball size in px at 960 wide (median teacher box)
bgsub = cv2.createBackgroundSubtractorMOG2(history=90, varThreshold=40, detectShadows=False)


def blobs(mask, pmask, min_area, max_area, score):
    h = mask.shape[0]
    mask[pmask > 0] = 0
    mask[int(h * 0.93):] = 0  # bottom strip is always shirt/arms
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    return [[float(x), float(y), float(x + w), float(y + h), score]
            for x, y, w, h, area in stats[1:]
            if min_area <= area <= max_area and 0.4 < w / h < 2.5 and max(w, h) < 2.2 * BALL]


def candidates(img, pmask):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    color = cv2.inRange(hsv, (93, 110, 110), (104, 255, 255))
    motion = bgsub.apply(img)
    # moving silhouette edges (hair, shoulders) fool bgsub, so keep motion blobs well clear of the person
    pm = cv2.dilate(pmask, np.ones((31, 31), np.uint8))
    return blobs(color, pmask.copy(), 60, 4000, 0.0) + blobs(motion, pm, 150, 3500, -1.0)


def merge(boxes):
    """Union boxes whose centres are closer than a ball diameter; confident boxes win."""
    boxes = sorted(boxes, key=lambda b: -b[4])
    out = []
    for b in boxes:
        for o in out:
            if np.linalg.norm(ctr(b) - ctr(o)) < BALL * 0.9:
                if o[4] < 0.3:  # grow non-teacher boxes to cover fragments
                    o[:4] = [min(o[0], b[0]), min(o[1], b[1]), max(o[2], b[2]), max(o[3], b[3])]
                break
        else:
            out.append(list(b))
    return out


def ctr(b):
    return np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


cands = []
B = 4  # small batches: big MPS batches of the x-size models have hung this machine
for i in range(0, len(FR), B):  # sequential order matters for bgsub
    if i % 400 == 0:
        print(f"autolabel {i}/{len(FR)}", flush=True)
    batch = FR[i:i + B]
    imgs = [cv2.imread(p) for p in batch]
    stud = (student.predict(imgs, imgsz=640, conf=0.5, device="mps", verbose=False)
            if student else [None] * len(imgs))
    for p, img, r, st in zip(batch, imgs, seg.predict(imgs, imgsz=640, classes=[0], device="mps", verbose=False), stud):
        boxes = [b for b in teacher.get(os.path.basename(p), []) if b[4] > 0.3]
        if st is not None:  # student boxes rank like confident teacher boxes (score 0.3-1 -> kept)
            boxes += [[*map(float, xy), 0.31 + 0.69 * float(c)] for xy, c in zip(st.boxes.xyxy.tolist(), st.boxes.conf.tolist())]
        cands.append(merge(boxes + candidates(img, person_mask(r, img.shape))))

# temporal consistency: keep boxes with a neighbour within 80px in frame t-1 or t+1,
# confident teacher boxes are always kept

kept = []
for t, boxes in enumerate(cands):
    nb = (cands[t - 1] if t else []) + (cands[t + 1] if t + 1 < len(cands) else [])
    prev = cands[t - 1] if t else []
    nxt = cands[t + 1] if t + 1 < len(cands) else []
    near = lambda b, fr: any(np.linalg.norm(ctr(b) - ctr(o)) < 80 for o in fr)
    kept.append([b for b in boxes if b[4] > 0.6
                 or (b[4] >= 0 and (near(b, prev) or near(b, nxt)))
                 or (near(b, prev) and near(b, nxt))])  # motion-only: needs both neighbours

os.makedirs(f"{VID}/labels", exist_ok=True)
h, w = cv2.imread(FR[0]).shape[:2]
for p, boxes in zip(FR, kept):
    with open(f"{VID}/labels/" + os.path.basename(p).replace(".jpg", ".txt"), "w") as f:
        for x1, y1, x2, y2, _ in boxes:
            # square-ish box padded a little: blobs from color are tight
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            s = float(np.clip(max(x2 - x1, y2 - y1), 0.75 * BALL, 1.4 * BALL))
            f.write(f"0 {cx / w:.5f} {cy / h:.5f} {s / w:.5f} {s / h:.5f}\n")
json.dump(dict(zip(FR, kept)), open(f"{VID}/candidates.json", "w"))
print("frames with labels:", sum(bool(k) for k in kept), "boxes:", sum(map(len, kept)))
