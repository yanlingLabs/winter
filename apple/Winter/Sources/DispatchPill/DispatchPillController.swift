import AppKit
import Combine
import CoreImage
import SwiftUI
import WinterKit

/// The pill's panel. The orb's own `KeyableNonActivatingPanel` is `private` to
/// `OrbWindowController.swift` (and the orb is not to be modified), so this is the same shape again:
/// a borderless non-activating `NSPanel` defaults `canBecomeKey`/`canBecomeMain` to true and AppKit
/// auto-promotes key-capable panels on Space changes, so both are gated on `acceptsKeyInput`.
///
/// One addition the orb did not need: a click on the pill while it is RESTING (not keyable — after a
/// click-outside compressed it) re-engages it, so the click that lands in the "Type here" field can
/// actually type. `sendEvent` runs before AppKit decides whether the click makes the panel key, so
/// flipping `acceptsKeyInput` there lets the very same click take focus.
final class DispatchPillPanel: NSPanel {
    var acceptsKeyInput = false
    /// Fired for a mouse-down that reaches the panel while it is not keyable. The location is the
    /// event's window-local point (AppKit, y-up).
    var onRestingMouseDown: ((CGPoint) -> Void)?

    override var canBecomeKey: Bool { acceptsKeyInput }
    override var canBecomeMain: Bool { acceptsKeyInput }

    override func sendEvent(_ event: NSEvent) {
        if !acceptsKeyInput, [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(event.type) {
            onRestingMouseDown?(event.locationInWindow)
        }
        super.sendEvent(event)
    }
}

/// The panel's canvas size — what `DispatchPillView` requests as its outer frame. Kept in lockstep
/// with every `panel.setFrame` (`DispatchPillController.setCanvas`): `NSHostingView` resizes its
/// window to its root view's requested frame on every layout pass (`MorphModel.activeWindowSize`'s
/// doc records the measured stack), so a root that asked for anything else would silently undo the
/// two-instant resize rule.
@MainActor
final class DispatchPillCanvasModel: ObservableObject {
    @Published var size: CGSize = .zero
}

/// The main pill's animated geometry: `size` is the spring's current value (60Hz while it runs),
/// `target` where it is heading. A separate object from the controller so that only the pill's shell
/// (`DispatchPillShell`) re-renders on a tick — not the transcript, the cards, or the composer.
@MainActor
final class DispatchPillMorphModel: ObservableObject {
    @Published var size: CGSize = .zero
    @Published var target: CGSize = .zero
}

/// The pill's own preferences (Settings → Dispatch). App-local, not the daemon's `settings.json`:
/// the pill is a Mac surface and nothing the daemon does depends on it — the same `UserDefaults`
/// posture, with the same injectable `defaults`, as `LoginItemController`/`ShortcutSettingsStore`.
///
/// ONE instance (`AppDelegate.dispatchPillSettings`) is handed to both the pill and the settings
/// page, so a change made on the page reaches the pill at once — including a pill that is put away
/// with a countdown already running (`DispatchPillController`'s `draftExpiry` sink). Read live,
/// never snapshotted: there is no restart to pick a change up.
@MainActor
final class DispatchPillSettings: ObservableObject {
    static let draftExpiryKey = "dispatchPillDraftExpiry"

    @Published private(set) var draftExpiry: DispatchPillDraftExpiry

    private let defaults: UserDefaults

    /// Reads only — constructing the store never writes a default into `defaults`.
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        draftExpiry = DispatchPillDraftExpiry(storedValue: defaults.string(forKey: Self.draftExpiryKey))
    }

    func setDraftExpiry(_ value: DispatchPillDraftExpiry) {
        guard value != draftExpiry else { return }
        let old = draftExpiry
        defaults.set(value.rawValue, forKey: Self.draftExpiryKey)
        draftExpiry = value
        NSLog("[DispatchPill] draft expiry setting: \(old.rawValue) → \(value.rawValue)")
    }
}

/// A live view onto one child session, for its pill's plume: the child's own `SessionModel`, fed by a
/// pinned harness of its own (`AppModel.makeDetachedFeed`, the detached windows' door). Closures,
/// not the `SessionFeed` itself, so a test can hand in a model with nothing behind it.
struct DispatchPillChildFeed {
    let session: SessionModel
    let start: () async -> Void
    let stop: () -> Void
}

/// Owns the dispatch pill: a bottom-anchored, screen-centred panel that replaces the orb as the
/// 4-finger tap's surface. Four looks — compact (idle), expanded (typing), full screen (transcript
/// and composer), and working (compact while a turn runs) — over the ONE dispatch session the orb
/// already follows (`AppModel.session`), through its OWN `FieldStateAdapter` (the orb's adapter has
/// its callbacks rewired by `GlassRootView` on every render, so it cannot be shared).
///
/// Above the pill float the asks waiting on the user (`ApprovalCardOverlay`) and the child sessions
/// Dispatch has spawned (`ChildSessionPillsView`).
///
/// Same seam convention as `OrbWindowController`: this controller exposes callbacks and imports no
/// `AppModel`; `AppDelegate.boot()` wires the real side effects.
///
/// GEOMETRY. The panel is resized at exactly two instants, the orb's rule: a canvas that must GROW
/// is set before the spring starts, so the shape always has room to animate into; one that must
/// SHRINK waits until the spring has settled (`dispatchPillCanvasStep`). Bottom edge and midX are the
/// anchors every resize keeps (`dispatchPillPanelFrame`). The shape itself — pill ↔ rounded rect,
/// small ↔ large — is driven by `morphStep` (the orb's morph integrator) on a 60Hz `Timer`, never by
/// `NSAnimationContext`/`.animator()` on the frame (a recorded SIGBUS class in this codebase).
///
/// VISIBILITY. Only the trigger (`handleTrigger`, i.e. `TriggerHub`: the 4-finger tap, the hotkey,
/// the menu's summon item) hides or shows the pill. A click outside compresses it to the compact
/// pill and leaves it on screen. Putting it away starts the draft countdown
/// (`DispatchPillDraftExpiry`); bringing it back cancels it.
@MainActor
final class DispatchPillController: ObservableObject {
    @Published private(set) var presentation: DispatchPillPresentation = .compact
    @Published private(set) var isVisible = false
    /// Which past turn the 2-finger swipe has pinned (index into the transcript), or nil for the
    /// composer. Only meaningful while compact/expanded.
    @Published private(set) var historyIndex: Int?
    /// `ComposerTextView`'s own measured content height — drives the typing pill's height and the
    /// full-screen composer's.
    @Published private(set) var composerContentHeight: CGFloat = 0

    let adapter: FieldStateAdapter
    let canvas = DispatchPillCanvasModel()
    let morph = DispatchPillMorphModel()

    // MARK: Wiring (AppDelegate)

    /// Send (or steer, mid-turn). Returns success — the draft clears only on success.
    var onSubmit: ((String) async -> Bool)?
    /// The stop button.
    var onInterrupt: (() -> Void)?
    /// Esc. Returns true when it was consumed as an interrupt (a turn was running).
    var onEsc: (() -> Bool)?
    var onApprovalRespond: ((String, Bool, String?, String?) async -> Bool)?  // callId, approved, optionId, childSessionId
    var onQuestionRespond: ((String, [String: String], [String: String], String?) async -> Bool)?
    var onPlanRespond: ((String, Bool, Bool, String?) async -> Bool)?
    var onElicitationRespond: ((String, Bool) async -> ElicitationSendResult)?
    var onElicitationURL: ((String) async -> String?)?
    /// A child pill was clicked — open that session in a detached window.
    var onOpenChild: ((String) -> Void)?
    /// A child pill's stop button.
    var onStopChild: ((String) -> Void)?
    /// "Open Dispatch in Winter" (the ⋯ popover, and the child row's "+n").
    var onOpenInApp: (() -> Void)?
    /// Opens a live view onto a child session, so its pill's plume can throw what THAT child uses.
    /// Nil (tests, no daemon token) leaves the child pills with a plain plume.
    var makeChildFeed: ((String) -> DispatchPillChildFeed?)? {
        didSet { reconcileChildFeeds() }
    }
    /// True while the ⋯ popover is open (`ExpandedPillAccessoryButtons` reports it): a click inside
    /// the popover's own window is not a click outside the pill.
    var auxiliaryPopoverOpen = false

    /// The session this pill is bound to, read fresh (card drafts are keyed by it).
    var currentSessionId: (() -> String?)? {
        didSet { adapter.boundSessionId = { [weak self] in self?.currentSessionId?() } }
    }

    // MARK: Test seams

    var panelFrameForTesting: CGRect { panel.frame }
    var panelIsVisibleForTesting: Bool { panel.isVisible }
    var panelAcceptsKeyForTesting: Bool { panel.acceptsKeyInput }
    var panelCanBecomeKeyForTesting: Bool { panel.canBecomeKey }
    var panelLevelForTesting: NSWindow.Level { panel.level }
    var panelCollectionBehaviorForTesting: NSWindow.CollectionBehavior { panel.collectionBehavior }
    var panelIgnoresMouseEventsForTesting: Bool { panel.ignoresMouseEvents }
    var isSpringIdleForTesting: Bool { springTimer == nil }
    var monitorCountForTesting: Int { monitors.count }
    private(set) var keyAssertionCountForTesting = 0
    /// Overrides the screen's visible frame (tests cannot pick which display they run on).
    var visibleFrameOverrideForTesting: CGRect?
    /// Overrides `NSEvent.mouseLocation` for the mouse gate.
    var mouseLocationOverrideForTesting: CGPoint?
    /// Overrides the clock the draft countdown reads (the close time, the deadline check on show).
    var nowOverrideForTesting: (() -> Date)?
    /// Replaces the TIMED options' interval (5/10/15 min) so a test can watch a real timer fire.
    /// `onClose` and `never` keep their meaning.
    var draftExpiryIntervalOverrideForTesting: TimeInterval?
    /// When the put-away pill's draft will be cleared; nil when no countdown is running.
    var draftExpiryDeadlineForTesting: Date? { draftExpiryDeadline }
    var draftExpiryTimerArmedForTesting: Bool { draftExpiryTimer != nil }
    /// What the cache holds right now, without consuming it (a restore would).
    var stashedDraftForTesting: String? { draftCache.restore() }

    // MARK: Internals

    private let session: SessionModel
    private let panel: DispatchPillPanel
    /// The pill's preferences — the instance the settings page writes (`AppDelegate`).
    let settings: DispatchPillSettings
    /// No age limit of its own: the draft countdown below owns expiry, and it runs only while the
    /// pill is put away — a stash made by a click outside, with the pill still on screen, must keep.
    private let draftCache = DraftCache(expiry: nil)
    /// The countdown to clearing a put-away pill's draft. Started by `hide()`, cancelled by `show()`.
    private var draftExpiryTimer: Timer?
    /// When the pill was put away — the countdown's origin, kept so a setting changed while the
    /// pill is away is measured from the real close, not from the change. nil while visible.
    private var closedAt: Date?
    private var draftExpiryDeadline: Date?
    /// Bumped whenever the countdown is re-armed or cancelled, so a timer callback that was
    /// already queued when that happened does nothing.
    private var draftExpiryGeneration = 0
    private let swipeRecognizer = TrackpadHorizontalSwipeRecognizer()
    private var monitors: [Any] = []
    private var externalFocus: ExternalFocusSnapshot?
    private var cancellables = Set<AnyCancellable>()
    private var lastDraft = ""
    private var accessorySize: CGSize = .zero
    private var accessoryFrame: CGRect = .zero
    private var lockedVisibleFrame: CGRect = .zero

    private var springTimer: Timer?
    private var lastSpringTick = CACurrentMediaTime()
    private var widthVelocity: Double = 0
    private var heightVelocity: Double = 0
    private var pendingShrink = false
    private var shrinkGeneration = 0

    /// How long an accessory-only shrink (a card resolved, a child finished — no spring running)
    /// waits, so SwiftUI's own removal has finished before the canvas tightens round what is left.
    /// Long enough for a child pill (or the row, or a card) to finish sinking back into the main pill
    /// (`childRowSpring`) before the canvas tightens round what is left — never clipped mid-animation.
    static let accessoryShrinkDelay: TimeInterval = 0.6
    /// The spring's settle bar, in points and points/second.
    static let settleDistance: Double = 0.5
    static let settleSpeed: Double = 4

    /// `settings` is required, never defaulted: the app hands in its ONE store
    /// (`AppDelegate.dispatchPillSettings`) and a test its own throwaway suite, so no construction
    /// can quietly read a different store than the settings page writes.
    init(session: SessionModel, settings: DispatchPillSettings) {
        self.session = session
        self.settings = settings
        self.adapter = FieldStateAdapter(session: session)
        let initialMain = CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight)
        let initialCanvas = dispatchPillCanvasSize(mainSize: initialMain, accessorySize: .zero)
        panel = DispatchPillPanel(
            contentRect: NSRect(origin: .zero, size: initialCanvas),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        // The orb's configuration, verbatim, except `ignoresMouseEvents` — the pill takes clicks
        // (the mouse gate below passes the transparent shadow margin through).
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.ignoresMouseEvents = false
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        // Dark whatever the system's appearance: the pill is a dark HUD over arbitrary desktop
        // content. Set on the PANEL (not only as SwiftUI's colour scheme) so the AppKit composer's
        // named colours (`TextPrimary`, the caret's `AccentColor`) resolve to their dark halves too.
        panel.appearance = NSAppearance(named: .darkAqua)

        morph.size = initialMain
        morph.target = initialMain
        canvas.size = initialCanvas
        lockedVisibleFrame = currentVisibleFrame()

        let hosting = NSHostingView(rootView: DispatchPillView(controller: self))
        hosting.sizingOptions = []
        panel.contentView = hosting
        panel.onRestingMouseDown = { [weak self] location in self?.handleRestingMouseDown(at: location) }

        wireAdapter()
        observeSession()
        observeSettings()
    }

    // MARK: - Visibility

    /// The 4-finger tap / hotkey / menu summon (`TriggerHub`). See `dispatchPillTriggerAction`.
    func handleTrigger() {
        switch dispatchPillTriggerAction(isVisible: isVisible, presentation: presentation) {
        case .show: show()
        case .hide: hide()
        case .collapseFullScreen: setPresentation(.compact)
        }
    }

    func toggle() { isVisible ? hide() : show() }

    /// Bring the pill up at the bottom of the screen the cursor is on, restore any stashed draft, and
    /// take the keyboard — a summon is for typing. Cancels the draft countdown first, so the next
    /// close starts a fresh one; a draft whose deadline has already passed is cleared before the
    /// restore could bring it back.
    func show() {
        guard !isVisible else { return }
        settleDraftExpiryOnShow()
        lockedVisibleFrame = currentVisibleFrame()
        restoreDraftIfEmpty()
        historyIndex = nil
        presentation = adapter.composerDraft.isEmpty ? .compact : .expanded
        snapToTarget()
        isVisible = true
        reconcileChildFeeds()
        panel.orderFrontRegardless()
        installMonitors()
        engage()
        updateMouseGate()
    }

    /// Put the pill away — the trigger's `.hide`, and nothing else calls it in the app. The draft is
    /// stashed (`DraftCache`) and comes back on the next summon unless the draft countdown
    /// (`DispatchPillDraftExpiry`), which starts here, clears it first.
    func hide() {
        guard isVisible else { return }
        stashDraft()
        historyIndex = nil
        auxiliaryPopoverOpen = false
        presentation = .compact
        removeMonitors()
        isVisible = false
        reconcileChildFeeds()
        snapToTarget()
        panel.orderOut(nil)
        rest(restoreFocus: true)
        startDraftExpiry()
    }

    // MARK: - Draft expiry (the put-away pill's countdown)

    private var now: Date { nowOverrideForTesting?() ?? Date() }

    /// The interval the countdown uses for `expiry` (the timed options can be shortened by a test).
    private func draftExpiryInterval(_ expiry: DispatchPillDraftExpiry) -> TimeInterval? {
        guard let interval = expiry.interval else { return nil }
        guard interval > 0, let override = draftExpiryIntervalOverrideForTesting else { return interval }
        return override
    }

    /// The close: start the countdown under the setting as it is NOW (read live, never a snapshot).
    private func startDraftExpiry() {
        closedAt = now
        armDraftExpiry(settings.draftExpiry)
    }

    /// (Re)arm the countdown from the recorded close. Used at the close and again when the setting
    /// changes while the pill is away, so the new value is measured from the close, not the change:
    /// a deadline already behind us clears now, `never` stops the countdown (the close stays
    /// recorded, so changing back re-arms it from the original close).
    private func armDraftExpiry(_ expiry: DispatchPillDraftExpiry) {
        cancelDraftExpiryTimer()
        guard let closedAt else { return }
        guard let deadline = dispatchPillDraftExpiryDeadline(closedAt: closedAt,
                                                            interval: draftExpiryInterval(expiry)) else {
            return
        }
        let remaining = deadline.timeIntervalSince(now)
        guard remaining > 0 else {
            expireDraft(under: expiry)
            return
        }
        draftExpiryDeadline = deadline
        let generation = draftExpiryGeneration
        // `.common` modes, so an open menu or a drag elsewhere in the app cannot hold it back.
        let timer = Timer(timeInterval: remaining, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.draftExpiryTimerFired(generation: generation, expiry: expiry) }
        }
        RunLoop.main.add(timer, forMode: .common)
        draftExpiryTimer = timer
    }

    private func draftExpiryTimerFired(generation: Int, expiry: DispatchPillDraftExpiry) {
        // A reopen or a re-arm since this timer was set makes it stale; and a visible pill's draft
        // is never cleared by the countdown, whatever got queued.
        guard generation == draftExpiryGeneration, !isVisible, closedAt != nil else { return }
        expireDraft(under: expiry)
    }

    /// Stop the timer and forget the deadline. The recorded close is the caller's to keep or drop.
    private func cancelDraftExpiryTimer() {
        draftExpiryGeneration += 1
        draftExpiryTimer?.invalidate()
        draftExpiryTimer = nil
        draftExpiryDeadline = nil
    }

    /// The countdown ran out (or `onClose`): the put-away draft is gone. The draft lives only in
    /// the cache while the pill is away (`hide()` stashed it and emptied the composer).
    private func expireDraft(under expiry: DispatchPillDraftExpiry) {
        cancelDraftExpiryTimer()
        closedAt = nil
        let hadDraft = draftCache.restore() != nil
        draftCache.clear()
        // The option only — never the text.
        if hadDraft { NSLog("[DispatchPill] put-away draft cleared (draft expiry: \(expiry.rawValue))") }
    }

    /// The reopen. A `Timer` is not promised to fire on time across a sleep, so the wall clock is
    /// checked here too: a deadline that passed while the timer was held back still clears the
    /// draft, before the restore could bring it back. Then the countdown is cancelled — the next
    /// close starts a fresh, full one.
    private func settleDraftExpiryOnShow() {
        if let deadline = draftExpiryDeadline, now >= deadline {
            expireDraft(under: settings.draftExpiry)
        }
        cancelDraftExpiryTimer()
        closedAt = nil
    }

    // MARK: - Presentation

    /// ↗ — the transcript and composer, full screen.
    func requestFullScreen() {
        guard isVisible else { return }
        historyIndex = nil
        setPresentation(.fullScreen)
        engage()
    }

    /// The full-screen surface's close button (and Esc there).
    func closeFullScreen() {
        guard presentation == .fullScreen else { return }
        setPresentation(dispatchPillPresentationLeavingFullScreen(draft: adapter.composerDraft))
    }

    private func setPresentation(_ next: DispatchPillPresentation) {
        guard next != presentation else { return }
        presentation = next
        retargetMain()
    }

    /// Click outside the pill (any app, any other window): compress to the compact pill, never hide,
    /// and keep the draft (`DraftCache`; a click back on the pill restores it). The keyboard goes
    /// wherever the click went.
    func handleClickOutside() {
        guard isVisible else { return }
        let wasPreviewing = historyIndex != nil
        historyIndex = nil
        stashDraft()
        if presentation != .compact {
            setPresentation(.compact)
        } else if wasPreviewing {
            retargetMain()
        }
        rest(restoreFocus: false)
    }

    // MARK: - Composer

    /// Enter / the send circle.
    func submit(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard adapter.beginComposerSubmit() else { return }
        let stayFullScreen = presentation == .fullScreen
        Task { @MainActor [weak self] in
            guard let self else { return }
            let ok = await self.onSubmit?(text) ?? false
            self.adapter.endComposerSubmit()
            guard ok else { return } // failure: the draft stays — never lost
            self.adapter.composerSendSucceeded(sentDraft: text)
            self.draftCache.clear()
            self.historyIndex = nil
            if !stayFullScreen, self.adapter.composerDraft.isEmpty {
                self.setPresentation(.compact)
            } else {
                self.retargetMain()
            }
        }
    }

    /// The stop button.
    func interrupt() { onInterrupt?() }

    /// "Clear Draft" (⋯).
    func clearDraft() {
        adapter.composerDraft = ""
        draftCache.clear()
    }

    /// `ComposerTextView.onContentHeightChange`.
    func composerContentHeightChanged(_ height: CGFloat) {
        guard abs(height - composerContentHeight) > 0.5 else { return }
        composerContentHeight = height
        if presentation == .expanded { retargetMain() }
    }

    /// The running tool's name, nil while thinking.
    var runningToolName: String? { workingToolName(session.state.status) }

    /// What the working plume throws: the running turn's tool uses so far (`plumeThrows(for:)`).
    var plumeThrows: [PlumeThrow] { Winter.plumeThrows(for: session.state.exchanges.last) }

    /// The current tool round's throws, which the plume streams again while the round runs
    /// (`plumeRepeatingThrows(for:)`).
    var plumeRepeatingThrows: [PlumeThrow] { Winter.plumeRepeatingThrows(for: session.state.exchanges.last) }

    /// The swiped-to turn's preview, or nil at the composer.
    var turnPreview: DispatchPillTurnPreview? {
        historyIndex.flatMap { dispatchPillTurnPreview(exchanges: session.state.exchanges, index: $0) }
    }

    /// The text field's height inside the bar for the current target.
    var composerFieldHeight: CGFloat {
        // While a turn is pinned the composer is hidden under it, at the height it would have.
        let composer = previewHeight == nil ? morph.target.height
            : dispatchPillMainSize(presentation: .expanded, composerContentHeight: composerContentHeight,
                                   visibleFrame: lockedVisibleFrame).height
        return max(1, composer - DispatchPillMetrics.composerVerticalPadding)
    }

    /// The pinned turn's height, or nil when no turn is pinned (the composer shows).
    private var previewHeight: CGFloat? {
        guard presentation == .expanded, let preview = turnPreview else { return nil }
        return dispatchPillPreviewHeight(reply: preview.reply)
    }

    /// A click on a pinned turn (and Esc there): back to the composer, keyboard included.
    func exitPreview() {
        guard historyIndex != nil else { return }
        historyIndex = nil
        retargetMain()
        engage()
    }

    /// The text field's width for the current TARGET — fixed while the spring runs, so the text
    /// never re-wraps (and so never re-measures its height) mid-animation.
    var composerFieldWidth: CGFloat { DispatchPillMetrics.fieldWidth(pillWidth: morph.target.width) }

    /// A click on the working pill's plume: open the typing pill (stop stays on the circle, Enter
    /// steers) and take the keyboard.
    func openComposer() {
        guard isVisible, presentation == .compact else { return }
        restoreDraftIfEmpty()
        historyIndex = nil
        setPresentation(.expanded)
        engage()
    }

    /// A turn just ended: pin its reply and open the pill to show it, when `dispatchPillRevealsReply`
    /// says so. Leaving it is the ordinary way out of a pinned turn — type, swipe, Esc, click away.
    private func revealReplyIfDue() {
        let exchanges = session.state.exchanges
        guard dispatchPillRevealsReply(isVisible: isVisible, presentation: presentation,
                                       previewing: historyIndex != nil, draft: adapter.composerDraft,
                                       latest: exchanges.last) else { return }
        historyIndex = exchanges.count - 1
        if presentation == .compact {
            setPresentation(.expanded)
        } else {
            retargetMain()
        }
    }

    // MARK: - Swipe (2-finger) through turns

    /// One accepted 2-finger swipe. Right = older, left = newer (the field's page-flip convention,
    /// `exchangeNavDirection`). Older from the composer pins the newest turn; newer from the newest
    /// turn returns to the composer. Compact grows to expanded to show the preview, and stays there.
    @discardableResult
    func handleSwipe(_ direction: TrackpadHorizontalSwipeDirection) -> Bool {
        guard isVisible, presentation != .fullScreen else { return false }
        let count = session.state.exchanges.count
        let next = navigateExchange(historyIndex, direction: exchangeNavDirection(for: direction), count: count)
        guard next != historyIndex else { return false }
        historyIndex = next
        if presentation == .compact {
            setPresentation(.expanded)
        } else {
            retargetMain()
        }
        return true
    }

    // MARK: - Esc

    /// Esc for this panel — see `dispatchPillEscAction`. Returns whether the key was consumed.
    @discardableResult
    func handleEscape() -> Bool {
        guard isVisible else { return false }
        let action = dispatchPillEscAction(presentation: presentation, previewing: historyIndex != nil,
                                           escConsumed: { self.onEsc?() == true })
        switch action {
        case .interrupt:
            break
        case .exitFullScreen:
            closeFullScreen()
        case .exitPreview:
            historyIndex = nil
            retargetMain()
        case .compress:
            stashDraft()
            setPresentation(.compact)
        case .rest:
            rest(restoreFocus: true)
        }
        return true
    }

    // MARK: - Layout reports from the view

    /// The floating layers' (cards + child pills) frame in canvas coordinates, or `.zero` when
    /// nothing floats. Its SIZE drives the canvas; its frame drives the mouse gate.
    func accessoryLayoutChanged(frame: CGRect) {
        accessoryFrame = frame
        let size = frame.size
        guard size != accessorySize else { return }
        accessorySize = size
        reconcileCanvas()
        updateMouseGate()
    }

    // MARK: - Focus

    /// Make the panel keyable and key — the summon, ↗, and a click on the resting pill. The app that
    /// had the keyboard is remembered so Esc can hand it back.
    func engage() {
        guard isVisible else { return }
        if externalFocus == nil { externalFocus = ExternalFocusSnapshot.captureCurrent() }
        panel.acceptsKeyInput = true
        makePanelKeyWinningLateActivation()
    }

    /// The orb's Finding-2 fix, same shape: assert key now and re-assert on the next runloop
    /// tick(s), so a late external activation that lands just after the summon cannot steal the
    /// keyboard back. Bounded, and each retry bails once the panel is key or no longer engaged.
    private func makePanelKeyWinningLateActivation(retriesLeft: Int = 3) {
        keyAssertionCountForTesting += 1
        panel.orderFrontRegardless()
        panel.makeKey()
        guard !panel.isKeyWindow, retriesLeft > 0 else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isVisible, self.panel.acceptsKeyInput, !self.panel.isKeyWindow else { return }
            self.makePanelKeyWinningLateActivation(retriesLeft: retriesLeft - 1)
        }
    }

    /// Stop taking the keyboard. `restoreFocus` hands it back to the app that had it before the
    /// summon (Esc, hide); a click-outside does not — the click already chose where focus goes.
    private func rest(restoreFocus: Bool) {
        panel.acceptsKeyInput = false
        if restoreFocus { externalFocus?.restore() }
        externalFocus = nil
    }

    private func handleRestingMouseDown(at windowPoint: CGPoint) {
        guard isVisible else { return }
        let local = CGPoint(x: windowPoint.x, y: panel.frame.height - windowPoint.y)
        if dispatchPillMainRect(canvasSize: canvas.size, mainSize: morph.size).contains(local) {
            restoreDraftIfEmpty()
            if !adapter.composerDraft.isEmpty, presentation == .compact { setPresentation(.expanded) }
        }
        engage()
    }

    // MARK: - Draft

    /// Move the draft from the composer into the `DraftCache`. An EMPTY composer leaves the cache
    /// alone: `DraftCache.stash("")` clears it, so a hide that follows a click-outside (which already
    /// stashed and emptied the composer) would otherwise throw the stashed draft away.
    private func stashDraft() {
        guard !adapter.composerDraft.isEmpty else { return }
        draftCache.stash(adapter.composerDraft)
        adapter.composerDraft = ""
    }

    /// Bring a stashed draft back into an empty composer. The cache is cleared once the draft is back
    /// where it lives, so text the user deletes afterwards can never be resurrected by a later restore.
    private func restoreDraftIfEmpty() {
        guard adapter.composerDraft.isEmpty, let restored = draftCache.restore(), !restored.isEmpty else { return }
        draftCache.clear()
        // Not a typing change: `lastDraft` moves first so the auto-expand observer does not treat the
        // restore as typing (the caller decides the presentation).
        lastDraft = restored
        adapter.composerDraft = restored
    }

    // MARK: - Geometry

    private func currentVisibleFrame() -> CGRect {
        if let visibleFrameOverrideForTesting { return visibleFrameOverrideForTesting }
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main ?? NSScreen.screens.first
        return screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    }

    private func mainTarget() -> CGSize {
        dispatchPillMainSize(presentation: presentation,
                             composerContentHeight: composerContentHeight,
                             previewHeight: previewHeight,
                             visibleFrame: lockedVisibleFrame)
    }

    private func canvasTarget() -> CGSize {
        dispatchPillCanvasSize(mainSize: morph.target,
                               accessorySize: presentation == .fullScreen ? .zero : accessorySize)
    }

    /// Retarget the spring at the current presentation's size. Grow-first: the canvas is reconciled
    /// BEFORE the spring starts (the timer's first tick is a frame away at the earliest).
    private func retargetMain() {
        let target = mainTarget()
        if target != morph.target {
            morph.target = target
            reconcileCanvas()
            if isVisible { startSpring() } else { snapToTarget() }
        } else {
            reconcileCanvas()
        }
        updateMouseGate()
    }

    /// Everything at its target, no animation — appearance, disappearance.
    private func snapToTarget() {
        cancelSpring()
        let target = mainTarget()
        morph.target = target
        morph.size = target
        pendingShrink = false
        applyComposerBlur()
        setCanvas(canvasTarget())
    }

    private func reconcileCanvas() {
        let target = canvasTarget()
        switch dispatchPillCanvasStep(current: canvas.size, target: target) {
        case .none:
            pendingShrink = false
        case .growNow(let size):
            setCanvas(size)
            // `setCanvas` can RE-ENTER this method (see its doc): the layout it triggers may report
            // new floating layers before it returns. So what is left to do is judged against the
            // target as it is NOW, never the `target` captured above — a stale "nothing left" here
            // once overwrote the re-entrant call's pending shrink and stranded the panel grown.
            // Bounded: every further step is either a grow (monotonic) or a deferred shrink.
            if canvasTarget() == canvas.size {
                pendingShrink = false
            } else {
                reconcileCanvas()
            }
        case .shrinkLater:
            pendingShrink = true
            scheduleDeferredShrink()
        }
    }

    /// The shrink half of the two-instant rule. While the spring runs, its settle performs the
    /// shrink (`springSettled`); this covers the accessory-only case where no spring runs.
    private func scheduleDeferredShrink() {
        shrinkGeneration += 1
        let generation = shrinkGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.accessoryShrinkDelay) { [weak self] in
            guard let self, generation == self.shrinkGeneration, self.springTimer == nil else { return }
            self.applyPendingShrink()
        }
    }

    private func applyPendingShrink() {
        guard pendingShrink else { return }
        pendingShrink = false
        let target = canvasTarget()
        if target != canvas.size { setCanvas(target) }
        updateMouseGate()
    }

    /// The one place the panel frame changes — the canvas model moves with it, in the same pass.
    ///
    /// The model moves FIRST. `NSHostingView` lays out synchronously inside `setFrame`, and that
    /// layout can call straight back in (`accessoryLayoutChanged` → `reconcileCanvas`); a re-entrant
    /// reconcile that read the OLD canvas size would compare the target against a frame that is
    /// already gone — measured: it answered `.none`, cleared the pending shrink, and the panel stayed
    /// at its grown size for good.
    private func setCanvas(_ size: CGSize) {
        canvas.size = size
        let frame = dispatchPillPanelFrame(canvasSize: size, visibleFrame: lockedVisibleFrame)
        panel.setFrame(frame, display: false)
    }

    // MARK: - Blur while the shape changes (the AppKit composer's half)

    /// The pill's `ComposerTextView`. SwiftUI's `.blur` on the shell blurs everything SwiftUI draws
    /// (`DispatchPillShell`); this NSView is AppKit's, so its blur is set here, as a Core Image
    /// content filter, on every spring tick — the same radius (`dispatchPillMorphBlur`), so text and
    /// icons soften and sharpen together.
    private weak var composerView: NSScrollView?
    private var appliedComposerBlur: CGFloat = 0

    func registerComposerView(_ view: NSScrollView) {
        composerView = view
        view.wantsLayer = true
        view.layerUsesCoreImageFilters = true
        appliedComposerBlur = -1
        applyComposerBlur()
    }

    private func applyComposerBlur() {
        guard let composerView else { return }
        let radius = dispatchPillMorphBlur(size: morph.size, target: morph.target)
        guard radius != appliedComposerBlur else { return }
        appliedComposerBlur = radius
        if radius > 0, let blur = CIFilter(name: "CIGaussianBlur") {
            blur.setValue(radius, forKey: kCIInputRadiusKey)
            composerView.contentFilters = [blur]
        } else {
            composerView.contentFilters = []
        }
    }

    var composerBlurRadiusForTesting: CGFloat { max(0, appliedComposerBlur) }
    var composerTextViewForTesting: NSTextView? { composerView?.documentView as? NSTextView }
    /// The floating layers' (cards + child row) last reported frame, canvas coordinates.
    var accessoryFrameForTesting: CGRect { accessoryFrame }

    // MARK: - Spring (the orb's `morphStep`, on width and height)

    private func startSpring() {
        guard springTimer == nil else { return }
        lastSpringTick = CACurrentMediaTime()
        springTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.springTick() }
        }
    }

    private func cancelSpring() {
        springTimer?.invalidate()
        springTimer = nil
        widthVelocity = 0
        heightVelocity = 0
    }

    /// Internal (not private) so a test can drive a stale tick, like `OrbWindowController.morphTick()`.
    func springTick() {
        // Re-entry guard — the orb's: queued Task hops can outlive the timer.
        guard springTimer != nil else { return }
        let now = CACurrentMediaTime()
        let dt = now - lastSpringTick
        lastSpringTick = now
        let target = morph.target
        let w = morphStep(progress: Double(morph.size.width), velocity: widthVelocity,
                          target: Double(target.width), dt: dt)
        let h = morphStep(progress: Double(morph.size.height), velocity: heightVelocity,
                          target: Double(target.height), dt: dt)
        widthVelocity = w.velocity
        heightVelocity = h.velocity
        let settled = abs(Double(target.width) - w.progress) < Self.settleDistance
            && abs(w.velocity) < Self.settleSpeed
            && abs(Double(target.height) - h.progress) < Self.settleDistance
            && abs(h.velocity) < Self.settleSpeed
        if settled {
            morph.size = target
            cancelSpring()
            applyPendingShrink()
        } else {
            morph.size = CGSize(width: max(1, w.progress), height: max(1, h.progress))
        }
        applyComposerBlur()
        updateMouseGate()
    }

    // MARK: - Mouse gate

    /// Take clicks only over what is drawn (the pill, the floating layers); the transparent shadow
    /// margin passes them through to whatever is underneath. Event-driven (mouse-moved monitors),
    /// re-run after every resize and spring tick.
    func updateMouseGate() {
        guard isVisible else { return }
        let point = mouseLocationOverrideForTesting ?? NSEvent.mouseLocation
        let frame = panel.frame
        let local = CGPoint(x: point.x - frame.minX, y: frame.maxY - point.y)
        let accepts = dispatchPillHitTest(point: local, canvasSize: canvas.size, mainSize: morph.size,
                                          accessoryFrame: presentation == .fullScreen ? .zero : accessoryFrame)
        if panel.ignoresMouseEvents == accepts { panel.ignoresMouseEvents = !accepts }
    }

    // MARK: - Event monitors (installed while visible, removed on hide)

    private func installMonitors() {
        guard monitors.isEmpty else { return }
        swipeRecognizer.reset()

        // Esc. A LOCAL monitor sees only this app's events; it acts only on keys bound for this panel.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            guard let self, self.isVisible, event.keyCode == 53,
                  event.window === self.panel || (event.window == nil && self.panel.isKeyWindow) else { return event }
            return self.handleEscape() ? nil : event
        }) { monitors.append(m) }

        // The 2-finger swipe through turns (compact/expanded only — full screen scrolls natively).
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel], handler: { [weak self] event in
            guard let self, self.isVisible, self.presentation != .fullScreen else { return event }
            let directed = event.window === self.panel
                || (event.window == nil && self.panel.frame.contains(NSEvent.mouseLocation))
            guard directed else { return event }
            let result = self.swipeRecognizer.handle(event)
            result.performAcceptedFeedback { self.handleSwipe($0) }
            return result.consumesScroll ? nil : event
        }) { monitors.append(m) }

        // Click outside — another app (global: mouse events need no Accessibility permission)…
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown],
                                                     handler: { [weak self] _ in
            Task { @MainActor in self?.handleClickOutside() }
        }) { monitors.append(m) }

        // …or another of Winter's own windows, or the panel's transparent margin.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown],
                                                    handler: { [weak self] event in
            guard let self, self.isVisible else { return event }
            if let window = event.window, window !== self.panel {
                // The ⋯ popover's (or a menu's) own window is part of the pill's interaction, not
                // "outside": compressing on its mouse-down would remove the very button whose
                // action fires on mouse-up. Judged three ways, since AppKit does not promise the
                // popover's window is parented to the panel.
                if self.auxiliaryPopoverOpen || window.parent === self.panel
                    || (self.panel.childWindows ?? []).contains(where: { $0 === window })
                    || String(describing: type(of: window)).contains("Menu") {
                    return event
                }
                self.handleClickOutside()
            } else if event.window === self.panel {
                let local = CGPoint(x: event.locationInWindow.x,
                                    y: self.panel.frame.height - event.locationInWindow.y)
                if !dispatchPillHitTest(point: local, canvasSize: self.canvas.size, mainSize: self.morph.size,
                                        accessoryFrame: self.presentation == .fullScreen ? .zero : self.accessoryFrame) {
                    self.handleClickOutside()
                }
            }
            return event
        }) { monitors.append(m) }

        // The mouse gate's inputs.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] _ in
            Task { @MainActor in self?.updateMouseGate() }
        }) { monitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] event in
            self?.updateMouseGate()
            return event
        }) { monitors.append(m) }
        panel.acceptsMouseMovedEvents = true
    }

    private func removeMonitors() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors.removeAll()
    }

    // MARK: - Adapter wiring (once — this adapter is the pill's alone)

    private func wireAdapter() {
        adapter.onSubmit = { [weak self] text in self?.submit(text) }
        adapter.onClearMessage = { [weak self] in self?.clearDraft() }
        adapter.onInterrupt = { [weak self] in self?.interrupt() }
        adapter.onOpenChild = { [weak self] sessionId in self?.onOpenChild?(sessionId) }
        // The respond callbacks — `GlassRootView.wireCallbacks()`'s discipline: in-flight on and the
        // stale error cleared SYNCHRONOUSLY, in-flight off once the RPC settles, an error line only on
        // failure (a success needs nothing: the resolved event retires the card).
        adapter.onApprovalRespond = { [weak self] callId, approved, optionId, childSessionId in
            guard let self else { return }
            self.adapter.interactionInFlight.insert(callId)
            self.adapter.interactionErrors[callId] = nil
            Task { @MainActor in
                let ok = await self.onApprovalRespond?(callId, approved, optionId, childSessionId) ?? false
                self.adapter.interactionInFlight.remove(callId)
                if !ok { self.adapter.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onQuestionRespond = { [weak self] callId, answers, notes, childSessionId in
            guard let self else { return }
            self.adapter.interactionInFlight.insert(callId)
            self.adapter.interactionErrors[callId] = nil
            Task { @MainActor in
                let ok = await self.onQuestionRespond?(callId, answers, notes, childSessionId) ?? false
                self.adapter.interactionInFlight.remove(callId)
                if !ok { self.adapter.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onPlanRespond = { [weak self] callId, approved, autoAccept, feedback in
            guard let self else { return }
            self.adapter.interactionInFlight.insert(callId)
            self.adapter.interactionErrors[callId] = nil
            Task { @MainActor in
                let ok = await self.onPlanRespond?(callId, approved, autoAccept, feedback) ?? false
                self.adapter.interactionInFlight.remove(callId)
                if !ok { self.adapter.interactionErrors[callId] = "couldn't send — try again" }
            }
        }
        adapter.onElicitationRespond = { [weak self] elicitationId, accept, host, expiresAt in
            guard let self else { return }
            self.adapter.answerElicitation(elicitationId, accept: accept, host: host, expiresAt: expiresAt, fetchURL: {
                await self.onElicitationURL?(elicitationId) ?? nil
            }, send: { accept in
                await self.onElicitationRespond?(elicitationId, accept) ?? .failed
            })
        }
    }

    // MARK: - Child plumes

    /// The most child sessions watched at once — the widest row's worth.
    static let maxChildFeeds = 8
    /// The live child sessions the child pills draw their plumes from, by session id.
    @Published private(set) var childSessions: [String: SessionModel] = [:]
    private var childFeeds: [String: (feed: DispatchPillChildFeed, task: Task<Void, Never>)] = [:]

    /// The child session behind a child pill, while it is being watched.
    func childSession(_ sessionId: String) -> SessionModel? { childSessions[sessionId] }

    /// Watch exactly the children that are still working (or waiting on the user) while the pill is on
    /// screen; let go of every other — a finished child, a stopped one, or all of them once the pill
    /// is put away — so no harness lingers.
    func reconcileChildFeeds() {
        let wanted: [String] = isVisible
            ? session.state.children
                .filter { ChildPillStatus(wireStatus: $0.status).isStoppable }
                .prefix(Self.maxChildFeeds)
                .map(\.sessionId)
            : []
        for id in Array(childFeeds.keys) where !wanted.contains(id) {
            childFeeds[id]?.feed.stop()
            childFeeds[id]?.task.cancel()
            childFeeds[id] = nil
            childSessions[id] = nil
        }
        guard let makeChildFeed else { return }
        for id in wanted where childFeeds[id] == nil {
            guard let feed = makeChildFeed(id) else { continue }
            childFeeds[id] = (feed, Task { await feed.start() })
            childSessions[id] = feed.session
        }
    }

    var watchedChildIdsForTesting: Set<String> { Set(childFeeds.keys) }

    private func observeSession() {
        // A child starting, finishing or being stopped changes which child sessions are watched.
        // `$state` publishes on willSet — the hop reads the new roster.
        session.$state
            .map(\.children)
            .removeDuplicates()
            .sink { [weak self] _ in DispatchQueue.main.async { self?.reconcileChildFeeds() } }
            .store(in: &cancellables)

        // Typing auto-expands (and leaves a swiped-to turn). `$composerDraft` publishes on willSet,
        // so the NEW value is the sink's argument and `lastDraft` is the old one.
        adapter.$composerDraft
            .sink { [weak self] new in
                guard let self else { return }
                let old = self.lastDraft
                self.lastDraft = new
                guard old != new else { return }
                // ONE HOP LATER, never here: this sink runs in the draft's willSet, and growing the
                // pill resizes the panel, whose hosting view lays out SYNCHRONOUSLY — handing the
                // composer the draft as it was BEFORE this keystroke. `ComposerTextView` then
                // "corrects" the text view back to it, and the first key typed into the compact pill
                // was lost (the user's report; `testTheFirstKeyTypedIntoTheCompactPillIsKept`).
                // By the hop the new draft is stored, so the same layout agrees with the text view.
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.adapter.composerDraft == new else { return }
                    if self.historyIndex != nil, !new.isEmpty {
                        self.historyIndex = nil
                        self.retargetMain()
                    }
                    let next = dispatchPillPresentationAfterDraftChange(self.presentation, old: old, new: new)
                    if next != self.presentation { self.setPresentation(next) }
                }
            }
            .store(in: &cancellables)

        // A refocus/reset shrinks the transcript under a pinned turn — never point past its end.
        session.$state
            .map(\.exchanges.count)
            .removeDuplicates()
            .sink { [weak self] count in
                guard let self, let index = self.historyIndex, index >= count else { return }
                self.historyIndex = nil
                self.retargetMain()
            }
            .store(in: &cancellables)

        // A reply opens the pill: on the turn's END (running → not), when the reply is complete.
        // `$state` publishes on willSet, so the sink reads the new value off its argument — and
        // defers the reveal one hop, so `session.state` (which the reveal reads) is the new one too.
        session.$state
            .map(\.turnRunning)
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] running in
                guard !running else { return }
                DispatchQueue.main.async { self?.revealReplyIfDue() }
            }
            .store(in: &cancellables)
    }

    /// A draft-expiry change made while the pill is put away applies to the countdown already
    /// running, measured from the close (`armDraftExpiry`). `$draftExpiry` publishes on willSet, so
    /// the NEW value is the sink's argument — never re-read the property here.
    private func observeSettings() {
        settings.$draftExpiry
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] expiry in
                guard let self, !self.isVisible, self.closedAt != nil else { return }
                self.armDraftExpiry(expiry)
            }
            .store(in: &cancellables)
    }

    // MARK: - Test-only drivers

    /// Set the presentation without a live panel (offscreen renders, state tests).
    func setPresentationForTesting(_ next: DispatchPillPresentation, historyIndex: Int? = nil) {
        self.historyIndex = historyIndex
        presentation = next
        snapToTarget()
    }

    /// Feed a composer height as the text view would, then settle.
    func setComposerContentHeightForTesting(_ height: CGFloat) {
        composerContentHeight = height
        snapToTarget()
    }

    func setVisibleForTesting(_ visible: Bool) { isVisible = visible }

    /// Hold the spring mid-flight at `size` (offscreen renders of a change of shape).
    func setAnimatedSizeForTesting(_ size: CGSize) {
        morph.size = size
        applyComposerBlur()
    }
}

/// PURE: does a canvas-local point (y-down) land on something the pill draws?
func dispatchPillHitTest(point: CGPoint, canvasSize: CGSize, mainSize: CGSize, accessoryFrame: CGRect) -> Bool {
    if dispatchPillMainRect(canvasSize: canvasSize, mainSize: mainSize).contains(point) { return true }
    return accessoryFrame.width > 0 && accessoryFrame.height > 0 && accessoryFrame.contains(point)
}
