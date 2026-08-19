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
    // MARK: - Wire-input safety bounds (fix round 1, I1)
    //
    // Every function below can receive attacker/bug-controlled input transcribed straight off the
    // wire (zoomPPT, tileX/tileY, and rect x/y/width/height all arrive via JSON with no magnitude
    // limit — `OfficeWireCodec`'s decode path never bounds an integer). A reviewer transcribed and
    // RAN three concrete inputs that trapped the helper (SIGTRAP, exit 133) through this file's
    // then-unchecked arithmetic, killing every open document on every connection — violating the
    // "helper always survives" invariant held since T2/T3. The constants and guards from here down
    // close that surface at its root: every function in this file is now a TOTAL function of its
    // arguments (never traps), so no caller anywhere, present or future, needs to remember to
    // pre-validate before calling in — callers that also want a WIRE-LEVEL refusal reason
    // (`OfficeHelperServer`'s `subscribeTiles`/`tileRequest` handlers) additionally check
    // `isZoomPPTValid`/`estimatedTileCount` themselves before proceeding; see task-4-report.md's
    // "Fix round 1" section for the full disposition.

    /// Sane zoom bounds — generous (0.001x to 100x the canonical `zoomPPT == 1000` == "100% at 2x
    /// device scale" pin) so no legitimate UI zoom level is ever rejected, while keeping
    /// `tileSpanTwips` far from the zone where it would need to clamp (see that function's own
    /// comment — spans only underflow to 0 past `zoomPPT > 10,240,000`, an order of magnitude above
    /// this bound).
    public static let minZoomPPT = 1
    public static let maxZoomPPT = 1_000_000
    public static func isZoomPPTValid(_ zoomPPT: Int) -> Bool { zoomPPT >= minZoomPPT && zoomPPT <= maxZoomPPT }

    /// Sane tile-index bounds. `1,000,000` tiles from the origin, at the LARGEST span a valid
    /// zoomPPT can produce (`zoomPPT == minZoomPPT == 1` → span == 5,120,000 twips, see
    /// `tileSpanTwips`), is a document position of `1,000,000 * 5,120,000 == 5.12e12` twips —
    /// nowhere near `Int64.max` (~9.22e18) and absurdly far beyond any real document, so
    /// `tileBoundsTwips`'s own multiplication never actually overflows once this bound holds; its
    /// overflow check is defense-in-depth, not load-bearing. Written as a symmetric RANGE
    /// comparison, never `abs(index) <= maxTileIndexMagnitude` — `abs(Int.min)` itself TRAPS (no
    /// positive `Int` can represent it), which would make the guard a new instance of exactly the
    /// crash class this fix round exists to close.
    public static let maxTileIndexMagnitude = 1_000_000
    public static func isTileIndexValid(_ index: Int) -> Bool {
        index >= -maxTileIndexMagnitude && index <= maxTileIndexMagnitude
    }

    /// The maximum number of tiles a single rect→tile-set enumeration (`tileCoordinates`/
    /// `viewportTileKeys`, reached from `subscribeTiles`) is allowed to expand to before being
    /// refused rather than attempted. Chosen generously above any plausible real UI viewport (a
    /// screen-filling viewport at typical zoom is tens of tiles; even a multi-monitor wall-sized
    /// prefetch margin is in the hundreds) — 4096 is a 64x64 grid, comfortably above any legitimate
    /// request while keeping both the resulting `subscribed` reply's NDJSON line size and the
    /// enumeration loop itself far short of the reviewer's observed "38 billion keys" OOM/stall
    /// case for a representable-but-huge viewport.
    public static let maxTilesPerRectEnumeration = 4096

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
    /// `roundedDivide`). `zoomPPT <= 0` is invalid — no caller in this codebase ever constructs one
    /// deliberately, but this is now an ENFORCED guard (fix round 1, M2), not just a documented
    /// assumption: `pixelsToTwips` right below already guarded its own `zoomPPT == 0` case; this
    /// function had not, despite taking the identical parameter from the identical (wire-reachable
    /// in principle, even though no current caller routes untrusted input through this specific
    /// function) family of inputs this whole fix round is about not trusting blindly.
    public static func twipsToPixels(_ twips: Int64, zoomPPT: Int) -> Int {
        guard zoomPPT > 0 else { return 0 }
        return Int(roundedDivide(twips * Int64(zoomPPT), 10_000))
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
        let span = roundedDivide(Int64(tilePixelSize) * 10_000, Int64(zoomPPT))
        // Fix round 1, I1: a large enough zoomPPT rounds this division down to 0 (roughly
        // `zoomPPT > 10,240,000`) — and `floorDiv`'s `a % b` traps on a zero divisor, a crash EVERY
        // tile-index computation in this file is exposed to (`tileIndex` -> `indexRange` ->
        // `tileCoordinates`/`estimatedTileCount`, all reachable from `subscribeTiles.zoomPPT`).
        // `isZoomPPTValid`'s own `maxZoomPPT` (1,000,000) already keeps every VALIDATED caller far
        // from this edge, but clamping HERE too means this function stays safe even for a caller
        // that skips that check — defense-in-depth for a divide-by-zero, not just the
        // multiplication overflow the reviewer named directly in `tileBoundsTwips`. Never 0.
        return max(span, 1)
    }

    /// Which tile index (floor division — correct for negative twips too, unlike `/`'s
    /// truncate-toward-zero) contains a given document-space twips coordinate.
    public static func tileIndex(twip: Int64, zoomPPT: Int) -> Int {
        Int(floorDiv(twip, tileSpanTwips(zoomPPT: zoomPPT)))
    }

    /// A tile's own bounding rectangle in twips — the inverse of `tileIndex`. `nil` (fix round 1,
    /// I1's trap #3) when `tileX`/`tileY`/`zoomPPT` are out of the sane bounds above, OR (defense-
    /// in-depth, should be unreachable once those bounds hold — see `maxTileIndexMagnitude`'s own
    /// comment) when `Int64(tileX) * span` would overflow anyway. Reachable with a HOSTILE key from
    /// two directions: `tileRequest.keys` directly (a client-supplied `TileKey`, checked here at
    /// paint time — `TileRenderer.renderRaw` throws when this returns `nil`, becoming a `.tileFailed`
    /// push through the tileRequest handler's EXISTING catch block, unchanged), and
    /// `TileCache.invalidate` recomputing bounds for every key it has EVER painted (the never-
    /// evicted `generations` ledger) on every SUBSEQUENT, otherwise-unrelated invalidation — a key
    /// that got in before this guard existed (or via any future caller of `TileCache`'s pure API
    /// directly, which accepts any `TileKey`) would otherwise crash the helper on a LATER firing
    /// that has nothing to do with the poisoned key itself. `TileCache.invalidate` skips a `nil`
    /// result rather than treating it as a match — see that method's own comment.
    public static func tileBoundsTwips(tileX: Int, tileY: Int, zoomPPT: Int) -> OfficeTwipsRect? {
        guard isTileIndexValid(tileX), isTileIndexValid(tileY), isZoomPPTValid(zoomPPT) else { return nil }
        let span = tileSpanTwips(zoomPPT: zoomPPT)
        let (x, xOverflow) = Int64(tileX).multipliedReportingOverflow(by: span)
        let (y, yOverflow) = Int64(tileY).multipliedReportingOverflow(by: span)
        guard !xOverflow, !yOverflow else { return nil }
        return OfficeTwipsRect(x: x, y: y, width: span, height: span)
    }

    /// The inclusive [min, max] tile-index range covering one axis of a twips span `[origin,
    /// origin + length)`. `length <= 0` covers no tiles at all (`nil`) — a degenerate/empty input,
    /// not an error: an empty viewport or a zero-area invalidation rect legitimately touches
    /// nothing.
    static func indexRange(origin: Int64, length: Int64, zoomPPT: Int) -> ClosedRange<Int>? {
        guard length > 0 else { return nil }
        // Fix round 1, I1's trap #1: `origin + length - 1` used to be unchecked `+`/`-`, which
        // TRAPS given a client-supplied (wire-decoded, no magnitude limit) `viewportTwips` with
        // `origin`/`length` near `Int64`'s extremes — a `subscribeTiles` call away. Checked
        // end-to-end; `nil` (this function's existing "nothing to cover" contract, previously only
        // reached via `length <= 0`) is the safe answer for "unrepresentable" too — a span this
        // extreme cannot be conservatively said to cover any tile, so callers already treating
        // `nil` as empty (`tileCoordinates`) stay correct without change.
        let (afterEnd, overflowedAdd) = origin.addingReportingOverflow(length)
        guard !overflowedAdd else { return nil }
        // The last twip actually INSIDE the span — origin+length itself is one-past-the-end
        // (half-open), so subtracting 1 avoids counting a phantom extra tile when the range's far
        // edge lands exactly on a tile boundary.
        let (lastTwip, overflowedSub) = afterEnd.subtractingReportingOverflow(1)
        guard !overflowedSub else { return nil }
        let minIndex = tileIndex(twip: origin, zoomPPT: zoomPPT)
        let maxIndex = tileIndex(twip: lastTwip, zoomPPT: zoomPPT)
        // Defensive: `ClosedRange`'s own initializer TRAPS if `lowerBound > upperBound`.
        // `tileIndex` is monotonic non-decreasing in its twip argument (floor division by a fixed
        // positive span — `tileSpanTwips` now guarantees `>= 1`, see its own comment) and
        // `lastTwip >= origin` always holds given `length > 0` and no overflow above, so
        // `minIndex <= maxIndex` should be unreachable — kept as a real guard rather than a trusted
        // invariant, exactly per this fix round's own "never trap, regardless of caller" standard.
        guard minIndex <= maxIndex else { return nil }
        return minIndex...maxIndex
    }

    /// `range.upperBound - range.lowerBound + 1`, computed with CHECKED arithmetic — never
    /// `range.count`. **Corrected, micro-round 2**: for a range this file's OWN `indexRange`
    /// produces, this can never actually overflow, and the previous version of this comment's cited
    /// example (`origin: 0, length: .max` at `zoomPPT: maxZoomPPT`) does NOT trap — dividing by a
    /// positive span cannot INCREASE a distance, so `indexRange`'s own two floor-divisions (`minIndex
    /// = floorDiv(origin, span)`, `maxIndex = floorDiv(lastTwip, span)`, `span >= 1` always per
    /// `tileSpanTwips`) can only shrink or preserve the twip-distance, never grow it: index-distance
    /// <= twip-distance (`lastTwip - origin == length - 1`) <= `Int64.max - 1`, and that upper bound
    /// is exactly what `indexRange`'s own checked `origin + length - 1` arithmetic already
    /// guarantees is representable. So — mirroring `maxTileIndexMagnitude`'s own honest framing —
    /// avoiding `.count` here is defense-in-depth, not load-bearing for anything `indexRange`
    /// itself ever hands this function: it protects a HYPOTHETICAL future caller passing a
    /// `ClosedRange<Int>` from somewhere else entirely, not the one call site (`estimatedTileCount`)
    /// this file actually has today. Still correct to keep total/never-trapping regardless — `nil`
    /// on overflow, the same "cannot represent this" meaning every other checked operation in this
    /// file uses.
    private static func axisCount(_ range: ClosedRange<Int>) -> Int? {
        let (span, overflowedSub) = range.upperBound.subtractingReportingOverflow(range.lowerBound)
        guard !overflowedSub else { return nil }
        let (count, overflowedAdd) = span.addingReportingOverflow(1)
        guard !overflowedAdd else { return nil }
        return count
    }

    /// Safely computes how many tiles a rect→tile-set enumeration (`tileCoordinates`/
    /// `viewportTileKeys`) WOULD produce for `rectTwips` at `zoomPPT`, without ever building the
    /// list — checked arithmetic throughout (including `axisCount` above, never `ClosedRange.count`
    /// directly), so this stays a TOTAL function regardless of how extreme the client-supplied
    /// inputs are.
    ///
    /// `0` for a legitimately empty/zero-area rect — checked FIRST via a `<= 0` comparison that
    /// cannot itself overflow, before any arithmetic that could — normal input (e.g. a viewport
    /// before a window has been sized), not a refusal. `nil` means "cannot or will not enumerate
    /// this": either axis's own `indexRange`/`axisCount` was unrepresentable, or the resulting
    /// count overflows or exceeds `maxTilesPerRectEnumeration` — every caller
    /// (`OfficeHelperServer.subscribeTiles`'s handler, `tileCoordinates` below) treats all of these
    /// identically: refuse, don't attempt.
    static func estimatedTileCount(rectTwips: OfficeTwipsRect, zoomPPT: Int) -> Int? {
        guard rectTwips.width > 0, rectTwips.height > 0 else { return 0 }
        guard let xRange = indexRange(origin: rectTwips.x, length: rectTwips.width, zoomPPT: zoomPPT),
              let yRange = indexRange(origin: rectTwips.y, length: rectTwips.height, zoomPPT: zoomPPT),
              let xCount = axisCount(xRange), let yCount = axisCount(yRange) else {
            return nil
        }
        let (total, overflowed) = xCount.multipliedReportingOverflow(by: yCount)
        guard !overflowed, total > 0, total <= maxTilesPerRectEnumeration else { return nil }
        return total
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
        // Fix round 1, I1's trap #2: `reserveCapacity(xRange.count * yRange.count)` used to
        // multiply two UNCHECKED `Int`s (and call `.count` on wire-derived ranges at all — see
        // `axisCount`'s own comment on why that alone can trap) — both a crash (multiplication
        // overflow) and, for a representable-but-huge viewport, an OOM/stall building one absurd
        // NDJSON line (the reviewer's own "38 billion keys" measurement). `estimatedTileCount` is
        // now the ONE place this cap/overflow logic lives — delegating to it here means this
        // function can never crash or attempt a pathological allocation regardless of caller,
        // whether or not that caller also pre-checks via `estimatedTileCount` itself (as
        // `subscribeTiles`'s handler now does, for an accurate wire refusal reason).
        guard let count = estimatedTileCount(rectTwips: rectTwips, zoomPPT: zoomPPT), count > 0 else {
            return []
        }
        // Recomputed rather than threaded through `estimatedTileCount`'s own return value — cheap
        // (a handful of integer ops), pure, and keeps that function's contract simple ("just a
        // count, or nil"). `estimatedTileCount` just proved both axes are representable and the
        // product is safe and within the cap, so these two `!`-free unwraps are guarded again here
        // for exhaustiveness, not because they are expected to ever actually fail.
        guard let xRange = indexRange(origin: rectTwips.x, length: rectTwips.width, zoomPPT: zoomPPT),
              let yRange = indexRange(origin: rectTwips.y, length: rectTwips.height, zoomPPT: zoomPPT) else {
            return []
        }
        var coordinates: [(tileX: Int, tileY: Int)] = []
        coordinates.reserveCapacity(count)
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
    ///
    /// **Disclosed edge case (fix round 1), folded into Stage B's own live-invalidation
    /// verification criteria rather than resolved here**: this "zero area intersects nothing"
    /// reading is about an individual DEGENERATE rect inside a non-empty `rectsTwips` array —
    /// distinct from `TileCache.invalidate`'s own "empty ARRAY means bump everything" special case
    /// (LOK's `"EMPTY"` sentinel, handled before any `intersects` call is ever made). Whether real
    /// LOK can ever emit a non-empty invalidation payload containing a genuinely zero-area rect
    /// that was still MEANT to invalidate something (as opposed to a legitimately no-op rect) is
    /// unverified — no real `INVALIDATE_TILES` firing has been observed at all yet (Debt #1,
    /// task-4-report.md). If Stage B's first live edit-triggered invalidation ever surfaces one,
    /// re-examine this reading against what LOK actually sends before assuming today's "intersects
    /// nothing" is the semantically correct call — it currently fails CLOSED (bumps nothing extra),
    /// not open, which is the safer of the two wrong answers if it is ever wrong at all.
    public func intersects(_ other: OfficeTwipsRect) -> Bool {
        guard width > 0, height > 0, other.width > 0, other.height > 0 else { return false }
        return x < other.x + other.width && other.x < x + width
            && y < other.y + other.height && other.y < y + height
    }
}
