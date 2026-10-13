// Ball-box correction: step through a queue of frames picked by tools/review_queue.py (where the
// model and the automatic labels disagree, plus a random sample), fix the pre-filled boxes, save.
// Saved frames land in data/<video>/labels_manual/, which training prefers over the auto labels.
// Needs tools/label_server.py. Boxes are YOLO-normalised [cx, cy, w, h].

const $ = (id) => document.getElementById(id);
const canvas = $("bxCanvas"), ctx = canvas.getContext("2d");
const HANDLE = 7;              // corner handle hit radius, image px
const MIN_BOX = 6;             // image px

let videos = [], vid = null;
let queue = [], reviewed = new Set(), qi = 0;
let n = null;                  // frame on screen (may be a neighbour of the queued one)
let img = null, boxes = [], preds = [], source = "none";
let selIdx = -1, hidden = false, dirty = false, undoStack = [];
let drag = null;               // {kind: move|resize|draw, ...}
let cursor = null, loupe = false;
let active = false;            // Boxes tab is showing

// ---------- data ----------

const api = (path, opts) => fetch(`/api/video/${vid}/${path}`, opts).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

document.addEventListener("label-server", (e) => {
  videos = e.detail;
  $("bxEmpty").hidden = true;
  $("projectVideo").addEventListener("change", () => {
    if ($("projectVideo").value) openVideo($("projectVideo").value);
  });
});

document.addEventListener("label-mode", (e) => {
  active = e.detail === "boxes";
  if (!active || !videos.length) return;
  const pick = $("projectVideo").value || videos.find((v) => v.queue > v.reviewed)?.id || videos[0].id;
  if (pick !== vid) { $("projectVideo").value = pick; openVideo(pick); } else draw();
  canvas.focus();
});

async function openVideo(id) {
  if (!active) { vid = null; return; }   // the Throws tab handles it; load lazily when switching
  if (dirty && !confirm("Leave this frame without saving?")) return;
  vid = id;
  const q = await api("queue");
  queue = q.frames;
  reviewed = new Set(q.reviewed);
  if (!queue.length) {
    toast(`No review queue for ${id} yet. Run tools/review_queue.py`);
    $("bxWhy").textContent = `Run: .venv/bin/python tools/review_queue.py data/${id} <weights.pt>`;
  }
  qi = Math.max(0, queue.findIndex((f) => !reviewed.has(f.n)));
  if (queue.length) await load(queue[qi].n);
  progress();
}

async function load(frame) {
  n = frame;
  const [data, image] = await Promise.all([
    api(`labels/${frame}`),
    new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = `/api/video/${vid}/frame/${frame}.jpg`; }),
  ]);
  img = image;
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  boxes = data.boxes.map((b) => [...b]);
  preds = data.preds;
  source = data.source;
  selIdx = -1; dirty = false; undoStack = [];
  strip();
  progress();
  draw();
}

async function save() {
  if (n === null) return;
  try {
    await api(`labels/${n}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ boxes }) });
  } catch {
    return toast("Couldn't save. Is the label server still running?");
  }
  reviewed.add(n);
  dirty = false;
  toast(boxes.length ? `Saved ${boxes.length} ball${boxes.length === 1 ? "" : "s"}` : "Saved: no balls");
  next();
}

function next() {
  const from = queue.findIndex((f) => f.n === n);
  let i = from >= 0 ? from + 1 : qi + 1;
  while (i < queue.length && reviewed.has(queue[i].n)) i++;
  if (i >= queue.length) {
    const left = queue.findIndex((f) => !reviewed.has(f.n));
    if (left < 0) { progress(); return toast("Queue done. Thank you! Retrain to use these labels"); }
    i = left;
  }
  qi = i;
  load(queue[qi].n);
}

function prevQueued() {
  if (qi > 0) { qi--; load(queue[qi].n); }
}

// ---------- editing ----------

const imgW = () => canvas.width, imgH = () => canvas.height;
const toPx = (b) => [(b[0] - b[2] / 2) * imgW(), (b[1] - b[3] / 2) * imgH(), b[2] * imgW(), b[3] * imgH()];
const fromPx = (x, y, w, h) => [(x + w / 2) / imgW(), (y + h / 2) / imgH(), w / imgW(), h / imgH()];

let lastSize = null;           // the size you last drew or resized a box to

function defaultSize() {
  // a ball-sized square: what you last drew, else the model's confident suggestions, else ~34 px at 960
  // wide (the automatic boxes are padded and can't be trusted for size)
  if (lastSize) return lastSize;
  const sizes = preds.filter((p) => p[4] >= 0.4).map((b) => Math.min(b[2] * imgW(), b[3] * imgH())).sort((a, b) => a - b);
  return sizes.length ? sizes[sizes.length >> 1] : imgW() * 0.035;
}

function edit(fn) {
  undoStack.push(JSON.stringify(boxes));
  fn();
  dirty = true;
  draw(); progress();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return toast("Nothing to undo");
  boxes = JSON.parse(prev); selIdx = -1; dirty = true;
  draw(); progress();
}

function pointer(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * imgW(), ((e.clientY - r.top) / r.height) * imgH()];
}

function hitBox(x, y) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const [bx, by, bw, bh] = toPx(boxes[i]);
    if (x >= bx - 3 && x <= bx + bw + 3 && y >= by - 3 && y <= by + bh + 3) return i;
  }
  return -1;
}

function hitCorner(x, y) {
  if (selIdx < 0) return null;
  const [bx, by, bw, bh] = toPx(boxes[selIdx]);
  const corners = [[bx, by, "nw"], [bx + bw, by, "ne"], [bx, by + bh, "sw"], [bx + bw, by + bh, "se"]];
  return corners.find(([cx, cy]) => Math.hypot(cx - x, cy - y) <= HANDLE * 1.6)?.[2] ?? null;
}

const visiblePreds = () => preds.filter((p) => !boxes.some((b) => Math.hypot(b[0] - p[0], (b[1] - p[1]) * imgH() / imgW()) < Math.max(b[2], p[2]) * 0.6));

function hitPred(x, y) {
  return visiblePreds().find((p) => {
    const [bx, by, bw, bh] = toPx(p);
    return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
  });
}

canvas.addEventListener("pointerdown", (e) => {
  if (!img || e.button === 2) return;
  canvas.focus();
  const [x, y] = pointer(e);
  canvas.setPointerCapture(e.pointerId);
  const corner = hitCorner(x, y);
  if (corner) {
    undoStack.push(JSON.stringify(boxes));
    drag = { kind: "resize", corner, box: toPx(boxes[selIdx]) };
    return;
  }
  const i = hitBox(x, y);
  if (i >= 0) {
    selIdx = i;
    undoStack.push(JSON.stringify(boxes));
    drag = { kind: "move", x, y, box: toPx(boxes[i]), moved: false };
    draw();
    return;
  }
  const p = hitPred(x, y);
  if (p) {
    edit(() => { boxes.push(p.slice(0, 4)); selIdx = boxes.length - 1; });
    return;
  }
  drag = { kind: "draw", x0: x, y0: y, x, y };
  selIdx = -1;
});

canvas.addEventListener("pointermove", (e) => {
  if (!img) return;
  const [x, y] = pointer(e);
  cursor = [x, y];
  if (!drag) {
    canvas.style.cursor = hitCorner(x, y) ? "nwse-resize" : hitBox(x, y) >= 0 ? "move" : hitPred(x, y) ? "copy" : "crosshair";
    if (loupe) draw();
    return;
  }
  if (drag.kind === "move") {
    const [bx, by, bw, bh] = drag.box;
    boxes[selIdx] = fromPx(bx + x - drag.x, by + y - drag.y, bw, bh);
    drag.moved = true;
  } else if (drag.kind === "resize") {
    let [bx, by, bw, bh] = drag.box;
    let x0 = bx, y0 = by, x1 = bx + bw, y1 = by + bh;
    if (drag.corner.includes("w")) x0 = x; else x1 = x;
    if (drag.corner.includes("n")) y0 = y; else y1 = y;
    boxes[selIdx] = fromPx(Math.min(x0, x1), Math.min(y0, y1), Math.max(Math.abs(x1 - x0), MIN_BOX), Math.max(Math.abs(y1 - y0), MIN_BOX));
  } else {
    drag.x = x; drag.y = y;
  }
  dirty = true;
  draw();
});

canvas.addEventListener("pointerup", () => {
  if (!drag) return;
  const remember = () => { const [, , w, h] = toPx(boxes[selIdx]); lastSize = Math.max(w, h); };
  if (drag.kind === "draw") {
    const w = Math.abs(drag.x - drag.x0), h = Math.abs(drag.y - drag.y0);
    edit(() => {
      if (w < MIN_BOX && h < MIN_BOX) {      // a click: drop a ball-sized box centred there
        const s = defaultSize();
        boxes.push(fromPx(drag.x0 - s / 2, drag.y0 - s / 2, s, s));
      } else {
        boxes.push(fromPx(Math.min(drag.x0, drag.x), Math.min(drag.y0, drag.y), Math.max(w, MIN_BOX), Math.max(h, MIN_BOX)));
        lastSize = Math.max(w, h);
      }
      selIdx = boxes.length - 1;
    });
  } else if (drag.kind === "move" && !drag.moved) {
    undoStack.pop();                        // plain click on a box only selects it
  } else {
    if (drag.kind === "resize") remember();
    progress();
  }
  drag = null;
  draw();
});

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const [x, y] = pointer(e);
  const i = hitBox(x, y);
  if (i >= 0) edit(() => { boxes.splice(i, 1); selIdx = -1; });
});

canvas.addEventListener("pointerleave", () => { cursor = null; if (loupe) draw(); });

// ---------- drawing ----------

function draw() {
  if (!img) return;
  const W = imgW(), H = imgH();
  ctx.drawImage(img, 0, 0, W, H);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  if (!hidden) {
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    for (const p of visiblePreds()) {
      const [x, y, w, h] = toPx(p);
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(`model ${p[4].toFixed(2)}`, x, y - 4);
    }
    ctx.setLineDash([]);
    boxes.forEach((b, i) => {
      const [x, y, w, h] = toPx(b);
      ctx.lineWidth = i === selIdx ? 2.5 : 2;
      ctx.strokeStyle = i === selIdx ? accent : "#7dff9a";
      ctx.strokeRect(x, y, w, h);
      if (i === selIdx) {
        ctx.fillStyle = accent;
        for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) ctx.fillRect(cx - 4, cy - 4, 8, 8);
      }
    });
    if (drag?.kind === "draw") {
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
      ctx.strokeRect(Math.min(drag.x0, drag.x), Math.min(drag.y0, drag.y), Math.abs(drag.x - drag.x0), Math.abs(drag.y - drag.y0));
    }
  }
  if (loupe && cursor) drawLoupe(accent);
  $("bxCount").textContent = boxes.length;
}

// 3x magnifier in the corner away from the cursor, for fitting boxes to small blurred balls
function drawLoupe(accent) {
  const W = imgW(), H = imgH(), S = 3, R = 60;
  const [x, y] = cursor;
  const size = R * 2 * S, ox = x > W / 2 ? 12 : W - size - 12, oy = 12;
  ctx.save();
  ctx.beginPath(); ctx.rect(ox, oy, size, size); ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, x - R, y - R, R * 2, R * 2, ox, oy, size, size);
  ctx.restore();
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.strokeRect(ox, oy, size, size);
}

function strip() {
  const box = $("bxStrip");
  box.replaceChildren(...[-2, -1, 0, 1, 2].map((d) => {
    const f = n + d;
    const el = document.createElement("button");
    el.className = "thumb" + (d === 0 ? " cur" : "") + (reviewed.has(f) ? " done" : "");
    el.title = `Frame ${f}`;
    if (f < 0) { el.disabled = true; return el; }
    const i = new Image();
    i.src = `/api/video/${vid}/frame/${f}.jpg`;
    i.alt = `Frame ${f}`;
    i.onerror = () => (el.disabled = true);
    el.append(i, Object.assign(document.createElement("span"), { textContent: d ? (d > 0 ? `+${d}` : d) : "this" }));
    el.addEventListener("click", () => d && goNeighbour(d));
    return el;
  }));
}

function goNeighbour(d) {
  if (dirty && !confirm("Leave this frame without saving?")) return;
  load(n + d);
}

const SOURCES = { manual: "your saved boxes", auto: "the automatic labels", none: "nothing (no labels yet)" };
const WHY = {
  "missed-throw": "You tapped a throw here that the model missed. Box the ball as it climbs, even if it's blurred or in front of you.",
  disagree: "Picked because the model and the automatic labels disagree here.",
  random: "A random frame. These keep the labels honest and test the model fairly.",
};

function progress() {
  const done = queue.filter((f) => reviewed.has(f.n)).length;
  $("bxDone").textContent = done;
  $("bxTotal").textContent = queue.length;
  $("bxBar").style.width = queue.length ? `${(100 * done) / queue.length}%` : "0";
  $("bxFrame").textContent = n ?? "–";
  const item = queue.find((f) => f.n === n);
  $("bxWhy").textContent = item ? WHY[item.why] ?? "" : "A neighbouring frame (not in the queue). You can still save it.";
  $("bxWhere").textContent = n === null ? "–" : `${vid} · frame ${n} · ${(n / 30).toFixed(2)} s`;
  $("bxSource").textContent = `Pre-filled from ${SOURCES[source]}${dirty ? " · edited" : ""}${reviewed.has(n) ? " · saved" : ""}`;
}

function toast(msg) {
  const el = $("bxToast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 1600);
}

// ---------- keys & buttons ----------

$("bxAccept").addEventListener("click", save);
$("bxSkip").addEventListener("click", () => { dirty = false; next(); });
$("bxPrev").addEventListener("click", prevQueued);

document.addEventListener("keydown", (e) => {
  if (!active || !img || e.target.matches?.("input, select, textarea")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); return undo(); }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const nudge = (dx, dy) => {
    if (selIdx < 0) return;
    const step = e.shiftKey ? 5 : 1;
    edit(() => { const [x, y, w, h] = toPx(boxes[selIdx]); boxes[selIdx] = fromPx(x + dx * step, y + dy * step, w, h); });
  };
  const grow = (d) => {
    if (selIdx < 0) return;
    edit(() => { const [x, y, w, h] = toPx(boxes[selIdx]); boxes[selIdx] = fromPx(x - d, y - d, Math.max(w + 2 * d, MIN_BOX), Math.max(h + 2 * d, MIN_BOX)); });
  };
  const keys = {
    Enter: save, " ": save,
    s: () => { dirty = false; next(); },
    ",": () => goNeighbour(-1), ".": () => goNeighbour(1), "<": () => goNeighbour(-1), ">": () => goNeighbour(1),
    a: () => {
      const add = visiblePreds().filter((p) => p[4] >= 0.25);
      if (!add.length) return toast("No suggestions to accept");
      edit(() => boxes.push(...add.map((p) => p.slice(0, 4))));
    },
    Backspace: () => selIdx >= 0 && edit(() => { boxes.splice(selIdx, 1); selIdx = -1; }),
    Delete: () => selIdx >= 0 && edit(() => { boxes.splice(selIdx, 1); selIdx = -1; }),
    c: () => boxes.length && edit(() => { boxes = []; selIdx = -1; }),
    z: undo,
    Escape: () => { selIdx = -1; draw(); },
    Tab: () => { if (boxes.length) { selIdx = (selIdx + (e.shiftKey ? boxes.length - 1 : 1)) % boxes.length; draw(); } },
    ArrowLeft: () => nudge(-1, 0), ArrowRight: () => nudge(1, 0), ArrowUp: () => nudge(0, -1), ArrowDown: () => nudge(0, 1),
    "[": () => grow(-1), "]": () => grow(1),
    h: () => { hidden = true; draw(); },
    Shift: () => { loupe = true; draw(); },
  };
  const fn = keys[e.key];
  if (fn) { e.preventDefault(); fn(); }
});

document.addEventListener("keyup", (e) => {
  if (!active) return;
  if (e.key === "h") { hidden = false; draw(); }
  if (e.key === "Shift") { loupe = false; draw(); }
});

addEventListener("beforeunload", (e) => { if (active && dirty) e.preventDefault(); });
