import Foundation
import Security
#if canImport(Darwin)
import Darwin
#endif

/// A completed office-helper request whose reply didn't match what was expected: a timeout, a
/// server-side refusal (`error{reason}`), or a structurally different frame than the one call
/// site's own request type ever produces in a correct implementation.
enum OfficeHelperClientError: Error, CustomStringConvertible, Equatable {
    case timedOut
    case serverError(reason: String)
    case unexpectedReply(OfficeWireFrame)
    /// Task 3 — a document-shaped failure (garbage file, unreadable path, ...), kept distinct from
    /// `.serverError` (a protocol-level refusal: bad token, malformed frame, `alreadyOpen`, ...) so
    /// a caller can tell "this document is bad" apart from "something is wrong with the
    /// connection/protocol" without string-matching `reason`. The brief's own garbage-survival test
    /// needs exactly this discrimination: assert THIS case, not merely "open() threw something."
    case openFailed(reason: String)
    /// Office Stage B Task 2 — a document-shaped `saveAs` failure (an unsupported format, a genuine
    /// disk problem under the helper's own `--state-path`), kept distinct from `.serverError` for
    /// the same reason `.openFailed` is: a caller can tell "this save failed for a reason about the
    /// DOCUMENT" apart from "something is wrong with the connection/protocol" without string-
    /// matching `reason`.
    case saveFailed(reason: String)

    var description: String {
        switch self {
        case .timedOut: return "office helper request timed out"
        case .serverError(let reason): return "office helper refused: \(reason)"
        case .unexpectedReply(let frame): return "office helper sent an unexpected reply: \(frame)"
        case .openFailed(let reason): return "office helper could not open the document: \(reason)"
        case .saveFailed(let reason): return "office helper could not save the document: \(reason)"
        }
    }
}

/// The app-role verbs the brief specified as `OfficeHelperXPC` (`open`/`close`/`ping`), over the
/// live authenticated connection `OfficeHelperSupervisor` builds — see `OfficeWire.swift`'s header
/// for why this is a socket client, not an `NSXPCConnection`-vended protocol object. One
/// `OfficeWireSeqAllocator` per client keeps every outbound request on this connection uniquely
/// numbered, so a reply is always checked against the seq that provoked it before being trusted.
final class OfficeHelperClient {
    private let connection: OfficeWireConnection
    private let seqAllocator: OfficeWireSeqAllocator
    private let requestTimeout: TimeInterval

    /// Task 3 — every `.documentEvent` push this connection receives, forwarded from
    /// `OfficeWireConnection.onDocumentEvent` (see that property's own header: pushes bypass the
    /// request/reply path entirely, so this fires independently of `ping`/`open`/`close` calls).
    /// Settable, not an `AsyncStream` (carry: don't add more single-consumer coupling than the
    /// brief already has, but don't build multicast yet either — Task 4's job). `nil` by default.
    var onDocumentEvent: ((String, OfficeDocumentEvent) -> Void)? {
        didSet { connection.onDocumentEvent = { [onDocumentEvent] docId, event in onDocumentEvent?(docId, event) } }
    }

    /// Task 4 — the tile-pipeline counterparts to `onDocumentEvent` above, same settable-closure
    /// shape (not an `AsyncStream`, same carry-driven restraint) proxied straight through to the
    /// underlying `OfficeWireConnection`'s own dedicated push callbacks.
    var onTile: ((UInt64, String, TileKey, Int, Int, Int, Data) -> Void)? {
        didSet { connection.onTile = { [onTile] seq, docId, key, generation, width, height, pixels in
            onTile?(seq, docId, key, generation, width, height, pixels)
        } }
    }
    var onTileFailed: ((UInt64, String, TileKey, String) -> Void)? {
        didSet { connection.onTileFailed = { [onTileFailed] seq, docId, key, reason in onTileFailed?(seq, docId, key, reason) } }
    }
    var onInvalidated: ((UInt64, String, [TileKey]) -> Void)? {
        didSet { connection.onInvalidated = { [onInvalidated] seq, docId, keys in onInvalidated?(seq, docId, keys) } }
    }

    init(connection: OfficeWireConnection, seqAllocator: OfficeWireSeqAllocator, requestTimeout: TimeInterval) {
        self.connection = connection
        self.seqAllocator = seqAllocator
        self.requestTimeout = requestTimeout
    }

    /// Awaits the next frame and requires its `seq` to match `seq` before returning it — checked
    /// for EVERY reply shape, including `.error` (F7, T2 review). Previously only the success arms
    /// (`.pong`/`.opened`/`.closed`) checked `replySeq == seq`, via a `case ... where` guard;
    /// `.error` matched on TYPE alone, so a stale error reply left over from an earlier,
    /// already-abandoned request on this connection could be misattributed as belonging to
    /// whatever request is CURRENTLY awaiting a reply — this connection supports only one
    /// outstanding wait at a time (`OfficeWireConnection`'s own header), but a reply to a TIMED-OUT
    /// request can still arrive late and queue, exactly the shape that made this reachable. A seq
    /// mismatch — of any frame type, `.error` included — throws `.unexpectedReply`, never
    /// `.serverError`: only a same-seq `.error` is genuinely this request's own answer.
    private func expectReply(seq: UInt64) async throws -> OfficeWireFrame {
        guard let reply = await connection.nextFrame(timeout: requestTimeout) else {
            throw OfficeHelperClientError.timedOut
        }
        guard reply.seq == seq else { throw OfficeHelperClientError.unexpectedReply(reply) }
        return reply
    }

    func ping() async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.ping(seq: seq))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .pong: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Task 3: `open` is real — loads the document via the helper's `LOKBridge` and returns its
    /// metadata. `.error(reason:"alreadyOpen")` (this task's own double-open ruling — see
    /// `OfficeHelperServer.handlePostAuthLine`'s own comment) surfaces as `.serverError`, same as
    /// any other protocol-level refusal; a genuine `openFailed` (garbage document, bad path)
    /// surfaces as the distinct `.openFailed` case so a caller can discriminate "this document is
    /// bad" from "something is wrong with the request itself" without string-matching.
    func open(docId: String, path: String) async throws -> OfficeDocumentMetadata {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.open(seq: seq, docId: docId, path: path))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .opened(_, _, let type, let parts, let sizeTwips):
            return OfficeDocumentMetadata(type: type, parts: parts, sizeTwips: sizeTwips)
        case .openFailed(_, _, let reason): throw OfficeHelperClientError.openFailed(reason: reason)
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Closing a doc this connection did NOT open surfaces as `.serverError(reason: "notOwner")`
    /// (F7, Task 4 review carry) — same discrimination shape as `alreadyOpen` (Task 3): a protocol-
    /// level refusal, not a document-shaped failure, so it is NOT a distinct thrown case the way
    /// `.openFailed` is.
    func close(docId: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.close(seq: seq, docId: docId))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .closed: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Office Stage B Task 2 — asks the helper to render `docId` to a temp file under ITS OWN
    /// `--state-path` and returns that path. Placing those bytes onto the real document path is
    /// entirely the CALLER's job (`OfficeRuntime.perform`'s `.save` effect) — this method's only
    /// concern is the wire round trip, exactly as `open`'s only concern is the wire round trip for
    /// loading a document.
    ///
    /// **Fix round 4 (NEW-2) — `part` added**, threaded straight onto the wire frame; see
    /// `OfficeWireFrame.save`'s own header for what it means here (the USER's active part, asserted
    /// onto LOK before the write) and `OfficeRuntimeReducer`'s `.saveRequested` for where it is
    /// resolved.
    func save(docId: String, part: Int) async throws -> String {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.save(seq: seq, docId: docId, part: part))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .saved(_, _, let tempPath): return tempPath
        case .saveFailed(_, _, let reason): throw OfficeHelperClientError.saveFailed(reason: reason)
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    // MARK: - Task 4: real input

    /// Office Stage B Task 4 — the real edit verb. Awaits only the immediate `keyEventOk` POST
    /// acknowledgment, same posture `requestTiles` already has toward its own slow, async-pushed
    /// effect: the actual edit (and whatever it invalidates) is observed later, through
    /// `onDocumentEvent`/`onInvalidated`, never through this reply.
    ///
    /// **Fix round 1, F2 — `part` added, threaded straight onto the wire frame; see
    /// `OfficeRuntime.postKeyEvent`'s own header for where it is resolved (at enqueue time, from
    /// `activePart`, the same source `subscribeTiles` already uses).**
    func postKey(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.keyEvent(seq: seq, docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .keyEventOk: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Office Stage B Task 4 — same posture as `postKey` above.
    func postMouse(docId: String, part: Int, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                   count: Int, buttons: Int, modifiers: Int) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.mouseEvent(seq: seq, docId: docId, part: part, type: type, xTwips: xTwips, yTwips: yTwips,
                                              count: count, buttons: buttons, modifiers: modifiers))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .mouseEventOk: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Office Stage B Task 5 — same posture as `postKey`/`postMouse` above: awaits only the
    /// immediate `extTextInputEventOk` POST acknowledgment, never a claim of effect.
    func postExtTextInput(docId: String, part: Int, type: OfficeExtTextInputType, text: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.extTextInputEvent(seq: seq, docId: docId, part: part, type: type, text: text))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .extTextInputEventOk: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    // MARK: - Office Stage B Task 6: clipboard, undo/redo, the second ("agent") view

    /// Reads the current text selection. `""` for "nothing selected" — never a distinct thrown
    /// case; the caller decides whether an empty answer is worth writing to the system pasteboard.
    func clipboardCopy(docId: String, part: Int) async throws -> String {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.clipboardCopy(seq: seq, docId: docId, part: part))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .clipboardCopyOk(_, _, let text): return text
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Same read as `clipboardCopy`, but the selection is also deleted on the far side.
    func clipboardCut(docId: String, part: Int) async throws -> String {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.clipboardCut(seq: seq, docId: docId, part: part))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .clipboardCutOk(_, _, let text): return text
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    func clipboardPaste(docId: String, part: Int, text: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.clipboardPaste(seq: seq, docId: docId, part: part, text: text))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .clipboardPasteOk: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// `.uno:Undo` against the document's own primary view. Answers once the command was
    /// DISPATCHED, never a claim it changed anything — see `OfficeWireFrame.undoOk`'s own header.
    func undo(docId: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.undo(seq: seq, docId: docId))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .undoOk: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    func redo(docId: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.redo(seq: seq, docId: docId))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .redoOk: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// The two-writer groundwork — mints a second ("agent") LOK view for `docId`, returning its
    /// view id. Deliberately NOT reachable from `OfficeRuntime`/`Driver` — the brief's own words
    /// are "unused by the app but drilled"; only the live characterization drill
    /// (`OfficeRuntimeLiveTests`) ever calls this, talking directly to this client, the same
    /// raw-probe precedent Task 5's ext-text-input investigation already set.
    func createAgentView(docId: String) async throws -> Int32 {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.createView(seq: seq, docId: docId))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .agentViewReady(_, _, let viewId): return viewId
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Posts a key event through the agent view specifically — same drill-only reachability as
    /// `createAgentView` above.
    func agentKeyEvent(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.agentKeyEvent(seq: seq, docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .agentKeyEventOk: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    // MARK: - Task 4: tiles

    /// Registers this connection as a tile-push subscriber for `docId` (which must already be open
    /// — by ANY connection, not necessarily this one) and returns the tile-set the CURRENT
    /// viewport needs (`TileMath.viewportTileKeys`, computed server-side so client and server can
    /// never disagree about the mapping). Produces `TileHandle`-equivalent identity for T6: the
    /// returned `[TileKey]` is exactly what a caller then feeds to `tileRequest` to fetch pixels.
    func subscribeTiles(docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect) async throws -> [TileKey] {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.subscribeTiles(seq: seq, docId: docId, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .subscribed(_, _, let keys): return keys
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    func unsubscribeTiles(docId: String) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.unsubscribe(seq: seq, docId: docId))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .unsubscribed: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }

    /// Asks for pixel data for `keys`. Only the IMMEDIATE acceptance is awaited here — each key's
    /// actual pixels (or failure) arrive later as `onTile`/`onTileFailed` pushes, exactly as many
    /// times as `keys.count` for a well-behaved helper (refuse-never-ignore, extended to per-key
    /// granularity — see `OfficeWireFrame.tileFailed`'s own header), never awaited synchronously by
    /// this method itself — painting can be slow and must not block the reply.
    func requestTiles(docId: String, keys: [TileKey]) async throws {
        let seq = seqAllocator.nextSeq()
        try await connection.send(.tileRequest(seq: seq, docId: docId, keys: keys))
        let reply = try await expectReply(seq: seq)
        switch reply {
        case .tileRequestAccepted: return
        case .error(_, let reason): throw OfficeHelperClientError.serverError(reason: reason)
        default: throw OfficeHelperClientError.unexpectedReply(reply)
        }
    }
}

/// The brief's own interface shape, kept as a top-level type (not nested inside
/// `OfficeHelperSupervisor`) exactly as named there — `events: AsyncStream<OfficeHelperEvent>` —
/// since Task 4 and later consumers are expected to match against it directly.
enum OfficeHelperEvent: Equatable, Sendable {
    case ready(lokVersion: String)
    case helperDied
    case helperUnavailable
}

/// Office Stage A Task 2 — supervises ONE `NormaOfficeHelper` process for as long as the app needs
/// it: spawns it directly (no launchd — see `OfficeWire.swift`'s header for why the brief's XPC
/// shape is deferred to Task 4), proves it alive with a `hello`/`helloOk` handshake, watches for
/// its death, and **never relaunches on its own**. "Relaunch on next demand only" (the brief's own
/// words): a helper that keeps dying must not become a hot loop competing with the user's machine
/// for CPU — the NEXT explicit `start()` call (whenever app code next needs the helper) gets its
/// own fresh 3-attempt budget, and that is the only door back in.
///
/// Renamed from the brief's `xpc: OfficeHelperXPC?` to `client: OfficeHelperClient?` — the
/// BEHAVIOR the brief specified (open/close/ping, callable once the helper is ready) is
/// unchanged; only the property name stopped implying a transport this task does not build.
@MainActor
final class OfficeHelperSupervisor {

    enum State: Equatable {
        case notStarted
        case starting
        case ready
        case stopped
    }

    struct Configuration {
        var helperExecutableURL: URL
        var socketDirectory: URL
        /// Task 3 finding, empirical (see task-3-report.md): LOK now boots BEFORE the socket even
        /// binds (main.swift's boot-sequencing — `helloOk.lokVersion` must be the real BuildId the
        /// moment the FIRST `hello` answers, carry T3-c), so this budget must absorb a cold
        /// `dlopen` of a ~127MB merged dylib plus a fontconfig font-directory scan, not just a
        /// socket connect. Measured directly: a COLD run (first `libmergedlo.dylib` load this OS
        /// session — page cache empty) needed MORE than the Task 2 default of 5.0s; a WARM run
        /// (same session, pages already cached by the kernel — persists across helper process
        /// respawns, since the cache lives below the process level) completed in ~8s. 30s is a
        /// deliberately generous budget for the one-time cold-cache cost — NOT a claim that every
        /// boot takes this long; T5+ may want to show the user a loading state for a first office
        /// tab open, but that is UX polish out of this task's scope, not a correctness requirement.
        var handshakeTimeout: TimeInterval = 30.0
        var maxAttempts: Int = 3
        var backoff: TimeInterval = 0.25
        /// Forwarded to the helper as `--idle-exit-seconds` when set. `nil` (production) lets the
        /// helper keep its own 120s default — tests shorten this so a smoke test doesn't spend two
        /// real minutes proving idle-exit happens at all.
        var idleExitSeconds: Int?
        /// Appended verbatim after the standard `--socket-path`/`--state-path`/`--token` (and
        /// optional `--idle-exit-seconds`) arguments. Empty in production — a pure testability
        /// seam so `OfficeSupervisorTests` can pass `NormaOfficeHelperFixture`'s `--mode` flag
        /// without the supervisor itself needing any concept of "fixture modes."
        var extraArguments: [String] = []

        /// Helper at `Contents/MacOS/NormaOfficeHelper` — the same nested path `NormaHelper`'s own
        /// bare-tool product is embedded at (project.yml's "Embed NormaHelper" postCompileScript
        /// does `cp` into `Contents/MacOS/`; "Embed NormaOfficeHelper" mirrors it exactly for this
        /// target). Socket directory per the brief's interface: `NORMA_OFFICE_STATE_PATH` (DEBUG
        /// only — the same escape hatch `NormaCEFRuntime.rootCachePath()` already uses for
        /// `NORMA_CEF_CACHE_PATH`) else `~/Library/Application Support/<bundleid>/Office/`.
        static func production() -> Configuration {
            Configuration(
                helperExecutableURL: Bundle.main.bundleURL
                    .appendingPathComponent("Contents/MacOS/NormaOfficeHelper"),
                socketDirectory: defaultStateDirectory())
        }

        static func defaultStateDirectory() -> URL {
            #if DEBUG
            if let override = ProcessInfo.processInfo.environment["NORMA_OFFICE_STATE_PATH"],
               !override.isEmpty {
                return URL(fileURLWithPath: override, isDirectory: true)
            }
            #endif
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
            let bundleId = Bundle.main.bundleIdentifier ?? "com.norma.app"
            return base.appendingPathComponent(bundleId, isDirectory: true)
                .appendingPathComponent("Office", isDirectory: true)
        }
    }

    private let configuration: Configuration

    /// **Office Stage B Task 2b** — the shared helper's own `--state-path`, exposed for
    /// `OfficeRuntime.Driver.stateDirectory` (`ShellSessionHost.officeDriver(for:)` reads this).
    /// `configuration.socketDirectory` doubles as `--state-path` already (`attemptOnce`'s own
    /// `arguments` array: `"--state-path", socketDirectory.path`) — this is the SAME directory,
    /// under its own name, not a second, independently-computed one. Fixed for this supervisor's
    /// whole lifetime (`configuration` is `let`), so — unlike `client` — safe to read at ANY time,
    /// including before the first `start()`.
    var statePath: URL { configuration.socketDirectory }
    private let eventsContinuation: AsyncStream<OfficeHelperEvent>.Continuation
    /// **Still single-consumer (T2/T3 carry, re-checked by Task 4 — deliberately NOT given a
    /// multicast wrapper here).** Task 4's own app-side tile plumbing (`OfficeHelperClient`'s
    /// `onTile`/`onTileFailed`/`onInvalidated`, `OfficeWireConnection`'s matching push callbacks)
    /// is an entirely SEPARATE notification path — per-connection settable closures proxying
    /// document/tile pushes off the wire — and never touches or drains THIS stream. Nothing this
    /// task built needs `events` read from more than one place; the carry's own condition ("if your
    /// app-side tile plumbing needs supervisor events in more than one place, add the multicast
    /// wrapper now") was checked and did not fire. Still a real constraint for whichever future
    /// task (T5's `OfficeRuntime`, most likely) is the first to actually need a second reader.
    let events: AsyncStream<OfficeHelperEvent>

    private(set) var state: State = .notStarted
    private(set) var client: OfficeHelperClient?

    /// Bumped on every `start()` call. Every closure that can fire asynchronously after the fact
    /// (death detection, a superseded attempt's own late handshake reply) captures the generation
    /// it belongs to and checks it against the CURRENT generation before touching state — so a
    /// stale signal from an attempt this supervisor has already moved past can never clobber a
    /// newer one's result. `private(set)`, not `private` — F3's own regression test
    /// (`testStartWhileReadyIsANoOpAndDoesNotOrphanTheRunningHelper`) asserts on it directly, via
    /// `@testable import`, to prove a redundant `start()` mints no new generation.
    private(set) var generation = 0
    /// `private(set)`, not `private` — F3's own test reads `.processIdentifier`/`.isRunning`
    /// directly to prove a redundant `start()` neither spawns a second process nor orphans the
    /// first one.
    private(set) var process: Process?
    private var connection: OfficeWireConnection?

    /// The `Process` most recently spawned by `attemptOnce`, set right after `process.run()`
    /// succeeds — unlike `process` above (which only ever holds a SUCCESSFUL attempt's process),
    /// this is overwritten on EVERY attempt, success or failure. Exists purely for T3 review F3's
    /// own regression tripwire: a FAILED attempt's process is otherwise unobservable from outside
    /// `attemptOnce` (it is a local variable there), so nothing could previously assert which
    /// signal a TIMED-OUT attempt's kill path actually sent — a refactor from `forceKill`
    /// (`SIGKILL`) back to `process.terminate()` (`SIGTERM`) stayed green with no test noticing.
    /// `OfficeSupervisorTests.testHandshakeTimeoutKillPathSendsSIGKILLNotSIGTERM` reads this,
    /// via `@testable import`, after a deliberately-timed-out attempt, and asserts
    /// `.terminationStatus == SIGKILL` (the LOK-free fixture has no crash-handler to intercept a
    /// raw signal, so `.terminationReason` alone reads `.uncaughtSignal` for EITHER signal —
    /// `.terminationStatus` is the actual discriminator, per the review's own note).
    private(set) var lastAttemptProcess: Process?

    init(configuration: Configuration) {
        self.configuration = configuration
        var continuation: AsyncStream<OfficeHelperEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        eventsContinuation = continuation
    }

    /// Spawns the helper and proves it alive, up to `configuration.maxAttempts` times with
    /// `configuration.backoff` between a killed attempt and the next. Returns once ready or once
    /// every attempt has failed (`.helperUnavailable`) — see the type's own header for why nothing
    /// past that point retries on its own.
    ///
    /// **Only `.notStarted` and `.stopped` can begin a new attempt cycle — `.starting` and
    /// `.ready` are both no-ops (F3, T2 review).** `.starting` was always guarded (re-entrancy);
    /// `.ready` was NOT, and a second `start()` call while a helper was already running and
    /// healthy would bump `generation` — invalidating the CURRENT generation's death-detection
    /// closures — spawn a brand-new process, and overwrite `process`/`connection`/`client` with
    /// it, all WITHOUT ever terminating the old process or closing its connection: an orphaned
    /// helper (in Task 3, ~488MB of mapped LOK) whose own idle-exit can never arm, because its
    /// still-open connection permanently pins its `connectionCount` above zero. "The next explicit
    /// `start()` is the only door back in" (the type's own header) means back in from a FAILED
    /// state (`.stopped`, whether from `.helperDied` or `.helperUnavailable`) — not a redundant
    /// call while already succeeded.
    func start() async {
        guard state == .notStarted || state == .stopped else { return }
        state = .starting
        client = nil
        generation += 1
        let myGeneration = generation

        let attempts = max(1, configuration.maxAttempts)
        for attempt in 1...attempts {
            guard myGeneration == generation else { return } // superseded by a newer start()
            if await attemptOnce(generation: myGeneration) {
                return // attemptOnce already moved state to .ready and emitted .ready
            }
            guard myGeneration == generation else { return }
            if attempt < attempts {
                try? await Task.sleep(nanoseconds: UInt64(max(0, configuration.backoff) * 1_000_000_000))
            }
        }
        guard myGeneration == generation else { return }
        state = .stopped
        eventsContinuation.yield(.helperUnavailable)
    }

    /// One spawn -> wait-for-socket -> connect -> `hello` cycle. `true` (and `state == .ready`) on
    /// success; on any failure this tears down what it started (kills the process, closes the
    /// connection) and returns `false` so `start()` can back off and try again.
    private func attemptOnce(generation myGeneration: Int) async -> Bool {
        let token = Self.generateToken()
        let socketDirectory = configuration.socketDirectory
        let socketPath = socketDirectory.appendingPathComponent("office.sock").path

        do {
            try FileManager.default.createDirectory(at: socketDirectory, withIntermediateDirectories: true)
        } catch {
            return false
        }

        // F1 fix (T2 review): a PRIOR attempt's helper, killed via SIGTERM, leaves its socket
        // FILE on disk — SIGTERM's default disposition does not run any unlink-on-exit cleanup,
        // and the SERVER's own unlink-before-bind only helps a helper that gets far enough to
        // start(); it does nothing for the path a killed helper leaves behind. Without this, the
        // existence-poll below returns true INSTANTLY against the stale file (nothing has to
        // create it — it's already there), and connecting proceeds into a dead inode: nothing is
        // listening, and empirically (T2 review, reproduced) UnixSocketTransport's connect does
        // not fail fast against that shape — it burns close to its own internal ~3s timeout before
        // giving up, per attempt. Worse: a crash-respawn sequence could connect to a PREVIOUS
        // generation's still-live helper instead of the new one if the stale path briefly outlives
        // its owner. Removing the file HERE, immediately before spawning, is the fix — the poll
        // below then only ever sees a socket file the FRESH process itself created.
        try? FileManager.default.removeItem(at: URL(fileURLWithPath: socketPath))

        let process = Process()
        process.executableURL = configuration.helperExecutableURL
        var arguments = ["--socket-path", socketPath, "--state-path", socketDirectory.path, "--token", token]
        if let idleExitSeconds = configuration.idleExitSeconds {
            arguments += ["--idle-exit-seconds", String(idleExitSeconds)]
        }
        arguments += configuration.extraArguments
        process.arguments = arguments

        do {
            try process.run()
        } catch {
            return false
        }
        lastAttemptProcess = process // F3 (T3 review) — every attempt, success or failure; see its own header

        let deadline = Date().addingTimeInterval(configuration.handshakeTimeout)

        // Poll for the socket FILE rather than connecting immediately: the helper's own start()
        // (bind+listen) runs after process launch, and connecting against a path that doesn't
        // exist yet fails immediately rather than waiting for it to appear — polling absorbs that
        // startup race inside the same overall handshake budget instead of burning a whole
        // UnixSocketTransport connect-timeout on it.
        while !FileManager.default.fileExists(atPath: socketPath) {
            if Date() >= deadline || myGeneration != generation {
                Self.forceKill(process) // SIGKILL, not SIGTERM — carry #4, see forceKill's own header
                return false
            }
            try? await Task.sleep(nanoseconds: 20_000_000) // 20ms
        }

        let connection = OfficeWireConnection(socketPath: socketPath)
        let helloSeq: UInt64 = 1
        var succeeded = false
        var lokVersion = ""

        // F2 fix (T2 review): `connection.open()` was UNBOUNDED by `deadline` — it is a single
        // `async throws` call with no timeout parameter of its own, governed only by
        // `UnixSocketTransport`'s hardcoded ~3s internal connect timeout, regardless of how much
        // of THIS attempt's budget the socket-file poll above already spent. Worst case per
        // attempt was measurably ~(handshakeTimeout + 3s), not handshakeTimeout — three attempts
        // at the brief's 5s/attempt could cost ~24s, not ~15s. `openWithDeadline` bounds it to
        // whatever budget remains right now, so the poll + connect + hello-wait together never
        // exceed `handshakeTimeout` by more than scheduling noise.
        let connectBudget = max(0, deadline.timeIntervalSinceNow)
        if await openWithDeadline(connection, timeout: connectBudget) {
            do {
                try await connection.send(.hello(seq: helloSeq, role: .app, token: token))
                let remaining = max(0, deadline.timeIntervalSinceNow)
                if let reply = await connection.nextFrame(timeout: remaining),
                   case .helloOk(let replySeq, let replyLokVersion) = reply, replySeq == helloSeq {
                    succeeded = true
                    lokVersion = replyLokVersion
                }
            } catch {
                succeeded = false
            }
        }

        guard succeeded else {
            connection.close()
            Self.forceKill(process) // SIGKILL, not SIGTERM — carry #4, see forceKill's own header
            return false
        }
        guard myGeneration == generation else {
            // A newer start() superseded this attempt while the handshake was in flight — leave
            // the newer attempt's own process/connection alone; tear down only this stale one.
            connection.close()
            Self.forceKill(process) // SIGKILL, not SIGTERM — carry #4, see forceKill's own header
            return false
        }

        self.process = process
        self.connection = connection
        // Reusing `handshakeTimeout` here means every steady-state request this client ever sends
        // (ping/open/close, not just the boot handshake above) also rides the 5.0s -> 30.0s Task 3
        // change — a deliberate choice, not an unnoticed side effect of the boot-sequencing fix: a
        // large document's `open` plausibly needs more than 5s too, and death detection is a
        // SEPARATE path (`armDeathDetection`'s `onClosed`/termination handler below), so a slow-but-
        // alive helper is not mistaken for a dead one just because one request runs long.
        self.client = OfficeHelperClient(connection: connection, seqAllocator: OfficeWireSeqAllocator(),
                                          requestTimeout: configuration.handshakeTimeout)
        self.state = .ready
        armDeathDetection(generation: myGeneration, process: process, connection: connection)
        eventsContinuation.yield(.ready(lokVersion: lokVersion))
        return true
    }

    /// Office Stage A Task 5 (carry 3) — **the quit path's kill door.** Not in Task 2's original
    /// interface (`start()`/`state`/`client`/`events` only) — added here because the quit sweep
    /// needs a SYNCHRONOUS way to make the helper process go away: "supervisor kill is SIGKILL +
    /// socket close; do not await async drains in teardown" (the runtime teardown contract this
    /// mirrors — `OfficeRuntime.teardown()`'s own header).
    ///
    /// Bumps `generation` FIRST, before touching the process — the same reason `attemptOnce`'s own
    /// failure paths do: it makes `armDeathDetection`'s closure see `myGeneration != generation` and
    /// stay silent, so a kill WE initiated never turns into a spurious `.helperDied` fanned out to
    /// every runtime a beat after the app already knows it asked for this. `forceKill` is SIGKILL,
    /// never `terminate()` — carry #4's own finding (SIGTERM is intercepted once LOK is loaded)
    /// applies exactly as much to a deliberate stop as to a failed handshake attempt.
    ///
    /// Idempotent and safe from every state, including `.notStarted` (nothing to kill) and
    /// `.starting` (an attempt in flight is abandoned — its own generation check in `attemptOnce`
    /// then unwinds it without touching whatever this call does next).
    func stop() {
        generation += 1
        if let process { Self.forceKill(process) } // forceKill itself no-ops when not running
        connection?.close()
        connection = nil
        client = nil
        process = nil
        state = .stopped
    }

    /// Bounds `connection.open()` by `timeout`, independent of `UnixSocketTransport`'s own
    /// internal ~3s connect timeout (F2, T2 review). NOT a `withTaskGroup` race — same reasoning
    /// `OfficeWireConnection`'s own header gives at length for `nextFrame`: NormaKit's `open()` has
    /// no cancellation checks of its own (its 3s deadline is a plain `queue.asyncAfter`, not
    /// `Task`-aware), so a structured group would still AWAIT the abandoned attempt before this
    /// function could return, defeating the bound entirely. This is the same unstructured
    /// continuation-race pattern instead: whichever of "connect finished" or "timeout elapsed"
    /// happens first wins, via a shared `OnceFlag`; an abandoned connect attempt keeps running
    /// in the background on its own time, awaited by no one once this returns.
    ///
    /// `true` only once actually connected within `timeout`; `false` on timeout OR a thrown
    /// connect error.
    private func openWithDeadline(_ connection: OfficeWireConnection, timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let once = OnceFlag()
            Task {
                do {
                    try await connection.open()
                    if once.trip() { continuation.resume(returning: true) }
                } catch {
                    if once.trip() { continuation.resume(returning: false) }
                }
            }
            Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                if once.trip() { continuation.resume(returning: false) }
            }
        }
    }

    /// Watches BOTH the process (`terminationHandler`) and the connection (`onClosed`) for the
    /// same underlying event — either can notice first depending on how the helper went away — and
    /// reports it exactly once, via `OnceFlag`, as `.helperDied`. Guarded by `generation` so a
    /// signal belonging to an attempt this supervisor has already moved past (e.g. a fresh
    /// `start()` already replaced it) is a no-op.
    private func armDeathDetection(generation myGeneration: Int, process: Process, connection: OfficeWireConnection) {
        let once = OnceFlag()
        let fire: @Sendable () -> Void = { [weak self] in
            guard once.trip() else { return }
            Task { @MainActor [weak self] in
                guard let self, myGeneration == self.generation else { return }
                self.state = .stopped
                self.client = nil
                self.eventsContinuation.yield(.helperDied)
            }
        }
        connection.onClosed = fire
        process.terminationHandler = { _ in fire() }
    }

    /// Task 3, carry #4 (EARNED): SIGTERM-equivalence to `_exit(0)` does NOT hold once LOK is
    /// loaded. `Process.terminate()` sends SIGTERM; measured directly against the real helper with
    /// a Writer document open (`sofficerc`'s `CrashDumpEnable=true`): the process still dies
    /// PROMPTLY (~22ms, no crash report generated) — but `Process.terminationReason` reports
    /// `.exit` with `terminationStatus == 255`, not `.uncaughtSignal` with status 15, meaning
    /// SOMETHING intercepts the raw signal and calls its own exit path rather than dying from
    /// SIGTERM's default disposition untouched (almost certainly LO's own crash-handler
    /// infrastructure, installed because `CrashDumpEnable=true`; the absence of any resulting
    /// crash report is consistent with that handler itself using a destructor-skipping exit, but
    /// this is inference, not proof — see task-3-report.md's full measurement). The carry's own
    /// instruction is explicit that "a handler runs" is disqualifying on its own, independent of
    /// whether the OUTCOME still looks safe: SIGKILL — which no userspace handler can intercept —
    /// replaces SIGTERM on every kill path below.
    private static func forceKill(_ process: Process) {
        guard process.isRunning else { return }
        kill(process.processIdentifier, SIGKILL)
    }

    /// A per-launch capability token: 32 random bytes, hex-encoded. Known only to this process and
    /// whatever it hands the token to at spawn (the helper, via `--token`) — proof of "you are the
    /// process I just launched," not a security boundary against another local user (this machine
    /// already trusts anything running as the same uid; see `OfficeWireFrame.hello`'s own comment
    /// on the role/token simplification).
    private static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            // SecRandomCopyBytes failing on macOS would be a far bigger problem than this token —
            // this fallback exists so a supervisor start() never crashes over it, not because it's
            // expected to run.
            return UUID().uuidString + UUID().uuidString
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
