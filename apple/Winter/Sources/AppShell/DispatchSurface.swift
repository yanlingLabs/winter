import SwiftUI
import WinterKit

// MARK: - The surface

/// app-shell T5: Dispatch's own surface — the design spec's "coordinator's sit-down surface": the
/// ONE singleton dispatch session's conversation, hosted through T3's
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
/// It mirrors iOS's own dispatch screen (`norma-ios/Winter/Code/DispatchModeView.swift`) in the
/// resolving/resolved/failed(retry) dance (`ShellSessionHost.DispatchResolution`).
struct DispatchSurface: View {
    @ObservedObject var nav: ShellNavigationModel
    @ObservedObject var directory: SessionDirectory
    @ObservedObject var host: ShellSessionHost

    /// The conversation alone, exactly like a Code session (user call, 2026-09-19): the fleet
    /// strip that sat above it — "N Running · N Background" and a rule — was the last top row left
    /// on a session surface. The same counts live on the Code page's Background tab.
    var body: some View {
        content
            // Dispatch's own backdrop (user call, 2026-09-19): a particle grid that leans away from
            // the cursor. Tracked HERE, on the surface, so the pointer is seen over the transcript
            // and composer too — the field itself takes no hits.
            // Under the titlebar band too (2026-09-19) — the empty strip above the thread was the
            // one place without dots. The hover is read in GLOBAL space for the same reason: the
            // field and this surface no longer share a local origin.
            .background {
                DispatchBackdrop(adapter: host.attachment?.adapter, pointer: pointer)
                    // The detail card's own corners — a dot in the corner outside the card's curve
                    // would sit on the sidebar.
                    .clipShape(shellDetailCardShape)
                    .ignoresSafeArea()
            }
            .onContinuousHover(coordinateSpace: .global) { phase in
                switch phase {
                case .active(let location): pointer = location
                case .ended: pointer = nil
                }
            }
            .navigationTitle(SessionMode.dispatch.title)
    }

    /// The cursor over this surface, in its own coordinates, or nil.
    @State private var pointer: CGPoint?

    @ViewBuilder
    private var content: some View {
        switch host.dispatchResolution {
        case .resolving:
            resolvingState
        case .failed:
            failedState
        case .idle:
            // Resolved (or the shell is between destinations — the same fallback `ShellSessionView`
            // already gives an unattached host, "This session isn't open"). The hosted view's
            // "Move to CLI" toolbar action stays absent here structurally: its gate
            // (`moveToCliOffered`, reading the live `directory` row) refuses the dispatch
            // singleton's mode — no surface-side special case needed.
            ShellSessionView(host: host, directory: directory)
        }
    }

    private var resolvingState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Opening Dispatch…")
                .font(Typography.emptyStateSubtitle)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var failedState: some View {
        ContentUnavailableView {
            Label("Can't Open Dispatch", systemImage: "wifi.slash")
        } description: {
            Text("Winter couldn't reach the daemon for it.")
        } actions: {
            Button("Try Again") { host.retryDispatchResolution() }
        }
    }
}

/// The particle field, told whether Dispatch is working. Its own view so it OBSERVES the attached
/// session's adapter — the surface holds the host, which does not republish the adapter's turn state.
private struct DispatchBackdrop: View {
    let adapter: FieldStateAdapter?
    let pointer: CGPoint?

    var body: some View {
        if let adapter {
            LiveBackdrop(adapter: adapter, pointer: pointer)
        } else {
            DispatchParticleField(pointer: pointer)
        }
    }

    private struct LiveBackdrop: View {
        @ObservedObject var adapter: FieldStateAdapter
        let pointer: CGPoint?

        var body: some View {
            DispatchParticleField(pointer: pointer, isWorking: adapter.turnRunning)
        }
    }
}
