import SwiftUI

/// ComputerV2 wake triggers (2026-10-12): "Waiting for you · click “Submit for review” in Chrome · 52 min left ·
/// [Stop waiting]" — one pill per trigger the session's model armed, floating above the composer while it is armed.
/// The user can always see that Winter waits, for what, for how long, and stop it. Drawn in the house chrome (a
/// `controlSurface` capsule with the elevated hairline, quiet meta type — `docs/brand.md`), never native controls.
/// The minutes tick on a half-minute timeline; the pill leaves when `wake_ended` lands.
struct WakeWaitingPills: View {
    let wakes: [ArmedWake]
    /// [Stop waiting] — nil on a surface that has no door to the daemon for it (then the pill has no button).
    let onStop: ((String) -> Void)?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            VStack(alignment: .leading, spacing: 6) {
                ForEach(wakes) { wake in
                    WakeWaitingPill(wake: wake, now: context.date, onStop: onStop)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct WakeWaitingPill: View {
    let wake: ArmedWake
    let now: Date
    let onStop: ((String) -> Void)?
    @State private var stopping = false
    @State private var hoveringStop = false

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "hourglass")
                .imageScale(.small)
                .foregroundStyle(Theme.accent)
            Text(WakeWords.pillLine(wake, now: now))
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            if let onStop {
                Text("·").font(Typography.caption()).foregroundStyle(Theme.textMuted)
                Button {
                    guard !stopping else { return }
                    stopping = true
                    onStop(wake.wakeId)
                } label: {
                    Text(stopping ? "Stopping…" : "Stop waiting")
                        .font(Typography.caption(.medium))
                        .foregroundStyle(hoveringStop ? Theme.textPrimary : Theme.textMuted)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(hoveringStop ? Theme.chromeHover : Color.clear))
                }
                .buttonStyle(.plain)
                .onHover { hoveringStop = $0 }
                .disabled(stopping)
                .accessibilityLabel("Stop waiting")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Capsule().fill(Theme.controlSurface))
        .overlay(Capsule().strokeBorder(Theme.hairlineElevated, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .help("Winter continues by itself when you do this")
    }
}

/// The session row's small "waiting for you" mark (ComputerV2 wake triggers): an hourglass in the accent, and — on the
/// mode landings' roomier rows — its words. Shown while any trigger of the session is armed (`SessionSummary.wakesArmed`).
struct WakeWaitingMark: View {
    var showsLabel = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "hourglass")
                .font(Typography.tiny(.semibold))
                .foregroundStyle(Theme.accent)
            if showsLabel {
                Text("waiting for you")
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
        }
        .help("Winter is waiting for you here")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Waiting for you")
    }
}
