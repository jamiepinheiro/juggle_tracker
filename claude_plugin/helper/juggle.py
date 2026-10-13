"""Camera -> ball detector -> juggle counter, streamed to the plugin as JSON lines on stdout.

  juggle.py --list            print the cameras as one JSON line and exit
  juggle.py --camera N        run: emits ready, frame (~10/s), throw, run_end, error
  juggle.py --video FILE      the same over a video file, then done (for testing)
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import threading
import time

import cv2
import numpy as np
import onnxruntime as ort

from counter import JuggleCounter

ort.set_default_logger_severity(3)

MODEL = os.path.join(os.path.dirname(__file__), "..", "model", "ball.onnx")
IN_W, IN_H = 640, 384      # the model's fixed input size
PREVIEW_W = 360            # width of the frames sent to the pane
PREVIEW_FPS = 10
JPEG_QUALITY = 55


def emit(msg):
    sys.stdout.write(json.dumps(msg, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def exit_with(pid):
    # The plugin stops the helper by stopping the process reading its output (helper/launch.sh).
    # A write to the abandoned pipe can block rather than fail, so watch that process instead.
    def watch():
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                os._exit(0)
            except PermissionError:
                pass
            time.sleep(0.5)
    threading.Thread(target=watch, daemon=True).start()


def list_cameras():
    # OpenCV's AVFoundation backend numbers devices in the order system_profiler lists them.
    names = []
    try:
        out = subprocess.run(["system_profiler", "SPCameraDataType", "-json"],
                             capture_output=True, text=True, timeout=10).stdout
        names = [c.get("_name", "Camera") for c in json.loads(out).get("SPCameraDataType", [])]
    except Exception:
        pass
    if not names:
        names = ["Default camera"]
    emit({"type": "cameras", "cameras": [{"index": i, "name": n} for i, n in enumerate(names)]})


class Detector:
    def __init__(self, path):
        avail = ort.get_available_providers()
        providers = [p for p in ("CoreMLExecutionProvider", "CPUExecutionProvider") if p in avail]
        try:
            self.session = ort.InferenceSession(path, providers=providers)
        except Exception:
            self.session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def detect(self, frame, conf=0.35, iou=0.45):
        """frame: BGR. Returns [{x, y, size, score}] normalised to the frame."""
        src_h, src_w = frame.shape[:2]
        # letterbox, same as Ultralytics: scale to fit, pad with grey 114
        r = min(IN_W / src_w, IN_H / src_h)
        w, h = round(src_w * r), round(src_h * r)
        ox, oy = (IN_W - w) // 2, (IN_H - h) // 2
        canvas = np.full((IN_H, IN_W, 3), 114, np.uint8)
        canvas[oy:oy + h, ox:ox + w] = cv2.resize(frame, (w, h), interpolation=cv2.INTER_LINEAR)
        blob = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).transpose(2, 0, 1)[None].astype(np.float32) / 255
        out = self.session.run(None, {self.input: blob})[0][0]  # [5, n]: cx, cy, w, h, score
        keep = out[4] >= conf
        boxes = out[:, keep].T
        boxes = boxes[np.argsort(-boxes[:, 4])]
        picked = []
        for b in boxes:
            if all(_iou(k, b) < iou for k in picked):
                picked.append(b)
        return [{
            "x": float((b[0] - ox) / r / src_w),
            "y": float((b[1] - oy) / r / src_h),
            "size": float(min(b[2], b[3]) / r / src_h),  # motion blur stretches the box along the motion
            "score": float(b[4]),
        } for b in picked]


def _iou(a, b):
    ix = max(0.0, min(a[0] + a[2] / 2, b[0] + b[2] / 2) - max(a[0] - a[2] / 2, b[0] - b[2] / 2))
    iy = max(0.0, min(a[1] + a[3] / 2, b[1] + b[3] / 2) - max(a[1] - a[3] / 2, b[1] - b[3] / 2))
    inter = ix * iy
    return inter / (a[2] * a[3] + b[2] * b[3] - inter)


def run(camera, video=None):
    detector = Detector(MODEL)
    cap = cv2.VideoCapture(video) if video else cv2.VideoCapture(camera, cv2.CAP_AVFOUNDATION)
    if not cap.isOpened():
        emit({"type": "error", "message": f"Could not open camera {camera}. "
              "Check that Juggle Break Camera is allowed in System Settings > Privacy & Security > Camera."})
        return 1
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    counter = JuggleCounter()
    counter.on_throw = lambda total, run: emit({"type": "throw", "total": total, "run": run})
    counter.on_run_end = lambda n: emit({"type": "run_end", "n": n})

    t0 = time.monotonic()
    last_preview = 0.0
    misses = 0
    ready = False
    while True:
        ok, frame = cap.read()
        if not ok and video:
            emit({"type": "done", "total": counter.total})
            return 0
        if not ok:
            misses += 1
            if misses > 60:
                emit({"type": "error", "message": f"Camera {camera} stopped sending frames."})
                return 1
            time.sleep(0.02)
            continue
        misses = 0
        frame = cv2.flip(frame, 1)  # mirror, like looking in a mirror
        t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000 if video else time.monotonic() - t0
        if not ready:
            emit({"type": "ready", "camera": camera, "w": frame.shape[1], "h": frame.shape[0]})
            ready = True

        dets = detector.detect(frame)
        tracks = counter.update(dets, t)

        if t - last_preview >= 1 / PREVIEW_FPS:
            last_preview = t
            h, w = frame.shape[:2]
            ph = round(h * PREVIEW_W / w)
            small = cv2.resize(frame, (PREVIEW_W, ph), interpolation=cv2.INTER_AREA)
            ok, jpg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok:
                emit({
                    "type": "frame",
                    "jpg": base64.b64encode(jpg.tobytes()).decode("ascii"),
                    "w": PREVIEW_W, "h": ph,
                    "dets": [[round(d["x"], 4), round(d["y"], 4), round(d["size"], 4)] for d in dets],
                    "tracks": [[[round(x, 4), round(y, 4)] for x, y in tr.trail] for tr in tracks
                               if len(tr.trail) > 1],
                })


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--watch-pid", type=int, help="exit when this process ends")
    ap.add_argument("--video", help="count a video file instead of the camera (for testing)")
    args = ap.parse_args()
    if args.watch_pid:
        exit_with(args.watch_pid)
    if args.list:
        list_cameras()
        return 0
    try:
        return run(args.camera, args.video)
    except (BrokenPipeError, KeyboardInterrupt):
        return 0
    except Exception as e:  # surface anything unexpected in the pane
        emit({"type": "error", "message": f"{type(e).__name__}: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
