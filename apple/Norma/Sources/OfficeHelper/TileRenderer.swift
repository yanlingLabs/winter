import Foundation

// Office Stage A Task 4 — the LOK-touching half of the tile pool. Only `NormaOfficeHelper`
// compiles this file (excluded from `NormaOfficeHelperFixture` in project.yml, alongside
// `LOKBridge.swift`/`Support/` — see that file's own header for why the fixture stays LOK-free):
// it calls `paintPartTile`/`getTileMode` directly through the same bridging-header vtable
// `LOKBridge.swift` already uses.

/// One instance per open document, owned by `LOKBridge`'s `OpenDocument` alongside the document's
/// own handle. Wraps a pure `TileCache` (`Sources/OfficeWire/TileCache.swift` — the generation
/// ledger + LRU pool, unit-tested independently and fast, per the structural split this task's own
/// review caught: `Sources/OfficeHelper` is unreachable from `NormaAppTests`, so a pool/eviction
/// design that lived ENTIRELY in this file would have zero fast test coverage, the same trap
/// `OfficeDocumentEvent`'s two raw parsers already hit once in Task 3) with the one real LOK call
/// that actually produces pixels.
///
/// **Every method here must run on `LOKDedicatedThread`.** This type does no locking or thread
/// marshaling of its own — `LOKBridge` is the only caller, and it is the caller's job (`thread.sync`
/// for `paint`, called from a connection thread via `tileRequest`; already-on-thread for
/// `applyInvalidation`, reached synchronously from inside a LOK callback — see
/// `OfficeDocumentBridge.applyTileInvalidation`'s own header) to guarantee that.
final class TileRenderer {
    private var cache: TileCache
    private let handle: UnsafeMutablePointer<LibreOfficeKitDocument>

    /// `getTileMode()`, read ONCE at construction — LOK's own contract is that tile mode is a
    /// property of the document/build, not something that varies per paint call (the spike's own
    /// `main.c` reads it once, the same way). `0 = LOK_TILEMODE_RGBA`, `1 = LOK_TILEMODE_BGRA`
    /// (`LibreOfficeKitEnums.h:38-43`, transcribed rather than imported — same reasoning as
    /// `LOKCallbackType` in `LOKBridge.swift`: that header is not safely importable into a plain
    /// bridging-header context outside a C++ translation unit).
    private let isBGRA: Bool

    init(handle: UnsafeMutablePointer<LibreOfficeKitDocument>, poolCapacity: Int = 32) {
        self.handle = handle
        self.cache = TileCache(capacity: poolCapacity)
        let tileMode = handle.pointee.pClass.pointee.getTileMode?(handle) ?? 0
        self.isBGRA = (tileMode == 1) // LOK_TILEMODE_BGRA, LibreOfficeKitEnums.h:41
    }

    /// The requested tile's CURRENT generation + RGBA pixels — a cache hit, or a fresh
    /// `paintPartTile` call (canonicalized to RGBA) on a miss.
    func paint(key: TileKey) -> (generation: Int, pixels: Data) {
        if let hit = cache.lookup(key: key) {
            return (hit.generation, hit.pixels)
        }
        let pixels = renderRaw(key: key)
        let generation = cache.recordPaint(key: key, pixels: pixels)
        return (generation, pixels)
    }

    /// Delegates to `TileCache.invalidate` — see that method's own header for the EMPTY-means-
    /// bump-everything and part-scoping rules; this wrapper adds nothing beyond routing.
    func applyInvalidation(rectsTwips: [OfficeTwipsRect], part: Int) -> [TileKey] {
        cache.invalidate(rectsTwips: rectsTwips, part: part)
    }

    /// The one real LOK call: `paintPartTile` into a fresh `TileMath.tilePixelSize`^2 buffer,
    /// BGRA-canonicalized to RGBA in place if `getTileMode()` reported BGRA — the spike's own
    /// proven swap (`spikes/office-lok-gate/main.c`'s in-place R/B exchange), so every payload
    /// this module ever produces is RGBA regardless of what a given LOK build happens to report.
    /// `nPart` is passed DIRECTLY to `paintPartTile` (never a separate `setPart` call first) —
    /// deliberately, so interleaved requests for different parts never need to coordinate a shared
    /// "current part" mutation between them; `nMode` is `LOK_PARTMODE_SLIDES` (0) — Stage A has no
    /// notes view. `nTilePosX/Y`/`nTileWidth/Height` are twips, truncated to `Int32` defensively
    /// (`paintPartTile`'s own C signature) — never observed to matter for Stage A's fixtures
    /// (twips values in the tens of thousands, nowhere near `Int32.max`), but a truncating
    /// conversion rather than a crashing one costs nothing and avoids a pathological-document trap.
    private func renderRaw(key: TileKey) -> Data {
        let size = TileMath.tilePixelSize
        let bounds = TileMath.tileBoundsTwips(tileX: key.tileX, tileY: key.tileY, zoomPPT: key.zoomPPT)
        var buffer = [UInt8](repeating: 0, count: TileMath.bytesPerTile)
        buffer.withUnsafeMutableBufferPointer { rawBuffer in
            handle.pointee.pClass.pointee.paintPartTile?(
                handle, rawBuffer.baseAddress, Int32(key.part), 0 /* LOK_PARTMODE_SLIDES */,
                Int32(size), Int32(size),
                Int32(truncatingIfNeeded: bounds.x), Int32(truncatingIfNeeded: bounds.y),
                Int32(truncatingIfNeeded: bounds.width), Int32(truncatingIfNeeded: bounds.height))
        }
        if isBGRA {
            var index = 0
            while index < buffer.count {
                buffer.swapAt(index, index + 2) // R <-> B; alpha (index+3) and G (index+1) untouched
                index += 4
            }
        }
        return Data(buffer)
    }
}
