import SwiftUI

// MARK: - The pills a command spawns above the main pill
//
// Both float in the same stack as the child-session row (`DispatchPillAccessories`), BELOW it: the
// spawned sessions stay on top, and these sit between them and the main pill. Same shape language as
// a child pill — a black capsule at the main pill's height with the faint white rim.

/// `/permissions`: the approval modes Dispatch can hold, as chips in one capsule. Picking one sets it
/// (`DispatchPillController.choosePolicy`); × closes the pill without changing anything.
struct DispatchPillPermissionsPill: View {
    let modes: [String]
    /// The session's current mode, or nil while it is not known (no chip is marked then).
    let current: String?
    /// The mode being set right now — its chip dims until the daemon answers.
    let pending: String?
    /// The last refusal, as `policyRefusalText` words it — shown in place of the chips.
    let refusal: String?
    let onPick: (String) -> Void
    let onClose: () -> Void

    @State private var hovered: String?

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "hand.raised")
                .font(Typography.caption(.semibold))
                .foregroundStyle(Color.white.opacity(0.55))
                .padding(.trailing, 6)
                .help("Permissions — how Dispatch handles actions that need your OK")
            if let refusal {
                Text(refusal)
                    .font(Typography.label(.medium))
                    .foregroundStyle(Color.orange)
                    .lineLimit(1)
                    .padding(.trailing, 8)
            } else {
                ForEach(modes, id: \.self) { chip($0) }
            }
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(Typography.caption(.bold))
                    .foregroundStyle(Color.white.opacity(0.8))
                    .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
                    .background(Circle().fill(Color.white.opacity(0.1)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 4)
            .help("Close")
        }
        .padding(.leading, 14)
        .padding(.trailing, DispatchPillMetrics.trailingPadding)
        .frame(height: DispatchPillMetrics.pillHeight)
        .background(Capsule().fill(Color.black))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
        .fixedSize()
        .animation(.easeOut(duration: 0.15), value: hovered)
        .animation(.easeOut(duration: 0.2), value: current)
    }

    private func chip(_ mode: String) -> some View {
        let selected = mode == current
        let dimmed = pending != nil && pending != mode
        return Button { onPick(mode) } label: {
            Text(policyDisplayLabel(mode))
                .font(Typography.label(.medium))
                .foregroundStyle(selected ? (isPolicyDangerous(mode) ? Color.red : Color.white) : Color.white.opacity(0.62))
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(Capsule().fill(Color.white.opacity(selected ? 0.16 : hovered == mode ? 0.08 : 0)))
                .contentShape(Capsule())
                .opacity(pending == mode ? 0.5 : dimmed ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        .disabled(pending != nil)
        .onHover { hovered = $0 ? mode : (hovered == mode ? nil : hovered) }
        .help(selected ? "\(policyDisplayLabel(mode)) — current" : "Switch Dispatch to \(policyDisplayLabel(mode))")
    }
}

/// A compaction running: what it is and how long it has been going — no progress, which nothing can
/// honestly report (`OrbSessionState.compactionStartedAt` is the clock's start, off the event that
/// began it).
struct DispatchPillCompactionPill: View {
    let startedAtMs: Int
    let width: CGFloat

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let elapsed = Int((context.date.timeIntervalSince1970 * 1000 - Double(startedAtMs)) / 1000)
            HStack(spacing: 8) {
                Image(systemName: "rectangle.compress.vertical")
                    .font(Typography.caption(.semibold))
                    .foregroundStyle(Color.white.opacity(0.7))
                Text("Compacting conversation")
                    .font(Typography.label(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 8)
                Text(dispatchPillElapsedText(seconds: elapsed))
                    .font(Typography.label(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Color.white.opacity(0.7))
            }
            .padding(.horizontal, 16)
            .frame(width: width, height: DispatchPillMetrics.pillHeight)
            .background(Capsule().fill(Color.black))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
            .help("The conversation is being summarized")
        }
    }
}

/// A command's short answer, floating above the pill for a few seconds (`DispatchPillController.commandNotice`).
struct DispatchPillNoticePill: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle")
                .font(Typography.caption(.semibold))
                .foregroundStyle(Color.white.opacity(0.7))
            Text(text)
                .font(Typography.label(.medium))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
        }
        .padding(.horizontal, 16)
        .frame(height: DispatchPillMetrics.pillHeight)
        .background(Capsule().fill(Color.black))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
        .fixedSize()
    }
}
