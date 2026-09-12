import SwiftUI

/// PURE: the empty-state subtitle — pinned directly (`ShellChatSurfaceTests`) since the wording
/// names a specific door and must track where creating actually STARTS. App shell T6 (review fix)
/// named the menu bar's "New Chat" entry here — the only door then. Bugfix pass B4 gave the
/// landing its OWN "New Chat" button (the SAME door, injected — see `newChat` below); chatgpt-ui
/// T2 retargets that door onto the new-chat page (the session is created on the page's first
/// send), and "Start one with New Chat" remains exactly what the button does — the exact
/// stale-copy drift class this pin exists for (this SwiftUI file's own convention: bodies
/// themselves are never unit-tested, only their pure decision helpers, per `DashboardTests`' file
/// doc — extracting the string is what makes that possible here).
let chatLandingEmptyStateSubtitle = "Start one with New Chat."

/// PURE (bugfix pass B4): whether the landing renders its "New Chat" header button. Gated ONLY on
/// the door being wired (`hasAction`) — deliberately NOT on the list: `hasRows` is in the signature
/// precisely so the pin (`ShellChatSurfaceTests`) can state that presence is identical in the empty
/// state and above a populated list, the same always-there header posture `ModeLandingView`'s "New"
/// button has. Unwired (a shell built without the door — `AppWindowController`'s pure window/
/// geometry tests pass no `openNewChat`) renders no dead button.
func chatLandingShowsNewChatButton(hasAction: Bool, hasRows: Bool) -> Bool {
    hasAction
}

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
/// swipe actions (no macOS equivalent worth faking). Its floating compose button DOES transfer now
/// (bugfix pass B4, header form): the landing's "New Chat" button is NOT the "second create path
/// with no owner" the T3 report warned against — it is the ONE New-chat door,
/// `AppDelegate.newChat()` (chatgpt-ui T2: opens the `.newChat` page; the create happens on the
/// page's first send — `ShellSessionHost.sendFirstChatMessage`), INJECTED through
/// `AppWindowController.openNewChat` → `ShellRootView.newChat`; this view never talks to a client.
struct ChatLandingView: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    /// B4: the New-chat door (T2: opens the new-chat page — creation starts there, on first
    /// send). `nil` for a shell built without one (`AppWindowController`'s pure window/geometry
    /// tests) — the landing then renders no header at all (`chatLandingShowsNewChatButton`), the
    /// same wiring-less fallback posture `ShellRootView.host`/`dashboardWiring` follow.
    var newChat: (() -> Void)? = nil

    private var rows: [SessionSummary] { sessionRows(for: .chat, in: directory.rows) }

    var body: some View {
        VStack(spacing: 0) {
            if chatLandingShowsNewChatButton(hasAction: newChat != nil, hasRows: !rows.isEmpty) {
                header
                Divider()
            }
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

    /// B4: the landing's own create affordance — `ModeLandingView.header`'s visual conventions
    /// verbatim (right-aligned `plus.circle` label, plain style, secondary tint, same padding),
    /// minus the tab picker chat doesn't have. Labeled "New Chat" — the door's established name
    /// (the menu-bar entry, and the empty-state copy that points here) — where the code landing's
    /// says "New" (its create opens a folder picker first; this one creates immediately).
    private var header: some View {
        HStack(spacing: 12) {
            Spacer(minLength: 8)
            Button {
                newChat?()
            } label: {
                Label("New Chat", systemImage: "plus.circle")
                    .font(Typography.label())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: SessionMode.chat.systemImage)
                .font(Typography.emptyStateGlyph)
                .foregroundStyle(.tertiary)
            Text("No chats yet")
                .font(Typography.emptyStateTitle)
            Text(chatLandingEmptyStateSubtitle)
                .font(Typography.emptyStateSubtitle)
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
                .font(Typography.landingBody)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(Date(timeIntervalSince1970: TimeInterval(row.createdAt) / 1000), style: .relative)
                .font(Typography.landingCaption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
