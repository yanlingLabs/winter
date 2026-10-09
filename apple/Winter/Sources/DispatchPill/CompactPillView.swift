import SwiftUI

// The compact pill's own pieces. The compact pill itself is `DispatchPillComposerBar`
// (`DispatchPillView.swift`) in its `.compact` presentation — one view for compact and expanded, so
// the text field survives the first keystroke (see that type's doc). What is compact-specific is
// drawn here:
//
//   idle:     [ Type here …………………………………… (🎙) ]   — the white circle, the voice glyph until there is text
//   working:  [ ·  ∘ ○ ▣ ◯ ⬤ ▣ ⬤⬤(■) ]            — the plume, end to end, tool tiles riding it

/// The working state's whole body: the plume, end to end, its nozzle behind the stop button, with
/// each tool Dispatch uses thrown out of it as a puff, and each site it reads as its favicon
/// (`plumeThrows`) — the current round's again and again while it runs. No composer — the text view
/// stays mounted underneath, invisible, so a keystroke still lands in it and the first one opens the
/// typing pill (`dispatchPillPresentationAfterDraftChange`).
struct CompactPillWorking: View {
    let thrown: [PlumeThrow]
    var repeating: [PlumeThrow] = []

    var body: some View {
        WorkingAnimationView(
            thrown: thrown,
            repeating: repeating,
            emitterInset: DispatchPillMetrics.trailingPadding + DispatchPillMetrics.sendCircleSize / 2
        )
    }
}

/// The pill's trailing circle — always white with a black glyph, never greyed. Its role is
/// `composerSendButtonRole` (the composer card's own rule, "running beats blocked"), so the pill and
/// the app's composer agree on what that button is at every instant:
///
/// - running → STOP (Enter still sends a steer; the circle trades its send for the stop the user
///   needs);
/// - text to send → SEND;
/// - nothing to send → the VOICE glyph. Voice input is not built yet, so the circle does nothing in
///   that state — it is a placeholder for it, never a disabled send.
struct PillSendStopButton: View {
    let isRunning: Bool
    let canSend: Bool
    /// Stop was pressed and the turn has not ended yet: the circle shows a spinner and the button waits.
    var isStopping: Bool = false
    let onSend: () -> Void
    let onStop: () -> Void

    var body: some View {
        let role = composerSendButtonRole(isRunning: isRunning, sendBlockedReason: canSend ? nil : "")
        let phase = pillStopPhase(isRunning: isRunning, isStopping: isStopping)
        Button {
            switch role {
            case .stop: onStop()
            case .send: onSend()
            case .blocked: break
            }
        } label: {
            ZStack {
                Circle()
                    .fill(Color.white)
                if phase == .stopping {
                    ProgressView()
                        .controlSize(.small)
                        .colorScheme(.light)
                } else {
                    Image(systemName: pillSendButtonSymbol(role))
                        .font(Typography.label(.bold))
                        .foregroundStyle(Color.black)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(phase == .stopping)
        .help(phase == .stopping ? pillStoppingLabel : pillSendButtonLabel(role))
        .accessibilityLabel(phase == .stopping ? pillStoppingLabel : pillSendButtonLabel(role))
    }
}

/// What the stop button is doing: nothing to stop, ready to stop, or stopped-and-waiting.
enum PillStopPhase: Equatable {
    case idle
    case running
    case stopping
}

/// PURE: a pending stop only means something while a turn is running — the moment the turn ends the
/// button is idle again, whatever the stop flag still says.
func pillStopPhase(isRunning: Bool, isStopping: Bool) -> PillStopPhase {
    guard isRunning else { return .idle }
    return isStopping ? .stopping : .running
}

/// The words for a stop that has been sent and not yet confirmed.
let pillStoppingLabel = "Stopping…"

/// PURE: the trailing circle's glyph for its role.
func pillSendButtonSymbol(_ role: ComposerSendButtonRole) -> String {
    switch role {
    case .stop: return "stop.fill"
    case .send: return "arrow.up"
    case .blocked: return "mic.fill"
    }
}

func pillSendButtonLabel(_ role: ComposerSendButtonRole) -> String {
    switch role {
    case .stop: return "Stop"
    case .send: return "Send"
    case .blocked: return "Voice"
    }
}
