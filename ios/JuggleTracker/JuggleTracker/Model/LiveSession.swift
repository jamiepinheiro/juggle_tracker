import AVFoundation
import Observation
import UIKit

/// One practice session in progress: owns the frame source and the tracking engine,
/// turns throw/run events into session stats, and saves the session when it ends.
@Observable
final class LiveSession {
    enum Source: Equatable {
        case camera(AVCaptureDevice.Position)
        case video(URL, name: String)
    }

    enum Phase: Equatable {
        case starting, running, finished(SessionRecord), failed(String)
    }

    struct Flash: Identifiable {
        let id = UUID()
        let x, y: Double
        let at: Date
    }

    let source: Source
    private(set) var phase: Phase = .starting
    private(set) var startedAt = Date()
    private(set) var currentRun = 0
    private(set) var total = 0
    private(set) var runs: [RunRecord] = []
    private(set) var detections: [Detection] = []
    private(set) var balls: [BallTrail] = []
    private(set) var flashes: [Flash] = []
    private(set) var frameSize = CGSize(width: 16, height: 9)
    private(set) var videoFrame: CGImage?            // video sessions only: the frame being analysed
    private(set) var videoProgress = 0.0
    private(set) var cameraPosition: AVCaptureDevice.Position?
    let previousBest: Int                             // personal best before this session

    @ObservationIgnored private(set) var camera: CameraSource?
    @ObservationIgnored private var video: VideoSource?
    @ObservationIgnored private let engine: TrackingEngine?   // nil if the ball model couldn't load
    @ObservationIgnored private var runStartedAt: Double?
    @ObservationIgnored private let store: SessionStore

    var bestRun: Int { max(runs.map(\.throwCount).max() ?? 0, currentRun) }
    var lastRun: Int? { runs.last?.throwCount }
    var isCamera: Bool { if case .camera = source { true } else { false } }

    init(source: Source, store: SessionStore) {
        self.source = source
        self.store = store
        engine = (try? BallModelDetector.bundled()).map { TrackingEngine(detector: $0) }
        previousBest = store.personalBest
    }

    // MARK: - lifecycle

    @MainActor
    func start() async {
        startedAt = Date()
        guard let engine else {
            phase = .failed("The ball model couldn't be loaded. Reinstall the app.")
            return
        }
        switch source {
        case .camera(let position):
            do {
                try await CameraSource.requestAccess()
                let cam = CameraSource(position: position)
                try cam.configure()
                cam.onFrame = { [weak self] sb in
                    guard let snap = engine.process(sb) else { return }
                    DispatchQueue.main.async { self?.apply(snap) }
                }
                camera = cam
                cameraPosition = position
                cam.start()
                phase = .running
            } catch {
                phase = .failed(error.localizedDescription)
            }
        case .video(let url, _):
            let src = VideoSource(url: url)
            src.onFrame = { [weak self] sb, orientation in
                guard let snap = engine.process(sb, orientation: orientation) else { return }
                DispatchQueue.main.async { self?.apply(snap) }
            }
            src.onImage = { [weak self] image, progress in
                DispatchQueue.main.async { self?.videoFrame = image; self?.videoProgress = progress }
            }
            src.onFinish = { [weak self] error in
                let snap = engine.finish()
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.apply(snap)
                    if let error { self.phase = .failed(error.localizedDescription) } else { self.complete() }
                }
            }
            video = src
            src.start()
            phase = .running
        }
        UIApplication.shared.isIdleTimerDisabled = true
    }

    /// Switch between back and front cameras; the choice is remembered for the next session.
    func flipCamera() {
        camera?.flip { [weak self] pos in
            self?.cameraPosition = pos
            UserDefaults.standard.set(pos == .front, forKey: "frontCamera")
        }
    }

    /// Stop now; the run in progress counts as ended.
    func stop() {
        guard phase == .running else { return }
        if let camera {
            camera.stop { [weak self] in
                guard let self else { return }
                camera.onFrameQueue { [engine = self.engine] in
                    guard let snap = engine?.finish() else { return }
                    DispatchQueue.main.async { self.apply(snap); self.complete() }
                }
            }
        } else {
            video?.cancel()   // onFinish flushes the engine and completes
        }
    }

    /// Leave without saving (e.g. the screen was dismissed while starting).
    func abandon() {
        video?.onFinish = nil
        video?.cancel()
        camera?.stop()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func complete() {
        guard phase == .running else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        let name: String? = if case .video(_, let n) = source { n } else { nil }
        let record = SessionRecord(startedAt: startedAt, endedAt: Date(), source: isCamera ? .camera : .video,
                                   videoName: name, runs: runs)
        if !runs.isEmpty { store.add(record) }
        currentRun = 0
        detections = []
        balls = []
        phase = .finished(record)
    }

    // MARK: - engine events

    private func apply(_ s: EngineSnapshot) {
        let now = Date()
        for e in s.throwEvents {
            if e.run == 1 { runStartedAt = e.t }
            flashes.append(Flash(x: e.x, y: e.y, at: now))
        }
        for end in s.runEnds {
            let duration = runStartedAt.map { max(0, end.endedAt - $0) } ?? 0
            if end.count >= TrackingEngine.minRun {
                runs.append(RunRecord(throwCount: end.count, duration: duration, endedAt: now))
            }
            runStartedAt = nil
        }
        flashes.removeAll { now.timeIntervalSince($0.at) > 0.8 }
        currentRun = s.run
        total = runs.reduce(0) { $0 + $1.throwCount } + s.run
        if phase == .running { detections = s.detections; balls = s.balls }
        if s.frameSize.width > 0 { frameSize = s.frameSize }
    }
}

extension LiveSession: Identifiable {}
