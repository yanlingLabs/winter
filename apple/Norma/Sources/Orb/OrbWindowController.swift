import AppKit
import NormaKit
import SwiftUI

/// v1 PointerOverlayWindow's key/main refusal pattern (GlassFieldWindow.swift GlassFieldPanel,
/// verbatim): a borderless NSPanel defaults BOTH to true, and AppKit auto-promotes orderable
/// key-capable windows on close/deactivate/Space changes. Collapsed (orb) keeps 2b's refusal;
/// expanded (field) types.
private final class KeyableNonActivatingPanel: NSPanel {
    var acceptsKeyInput = false
    override var canBecomeKey: Bool { acceptsKeyInput }
    override var canBecomeMain: Bool { acceptsKeyInput }
}

/// Owns the orb/field panel. Task B (v1 field transplant, window choreography): the panel is no
/// longer a single fixed size — mirroring v1's real `GlassFieldWindowController` (`show()`/
/// `showCollapsedOrb()`/`hide()`), it is `morphModel.collapsedWindowSize` (240×140) while
/// collapsed and `morphModel.windowSize` (480×440) while expanded, resized at exactly two
/// instants: `expandToField()` resizes UP (with v1's origin math) BEFORE starting the morph
/// (mirrors v1 `show()`'s order — the frame never changes DURING the morph, only content
/// geometry does); `finishCollapse()` resizes DOWN only once the collapse morph has fully
/// SETTLED (mirrors v1 `hide()`'s `settleCollapsedOrb()`). Both resizes keep the SAME physical
/// glass-anchor screen point (`currentGlassAnchor()`) — the panel expands/collapses IN PLACE,
/// never jumping. ARCHITECTURE NOTE (v1's converged lesson) still holds: this panel IS the field
/// window's collapsed state — expansion happens in place so the glassEffectID morph stays inside
/// one GlassEffectContainer (now owned by `NormaFieldView` itself). Do not add a second window
/// for the field.
///
/// EDGE FENCE (user directive, replaces v1's per-corner switching): `morphModel.corner` stays
/// `.topLeft` FOREVER — `OrbFollower`'s tracking spring fences its target anchor instead
/// (`fenceAnchorForTopLeftCorner`) so the expanded frame always fits on-screen from wherever the
/// anchor ends up, even while collapsed. `follower.isExpanded` mirrors `surface` exactly (see
/// `OrbFollower`'s own doc) so its continuous per-frame `setFrameOrigin` always targets whichever
/// size the panel is ACTUALLY sized to right now.
@MainActor
final class OrbWindowController: ObservableObject {
    enum Surface { case orb, field, window }

    let follower: OrbFollower
    let morphModel: MorphModel
    /// Task-3 fix wave: the fluid orb's own dedicated model (split off `MorphModel` — see
    /// `FluidModel`'s doc, `FieldKit/FluidOrbView.swift`), created alongside `morphModel` and
    /// passed down the same path (`GlassRootView` → `NormaFieldView` → `FluidOrbSlot`).
    /// `OrbFollower` also holds this reference to write its per-tick acceleration tap directly
    /// onto it instead of onto `morphModel`.
    let fluidModel = FluidModel()
    private let panel: KeyableNonActivatingPanel
    private(set) var isVisible = false
    /// Derived, not driven directly by callers: `.field` the instant an expand STARTS,
    /// `.orb` only once a collapse COMPLETES (the morph spring settles at 0). Kept as
    /// `@Published` purely for input/draft logic (GlassRootView's `onChange` + the Esc
    /// monitor's key-routing) — rendering reads `morphModel.progress`, not this.
    @Published private(set) var surface: Surface = .orb

    /// Test-only convenience — `morphModel.progress` is already reachable via `@testable
    /// import`, but tests read through this name so they don't reach past the controller's
    /// public surface into its collaborator's internals.
    var morphProgressForTesting: Double { morphModel.progress }

    /// Test-only: true once the morph spring has settled (no timer running) — the reliable "the
    /// morph is done" signal a progress read can't give (the spring can overshoot past the target
    /// before the settle epsilon fires). Gate r7's `zoomToggleWindow()` no-ops mid-morph, so its
    /// test waits on this.
    var isMorphIdleForTesting: Bool { morphTimer == nil }

    /// Task 5: mirrors `isMorphIdleForTesting` for the ZOOM spring specifically — a separate timer
    /// from `morphTimer` (the two never run at once: `zoomToggleWindow()` only starts once the
    /// window's own morph is idle), so the interplay tests (collapse/hide/detach cancelling an
    /// in-flight zoom) need a seam that reads the zoom timer's own resting state, independent of
    /// `isMorphIdleForTesting`.
    var isZoomIdleForTesting: Bool { zoomTimer == nil }

    /// Task 5: mirrors `morphProgressForTesting` for the zoom spring's own 0…1 scalar (0 =
    /// `chatWindowDefaultSize`, 1 = the in-flight zoom leg's near-fullscreen target) — lets a test
    /// poll a genuine mid-flight sample (the retarget test) the same way `MorphRetargetTests`
    /// polls `morphProgressForTesting` mid-collapse.
    var zoomProgressForTesting: Double { zoomProgress }

    /// Test-only counter (gate fix — Esc-interrupt live-gate finding): `MorphTimerReentrancyTests`
    /// asserts this stays at 1 after a stale/duplicate `morphTick()` fires post-settle — see
    /// `morphTick()`'s re-entry guard doc for the bug this locks in against.
    private(set) var finishCollapseCallCountForTesting = 0

    /// Test-only counter (Finding-2, gate 2): every synchronous `makePanelKeyWinningLateActivation`
    /// pass increments this — a re-summon must re-assert key focus, so a test drives
    /// expand→collapse→re-expand and asserts this went UP on the second expand (see that method's
    /// doc for the key-window race it defends against).
    private(set) var keyAssertionCountForTesting = 0

    /// Test-only read-through — lets a test observe whether the panel actually became the key
    /// window after a summon (the Finding-2 smoking gun). Key status depends on a live WindowServer
    /// session, so tests that assert on it must tolerate a headless host where it stays false.
    var panelIsKeyForTesting: Bool { panel.isKeyWindow }

    /// Test-only read-through (gate r8): the panel's live AppKit frame — lets a test observe the
    /// window-collapse cursor-ride (`rideWindowCollapseToCursor()`) actually moving the panel,
    /// without exposing the panel itself past this seam.
    var panelFrameForTesting: CGRect { panel.frame }

    /// Test-only read-through (gate r8): the CURRENT glass anchor, reusing the exact private helper
    /// `finishCollapse()`/`expandToField()` already read off the live panel frame (composer corner
    /// mapped through whichever size the panel is actually sized to right now) — lets a test assert
    /// where the settled orb (or field) anchor actually landed after a collapse.
    var currentGlassAnchorForTesting: CGPoint { currentGlassAnchor() }

    /// Test-only override (gate r8): `rideWindowCollapseToCursor()` uses this INSTEAD of
    /// `follower.rawGlassAnchor()` when set. `OrbFollower`'s cursor tracker reads the real OS mouse
    /// position, which a test can't deterministically move (no CGEvent-warp seam in this suite) —
    /// `nil` (the production default) leaves the live-cursor path unaffected.
    var glassAnchorOverrideForTesting: CGPoint?

    /// Test-only seam: `surface` is `private(set)` because production callers only ever move it via
    /// `expandToField()`/`collapseToOrb()`/`enterWindowMode()`/`collapseWindowToOrb()`'s own guarded
    /// transitions — but a test may need to plant a surface directly to exercise a method in
    /// isolation without first driving the whole handoff.
    func setSurfaceForTesting(_ s: Surface) { surface = s }

    /// Wired in Task 6: the controller exposes callbacks, it does NOT import AppModel.
    /// Returns send success — GlassRootView's submit() gates the draft clear on this so a
    /// failed/disconnected send never loses the composed text (spec §6).
    var onSubmit: ((String) async -> Bool)?
    var onInterrupt: (() -> Void)?
    /// Returns true when the key was consumed as an interrupt (turn running); false → collapse.
    var onEsc: (() -> Bool)?

    /// Task 3 (2d-iii): the SAME seam as `onSubmit` above, threaded for the three pending-
    /// interaction respond RPCs — `AppDelegate.boot()` wires these to `AppModel.respondApproval`/
    /// `respondQuestion`/`respondPlan` (the focused-session surface), exactly mirroring the
    /// `onSubmit` chain (`FieldStateAdapter.onXRespond` → `GlassRootView.wireCallbacks()` → these
    /// closures → `AppDelegate` → `AppModel`) so this controller stays model-free.
    var onApprovalRespond: ((String, Bool, String?, String?) async -> Bool)?  // callId, approved, optionId, childSessionId
    var onQuestionRespond: ((String, [String: String], [String: String], String?) async -> Bool)?
    var onPlanRespond: ((String, Bool, Bool, String?) async -> Bool)?

    /// Dispatch (Phase 7), Task 8: fired by `GlassRootView.wireCallbacks()` (relaying
    /// `FieldStateAdapter.onOpenChild`) when the field's own child-status circle is tapped —
    /// `AppDelegate.boot()` wires this to the SAME detached-window-open path
    /// `registerDetachedWindow`'s `onOpenSessionDetached` uses (`openSessionInNewDetachedWindow`),
    /// same "controller exposes a hook, AppDelegate wires the real side effect" seam as
    /// `onApprovalRespond` et al above.
    var onOpenChild: ((String) -> Void)?

    /// Task 4 (2d-iii): the ⋯ menu's approval-mode picker — SAME seam as `onApprovalRespond` et al
    /// just above (`AppDelegate.boot()` wires this to `AppModel.setSessionPolicy`). New policy
    /// string in, success out.
    var onSetPolicy: ((String) async -> Bool)?

    /// Task 10 (Chat Slice D): the model menu — same seam as `onSetPolicy` just above
    /// (`AppDelegate.boot()` wires this to `AppModel.setSessionModel`), widened to the nilable wire
    /// shape `session.setModel` itself takes (`nil` clears the override).
    var onSetModel: ((String?) async -> Bool)?

    /// provider-correctness T6: the effort menu — the exact twin of `onSetModel` above
    /// (`AppDelegate.boot()` wires it to `AppModel.setSessionEffort`). `nil` clears the override.
    var onSetEffort: ((String?) async -> Bool)?

    /// provider-correctness T6: reads the daemon's synced model catalogue (`sync.config`) — the
    /// pickers' only source of slugs and effort levels. Same "controller exposes a hook,
    /// AppDelegate wires the real side effect" seam as the callbacks above; `nil` (unwired, or a
    /// failed fetch) leaves the adapter at `.empty`, which the pickers render as "no rows offered"
    /// rather than as a guessed lineup.
    var onFetchModelCatalogue: (() async -> SyncConfigSnapshot?)?

    /// Task 6 (2e-iii): the morph window's width-responsive sidebar wiring — this controller exposes
    /// it (it does NOT import `AppModel`), `AppDelegate.boot()` wires it to the app model's
    /// `directory`/`focusSession`/create-primitive plus AppDelegate's own detached-window spawn.
    /// `GlassRootView` reads it live and threads it down through `NormaFieldView` →
    /// `WindowSurfaceView` → `WindowContentView`. A plain `var` set once at boot (like the callback
    /// seams above); the window surface only ever renders long after boot, so it's always set by
    /// then, and the `directory` inside drives its own updates independently.
    var sidebars: SidebarWiring?

    /// Plan-immunity (2026-07-28 design; fix round 1, review finding — door 3): keeps THIS
    /// controller's own `fieldAdapter.isChatSession` honest across a sidebar session switch —
    /// `AppDelegate.boot()`'s `sidebars.onSelect` calls this alongside `AppModel.focusSession(_:)`,
    /// mirroring `DetachedWindowController.selectSession`'s identical in-place re-derivation (same
    /// pure helper, `DetachedWindowController.isChatSession(_:in:)`). Pulled out of that closure
    /// into its own method — rather than inlined — specifically so it's unit-testable directly
    /// against a real `OrbWindowController` (`AdapterOwnershipTests.swift`'s own construction
    /// precedent) without booting the whole app: `AppDelegate.boot()`'s own `AppModel` can never be
    /// given a scripted transport in a unit test (its `isRunningUnitTests` gate always falls back to
    /// a token-missing model), so a closure inlined there would be untestable end-to-end. The morph
    /// window renders `WindowContentView` off `fieldAdapter` — a SEPARATE `FieldStateAdapter`
    /// instance from any `DetachedWindowController`'s own — so without this, selecting a chat row
    /// here would leave the orb's OWN policy pickers shown-but-broken even after the
    /// `DetachedWindowController` fix.
    func updateIsChatSession(for sessionId: String, rows: [SessionSummary]) {
        fieldAdapter.isChatSession = DetachedWindowController.isChatSession(sessionId, in: rows)
        // panel-shell T10b review fix (Important 1): this method is the THIRD
        // in-place-session-switch site, sibling to `ShellSessionHost.hop`/
        // `DetachedWindowController.selectSession` (both already clear their own adapter's
        // `pendingCardDrafts` on switch) — named directly by this method's own doc above ("a
        // SEPARATE FieldStateAdapter instance", "mirroring DetachedWindowController.selectSession's
        // identical in-place re-derivation").
        // Doubly important here, not merely symmetrical: `fieldAdapter` is a `let`, constructed
        // once and living for the WHOLE APP LIFETIME — unlike a `DetachedWindowController` (which
        // dies on window close) or a `ShellSessionAttachment` (bounded by the shell's own
        // lifetime), nothing else ever tears this adapter down. A forgotten clear here would not
        // just leak one switch's worth of entries; it would accumulate for as long as the app
        // runs. (`FieldStateAdapter`'s own resolve-path sweep is a second, independent backstop
        // against exactly that unbounded growth — see its doc — but the explicit clear stays: it
        // fires the instant a switch is chosen, not on the next state tick.)
        //
        // Composite keying (`FieldStateAdapter.pendingCardDraftBinding`) already prevents a
        // cross-session collision even without this clear, so — same as its two siblings — this
        // is hygiene, not a correctness fix for a visible bug. One timing note for a future
        // reader: this fires SYNCHRONOUSLY here, while the caller (`AppDelegate`'s
        // `sidebars.onSelect`) starts `AppModel.focusSession(sid)` right after in a separate
        // `Task`, asynchronously — for one beat after a GENUINE switch, `fieldAdapter` can render
        // the OLD session's still-visible cards against an already-emptied draft store, harmless
        // because a real switch was chosen and those drafts are about to stop being displayed
        // regardless of when the clear lands. (A redundant reselect is a DIFFERENT case, and the
        // guard right below is what keeps this paragraph's reasoning from covering it too.)
        //
        // Review round 3 fix: this line MUST be guarded — both siblings already are
        // (`ShellSessionHost.hop` is reachable only via `shellAttachmentAction`'s `attached ==
        // selection ? .none : .hop(...)`; `DetachedWindowController.selectSession` opens with
        // `guard sessionId != self.sessionId else { return }`), and this method had no such
        // guard. `SessionSidebarRow.onTapGesture` calls `onSelect(row.sessionId)`
        // UNCONDITIONALLY — no `isCurrent` check — so re-clicking the row already displayed
        // reaches this line on every tap. `AppModel.refocus`'s own idempotency guard
        // (`sessionId == focusedSessionId && attachedSession == sessionId`) makes the caller's
        // FOLLOWING `focusSession` a genuine no-op in that case: `session.reset()` never runs,
        // `pendingInteractions` is untouched, nothing about the session changes — but this line
        // still wiped a live, typed-but-unsubmitted draft anyway. There was prior art warning
        // against exactly this: in `GlassRootView.swift`, the "I1 (review)" comment sitting
        // directly above the line that wires `boundSessionId` (see below) already records that
        // THIS call site was deliberately kept free of non-idempotent per-call side effects, for
        // the same reason.
        //
        // `fieldAdapter.boundSessionId()` is the comparison — not a new stored property —
        // verified from the source, not assumed: it resolves to `AppModel.focusedSessionId` via
        // `SidebarWiring.currentSessionId` (a plain `() -> String?`, `GlassRootView`'s wiring,
        // `AppDelegate.boot()`'s own), re-read fresh on every call with no caching anywhere in
        // the chain. `refocus` is documented as "the ONE place `focusedSessionId` is ever
        // assigned" (`AppModel.swift`), and `fieldAdapter` itself was constructed with
        // `model.session` DIRECTLY (`AppDelegate.swift`'s `OrbWindowController(session:
        // model.session)`) — the SAME object `refocus` mutates (`SessionModel` is a `final
        // class`) — so `boundSessionId()` and `fieldAdapter.pendingInteractions` can never name
        // two different sessions. At the moment this method runs — synchronously, BEFORE the
        // caller's separate `Task { focusSession(sid) }` even starts — `boundSessionId()` still
        // reads the PRE-switch value: correctly "different" for a genuine switch (the switch
        // hasn't landed yet), correctly "same" for a settled redundant reselect (the realistic
        // case: enough real time has passed since the original switch for ITS OWN async refocus
        // to have long since completed and updated `focusedSessionId`).
        guard sessionId != fieldAdapter.boundSessionId() else { return }
        fieldAdapter.pendingCardDrafts = [:]
    }

    /// Task 4: fired by `requestWindowDetach()` with the panel's CURRENT frame (spawn the detached
    /// window exactly there). AppDelegate's closure spawns the detached window SYNCHRONOUSLY
    /// (`DetachedWindowController.show()`'s `makeKeyAndOrderFront` runs before the closure
    /// returns) — see `requestWindowDetach()`'s doc for the never-both-invisible ordering this
    /// depends on. The controller exposes this callback, it does NOT import AppModel/AppDelegate
    /// (same seam convention as `onSubmit`/`onEsc` above).
    ///
    /// I1 fix (review): returns whether a window actually spawned. AppDelegate's closure can bail
    /// with nothing spawned (no focused session yet — reachable via summon→expand→yellow before
    /// any message — or `makeDetachedFeed` returning nil on a missing daemon token), and
    /// `requestWindowDetach()` gates its exit-to-orb on this return so a spawn failure never
    /// discards the window surface's content into the orb with nothing to show for it. `nil`
    /// (unwired — e.g. tests that never set this) defaults to `true`, preserving the old
    /// unconditional-exit behavior.
    var onWindowDetach: ((NSRect) -> Bool)?

    /// Wave-5 gate item 4: the composer-hop seam — `handleAcceptedSwipe` below needs to know
    /// whether the shell is CURRENTLY showing the composer (`FieldStateAdapter.showingDraft`) to
    /// decide the swipe against the field's full position space (history ⟷ response ⟷ composer,
    /// see `navigateFieldSwipe`), but that flag lives on the adapter `GlassRootView` owns, not
    /// here (the controller doesn't import FieldKit's adapter type). Wired idempotently by
    /// `GlassRootView.wireCallbacks()`, same pattern/lifecycle as `FieldStateAdapter`'s own
    /// `onSubmit`/`onClearMessage`/`onCollapse` closures.
    var isShowingDraft: (() -> Bool)?
    /// Wired by `GlassRootView.wireCallbacks()` to `adapter.showingDraft = `. The other half of
    /// the composer-hop seam above.
    var setShowingDraft: ((Bool) -> Void)?

    /// Wave 2c task 4: which historical exchange (index into `session.state.exchanges`) the
    /// field's shell is pinned to via an accepted 2-finger swipe — `nil` = live/draft view
    /// (`ExchangeNavigation.swift`'s convention). `private(set)`: only `handleAcceptedSwipe`
    /// below (from the scroll monitor) and `finishCollapse()` move it from inside this class;
    /// `resetExchangeIndex()` is the one external hook (`GlassRootView.submit()` calls it on a
    /// successful send — the same place the draft-clear-on-success logic already lives).
    /// `GlassRootView` additionally resets it the instant a new turn actually STARTS, mirroring
    /// the draft-cache reset rule, via `.onChange(of: session.state.turnRunning)`.
    @Published private(set) var exchangeIndex: Int?

    func resetExchangeIndex() {
        exchangeIndex = nil
    }

    // MARK: - Thinking-minimize choreography (wave-3 gate item 2)

    /// One-shot latch: `GlassRootView.submit()` arms this on a send that succeeds WHILE THE
    /// SESSION WAS IDLE (a genuine new-turn submit, not a mid-turn steer) — distinguishing "this
    /// turn-start followed the field's OWN submit" (item 2a: auto-collapse) from "a turn started
    /// for some other reason while the field happens to be open" (e.g. the user summoned the
    /// field DURING an already-running turn to watch/steer — that path never arms this, and a
    /// steer submit doesn't either, since `wasIdle` is false). `consumeCollapseOnTurnStart()` is
    /// the only reader — it always clears the flag so a stale arm from an earlier submit can
    /// never fire on a LATER, unrelated turn-start.
    var collapseOnTurnStart = false

    /// Consumes (and always clears) `collapseOnTurnStart` — one-shot by construction: a second
    /// turn-start without a fresh submit in between returns `false`.
    @discardableResult
    func consumeCollapseOnTurnStart() -> Bool {
        defer { collapseOnTurnStart = false }
        return collapseOnTurnStart
    }

    /// One-shot latch: `GlassRootView`'s turn-completion handler arms this immediately before
    /// calling `expandToField()` to reveal a finished answer (item 2b) — without it, the
    /// existing summon-home-state rule (`summonShowsComposer`, v1 semantics: every summon opens
    /// the COMPOSER unless a turn is actively streaming) would flip `showingDraft` back to
    /// `true` on this very expand, since by definition the turn has already finished
    /// (`turnRunning == false`) — hiding the very answer this auto-expand exists to reveal.
    var expandForAnswerReveal = false

    /// Consumes (and always clears) `expandForAnswerReveal` — one-shot, same shape as
    /// `consumeCollapseOnTurnStart()` above.
    @discardableResult
    func consumeExpandForAnswerReveal() -> Bool {
        defer { expandForAnswerReveal = false }
        return expandForAnswerReveal
    }

    /// Task 2d-i.2: the ONE FieldStateAdapter both surfaces (field + chat window) observe.
    /// Owned here — not by GlassRootView — so the chat window shares drafts, replies, and
    /// focus state with the field for free.
    let fieldAdapter: FieldStateAdapter

    private let session: SessionModel
    private let swipeRecognizer = TrackpadHorizontalSwipeRecognizer()
    private var keyMonitor: Any?
    private var scrollMonitor: Any?
    private var externalFocus: ExternalFocusSnapshot?

    // MARK: Morph spring (60Hz Timer — v1 GlassFieldWindow.swift:1795-1845)

    private var morphTimer: Timer?
    private var lastMorphTick = CACurrentMediaTime()
    private var morphVelocity: Double = 0
    private var morphTarget: Double = 0

    // MARK: Zoom spring (Task 5 — green traffic light; SAME Timer+Task-hop pattern as
    // `morphTimer` above, but a DISTINCT timer/scalar: the window shell itself is not re-morphing
    // during a zoom (`morphModel.progress` stays pinned at 1 throughout), only its CONTENT size is
    // animating, so this drives its own independent 0…1 scalar rather than reusing `morphTarget`.

    private var zoomTimer: Timer?
    private var lastZoomTick = CACurrentMediaTime()
    private var zoomVelocity: Double = 0
    /// 0 == `chatWindowDefaultSize`, 1 == `zoomedContentSize` (the currently in-flight/just-settled
    /// leg's near-fullscreen target).
    private var zoomProgress: Double = 0
    private var zoomTarget: Double = 0
    /// The near-fullscreen content size for the CURRENTLY in-flight (or just-settled) zoom-IN leg —
    /// recomputed only when a press starts a FRESH zoom-in (`zoomToggleWindow()`'s `else` branch);
    /// a retarget back toward 0 while already zooming in just flips `zoomTarget`, it never touches
    /// this, so the interpolation's "1" end stays fixed for the whole animation even though
    /// `windowSurfaceLayout` itself is recomputed fresh every tick.
    private var zoomedContentSize = chatWindowDefaultSize

    init(session: SessionModel) {
        self.session = session
        self.fieldAdapter = FieldStateAdapter(session: session)
        let morph = MorphModel()
        self.morphModel = morph
        self.follower = OrbFollower(morphModel: morph, fluidModel: fluidModel)

        // v1 PointerOverlayWindow configuration, verbatim, except the panel now starts sized to
        // the COLLAPSED geometry (task B: the panel resizes between `collapsedWindowSize` and
        // `windowSize` as the field expands/collapses — see the type doc above).
        panel = KeyableNonActivatingPanel(
            contentRect: NSRect(origin: .zero, size: morph.collapsedWindowSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.ignoresMouseEvents = true
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false

        follower.onWindowOriginChange = { [weak self] origin in
            guard let self, isVisible else { return }
            panel.setFrameOrigin(origin)
        }
        // Guarded by collapseToOrb() itself (no-op unless surface == .field) — see OrbFollower's
        // doc on why this fires unconditionally on every fast-flick sample.
        follower.onFastFlick = { [weak self] in
            self?.collapseToOrb()
        }

        // ARCHITECTURE NOTE above: GlassRootView (not OrbView) is the panel's content — it hosts
        // `NormaFieldView` (FieldKit), which owns its own `GlassEffectContainer` and renders the
        // whole orb↔field morph off `morphModel.progress`.
        panel.contentView = NSHostingView(
            rootView: GlassRootView(
                session: session, controller: self, morphModel: morph,
                fluidModel: fluidModel, adapter: fieldAdapter
            )
        )
    }

    func show() {
        guard !isVisible else { return }
        isVisible = true
        panel.orderFrontRegardless()
        follower.start()
    }

    func hide() {
        guard isVisible else { return }
        if surface == .field {
            // Gate fix (F1): hiding outright is a stronger action than a pending field→window
            // handoff — never let a stale `pendingWindowExpand` from an aborted handoff fire the
            // window expansion this force-finish's `finishCollapse()` (below) is about to run.
            pendingWindowExpand = false
            // Nobody will see the last bit of the collapse morph once the panel is ordered
            // out — snap it to settled rather than leaving an orphaned Timer + monitor + key
            // panel running behind a hidden window.
            cancelMorphTimer()
            morphModel.progress = 0
            morphVelocity = 0
            finishCollapse()
        } else if surface == .window {
            // Gate r7: hiding while the window is open — snap-finish the window's collapse to the
            // orb (same teardown the morph settle runs) rather than orphaning its monitors + mouse
            // gate behind a hidden panel.
            // Task 5: a zoom in flight must never keep animating behind a hidden panel either —
            // cancel it alongside the morph timer, before the snap-finish below.
            cancelZoomTimer()
            cancelMorphTimer()
            morphModel.progress = 0
            morphVelocity = 0
            finishWindowCollapse()
        }
        isVisible = false
        follower.stop()
        panel.orderOut(nil)
    }

    func toggle() { isVisible ? hide() : show() }

    /// Expands the collapsed orb into the field IN PLACE: captures external focus, makes the
    /// panel keyable and key, flips `surface` to `.field` immediately (so a fast Esc/flick can
    /// reverse the morph before it settles), and starts the morph spring toward 1.
    ///
    /// Task B: mirrors v1 `show()`'s exact order (GlassFieldWindow.swift:695-773) — the panel is
    /// resized UP to `morphModel.windowSize` at the current glass-anchor point BEFORE the morph
    /// starts (the frame itself never changes DURING the morph, only the content geometry does);
    /// only afterward does `morphTarget` flip to 1. `follower.isExpanded = true` right after the
    /// resize keeps the tracking spring's per-frame target consistent with the panel's new real
    /// size, and `follower.snapWindowOrigin(to:)` avoids a one-frame "catch up" jump from the
    /// spring's stale pre-resize position.
    func expandToField() {
        // RETARGET (v1 parity — GlassFieldWindow.swift:765-772's `midHide` re-show): a
        // re-summon arrived while a collapse morph is still in flight. `surface` is still
        // `.field` here — it only flips to `.orb` inside `finishCollapse()`, which itself
        // only runs once the morph SETTLES with `morphTarget == 0` (see `morphTick()`).
        // Teardown therefore never ran: the panel is still keyable, still key, still sized
        // to `morphModel.windowSize`, and the focus snapshot and key monitor are still live.
        // So there is nothing to re-acquire (no resize either — the panel is already the
        // right size) — just reverse the spring's target back toward 1 from wherever
        // `progress` currently sits (no snap, no discontinuity) and bail out before any of
        // the "cold start" setup below re-runs. Flipping `morphTarget` here doubles as
        // clearing the pending collapse completion: `finishCollapse()` is gated on
        // `morphTarget == 0` read FRESH at settle time (there's no captured completion
        // closure to go stale), so once the target is 1 the stale collapse-teardown can
        // never fire — it settles at 1 instead of 0.
        if surface == .field && morphTarget == 0 {
            // Gate fix (F1): a re-summon mid-collapse cancels any pending field→window handoff
            // armed by `enterWindowMode()` — the user reopened the field instead of letting it
            // finish morphing into the orb, so that handoff must never fire once THIS retargeted
            // morph later settles (belt: it settles at 1 now anyway, never hitting
            // `morphTick()`'s `morphTarget == 0` gate — but a one-shot must never be left armed
            // past the cycle it was meant for).
            pendingWindowExpand = false
            startMorph(target: 1)
            // Finding-2 (belt): teardown never ran on this path, so the panel is still keyable and
            // still key and NO `restore()` fired this cycle — so unlike the cold path below there's
            // no live race to beat here. Re-assert only DEFERRED (next runloop tick), purely to
            // catch an EARLIER collapse cycle's `restore()` activation that might still be in
            // flight. Deliberately NOT synchronous: this retarget sequence feeds a timing-sensitive
            // 60Hz morph spring (see `MorphTimerReentrancyTests`), and a synchronous
            // `orderFrontRegardless()`/`makeKey()` inline here perturbs that spring's settle timing.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.surface == .field, !self.panel.isKeyWindow else { return }
                self.makePanelKeyWinningLateActivation()
            }
            OrbDebug.log("expandToField: retarget mid-collapse re-summon, morphTarget=1")
            return
        }

        guard surface == .orb else { return }

        // Gate-3 fix (F1): the collapsed orb now tracks the cursor across the FULL screen
        // (`OrbFollower.targetOrigin()` no longer over-fences it against the expanded frame's
        // size — see that type's doc). That means the orb can genuinely be sitting right at a
        // screen edge when the user expands, so the raw anchor is re-fenced HERE, against the
        // real `windowSize` about to be applied, before computing the resize origin — otherwise
        // a bottom/edge-hugging orb could expand partially off-screen on this one hard
        // `setFrame` cut (the follower's own per-frame fence only kicks in on the NEXT tick).
        let anchor = fenceAnchorForTopLeftCorner(
            currentGlassAnchor(),
            expandedSize: morphModel.windowSize,
            haloPadding: morphModel.haloPadding,
            navOffset: morphModel.navPillHeight + morphModel.interPillGap,
            visibleFrame: (panel.screen ?? NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
        )
        let origin = morphModel.corner.windowOrigin(
            glassAnchor: anchor,
            morph: morphModel,
            windowSize: morphModel.windowSize,
            surface: .composer
        )
        panel.setFrame(NSRect(origin: origin, size: morphModel.windowSize), display: false)
        // Gate-3 fix (F1, root cause #2): keep `NormaFieldView`'s outer `.frame(...)` request in
        // lockstep with this resize — see `MorphModel.activeWindowSize`'s doc for why (NSHostingView
        // otherwise silently resizes this panel back to whatever the SwiftUI content requests).
        morphModel.activeWindowSize = morphModel.windowSize
        follower.isExpanded = true
        follower.snapWindowOrigin(to: origin)

        externalFocus = ExternalFocusSnapshot.captureCurrent()
        panel.acceptsKeyInput = true
        panel.ignoresMouseEvents = false
        surface = .field
        // Finding-2 fix (gate 2): make the panel key AND keep it key against a late external-app
        // reactivation — see `makePanelKeyWinningLateActivation`'s doc. `surface = .field` is set
        // FIRST so the belt in the key monitor (and the retry's `surface == .field` guard) sees the
        // right surface immediately.
        makePanelKeyWinningLateActivation()
        startMorph(target: 1)

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self else { return event }
            // Finding-2 belt (gate 2, wave-9 parity): a LOCAL monitor only ever sees OUR app's own
            // events, and this accessory app has exactly ONE window a keyDown could be meant for
            // while the field/window is open — this panel. So route Esc on the SURFACE, not on
            // `event.window === panel`: a re-summon key race can leave the keyDown bound to a
            // stale/nil window (exactly what wave-9 found for synthesized scrolls), and the old
            // window-identity guard then silently dropped a perfectly good Esc. The routing
            // functions are pure/table-tested (window identity is deliberately not an input).
            //
            // Gate r7: the SAME monitor now serves the window surface too — `finishCollapse()` never
            // ran on the field→window handoff, so this monitor is still installed; it reads
            // `self.surface` live and dispatches to `windowEscAction` while `.window`.
            let running = self.session.state.turnRunning
            switch self.surface {
            case .field:
                switch escMonitorAction(
                    keyCode: event.keyCode, surface: .field,
                    escConsumed: { self.onEsc?() == true }
                ) {
                case .passThrough:
                    return event
                case .interrupt:
                    OrbDebug.log("key monitor: field Esc → interrupt panelKey=\(panel.isKeyWindow) turnRunning=\(running)")
                    return nil
                case .collapse:
                    OrbDebug.log("key monitor: field Esc → collapse panelKey=\(panel.isKeyWindow) turnRunning=\(running)")
                    self.collapseToOrb()
                    return nil
                }
            case .window:
                switch windowEscAction(keyCode: event.keyCode, escConsumed: { self.onEsc?() == true }) {
                case .interrupt?:
                    OrbDebug.log("key monitor: window Esc → interrupt turnRunning=\(running)")
                    return nil
                case .close?:
                    OrbDebug.log("key monitor: window Esc → collapse turnRunning=\(running)")
                    self.collapseWindowToOrb()
                    return nil
                case nil:
                    // Task 3 (2d-iii): y/n/digit card routing — ONLY reached once Esc handling
                    // above has passed (not Esc, or Esc consumed nothing surface-relevant). Only
                    // the WINDOW surface mounts `PendingCardsView` (`WindowContentView`, shared
                    // with `DetachedWindowController`) — the small `.field` composer never shows
                    // cards, so this routing is scoped to `.window` only, not `.field` above.
                    let topmost = self.fieldAdapter.pendingInteractions.first
                    if let action = cardKeyAction(
                        keyCode: event.keyCode,
                        chars: event.charactersIgnoringModifiers,
                        topmost: topmost,
                        composerDraft: self.fieldAdapter.composerDraft,
                        textFieldFocused: isTextEditingFocused(in: panel)
                    ) {
                        self.dispatchCardKeyAction(action, topmost: topmost)
                        return nil
                    }
                    return event
                }
            case .orb:
                return event
            }
        }

        // Wave 2c task 4: same lifecycle as the Esc monitor above — installed only while
        // `.field`, torn down on collapse completion (`finishCollapse()`). Window-scoped like
        // the key monitor so a swipe elsewhere in the app (there's only ever this one panel,
        // but the filter costs nothing) never gets routed here.
        swipeRecognizer.reset()
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
            guard let self else { return event }
            // Gate r7: this monitor's swipe/response-scroll interception is FIELD-only. In window
            // mode the surface is opaque with a real `ScrollView` that hit-tests natively (no
            // difference blend to break it — the whole reason the window escapes the field's
            // regime), so scrolls must pass straight through untouched.
            guard self.surface == .field else { return event }
            // Real trackpad events arrive bound to the panel (`event.window === panel` — proven
            // live in wave 8: 80 consecutive real samples). Synthesized scroll events
            // (accessibility/automation tooling, and this project's own CGEvent verification
            // probes) can NEVER take that path: macOS's window server refuses to route a
            // synthesized scroll to a borderless nonactivating panel (verified empirically in
            // wave 9 — `.cghidEventTap` and `.cgSessionEventTap` posts over the panel's visible
            // pixels with the cursor warped there never reached this app at all), and
            // `CGEventPostToPid` delivers them with NO window binding (`event.window == nil`,
            // `windowNumber == 0`). A nil-window scroll event reaching this single-panel app has
            // no other possible target — AppKit drops it after monitors run — so treating one as
            // panel-directed while the cursor is actually inside the panel's frame is safe and
            // makes the surface driveable by synthetic events, same spirit as v1's
            // ScrollRedirector consuming raw CGEvents that never had a window at all.
            let panelDirected = event.window === panel
                || (event.window == nil && panel.frame.contains(NSEvent.mouseLocation))
            guard panelDirected else {
                // Wave-9 diagnostic (debug-gated, permanent): without this branch a rejected
                // sample vanished silently, leaving "no log lines" ambiguous between "no events
                // arrived at the app" and "events arrived but failed the window guard".
                OrbDebug.log("scroll monitor: NON-PANEL window=\(event.window.map { String(describing: type(of: $0)) } ?? "nil") num=\(event.windowNumber) dy=\(event.scrollingDeltaY)")
                return event
            }
            let result = swipeRecognizer.handle(event)
            result.performAcceptedFeedback { direction in
                self.handleAcceptedSwipe(direction)
            }

            // Wave-9 gate fix (v1 mechanism port — see `MorphModel.responseScrollOffset`'s doc
            // and the wave-9 report): wave 8 proved every vertical-dominant sample reaches this
            // monitor and gets handed back to AppKit (`.ignored` → PASSED, `return event`) — but
            // AppKit's normal hit-test dispatch never actually delivers it to the reply's
            // viewport (`GlassForegroundLegibility`'s `.compositingGroup()` breaks that path,
            // confirmed via synthesized CGEvent probes). v1 never trusted that dispatch either
            // (its composer was permanently `ignoresMouseEvents = true`): its `ScrollRedirector`
            // CGEventTap drove the AppKit clip-view bounds directly off the raw deltas and
            // swallowed the event at the tap. Same idea here, scoped to this monitor: an
            // `.ignored` sample (not part of a horizontal swipe) while the inline response is
            // actually showing drives `responseScrollOffset` directly and is swallowed ourselves,
            // rather than handed back to a dispatch path that silently drops it. A `.ignored`
            // sample while the COMPOSER is showing (or there's no reply at all) still falls
            // through to `return event` unchanged — this fix is scoped to the reply only, per the
            // wave-9 brief.
            var consumed = result.consumesScroll
            if case .ignored = result, self.isShowingInlineResponse() {
                self.applyResponseScroll(deltaY: event.scrollingDeltaY)
                consumed = true
            }

            // Wave-8 gate item 2 empirical evidence hook, extended for wave 9: NORMA_ORB_DEBUG=1
            // traces every scroll-wheel sample's CONSUMED (swallowed here — either swipe-tracking
            // or, new in wave 9, manually driving the reply's scroll offset) vs PASSED (handed
            // back to AppKit unchanged) decision, paired with the raw deltas/phase that drove it
            // and the resulting offset — this is what proves a vertical two-finger drag actually
            // moves the reply now instead of being silently dropped by AppKit's hit-test dispatch.
            OrbDebug.log("scroll monitor: \(consumed ? "CONSUMED" : "PASSED") result=\(result) dx=\(event.scrollingDeltaX) dy=\(event.scrollingDeltaY) phase=\(event.phase) responseScrollOffset=\(self.morphModel.responseScrollOffset)")
            return consumed ? nil : event
        }

        OrbDebug.log("expandToField: morphTarget=1")
    }

    /// Task 3 (2d-iii): turns a `cardKeyAction(...)` result into the matching `fieldAdapter`
    /// respond call. `.selectOption` rebuilds its answers dict via the SAME pure `questionAnswers`
    /// helper the card's own whole-card Submit button uses (`PendingCards.swift`) — a digit press
    /// is "complete by construction" (the router only ever returns `.selectOption` for a single-
    /// question single-select card, see `cardKeyAction`'s doc), so this single call both selects
    /// AND submits, exactly like clicking that one option then Submit would. `topmost` is passed
    /// in (not re-read) so this stays consistent with whichever card the router itself matched
    /// against, in the same synchronous key-handling pass.
    private func dispatchCardKeyAction(_ action: CardKeyAction, topmost: PendingInteraction?) {
        switch action {
        case .approve(let callId, let childSessionId):
            fieldAdapter.onApprovalRespond(callId, true, nil, childSessionId)
        case .deny(let callId, let childSessionId):
            fieldAdapter.onApprovalRespond(callId, false, nil, childSessionId)
        case .selectOption(let callId, let index, let childSessionId):
            guard case .question(_, let questions, _) = topmost else { return }
            fieldAdapter.onQuestionRespond(callId, questionAnswers(for: questions, selections: [0: [index]], otherTexts: [:]), [:], childSessionId)
        }
    }

    /// Finding-2 fix (gate 2 — "Esc from the field is dead after a re-summon"). ROOT CAUSE: after an
    /// auto-collapse, `finishCollapse()` calls `externalFocus?.restore()` →
    /// `NSRunningApplication.activate()` on the app that was frontmost before we summoned. The
    /// WindowServer processes that activation ASYNCHRONOUSLY. A fast re-summon's `panel.makeKey()`
    /// can therefore run and win momentarily, only for the in-flight external activation to LAND a
    /// beat later and steal system key focus back. The panel is then no longer the key window,
    /// physical keyDowns (incl. Esc) route to the external app, and our LOCAL key monitor — which
    /// only ever sees OUR app's own events — never fires at all (no belt can recover an event that
    /// never arrives; that's why the wave-9-style window-agnostic belt in the monitor is necessary
    /// but not SUFFICIENT — this is the sufficient half).
    ///
    /// FIX: assert key now, then RE-ASSERT on the next runloop tick(s). By the next tick the late
    /// external activation has already landed, so our re-`makeKey()` is the last word and wins.
    /// `orderFrontRegardless()` + `makeKey()` (deliberately NOT `NSApp.activate(ignoringOtherApps:)`
    /// — v1's avoided nuclear option; a `.nonactivatingPanel` can hold key focus without activating
    /// the whole app, Spotlight-style). Bounded retries, and each retry bails the instant the panel
    /// is already key or the surface has left `.field`, so it can never spin.
    private func makePanelKeyWinningLateActivation(retriesLeft: Int = 3) {
        keyAssertionCountForTesting += 1
        panel.orderFrontRegardless()
        panel.makeKey()
        let isKey = panel.isKeyWindow
        OrbDebug.log("makePanelKey: panelKey=\(isKey) retriesLeft=\(retriesLeft)")
        guard !isKey, retriesLeft > 0 else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.surface == .field, !self.panel.isKeyWindow else { return }
            self.makePanelKeyWinningLateActivation(retriesLeft: retriesLeft - 1)
        }
    }

    /// The physical screen point where the composer's chosen corner (`morphModel.corner`,
    /// always `.topLeft`) currently sits, derived from the panel's ACTUAL live frame. Stable
    /// across a resize — that's the whole "expand in place" property (see the type doc above):
    /// resizing the panel only adds/removes interior space to the right/below this point, it
    /// never moves the point itself, so this can be read BEFORE either `expandToField()`'s
    /// up-resize or `finishCollapse()`'s down-resize to recover the exact anchor to resize
    /// around, regardless of which size the panel currently is.
    private func currentGlassAnchor() -> CGPoint {
        let origin = panel.frame.origin
        let size = panel.frame.size
        let local = morphModel.corner.orbAnchorInWindow(windowSize: size, morph: morphModel)
        return CGPoint(x: origin.x + local.x, y: origin.y + size.height - local.y)
    }

    /// Wave-5 gate item 4 (user directive, addendum): the v1 music-player convention (`.left →
    /// previousTrack()`, `.right → nextTrack()`) is REPLACED by page-flip/browser-back — physical
    /// `.right` means back/older, `.left` means forward/newer (`exchangeNavDirection(for:)`,
    /// `Field/ExchangeNavigation.swift`). The decision now covers the field's FULL position
    /// space, not just history: swiping "newer" past the live (nil) view hops into the composer;
    /// swiping "older" from the composer hops back to the response, when there's a reply to
    /// return to (`navigateFieldSwipe`, same file — extracted pure so it's table-tested).
    /// Returns whether the swipe actually moved anything so the haptic only fires on an ACCEPTED
    /// swipe (D6), not on every threshold crossing (e.g. already at the oldest exchange and
    /// swiping further "older" is a no-op, silently — same as before this wave).
    private func handleAcceptedSwipe(_ direction: TrackpadHorizontalSwipeDirection) -> Bool {
        let navDirection = exchangeNavDirection(for: direction)
        let showingDraft = isShowingDraft?() ?? false
        let hasReply = session.state.turnRunning
            || !(session.state.exchanges.last?.reply.isEmpty ?? true)
        guard let target = navigateFieldSwipe(
            exchangeIndex: exchangeIndex,
            showingDraft: showingDraft,
            hasReply: hasReply,
            direction: navDirection,
            count: session.state.exchanges.count
        ) else { return false }

        switch target {
        case .exchange(let next):
            if showingDraft { setShowingDraft?(false) }
            exchangeIndex = next
        case .composer:
            setShowingDraft?(true)
        }
        return true
    }

    /// Wave-9 gate fix: mirrors `NormaFieldView.showsInlineResponse` (`hasReply &&
    /// !adapter.showingDraft`) using the state this controller already has direct access to
    /// (`session.state`, and `isShowingDraft` — the same composer-hop seam `handleAcceptedSwipe`
    /// above reads), rather than reaching into `FieldStateAdapter` (which this controller
    /// deliberately doesn't import — see `isShowingDraft`'s own doc). Gates the scroll monitor's
    /// manual `responseScrollOffset` drive to exactly the surface it's meant for: showing the
    /// composer (or nothing at all) leaves an `.ignored` scroll sample untouched (`return event`),
    /// unchanged from before this wave.
    private func isShowingInlineResponse() -> Bool {
        guard isShowingDraft?() != true else { return false }
        return session.state.turnRunning || !(session.state.exchanges.last?.reply.isEmpty ?? true)
    }

    /// Wave-9 gate fix — ported from v1's `GlassFieldWindow.scrollComposer` (manual AppKit
    /// clip-view bounds scroll; see `MorphModel.responseScrollOffset`'s doc for the full
    /// mechanism and why hit-test dispatch can't be trusted here). Drives
    /// `morphModel.responseScrollOffset` directly off the raw vertical delta instead.
    ///
    /// Sign: `NSEvent.scrollingDeltaY` already bakes in the user's System Settings "natural
    /// scrolling" preference — a two-finger drag UP (fingers move toward the top of the trackpad)
    /// reports a NEGATIVE `scrollingDeltaY` under natural scrolling and is the gesture that reveals
    /// content further DOWN the reply (the conventional "scroll down" motion). Revealing content
    /// further down means the visible window into the reply moves further from its top, i.e.
    /// `responseScrollOffset` must INCREASE — hence the negation below (v1's own AppKit clip-origin
    /// convention, `origin.y -= deltaY` in `GlassFieldWindow.scrollComposer`, is the same negation
    /// for the same reason, just expressed in AppKit's bounds-origin terms instead of a SwiftUI
    /// offset). Verified empirically against synthesized CGEvent scroll probes — see the wave-9
    /// report.
    private func applyResponseScroll(deltaY: CGFloat) {
        morphModel.responseScrollOffset = clampedResponseScrollOffset(
            current: morphModel.responseScrollOffset,
            deltaY: deltaY,
            maxOffset: morphModel.maxResponseScrollOffset
        )
    }

    /// Starts the collapse morph toward 0. Teardown (monitor off, keyability off, focus
    /// restore, panel resize DOWN, `surface` → `.orb`) happens on COMPLETION
    /// (`finishCollapse()`), not here — the tracking spring runs throughout so the shrinking
    /// glass keeps riding the cursor instead of detaching mid-collapse (v1's "ghost circle" fix).
    func collapseToOrb() {
        guard surface == .field else { return }
        startMorph(target: 0)
        OrbDebug.log("collapseToOrb: morphTarget=0")
    }

    func toggleField() {
        if !isVisible {
            // Summon while hidden: bring the orb back first, then expand — never
            // expand an ordered-out panel (makeKey on a hidden window + nil screen).
            show()
        }
        if surface == .field && morphTarget == 0 {
            // Mid-collapse re-summon: v1 semantics are that a tap DURING the collapse
            // reopens (see `expandToField()`'s retarget path) rather than being dropped or
            // queuing a second collapse. Only a tap while fully open (or still expanding)
            // closes — that's the `else` below, unchanged.
            expandToField()
        } else if surface == .orb {
            expandToField()
        } else {
            collapseToOrb()
        }
    }

    /// One-shot latch (gate fix F1, gate r7): armed by `enterWindowMode()` instead of driving the
    /// handoff synchronously. The field must be SEEN to morph back into the orb before the window
    /// grows out of it, so `enterWindowMode()` merely arms this and starts the ordinary animated
    /// `collapseToOrb()` — the actual handoff (`presentWindowSurface()`: lock the screen, compute
    /// the layout, set the big window frame, flip to `.window`, start a fresh 0→1 morph on the SAME
    /// panel) fires from `morphTick()` the instant the reverse-morph crosses progress ≤0.08 (v1's
    /// `morphCompletionProgressThreshold`). `consumePendingWindowExpand()` is the one-shot consumer,
    /// same shape as `consumeCollapseOnTurnStart()`/`consumeExpandForAnswerReveal()` above.
    ///
    /// Cleared (never fires stale — this codebase got burned by exactly that once already, see
    /// `collapseOnTurnStart`'s doc) on any path that ends this collapse cycle for a DIFFERENT
    /// reason: `expandToField()`'s mid-morph retarget (the user re-summoned the field, cancelling
    /// the handoff) and `hide()`'s force-finish branch (hiding outright is a stronger action than
    /// a pending window handoff).
    private var pendingWindowExpand = false

    @discardableResult
    private func consumePendingWindowExpand() -> Bool {
        defer { pendingWindowExpand = false }
        return pendingWindowExpand
    }

    /// Legal only from `.field`. Gate fix (F1): no longer drives the handoff itself — arms
    /// `pendingWindowExpand` and starts the ordinary animated `collapseToOrb()` so the field
    /// visibly morphs back into the orb first. See `pendingWindowExpand`'s doc for the rest of
    /// the handoff (which runs inside `finishCollapse()` once the morph settles).
    func enterWindowMode() {
        guard surface == .field else { return }
        pendingWindowExpand = true
        collapseToOrb()
    }

    /// Task 6 (FieldFocus): public alias for `enterWindowMode()` reachable from
    /// `FieldStateAdapter.onExpandToWindow` — the field's Enter-on-chevron path and the (best-
    /// effort click) chevron overlay both call this indirectly via the adapter, never
    /// `enterWindowMode()` directly (the adapter has no reference to the controller's window-mode
    /// internals beyond this seam).
    func requestExpandToWindow() {
        enterWindowMode()
    }

    /// Gate r7 test seam: the window is zoomed (green traffic light) — a spring-animated (Task 5)
    /// grow to a near-fullscreen content size; toggles back to `chatWindowDefaultSize`. Flips
    /// immediately on press (the TARGET, same "flip now, animate toward it" contract as `surface`
    /// itself) — `zoomProgress`/`zoomTimer` is what actually animates toward whichever size this
    /// now says. Reset on collapse.
    private(set) var windowZoomed = false

    /// Gate r8: the CONTENT size held fixed for the duration of a window collapse, captured by
    /// `collapseWindowToOrb()` from whatever `windowFinalRect` was open with (so a ZOOMED window
    /// collapses at its zoomed size, never silently resetting to `chatWindowDefaultSize`).
    /// `rideWindowCollapseToCursor()` re-lays-out every tick at this fixed content size — only the
    /// ANCHOR (and therefore the panel frame/orb point) moves.
    private var windowCollapseContentSize = chatWindowDefaultSize

    /// Gate r8: the screen locked in for the whole collapse ride (v1 parity — `lockLargeSurface`
    /// never re-resolves which screen to use mid-flight, even if the cursor wanders onto another
    /// display during the collapse). `nil` outside of an in-flight window collapse.
    private var windowCollapseLockedScreen: CGRect?

    /// Gate r7 (ARCHITECTURE PIVOT): present the large window surface on the SAME panel — v1's
    /// `presentLargeSurface` (GlassFieldWindow.swift:829-883), simplified for v2's single centered
    /// surface. Called from `morphTick()` the instant the field's reverse-morph crosses progress
    /// ≤0.08, so the composer is seen morphing back toward the orb before the window grows out of
    /// it. Locks the screen, computes the layout, sets the big window frame UP-FRONT, updates
    /// `activeWindowSize`, switches to fixed-Space behavior (no `.canJoinAllSpaces` — the window
    /// stays on its Space, v1 parity), flips to `.window`, and starts a FRESH 0→1 morph (SAME
    /// 140/22 spring, same `morphTick`).
    private func presentWindowSurface() {
        guard consumePendingWindowExpand() else { return }
        cancelMorphTimer() // the field's reverse-morph is done; take over with a fresh window morph

        // The orb's current screen position — `finishCollapse()` never ran (we cancelled the field
        // collapse mid-way), so the panel is still the FIELD frame and `currentGlassAnchor()` reads
        // its orb anchor, which the collapse's cursor-riding put at ~the cursor.
        let anchor = currentGlassAnchor()
        let screen = visibleScreenFrame(containing: anchor)
        let layout = windowSurfaceLayout(
            anchor: anchor,
            contentSize: chatWindowDefaultSize,
            haloPadding: morphModel.haloPadding,
            orbBubbleSize: morphModel.orbBubbleSize,
            screenFrame: screen
        )
        morphModel.windowFinalRect = layout.finalRect
        morphModel.windowOrbPoint = layout.orbPoint
        windowZoomed = false

        // Stationary (spec §5): pause the follower so it never springs the locked window frame.
        follower.windowStationary = true

        // Fixed-Space behavior — the window stays on the Space it opened on (v1 parity:
        // `fixedSpacePanelCollectionBehavior`, no `.canJoinAllSpaces`).
        panel.collectionBehavior = [.stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.setFrame(layout.windowFrame, display: false)
        // Keep NSHostingView's own auto-resize in lockstep (see `MorphModel.activeWindowSize`).
        morphModel.activeWindowSize = layout.windowFrame.size

        // Window-mode input: keyable + hit-testable (gated by the mouse gate) + draggable by the
        // glass body (spec §5 — only in window mode; false everywhere else).
        panel.acceptsKeyInput = true
        panel.ignoresMouseEvents = false
        panel.isMovableByWindowBackground = true
        panel.orderFrontRegardless()
        panel.makeKey()

        surface = .window
        morphModel.renderSurface = .window
        morphModel.progress = 0
        morphVelocity = 0

        startWindowMouseGate()
        startMorph(target: 1)
        OrbDebug.log("presentWindowSurface: anchor=\(anchor) windowFrame=\(layout.windowFrame)")
    }

    /// Gate r7: window → orb collapse — Esc (idle), the RED traffic light, and the 4-finger tap
    /// all route here (Task 4: the yellow light no longer does — see `requestWindowDetach()`). v1
    /// parity: the large surface ALWAYS returns to the orb, never back to the field.
    /// Reverse-morphs the shell back down to the orb bubble (SAME 140/22 spring);
    /// `finishWindowCollapse()` does the teardown once it settles.
    ///
    /// Gate r8: also arms the cursor-ride (`rideWindowCollapseToCursor()`, driven from `morphTick()`
    /// every tick this collapse is in flight) by capturing what stays FIXED for the whole ride — the
    /// content size (so a zoomed window collapses at its zoomed size) and the screen the window
    /// opened on (v1 `lockLargeSurface` parity — never re-resolved mid-flight).
    func collapseWindowToOrb() {
        guard surface == .window else { return }
        // Task 5: a zoom in flight must never keep animating once the collapse takes over the
        // panel frame — cancel it FIRST. Whatever content size the zoom had reached (mid-flight or
        // settled) is exactly what `windowFinalRect` reads below, so a collapse mid-zoom rides out
        // at whichever size it was interrupted at — no separate reconciliation needed.
        cancelZoomTimer()
        windowCollapseContentSize = morphModel.windowFinalRect?.size ?? chatWindowDefaultSize
        windowCollapseLockedScreen = visibleScreenFrame(containing: currentWindowScreenAnchor())
        startMorph(target: 0)
        OrbDebug.log("collapseWindowToOrb: morphTarget=0")
    }

    /// Task 4: one-shot re-entrancy latch for `requestWindowDetach()` — armed for the duration of
    /// the synchronous `onWindowDetach?(frame)` callback (during which `surface` is STILL
    /// `.window` — it only flips inside `exitWindowModeForDetach()`, called right after only on a
    /// successful spawn), cleared unconditionally right after (I1 fix: whether or not the exit
    /// actually ran — a false return must never leave this latch stuck armed, or every later
    /// detach attempt would silently no-op forever). Guards against a reentrant detach request
    /// landing inside the callback itself, before the ordinary `surface == .window` guard alone
    /// would catch it.
    private var detachInFlight = false

    /// Task 4 (yellow traffic light → detach): spawns a native detached window at the panel's
    /// CURRENT frame, then frees the orb panel back to `.orb` — no animation, same instant
    /// teardown `hide()`'s `.window` branch already uses (`exitWindowModeForDetach()` below), just
    /// without ordering the panel out (the orb stays visible; a new window took the field's
    /// place).
    ///
    /// Guarded against firing mid-morph (`morphTimer != nil` — covers any spring currently
    /// driving the panel, including the window's own open/close morph), mid-zoom (`zoomTimer !=
    /// nil` — Task 5's spring-animated green traffic light; a detach mid-zoom is a no-op exactly
    /// like a detach mid-morph, not a snap-then-detach), mid-handoff (`pendingWindowExpand` — the
    /// field hasn't finished collapsing into the window yet), when the surface isn't actually
    /// `.window`, or re-entrantly (`detachInFlight`).
    ///
    /// OWNS the never-both-invisible ordering (see the task brief): fires `onWindowDetach?(frame)`
    /// FIRST — the caller's closure (AppDelegate) spawns the detached window SYNCHRONOUSLY
    /// (`DetachedWindowController.show()`'s `makeKeyAndOrderFront` runs before that closure
    /// returns) — and only THEN runs `exitWindowModeForDetach()`, and only when that closure
    /// reports the spawn actually succeeded (I1 fix, review: `onWindowDetach` can no-op — no
    /// focused session yet, or a missing daemon token — and running the exit unconditionally in
    /// that case discarded the window's content into the orb with nothing spawned to replace it).
    /// So there is never a frame where neither the window surface nor a detached window is on
    /// screen, AND a failed spawn leaves the window surface untouched rather than vanishing it.
    ///
    /// LIVE-GATE W1a fix: `frame` used to be the raw panel frame — which spans content + the
    /// invisible halo padding + the orb-anchor union (`windowSurfaceLayout`'s doc), so the
    /// detached window spawned visibly BIGGER than the morph window it replaced. It now fires with
    /// the visible glass CONTENT rect instead, derived from `morphModel.windowFinalRect` (window-
    /// local, y-down) mapped to screen coords against the panel's live frame — same conversion
    /// `updateWindowMouseGate()` already uses for hit-testing, extracted pure as
    /// `windowSurfaceContentScreenRect` so it's unit-tested. `windowFinalRect` is always set here
    /// in practice (the `surface == .window` guard above is only reachable once
    /// `presentWindowSurface()` has run, which sets it, and nothing clears it before
    /// `finishWindowCollapse()` — reached only once `surface` has already left `.window`) — the
    /// `?? frame` fallback is defensive only, never expected to fire.
    func requestWindowDetach() {
        guard surface == .window, morphTimer == nil, zoomTimer == nil, !pendingWindowExpand, !detachInFlight else { return }
        detachInFlight = true
        let frame = panel.frame
        let contentFrame = morphModel.windowFinalRect.map {
            windowSurfaceContentScreenRect(panelFrame: frame, finalRect: $0)
        } ?? frame
        // `?? true`: unwired (nil) defaults to the old unconditional-exit behavior, so callers/
        // tests that never set `onWindowDetach` keep seeing the exit run.
        let spawned = onWindowDetach?(contentFrame) ?? true
        if spawned {
            exitWindowModeForDetach()
        }
        detachInFlight = false
        OrbDebug.log("requestWindowDetach: panelFrame=\(frame) contentFrame=\(contentFrame) spawned=\(spawned)")
    }

    /// Task 4: the `hide()` `.window` branch (see that method, above), with one deliberate
    /// difference (I2 fix, review — see below) — cancel the morph timer, snap
    /// `progress`/`morphVelocity` to settled, clear `externalFocus`, then `finishWindowCollapse()`
    /// — but WITHOUT `panel.orderOut`: the orb panel stays visible/on screen (a detached window
    /// has just taken the field's place instead of the panel hiding outright).
    /// `finishWindowCollapse()` already resizes the panel back down to `collapsedWindowSize`, snaps
    /// the follower to the settled orb anchor, and restores global (follow-everywhere) Space
    /// behavior — none of that touches `isVisible`/orders the panel out (verified by inspection,
    /// `finishWindowCollapse()` above).
    func exitWindowModeForDetach() {
        // Task 5: belt — `requestWindowDetach()`'s own guard already keeps this unreachable while
        // `zoomTimer != nil`, but cancel it here too so this method stays independently correct
        // (same defensive posture as `cancelMorphTimer()` right below, which the guard also
        // already covers).
        cancelZoomTimer()
        cancelMorphTimer()
        morphModel.progress = 0
        morphVelocity = 0
        // I2 fix (review): the detached window IS the new focus. `finishWindowCollapse()`'s
        // unconditional `externalFocus?.restore()` would otherwise activate the app that was
        // frontmost BEFORE the orb was ever summoned, immediately AFTER the detached window's
        // `makeKeyAndOrderFront` in this SAME synchronous call chain (`requestWindowDetach()` ran
        // `onWindowDetach?(frame)`, which just called `DetachedWindowController.show()`,
        // synchronously before this method runs) — the exact "late activation wins" hazard
        // `makePanelKeyWinningLateActivation()`'s doc already catalogs (there, a late external
        // activation stole key focus back from a re-summoned field; here it would steal frontmost
        // status from a just-born detached window instead). Nil-ing `externalFocus` here makes
        // `finishWindowCollapse()`'s `restore()` a no-op via optional chaining, so the detached
        // window keeps whatever activation it just won. `collapseWindowToOrb()` (ordinary
        // window→orb, no detach) and `hide()` are untouched — both still reach
        // `finishWindowCollapse()` with `externalFocus` still set, so they keep restoring the
        // pre-summon app exactly as before.
        externalFocus = nil
        finishWindowCollapse()
    }

    /// Gate r8 (v1 follow-collapse parity — `trackStep`'s `isCollapsing` branch for `.dashboard`/
    /// `.chat`, GlassFieldWindow.swift:1909-1925, mapped in
    /// `.superpowers/sdd/v1-largesurface-map.md` §5): each collapse tick, recompute the
    /// window-surface layout at the LIVE cursor (fenced to the screen locked in by
    /// `collapseWindowToOrb()`) instead of leaving the shell converging on the stale open anchor.
    /// `windowSurfaceLayout`'s content frame is centered on the LOCKED screen independent of
    /// `anchor` — so the content never visibly slides mid-collapse; only the orb-bubble end of the
    /// morph (`windowOrbPoint`) and the enclosing panel frame chase the cursor, which is what makes
    /// the tail of the shrink (once `morphedWindowSurfaceRect`'s travel band starts blending away
    /// from `finalRect`) read as "already following" instead of a stationary melt. Snapped every
    /// tick, not sprung — v1's own semantics here (`originPos = layout.windowFrame.origin; velocity
    /// = .zero`) — via a direct `panel.setFrame` rather than through `OrbFollower` (whose own
    /// tracking spring stays paused throughout window mode, `windowStationary` — see that
    /// property's doc for why the two mechanisms never fight over the panel frame).
    private func rideWindowCollapseToCursor() {
        guard let screen = windowCollapseLockedScreen else { return }
        let raw = glassAnchorOverrideForTesting ?? follower.rawGlassAnchor()
        let anchor = fenceAnchorForWindowCollapse(
            raw,
            orbBubbleSize: morphModel.orbBubbleSize,
            haloPadding: morphModel.haloPadding,
            visibleFrame: screen
        )
        let layout = windowSurfaceLayout(
            anchor: anchor,
            contentSize: windowCollapseContentSize,
            haloPadding: morphModel.haloPadding,
            orbBubbleSize: morphModel.orbBubbleSize,
            screenFrame: screen
        )
        morphModel.windowFinalRect = layout.finalRect
        morphModel.windowOrbPoint = layout.orbPoint
        panel.setFrame(layout.windowFrame, display: false)
        morphModel.activeWindowSize = layout.windowFrame.size
    }

    /// Gate r7 (green traffic light), Task 5 (spring-animated): toggle the window between
    /// `chatWindowDefaultSize` and a near-fullscreen content size — a dedicated `zoomTimer` (same
    /// 60Hz Timer+Task-hop pattern as `morphTimer`, see `startZoomTimer()`) springs a 0…1 scalar
    /// (`zoomProgress`, `morphStep`'s 140/22 default tuning — SAME integrator `morphTick()` uses,
    /// just a separate scalar) that `zoomTick()` uses to interpolate `contentSize` between
    /// `chatWindowDefaultSize` and `zoomedContentSize` every tick, recomputing
    /// `windowSurfaceLayout(anchor:contentSize:…)` and applying the panel frame +
    /// `morphModel.windowFinalRect`/`windowOrbPoint`/`activeWindowSize` in lockstep — the mouse
    /// gate (`updateWindowMouseGate()`) reads those three every tick regardless of which spring is
    /// driving the panel. Deliberately NOT `.animator()`/`NSAnimationContext` for the frame
    /// (verified SIGBUS class in this codebase) — manual Timer, same as the morph.
    ///
    /// `windowZoomed` flips to the NEW target immediately (same "flip now, animate toward it"
    /// contract `surface` itself uses) so a re-press mid-flight RETARGETS: `zoomTarget` flips
    /// (0↔1) while `zoomProgress`/`zoomVelocity` are left exactly where they are — the same morph
    /// retarget idiom `expandToField()`'s mid-collapse re-summon uses on `morphTarget` — so the
    /// animation reverses smoothly from wherever it currently sits instead of snapping. A COLD
    /// start (no zoom currently in flight) instead seeds `zoomProgress` at whichever fixed end the
    /// window is currently settled at (`windowZoomed ? 1 : 0`), so a fresh press always animates
    /// FROM the resting state, never from a stale scalar left over from a previous cycle.
    ///
    /// No-op while the window's own morph is in flight (`morphTimer != nil`, unchanged from gate
    /// r7) — zoom only ever starts once that has settled. `zoomedContentSize` (the near-fullscreen
    /// "1" end) is only recomputed when a press starts a FRESH zoom-IN leg (the `else` branch
    /// below) — a retarget back toward 0 while already zooming in just flips `zoomTarget`, never
    /// touching it, so the interpolation's target end stays fixed for the whole animation even
    /// though the layout itself is recomputed fresh every tick (screen/anchor could otherwise
    /// drift the target size tick-to-tick, which would fight the spring).
    func zoomToggleWindow() {
        guard surface == .window, morphTimer == nil else { return }
        if zoomTimer == nil {
            zoomProgress = windowZoomed ? 1 : 0
            zoomVelocity = 0
        }
        if windowZoomed {
            zoomTarget = 0
            windowZoomed = false
        } else {
            let anchor = currentWindowScreenAnchor()
            let screen = visibleScreenFrame(containing: anchor)
            let inset = morphModel.haloPadding + chatWindowZoomInset
            zoomedContentSize = CGSize(
                width: max(chatWindowDefaultSize.width, screen.width - 2 * inset),
                height: max(chatWindowDefaultSize.height, screen.height - 2 * inset)
            )
            zoomTarget = 1
            windowZoomed = true
        }
        startZoomTimer()
        OrbDebug.log("zoomToggleWindow: zoomed=\(windowZoomed) target=\(zoomTarget)")
    }

    private func startZoomTimer() {
        guard zoomTimer == nil else { return }
        lastZoomTick = CACurrentMediaTime()
        zoomTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.zoomTick()
            }
        }
    }

    private func cancelZoomTimer() {
        zoomTimer?.invalidate()
        zoomTimer = nil
        zoomVelocity = 0
    }

    /// Internal (not `private`), same access-level convention as `morphTick()` — kept consistent
    /// in case a future test ever needs to drive a stale tick directly the way
    /// `MorphTimerReentrancyTests` does for `morphTick()`.
    func zoomTick() {
        // Re-entry guard — same rationale as `morphTick()`'s own (see that method's doc): the
        // Timer's closure hops through `Task { @MainActor in … }` rather than running
        // synchronously, so multiple queued closures could otherwise redundantly re-run the
        // settle branch. `cancelZoomTimer()` sets `zoomTimer = nil` the first time this settles,
        // so any later/duplicate tick bails out here instead.
        guard zoomTimer != nil else { return }

        let now = CACurrentMediaTime()
        let dt = now - lastZoomTick
        lastZoomTick = now

        let (next, velocity) = morphStep(
            progress: zoomProgress,
            velocity: zoomVelocity,
            target: zoomTarget,
            dt: dt
        )
        zoomProgress = next
        zoomVelocity = velocity

        // Fix A parity (same settle epsilon `morphTick()` uses, v1's own — GlassFieldWindow.swift:
        // 1841): 0.004 progress / 0.05 velocity, not a tighter ad hoc threshold.
        let distance = abs(zoomTarget - next)
        let settled = distance < 0.004 && abs(velocity) < 0.05

        if settled {
            zoomProgress = zoomTarget
        }
        applyZoomContentSize(interpolatedZoomContentSize(progress: zoomProgress))

        if settled {
            cancelZoomTimer()
        }
    }

    /// Linear interpolation between `chatWindowDefaultSize` (0) and `zoomedContentSize` (1) — the
    /// zoom spring's own scalar drives this directly (unlike the orb↔field morph, there is no
    /// smoothstep travel-band shaping here: a window CONTENT resize reads fine as a plain linear
    /// grow, and keeping it linear keeps the interpolated size exactly `chatWindowDefaultSize` at
    /// progress 0 and exactly `zoomedContentSize` at progress 1 with no floating-point drift at
    /// either end).
    private func interpolatedZoomContentSize(progress: Double) -> CGSize {
        // Task-5 review: clamp like morphedWindowSurfaceRect does — 140/22 is barely underdamped
        // (ζ≈0.93), so the scalar can transiently tick past [0,1] before the settle epsilon
        // fires; unclamped, that overshoot fed panel.setFrame directly (a few px past the
        // intended bounds for 1-2 ticks).
        let p = max(0.0, min(1.0, progress))
        return CGSize(
            width: chatWindowDefaultSize.width
                + (zoomedContentSize.width - chatWindowDefaultSize.width) * p,
            height: chatWindowDefaultSize.height
                + (zoomedContentSize.height - chatWindowDefaultSize.height) * p
        )
    }

    /// EVERY zoom tick (Task 5 brief): recompute the window-surface layout at the CURRENT anchor
    /// for the given interpolated content size, and apply the panel frame + the three model fields
    /// the mouse gate (`updateWindowMouseGate()`) reads in lockstep — same discipline as
    /// `rideWindowCollapseToCursor()`'s per-tick `panel.setFrame` + layout-lockstep pattern.
    /// `currentWindowScreenAnchor()` is self-consistent across resizes (derived from the panel's
    /// own live frame + the `windowOrbPoint` this same method just set), so recomputing it fresh
    /// every tick — rather than locking it once at the press — still holds the anchor fixed for
    /// the whole animation without any separate "locked anchor" state to manage.
    private func applyZoomContentSize(_ content: CGSize) {
        let anchor = currentWindowScreenAnchor()
        let screen = visibleScreenFrame(containing: anchor)
        let layout = windowSurfaceLayout(
            anchor: anchor, contentSize: content,
            haloPadding: morphModel.haloPadding, orbBubbleSize: morphModel.orbBubbleSize,
            screenFrame: screen
        )
        morphModel.windowFinalRect = layout.finalRect
        morphModel.windowOrbPoint = layout.orbPoint
        // Task-5 review: `display: false` like EVERY other per-tick setFrame in this file
        // (rideWindowCollapseToCursor's precedent) — `true` forced a synchronous WindowServer
        // redisplay 60×/s; let AppKit coalesce with the run loop. The mouse gate reads
        // panel.frame directly, which updates synchronously regardless of the flag.
        panel.setFrame(layout.windowFrame, display: false)
        morphModel.activeWindowSize = layout.windowFrame.size
    }

    /// The orb end of the window shell mapped to screen coords, read off the panel's CURRENT frame
    /// (robust to a user drag — the window may have moved from where it opened).
    private func currentWindowScreenAnchor() -> CGPoint {
        let frame = panel.frame
        let orbPoint = morphModel.windowOrbPoint ?? CGPoint(x: frame.width / 2, y: frame.height / 2)
        return CGPoint(x: frame.minX + orbPoint.x, y: frame.maxY - orbPoint.y)
    }

    private func visibleScreenFrame(containing point: CGPoint) -> NSRect {
        (NSScreen.screens.first { $0.frame.contains(point) }?.visibleFrame)
            ?? NSScreen.main?.visibleFrame
            ?? NSScreen.main?.frame
            ?? .zero
    }

    // MARK: Window-surface mouse gating (gate r7 — transplant of v1 `largeSurfaceMouseGate`/
    // `largeSurfaceHitTest`, GlassFieldWindow.swift:1158-1219/1248-1290)

    private var windowMouseGateTimer: Timer?

    private func startWindowMouseGate() {
        guard windowMouseGateTimer == nil else { return }
        panel.acceptsMouseMovedEvents = true
        updateWindowMouseGate()
        windowMouseGateTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateWindowMouseGate() }
        }
    }

    private func stopWindowMouseGate() {
        windowMouseGateTimer?.invalidate()
        windowMouseGateTimer = nil
    }

    /// The panel now spans content + halo, so a click on the transparent halo margin must pass
    /// THROUGH. 60Hz: hit-test the current morphed shell rect and toggle `panel.ignoresMouseEvents`.
    private func updateWindowMouseGate() {
        guard surface == .window, isVisible,
              let finalRect = morphModel.windowFinalRect,
              let orbPoint = morphModel.windowOrbPoint else { return }
        let frame = panel.frame
        let screenPoint = NSEvent.mouseLocation
        let localPoint = CGPoint(x: screenPoint.x - frame.minX, y: frame.maxY - screenPoint.y)
        let accepts = windowSurfaceHitTest(
            point: localPoint, windowSize: frame.size,
            finalRect: finalRect, orbPoint: orbPoint,
            progress: morphModel.progress, orbBubbleSize: morphModel.orbBubbleSize
        )
        setWindowMouseAcceptance(accepts)
    }

    /// v1 parity: only mutate on a CHANGE, and synthesize a mouse-moved on each toggle so hover/
    /// tracking doesn't stick when the pointer crosses the shell↔halo boundary.
    private func setWindowMouseAcceptance(_ accepts: Bool) {
        let wasAccepting = !panel.ignoresMouseEvents
        guard wasAccepting != accepts else { return }
        if wasAccepting, !accepts { synthesizeWindowMouseMoved() }
        panel.ignoresMouseEvents = !accepts
        panel.acceptsMouseMovedEvents = true
        if !wasAccepting, accepts { synthesizeWindowMouseMoved() }
    }

    private func synthesizeWindowMouseMoved() {
        let screenPoint = NSEvent.mouseLocation
        guard panel.frame.contains(screenPoint) else { return }
        let locationInWindow = CGPoint(x: screenPoint.x - panel.frame.minX, y: screenPoint.y - panel.frame.minY)
        guard let event = NSEvent.mouseEvent(
            with: .mouseMoved, location: locationInWindow,
            modifierFlags: NSEvent.modifierFlags, timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0
        ) else { return }
        panel.sendEvent(event)
    }

    // MARK: Morph spring

    private func startMorph(target: Double) {
        morphTarget = target
        // Fix E/F seam (anim-fidelity restore, v1 parity — `isCollapsing`, GlassFieldWindow.swift:
        // 1908/1927/1933): the single place `morphTarget` actually changes, in EITHER direction —
        // mirrors it onto the follower so its own tick() can tell "collapsing" apart from
        // "(re-)expanding" (v1 computes this fresh every tick as `morphTimer != nil && morphTarget
        // == 0`; stored here instead since v2's `morphTarget` is private to this controller, not
        // reachable from `OrbFollower`). A retarget back to 1 (`expandToField()`'s mid-collapse
        // re-summon path) flows through this same call, so it flips back to `false` in exactly
        // the place v1's own computed property would — no separate reset needed on that path.
        // `finishCollapse()` resets it too, for the natural-settle completion this call doesn't
        // itself observe.
        follower.isCollapsing = (target == 0)
        guard morphTimer == nil else { return }
        lastMorphTick = CACurrentMediaTime()
        morphTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.morphTick()
            }
        }
    }

    private func cancelMorphTimer() {
        morphTimer?.invalidate()
        morphTimer = nil
        morphVelocity = 0
    }

    /// Internal (not `private`) purely so `MorphTimerReentrancyTests` can drive a stale tick
    /// directly — see the re-entry guard's doc just below for why that's needed.
    func morphTick() {
        // Re-entry guard (gate fix — Esc-interrupt live-gate finding): `startMorph()` schedules
        // this via `Timer.scheduledTimer` whose closure hops through `Task { @MainActor in
        // self?.morphTick() }` rather than running synchronously. Under main-actor contention
        // (reproduced live during the gate's repro session: rapid, overlapping summon/collapse
        // triggers backed up the main actor enough that SEVEN queued `Task` closures all ran in
        // a burst once it freed up) MULTIPLE Task closures can queue up before any of them runs.
        // Each one independently re-checks the settle condition below and — with no guard here —
        // redundantly re-ran the ENTIRE settle-and-teardown branch, including `finishCollapse()`
        // seven times over for a single collapse (confirmed via `OrbDebug` — see the gate
        // report). `cancelMorphTimer()` sets `morphTimer = nil` the FIRST time this settles, so
        // any later/duplicate tick now bails out here instead of redundantly re-running
        // teardown — cheap insurance against this class of stale-callback bug even though this
        // session's repro of the reported Esc failure itself did not reproduce through this path
        // (see the gate report's "what did and didn't reproduce" section).
        guard morphTimer != nil else { return }

        let now = CACurrentMediaTime()
        let dt = now - lastMorphTick
        lastMorphTick = now

        let (next, velocity) = morphStep(
            progress: morphModel.progress,
            velocity: morphVelocity,
            target: morphTarget,
            dt: dt
        )

        // Gate r7 (v1 early-fire parity — `morphCompletionProgressThreshold`, GlassFieldWindow.swift:
        // 822): when the field is reverse-morphing toward the orb WITH a window handoff armed
        // (`pendingWindowExpand`), present the window surface the INSTANT progress crosses ≤0.08 on
        // the way to 0 — the composer is seen morphing back to the orb, then the window grows out of
        // it (`presentWindowSurface()` starts a fresh 0→1 morph on the SAME panel). One-shot:
        // `presentWindowSurface()` consumes `pendingWindowExpand` AND cancels this morph timer, so
        // this branch can never re-fire. `surface == .field` is a belt — the latch is only ever
        // armed while `.field`.
        if surface == .field, morphTarget == 0, pendingWindowExpand, next <= 0.08 {
            morphModel.progress = next
            morphVelocity = velocity
            presentWindowSurface() // consumes the latch, cancels this morph, starts the window's 0→1
            return
        }

        // Gate r8: the window's OWN collapse (v1 follow-collapse parity) — ride the panel toward
        // the live cursor every tick this reverse-morph is in flight, see
        // `rideWindowCollapseToCursor()`'s doc.
        if surface == .window, morphTarget == 0 {
            rideWindowCollapseToCursor()
        }

        morphModel.progress = next
        morphVelocity = velocity

        let distance = abs(morphTarget - next)
        // Fix A (anim-fidelity restore): v1's own settle epsilon (GlassFieldWindow.swift:1841)
        // is 0.004/0.05, not 0.001/0.01 — the tighter v2 threshold made the spring visibly hang
        // for several extra ticks near rest (imperceptible velocity, but not yet "there" by the
        // old, stricter bar) instead of settling the instant it's perceptually done.
        guard distance < 0.004, abs(velocity) < 0.05 else { return }

        morphModel.progress = morphTarget
        cancelMorphTimer()

        if morphTarget == 0 {
            // Gate r7: the window's own collapse settles here too — route it to its own teardown.
            if surface == .window {
                finishWindowCollapse()
            } else {
                finishCollapse()
            }
        }
    }

    /// Gate r7: the window → orb teardown, run once the window's collapse morph settles at 0
    /// (`morphTick()`) or a `hide()` force-finish. v1 `settleCollapsedOrb` (GlassFieldWindow.swift:
    /// 1493-1525) parity, adapted: tear down the window monitors + mouse gate, restore GLOBAL
    /// (follow-everywhere) Space behavior, resize the panel back DOWN to `collapsedWindowSize` at
    /// the orb's CURRENT screen anchor (read off the live panel frame + `windowOrbPoint` — robust
    /// to a user drag), flip back to `.orb`/`.field` render, and RESUME the follower from the locked
    /// orb origin so it springs smoothly toward the cursor (rather than teleporting).
    ///
    /// Gate r8 (fixes the r7 conscious simplification of the same name): the window is no longer
    /// stationary DURING its collapse — `rideWindowCollapseToCursor()` (called from `morphTick()`
    /// every tick this collapse is in flight) already converged the shell's orb end on the live
    /// cursor, so `currentWindowScreenAnchor()` below reads off the RIDDEN frame — i.e. it already
    /// equals (close to) the live cursor position, not the stale locked-open anchor. The follower
    /// then only has the tiny remaining `baseOffset` gap left to close, so it reads as a seamless
    /// continuation rather than a spring-glide from wherever the window happened to open.
    private func finishWindowCollapse() {
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
        stopWindowMouseGate()
        panel.acceptsKeyInput = false
        panel.ignoresMouseEvents = true
        panel.isMovableByWindowBackground = false
        // Restore global (follow-everywhere) Space behavior — the orb follows the cursor again.
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]

        let anchor = currentWindowScreenAnchor()
        let origin = morphModel.corner.windowOrigin(
            glassAnchor: anchor, morph: morphModel,
            windowSize: morphModel.collapsedWindowSize, surface: .composer
        )
        panel.setFrame(NSRect(origin: origin, size: morphModel.collapsedWindowSize), display: false)
        morphModel.activeWindowSize = morphModel.collapsedWindowSize

        // `surface` LEAVES `.window` BEFORE the window-only layout is torn down, so the invariant
        // "`windowFinalRect` is non-nil for exactly as long as `surface == .window`" holds at every
        // observable instant. `presentWindowSurface()` already establishes it in the correct order
        // on the way in (rect first, then surface); this is the same ordering on the way out.
        //
        // The old order nilled the rect first and flipped `surface` several lines later, leaving a
        // window in which an observer could see `.window` with no layout. That is exactly what
        // `SurfaceWindowTests.testRequestWindowDetachFiresOnceWithContentFrameAndExitsToOrb` kept
        // hitting under a loaded full-suite run and never in isolation — it polls for `.window`
        // and then reads the rect. Three separate failures were written off as an environmental
        // flake before the ordering turned out to be the cause.
        surface = .orb

        morphModel.windowFinalRect = nil
        morphModel.windowOrbPoint = nil
        morphModel.renderSurface = .field
        morphModel.progress = 0
        windowZoomed = false
        windowCollapseLockedScreen = nil // gate r8: scope the ride's locked screen to one collapse span

        externalFocus?.restore()
        externalFocus = nil
        exchangeIndex = nil

        follower.isExpanded = false
        follower.isCollapsing = false
        follower.snapWindowOrigin(to: origin) // pin the spring at the locked orb origin (no publish)
        follower.windowStationary = false      // wake → springs from here toward the cursor
        OrbDebug.log("window collapse: complete")
    }

    /// The collapse-completion teardown, shared by the morph settling naturally (`morphTick()`)
    /// and `hide()`'s force-finish path. Task B: mirrors v1 `settleCollapsedOrb()`
    /// (GlassFieldWindow.swift:1493-1525) — resizes the panel back DOWN to
    /// `morphModel.collapsedWindowSize` now that nobody will see the last bit of the morph,
    /// keeping the SAME physical anchor point the field was just occupying (`currentGlassAnchor()`
    /// reads the panel's CURRENT — still big — frame) so the shrink doesn't jump.
    private func finishCollapse() {
        finishCollapseCallCountForTesting += 1
        if let keyMonitor {
            NSEvent.removeMonitor(keyMonitor)
            self.keyMonitor = nil
        }
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
        panel.acceptsKeyInput = false
        panel.ignoresMouseEvents = true

        let anchor = currentGlassAnchor()
        let origin = morphModel.corner.windowOrigin(
            glassAnchor: anchor,
            morph: morphModel,
            windowSize: morphModel.collapsedWindowSize,
            surface: .composer
        )
        panel.setFrame(NSRect(origin: origin, size: morphModel.collapsedWindowSize), display: false)
        // Gate-3 fix (F1, root cause #2): see the matching line in `expandToField()` +
        // `MorphModel.activeWindowSize`'s doc.
        morphModel.activeWindowSize = morphModel.collapsedWindowSize
        follower.isExpanded = false
        // Fix E/F: the natural-settle completion this reaches via `morphTick()` (as opposed to a
        // retarget back to 1, which `startMorph(target:)` itself already resets) — the collapse
        // that was in flight is now over, so the next expand must start fresh, not still read as
        // "collapsing" from this cycle's stale latch.
        follower.isCollapsing = false
        follower.snapWindowOrigin(to: origin)

        externalFocus?.restore()
        externalFocus = nil
        exchangeIndex = nil

        OrbDebug.log("collapseToOrb: complete")

        surface = .orb

        // Belt (gate r7): a pending field→window handoff should always have already fired at the
        // ≤0.08 crossing in `morphTick()` (0.08 > the 0.004 settle epsilon, so it can never slip
        // through to a full settle) — but if one somehow survives to here, present the window
        // surface now (from the freshly-collapsed orb frame) instead of stranding the request.
        if pendingWindowExpand {
            presentWindowSurface()
        }
    }
}

/// Finding-2 (gate 2): what the field key monitor should do with a keyDown, extracted pure so it's
/// table-tested (`EscInterruptTests`).
enum EscMonitorAction: Equatable { case passThrough, interrupt, collapse }

/// Esc (keyCode 53) while the field is open is ALWAYS the field's — interrupt a running turn
/// (whatever `escConsumed` reports, i.e. `onEsc()`), else collapse the field. Every other key, and
/// any key while the surface is the collapsed orb, passes through untouched.
///
/// Window identity is deliberately NOT an input: a local monitor only sees OUR app's events, this
/// accessory app has a single window, and a re-summon key race can leave the keyDown bound to a
/// stale/nil window — so routing on the SURFACE (not `event.window === panel`) is what makes the
/// Esc survive the race (same window-agnostic acceptance wave-9 landed for synthesized scrolls).
///
/// `escConsumed` is a closure, not a `Bool`, so `onEsc()`'s interrupt side effect fires ONLY after
/// the keyCode/surface guard passes — never on unrelated keydowns.
func escMonitorAction(
    keyCode: UInt16,
    surface: OrbWindowController.Surface,
    escConsumed: () -> Bool
) -> EscMonitorAction {
    guard keyCode == 53, surface == .field else { return .passThrough }
    return escConsumed() ? .interrupt : .collapse
}

/// 4-finger tap / hotkey routing (spec §4): while the window surface is open the tap collapses it
/// back to the orb; otherwise the existing field toggle. `windowVisible` is the belt against a stale
/// `.window` surface with no live panel — never wedge the summon path.
enum SummonToggleAction: Equatable { case toggleField, closeWindow }

func summonToggleAction(surface: OrbWindowController.Surface, windowVisible: Bool) -> SummonToggleAction {
    (surface == .window && windowVisible) ? .closeWindow : .toggleField
}

/// Gate r7 (moved from the deleted `ChatWindowController`): Esc routing for the window surface —
/// interrupt a running turn (window STAYS open so you can watch the stopped feedback), otherwise
/// collapse back to the orb. Pure for tests (`WindowEscActionTests`). Distinct from the field's
/// `escMonitorAction` only in name/semantics documentation; the window's key monitor branch uses
/// this so the two surfaces' Esc contracts stay independently testable.
enum WindowEscAction: Equatable { case interrupt, close }

func windowEscAction(keyCode: UInt16, escConsumed: () -> Bool) -> WindowEscAction? {
    guard keyCode == 53 else { return nil }
    return escConsumed() ? .interrupt : .close
}

/// Task 3 (2d-iii): what a keyDown should do to the pending-interaction cards — extracted pure so
/// it's table-tested (`CardWiringTests`), same convention as `escMonitorAction`/`windowEscAction`
/// above. `y`/`n` approve/deny the OLDEST pending interaction (`topmost`, `pendingInteractions`'s
/// own ordering — oldest-first) when it's an `.approval`; a digit 1-9 selects an option on a
/// `.question` card ONLY when that card is both single-question AND single-select — see the
/// `.question` branch below for why that's the only shape a bare digit can safely resolve.
///
/// `composerDraft` is threaded directly into this pure function — not just checked at the two call
/// sites (`OrbWindowController`'s window-mode key monitor, `DetachedWindowController`'s monitor)
/// — so the whole "typing 'yes' into the composer must never trigger a card" guard is itself
/// unit-testable without a live `NSEvent` monitor. Checked FIRST, before even looking at
/// `topmost`: cards capture a keystroke ONLY while the composer draft is empty, full stop.
///
/// T4-review fix: `textFieldFocused` is the SAME idea extended to a card's OWN text fields (the
/// always-visible per-question notes field, and the pre-existing "Other" field) — both call sites'
/// key monitor runs BEFORE the SwiftUI field editor ever sees the event (a local
/// `NSEvent.addLocalMonitorForEvents` monitor fires ahead of first-responder dispatch), so without
/// this guard a digit-leading note ("3 retries") got eaten as `.selectOption` before a single
/// character reached the field. `composerDraft.isEmpty` does NOT cover this case — the card's notes/
/// Other state is local `@State` on the card view, never written through `composerDraft` at all.
/// Defaults `false` so every pre-existing call site (and the tests above) is byte-identical; only
/// the two live monitors below pass a real value, computed from AppKit's `firstResponder`.
enum CardKeyAction: Equatable {
    /// Dispatch (Phase 7): each action carries the card's own `childSessionId` straight through —
    /// see `PendingInteraction.approval`/`.question`'s doc — so `dispatchCardKeyAction` can route
    /// the respond to the child exactly like a mouse click on the same card would.
    case approve(String, String?)
    case deny(String, String?)
    case selectOption(String, Int, String?)
}

func cardKeyAction(
    keyCode: UInt16, chars: String?, topmost: PendingInteraction?, composerDraft: String,
    textFieldFocused: Bool = false
) -> CardKeyAction? {
    guard !textFieldFocused else { return nil }
    guard composerDraft.isEmpty else { return nil }
    guard let topmost, let chars, let ch = chars.lowercased().first else { return nil }
    switch topmost {
    case .approval(let callId, _, _, _, let childSessionId, _):
        if ch == "y" { return .approve(callId, childSessionId) }
        if ch == "n" { return .deny(callId, childSessionId) }
        return nil
    case .question(let callId, let questions, let childSessionId):
        // Digit-select v1 (documented, per the task-3 brief): only a SINGLE-question, SINGLE-
        // select card is "complete by construction" the instant one option is chosen, so a digit
        // both SELECTS and SUBMITS in one press, via the same `questionAnswers` helper the card's
        // own whole-card Submit button uses (see `dispatchCardKeyAction` at the call sites).
        // multiSelect (more than one answer possible) or a multi-question ask (the daemon's
        // `QuestionBroker.respond` is first-response-wins across the WHOLE ask — resolving it from
        // a single digit would silently discard whatever the OTHER questions needed) both stay
        // mouse-only; there's no half-answered state a digit could safely leave behind.
        guard questions.count == 1, let question = questions.first, !question.multiSelect,
              let digit = ch.wholeNumberValue, (1...9).contains(digit),
              question.options.indices.contains(digit - 1) else { return nil }
        return .selectOption(callId, digit - 1, childSessionId)
    case .plan:
        return nil // approve/deny/feedback all need more than one bare keystroke — mouse only.
    }
}

/// T4-review fix: the `cardKeyAction(textFieldFocused:)` guard's live input — is `window`'s current
/// `firstResponder` an ACTIVE text-editing view a keystroke would otherwise land in?
///
/// AppKit-correct form for "is a SwiftUI `TextField` currently being edited": when one takes focus,
/// the window's `firstResponder` becomes its FIELD EDITOR, which is always an `NSTextView` (the
/// concrete class backing the `NSText` protocol) — never the `NSTextField`/SwiftUI view itself. So
/// `firstResponder is NSText` is true for exactly "some text view is editing right now" — both the
/// card's notes/Other `TextField`s (the T4 bug) AND, ordinarily, nothing else in this app.
///
/// EXCEPT: this window's own message composer (`ComposerTextView`'s `CommandTextView`, a real
/// `NSTextView` subclass, not a field-editor-backed `NSTextField`) aggressively claims and holds
/// `firstResponder` at rest — `makeNSView`/`updateNSView` (`ComposerTextView.swift:98-104,121-126`)
/// both re-claim it via `makeFirstResponder` whenever it isn't already the first responder. That
/// means `firstResponder is NSText` is ALREADY true the instant a card appears with an empty,
/// unfocused composer — the composer itself is an `NSText`. Without excluding it by concrete type,
/// this guard would suppress digit-select on the primary, already-shipped, already-tested path
/// (`CardWiringTests.testCardKeyActionDigitsSelectOption`) — a regression strictly worse than the
/// bug it fixes. `!(firstResponder is CommandTextView)` narrows the guard to "some OTHER text view
/// — i.e., a card's own field — is being edited," leaving the composer's resting/typing behavior
/// completely unchanged (still governed solely by `composerDraft.isEmpty`, as before this fix).
func isTextEditingFocused(in window: NSWindow) -> Bool {
    guard let responder = window.firstResponder else { return false }
    return responder is NSText && !(responder is CommandTextView)
}
