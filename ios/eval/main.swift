// Scores the iOS counting pipeline (the app's own BallModelDetector, TrackingEngine and
// JuggleCounter) against hand-labelled videos. usage: eval/run.sh video.MOV [video.MOV ...]
// Labels (segments with a tap per throw) come from <name>.labels.json next to the video, or else
// from the labelling tool's data_labelling/data/<name>/throws.labels.json.
import AVFoundation

struct Labels: Decodable {
    struct Segment: Decodable { let start: Double; let end: Double?; let taps: [Double] }
    let segments: [Segment]
}

let args = Array(CommandLine.arguments.dropFirst())
let detector = try BallModelDetector(url: URL(fileURLWithPath: args[0]))
var grandErr = 0, grandCounted = 0, grandLabelled = 0

for video in args.dropFirst() {
    let url = URL(fileURLWithPath: video)
    var labelsURL = url.deletingPathExtension().appendingPathExtension("labels.json")
    if !FileManager.default.fileExists(atPath: labelsURL.path) {
        labelsURL = URL(fileURLWithPath: "../../data_labelling/data/\(url.deletingPathExtension().lastPathComponent)/throws.labels.json")
    }
    let labels = try JSONDecoder().decode(Labels.self, from: Data(contentsOf: labelsURL))
    // attempts with an end and taps; drop one nested inside another (a double label)
    var segs = labels.segments.filter { $0.end != nil && !$0.taps.isEmpty }.sorted { $0.start < $1.start }
    segs = segs.filter { s in !segs.contains { o in o.start < s.start && s.end! < o.end! } }
    let labelledUntil = (segs.last?.end ?? 0) + 1.5

    let asset = AVURLAsset(url: url)
    let track = try await asset.loadTracks(withMediaType: .video)[0]
    let orientation = VideoSource.orientation(of: try await track.load(.preferredTransform))
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange])
    reader.add(out); reader.startReading()

    let engine = TrackingEngine(detector: detector)
    var throwsAt: [Double] = [], runs: [(n: Int, first: Double, last: Double)] = [], runStart: Double?
    func take(_ s: EngineSnapshot) {
        for e in s.throwEvents { if e.run == 1 { runStart = e.t }; throwsAt.append(e.t) }
        for r in s.runEnds { runs.append((r.count, runStart ?? r.endedAt, r.endedAt)); runStart = nil }
    }
    let started = Date(); var frames = 0
    while true {
        let more: Bool = autoreleasepool {   // free each frame's temporaries as we go
            guard let sb = out.copyNextSampleBuffer() else { return false }
            if let s = engine.process(sb, orientation: orientation) { take(s) }
            frames += 1
            return true
        }
        if !more { break }
    }
    take(engine.finish())

    // the app's run rules: runs shorter than minRun aren't saved, so their throws don't count
    let kept = runs.filter { $0.n >= TrackingEngine.minRun && $0.first <= labelledUntil }
    let counted = throwsAt.filter { t in kept.contains { $0.first - 1e-6 <= t && t <= $0.last + 1e-6 } }
    let inSeg = { (t: Double, s: Labels.Segment) in s.start - 0.3 <= t && t <= s.end! + 0.5 }  // apex lands after the tap
    let per = segs.map { s in counted.filter { inSeg($0, s) }.count }
    let wanted = segs.map(\.taps.count)
    let outside = counted.filter { t in !segs.contains { inSeg(t, $0) } }.count
    let err = zip(per, wanted).reduce(0) { $0 + abs($1.0 - $1.1) } + outside
    grandErr += err; grandCounted += counted.count; grandLabelled += wanted.reduce(0, +)
    print("\(url.lastPathComponent): \(counted.count)/\(wanted.reduce(0, +)) throws, \(kept.count) runs for \(segs.count) attempts, error \(err)"
          + String(format: "  (%.1f ms/frame)", Date().timeIntervalSince(started) * 1000 / Double(max(frames, 1))))
    print("   labelled per attempt \(wanted)")
    print("   counted per attempt  \(per)" + (outside > 0 ? "  + \(outside) outside attempts" : ""))
}
print("TOTAL: \(grandCounted)/\(grandLabelled) throws, error \(grandErr)  (error = per-attempt miscounts + throws outside any attempt)")
