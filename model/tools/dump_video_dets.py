"""Run a model over a video file (as the browser sees it) and dump detections for run_counter.mjs.
usage: dump_video_dets.py <weights.pt> <video.mp4> out.json [conf]"""
import json, sys
import cv2
from ultralytics import YOLO
m = YOLO(sys.argv[1])
conf = float(sys.argv[4]) if len(sys.argv) > 4 else 0.35
cap = cv2.VideoCapture(sys.argv[2]); res = []
while True:
    ok, f = cap.read()
    if not ok:
        break
    r = m.predict(f, imgsz=640, conf=conf, verbose=False, device="mps")[0]
    H, W = r.orig_shape
    res.append([{"x": b[0] / W, "y": b[1] / H, "size": min(b[2], b[3]) / H, "score": c}
                for b, c in zip(r.boxes.xywh.tolist(), r.boxes.conf.tolist())])
json.dump({"fps": round(cap.get(cv2.CAP_PROP_FPS)) or 30, "frames": res}, open(sys.argv[3], "w"))
print("frames", len(res), "dets", sum(map(len, res)))
