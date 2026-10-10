import SwiftUI

/// app-shell T5: Cowork's Coming-soon surface — iOS's own actual pattern
/// (`norma-ios/Winter/App/ComingSoonView.swift`): a `ContentUnavailableView` with an icon + one
/// sentence, no list and no create door: `session.create` excludes Cowork and `SpawnSession`
/// pre-flight-rejects its reserved `cowork` argument. Lifecycle/output helpers can recognize
/// synthetic Cowork rows, but do not make a Cowork session creatable. A list or "New" button here
/// would promise an unavailable capability. The "Soon" chip lives on the SIDEBAR row
/// (`ShellSidebar.modeRow`, shipped T1, T1-review-verified) — this view is the landing half of that
/// same honesty, not a second place the chip needs re-rendering.
///
/// Deliberately takes NO `ShellSessionHost`/`SessionDirectory` — unlike every other mode's landing
/// (`ModeLandingView`, `DispatchSurface`). That absence of a wiring seam IS the pin: there is nothing
/// here to attach a create/roster door to, so `ShellRootView.detail` can (and does) route
/// `.mode(.cowork)` to this view UNCONDITIONALLY, regardless of whether the shell even has a host.
struct CoworkPlaceholder: View {
    var body: some View {
        ContentUnavailableView {
            Label(SessionMode.cowork.title, systemImage: SessionMode.cowork.systemImage)
        } description: {
            Text("Cowork isn't available yet.")
        }
        .navigationTitle(SessionMode.cowork.title)
    }
}
