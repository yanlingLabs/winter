import Foundation
import NormaKit
import NormaProtocol

/// 2e-iii Task 5: a live list of every session (title/createdAt/scope/cwd), backing the left
/// sidebar's session switcher (`SessionSidebar` — not yet mounted anywhere, Task 6 does that).
/// Deliberately socket-free: production wiring (`AppModel`/`DetachedWindowController`, both own
/// their own `NormaClient`) injects a `lister` closure around `client.listSessions()`, the same
/// dependency-injection shape `SessionFeed` uses for its transport — this file stays testable with
/// a stub closure, no scripted transport needed (see `SessionDirectoryTests`).
@MainActor
final class SessionDirectory: ObservableObject {
    @Published private(set) var rows: [SessionSummary] = []

    private let lister: () async throws -> [SessionSummary]
    /// app-shell Task 2: the poll's tick, injectable so a test drives it deterministically instead
    /// of waiting on a real 5s sleep — the same seam shape as `PairingSheetModel`'s `sleepTick`
    /// (NormaKit), just defaulted to a real `Task.sleep` here since this type has no `now()` clock
    /// of its own to pair it with.
    private let sleepTick: @Sendable () async -> Void
    private var pollTask: Task<Void, Never>?

    init(
        lister: @escaping () async throws -> [SessionSummary],
        sleepTick: @escaping @Sendable () async -> Void = { try? await Task.sleep(for: .seconds(5)) }
    ) {
        self.lister = lister
        self.sleepTick = sleepTick
    }

    /// Full re-list, newest-first. Defensive: a thrown/failed `lister` call (daemon hiccup, RPC
    /// timeout) leaves `rows` exactly as they were — a transient failure must never blank the
    /// sidebar out from under the user.
    func refresh() async {
        guard let fetched = try? await lister() else { return }
        rows = fetched.sorted { $0.createdAt > $1.createdAt }
    }

    /// FINAL-REVIEW FIX (M1): the wirers' (`AppModel.init` / `DetachedWindowController.init`) own
    /// bootstrap kick, named so it's a single testable seam instead of an inline
    /// `Task { await refresh() }` duplicated at both construction sites. Fire-and-forget, same
    /// posture as `handle`'s event-triggered refreshes below: without SOME initial load, a cold
    /// window's session switcher (and `WorkSidebar`'s info block, which reads this same `directory`
    /// instance) stays empty until an unrelated session_created/session_titled broadcast happens to
    /// arrive — spec demands "session.list on appear + refresh on events", not "…or whenever the
    /// next broadcast happens to land." A failure here (e.g. this directory's own harness hasn't
    /// finished `client.connect()` yet at construction time) is silently absorbed by `refresh()`'s
    /// own `try?`; `SessionSidebar`'s own `.task { await directory.refresh() }` and every
    /// session-lifecycle broadcast are the belt-and-suspenders that keep retrying.
    func startInitialLoad() {
        Task { await refresh() }
    }

    /// app-shell Task 2: the visible-gated `session.list` poll — the belt to `handle`'s suspenders
    /// below. Broadcasts cover every ADDITION (`session_created`) and most in-place edits
    /// (`session_titled`, `session_activity`), but nothing ever announces a DELETION, so a row
    /// pruned by the daemon (never happens today, but `refresh()`'s full-replacement fold already
    /// handles it for free — see that method's own doc) only leaves this directory once something
    /// re-lists. That something is this poll.
    ///
    /// Driven by `AppWindowController.onRenderingActiveChange` (T1's visibility signal): `true`
    /// while the shell window is visible AND unoccluded (re)starts a loop that waits one
    /// `sleepTick` then `refresh()`es, repeating for as long as it stays active; `false` cancels any
    /// outstanding loop outright — no ticks, no `session.list` calls, while the window is hidden.
    /// Same cancel-then-maybe-restart shape as `PairingSheetModel.startFreshOffer`'s countdown-task
    /// replacement: a redundant `true` while already active resets the loop rather than stacking a
    /// second one.
    func setPolling(active: Bool) {
        pollTask?.cancel()
        pollTask = nil
        guard active else { return }
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.sleepTick()
                if Task.isCancelled { return }
                await self.refresh()
            }
        }
    }

    /// Session-lifecycle events broadcast to every authed harness (`session_created`,
    /// `session_titled` — see the daemon's fan-out, spec'd in Task 1/2/3 of this phase). Both kick
    /// a full `refresh()` so the row list itself (new row appearing; sort order) stays correct; a
    /// titled event ADDITIONALLY patches the affected row's title in place, synchronously, so the
    /// sidebar's title updates the instant the event arrives rather than waiting on the refresh
    /// round trip (which the caller's own socket may be mid-backoff on).
    func handle(_ event: SessionEvent) {
        switch event {
        case .sessionTitled(let v):
            if let idx = rows.firstIndex(where: { $0.sessionId == v.sessionId }) {
                rows[idx].title = v.title
            }
            Task { await refresh() }
        case .sessionCreated:
            Task { await refresh() }
        case .childUpdate:
            // Dispatch (Phase 7): a child session just spawned/finished — refresh so the list
            // picks up its row (mode/parentSessionId, already threaded through `lister`'s mapping)
            // and status changes, same cadence as `sessionCreated` above.
            Task { await refresh() }
        case .sessionActivity(let v):
            // app-shell Task 2, THE dedupe trap (CLAUDE.md's iOS-streaming lesson, hand-copied
            // here on purpose): this event is TRANSIENT — stamped with the store's `lastSeq`, never
            // persisted, and NormaKit's own `route()` already exempts it from seq dedupe before it
            // ever reaches `feed.onEvent`/this method. Gating this patch on `v.seq` (e.g. dropping
            // it when `v.seq <= someCursor`) would therefore drop EVERY one of these, forever,
            // silently — a transient routinely arrives AT or BELOW a caught-up client's cursor. So:
            // DERIVE, patching the matching row directly off the payload, exactly like the titled
            // patch above — never compare `v.seq` against anything.
            //
            // No `Task { await refresh() }` follow-up (unlike every other case here): activity is
            // the daemon's own DERIVED read-time state, and `session.list` would answer the exact
            // same string this event already carries — a refresh here buys nothing but an extra
            // round trip on top of every attach/detach/backgrounding churn.
            //
            // An id this directory doesn't know about yet (arrived before the initial `refresh()`
            // populated `rows`, or for a session this window never listed) is silently ignored —
            // never a crash, and never a synthesized row from a payload that carries only
            // `sessionId`/`activity`, missing every other field `SessionSummary` needs.
            if let idx = rows.firstIndex(where: { $0.sessionId == v.sessionId }) {
                rows[idx].activity = v.activity
            }
        default:
            break // every other event type is irrelevant to the session list itself
        }
    }
}

/// One row of the directory. `id` mirrors `sessionId` (`Identifiable` for `ForEach` in
/// `SessionSidebar`) rather than being a separate synthesized value — two rows for the same
/// session id are never a legitimate state.
struct SessionSummary: Equatable, Identifiable {
    let sessionId: String
    var title: String?
    var createdAt: Int
    var scope: String
    var cwd: String?
    // Dispatch (Phase 7): threaded through from listSessions() — `SessionsPane` (Task 7) consumes
    // both: `mode == "dispatch"` drives the row's badge, `parentSessionId` drives the child-follows-
    // parent grouping/indent. Defaulted (unlike title/cwd above) so existing memberwise-init call
    // sites (SessionDirectoryTests) don't all need touching for an additive field older tests never
    // set.
    var mode: String? = nil
    var parentSessionId: String? = nil
    // Chat Slice D Task 10: threaded through from listSessions() (T1's per-session model override,
    // deferred by T1 itself — "no consumer yet") — `WindowContentView`'s model menu reads this
    // straight off the current session's row (`currentSidebarSessionSummary`, WorkSidebar.swift)
    // to know what's currently pinned, same "read fresh from the directory" convention as
    // `sidebarSessionInfo`'s title/scope/cwd rows. Defaulted, same reasoning as `mode` above.
    var model: String? = nil
    /// provider-correctness T6: threaded through from `listSessions()` (T4's per-session effort
    /// override) — `WindowContentView`'s effort menu reads this to know what is currently pinned,
    /// same convention as `model` above.
    ///
    /// The value may be a Norma-level TIER (`"ultra"`) reported VERBATIM rather than its wire
    /// translation (`SessionListResult.effort`'s own doc comment) — so a picker matching it against
    /// the chosen model's `efforts` array alone will show no checkmark. Match against BOTH lists.
    var effort: String? = nil
    /// working-directories T8: the session's ordered working-directory set, threaded through from
    /// `listSessions()` — the create picker's recents (`recentWorkingDirs`) and the header chip
    /// (`dirsMenuIsVisible`/`dirsChipLabel`) read it straight off this row, same "read fresh from the
    /// directory" convention as `model`/`effort` above. Defaulted, same reasoning as `mode`.
    ///
    /// **`nil` ≠ `[]`.** `nil` = the daemon populated no set at all (chat/dispatch have no
    /// working-directory concept — `session.list`'s own participation gate); `[]` = a real
    /// WORKDIR-LESS session, writable only in `$OUTDIR`/`$TMPDIR`/`$MEMDIR`. `cwd` above is the
    /// daemon's alias of `dirs[0]?.path` for a participating row, never an independent fact.
    var dirs: [SessionDirEntry]? = nil
    /// app-shell Task 2: threaded through from `listSessions()` (NormaKit's own `activity` decode)
    /// AND kept live by `handle`'s `.sessionActivity` case above — every later app-shell surface
    /// (chips, tabs, roster, panel) reads this field, never `listSessions()` directly. Defaulted,
    /// same reasoning as `mode`/`dirs` above.
    ///
    /// One of `"active"|"background"|"idle"|"archived"` for a participating (code/cowork) row,
    /// `nil` for a chat/dispatch row or a daemon predating the field — the SAME absent-is-a-real-
    /// value discipline `dirs` documents above. Never coerce absence to a displayed value.
    var activity: String? = nil
    var id: String { sessionId }
}
