import SwiftUI

/// The pill-themed session window's header: a quiet capsule on the traffic lights' row with the
/// session's title and a dot in its plume colour. The plume itself — and the stop — live in the
/// composer (`PillChromeComposer`), the way they do in the dispatch pill.
struct SessionWindowHeader: View {
    @ObservedObject var adapter: FieldStateAdapter
    @ObservedObject var directory: SessionDirectory
    let sessionId: () -> String
    let fallbackTitle: String
    let palette: PlumePalette

    static let height: CGFloat = 40
    static let width: CGFloat = 380

    private var title: String {
        let id = sessionId()
        let row = directory.rows.first { $0.sessionId == id }
        let named = (row?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return named.isEmpty ? fallbackTitle : named
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(palette.bodyColor)
                .frame(width: 7, height: 7)
                .opacity(adapter.turnRunning ? 1 : 0.6)
            Text(title)
                .font(Typography.label(.semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .padding(.horizontal, 16)
        .frame(height: Self.height)
        .frame(maxWidth: Self.width)
        .background(Capsule().fill(pillChromeSurface))
        .shadow(color: .black.opacity(0.6), radius: 12, y: 3)
        .animation(.easeInOut(duration: 0.3), value: adapter.turnRunning)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }
}
