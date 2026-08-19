import Foundation

/// Office Stage A Task 4 — the PURE, LOK-free half of the tile pool: which coordinates are
/// currently cached, their generations, and LRU eviction order. Deliberately split out of
/// `TileRenderer.swift` (the LOK-touching half, `Sources/OfficeHelper`, which owns actual pixel
/// rendering) for one concrete reason: `Sources/OfficeHelper` is excluded from `Norma`'s own
/// sources sweep (a `main.swift` collision — see `OfficeWire.swift`'s header), so nothing living
/// there is importable by `NormaAppTests` — exactly the trap `OfficeDocumentEvent`'s two raw-
/// payload parsers already hit once in Task 3 (moved to this same `Sources/OfficeWire` directory
/// for the identical reason — see that file's "LOK raw callback payload parsing" section). This
/// file lives here so the brief's own "pool-LRU eviction test" can exist at all, fast and LOK-free,
/// rather than depending on a real `paintTile` call for every case. A disclosed structural
/// deviation from the brief's literal file list (which names only `TileRenderer.swift` +
/// `TileMath.swift`): this is a THIRD new file, not an unannounced expansion of either of those two
/// — see task-4-report.md.
///
/// `TileRenderer` (OfficeHelper) owns exactly one `TileCache` per open document and is the only
/// thing that constructs one against REAL pixels; it supplies real `Data` to `recordPaint` and
/// calls `invalidate` from the LOK callback translation path. `FakeOfficeDocumentBridge`
/// (`OfficeHelperServer.swift`) also owns one per fake-opened docId, with synthetic pixel content,
/// so the WIRE-LEVEL plumbing (subscribe/request/multicast/invalidate) is testable over a real
/// socket without booting real LOK — only pixel CORRECTNESS needs the vendor-gated live tests.
public struct TileCache: Sendable {
    public struct Entry: Equatable, Sendable {
        public let generation: Int
        public let pixels: Data
    }

    public let capacity: Int

    /// Every coordinate this cache has EVER painted, and its current generation — never evicted,
    /// unlike `pixelsByKey`/`lruOrder` below. Kept for the lifetime of the owning document so a
    /// coordinate whose pixels were LRU-evicted and later re-painted still reports a generation
    /// that only ever goes up, never appears to "reset" to a caller comparing generation numbers.
    /// Disclosed scaling limitation (task-4-report.md): an extremely long session that pans/zooms
    /// across a very large number of distinct coordinates grows this dictionary unboundedly —
    /// capped LRU applies only to the pixel POOL, not this ledger. Not a correctness bug for
    /// Stage A's own tests or realistic session lengths; flagged as a future hardening item.
    private var generations: [TileKey: Int] = [:]
    /// Only the currently-cached (`<= capacity`) coordinates' actual pixel payloads.
    private var pixelsByKey: [TileKey: Data] = [:]
    /// LRU order, least-recently-used FIRST. Touched by both `recordPaint` (a fresh paint is
    /// always most-recently-used) and a `lookup` HIT (a cache hit also counts as use).
    private var lruOrder: [TileKey] = []

    public init(capacity: Int) {
        self.capacity = max(1, capacity)
    }

    public var cachedCount: Int { pixelsByKey.count }
    /// Test/debug visibility only — the LRU order at this instant, least-recently-used first.
    public var lruOrderForTesting: [TileKey] { lruOrder }
    /// Test/debug visibility only — every coordinate this cache has ever painted (including
    /// currently-evicted ones), for asserting the generation ledger's own persistence.
    public var knownKeysForTesting: Set<TileKey> { Set(generations.keys) }

    /// Returns the CURRENT generation for `key` (0 if never seen before — a coordinate nobody has
    /// requested has no staleness history to have accumulated) and stores `pixels`, marking `key`
    /// most-recently-used. Evicts the least-recently-used cached entry if this insert would exceed
    /// `capacity` — `generations` itself is NEVER evicted (see its own header).
    @discardableResult
    public mutating func recordPaint(key: TileKey, pixels: Data) -> Int {
        // `dictionary[key, default:]` is a READ-only convenience — it does NOT insert `key` into
        // the dictionary. Without the explicit write-back below, a freshly-painted key's
        // generation reads as 0 correctly but the key itself never becomes "known": `invalidate`'s
        // `generations.keys` (both the EMPTY-invalidation and the part-scoped filter) would never
        // see it, silently failing to bump a tile that HAS been painted and IS cached — caught by
        // `TileCacheTests` failing on first run, not by inspection.
        let generation = generations[key] ?? 0
        generations[key] = generation
        pixelsByKey[key] = pixels
        touch(key)
        evictIfNeeded()
        return generation
    }

    /// A cache hit (marks `key` most-recently-used) or `nil` on a miss — an evicted, never-painted,
    /// or stale-and-removed (see `invalidate`) coordinate.
    public mutating func lookup(key: TileKey) -> Entry? {
        guard let pixels = pixelsByKey[key] else { return nil }
        touch(key)
        return Entry(generation: generations[key, default: 0], pixels: pixels)
    }

    /// Bumps the generation of, and evicts the cached pixels for, every key this cache has ever
    /// painted whose bounds intersect `rectsTwips` and whose `part` matches `part` — OR, when
    /// `rectsTwips` is empty, EVERY key regardless of part.
    ///
    /// **The empty-array case is not "no rectangles to intersect, so nothing matches" — it is
    /// LOK's OWN "EMPTY" sentinel for `LOK_CALLBACK_INVALIDATE_TILES`, meaning "the whole document,
    /// drop every tile" (`LibreOfficeKitEnums.h:120-129`; `OfficeDocumentEvent.parseInvalidateTiles`
    /// maps the literal string `"EMPTY"` to `rectsTwips: []`).** A naive rect-intersection reading
    /// of an empty rect LIST would bump nothing — the exact opposite of what LOK is saying. This is
    /// deliberately special-cased FIRST, before any intersection test runs, and pinned by name in
    /// the exhaustive table test (`testEmptyInvalidationBumpsEveryCachedKeyAcrossEveryPart`).
    ///
    /// `part` scoping for the NON-empty case: an invalidation rect is scoped to the part it fired
    /// for (a dirty rectangle on spreadsheet sheet 2 says nothing about sheet 0's identically-
    /// numbered tile coordinates — different parts are independent canvases). The EMPTY case
    /// ignores `part` entirely and bumps every part's keys — "the whole document" reads as
    /// document-wide, not scoped to whichever part happened to be active when LOK fired it; a
    /// disclosed interpretation (Stage A's gate fixtures are all `parts == 1`, so it is not
    /// empirically distinguishable from "current part only" against real LOK — see
    /// task-4-report.md).
    ///
    /// Returns every `TileKey` actually bumped, SORTED by `(part, zoomPPT, tileX, tileY)` — fix
    /// round 1, discretionary: the underlying `Dictionary.keys` iteration order is unspecified, so
    /// leaving it unsorted made every wire-level capture of an `invalidated{keys}` push
    /// non-deterministic to diff between runs. Sorting costs nothing observable (this list is
    /// bounded by how many distinct coordinates a document's session has ever painted, never the
    /// pathological sizes `estimatedTileCount` guards against elsewhere) and the caller
    /// (`OfficeHelperServer`) already uses this list verbatim as the `invalidated{keys}` wire push.
    @discardableResult
    public mutating func invalidate(rectsTwips: [OfficeTwipsRect], part: Int) -> [TileKey] {
        let touchedKeys: [TileKey]
        if rectsTwips.isEmpty {
            touchedKeys = Array(generations.keys)
        } else {
            touchedKeys = generations.keys.filter { key in
                guard key.part == part else { return false }
                // Fix round 1, I1's trap #3 (the "poisoned cached key" half): `tileBoundsTwips` is
                // now `nil`-safe rather than trapping, but a `nil` here still needs a DECISION, not
                // just an absence of a crash. A key whose own coordinates are no longer
                // representable/valid (e.g. a hostile tileX or zoomPPT that reached `recordPaint`
                // via some caller of this pure API directly, before this fix round's handler-level
                // guards existed on the wire path) cannot be tested for intersection at all — this
                // SKIPS it (excluded from `touchedKeys`, generation not bumped, not evicted) rather
                // than either crashing the WHOLE invalidation pass over one bad key, or guessing
                // that it matches. It simply sits inert in the ledger, exactly like any other known
                // key nobody has asked about since.
                guard let bounds = TileMath.tileBoundsTwips(tileX: key.tileX, tileY: key.tileY, zoomPPT: key.zoomPPT) else {
                    return false
                }
                return rectsTwips.contains { $0.intersects(bounds) }
            }
        }
        for key in touchedKeys {
            generations[key, default: 0] += 1
            pixelsByKey.removeValue(forKey: key)
            lruOrder.removeAll { $0 == key }
        }
        return touchedKeys.sorted { lhs, rhs in
            (lhs.part, lhs.zoomPPT, lhs.tileX, lhs.tileY) < (rhs.part, rhs.zoomPPT, rhs.tileX, rhs.tileY)
        }
    }

    private mutating func touch(_ key: TileKey) {
        lruOrder.removeAll { $0 == key }
        lruOrder.append(key)
    }

    private mutating func evictIfNeeded() {
        while pixelsByKey.count > capacity, !lruOrder.isEmpty {
            let victim = lruOrder.removeFirst()
            pixelsByKey.removeValue(forKey: victim)
        }
    }
}
