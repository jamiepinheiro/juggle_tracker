import Foundation
import Observation

/// Saved sessions, kept as JSON in the app's Documents folder.
@Observable
final class SessionStore {
    private(set) var sessions: [SessionRecord] = []   // newest first
    private let url: URL

    init(url: URL? = nil) {
        self.url = url ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("sessions.json")
        load()
    }

    var personalBest: Int { sessions.map(\.bestRun).max() ?? 0 }

    func add(_ session: SessionRecord) {
        sessions.insert(session, at: 0)
        save()
    }

    func delete(_ ids: Set<SessionRecord.ID>) {
        sessions.removeAll { ids.contains($0.id) }
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([SessionRecord].self, from: data) else { return }
        sessions = decoded.sorted { $0.startedAt > $1.startedAt }
    }

    private func save() {
        do {
            try JSONEncoder().encode(sessions).write(to: url, options: .atomic)
        } catch {
            print("Couldn't save sessions: \(error)")
        }
    }
}
