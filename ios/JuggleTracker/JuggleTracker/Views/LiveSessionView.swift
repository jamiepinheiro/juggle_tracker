import AVFoundation
import SwiftUI

struct LiveSessionView: View {
    let session: LiveSession
    let close: () -> Void
    @State private var showAllMotion = false
    @State private var bump = false

    var body: some View {
        Group {
            switch session.phase {
            case .finished(let record):
                NavigationStack {
                    ScrollView { SessionStatsView(session: record, previousBest: session.previousBest).padding() }
                        .navigationTitle("Session done")
                        .toolbar { Button("Done", action: close).fontWeight(.semibold) }
                }
            case .failed(let message):
                ContentUnavailableView {
                    Label("Can't start", systemImage: "video.slash")
                } description: {
                    Text(message)
                } actions: {
                    Button("Back", action: close).buttonStyle(.borderedProminent)
                }
            default:
                live
            }
        }
        .task { await session.start() }
        .onDisappear { session.abandon() }
    }

    private var live: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ZStack {
                if let camera = session.camera {
                    CameraPreview(camera: camera)
                } else if let frame = session.videoFrame {
                    Image(decorative: frame, scale: 1).resizable().scaledToFit()
                }
                TrackingOverlay(session: session, showAllMotion: showAllMotion)
            }
            .ignoresSafeArea()
            hud
        }
        .statusBarHidden()
        .onChange(of: session.currentRun) { old, new in
            guard new > old else { return }
            bump = true
            withAnimation(.spring(duration: 0.25)) { bump = false }
        }
    }

    private var hud: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    TimelineView(.periodic(from: session.startedAt, by: 1)) { ctx in
                        Text(formatDuration(ctx.date.timeIntervalSince(session.startedAt)))
                            .font(.headline.monospacedDigit())
                    }
                    Text("\(session.runs.count) runs · best \(session.bestRun) · \(session.total) throws")
                        .font(.subheadline.monospacedDigit())
                    if case .video = session.source {
                        ProgressView(value: session.videoProgress).frame(width: 160).tint(.white)
                    }
                }
                .padding(10)
                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                Spacer()
                if session.isCamera {
                    Button {
                        session.flipCamera()
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath.camera")
                            .frame(width: 44, height: 44)
                            .background(.black.opacity(0.45), in: Circle())
                    }
                    .accessibilityLabel(session.cameraPosition == .front ? "Switch to back camera" : "Switch to front camera")
                    .disabled(session.phase != .running)
                }
                Menu {
                    Toggle("Show every detected ball", isOn: $showAllMotion)
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 44, height: 44)
                        .background(.black.opacity(0.45), in: Circle())
                }
                .accessibilityLabel("Display options")
            }
            Spacer()
            VStack(spacing: 0) {
                Text("\(session.currentRun)")
                    .font(.system(size: 140, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(session.currentRun > 0 ? Color.accentColor : .white)
                    .scaleEffect(bump ? 1.12 : 1)
                    .contentTransition(.numericText(value: Double(session.currentRun)))
                    .accessibilityLabel("\(session.currentRun) throws this run")
                Text(runCaption).font(.title3.weight(.semibold))
                // The last run stays readable from across the room while you pick the balls up.
                if session.currentRun == 0, let last = session.lastRun {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("Last run").font(.title2.weight(.semibold))
                        Text("\(last)")
                            .font(.system(size: 64, weight: .bold, design: .rounded))
                            .monospacedDigit()
                    }
                    .padding(.top, 4)
                    .accessibilityElement(children: .combine)
                }
            }
            .shadow(color: .black.opacity(0.6), radius: 6)
            Spacer().frame(height: 24)
            Button {
                session.stop()
            } label: {
                Text("End session").font(.headline).frame(maxWidth: 320, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.black)
            .disabled(session.phase != .running)
        }
        .foregroundStyle(.white)
        .padding()
    }

    private var runCaption: String {
        if session.currentRun > 0 {
            return session.previousBest > 0 && session.currentRun > session.previousBest ? "New personal best" : "this run"
        }
        return session.phase == .running ? "Start throwing" : "Starting…"
    }
}

/// The counter's ball tracks and counted apexes, drawn over the aspect-fit picture.
private struct TrackingOverlay: View {
    let session: LiveSession
    let showAllMotion: Bool

    var body: some View {
        TimelineView(.animation(paused: session.flashes.isEmpty)) { ctx in
            Canvas { gc, size in
                let rect = aspectFit(session.frameSize, in: size)
                func pt(_ x: Double, _ y: Double) -> CGPoint {
                    CGPoint(x: rect.minX + x * rect.width, y: rect.minY + y * rect.height)
                }
                // Every ball the model finds this frame, counted or not (debug view).
                if showAllMotion {
                    for d in session.detections {
                        let r = d.size * rect.height / 2, c = pt(d.x, d.y)
                        gc.stroke(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                                  with: .color(.white.opacity(0.8)), lineWidth: 1.5)
                    }
                }
                // The balls the counter is following.
                for b in session.balls {
                    var path = Path()
                    path.addLines(b.points.map { pt($0.x, $0.y) })
                    gc.stroke(path, with: .color(.accentColor.opacity(0.8)),
                              style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    if let last = b.points.last {
                        let r = max(8, b.size * rect.height * 0.75)
                        let c = pt(last.x, last.y)
                        gc.stroke(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                                  with: .color(.accentColor), lineWidth: 2.5)
                    }
                }
                for f in session.flashes {
                    let age = ctx.date.timeIntervalSince(f.at) / 0.8
                    guard age < 1 else { continue }
                    let r = rect.height * 0.03 * (1 + age)
                    let c = pt(f.x, f.y)
                    gc.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                            with: .color(.accentColor.opacity(1 - age)))
                }
            }
        }
        .allowsHitTesting(false)
    }
}

func aspectFit(_ content: CGSize, in box: CGSize) -> CGRect {
    guard content.width > 0, content.height > 0 else { return CGRect(origin: .zero, size: box) }
    let s = min(box.width / content.width, box.height / content.height)
    let w = content.width * s, h = content.height * s
    return CGRect(x: (box.width - w) / 2, y: (box.height - h) / 2, width: w, height: h)
}

private struct CameraPreview: UIViewRepresentable {
    let camera: CameraSource

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.backgroundColor = .black
        v.previewLayer.session = camera.session
        v.previewLayer.videoGravity = .resizeAspect   // same framing as the overlay's aspect fit
        camera.attach(previewLayer: v.previewLayer)
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
