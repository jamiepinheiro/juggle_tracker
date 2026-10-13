"""Local server for the labelling tool: serves data_labelling/web/ and reads/writes labels straight into data/<video>/.
Playable copies of the videos are served from data/videos/<video>.mp4 (or .mov) at /videos/.

usage: python3 data_labelling/tools/label_server.py [port]   (default 5175) -> http://localhost:5175/label.html

API (all under /api):
  GET  videos                         list of videos with frames, playable file and progress
  GET  video/<id>/frame/<n>.jpg       extracted frame n (0-based) from data/<id>/frames
  GET  video/<id>/labels/<n>          {boxes, source: manual|auto|none, preds}
  PUT  video/<id>/labels/<n>          {boxes: [[cx, cy, w, h], ...]} -> data/<id>/labels_manual/
  GET  video/<id>/queue               {frames: [...], reviewed: [...]} from review_queue.py
  GET  video/<id>/throws              hand-tapped throws (label.html Throws mode)
  PUT  video/<id>/throws              -> data/<id>/throws.labels.json
  GET  video/<id>/model_throws        throws the model + counter flag, from review_queue.py
Boxes are YOLO-normalised (cx, cy, w, h in 0-1). An empty manual file means "checked: no balls".
"""
import json, os, re, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA, WEB = os.path.join(ROOT, "data"), os.path.join(ROOT, "web")
VIDEOS = os.path.join(DATA, "videos")
VID_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


def vdir(vid):
    if not VID_RE.match(vid):
        raise ValueError("bad video id")
    d = os.path.join(DATA, vid)
    if not os.path.isdir(os.path.join(d, "frames")):
        raise FileNotFoundError(vid)
    return d


def is_neg(vid, n):
    cfg = load_json(os.path.join(DATA, "videos.json"), {}).get(vid, {})
    return any(a <= n < b for a, b in cfg.get("neg", []))


def read_boxes(path):
    if not os.path.exists(path):
        return None
    return [[float(v) for v in l.split()[1:5]] for l in open(path) if l.strip()]


def load_json(path, default):
    return json.load(open(path)) if os.path.exists(path) else default


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, *_):  # quiet
        pass

    def translate_path(self, path):
        if path.startswith("/videos/"):
            name = os.path.basename(path.split("?")[0])
            return os.path.join(VIDEOS, name)
        return super().translate_path(path)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")

    def route(self, method):
        parts = self.path.split("?")[0].strip("/").split("/")
        if parts[0] != "api":
            return False
        try:
            if parts[1:] == ["videos"] and method == "GET":
                self.send_json(list_videos())
                return True
            _, _, vid, kind, *rest = parts
            d = vdir(vid)
            if kind == "frame" and method == "GET":
                n = int(rest[0].removesuffix(".jpg"))
                p = os.path.join(d, "frames", f"{n + 1:05d}.jpg")
                data = open(p, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "max-age=3600")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            elif kind == "labels":
                n = int(rest[0]); name = f"{n + 1:05d}.txt"
                manual = os.path.join(d, "labels_manual", name)
                if method == "GET":
                    m = read_boxes(manual)
                    a = [] if is_neg(vid, n) else read_boxes(os.path.join(d, "labels", name))
                    preds = load_json(os.path.join(d, "predictions.json"), {}).get(str(n), [])
                    self.send_json({"boxes": m if m is not None else (a or []),
                                    "source": "manual" if m is not None else ("auto" if a is not None else "none"),
                                    "preds": preds})
                elif method == "PUT":
                    boxes = self.body()["boxes"]
                    os.makedirs(os.path.dirname(manual), exist_ok=True)
                    with open(manual, "w") as f:
                        for cx, cy, w, h in boxes:
                            f.write(f"0 {cx:.5f} {cy:.5f} {w:.5f} {h:.5f}\n")
                    self.send_json({"ok": True})
                elif method == "DELETE":  # back to unreviewed
                    if os.path.exists(manual):
                        os.remove(manual)
                    self.send_json({"ok": True})
            elif kind == "queue" and method == "GET":
                q = load_json(os.path.join(d, "review_queue.json"), {"frames": []})
                self.send_json({**q, "reviewed": reviewed(d)})
            elif kind == "throws":
                p = os.path.join(d, "throws.labels.json")
                if method == "GET":
                    self.send_json(load_json(p, None))
                elif method == "PUT":
                    json.dump(self.body(), open(p, "w"), indent=2)
                    self.send_json({"ok": True})
            elif kind == "model_throws" and method == "GET":
                self.send_json(load_json(os.path.join(d, "model_throws.json"), None))
            else:
                self.send_json({"error": "not found"}, 404)
        except (FileNotFoundError, ValueError, IndexError, KeyError) as e:
            self.send_json({"error": str(e)}, 404)
        return True

    def do_GET(self):
        if not self.route("GET"):
            super().do_GET()

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")


def reviewed(d):
    md = os.path.join(d, "labels_manual")
    return sorted(int(f[:-4]) - 1 for f in os.listdir(md)) if os.path.isdir(md) else []


def list_videos():
    out = []
    for vid in sorted(os.listdir(DATA)):
        d = os.path.join(DATA, vid)
        if not (os.path.isdir(os.path.join(d, "frames")) and not os.path.islink(d)):
            continue
        sample = next((f"videos/{vid}{ext}" for ext in (".mp4", ".mov", ".MOV")
                       if os.path.exists(os.path.join(VIDEOS, vid + ext))), None)
        q = load_json(os.path.join(d, "review_queue.json"), {"frames": []})
        out.append({"id": vid, "frames": len(os.listdir(os.path.join(d, "frames"))), "video": sample,
                    "queue": len(q["frames"]), "reviewed": len(reviewed(d)),
                    "hasThrows": os.path.exists(os.path.join(d, "throws.labels.json"))})
    return out


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5175
    print(f"labelling server on http://localhost:{port}/label.html")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
