import Foundation

/// One unbroken run: throws from the first catch to the drop (or a pause longer than the run gap).
struct RunRecord: Codable, Hashable, Identifiable {
    var id = UUID()
    var throwCount: Int
    var duration: TimeInterval     // first apex to last apex
    var endedAt: Date
}

struct SessionRecord: Codable, Hashable, Identifiable {
    enum Source: String, Codable { case camera, video }

    var id = UUID()
    var startedAt: Date
    var endedAt: Date
    var source: Source
    var videoName: String?
    var runs: [RunRecord]

    var duration: TimeInterval { endedAt.timeIntervalSince(startedAt) }
    var totalThrows: Int { runs.reduce(0) { $0 + $1.throwCount } }
    var bestRun: Int { runs.map(\.throwCount).max() ?? 0 }
    var averageRun: Double { runs.isEmpty ? 0 : Double(totalThrows) / Double(runs.count) }
    var longestRunTime: TimeInterval { runs.map(\.duration).max() ?? 0 }
    var timeJuggling: TimeInterval { runs.reduce(0) { $0 + $1.duration } }

    var medianRun: Double {
        let s = runs.map(\.throwCount).sorted()
        guard !s.isEmpty else { return 0 }
        return s.count % 2 == 1 ? Double(s[s.count / 2]) : Double(s[s.count / 2 - 1] + s[s.count / 2]) / 2
    }

    /// Throws per second while juggling (gaps between throws inside runs only).
    var throwRate: Double? {
        let intervals = runs.reduce(0) { $0 + max($1.throwCount - 1, 0) }
        return timeJuggling > 0 && intervals > 0 ? Double(intervals) / timeJuggling : nil
    }
}
