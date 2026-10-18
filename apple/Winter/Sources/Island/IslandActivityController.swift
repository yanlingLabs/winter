import AppKit
import SwiftUI
import WinterCUPresentation
import WinterKit

/// The Winter island's activity on screen (phase 2, `docs/claude/island.md`): ONE slot under the housing for the
/// computer-use pill (opening into its mirror) or a turn-result card, born from the housing with phase 1's liquid and
/// going back up into it; and the detached mirror windows. What owns the slot is `IslandActivityArbiter`'s: a card
/// needing an answer, or the open island, always wins.
///
/// IDLE: nothing on screen → no panel, no monitor, no timer. Pointer monitors only while the slot shows something;
/// display-rate frames only while a shape moves; ONE one-shot wake-up while a pill lingers or a result shows; the mirror's
/// pictures only while a mirror is on screen (`IslandMirrorLifecycle`).
@MainActor
final class IslandActivityController {
    let store: IslandActivityStore
    private weak var island: IslandController?
    private let mirrors: IslandMirrorLifecycle?
    /// The live model a session's mirror draws (the app's `MirrorCoordinator`).
    var mirrorModel: (String) -> CUMirrorModel? = { _ in nil }

    private let panel = IslandPanel(level: .statusBar)
    private let pointer = DispatchPillPointer()
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    private var started = false

    /// What the slot draws, and what is going back up.
    private var shown: IslandActivityShown?
    private var leaving: IslandActivityShown?
    private var decision = IslandActivityDecision.none
    private var contentRect: CGRect = .zero
    private var pointerMonitors: [Any] = []
    private var wake: DispatchWorkItem?
    private var detached: [String: IslandDetachedMirrorPanel] = [:]
    private var laying = false
    private var dirty = false
    /// The full layout's screen rect (the panel itself is cut to what is drawn once it rests), and the cut.
    private var fullFrame: CGRect = .zero
    /// A mirror closing springs back to the pill: its area stays in the panel until the spring is done.
    private var collapseHold: (rect: CGRect, until: TimeInterval)?
    private var wasExpanded = false

    init(store: IslandActivityStore, island: IslandController, mirrors: IslandMirrorLifecycle?) {
        self.store = store
        self.island = island
        self.mirrors = mirrors
        panel.title = "Winter island activity"
    }

    func start() {
        guard !started else { return }
        started = true
        store.onChange = { [weak self] in self?.layout() }
        store.scheduleWake = { [weak self] deadline in self?.armWake(deadline) }
        observeScreen()
        layout()
    }

    func stop() {
        started = false
        for (center, token) in screenObservers { center.removeObserver(token) }
        screenObservers = []
        wake?.cancel()
        removePointerMonitors()
        panel.orderOut(nil)
        for p in detached.values { p.orderOut(nil) }
        detached = [:]
        mirrors?.closeAll()
    }

    // MARK: Layout

    /// Re-decides what the slot shows (the activity changed, or the island's own top did).
    func layout() {
        guard started, let island else { return }
        if laying { dirty = true; return }
        laying = true
        defer { laying = false }
        repeat {
            dirty = false
            layoutOnce(island)
        } while dirty
    }

    private func layoutOnce(_ island: IslandController) {
        let cards = island.store
        let cardOnTop = cards.currentCard != nil || cards.waitingCard != nil
        store.setCardOnTop(cardOnTop)
        store.setIslandOpen(island.isOpen)
        let cu = store.cuPresentation
        // An alarm's notice before a turn result: it waited its turn, and it is acknowledged only once seen.
        decision = IslandActivityArbiter.decide(cardOnTop: cardOnTop, islandOpen: island.isOpen,
                                                result: store.currentAlarm?.id ?? store.currentResult?.id, computerUse: cu?.sessionId,
                                                mirrorOpen: store.mirrorOpen, realMouse: store.usingRealMouse)
        // The in-island mirror's pictures flow only while it is on screen.
        if case .computerUse(let sid, true) = decision.slot { mirrors?.setIslandMirror(sid) } else { mirrors?.setIslandMirror(nil) }
        closeEndedDetachedMirrors()
        // Rung 4 (the agent's hardware pointer): the detached mirrors go fully transparent and click-through, so the
        // helper's hit test (which skips alpha-0 windows) never finds Winter in the way and no click lands on them.
        for window in detached.values {
            let away = store.usingRealMouse
            window.alphaValue = away ? 0 : 1
            window.ignoresMouseEvents = away
        }
        // …and the slot goes AT ONCE — no way back up into the housing: a retreating panel is still a Winter window at
        // the top centre, which the helper's hit test would refuse to click through.
        if store.usingRealMouse {
            shown = nil
            leaving = nil
            panel.orderOut(nil)
            contentRect = .zero
            wasExpanded = false
            collapseHold = nil
            updatePointerMonitors(active: false)
            return
        }

        let key: String? = switch decision.slot {
        case .none: nil
        case .result(let id): "result|\(id)"
        case .computerUse: "cu"
        }
        if shown?.key != key {
            if let old = shown, !reduceMotion { beginLeaving(old) }
            shown = makeShown(key: key, island: island)
        }
        if let shown, case .computerUse = decision.slot, let cu { shown.lastCU = cu }
        draw(island)
    }

    private func makeShown(key: String?, island: IslandController) -> IslandActivityShown? {
        guard let key else { return nil }
        let shape = island.screenShape
        let geometry: DesktopIslandGeometry
        var result: IslandResultItem?
        var alarm: IslandUsageAlarmItem?
        switch decision.slot {
        case .result(let id):
            if let item = store.currentAlarm, item.id == id {
                alarm = item
                geometry = IslandLayout.cardGeometry(shape, size: measure(item), rounded: true)
            } else if let item = store.currentResult {
                result = item
                geometry = IslandLayout.cardGeometry(shape, size: measure(item), rounded: true)
            } else {
                return nil
            }
        case .computerUse:
            geometry = IslandLayout.cardGeometry(shape, size: CGSize(width: IslandActivityLayout.cuPillWidth,
                                                                      height: DesktopIslandGeometry.pillHeight), rounded: false)
        case .none:
            return nil
        }
        let state = DesktopIslandState(secondsLeft: 0)
        state.bornAt = Date()
        if reduceMotion { state.still = true } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + DesktopIslandFluid.settle + 0.05) { [weak state, weak self] in
                guard let state, state.returningAt == nil else { return }
                state.still = true
                self?.layout()
            }
        }
        return IslandActivityShown(key: key, geometry: geometry, state: state, result: result, alarm: alarm, lastCU: store.cuPresentation)
    }

    private func measure(_ item: IslandResultItem) -> CGSize {
        let host = NSHostingView(rootView: IslandResultContent(item: item, onOpen: {}, onDismiss: {}).environment(\.colorScheme, .dark))
        return CGSize(width: IslandLayout.cardWidth, height: max(ceil(host.fittingSize.height), DesktopIslandGeometry.pillHeight))
    }

    private func measure(_ item: IslandUsageAlarmItem) -> CGSize {
        let host = NSHostingView(rootView: IslandUsageAlarmContent(item: item, now: Date(), onOpen: {}, onDismiss: {}).environment(\.colorScheme, .dark))
        return CGSize(width: IslandLayout.cardWidth, height: max(ceil(host.fittingSize.height), DesktopIslandGeometry.pillHeight))
    }

    private func beginLeaving(_ old: IslandActivityShown) {
        old.state.returningAt = Date()
        old.state.still = false
        old.expanded = false
        leaving = old
        let key = old.key
        DispatchQueue.main.asyncAfter(deadline: .now() + DesktopIslandFluid.settle / DesktopIslandFluid.returnSpeed + 0.05) { [weak self] in
            guard let self, self.leaving?.key == key, self.leaving === old else { return }
            self.leaving = nil
            if let island = self.island { self.draw(island) }
        }
    }

    /// The panel's size: the widest and lowest of what it draws (the computer-use slot always has room for its mirror).
    private func panelSize(_ s: IslandActivityShown) -> CGSize {
        var size = s.geometry.panelSize
        if s.key == "cu" {
            let mirror = IslandActivityLayout.mirrorSize
            size.width = max(size.width, mirror.width + 2 * DesktopIslandGeometry.margin)
            size.height = max(size.height, s.geometry.pill.minY + mirror.height + DesktopIslandGeometry.margin)
        }
        return size
    }

    private func draw(_ island: IslandController) {
        var width: CGFloat = 0
        var height: CGFloat = 0
        for s in [shown, leaving].compactMap({ $0 }) {
            let size = panelSize(s)
            width = max(width, size.width)
            height = max(height, size.height)
        }
        guard width > 0, height > 0 else {
            panel.orderOut(nil)
            contentRect = .zero
            updatePointerMonitors(active: false)
            return
        }
        let expanded: Bool = if case .computerUse(_, true) = decision.slot { true } else { false }
        shown?.expanded = expanded
        let previousContent = contentRect
        if let shown {
            let dx = (width - shown.geometry.panelSize.width) / 2
            let size = expanded ? IslandActivityLayout.mirrorSize : shown.geometry.pill.size
            contentRect = CGRect(x: dx + shown.geometry.pill.midX - size.width / 2, y: shown.geometry.pill.minY,
                                 width: size.width, height: size.height)
        } else {
            contentRect = .zero
        }
        let now = ProcessInfo.processInfo.systemUptime
        if wasExpanded, !expanded {
            collapseHold = (previousContent, now + 0.5)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { [weak self] in
                guard let self, let island = self.island else { return }
                self.draw(island)
            }
        }
        wasExpanded = expanded
        // At rest the panel is cut to what is drawn (and its shadow): no transparent area of Winter's sits over the
        // menu bar or the app below — the window server, and the helper's hit test, see only the pill or card.
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        var crop = bounds
        if let shown, leaving == nil, shown.state.still, !contentRect.isEmpty {
            var r = contentRect
            if let hold = collapseHold, hold.until > now { r = r.union(hold.rect) } else { collapseHold = nil }
            crop = r.insetBy(dx: -IslandActivityLayout.shadowRoom, dy: -IslandActivityLayout.shadowRoom).intersection(bounds).integral
        }
        let mirrorSession: String? = if case .computerUse(let sid, true) = decision.slot { sid } else { nil }
        let root = IslandActivityRoot(
            activity: store, panelSize: CGSize(width: width, height: height), crop: crop, pointer: pointer, current: shown,
            leaving: leaving, mirrorModel: mirrorSession.flatMap(mirrorModel), reduceMotion: reduceMotion,
            onPill: { [weak self] in self?.store.setMirrorOpen(true) },
            onCollapse: { [weak self] in self?.store.setMirrorOpen(false) },
            onDetach: { [weak self] in self?.detachMirror() },
            onOpenResult: { [weak self] id in self?.store.openResult(id) },
            onDismissResult: { [weak self] id in self?.store.dismissResult(id) })
        if let host = panel.contentView as? IslandHostingView<IslandActivityRoot> {
            host.rootView = root
        } else {
            let host = IslandHostingView(rootView: root)
            host.sizingOptions = []
            panel.contentView = host
        }
        let screen = island.screenFrame
        fullFrame = CGRect(x: screen.midX - width / 2, y: screen.maxY - height, width: width, height: height)
        panel.setFrame(CGRect(x: fullFrame.minX + crop.minX, y: fullFrame.maxY - crop.maxY, width: crop.width, height: crop.height),
                       display: true)
        if !panel.isVisible { panel.orderFrontRegardless() }
        updatePointerMonitors(active: true)
        pointerMoved()
    }

    // MARK: The mirror, detached

    private func detachMirror() {
        guard case .computerUse(let sid, true) = decision.slot, let island else { return }
        let window = IslandDetachedMirrorPanel(sessionId: sid)
        // The window takes the pictures over BEFORE the island lets go: one continuous capture.
        mirrors?.detach(windowId: window.windowId)
        let title = store.cuPresentation?.title ?? "Computer use"
        let close: () -> Void = { [weak self, weak window] in
            guard let self, let window else { return }
            self.closeDetached(window)
        }
        let host = NSHostingView(rootView: IslandDetachedMirrorView(title: title, model: mirrorModel(sid), onClose: close))
        window.contentView = host
        let visible = IslandLayout.islandScreen()?.visibleFrame ?? island.screenFrame
        window.setFrame(IslandDetachedMirrorPanel.initialFrame(visible: visible), display: true)
        detached[window.windowId] = window
        window.orderFrontRegardless()
        store.setMirrorOpen(false)
    }

    private func closeDetached(_ window: IslandDetachedMirrorPanel) {
        window.orderOut(nil)
        detached.removeValue(forKey: window.windowId)
        mirrors?.closeDetached(windowId: window.windowId)
    }

    /// A detached mirror stays until closed or until its session's computer use ends (its pill's linger included).
    private func closeEndedDetachedMirrors() {
        for window in detached.values where islandDetachedMirrorEnded(sessionId: window.sessionId, cu: store.cu) {
            closeDetached(window)
        }
    }

    // MARK: Pointer

    private func updatePointerMonitors(active: Bool) {
        if active, pointerMonitors.isEmpty {
            if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] _ in
                MainActor.assumeIsolated { self?.pointerMoved() }
            }) { pointerMonitors.append(m) }
            if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { [weak self] event in
                MainActor.assumeIsolated { self?.pointerMoved() }
                return event
            }) { pointerMonitors.append(m) }
            panel.acceptsMouseMovedEvents = true
        } else if !active {
            removePointerMonitors()
        }
    }

    private func removePointerMonitors() {
        pointerMonitors.forEach(NSEvent.removeMonitor)
        pointerMonitors = []
    }

    /// Where the pointer is over the slot: the shell grows and its buttons glow under it, a result is held, and outside
    /// what is drawn the panel lets clicks through.
    private func pointerMoved() {
        guard panel.isVisible else { return }
        let mouse = NSEvent.mouseLocation
        let frame = fullFrame
        let local = CGPoint(x: mouse.x - frame.minX, y: frame.maxY - mouse.y)
        let point: CGPoint? = panel.frame.contains(mouse) ? local : nil
        // The hit area IS the drawn shell: its own shape, and the grown one while hovered.
        let over = IslandHover.isOver(point, contentRect, wasHovered: shown?.hovered ?? false)
        // Into the shell's own unscaled space, where its buttons measure themselves.
        pointer.set(point.map { IslandHover.unscaled($0, in: contentRect, grown: over) })
        if let shown {
            let own = point.map { CGPoint(x: $0.x - (frame.width - shown.geometry.panelSize.width) / 2, y: $0.y) }
            if shown.state.pointer != own { shown.state.pointer = own }
            if shown.hovered != over { shown.hovered = over }
        }
        panel.ignoresMouseEvents = !over
        if case .result = decision.slot { store.hoverResult(over) }
    }

    // MARK: Who can see the screen

    private var screenObservers: [(NotificationCenter, NSObjectProtocol)] = []

    /// The screen lock, the displays' sleep and the console session (`IslandScreenPresence`): an alarm's notice counts its
    /// time only while someone can see it. Event-driven: nothing runs between the system's own notifications.
    private func observeScreen() {
        guard screenObservers.isEmpty else { return }
        let signals: [(NotificationCenter, Notification.Name, IslandScreenPresence.Signal)] = [
            (DistributedNotificationCenter.default(), Notification.Name("com.apple.screenIsLocked"), .locked),
            (DistributedNotificationCenter.default(), Notification.Name("com.apple.screenIsUnlocked"), .unlocked),
            (NSWorkspace.shared.notificationCenter, NSWorkspace.screensDidSleepNotification, .displaysSlept),
            (NSWorkspace.shared.notificationCenter, NSWorkspace.screensDidWakeNotification, .displaysWoke),
            (NSWorkspace.shared.notificationCenter, NSWorkspace.sessionDidResignActiveNotification, .sessionResigned),
            (NSWorkspace.shared.notificationCenter, NSWorkspace.sessionDidBecomeActiveNotification, .sessionActivated),
        ]
        for (center, name, signal) in signals {
            let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.store.screenSignal(signal) }
            }
            screenObservers.append((center, token))
        }
    }

    // MARK: The wake-up

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
}

/// PURE: a detached mirror's session no longer uses the computer (and no longer lingers): the window closes.
func islandDetachedMirrorEnded(sessionId: String, cu: IslandCUState) -> Bool {
    cu.sessions[sessionId] == nil && cu.lingering?.item.sessionId != sessionId
}

/// What the activity slot draws: its liquid geometry, its birth/return clock, and its content.
@MainActor
final class IslandActivityShown: ObservableObject {
    let key: String
    let geometry: DesktopIslandGeometry
    let state: DesktopIslandState
    let result: IslandResultItem?
    /// A fired plan alarm's notification (in the result's slot).
    let alarm: IslandUsageAlarmItem?
    /// The computer-use pill's last words (kept while it goes back up, when the store has none any more).
    @Published var lastCU: IslandCUPresentation?
    @Published var expanded = false
    @Published var hovered = false

    init(key: String, geometry: DesktopIslandGeometry, state: DesktopIslandState, result: IslandResultItem?,
         alarm: IslandUsageAlarmItem? = nil, lastCU: IslandCUPresentation?) {
        self.key = key
        self.geometry = geometry
        self.state = state
        self.result = result
        self.alarm = alarm
        self.lastCU = lastCU
    }
}

/// The activity panel's content: the slot (and the one going back up), centred on the panel's midline.
struct IslandActivityRoot: View {
    @ObservedObject var activity: IslandActivityStore
    let panelSize: CGSize
    /// The part of the layout the panel shows (panel-local, top-left origin).
    let crop: CGRect
    let pointer: DispatchPillPointer
    let current: IslandActivityShown?
    let leaving: IslandActivityShown?
    let mirrorModel: CUMirrorModel?
    let reduceMotion: Bool
    let onPill: () -> Void
    let onCollapse: () -> Void
    let onDetach: () -> Void
    let onOpenResult: (String) -> Void
    let onDismissResult: (String) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let leaving { slot(leaving).id("leaving-\(leaving.key)") }
            if let current { slot(current).id(current.key) }
        }
        .frame(width: panelSize.width, height: panelSize.height, alignment: .topLeading)
        .coordinateSpace(name: DispatchPillView.canvasSpace)
        .offset(x: -crop.minX, y: -crop.minY)
        .frame(width: crop.width, height: crop.height, alignment: .topLeading)
        .environment(\.dispatchPillPointer, pointer)
        .environment(\.colorScheme, .dark)
    }

    @ViewBuilder
    private func slot(_ s: IslandActivityShown) -> some View {
        IslandActivitySlotView(shown: s, activity: activity, mirrorModel: mirrorModel, reduceMotion: reduceMotion,
                               onPill: onPill, onCollapse: onCollapse, onDetach: onDetach,
                               onOpenResult: onOpenResult, onDismissResult: onDismissResult)
            .offset(x: (panelSize.width - s.geometry.panelSize.width) / 2)
    }
}

/// One slot: while born or going back up, phase 1's liquid around the pill (or the result card); at rest the computer-use
/// shell morphs between the pill and its mirror on a spring.
struct IslandActivitySlotView: View {
    @ObservedObject var shown: IslandActivityShown
    @ObservedObject var activity: IslandActivityStore
    let mirrorModel: CUMirrorModel?
    let reduceMotion: Bool
    let onPill: () -> Void
    let onCollapse: () -> Void
    let onDetach: () -> Void
    let onOpenResult: (String) -> Void
    let onDismissResult: (String) -> Void
    @ObservedObject private var state: DesktopIslandState

    init(shown: IslandActivityShown, activity: IslandActivityStore, mirrorModel: CUMirrorModel?, reduceMotion: Bool,
         onPill: @escaping () -> Void, onCollapse: @escaping () -> Void, onDetach: @escaping () -> Void,
         onOpenResult: @escaping (String) -> Void, onDismissResult: @escaping (String) -> Void) {
        self.shown = shown
        self.activity = activity
        self.mirrorModel = mirrorModel
        self.reduceMotion = reduceMotion
        self.onPill = onPill
        self.onCollapse = onCollapse
        self.onDetach = onDetach
        self.onOpenResult = onOpenResult
        self.onDismissResult = onDismissResult
        self.state = shown.state
    }

    private var presentation: IslandCUPresentation? { shown.key == "cu" ? (activity.cuPresentation ?? shown.lastCU) : nil }

    var body: some View {
        let g = shown.geometry
        Group {
            if state.still || state.bornAt == nil {
                rest
            } else {
                TimelineView(.animation) { context in liquid(at: context.date) }
            }
        }
        .frame(width: g.panelSize.width,
               height: shown.key == "cu" ? max(g.panelSize.height, g.pill.minY + IslandActivityLayout.mirrorSize.height
                                                + DesktopIslandGeometry.margin) : g.panelSize.height,
               alignment: .topLeading)
    }

    /// The liquid frame (birth, or the way back up).
    private func liquid(at date: Date) -> some View {
        let g = shown.geometry
        var frame = DesktopIslandFluid(geometry: g).frame(at: state.seconds(at: date))
        if reduceMotion {
            frame = DesktopIslandFluid(geometry: g).frame(at: DesktopIslandFluid.settle)
            let on = state.seconds(at: date) > 0 ? 1.0 : 0.0
            frame.blobs = []
            frame.crisp = on
            frame.content = on
        }
        return CUIslandLiquidFrame(frame: frame, geometry: g, hovered: false, interactive: false) { content(expanded: false) }
    }

    /// At rest: the shell, the pill or the mirror, morphing on a spring.
    private var rest: some View {
        let g = shown.geometry
        let expanded = shown.expanded && shown.key == "cu"
        let size = expanded ? IslandActivityLayout.mirrorSize : g.pill.size
        return IslandMorphShell(size: size, cornerRadius: expanded ? IslandActivityLayout.mirrorCorner : g.bodyCornerRadius,
                                hovered: shown.hovered) {
            content(expanded: expanded)
        }
        .offset(x: g.pill.midX - size.width / 2, y: g.pill.minY)
        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.8), value: expanded)
    }

    @ViewBuilder
    private func content(expanded: Bool) -> some View {
        if let item = shown.result {
            IslandResultContent(item: item, onOpen: { onOpenResult(item.id) }, onDismiss: { onDismissResult(item.id) })
        } else if let item = shown.alarm {
            IslandUsageAlarmContent(item: item, now: Date(), onOpen: { onOpenResult(item.id) }, onDismiss: { onDismissResult(item.id) })
        } else if let p = presentation {
            ZStack {
                if expanded {
                    IslandMirrorContent(presentation: p, model: mirrorModel, onDetach: onDetach, onCollapse: onCollapse)
                        .transition(.islandBlurFade)
                } else {
                    Button(action: onPill) { IslandCUPillContent(presentation: p) }
                        .buttonStyle(IslandPressStyle())
                        .transition(.islandBlurFade)
                }
            }
        }
    }
}
