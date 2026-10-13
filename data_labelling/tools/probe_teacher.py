"""Run a large pretrained COCO detector over frames and dump 'sports ball' boxes (teacher labels).
usage: probe_teacher.py data/<video>  -> data/<video>/teacher.json"""
import json, sys, glob
from ultralytics import YOLO

VID = sys.argv[1]
frames = sorted(glob.glob(f"{VID}/frames/*.jpg"))
model = YOLO("../model/pretrained/yolo11x.pt")
out = {}
for i in range(0, len(frames), 16):
    batch = frames[i:i + 16]
    for path, r in zip(batch, model.predict(batch, imgsz=960, conf=0.05, classes=[32], device="mps", verbose=False)):
        out[path] = [[*map(float, b.xyxy[0]), float(b.conf)] for b in r.boxes]
json.dump(out, open(f"{VID}/teacher.json", "w"))
n = sum(1 for v in out.values() if any(b[4] > 0.25 for b in v))
print("frames with ball conf>0.25:", n, "/", len(out))
print("total boxes >0.25:", sum(sum(b[4] > 0.25 for b in v) for v in out.values()))
