import SwiftUI
import NormaKit

// MARK: - The fleet strip (PURE — driven directly by DispatchSurfaceTests)

/// app-shell T5: the fleet strip's two counts — off T2's already-live rows, the SAME `activity`
/// field every roster surface reads (`landingTabRows`'s `.background` case is this function's twin).
/// NO new RPC: the design spec is explicit that `session.list` (via `list_sessions`) is a DISPATCH
/// TOOL, not a client RPC — re-fetching a second roster here would be a parallel implementation of
/// `session.list` with nothing on the daemon backing it as a client-facing call. Dispatch/chat rows
/// carry no `activity` at all (`ACTIVITY_MODES`, the participation allowlist) and so drop out of both
/// counts for free — the same absent-tolerance every other consumer of this field already gets.
func fleetCounts(_ rows: [SessionSummary]) -> (running: Int, background: Int) {
    (rows.filter { $0.activity == "active" }.count, rows.filter { $0.activity == "background" }.count)
}

/// PURE: the fleet strip's tap target. The design calls for landing on "the session" a count
/// represents; `ModeLandingView`'s tab is per-view `@State` with no seam for an outside caller to
/// preselect it (a real but separable change), so the smallest HONEST shape — reported, not silently
/// settled for — is the code landing itself: the matching rows are right there, just not
/// tab-preselected.
func fleetStripTapDestination() -> ShellDestination { .mode(.code) }

// MARK: - The surface

/// app-shell T5: Dispatch's own surface — the design spec's "coordinator's sit-down surface": the
/// fleet strip above the ONE singleton dispatch session's conversation, hosted through T3's
/// `ShellSessionHost` exactly like any other session. `ShellSessionHost.apply(destination:)`'s
/// `.mode(.dispatch)` case resolves `session.dispatch` and attaches through the ordinary `select`
/// door — so hop/hide/re-show all govern the dispatch session precisely as they govern a code or chat
/// one, with no special-cased attachment behavior living in this view.
///
/// The orb's own quick-dispatch window (`OrbWindowController`'s morph surface) is UNTOUCHED — it
/// keeps its own lightweight door onto the same singleton session; the two coexist by design
/// (multi-attach is the shipped norm, T3's finding: the shell mints its OWN harness, sharing only the
/// transport factory and token).
///
/// GALLERY EXTENSION POINT: no iOS page covers a fleet strip, and neither does iOS's own dispatch
/// screen (`norma-ios/Norma/Code/DispatchModeView.swift`) — what THAT view establishes, and what this
/// one mirrors, is the resolving/resolved/failed(retry) dance (`ShellSessionHost.DispatchResolution`).
/// The fleet strip itself is a genuinely new Mac-only addition the design spec calls for directly
/// ("the fleet view … the roster the dispatch tools made visible"), with nothing on the phone to
/// extend from.
struct DispatchSurface: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    @ObservedObject var host: ShellSessionHost

    var body: some View {
        VStack(spacing: 0) {
            fleetStrip
            Divider()
            content
        }
        .navigationTitle(SessionMode.dispatch.title)
    }

    private var counts: (running: Int, background: Int) { fleetCounts(directory.rows) }

    private var fleetStrip: some View {
        HStack(spacing: 16) {
            fleetCountButton(label: "Running", count: counts.running, systemImage: "bolt.fill")
            fleetCountButton(label: "Background", count: counts.background, systemImage: "moon.fill")
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func fleetCountButton(label: String, count: Int, systemImage: String) -> some View {
        Button {
            nav.navigate(to: fleetStripTapDestination())
        } label: {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                Text("\(count) \(label)")
            }
        }
        .buttonStyle(.plain)
        .font(.callout)
        .foregroundStyle(.secondary)
    }

    @ViewBuilder
    private var content: some View {
        switch host.dispatchResolution {
        case .resolving:
            resolvingState
        case .failed:
            failedState
        case .idle:
            // Resolved (or the shell is between destinations — the same fallback `ShellSessionView`
            // already gives an unattached host, "This session isn't open").
            ShellSessionView(host: host)
        }
    }

    private var resolvingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Opening Dispatch…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var failedState: some View {
        ContentUnavailableView {
            Label("Can't Open Dispatch", systemImage: "wifi.slash")
        } description: {
            Text("Norma couldn't reach the daemon for it.")
        } actions: {
            Button("Try Again") { host.retryDispatchResolution() }
        }
    }
}
