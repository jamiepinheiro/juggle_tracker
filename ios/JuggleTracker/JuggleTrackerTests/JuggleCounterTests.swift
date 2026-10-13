// Port of tests/counter.test.js: the same synthetic cascades must give the same answers.
import XCTest
@testable import JuggleTracker

final class JuggleCounterTests: XCTestCase {
    private let fps = 30.0, size = 0.04
    private var g: Double { 95 * size }   // normalised gravity (frame heights / s^2)

    /// Ball k thrown at k*beat from alternating hands, in flight for `flight` seconds.
    /// As in a real cascade, balls are thrown from inside the hands and caught outside.
    private func cascade(throws n: Int, beat: Double = 0.33, flight: Double = 0.9, handY: Double = 0.8,
                         drop: Bool = false, miss: Int = 0) -> [[Detection]] {
        var frames: [[Detection]] = []
        let end = Double(n) * beat + flight + 0.5
        var f = 0
        while Double(f) < end * fps {
            let t = Double(f) / fps
            var dets: [Detection] = []
            for k in 0..<n {
                let u = t - Double(k) * beat
                let x0 = k % 2 == 1 ? 0.55 : 0.45, x1 = k % 2 == 1 ? 0.35 : 0.65
                if u < 0 || u > flight { continue }
                let v0 = g * flight / 2
                let y = handY - v0 * u + g * u * u / 2
                if drop && k == n - 1 && u > flight / 2 { continue }
                if miss > 0 && (f * 7 + k) % miss == 0 { continue }
                dets.append(Detection(x: x0 + (x1 - x0) * u / flight, y: y, size: size, score: 0.9))
            }
            frames.append(dets)
            f += 1
        }
        return frames
    }

    private func run(_ frames: [[Detection]]) -> (total: Int, runs: [Int]) {
        let c = JuggleCounter()
        var runs: [Int] = []
        c.onRunEnd = { n, _ in runs.append(n) }
        for (i, d) in frames.enumerated() { c.update(d, t: Double(i) / fps) }
        c.update([], t: Double(frames.count) / fps + 5)
        return (c.total, runs)
    }

    func testCountsEveryThrowInACleanCascade() {
        let r = run(cascade(throws: 12))
        XCTAssertEqual(r.total, 12)
        XCTAssertEqual(r.runs, [12])
    }

    func testToleratesMissedDetections() {
        XCTAssertEqual(run(cascade(throws: 15, miss: 4)).total, 15)
    }

    func testDuplicateDetectionsOnOneBallCountOnce() {
        let frames = cascade(throws: 6).map { $0.flatMap { b in [b, Detection(x: b.x + 0.005, y: b.y, size: b.size, score: 0.5)] } }
        XCTAssertEqual(run(frames).total, 6)
    }

    func testSmallHandMovementsAreNotThrows() {
        let frames = (0..<90).map { f in [Detection(x: 0.5, y: 0.8 - 0.04 * sin(Double(f) / 5), size: size, score: 0.9)] }
        XCTAssertEqual(run(frames).total, 0)
    }

    func testBallLeavingTheTopOfTheFrameStillCounts() {
        let frames = cascade(throws: 3, flight: 1.2, handY: 0.5).map { $0.filter { $0.y > 0 } }
        XCTAssertEqual(run(frames).total, 3)
    }

    func testSeparateAttemptsBecomeSeparateRuns() {
        let gap = [[Detection]](repeating: [], count: 60)
        XCTAssertEqual(run(cascade(throws: 5) + gap + cascade(throws: 3)).runs, [5, 3])
    }

    func testArcSeenOnlyNearItsApexCounts() {
        // ball blurred on the way up: keep the top of each arc and the whole fall
        let full = cascade(throws: 4)
        let partial = full.enumerated().map { i, dets in
            dets.filter { b in
                let prev = i > 0 ? full[i - 1].first { abs($0.x - b.x) < 0.02 } : nil
                let rising = prev.map { b.y < $0.y } ?? true
                return !rising || b.y < 0.6
            }
        }
        XCTAssertEqual(run(partial).total, 4)
    }

    func testSlowHandLiftIsNotAThrow() {
        // 2 s up-and-down: far slower than free fall
        let frames = (0..<60).map { f in [Detection(x: 0.5, y: 0.8 - 0.2 * sin(Double.pi * Double(f) / 60), size: size, score: 0.9)] }
        XCTAssertEqual(run(frames).total, 0)
    }

    func testDataExportIsReadableJSON() throws {
        let s = SessionRecord(startedAt: Date(timeIntervalSince1970: 0), endedAt: Date(timeIntervalSince1970: 60),
                              source: .camera, runs: [RunRecord(throwCount: 5, duration: 2, endedAt: Date(timeIntervalSince1970: 30))])
        let data = try DataExport(sessions: [s]).json()
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(obj["app"] as? String, "Juggle Tracker")
        let sessions = try XCTUnwrap(obj["sessions"] as? [[String: Any]])
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0]["startedAt"] as? String, "1970-01-01T00:00:00Z")
        XCTAssertEqual((sessions[0]["runs"] as? [[String: Any]])?.first?["throwCount"] as? Int, 5)
    }

    func testSessionStats() {
        let s = SessionRecord(startedAt: Date(timeIntervalSince1970: 0), endedAt: Date(timeIntervalSince1970: 120),
                              source: .camera, runs: [
                                  RunRecord(throwCount: 3, duration: 1.0, endedAt: .now),
                                  RunRecord(throwCount: 9, duration: 4.0, endedAt: .now),
                                  RunRecord(throwCount: 6, duration: 2.5, endedAt: .now),
                              ])
        XCTAssertEqual(s.bestRun, 9)
        XCTAssertEqual(s.totalThrows, 18)
        XCTAssertEqual(s.averageRun, 6)
        XCTAssertEqual(s.medianRun, 6)
        XCTAssertEqual(s.duration, 120)
        XCTAssertEqual(s.throwRate!, 15 / 7.5, accuracy: 1e-9)
    }
}
