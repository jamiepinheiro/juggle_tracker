import { BallDetector } from "./detector.js";
import { JuggleCounter } from "./counter.js";
import { loadRuns, saveRun, clearRuns, summarize } from "./history.js";

const $ = (id) => document.getElementById(id);
const view = $("view"), ctx = view.getContext("2d");
const video = document.createElement("video");
video.playsInline = true; video.muted = true;
// must live in the DOM: Chrome pauses detached video-only media "to save power"
video.className = "source";
document.body.appendChild(video);

let detector = null;
let source = null;          // "camera" | "file" | null
let stream = null;
let busy = false;
let lastDets = [];
let flashes = [];           // apex markers: {x, y, until}
let frames = 0, fpsT = performance.now(), fps = 0;

const counter = new JuggleCounter();
// Throws that leave the top of the frame are easy to miss (the ball is only seen for a few
// frames, often blurred against you), so nudge the camera setup when that's most of them.
const recentReasons = [];
counter.onThrow = (e) => {
  flashes.push({ x: e.x, y: e.y, until: performance.now() + 600 });
  setRun(e.run);
  recentReasons.push(e.reason);
  if (recentReasons.length > 8) recentReasons.shift();
  const topExits = recentReasons.filter((r) => r === "left-top").length;
  $("framing").hidden = !(source === "camera" && recentReasons.length >= 6 && topExits >= 3);
};
counter.onRunEnd = (n) => {
  saveRun({ n, at: Date.now(), source });
  $("last").textContent = n;
  setRun(0);
  renderHistory();
};

function setRun(n) {
  const el = $("run");
  el.textContent = n;
  if (n > 0) { el.classList.add("bump"); clearTimeout(setRun.timer); setRun.timer = setTimeout(() => el.classList.remove("bump"), 150); }
}

function status(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

// ---- sources -------------------------------------------------------------

async function startCamera() {
  stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false,
    });
  } catch (e) {
    status(`Camera unavailable: ${e.message}. Allow camera access for this page and try again.`, true);
    return;
  }
  video.srcObject = stream;
  await video.play();
  begin("camera");
}

// Files are stepped frame by frame instead of played: every frame is analysed no matter
// how fast the model runs, so the count for a given video is always the same.
const FILE_FPS = 30;

async function startFile(file) {
  stop();
  if (!detector) { status("The model is still loading. Try again in a moment.", true); return; }
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error("This browser can't decode that video.")); })
    .catch((e) => { status(e.message, true); throw e; });
  begin("file");
  const session = source;
  const n = Math.floor(video.duration * FILE_FPS);
  const conf = +$("conf").value;
  for (let i = 0; i < n && source === session; i++) {
    const t = i / FILE_FPS;
    video.currentTime = (i + 0.5) / FILE_FPS; // mid-frame: seeking to a boundary can land on the previous frame
    await new Promise((ok) => (video.onseeked = ok));
    const dets = await detector.detect(video, video.videoWidth, video.videoHeight, { conf });
    lastDets = dets;
    counter.update(dets, t);
    draw();
    if (i % 15 === 0) status(`Counting video… ${Math.round((100 * i) / n)}% · ${counter.total} throws so far`);
  }
  if (source !== session) return;
  const total = counter.total;
  stop();
  status(`Done: ${total} throws counted in that video.`);
}

function begin(kind) {
  source = kind;
  counter.reset();
  setRun(0);
  $("empty").hidden = true;
  $("stopBtn").hidden = false;
  view.width = video.videoWidth; view.height = video.videoHeight;
  $("viewport").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  if (kind === "camera") schedule();
}

function stop() {
  if (counter.run > 0) counter.update([], Infinity); // flush the run in progress
  source = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.pause();
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute("src"); video.load(); }
  $("stopBtn").hidden = true;
  $("empty").hidden = false;
  $("viewport").style.aspectRatio = "";
}

// ---- main loop -------------------------------------------------------------

function schedule() {
  if (!source) return;
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
  else requestAnimationFrame(onFrame);
}

function onFrame(now) {
  if (source !== "camera") return;
  const t = now / 1000;
  draw();
  if (detector && !busy) {
    busy = true;
    const conf = +$("conf").value;
    detector.detect(video, video.videoWidth, video.videoHeight, { conf })
      .then((dets) => {
        lastDets = dets;
        counter.update(dets, t);
        frames++;
      })
      .catch((e) => status(`Detection failed: ${e.message}`, true))
      .finally(() => { busy = false; });
  }
  const n = performance.now();
  if (n - fpsT > 1000) {
    fps = (frames * 1000) / (n - fpsT); frames = 0; fpsT = n;
    status(`Tracking at ${fps.toFixed(0)} fps · ${detector.backend.toUpperCase()} · ${counter.total} throws this session`);
  }
  schedule();
}

function draw() {
  const W = view.width, H = view.height;
  const mirror = source === "camera" && $("mirror").checked;
  ctx.save();
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, W, H);
  if ($("overlay").checked) {
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    ctx.lineWidth = Math.max(2, W / 400);
    for (const tr of counter.tracks) {
      if (tr.trail.length < 2) continue;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      tr.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
      ctx.stroke();
    }
    ctx.strokeStyle = accent;
    for (const d of lastDets) {
      const r = (d.size * H) / 2 + 4;
      ctx.beginPath(); ctx.arc(d.x * W, d.y * H, r, 0, Math.PI * 2); ctx.stroke();
    }
    const now = performance.now();
    flashes = flashes.filter((f) => f.until > now);
    for (const f of flashes) {
      const a = (f.until - now) / 600;
      ctx.fillStyle = accent; ctx.globalAlpha = a;
      ctx.beginPath(); ctx.arc(f.x * W, f.y * H, H * 0.025 * (2 - a), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// ---- history ---------------------------------------------------------------

function renderHistory() {
  const s = summarize(loadRuns());
  $("today").textContent = s.bestToday || "–";
  $("best").textContent = s.best || "–";
  $("todayTotal").textContent = s.totalToday;
  barChart($("runsChart"), s.todayRuns.map((r) => ({ v: r.n })), s.bestToday);
  barChart($("daysChart"), s.days.map((d) => ({ v: d.best, label: d.label })), s.best);
  $("runsEmpty").hidden = s.todayRuns.length > 0;
  $("daysEmpty").hidden = s.days.length > 0;
}

function barChart(svg, data, best) {
  svg.replaceChildren();
  svg.style.display = data.length ? "" : "none";
  if (!data.length) return;
  const W = svg.clientWidth || 300, H = 110, top = 14, bottom = data[0].label ? 16 : 4;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const max = Math.max(...data.map((d) => d.v), 1);
  const slot = W / data.length, bw = Math.max(2, Math.min(28, slot * 0.7));
  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.appendChild(e);
  };
  el("line", { x1: 0, x2: W, y1: H - bottom + 0.5, y2: H - bottom + 0.5, class: "grid" });
  data.forEach((d, i) => {
    const h = ((H - top - bottom) * d.v) / max;
    const x = i * slot + (slot - bw) / 2;
    el("rect", { x, y: H - bottom - h, width: bw, height: Math.max(h, 1), rx: 2, class: d.v === best ? "bar best" : "bar" });
    if (d.v === best || data.length <= 12) el("text", { x: x + bw / 2, y: H - bottom - h - 3, "text-anchor": "middle", class: "axis" }, d.v);
    if (d.label && (data.length <= 10 || i === 0 || i === data.length - 1))
      el("text", { x: x + bw / 2, y: H - 3, "text-anchor": "middle", class: "axis" }, d.label);
  });
}

// ---- wiring ---------------------------------------------------------------

$("camBtn").onclick = startCamera;
$("stopBtn").onclick = () => { const n = counter.total; stop(); status(`Stopped. ${n} throws this session.`); };
$("fileIn").onchange = (e) => { const f = e.target.files[0]; if (f) startFile(f).catch(() => {}); e.target.value = ""; };
$("clearBtn").onclick = () => {
  if (confirm("Delete all saved runs from this browser? This can't be undone.")) { clearRuns(); renderHistory(); }
};
addEventListener("resize", renderHistory);
renderHistory();

BallDetector.load("model/ball.onnx", 640, 384) // input size from tools/export.py
  .then((d) => { detector = d; status(`Model ready (${d.backend.toUpperCase()}). Start the camera or open a video.`); })
  .catch((e) => status(`Model failed to load: ${e.message}`, true));

// expose for debugging / automated checks
window.juggle = { counter, startFile, get detector() { return detector; } };
