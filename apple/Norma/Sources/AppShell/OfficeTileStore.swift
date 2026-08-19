import Combine
import Foundation

/// office-plumbing Task 6 — **the app-side pixel pool: one per `OfficeRuntime`, never `@Published`.**
///
/// `OfficeRuntimeState` (Task 5) is `Equatable` and cheap to diff — every mutation is a SwiftUI
/// invalidation, which is exactly right for "which documents are open" but exactly wrong for tile
/// pixels: a scroll can land dozens of 1 MiB payloads a second (`TileMath.bytesPerTile`), and
/// publishing each one would fire a reducer-shaped invalidation storm over data no `Equatable` diff
/// should ever have to compare. This type is the disclosed design choice the T6 dispatch asked for:
/// pixels live HERE, off the `@Published` graph entirely, and `tilesArrived` is a lightweight signal
/// (which keys changed, never the bytes) a view can subscribe to and read the store directly from.
///
/// **Keyed by `(docId, TileKey)`, not `TileKey` alone** — unlike the helper's own `TileCache` (one
/// instance per open document, so a bare `TileKey` is unambiguous there), one runtime can hold
/// several open documents (several `.document` tabs in the same session), and this store is shared
/// across all of them.
///
/// **No persistent PER-KEY "generations" ledger**, unlike `TileCache.generations` — and, as far as a
/// re-PAINTED key goes, deliberately not a missing feature: the helper-side cache needs one because
/// ITS OWN `invalidate` has to keep bumping a generation for a coordinate it may have evicted long
/// ago, so a later re-paint never appears to regress. This store never paints anything; every
/// generation number it will ever see arrives ALREADY DECIDED, stamped on the incoming `onTile` push
/// by the one place that mints them (the helper's `TileCache.recordPaint`). An evicted-then-later-
/// refetched key simply gets told the current generation again over the wire — there is nothing for
/// THAT case for this side to remember.
///
/// **office-plumbing Task 8 correction**: the paragraph above used to end there, claiming "nothing to
/// remember" full stop — true for a re-painted key, false for `invalidate` itself, which this task is
/// the first to actually exercise (a reload's `.reloadDocument` effect closes the whole document
/// instead — see `evictAll`'s own doc — so `invalidate` proper stays reachable only from a genuine
/// same-docId edit, Stage B territory; T8 is what made reasoning about it precise enough to catch the
/// bug below). `invalidate` evicted a cached ENTRY but left that key's IN-FLIGHT marker untouched —
/// a request sent just before an invalidation resolves AFTER it, `ingest` has no cached generation
/// left to compare the late reply against (the entry is gone), and the late, pre-invalidation reply
/// is accepted as if it were current. Clearing the in-flight marker too (below) does not erase that
/// ONE stale frame — the reply that was already in flight still lands and still paints, once — but it
/// closes the WORSE half: without it, `keysNeedingRequest` also believes a fresh ask is still
/// outstanding and refuses to issue one, so nothing EVER corrects that one stale frame.
///
/// **What "with it" actually buys — corrected, T8 fix-round review I1**: NOT "the very next viewport
/// pass re-requests the key and the stale frame is superseded," this header's own prior claim, true
/// only in the ordering where a fresh ask is already back in flight before the late reply lands. The
/// DEFAULT ordering is the other one: the late reply is typically milliseconds away, while a fresh
/// viewport pass may never come at all — a static, non-scrolling view issues no further `.subscribe`
/// for these same candidates. When the late reply lands FIRST, `ingest` has no per-key generation
/// floor to reject it against (the entry `invalidate` removed is simply gone, not remembered as
/// stale), so it is cached exactly as if it were fresh; `keysNeedingRequest` then excludes the key
/// again — it now reads as cached, not stale — and no further pass is ever triggered to re-ask for
/// it. On a static viewport the stale frame is not superseded by "the next pass"; it PERSISTS until
/// something else independently touches that key: another `invalidate` covering it, LRU pressure
/// evicting it, or the whole docId being evicted (`evictAll`).
///
/// A full per-key ledger (reject any arrival at or below an invalidated generation, closing even the
/// one stale frame) was considered and set aside: Stage A never calls `invalidate` at all, so there is
/// no live call site to justify the extra bookkeeping against yet — this is deliberately the cheaper
/// half of the review's own either/or. Whenever that ledger is built (Stage B), mind `ingest`'s own
/// unconditional `inFlight.remove(k)` above: a rejected arrival would still clear the in-flight marker
/// regardless of whether it is accepted, handing `keysNeedingRequest` a key that reads as immediately
/// re-askable — `markRequested`'s own header closes this same duplicate-request window on the SEND
/// side; a naive reject-and-return-false rule here would reopen its receive-side mirror.
///
/// The RELOAD path's own version of "a reply arrives for something this store has moved on from" is
/// closed differently, and completely, by construction rather than by a ledger: a reload always mints
/// a NEW docId (T6 review F4), and `evictAll(docId:)` — called synchronously, before the new open
/// even starts (`OfficeRuntime.perform`'s `.reloadDocument` case) — clears the OLD docId's entries,
/// in-flight markers AND pending-arrival record all at once. A reply that was in flight for the OLD
/// docId and resolves after that can still be `ingest`ed (this store does not track "which docIds are
/// still open" — nothing stops it), but the entry it (re-)creates is addressed under a `Key` nothing
/// downstream ever looks up again: the canvas that used to read that docId has already moved on to
/// the new one (`OfficeTileCanvasView.syncDocumentIdentity`), and a fresh open never reuses a retired
/// docId. The phantom entry is genuinely inert dead weight, not a correctness hazard — bounded by the
/// LRU cap like anything else here, never read, never confused for the new document's own entries
/// (different `docId` in the key). `testALateArrivalForAClosedDocIdCannotContaminateAFreshDocIds
/// Entries` is the proof.
@MainActor
final class OfficeTileStore {
    struct Key: Hashable {
        var docId: String
        var tileKey: TileKey
    }

    struct Entry {
        var generation: Int
        var pixels: Data
    }

    let capacity: Int

    private var entries: [Key: Entry] = [:]
    /// Least-recently-used FIRST — mirrors `TileCache.lruOrder` exactly (touched by both a fresh
    /// `ingest` and a `tile(docId:key:)` read-hit).
    private var lruOrder: [Key] = []
    /// **Requested-but-not-yet-resolved keys** — the in-flight half of the request-filtering door
    /// (`keysNeedingRequest`). Without this, a viewport re-subscribe during the ~0.8-0.9s cold fill
    /// (obligation 4) re-requests every tile still in flight on each throttle tick, since
    /// `entries` alone has nothing to say about a key whose pixels simply haven't arrived yet —
    /// the exact "big batch pins the connection" amplifier obligation 3 warns against. Cleared for a
    /// key the moment its outcome arrives (`onTile` OR `onTileFailed` — `OfficeHelperClient
    /// .requestTiles`'s own doc: refuse-never-ignore guarantees exactly one of the two per requested
    /// key), and swept wholesale by `evictAll`/`evictEverything` for the cases where an outcome can
    /// no longer be trusted to arrive at all (a closed document, a dead helper — see their own doc).
    private var inFlight: Set<Key> = []

    /// Coalesced arrival signal — accumulated per `docId` between run-loop turns and flushed once,
    /// mirroring `EditorViewportHostView.applyAfterUpdate`'s own `DispatchQueue.main.async` +
    /// boolean-guard coalescing shape (obligation 3: "coalesce redraws"). Carries WHICH keys changed
    /// (arrived or were invalidated) so a subscriber can redraw just those tiles rather than its
    /// whole visible set — never carries pixel bytes.
    let tilesArrived = PassthroughSubject<(docId: String, keys: Set<TileKey>), Never>()
    private var pendingArrivals: [String: Set<TileKey>] = [:]
    private var flushScheduled = false

    init(capacity: Int = 64) {
        self.capacity = max(1, capacity)
    }

    // MARK: - Reads

    /// A cache hit (marks `key` most-recently-used) or `nil` on a miss.
    func tile(docId: String, key: TileKey) -> Entry? {
        let k = Key(docId: docId, tileKey: key)
        guard let entry = entries[k] else { return nil }
        touch(k)
        return entry
    }

    /// Which of `candidates` are worth asking the helper for right now — neither already cached nor
    /// already in flight. The caller (`OfficeRuntime.perform`'s `.subscribe` case) sends exactly this
    /// list to `requestTiles`, never the full `subscribeTiles` reply verbatim — see this type's own
    /// header and obligation 3.
    func keysNeedingRequest(docId: String, candidates: [TileKey]) -> [TileKey] {
        candidates.filter { candidate in
            let k = Key(docId: docId, tileKey: candidate)
            return entries[k] == nil && !inFlight.contains(k)
        }
    }

    // MARK: - Test/debug visibility only

    var cachedCountForTesting: Int { entries.count }
    var inFlightCountForTesting: Int { inFlight.count }
    var lruOrderForTesting: [Key] { lruOrder }

    // MARK: - Writes

    /// Record that `keys` are ABOUT to be handed to `requestTiles` — call this SYNCHRONOUSLY, in the
    /// same uninterrupted stretch of actor-isolated code that decides to send, BEFORE the `await`
    /// that actually performs the wire call (see `OfficeRuntime.perform`'s `.subscribe` case). This
    /// was originally written the other way round ("call this after the send succeeds"), which reads
    /// naturally but is wrong: it leaves a window, for the full length of the wire round trip, where
    /// `keysNeedingRequest` cannot see these keys as in flight — an ordinary overlapping subscribe
    /// during continuous scroll (the throttle tick, or the shared queue's own latency, outrunning a
    /// single round trip) then sees them as still unrequested and issues a duplicate `requestTiles`
    /// call, each duplicate lengthening the queue's own backlog. Marking before the `await` closes
    /// that window structurally — nothing else can run on the same actor between the decision to
    /// send and this call, since there is no suspension point in between.
    ///
    /// The other half of this contract is the caller's: if the send throws, the caller MUST call
    /// `markFailed` for every key passed here. This call has no way to tell "sent, awaiting a reply"
    /// apart from "never sent" on its own — a throw that skips `markFailed` stands the keys in flight
    /// forever, exactly as a genuinely successful, still-outstanding request would.
    func markRequested(docId: String, keys: [TileKey]) {
        for key in keys { inFlight.insert(Key(docId: docId, tileKey: key)) }
    }

    /// A tile's pixels arrived (`OfficeHelperClient.onTile`). `false`, and nothing recorded, when
    /// `generation` is STALE — strictly less than an already-cached entry's own — which the wire's
    /// single ordered connection should never actually produce (see this type's own header), but
    /// costs nothing to guard: never let an out-of-order arrival regress what is on screen.
    @discardableResult
    func ingest(docId: String, key: TileKey, generation: Int, pixels: Data) -> Bool {
        let k = Key(docId: docId, tileKey: key)
        inFlight.remove(k)
        if let existing = entries[k], existing.generation > generation { return false }
        entries[k] = Entry(generation: generation, pixels: pixels)
        touch(k)
        evictIfNeeded()
        markDirty(docId: docId, key: key)
        return true
    }

    /// A tile request came back refused (`OfficeHelperClient.onTileFailed`) — nothing to cache, but
    /// the key is resolved and must stop blocking a future request for it.
    func markFailed(docId: String, key: TileKey) {
        inFlight.remove(Key(docId: docId, tileKey: key))
    }

    /// Server-pushed invalidation (`OfficeHelperClient.onInvalidated`) — evict the matching entries
    /// (their pixels are stale; the canvas returns to the placeholder tone until a fresh paint
    /// arrives) and signal the change. Stage A never actually fires this (T4/T5.5's own honest null —
    /// no edit verbs exist yet) but the store implements it faithfully rather than leaving it as a
    /// TODO, since Stage B's first live edit needs exactly this behavior already proven.
    func invalidate(docId: String, keys: [TileKey]) {
        var changed: Set<TileKey> = []
        for key in keys {
            let k = Key(docId: docId, tileKey: key)
            let hadEntry = entries.removeValue(forKey: k) != nil
            if hadEntry { lruOrder.removeAll { $0 == k } }
            // office-plumbing Task 8 (the store header's own correction, above): a key can be
            // invalidated while a request for it is still outstanding, with NOTHING cached yet
            // (`hadEntry == false`) — clearing the marker here is what lets the NEXT viewport pass
            // ask for it again instead of believing, forever, that an ask is still in flight.
            let wasInFlight = inFlight.remove(k) != nil
            if hadEntry || wasInFlight { changed.insert(key) }
        }
        guard !changed.isEmpty else { return }
        pendingArrivals[docId, default: []].formUnion(changed)
        scheduleFlush()
    }

    /// A document closed (`OfficeRuntime.perform`'s `.helperClose` case, and per-doc in
    /// `performTeardown`) — every entry, in-flight marker and pending-arrival record for `docId` is
    /// unreachable from this point on (a fresh open mints a fresh `docId`, never reused), so this
    /// releases the pixels rather than letting them sit as dead weight for the rest of the process.
    func evictAll(docId: String) {
        entries = entries.filter { $0.key.docId != docId }
        lruOrder.removeAll { $0.docId == docId }
        inFlight = inFlight.filter { $0.docId != docId }
        pendingArrivals.removeValue(forKey: docId)
    }

    /// The shared helper died or never came up (`OfficeRuntime.handle(supervisorEvent:)`) — the
    /// reducer wipes EVERY open document for this runtime in the same transition (`OfficeRuntimeState
    /// .documents` -> `[:]`), so every `docId` this store still holds is now equally unreachable, not
    /// just the one a plain `evictAll` would target. This is also what prevents a genuinely
    /// PERMANENT wedge: an in-flight key whose connection just died will never receive its
    /// `onTile`/`onTileFailed` resolution (the guarantee `keysNeedingRequest`'s own header leans on),
    /// so without this sweep that key would sit "in flight" forever and its tile would never be
    /// re-requested even after a fresh open.
    func evictEverything() {
        entries.removeAll()
        lruOrder.removeAll()
        inFlight.removeAll()
        pendingArrivals.removeAll()
    }

    // MARK: - LRU

    private func touch(_ key: Key) {
        lruOrder.removeAll { $0 == key }
        lruOrder.append(key)
    }

    private func evictIfNeeded() {
        while entries.count > capacity, !lruOrder.isEmpty {
            let victim = lruOrder.removeFirst()
            entries.removeValue(forKey: victim)
        }
    }

    // MARK: - Coalescing

    private func markDirty(docId: String, key: TileKey) {
        pendingArrivals[docId, default: []].insert(key)
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.async { [weak self] in self?.flush() }
    }

    private func flush() {
        flushScheduled = false
        let batch = pendingArrivals
        pendingArrivals.removeAll()
        for (docId, keys) in batch where !keys.isEmpty {
            tilesArrived.send((docId: docId, keys: keys))
        }
    }
}
