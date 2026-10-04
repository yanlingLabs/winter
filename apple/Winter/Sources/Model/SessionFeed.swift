import Foundation
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

    init(makeTransport: @escaping @Sendable () -> WinterTransport, token: String, clientName: String, mode: Mode, session: SessionModel) {
        client = WinterClient(makeTransport: makeTransport, token: token, clientName: clientName)
        self.mode = mode
        self.session = session
        if case .pinned = mode { session.isLoadingHistory = true }
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
        // The daemon may not be up yet — retry the INITIAL connect with capped backoff.
        var attempt = 0
        while true {
            do {
                try await client.connect()
                break
            } catch {
                attempt += 1
                onRetry?()
                let backoff = min(0.5 * pow(2.0, Double(attempt - 1)), 10.0)
                try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                if Task.isCancelled { return }
            }
        }

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
            onPinnedAttach?(sessionId, ceilingSeq)
            armReplayCeiling(ceilingSeq)
        }
        session.markConnected() // M2: connect() success IS the connected signal
        onConnected?()

        pumpTask = Task { [weak self] in
            guard let self else { return }
            for await ev in self.client.events {
                await self.handle(ev)
                if Task.isCancelled { return }
            }
        }
        await pumpTask?.value
    }

    /// Verbatim (AppModel.swift original :63-66): cancel the pump, then a deliberate, detached
    /// close — deliberate closes must not trigger WinterClient's reconnect loop (Task 9).
    func stop() {
        replayDeadline?.cancel()
        pumpTask?.cancel()
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
        pendingChunks.removeAll() // the old session's — never folded into the new one
        session.reset()
        // Buffering starts BEFORE the attach: the pump is already running here, so the replay can
        // arrive while the attach is still awaited.
        beginReplay()
        // Same two lines, and for the same reason — see `start()`'s pinned branch.
        let ceilingSeq = try? await client.attach(sessionId: sessionId, fromSeq: 0)
        onPinnedAttach?(sessionId, ceilingSeq)
        armReplayCeiling(ceilingSeq)
    }

    private func handle(_ ev: WinterEvent) async {
        if let onEvent, await onEvent(ev) { return }
        switch ev {
        case .session(let e):
            if case .pinned(let sessionId) = mode, e.sessionId == sessionId {
                if replayBuffer != nil {
                    replayBuffer?.append(e)
                    if let ceiling = replayCeiling, !e.isTransient, e.seq >= ceiling { finishReplay() } else { armReplayDeadline() }
                } else if case .assistantDelta = e {
                    pendingChunks.append(e)
                    scheduleChunkFlush()
                } else {
                    flushChunks()
                    session.apply(e)
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

    /// How long streamed chunks wait to be folded together — one display frame.
    static let chunkFlushInterval: TimeInterval = 1.0 / 60.0
    private var pendingChunks: [SessionEvent] = []
    private var chunkFlushScheduled = false

    /// Streamed text is folded into the session at most once a frame, never once per chunk (user,
    /// 2026-10-02): every fold re-renders whatever shows the session, and a model sends a chunk every
    /// few milliseconds — a session window re-rendering per chunk fell further and further behind
    /// the stream (the dispatch pill showed a child done while its window was still writing). Any
    /// other event folds the waiting chunks first, so the session sees every event in order.
    private func scheduleChunkFlush() {
        guard !chunkFlushScheduled else { return }
        chunkFlushScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.chunkFlushInterval) { [weak self] in
            MainActor.assumeIsolated { self?.flushChunks() }
        }
    }

    private func flushChunks() {
        chunkFlushScheduled = false
        guard !pendingChunks.isEmpty else { return }
        let chunks = pendingChunks
        pendingChunks.removeAll(keepingCapacity: true)
        session.apply(contentsOf: chunks)
    }
}
