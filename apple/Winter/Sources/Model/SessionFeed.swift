import Foundation
import os
import WinterProtocol
import WinterKit

/// One live view of one session: its own `WinterClient` (own socket — a full Winter harness),
/// connect-with-backoff, attach, and an event pump into a `SessionModel`. Extracted from
/// `AppModel` (2d-ii-b Task 1): `AppModel` remains the orb's `followFocus` consumer; a detached
/// chat window (Task 3/4) will use `pinned` mode — a fixed sessionId, no focus-following, no
/// session creation.
///
/// SHAPE SHIPPED: hook composition, not extraction-by-delegation. `AppModel`'s focus-follow logic
/// (`refocus`/`focusNewestSession`/`ensureFocusedSession`/`setSessionPolicy`) stays PHYSICALLY in
/// `AppModel` — it depends on `AppModel`-private state (`focusedSessionId`, `selfCreatedSessionId`,
/// `connectionSummary`) that has no reason to live here. `SessionFeed` owns only the mechanical
/// parts that are IDENTICAL for both modes — the
/// connect-with-backoff loop, the event pump, and `stop()` (AppModel.swift original :33-66,
/// verbatim) — and calls back into the mode's owner through four small hooks at the exact points
/// `AppModel`'s original `start()`/`handle()` touched app-only state. `pinned` mode leaves every
/// hook nil and gets `SessionFeed`'s own default behavior instead: self-attach at start, then
/// apply-if-my-session (plus every connection state) with no session_created/refocus/policy logic.
@MainActor
final class SessionFeed {
    enum Mode {
        case followFocus
        case pinned(sessionId: String)
    }

    /// send/steer/interrupt/setPolicy/attach callers (AppModel, later DetachedWindowController).
    let client: WinterClient
    /// `var`, not `let`: Task 5 (2e-iii)'s `repin(to:)` flips a `.pinned` feed onto a DIFFERENT
    /// session id in place (the detached window's sidebar "switch in place" action) — everything
    /// else about the feed (client/socket, session, hooks) stays the same across a repin.
    private var mode: Mode
    private let session: SessionModel
    private var pumpTask: Task<Void, Never>?
    /// Events read off the client's stream and waiting for the main actor (see `start()`).
    private let relay = EventRelay()
    private var draining = false
    private var stopped = false

    /// followFocus: AppModel sets this to flip `connectionSummary` to the "retrying" string on
    /// each failed connect attempt (AppModel.swift original :42, verbatim string). Unused in
    /// pinned mode — a detached window has no summary line of its own yet (Task 3/4).
    var onRetry: (() -> Void)?
    /// followFocus: AppModel sets this to `focusNewestSession()` — runs once, right after
    /// `connect()` succeeds, before `markConnected()`/the pump start (AppModel.swift original
    /// :49). Pinned mode ignores this hook entirely; it attaches its fixed sessionId itself.
    var onAttach: (() async -> Void)?
    /// followFocus: AppModel sets this to recompute `connectionSummary` right after
    /// `session.markConnected()` (AppModel.swift original :51). Left nil in pinned mode.
    var onConnected: (() -> Void)?
    /// followFocus: AppModel sets this to its verbatim `handle(_:)` — the session_created
    /// interception, focused-id filter, and connection-state application (AppModel.swift original
    /// :130-148) — always returning `true` (fully handled; the default application below never
    /// runs for followFocus). Pinned mode leaves this nil and falls through to the default: apply
    /// only events whose `sessionId` equals the pinned id, plus every connection state.
    var onEvent: ((WinterEvent) async -> Bool)?
    /// browser-runtime live-gate fix A: a `.pinned` attach has answered — `ceilingSeq` is
    /// `session.attach`'s `lastSeq`, which is the seq of the `harness_attached` the daemon appended
    /// for THIS attach (`SessionHub.attach` returns exactly that, `packages/core/src/sessions/hub.ts`)
    /// and therefore the seq of the last event its replay will deliver. `nil` = the attach threw, so
    /// no replay is coming at all.
    ///
    /// Fired from BOTH pinned attach paths, `start()`'s and `repin`'s, and unavoidably AFTER the
    /// await — which is why it is a CEILING and not a "replay finished" signal: `repin` re-attaches
    /// against an already-running pump, so the entire replay can be folded while it suspends. A
    /// consumer that must be armed before the first replayed event arrives has to arm at the call
    /// site that asks for the attach (`ShellSessionHost.attachFresh`/`hop` call
    /// `PanelStore.beginReplay` synchronously, for exactly that reason).
    ///
    /// Unused in `.followFocus` mode: that feed attaches through `onAttach`, which is `AppModel`'s
    /// own focus machinery, and nothing there has a panel to coalesce folds for.
    var onPinnedAttach: ((_ sessionId: String, _ ceilingSeq: Int?) -> Void)?

    // MARK: - Observers: what a shared feed gives each of its surfaces

    /// `onEvent`, `onConnected` and `onPinnedAttach` above are ONE closure each — the owner's. A feed that several
    /// surfaces share (`SessionFeedHub`) gives each of them its own tap on the same three moments instead: events
    /// as they are folded, the connect, and the attach (or re-attach) answer. A tap added to a feed that is ALREADY
    /// connected/attached is told so at once, one turn later — the moment it missed is not coming back, and a surface
    /// waiting on it (the shell arms a replay window and waits for its end) must not wait forever.
    private var eventObservers: [(id: Int, run: (WinterEvent) -> Void)] = []
    private var connectedObservers: [(id: Int, run: () -> Void)] = []
    private var attachObservers: [(id: Int, run: (String, Int?) -> Void)] = []
    private var nextObserverId = 0

    /// True once `stop()` has run: the feed is closed for good (a shared feed's last holder let go).
    var isStopped: Bool { stopped }
    /// True once `session.markConnected()` has run (the connect, and for a pinned feed the attach, succeeded).
    private(set) var isConnected = false
    /// A pinned feed's attach has been answered (success or failure) and no re-attach is in flight.
    private(set) var isAttached = false
    private var attachWaiters: [CheckedContinuation<Void, Never>] = []

    /// Every event this feed reads, before it is folded (before `onEvent`). Raw events: a surface that keeps its own
    /// side store (the shell's panel, a sidebar's directory) folds what it needs from them.
    func observeEvents(_ run: @escaping (WinterEvent) -> Void) -> FeedObservation {
        let id = takeObserverId()
        eventObservers.append((id, run))
        return FeedObservation { [weak self] in self?.eventObservers.removeAll { $0.id == id } }
    }

    /// The feed's connect (for a pinned feed: after the attach is answered). `fireIfAlreadyConnected` tells a tap that
    /// joins later, one turn on.
    func observeConnected(fireIfAlreadyConnected: Bool = true, _ run: @escaping () -> Void) -> FeedObservation {
        let id = takeObserverId()
        connectedObservers.append((id, run))
        let observation = FeedObservation { [weak self] in self?.connectedObservers.removeAll { $0.id == id } }
        if fireIfAlreadyConnected, isConnected {
            DispatchQueue.main.async { [weak observation] in MainActor.assumeIsolated { if observation?.isActive == true { run() } } }
        }
        return observation
    }

    /// The attach answer — `start()`'s, and every `repin`'s. A tap that joins a feed already attached is told
    /// `(sessionId, nil)`: nil is "no replay is coming", which is the truth for it.
    func observeAttach(_ run: @escaping (_ sessionId: String, _ ceilingSeq: Int?) -> Void) -> FeedObservation {
        let id = takeObserverId()
        attachObservers.append((id, run))
        let observation = FeedObservation { [weak self] in self?.attachObservers.removeAll { $0.id == id } }
        if isAttached, let sessionId = pinnedSessionId {
            DispatchQueue.main.async { [weak observation] in MainActor.assumeIsolated { if observation?.isActive == true { run(sessionId, nil) } } }
        }
        return observation
    }

    private func takeObserverId() -> Int {
        nextObserverId += 1
        return nextObserverId
    }

    /// Returns once this feed's pinned attach has been answered — at once if it already has. Also returns when the feed
    /// is stopped, so nothing waits on a feed that is gone.
    func waitUntilAttached() async {
        if isAttached || stopped { return }
        await withCheckedContinuation { attachWaiters.append($0) }
    }

    private func attachAnswered(sessionId: String, ceilingSeq: Int?) {
        isAttached = true
        onPinnedAttach?(sessionId, ceilingSeq)
        for observer in attachObservers { observer.run(sessionId, ceilingSeq) }
        let waiters = attachWaiters
        attachWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    init(makeTransport: @escaping @Sendable () -> WinterTransport, token: String, clientName: String, mode: Mode, session: SessionModel,
         latencyReportInterval: TimeInterval = FeedLatencyMeter.interval) {
        self.latencyReportInterval = latencyReportInterval
        client = WinterClient(makeTransport: makeTransport, token: token, clientName: clientName)
        self.mode = mode
        self.session = session
        if case .pinned = mode { session.isLoadingHistory = true }
        FeedRegistry.shared.register(self)
    }

    private static let logger = Logger(subsystem: "com.winter.app", category: "feed")

    /// How far behind its daemon this feed is (`FeedLatencyMeter`): one `.notice` per 10 s while events flow.
    private let latencyReportInterval: TimeInterval
    private(set) lazy var latency = FeedLatencyMeter(
        label: { [weak self] in
            guard let self else { return "feed" }
            if let id = self.pinnedSessionId { return "window \(id.prefix(10))" }
            return "orb \(self.focusedSessionIdProvider?()?.prefix(10) ?? "-")"
        },
        backlog: { [weak self] in self?.diagnostics.backlog ?? 0 },
        interval: latencyReportInterval)

    // MARK: - What a hang report names

    /// The session this feed shows right now, for a feed that follows focus (`.pinned` knows its own).
    var focusedSessionIdProvider: (() -> String?)?
    /// Events held outside this feed that are still waiting to be folded (the owner's own queues).
    var extraBacklog: (() -> Int)?

    /// What this feed is doing, read from the main thread: the session, whether its turn is live per the client's
    /// reducer, and how much is waiting — events on the stream, streamed chunks, a held replay, the owner's queues.
    var diagnostics: FeedDiagnostics {
        // A stopped feed folds nothing more: whatever it still holds is not waiting for anything.
        if stopped { return FeedDiagnostics(sessionId: pinnedSessionId ?? focusedSessionIdProvider?(), turnLive: false, backlog: 0, oldestEventAge: 0) }
        return FeedDiagnostics(sessionId: pinnedSessionId ?? focusedSessionIdProvider?(),
                        turnLive: session.state.turnRunning,
                        backlog: client.traffic.backlog + relay.count + chunks.count + (replayBuffer?.count ?? 0) + (extraBacklog?() ?? 0),
                        oldestEventAge: client.traffic.oldestAge)
    }

    /// Task 3: the fixed session id in `.pinned` mode; `nil` in `.followFocus` mode (which has no
    /// single fixed id — the focused session changes over time). `DetachedWindowController`'s
    /// `init(feed:session:frame:title:)` doesn't carry a separate sessionId parameter — its
    /// submit/steer/interrupt wire needs the id, and this is the only place it lives.
    var pinnedSessionId: String? {
        if case .pinned(let sessionId) = mode { return sessionId }
        return nil
    }

    /// Connect w/ capped backoff → mode's attach phase → mark connected → pump `client.events`
    /// into the reducer until the stream ends. Verbatim extraction of `AppModel`'s original
    /// `start()` (AppModel.swift :33-61), generalized via the hooks above.
    func start() async {
        // A feed that was let go before its start got to run (a surface that took a hold and dropped it within one
        // turn) must not open a connection nobody would ever close: it would stay attached to its session, and every
        // event the daemon sent it would land on a stream that ended with `stop()`.
        if stopped { return }
        // The daemon may not be up yet — retry the INITIAL connect with capped backoff.
        var attempt = 0
        while true {
            do {
                try await client.connect()
                break
            } catch {
                attempt += 1
                if stopped { return }
                onRetry?()
                let backoff = min(0.5 * pow(2.0, Double(attempt - 1)), 10.0)
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                if Task.isCancelled || stopped { return }
            }
        }
        // `stop()` may have landed while the connect was in flight, after its own `close()` had already run: that
        // connect opened a transport no one else will close.
        if stopped { await client.close(); return }

        switch mode {
        case .followFocus:
            await onAttach?()
        case .pinned(let sessionId):
            // **The attach is taken FIRST, into a local, and the hook called after — never
            // `onPinnedAttach?(sessionId, try? await client.attach(…))`.** Optional chaining does
            // not evaluate its arguments when the base is nil, so writing it that way skips the
            // ATTACH ITSELF for every feed with no hook wired — which is every one but the shell's
            // (`DetachedWindowController`, the chat window, most tests). Caught by the full suite:
            // two rows timed out having seen only `protocol.hello` on the wire.
            beginReplay()
            let ceilingSeq = try? await client.attach(sessionId: sessionId, fromSeq: 0)
            attachAnswered(sessionId: sessionId, ceilingSeq: ceilingSeq)
            armReplayCeiling(ceilingSeq)
        }
        // Let go during the attach: the feed is closed for good, so it is not "connected" to anything, and nothing
        // reads the stream (a reader started now would only fold into a session no surface shows).
        if stopped { await client.close(); return }
        session.markConnected() // M2: connect() success IS the connected signal
        isConnected = true
        onConnected?()
        for observer in connectedObservers { observer.run() }

        // The stream is read OFF the main actor and handed over in batches. Iterating an `AsyncStream` from a
        // main-actor task costs a hop per element however full the stream is — measured on a replay of a real
        // 14-minute session: ~380 events a second with the main thread 84% idle, a backlog 24 s deep, while the
        // events themselves cost next to nothing to fold. Here the reader never touches the main actor; one hop
        // takes everything that has arrived, and `drain` folds it in order.
        let relay = self.relay
        let client = self.client
        let reader = Task.detached(priority: .userInitiated) { [weak self] in
            // However this loop ends — the stream finished, the task cancelled by `stop()`, a return on the check below —
            // nothing will ever take what is still on the stream, so it is no backlog: a hang report must not go on
            // naming it (and its age) for as long as something holds this feed.
            defer { client.traffic.retire() }
            for await event in client.events {
                let waited = client.traffic.noteConsumed()
                let needsDrain = relay.push(.init(event: event, at: ProcessInfo.processInfo.systemUptime, streamWait: waited))
                if needsDrain { Task { @MainActor [weak self] in await self?.drain() } }
                if Task.isCancelled { return }
            }
        }
        pumpTask = reader
        await reader.value
        await drain() // whatever the last batch left
        if !stopped {
            // Nothing but `stop()` should end this loop: the client's stream is single-consumer, so a second reader of
            // it, or the client closed from outside, leaves a feed that is connected and hears nothing more.
            let label = pinnedSessionId.map { String($0.prefix(10)) } ?? "orb"
            Self.logger.fault("feed \(label, privacy: .public): the client's event stream ended without stop() — this feed receives no more events")
        }
    }

    /// Folds every event the reader has handed over, in order, batch after batch, until none is waiting. One drain
    /// runs at a time: a second asked for while one is under way is a no-op (the running one takes what arrived).
    private func drain() async {
        guard !draining else { return }
        draining = true
        defer { draining = false }
        while !stopped {
            let batch = relay.take()
            if batch.isEmpty { return }
            for entry in batch {
                if stopped { return }
                if case .session(let e) = entry.event {
                    latency.noteConsumed(e, queueWait: entry.streamWait + (ProcessInfo.processInfo.systemUptime - entry.at))
                }
                await handle(entry.event)
            }
        }
    }

    /// Verbatim (AppModel.swift original :63-66): cancel the pump, then a deliberate, detached
    /// close — deliberate closes must not trigger WinterClient's reconnect loop (Task 9).
    func stop() {
        replayDeadline?.cancel()
        stopped = true
        pumpTask?.cancel()
        // A stopped feed is out of the hang reports (a surface may still hold it), and what it had not folded — on the
        // client's stream, in the relay — is never going to be: it is no backlog.
        FeedRegistry.shared.unregister(self)
        client.traffic.retire()
        relay.discard()
        let waiters = attachWaiters
        attachWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
        Task { await client.close() }
    }

    /// Task 5 (2e-iii): the detached window's sidebar "switch in place" action — re-pins an
    /// ALREADY-RUNNING `.pinned` feed onto a different session, reusing the exact attach path
    /// `start()`'s pinned branch uses (`client.attach(sessionId:fromSeq:)` from 0), so the reducer
    /// rebuilds entirely from the new session's own event history. `session.reset()` first, same
    /// as `AppModel.refocus`'s own reset-before-replay — a stale reply/task/pending-interaction
    /// from the OLD session must never bleed into the newly-attached one. No-op in `.followFocus`
    /// mode (no caller re-pins the orb's own feed — `AppModel.focusSession` calls `refocus`
    /// directly instead, since that machinery already lives on `AppModel`, not here).
    func repin(to sessionId: String) async {
        guard case .pinned = mode else { return }
        mode = .pinned(sessionId: sessionId)
        isAttached = false
        chunks.removeAll() // the old session's — never folded into the new one
        session.reset()
        // Buffering starts BEFORE the attach: the pump is already running here, so the replay can
        // arrive while the attach is still awaited.
        beginReplay()
        // Same two lines, and for the same reason — see `start()`'s pinned branch.
        let ceilingSeq = try? await client.attach(sessionId: sessionId, fromSeq: 0)
        attachAnswered(sessionId: sessionId, ceilingSeq: ceilingSeq)
        armReplayCeiling(ceilingSeq)
    }

    private func handle(_ ev: WinterEvent) async {
        for observer in eventObservers { observer.run(ev) }
        if let onEvent, await onEvent(ev) { return }
        switch ev {
        case .session(let e):
            if case .pinned(let sessionId) = mode, e.sessionId == sessionId {
                if replayBuffer != nil {
                    replayBuffer?.append(e)
                    if let ceiling = replayCeiling, !e.isTransient, e.seq >= ceiling { finishReplay() } else { armReplayDeadline() }
                } else if e.isStreamedChunk {
                    chunks.append(e)
                } else {
                    flushChunks()
                    session.apply(e)
                    latency.noteFolded([e])
                }
            }
            // followFocus always supplies onEvent (returns true above) — no fallback needed here.
        case .connection(let s):
            finishReplay()
            flushChunks()
            session.apply(connection: s)
        case .unknown:
            break // newer daemon event — nothing to render for it
        }
    }

    // MARK: - The replay, in one fold

    /// A pinned attach replays the session's whole log from seq 0. Folded event by event, a long
    /// history reached the window over many frames and its transcript slid down through it one item
    /// at a time (user, 2026-10-04). So the replay is held here and folded ONCE
    /// (`SessionModel.apply(replay:)`) when it is complete: when the event at `session.attach`'s
    /// ceiling arrives — the `harness_attached` of this very attach, the replay's last event — or
    /// at once if that is already in hand, or if the attach failed (no replay is coming).
    /// Only a PERSISTED event can be the ceiling: a transient (a streamed chunk of a child at work) is
    /// stamped with the store's current last seq, so one sent just after the attach carries the
    /// ceiling's own seq while the replay is still arriving. `replayFallback` bounds the wait should
    /// the ceiling never come — an idle timer, restarted by every event held, so a long history that
    /// takes a while to arrive is never cut in two; a connection change folds what has arrived first,
    /// so the order of events is kept.
    private var replayBuffer: [SessionEvent]?
    private var replayCeiling: Int?
    private var replayDeadline: DispatchWorkItem?
    static let replayFallback: TimeInterval = 1.5

    private func beginReplay() {
        replayDeadline?.cancel()
        replayDeadline = nil
        replayBuffer = []
        replayCeiling = nil
        session.isLoadingHistory = true
    }

    private func armReplayCeiling(_ ceilingSeq: Int?) {
        guard replayBuffer != nil else { return }
        guard let ceilingSeq else { finishReplay(); return }
        replayCeiling = ceilingSeq
        if replayBuffer?.contains(where: { !$0.isTransient && $0.seq >= ceilingSeq }) == true { finishReplay(); return }
        armReplayDeadline()
    }

    private func armReplayDeadline() {
        guard replayCeiling != nil else { return } // armed once the attach has answered
        replayDeadline?.cancel()
        let deadline = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.finishReplay() }
        }
        replayDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.replayFallback, execute: deadline)
    }

    private func finishReplay() {
        replayDeadline?.cancel()
        replayDeadline = nil
        replayCeiling = nil
        guard let events = replayBuffer else { return }
        replayBuffer = nil
        OrbDebug.log("feed \(pinnedSessionId ?? "-"): replay folded — \(events.count) events")
        session.apply(replay: events)
        session.isLoadingHistory = false
    }

    // MARK: - Streamed chunks, a frame at a time

    /// How long streamed reply chunks wait to be folded together — one display frame.
    static let chunkFlushInterval: TimeInterval = StreamedChunkQueue.assistantInterval

    /// Streamed text — a reply's chunks AND a reasoning block's (`thinking_delta`) — is folded into the
    /// session at most once a frame (reply) or every `StreamedChunkQueue.thinkingInterval` (reasoning),
    /// never once per chunk (user, 2026-10-02; reasoning added 2026-10-08): every fold re-renders
    /// whatever shows the session, and a model sends a chunk every few milliseconds — a session window
    /// re-rendering per chunk fell further and further behind the stream (the dispatch pill showed a
    /// child done while its window was still writing; a window on a 60-call session was minutes behind
    /// a reasoning model, still "working" after the turn had been stopped). Any other event folds the
    /// waiting chunks first, so the session sees every event in order.
    private lazy var chunks = StreamedChunkQueue { [weak self] events in
        self?.session.apply(contentsOf: events)
        self?.latency.noteFolded(events)
    }

    private func flushChunks() { chunks.flush() }
}

// MARK: - Coalescing streamed chunks

extension SessionEvent {
    /// A streamed fragment a model sends every few milliseconds — a reply's chunk or a reasoning
    /// block's increment. Both are TRANSIENT and both are folded in batches (`StreamedChunkQueue`).
    var isStreamedChunk: Bool {
        switch self {
        case .assistantDelta, .thinkingDelta: return true
        default: return false
        }
    }
}

/// Holds streamed chunks and folds each batch with ONE publish (`SessionModel.apply(contentsOf:)`): a
/// reply's chunks at most once a frame, a reasoning block's every 80 ms (a reasoning pill changes less
/// visibly than a reply, and a session full of tool pills costs more to re-render per fold). Shared by
/// the detached windows' feed and the orb's, which fold chunks by the same rule for the same reason.
@MainActor
final class StreamedChunkQueue {
    static let assistantInterval: TimeInterval = 1.0 / 60.0
    static let thinkingInterval: TimeInterval = 0.08

    private var pending: [SessionEvent] = []
    private var dueAt: DispatchTime?
    private let foldInto: ([SessionEvent]) -> Void

    init(foldInto: @escaping ([SessionEvent]) -> Void) {
        self.foldInto = foldInto
    }

    var count: Int { pending.count }

    static func interval(for event: SessionEvent) -> TimeInterval {
        if case .thinkingDelta = event { return thinkingInterval }
        return assistantInterval
    }

    func append(_ event: SessionEvent) {
        pending.append(event)
        let due = DispatchTime.now() + Self.interval(for: event)
        // A flush is already due no later than this chunk needs: it will take this one too.
        if let dueAt, dueAt <= due { return }
        dueAt = due
        DispatchQueue.main.asyncAfter(deadline: due) { [weak self] in
            MainActor.assumeIsolated { self?.flush() }
        }
    }

    /// Folds what is waiting, now. A scheduled flush that fires after this finds nothing and does nothing.
    func flush() {
        dueAt = nil
        guard !pending.isEmpty else { return }
        let events = pending
        pending.removeAll(keepingCapacity: true)
        foldInto(events)
    }

    /// Drops what is waiting unfolded (the session it belonged to is gone).
    func removeAll() {
        pending.removeAll()
        dueAt = nil
    }
}


/// Events the reader has taken off the client's stream and the main actor has not yet folded. A lock, a buffer and
/// one flag: `push` says whether the main actor must be asked to drain (none is already on its way), `take` hands
/// over everything and re-arms.
final class EventRelay: @unchecked Sendable {
    struct Entry: @unchecked Sendable {
        let event: WinterEvent
        /// When it was handed over (monotonic seconds), and how long it had waited on the client's stream before.
        let at: TimeInterval
        let streamWait: TimeInterval
    }

    private let lock = NSLock()
    private var entries: [Entry] = []
    private var drainRequested = false

    /// Adds `entry`; true when the caller must now ask the main actor to drain.
    func push(_ entry: Entry) -> Bool {
        lock.lock(); defer { lock.unlock() }
        entries.append(entry)
        if drainRequested { return false }
        drainRequested = true
        return true
    }

    func take() -> [Entry] {
        lock.lock(); defer { lock.unlock() }
        let taken = entries
        entries = []
        drainRequested = false
        return taken
    }

    /// Drops everything held (the feed is stopped: nothing will fold it).
    func discard() {
        lock.lock(); defer { lock.unlock() }
        entries = []
    }

    var count: Int { lock.lock(); defer { lock.unlock() }; return entries.count }
}


/// One tap on a feed (`SessionFeed.observeEvents`/`observeConnected`/`observeAttach`): cancelled by its owner when the
/// owner lets go of the feed, or leaves it for another.
@MainActor
final class FeedObservation {
    private var onCancel: (() -> Void)?
    private(set) var isActive = true

    init(onCancel: @escaping () -> Void) { self.onCancel = onCancel }

    func cancel() {
        guard isActive else { return }
        isActive = false
        onCancel?()
        onCancel = nil
    }
}
