import AVFoundation

enum CameraError: LocalizedError {
    case unavailable, denied, cannotAdd

    var errorDescription: String? {
        switch self {
        case .unavailable: "This device has no camera. Count a recorded video instead (the paperclip button)."
        case .denied: "Camera access is off. Turn it on in Settings › Juggle Tracker › Camera."
        case .cannotAdd: "The camera couldn't be started."
        }
    }
}

/// Live frames from the camera, delivered upright on a background queue.
final class CameraSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    private(set) var position: AVCaptureDevice.Position
    var onFrame: ((CMSampleBuffer) -> Void)?

    private let output = AVCaptureVideoDataOutput()
    private let frameQueue = DispatchQueue(label: "juggle.camera.frames", qos: .userInteractive)
    private let sessionQueue = DispatchQueue(label: "juggle.camera.session")
    private var device: AVCaptureDevice?
    private var input: AVCaptureDeviceInput?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var rotation: AVCaptureDevice.RotationCoordinator?
    private var rotationObservations: [NSKeyValueObservation] = []

    init(position: AVCaptureDevice.Position) {
        self.position = position
    }

    static func requestAccess() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return
        case .notDetermined:
            if await AVCaptureDevice.requestAccess(for: .video) { return }
            throw CameraError.denied
        default: throw CameraError.denied
        }
    }

    func configure() throws {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .hd1920x1080
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: frameQueue)
        guard session.canAddOutput(output) else { throw CameraError.cannotAdd }
        session.addOutput(output)
        try use(position)
    }

    /// Switch between the back and front cameras while running.
    func flip(then done: @escaping (AVCaptureDevice.Position) -> Void) {
        let next: AVCaptureDevice.Position = position == .back ? .front : .back
        sessionQueue.async {
            self.session.beginConfiguration()
            let ok = (try? self.use(next)) != nil
            self.session.commitConfiguration()
            DispatchQueue.main.async {
                if ok, let layer = self.previewLayer { self.attach(previewLayer: layer) }
                done(self.position)
            }
        }
    }

    /// Swap the camera input. Call inside a configuration block.
    private func use(_ pos: AVCaptureDevice.Position) throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: pos) else {
            throw CameraError.unavailable
        }
        let newInput = try AVCaptureDeviceInput(device: device)
        if let input { session.removeInput(input) }
        guard session.canAddInput(newInput) else {
            if let input { session.addInput(input) }
            throw CameraError.cannotAdd
        }
        session.addInput(newInput)
        input = newInput
        self.device = device
        position = pos
        if let c = output.connection(with: .video), c.isVideoMirroringSupported {
            c.automaticallyAdjustsVideoMirroring = false
            c.isVideoMirrored = pos == .front   // match the mirrored front-camera preview
        }

        // 60 fps where the format allows: shorter exposures, less blur on fast balls.
        try device.lockForConfiguration()
        if device.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.maxFrameRate >= 60 }) {
            device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 60)
            device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 60)
        }
        device.unlockForConfiguration()
    }

    /// Keep the preview and the analysed frames upright as the device rotates.
    func attach(previewLayer: AVCaptureVideoPreviewLayer) {
        self.previewLayer = previewLayer
        guard let device else { return }
        let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
        rotation = coordinator
        let apply = { [weak self, weak previewLayer] in
            guard let self else { return }
            let capture = coordinator.videoRotationAngleForHorizonLevelCapture
            let preview = coordinator.videoRotationAngleForHorizonLevelPreview
            if let c = self.output.connection(with: .video), c.isVideoRotationAngleSupported(capture) { c.videoRotationAngle = capture }
            if let c = previewLayer?.connection, c.isVideoRotationAngleSupported(preview) { c.videoRotationAngle = preview }
        }
        apply()
        rotationObservations = [
            coordinator.observe(\.videoRotationAngleForHorizonLevelCapture) { _, _ in DispatchQueue.main.async(execute: apply) },
            coordinator.observe(\.videoRotationAngleForHorizonLevelPreview) { _, _ in DispatchQueue.main.async(execute: apply) },
        ]
    }

    func start() { sessionQueue.async { self.session.startRunning() } }

    func stop(then done: @escaping () -> Void = {}) {
        sessionQueue.async {
            self.session.stopRunning()
            // drain frames already queued so the caller can finish the engine safely
            self.frameQueue.async { DispatchQueue.main.async(execute: done) }
        }
    }

    /// Runs `work` on the frame queue, after any frame being processed.
    func onFrameQueue(_ work: @escaping () -> Void) { frameQueue.async(execute: work) }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        onFrame?(sampleBuffer)
    }
}
