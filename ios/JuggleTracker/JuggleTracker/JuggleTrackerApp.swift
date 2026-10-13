import SwiftUI

@main
struct JuggleTrackerApp: App {
    @State private var store = SessionStore()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environment(store)
        }
    }
}
