import SwiftUI

/// Fallback only when the shell has no management connection.
struct CoworkPlaceholder: View {
    var body: some View {
        ContentUnavailableView {
            Label("Workspace service unavailable", systemImage: "square.stack")
        } description: {
            Text("Connect to Winter to inspect Cowork workspaces. Cowork conversations are not available yet.")
        }.navigationTitle("Cowork")
    }
}
