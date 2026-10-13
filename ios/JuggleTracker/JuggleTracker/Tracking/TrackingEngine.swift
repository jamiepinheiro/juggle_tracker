import CoreMedia
import CoreGraphics
import ImageIO

/// What the UI needs after each analysed frame.
struct EngineSnapshot {
    var detections: [Detection]          // the ball model's detections this frame
    var balls: [BallTrail]               // the counter's ball tracks
    var throwEvents: [ThrowEvent]
    var runEnds: [(count: Int, endedAt: Double)]
    var run: Int
    var total: Int
    var frameSize: CGSize
}

struct BallTrail {
    var points: [CGPoint]
    var size: Double
}

/// Ball finding + counter. Not thread-safe: each session's frame source calls it from one queue.
final class TrackingEngine {
    private let detector: BallModelDetector
    /// Run settings checked against hand-labelled attempts (IMG_0736 and IMG_0737 throws.labels.json):
    /// throws inside an attempt are 0.2–0.6 s apart and attempts are 1.2 s or more apart, so the
    /// web counter's 1.5 s gap merged quick restarts into one run.
    static let runGap = 1.0
    /// Runs shorter than this are a stray toss, not juggling, and are left out of the stats.
    static let minRun = 2
    private let counter = JuggleCounter(options: {
        var o = CounterOptions()
        o.runGap = TrackingEngine.runGap
        return o
    }())
    private var throwEvents: [ThrowEvent] = []
    private var runEnds: [(count: Int, endedAt: Double)] = []
    private var lastT = -Double.infinity

    init(detector: BallModelDetector) {
        self.detector = detector
        counter.onThrow = { [unowned self] in throwEvents.append($0) }
        counter.onRunEnd = { [unowned self] n, t in runEnds.append((n, t)) }
    }

    func process(_ sampleBuffer: CMSampleBuffer, orientation: CGImagePropertyOrientation = .up) -> EngineSnapshot? {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        var size = CGSize(width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb))
        if [.left, .right, .leftMirrored, .rightMirrored].contains(orientation) { size = CGSize(width: size.height, height: size.width) }
        let t = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds

        let detections: [Detection]
        do {
            detections = try detector.detect(pb, orientation: orientation)
        } catch {
            print("Ball detection failed: \(error)")
            return nil
        }
        counter.update(detections, t: t)
        lastT = t
        return snapshot(detections: detections, frameSize: size)
    }

    /// End of input: close the run in progress.
    func finish() -> EngineSnapshot {
        counter.update([], t: .infinity)
        return snapshot(detections: [], frameSize: .zero)
    }

    private func snapshot(detections: [Detection], frameSize: CGSize) -> EngineSnapshot {
        defer { throwEvents = []; runEnds = [] }
        // Only tracks that look like a throw: they have counted one, or have climbed half the
        // rise a throw needs. The rest are balls in hands, which the counter ignores.
        let o = counter.o
        let balls = counter.tracks.filter { tr in
            lastT - tr.t < 0.1 && tr.trail.count > 1 &&
                (tr.throwCount > 0 || climb(tr) >= 0.5 * max(o.minRise, o.minRiseBalls * tr.size))
        }
        .map { BallTrail(points: $0.trail.map { CGPoint(x: $0.0, y: $0.1) }, size: $0.size) }
        func climb(_ tr: Track) -> Double {
            (tr.samples.filter { $0.t >= tr.floorT }.map(\.y).max() ?? tr.y) - tr.y
        }
        return EngineSnapshot(detections: detections, balls: balls, throwEvents: throwEvents, runEnds: runEnds,
                              run: counter.run, total: counter.total, frameSize: frameSize)
    }
}
