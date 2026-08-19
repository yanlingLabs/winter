import Foundation

// MARK: - The state (PURE — `OfficeRuntimeReducerTests` drives every row of this without a helper)

/// Everything about a session's office documents that anything outside it may read: whether the
/// (shared, app-wide) helper is up, which paths are open, and what each one knows about itself.
///
/// **Deliberately a plain value with no references in it** — the same reason `EditorRuntimeState`
/// gives: the lifecycle has to be reasoned about, and tested, without a helper process, a socket or
/// a run loop, and a state that carried a connection or a client would drag all three back in
/// through the back door.
struct OfficeRuntimeState: Equatable {
    /// Where THIS runtime is in learning about the (possibly shared, possibly already-running)
    /// helper. Unlike `EditorRuntimeState.Phase` — where each runtime owns its own browser and a
    /// browser that failed to appear leaves nothing sane to retry against — `.failed` here is NOT
    /// terminal: the helper is an app-wide process the supervisor is willing to relaunch "on next
    /// demand" (`OfficeHelperSupervisor`'s own header), and a demand is exactly a fresh
    /// `.openRequested`. See `OfficeRuntimeReducer`'s own `.openRequested` case for the retry.
    enum Phase: String, Equatable {
        case idle
        case starting
        case ready
        case failed
    }

    /// One open document. `docId` is caller-minted (T3's own interface note: "the helper never
    /// invents ids") — minted by the imperative half at the moment `.helperOpen` is performed, never
    /// by this pure reducer.
    struct DocumentEntry: Equatable {
        var docId: String
        var type: OfficeDocumentKind
        var parts: Int
        /// Which part (sheet/slide/page) a viewport last asked to see — T6's part-navigation strip
        /// reads this; T5 only ever WRITES it, as a side effect of `.subscribeRequested` (the one
        /// event that carries a part number in Stage A). Defaults to 0 — the first part — since
        /// nothing has asked for anything else yet at open time.
        var activePart: Int = 0
        var sizeTwips: OfficeDocumentSize
    }

    var phase: Phase = .idle
    /// Absolute path -> what is known about its open document.
    var documents: [String: DocumentEntry] = [:]
    /// Opens that arrived before the (shared) helper was ready, in order, deduped. Flushed by
    /// `.helperBecameReady` and dropped by `.helperDied`/`.helperUnavailable` (they can never land) —
    /// same shape and same reasoning as `EditorRuntimeState.pendingOpens`.
    var pendingOpens: [String] = []
    /// **Task 5 (mirrors editor-product Task 5's `openFailures`): why a path has no document —
    /// the explicit signal.** `documents[path] == nil` alone is NOT "the file could not be opened":
    /// a queued open and an open still in flight are both "no document" too, and only a genuine
    /// failure belongs here. Cleared by a fresh `.openRequested` for the same path (a retry must not
    /// keep showing a stale sentence), by the document actually opening, by a close, or by teardown.
    var openFailures: [String: String] = [:]
    /// Why `phase == .failed` — set by `.helperDied`/`.helperUnavailable`, cleared by whatever
    /// supersedes it (a fresh `.openRequested`, which retries) or by teardown. Not part of the
    /// brief's literal field list for `documents[path]` — added at the top level, mirroring
    /// `EditorRuntimeState.failureReason`, because carry 4 ("helperDied -> runtime surfaces a
    /// banner/failed state") needs somewhere durable to say WHY, and a per-document field cannot: a
    /// helper death clears every document at once (see `.helperDied` below), so nothing document-
    /// scoped could ever hold this by the time anything reads it.
    var failureReason: String?
}

// MARK: - Events

/// Everything that can happen to a runtime. The imperative half feeds these; the reducer is the
/// only thing that decides what they mean.
enum OfficeRuntimeEvent: Equatable {
    /// "Open this file." Queued while starting; self-starting from `.idle` AND from `.failed` (carry
    /// 4 — see `OfficeRuntimeState.Phase`'s own doc).
    case openRequested(path: String)
    /// The (shared) helper reported ready — either a fresh boot this runtime itself asked for, or
    /// the fan-out telling every runtime that SOME session's ask succeeded. No payload: nothing in
    /// this state shape remembers the helper's `lokVersion`.
    case helperBecameReady
    /// A `.helperOpen` reached the helper and it answered with the document's metadata.
    case opened(path: String, docId: String, metadata: OfficeDocumentMetadata)
    /// A `.helperOpen` reached the helper and it refused (garbage file, unreadable path, ...) — see
    /// `OfficeHelperClientError.openFailed`, the shape the imperative half classifies this from.
    case openFailed(path: String, reason: String)
    case closeRequested(path: String)
    /// T6's tile door: a viewport wants to see `part` of `path`. Thin at T5 — this event only
    /// updates `activePart` and asks the helper; T6 owns everything about what the viewport
    /// coordinates mean and what it does with the returned tile keys.
    case subscribeRequested(path: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)
    case unsubscribeRequested(path: String)
    /// The shared supervisor's own death/never-came-up signals, fanned out to every runtime in the
    /// table (`ShellSessionHost`'s own broadcast — see its header). Legal, and identically handled,
    /// from every phase — carry 4's own words, and `OfficeRuntimeReducerTests
    /// .testHelperDiedFromEveryPhaseClearsEverythingFailsAndBanners` is the pin.
    case helperDied
    case helperUnavailable
    /// Release everything. Legal from every phase, and the only route back to a fresh `.idle`.
    case teardownRequested
}

/// What the imperative half must DO about an event. Named after the effect, never after the wire
/// call, so the reducer's tests read as claims about the runtime rather than about the socket.
///
/// The brief names five: `.helperOpen`, `.helperClose`, `.subscribe`, `.unsubscribe`,
/// `.emitBanner`. Two more are added here, mirroring `EditorRuntimeEffect`'s own extra members
/// beyond its headline `.createBrowser`/`.registerWithHub` pair: `.ensureHelperReady` (the "ask the
/// possibly-already-running shared helper to be ready" step `.openRequested` needs from `.idle`/
/// `.failed`) and `.teardown` (releasing everything this runtime holds, on the same terms as
/// `EditorRuntimeEffect.teardown(browserId:)`).
enum OfficeRuntimeEffect: Equatable {
    case ensureHelperReady
    case helperOpen(path: String)
    case helperClose(docId: String)
    case subscribe(docId: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect)
    case unsubscribe(docId: String)
    /// Task 5: whenever the reducer decides something is worth telling the user, this fires
    /// alongside the state it also writes (`failureReason` for a helper death,
    /// `openFailures[path]` for one document) — the effect is the transient, "say it once" half; the
    /// state is the durable, "a later render can still read it" half. No banner UI surface exists
    /// yet in Stage A (T6+ wires one against `documents`/`openFailures`/`failureReason`) —
    /// `OfficeRuntime`'s own performer for this case is a documented no-op relay; the effect still
    /// fires and is asserted by the reducer tests, matching the brief's named effect list.
    case emitBanner(reason: String)
    /// Release every open docId (closing each is the imperative half's job — see
    /// `OfficeRuntime.performTeardown`); never touches the shared helper PROCESS itself, which
    /// outlives any one session's runtime (`ShellSessionHost.teardownOfficeRuntime`'s own header).
    case teardown(docIds: [String])
}

/// **The whole lifecycle, as one pure function.** Every claim Task 5 makes about this runtime —
/// self-starting from idle AND from failed, ready-gates-opens, helperDied-in-every-phase,
/// teardown-from-every-phase — is a row of `OfficeRuntimeReducerTests` driving this directly, with
/// no helper process, no socket and no run loop.
enum OfficeRuntimeReducer {
    static func reduce(_ state: OfficeRuntimeState,
                       _ event: OfficeRuntimeEvent) -> (OfficeRuntimeState, [OfficeRuntimeEffect]) {
        var next = state

        switch event {

        case .openRequested(let path):
            // A new ask supersedes the last failure for that path, before any phase decides
            // anything — the same discipline `EditorRuntimeReducer.openRequested` states at length:
            // a retry (the tree click on a file whose permissions just got fixed) must not keep
            // showing a stale sentence while its own fresh attempt is in flight.
            next.openFailures.removeValue(forKey: path)
            switch state.phase {
            case .idle, .failed:
                // **Carry 4: `.failed` retries exactly like `.idle`.** The shared helper's own
                // contract is "relaunch on next demand only" — this IS that demand. A fresh attempt
                // also supersedes whatever the last failure said (`failureReason`), same reasoning
                // as the `openFailures` clear above, one level up.
                next.phase = .starting
                next.pendingOpens = [path]
                next.failureReason = nil
                return (next, [.ensureHelperReady])
            case .starting:
                if !next.pendingOpens.contains(path) { next.pendingOpens.append(path) }
                return (next, [])
            case .ready:
                // No per-runtime "current"/"activate" concept (Office has no single shared page the
                // way Editor's one CEF browser is — T6 gives every open document its OWN tab and tile
                // canvas). An already-open path is simply left alone; T6's tab layer owns dedupe/
                // activate against ITS OWN already-open tab, mirroring `openFileTab`'s contract.
                guard state.documents[path] == nil else { return (next, []) }
                return (next, [.helperOpen(path: path)])
            }

        case .helperBecameReady:
            guard state.phase == .starting else { return (next, []) }
            next.phase = .ready
            let queued = next.pendingOpens
            next.pendingOpens = []
            return (next, queued.map { .helperOpen(path: $0) })

        case .opened(let path, let docId, let metadata):
            // Gated on `.ready`, like every other arm that records what the helper said: the async
            // reply can land after a teardown or a helper death moved this runtime past `.ready`
            // (the imperative half's own generation guard — `OfficeRuntime.perform`'s `.helperOpen`
            // case — is what stops the DISPATCH from even reaching here in the teardown case; this
            // guard is the belt, and the only line of defense for the helperDied case, which does
            // not bump that generation).
            guard state.phase == .ready else { return (next, []) }
            next.openFailures.removeValue(forKey: path)
            next.documents[path] = OfficeRuntimeState.DocumentEntry(
                docId: docId, type: metadata.type, parts: metadata.parts, sizeTwips: metadata.sizeTwips)
            return (next, [])

        case .openFailed(let path, let reason):
            guard state.phase == .ready else { return (next, []) }
            next.openFailures[path] = reason
            let basename = (path as NSString).lastPathComponent
            return (next, [.emitBanner(reason: "Couldn't open \(basename): \(reason)")])

        case .closeRequested(let path):
            next.pendingOpens.removeAll { $0 == path }
            next.openFailures.removeValue(forKey: path)
            guard let doc = state.documents[path] else { return (next, []) }
            next.documents.removeValue(forKey: path)
            return (next, [.helperClose(docId: doc.docId)])

        case .subscribeRequested(let path, let part, let zoomPPT, let viewportTwips):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            next.documents[path]?.activePart = part
            return (next, [.subscribe(docId: doc.docId, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips)])

        case .unsubscribeRequested(let path):
            guard state.phase == .ready, let doc = state.documents[path] else { return (next, []) }
            return (next, [.unsubscribe(docId: doc.docId)])

        case .helperDied, .helperUnavailable:
            // **Carry 4, both halves at once.** Every open document's docId lives only on the
            // now-gone helper, so NONE of them survive this — a per-document banner would have
            // nothing left to be attached to a beat later; the failure is recorded at the top level
            // instead (`failureReason`). Never auto-restarts: nothing here emits `.ensureHelperReady`
            // — see `OfficeRuntime`'s own doc on why relaunch is next-demand-only.
            let reason = (event == .helperDied)
                ? "The office helper stopped unexpectedly."
                : "The office helper couldn't be started."
            var fresh = OfficeRuntimeState()
            fresh.phase = .failed
            fresh.failureReason = reason
            return (fresh, [.emitBanner(reason: reason)])

        case .teardownRequested:
            // From every phase, including `.idle` — the effect is emitted unconditionally so the
            // imperative half has one path to run (idempotent), and so "teardown from anywhere
            // releases the slot" is a claim the tests can make about the reducer alone. Every open
            // docId is handed to the imperative half to close; NEVER the shared helper process
            // itself (see `.teardown`'s own doc).
            let docIds = state.documents.values.map(\.docId)
            return (OfficeRuntimeState(), [.teardown(docIds: docIds)])
        }
    }
}

// MARK: - The runtime

/// Office Stage A Task 5 — **one session's view of the app-wide office helper, and everything that
/// has to happen for it to open/close documents through it.**
///
/// Unlike `EditorRuntime` (one hidden CEF browser PER SESSION, created and torn down by this very
/// object), the office helper is ONE process shared by every session (`OfficeHelperSupervisor`'s own
/// design — one socket path per state directory). This object therefore does not own a supervisor —
/// it is handed a `Driver` that already knows how to reach the SHARED one, built by
/// `ShellSessionHost` (see that file's own header on the fan-out this implies).
///
/// The lifecycle itself is NOT here — it is `OfficeRuntimeReducer`, pure and tested without a
/// helper process. This half performs effects and relays what the shared helper (via its Driver)
/// says.
@MainActor
final class OfficeRuntime: ObservableObject {

    /// Every call this file makes into the shared helper. Closures, not a direct
    /// `OfficeHelperSupervisor`/`OfficeHelperClient` reference — the same reasoning
    /// `EditorRuntime.CEFDriver` gives: nothing helper-shaped is safely constructible under XCTest
    /// (a real driver spawns a subprocess), so this runtime's logic has to be reachable without it.
    ///
    /// **No `.production` default** (unlike `CEFDriver`, which closes over CEF's global C
    /// functions): the shared helper is owned per-`ShellSessionHost` instance, not a process-wide
    /// singleton (many hosts exist across the test suite alone), so there is nothing static to
    /// default to. `ShellSessionHost.officeRuntime(for:)` builds one per runtime from its own
    /// `officeHelperSupervisor`/`officeRequestQueue` at mint time.
    struct Driver {
        /// Synchronous — `OfficeHelperSupervisor.state` is a plain stored property. This is the
        /// late-joiner check `.ensureHelperReady` needs: a runtime minted AFTER the shared helper is
        /// already `.ready` would otherwise wait forever for a fan-out event that already happened
        /// in the past, to a supervisor `events` stream nobody yet subscribed on its behalf.
        var helperState: () -> OfficeHelperSupervisor.State
        /// Asks the shared supervisor to be ready. Safe to call when a start is already in flight,
        /// or when one already succeeded (`OfficeHelperSupervisor.start()`'s own documented no-ops)
        /// — this runtime never needs to know which case it is; either way, ONE eventual fan-out
        /// event (or the synchronous `helperState()` check above) is what actually advances it.
        var startHelper: () async -> Void
        /// Routed through `ShellSessionHost`'s ONE `OfficeHelperRequestQueue` in production — see
        /// that type's own header for why a raw, un-serialized `client.open` is not safe to call
        /// from more than one place at a time on the shared connection.
        var open: (_ docId: String, _ path: String) async throws -> OfficeDocumentMetadata
        /// Never throws to the caller: a close is fire-and-forget everywhere this file uses it
        /// (optimistic removal in the reducer, teardown, the carry-6 compensating close) — there is
        /// nothing left to roll back to on failure, only something worth logging, which the
        /// production implementation does on its own terms.
        var close: (_ docId: String) async -> Void
        var subscribeTiles: (_ docId: String, _ part: Int, _ zoomPPT: Int,
                             _ viewportTwips: OfficeTwipsRect) async throws -> [TileKey]
        var unsubscribeTiles: (_ docId: String) async -> Void
    }

    let sessionId: String

    /// The published state. `stateSnapshot` is the same value under the name the plan's interface
    /// names it by — mirrors `EditorRuntime.state`/`.stateSnapshot` exactly.
    @Published private(set) var state = OfficeRuntimeState()
    var stateSnapshot: OfficeRuntimeState { state }

    private let driver: Driver
    private let makeDocId: () -> String

    /// **Carry 6's belt: bumped by `teardown()`, checked by every in-flight `.helperOpen` before it
    /// dispatches its result.** Mirrors `OfficeHelperSupervisor.generation`'s own reasoning exactly:
    /// `teardown()` resets `state` to a value that is BYTE-IDENTICAL to a runtime that was simply
    /// never started, so a phase check alone cannot tell "this specific open was superseded" apart
    /// from "this runtime never asked for anything." A stale open that resumes after a teardown must
    /// neither resurrect the torn-down runtime NOR orphan the document it just opened on the shared
    /// helper — see `perform(_:)`'s `.helperOpen` case for both halves.
    private(set) var generation = 0

    init(sessionId: String, driver: Driver, makeDocId: @escaping () -> String = { UUID().uuidString }) {
        self.sessionId = sessionId
        self.driver = driver
        self.makeDocId = makeDocId
    }

    // MARK: The doors

    /// Open a file. Synchronous — unlike `EditorRuntime.openFile` (which awaits a DISK READ this
    /// object does itself), nothing here needs to happen before the reducer can decide what to do;
    /// every actual round trip to the helper is fire-and-forget from this door's own perspective,
    /// exactly like `EditorRuntime.close`/`.teardown`. Never sequence off this call returning —
    /// observe `state`/`stateSnapshot` instead (the same rule `EditorRuntime.openFile`'s own header
    /// states, for the identical reason: this returns before the helper has answered anything).
    func open(_ path: String) {
        perform(dispatch(.openRequested(path: path)))
    }

    func close(_ path: String) {
        perform(dispatch(.closeRequested(path: path)))
    }

    /// T6's tile door. Thin here — see `OfficeRuntimeEvent.subscribeRequested`'s own doc.
    func subscribeTiles(path: String, part: Int, zoomPPT: Int, viewportTwips: OfficeTwipsRect) {
        perform(dispatch(.subscribeRequested(path: path, part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips)))
    }

    func unsubscribeTiles(path: String) {
        perform(dispatch(.unsubscribeRequested(path: path)))
    }

    /// Release everything this runtime holds. Legal from every phase and safe twice.
    /// **Synchronous by contract** — the quit path and the shell's departure policy both need the
    /// STATE reset to have happened when this returns (mirrors `EditorRuntime.teardown`'s own
    /// header). What is NOT synchronous, and cannot be: the actual `close` round trips to the
    /// shared helper for each document this runtime held — those are fire-and-forget, the same
    /// "obligation 5" `AppDelegate.editorQuitGate` already documents for saves in flight ("no
    /// attempt to wait out an in-flight [request]").
    func teardown() {
        perform(dispatch(.teardownRequested))
    }

    /// **The fan-out door** — called by `ShellSessionHost`'s ONE consumer of the shared supervisor's
    /// `events` stream, once per event, for EVERY runtime in its table (see that file's header for
    /// why this must be a fan-out rather than each runtime subscribing on its own:
    /// `OfficeHelperSupervisor.events` is documented single-consumer).
    func handle(supervisorEvent event: OfficeHelperEvent) {
        switch event {
        case .ready:
            perform(dispatch(.helperBecameReady))
        case .helperDied:
            perform(dispatch(.helperDied))
        case .helperUnavailable:
            perform(dispatch(.helperUnavailable))
        }
    }

    // MARK: The reducer, driven

    private func dispatch(_ event: OfficeRuntimeEvent) -> [OfficeRuntimeEffect] {
        let (next, effects) = OfficeRuntimeReducer.reduce(state, event)
        state = next
        return effects
    }

    private func perform(_ effects: [OfficeRuntimeEffect]) {
        for effect in effects {
            switch effect {
            case .ensureHelperReady:
                // The late-joiner check: if the shared helper is ALREADY ready (some other session
                // started it before this runtime existed, or before this runtime had anything to
                // open), fold that synchronously — no fan-out event is ever coming for a readiness
                // that already happened in the past. Otherwise ask, and let the shared fan-out (or
                // this runtime's own future read of it) advance every waiting runtime once the ask
                // resolves, whoever actually triggered it.
                if driver.helperState() == .ready {
                    perform(dispatch(.helperBecameReady))
                } else {
                    Task { [driver] in await driver.startHelper() }
                }

            case .helperOpen(let path):
                let docId = makeDocId()
                let myGeneration = generation
                Task { [weak self, driver] in
                    guard let self else { return }
                    do {
                        let metadata = try await driver.open(docId, path)
                        guard myGeneration == self.generation else {
                            // Carry 6: teardown superseded this open while it was in flight. The
                            // document is now open on the shared helper with no owner left to close
                            // it — compensate rather than orphan it. Never dispatch into the fresh
                            // state teardown just produced.
                            await driver.close(docId)
                            return
                        }
                        self.perform(self.dispatch(.opened(path: path, docId: docId, metadata: metadata)))
                    } catch {
                        guard myGeneration == self.generation else { return } // superseded AND failed: nothing to compensate, nothing to record
                        self.perform(self.dispatch(.openFailed(path: path, reason: Self.describe(error))))
                    }
                }

            case .helperClose(let docId):
                Task { [driver] in await driver.close(docId) }

            case .subscribe(let docId, let part, let zoomPPT, let viewportTwips):
                Task { [driver] in
                    // T6 owns consuming the returned `[TileKey]` — T5 only builds the door and fires
                    // the wire call. A failure here is logged by the production driver; there is no
                    // reducer state yet that a subscribe failure would change.
                    _ = try? await driver.subscribeTiles(docId, part, zoomPPT, viewportTwips)
                }

            case .unsubscribe(let docId):
                Task { [driver] in await driver.unsubscribeTiles(docId) }

            case .emitBanner:
                // No banner UI surface exists in Stage A yet — T6+ wires one against
                // `state.failureReason`/`state.openFailures`, which is what a future banner view
                // actually reads (this effect's own doc explains the split). Documented no-op relay.
                break

            case .teardown(let docIds):
                performTeardown(docIds: docIds)
            }
        }
    }

    private func performTeardown(docIds: [String]) {
        generation += 1
        for docId in docIds {
            Task { [driver] in await driver.close(docId) }
        }
    }

    /// PURE: classifies an `OfficeHelperClient` failure into the short sentence
    /// `.openFailed`/`.emitBanner` show. `.openFailed(reason:)` already carries the helper's own
    /// text; everything else (a timeout, a protocol-level refusal, an unexpected reply shape) is
    /// this runtime's own connection trouble, not a fact about the document.
    private static func describe(_ error: Error) -> String {
        if let clientError = error as? OfficeHelperClientError, case .openFailed(let reason) = clientError {
            return reason
        }
        return (error as? CustomStringConvertible)?.description ?? "the office helper request failed"
    }
}

// MARK: - The shared client's request funnel

/// Office Stage A Task 5 — serializes every call this app makes into the ONE shared
/// `OfficeHelperClient`. `OfficeHelperClient.expectReply(seq:)` is a single-outstanding-request
/// waiter (`OfficeHelperSupervisor`'s own header: "single-outstanding-request contract, seq
/// allocator NOT thread-safe") — two overlapping calls on the same connection have no way to tell
/// each other's replies apart, so the SECOND call's `expectReply` can consume the FIRST call's
/// answer (or vice versa), silently misattributing one and leaving the other awaiting a reply that
/// already arrived and was thrown away.
///
/// This is reachable the ORDINARY way, not just across sessions: two quick clicks on two different
/// files in the SAME session's Files tree are two concurrent `OfficeRuntime.open()` calls the
/// moment T6 wires a door to call it — the first `driver.open` has not resumed before the second
/// fires. Every `OfficeRuntime` sharing the app-wide client routes its Driver calls through ONE
/// queue instance (`ShellSessionHost.officeRequestQueue`) rather than calling the client directly.
///
/// **No cancellation semantics, and none are needed**: a torn-down runtime's own in-flight call
/// still runs to completion through this queue (nothing here knows or cares that its caller went
/// away) — `OfficeRuntime`'s own generation guard (`perform(_:)`'s `.helperOpen` case) is what
/// absorbs a stale resume, not this queue.
@MainActor
final class OfficeHelperRequestQueue {
    private var tail: Task<Void, Never> = Task {}

    /// Runs `operation` only after every previously-enqueued operation has finished — success or
    /// throw, in the order they were enqueued.
    func run<T>(_ operation: @escaping () async throws -> T) async throws -> T {
        let previous = tail
        var outcome: Result<T, Error>!
        let current = Task {
            _ = await previous.value
            do {
                outcome = .success(try await operation())
            } catch {
                outcome = .failure(error)
            }
        }
        tail = current
        await current.value
        return try outcome.get()
    }
}
