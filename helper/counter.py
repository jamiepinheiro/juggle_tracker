"""Ball tracking + throw counting. Pure logic: fed detections, counts throws.

Coordinates are normalised to the frame: x, y in [0, 1], y grows downward.
A throw is counted once per arc, at its apex. An apex counts when the ball then falls and either
  a) the ball was seen climbing at least `need` (a few ball diameters) before it, or
  b) the top of the arc is a parabola curving at roughly gravity and the ball then falls `need`.
Either way, if there are enough samples around the apex its curvature must match gravity.
A rising ball that leaves through the top of the frame also counts.
"""

import math

DEFAULTS = dict(
    max_missing=0.25,   # s a track survives without a detection
    gate=0.14,          # max association distance (normalised), scaled up with speed
    min_rise=0.10,      # climb/fall that makes an arc a throw (fraction of frame height)
    min_rise_balls=2.0, # ...or this many ball diameters, whichever is larger
    turn_balls=0.35,    # fall below the peak (ball diameters) that confirms an apex seen climbing
    g_balls=95,         # gravity in detector-box diameters / s^2
    g_range=(0.5, 2.0), # accepted curvature, as a multiple of gravity
    run_gap=1.5,        # s without a throw that ends a run
    top_edge=1.5,       # ball diameters from the top: a rising ball lost there left the frame
    dup_time=0.18,      # s: two apexes this close in time and space are the same throw
    dup_balls=1.5,      # ...and space, in ball diameters
    history=2.0,        # s of samples kept per track
)


class Track:
    def __init__(self, tid, d, t):
        self.id = tid
        self.x, self.y = d["x"], d["y"]
        self.vx = self.vy = 0.0
        self.size = d["size"]
        self.t = t
        self.samples = [(t, d["x"], d["y"])]
        self.falling = False
        self.floor_y, self.floor_t = 0.0, -math.inf
        self.trail = [(d["x"], d["y"])]


class JuggleCounter:
    def __init__(self, **opts):
        self.o = {**DEFAULTS, **opts}
        self.on_throw = None    # (total, run) -> None
        self.on_run_end = None  # (run_length) -> None
        self.reset()

    def reset(self):
        self.tracks = []
        self.recent = []
        self.next_id = 1
        self.total = 0
        self.run = 0
        self.last_throw_at = -math.inf

    def update(self, dets, t):
        o = self.o
        dets = _dedupe(dets)

        # Greedy nearest-neighbour association against constant-velocity predictions.
        pairs = []
        for tr in self.tracks:
            dt = t - tr.t
            px, py = tr.x + tr.vx * dt, tr.y + tr.vy * dt
            gate = o["gate"] + math.hypot(tr.vx, tr.vy) * dt * 0.5
            for j, d in enumerate(dets):
                dist = math.hypot(d["x"] - px, d["y"] - py)
                if dist < gate:
                    pairs.append((dist, id(tr), tr, j))
        pairs.sort(key=lambda p: p[0])
        used_t, used_d = set(), set()
        for _, key, tr, j in pairs:
            if key in used_t or j in used_d:
                continue
            used_t.add(key)
            used_d.add(j)
            self._step(tr, dets[j], t)
        for j, d in enumerate(dets):
            if j not in used_d:
                self.tracks.append(Track(self.next_id, d, t))
                self.next_id += 1

        # Retire stale tracks; a ball that vanished off the top while climbing was thrown.
        kept = []
        for tr in self.tracks:
            if t - tr.t <= o["max_missing"]:
                kept.append(tr)
                continue
            if tr.vy < 0 and tr.y < o["top_edge"] * tr.size:
                low = max([p[2] for p in self._since(tr)] + [tr.y])
                if low - tr.y >= self._need(tr):
                    self._count(tr, tr.t, tr.x, tr.y)
        self.tracks = kept

        if self.run > 0 and t - self.last_throw_at > o["run_gap"]:
            n = self.run
            self.run = 0
            if self.on_run_end:
                self.on_run_end(n)
        return self.tracks

    def _step(self, tr, d, t):
        dt = max(t - tr.t, 1e-3)
        a = 0.6  # velocity smoothing
        tr.vx = a * ((d["x"] - tr.x) / dt) + (1 - a) * tr.vx
        tr.vy = a * ((d["y"] - tr.y) / dt) + (1 - a) * tr.vy
        tr.x, tr.y, tr.t = d["x"], d["y"], t
        tr.size = 0.8 * tr.size + 0.2 * d["size"]
        tr.trail.append((d["x"], d["y"]))
        if len(tr.trail) > 24:
            tr.trail.pop(0)
        tr.samples.append((t, d["x"], d["y"]))
        while tr.samples[0][0] < t - self.o["history"]:
            tr.samples.pop(0)
        if tr.falling:
            if d["y"] >= tr.floor_y:
                tr.floor_y, tr.floor_t = d["y"], t
            elif tr.floor_y - d["y"] > self.o["turn_balls"] * tr.size:
                tr.falling = False
        if not tr.falling:
            self._check_apex(tr)

    def _since(self, tr):
        # Samples of the current arc: from the bottom of the previous one.
        return [p for p in tr.samples if p[0] >= tr.floor_t]

    def _check_apex(self, tr):
        s = self._since(tr)
        if len(s) < 3:
            return
        k = min(range(len(s)), key=lambda i: (s[i][2], i))
        if k == 0 or k == len(s) - 1:
            return  # peak needs samples on both sides
        pt, px, py = s[k]
        need = self._need(tr)
        before = max(p[2] for p in s[:k]) - py
        after = max(p[2] for p in s[k + 1:]) - py
        free_fall = self._free_fall(tr, pt)  # None: too few samples to tell
        climbed = before >= need and after >= self.o["turn_balls"] * tr.size and free_fall is not False
        arced = after >= need and before > 0 and free_fall is True
        if climbed or arced:
            self._count(tr, pt, px, py)

    def _free_fall(self, tr, tp):
        # Fit y = a t^2 + b t + c around the apex: a ball in free flight curves at about gravity.
        pts = [p for p in tr.samples if abs(p[0] - tp) <= 0.2]
        if len(pts) < 5 or not any(p[0] < tp for p in pts) or not any(p[0] > tp for p in pts):
            return None
        acc = 2 * _quad_a([p[0] - tp for p in pts], [p[2] for p in pts])
        g = self.o["g_balls"] * tr.size
        lo, hi = self.o["g_range"]
        return lo * g <= acc <= hi * g

    def _need(self, tr):
        return max(self.o["min_rise"], self.o["min_rise_balls"] * tr.size)

    def _count(self, tr, at, x, y):
        tr.falling = True
        tr.floor_y, tr.floor_t = y, at
        for p in tr.samples:
            if p[0] >= at and p[2] >= tr.floor_y:
                tr.floor_y, tr.floor_t = p[2], p[0]
        # a twin track on the same ball can reach the same apex: count it once
        dup = any(abs(r[0] - at) < self.o["dup_time"] and
                  math.hypot(r[1] - x, r[2] - y) < self.o["dup_balls"] * tr.size
                  for r in self.recent)
        self.recent.append((at, x, y))
        if len(self.recent) > 8:
            self.recent.pop(0)
        if dup:
            return
        self.total += 1
        self.run += 1
        self.last_throw_at = at
        if self.on_throw:
            self.on_throw(self.total, self.run)


def _quad_a(xs, ys):
    # Least-squares coefficient of x^2 for a quadratic fit through points (x, y).
    s0 = s1 = s2 = s3 = s4 = t0 = t1 = t2 = 0.0
    for x, y in zip(xs, ys):
        x2 = x * x
        s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2
        t0 += y; t1 += x * y; t2 += x2 * y

    def det3(m):
        return (m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
                + m[2] * (m[3] * m[7] - m[4] * m[6]))

    D = det3([s4, s3, s2, s3, s2, s1, s2, s1, s0])
    return det3([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / D if D else 0.0


def _dedupe(dets):
    # Merge detections that overlap by more than half a ball: one ball, one detection.
    out = []
    for d in sorted(dets, key=lambda d: -d["score"]):
        if all(math.hypot(k["x"] - d["x"], k["y"] - d["y"]) > 0.5 * max(k["size"], d["size"]) for k in out):
            out.append(d)
    return out
