import AppKit

// MARK: - Layout (pure — `SessionWindowStackTests`)

/// Where the session windows opened from the dispatch pill's child pills go (user, 2026-10-02): a
/// stack standing on the pill. The newest window sits at the BOTTOM, nearest the pill; every
/// window already open shrinks and moves up to make room for it, and grows back down when one
/// closes. When a column cannot take another window at `minHeight`, the next ones start a new
/// column beside it, the columns centred on the pill.
struct SessionWindowStackGeometry: Equatable {
    /// The screen's visible frame (Dock and menu bar excluded).
    var visibleFrame: CGRect
    /// The pill's horizontal centre — the stack's.
    var anchorMidX: CGFloat
    /// The stack's bottom edge: just above the pill and its row of child pills.
    var bottomY: CGFloat
    var width: CGFloat = 560
    /// A window's height when it stands alone (the old detached-window height).
    var maxHeight: CGFloat = 640
    /// The shortest a window in the stack gets before the stack starts a new column.
    var minHeight: CGFloat = 240
    var gap: CGFloat = 12
    var topMargin: CGFloat = 12

    /// The default geometry over a screen: centred on it (the pill is), standing on the pill and its
    /// child row with a little air.
    static func standing(on visibleFrame: CGRect) -> SessionWindowStackGeometry {
        let bottom = visibleFrame.minY + DispatchPillMetrics.dockGap + DispatchPillMetrics.pillHeight
            + DispatchPillMetrics.stackGap + DispatchPillMetrics.childRowHeight + 22
        return SessionWindowStackGeometry(visibleFrame: visibleFrame, anchorMidX: visibleFrame.midX, bottomY: bottom)
    }

    /// The height the stack may use.
    var availableHeight: CGFloat { max(minHeight, visibleFrame.maxY - topMargin - bottomY) }

    /// How many windows one column holds before the next column starts.
    var perColumn: Int { max(1, Int(((availableHeight + gap) / (minHeight + gap)).rounded(.down))) }
}

/// PURE: the frames of `count` stacked windows, OLDEST first. Column `c` holds members
/// `c*perColumn ..< (c+1)*perColumn`; within a column the newest stands at the bottom and every
/// window shares the column's height (never taller than `maxHeight`, never shorter than `minHeight`).
func sessionWindowStackFrames(count: Int, geometry g: SessionWindowStackGeometry) -> [CGRect] {
    guard count > 0 else { return [] }
    let perColumn = g.perColumn
    let columns = (count + perColumn - 1) / perColumn
    let totalWidth = CGFloat(columns) * g.width + CGFloat(columns - 1) * g.gap
    var firstX = (g.anchorMidX - totalWidth / 2).rounded()
    // Kept on screen: a stack too wide for it hugs the left edge (and overlaps past the right).
    firstX = min(max(firstX, g.visibleFrame.minX + g.gap), max(g.visibleFrame.minX + g.gap, g.visibleFrame.maxX - g.gap - totalWidth))
    var frames: [CGRect] = []
    for column in 0..<columns {
        let members = min(perColumn, count - column * perColumn)
        let height = min(g.maxHeight, max(g.minHeight, (g.availableHeight - g.gap * CGFloat(members - 1)) / CGFloat(members)))
        let x = firstX + CGFloat(column) * (g.width + g.gap)
        // Oldest at the top: member i (0 = oldest in this column) stands (members-1-i) slots up.
        for i in 0..<members {
            let slot = CGFloat(members - 1 - i)
            let y = g.bottomY + slot * (height + g.gap)
            frames.append(CGRect(x: x, y: y, width: g.width, height: height).integral)
        }
    }
    return frames
}

/// PURE: ease-out cubic, `t` in 0…1.
func sessionWindowStackEase(_ t: Double) -> Double {
    let c = min(max(t, 0), 1)
    return 1 - pow(1 - c, 3)
}

// MARK: - The stack

/// Owns the stack's membership and moves its windows. Frames are animated on a manual 60Hz timer —
/// never `NSAnimationContext`/`.animator()` on a frame (a recorded SIGBUS class in this codebase; the
/// orb's own zoom is animated the same way).
@MainActor
final class SessionWindowStack {
    static let animationDuration: CFTimeInterval = 0.32
    /// How far below its slot a new window starts as it rises in.
    static let entranceRise: CGFloat = 26

    private(set) var members: [DetachedWindowController] = []
    private var timer: Timer?
    private var startedAt: CFTimeInterval = 0
    private var moves: [(controller: DetachedWindowController, from: CGRect, to: CGRect, fadeIn: Bool)] = []
    /// Overrides the screen (tests).
    var visibleFrameOverride: CGRect?

    private var geometry: SessionWindowStackGeometry {
        let visible = visibleFrameOverride ?? NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return .standing(on: visible)
    }

    /// Where the next window goes — the bottom slot once it has joined.
    func frameForNewMember() -> CGRect {
        sessionWindowStackFrames(count: members.count + 1, geometry: geometry).last ?? .zero
    }

    /// A new window joins at the bottom; the others make room. It rises in from just below its slot.
    func add(_ controller: DetachedWindowController) {
        guard !members.contains(where: { $0 === controller }) else { return }
        members.append(controller)
        controller.stackMembership = self
        relayout(entering: controller)
    }

    /// A window leaves (closed, or the user moved or resized it): the rest close the gap.
    func remove(_ controller: DetachedWindowController) {
        guard members.contains(where: { $0 === controller }) else { return }
        members.removeAll { $0 === controller }
        moves.removeAll { $0.controller === controller }
        controller.stackMembership = nil
        relayout(entering: nil)
    }

    private func relayout(entering: DetachedWindowController?) {
        let targets = sessionWindowStackFrames(count: members.count, geometry: geometry)
        moves = zip(members, targets).map { member, target in
            if member === entering {
                let from = target.offsetBy(dx: 0, dy: -Self.entranceRise)
                member.setStackFrame(from)
                member.setStackAlpha(0)
                return (member, from, target, true)
            }
            return (member, member.currentFrame, target, false)
        }
        startedAt = CACurrentMediaTime()
        if timer == nil {
            let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
        tick()
    }

    private func tick() {
        let p = sessionWindowStackEase((CACurrentMediaTime() - startedAt) / Self.animationDuration)
        for move in moves {
            let f = move.from, t = move.to
            let frame = CGRect(x: f.minX + (t.minX - f.minX) * p, y: f.minY + (t.minY - f.minY) * p,
                               width: f.width + (t.width - f.width) * p, height: f.height + (t.height - f.height) * p)
            move.controller.setStackFrame(p >= 1 ? t : frame)
            if move.fadeIn { move.controller.setStackAlpha(CGFloat(p)) }
        }
        if p >= 1 {
            timer?.invalidate()
            timer = nil
            moves = []
        }
    }

    /// Settles every move at once (tests).
    func finishForTesting() {
        startedAt = -.greatestFiniteMagnitude
        tick()
    }
}
