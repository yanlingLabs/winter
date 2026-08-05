import SwiftUI
import NormaKit

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
        VStack(spacing: 0) {
            header
            Divider()
            if rows.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(rows) { row in
                        landingRow(row)
                    }
                }
                .listStyle(.inset)
            }
        }
        .navigationTitle(mode.title)
        // The same belt `ChatLandingView`/`ShellSidebar` carry: the shell's 5s poll (T2) only runs
        // while the window is visible, and this surface can appear before its first tick.
        .task { await directory.refresh() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Picker("Tab", selection: $tab) {
                ForEach(LandingTab.allCases) { t in
                    Text(t.title).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 280)
            Spacer(minLength: 8)
            // T8-wd's create-time picker, reused verbatim — same anatomy as `SessionSidebar`'s own
            // "+ New session" row (`Image(systemName: "plus.circle")` + a plain-styled button).
            Button {
                host.startNewSession { sessionId in
                    nav.navigate(to: .session(sessionId))
                }
            } label: {
                Label("New", systemImage: "plus.circle")
                    .font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private func landingRow(_ row: SessionSummary) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                nav.navigate(to: .session(row.sessionId))
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
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
                    Spacer(minLength: 8)
                    // T3's carried ruling: the Archived tab's row affordance SAYS what clicking does
                    // ("Resume" — clicking attaches, which clears the archive flag daemon-side) rather
                    // than repeating the chip's "Archived" state a whole tab already named that says.
                    if landingRowShowsResumeAffordance(tab) {
                        resumeAffordance
                    } else {
                        ActivityChip(activity: row.activity)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Archived tab (§ `landingTabOffersRosterVerbs`): resume — the row's own click, above —
            // is the ONLY exit; no background/unbackground/stop/archive buttons render here at all,
            // mirroring the immutability ruling in the UI rather than re-deriving it.
            if landingTabOffersRosterVerbs(tab) {
                rosterVerbsRow(row)
            }
        }
        .padding(.vertical, 4)
    }

    /// The Background tab's per-row verbs: Stop (`session.interrupt`), the background⇄clear verb
    /// (`backgroundVerbOffered` — never re-derived; a background-tab row always resolves to
    /// `.unbackground`), and Archive. A refusal (e.g. Archive on a row still mid-turn — "stop or
    /// background it first") is shown VERBATIM, keyed to this row alone.
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
        .font(.caption)
        .foregroundStyle(.secondary)

        if let refusal = host.rosterRefusals[row.sessionId] {
            Text(refusal)
                .font(.caption2)
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
        Label("Resume", systemImage: "arrow.uturn.left.circle")
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: mode.systemImage)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text(emptyTitle)
                .font(.title2)
            Text(emptyDetail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
