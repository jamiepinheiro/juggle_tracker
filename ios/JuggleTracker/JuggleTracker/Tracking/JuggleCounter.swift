// Ball tracking + throw counting. A line-for-line port of web/counter.js (same association,
// apex, gravity and run logic, same defaults). Keep the two in sync.
//
// Coordinates are normalised to the frame: x,y in [0,1], y grows downward.
// A throw is counted once per arc, at its apex. An apex counts when the ball then falls and either
//   a) the ball was seen climbing at least `need` (a few ball diameters) before it, or
//   b) the top of the arc is a parabola curving at roughly gravity and the ball then falls `need`.
// Either way, if there are enough samples around the apex its curvature must match gravity.
//      Balls are often too blurred to detect right after release, so sometimes only the top
//      of the arc is seen.
// A rising ball that leaves through the top of the frame also counts.

import Foundation

struct Detection {
    var x: Double
    var y: Double
    var size: Double
    var score: Double
}

struct ThrowEvent {
    enum Reason: String { case climbed, arc, leftTop }
    let trackId: Int
    let t: Double
    let x: Double
    let y: Double
    let reason: Reason
    let run: Int
    let total: Int
}

struct CounterOptions {
    var maxMissing = 0.25       // s a track survives without a detection
    var gate = 0.14             // max association distance (normalised), scaled up with speed
    var minRise = 0.10          // climb/fall that makes an arc a throw (fraction of frame height)
    var minRiseBalls = 2.0      // ...or this many ball diameters, whichever is larger
    var turnBalls = 0.35        // fall below the peak (ball diameters) that confirms an apex seen climbing
    var gBalls = 95.0           // gravity in detector-box diameters / s^2 (depends on how big the
                                // detector's boxes are relative to the ball)
    var gRange = (0.5, 2.0)     // accepted curvature, as a multiple of gravity
    var runGap = 1.5            // s without a throw that ends a run
    var topEdge = 1.5           // ball diameters from the top: a rising ball lost there left the frame (thrown)
    var dupTime = 0.18          // s: two apexes this close in time and space are the same throw
    var dupBalls = 1.5          // ...and space, in ball diameters
    var history = 2.0           // s of samples kept per track
}

final class Track {
    struct Sample { let t, x, y: Double }

    let id: Int
    var x, y, size, t: Double
    var vx = 0.0, vy = 0.0
    var samples: [Sample]
    var apexT = -Double.infinity       // time of the last apex counted on this track
    var falling = false                // after an apex, until the ball bottoms out (is caught) and climbs again
    var floorY = 0.0, floorT = -Double.infinity  // lowest point since the last apex: the next arc starts here
    var throwCount = 0
    var trail: [(Double, Double)]

    init(id: Int, d: Detection, t: Double) {
        self.id = id
        x = d.x; y = d.y; size = d.size; self.t = t
        samples = [Sample(t: t, x: d.x, y: d.y)]
        trail = [(d.x, d.y)]
    }
}

final class JuggleCounter {
    var o: CounterOptions
    private(set) var tracks: [Track] = []
    private var recent: [(t: Double, x: Double, y: Double)] = []  // recent apexes, for duplicate suppression
    private var nextId = 1
    private(set) var total = 0
    private(set) var run = 0
    private(set) var lastThrowAt = -Double.infinity
    var onThrow: ((ThrowEvent) -> Void)?
    var onRunEnd: ((_ runLength: Int, _ endedAt: Double) -> Void)?

    init(options: CounterOptions = CounterOptions()) { o = options }

    func reset() {
        tracks = []
        recent = []
        nextId = 1
        total = 0
        run = 0
        lastThrowAt = -.infinity
    }

    /// dets normalised; t: seconds. Returns current tracks.
    @discardableResult
    func update(_ input: [Detection], t: Double) -> [Track] {
        var live = tracks
        let dets = dedupe(input)

        // Greedy nearest-neighbour association against constant-velocity predictions.
        var pairs: [(dist: Double, tr: Track, j: Int)] = []
        for tr in live {
            let dt = t - tr.t
            let px = tr.x + tr.vx * dt, py = tr.y + tr.vy * dt
            let gate = o.gate + hypot(tr.vx, tr.vy) * dt * 0.5
            for (j, d) in dets.enumerated() {
                let dist = hypot(d.x - px, d.y - py)
                if dist < gate { pairs.append((dist, tr, j)) }
            }
        }
        pairs.sort { $0.dist < $1.dist }
        var usedT = Set<ObjectIdentifier>(), usedD = Set<Int>()
        for (_, tr, j) in pairs {
            if usedT.contains(ObjectIdentifier(tr)) || usedD.contains(j) { continue }
            usedT.insert(ObjectIdentifier(tr)); usedD.insert(j)
            step(tr, dets[j], t)
        }
        for (j, d) in dets.enumerated() where !usedD.contains(j) {
            live.append(Track(id: nextId, d: d, t: t))
            nextId += 1
        }

        // Retire stale tracks; a ball that vanished off the top while climbing was thrown.
        tracks = live.filter { tr in
            if t - tr.t <= o.maxMissing { return true }
            if tr.vy < 0 && tr.y < o.topEdge * tr.size {
                let low = max(since(tr).map(\.y).max() ?? tr.y, tr.y)
                if low - tr.y >= need(tr) { count(tr, at: tr.t, x: tr.x, y: tr.y, reason: .leftTop) }
            }
            return false
        }

        if run > 0 && t - lastThrowAt > o.runGap {
            let n = run
            run = 0
            onRunEnd?(n, lastThrowAt)
        }
        return tracks
    }

    private func step(_ tr: Track, _ d: Detection, _ t: Double) {
        let dt = max(t - tr.t, 1e-3)
        let a = 0.6 // velocity smoothing
        tr.vx = a * ((d.x - tr.x) / dt) + (1 - a) * tr.vx
        tr.vy = a * ((d.y - tr.y) / dt) + (1 - a) * tr.vy
        tr.x = d.x; tr.y = d.y; tr.t = t
        tr.size = 0.8 * tr.size + 0.2 * d.size
        tr.trail.append((d.x, d.y))
        if tr.trail.count > 24 { tr.trail.removeFirst() }
        tr.samples.append(Track.Sample(t: t, x: d.x, y: d.y))
        while tr.samples[0].t < t - o.history { tr.samples.removeFirst() }
        if tr.falling {
            if d.y >= tr.floorY { tr.floorY = d.y; tr.floorT = t }
            else if tr.floorY - d.y > o.turnBalls * tr.size { tr.falling = false }
        }
        if !tr.falling { checkApex(tr) }
    }

    // Samples of the current arc: from the bottom of the previous one.
    private func since(_ tr: Track) -> [Track.Sample] {
        tr.samples.filter { $0.t >= tr.floorT }
    }

    private func checkApex(_ tr: Track) {
        let s = since(tr)
        guard s.count >= 3 else { return }
        var k = 0
        for i in 1..<s.count where s[i].y < s[k].y { k = i }
        if k == 0 || k == s.count - 1 { return } // peak needs samples on both sides
        let peak = s[k], need = need(tr)
        let before = s[..<k].map(\.y).max()! - peak.y
        let after = s[(k + 1)...].map(\.y).max()! - peak.y
        let freeFall = self.freeFall(tr, peak.t) // nil: too few samples to tell
        let climbed = before >= need && after >= o.turnBalls * tr.size && freeFall != false
        let arced = after >= need && before > 0 && freeFall == true
        if climbed || arced { count(tr, at: peak.t, x: peak.x, y: peak.y, reason: climbed ? .climbed : .arc) }
    }

    // Fit y = a t^2 + b t + c around the apex: a ball in free flight curves at about gravity,
    // a hand moving a ball around curves far less.
    private func freeFall(_ tr: Track, _ tp: Double) -> Bool? {
        let pts = tr.samples.filter { abs($0.t - tp) <= 0.2 }
        guard pts.count >= 5, pts.contains(where: { $0.t < tp }), pts.contains(where: { $0.t > tp }) else { return nil }
        let acc = 2 * quadA(pts.map { $0.t - tp }, pts.map(\.y))
        let g = o.gBalls * tr.size
        return acc >= o.gRange.0 * g && acc <= o.gRange.1 * g
    }

    private func need(_ tr: Track) -> Double { max(o.minRise, o.minRiseBalls * tr.size) }

    private func count(_ tr: Track, at: Double, x: Double, y: Double, reason: ThrowEvent.Reason) {
        tr.apexT = at
        tr.falling = true
        tr.floorY = y; tr.floorT = at
        for p in tr.samples where p.t >= at && p.y >= tr.floorY { tr.floorY = p.y; tr.floorT = p.t }
        // a twin track on the same ball can reach the same apex: count it once
        let dup = recent.contains { r in
            abs(r.t - at) < o.dupTime && hypot(r.x - x, r.y - y) < o.dupBalls * tr.size
        }
        recent.append((at, x, y))
        if recent.count > 8 { recent.removeFirst() }
        if dup { return }
        tr.throwCount += 1
        total += 1
        run += 1
        lastThrowAt = at
        onThrow?(ThrowEvent(trackId: tr.id, t: at, x: x, y: y, reason: reason, run: run, total: total))
    }
}

// Least-squares coefficient of x^2 for a quadratic fit through points (x, y).
private func quadA(_ xs: [Double], _ ys: [Double]) -> Double {
    var s0 = 0.0, s1 = 0.0, s2 = 0.0, s3 = 0.0, s4 = 0.0, t0 = 0.0, t1 = 0.0, t2 = 0.0
    for (x, y) in zip(xs, ys) {
        let x2 = x * x
        s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2
        t0 += y; t1 += x * y; t2 += x2 * y
    }
    // [[s4 s3 s2][s3 s2 s1][s2 s1 s0]] [a b c]^T = [t2 t1 t0]^T, solved for a by Cramer's rule
    func det3(_ m: [Double]) -> Double {
        m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    }
    let d = det3([s4, s3, s2, s3, s2, s1, s2, s1, s0])
    return d != 0 ? det3([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / d : 0
}

// Merge detections that overlap by more than half a ball: one ball, one detection.
private func dedupe(_ dets: [Detection]) -> [Detection] {
    var out: [Detection] = []
    for d in dets.sorted(by: { $0.score > $1.score }) {
        if out.allSatisfy({ hypot($0.x - d.x, $0.y - d.y) > 0.5 * max($0.size, d.size) }) { out.append(d) }
    }
    return out
}
