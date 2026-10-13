// Ball tracking + throw counting. Pure logic, no DOM: fed detections, emits throws.
//
// Coordinates are normalised to the frame: x,y in [0,1], y grows downward.
// A throw is counted once per arc, at its apex. An apex counts when the ball then falls and either
//   a) the ball was seen climbing at least `need` (a few ball diameters) before it, or
//   b) the top of the arc is a parabola curving at roughly gravity and the ball then falls `need`.
// Either way, if there are enough samples around the apex its curvature must match gravity.
//      Balls are often too blurred to detect right after release, so sometimes only the top
//      of the arc is seen.
// A rising ball that leaves through the top of the frame also counts.

export const DEFAULTS = {
  maxMissing: 0.25,   // s a track survives without a detection
  gate: 0.14,         // max association distance (normalised), scaled up with speed
  minRise: 0.10,      // climb/fall that makes an arc a throw (fraction of frame height)
  minRiseBalls: 2.0,  // ...or this many ball diameters, whichever is larger
  turnBalls: 0.35,    // fall below the peak (ball diameters) that confirms an apex seen climbing
  gBalls: 95,         // gravity in detector-box diameters / s^2 (measured on real arcs; the boxes
                      // are padded, so this is below 9.8 m/s^2 over a ~6.5 cm ball)
  gRange: [0.5, 2.0], // accepted curvature, as a multiple of gravity
  runGap: 1.5,        // s without a throw that ends a run
  topEdge: 1.5,       // ball diameters from the top: a rising ball lost there left the frame (thrown)
  dupTime: 0.18,      // s: two apexes this close in time and space are the same throw
  dupBalls: 1.5,      // ...and space, in ball diameters
  history: 2.0,       // s of samples kept per track
};

export class JuggleCounter {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.onThrow = null;   // (throwEvent) => void
    this.onDuplicate = null; // (apex) => void: an apex suppressed as a repeat of a counted one
    this.onRunEnd = null;  // (runLength, endedAt) => void
    this.reset();
  }

  reset() {
    this.tracks = [];
    this.recent = [];      // recent apexes, for duplicate suppression
    this.nextId = 1;
    this.total = 0;
    this.run = 0;
    this.lastThrowAt = -Infinity;
  }

  /** dets: [{x, y, size, score}] normalised; t: seconds. Returns current tracks. */
  update(dets, t) {
    const o = this.o;
    const live = this.tracks;
    dets = dedupe(dets);

    // Greedy nearest-neighbour association against constant-velocity predictions.
    const pairs = [];
    for (const tr of live) {
      const dt = t - tr.t;
      const px = tr.x + tr.vx * dt, py = tr.y + tr.vy * dt;
      const gate = o.gate + Math.hypot(tr.vx, tr.vy) * dt * 0.5;
      dets.forEach((d, j) => {
        const dist = Math.hypot(d.x - px, d.y - py);
        if (dist < gate) pairs.push([dist, tr, j]);
      });
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, tr, j] of pairs) {
      if (usedT.has(tr) || usedD.has(j)) continue;
      usedT.add(tr); usedD.add(j);
      this._step(tr, dets[j], t);
    }
    dets.forEach((d, j) => {
      if (!usedD.has(j)) live.push(this._newTrack(d, t));
    });

    // Retire stale tracks; a ball that vanished off the top while climbing was thrown.
    this.tracks = live.filter((tr) => {
      if (t - tr.t <= o.maxMissing) return true;
      if (tr.vy < 0 && tr.y < o.topEdge * tr.size) {
        const low = Math.max(...this._since(tr).map((p) => p.y), tr.y);
        if (low - tr.y >= this._need(tr)) this._count(tr, tr.t, tr.x, tr.y, "left-top");
      }
      return false;
    });

    if (this.run > 0 && t - this.lastThrowAt > o.runGap) {
      const n = this.run;
      this.run = 0;
      this.onRunEnd?.(n, this.lastThrowAt);
    }
    return this.tracks;
  }

  _newTrack(d, t) {
    return {
      id: this.nextId++, x: d.x, y: d.y, vx: 0, vy: 0, size: d.size, t,
      samples: [{ t, x: d.x, y: d.y }],
      apexT: -Infinity,  // time of the last apex counted on this track
      falling: false,    // after an apex, until the ball bottoms out (is caught) and climbs again
      floorY: 0, floorT: -Infinity, // lowest point since the last apex: the next arc starts here
      throws: 0,
      trail: [[d.x, d.y]],
    };
  }

  _step(tr, d, t) {
    const dt = Math.max(t - tr.t, 1e-3);
    const a = 0.6; // velocity smoothing
    tr.vx = a * ((d.x - tr.x) / dt) + (1 - a) * tr.vx;
    tr.vy = a * ((d.y - tr.y) / dt) + (1 - a) * tr.vy;
    tr.x = d.x; tr.y = d.y; tr.t = t;
    tr.size = 0.8 * tr.size + 0.2 * d.size;
    tr.trail.push([d.x, d.y]);
    if (tr.trail.length > 24) tr.trail.shift();
    tr.samples.push({ t, x: d.x, y: d.y });
    while (tr.samples[0].t < t - this.o.history) tr.samples.shift();
    if (tr.falling) {
      if (d.y >= tr.floorY) { tr.floorY = d.y; tr.floorT = t; }
      else if (tr.floorY - d.y > this.o.turnBalls * tr.size) tr.falling = false;
    }
    if (!tr.falling) this._checkApex(tr);
  }

  // Samples of the current arc: from the bottom of the previous one.
  _since(tr) {
    return tr.samples.filter((p) => p.t >= tr.floorT);
  }

  _checkApex(tr) {
    const s = this._since(tr);
    if (s.length < 3) return;
    let k = 0;
    for (let i = 1; i < s.length; i++) if (s[i].y < s[k].y) k = i;
    if (k === 0 || k === s.length - 1) return; // peak needs samples on both sides
    const peak = s[k], need = this._need(tr);
    const before = Math.max(...s.slice(0, k).map((p) => p.y)) - peak.y;
    const after = Math.max(...s.slice(k + 1).map((p) => p.y)) - peak.y;
    const freeFall = this._freeFall(tr, peak.t); // null: too few samples to tell
    const climbed = before >= need && after >= this.o.turnBalls * tr.size && freeFall !== false;
    const arced = after >= need && before > 0 && freeFall === true;
    if (climbed || arced) this._count(tr, peak.t, peak.x, peak.y, climbed ? "climbed" : "arc");
  }

  // Fit y = a t^2 + b t + c around the apex: a ball in free flight curves at about gravity,
  // a hand moving a ball around curves far less.
  _freeFall(tr, tp) {
    const pts = tr.samples.filter((p) => Math.abs(p.t - tp) <= 0.2);
    if (pts.length < 5 || !pts.some((p) => p.t < tp) || !pts.some((p) => p.t > tp)) return null;
    const acc = 2 * quadA(pts.map((p) => p.t - tp), pts.map((p) => p.y));
    const g = this.o.gBalls * tr.size;
    return acc >= this.o.gRange[0] * g && acc <= this.o.gRange[1] * g;
  }

  _need(tr) { return Math.max(this.o.minRise, this.o.minRiseBalls * tr.size); }

  // reason: "climbed" (rise seen), "arc" (only the parabolic top seen), "left-top" (exited upward)
  _count(tr, at, x, y, reason) {
    tr.apexT = at;
    tr.falling = true;
    tr.floorY = y; tr.floorT = at;
    for (const p of tr.samples) if (p.t >= at && p.y >= tr.floorY) { tr.floorY = p.y; tr.floorT = p.t; }
    // a twin track on the same ball can reach the same apex: count it once
    const dup = this.recent.some((r) => Math.abs(r.t - at) < this.o.dupTime &&
      Math.hypot(r.x - x, r.y - y) < this.o.dupBalls * tr.size);
    this.recent.push({ t: at, x, y });
    if (this.recent.length > 8) this.recent.shift();
    if (dup) { this.onDuplicate?.({ trackId: tr.id, t: at, x, y, reason }); return; }
    tr.throws++;
    this.total++;
    this.run++;
    this.lastThrowAt = at;
    this.onThrow?.({ trackId: tr.id, t: at, x, y, reason, run: this.run, total: this.total });
  }
}

// Least-squares coefficient of x^2 for a quadratic fit through points (x, y).
function quadA(xs, ys) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  xs.forEach((x, i) => {
    const y = ys[i], x2 = x * x;
    s0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  });
  // [[s4 s3 s2][s3 s2 s1][s2 s1 s0]] [a b c]^T = [t2 t1 t0]^T, solved for a by Cramer's rule
  const det3 = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det3([s4, s3, s2, s3, s2, s1, s2, s1, s0]);
  return D ? det3([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / D : 0;
}

// Merge detections that overlap by more than half a ball: one ball, one detection.
function dedupe(dets) {
  const out = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score)) {
    if (out.every((k) => Math.hypot(k.x - d.x, k.y - d.y) > 0.5 * Math.max(k.size, d.size))) out.push(d);
  }
  return out;
}
