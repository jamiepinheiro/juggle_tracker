// Runs the trained YOLO ball detector (ONNX) in the browser via onnxruntime-web.
import * as ort from "./vendor/ort.min.mjs";

ort.env.wasm.wasmPaths = new URL("./vendor/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

export class BallDetector {
  /** inW/inH: the model's fixed input size (see tools/export.py). */
  static async load(url, inW = 640, inH = 384) {
    const d = new BallDetector();
    d.inW = inW; d.inH = inH;
    const providers = navigator.gpu ? ["webgpu", "wasm"] : ["wasm"];
    for (const ep of providers) {
      try {
        d.session = await ort.InferenceSession.create(url, { executionProviders: [ep], graphOptimizationLevel: "all" });
        d.backend = ep;
        break;
      } catch (e) {
        console.warn(`onnxruntime ${ep} backend unavailable:`, e);
      }
    }
    if (!d.session) throw new Error("Could not start the model on WebGPU or WASM.");
    d.canvas = new OffscreenCanvas(inW, inH);
    d.ctx = d.canvas.getContext("2d", { willReadFrequently: true });
    d.input = new Float32Array(3 * inW * inH);
    return d;
  }

  /** source: video/canvas. Returns [{x, y, size, score}] normalised to the source frame. */
  async detect(source, srcW, srcH, { conf = 0.35, iou = 0.45 } = {}) {
    const W = this.inW, H = this.inH;
    // letterbox, same as Ultralytics: scale to fit, pad with grey 114
    const r = Math.min(W / srcW, H / srcH);
    const w = Math.round(srcW * r), h = Math.round(srcH * r);
    const ox = (W - w) / 2, oy = (H - h) / 2;
    this.ctx.fillStyle = "rgb(114,114,114)";
    this.ctx.fillRect(0, 0, W, H);
    this.ctx.drawImage(source, ox, oy, w, h);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    const plane = W * H, inp = this.input, k = 1 / 255;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      inp[i] = px[p] * k;
      inp[i + plane] = px[p + 1] * k;
      inp[i + 2 * plane] = px[p + 2] * k;
    }
    const feeds = { [this.session.inputNames[0]]: new ort.Tensor("float32", inp, [1, 3, H, W]) };
    const out = (await this.session.run(feeds))[this.session.outputNames[0]];
    const [, , n] = out.dims; // [1, 5, n]: cx, cy, w, h, score
    const o = out.data;
    const boxes = [];
    for (let i = 0; i < n; i++) {
      const s = o[4 * n + i];
      if (s < conf) continue;
      boxes.push({ cx: o[i], cy: o[n + i], w: o[2 * n + i], h: o[3 * n + i], score: s });
    }
    boxes.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const b of boxes) if (keep.every((k) => iouOf(k, b) < iou)) keep.push(b);
    return keep.map((b) => ({
      x: (b.cx - ox) / r / srcW,
      y: (b.cy - oy) / r / srcH,
      size: Math.min(b.w, b.h) / r / srcH, // motion blur stretches the box along the motion
      score: b.score,
    }));
  }
}

function iouOf(a, b) {
  const ix = Math.max(0, Math.min(a.cx + a.w / 2, b.cx + b.w / 2) - Math.max(a.cx - a.w / 2, b.cx - b.w / 2));
  const iy = Math.max(0, Math.min(a.cy + a.h / 2, b.cy + b.h / 2) - Math.max(a.cy - a.h / 2, b.cy - b.h / 2));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}
