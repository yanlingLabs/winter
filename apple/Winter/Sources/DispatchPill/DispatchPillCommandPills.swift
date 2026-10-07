import AppKit
import SwiftUI

// MARK: - What the pill's commands show
//
// The `/` menu, the compaction clock and a command's notice float in the same stack as the child-session
// row (`DispatchPillAccessories`), BELOW it: the spawned sessions stay on top. `/permissions` floats
// nothing — `DispatchPillPermissionsRow` is drawn inside the main pill, which morphs to hold it. Same
// shape language as a child pill: black, the main pill's height or corner radius, the faint white rim.

/// The blue the `/` menu marks its closest match with, and the composer draws a fully typed command in.
let dispatchPillCommandBlue = Color(red: 0.42, green: 0.64, blue: 1.0)
let dispatchPillCommandBlueNS = NSColor(red: 0.42, green: 0.64, blue: 1.0, alpha: 1)
/// The closest match's row fill in the `/` menu.
let dispatchPillCommandMatchFill = Color(red: 0.20, green: 0.42, blue: 0.95).opacity(0.42)

/// `/permissions`: the approval modes Dispatch can hold, as chips — drawn INSIDE the main pill, which
/// morphs to `permissionsPickerWidth` to hold them (`DispatchPillController.permissionsPickerOpen`).
/// Picking one sets it (`choosePolicy`); × (or Esc) morphs the pill back into the composer.
struct DispatchPillPermissionsRow: View {
    let modes: [String]
    /// The session's current mode, or nil while it is not known (no chip is marked then).
    let current: String?
    /// The mode being set right now — its chip dims until the daemon answers.
    let pending: String?
    /// The last refusal, as `policyRefusalText` words it — shown in place of the chips.
    let refusal: String?
    /// The chip the keyboard is on (←/→ or ↑/↓, then Enter) — on the menus' blue fill.
    var focused: String? = nil
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
            Spacer(minLength: 4)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(Typography.caption(.bold))
                    .foregroundStyle(Color.white.opacity(0.8))
                    .frame(width: DispatchPillMetrics.sendCircleSize, height: DispatchPillMetrics.sendCircleSize)
                    .background(Circle().fill(Color.white.opacity(0.1)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("Back (Esc)")
        }
        .padding(.leading, 14)
        .padding(.trailing, DispatchPillMetrics.trailingPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeOut(duration: 0.15), value: hovered)
        .animation(.easeOut(duration: 0.2), value: current)
        .animation(.easeOut(duration: 0.12), value: focused)
    }

    private func chipFill(_ mode: String, selected: Bool) -> Color {
        if focused == mode { return dispatchPillCommandMatchFill }
        return Color.white.opacity(selected ? 0.16 : hovered == mode ? 0.08 : 0)
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
                .background(Capsule().fill(chipFill(mode, selected: selected)))
                .contentShape(Capsule())
                .opacity(pending == mode ? 0.5 : dimmed ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        .disabled(pending != nil)
        .onHover { hovered = $0 ? mode : (hovered == mode ? nil : hovered) }
        .help(selected ? "\(policyDisplayLabel(mode)) — current" : "Switch Dispatch to \(policyDisplayLabel(mode))")
    }
}

/// A `/` menu — the commands while one is being typed, the approval modes after `/permissions ` — in a
/// rounded rectangle the main pill's width and corner radius, right above it. Rows matching what is
/// typed stay bright (the matched letters in full white), the rest fade; the marked row — the one the
/// ↑/↓ keys moved to, else the closest match, the one Enter completes to — sits on a blue fill. The mode
/// in effect says "current". A click on a row runs it.
struct DispatchPillMenuView: View {
    let menu: DispatchPillMenu
    /// The row the arrows moved to, or nil (the closest match is marked).
    let selected: String?
    let width: CGFloat
    let onPick: (String) -> Void

    @State private var hovered: String?

    private var marked: String? { selected.flatMap { menu.matches.contains($0) ? $0 : nil } ?? menu.best }

    var body: some View {
        let radius = DispatchPillMetrics.maxCornerRadius
        let inset = DispatchPillMetrics.commandMenuInset
        VStack(spacing: 0) {
            ForEach(menu.items, id: \.id) { item in
                row(item, rowRadius: radius - inset)
            }
        }
        .padding(inset)
        .frame(width: width)
        .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color.black))
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.white.opacity(0.09), lineWidth: 1))
        .animation(.easeOut(duration: 0.12), value: menu)
        .animation(.easeOut(duration: 0.12), value: marked)
        .animation(.easeOut(duration: 0.12), value: hovered)
    }

    private func row(_ item: DispatchPillMenuItem, rowRadius: CGFloat) -> some View {
        let matching = menu.matches.contains(item.id)
        let isMarked = marked == item.id
        return Button { onPick(item.id) } label: {
            HStack(spacing: 10) {
                title(item.title, matching: matching)
                    .font(Typography.label(.semibold))
                Text(item.summary)
                    .font(Typography.label())
                    .foregroundStyle(Color.white.opacity(matching ? 0.55 : 0.3))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                if menu.current == item.id {
                    Text("current")
                        .font(Typography.caption(.medium))
                        .foregroundStyle(Color.white.opacity(0.5))
                }
                if isMarked {
                    Image(systemName: "return")
                        .font(Typography.caption(.semibold))
                        .foregroundStyle(Color.white.opacity(0.6))
                        .help("Enter")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: DispatchPillMetrics.commandRowHeight)
            .background(RoundedRectangle(cornerRadius: rowRadius, style: .continuous)
                .fill(isMarked ? dispatchPillCommandMatchFill : Color.white.opacity(hovered == item.id ? 0.07 : 0)))
            .contentShape(RoundedRectangle(cornerRadius: rowRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 ? item.id : (hovered == item.id ? nil : hovered) }
    }

    /// The row's title with the typed letters in full white and the rest softer — or all faded when the
    /// row does not match.
    private func title(_ title: String, matching: Bool) -> Text {
        let query = menu.query
        guard matching, !query.isEmpty, let r = title.lowercased().range(of: query) else {
            return Text(title).foregroundColor(Color.white.opacity(matching ? 0.85 : 0.35))
        }
        // `r` indexes the lowercased copy; the title has the same characters, so map by offset.
        let lower = title.lowercased()
        let start = lower.distance(from: lower.startIndex, to: r.lowerBound)
        let length = lower.distance(from: r.lowerBound, to: r.upperBound)
        let a = title.index(title.startIndex, offsetBy: start)
        let b = title.index(a, offsetBy: length)
        func run(_ text: Substring, _ color: Color) -> AttributedString {
            var piece = AttributedString(String(text))
            piece.foregroundColor = color
            return piece
        }
        return Text(run(title[..<a], Color.white.opacity(0.6)) + run(title[a..<b], Color.white) + run(title[b...], Color.white.opacity(0.6)))
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
                    .font(Typography.labelMono(.medium)) // fixed-width, so the ticking seconds never jitter
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
