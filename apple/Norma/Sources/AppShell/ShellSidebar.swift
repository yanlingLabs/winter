import SwiftUI

/// The shell's root content: the nav sidebar and the selected destination's surface.
///
/// A `NavigationSplitView`, not the hand-rolled `HStack`+`ScrollView` sidebar `DashboardView` uses.
/// That convention exists because nothing in this target had ever needed a real sidebar column;
/// this window does, and on macOS 26 the split view's sidebar is exactly the first-party Liquid
/// Glass column the gallery describes (`norma-ios/docs/ios26-design-gallery/01-navigation-shell.md`
/// §1: "on iPad/Mac the sidebar becomes a floating Liquid Glass panel … you get this restyle for
/// free"). GALLERY EXTENSION POINT: the gallery's drawer anatomy is written for iPhone, where §3's
/// honest answer is that no first-party drawer API exists in either geometry and Claude's is a
/// hand-rolled REVEAL. On the Mac the sanctioned container exists, so the geometry half of that
/// section (reveal layering, card travel, edge-swipe gating, VoiceOver inversion) does not
/// transfer — what transfers is the drawer's ANATOMY, which `ShellSidebar` mirrors row for row.
struct ShellRootView: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    /// app-shell T3: the session host. `nil` for a shell built without one (see
    /// `AppWindowController.host`), which simply renders the landing placeholders it always did.
    var host: ShellSessionHost?
    /// Task 7: the Dashboard's injected data/closures — `nil` for a shell built without one (see
    /// `AppWindowController.dashboardWiring`), same host-less-fallback posture as `host` above.
    var dashboardWiring: DashboardWiring?
    /// Task 7: the Dashboard's current-pane memory — UNCONDITIONAL (see
    /// `AppWindowController.dashboardSelection`'s own doc comment for why it's never optional).
    @ObservedObject var dashboardSelection: DashboardSelectionModel
    /// Task 7 (spec §1 windows disposition): the pairing sheet's presentation state, attached below
    /// as a SwiftUI `.sheet` — replaces `PairingSheetWindowController` (deleted this task).
    @ObservedObject var pairingPresentation: PairingSheetPresentationModel

    var body: some View {
        NavigationSplitView {
            ShellSidebar(nav: nav, directory: directory)
                .navigationSplitViewColumnWidth(min: 208, ideal: 240, max: 320)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        // app-shell T4: the hop-away "keep working?" banner (spec §1, T3 review as-m9) — an
        // OVERLAY on the whole split view, not inside `detail`, so it survives the very
        // navigation that triggered it (the user has already moved on to a different surface by
        // the time this appears).
        .overlay(alignment: .bottom) {
            if let host {
                HopAwayBannerHost(host: host, directory: directory)
            }
        }
        // Task 7: the pairing ceremony rides ON the shell now, not its own `NSPanel` window —
        // `isPresented` and `onDismiss` both go through `pairingPresentation.dismiss()` so the
        // system's own close gesture (and this view's explicit close button,
        // `PairingSheetContainerView`'s overlay) run the SAME teardown.
        .sheet(isPresented: Binding(
            get: { pairingPresentation.isPresented },
            set: { if !$0 { pairingPresentation.dismiss() } }
        )) {
            PairingSheetContainerView(presentation: pairingPresentation)
        }
    }

    /// The destination's surface. Six are real as of T7 — a hosted session, the chat landing, the
    /// code landing, the dispatch surface, the cowork Coming-soon, and the Dashboard surface —
    /// leaving no destination on T1's placeholder in production (it's reached only by a shell built
    /// without the relevant wiring, e.g. the pure geometry tests).
    @ViewBuilder
    private var detail: some View {
        switch nav.destination {
        case .session:
            if let host {
                ShellSessionView(host: host, directory: directory)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        case .mode(.chat):
            ChatLandingView(nav: nav, directory: directory)
        case .mode(.code):
            if let host {
                ModeLandingView(mode: .code, nav: nav, directory: directory, host: host)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        case .mode(.dispatch):
            // T5: dispatch always shows the ONE singleton session (`ShellSessionHost.apply`'s
            // `.mode(.dispatch)` case), the same host-required shape `.mode(.code)` has above —
            // there is no session to attach to without one.
            if let host {
                DispatchSurface(nav: nav, directory: directory, host: host)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        case .mode(.cowork):
            // Needs no host — there is nothing here to attach, list, or create.
            CoworkPlaceholder()
        case .dashboard:
            // Task 7: needs no host either — `DashboardSurface` attaches to nothing, it only reads
            // `dashboardWiring`'s injected closures (mirrors `.mode(.cowork)`'s own "no host"
            // shape). The SPECIFIC pane shown is `dashboardSelection.selection`, not read from
            // `nav.destination`'s own payload here — see `AppWindowController.summon`'s doc comment
            // for how a non-nil payload reaches that model.
            if let dashboardWiring {
                DashboardSurface(wiring: dashboardWiring, selection: dashboardSelection)
            } else {
                ShellLandingView(destination: nav.destination)
            }
        }
    }
}

/// The nav sidebar — the measured Claude/iOS drawer anatomy, Mac-tuned (gallery
/// `01-navigation-shell.md` §3's "what Claude actually ships", and the phone's own `SidebarView`):
///
/// - the serif "Norma" wordmark pinned at the top (the ONE serif accent),
/// - the four mode rows in `SessionMode.sidebarOrder`, unavailable ones dimmed with a "Soon" chip
///   but never dead (spec §2 / iOS: the row still selects, landing on its Coming-soon surface),
/// - a FLAT Recents list under a sentence-case caption — mode-agnostic and empty-capable, exactly
///   as on the phone (no nesting, no per-mode grouping here; the per-mode lists live on each mode's
///   own landing view),
/// - the gear → Dashboard affordance in a bottom bar. The Dashboard is reached from the gear, NOT
///   from a fifth session-like row (the design review's nav correction).
///
/// Two deliberate Mac divergences from the phone, both noted as gallery extension points in the
/// task report: selection is the system's own sidebar highlight (`List(selection:)`) rather than
/// the phone's hand-drawn `Theme.selectionPill`, and the bottom bar is a plain `safeAreaInset`
/// rather than a `.bottomBar` toolbar (macOS has no bottom bar placement).
struct ShellSidebar: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory

    /// `List(selection:)` wants an optional binding; the shell's destination is never absent, so
    /// the setter simply ignores a `nil` (a click that deselects everything, which the system can
    /// produce on ⌘-click) and keeps the current surface up.
    private var selection: Binding<ShellDestination?> {
        Binding(
            get: { nav.destination },
            set: { if let destination = $0 { nav.navigate(to: destination) } }
        )
    }

    /// Task 7: the gear's own highlight — true for ANY `.dashboard` destination regardless of
    /// which pane's payload it carries (`case .dashboard:` matches every payload, the associated-
    /// value wildcard), so drilling into a specific pane (a deep link, or a click inside
    /// `DashboardSurface`'s own sidebar) keeps the gear lit exactly like the plain "Dashboard…"
    /// entry does.
    private var isDashboardDestination: Bool {
        if case .dashboard = nav.destination { return true }
        return false
    }

    var body: some View {
        List(selection: selection) {
            Section {
                ForEach(SessionMode.sidebarOrder) { mode in
                    modeRow(mode).tag(ShellDestination.mode(mode))
                }
            }
            // app-shell T4: Recents FILTERS OUT archived rows (`excludingArchived` — the
            // hidden-by-default ruling, T3 review as-m10). An ordinary Recents click just navigates
            // to `.session(id)`, and the shell resumes-by-attaching whatever it's given
            // (`ShellSessionHost`/`session.attach` clears the archive flag daemon-side) — so an
            // archived row sitting in this flat, mode-agnostic list would make an idle click
            // silently un-archive it. Archived sessions are reachable only through the Archived tab
            // (`ModeLandingView`), where resume is the stated, deliberate action.
            Section("Recents") {
                let recents = excludingArchived(directory.rows)
                if recents.isEmpty {
                    Text("No sessions yet")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(recents) { row in
                        Text(sessionDisplayTitle(row.title))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .tag(ShellDestination.session(row.sessionId))
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { wordmark }
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        // Same "the view's own appearance is the belt" posture as `SessionSidebar.task` — the
        // wirer-level `startInitialLoad()` kick can lose its race against this directory's harness
        // connecting. Task 2 adds the owned 5 s poll on top (visible-only).
        .task { await directory.refresh() }
    }

    /// The ONE serif accent, the phone's `Theme.wordmark` register — Mac-tuned (the phone's 25 pt
    /// title sits under a status bar; this sits under the window's own titlebar).
    private var wordmark: some View {
        Text("Norma")
            .font(.system(size: 19, weight: .regular, design: .serif))
            .foregroundStyle(.primary)
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }

    private func modeRow(_ mode: SessionMode) -> some View {
        HStack(spacing: 8) {
            Image(systemName: mode.systemImage)
                .frame(width: 18)
            Text(mode.title)
            Spacer(minLength: 4)
            if !mode.isAvailable {
                Text("Soon")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(.quaternary))
            }
        }
        // Unavailable modes read dimmed — but still select (never a dead row).
        .foregroundStyle(mode.isAvailable ? .primary : .secondary)
    }

    /// The gear → Dashboard affordance. A bare button in a hairline-topped bar: on macOS the
    /// system does not vend a bottom toolbar for a sidebar column, so the glass-bar treatment the
    /// gallery describes for iOS becomes a plain bar here (extension point, reported).
    private var bottomBar: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 6) {
                Button {
                    // Task 7: a PLAIN navigation (`pane: nil`) — preserves whichever pane
                    // `DashboardSurface`'s own `DashboardSelectionModel` is already showing (that
                    // model is the one persistent source of truth for "current pane"; it is never
                    // touched by a nil-payload navigation — see `AppWindowController.summon`'s own
                    // doc comment). A fresh app window still lands on `defaultDashboardPane` (the
                    // selection model's own init default).
                    nav.navigate(to: .dashboard(pane: nil))
                } label: {
                    Image(systemName: "gearshape")
                        .font(.body)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(isDashboardDestination ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .help("Dashboard")
                .accessibilityLabel("Dashboard")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }
}

/// Task 1 landing placeholder. The window, its summon paths, the sidebar and the selection model
/// are final architecture; THIS view is the one part that is deliberately temporary — Tasks 3–5 and
/// 7 replace it surface by surface (see `shellLandingPlaceholderText`).
struct ShellLandingView: View {
    let destination: ShellDestination

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: shellDestinationSystemImage(destination))
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.tertiary)
            Text(shellDestinationTitle(destination))
                .font(.title2)
            Text(shellLandingPlaceholderText(destination))
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
