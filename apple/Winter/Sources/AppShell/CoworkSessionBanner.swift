import SwiftUI
import WinterKit
import WinterProtocol

// The Cowork session window's notes (design 7.9): what is true of this conversation in this version, in
// plain lines above the transcript. Drawn only for a row whose mode is `cowork`; while Cowork is closed such a
// row (a synthetic one, since no daemon can create it) shows the single unavailable line and reads nothing.

/// PURE: does this session row get the Cowork banner? A missing row, and every mode but `cowork`, does not.
/// `SessionMode(wire:)` reads an absent mode as code, so absence never opens it.
func coworkBannerApplies(to row: SessionSummary?) -> Bool {
    guard let row else { return false }
    return SessionMode(wire: row.mode) == .cowork
}

/// PURE: the SF Symbol for a note, so a warning-weight fact reads differently from a state.
func coworkNoteSymbol(_ kind: CoworkSessionNote.Kind) -> String {
    switch kind {
    case .unavailable, .uncertain, .sourceUnavailable: return "exclamationmark.triangle"
    case .starting, .draining: return "clock"
    default: return "info.circle"
    }
}

struct CoworkSessionBanner: View {
    @ObservedObject var model: CoworkSessionWindowModel
    let row: SessionSummary

    var body: some View {
        let notes = model.notes(location: row.coworkLocation)
        VStack(alignment: .leading, spacing: 4) {
            ForEach(notes) { note in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: coworkNoteSymbol(note.kind))
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                    Text(note.text)
                        .font(Typography.control())
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.elevatedSurface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .task(id: row.cowork?.workspaceId) {
            model.bind(workspaceId: row.cowork?.workspaceId)
            while !Task.isCancelled {
                // Reads nothing while the app's constant is off: `refresh` returns before any request, and the
                // loop does not wait around for a gate that cannot open.
                await model.refresh()
                guard SessionMode.cowork.isAvailable else { return }
                try? await Task.sleep(for: .seconds(model.pollSeconds))
            }
        }
    }
}
