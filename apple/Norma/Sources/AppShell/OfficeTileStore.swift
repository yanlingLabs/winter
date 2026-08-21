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
/// **Office Stage B Task 4 — the ledger IS built now: `invalidatedWhileInFlight`, one shot per key.**
/// The paragraph above used to end "considered and set aside... no live call site to justify it
/// yet" — Task 4 is that live call site, the first real edit-triggered `invalidate` this store has
/// ever actually received. The design below is the resolution the paragraph above already warned
/// any future ledger would have to reckon with: **`ingest`'s own unconditional `inFlight.remove(k)`
/// is what a naive reject-and-return-false rule would have reopened.**
///
/// The mechanism: `invalidate`, on a key that IS currently in flight, does two things — evicts the
/// cached entry (unchanged) and marks the key `invalidatedWhileInFlight`, but does **NOT** clear
/// `inFlight` for it. `keysNeedingRequest` therefore still reads the key as "already asked for" —
/// a SECOND request is refused, not merely discouraged — for as long as the one outstanding request
/// remains unresolved. `ingest` checks `invalidatedWhileInFlight` FIRST, before its generation
/// check: if the key is marked, this arrival is rejected outright (not cached, `false` returned),
/// the one-shot marker is consumed (removed), and — only now — `inFlight` is cleared too, letting
/// the NEXT ask through. `markFailed` (the request resolves via `.tileFailed` instead of `.tile`)
/// clears the SAME marker for the SAME reason: either resolution consumes the one-shot state.
///
/// **This is NOT the pre-T8 bug returning under a new name — the two are opposite in exactly the
/// way that matters.** The pre-T8 bug left `inFlight` set by OMISSION, forever, with nothing in
/// this store ever scheduled to clear it — a genuine permanent wedge. Task 4's design leaves
/// `inFlight` set DELIBERATELY, for the bounded window until the one already-in-flight request
/// resolves (typically milliseconds — see the liveness argument below), at which point `ingest`/
/// `markFailed` clear it unconditionally as part of normal resolution handling, the same call
/// shape every other key's resolution already goes through. Same OBSERVABLE state for a few
/// milliseconds; categorically different GUARANTEE.
///
/// **Why NOT clear `inFlight` immediately at invalidate time (the obvious-looking alternative, and
/// this type's own prior behavior)**: it reopens exactly the duplicate-request ambiguity this
/// header already named as the risk. If a second request for the SAME key were allowed to go out
/// before the first (now-stale) one resolves, this store would have TWO logically distinct replies
/// converging on ONE `Key` with no request-id to tell them apart. Whichever arrives FIRST cannot be
/// told "stale" from "fresh" by inspection alone — a naive one-shot-reject-the-next-arrival rule
/// would, in the ordering where the FRESH reply lands first, reject the correct pixels and then
/// accept the actually-stale ones right after: worse than doing nothing. Blocking re-asks until the
/// one guaranteed resolution lands (refuse-never-ignore, per key, is the wire's own contract) keeps
/// exactly one reply in flight per key at all times, so "the next arrival" is never ambiguous about
/// which request it answers.
///
/// **The liveness argument — this does not reintroduce a permanent wedge.** The paragraph two above
/// this one already worried about that shape (the pre-T8 bug this store's own history opens with).
/// Three independent guarantees close it here: (1) refuse-never-ignore means a genuinely-sent
/// request gets EXACTLY ONE of `onTile`/`onTileFailed`, so the one-shot marker's consuming
/// resolution is always coming, typically within milliseconds (this store's own prior-paragraph
/// observation about the DEFAULT ordering, unchanged); (2) `markFailed` clears the marker exactly
/// like `ingest`'s rejection path does, so a failed (not merely stale) resolution still unblocks
/// the key; (3) `evictAll`/`evictEverything` (the connection-died/document-closed safety nets
/// `keysNeedingRequest`'s own header already leans on for the identical reason) sweep
/// `invalidatedWhileInFlight` alongside `inFlight` — a request that will NEVER resolve because its
/// whole connection died cannot leave a key wedged either.
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

    /// office live-gate fix #3 — whole-document tile residency's own eligibility ceiling: the most
    /// tiles `OfficeTileCanvasView`'s prefetch will ever treat one open document as small enough to
    /// hold WHOLLY resident. Lives here, not on the view, so `defaultCapacity` right below (and
    /// `OfficeRuntime`'s construction of this store, which just takes the default) can reference the
    /// SAME number without a reverse dependency from this type onto the view layer.
    ///
    /// **Memory argument**: `TileMath.bytesPerTile` is exactly 1&nbsp;MiB (512x512 RGBA). The T6
    /// review's own ledger (`task-6-report.md`) sized this store's ORIGINAL default at 64 tiles
    /// (64&nbsp;MiB) as enough for a single scrolling viewport — it does not derive that number from
    /// a stated RAM percentage, only from this same per-tile unit cost. 128 continues that identical
    /// order-of-magnitude reasoning (double, still a small, fixed footprint for one open document in
    /// a native Mac app) rather than inventing an unrelated budget; picked at the upper end of the
    /// live-gate brief's own suggested 96-128 range so the widest range of real documents qualify.
    static let residencyCapTiles = 128
    /// office live-gate fix #3 — this store's own default capacity, raised from the original 64 to
    /// `residencyCapTiles` PLUS headroom. **Disclosed, not eliminated, limitation**: this store is
    /// SHARED across every open document in one `OfficeRuntime` (this type's own header, above,
    /// unchanged by this task) — sizing it to EXACTLY the residency cap would let a second tab's
    /// ordinary lazy viewport fetches immediately start evicting a first tab's freshly-resident set
    /// through the same LRU the moment the user switches tabs. The headroom softens the common case
    /// (one other tab's own visible+margin viewport, a handful of tiles, coexisting without
    /// immediately cannibalizing a resident document) but is not enough for a SECOND fully-resident
    /// document at the same time — a bounded-scope limitation, not a bug. Nothing re-triggers a
    /// displaced document's own prefetch merely because the store quietly evicted some of its tiles
    /// later (`OfficeTileCanvasView.evaluateResidencyIfNeeded`'s own memoization) — a document
    /// evicted this way silently degrades to viewport+margin lazy mode until its part/zoom next
    /// changes, self-healing via the ordinary margin ask rather than via a fresh whole-doc sweep.
    static let defaultCapacity = residencyCapTiles + 32

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
    /// Office Stage B Task 4 — the one-shot rejection set: a key currently in `inFlight` that a
    /// real `invalidate` ALSO touched. See this type's own header for the full mechanism and why
    /// this deliberately does NOT clear `inFlight` for the key it names — `ingest`/`markFailed` are
    /// the only two places that ever remove an entry, each consuming it as part of resolving the
    /// one outstanding request the marker exists to distrust.
    private var invalidatedWhileInFlight: Set<Key> = []

    /// Coalesced arrival signal — accumulated per `docId` between run-loop turns and flushed once,
    /// mirroring `EditorViewportHostView.applyAfterUpdate`'s own `DispatchQueue.main.async` +
    /// boolean-guard coalescing shape (obligation 3: "coalesce redraws"). Carries WHICH keys changed
    /// (arrived or were invalidated) so a subscriber can redraw just those tiles rather than its
    /// whole visible set — never carries pixel bytes.
    let tilesArrived = PassthroughSubject<(docId: String, keys: Set<TileKey>), Never>()
    private var pendingArrivals: [String: Set<TileKey>] = [:]
    private var flushScheduled = false

    init(capacity: Int = OfficeTileStore.defaultCapacity) {
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
    /// Office Stage B Task 4 — test/debug visibility only, mirrors `inFlightCountForTesting`'s own
    /// posture for the new one-shot set.
    var invalidatedWhileInFlightCountForTesting: Int { invalidatedWhileInFlight.count }

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

    /// A tile's pixels arrived (`OfficeHelperClient.onTile`). Office Stage B Task 4 — checks the
    /// one-shot `invalidatedWhileInFlight` marker FIRST, before the (unchanged) generation check:
    /// if this key was invalidated while THIS reply was still outstanding, the arrival is a known-
    /// stale frame — rejected outright (`false`, not cached), the marker consumed, and `inFlight`
    /// cleared as part of the SAME resolution (see this type's own header for why `inFlight`
    /// deliberately stayed set until exactly this moment). `false` also, unchanged from before this
    /// task, when `generation` is STALE relative to an already-cached entry — the wire's single
    /// ordered connection should never actually produce that shape (see this type's own header),
    /// but costs nothing to guard: never let an out-of-order arrival regress what is on screen.
    @discardableResult
    func ingest(docId: String, key: TileKey, generation: Int, pixels: Data) -> Bool {
        let k = Key(docId: docId, tileKey: key)
        if invalidatedWhileInFlight.remove(k) != nil {
            inFlight.remove(k)
            return false
        }
        inFlight.remove(k)
        if let existing = entries[k], existing.generation > generation { return false }
        entries[k] = Entry(generation: generation, pixels: pixels)
        touch(k)
        evictIfNeeded()
        markDirty(docId: docId, key: key)
        return true
    }

    /// A tile request came back refused (`OfficeHelperClient.onTileFailed`) — nothing to cache, but
    /// the key is resolved and must stop blocking a future request for it. Office Stage B Task 4:
    /// also consumes `invalidatedWhileInFlight` for the SAME reason `ingest`'s rejection path does
    /// — a failed resolution is still A resolution, and must unblock the key exactly as a
    /// successful-but-rejected one does.
    func markFailed(docId: String, key: TileKey) {
        let k = Key(docId: docId, tileKey: key)
        invalidatedWhileInFlight.remove(k)
        inFlight.remove(k)
    }

    /// Server-pushed invalidation (`OfficeHelperClient.onInvalidated`) — evict the matching entries
    /// (their pixels are stale; the canvas returns to the placeholder tone until a fresh paint
    /// arrives) and signal the change. First fires for real in Office Stage B Task 4 (a genuine
    /// edit-triggered `INVALIDATE_TILES`) — the store's own header has the full account of what
    /// changed here versus Stage A's honest, never-exercised implementation.
    func invalidate(docId: String, keys: [TileKey]) {
        var changed: Set<TileKey> = []
        for key in keys {
            let k = Key(docId: docId, tileKey: key)
            let hadEntry = entries.removeValue(forKey: k) != nil
            if hadEntry { lruOrder.removeAll { $0 == k } }
            // Office Stage B Task 4 (this type's own header has the full mechanism and the
            // liveness argument): a key currently in flight is marked `invalidatedWhileInFlight`
            // and DELIBERATELY left in `inFlight` — a second, ambiguous request for the same key
            // must not go out before the one already-outstanding reply resolves. A key that was
            // NOT in flight (nothing outstanding to distrust) is unaffected by this marker either
            // way; `changed` below still fires for it exactly as it always has, off `hadEntry`.
            let wasInFlight = inFlight.contains(k)
            if wasInFlight { invalidatedWhileInFlight.insert(k) }
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
        // Office Stage B Task 4 — the identical liveness reasoning `evictEverything`'s own header
        // states just below: a closed docId's in-flight request will never resolve for THIS store
        // to observe, so a key it left `invalidatedWhileInFlight` must not stay poisoned forever
        // against a docId that no longer exists (moot for THIS docId specifically, but a leaked
        // entry here is still dead weight this sweep already exists to release).
        invalidatedWhileInFlight = invalidatedWhileInFlight.filter { $0.docId != docId }
        pendingArrivals.removeValue(forKey: docId)
    }

    /// The shared helper died or never came up (`OfficeRuntime.handle(supervisorEvent:)`) — the
    /// reducer wipes EVERY open document for this runtime in the same transition (`OfficeRuntimeState
    /// .documents` -> `[:]`), so every `docId` this store still holds is now equally unreachable, not
    /// just the one a plain `evictAll` would target. This is also what prevents a genuinely
    /// PERMANENT wedge: an in-flight key whose connection just died will never receive its
    /// `onTile`/`onTileFailed` resolution (the guarantee `keysNeedingRequest`'s own header leans on),
    /// so without this sweep that key would sit "in flight" forever and its tile would never be
    /// re-requested even after a fresh open. Office Stage B Task 4 — `invalidatedWhileInFlight` is
    /// the SAME shape of liveness hazard (a marker whose only clearing path is a resolution that
    /// can now never arrive) and gets the identical sweep, for the identical reason.
    func evictEverything() {
        entries.removeAll()
        lruOrder.removeAll()
        inFlight.removeAll()
        invalidatedWhileInFlight.removeAll()
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
