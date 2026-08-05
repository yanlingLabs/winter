import SwiftUI

/// app-shell T5: Cowork's Coming-soon surface — iOS's own actual pattern
/// (`norma-ios/Norma/App/ComingSoonView.swift`): a `ContentUnavailableView` with an icon + one
/// sentence, no list and no create door, because there is nothing behind it to list or create —
/// `session_spawn` pre-flight-rejects the cowork mode entirely (design spec §"Cowork": "NOT an empty
/// list — the mode is not wire-expressible yet"), so a list would promise a capability that fails on
/// first use, and a "New" button would be a dead one. The "Soon" chip lives on the SIDEBAR row
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
