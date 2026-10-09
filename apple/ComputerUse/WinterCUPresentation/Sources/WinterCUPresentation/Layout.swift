import CoreGraphics

// Pure geometry: where a mirror goes, when it docks, how two of them stack. Everything here works in
// global screen points with a TOP-LEFT origin (the window server's space, the one `CGWindowListCopyWindowInfo`
// and the helper RPC use). AppKit's bottom-left space appears only at the edge, in `QuartzSpace`.

/// One display, in top-left global points. `visibleFrame` excludes the menu bar and the Dock.
struct ScreenInfo: Equatable, Sendable {
    var frame: CGRect
    var visibleFrame: CGRect
}

enum QuartzSpace {
    /// Converts between AppKit (bottom-left origin, y up) and the window server (top-left origin, y down). The flip is its
    /// own inverse; `primaryHeight` is the height of the screen whose AppKit origin is (0, 0).
    static func flip(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// What the mirror can know about its window right now.
struct WindowSnapshot: Equatable, Sendable {
    /// Top-left global points.
    var frame: CGRect
    /// The window server's on-screen flag: false for minimized windows and windows on another Space.
    var isOnScreen: Bool
}

enum WindowPresence: Equatable {
    /// On the current Space and showing on some screen.
    case visible(CGRect)
    /// Minimized, on another Space, off every screen, or gone. Carries the last frame we know, if any.
    case hidden(lastFrame: CGRect?)

    var isVisible: Bool {
        if case .visible = self { return true }
        return false
    }

    var frame: CGRect? {
        switch self {
        case .visible(let f): return f
        case .hidden(let f): return f
        }
    }
}

enum WindowVisibility {
    static func classify(_ snapshot: WindowSnapshot?, screens: [ScreenInfo], minVisibleArea: CGFloat) -> WindowPresence {
        guard let snapshot else { return .hidden(lastFrame: nil) }
        let frame = snapshot.frame
        guard snapshot.isOnScreen, frame.width > 0, frame.height > 0 else { return .hidden(lastFrame: frame) }
        let shown = screens.reduce(CGFloat(0)) { sum, screen in
            let i = frame.intersection(screen.frame)
            return i.isNull ? sum : sum + i.width * i.height
        }
        return shown >= minVisibleArea ? .visible(frame) : .hidden(lastFrame: frame)
    }
}

enum ScreenCorner: Equatable, Sendable {
    case topLeft, topRight, bottomLeft, bottomRight

    var isTop: Bool { self == .topLeft || self == .topRight }
    var isLeft: Bool { self == .topLeft || self == .bottomLeft }
}

enum MirrorLayout {
    /// The live image's size for a window of `windowSize`: `mirrorContentWidth` wide at the window's aspect, narrower for
    /// tall windows (never taller than `mirrorMaxContentHeight`), letterboxed for very wide ones.
    static func contentSize(forWindow windowSize: CGSize?, tuning: PresentationTuning) -> CGSize {
        var size = windowSize ?? tuning.defaultWindowSize
        if size.width <= 0 || size.height <= 0 { size = tuning.defaultWindowSize }
        let aspect = size.width / size.height
        var width = tuning.mirrorContentWidth
        var height = width / aspect
        if height > tuning.mirrorMaxContentHeight {
            height = tuning.mirrorMaxContentHeight
            width = max(tuning.mirrorMinContentWidth, height * aspect)
        } else if height < tuning.mirrorMinContentHeight {
            height = tuning.mirrorMinContentHeight
        }
        return CGSize(width: width.rounded(), height: height.rounded())
    }

    static func panelSize(content: CGSize, tuning: PresentationTuning) -> CGSize {
        CGSize(width: content.width + 2 * tuning.mirrorPadding,
               height: content.height + 2 * tuning.mirrorPadding + tuning.mirrorCaptionHeight)
    }

    /// The screen a rect belongs to: the one it overlaps most, else the one nearest its centre, else the first.
    static func screen(for rect: CGRect, in screens: [ScreenInfo]) -> ScreenInfo? {
        var best: (ScreenInfo, CGFloat)?
        for screen in screens {
            let i = rect.intersection(screen.frame)
            let area = i.isNull ? 0 : i.width * i.height
            if area > 0, area > (best?.1 ?? 0) { best = (screen, area) }
        }
        if let best { return best.0 }
        let centre = CGPoint(x: rect.midX, y: rect.midY)
        return screens.min { distance(centre, $0.frame) < distance(centre, $1.frame) }
    }

    /// The panel's frame over a visible window: its top-left on the window's top-left (over the traffic lights), kept
    /// inside the visible part of the window's screen.
    static func anchoredFrame(windowFrame: CGRect, panelSize: CGSize, screens: [ScreenInfo], tuning: PresentationTuning) -> CGRect {
        var origin = CGPoint(x: windowFrame.minX + tuning.anchorInset, y: windowFrame.minY + tuning.anchorInset)
        if let bounds = screen(for: windowFrame, in: screens)?.visibleFrame.insetBy(dx: tuning.screenMargin, dy: tuning.screenMargin) {
            origin.x = clamp(origin.x, bounds.minX, bounds.maxX - panelSize.width)
            origin.y = clamp(origin.y, bounds.minY, bounds.maxY - panelSize.height)
        }
        return CGRect(origin: origin, size: panelSize)
    }

    /// The corner of `area` nearest to `point`.
    static func nearestCorner(to point: CGPoint, in area: CGRect) -> ScreenCorner {
        let left = point.x < area.midX
        let top = point.y < area.midY
        switch (top, left) {
        case (true, true): return .topLeft
        case (true, false): return .topRight
        case (false, true): return .bottomLeft
        case (false, false): return .bottomRight
        }
    }

    /// Panels docked in one corner, newest first: the newest sits in the corner, older ones stack away from it along
    /// the screen edge (downward from a top corner, upward from a bottom one).
    static func dockedFrames(panelSizes: [CGSize], corner: ScreenCorner, visibleFrame: CGRect, tuning: PresentationTuning) -> [CGRect] {
        let area = visibleFrame.insetBy(dx: tuning.screenMargin, dy: tuning.screenMargin)
        var frames: [CGRect] = []
        var offset: CGFloat = 0
        for size in panelSizes {
            let x = corner.isLeft ? area.minX : area.maxX - size.width
            let y = corner.isTop ? area.minY + offset : area.maxY - size.height - offset
            frames.append(CGRect(x: x, y: y, width: size.width, height: size.height))
            offset += size.height + tuning.stackGap
        }
        return frames
    }

    struct Request: Equatable {
        var presence: WindowPresence
        var panelSize: CGSize
    }

    /// Frames for the mirrors on screen, given newest first (the caller has already capped the list). A visible window
    /// gets its anchored frame; hidden ones dock in the corner nearest their last frame and stack with any other mirror
    /// docked in that same corner. The newest is ordered on top by the caller.
    static func frames(for requests: [Request], screens: [ScreenInfo], tuning: PresentationTuning) -> [CGRect] {
        var result = [CGRect](repeating: .zero, count: requests.count)
        var docks: [(screen: ScreenInfo, corner: ScreenCorner, indices: [Int])] = []
        for (index, request) in requests.enumerated() {
            switch request.presence {
            case .visible(let frame):
                result[index] = anchoredFrame(windowFrame: frame, panelSize: request.panelSize, screens: screens, tuning: tuning)
            case .hidden(let lastFrame):
                guard let (screen, corner) = dock(for: lastFrame, screens: screens) else {
                    result[index] = CGRect(origin: .zero, size: request.panelSize)
                    continue
                }
                if let slot = docks.firstIndex(where: { $0.screen == screen && $0.corner == corner }) {
                    docks[slot].indices.append(index)
                } else {
                    docks.append((screen, corner, [index]))
                }
            }
        }
        for dock in docks {
            let sizes = dock.indices.map { requests[$0].panelSize }
            let frames = dockedFrames(panelSizes: sizes, corner: dock.corner, visibleFrame: dock.screen.visibleFrame, tuning: tuning)
            for (i, index) in dock.indices.enumerated() { result[index] = frames[i] }
        }
        return result
    }

    /// Where a hidden window's mirror docks: the corner nearest the window's last centre on its screen; with no frame
    /// known, the top-right of the first (main) screen.
    static func dock(for lastFrame: CGRect?, screens: [ScreenInfo]) -> (ScreenInfo, ScreenCorner)? {
        guard let lastFrame, lastFrame.width > 0, lastFrame.height > 0 else {
            return screens.first.map { ($0, .topRight) }
        }
        guard let screen = screen(for: lastFrame, in: screens) else { return nil }
        let corner = nearestCorner(to: CGPoint(x: lastFrame.midX, y: lastFrame.midY), in: screen.visibleFrame)
        return (screen, corner)
    }

    /// `point` as a fraction (0…1 on each axis) of the window frame, for drawing the cursor inside a mirror.
    static func fraction(of point: CGPoint, in windowFrame: CGRect) -> CGPoint {
        guard windowFrame.width > 0, windowFrame.height > 0 else { return CGPoint(x: 0.5, y: 0.5) }
        return CGPoint(x: clamp((point.x - windowFrame.minX) / windowFrame.width, 0, 1),
                       y: clamp((point.y - windowFrame.minY) / windowFrame.height, 0, 1))
    }

    /// A fraction mapped into a rect (top-left origin), the inverse of `fraction(of:in:)`.
    static func point(atFraction f: CGPoint, in rect: CGRect) -> CGPoint {
        CGPoint(x: rect.minX + f.x * rect.width, y: rect.minY + f.y * rect.height)
    }

    /// The largest rect of `aspect` (width / height) centred in `bounds`: where the live image is drawn in the mirror.
    static func aspectFit(aspect: CGFloat, in bounds: CGRect) -> CGRect {
        guard aspect > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        if bounds.width / bounds.height > aspect {
            let w = bounds.height * aspect
            return CGRect(x: bounds.midX - w / 2, y: bounds.minY, width: w, height: bounds.height)
        }
        let h = bounds.width / aspect
        return CGRect(x: bounds.minX, y: bounds.midY - h / 2, width: bounds.width, height: h)
    }

    static func clamp(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
        hi < lo ? lo : min(max(v, lo), hi)
    }

    private static func distance(_ p: CGPoint, _ r: CGRect) -> CGFloat {
        let dx = max(r.minX - p.x, 0, p.x - r.maxX)
        let dy = max(r.minY - p.y, 0, p.y - r.maxY)
        return (dx * dx + dy * dy).squareRoot()
    }
}
