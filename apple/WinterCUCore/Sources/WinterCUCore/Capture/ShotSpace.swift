import CoreGraphics
import Foundation

/// The coordinate space of one screenshot, named by its `shotId`. A `Point` action carries pixels in that
/// image; this maps them back to screen points (top-left origin).
///
/// A window shot is stored window-relative, so a click still lands on the same control after the window
/// has moved: the window's current origin is added at action time.
public struct CUShotSpace: Sendable, Equatable {
    public enum Anchor: Sendable, Equatable {
        /// `regionOrigin` is the captured region's top-left inside the window, in points.
        case window(windowID: UInt32, regionOrigin: CGPoint)
        /// `origin` is the captured area's top-left in global screen points.
        case screen(origin: CGPoint)
    }

    public let id: String
    public let anchor: Anchor
    /// Image size in pixels.
    public let imageWidth: Int
    public let imageHeight: Int
    /// Size of the captured area in points.
    public let pointsWidth: Double
    public let pointsHeight: Double

    public init(id: String, anchor: Anchor, imageWidth: Int, imageHeight: Int, pointsWidth: Double, pointsHeight: Double) {
        self.id = id
        self.anchor = anchor
        self.imageWidth = max(1, imageWidth)
        self.imageHeight = max(1, imageHeight)
        self.pointsWidth = pointsWidth
        self.pointsHeight = pointsHeight
    }

    /// Image pixels → points within the captured area (window-relative for window shots).
    public func localPoint(pixel: CGPoint) throws -> CGPoint {
        guard pixel.x.isFinite, pixel.y.isFinite,
              pixel.x >= 0, pixel.y >= 0,
              pixel.x <= Double(imageWidth), pixel.y <= Double(imageHeight)
        else {
            // A common mistake is window POINTS (or a 2× pixel value) instead of this image's pixels.
            let looksPoints = pixel.x <= pointsWidth + 1 && pixel.y <= pointsHeight + 1
                && (pixel.x > Double(imageWidth) || pixel.y > Double(imageHeight))
            let looks2x = pixel.x <= Double(imageWidth) * 2 + 1 && pixel.y <= Double(imageHeight) * 2 + 1
                && (pixel.x > Double(imageWidth) || pixel.y > Double(imageHeight))
            let hint = looksPoints ? " — that looks like window points (\(fmt(pointsWidth))×\(fmt(pointsHeight))); use this image's pixels"
                : looks2x ? " — that looks like a 2× (Retina) value; use this image's pixels, not the backing size"
                : ""
            throw CUError.invalidParams(
                "point [\(fmt(pixel.x)), \(fmt(pixel.y))] is outside screenshot \(id); valid x 0–\(imageWidth), y 0–\(imageHeight) px (window \(fmt(pointsWidth))×\(fmt(pointsHeight)) pt)\(hint)")
        }
        let x = pixel.x * pointsWidth / Double(imageWidth)
        let y = pixel.y * pointsHeight / Double(imageHeight)
        switch anchor {
        case .window(_, let origin): return CGPoint(x: origin.x + x, y: origin.y + y)
        case .screen: return CGPoint(x: x, y: y)
        }
    }

    /// Image pixels → global screen points. A window shot needs the window's current origin.
    public func screenPoint(pixel: CGPoint, windowOrigin: CGPoint? = nil) throws -> CGPoint {
        let local = try localPoint(pixel: pixel)
        switch anchor {
        case .window:
            guard let o = windowOrigin else {
                throw CUError.invalidParams("screenshot \(id) belongs to a window whose position is unknown")
            }
            return CGPoint(x: o.x + local.x, y: o.y + local.y)
        case .screen(let origin):
            return CGPoint(x: origin.x + local.x, y: origin.y + local.y)
        }
    }

    private func fmt(_ v: Double) -> String { v.rounded() == v ? String(Int(v)) : String(v) }
}

/// Parses a `[x, y]` wire point.
func cuPoint(_ a: [Double]?, _ what: String = "point") throws -> CGPoint? {
    guard let a else { return nil }
    guard a.count == 2, a.allSatisfy(\.isFinite) else { throw CUError.invalidParams("\(what) must be [x, y]") }
    return CGPoint(x: a[0], y: a[1])
}

/// Parses an `[x, y, w, h]` wire rect.
func cuRect(_ a: [Double]?, _ what: String = "region") throws -> CGRect? {
    guard let a else { return nil }
    guard a.count == 4, a.allSatisfy(\.isFinite), a[2] > 0, a[3] > 0 else {
        throw CUError.invalidParams("\(what) must be [x, y, w, h] with a positive size")
    }
    return CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
}

func cuFrame(_ r: CGRect) -> [Double] {
    [Double(r.origin.x), Double(r.origin.y), Double(r.size.width), Double(r.size.height)]
}
