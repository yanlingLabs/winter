import CoreGraphics
import Foundation

/// ComputerV2 Phase 4 (lane H3) — **the headless presentation's geometry**, pure: where the page sits in the panel's
/// view (aspect-fit, letterboxed, centred), how a point in the view becomes a CSS pixel of the page and back, the
/// render scale to ask the producer for, and a wheel event's deltas.
///
/// Every coordinate here is TOP-LEFT origin, y down — the presentation view is flipped, and CSS pixels are the page's
/// own coordinates (CEF's `CefMouseEvent`, the IME's character rects). The page's CSS size is the producer's
/// welcome (Winter Headless renders a fixed 1280×800 view).
enum HeadlessPresentGeometry {

    /// Where a page of `content` CSS pixels is drawn inside `bounds` (view points): the largest rect with the page's
    /// aspect that fits, centred. Empty when either size is empty.
    static func fitRect(content: CGSize, in bounds: CGSize) -> CGRect {
        guard content.width > 0, content.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
        let scale = min(bounds.width / content.width, bounds.height / content.height)
        let size = CGSize(width: content.width * scale, height: content.height * scale)
        return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
                      width: size.width, height: size.height)
    }

    /// View points per CSS pixel for `fit` (0 when nothing is drawn).
    static func fitScale(fit: CGRect, content: CGSize) -> CGFloat {
        guard content.width > 0, fit.width > 0 else { return 0 }
        return fit.width / content.width
    }

    /// The CSS pixel under `point` (view points), or nil when the point is outside the page (the letterbox) —
    /// unless `clamp`, which pins it to the page's edge (a drag that started on the page keeps reaching it).
    static func cssPoint(_ point: CGPoint, fit: CGRect, content: CGSize, clamp: Bool = false) -> CGPoint? {
        let scale = fitScale(fit: fit, content: content)
        guard scale > 0 else { return nil }
        var x = (point.x - fit.minX) / scale
        var y = (point.y - fit.minY) / scale
        if clamp {
            x = min(max(x, 0), content.width - 1)
            y = min(max(y, 0), content.height - 1)
        } else if x < 0 || y < 0 || x >= content.width || y >= content.height {
            return nil
        }
        return CGPoint(x: x.rounded(.down), y: y.rounded(.down))
    }

    /// A rect of CSS pixels (an IME character's bounds) in view points.
    static func viewRect(_ css: CGRect, fit: CGRect, content: CGSize) -> CGRect {
        let scale = fitScale(fit: fit, content: content)
        return CGRect(x: fit.minX + css.minX * scale, y: fit.minY + css.minY * scale,
                      width: css.width * scale, height: css.height * scale)
    }

    /// The producer renders between these scales (device pixels per CSS pixel).
    static let minScale = 1.0
    static let maxScale = 4.0
    /// Scales are asked for in steps of this, so a live resize does not ask for a new pool generation per frame.
    static let scaleStep = 0.25

    /// The render scale to ask the producer for: device pixels per CSS pixel on screen — the fit scale times the
    /// display's backing scale — rounded UP to a `scaleStep` (never blurrier than the screen), clamped to
    /// [`minScale`, `maxScale`].
    static func renderScale(fitScale: Double, backingScale: Double) -> Double {
        let wanted = fitScale * backingScale
        guard wanted.isFinite, wanted > 0 else { return minScale }
        let stepped = (wanted / scaleStep - 1e-9).rounded(.up) * scaleStep
        return min(max(stepped, minScale), maxScale)
    }

    /// How a wheel line becomes CSS pixels (a mouse wheel's notch, as Chromium counts it).
    static let pixelsPerLine = 40.0

    /// A scroll event's deltas in CSS pixels, signed as CEF wants them (positive y scrolls up, as the event's own
    /// `scrollingDeltaY` is). PRECISE deltas (a trackpad, a Magic Mouse) are view points: divided by the fit scale,
    /// the page moves under the fingers exactly as far as they moved. LINE deltas (a notched wheel) are lines.
    static func wheelDelta(dx: Double, dy: Double, precise: Bool, fitScale: Double) -> (dx: Int32, dy: Int32) {
        func clampToInt32(_ v: Double) -> Int32 {
            guard v.isFinite else { return 0 }
            return Int32(min(max(v.rounded(), -1_000_000), 1_000_000))
        }
        if precise {
            let scale = fitScale > 0 ? fitScale : 1
            return (clampToInt32(dx / scale), clampToInt32(dy / scale))
        }
        return (clampToInt32(dx * pixelsPerLine), clampToInt32(dy * pixelsPerLine))
    }

    /// The IME's character rect (CSS pixels, one per composed character) for an NSTextInputClient range: `location`
    /// counted inside the composition when it is at or past the composition's start (as cefclient does), else the
    /// first character. nil when there is none to show.
    static func compositionRect(location: Int, compositionStart: Int, rects: [CGRect]) -> CGRect? {
        guard !rects.isEmpty else { return nil }
        var index = location
        if location == NSNotFound { index = 0 } else if location >= compositionStart { index = location - compositionStart }
        if index < 0 { index = 0 }
        if index >= rects.count {
            // Past the last character: a caret just after it.
            let last = rects[rects.count - 1]
            return CGRect(x: last.maxX, y: last.minY, width: 0, height: last.height)
        }
        return rects[index]
    }
}
