import Foundation
import NormaProtocol
import NormaKit

/// One live view of one session: its own `NormaClient` (own socket — a full Norma harness),
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
    let client: NormaClient
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
    var onEvent: ((NormaEvent) async -> Bool)?
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

    init(makeTransport: @escaping @Sendable () -> NormaTransport, token: String, clientName: String, mode: Mode, session: SessionModel) {
        client = NormaClient(makeTransport: makeTransport, token: token, clientName: clientName)
        self.mode = mode
        self.session = session
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
            onPinnedAttach?(sessionId, try? await client.attach(sessionId: sessionId, fromSeq: 0))
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
    /// close — deliberate closes must not trigger NormaClient's reconnect loop (Task 9).
    func stop() {
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
        session.reset()
        onPinnedAttach?(sessionId, try? await client.attach(sessionId: sessionId, fromSeq: 0))
    }

    private func handle(_ ev: NormaEvent) async {
        if let onEvent, await onEvent(ev) { return }
        switch ev {
        case .session(let e):
            if case .pinned(let sessionId) = mode, e.sessionId == sessionId {
                session.apply(e)
            }
            // followFocus always supplies onEvent (returns true above) — no fallback needed here.
        case .connection(let s):
            session.apply(connection: s)
        case .unknown:
            break // newer daemon event — nothing to render for it
        }
    }
}
