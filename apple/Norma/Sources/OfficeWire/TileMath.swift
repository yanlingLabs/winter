import Foundation

/// Office Stage A Task 4 — SHARED, pure tile geometry: twips<->points<->pixels conversions, the
/// viewport->tile-set mapping, and the invalidation-rect->tile-coordinates mapping. Zero LOK
/// symbols, zero I/O, zero mutable state — every function is a pure, total function of its
/// arguments, which is what makes the exhaustive table test in `TileMathTests.swift` possible.
/// Lives in `Sources/OfficeWire` (compiled into `Norma`, `NormaOfficeHelper`, AND
/// `NormaOfficeHelperFixture` via that directory's unconditional `sources` sweep in every one of
/// the three targets — see project.yml) because BOTH the app (computing which tiles a viewport
/// needs, to drive `subscribeTiles`/`tileRequest`) and the helper (computing which cached tiles an
/// invalidation rect touches) need the identical arithmetic — a client and server that derived
/// tile boundaries with even slightly different rounding would disagree about tile identity across
/// the wire.
///
/// ## The unit system
///
/// - **Twips**: LOK's native document-space unit, 1/1440 inch, always an integer (`Int64` — a
///   large document's height in twips can exceed `Int32`).
/// - **Points**: the typographic unit Norma's UI otherwise speaks in (`256pt` tiles, per the Tile
///   Core spec). `twipsPerPoint = 20` (1440 twips/inch / 72pt/inch) is exact — no rounding needed
///   for twips<->points.
/// - **zoomPPT**: pixels-per-twip x 10000, an integer (never a float — the brief's own reason:
///   "avoids float keys" in a `TileKey`'s Hashable/Equatable identity, and floats are not exact
///   enough for wire round-tripping to be safe against a rare rounding-direction disagreement
///   between two Swift processes). At the canonical "100% zoom, 2x device scale" configuration
///   this task's product-path pins render at, `zoomPPT == 1000`, derived: 1pt = 20 twips, 1pt = 2px
///   at 2x device scale, so 1 twip = 2/20 px = 0.1px = 1000/10000 — i.e. `zoomPPT == 1000` implies
///   `tileSpanTwips == 5120` implies a 256pt tile occupies exactly `tilePixelSize` (512) pixels,
///   matching the Tile Core spec's own "256pt tiles at 2x (512px)" line exactly. This identity is
///   asserted directly in the table test, not just narrated here.
public enum TileMath {
    /// Twips per (typographic) point — exact, LOK's own unit relationship (1440 twips/inch, 72pt/inch).
    public static let twipsPerPoint: Int64 = 20

    /// The FIXED render canvas size, in pixels, for every tile regardless of zoom — 256pt at a
    /// fixed 2x device scale (the Tile Core spec's own pin). Zooming the document changes how many
    /// TWIPS a tile spans (see `tileSpanTwips`), never how many pixels the rendered buffer is —
    /// this is what lets `paintTile`'s `nCanvasWidth`/`nCanvasHeight` stay a compile-time constant
    /// while `nTileWidth`/`nTileHeight` (twips) vary per zoom.
    public static let tilePixelSize: Int = 512

    /// Bytes per tile at `tilePixelSize`, RGBA (4 bytes/pixel) — the canonical in-memory pixel
    /// format every payload on this wire uses, regardless of what LOK's own `getTileMode()` reports
    /// for a given build (BGRA is byte-swapped to RGBA before it ever reaches this module — see
    /// `TileRenderer.swift`). `512 * 512 * 4 == 1_048_576` — **1 MiB, not the 256 KiB a "256px
    /// tile" reading of the transport-decision framing would suggest**; that estimate's arithmetic
    /// matches a 256x256 tile, not the Tile Core spec's actual 256pt-at-2x == 512x512 tile. See
    /// task-4-report.md's transport section for the full correction and why it does not change the
    /// verdict. Asserted directly in the table test so this constant can never silently drift from
    /// the number every downstream measurement depends on.
    public static let bytesPerTile = tilePixelSize * tilePixelSize * 4

    // MARK: - Straight unit conversion

    public static func twipsToPoints(_ twips: Int64) -> Double { Double(twips) / Double(twipsPerPoint) }
    public static func pointsToTwips(_ points: Double) -> Int64 { Int64((points * Double(twipsPerPoint)).rounded()) }

    /// `pixels = twips * zoomPPT / 10000`, rounded to the nearest pixel (ties away from zero, via
    /// `roundedDivide`). `zoomPPT <= 0` is invalid (no caller in this codebase ever constructs
    /// one); `roundedDivide`/`tileSpanTwips` define the fallback behavior for that case.
    public static func twipsToPixels(_ twips: Int64, zoomPPT: Int) -> Int {
        Int(roundedDivide(twips * Int64(zoomPPT), 10_000))
    }

    public static func pixelsToTwips(_ pixels: Int, zoomPPT: Int) -> Int64 {
        guard zoomPPT != 0 else { return 0 }
        return roundedDivide(Int64(pixels) * 10_000, Int64(zoomPPT))
    }

    // MARK: - Tile geometry

    /// How many twips one tile spans at `zoomPPT` — the FIXED `tilePixelSize` pixel canvas,
    /// converted back to twips at the current zoom. Every tile at a given `zoomPPT` uses this same
    /// value, so adjacent tile boundaries are always exactly contiguous (`tileX * span` to
    /// `(tileX+1) * span`) regardless of the rounding this division performs — rounding only
    /// affects how close the round-trip (`twipsToPixels(tileSpanTwips(z), zoomPPT: z)`) lands to
    /// exactly `tilePixelSize`, never whether tiles gap or overlap, since every tile at a given
    /// zoom shares the identical span. `zoomPPT <= 0` is invalid input and returns `tilePixelSize`
    /// twips-for-twips as an inert fallback rather than dividing by zero or a negative span that
    /// would invert tile ordering.
    public static func tileSpanTwips(zoomPPT: Int) -> Int64 {
        guard zoomPPT > 0 else { return Int64(tilePixelSize) }
        return roundedDivide(Int64(tilePixelSize) * 10_000, Int64(zoomPPT))
    }

    /// Which tile index (floor division — correct for negative twips too, unlike `/`'s
    /// truncate-toward-zero) contains a given document-space twips coordinate.
    public static func tileIndex(twip: Int64, zoomPPT: Int) -> Int {
        Int(floorDiv(twip, tileSpanTwips(zoomPPT: zoomPPT)))
    }

    /// A tile's own bounding rectangle in twips — the inverse of `tileIndex`.
    public static func tileBoundsTwips(tileX: Int, tileY: Int, zoomPPT: Int) -> OfficeTwipsRect {
        let span = tileSpanTwips(zoomPPT: zoomPPT)
        return OfficeTwipsRect(x: Int64(tileX) * span, y: Int64(tileY) * span, width: span, height: span)
    }

    /// The inclusive [min, max] tile-index range covering one axis of a twips span `[origin,
    /// origin + length)`. `length <= 0` covers no tiles at all (`nil`) — a degenerate/empty input,
    /// not an error: an empty viewport or a zero-area invalidation rect legitimately touches
    /// nothing.
    static func indexRange(origin: Int64, length: Int64, zoomPPT: Int) -> ClosedRange<Int>? {
        guard length > 0 else { return nil }
        let minIndex = tileIndex(twip: origin, zoomPPT: zoomPPT)
        // The last twip actually INSIDE the span — origin+length itself is one-past-the-end
        // (half-open), so subtracting 1 avoids counting a phantom extra tile when the range's far
        // edge lands exactly on a tile boundary.
        let maxIndex = tileIndex(twip: origin + length - 1, zoomPPT: zoomPPT)
        return minIndex...maxIndex
    }

    /// **viewport->tile-set**: every `TileKey` (at `part`/`zoomPPT`) whose bounds intersect
    /// `viewportTwips`. Empty for a zero-area viewport. Order is row-major (Y outer, X inner,
    /// ascending) — not load-bearing for correctness, but deterministic, which the table test
    /// relies on for exact-array comparisons.
    public static func viewportTileKeys(part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect) -> [TileKey] {
        tileCoordinates(rectTwips: viewportTwips, zoomPPT: zoomPPT).map {
            TileKey(part: part, zoomPPT: zoomPPT, tileX: $0.tileX, tileY: $0.tileY)
        }
    }

    /// **invalidation-rect->tile-keys**' shared geometry core: every `(tileX, tileY)` whose bounds
    /// intersect `rectTwips`, with NO `part`/generation attached — `part` scoping and generation
    /// bumping are `TileCache.invalidate`'s job (a stateful concern; this function stays pure and
    /// state-free), and `viewportTileKeys` above is this same computation with a `part` stamped on
    /// afterward. Kept as one shared primitive rather than two independent implementations so the
    /// viewport and invalidation call sites can never disagree about what "covers this rect" means.
    public static func tileCoordinates(rectTwips: OfficeTwipsRect, zoomPPT: Int) -> [(tileX: Int, tileY: Int)] {
        guard let xRange = indexRange(origin: rectTwips.x, length: rectTwips.width, zoomPPT: zoomPPT),
              let yRange = indexRange(origin: rectTwips.y, length: rectTwips.height, zoomPPT: zoomPPT) else {
            return []
        }
        var coordinates: [(tileX: Int, tileY: Int)] = []
        coordinates.reserveCapacity(xRange.count * yRange.count)
        for y in yRange {
            for x in xRange {
                coordinates.append((tileX: x, tileY: y))
            }
        }
        return coordinates
    }

    // MARK: - Integer helpers

    /// Floor division — `a / b` rounded toward negative infinity, correct for negative `a` (Swift's
    /// `/` truncates toward zero, which only equals floor when both operands share a sign). `b` is
    /// always a positive tile span at every call site in this file.
    static func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
        let quotient = a / b
        let remainder = a % b
        return (remainder != 0 && (remainder < 0) != (b < 0)) ? quotient - 1 : quotient
    }

    /// Round-to-nearest division, ties away from zero — matches `Double.rounded()`'s default rule,
    /// applied in pure integer arithmetic (no float round-trip, which could disagree at the exact
    /// tie boundary between two platforms/compilers). `b` is always positive at every call site here.
    static func roundedDivide(_ a: Int64, _ b: Int64) -> Int64 {
        guard b != 0 else { return 0 }
        if a >= 0 {
            return (a + b / 2) / b
        } else {
            return -((-a + b / 2) / b)
        }
    }
}

/// `(part, zoomPPT, tileX, tileY)` — a tile's logical identity, independent of its rendered
/// generation (see `TileCache`, which pairs a `TileKey` with a generation + pixel payload). Crosses
/// the wire inside `subscribeTiles`'s reply, `tileRequest`'s request, and `tile`/`invalidated`'s
/// payloads (`OfficeWire.swift`).
public struct TileKey: Hashable, Equatable, Sendable {
    public let part: Int
    public let zoomPPT: Int
    public let tileX: Int
    public let tileY: Int
    public init(part: Int, zoomPPT: Int, tileX: Int, tileY: Int) {
        self.part = part
        self.zoomPPT = zoomPPT
        self.tileX = tileX
        self.tileY = tileY
    }

    /// Manual JSON encode/decode, matching this file's own established discipline
    /// (`OfficeWireCodec`'s `[String: Any]` style throughout `OfficeWire.swift`) rather than
    /// introducing `Codable` for just this one type.
    func jsonObject() -> [String: Any] {
        ["part": part, "zoomPPT": zoomPPT, "tileX": tileX, "tileY": tileY]
    }

    static func decode(_ object: [String: Any]) -> TileKey? {
        guard let part = intValue(object["part"]), let zoomPPT = intValue(object["zoomPPT"]),
              let tileX = intValue(object["tileX"]), let tileY = intValue(object["tileY"]) else {
            return nil
        }
        return TileKey(part: part, zoomPPT: zoomPPT, tileX: tileX, tileY: tileY)
    }
}

extension OfficeTwipsRect {
    /// Standard half-open AABB overlap test. A zero-width or zero-height rect on EITHER side
    /// intersects nothing, including an identical zero-size rect at the same origin — an empty
    /// rectangle covers no area to overlap.
    public func intersects(_ other: OfficeTwipsRect) -> Bool {
        guard width > 0, height > 0, other.width > 0, other.height > 0 else { return false }
        return x < other.x + other.width && other.x < x + width
            && y < other.y + other.height && other.y < y + height
    }
}
