import AppKit
import NormaKit
import SwiftUI

/// Task 3 (2d-ii-b): one detached chat window end-to-end — a REAL, native-chrome `NSWindow`
/// (native traffic lights, native resize, native Space/Mission-Control participation) hosting the
/// shared `WindowContentView` on its OWN `SessionFeed` (its own `NormaClient`/socket, pinned to one
/// session forever — spec's "harness-per-window"). Unlike the morph window
/// (`OrbWindowController`'s `.window` surface — a borderless, self-drawn, morphing panel), this
/// window NEVER morphs, so none of 2d-i's chrome-minimum constraints apply: it is a plain titled
/// window, and clicking it activates the app like any ordinary window (correct — this is detached
/// furniture, not the omnipresent orb).
///
/// Owns the window's whole lifecycle: construction at the handoff frame, the composer's
/// submit/steer wire (mirrors `GlassRootView.submit`'s success-gated draft clear), the Esc→
/// interrupt-only key monitor (a real window must never vanish on Esc), and the one-shot
/// `windowWillClose` teardown (`feed.stop()` + monitor removal + `onClosed`) shared by both the
/// programmatic `close()` path (app termination) and the user's own red traffic light.
@MainActor
final class DetachedWindowController: NSObject, NSWindowDelegate {
    private let feed: SessionFeed
    private let session: SessionModel
    private let window: NSWindow
    private let adapter: FieldStateAdapter

    /// The pinned session id this window's feed talks to — read off `feed.pinnedSessionId` at
    /// construction (the only place that holds it; this controller's own init doesn't carry a
    /// separate sessionId parameter). `feed` is ALWAYS constructed in `.pinned` mode for a detached
    /// window (`AppModel.makeDetachedFeed`'s only mode) — an empty-string fallback with a logged
    /// contract-violation warning is defensive, not an expected path.
    ///
    /// `private(set) var`, not `let`: Task 5 (2e-iii)'s `selectSession(_:)` re-pins THIS window's
    /// feed onto a different session in place (the sidebar's "switch in place" action) — every
    /// submit/interrupt/respond/setPolicy closure below reads this property fresh at call time
    /// (never a captured local), so they automatically target whatever session is CURRENTLY pinned.
    private(set) var sessionId: String

    /// Task 5 (2e-iii): this window's own live session directory (all sessions' title/createdAt),
    /// used by the (Task-6-mounted) left sidebar. Lists via this window's OWN `feed.client` — same
    /// socket, no second harness.
    let directory: SessionDirectory

    /// Task 5 (2e-iii): sidebar ⌘-click "open in a NEW detached window" — this window has no way to
    /// spawn ANOTHER window itself (`AppDelegate` owns the `detachedWindows` registry), so it asks
    /// upward via this closure, same "controller exposes a hook, AppDelegate wires it" convention
    /// as `onClosed` (see `AppDelegate.registerDetachedWindow`).
    var onOpenSessionDetached: ((String) -> Void)?

    private var escMonitor: Any?
    /// FINAL-REVIEW FIX (minor #3): the feed-start Task is stored so close can CANCEL it —
    /// `SessionFeed.start()`'s initial connect-backoff loop exits only on Task.isCancelled;
    /// without this, closing a window whose daemon never came up left the loop spinning
    /// (bounded at 10s backoff, but D9 says a closed window leaves NOTHING running).
    private var feedTask: Task<Void, Never>?
    /// One-shot latch: `windowWillClose` runs teardown + fires `onClosed` exactly once, whether it
    /// arrived via the programmatic `close()` (termination hook) or the user's red traffic light —
    /// both funnel through this same AppKit delegate callback.
    private var didClose = false

    /// Registry removal hook (`AppDelegate.registerDetachedWindow`) — fires exactly once.
    var onClosed: ((DetachedWindowController) -> Void)?

    /// working-directories T8: the live create-time folder sheet, held for its lifetime and dropped
    /// in its own completion. Nothing else retains a sheet controller, so without this it would be
    /// deallocated the instant `newSession()` returned, taking its Start/Cancel callbacks with it.
    private var dirPickerSheet: WorkingDirPickerSheetController?

    /// Test-only read-through — lets tests assert on the constructed window's frame/styleMask
    /// without exposing `window` itself past this seam (same convention as
    /// `OrbWindowController.panelFrameForTesting`/`windowForTesting`-style accessors elsewhere).
    var windowForTesting: NSWindow? { window }

    /// Task 5 (2e-iii): this window's current on-screen frame — legitimate PRODUCTION use (unlike
    /// `windowForTesting` above), read by `AppDelegate.registerDetachedWindow`'s
    /// `onOpenSessionDetached` wiring to cascade a sidebar-spawned window off this one.
    var currentFrame: NSRect { window.frame }

    /// Test-only read-through — lets tests drive `adapter.onSubmit`/inspect `composerDraft`
    /// directly (the real trigger, `ComposerTextView`'s `onSubmit`, isn't reachable from a unit
    /// test) without exposing the adapter as a general API surface on this controller.
    var adapterForTesting: FieldStateAdapter { adapter }

    /// - Parameters:
    ///   - frame: spawn exactly here (the morph window's frame at the moment of detach — task 4).
    ///   - title: the session's first prompt, clipped to ~40 chars, else "Norma" (a11y + the
    ///     Dock-minimize label a native titled window shows).
    ///   - isChat: Plan-immunity (2026-07-28 design) — true only for a session pinned at
    ///     `mode:"chat"`. Defaulted `false` so every PRE-EXISTING caller (sidebar +New, ⌘-click
    ///     detach, "Open Norma App") is unaffected; `AppDelegate.createAndOpenChat()`/`openChat()`'s
    ///     reopen path are the only callers that ever pass `true`. Seeds `adapter.isChatSession`
    ///     (see that property's own doc comment for what it gates).
    init(feed: SessionFeed, session: SessionModel, frame: NSRect, title: String, isChat: Bool = false) {
        self.feed = feed
        self.session = session
        if let pinned = feed.pinnedSessionId {
            self.sessionId = pinned
        } else {
            OrbDebug.log("DetachedWindowController: feed has no pinned session id — contract violation (submit/interrupt will target an empty id)")
            self.sessionId = ""
        }
        let feedClient = feed.client
        let sessionDirectory = SessionDirectory(lister: {
            try await feedClient.listSessions().map {
                SessionSummary(sessionId: $0.sessionId, title: $0.title, createdAt: $0.createdAt, scope: $0.scope, cwd: $0.cwd, mode: $0.mode, parentSessionId: $0.parentSessionId, model: $0.model, effort: $0.effort, dirs: $0.dirs)
            }
        })
        directory = sessionDirectory
        // FINAL-REVIEW FIX (M1): cold-window bootstrap — same "session.list on construction" kick
        // as AppModel's own directory (see SessionDirectory.startInitialLoad's doc); a freshly
        // spawned detached window's sidebar (and its own WorkSidebar info block) must not sit empty
        // until an unrelated session_created/session_titled broadcast arrives.
        sessionDirectory.startInitialLoad()
        // Task 5 (2e-iii): forward session_created/session_titled to this window's OWN directory —
        // returns false (this feed's `onEvent` was previously nil) so SessionFeed's default
        // pinned-mode fallback (apply only events matching the pinned sessionId, plus every
        // connection state) still runs unchanged; the directory is purely an ADDITIONAL observer,
        // not a replacement for the existing event-application path.
        feed.onEvent = { [sessionDirectory] ev in
            if case .session(let e) = ev { sessionDirectory.handle(e) }
            return false
        }

        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.title = title
        window.isReleasedWhenClosed = false // this controller owns the window's lifetime
        window.minSize = NSSize(width: 340, height: 360)
        window.backgroundColor = .clear
        window.isOpaque = false
        // LIVE-GATE W1b fix (Safari-style unified-toolbar technique, proven in this repo's
        // history around commit dd48b68): an empty toolbar + `.unified` style inserts the taller
        // titlebar band macOS gives a real toolbar window — traffic lights inset like Safari's
        // (~22pt, matching the morph window's own 14pt lights) instead of a bare titled window's
        // compact chrome, and macOS 26 gives that band the larger corner radius the morph
        // window's shell draws (26pt, `chatWindowCornerRadius`). AppKit enforces a chrome-minimum
        // frame (~40×220 observed historically) on toolbar windows, but that's irrelevant here:
        // `minSize` is already 340×360, and a detached window never animates open from a tiny
        // frame (unlike the morph panel), so there's no tiny-frame collision to guard against.
        let toolbar = NSToolbar(identifier: "norma.detached.toolbar")
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        self.window = window

        let adapter = FieldStateAdapter(session: session)
        adapter.isChatSession = isChat
        self.adapter = adapter

        super.init()

        window.delegate = self
        adapter.onSubmit = { [weak self] text in self?.submit(text) }
        // FINAL-REVIEW FIX: [weak adapter] — the strong capture (GlassRootView's idiom) forms an
        // adapter→closure→adapter cycle. Harmless on the app-lifetime orb adapter, a REAL leak
        // here: detached windows create one adapter per window, and the cycle kept adapter +
        // SessionModel + its Combine sinks alive after every close (once per open/close cycle).
        adapter.onClearMessage = { [weak adapter] in adapter?.composerDraft = "" }

        // Task 3 (2d-iii): the three pending-interaction respond callbacks — wired DIRECTLY to
        // this window's OWN `feed.client`/pinned `sessionId` (never through `AppModel`, same
        // "harness-per-window" posture `submit(_:)` below already follows). `[weak adapter]` —
        // same leak lesson as `onClearMessage` just above: a strong `[adapter]` capture (the
        // `GlassRootView` idiom) forms an adapter→closure→adapter cycle that's harmless on the
        // orb's single app-lifetime adapter but a REAL leak here (one adapter per detached
        // window). `client` is captured as a plain local (no cycle risk — never changes, doesn't
        // hold a reference back to the adapter).
        //
        // Task 5 (2e-iii) FIX: `sessionId` must be read FRESH (`self.sessionId`, `[weak self]`) at
        // call time, not captured once as a local `sid` here — `selectSession(_:)`'s "switch in
        // place" re-pins THIS controller's `sessionId` after construction, and these closures
        // outlive that repin (they're stored on the adapter for the window's whole lifetime). A
        // captured `sid` would keep targeting the OLD session forever after a repin.
        let client = feed.client
        adapter.onApprovalRespond = { [weak self, weak adapter] callId, approved, optionId, childSessionId in
            guard let adapter else { return }
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor [weak self, weak adapter] in
                guard let self else { return }
                // Dispatch (Phase 7): route to the child when this card is a mirrored copy —
                // same `childSessionId ?? <this surface's own session>` rule as AppModel's.
                let target = childSessionId ?? self.sessionId
                let ok = (try? await client.approvalRespond(sessionId: target, callId: callId, approved: approved, optionId: optionId)) != nil
                adapter?.interactionInFlight.remove(callId)
                if !ok { adapter?.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onQuestionRespond = { [weak self, weak adapter] callId, answers, notes, childSessionId in
            guard let adapter else { return }
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor [weak self, weak adapter] in
                guard let self else { return }
                let target = childSessionId ?? self.sessionId
                let ok = (try? await client.askUserRespond(sessionId: target, callId: callId, answers: answers, notes: notes.isEmpty ? nil : notes)) != nil
                adapter?.interactionInFlight.remove(callId)
                if !ok { adapter?.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onPlanRespond = { [weak self, weak adapter] callId, approved, autoAccept, feedback in
            guard let adapter else { return }
            adapter.interactionInFlight.insert(callId)
            adapter.interactionErrors[callId] = nil
            Task { @MainActor [weak self, weak adapter] in
                guard let self else { return }
                let ok = (try? await client.planRespond(sessionId: self.sessionId, callId: callId, approved: approved, autoAccept: autoAccept, feedback: feedback)) != nil
                adapter?.interactionInFlight.remove(callId)
                if !ok { adapter?.interactionErrors[callId] = "couldn't send — try again" }
            }
        }

        // Task 4 (2d-iii): the ⋯ menu's approval-mode picker — wired DIRECTLY to this window's own
        // `feed.client`/pinned `sessionId`, same posture as the three respond callbacks just above.
        // `[weak adapter]` throughout for the same leak reason (one adapter per detached window);
        // `[weak self]` for the same live-sessionId-read reason as those three callbacks.
        adapter.onSetPolicy = { [weak self, weak adapter] policy in
            guard let adapter else { return }
            adapter.policyChangeInFlight = true
            Task { @MainActor [weak self, weak adapter] in
                guard let self else { return }
                let ok = (try? await client.setPolicy(sessionId: self.sessionId, policy: policy)) != nil
                adapter?.policyChangeInFlight = false
                if ok { adapter?.sessionPolicy = policy }
            }
        }

        // Task 10 (Chat Slice D): the model menu — same seam/discipline as the policy picker just
        // above, EXCEPT there's no local cache to bump on success: the model menu reads the CURRENT
        // session's `model` straight off `directory`'s own row (`currentSidebarSessionSummary`,
        // WorkSidebar.swift), which `session.list` already carries (T1) — so a successful change
        // just needs THAT row refreshed, not a second source of truth kept in sync by hand.
        // Refresh happens BEFORE clearing `modelChangeInFlight` so the same re-render its `@Published`
        // flip forces already sees the fresh row.
        adapter.onSetModel = { [weak self, weak adapter] model in
            guard let adapter else { return }
            adapter.modelChangeInFlight = true
            Task { @MainActor [weak self, weak adapter] in
                guard let self else { return }
                let ok = (try? await client.setModel(sessionId: self.sessionId, model: model)) != nil
                if ok { await self.directory.refresh() }
                // provider-correctness T6: the RPC's answer is no longer swallowed. On SUCCESS the
                // optimistic overlay retires (the refreshed row now carries the truth) and the
                // selection goes on probation for exactly one turn; on REFUSAL the overlay reverts
                // to `.none`, which re-renders whatever the daemon still holds. A revert is never a
                // write of the previous value — see `OptimisticSelection.none`.
                adapter?.pendingModel = .none
                if ok { adapter?.armProbation(model: .some(model)) }
                adapter?.modelChangeInFlight = false
            }
        }

        // provider-correctness T6: the effort menu — the model wiring's exact twin on the other
        // axis, down to the refresh-before-clearing-in-flight ordering.
        adapter.onSetEffort = { [weak self, weak adapter] effort in
            guard let adapter else { return }
            adapter.effortChangeInFlight = true
            Task { @MainActor [weak self, weak adapter] in
                guard let self else { return }
                let ok = (try? await client.setEffort(sessionId: self.sessionId, effort: effort)) != nil
                if ok { await self.directory.refresh() }
                adapter?.pendingEffort = .none
                if ok { adapter?.armProbation(effort: .some(effort)) }
                adapter?.effortChangeInFlight = false
            }
        }

        // working-directories T8: the header chip's two doors. `[weak self]` and a FRESH `sessionId`
        // read for the same reason every callback above takes one — `selectSession` repins this
        // controller in place, and a captured id would keep mutating the previous session's dirs.
        adapter.onSetDirs = { [weak self] op, path in self?.applyDirsOp(op, path: path) }
        adapter.onPickWorkingDir = { [weak self] op in self?.pickWorkingDir(op) }

        // provider-correctness T6: the synced catalogue this window's pickers read. Fetched once at
        // construction — `sync.config` is a snapshot, never a subscription — and re-fetched on a
        // session switch (`selectSession`), which is also when a `norma model --effort` edit made
        // meanwhile becomes worth re-reading. A failure leaves `.empty`, which the pickers render as
        // "no rows offered" rather than as a guessed lineup.
        refreshModelCatalogue()
        adapter.onRefreshModelCatalogue = { [weak self] in self?.refreshModelCatalogue() }
        // I1 (review): stamps every probation with the session it was armed for, so a verdict can
        // never be applied to a different one. This window repins in place (`selectSession`), so it
        // is read FRESH rather than captured.
        adapter.boundSessionId = { [weak self] in self?.sessionId }

        // Task 6 (2e-iii): this window's own sidebar wiring — its own `directory`, `selectSession`
        // (switch in place), `newSession` (create+repin), and the AppDelegate-wired
        // `onOpenSessionDetached` (⌘-click → a NEW detached window for that id). `currentSessionId`
        // is read FRESH (`self.sessionId`) so it tracks `selectSession`'s repin.
        let sidebars = SidebarWiring(
            directory: directory,
            currentSessionId: { [weak self] in self?.sessionId },
            onSelect: { [weak self] sid in self?.selectSession(sid) },
            onOpenDetached: { [weak self] sid in self?.onOpenSessionDetached?(sid) },
            onNewSession: { [weak self] in self?.newSession() }
        )
        window.contentView = NSHostingView(rootView: DetachedWindowRootView(adapter: adapter, sidebars: sidebars))
        window.setFrame(frame, display: true)
    }

    /// provider-correctness T6: re-reads `sync.config` into the adapter. Fire-and-forget with a
    /// `try?`, same posture as `SessionDirectory.refresh` — a daemon hiccup must leave the previous
    /// catalogue in place, never blank the picker out from under the user.
    func refreshModelCatalogue() {
        let client = feed.client
        Task { @MainActor [weak self] in
            guard let snapshot = try? await client.syncConfig() else { return }
            self?.adapter.modelCatalogue = snapshot
        }
    }

    /// Orders the window front and starts its feed (connect/attach/pump — the same `SessionFeed`
    /// mechanics any pinned window uses); installs the Esc monitor. Idempotent-ish in practice:
    /// task 4 calls this exactly once per spawned controller.
    func show() {
        window.makeKeyAndOrderFront(nil)
        feedTask = Task { await feed.start() }
        installEscMonitor()
    }

    /// Programmatic close (the app-termination hook, `AppDelegate.applicationWillTerminate`) — goes
    /// through the SAME AppKit `windowWillClose` path the red traffic light does, so teardown only
    /// ever lives in one place.
    func close() {
        window.close()
    }

    /// Task 5 (2e-iii): the (Task-6-mounted) sidebar's plain-click "switch in place" action —
    /// re-pins THIS window's own feed (same harness/socket) onto a different session instead of
    /// opening a new detached window. `sessionId` flips FIRST, synchronously, so every closure that
    /// reads it live (submit/interrupt/respond/setPolicy above) targets the new session immediately
    /// — even before `feed.repin(to:)`'s attach round-trip completes.
    ///
    /// Plan-immunity (2026-07-28 design): `adapter.isChatSession` is re-derived HERE too, from
    /// `directory`'s already-loaded rows (`isChatSession(_:in:)` below) — the left sidebar
    /// (`SessionSidebar`) lists every session with no mode filter of its own, so a code window's
    /// sidebar can select INTO an existing chat session (and vice versa) without ever closing this
    /// window. Without this re-derivation the policy picker would stay stuck showing (or hiding)
    /// whatever `isChat` this controller happened to be constructed with, regardless of which
    /// session is actually pinned now.
    func selectSession(_ sessionId: String) {
        guard sessionId != self.sessionId else { return }
        self.sessionId = sessionId
        adapter.isChatSession = Self.isChatSession(sessionId, in: directory.rows)
        // provider-correctness T6: a different session means a different pinned model/effort and a
        // possibly-different mode, so every picker overlay from the OLD session must go — leaving
        // one would render the previous session's optimistic choice as this session's selection.
        // The probation goes too: it is scoped to the turn that follows the apply, and that turn
        // will now never run here.
        adapter.pendingModel = .none
        adapter.pendingEffort = .none
        adapter.selectionProbation = nil
        // working-directories T8: a refusal is about the session it was refused FOR — "that directory
        // is locked for this session" rendered over a different session's chip is a lie about a rule.
        adapter.dirsRefusal = nil
        Task { @MainActor [weak self] in
            await self?.feed.repin(to: sessionId)
        }
    }

    /// Plan-immunity (2026-07-28 design; fix round 1, Minor 3 — comment corrected, default kept):
    /// pure decision helper for `selectSession`'s in-place `isChatSession` re-derivation — is the
    /// given session id chat-mode, per the directory's currently-loaded rows? `false` (not chat)
    /// whenever the row isn't found (the directory hasn't loaded it yet).
    ///
    /// This is NOT "the conservative default" in any general safety sense — for a chat target that
    /// isn't loaded yet, `false` is the WRONG direction (it shows a picker that cannot work, rather
    /// than hiding one that could). It's kept anyway because it's the CORRECT answer for the one
    /// real caller that actually reaches "not found" today: `newSession()` below calls
    /// `selectSession(created.sessionId)` immediately after creating a plain session (no `mode`
    /// param — always code), so the freshly minted id is NEVER in `directory.rows` yet, and `false`
    /// is simply right, not a hedge. The sidebar's plain-click path (`selectSession`'s OTHER call
    /// site) never hits "not found" in practice — the clicked row IS the directory's own row, so
    /// it's always already loaded — making the "wrong" direction for a hypothetical unloaded chat
    /// id unreachable rather than merely tolerated. Flipping the default to `true` would fix that
    /// unreachable case at the cost of breaking the reachable one (every "+ New session" would
    /// briefly show its picker hidden, since the fresh id isn't loaded either). `nonisolated
    /// static`, no `self`/MainActor dependency, mirrors `AppDelegate.chatSessionToOpen(in:)`'s own
    /// "pure decision helper, directly unit-testable" shape.
    nonisolated static func isChatSession(_ sessionId: String, in rows: [SessionSummary]) -> Bool {
        rows.first(where: { $0.sessionId == sessionId })?.mode == "chat"
    }

    /// Task 5 (2e-iii): the sidebar's "+ New session" action — create, then re-pin this window onto
    /// the freshly created session (the "create+repin" shape the brief calls for; this window's own
    /// `.pinned` feed ignores `session_created` broadcasts entirely — see
    /// `SessionFeedTests.testPinnedFeedIgnoresSessionCreated` — so an explicit `selectSession` call
    /// is the only way this controller ever re-targets itself).
    ///
    /// working-directories T8: THE app's one code-session create path, and so the one place the
    /// create-time folder picker mounts (the other two create paths are `AppModel.startFreshSession`,
    /// which resolves the DISPATCH singleton, and `AppDelegate.createAndOpenChat`, `mode:"chat"` —
    /// neither participates in working directories at all). It no longer hardcodes
    /// `cwd: NSHomeDirectory()`: the sheet's answer decides, and **"No folder (outputs only)" creates
    /// with NO cwd at all**, which is what makes the daemon write `dirs = []` (T6) rather than
    /// silently adopting the home directory as a writable root. Cancelling the sheet creates nothing.
    func newSession() {
        // A sheet is modal to this window, so a second click can't normally arrive — but replacing a
        // live sheet controller would deallocate it out from under its own attached sheet, orphaning
        // it on the host window. Belt: one at a time.
        guard dirPickerSheet == nil else { return }
        // Recents ride the directory this window already keeps loaded — no extra RPC (design doc §2).
        let sheet = WorkingDirPickerSheetController(
            recents: recentWorkingDirs(directory.rows), host: window
        ) { [weak self] choice in
            self?.dirPickerSheet = nil
            guard let choice else { return } // cancelled: create nothing
            self?.startSession(with: choice)
        }
        dirPickerSheet = sheet
        sheet.present()
    }

    /// `newSession()`'s second half — the create+repin the picker's answer feeds. Split out (and
    /// internal, not private) because it is also the TESTABLE seam: an AppKit sheet cannot be driven
    /// from a unit test, so `DetachedWindowTests` drives the choice directly here, which is the half
    /// that actually touches the wire.
    ///
    /// `choice.cwdParam` is `nil` for the outputs-only choice — `createSession`'s own `cwd` is
    /// optional and `obj(...)` omits an absent key entirely, so no `cwd` reaches the wire at all.
    func startSession(with choice: WorkingDirChoice) {
        let client = feed.client
        Task { @MainActor [weak self] in
            guard let created = try? await client.createSession(scope: "global", cwd: choice.cwdParam, approvalPolicy: "auto") else { return }
            self?.selectSession(created.sessionId)
        }
    }

    /// working-directories T8: the chip's per-entry action (today: "Remove") — a path already in the
    /// set, so no panel and no confirm; the row the user clicked IS the selection.
    ///
    /// A refusal is published VERBATIM (`adapter.dirsRefusal`) — `set-dirs.ts` writes one sentence
    /// per rule and each names the rule it enforced. On success the refusal clears and the DIRECTORY
    /// row is refreshed: the dirs set lives on `session.list`'s row exactly like `model` does, so
    /// there is no second source of truth here to keep in sync (the `onSetModel` precedent).
    private func applyDirsOp(_ op: SessionDirsOp, path: String) {
        let client = feed.client
        adapter.dirsChangeInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                _ = try await client.setDirs(sessionId: self.sessionId, op: op, path: path)
                await self.directory.refresh()
                self.adapter.dirsRefusal = nil
            } catch let error as RpcError {
                self.adapter.dirsRefusal = error.message
            } catch {
                self.adapter.dirsRefusal = "couldn't reach the daemon — try again"
            }
            self.adapter.dirsChangeInFlight = false
        }
    }

    /// working-directories T8: the chip's "Add folder…"/"Change primary folder…" — panel, then the
    /// CONFIRM alert (the user's ruling: a manual add is selection + confirm), then the RPC. AppKit
    /// lives here rather than in the SwiftUI menu, same seam as every other controller-owned side
    /// effect on this adapter.
    private func pickWorkingDir(_ op: SessionDirsOp) {
        runWorkingDirOpenPanel(on: window) { [weak self] path in
            guard let self, let path else { return } // cancelled panel: nothing happens
            confirmWorkingDir(op: op, path: path, on: self.window) { [weak self] confirmed in
                guard let self, confirmed else { return } // declined confirm: nothing happens
                self.applyDirsOp(op, path: path)
            }
        }
    }

    private func installEscMonitor() {
        escMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.window else { return event }
            if event.keyCode == 53 { // Esc
                guard self.session.state.turnRunning else { return event } // idle: pass through — NEVER close on Esc
                let client = self.feed.client
                let sid = self.sessionId
                Task { try? await client.interrupt(sessionId: sid) }
                return nil // consumed
            }
            // Task 3 (2d-iii): y/n/digit card routing — AFTER Esc handling above, per the brief's
            // ordering (a stale card-key press must never fight the interrupt-only Esc contract).
            let topmost = self.adapter.pendingInteractions.first
            if let action = cardKeyAction(
                keyCode: event.keyCode,
                chars: event.charactersIgnoringModifiers,
                topmost: topmost,
                composerDraft: self.adapter.composerDraft,
                textFieldFocused: isTextEditingFocused(in: self.window)
            ) {
                self.dispatchCardKeyAction(action, topmost: topmost)
                return nil
            }
            return event
        }
    }

    /// Task 3 (2d-iii): identical shape to `OrbWindowController.dispatchCardKeyAction` — see that
    /// method's doc for why `.selectOption` both selects AND submits in one call.
    private func dispatchCardKeyAction(_ action: CardKeyAction, topmost: PendingInteraction?) {
        switch action {
        case .approve(let callId, let childSessionId):
            adapter.onApprovalRespond(callId, true, nil, childSessionId)
        case .deny(let callId, let childSessionId):
            adapter.onApprovalRespond(callId, false, nil, childSessionId)
        case .selectOption(let callId, let index, let childSessionId):
            guard case .question(_, let questions, _) = topmost else { return }
            adapter.onQuestionRespond(callId, questionAnswers(for: questions, selections: [0: [index]], otherTexts: [:]), [:], childSessionId)
        }
    }

    /// Mirrors `GlassRootView.submit`'s success-gated draft clear (GlassRootView.swift:~140–176):
    /// steer if this session's turn is already running, else send; the draft is cleared ONLY on
    /// success — a failed send/steer never loses the composed text.
    private func submit(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let wasRunning = session.state.turnRunning
        let sid = sessionId
        let client = feed.client
        Task { @MainActor [weak self] in
            let ok: Bool
            if wasRunning {
                ok = (try? await client.steer(sessionId: sid, text: trimmed)) != nil
            } else {
                ok = (try? await client.send(sessionId: sid, text: trimmed)) != nil
            }
            if ok {
                self?.adapter.composerDraft = ""
            }
            // failure: text stays in the composer — the draft is never lost (spec §6 parity)
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard !didClose else { return }
        didClose = true
        feedTask?.cancel()
        feedTask = nil
        feed.stop()
        if let escMonitor {
            NSEvent.removeMonitor(escMonitor)
            self.escMonitor = nil
        }
        onClosed?(self)
    }
}

/// The detached window's content: `WindowContentView` (shared with the morph window, task 2) over
/// a near-opaque tint + glass backdrop (reuses `chatWindowTint` — same approved values, no
/// progress-based fade-in here since this window never morphs, it's just always-on). Deliberately
/// NO `clipShape`/corner mask — the corner rounding comes for free from the SYSTEM window shape (a
/// real titled `NSWindow`), unlike the morph window's self-drawn `RoundedRectangle` shell. Content
/// bleeds up under the (hidden, transparent) native titlebar via the window's
/// `.fullSizeContentView` style mask + this view's `topInset: 52` (LIVE-GATE W1b: bumped from 40
/// to clear the TALLER unified-toolbar titlebar band the window construction above now attaches —
/// tune-at-gate constant).
struct DetachedWindowRootView: View {
    @ObservedObject var adapter: FieldStateAdapter
    /// Task 6 (2e-iii): the width-responsive sidebar wiring built in `DetachedWindowController.init`.
    let sidebars: SidebarWiring
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        WindowContentView(
            adapter: adapter,
            tint: Color(red: 0.45, green: 0.75, blue: 1.0),
            topInset: 52,
            sidebars: sidebars
        ) {
            EmptyView()
        }
        .background {
            let t = chatWindowTint(darkMode: colorScheme == .dark)
            Rectangle()
                .fill(.regularMaterial)
                .overlay(Color(white: t.white).opacity(t.opacity))
        }
        .ignoresSafeArea()
    }
}
