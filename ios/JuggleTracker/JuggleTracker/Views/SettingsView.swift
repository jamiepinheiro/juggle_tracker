import SwiftUI

struct SettingsView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("How balls are found") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Every frame goes through a small neural network trained to spot juggling balls (it runs on the device's Neural Engine; nothing leaves the device).")
                        Text("It learned from footage of blue-and-white beanbags. Other balls may be missed until it's retrained on them.")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }

                Section {
                    ShareLink(item: DataExport(sessions: store.sessions),
                              preview: SharePreview("Juggle Tracker data")) {
                        Label("Export all data (JSON)", systemImage: "square.and.arrow.up")
                    }
                } header: {
                    Text("Your data")
                } footer: {
                    Text("Every session with its runs, in one JSON file. \(store.sessions.count) sessions.")
                }

                Section("How runs are counted") {
                    Text("A throw counts at the top of each ball's arc. A run ends after a second without a throw, which is usually a drop. A single throw on its own isn't saved as a run.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() }.fontWeight(.semibold) }
        }
    }
}
