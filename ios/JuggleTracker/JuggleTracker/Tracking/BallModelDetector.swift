// Finds balls with the trained YOLO model (Model/BallModel.mlpackage, exported from the
// webapp's weights by tools/export_coreml.py). Each frame is letterboxed to the model's square
// input the way it was trained (scaled to fit, centred, grey padding); the raw output (box and
// score for each candidate) is decoded and overlapping boxes are merged here.

import CoreImage
import CoreML
import ImageIO

final class BallModelDetector {
    var minScore: Float = 0.35      // the webapp's default sensitivity
    var maxOverlap: Float = 0.5     // boxes overlapping more than this are one ball
    private let model: MLModel
    private let inputName: String
    private let side: Int
    private let ciContext = CIContext()
    private var pool: CVPixelBufferPool?

    init(url: URL) throws {
        let config = MLModelConfiguration()
        config.computeUnits = .all
        model = try MLModel(contentsOf: url, configuration: config)
        let input = model.modelDescription.inputDescriptionsByName.first!
        inputName = input.key
        side = input.value.imageConstraint?.pixelsWide ?? 640
    }

    /// The model bundled with the app.
    static func bundled() throws -> BallModelDetector {
        guard let url = Bundle.main.url(forResource: "BallModel", withExtension: "mlmodelc") else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSLocalizedDescriptionKey: "The ball model is missing from the app."])
        }
        return try BallModelDetector(url: url)
    }

    /// Balls in the frame, normalised to the upright image (top-left origin); size is the box's
    /// longer side as a fraction of the frame height, as in the webapp.
    func detect(_ pb: CVPixelBuffer, orientation: CGImagePropertyOrientation = .up) throws -> [Detection] {
        let image = CIImage(cvPixelBuffer: pb).oriented(orientation)
        let w = image.extent.width, h = image.extent.height
        let s = Double(side), r = s / max(w, h)
        let dx = (s - w * r) / 2, dy = (s - h * r) / 2
        guard let input = letterboxed(image, scale: r, dx: dx, dy: dy) else { return [] }

        let out = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: [inputName: MLFeatureValue(pixelBuffer: input)]))
        guard let name = out.featureNames.first, let arr = out.featureValue(for: name)?.multiArrayValue else { return [] }

        // [1, 5, N]: cx, cy, w, h (input pixels), score
        let n = arr.shape[2].intValue
        let rs = arr.strides[1].intValue, cs = arr.strides[2].intValue
        var boxes: [(score: Float, rect: CGRect)] = []
        func read(_ get: (Int) -> Float) {
            for i in 0..<n {
                let score = get(4 * rs + i * cs)
                guard score >= minScore else { continue }
                let cx = Double(get(i * cs)), cy = Double(get(rs + i * cs))
                let bw = Double(get(2 * rs + i * cs)), bh = Double(get(3 * rs + i * cs))
                boxes.append((score, CGRect(x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh)))
            }
        }
        switch arr.dataType {
        case .float16: arr.withUnsafeBufferPointer(ofType: Float16.self) { p in read { Float(p[$0]) } }
        default: arr.withUnsafeBufferPointer(ofType: Float.self) { p in read { p[$0] } }
        }

        // Keep the best box of each overlapping group.
        var kept: [(score: Float, rect: CGRect)] = []
        for b in boxes.sorted(by: { $0.score > $1.score }) where !kept.contains(where: { overlap($0.rect, b.rect) > maxOverlap }) {
            kept.append(b)
        }
        return kept.map { b in
            Detection(x: (b.rect.midX - dx) / (w * r), y: (b.rect.midY - dy) / (h * r),
                      size: max(b.rect.width, b.rect.height) / r / h, score: Double(b.score))
        }
    }

    /// The frame scaled to fit a side×side BGRA buffer, centred on grey (114, as in training).
    private func letterboxed(_ image: CIImage, scale r: Double, dx: Double, dy: Double) -> CVPixelBuffer? {
        if pool == nil {
            let attrs: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                                        kCVPixelBufferWidthKey as String: side, kCVPixelBufferHeightKey as String: side,
                                        kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
        }
        var buf: CVPixelBuffer?
        guard let pool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buf) == kCVReturnSuccess, let buf else { return nil }
        let placed = image
            .transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
            .transformed(by: CGAffineTransform(scaleX: r, y: r))
            .transformed(by: CGAffineTransform(translationX: dx, y: dy))
        let grey = CIImage(color: CIColor(red: 114 / 255, green: 114 / 255, blue: 114 / 255))
            .cropped(to: CGRect(x: 0, y: 0, width: side, height: side))
        ciContext.render(placed.composited(over: grey), to: buf)
        return buf
    }
}

private func overlap(_ a: CGRect, _ b: CGRect) -> Float {
    let i = a.intersection(b)
    guard !i.isNull else { return 0 }
    let x = i.width * i.height
    return Float(x / (a.width * a.height + b.width * b.height - x))
}
