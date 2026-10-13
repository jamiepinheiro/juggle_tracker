"""Export trained weights to ONNX (browser demo + Claude plugin). usage: export.py <weights.pt> <out_dir> [height width]

Default 384x640: webcams are 16:9, so a square input would spend ~40% of its compute on padding.
Keep web/app.js's BallDetector.load(...) size in sync. Writes <out_dir>/ball.onnx."""
import os, shutil, sys
from ultralytics import YOLO
imgsz = [int(sys.argv[3]), int(sys.argv[4])] if len(sys.argv) > 4 else [384, 640]
path = YOLO(sys.argv[1]).export(format="onnx", imgsz=imgsz, simplify=True, opset=17, dynamic=False)
dest = os.path.join(sys.argv[2], "ball.onnx")
os.makedirs(sys.argv[2], exist_ok=True)
shutil.move(path, dest)
print("->", dest)
