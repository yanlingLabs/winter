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

    var body: some View {
        NavigationSplitView {
            ShellSidebar(nav: nav, directory: directory)
                .navigationSplitViewColumnWidth(min: 208, ideal: 240, max: 320)
        } detail: {
            ShellLandingView(destination: nav.destination)
        }
        .navigationSplitViewStyle(.balanced)
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

    var body: some View {
        List(selection: selection) {
            Section {
                ForEach(SessionMode.sidebarOrder) { mode in
                    modeRow(mode).tag(ShellDestination.mode(mode))
                }
            }
            Section("Recents") {
                if directory.rows.isEmpty {
                    Text("No sessions yet")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(directory.rows) { row in
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
                    nav.navigate(to: .dashboard)
                } label: {
                    Image(systemName: "gearshape")
                        .font(.body)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(nav.destination == .dashboard ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
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
