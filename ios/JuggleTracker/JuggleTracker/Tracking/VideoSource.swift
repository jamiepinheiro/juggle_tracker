import AVFoundation
import CoreImage

/// Frames from a video file, read in order and paced to play at real time, so a recording
/// goes through exactly the same pipeline as the camera. Every frame is analysed: if the
/// device can't keep up, playback slows down rather than skipping, so counts are repeatable.
final class VideoSource {
    let url: URL
    var onFrame: ((CMSampleBuffer, CGImagePropertyOrientation) -> Void)?
    var onImage: ((CGImage, Double) -> Void)?         // display frame, progress 0...1
    var onFinish: ((Error?) -> Void)?

    private let queue = DispatchQueue(label: "juggle.video.frames", qos: .userInteractive)
    private let ciContext = CIContext()
    private let cancelled = Cancelled()

    private final class Cancelled: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        var isSet: Bool { lock.withLock { value } }
        func set() { lock.withLock { value = true } }
    }

    init(url: URL) { self.url = url }

    func start() {
        queue.async { [self] in
            do {
                try read()
                onFinish?(nil)
            } catch {
                onFinish?(error)
            }
        }
    }

    func cancel() { cancelled.set() }

    private func read() throws {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .video).first else {
            throw CocoaError(.fileReadCorruptFile, userInfo: [NSLocalizedDescriptionKey: "That file has no video track."])
        }
        let orientation = Self.orientation(of: track.preferredTransform)
        let duration = asset.duration.seconds
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        ])
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? CocoaError(.fileReadUnknown) }

        var firstPTS: Double?
        let wallStart = CACurrentMediaTime()
        // One autorelease pool per frame: this loop runs for the whole video in one block, and
        // each frame's temporary images would otherwise pile up until memory runs out.
        while !cancelled.isSet {
            let more: Bool = autoreleasepool {
                guard let sb = output.copyNextSampleBuffer() else { return false }
                guard let pb = CMSampleBufferGetImageBuffer(sb) else { return true }
                let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
                let first = firstPTS ?? pts
                firstPTS = first
                let wait = wallStart + (pts - first) - CACurrentMediaTime()
                if wait > 0 { Thread.sleep(forTimeInterval: wait) }
                onFrame?(sb, orientation)
                let ci = CIImage(cvPixelBuffer: pb).oriented(orientation)
                if let image = ciContext.createCGImage(ci, from: ci.extent) {
                    onImage?(image, duration > 0 ? min(1, (pts - first) / duration) : 0)
                }
                return true
            }
            if !more { break }
        }
        if reader.status == .failed, let e = reader.error { throw e }
    }

    static func orientation(of t: CGAffineTransform) -> CGImagePropertyOrientation {
        switch (t.a, t.b, t.c, t.d) {
        case (0, 1, -1, 0): .right      // recorded in portrait
        case (0, -1, 1, 0): .left
        case (-1, 0, 0, -1): .down
        default: .up
        }
    }
}
