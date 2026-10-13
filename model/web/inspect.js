// Inspector: runs the same detector + counter as the tracker, but draws everything they decide.
import { BallDetector } from "./detector.js";
import { JuggleCounter } from "./counter.js";

const $ = (id) => document.getElementById(id);
const view = $("view"), ctx = view.getContext("2d");
const tl = $("timeline"), tctx = tl.getContext("2d");
const video = document.createElement("video");
video.playsInline = true; video.muted = true;
video.className = "source";          // in the DOM, or Chrome pauses it to save power
document.body.appendChild(video);

const FILE_FPS = 30;
const WINDOW = 8;                    // seconds shown on the timeline
const FLOOR = 0.15;                  // detections down to here are drawn; only >= threshold are counted
const REASONS = {
  climbed: "seen climbing, then turning over",
  arc: "parabolic top seen (climb not detected)",
  "left-top": "left the top of the frame climbing",
};
const TRACK_COLORS = ["#7fb2e5", "#9fd39a", "#e0b97a", "#c6a3e0", "#7fd1c7", "#e59fb7"];

let detector = null, source = null, stream = null, paused = false, session = 0;
let strong = [], weak = [];
let samples = [];                    // {t, y, id} for the timeline
let marks = [];                      // {t, n, dup}
let flashes = [];                    // {x, y, n, until}
let pendingShots = [];               // throw events waiting for the frame to be drawn
let now = 0, inferMs = 0;

const counter = new JuggleCounter();
counter.onThrow = (e) => {
  marks.push({ t: e.t, n: e.total, dup: false });
  flashes.push({ x: e.x, y: e.y, n: e.total, until: performance.now() + 900 });
  pendingShots.push(e);
};
counter.onDuplicate = (e) => marks.push({ t: e.t, dup: true });

// ---- sources -------------------------------------------------------------

async function startCamera() {
  stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } } });
  } catch (e) {
    return status(`Camera unavailable: ${e.message}. Allow camera access for this page and try again.`);
  }
  video.srcObject = stream;
  await video.play();
  begin("camera");
  const id = session;
  const loop = (ts) => {
    if (source !== "camera" || session !== id) return;
    if (!paused) step(ts / 1000);
    video.requestVideoFrameCallback(loop);
  };
  video.requestVideoFrameCallback(loop);
}

async function startFile(file) {
  stop();
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  try {
    await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error("This browser can't decode that video.")); });
  } catch (e) { return status(e.message); }
  begin("file");
  const id = session;
  const n = Math.floor(video.duration * FILE_FPS);
  for (let i = 0; i < n && session === id; i++) {
    while (paused && session === id) await new Promise((r) => setTimeout(r, 100));
    video.currentTime = (i + 0.5) / FILE_FPS; // mid-frame: a boundary can land on the previous frame
    await new Promise((ok) => (video.onseeked = ok));
    await step(i / FILE_FPS);
  }
  if (session === id) status(`Finished: ${counter.total} throws flagged in that video.`);
}

function begin(kind) {
  source = kind; session++; paused = false;
  counter.reset();
  samples = []; marks = []; flashes = []; pendingShots = [];
  $("log").replaceChildren();
  $("logEmpty").hidden = false;
  $("empty").hidden = true;
  $("pauseBtn").hidden = $("stopBtn").hidden = false;
  $("pauseBtn").textContent = "Pause";
  view.width = video.videoWidth; view.height = video.videoHeight;
  $("viewport").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  status(kind === "camera" ? "Juggle in front of the camera." : "Stepping through the video frame by frame.");
}

function stop() {
  session++;
  source = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.pause();
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute("src"); video.load(); }
  $("pauseBtn").hidden = $("stopBtn").hidden = true;
}

// ---- per frame -------------------------------------------------------------

let busy = false;
async function step(t) {
  if (!detector || busy) return;
  busy = true;
  try {
    const conf = +$("conf").value;
    const t0 = performance.now();
    const dets = await detector.detect(video, video.videoWidth, video.videoHeight, { conf: FLOOR });
    inferMs = 0.8 * inferMs + 0.2 * (performance.now() - t0);
    strong = dets.filter((d) => d.score >= conf);
    weak = dets.filter((d) => d.score < conf);
    now = t;
    counter.update(strong, t);
    for (const tr of counter.tracks) if (tr.t === t) samples.push({ t, y: tr.y, id: tr.id });
    samples = samples.filter((s) => s.t > t - WINDOW);
    marks = marks.filter((m) => m.t > t - WINDOW);
    draw();
    drawTimeline();
    for (const e of pendingShots.splice(0)) logThrow(e);
    $("total").textContent = counter.total;
    $("run").textContent = counter.run;
    $("tracks").textContent = counter.tracks.length;
    $("speed").textContent = `${inferMs.toFixed(0)} ms`;
  } finally {
    busy = false;
  }
}

function draw() {
  const W = view.width, H = view.height;
  const mirror = source === "camera" && $("mirror").checked;
  const X = (x) => (mirror ? 1 - x : x) * W;
  ctx.save();
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();

  const lw = Math.max(2, W / 450), font = Math.max(12, W / 70);
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  ctx.lineWidth = lw;

  // tracks: trail + id
  for (const tr of counter.tracks) {
    const col = TRACK_COLORS[tr.id % TRACK_COLORS.length];
    ctx.strokeStyle = col;
    ctx.beginPath();
    tr.trail.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), y * H) : ctx.moveTo(X(x), y * H)));
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.fillText(`ball ${tr.id}`, X(tr.x) + (tr.size * H) / 2 + 8, tr.y * H - 6);
  }

  // detections with their confidence
  const label = (d, color) => {
    ctx.fillStyle = color;
    ctx.fillText(d.score.toFixed(2), X(d.x) - (d.size * H) / 2, d.y * H + (d.size * H) / 2 + font + 2);
  };
  if ($("showWeak").checked) {
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = "rgba(200,195,185,0.8)";
    for (const d of weak) { circle(X(d.x), d.y * H, (d.size * H) / 2 + 4); label(d, "rgba(200,195,185,0.9)"); }
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = "#f3f1ec";
  for (const d of strong) { circle(X(d.x), d.y * H, (d.size * H) / 2 + 4); label(d, "#f3f1ec"); }

  // counted throws: accent burst + number at the apex
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const t = performance.now();
  flashes = flashes.filter((f) => f.until > t);
  for (const f of flashes) {
    ctx.globalAlpha = Math.min(1, (f.until - t) / 400);
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(X(f.x), f.y * H, H * 0.03, 0, Math.PI * 2); ctx.fill();
    ctx.font = `700 ${font * 1.6}px system-ui, sans-serif`;
    ctx.fillText(`#${f.n}`, X(f.x) + H * 0.04, f.y * H + font * 0.6);
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    ctx.globalAlpha = 1;
  }
}

function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }

function drawTimeline() {
  const dpr = devicePixelRatio || 1;
  const W = tl.clientWidth, H = tl.clientHeight;
  if (tl.width !== W * dpr) { tl.width = W * dpr; tl.height = H * dpr; }
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue("--muted").trim(), line = css.getPropertyValue("--line").trim();
  const accent = css.getPropertyValue("--accent").trim();
  const pad = 22;
  const tx = (t) => ((t - (now - WINDOW)) / WINDOW) * W;
  const ty = (y) => pad / 2 + y * (H - pad);   // y=0 (top of frame) at the top
  tctx.font = "11px system-ui, sans-serif";
  tctx.strokeStyle = line; tctx.lineWidth = 1;
  for (let s = Math.ceil(now - WINDOW); s <= now; s++) {
    tctx.beginPath(); tctx.moveTo(tx(s) + 0.5, 0); tctx.lineTo(tx(s) + 0.5, H); tctx.stroke();
  }
  for (const m of marks) {
    const x = tx(m.t);
    tctx.strokeStyle = m.dup ? muted : accent;
    tctx.setLineDash(m.dup ? [4, 4] : []);
    tctx.lineWidth = m.dup ? 1 : 2;
    tctx.beginPath(); tctx.moveTo(x, 12); tctx.lineTo(x, H); tctx.stroke();
    tctx.setLineDash([]);
    if (!m.dup) { tctx.fillStyle = accent; tctx.fillText(`#${m.n}`, x + 3, 11); }
  }
  for (const s of samples) {
    tctx.fillStyle = TRACK_COLORS[s.id % TRACK_COLORS.length];
    tctx.beginPath(); tctx.arc(tx(s.t), ty(s.y), 2.5, 0, Math.PI * 2); tctx.fill();
  }
}

function logThrow(e) {
  const li = document.createElement("li");
  li.className = "new";
  const shot = document.createElement("canvas");
  shot.width = 224; shot.height = Math.round((224 * view.height) / view.width);
  shot.getContext("2d").drawImage(view, 0, 0, shot.width, shot.height);
  const info = document.createElement("div");
  const n = document.createElement("div"); n.className = "n";
  n.textContent = `#${e.total} · run ${e.run} · ${e.t.toFixed(2)} s`;
  const why = document.createElement("div"); why.className = "why";
  why.textContent = `ball ${e.trackId}: ${REASONS[e.reason] ?? e.reason}`;
  info.append(n, why);
  li.append(shot, info);
  const log = $("log");
  log.querySelector(".new")?.classList.remove("new");
  log.prepend(li);
  while (log.children.length > 60) log.lastChild.remove();
  $("logEmpty").hidden = true;
  $("logCount").textContent = `(${counter.total})`;
}

function status(msg) { $("status").textContent = msg; }

// ---- wiring ---------------------------------------------------------------

$("camBtn").onclick = startCamera;
$("fileIn").onchange = (e) => { const f = e.target.files[0]; if (f) startFile(f); e.target.value = ""; };
$("stopBtn").onclick = () => { stop(); status(`Stopped. ${counter.total} throws flagged.`); };
$("pauseBtn").onclick = () => {
  paused = !paused;
  $("pauseBtn").textContent = paused ? "Resume" : "Pause";
  if (source === "camera") paused ? video.pause() : video.play();
};
$("conf").oninput = () => ($("confOut").textContent = (+$("conf").value).toFixed(2));
$("rise").oninput = () => {
  counter.o.minRiseBalls = +$("rise").value;
  $("riseOut").textContent = (+$("rise").value).toFixed(2).replace(/0$/, "");
};
addEventListener("resize", () => source && drawTimeline());

BallDetector.load("model/ball.onnx", 640, 384)
  .then((d) => { detector = d; status(`Model ready (${d.backend.toUpperCase()}). Start the camera or open a video.`); })
  .catch((e) => status(`Model failed to load: ${e.message}`));

window.inspector = { counter, startFile, get detector() { return detector; } };
