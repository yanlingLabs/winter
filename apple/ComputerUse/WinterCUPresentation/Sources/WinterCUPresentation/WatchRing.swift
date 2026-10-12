import CoreGraphics
import Foundation

// WAKE TRIGGERS, what the user SEES while Winter waits on them in an app (the spine's "visible while armed"): a ring
// around the watched element and a small pill — "Winter continues when you click “Send”" — drawn only while the bound
// window is frontmost on the active Space (the engine decides that). Click-through, never key, never activating, never
// in a capture. The pill's sentence is FIXED per kind and names only the element's own label: never the model's note,
// never the text it waits for.

/// One watch to draw. Frames are in screen points, top-left origin (the engine's `CUWatchShown`, restated: this package
/// does not import the engine).
public struct CUWatchRing: Sendable, Equatable {
    public let watchId: String
    /// `clicked`, `changed`, `gone`, `appeared`, `titled`.
    public let kind: String
    /// The element's own label (its accessible name, else its role words); nil for the window-wide kinds.
    public let label: String?
    /// The element (the ring); nil for the window-wide kinds — then only the pill, at the window's top.
    public let elementFrame: CGRect?
    public let windowFrame: CGRect

    public init(watchId: String, kind: String, label: String?, elementFrame: CGRect?, windowFrame: CGRect) {
        self.watchId = watchId
        self.kind = kind
        self.label = label
        self.elementFrame = elementFrame
        self.windowFrame = windowFrame
    }
}

/// Shows the rings. The shell hands it the whole list each time.
@MainActor public protocol CUWatchRingPresenting: AnyObject {
    /// Every watch to draw now; an empty list removes them all.
    func show(_ rings: [CUWatchRing])
}

/// The ring and the pill, worded and placed. Pure.
public enum CUWatchRingModel {
    public static let labelMax = 60
    /// The ring's gap around the element, and its corner radius.
    public static let ringInset: CGFloat = 4
    public static let ringRadius: CGFloat = 7
    public static let pillHeight: CGFloat = 26
    public static let pillMaxWidth: CGFloat = 420
    public static let pillGap: CGFloat = 6

    /// The pill's fixed sentence for `kind`, naming only the element's own label (one sanitized line).
    public static func sentence(kind: String, label: String?) -> String {
        let name = CUDesktopPromptModel.sanitize(label ?? "", max: labelMax)
        let quoted = name.isEmpty ? "this" : "\u{201C}\(name)\u{201D}"
        switch kind {
        case "clicked": return "Winter continues when you click \(quoted)"
        case "changed": return "Winter continues when you change \(quoted)"
        case "gone" where label != nil: return "Winter continues when \(quoted) goes away"
        case "titled": return "Winter continues when this window\u{2019}s title changes"
        default: return "Winter continues when this window changes"
        }
    }

    /// The ring around the element, clipped to the window (nil: no element, or none of it is in the window).
    public static func ringFrame(element: CGRect?, window: CGRect) -> CGRect? {
        guard let element, element.width > 0 || element.height > 0 else { return nil }
        let visible = element.intersection(window)
        guard !visible.isNull, visible.width > 0, visible.height > 0 else { return nil }
        return visible.insetBy(dx: -ringInset, dy: -ringInset)
    }

    /// Where the pill goes, `width` wide: centred under the ring when it fits inside the window, else above it; with no
    /// ring, at the window's top centre (just under its title bar).
    public static func pillFrame(ring: CGRect?, window: CGRect, width: CGFloat) -> CGRect {
        let w = min(width, pillMaxWidth, max(120, window.width - 16))
        let h = pillHeight
        func clampX(_ x: CGFloat) -> CGFloat { min(max(x, window.minX + 8), window.maxX - w - 8) }
        guard let ring else {
            return CGRect(x: clampX(window.midX - w / 2), y: window.minY + 34, width: w, height: h)
        }
        let below = ring.maxY + pillGap
        let y = below + h <= window.maxY - 4 ? below : max(window.minY + 4, ring.minY - pillGap - h)
        return CGRect(x: clampX(ring.midX - w / 2), y: y, width: w, height: h)
    }
}

/// One drawn watch: its ring (when it has one) and its pill.
@MainActor protocol WatchRingSurface: AnyObject {
    /// Places (or moves) both; `ring` nil hides the ring and keeps the pill.
    func place(ring: CGRect?, pill: CGRect, sentence: String)
    func close()
    /// The pill's width for this sentence (its text measured).
    func pillWidth(for sentence: String) -> CGFloat
}

@MainActor protocol WatchRingSurfaceFactory {
    func make() -> WatchRingSurface
}

/// The live rings: one surface per watch, replaced as the list changes, closed when a watch leaves it.
@MainActor public final class CUWatchRingController: CUWatchRingPresenting {
    private let surfaces: WatchRingSurfaceFactory
    private var live: [String: (surface: WatchRingSurface, ring: CUWatchRing)] = [:]

    init(surfaces: WatchRingSurfaceFactory) {
        self.surfaces = surfaces
    }

    /// The live controller: AppKit panels. Draws nothing until `show` gives it a ring.
    public static func live() -> CUWatchRingController {
        CUWatchRingController(surfaces: AppKitWatchRingFactory())
    }

    /// The watches drawn now.
    public var shownIds: [String] { live.keys.sorted() }

    public func show(_ rings: [CUWatchRing]) {
        let wanted = Set(rings.map(\.watchId))
        for (id, entry) in live where !wanted.contains(id) {
            entry.surface.close()
            live[id] = nil
            PresentationLog.notice("watch ring \(id): hidden")
        }
        for r in rings {
            if let entry = live[r.watchId], entry.ring == r { continue }
            let surface = live[r.watchId]?.surface ?? surfaces.make()
            if live[r.watchId] == nil { PresentationLog.notice("watch ring \(r.watchId): shown (\(r.kind))") }
            let sentence = CUWatchRingModel.sentence(kind: r.kind, label: r.label)
            let ring = CUWatchRingModel.ringFrame(element: r.elementFrame, window: r.windowFrame)
            let pill = CUWatchRingModel.pillFrame(ring: ring, window: r.windowFrame, width: surface.pillWidth(for: sentence))
            surface.place(ring: ring, pill: pill, sentence: sentence)
            live[r.watchId] = (surface, r)
        }
    }
}
