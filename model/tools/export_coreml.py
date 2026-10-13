"""Export trained weights to Core ML for the iOS app. usage: export_coreml.py <weights.pt> <out_dir> [size]

Square input (default 640): the phone may be propped in portrait or landscape, so a 16:9 input
like the browser's would squeeze portrait frames. The model's raw output (box + score for each of
8400 candidates) is decoded in the app (Tracking/BallModelDetector.swift): exporting with NMS built
in fails with current torch/coremltools. Writes <out_dir>/BallModel.mlpackage."""
import os, shutil, sys
from ultralytics import YOLO
size = int(sys.argv[3]) if len(sys.argv) > 3 else 640
path = YOLO(sys.argv[1]).export(format="coreml", imgsz=size, nms=False)
dest = os.path.join(sys.argv[2], "BallModel.mlpackage")
os.makedirs(sys.argv[2], exist_ok=True)
shutil.rmtree(dest, ignore_errors=True)
shutil.move(path, dest)
print("->", dest)
