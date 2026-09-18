import SwiftUI
import WinterKit

// MARK: - Tabs (PURE — driven directly by ModeLandingViewTests)

/// app-shell T4: the landing's three tabs — the SP1 obligations' home (design doc §2: "the Background
/// tab … the Archived tab … activity chips on every session row"). `All` is deliberately not called
/// out as excluding archived in its own case — see `landingTabRows` for why it must.
enum LandingTab: String, CaseIterable, Identifiable, Sendable {
    case all, background, archived

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .background: return "Background"
        case .archived: return "Archived"
        }
    }
}

/// PURE: a tab's rows, out of a MODE's already-filtered rows (`sessionRows(for:in:)`, T3) — one more
/// filter stacked on top, same composition shape every landing reuses.
///
/// `.all` EXCLUDES archived via `excludingArchived` (`ShellNavigation.swift`) — the hidden-by-default
/// ruling (plan/design doc §2), shared with `ShellSidebar`'s Recents list rather than re-derived here
/// a second time. `.background`/`.archived` read the daemon's own derived `activity` field directly
/// — never re-computed from anything else.
func landingTabRows(_ tab: LandingTab, in rows: [SessionSummary]) -> [SessionSummary] {
    switch tab {
    case .all: return excludingArchived(rows)
    case .background: return rows.filter { $0.activity == "background" }
    case .archived: return rows.filter { $0.activity == "archived" }
    }
}

/// PURE: whether a landing row on THIS tab offers the roster verbs (stop / background⇄clear /
/// archive) at all — never on Archived. Mirrors T3's carried ruling rather than re-deriving it:
/// resume — clicking the row — is archived's only exit (`ActivityMenu.backgroundVerbOffered`'s own
/// "archived is immutable except through resume" is the daemon-side twin of this UI-side gate).
func landingTabOffersRosterVerbs(_ tab: LandingTab) -> Bool {
    tab == .background
}

/// PURE: whether a row shows the "Resume" affordance in place of its activity chip — the carried
/// ruling that the tab's row should SAY what clicking does. Only the Archived tab: elsewhere, a
/// click just opens the session, so the chip (its current derived state) is the more useful trailing
/// label; on Archived, a click resumes it (`session.attach` clears the archive flag daemon-side —
/// T3's finding), and an "Archived" chip on every row of a tab already named Archived says nothing a
/// user doesn't already know, where "Resume" says exactly what happens next.
func landingRowShowsResumeAffordance(_ tab: LandingTab) -> Bool {
    tab == .archived
}

// MARK: - The landing

/// app-shell T4: the shared per-mode landing — session list + tabs + chips + (on the Background tab)
/// the roster verbs + the "New" create door. Built MODE-PARAMETERIZED from the start (the plan's
/// interface block: "the landing pattern every mode reuses") even though this task wires it to only
/// ONE sidebar row (`.mode(.code)`, `ShellRootView.detail`) — dispatch/cowork stay T1's placeholders
/// until T5 decides how (or whether) they reuse this same view.
///
/// `host` is NOT optional here (unlike `ChatLandingView`, which only ever navigates): the roster
/// verbs and the "New" button both need `ShellSessionHost`'s wire seams
/// (`interruptFromRoster`/`setActivityFromRoster`/`startNewSession`), so `ShellRootView` falls back
/// to the plain placeholder when there is no host, the same guard the `.session` case already uses.
struct ModeLandingView: View {
    let mode: SessionMode
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    @ObservedObject var host: ShellSessionHost

    @State private var tab: LandingTab = .all

    private var modeRows: [SessionSummary] { sessionRows(for: mode, in: directory.rows) }
    private var rows: [SessionSummary] { landingTabRows(tab, in: modeRows) }

    var body: some View {
        // 2026-09-18: the app's own list chrome (`SessionListChrome.swift`) — large title, the
        // composer's switch for the tabs, hover rows in a centred column — replacing the AppKit
        // `List` under a segmented `Picker`. Every read, verb and gate below is unchanged.
        SessionListPage(title: mode.title, actionTitle: "New", action: newSession) {
            SessionListTabs(tabs: LandingTab.allCases, selection: $tab, title: \.title)
        } content: {
            if rows.isEmpty {
                SessionListEmpty(title: emptyTitle, detail: emptyDetail)
            } else {
                ForEach(rows) { row in
                    landingRow(row)
                }
            }
        }
        .navigationTitle(mode.title)
        .task { await directory.refresh() }
    }

    private func newSession() {
        host.startNewSession { sessionId in
            nav.navigate(to: .session(sessionId))
        }
    }

    @ViewBuilder
    private func landingRow(_ row: SessionSummary) -> some View {
        SessionListRow(title: sessionDisplayTitle(row.title),
                       date: sessionListDate(row.createdAt),
                       action: { nav.navigate(to: .session(row.sessionId)) }) {
            if landingRowShowsResumeAffordance(tab) {
                resumeAffordance
            } else {
                ActivityChip(activity: row.activity)
            }
        } below: {
            if landingTabOffersRosterVerbs(tab) {
                rosterVerbsRow(row)
                    .padding(.bottom, 6)
            }
        }
        .contextMenu {
            if moveToCliOffered(row: row) {
                Button {
                    host.moveToCli(sessionId: row.sessionId)
                } label: {
                    Label("Move to CLI", systemImage: "terminal")
                }
            }
        }
    }

    @ViewBuilder
    private func rosterVerbsRow(_ row: SessionSummary) -> some View {
        let inFlight = host.rosterActionInFlight.contains(row.sessionId)
        HStack(spacing: 14) {
            rosterButton("Stop", systemImage: "stop.circle") {
                host.interruptFromRoster(row.sessionId)
            }
            if let verb = backgroundVerbOffered(activity: row.activity) {
                rosterButton(backgroundVerbLabel(verb), systemImage: verb == .background ? "moon" : "moon.fill") {
                    host.setActivityFromRoster(row.sessionId, target: verb.rawValue)
                }
            }
            rosterButton("Archive", systemImage: "archivebox") {
                host.setActivityFromRoster(row.sessionId, target: "archived")
            }
        }
        .disabled(inFlight)
        .font(Typography.control())
        .foregroundStyle(Theme.textMuted)

        if let refusal = host.rosterRefusals[row.sessionId] {
            Text(refusal)
                .font(Typography.chipLabel)
                .foregroundStyle(.red)
        }
    }

    private func rosterButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(.plain)
    }

    /// The Archived tab's trailing label — never a button of its own (the row's whole surface, above,
    /// is the click; this is presentational only, so it says what THAT click does).
    private var resumeAffordance: some View {
        Label("Resume", systemImage: "arrow.uturn.left")
            .font(Typography.control())
            .foregroundStyle(Theme.textMuted)
    }

    private var emptyTitle: String {
        switch tab {
        case .all: return "No \(mode.title) sessions yet"
        case .background: return "Nothing running in the background"
        case .archived: return "No archived sessions"
        }
    }

    private var emptyDetail: String {
        switch tab {
        case .all: return "Start one with New, or open one from Recents."
        case .background: return "Sessions kept running unattended show up here."
        case .archived: return "Sessions you archive stay here until you resume them."
        }
    }
}
