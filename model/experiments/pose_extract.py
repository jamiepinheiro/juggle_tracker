"""Per-frame wrist/shoulder/nose keypoints for the main person (largest box), from YOLO11n-pose.
usage: pose_extract.py ../data_labelling/data/<video>  -> data/<video>/pose.json  {frame: [[x, y, conf] x 17] | null}"""
import os, sys; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
from paths import PRETRAINED
import glob, json, sys
from ultralytics import YOLO
VID = sys.argv[1]
FR = sorted(glob.glob(f"{VID}/frames/*.jpg"))
m = YOLO(f"{PRETRAINED}/yolo11n-pose.pt")
out = {}
for i in range(0, len(FR), 8):
    for k, r in enumerate(m.predict(FR[i:i + 8], imgsz=640, device="mps", verbose=False)):
        if r.keypoints is None or not len(r.boxes):
            out[i + k] = None; continue
        j = int(r.boxes.xywh[:, 2:].prod(1).argmax())   # biggest person = the juggler
        kp = r.keypoints.xyn[j].tolist(); c = r.keypoints.conf[j].tolist()
        out[i + k] = [[round(x, 4), round(y, 4), round(s, 3)] for (x, y), s in zip(kp, c)]
json.dump(out, open(f"{VID}/pose.json", "w"))
print(VID, "frames", len(out), "with person", sum(v is not None for v in out.values()))
