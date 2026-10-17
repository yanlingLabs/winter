import AppKit
import ApplicationServices
import Combine
import SwiftUI
import WinterCUPresentation
import WinterKit

/// What the app tells the island about its own focus (wired by `AppDelegate`).
struct IslandFocusSources {
    /// The Dispatch pill is on screen.
    var dispatchPillVisible: () -> Bool = { false }
    /// The Dispatch coordinator session ids this app knows.
    var dispatchSessionIds: () -> Set<String> = { [] }
    /// The sessions shown by a Winter window that is key or main (the app window's, a detached window's).
    var keyOrMainWindowSessionIds: () -> Set<String> = { [] }
}

/// The Winter island on screen (`docs/claude/island.md`): the slim strip extending the housing (always there, static),
/// the cards born from it on top (the store's queue), and the open island (a click on the strip; a click outside or
/// Esc closes it; a two-finger swipe over it changes tabs).
///
/// IDLE: the strip is a static view; no timer, no display link, no monitor runs. Pointer monitors exist only while a
/// card or the open island is on screen (compacted cards draw nothing but the strip's count); display-rate frames only
/// while a shape moves (a card's birth, the island's open/close morph); the queue's self-compaction is ONE one-shot
/// wake-up while a card is expanded.
///
/// SCREEN: the island lives on the screen with a camera housing, else the main screen (`IslandLayout.islandScreen`),
/// re-read when the displays change.
@MainActor
final class IslandController {
    let store: IslandStore
    var focusSources = IslandFocusSources()
    /// The phase-2 tabs' models (Sessions, Shelf, Usage and limits, Devices).
    let tabModels: IslandTabModels

    private let stripPanel = IslandPanel(level: .statusBar)
    private let topPanel = IslandPanel(level: .statusBar)
    private let islandPanel = IslandPanel(level: .statusBar)
    private var shape = IslandScreenShape(housing: nil, menuBarHeight: 24)
    private(set) var screenFrame = CGRect(x: 0, y: 0, width: 1440, height: 900)
    /// The island screen's top (phase 2's activity slot hangs from the same housing).
    var screenShape: IslandScreenShape { shape }
    /// Told after every redraw of the cards on top and every open/close (phase 2's activity slot yields to them).
    var onTopChanged: (() -> Void)?
    /// Told on every change of focus (phase 2's computer-use pill hides while its session's host is in front).
    var onFocusChanged: (() -> Void)?
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    /// The pointer over the top panel, for the buttons' glow (`pillHoverGlow`).
    private let pointer = DispatchPillPointer()
    private var started = false

    // The card on top, and the one going back into the housing.
    private typealias Shown = IslandShownCard
    private var shown: Shown?
    private var leaving: (shown: Shown, card: IslandCard)?
    private var topHitRects: [CGRect] = []
    private var cardRect: CGRect = .zero
    private var waitingRect: CGRect = .zero

    private let openModel = IslandOpenModel()
    private(set) var isOpen = false
    private let swipeRecognizer = TrackpadHorizontalSwipeRecognizer()

    private var pointerMonitors: [Any] = []
    private var openMonitors: [Any] = []
    private var observers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var wake: DispatchWorkItem?
    private let terminalWatcher = TerminalFocusWatcher()
    /// The user dismissed the current card themselves (a click on the waiting pill).
    private var explicitDismiss = false
    /// The pointer over the OPEN island (its rows' hover and its buttons' glow), fed only while it is open.
    private let openPointer = DispatchPillPointer()
    /// The open island's refresh of the selected tab's data (on open, on a tab change, then every
    /// `openRefreshInterval` while open — nothing pushes `signals.working`, the helper's permissions or a phone's
    /// connection). Cancelled on close: nothing runs while the island is closed.
    private var openRefresh: Task<Void, Never>?
    static let openRefreshInterval: Duration = .seconds(5)
    private var relayoutPending = false
    private var cancellables = Set<AnyCancellable>()

    init(store: IslandStore, tabs: IslandTabModels? = nil) {
        self.store = store
        self.tabModels = tabs ?? IslandTabModels()
        store.focus = { [weak self] in self?.currentFocus() ?? IslandFocus() }
        store.scheduleWake = { [weak self] deadline in self?.armWake(deadline) }
        store.onChange = { [weak self] in self?.layoutTop() }
        store.openURL = { NSWorkspace.shared.open($0) }
        store.readTerminals = { ttys in
            let front = NSWorkspace.shared.frontmostApplication
            let pid = front?.processIdentifier
            let bundle = front?.bundleIdentifier
            return await Task.detached(priority: .userInitiated) {
                let snapshot = TerminalSnapshotReader.read(frontPid: pid, frontBundleId: bundle, ttys: ttys)
                var out: [String: TerminalFrontness] = [:]
                for tty in ttys { out[tty] = TerminalWindowMatcher.frontness(of: tty, in: snapshot) }
                return out
            }.value
        }
        terminalWatcher.onChange = { [weak self] in self?.focusChanged() }
        stripPanel.title = "Winter island"
        topPanel.title = "Winter island cards"
        islandPanel.title = "Winter island"
        topPanel.onKeyInputChange = { [weak store] typing in store?.typingCurrent(typing) }
        topPanel.onKeyDown = { [weak self] event in
            // Esc while typing into a card: stop typing (the keyboard goes back), the card stays.
            guard event.keyCode == 53, let self else { return false }
            self.topPanel.rest()
            return true
        }
        islandPanel.onKeyDown = { [weak self] event in
            guard let self, self.isOpen else { return false }
            if event.keyCode == 53 {
                self.close()
                return true
            }
            // ⌘C on the Shelf: the selected item's file URL (the user's own copy).
            if event.charactersIgnoringModifiers?.lowercased() == "c", event.modifierFlags.contains(.command),
               self.store.tabs.selected?.id == IslandTabRegistry.shelf.id {
                return self.tabModels.shelf.copySelected()
            }
            return false
        }
        // A click on a shelf item lets the island take the keyboard (so ⌘C reaches it); closing gives it back.
        tabModels.shelf.onSelect = { [weak self] in self?.islandPanel.takeKeyboard() }
        observeTabs()
    }

    // MARK: - The tabs

    private func observeTabs() {
        // A tab change: relayout (each tab has its own height) and refresh what it shows.
        store.$tabs.map { $0.selected?.id }.removeDuplicates().dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self, self.isOpen else { return }
                self.layoutIsland()
                self.restartOpenRefresh()
            }
            .store(in: &cancellables)
        // The selected tab's content changed size: relayout once (coalesced).
        let changes: [AnyPublisher<Void, Never>] = [
            store.$cards.map { _ in () }.eraseToAnyPublisher(),
            tabModels.sessions.$rows.map { _ in () }.eraseToAnyPublisher(),
            tabModels.shelf.$items.map { _ in () }.eraseToAnyPublisher(),
            tabModels.usage.objectWillChange.map { _ in () }.eraseToAnyPublisher(),
            tabModels.devices.objectWillChange.map { _ in () }.eraseToAnyPublisher(),
            store.activity.$watches.map { _ in () }.eraseToAnyPublisher(),
        ]
        Publishers.MergeMany(changes)
            .sink { [weak self] in self?.relayoutSoon() }
            .store(in: &cancellables)
        // A card arriving or leaving changes a session's "waiting for you".
        store.$cards.receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.tabModels.sessions.recompute() }
            .store(in: &cancellables)
    }

    private func relayoutSoon() {
        guard isOpen, !relayoutPending else { return }
        relayoutPending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.relayoutPending = false
            if self.isOpen { self.layoutIsland() }
        }
    }

    private func restartOpenRefresh() {
        openRefresh?.cancel()
        let tabs = tabModels
        openRefresh = Task { @MainActor [weak self] in
            var first = true
            while !Task.isCancelled {
                guard let id = self?.store.tabs.selected?.id else { return }
                await tabs.refresh(tab: id, periodic: !first)
                first = false
                try? await Task.sleep(for: Self.openRefreshInterval)
            }
        }
    }

    /// The working-sessions count on the strip (the session directory's `signals.working`, on its own pushes).
    func setWorkingSessions(_ count: Int) {
        guard store.workingSessions != count else { return }
        store.workingSessions = count
        layoutStrip()
    }

    /// A drag with files came over the strip or the island: open it on the Shelf.
    private func dragEntered() {
        if !isOpen { open() }
        store.tabs.select(IslandTabRegistry.shelf.id)
        tabModels.shelf.dropTargeted = true
    }

    private var fileDrop: IslandFileDrop {
        IslandFileDrop(
            entered: { [weak self] in self?.dragEntered() },
            exited: { [weak self] in self?.tabModels.shelf.dropTargeted = false },
            drop: { [weak self] urls in
                guard let self else { return false }
                if !self.isOpen { self.open() }
                self.store.tabs.select(IslandTabRegistry.shelf.id)
                let taken = self.tabModels.shelf.add(urls) > 0 || !urls.isEmpty
                self.relayoutSoon()
                let shelf = self.tabModels.shelf
                Task { await shelf.resolveAll() }
                return taken
            })
    }

    // MARK: - Lifecycle

    func start() {
        guard !started else { return }
        started = true
        placeOnScreen()
        observeFocus()
    }

    func stop() {
        started = false
        removePointerMonitors()
        removeOpenMonitors()
        wake?.cancel()
        settleWake?.cancel()
        settleWake = nil
        openRefresh?.cancel()
        openRefresh = nil
        pendingReroute?.cancel()
        pendingReroute = nil
        terminalWatcher.stop()
        for o in observers { NotificationCenter.default.removeObserver(o) }
        for o in workspaceObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        observers = []
        workspaceObservers = []
        stripPanel.orderOut(nil)
        topPanel.orderOut(nil)
        islandPanel.orderOut(nil)
    }

    /// The focus changed somewhere (an app came to the front, a window became key, the Dispatch pill showed or hid, a
    /// terminal's tab changed): re-judge where the cards go. Nothing to do while nothing is pending.
    func focusChanged() {
        onFocusChanged?()
        guard !store.cards.isEmpty, pendingReroute == nil else { return }
        // Trailing coalesce: a burst of notifications (an app switch raises several) is ONE re-route.
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.pendingReroute = nil
                Task { await self.store.reroute() }
            }
        }
        pendingReroute = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.focusCoalesce, execute: item)
    }

    /// How long focus notifications are gathered into one re-route.
    static let focusCoalesce: TimeInterval = 0.1
    private var pendingReroute: DispatchWorkItem?
    /// View requests already acked to the daemon (`island.shown`).
    private var acked: Set<String> = []

    /// Ack the view requests the top panel actually shows — only once it is ordered in on a screen.
    private func ackShownViewRequests() {
        let onScreen: [String]
        if islandPanel.isVisible, islandPanel.screen != nil {
            // The open island lists every view request in Needs you.
            onScreen = store.cards.filter { $0.kind == .viewRequest }.map(\.callId)
        } else if topPanel.isVisible, topPanel.screen != nil {
            onScreen = store.viewRequestsOnTop.map(\.callId)
        } else {
            return
        }
        let ids = islandAckIds(onScreen, alreadyAcked: acked)
        guard !ids.isEmpty else { return }
        acked.formUnion(ids)
        store.onShown?(ids)
    }

    private func observeFocus() {
        let ws = NSWorkspace.shared.notificationCenter
        workspaceObservers.append(ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.focusChanged() }
        })
        let nc = NotificationCenter.default
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                     NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification, NSWindow.didResignMainNotification] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                MainActor.assumeIsolated {
                    // The island's own panels taking the keyboard is not a change of focus anywhere else.
                    if let window = note.object as? NSWindow, window is IslandPanel { return }
                    self?.focusChanged()
                }
            })
        }
        observers.append(nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.placeOnScreen() }
        })
    }

    private func currentFocus() -> IslandFocus {
        IslandFocus(dispatchPillVisible: focusSources.dispatchPillVisible(),
                    dispatchSessionIds: focusSources.dispatchSessionIds(),
                    winterFrontmost: NSApp.isActive,
                    keyOrMainWindowSessionIds: NSApp.isActive ? focusSources.keyOrMainWindowSessionIds() : [])
    }

    // MARK: - Screen and strip

    private func placeOnScreen() {
        guard let screen = IslandLayout.islandScreen() else { return }
        screenFrame = screen.frame
        shape = IslandLayout.shape(of: screen)
        stripWaiting = nil
        layoutStrip()
        layoutTop()
        if isOpen { layoutIsland() }
    }

    /// Whether the strip was last laid out with something waiting (nil: not laid out yet).
    private var stripWaiting: Bool?

    /// The strip's panel for the current count: the housing alone while nothing waits (nothing at all without a
    /// housing), the wings or the tab while something does. Re-laid out only when that flips.
    private func layoutStrip() {
        let waiting = store.strip.showsWings
        guard started, stripWaiting != waiting else { return }
        stripWaiting = waiting
        guard let strip = IslandLayout.strip(shape, waiting: waiting) else {
            stripPanel.orderOut(nil)
            return
        }
        let view = IslandStripRoot(store: store, size: strip.size, housingWidth: shape.housing?.width) { [weak self] point in
            self?.stripClicked(at: point)
        } onPart: { [weak self] part in
            self?.stripPartChosen(part)
        }
        if let host = stripPanel.contentView as? IslandHostingView<IslandStripRoot> {
            host.rootView = view
        } else {
            let host = IslandHostingView(rootView: view)
            host.sizingOptions = []
            host.fileDrop = fileDrop
            stripPanel.contentView = host
        }
        stripPanel.setFrame(panelFrame(for: strip), display: true)
        if !stripPanel.isVisible { stripPanel.orderFrontRegardless() }
    }

    /// A click on the strip at `point` (x from the centre): the waiting wing opens the island on Needs you, the working
    /// wing on Sessions, the housing toggles it (`IslandStripPart.action`).
    private func stripClicked(at point: CGPoint) {
        stripPartChosen(IslandLayout.stripPart(at: point, shape, model: store.strip) ?? .housing)
    }

    private func stripPartChosen(_ part: IslandStripPart) {
        switch part.action(isOpen: isOpen, selectedTab: store.tabs.selected?.id) {
        case .open(let tab):
            if let tab { store.tabs.select(tab) }
            open()
        case .select(let tab):
            store.tabs.select(tab)
        case .close:
            close()
        }
    }

    /// A rect measured from the island's centre and the screen's top → a screen frame.
    private func panelFrame(for r: CGRect) -> CGRect {
        CGRect(x: screenFrame.midX + r.minX, y: screenFrame.maxY - r.maxY, width: r.width, height: r.height)
    }

    // MARK: - The cards on top

    private func layoutTop() {
        guard started else { return }
        layoutStrip()
        let current = store.currentCard
        // The card on top changed: the old one goes (back into the housing when it compacted or was answered here),
        // the new one is born.
        if shown?.id != current?.id {
            // The keyboard is given back only when the card it was typed into is ANSWERED (here or anywhere) or the
            // user dismissed it (a click on the waiting pill, Esc). A typed-into card is never replaced or compacted
            // (`IslandQueue.currentTyping`), so no keystroke lands in the app behind.
            if let old = shown, store.card(old.id) == nil || store.answeredHere.contains(old.id) || explicitDismiss {
                topPanel.rest()
            }
            explicitDismiss = false
            if let old = shown, let card = store.card(old.id) ?? leavingCard(old.id) {
                let compacted = store.queue.compacted.contains { $0.id == old.id }
                if (compacted || store.answeredHere.contains(old.id)) && current == nil && !reduceMotion {
                    beginLeaving(old, card: card)
                }
            }
            shown = current.map(makeShown)
        }
        drawTop()
    }

    private func leavingCard(_ id: String) -> IslandCard? { leaving?.card.id == id ? leaving?.card : nil }

    private func makeShown(_ card: IslandCard) -> Shown {
        let secondsLeft = card.expiresAt.map { max(0, Int((Double($0) - Date().timeIntervalSince1970 * 1000) / 1000)) } ?? 60
        let state = DesktopIslandState(secondsLeft: secondsLeft)
        let geometry: DesktopIslandGeometry
        var prompt: CUDesktopPromptModel?
        if case .viewRequest(let app, let bundleId, let reason) = card.payload {
            let model = CUDesktopPromptModel(CUDesktopPromptRequest(promptId: card.callId, sessionId: card.answerSessionId,
                                                                    app: app, bundleId: bundleId, reason: reason,
                                                                    timeoutMs: 60_000, expiresAt: card.expiresAt),
                                             now: ProcessInfo.processInfo.systemUptime)
            prompt = model
            geometry = DesktopIslandGeometry.make(housing: shape.housing, menuBarHeight: shape.menuBarHeight,
                                                  pillWidth: DesktopIslandGeometry.pillWidth(for: model.headline), slot: 0)
            state.onSwitch = { [weak self] in self?.store.answerApproval(card, approved: true) }
            state.onRefuse = { [weak self] in self?.store.answerApproval(card, approved: false) }
        } else {
            geometry = IslandLayout.cardGeometry(shape, size: measure(card), rounded: true)
        }
        state.bornAt = Date()
        if reduceMotion { state.still = true } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + DesktopIslandFluid.settle + 0.05) { [weak state] in
                if state?.returningAt == nil { state?.still = true }
            }
        }
        return Shown(id: card.id, geometry: geometry, state: state, prompt: prompt)
    }

    /// A rectangle's size: the content's own height at the card width.
    private func measure(_ card: IslandCard) -> CGSize {
        let host = NSHostingView(rootView: IslandRectContent(card: card, store: store).environment(\.colorScheme, .dark))
        let height = ceil(host.fittingSize.height)
        return CGSize(width: IslandLayout.cardWidth, height: max(height, DesktopIslandGeometry.pillHeight))
    }

    private func beginLeaving(_ old: Shown, card: IslandCard) {
        old.state.returningAt = Date()
        old.state.still = false
        leaving = (old, card)
        let id = old.id
        DispatchQueue.main.asyncAfter(deadline: .now() + DesktopIslandFluid.settle / DesktopIslandFluid.returnSpeed + 0.05) { [weak self] in
            guard let self, self.leaving?.shown.id == id else { return }
            self.leaving = nil
            self.drawTop()
        }
    }

    private func drawTop() {
        defer { onTopChanged?() }
        let currentCard = store.currentCard
        let waitingCard = store.waitingCard
        // Everything is centred on the panel's midline; the panel is as wide and tall as the widest and lowest part.
        var width: CGFloat = 0
        var height: CGFloat = 0
        if let shown { width = max(width, shown.geometry.panelSize.width); height = max(height, shown.geometry.panelSize.height) }
        if let leaving { width = max(width, leaving.shown.geometry.panelSize.width); height = max(height, leaving.shown.geometry.panelSize.height) }
        var waiting: CGRect?
        if let shown, waitingCard != nil {
            let r = IslandLayout.waitingRect(below: shown.geometry)
            waiting = r
            height = max(height, r.maxY + DesktopIslandGeometry.margin)
        }
        guard width > 0, height > 0, !isOpen else {
            topPanel.orderOut(nil)
            topPanel.rest()
            cardRect = .zero; waitingRect = .zero
            updatePointerMonitors(active: false)
            watchTerminalsIfNeeded()
            return
        }
        // Panel-local rects (top-left origin).
        func centred(_ w: CGFloat) -> CGFloat { (width - w) / 2 }
        cardRect = shown.map { $0.geometry.pill.offsetBy(dx: centred($0.geometry.panelSize.width), dy: 0) } ?? .zero
        waitingRect = waiting.map { $0.offsetBy(dx: centred(shown!.geometry.panelSize.width), dy: 0) } ?? .zero

        let root = IslandTopRoot(
            store: store, panelSize: CGSize(width: width, height: height), pointer: pointer,
            current: shown.flatMap { s in currentCard.map { IslandShownPair(shown: s, card: $0) } },
            leaving: leaving.map { IslandShownPair(shown: $0.shown, card: $0.card) },
            waiting: waitingCard.map { ($0, waitingRect) },
            reduceMotion: reduceMotion,
            onWaitingClick: { [weak self] in
                self?.explicitDismiss = true
                self?.store.clickWaiting()
            })
        if let host = topPanel.contentView as? IslandHostingView<IslandTopRoot> {
            host.rootView = root
        } else {
            let host = IslandHostingView(rootView: root)
            host.sizingOptions = []
            topPanel.contentView = host
        }
        topPanel.setFrame(panelFrame(for: CGRect(x: -width / 2, y: 0, width: width, height: height)), display: true)
        if !topPanel.isVisible { topPanel.orderFrontRegardless() }
        acked.formIntersection(Set(store.cards.map(\.callId)))
        ackShownViewRequests()
        updatePointerMonitors(active: true)
        pointerMoved()
        watchTerminalsIfNeeded()
    }

    /// While a card is hidden behind its terminal, that terminal app is watched for a change of tab or window (no
    /// other event says so); otherwise nothing is watched.
    private func watchTerminalsIfNeeded() {
        let watching = store.cards.contains { card in
            store.placements[card.id] == .hidden && card.hosts.contains { $0.tty != nil }
        }
        terminalWatcher.update(watching: watching, frontPid: NSWorkspace.shared.frontmostApplication?.processIdentifier)
    }

    // MARK: - Pointer

    private func updatePointerMonitors(active: Bool) {
        if active, pointerMonitors.isEmpty {
            if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] _ in
                MainActor.assumeIsolated { self?.pointerMoved() }
            }) { pointerMonitors.append(m) }
            if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] event in
                MainActor.assumeIsolated { self?.pointerMoved() }
                return event
            }) { pointerMonitors.append(m) }
            topPanel.acceptsMouseMovedEvents = true
        } else if !active {
            removePointerMonitors()
        }
    }

    private func removePointerMonitors() {
        pointerMonitors.forEach(NSEvent.removeMonitor)
        pointerMonitors = []
    }

    /// Where the pointer is over the top panel: the card (or the waiting pill) grows and its buttons glow under it, the
    /// hover holds the card, and outside what is drawn the panel lets clicks through.
    private func pointerMoved() {
        guard topPanel.isVisible else { return }
        let mouse = NSEvent.mouseLocation
        let frame = topPanel.frame
        let local = CGPoint(x: mouse.x - frame.minX, y: frame.maxY - mouse.y)
        let inside = frame.contains(mouse)
        let point: CGPoint? = inside ? local : nil
        pointer.set(point)
        if let shown {
            // The card's own panel-space (it is centred in a panel that may be wider).
            let own = point.map { CGPoint(x: $0.x - (frame.width - shown.geometry.panelSize.width) / 2, y: $0.y) }
            if shown.state.pointer != own { shown.state.pointer = own }
        }
        let overCard = point.map { cardRect.insetBy(dx: -4, dy: -4).contains($0) } ?? false
        let overWaiting = point.map { waitingRect.contains($0) } ?? false
        topPanel.ignoresMouseEvents = !(overCard || overWaiting)
        store.hoverCurrent(overCard || overWaiting)
    }

    // MARK: - The wake-up

    private func armWake(_ deadline: TimeInterval?) {
        wake?.cancel()
        wake = nil
        guard let deadline else { return }
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.wake = nil
                self?.store.tick()
            }
        }
        wake = item
        let delay = max(0, deadline - ProcessInfo.processInfo.systemUptime)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay + 0.02, execute: item)
    }

    // MARK: - The open island

    func toggle() { isOpen ? close() : open() }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        // The morph grows out of the strip as it is drawn NOW (the housing alone while nothing waits or works).
        morphSource = IslandLayout.strip(shape, waiting: store.strip.showsWings) ?? IslandLayout.strip(shape)
        layoutIsland()
        openModel.beginOpening(instant: reduceMotion)
        islandPanel.orderFrontRegardless()
        ackShownViewRequests()
        settleWake?.cancel()
        if !reduceMotion {
            // ONE wake-up when the shape has grown: the frame driver stops (frames only while it moves).
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.openModel.settled() }
            }
            settleWake = item
            DispatchQueue.main.asyncAfter(deadline: .now() + IslandOpenMorph.settle + 0.05, execute: item)
        }
        drawTop()
        installOpenMonitors()
        restartOpenRefresh()
    }

    /// What the open island grew out of (x from the centre), kept for its way back.
    private var morphSource: CGRect = .zero
    /// The open/close morph's one wake-up (settled, or gone back into the strip).
    private var settleWake: DispatchWorkItem?

    /// Closes the island. `outsideClick`: the user clicked another app or window — the keyboard is dropped WITHOUT
    /// giving it back to the app it came from, so the app the user clicked keeps it.
    func close(outsideClick: Bool = false) {
        guard isOpen else { return }
        isOpen = false
        removeOpenMonitors()
        openRefresh?.cancel()
        openRefresh = nil
        openPointer.set(nil)
        tabModels.shelf.dropTargeted = false
        if outsideClick { islandPanel.letGo() } else { islandPanel.rest() }
        settleWake?.cancel()
        settleWake = nil
        if reduceMotion {
            islandPanel.orderOut(nil)
            openModel.reset()
        } else {
            // Back into the strip: the contents go first, then the mass shrinks (the opening played backwards).
            let back = openModel.beginClosing()
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, !self.isOpen else { return }
                    self.settleWake = nil
                    self.islandPanel.orderOut(nil)
                    self.openModel.reset()
                }
            }
            settleWake = item
            DispatchQueue.main.asyncAfter(deadline: .now() + back + 0.05, execute: item)
        }
        drawTop()
    }

    private func layoutIsland() {
        let contentHeight = islandContentHeight()
        let r = IslandLayout.island(shape, contentHeight: contentHeight)
        // Room for the shadow (and the hover grow) below and at the sides; panel-local rects from here.
        let pad = Self.islandPad
        let target = CGRect(x: pad, y: 0, width: r.width, height: r.height)
        let source = morphSource.offsetBy(dx: r.width / 2 + pad, dy: 0)
        islandRect = target
        let root = IslandOpenRoot(store: store, model: openModel, shape: shape, target: target, source: source,
                                  tabModels: tabModels, pointer: openPointer, reduceMotion: reduceMotion) { [weak self] in
            self?.close()
        }
        if let host = islandPanel.contentView as? IslandHostingView<IslandOpenRoot> {
            host.rootView = root
        } else {
            let host = IslandHostingView(rootView: root)
            host.sizingOptions = []
            host.fileDrop = fileDrop
            islandPanel.contentView = host
        }
        islandPanel.setFrame(panelFrame(for: CGRect(x: r.minX - pad, y: 0, width: r.width + 2 * pad, height: r.height + pad)), display: true)
    }

    /// Around the open island inside its panel: its shadow (18 pt, 6 down) and its hover grow (3 % of 560 is under 17 pt).
    static let islandPad: CGFloat = 36
    /// The open island's resting rect in its panel (its hover is judged against it).
    private var islandRect: CGRect = .zero

    /// The open island's content height: its header and each listed card, measured at the island's width (the list
    /// scrolls past the island's maximum).
    private func islandContentHeight() -> CGFloat {
        let header = IslandOpenHeader.height
        if store.tabs.selected?.id == IslandTabRegistry.watches.id {
            // The Watches tab (phase 2, lane B): its rows measured at the island's width.
            return islandWatchesHeight(store.activity, header: header)
        }
        if let id = store.tabs.selected?.id, id != IslandTabRegistry.needsYou.id {
            // A phase-2 tab: its flat body measured at the island's width.
            let host = NSHostingView(rootView: VStack(spacing: 0) { IslandTabBody(id: id, models: tabModels, scrolls: false) }
                .frame(width: IslandLayout.islandWidth).environment(\.colorScheme, .dark))
            return header + min(ceil(host.fittingSize.height), IslandLayout.islandMaxHeight) + 6
        }
        guard !store.cards.isEmpty else { return header + 90 }
        var rows: CGFloat = 0
        for card in store.cards.reversed() {
            let host = NSHostingView(rootView: IslandNeedsYouRow(card: card, store: store)
                .frame(width: IslandLayout.islandWidth - 2 * IslandLayout.listInset).environment(\.colorScheme, .dark))
            rows += ceil(host.fittingSize.height) + IslandNeedsYouList.gap
            if header + rows > IslandLayout.islandMaxHeight { break }
        }
        return header + rows - IslandNeedsYouList.gap + IslandLayout.listInset
    }

    private func installOpenMonitors() {
        guard openMonitors.isEmpty else { return }
        swipeRecognizer.reset()
        // A click in another app closes it (mouse-downs need no permission)…
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close(outsideClick: true) }
        }) { openMonitors.append(m) }
        // …or in another of Winter's windows. A click on the strip toggles it itself.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, self.isOpen, let window = event.window else { return }
                if window === self.islandPanel || window === self.stripPanel { return }
                if String(describing: type(of: window)).contains("Menu") { return }
                self.close(outsideClick: true)
            }
            return event
        }) { openMonitors.append(m) }
        // Esc while the island is not key (another app has the keyboard): a global key monitor, which macOS only
        // delivers to an app trusted for Accessibility; while it is key, the panel's own `onKeyDown` handles it.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            MainActor.assumeIsolated { if event.keyCode == 53 { self?.close() } }
        }) { openMonitors.append(m) }
        // The pointer over the open island: it grows a little, its rows lighten and its buttons glow under it.
        let movedOpen: (NSEvent?) -> Void = { [weak self] _ in
            guard let self, self.isOpen else { return }
            let mouse = NSEvent.mouseLocation
            let frame = self.islandPanel.frame
            let local: CGPoint? = frame.contains(mouse) ? CGPoint(x: mouse.x - frame.minX, y: frame.maxY - mouse.y) : nil
            self.openPointer.set(local)
            let hovered = local.map { self.islandRect.contains($0) } ?? false
            if self.openModel.hovered != hovered, !self.openModel.isClosing { self.openModel.hovered = hovered }
        }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: { event in
            MainActor.assumeIsolated { movedOpen(event) }
        }) { openMonitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { event in
            MainActor.assumeIsolated { movedOpen(event) }
            return event
        }) { openMonitors.append(m) }
        islandPanel.acceptsMouseMovedEvents = true
        // The two-finger swipe over the island changes tabs.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel], handler: { [weak self] event in
            guard let self, self.isOpen, event.window === self.islandPanel else { return event }
            let result = self.swipeRecognizer.handle(event)
            result.performAcceptedFeedback { direction in self.store.tabs.swipe(direction) }
            return result.consumesScroll ? nil : event
        }) { openMonitors.append(m) }
    }

    private func removeOpenMonitors() {
        openMonitors.forEach(NSEvent.removeMonitor)
        openMonitors = []
    }
}

// MARK: - Roots

/// The strip's panel content. A click is told WHERE it landed (x from the centre): the waiting wing opens Needs you,
/// the working wing Sessions, the housing toggles (`IslandStripPart`); VoiceOver gets the same as named actions.
struct IslandStripRoot: View {
    @ObservedObject var store: IslandStore
    let size: CGSize
    let housingWidth: CGFloat?
    let onClick: (CGPoint) -> Void
    let onPart: (IslandStripPart) -> Void

    var body: some View {
        IslandStripView(model: store.strip, size: size, housingWidth: housingWidth)
            .onTapGesture(coordinateSpace: .local) { location in
                onClick(CGPoint(x: location.x - size.width / 2, y: location.y))
            }
            .accessibilityAction { onPart(.housing) }
            .accessibilityAction(named: "Show what needs you") { onPart(.waitingWing) }
            .accessibilityAction(named: "Show sessions") { onPart(.workingWing) }
            .environment(\.colorScheme, .dark)
    }
}

/// The top panel's content: the card on top (and the one going back up), and the waiting pill under it.
struct IslandTopRoot: View {
    @ObservedObject var store: IslandStore
    let panelSize: CGSize
    let pointer: DispatchPillPointer
    let current: IslandShownPair?
    let leaving: IslandShownPair?
    let waiting: (IslandCard, CGRect)?
    let reduceMotion: Bool
    let onWaitingClick: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let leaving { cardView(leaving.shown, leaving.card).id("leaving-\(leaving.card.id)") }
            if let current { cardView(current.shown, current.card).id(current.card.id) }
            if let (card, rect) = waiting {
                IslandWaitingPill(card: card, action: onWaitingClick)
                    .offset(x: rect.minX, y: rect.minY)
                    .transition(.scale(scale: 0.6, anchor: .top).combined(with: .opacity))
            }
        }
        .frame(width: panelSize.width, height: panelSize.height, alignment: .topLeading)
        .coordinateSpace(name: DispatchPillView.canvasSpace)
        .environment(\.dispatchPillPointer, pointer)
        .environment(\.colorScheme, .dark)
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.8), value: waiting?.0.id)
    }

    @ViewBuilder
    private func cardView(_ s: IslandShownCard, _ card: IslandCard) -> some View {
        let dx = (panelSize.width - s.geometry.panelSize.width) / 2
        Group {
            if let prompt = s.prompt {
                DesktopIslandView(model: prompt, geometry: s.geometry, state: s.state, reduceMotion: reduceMotion,
                                  countdownInLabel: false)
            } else {
                IslandRectShell(card: card, geometry: s.geometry, state: s.state, store: store, reduceMotion: reduceMotion)
            }
        }
        .offset(x: dx)
    }
}

/// A card drawn on top: its liquid geometry, its birth/return clock, and (a view request) the desktop-switch words.
struct IslandShownCard {
    let id: String
    let geometry: DesktopIslandGeometry
    let state: DesktopIslandState
    let prompt: CUDesktopPromptModel?
}

struct IslandShownPair {
    let shown: IslandShownCard
    let card: IslandCard
}

/// PURE: the view requests to ack now — those on screen not acked before.
func islandAckIds(_ onScreen: [String], alreadyAcked: Set<String>) -> [String] {
    var seen = Set<String>()
    return onScreen.filter { !alreadyAcked.contains($0) && seen.insert($0).inserted }
}
