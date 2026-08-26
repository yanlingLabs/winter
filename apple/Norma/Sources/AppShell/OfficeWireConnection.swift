import Foundation
import NormaKit

/// Trips exactly once; returns `true` only for the tripping caller. A private twin of NormaKit's
/// own `UnixSocketTransport.OnceFlag` — that one is internal to NormaKit's module and not visible
/// here, so this repeats the same ten lines rather than reaching across a module boundary for
/// them.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var tripped = false
    func trip() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if tripped { return false }
        tripped = true
        return true
    }
}

/// One client connection to an office helper's Unix socket: line-buffered NDJSON framing over
/// NormaKit's `UnixSocketTransport`, plus a single-outstanding-request/response primitive with a
/// timeout. Owns no retry policy and no process lifecycle — `OfficeHelperSupervisor` layers both
/// on top. `OfficeSupervisorTests`' token-mismatch case uses this directly, with no supervisor
/// involved, to assert the WIRE PROTOCOL's own refusal behavior against the fake helper fixture.
///
/// **Two wait shapes, and only one of them is still single-outstanding.**
///
/// * `nextFrame(seq:timeout:)` — **demultiplexed**, added by office-finish Job 1. Any number may be
///   outstanding at once; each returns exactly the frame carrying its own seq and leaves every other
///   frame alone. Every `OfficeHelperClient` request uses this.
/// * `nextFrame(timeout:)` — the original **anonymous** wait: "hand me whatever arrives next."
///   Still **one outstanding at a time** (one `waiter` slot, last registration wins), which is all
///   its two remaining callers need — the supervisor's own hello handshake and the harness/test
///   hello waits, both of which own the connection exclusively at that moment.
///
/// The original header said "Only one outstanding `nextFrame` wait at a time … there is no
/// pipelining to support yet." That was true of the callers, never enforced by this class, and the
/// gap was load-bearing: two overlapping waits silently orphaned the older one (the `waiter` slot is
/// overwritten and nothing resumes the loser until its own timeout), while `OfficeHelperClient`
/// discarded any frame whose seq did not match. One interleave therefore desynchronized the whole
/// stream permanently. See `seqWaiters`' own header for the measurement.
///
/// If no waiter of either kind claims a decoded reply, it queues (`frameQueue`) for the next call —
/// bounded, and every drop is logged, since queued frames no longer self-drain.
///
/// **Why not a `TaskGroup` race against `Task.sleep` for the timeout**, which looks like the
/// obvious shape: a `for await` loop over `transport.incoming` does not actually stop when its
/// enclosing `Task` is cancelled — `AsyncStream.Iterator.next()` isn't a cancellation-checking
/// suspension point — so `group.cancelAll()` on the timeout winning leaves the reader child
/// un-finished, and `withTaskGroup` awaits every child before it can return: the whole call would
/// hang forever the first time a peer went silent instead of replying (exactly the "silent"
/// fixture mode this connection has to survive). Instead, ONE persistent reader `Task` (started in
/// `open()`, living for the connection's whole lifetime) continuously drains `transport.incoming`
/// into `frameQueue` / hands frames straight to a waiting continuation; `nextFrame`'s timeout is a
/// second, fully independent `Task.sleep` that races only via a shared `OnceFlag`-guarded
/// continuation — never via structured cancellation of the reader.
final class OfficeWireConnection: @unchecked Sendable {
    private struct PendingWait {
        let once: OnceFlag
        let continuation: CheckedContinuation<OfficeWireFrame?, Never>
    }

    private let transport: NormaTransport
    private let lock = NSLock()
    private var buffer = Data()
    /// Task 4 — how many leading bytes of `buffer` are ALREADY confirmed newline-free, while in
    /// LINE-SCANNING mode (`pendingTileHeader == nil` — see that field's own header for the other
    /// mode). Without this, the newline scan below restarted from `buffer.startIndex` on every
    /// call — fine for a short line, but a control frame CAN still be large (`subscribed`/
    /// `invalidated` report up to `TileMath.maxTilesPerRectEnumeration` keys, thousands of bytes of
    /// JSON) and can still arrive split across many `UnixSocketTransport` read chunks: each `ingest`
    /// call before the terminating newline appears would otherwise re-scan the entire buffer
    /// accumulated so far, making total scan cost quadratic in the line's length. Reset to 0 only
    /// when a line is actually consumed (`removeSubrange` shifts everything after it down to index
    /// 0, invalidating any prior "scanned up to here" offset); advanced to `buffer.count` whenever a
    /// scan finds no newline in the new tail, so the NEXT call resumes exactly where this one left
    /// off. Net effect: every byte is scanned at most once as part of finding the line it belongs
    /// to — linear in total bytes, not quadratic in chunk count.
    ///
    /// **Task 5.5 note**: this was originally written to protect a `.tile` push specifically (rung
    /// 1's base64 payload lived INSIDE the line being scanned, ~1.4MB of text). Rung 2 moves tile
    /// pixels out of any scanned line entirely (see `pendingTileHeader`) — so the quadratic risk
    /// this field guards against no longer applies to tiles at all, only to the (much smaller, but
    /// not unbounded) control frames named above. Kept for them; the reasoning narrowed, the field
    /// did not retire.
    private var scannedPrefixLength = 0
    /// Task 5.5 — non-nil exactly when the NEXT `header.byteCount` bytes of `buffer` are a `.tile`
    /// push's raw pixel payload, not another NDJSON line: set the moment a `.tile` header line
    /// decodes (`OfficeWireCodec.decodeInbound` returning `.tilePending`) and its `byteCount` passes
    /// the exact-size check (see `ingest`'s own comment on that check); cleared the moment enough
    /// bytes have accumulated to complete the payload. While non-nil, `ingest`'s scan loop does
    /// ONLY a length comparison (`buffer.count >= header.byteCount`) — **never** a newline scan or
    /// any other inspection of these bytes, because raw RGBA payload bytes routinely contain `0x0A`
    /// (the landmine the T4 review named directly: a plain newline scan cannot see past/through
    /// payload bytes to find where the payload ends or where the next real line begins).
    private var pendingTileHeader: TileWireHeader?
    private var frameQueue: [OfficeWireFrame] = []
    private var waiter: PendingWait?
    /// office-finish Job 1 — seq-keyed waiters, the demultiplexer. `waiter` above stays exactly as
    /// it was and serves the two ANONYMOUS callers that cannot name a seq up front (the
    /// supervisor's handshake, `OfficeHelperSupervisor.swift:838`, and the harness/test `hello`
    /// waits); `seqWaiters` serves `nextFrame(seq:timeout:)`, which every `OfficeHelperClient`
    /// request now uses.
    ///
    /// **Why this exists.** Before it, this connection delivered "whatever frame arrived next" to
    /// whoever happened to be waiting, and `OfficeHelperClient.expectReply` threw
    /// `.unexpectedReply` on a seq mismatch — **consuming and discarding the frame**. With two
    /// concurrent requests in flight on one connection (the shipping app has exactly one such
    /// surface today, `OfficeHarness`'s raw `supervisor?.client` calls, and instant save creates a
    /// second writer that races them) that is not merely a failed request: the discarded frame was
    /// the OTHER request's answer, so that request then starves for its full 30 s timeout, and the
    /// stream stays permanently one frame out of step. Measured cost: the office harness collapsed
    /// from 102/103 in ~155 s to 76/103 in 442 s from a single interleave.
    ///
    /// **Soundness rests on seq uniqueness**, which is why `OfficeWireSeqAllocator.nextSeq()` is now
    /// lock-guarded (`OfficeWire.swift`) — it was a bare `var next: UInt64` whose only protection was
    /// that every production caller happened to be serialized behind one FIFO. A demux keyed on a
    /// value two racing callers can both mint would misroute silently, which is strictly worse than
    /// the desync it replaces.
    private var seqWaiters: [UInt64: PendingWait] = [:]
    /// How many decoded reply frames nobody is waiting for this connection will hold before it
    /// starts dropping the oldest. Only reached by frames whose requester already timed out and
    /// walked away, so on a healthy connection it stays at 0 — 64 is "far past anything normal,
    /// still trivially small" (a control frame is bytes; tile PIXELS never enter this queue at all,
    /// they go straight to `onTile`). Before the seq demux this bound was unnecessary because the
    /// queue self-drained destructively; it is necessary now, and it logs every drop.
    private static let unclaimedFrameQueueCapacity = 64
    private var droppedUnclaimedFrames = 0
    private var streamClosed = false
    private var readerTask: Task<Void, Never>?

    /// Fired at most once, when the underlying transport reports closed — from whatever thread/
    /// queue the transport's own state machine runs on. `OfficeHelperSupervisor` hops back to
    /// `@MainActor` itself; this connection makes no isolation promises about when it fires.
    var onClosed: (@Sendable () -> Void)?

    /// Task 3 — fires for every `.documentEvent` frame this connection receives, from the
    /// reader task's own thread (no isolation promise, same as `onClosed`). **Never delivered
    /// through `nextFrame`/`frameQueue`** — see `ingest(_:)`'s own comment for the real bug this
    /// avoids: before Task 3, every frame a helper could send was a direct reply to a request this
    /// connection's single outstanding `nextFrame` waiter was already expecting. A `.documentEvent`
    /// push has no such waiter — it can arrive between two ordinary requests. Queuing it into the
    /// SAME `frameQueue` a `ping`/`open`/`close` call drains would let it be handed to whichever
    /// call is CURRENTLY awaiting a reply, failing that call with a seq mismatch while the real
    /// reply it should have gotten sits queued behind the misdelivered push — a real, reachable bug
    /// the moment async pushes exist on a connection also doing ordinary request/response traffic
    /// (proven by `testDocumentEventPushDoesNotStarveAConcurrentPingReply` in
    /// `OfficeHelperLiveTests`). Routing by CASE at ingest time, before anything touches
    /// `frameQueue`, is what keeps the two streams apart with no dependency on tracking outstanding
    /// seqs. `nil` (the default): pushes are silently dropped — correct for every Stage A caller
    /// except the one that sets this (`OfficeHelperClient`, via `OfficeHelperSupervisor`).
    var onDocumentEvent: (@Sendable (String, OfficeDocumentEvent) -> Void)?

    /// Task 4 — the same "never through `frameQueue`" routing as `onDocumentEvent` above, for the
    /// three NEW push-only frame types tiles introduce. `.subscribed`/`.unsubscribed`/
    /// `.tileRequestAccepted` are direct, seq-correlated REPLIES (awaited via the normal
    /// `nextFrame`/`expectReply` path in `OfficeHelperClient`, exactly like `opened`/`closed`) and
    /// are deliberately NOT listed here — only frames the helper sends WITHOUT a matching
    /// outstanding request need this treatment.
    // `seq` (helper-minted, per-CONNECTION — F8) leads every one of these three: unlike
    // `onDocumentEvent`'s payload, it is genuinely useful here for a caller/test wanting to reason
    // about per-connection push ordering (e.g. detecting out-of-order delivery), and costs nothing
    // to thread through since `ingest()` already has it off the decoded frame.
    var onTile: (@Sendable (UInt64, String, TileKey, Int, Int, Int, Data) -> Void)?  // seq, docId, key, generation, width, height, pixels
    var onTileFailed: (@Sendable (UInt64, String, TileKey, String) -> Void)?           // seq, docId, key, reason
    var onInvalidated: (@Sendable (UInt64, String, [TileKey]) -> Void)?                // seq, docId, keys

    init(socketPath: String) {
        transport = UnixSocketTransport(path: socketPath)
    }

    /// Connects and starts the persistent background reader. Throws whatever
    /// `UnixSocketTransport.open()` throws (including its own ~3s internal connect timeout) if the
    /// socket cannot be reached at all.
    func open() async throws {
        try await transport.open()
        let incoming = transport.incoming
        readerTask = Task { [weak self] in
            for await event in incoming {
                guard let self else { return }
                switch event {
                case .data(let data): self.ingest(data)
                case .closed: self.ingestClosed()
                }
            }
        }
    }

    func send(_ frame: OfficeWireFrame) async throws {
        try await transport.send(frame.encodedLine())
    }

    /// Bypasses `OfficeWireFrame` encoding to send arbitrary bytes — test-only (F4's regression
    /// tests construct a deliberately invalid-UTF-8 line this way; nothing in production code ever
    /// needs to send bytes that aren't a well-formed frame).
    func sendRaw(_ data: Data) async throws {
        try await transport.send(data)
    }

    /// Waits for the next frame this connection hasn't yet delivered. `nil` on timeout OR the
    /// connection closing first — callers that must tell those apart check `isClosed` afterward.
    ///
    /// **The frameQueue/streamClosed check and the waiter registration happen under ONE lock
    /// hold, inside the continuation body — not as a separate fast-path check before it.** An
    /// earlier version checked `frameQueue` first, unlocked, and only then registered the waiter
    /// inside `withCheckedContinuation`: the reader task could `ingest()` a frame in the gap
    /// between those two lock holds, see no waiter yet registered, and leave it queued —
    /// delivering nothing, so the waiter that registers a moment later starves for the full
    /// `timeout` with its answer already sitting in `frameQueue`. A real request that should have
    /// returned instantly would instead read as a timeout, intermittently. Doing both checks and
    /// the registration atomically closes that window.
    func nextFrame(timeout: TimeInterval) async -> OfficeWireFrame? {
        await withCheckedContinuation { (continuation: CheckedContinuation<OfficeWireFrame?, Never>) in
            let once = OnceFlag()
            lock.lock()
            if !frameQueue.isEmpty {
                let frame = frameQueue.removeFirst()
                lock.unlock()
                if once.trip() { continuation.resume(returning: frame) }
                return
            }
            if streamClosed {
                lock.unlock()
                if once.trip() { continuation.resume(returning: nil) }
                return
            }
            waiter = PendingWait(once: once, continuation: continuation)
            lock.unlock()

            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                self.clearWaiterIfStillPending(once)
                if once.trip() { continuation.resume(returning: nil) }
            }
        }
    }

    /// office-finish Job 1 — the demultiplexing counterpart to `nextFrame(timeout:)`: waits for the
    /// reply carrying exactly `seq`, and is unaffected by any other frame arriving first.
    ///
    /// Three things it must do that the anonymous version does not, each a real hole if skipped:
    ///
    /// 1. **Scan `frameQueue` for `seq` on entry**, not just `first`. The reply can already have
    ///    landed in the gap between `connection.send` returning and this call registering — that is
    ///    the same send→await window `nextFrame(timeout:)`'s own header describes, and it is wider
    ///    here because another request's frames may sit ahead of ours in the queue.
    /// 2. **Leave frames it does not want in the queue.** Consuming-and-discarding a mismatched
    ///    frame is precisely the bug being fixed: that frame is somebody else's answer.
    /// 3. **Register under `seq`, so `ingest` can route to it directly** rather than handing it
    ///    whatever arrived.
    func nextFrame(seq: UInt64, timeout: TimeInterval) async -> OfficeWireFrame? {
        await withCheckedContinuation { (continuation: CheckedContinuation<OfficeWireFrame?, Never>) in
            let once = OnceFlag()
            lock.lock()
            if let index = frameQueue.firstIndex(where: { $0.seq == seq }) {
                let frame = frameQueue.remove(at: index)
                lock.unlock()
                if once.trip() { continuation.resume(returning: frame) }
                return
            }
            if streamClosed {
                lock.unlock()
                if once.trip() { continuation.resume(returning: nil) }
                return
            }
            // A second wait on a seq already being awaited would silently orphan the first waiter
            // (dictionary assignment overwrites it, and nothing would ever resume it — it would
            // starve for its full timeout). That cannot happen with a correct allocator, so it is a
            // programming error, not a runtime condition: log loudly and resume the OLD waiter with
            // `nil` rather than leaving it hanging. Never silently.
            // Disclosed gap, seen and reasoned about rather than missed: this releases the lock to
            // resume the orphan and re-acquires it below WITHOUT re-scanning `frameQueue` or
            // re-checking `streamClosed` in between, so a stream that closed in that window costs
            // the new waiter its full timeout instead of an immediate `nil`. Left as is because the
            // branch is unreachable — reaching it requires the (now lock-guarded) allocator to mint
            // a duplicate seq — and because it is the loudest path in this file: the NSLog below is
            // a bug report, not a runtime condition.
            if let orphan = seqWaiters.removeValue(forKey: seq) {
                lock.unlock()
                NSLog("[OfficeWireConnection] two concurrent waits on seq %llu — the seq allocator "
                      + "minted a duplicate; failing the older wait", seq)
                if orphan.once.trip() { orphan.continuation.resume(returning: nil) }
                lock.lock()
            }
            seqWaiters[seq] = PendingWait(once: once, continuation: continuation)
            lock.unlock()

            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                self.clearSeqWaiterIfStillPending(seq, once)
                if once.trip() { continuation.resume(returning: nil) }
            }
        }
    }

    /// If `waiter` is still the one registered under `once` (i.e. `ingest`/`ingestClosed` hasn't
    /// already claimed and cleared it), clear it — so a frame arriving AFTER this timeout has
    /// already fired finds no waiter to (incorrectly) resume a second time. A plain, non-async
    /// function on purpose: `NSLock.lock()`/`.unlock()` are marked unavailable from a LEXICALLY
    /// async context (a Swift 6 error, a warning here) — calling them from inside this ordinary
    /// function, itself called from `Task { }`'s async closure, is the sanctioned way to bridge
    /// that, exactly as Apple's own migration guidance for `noasync` APIs describes.
    private func clearWaiterIfStillPending(_ once: OnceFlag) {
        lock.lock()
        if waiter?.once === once { waiter = nil }
        lock.unlock()
    }

    /// `clearWaiterIfStillPending`'s seq-keyed twin, and it must compare `once` identity rather than
    /// merely `seqWaiters[seq] != nil`: a timed-out wait on seq N and a LATER wait on the same seq N
    /// (possible only after an allocator wrap, but the check costs nothing) must not clear each
    /// other's registration.
    private func clearSeqWaiterIfStillPending(_ seq: UInt64, _ once: OnceFlag) {
        lock.lock()
        if seqWaiters[seq]?.once === once { seqWaiters.removeValue(forKey: seq) }
        lock.unlock()
    }

    var isClosed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return streamClosed
    }

    func close() {
        readerTask?.cancel()
        transport.close()
        // Do not rely on the reader task to notice `.closed` promptly — it may already be
        // cancelled, and cancellation does not interrupt a suspended `for await` (see the header
        // comment). Wake any waiter directly.
        ingestClosed()
    }

    // MARK: - Reader-side ingestion (called from the reader Task only)

    private func ingest(_ data: Data) {
        var toDeliver: OfficeWireFrame?
        var pending: PendingWait?
        var pushesToDeliver: [(String, OfficeDocumentEvent)] = []
        // Task 4 — the three new async-push shapes, collected the same way `pushesToDeliver`
        // already is (under `lock`, delivered to callbacks after `lock.unlock()` below).
        var tilesToDeliver: [(UInt64, String, TileKey, Int, Int, Int, Data)] = []
        var tileFailuresToDeliver: [(UInt64, String, TileKey, String)] = []
        var invalidationsToDeliver: [(UInt64, String, [TileKey])] = []
        // Task 5.5 — set at most once per call, the moment a `.tile` header's `byteCount` fails the
        // exact-size check below; non-nil means "tear this connection down after this scan loop."
        // Collected here (under `lock`, exactly like every delivery array above) rather than acted
        // on immediately: `close()` -> `ingestClosed()` re-enters `lock`, and `NSLock` is not
        // recursive — calling it while THIS function still holds `lock` would deadlock.
        var refusalReason: String?
        lock.lock()
        buffer.append(data)
        scanLoop: while true {
            if let header = pendingTileHeader {
                // Task 5.5 payload-accumulation mode — THE LANDMINE this rewrite exists for: these
                // bytes are NEVER scanned for anything (raw RGBA routinely contains 0x0A, which a
                // newline scan would misread as a line terminator). A pure length comparison against
                // `buffer.count` is the entire cost of this branch on every `ingest` call until
                // enough bytes have arrived — O(1) per call, so fragmentation (many small chunks)
                // cannot make this quadratic; there is no scan here to repeat.
                guard buffer.count >= header.byteCount else { break } // wait for more data to arrive
                let payloadEnd = buffer.index(buffer.startIndex, offsetBy: header.byteCount)
                let pixels = buffer.subdata(in: buffer.startIndex..<payloadEnd)
                buffer.removeSubrange(buffer.startIndex..<payloadEnd)
                scannedPrefixLength = 0 // the remaining buffer is a fresh, unscanned tail
                pendingTileHeader = nil
                tilesToDeliver.append((header.seq, header.docId, header.key, header.generation,
                                        header.width, header.height, pixels))
                continue scanLoop // more may already be buffered: the next header, even a full next tile
            }

            let searchStart = buffer.index(buffer.startIndex, offsetBy: scannedPrefixLength)
            guard let newlineIndex = buffer[searchStart...].firstIndex(of: 0x0A) else {
                scannedPrefixLength = buffer.count // nothing new to find until more bytes arrive
                break
            }
            let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
            buffer.removeSubrange(buffer.startIndex...newlineIndex)
            scannedPrefixLength = 0 // the remaining buffer is a fresh, unscanned tail
            // F4 (T2 review), client side: an undecodable line is now LOGGED, not silently
            // dropped — "your call on shape, disclose it." Logging only, not surfaced as a
            // delivered frame: this client has no reply mechanism (it isn't the one being asked
            // anything), and forcibly handing an unrelated garbage line to whichever caller is
            // CURRENTLY awaiting `nextFrame` would misattribute it to that request, which is worse
            // than the request simply timing out normally. A malformed line from the helper is
            // also a signal something is more fundamentally wrong (a protocol version mismatch, a
            // corrupted stream) that a developer should be able to see in the log, not just infer
            // from a mysteriously timed-out request.
            guard let line = String(data: lineData, encoding: .utf8) else {
                NSLog("[OfficeWireConnection] dropped a non-UTF-8 line from the helper (%d bytes)", lineData.count)
                continue scanLoop
            }
            // Task 5.5: reads via `OfficeWireCodec.decodeInbound` directly now, not
            // `OfficeWireFrame.decode` — the plain `decode` collapses `.tilePending` to `nil`
            // (correctly, per its own contract: a tile header alone is not a complete frame), which
            // is exactly the case THIS function must see distinctly to enter payload-accumulation
            // mode. See `OfficeWireInbound`'s own header for the full reasoning.
            switch OfficeWireCodec.decodeInbound(line) {
            case .frame(let frame):
                // Task 3/4: unprompted PUSHES never go into `frameQueue` — routed straight to
                // their own dedicated callback (see `onDocumentEvent`/`onTile`/`onTileFailed`/
                // `onInvalidated`'s own headers for the real interleaving bug this avoids).
                // Collected here, under THIS lock hold; delivered after `lock.unlock()` below —
                // never invoke an arbitrary caller-supplied closure while holding `lock`.
                switch frame {
                case .documentEvent(_, let docId, let event):
                    pushesToDeliver.append((docId, event))
                case .tile:
                    // Unreachable by construction (Task 5.5): `decodeInbound` never produces
                    // `.frame(.tile(...))` anymore — a `"tile"` line always decodes to
                    // `.tilePending` instead, handled in the case below. Listed explicitly (not
                    // folded into `default`) and logged rather than silently queued: `frameQueue`
                    // is exactly the misattribution hazard `onTile`'s own header warns against for
                    // every other push type, so a future decode regression that somehow
                    // reintroduces this shape must not silently re-open that hazard for tiles too.
                    NSLog("[OfficeWireConnection] unreachable: decodeInbound produced .frame(.tile) "
                          + "— dropping rather than risking frameQueue misattribution")
                case .tileFailed(let seq, let docId, let key, let reason):
                    tileFailuresToDeliver.append((seq, docId, key, reason))
                case .invalidated(let seq, let docId, let keys):
                    invalidationsToDeliver.append((seq, docId, keys))
                default:
                    frameQueue.append(frame)
                }
            case .tilePending(let header):
                // Task 5.5 — exact-size-or-refuse (the T4 review's own byteCount-cap precedent,
                // applied client-side): every tile this system paints today is EXACTLY
                // `TileMath.bytesPerTile` (512x512 RGBA, 1 MiB — see that constant's own doc
                // comment). `byteCount == 0` is refused by this SAME rule, not a special case — it
                // is simply not the one legal size, so "is zero legal" needs no separate answer
                // (the brief's own "byteCount 0 — legal? define" is answered HERE: no, uniformly).
                // A disagreeing `byteCount` — zero, truncated/lying, or hostile-huge — is not a
                // size this reader will ever wait to accumulate: honoring it either desyncs
                // framing (a wrong-but-plausible count makes the NEXT header start at the wrong
                // offset once payload bytes finally stop, or never) or, for a huge value, blocks
                // indefinitely accumulating bytes that may never arrive while holding an unbounded
                // buffer — the exact DoS shape `TileMath.maxTilesPerRectEnumeration`/
                // `isZoomPPTValid` already refuse server-side for the identical reason. There is no
                // reply mechanism for a push (refuse-never-ignore's usual "answer with an error
                // frame" has nothing to answer INTO here), so the only thing left to refuse is the
                // connection itself — recorded here, acted on after this scan loop and after
                // `lock.unlock()` (see `refusalReason`'s own declaration above).
                guard header.byteCount == TileMath.bytesPerTile else {
                    refusalReason = "tile byteCount \(header.byteCount) != \(TileMath.bytesPerTile) "
                        + "(docId=\(header.docId) key=\(header.key))"
                    break scanLoop // stop trusting this stream; nothing after this line can be framed safely
                }
                pendingTileHeader = header
            case .tileHeaderMalformed(let seq, let reason):
                // Wave fix (T5.5 review Minor-B) — same refusal shape as the byteCount-mismatch
                // branch right above, for the same reason: a `"tile"` line whose OWN structure
                // failed to decode may still have raw payload bytes following it on the wire (see
                // `OfficeWireInbound.tileHeaderMalformed`'s own header), and there is no `byteCount`
                // to trust even if there were — nothing safe to do except stop scanning immediately.
                // Falling through to `.rejected`'s "log and keep scanning" would newline-scan
                // straight into those bytes hunting for `0x0A`, exactly the garbage-line storm this
                // case exists to prevent.
                refusalReason = "tile header (seq=\(seq)) failed to decode: \(reason)"
                break scanLoop
            case .rejected, .unreadable:
                NSLog("[OfficeWireConnection] dropped an undecodable line from the helper: %@", line)
            }
        }
        // office-finish Job 1 — the demux, in the one place frames become available.
        //
        // Order matters and is deliberate: a frame whose seq a caller is explicitly waiting for goes
        // to THAT caller, and only what nobody claimed by seq is offered to the anonymous waiter.
        // The reverse order would re-open the whole bug — the anonymous waiter (the handshake) would
        // swallow a reply a concurrent request had already asked for by name.
        //
        // Every claimed frame is collected here, under THIS lock hold, and resumed after
        // `lock.unlock()` below — the same discipline the push arrays above already follow, for the
        // same reason (never resume a continuation, or invoke a caller closure, while holding
        // `lock`). Collecting ALL of them rather than one is not an optimisation: `ingest` routinely
        // decodes several lines from a single read chunk, and the previous code delivered at most
        // one frame per call. With one waiter that was harmless (the next `nextFrame` drained the
        // queue itself); with N seq waiters it would leave N-1 of them asleep until the next chunk
        // arrived — which, if this chunk contained every outstanding reply, is never.
        var seqDeliveries: [(PendingWait, OfficeWireFrame)] = []
        if !seqWaiters.isEmpty {
            var unclaimed: [OfficeWireFrame] = []
            unclaimed.reserveCapacity(frameQueue.count)
            for frame in frameQueue {
                if let pendingWait = seqWaiters.removeValue(forKey: frame.seq) {
                    seqDeliveries.append((pendingWait, frame))
                } else {
                    unclaimed.append(frame)
                }
            }
            frameQueue = unclaimed
        }
        if waiter != nil, !frameQueue.isEmpty {
            toDeliver = frameQueue.removeFirst()
            pending = waiter
            waiter = nil
        }
        // Nothing claimed these: either a reply to a request that already timed out and walked away,
        // or a reply nobody ever asked for. Before the demux they were self-draining — the next
        // `expectReply` consumed one and threw — so the queue could not grow. Now they persist, so
        // they need a bound, and the bound needs a VOICE: a silently dropped frame is the
        // guard-that-degrades-silently failure this file's own headers keep naming. Dropping the
        // OLDEST is the right end: the newest unclaimed frame is the one most likely to still be
        // wanted.
        while frameQueue.count > Self.unclaimedFrameQueueCapacity {
            let dropped = frameQueue.removeFirst()
            droppedUnclaimedFrames += 1
            NSLog("[OfficeWireConnection] unclaimed frame queue exceeded %d — dropped the oldest "
                  + "(seq %llu); %d dropped on this connection so far",
                  Self.unclaimedFrameQueueCapacity, dropped.seq, droppedUnclaimedFrames)
        }
        lock.unlock()
        for (pendingWait, frame) in seqDeliveries where pendingWait.once.trip() {
            pendingWait.continuation.resume(returning: frame)
        }
        for (docId, event) in pushesToDeliver {
            onDocumentEvent?(docId, event)
        }
        for (seq, docId, key, generation, width, height, pixels) in tilesToDeliver {
            onTile?(seq, docId, key, generation, width, height, pixels)
        }
        for (seq, docId, key, reason) in tileFailuresToDeliver {
            onTileFailed?(seq, docId, key, reason)
        }
        for (seq, docId, keys) in invalidationsToDeliver {
            onInvalidated?(seq, docId, keys)
        }
        if let pending, let toDeliver, pending.once.trip() {
            pending.continuation.resume(returning: toDeliver)
        }
        // Task 5.5 + wave — refuse-never-ignore for BOTH tile-refusal sources (a well-formed
        // header whose byteCount is not exactly bytesPerTile, and a "tile"-typed line that fails
        // structural decode entirely): this connection cannot be
        // trusted to still be in sync (see the `.tilePending` case above), so it is torn down the
        // same way any other fatal transport condition is. `close()` wakes any pending waiter with
        // `nil` and fires `onClosed`, which `OfficeHelperSupervisor`'s death-detection turns into
        // `.helperDied` exactly as it would for a real crash — the honest, if slightly surprising,
        // observable outcome of "the helper's own wire framing can no longer be trusted." Called
        // AFTER `lock.unlock()` above — see `refusalReason`'s own declaration for why.
        if let refusalReason {
            NSLog("[OfficeWireConnection] refusing connection: %@", refusalReason)
            close()
        }
    }

    private func ingestClosed() {
        lock.lock()
        let alreadyClosed = streamClosed
        streamClosed = true
        let pending = waiter
        waiter = nil
        // office-finish Job 1 — EVERY seq waiter, not just the anonymous one. Missing this is the
        // difference between "the helper died and every in-flight request learns so immediately"
        // and "every in-flight request hangs for its full 30 s timeout on a socket that is already
        // gone" — and the save-liveness landmine (a save's bound is per queued request plus
        // backlog) makes that difference user-visible, not merely slow.
        let orphanedSeqWaiters = Array(seqWaiters.values)
        seqWaiters.removeAll()
        lock.unlock()
        if let pending, pending.once.trip() {
            pending.continuation.resume(returning: nil)
        }
        for orphan in orphanedSeqWaiters where orphan.once.trip() {
            orphan.continuation.resume(returning: nil)
        }
        guard !alreadyClosed else { return }
        onClosed?()
    }
}
