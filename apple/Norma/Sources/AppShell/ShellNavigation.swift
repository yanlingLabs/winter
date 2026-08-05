import Foundation

// MARK: - The four modes (the iOS nav mirror)

/// The four Norma session modes the shell's sidebar presents — the Mac mirror of the phone's own
/// `SessionMode` (`norma-ios/Norma/App/SessionMode.swift`), deliberately field-for-field: the same
/// four cases, the same `sidebarOrder` literal (pinned on iOS by `SessionModeTests`, and here by
/// `AppShellTests.testSidebarOrderMirrorsThePhonesFourRows` — two lists that must move together),
/// the same `isAvailable` reading of cowork.
///
/// Spec §2 (post-review correction): the sidebar is FOUR mode rows plus a flat Recents list — the
/// Dashboard is reached from a gear affordance, NOT a fifth session-like row. `ShellDestination`
/// below is where that distinction lives.
///
/// Cowork has no daemon mode at all yet (`session_spawn` pre-flight-rejects it), so it renders as
/// the honest "Coming soon" shell (Task 5) rather than an empty list.
enum SessionMode: String, CaseIterable, Identifiable, Sendable {
    case code, dispatch, cowork, chat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .code: return "Code"
        case .dispatch: return "Dispatch"
        case .cowork: return "Cowork"
        case .chat: return "Chat"
        }
    }

    /// SF Symbol per row — the phone's own glyph set, unchanged (the two sidebars are meant to read
    /// as siblings).
    var systemImage: String {
        switch self {
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .dispatch: return "antenna.radiowaves.left.and.right"
        case .cowork: return "checklist"
        case .chat: return "bubble.left.and.bubble.right"
        }
    }

    var isAvailable: Bool {
        switch self {
        case .code, .dispatch, .chat: return true
        case .cowork: return false
        }
    }

    /// Approved sidebar order: functional modes first, then the coming-soon shell.
    static let sidebarOrder: [SessionMode] = [.code, .dispatch, .cowork, .chat]

    /// The wire's `mode` string (`SessionSummary.mode`, threaded through from `session.list`).
    /// `nil` — which the daemon sends for a plain code session — and any unknown future mode both
    /// read as `.code`, the same fail-toward-the-default posture as `memoryTypeBadge`/
    /// `skillSourceBadge`'s unknown-value fallbacks in the Dashboard panes.
    init(wire: String?) {
        self = SessionMode(rawValue: wire ?? "") ?? .code
    }
}

// MARK: - The selection model

/// Everything the shell can be showing. Exactly three shapes, per the plan's Interfaces:
/// - `.mode` — one of the four sidebar rows' landing views (per-mode session lists, Task 4/5)
/// - `.session` — a specific session hosted in-app (Task 3's `ShellSessionHost`)
/// - `.dashboard` — the gear affordance's surface (Task 7)
///
/// `Hashable` because the sidebar's `List(selection:)` tags its rows with these values.
///
/// Task 7: `.dashboard` carries an OPTIONAL `DashboardPane` payload — additive to T1's original
/// bare `case dashboard`. `nil` is a PLAIN navigation (preserve whatever pane the surface is
/// already showing — the `AppWindowController.summon(navigatingTo:)`-owned "targeted vs plain"
/// distinction this mirrors is the exact `openDashboard(initialPane:)` lesson the old
/// `DashboardWindowController` learned the hard way: retargeting unconditionally on a plain
/// refocus discarded the user's current pane). A non-nil pane is a DEEP LINK — "Manage Plugins…"
/// is the one production example (`.dashboard(pane: .pluginManager)`), differentiating it from
/// the plain "Dashboard…" entry (`.dashboard(pane: nil)`) for the first time; T6 shipped both
/// landing on the same bare `.dashboard` because this payload didn't exist yet.
///
/// Every PRE-EXISTING producer of the old bare `.dashboard` becomes `.dashboard(pane: nil)` —
/// mechanically additive, never a behavior change for those call sites (the sidebar's gear button,
/// `AppShellTests`' pure-destination fixtures). `case .dashboard:` (no binding) still compiles
/// and matches regardless of payload — Swift's associated-value wildcard — so every switch that
/// only needed the CASE (title/glyph lookups) needed no change at all; only equality/array-literal
/// call sites (which need a concrete value, not a pattern) needed the explicit `(pane: nil)`.
enum ShellDestination: Hashable, Sendable {
    case mode(SessionMode)
    case session(String)
    case dashboard(pane: DashboardPane?)
}

/// Where a freshly opened shell lands — the FIRST row in `SessionMode.sidebarOrder`, computed
/// rather than hard-coded, so reordering the rows can never silently change the landing surface
/// (same posture as `defaultDashboardPane`, which reads `dashboardPaneOrder.first`).
let defaultShellDestination: ShellDestination = .mode(SessionMode.sidebarOrder.first ?? .code)

/// PURE: which sidebar MODE row renders highlighted for a destination — `nil` for a recents entry
/// or the Dashboard, so the four rows go quiet when the user is somewhere else (iOS's own nav: the
/// gear is not a fifth session-like row).
func selectedSidebarMode(for destination: ShellDestination) -> SessionMode? {
    if case .mode(let mode) = destination { return mode }
    return nil
}

/// PURE: the landing surface's title.
func shellDestinationTitle(_ destination: ShellDestination) -> String {
    switch destination {
    case .mode(let mode): return mode.title
    case .session: return "Session"
    case .dashboard: return "Dashboard"
    }
}

/// PURE: the landing surface's glyph.
func shellDestinationSystemImage(_ destination: ShellDestination) -> String {
    switch destination {
    case .mode(let mode): return mode.systemImage
    case .session: return "text.bubble"
    case .dashboard: return "gearshape"
    }
}

/// PURE: the rows a MODE's landing list shows, out of the shared directory (T2's live rows) — the
/// per-mode session lists spec §2 puts on each landing view, as one filter every landing reuses
/// (T3's chat landing today; T4/T5's code and dispatch landings next).
///
/// Filtering through `SessionMode(wire:)` rather than comparing the raw string is what makes the
/// wire's own conventions hold in one place: the daemon OMITS `mode` for a plain code session, and
/// an unknown future mode degrades to code — so `.code` is the mode that inherits both, and every
/// other landing lists exactly what its own name says. Order is the directory's (newest first).
func sessionRows(for mode: SessionMode, in rows: [SessionSummary]) -> [SessionSummary] {
    rows.filter { SessionMode(wire: $0.mode) == mode }
}

/// PURE: rows with an `"archived"` activity removed — the hidden-by-default ruling (design doc §2:
/// "Archived tab: hidden-by-default listing"), shared by the sidebar's flat Recents list
/// (`ShellSidebar`) and the landing's "All" tab (`ModeLandingView`, T4) rather than re-derived twice.
///
/// T3's review carried this decision forward explicitly (as-m10): `session.attach` clears the
/// archive flag (T3's finding — "attaching IS the resume"), so an ORDINARY click on a Recents row or
/// an "All" row must never reach an archived session at all, or it would silently un-archive it. The
/// Archived tab's resume (T4) is the one place that click is meant to do exactly that.
func excludingArchived(_ rows: [SessionSummary]) -> [SessionSummary] {
    rows.filter { $0.activity != "archived" }
}

/// PURE: Task 1's placeholder copy, narrowed by T3/T4/T5. Every mode now has a real landing
/// (`ChatLandingView`/`ModeLandingView`/`DispatchSurface`/`CoworkPlaceholder`); `ShellRootView.detail`
/// wires chat and cowork UNCONDITIONALLY (neither needs a host), so `.mode(.chat)` and
/// `.mode(.cowork)` never reach this function at all any more. `.mode(.code)`/`.mode(.dispatch)` and
/// `.session` still fall through here, but ONLY when the shell was built WITHOUT a host
/// (`AppWindowController.host` nil — the pure window tests) — so this says what is actually true of
/// that shell (no session can attach without one) rather than the stale "surface lands later"
/// promise a mode that has since shipped would be telling. Task 7: `.dashboard` now ships too
/// (`DashboardSurface`, wired unconditionally in `ShellRootView.detail` — it needs no host, only
/// `AppWindowController.dashboardWiring`), so its own case here is reached ONLY by a shell built
/// WITHOUT that wiring (the same pure-construction test posture as the host-less `.mode`/`.session`
/// cases above it) — never in production.
func shellLandingPlaceholderText(_ destination: ShellDestination) -> String {
    switch destination {
    case .mode, .session: return "This shell has no session host."
    case .dashboard: return "The Dashboard surface has no wiring."
    }
}

/// "" / whitespace-only / nil → "New session" (the placeholder the daemon hasn't titled yet
/// exists as); otherwise the trimmed title verbatim. Task 7: moved here from the now-deleted
/// `SessionsPane.swift` (the Dashboard's Sessions pane died — redundant with the shell's own
/// lists, spec §4) — this helper itself stayed alive and widely used (`ShellSidebar`'s Recents
/// list, `ChatLandingView`/`ModeLandingView`'s rows, `ShellSessionHost`'s hop-away banner), so it
/// moved to the shared pure-helpers home every one of those files already reads (`excludingArchived`
/// above), rather than dying with its old host view.
func sessionDisplayTitle(_ title: String?) -> String {
    let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? "New session" : trimmed
}

/// The shell's navigation state — ONE instance per `AppWindowController`, for the process
/// lifetime. `@ObservedObject` on the SwiftUI side (never `@State`): the controller must be able to
/// retarget the ALREADY-RENDERED view when a summon arrives with a destination, which is precisely
/// the bug `DashboardSelectionModel` was extracted to fix (a `@State` seeds once, at construction,
/// so nothing outside the view can ever move it afterwards).
@MainActor
final class ShellNavigationModel: ObservableObject {
    @Published private(set) var destination: ShellDestination

    /// Mirrors `AppWindowController.isRenderingActive` (hidden-window hygiene, spec §1) so views
    /// can gate their own tick work — a hidden or fully occluded shell must accumulate none.
    /// Published here rather than read off the controller so a SwiftUI body observes the change.
    @Published private(set) var renderingActive = false

    /// app-shell T3: fires on every destination CHANGE (never on a redundant re-navigation), so the
    /// session host learns what the shell is showing from ONE source of truth — the destination —
    /// instead of a second selection variable that can drift out of step with it. Wired by
    /// `AppWindowController` to `ShellSessionHost.apply(destination:)`; `nil` for a shell built
    /// without a host (every pre-existing construction site, and every T1 test).
    var onDestinationChange: ((ShellDestination) -> Void)?

    init(destination: ShellDestination = defaultShellDestination) {
        self.destination = destination
    }

    func navigate(to destination: ShellDestination) {
        guard self.destination != destination else { return }
        self.destination = destination
        onDestinationChange?(destination)
    }

    /// Called only by `AppWindowController` (visibility/occlusion changes) — never by a view.
    func setRenderingActive(_ active: Bool) {
        guard renderingActive != active else { return }
        renderingActive = active
    }
}
