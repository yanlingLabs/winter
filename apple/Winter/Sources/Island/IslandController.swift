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
/// card, the badge or the open island is on screen; display-rate frames only while a shape moves; the queue's
/// self-compaction is ONE one-shot wake-up while a card is expanded.
///
/// SCREEN: the island lives on the screen with a camera housing, else the main screen (`IslandLayout.islandScreen`),
/// re-read when the displays change.
@MainActor
final class IslandController {
    let store: IslandStore
    var focusSources = IslandFocusSources()

    private let stripPanel = IslandPanel(level: .statusBar)
    private let topPanel = IslandPanel(level: .statusBar)
    private let islandPanel = IslandPanel(level: .statusBar)
    private var shape = IslandScreenShape(housing: nil, menuBarHeight: 24)
    private var screenFrame = CGRect(x: 0, y: 0, width: 1440, height: 900)
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
    private var badgeRect: CGRect = .zero
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

    init(store: IslandStore) {
        self.store = store
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
            guard event.keyCode == 53, let self, self.isOpen else { return false }
            self.close()
            return true
        }
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
        guard !store.cards.isEmpty else { return }
        Task { await store.reroute() }
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
        let waiting = store.strip.waitingCount > 0
        guard started, stripWaiting != waiting else { return }
        stripWaiting = waiting
        guard let strip = IslandLayout.strip(shape, waiting: waiting) else {
            stripPanel.orderOut(nil)
            return
        }
        let view = IslandStripRoot(store: store, size: strip.size, housingWidth: shape.housing?.width) { [weak self] in
            self?.toggle()
        }
        if let host = stripPanel.contentView as? IslandHostingView<IslandStripRoot> {
            host.rootView = view
        } else {
            let host = IslandHostingView(rootView: view)
            host.sizingOptions = []
            stripPanel.contentView = host
        }
        stripPanel.setFrame(panelFrame(for: strip), display: true)
        if !stripPanel.isVisible { stripPanel.orderFrontRegardless() }
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
        let queue = store.queue
        let currentCard = store.currentCard
        let waitingCard = store.waitingCard
        let showBadge = currentCard == nil && queue.badgeCount > 0 && !isOpen
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
        let badgeWidth = IslandBadge.width(for: queue.badgeCount)
        var badge: CGRect?
        if showBadge {
            let r = IslandLayout.badge(shape, width: badgeWidth)
            badge = r
            width = max(width, badgeWidth + 2 * DesktopIslandGeometry.margin)
            height = max(height, r.maxY + DesktopIslandGeometry.margin)
        }
        guard width > 0, height > 0, !isOpen else {
            topPanel.orderOut(nil)
            topPanel.rest()
            cardRect = .zero; badgeRect = .zero; waitingRect = .zero
            updatePointerMonitors(active: false)
            watchTerminalsIfNeeded()
            return
        }
        // Panel-local rects (top-left origin).
        func centred(_ w: CGFloat) -> CGFloat { (width - w) / 2 }
        cardRect = shown.map { $0.geometry.pill.offsetBy(dx: centred($0.geometry.panelSize.width), dy: 0) } ?? .zero
        waitingRect = waiting.map { $0.offsetBy(dx: centred(shown!.geometry.panelSize.width), dy: 0) } ?? .zero
        badgeRect = badge.map { CGRect(x: centred($0.width), y: $0.minY, width: $0.width, height: $0.height) } ?? .zero

        let root = IslandTopRoot(
            store: store, panelSize: CGSize(width: width, height: height), pointer: pointer,
            current: shown.flatMap { s in currentCard.map { IslandShownPair(shown: s, card: $0) } },
            leaving: leaving.map { IslandShownPair(shown: $0.shown, card: $0.card) },
            waiting: waitingCard.map { ($0, waitingRect) },
            badge: showBadge ? (queue.badgeCount, badgeRect) : nil,
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

    /// Where the pointer is over the top panel: the card grows and its buttons glow under it, the hover holds the card,
    /// the badge brings the newest back, and outside what is drawn the panel lets clicks through.
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
        let overBadge = point.map { badgeRect.insetBy(dx: -4, dy: -4).contains($0) } ?? false
        topPanel.ignoresMouseEvents = !(overCard || overWaiting || overBadge)
        store.hoverCurrent(overCard || overWaiting)
        if overBadge { store.hoverBadge() }
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
        layoutIsland()
        openModel.open = false
        islandPanel.orderFrontRegardless()
        DispatchQueue.main.async { [openModel, reduceMotion] in
            if reduceMotion { openModel.open = true } else {
                withAnimation(.spring(response: 0.38, dampingFraction: 0.78)) { openModel.open = true }
            }
        }
        drawTop()
        installOpenMonitors()
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        removeOpenMonitors()
        islandPanel.rest()
        if reduceMotion {
            islandPanel.orderOut(nil)
        } else {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.9)) { openModel.open = false }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) { [weak self] in
                guard let self, !self.isOpen else { return }
                self.islandPanel.orderOut(nil)
            }
        }
        drawTop()
    }

    private func layoutIsland() {
        let contentHeight = islandContentHeight()
        let r = IslandLayout.island(shape, contentHeight: contentHeight)
        let root = IslandOpenRoot(store: store, model: openModel, shape: shape, size: r.size,
                                  stripSize: IslandLayout.strip(shape).size) { [weak self] in self?.close() }
        if let host = islandPanel.contentView as? IslandHostingView<IslandOpenRoot> {
            host.rootView = root
        } else {
            let host = IslandHostingView(rootView: root)
            host.sizingOptions = []
            islandPanel.contentView = host
        }
        // Room for the shadow below and at the sides.
        let pad: CGFloat = 30
        islandPanel.setFrame(panelFrame(for: CGRect(x: r.minX - pad, y: 0, width: r.width + 2 * pad, height: r.height + pad)), display: true)
    }

    /// The open island's content height: its header and each listed card, measured at the island's width (the list
    /// scrolls past the island's maximum).
    private func islandContentHeight() -> CGFloat {
        let header: CGFloat = 46
        guard !store.cards.isEmpty else { return header + 90 }
        var rows: CGFloat = 0
        for card in store.cards.reversed() {
            let host = NSHostingView(rootView: IslandNeedsYouRow(card: card, store: store)
                .frame(width: IslandLayout.islandWidth - 28).environment(\.colorScheme, .dark))
            rows += ceil(host.fittingSize.height) + 10
            if header + rows > IslandLayout.islandMaxHeight { break }
        }
        return header + rows + 14
    }

    private func installOpenMonitors() {
        guard openMonitors.isEmpty else { return }
        swipeRecognizer.reset()
        // A click in another app closes it (mouse-downs need no permission)…
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }) { openMonitors.append(m) }
        // …or in another of Winter's windows. A click on the strip toggles it itself.
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown], handler: { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, self.isOpen, let window = event.window else { return }
                if window === self.islandPanel || window === self.stripPanel { return }
                if String(describing: type(of: window)).contains("Menu") { return }
                self.close()
            }
            return event
        }) { openMonitors.append(m) }
        // Esc while the island is not key (another app has the keyboard): a global key monitor, which macOS only
        // delivers to an app trusted for Accessibility; while it is key, the panel's own `onKeyDown` handles it.
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            MainActor.assumeIsolated { if event.keyCode == 53 { self?.close() } }
        }) { openMonitors.append(m) }
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

/// Whether the island is open (its spring).
@MainActor final class IslandOpenModel: ObservableObject {
    @Published var open = false
}

struct IslandStripRoot: View {
    @ObservedObject var store: IslandStore
    let size: CGSize
    let housingWidth: CGFloat?
    let onClick: () -> Void

    var body: some View {
        IslandStripView(model: store.strip, size: size, housingWidth: housingWidth)
            .onTapGesture(perform: onClick)
            .environment(\.colorScheme, .dark)
    }
}

/// The top panel's content: the card on top (and the one going back up), the waiting pill under it, or the badge.
struct IslandTopRoot: View {
    @ObservedObject var store: IslandStore
    let panelSize: CGSize
    let pointer: DispatchPillPointer
    let current: IslandShownPair?
    let leaving: IslandShownPair?
    let waiting: (IslandCard, CGRect)?
    let badge: (Int, CGRect)?
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
            if let (count, rect) = badge {
                IslandBadge(count: count, width: rect.width)
                    .offset(x: rect.minX, y: rect.minY)
                    .transition(.scale(scale: 0.5, anchor: .top).combined(with: .opacity))
            }
        }
        .frame(width: panelSize.width, height: panelSize.height, alignment: .topLeading)
        .coordinateSpace(name: DispatchPillView.canvasSpace)
        .environment(\.dispatchPillPointer, pointer)
        .environment(\.colorScheme, .dark)
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.8), value: waiting?.0.id)
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.8), value: badge?.0)
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

/// The open island's panel content: the island growing out of the strip, a tap on its top band closing it.
struct IslandOpenRoot: View {
    @ObservedObject var store: IslandStore
    @ObservedObject var model: IslandOpenModel
    let shape: IslandScreenShape
    let size: CGSize
    let stripSize: CGSize
    let onClose: () -> Void

    var body: some View {
        let sx = model.open ? 1 : stripSize.width / size.width
        let sy = model.open ? 1 : stripSize.height / max(size.height, 1)
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                IslandExpandedView(store: store, shape: shape, size: size)
                    .opacity(model.open ? 1 : 0.0)
                Color.clear
                    .frame(width: size.width, height: shape.topInset)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onClose)
            }
            .scaleEffect(x: sx, y: sy, anchor: .top)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .environment(\.colorScheme, .dark)
    }
}
