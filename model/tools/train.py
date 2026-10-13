"""Fine-tune a small YOLO ball detector. usage: train.py <run-name> [epochs] [init-weights]"""
import os, sys
from ultralytics import YOLO
from paths import DATA, PRETRAINED, RUNS
name = sys.argv[1]; epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 60
YOLO(sys.argv[3] if len(sys.argv) > 3 else os.path.join(PRETRAINED, "yolo11n.pt")).train(
    data=os.path.join(DATA, "ds/data.yaml"), imgsz=640, epochs=epochs, batch=16, device="mps", project=RUNS, name=name,
    exist_ok=True, patience=15, workers=4, plots=False, cache="ram",
    # webcam footage won't look like this one video: lean on colour/scale/flip augmentation
    hsv_h=0.03, hsv_s=0.6, hsv_v=0.4, degrees=10, scale=0.6, fliplr=0.5, mosaic=1.0, mixup=0.1, close_mosaic=10,
)
