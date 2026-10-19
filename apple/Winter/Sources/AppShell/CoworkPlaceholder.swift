import SwiftUI

/// Fallback only when the shell has no management connection.
struct CoworkPlaceholder: View {
    var body: some View {
        ContentUnavailableView {
            Label("Cowork is coming soon", systemImage: "square.stack")
        } description: {
            Text("Cowork is not available yet.")
        }.navigationTitle("Cowork")
    }
}
