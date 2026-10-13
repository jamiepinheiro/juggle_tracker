"""Dump per-frame ball detections as JSON for the JS counter.
usage: dump_dets.py labels <labels_dir> out.json
       dump_dets.py model <weights.pt|.onnx> out.json [conf] [frames_glob]"""
import glob, json, os, sys
from paths import DATA
mode, src, out = sys.argv[1:4]
fg = sys.argv[5] if len(sys.argv) > 5 else f"{DATA}/IMG_0736/frames/*.jpg"
frames = sorted(glob.glob(fg))
res = []
if mode == "labels":
    for p in frames:
        lp = os.path.join(src, os.path.basename(p)[:-4] + ".txt")
        dets = []
        for l in open(lp) if os.path.exists(lp) else []:
            _, x, y, w, h = map(float, l.split()[:5])
            dets.append({"x": x, "y": y, "size": h, "score": 1})
        res.append(dets)
else:
    from ultralytics import YOLO
    conf = float(sys.argv[4]) if len(sys.argv) > 4 else 0.35
    m = YOLO(src, task="detect")
    for i in range(0, len(frames), 16):
        for r in m.predict(frames[i:i + 16], imgsz=640, conf=conf, verbose=False, device="mps" if src.endswith(".pt") else "cpu"):
            H, W = r.orig_shape
            res.append([{"x": float(b[0]) / W, "y": float(b[1]) / H, "size": float(min(b[2], b[3])) / H, "score": float(c)}
                        for b, c in zip(r.boxes.xywh.tolist(), r.boxes.conf.tolist())])
json.dump({"fps": 30, "frames": res}, open(out, "w"))
print("frames", len(res), "dets", sum(map(len, res)))
