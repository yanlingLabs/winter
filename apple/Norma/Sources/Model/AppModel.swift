import Foundation
import WinterProtocol
import WinterKit

@MainActor
final class AppModel: ObservableObject {
    let session = SessionModel()
    @Published private(set) var connectionSummary = "connecting…"

    /// Owns the socket + connect/attach/pump mechanics (2d-ii-b Task 1 extraction, see
    /// SessionFeed.swift). AppModel is its `followFocus` consumer — the focus-tracking state
    /// below stays here; it's specific to this mode and SessionFeed's `pinned` mode doesn't need
    /// it.
    private let feed: SessionFeed
    /// Task 4 (2f): widened from `private` so `AppDelegate.boot()` can construct `PeripheralProvider`
    /// against THIS SAME client/socket — the daemon rule (Task 3's server wiring) is THE provider =
    /// the most-recent-advertiser CONNECTION, so advertise/respond/revoke must all go through the
    /// app's MAIN feed client, never a second one.
    var client: WinterClient { feed.client }
    /// Task 5 (2e-iii): the left sidebar's live session list (`SessionSidebar`, not yet mounted —
    /// Task 6 does that). Lists via this AppModel's own `client`, same socket the orb's focus-follow
    /// feed already uses — no second harness for the directory.
    let directory: SessionDirectory
    /// Task 4: `private(set)` (was fully `private`) so AppDelegate's detach closure can capture the
    /// currently-focused session id BEFORE `startFreshSessionAfterDetach()` flips it — the
    /// detached window needs the OLD id (via `makeDetachedFeed(sessionId:)`), the orb needs a NEW
    /// one.
    private(set) var focusedSessionId: String?
    private var selfCreatedSessionId: String?

    /// Task 3 (2d-ii-b): stashed so `makeDetachedFeed(sessionId:)` can mint a FRESH `SessionFeed`
    /// (its own `WinterClient`/socket — a full harness, spec §"harness-per-window") for a detached
    /// window, sharing the same transport factory + token AppModel itself connects with (one
    /// Keychain read, shared — no per-window Keychain prompts). Previously only passed through to
    /// the `followFocus` feed built in `init` below; nothing needed to reconstruct another one.
    private let makeTransport: @Sendable () -> WinterTransport
    private let token: String
    private let clientName: String

    /// The sentinel `AppDelegate.boot()` passes when the Keychain has no harness token yet (see
    /// `AppDelegate.swift`'s `production`/`tokenMissing` wiring) — kept in sync with that literal
    /// by hand; `makeDetachedFeed` refuses to spawn a harness against it (spec §4: "cannot spawn a
    /// harness without a token").
    static let missingTokenSentinel = "missing-token"

    /// Task 4 (2f): set by `AppDelegate.boot()` right after constructing `PeripheralProvider`
    /// against `client` above. Composed into `feed.onEvent`/`feed.onConnected` below exactly like
    /// `directory.handle(e)` — a side-observer, never gating `handle(ev)`'s own focused-session
    /// filtering or the fixed `return true`. Lease events arrive on the REQUESTER's session (which
    /// this AppModel may not be focused on at all) — that's expected, not a bug; see
    /// `PeripheralProvider.handle`'s doc comment.
    var onPeripheralEvent: ((SessionEvent) async -> Void)?
    /// Task 4 (2f): fired once per successful connect (mirrors `onConnected` above) — the seam
    /// `PeripheralProvider.advertiseIfConnected()` hangs off (spec §A4: "advertises on connect").
    var onClientConnected: (() -> Void)?
    /// Menu-bar status feed (Task DD-T5). Fired on MainActor only when the derived
    /// `MenuBarActivity` value CHANGES — see `handle(_ ev:)`'s derive-and-publish step at the
    /// single point every event flows through.
    var onActivityChange: ((MenuBarActivity) -> Void)?
    private var menuBarActivity: MenuBarActivity = .idle

    /// orb-scope Part 2: the Mac app's own harness registers under this clientName — every
    /// `user_message` the orb/field surface itself sends (via `sendOrSteer`'s `client.send` path,
    /// a genuine new-turn submit) carries it verbatim (daemon: `hub.send` stamps
    /// `clientName: client.clientName` off the connection's own registered identity,
    /// `packages/core/src/sessions/hub.ts`). Named here (not just inlined as the init default
    /// below) so `SessionReducer`'s `lastTurnWasOrbInitiated` derivation
    /// (`SessionModel.swift`) has ONE source of truth to compare against instead of a second,
    /// independently-drifting literal.
    static let ownClientName = "orb"

    init(makeTransport: @escaping @Sendable () -> WinterTransport, token: String, clientName: String = AppModel.ownClientName) {
        self.makeTransport = makeTransport
        self.token = token
        self.clientName = clientName
        feed = SessionFeed(makeTransport: makeTransport, token: token, clientName: clientName, mode: .followFocus, session: session)
        let feedClient = feed.client
        directory = SessionDirectory(lister: {
            try await feedClient.listSessions().map {
                SessionSummary(sessionId: $0.sessionId, title: $0.title, createdAt: $0.createdAt, scope: $0.scope, cwd: $0.cwd, mode: $0.mode, parentSessionId: $0.parentSessionId, model: $0.model, effort: $0.effort, dirs: $0.dirs, activity: $0.activity, archived: $0.archived, signals: $0.signals, approvalPolicy: $0.approvalPolicy, runtimeKind: $0.runtimeKind, providerId: $0.providerId)
            }
        })
        // FINAL-REVIEW FIX (M1): cold-window bootstrap — session.list on construction, not only on
        // the next session_created/session_titled broadcast. See SessionDirectory.startInitialLoad's
        // doc for why a lost race against this AppModel's own not-yet-connected client is harmless.
        directory.startInitialLoad()
        // Hook composition (see SessionFeed's doc comment for why): these four closures are the
        // ONLY seam between the extracted mechanics and AppModel's focus-follow behavior, each
        // firing at the exact point the original monolithic start()/handle() touched app state.
        feed.onRetry = { [weak self] in self?.connectionSummary = "daemon unreachable — retrying…" }
        feed.onAttach = { [weak self] in await self?.focusNewestSession() }
        feed.onConnected = { [weak self] in
            guard let self else { return }
            self.connectionSummary = self.summaryLine()
            self.onClientConnected?()
        }
        feed.onEvent = { [weak self] ev in
            // Task 5 (2e-iii): forward session_created/session_titled to the directory FIRST —
            // composed at the top of the existing closure, not a replacement of it (the hook
            // contract's "return true consumes the event" doesn't apply here: `handle(ev)` below
            // still fully owns event application in followFocus mode, same as before this task).
            // Task 4 (2f): the peripheral provider hook is composed the SAME way, right after —
            // both are side-observers of the raw event, independent of `handle(ev)`'s focused-
            // session filtering below.
            if case .session(let e) = ev {
                self?.directory.handle(e)
                await self?.onPeripheralEvent?(e)
            }
            await self?.handle(ev)
            return true // AppModel's handle() fully owns event application in followFocus mode.
        }
    }

    /// Production wiring: harness token from the Keychain, profile-resolved unix socket (devfix
    /// socket strand — `WinterPaths.socketPath(home:)` with `AppProfile.winterHome`, not the bare
    /// no-arg `socketPath()`, so a dev-profile app dials its OWN daemon's socket instead of
    /// whatever `$WINTER_HOME` independently resolves to).
    static func production() throws -> AppModel {
        let token = try KeychainToken.readHarnessToken(service: AppProfile.keychainService)
        let path = WinterPaths.socketPath(home: AppProfile.winterHome)
        return AppModel(makeTransport: { UnixSocketTransport(path: path) }, token: token)
    }

    func start() async {
        await feed.start()
    }

    func stop() {
        feed.stop()
    }

    /// Task 3 (2d-ii-b): a detached window's own harness — a FRESH `SessionModel` + a `pinned`
    /// `SessionFeed` sharing AppModel's transport factory/token/clientName, wired to `sessionId`
    /// forever (never follows focus). Returns `nil` when this AppModel was booted with the
    /// degraded "no daemon token yet" fallback (`AppDelegate.boot()`'s `tokenMissing` path,
    /// `missingTokenSentinel`) — spec §4: "cannot spawn a harness without a token," logged rather
    /// than silently handed a client that can never authenticate.
    func makeDetachedFeed(sessionId: String) -> (feed: SessionFeed, session: SessionModel)? {
        guard token != Self.missingTokenSentinel else {
            OrbDebug.log("makeDetachedFeed: no daemon token — refusing to spawn a detached harness for \(sessionId.prefix(10))")
            return nil
        }
        let detachedSession = SessionModel()
        let detachedFeed = SessionFeed(
            makeTransport: makeTransport, token: token, clientName: clientName,
            mode: .pinned(sessionId: sessionId), session: detachedSession
        )
        return (detachedFeed, detachedSession)
    }

    /// Field summon path: a session to talk to — the ONE permanent dispatch session (Phase 7),
    /// get-or-created via `session.dispatch` when none is focused.
    ///
    /// Approval policy is the DAEMON's business now: `session.dispatch` sets the dispatch
    /// singleton's policy ("auto") server-side, so this client no longer passes one (the old
    /// `createSession(approvalPolicy: "auto")` call did). The daemon's reviewer still gates
    /// dangerous bash regardless of policy — auto ≠ unguarded. Sessions the orb merely
    /// FOLLOWS (created elsewhere, e.g. the CLI) keep their creator's policy, unchanged.
    func ensureFocusedSession() async -> String? {
        if let sid = focusedSessionId { return sid }
        guard let created = try? await client.dispatchSession() else { return nil }
        // The daemon broadcasts session_created BEFORE the RPC response returns; the pump may
        // have already refocused us onto the new session. Idempotent skip — never double-attach.
        if focusedSessionId == created.sessionId { return focusedSessionId }
        selfCreatedSessionId = created.sessionId // belt: suppress the broadcast if it arrives AFTER us
        await refocus(onto: created.sessionId)
        return focusedSessionId
    }

    /// DEFECT FIX (reviewed defect, 2e-iv): the fresh-session identity, EXPLICIT — returns the
    /// newly created session's id, or `nil` on an RPC failure. `startFreshSessionAfterDetach()`
    /// below used to be the ONLY entry point, and a caller needing to know "did this actually
    /// succeed" had no choice but to infer it from `focusedSessionId` afterward — which silently
    /// stays whatever it already was (a STALE pre-existing focus, if one existed) when the create
    /// RPC fails, since nothing here ever clears it on failure. `AppDelegate`'s now-retired
    /// `openStandaloneWinterWindow()` (App shell T6) used to read `focusedSessionId` that way and
    /// could spawn its standalone window on a stale prior session when the create failed. Returning
    /// the id makes success/failure the return value's
    /// job instead: `nil` unambiguously means "nothing was created," regardless of whatever
    /// `focusedSessionId` happened to be already — the caller no longer needs (or is tempted) to
    /// re-derive that from focus state.
    @discardableResult
    func startFreshSession() async -> String? {
        // Dispatch (Phase 7): the orb has exactly ONE permanent session; "fresh" refocuses onto it.
        guard let created = try? await client.dispatchSession() else { return nil }
        // Same belt as ensureFocusedSession(): the daemon's session_created broadcast can arrive
        // (and refocus us) before this RPC response does — idempotent skip, never double-attach.
        if focusedSessionId == created.sessionId { return focusedSessionId }
        selfCreatedSessionId = created.sessionId // suppress the broadcast if it arrives AFTER us
        await refocus(onto: created.sessionId)
        // DEFECT FIX (residual leg, final-review Medium): `createSession` can succeed while the
        // follow-up `refocus`'s `session.attach` then fails. `WinterClient.attach` rolls
        // `attachedSessionId` back to its pre-call value on throw, and `refocus`'s catch
        // reconciles `focusedSessionId` to that same rolled-back (STALE, pre-existing) session —
        // never to `created.sessionId`. Returning `focusedSessionId` unconditionally here would
        // then hand the caller that stale id as if it were the fresh one; only return success
        // when focus actually landed on the session we just created.
        guard focusedSessionId == created.sessionId else {
            OrbDebug.log("startFreshSession: post-refocus focus (\(focusedSessionId ?? "nil")) != created session (\(created.sessionId)) — attach must have failed; returning nil instead of a stale id")
            return nil
        }
        return focusedSessionId
    }

    /// The generic "create a brand-new session and focus onto it" primitive — despite the name it is
    /// NOT detach-specific. Two callers: (1) Task 4 detach choreography, the orb's "clean slate" step
    /// after a detach (the session it was just focused on now belongs to a standalone detached window
    /// — its own harness, see `makeDetachedFeed(sessionId:)` — so the orb's NEXT summon must never
    /// keep talking into that same session); (2) 2e-iii Task 6, the sidebars' "new session"
    /// affordance (`SidebarWiring.onNewSession`), a plain create+focus with no detach involved.
    ///
    /// Exact `ensureFocusedSession()` creation body above, but UNCONDITIONAL: skips the
    /// `if let sid = focusedSessionId { return sid }` early-out on purpose — a focus almost always
    /// exists at these call sites, and this must create+refocus onto a brand-new one regardless.
    ///
    /// DEFECT FIX: now a thin delegation to `startFreshSession()` above — same create+focus
    /// behavior for these two void-returning callers, unchanged.
    func startFreshSessionAfterDetach() async {
        await startFreshSession()
    }

    /// Field submit: steer a running turn, otherwise send (starts a turn). CLI parity.
    ///
    /// 2d-iii task 4 (force-auto removal): this used to force the focused session to
    /// `approvalPolicy: "auto"` before the first send/steer (Finding-1, gate 2 — the orb had no
    /// approval UI, so an "ask"-mode session it merely followed would hang forever on the first
    /// approval). The orb now HAS approval UI (pending-interaction cards, task 3) — an attached
    /// session keeps whatever policy its creator gave it, and any approval/question/plan it raises
    /// simply surfaces as a card instead of being silently forced past. See `setSessionPolicy`
    /// below for the new, EXPLICIT (user-driven, ⋯ menu) way to change a session's policy.
    func sendOrSteer(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sid = await ensureFocusedSession() else { return false }
        if session.state.turnRunning {
            return (try? await client.steer(sessionId: sid, text: trimmed)) != nil
        }
        return (try? await client.send(sessionId: sid, text: trimmed)) != nil
    }

    /// Task 4 (2d-iii): the ⋯ menu's approval-mode picker — the orb's own focused-session surface
    /// for an EXPLICIT, user-driven policy change (replaces the removed `forceAutoPolicyIfNeeded`).
    /// Mirrors `sendOrSteer`'s shape: guard a focused session, `try?` the RPC, `nil`/throw means
    /// failure. Does NOT update any local policy cache — `FieldStateAdapter.sessionPolicy` is
    /// bumped by the WIRER (`GlassRootView`/`DetachedWindowController`) on a `true` return, same
    /// convention as `interactionInFlight`/`interactionErrors`.
    func setSessionPolicy(_ policy: String) async -> Bool {
        guard let sid = focusedSessionId else { return false }
        return (try? await client.setPolicy(sessionId: sid, policy: policy)) != nil
    }

    /// Task 10 (Chat Slice D): the model menu's own focused-session surface for an EXPLICIT,
    /// user-driven model change — mirrors `setSessionPolicy` just above exactly (guard a focused
    /// session, `try?` the RPC, `nil`/throw means failure). `model: nil` clears the override
    /// (`WinterClient.setModel` sends a literal wire `null`, never an omitted key). Unlike
    /// `setSessionPolicy`, there is no mode-agnostic special case to guard here — `session.setModel`
    /// itself has none (ipc/server.ts's own doc comment: "no chat/dispatch special case").
    ///
    /// Winter Phase 8d (Task 4.2): now a thin wrapper over `Self.applyModelChange` — the ONE door
    /// every `session.setModel` call in the app goes through (`ShellSessionHost`'s and
    /// `DetachedWindowController`'s own live-session `adapter.onSetModel` wiring, and
    /// `stampHeldSelection`'s new-chat stamp, call the static helper directly with their own
    /// `client`/`sessionId` — none of those holds an `AppModel`). This wrapper keeps returning
    /// `Bool` (`outcome == .ok`) rather than the full outcome: its one caller is the orb's
    /// `OrbWindowController.onSetModel` bridge (via `AppDelegate`), whose `(String?) async -> Bool`
    /// shape predates 8d and whose compact picker has no confirm-sheet surface to populate — a
    /// `.confirmationRequired`/`.disabled`/`.lossyFork`/`.blocked` outcome there degrades to the
    /// same "the change did not take" the orb has always shown for any refusal, never a crash and
    /// never a silent lossy switch. `ShellSessionHost`/`DetachedWindowController`'s wiring (this
    /// file's neighbours) call `Self.applyModelChange` directly instead of this method, because
    /// THEY have the confirm-sheet state (`FieldStateAdapter.pendingModelConfirmation`) to fill in.
    func setSessionModel(_ model: String?) async -> Bool {
        guard let sid = focusedSessionId else { return false }
        return await Self.applyModelChange(client: client, sessionId: sid, model: model) == .ok
    }

    /// provider-correctness T6: the effort menu's focused-session surface — `setSessionModel`'s
    /// exact twin on the other axis ("effort and model are two different things, just like the
    /// CLI"). `effort: nil` clears the override (a literal wire null). Like `setSessionModel`, there
    /// is no mode special case to guard here: `session.setEffort` is mode-agnostic — what IS
    /// mode-scoped is which levels a picker may OFFER (a Winter tier is code-sessions-only), and that
    /// is the picker's obligation, enforced daemon-side, not this method's.
    func setSessionEffort(_ effort: String?) async -> Bool {
        guard let sid = focusedSessionId else { return false }
        return (try? await client.setEffort(sessionId: sid, effort: effort)) != nil
    }

    /// provider-correctness T6: the daemon's synced model catalogue (`sync.config`) — the pickers'
    /// only source of slugs and effort levels. `nil` on any failure, which leaves the caller's
    /// existing catalogue untouched: a daemon hiccup must never blank a picker out from under the
    /// user, the same posture `SessionDirectory.refresh` takes for the same reason.
    func fetchModelCatalogue() async -> SyncConfigSnapshot? {
        try? await client.syncConfig()
    }

    func interruptTurn() async {
        guard let sid = focusedSessionId else { return }
        _ = try? await client.interrupt(sessionId: sid)
    }

    // MARK: - Task 3 (2d-iii): pending-interaction respond — the orb's own focused-session surface,
    // mirroring `sendOrSteer`'s shape exactly (guard a focused session, `try?` the RPC, `nil` on
    // throw means failure). Deliberately does NOT force-auto/create a session the way
    // `sendOrSteer`/`ensureFocusedSession` do — a respond only ever targets a callId the daemon
    // already asked THIS focused session about, so there is nothing to create here; no focused
    // session simply means there is nothing to respond to (fails closed, `false`).
    //
    // `WinterClient`'s three respond methods each return `alreadyResolved` (a race indicator, not
    // a success flag) — that's a different signal than "did the RPC succeed," so it's discarded
    // here in favor of the same `!= nil` success convention `sendOrSteer` already uses.

    // TASK-3 REVIEW FIX (silent false-success race): the callId is bound at click time, but
    // these methods run in a deferred Task — a concurrent refocus (session_created follow)
    // could swap `focusedSessionId` in between, shipping {NEW sessionId, OLD callId}. The
    // daemon's brokers never throw on a miss (they return alreadyResolved: true), so that
    // mismatch used to read as plain SUCCESS while the real pending interaction sat
    // unresolved. The guard below closes it on the main actor: `refocus` swaps
    // `focusedSessionId` and resets `session` state in the same synchronous run, so "callId
    // still pending in the current session's state" proves the {sessionId, callId} pair is
    // consistent. A stale click fails closed (false → the card's inline error line; after a
    // refocus the card itself is already gone anyway).

    private func pendingCallIdIsCurrent(_ callId: String) -> Bool {
        session.state.pendingInteractions.contains { $0.callId == callId }
    }

    /// `childSessionId` (Dispatch, Phase 7): set only on the mirrored copy of a CHILD session's
    /// approval (`TranscriptInteractionCard`'s own `InteractionRecord.Ask.approval` payload) — routes the respond
    /// RPC straight to the child instead of this focused (dispatch) session. `nil` is the pre-
    /// Phase-7 behavior, unchanged: respond into whatever session is currently focused.
    /// `optionId` (SP-approvals T6): the allow-rule choice tapped, when the card offered any —
    /// threaded straight through to `WinterKit`'s `approvalRespond`, `nil` for the plain Approve/
    /// Deny buttons (allow-once/deny carry no rule to persist).
    func respondApproval(callId: String, approved: Bool, optionId: String? = nil, childSessionId: String? = nil) async -> Bool {
        let target = childSessionId ?? focusedSessionId
        guard let sid = target, pendingCallIdIsCurrent(callId) else { return false }
        return (try? await client.approvalRespond(sessionId: sid, callId: callId, approved: approved, optionId: optionId)) != nil
    }

    /// `childSessionId`: same Dispatch/Phase-7 routing as `respondApproval`'s.
    func respondQuestion(callId: String, answers: [String: String], notes: [String: String] = [:], childSessionId: String? = nil) async -> Bool {
        let target = childSessionId ?? focusedSessionId
        guard let sid = target, pendingCallIdIsCurrent(callId) else { return false }
        return (try? await client.askUserRespond(sessionId: sid, callId: callId, answers: answers, notes: notes.isEmpty ? nil : notes)) != nil
    }

    func respondPlan(callId: String, approved: Bool, autoAccept: Bool, feedback: String?) async -> Bool {
        guard let sid = focusedSessionId, pendingCallIdIsCurrent(callId) else { return false }
        return (try? await client.planRespond(sessionId: sid, callId: callId, approved: approved, autoAccept: autoAccept, feedback: feedback)) != nil
    }

    /// Sparkle T4: Update idle gate — executing agent-turn count; nil when the daemon is
    /// unreachable.
    func engineActivity() async -> Int? {
        try? await client.engineActivity()
    }

    private func handle(_ ev: WinterEvent) async {
        switch ev {
        case .session(let e):
            if case .sessionCreated(let v) = e {
                if v.sessionId == selfCreatedSessionId { selfCreatedSessionId = nil; return }
                // orb-scope fix: the orb/field is a DISPATCH-mode surface only. The daemon
                // broadcasts session_created to EVERY authed harness (not just attachments), and
                // remote/phone-originated creates — and CLI/TUI ones — are always mode "code"
                // (protocol contract: mode ABSENT means "code", packages/protocol/src/events.ts).
                // A code session must never steal the orb's focus; it still flows to the
                // directory/session-list observer (composed separately in `feed.onEvent`, ahead of
                // this `handle` call) so the sidebar keeps updating — only the FOCUS action is
                // gated here. Only a genuine dispatch-singleton create earns an automatic refocus.
                if v.mode == "dispatch", v.sessionId != focusedSessionId {
                    await refocus(onto: v.sessionId) // most-recent focus (spec §4.4, 2b subset), dispatch-only
                    return
                }
            }
            guard e.sessionId == focusedSessionId else { return }
            session.apply(e)
        case .connection(let s):
            session.apply(connection: s)
            connectionSummary = summaryLine()
            // FINAL-REVIEW FIX (M1): `.connection(.connected)` arriving through the event pump is
            // UNAMBIGUOUSLY a RECONNECT — `WinterClient.connect()`'s own initial success never
            // yields this event (its contract: "no `.connection(.connected)` event for the INITIAL
            // connect... Reconnects DO yield `.connection` states" — WinterClient.swift); the
            // initial connect fires `onClientConnected` directly via `feed.onConnected` above
            // instead. Re-fire the SAME hook Task 4 wired for the initial connect so
            // `PeripheralProvider.advertiseIfConnected()` runs again on reconnect too — otherwise a
            // daemon restart/socket drop leaves the provider's ghost `activeLeases` never cleared
            // (the fix lives in `advertiseIfConnected()` itself; this is what actually invokes it).
            if s == .connected { onClientConnected?() }
        case .unknown:
            break // newer daemon event — orb has nothing to render for it
        }
        // Task DD-T5: menu-bar activity derivation. Scoped to the FOCUSED session only, not
        // independent of the filtering above: every path that reaches this point already satisfies
        // `e.sessionId == focusedSessionId` — either via the `guard` above (which `return`s out of
        // `handle` entirely, not just the switch, for events from any other session) or via the
        // equivalent check inside the `sessionCreated` branch (both of its early `return`s exit
        // `handle` before this point too). On `refocus(onto:)` (below), the model sets
        // `focusedSessionId` and then `client.attach(sessionId:, fromSeq: 0)` triggers a full replay
        // of the newly-focused session's events through this same `handle`, so `menuBarActivity`
        // reconverges to that session's true terminal state on every focus switch — self-healing;
        // it can never wedge on stale state from a session that's no longer focused.
        if case .session(let e) = ev {
            let nextActivity = MenuBarActivity.next(after: menuBarActivity, event: e)
            if nextActivity != menuBarActivity {
                menuBarActivity = nextActivity
                onActivityChange?(nextActivity)
            }
        }
    }

    /// Task 5 (2e-iii): the left sidebar's "switch in place" action for the morph window (a plain
    /// click on a `SessionSidebar` row) — the EXACT same refocus machinery `focusNewestSession()`
    /// already uses below, just parameterized to an explicit id instead of always picking the
    /// newest. `refocus(onto:)` is already idempotent (a no-op if already focused+attached there),
    /// so re-selecting the current row is safe.
    ///
    /// orb-scope fix (plan-immunity Task 2): this is the one caller that hands `refocus` an
    /// ATTACKER-CHOSEN id (any row visible in the sidebar) rather than one this file already knows
    /// is dispatch — `refocus`'s own dispatch-only gate (see its doc comment) is what actually
    /// refuses a non-dispatch target; this wrapper stays a thin, obviously-correct one-liner.
    func focusSession(_ sessionId: String) async {
        await refocus(onto: sessionId)
    }

    /// orb-scope fix: on connect/reconnect the orb only auto-focuses the newest DISPATCH session —
    /// code sessions (CLI/TUI/phone) never summon the field this way either. No dispatch session
    /// existing yet is the correct pre-first-summon state (`focusedSessionId` stays nil);
    /// `ensureFocusedSession()` mints the dispatch singleton on the first deliberate summon/submit.
    private func focusNewestSession() async {
        guard let sessions = try? await client.listSessions() else { return }
        guard let newest = sessions.filter({ $0.mode == "dispatch" }).max(by: { $0.createdAt < $1.createdAt }) else { return }
        await refocus(onto: newest.sessionId)
    }

    private func refocus(onto sessionId: String) async {
        // Idempotent: already focused AND attached to this session — nothing to do.
        if sessionId == focusedSessionId, await client.attachedSession == sessionId { return }
        // orb-scope fix (plan-immunity Task 2 — T1 review's REAL hole): `refocus` is the ONE place
        // `focusedSessionId` is ever assigned, so gating HERE (not only at each call site) closes
        // every path, including `focusSession(_:)` below, which had NO mode gate at all before this
        // fix — only `focusNewestSession()` filtered to dispatch. Positive match, same "== dispatch,
        // fails closed on any other mode" shape as that filter and the fallback below.
        //
        // Checked against `directory`'s CACHED rows, never a fresh `listSessions()` RPC — that
        // would add a round trip ahead of every attach, and this file's own test suite pins several
        // attaches to a fixed wire position. "Not found" is deliberately NOT refused: every trusted
        // internal caller (`ensureFocusedSession`/`startFreshSession`'s own `session.dispatch`
        // create, `focusNewestSession`'s freshly-filtered list, the `sessionCreated` handler's own
        // already-mode-checked broadcast) can reach here for a session that IS genuinely dispatch
        // before the directory's own async refresh has caught up — `SessionDirectory.handle` kicks
        // an UNAWAITED `Task { refresh() }`, so a split second after creation the new session is
        // real but not yet cached. Refusing on "not found" would wrongly block the orb's own
        // ordinary summon flow (see `testEnsureFocusedSessionRefocusesOntoAFreshDispatchSessionNotYetInTheDirectory`).
        // Only a row that's actually LOADED with some OTHER mode is refused — `focusSession`'s
        // sidebar click is the one caller that can supply an attacker-chosen id, and (after the
        // orb sidebar's own row filter, `AppDelegate.isOrbSidebarRow`) it can only ever pass an id
        // that's already in `directory.rows`, so the "not found" leniency is unreachable from
        // there in practice — same precedent as `DetachedWindowController.isChatSession`'s own
        // documented reasoning for its "false when not found" default.
        if let row = directory.rows.first(where: { $0.sessionId == sessionId }), row.mode != "dispatch" {
            OrbDebug.log("refocus: refusing non-dispatch session \(sessionId.prefix(10)) (mode: \(row.mode ?? "code"))")
            return
        }
        session.reset()
        focusedSessionId = sessionId
        // Full replay from 0 rebuilds tasks/pending state through the reducer.
        do {
            _ = try await client.attach(sessionId: sessionId, fromSeq: 0)
        } catch {
            // Target vanished or transport hiccuped: reconcile with WinterKit's ground truth
            // (attach() rolled its state back), then fall back to the newest surviving session.
            focusedSessionId = await client.attachedSession
            // orb-scope review (Important 1): this fallback is a THIRD focus-acquisition site and
            // was mode-blind — same dispatch-only filter as `focusNewestSession()` and the
            // `sessionCreated` handler above, in the same `== "dispatch"` direction (fails closed on
            // an unknown future mode value, never an implicit `!= "code"`). Without it, a daemon
            // restart or transport hiccup mid-refocus could fall back onto a phone/CLI-created CODE
            // session — reopening the orb-dispatch-only bug in a narrow, harder-to-hit form. Staying
            // unfocused when no dispatch session survives (the `let newest = ...` fails) is the
            // correct outcome, matching the pre-first-summon state elsewhere.
            if let sessions = try? await client.listSessions(),
               let newest = sessions.filter({ $0.mode == "dispatch" }).max(by: { $0.createdAt < $1.createdAt }),
               newest.sessionId != sessionId {
                session.reset()
                focusedSessionId = newest.sessionId
                if (try? await client.attach(sessionId: newest.sessionId, fromSeq: 0)) == nil {
                    focusedSessionId = await client.attachedSession // reconcile again on double failure
                }
            }
        }
        connectionSummary = summaryLine()
    }

    private func summaryLine() -> String {
        if session.state.status == .disconnected { return "daemon unreachable" }
        if let sid = focusedSessionId { return "session \(sid.prefix(10))" }
        return "connected — no session yet"
    }
}

// MARK: - Winter Phase 8d Task 4.2: the ONE `session.setModel` outcome-routing door

/// The richer answer `session.setModel` can now give beyond plain success/`NOT_FOUND` — the
/// handoff barrier's four typed codes (`HandoffRpcCode`, WinterKit) plus `.ok` and a catch-all
/// `.failed` for everything else (an unresolvable sessionId, a transport error, a refusal that
/// carries no handoff code at all — e.g. `runtime_selection_refused`/`session_predates_winter_leg`,
/// which ARE real refusals but not one of the four confirm/disable/error shapes a picker treats
/// specially).
enum ModelChangeOutcome: Equatable {
    case ok
    /// `error.data.warnings` verbatim (WS-13 §8.2's own list) — the confirm sheet's bullet list.
    /// Resending with `confirmLossy: true` is the caller's job (`AppModel.applyModelChange` again).
    case confirmationRequired(warnings: [String])
    /// The daemon's own refusal message, which NAMES the setting (`runtimes.handoff.crossRuntime`)
    /// — surfaced verbatim rather than re-worded, so a support conversation can grep for it.
    case disabled(String)
    case lossyFork(String)
    case blocked(String)
    case failed(String)
}

extension AppModel {
    /// **THE ONE door every `session.setModel` call in the app goes through** (Task 4.2's own
    /// requirement) — static, not an instance method, because two of its four callers
    /// (`ShellSessionHost`, `DetachedWindowController`) hold their OWN `WinterClient`
    /// ("harness-per-window": each window is a full harness, not a facet of the orb's `AppModel`),
    /// so the shared decision logic must not require an `AppModel` instance to exist. The other two
    /// callers are `AppModel.setSessionModel` itself (the orb's focused-session surface) and
    /// `ShellSessionHost.stampHeldSelection` (the new-chat "apply a held pick to the just-bound
    /// session" stamp, which deliberately never blocks on the outcome — see that method's own doc
    /// comment for why a refusal there must never hold up the user's message).
    ///
    /// Maps `RpcError.handoffCode` (WinterKit, Interfaces block) onto `ModelChangeOutcome` 1:1; any
    /// other thrown error (including a plain `RpcError` with no handoff code, and a transport
    /// failure) becomes `.failed(message)`.
    static func applyModelChange(client: WinterClient, sessionId: String, model: String?, confirmLossy: Bool = false) async -> ModelChangeOutcome {
        do {
            try await client.setModel(sessionId: sessionId, model: model, confirmLossy: confirmLossy)
            return .ok
        } catch let err as RpcError {
            switch err.handoffCode {
            case .confirmationRequired:
                let warnings = (err.data?["warnings"]?.arrayValue ?? []).compactMap { $0.stringValue }
                return .confirmationRequired(warnings: warnings)
            case .disabled: return .disabled(err.message)
            case .lossyFork: return .lossyFork(err.message)
            case .blocked: return .blocked(err.message)
            case nil: return .failed(err.message)
            }
        } catch {
            return .failed("\(error)")
        }
    }

    // MARK: - Winter Phase 8d Task 4.2 (P8d-8): the ONE advisor setting, read/written directly

    /// `settings.runtimes.advisorModel` (`packages/core/src/settings.ts`) is THE ONE D30 setting
    /// (P8d-8) — read/written here the SAME way `UpdaterCoordinator.readChannelFromSettings()`
    /// already reads `updates.channel`: direct JSON file access via `WinterPaths.settingsPath`,
    /// never an RPC. This IS the app's existing settings-access pattern (the brief's own "find the
    /// existing settings write path the app uses" — there is no generic `settings.set`-style RPC
    /// anywhere in the protocol to route through instead, and `provider.configure` is a scoped,
    /// purpose-specific BYOK verb with an unrelated params shape, not a general settings door; see
    /// this lane's report for the full note). The daemon's settings-watcher hot-reloads the file on
    /// write, exactly as a `winter model` CLI edit does — no daemon restart, ever (P8d-8's rule).
    ///
    /// Uses `AppProfile.winterHome` explicitly (never the bare env-only `WinterPaths.settingsPath()`)
    /// — the SAME devfix discipline `AppModel.production()`/`AppDelegate` already apply to
    /// `socketPath`, for the identical reason: a dev build must never read or write the DIST home's
    /// settings.json.
    ///
    /// `nil` = unset ("Automatic"). Blank-is-absent on both sides, mirroring
    /// `winterOptionsFromSettings`'s own rule (`settings.ts`): a blank string is never READ as a
    /// model id, and is never WRITTEN — clearing removes the key rather than storing `""`.
    nonisolated static func readAdvisorModelFromSettings() -> String? {
        let url = URL(fileURLWithPath: WinterPaths.settingsPath(home: AppProfile.winterHome))
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let runtimes = obj["runtimes"] as? [String: Any],
              let model = runtimes["advisorModel"] as? String
        else { return nil }
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// A shallow merge at both levels — preserves every other top-level key AND every other key
    /// already under `runtimes` — the SAME shape `saveSettings(settingsPath, {...settings,
    /// runtimes: {...settings.runtimes, advisorModel}})` takes on the daemon/CLI side
    /// (`packages/cli/src/main.ts`'s `case "model"`). A MISSING settings.json is read as `{}`
    /// (every field in `Settings` is optional, so an empty object is a valid file — the same
    /// "first write creates it" the CLI's own `saveSettings` already does for a fresh home).
    /// Returns `false` (writing nothing) on any parse/encode/I-O failure — never a partial file.
    ///
    /// Whole-branch review Major 2: a settings.json that EXISTS and was readable but does not
    /// parse as a JSON object (hand-edited, truncated, or from a future/incompatible schema) is
    /// NOT "no settings.json yet" — conflating the two used to fall through to `obj = [:]` and
    /// atomically REPLACE that file with `{"runtimes":{"advisorModel":…}}`, which the daemon's
    /// settings-watcher then hot-loads, silently resetting every OTHER setting in it. The fresh
    /// object is only ever the honest "there is genuinely nothing there yet" case
    /// (`Data(contentsOf:)` itself failing, e.g. ENOENT) — a file that exists but fails to parse
    /// refuses the write entirely instead. Callers surface `false` to the user (`ComposerModelChip`'s
    /// wirers: `FieldStateAdapter.applyAdvisorModelSelection` sets `modelChangeError`, the
    /// existing "Couldn't switch model" alert; `ShellSessionHost.setNewChatAdvisorModel` sets its
    /// own `newChatAdvisorError`, rendered the same way `newChatCreate`'s failure banner is).
    @discardableResult
    nonisolated static func writeAdvisorModelToSettings(_ model: String?) -> Bool {
        let url = URL(fileURLWithPath: WinterPaths.settingsPath(home: AppProfile.winterHome))
        var obj: [String: Any]
        if let data = try? Data(contentsOf: url) {
            guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return false // exists, unparseable/not-an-object — refuse rather than clobber it
            }
            obj = parsed
        } else {
            obj = [:] // genuinely no file yet — the honest "first write creates it" case
        }
        var runtimes = obj["runtimes"] as? [String: Any] ?? [:]
        let trimmed = model?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            runtimes["advisorModel"] = trimmed
        } else {
            runtimes.removeValue(forKey: "advisorModel")
        }
        obj["runtimes"] = runtimes
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        else { return false }
        return (try? data.write(to: url, options: .atomic)) != nil
    }
}
