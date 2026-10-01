import SwiftUI

// The compact pill's own pieces. The compact pill itself is `DispatchPillComposerBar`
// (`DispatchPillView.swift`) in its `.compact` presentation — one view for compact and expanded, so
// the text field survives the first keystroke (see that type's doc). What is compact-specific is
// drawn here:
//
//   idle:     [ Type here …………………………………… (●) ]   — the blue send circle
//   working:  [ (✺) Reticulating… ………………… (■) ]   — the rocket ring, the working verb, stop

/// The working state's leading mark: the particle ring with the running tool's icon at its centre.
struct CompactPillLeading: View {
    let toolName: String?

    var body: some View {
        WorkingAnimationView(toolName: toolName, diameter: 26)
            .transition(.opacity.combined(with: .scale(scale: 0.6)))
    }
}

/// The pill's trailing circle: the blue SEND circle, or STOP while a turn runs. The role is
/// `composerSendButtonRole` — the composer card's own rule, "running beats blocked" — so the pill
/// and the app's composer agree on what that button is at every instant. While a turn runs, Enter
/// still sends (a steer); the circle trades its send for the stop the user needs. When blocked,
/// shows a voice/mic icon overlay instead of a disabled state.
struct PillSendStopButton: View {
    let isRunning: Bool
    let canSend: Bool
    let onSend: () -> Void
    let onStop: () -> Void

    var body: some View {
        let role = composerSendButtonRole(isRunning: isRunning, sendBlockedReason: canSend ? nil : "")
        Button {
            switch role {
            case .stop: onStop()
            case .send: onSend()
            case .blocked: break
            }
        } label: {
            ZStack {
                Circle()
                    .fill(Color.blue)
                if case .blocked = role {
                    Image(systemName: "mic.fill")
                        .font(Typography.label(.bold))
                        .foregroundStyle(.white)
                } else {
                    Image(systemName: role == .stop ? "stop.fill" : "arrow.up")
                        .font(Typography.label(.bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(role == .stop ? "Stop" : "Send")
        .accessibilityLabel(role == .stop ? "Stop" : "Send")
    }
}
