import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct HomeView: View {
    @Environment(SessionStore.self) private var store
    @AppStorage("frontCamera") private var frontCamera = true
    @State private var showSettings = false
    @State private var live: LiveSession?
    @State private var photoItem: PhotosPickerItem?
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var loadingVideo = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    startPanel
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
                Section {
                    if store.sessions.isEmpty {
                        Text("No sessions yet. Each session you finish is saved here with its runs, so you can watch your best run grow.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.sessions) { s in
                        NavigationLink(value: s) { SessionRow(session: s) }
                    }
                    .onDelete { idx in store.delete(Set(idx.map { store.sessions[$0].id })) }
                } header: {
                    Text("Sessions")
                }
            }
            .navigationTitle("Juggle Tracker")
            .toolbar {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
            .navigationDestination(for: SessionRecord.self) { SessionDetailView(session: $0) }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .videos)
        .fullScreenCover(item: $live) { session in
            LiveSessionView(session: session) { live = nil }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.movie]) { result in
            switch result {
            case .success(let url): openVideo(securityScoped: url)
            case .failure(let e): errorText = e.localizedDescription
            }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            loadingVideo = true
            Task {
                defer { loadingVideo = false; photoItem = nil }
                do {
                    guard let movie = try await item.loadTransferable(type: PickedMovie.self) else { return }
                    begin(.video(movie.url, name: "Video from Photos"))
                } catch {
                    errorText = "That video couldn't be opened: \(error.localizedDescription)"
                }
            }
        }
        #if DEBUG
        .task {
            // Simulator checks (no camera there): `-debug-video <file>` counts that video straight
            // away. A relative path is in the app's Documents folder (how to get files onto a device).
            let args = UserDefaults.standard
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            func resolve(_ key: String) -> String? {
                args.string(forKey: key).map { $0.hasPrefix("/") ? $0 : docs.appendingPathComponent($0).path }
            }
            if let path = resolve("debug-video"), live == nil {
                begin(.video(URL(fileURLWithPath: path), name: URL(fileURLWithPath: path).lastPathComponent))
            }
        }
        #endif
        .alert("Something went wrong", isPresented: .constant(errorText != nil), presenting: errorText) { _ in
            Button("OK") { errorText = nil }
        } message: { Text($0) }
    }

    private var startPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline, spacing: 24) {
                bestFigure("Personal best", store.personalBest)
                bestFigure("Best today", bestToday)
            }

            HStack(spacing: 10) {
                Button {
                    begin(.camera(frontCamera ? .front : .back))
                } label: {
                    Label("Start session", systemImage: "camera.fill")
                        .font(.title3.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 52)
                }
                .buttonStyle(.borderedProminent)

                // Count a recorded video instead of the live camera.
                Menu {
                    Button { showPhotos = true } label: { Label("Video from Photos", systemImage: "photo.on.rectangle") }
                    Button { showFiles = true } label: { Label("Video from Files", systemImage: "folder") }
                } label: {
                    Group {
                        if loadingVideo { ProgressView() } else { Image(systemName: "paperclip").font(.title3.weight(.semibold)) }
                    }
                    .frame(width: 34, height: 52)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Count a recorded video")
            }
            .buttonBorderShape(.capsule)

            Text("Prop the device up, still, so it sees the full height of your throws, then juggle. A run ends when you drop or pause for a second.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
    }

    private func bestFigure(_ label: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value > 0 ? "\(value)" : "–")
                .font(.system(size: 44, weight: .bold, design: .rounded))
                .monospacedDigit()
            Text(label).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var bestToday: Int {
        store.sessions.filter { Calendar.current.isDateInToday($0.startedAt) }.map(\.bestRun).max() ?? 0
    }

    private func begin(_ source: LiveSession.Source) {
        live = LiveSession(source: source, store: store)
    }

    private func openVideo(securityScoped url: URL) {
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        do {
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(url.pathExtension)
            try FileManager.default.copyItem(at: url, to: copy)
            begin(.video(copy, name: url.deletingPathExtension().lastPathComponent))
        } catch {
            errorText = "That file couldn't be opened: \(error.localizedDescription)"
        }
    }
}

private struct SessionDetailView: View {
    let session: SessionRecord
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        ScrollView { SessionStatsView(session: session, previousBest: nil).padding() }
            .navigationTitle(session.startedAt.formatted(date: .abbreviated, time: .shortened))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button(role: .destructive) { confirming = true } label: { Image(systemName: "trash") }
                    .accessibilityLabel("Delete session")
            }
            .confirmationDialog("Delete this session?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Delete session", role: .destructive) {
                    store.delete([session.id])
                    dismiss()
                }
            } message: {
                Text("Its runs are removed from your history and bests. This can't be undone.")
            }
    }
}

private struct SessionRow: View {
    let session: SessionRecord

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.startedAt.formatted(date: .abbreviated, time: .shortened))
                Text("\(session.runs.count) runs · \(session.totalThrows) throws · \(formatDuration(session.duration))"
                     + (session.source == .video ? " · video" : ""))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 0) {
                Text("\(session.bestRun)").font(.title2.weight(.semibold)).monospacedDigit()
                Text("best").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

/// A video picked from Photos, copied to a temporary file we own.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { received in
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

func formatDuration(_ t: TimeInterval) -> String {
    let s = Int(t.rounded())
    return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
}
