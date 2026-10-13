import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// Everything the app stores, as one JSON file for Settings › Export all data.
struct DataExport: Transferable {
    let sessions: [SessionRecord]

    private struct File: Encodable {
        let app = "Juggle Tracker"
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let exportedAt = Date()
        let sessions: [SessionRecord]
    }

    func json() throws -> Data {
        let file = File(sessions: sessions)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(file)
    }

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .json) { export in
            let day = Date().formatted(.iso8601.year().month().day())
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("juggle-tracker-\(day).json")
            try export.json().write(to: url, options: .atomic)
            return SentTransferredFile(url)
        }
    }
}
