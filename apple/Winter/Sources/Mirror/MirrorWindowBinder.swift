import AppKit
import Combine
import SwiftUI
import WinterCUPresentation

// -----------------------------------------------------------------------------------------------
// One Winter window's side of the mirror: tells the coordinator what the window shows (its session and
// width), and puts the mirror on screen — a CHILD PANEL of the window, pinned to its top-left corner.
//
// Why a child panel and not a SwiftUI overlay: the main window's traffic lights are AppKit's, drawn in
// the titlebar ABOVE the content view, so nothing inside the content can cover them; the user's ruling
// is that the mirror covers them ("like ChatGPT"). A child window orders above its parent, moves with
// it, hides with it and stays on its Space. The panel takes no mouse events — it is a picture, and the
// window's buttons under it keep working.
// -----------------------------------------------------------------------------------------------

/// The panel the mirror lives in: borderless, transparent, never key, click-through.
final class MirrorChildPanel: NSPanel {
    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        collectionBehavior = [.fullScreenAuxiliary]
        isFloatingPanel = false
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// What the panel draws: the session's mirror, at the size its target's window calls for.
private struct MirrorPanelContent: View {
    @ObservedObject var state: MirrorSessionState

    var body: some View {
        if let model = state.sink as? CUMirrorModel {
            CUMirrorView(model: model)
                .frame(width: state.panelSize.width, height: state.panelSize.height)
        }
    }
}

@MainActor
final class MirrorWindowBinder {
    private let coordinator: MirrorCoordinator
    private let windowId: String
    private let kind: MirrorWindowKind
    private weak var window: NSWindow?

    private(set) var sessionId: String?
    private var width: CGFloat
    private var turnRunning = false

    private var panel: MirrorChildPanel?
    private var hosting: NSHostingView<MirrorPanelContent>?
    private var shownState: MirrorSessionState?
    private var coordinatorWatch: AnyCancellable?
    private var stateWatch: AnyCancellable?
    private var observers: [NSObjectProtocol] = []
    private var refreshScheduled = false

    init(coordinator: MirrorCoordinator, windowId: String = UUID().uuidString, kind: MirrorWindowKind, window: NSWindow, sessionId: String?) {
        self.coordinator = coordinator
        self.windowId = windowId
        self.kind = kind
        self.window = window
        self.sessionId = sessionId
        self.width = window.frame.width
        coordinatorWatch = coordinator.objectWillChange.sink { [weak self] _ in self?.scheduleRefresh() }
        watchState()
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.windowResized() }
        })
        publish()
    }

    // MARK: What the window tells us

    /// The window shows `sessionId` (nil: none) and that session's turn is or is not running — an
    /// attach, a hop, a repin, a turn boundary. One call so the pair never disagrees for a moment.
    func update(sessionId: String?, turnRunning: Bool) {
        let sessionChanged = sessionId != self.sessionId
        self.sessionId = sessionId
        self.turnRunning = turnRunning
        if sessionChanged { watchState() }
        if let sessionId { coordinator.setTurnRunning(sessionId: sessionId, running: turnRunning) }
        if sessionChanged { publish() }
    }

    /// The window closed (or stopped being a session surface): nothing is watched, no panel remains.
    func close() {
        coordinator.removeWindow(id: windowId)
        coordinatorWatch = nil
        stateWatch = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        hidePanel()
        panel = nil
        hosting = nil
    }

    private func windowResized() {
        guard let window else { return }
        if window.frame.width != width {
            width = window.frame.width
            publish()
        }
        placePanel()
    }

    private func publish() {
        coordinator.setWindow(MirrorWindow(id: windowId, kind: kind, sessionId: sessionId, width: width))
        scheduleRefresh()
    }

    // MARK: The panel

    private func watchState() {
        stateWatch = nil
        guard let sessionId else { return }
        stateWatch = coordinator.state(for: sessionId).objectWillChange.sink { [weak self] _ in self?.scheduleRefresh() }
    }

    /// Coalesces the changes of one runloop turn into one placement; reads the values AFTER they settle
    /// (`objectWillChange` fires before the change).
    private func scheduleRefresh() {
        guard !refreshScheduled else { return }
        refreshScheduled = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.refreshScheduled = false
                self?.refresh()
            }
        }
    }

    private func refresh() {
        guard let window, let sessionId, coordinator.isEligible(windowId: windowId), window.isVisible else {
            hidePanel()
            return
        }
        let state = coordinator.state(for: sessionId)
        guard state.isVisible else {
            hidePanel()
            return
        }
        showPanel(for: state, over: window)
    }

    private func showPanel(for state: MirrorSessionState, over window: NSWindow) {
        let panel = self.panel ?? MirrorChildPanel()
        self.panel = panel
        if shownState !== state || hosting == nil {
            let host = NSHostingView(rootView: MirrorPanelContent(state: state))
            panel.contentView = host
            hosting = host
            shownState = state
        }
        placePanel()
        if panel.parent !== window { window.addChildWindow(panel, ordered: .above) }
        panel.orderFront(nil)
    }

    private func placePanel() {
        guard let window, let panel, let state = shownState else { return }
        let frame = mirrorPanelFrame(parent: window.frame, size: state.panelSize)
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }

    private func hidePanel() {
        guard let panel else { return }
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        shownState = nil
    }
}
