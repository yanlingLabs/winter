import SwiftUI

// The commands the user ran from the pill, as a row of small pills in the floating stack, right under the
// child-session row. Same shape language and width-splitting as a child pill (`childPillLayout`) — but they
// ARRIVE differently: a session pill rises out of the main pill; a command pill types itself on, growing from
// its leading edge while the `$ command` appears character by character behind a terminal cursor.

/// PURE (`ShellCommandLineTests`): what a command pill draws for its run's LINE (`CommandRun.commandOutcome`);
/// whether the shell is still open after it is `CommandRun.shellIsLive`.
enum CommandPillStatus: Equatable {
    case running
    /// The shell has not started the line on its own: neutral, never "failed" (the window offers "Type it").
    case waiting
    /// The user typed the line in by hand: its status is not known.
    case handedOver
    case succeeded
    case failed

    init(_ outcome: CommandRunOutcome, waiting: Bool = false) {
        switch outcome {
        case .running: self = waiting ? .waiting : .running
        case .typedByHand, .interactive: self = .handedOver
        case .exited(0): self = .succeeded
        default: self = .failed
        }
    }
}

/// How a command pill looks part-way through typing itself on: `progress` 0 = a sliver at its leading edge,
/// 1 = in place.
struct CommandPillEntrance: Equatable {
    let scaleX: Double
    let opacity: Double

    init(progress: Double) {
        let p = min(max(progress, 0), 1)
        scaleX = 0.12 + 0.88 * p
        opacity = min(1, p * 1.6)
    }
}

/// The row's changes ride the child row's spring, so the two rows move as one stack.
@MainActor
func commandPillRowAnimated(_ change: () -> Void) {
    withAnimation(childRowSpring, change)
}

private struct CommandPillEntranceModifier: ViewModifier {
    let progress: Double
    func body(content: Content) -> some View {
        let look = CommandPillEntrance(progress: progress)
        content
            .scaleEffect(x: look.scaleX, y: 1, anchor: .leading)
            .opacity(look.opacity)
    }
}

extension AnyTransition {
    /// A command pill unrolling from its leading edge — and rolling back up when it leaves.
    static var commandPill: AnyTransition {
        .modifier(active: CommandPillEntranceModifier(progress: 0), identity: CommandPillEntranceModifier(progress: 1))
            .animation(.spring(response: 0.32, dampingFraction: 0.86))
    }
}

struct CommandPillsView: View {
    @ObservedObject var store: CommandRunStore
    let rowWidth: CGFloat

    var body: some View {
        // Newest at the trailing end, like the child row; the ones that do not fit fold into "+n".
        let layout = childPillLayout(count: store.runs.count, rowWidth: rowWidth)
        let visible = Array(store.runs.suffix(layout.visibleCount))
        HStack(spacing: DispatchPillMetrics.childPillGap) {
            if layout.overflowCount > 0 {
                let hidden = store.runs.prefix(layout.overflowCount)
                Button { if let newest = hidden.last { store.openWindow(newest.id) } } label: {
                    Text("+\(layout.overflowCount)")
                        .font(Typography.label(.semibold))
                        .foregroundStyle(Color.white)
                        .frame(width: DispatchPillMetrics.childRowHeight, height: DispatchPillMetrics.childRowHeight)
                        .background(Circle().fill(Color.black))
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("\(layout.overflowCount) earlier command\(layout.overflowCount == 1 ? "" : "s") — open the latest of them")
                .transition(.commandPill)
            }
            ForEach(visible) { run in
                CommandPill(run: run,
                            onOpen: { store.openWindow(run.id) },
                            onStop: { store.stop(run.id) },
                            onEnd: { store.endShell(run.id) },
                            onDismiss: { store.dismiss(run.id) })
                    .frame(width: layout.pillWidth, height: DispatchPillMetrics.childRowHeight)
                    .transition(.commandPill)
            }
        }
        .animation(childRowSpring, value: store.runs.map(\.id))
        .frame(width: rowWidth, height: DispatchPillMetrics.childRowHeight, alignment: .trailing)
    }
}

/// One run: a terminal cursor while its line works (then a check, or a quiet red mark — with a small purple
/// prompt beside it while the shell is still open), `$ command` in the terminal's mono, and at the trailing end a
/// stop (the line), an end (the open shell) or × (all done).
private struct CommandPill: View {
    @ObservedObject var run: CommandRun
    let onOpen: () -> Void
    let onStop: () -> Void
    let onEnd: () -> Void
    let onDismiss: () -> Void

    /// How many characters of the command have typed on so far.
    @State private var typed = 0
    @State private var hovering = false

    private var status: CommandPillStatus { CommandPillStatus(run.commandOutcome, waiting: run.needsManualStart) }

    var body: some View {
        HStack(spacing: 6) {
            statusMark
            Text(typedCommand)
                .font(Typography.labelMono(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            trailingControl
        }
        .padding(.leading, 12)
        .padding(.trailing, DispatchPillMetrics.trailingPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Capsule().fill(Color.black))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
        .contentShape(Capsule())
        .animation(.easeInOut(duration: 0.3), value: status)
        .animation(.easeInOut(duration: 0.3), value: run.shellIsLive)
        .onTapGesture(perform: onOpen)
        .onHover { hovering = $0 }
        .help(run.shellIsLive ? "$ \(run.command) — its shell is still open; click to type in it"
                              : "$ \(run.command) — open its terminal")
        .task { await typeOn() }
    }

    private var typedCommand: String {
        let full = run.displayTitle
        return typed >= full.count ? full : String(full.prefix(typed))
    }

    /// The type-on: a character every few milliseconds, the first forty or so (the rest truncate anyway).
    private func typeOn() async {
        let full = run.displayTitle
        let shown = min(full.count, 44)
        guard typed < shown else { return }
        for count in (typed + 1)...shown {
            try? await Task.sleep(nanoseconds: 14_000_000)
            if Task.isCancelled { return }
            typed = count
        }
        typed = full.count
    }

    @ViewBuilder
    private var statusMark: some View {
        HStack(spacing: 3) {
            lineMark
            if run.shellIsLive {
                // The shell is still open: a small prompt caret, steady.
                Text("›")
                    .font(Typography.labelMono(.bold))
                    .foregroundStyle(Theme.commandPurple)
                    .transition(.opacity)
            }
        }
    }

    @ViewBuilder
    private var lineMark: some View {
        switch status {
        case .running:
            // A terminal cursor, blinking — the run is working.
            TimelineView(.periodic(from: .now, by: 0.53)) { context in
                let on = Int(context.date.timeIntervalSinceReferenceDate / 0.53) % 2 == 0
                RoundedRectangle(cornerRadius: 1)
                    .fill(Theme.commandPurple)
                    .frame(width: 7, height: 13)
                    .opacity(on ? 1 : 0.15)
            }
            .frame(width: 12, height: 20)
        case .waiting, .handedOver:
            // Neutral: a steady, dim cursor.
            RoundedRectangle(cornerRadius: 1)
                .fill(Theme.commandPurple.opacity(0.45))
                .frame(width: 7, height: 13)
                .frame(width: 12, height: 20)
        case .succeeded:
            Image(systemName: "checkmark")
                .font(Typography.caption(.semibold))
                .foregroundStyle(Color.white.opacity(0.55))
                .frame(width: 12, height: 20)
        case .failed:
            Circle()
                .fill(Color.red.opacity(0.85))
                .frame(width: 7, height: 7)
                .frame(width: 12, height: 20)
        }
    }

    @ViewBuilder
    private var trailingControl: some View {
        if status == .running || status == .waiting {
            Button(action: onStop) {
                Image(systemName: "stop.fill")
                    .font(Typography.caption(.bold))
                    .foregroundStyle(Color.white.opacity(0.85))
                    .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
                    .background(Circle().fill(Color.white.opacity(0.1)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Stop this command (Ctrl-C) — the shell stays open")
        } else if run.shellIsLive {
            Button(action: onEnd) {
                Image(systemName: "power")
                    .font(Typography.caption(.bold))
                    .foregroundStyle(Color.white.opacity(hovering ? 0.85 : 0.55))
                    .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("End this shell")
        } else {
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(Typography.caption(.bold))
                    .foregroundStyle(Color.white.opacity(hovering ? 0.8 : 0.45))
                    .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
    }
}
