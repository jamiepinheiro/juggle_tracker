// Manual labelling: watch a video, tap J on each throw, D at the drop. Each segment keeps its count
// and the video time of every tap, so the labels double as ground truth for the counter.
// With tools/label_server.py running, project videos can be picked from data/ and labels save
// straight to data/<video>/throws.labels.json; the model's own throws can be overlaid for review.

const $ = (id) => document.getElementById(id);
const video = $("video");
const FRAME = 1 / 30;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

let fileInfo = null;        // {name, size, project?}
let server = false;         // tools/label_server.py is serving this page
let modelThrows = null;     // [t...] the model + counter's throws for the open project video
let segs = [];              // {id, start, end|null, count, taps: [t...]}
let sel = null;             // selected segment id
let undoStack = [];
let typed = "";             // digits typed for a count, committed with Enter

// ---------- persistence ----------

const storeKey = () => fileInfo && `juggle-labels:${fileInfo.name}:${fileInfo.size}`;

function save() {
  if (!fileInfo) return;
  try { localStorage.setItem(storeKey(), JSON.stringify({ ...fileInfo, segs })); } catch {}
  if (fileInfo.project) saveToProject();
}

// debounced write to data/<video>/throws.labels.json
function saveToProject() {
  clearTimeout(saveToProject.t);
  $("savedTo").textContent = "Saving…";
  saveToProject.t = setTimeout(async () => {
    try {
      const r = await fetch(`/api/video/${fileInfo.project}/throws`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(exportData()),
      });
      if (!r.ok) throw new Error(r.status);
      $("savedTo").textContent = `Saved to data/${fileInfo.project}/throws.labels.json`;
    } catch {
      $("savedTo").textContent = "Not saved to the project (is the label server running?). Kept in this browser.";
    }
  }, 400);
}

function restore() {
  try {
    const raw = localStorage.getItem(storeKey());
    return raw ? JSON.parse(raw).segs || [] : [];
  } catch { return []; }
}

function snapshot() {
  undoStack.push(JSON.stringify({ segs, sel }));
  if (undoStack.length > 300) undoStack.shift();
}

function undo() {
  const prev = undoStack.pop();
  if (!prev) return toast("Nothing to undo");
  ({ segs, sel } = JSON.parse(prev));
  changed();
  toast("Undone");
}

// ---------- segment model ----------

const now = () => video.currentTime;
const openSeg = () => segs.find((s) => s.end === null);
const selSeg = () => openSeg() || segs.find((s) => s.id === sel) || null;
const sortSegs = () => segs.sort((a, b) => a.start - b.start);
const newId = () => Math.random().toString(36).slice(2, 9);

function startSeg(t = now()) {
  snapshot();
  const open = openSeg();
  if (open) closeSeg(open, t);
  const s = { id: newId(), start: t, end: null, count: 0, taps: [] };
  segs.push(s);
  sel = s.id;
  sortSegs();
  changed();
  return s;
}

function closeSeg(s, t) {
  s.end = Math.max(t, s.start);
}

function endSeg() {
  const s = openSeg();
  if (!s) return toast("No open segment. Press S or J to start one");
  snapshot();
  closeSeg(s, now());
  sel = s.id;
  changed();
  toast(`Segment ended · ${s.count} juggle${s.count === 1 ? "" : "s"}`);
}

// segments that overlap another one: usually the same stretch labelled twice after rewinding
function overlapping(s) {
  const end = s.end ?? Math.max(now(), s.start);
  return segs.filter((o) => o !== s && o.start < end && (o.end ?? Infinity) > s.start);
}

function tap() {
  let s = openSeg();
  if (!s) {
    const t = now();
    const inside = segs.find((o) => o.end !== null && t >= o.start && t <= o.end);
    if (inside) toast(`Already inside segment ${segs.indexOf(inside) + 1}. Labelling this stretch twice? Z undoes`);
    s = startSeg();
  } else snapshot();
  s.count++;
  s.taps.push(round(now()));
  changed();
  bump();
}

function untap() {
  const s = selSeg();
  if (!s || s.count === 0) return;
  snapshot();
  s.count--;
  if (s.taps.length > s.count) s.taps.pop();
  changed();
}

function setCount(n, s = selSeg()) {
  if (!s) return toast("Select or start a segment first");
  snapshot();
  s.count = n;
  if (s.taps.length > n) s.taps.length = n;
  changed();
  toast(`Count set to ${n}`);
}

function moveEdge(edge) {
  const s = selSeg();
  if (!s) return toast("Select a segment first");
  const t = now();
  if (edge === "start" && s.end !== null && t > s.end) return toast("Start can't be after the end");
  if (edge === "end" && t < s.start) return toast("End can't be before the start");
  snapshot();
  s[edge] = t;
  sortSegs();
  changed();
  toast(`${edge === "start" ? "Start" : "End"} moved to ${fmt(t)}`);
}

function deleteSel() {
  const s = selSeg();
  if (!s) return;
  snapshot();
  segs = segs.filter((x) => x !== s);
  sel = null;
  changed();
  toast("Segment deleted · Z to undo");
}

function jumpSeg(dir) {
  if (!segs.length) return;
  const t = now() + (dir > 0 ? 0.05 : -0.05);
  const target = dir > 0 ? segs.find((s) => s.start > t) : [...segs].reverse().find((s) => s.start < t);
  if (!target) return toast(dir > 0 ? "No later segment" : "No earlier segment");
  selectSeg(target, true);
}

function selectSeg(s, seek) {
  sel = s.id;
  if (seek) video.currentTime = s.start;
  render();
}

// ---------- playback ----------

function togglePlay() {
  if (!video.src) return;
  video.paused ? video.play().catch(() => {}) : video.pause();
}

function seek(dt) {
  if (!video.duration) return;
  video.currentTime = Math.min(Math.max(0, video.currentTime + dt), video.duration);
}

function step(dir) {
  video.pause();
  seek(dir * FRAME);
}

function changeSpeed(dir) {
  const i = SPEEDS.indexOf(video.playbackRate);
  const next = SPEEDS[Math.min(Math.max(0, (i < 0 ? 3 : i) + dir), SPEEDS.length - 1)];
  video.playbackRate = next;
  $("speed").textContent = `${next}×`;
  toast(`Speed ${next}×`);
}

// ---------- rendering ----------

const round = (t) => Math.round(t * 1000) / 1000;

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = s.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function changed() {
  save();
  render();
}

function render() {
  renderSummary();
  renderList();
  renderTimeline();
  renderTicks();
  renderHud();
}

// ---------- taps vs the model's throws ----------

const TOL = 0.35; // s: a tap and a model throw this close are the same throw
const allTaps = () => segs.flatMap((s) => s.taps).sort((a, b) => a - b);
const near = (t, list) => list.some((u) => Math.abs(u - t) <= TOL);

function disagreements() {
  if (!modelThrows) return [];
  const taps = allTaps();
  return [...modelThrows.filter((t) => !near(t, taps)), ...taps.filter((t) => !near(t, modelThrows))].sort((a, b) => a - b);
}

function renderTicks() {
  const d = video.duration;
  const tick = (t, cls) => {
    const el = document.createElement("div");
    el.className = cls;
    el.style.left = `${(t / d) * 100}%`;
    return el;
  };
  if (!d) { $("tlTaps").replaceChildren(); $("tlModel").replaceChildren(); return; }
  const taps = allTaps();
  const show = $("showModel").checked && modelThrows;
  $("tlTaps").replaceChildren(...taps.map((t) => tick(t, show && !near(t, modelThrows) ? "tk miss" : "tk")));
  $("tlModel").hidden = !show;
  $("modelLegend").hidden = !show;
  if (show) $("tlModel").replaceChildren(...modelThrows.map((t) => tick(t, near(t, taps) ? "tk" : "tk miss")));
}

function nextDisagreement() {
  if (!modelThrows) return toast("Model throws are only available for project videos");
  if (!$("showModel").checked) { $("showModel").checked = true; renderTicks(); }
  const t = disagreements().find((x) => x > now() + 0.8);
  if (t === undefined) return toast("No more disagreements after this point");
  video.pause();
  video.currentTime = Math.max(0, t - 0.7);   // land just before it so you can watch it happen
  toast(`Disagreement at ${fmt(t)}. Play to watch it`);
}

function renderSummary() {
  const counts = segs.map((s) => s.count);
  const total = counts.reduce((a, b) => a + b, 0);
  $("sumTotal").textContent = total;
  $("sumSegs").textContent = segs.length;
  $("sumBest").textContent = counts.length ? Math.max(...counts) : "–";
  $("sumAvg").textContent = counts.length ? (total / counts.length).toFixed(1) : "–";
}

function renderList() {
  const list = $("segList");
  const focusedId = document.activeElement?.closest?.("li")?.dataset.id;
  list.replaceChildren(...segs.map((s, i) => {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    if (s.id === (selSeg()?.id)) li.classList.add("sel");

    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = i + 1;

    const range = document.createElement("span");
    range.className = "range";
    if (s.end === null) {
      range.innerHTML = `${fmt(s.start)} → <span class="open-tag">open</span>`;
    } else {
      range.textContent = `${fmt(s.start)} → ${fmt(s.end)}`;
      const dur = document.createElement("small");
      dur.textContent = `${(s.end - s.start).toFixed(1)}s`;
      range.append(dur);
    }

    const input = document.createElement("input");
    input.type = "number"; input.min = "0"; input.step = "1";
    input.value = s.count;
    input.setAttribute("aria-label", `Juggles in segment ${i + 1}`);
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", () => {
      const n = Math.max(0, parseInt(input.value, 10) || 0);
      if (n !== s.count) setCount(n, s);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") input.blur();
    });

    const del = document.createElement("button");
    del.className = "del"; del.textContent = "×"; del.title = "Delete segment";
    del.addEventListener("click", (e) => { e.stopPropagation(); sel = s.id; deleteSel(); });

    if (overlapping(s).length) {
      const tag = document.createElement("small");
      tag.className = "overlap-tag";
      tag.textContent = "overlaps";
      tag.title = "This segment overlaps another one. The same throws may be counted twice";
      range.append(tag);
    }
    li.append(idx, range, input, del);
    li.addEventListener("click", () => selectSeg(s, true));
    return li;
  }));
  $("segEmpty").hidden = segs.length > 0;
  if (focusedId) list.querySelector(`li[data-id="${focusedId}"] input`)?.focus();
  list.querySelector("li.sel")?.scrollIntoView({ block: "nearest" });
}

function renderTimeline() {
  const d = video.duration;
  const box = $("tlSegs");
  if (!d) { box.replaceChildren(); return; }
  const cur = selSeg()?.id;
  box.replaceChildren(...segs.map((s) => {
    const el = document.createElement("div");
    el.className = "tl-seg" + (s.end === null ? " open" : "") + (s.id === cur ? " sel" : "");
    el.dataset.id = s.id;
    const end = s.end === null ? Math.max(now(), s.start) : s.end;
    el.style.left = `${(s.start / d) * 100}%`;
    el.style.width = `${((end - s.start) / d) * 100}%`;
    el.title = `${fmt(s.start)}–${fmt(end)} · ${s.count}`;
    return el;
  }));
}

function renderTime() {
  const d = video.duration || 0;
  $("tNow").textContent = fmt(video.currentTime);
  $("playhead").style.left = d ? `${(video.currentTime / d) * 100}%` : "0";
  const open = openSeg();
  if (open && d) {
    const el = $("tlSegs").querySelector(`[data-id="${open.id}"]`);
    if (el) el.style.width = `${((Math.max(now(), open.start) - open.start) / d) * 100}%`;
  }
}

function renderHud() {
  const hud = $("hud");
  hud.hidden = !video.src;
  hud.classList.toggle("typing", typed !== "");
  if (typed) {
    $("hudLabel").textContent = "Set count · Enter";
    $("hudCount").textContent = typed;
    return;
  }
  const open = openSeg();
  const s = selSeg();
  $("hudLabel").textContent = open ? "Counting" : s ? `Segment ${segs.indexOf(s) + 1}` : "Press J on each throw";
  $("hudCount").textContent = s ? s.count : "0";
}

function bump() {
  const el = $("hudCount");
  el.classList.add("bump");
  clearTimeout(bump.t);
  bump.t = setTimeout(() => el.classList.remove("bump"), 150);
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 1600);
}

// smooth playhead while playing
(function tick() {
  if (!video.paused) renderTime();
  requestAnimationFrame(tick);
})();
video.addEventListener("timeupdate", renderTime);
video.addEventListener("seeked", renderTime);
video.addEventListener("play", () => ($("playBtn").textContent = "Pause"));
video.addEventListener("pause", () => ($("playBtn").textContent = "Play"));
video.addEventListener("loadedmetadata", () => {
  $("tDur").textContent = fmt(video.duration);
  $("playBtn").disabled = false;
  render();
  renderTime();
});

// ---------- loading ----------

function openFile(f) {
  if (!f || !f.type.startsWith("video/")) return toast("That isn't a video file");
  if (video.src) URL.revokeObjectURL(video.src);
  fileInfo = { name: f.name, size: f.size };
  modelThrows = null;
  $("savedTo").textContent = "Saved in this browser";
  if (server) $("projectVideo").value = "";
  segs = restore();
  sel = null;
  undoStack = [];
  typed = "";
  video.src = URL.createObjectURL(f);
  video.playbackRate = 1;
  $("speed").textContent = "1×";
  $("empty").hidden = true;
  $("fileName").textContent = f.name;
  $("fileName").title = f.name;
  render();
  if (segs.length) toast(`Restored ${segs.length} segment${segs.length === 1 ? "" : "s"}`);
}

$("fileIn").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });

async function openProject(id) {
  const v = projectVideos.find((x) => x.id === id);
  if (!v?.video) return toast("No playable copy in data/videos for this video");
  if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
  fileInfo = { name: id, size: 0, project: id };
  const [saved, model] = await Promise.all([
    fetch(`/api/video/${id}/throws`).then((r) => r.json()).catch(() => null),
    fetch(`/api/video/${id}/model_throws`).then((r) => r.json()).catch(() => null),
  ]);
  modelThrows = model?.times ?? null;
  segs = (saved?.segments ?? []).map((s) => ({ id: newId(), start: s.start, end: s.end, count: s.count, taps: s.taps ?? [] }));
  if (!segs.length) segs = restore();   // earlier browser-only labels for this video
  sel = null; undoStack = []; typed = "";
  video.src = v.video;
  video.playbackRate = 1;
  $("speed").textContent = "1×";
  $("empty").hidden = true;
  $("fileName").textContent = id;
  $("savedTo").textContent = saved ? `Saved to data/${id}/throws.labels.json` : "Autosaves to the project";
  $("showModel").disabled = !modelThrows;
  render();
  toast(segs.length ? `Loaded ${segs.length} segment${segs.length === 1 ? "" : "s"}` : `Opened ${id}`);
}

let projectVideos = [];
fetch("/api/videos").then((r) => (r.ok ? r.json() : Promise.reject())).then((list) => {
  server = true;
  projectVideos = list;
  const sel = $("projectVideo");
  sel.replaceChildren(new Option("Project videos…", ""), ...list.filter((v) => v.video).map((v) =>
    new Option(`${v.id}${v.hasThrows ? " · labelled" : ""}`, v.id)));
  sel.hidden = false;
  sel.addEventListener("change", () => sel.value && openProject(sel.value));
  document.dispatchEvent(new CustomEvent("label-server", { detail: list }));
}).catch(() => {});

$("showModel").addEventListener("change", renderTicks);

// ---------- modes ----------

function setMode(mode) {
  document.body.dataset.mode = mode;
  $("modeThrows").setAttribute("aria-selected", mode === "throws");
  $("modeBoxes").setAttribute("aria-selected", mode === "boxes");
  $("throwsMode").hidden = mode !== "throws";
  $("boxesMode").hidden = mode !== "boxes";
  for (const id of ["openLabel", "exportJson", "exportCsv"]) $(id).hidden = mode !== "throws";
  document.querySelector('label[for="importIn"]').hidden = mode !== "throws";
  $("savedTo").hidden = mode !== "throws";
  if (mode === "boxes") video.pause();
  document.dispatchEvent(new CustomEvent("label-mode", { detail: mode }));
}
$("modeThrows").addEventListener("click", () => setMode("throws"));
$("modeBoxes").addEventListener("click", () => setMode("boxes"));
document.body.dataset.mode = "throws";

const vp = $("viewport");
vp.addEventListener("dragover", (e) => { e.preventDefault(); vp.classList.add("drag"); });
vp.addEventListener("dragleave", () => vp.classList.remove("drag"));
vp.addEventListener("drop", (e) => {
  e.preventDefault();
  vp.classList.remove("drag");
  openFile(e.dataTransfer.files[0]);
});
vp.addEventListener("click", togglePlay);
$("playBtn").addEventListener("click", togglePlay);
// keep focus off buttons so Space and Enter always reach the shortcuts
document.addEventListener("click", (e) => { if (e.target.closest("button, label.button")) e.target.closest("button, label.button").blur(); });

// ---------- timeline scrubbing ----------

const tl = $("timeline");
function scrubTo(e) {
  if (!video.duration) return;
  const r = tl.getBoundingClientRect();
  video.currentTime = Math.min(Math.max(0, (e.clientX - r.left) / r.width), 1) * video.duration;
  renderTime();
}
tl.addEventListener("pointerdown", (e) => {
  tl.setPointerCapture(e.pointerId);
  const hit = e.target.closest(".tl-seg");
  if (hit) { sel = hit.dataset.id; render(); }
  scrubTo(e);
});
tl.addEventListener("pointermove", (e) => { if (tl.hasPointerCapture(e.pointerId)) scrubTo(e); });

// ---------- import / export ----------

function exportData() {
  return {
    video: fileInfo?.name ?? null,
    duration: video.duration ? round(video.duration) : null,
    total: segs.reduce((a, s) => a + s.count, 0),
    segments: segs.map((s) => ({ start: round(s.start), end: s.end === null ? null : round(s.end), count: s.count, taps: s.taps })),
  };
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const baseName = () => (fileInfo?.name ?? "labels").replace(/\.[^.]+$/, "");

$("exportJson").addEventListener("click", () => {
  if (!segs.length) return toast("No segments to export");
  download(`${baseName()}.labels.json`, JSON.stringify(exportData(), null, 2), "application/json");
});

$("exportCsv").addEventListener("click", () => {
  if (!segs.length) return toast("No segments to export");
  const rows = [["segment", "start_s", "end_s", "duration_s", "juggles"]];
  segs.forEach((s, i) => rows.push([
    i + 1, round(s.start), s.end === null ? "" : round(s.end),
    s.end === null ? "" : round(s.end - s.start), s.count,
  ]));
  download(`${baseName()}.labels.csv`, rows.map((r) => r.join(",")).join("\n") + "\n", "text/csv");
});

$("importIn").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const list = Array.isArray(data) ? data : data.segments;
    if (!Array.isArray(list)) throw new Error("no segments");
    snapshot();
    segs = list.map((s) => ({
      id: newId(),
      start: +s.start || 0,
      end: s.end == null ? null : +s.end,
      count: Math.max(0, parseInt(s.count, 10) || 0),
      taps: Array.isArray(s.taps) ? s.taps : [],
    }));
    sortSegs();
    sel = null;
    changed();
    toast(`Imported ${segs.length} segments`);
  } catch {
    toast("Couldn't read that labels file");
  }
});

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (document.body.dataset.mode !== "throws") return;
  const inField = e.target.matches?.("input, textarea, select");
  if (inField) return;

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!video.src) return;

  // typed count
  if (/^[0-9]$/.test(e.key)) {
    typed = (typed + e.key).replace(/^0+(?=\d)/, "").slice(0, 4);
    renderHud();
    e.preventDefault();
    return;
  }
  if (typed) {
    if (e.key === "Enter") { const n = parseInt(typed, 10); typed = ""; setCount(n); e.preventDefault(); return; }
    if (e.key === "Backspace") { typed = typed.slice(0, -1); renderHud(); e.preventDefault(); return; }
    if (e.key === "Escape") { typed = ""; renderHud(); e.preventDefault(); return; }
  }

  const handlers = {
    " ": togglePlay, k: togglePlay, K: togglePlay,
    j: tap, ArrowUp: tap,
    J: untap, ArrowDown: untap,
    s: () => { const t = now(); startSeg(t); toast(`Segment started at ${fmt(t)}`); },
    d: endSeg, e: endSeg,
    "[": () => moveEdge("start"), "]": () => moveEdge("end"),
    ArrowLeft: () => seek(e.shiftKey ? -10 : -2),
    ArrowRight: () => seek(e.shiftKey ? 10 : 2),
    ",": () => step(-1), ".": () => step(1), "<": () => step(-1), ">": () => step(1),
    "-": () => changeSpeed(-1), "_": () => changeSpeed(-1),
    "=": () => changeSpeed(1), "+": () => changeSpeed(1),
    n: () => jumpSeg(1), p: () => jumpSeg(-1),
    Backspace: deleteSel, Delete: deleteSel,
    z: undo,
    m: () => {
      if (!modelThrows) return toast("Model throws are only available for project videos");
      $("showModel").checked = !$("showModel").checked; renderTicks();
    },
    x: nextDisagreement,
    Escape: () => { sel = null; render(); },
  };
  const fn = handlers[e.key];
  if (fn) {
    e.preventDefault();
    fn();
  }
});

render();
