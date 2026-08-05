import SwiftUI

/// app-shell T3: the Chat mode's landing — the first real landing surface, and the shape the other
/// three follow (T4 generalizes it into `ModeLandingView`; this file is the one-mode instance that
/// proves the pattern against a live directory rather than a sketch).
///
/// Spec §2: "the ChatContent views move in essentially intact" — so a row's click does NOT open a
/// window; it navigates the shell to `.session(id)`, which is what makes `ShellSessionHost` attach
/// and the shared transcript render in place (`ShellRootView.detail`).
///
/// Chat rows carry NO activity chip and never will: chat does not participate in the activity
/// lifecycle at all (`ACTIVITY_MODES`, and `session.list` populates no `activity` for those rows),
/// which is exactly why the chips T4 adds belong to the code/cowork landings and not here.
///
/// GALLERY EXTENSION POINT: the phone's own chat list is a `List` of title + relative time rows
/// (`norma-ios`'s session list), which is what this mirrors; what does not transfer is the phone's
/// swipe actions (no macOS equivalent worth faking) and its floating compose button — creating a
/// chat is still the menu bar's door until T6 retargets it, and a landing button that duplicated it
/// before then would be a second create path with no owner.
struct ChatLandingView: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory

    private var rows: [SessionSummary] { sessionRows(for: .chat, in: directory.rows) }

    var body: some View {
        Group {
            if rows.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(rows) { row in
                        Button {
                            nav.navigate(to: .session(row.sessionId))
                        } label: {
                            ChatLandingRow(row: row)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .listStyle(.inset)
            }
        }
        .navigationTitle(SessionMode.chat.title)
        // The same belt `ShellSidebar`/`SessionSidebar` carry: the shell's 5s poll (T2) only runs
        // while the window is visible, and this surface can appear before its first tick.
        .task { await directory.refresh() }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: SessionMode.chat.systemImage)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text("No chats yet")
                .font(.title2)
            Text("Start one from the menu bar's Chat entry.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// One landing row — title (with the directory's own "New session" fallback for an untitled row)
/// over its relative creation time, the same anatomy `SessionSidebar`'s rows use so the two lists
/// read as one family.
private struct ChatLandingRow: View {
    let row: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(sessionDisplayTitle(row.title))
                .font(.body)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(Date(timeIntervalSince1970: TimeInterval(row.createdAt) / 1000), style: .relative)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
