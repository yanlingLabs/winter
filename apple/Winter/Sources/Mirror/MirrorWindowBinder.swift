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
    private var relatedSessionIds: [String] = []
    private var width: CGFloat
    /// The window is on screen (see `MirrorWindow.isVisible`): last value sent to the coordinator.
    private var onScreen: Bool

    private var panel: MirrorChildPanel?
    private var hosting: NSHostingView<MirrorPanelContent>?
    private var shownState: MirrorSessionState?
    private var coordinatorWatch: AnyCancellable?
    private var observers: [NSObjectProtocol] = []
    private var refreshScheduled = false

    init(coordinator: MirrorCoordinator, windowId: String = UUID().uuidString, kind: MirrorWindowKind, window: NSWindow, sessionId: String?) {
        self.coordinator = coordinator
        self.windowId = windowId
        self.kind = kind
        self.window = window
        self.sessionId = sessionId
        self.width = window.frame.width
        self.onScreen = Self.isOnScreen(window)
        // The coordinator re-publishes whenever any session's mirror comes up, goes down or changes target.
        coordinatorWatch = coordinator.objectWillChange.sink { [weak self] _ in self?.scheduleRefresh() }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.windowResized() }
        })
        // Frames are only worth capturing for a window somebody can see: minimized, ordered out or wholly
        // covered, it is sent none (`MirrorCoordinator.wantsFrames`).
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                     NSWindow.didDeminiaturizeNotification, NSWindow.didChangeScreenNotification] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.visibilityChanged() }
            })
        }
        publish()
    }

    // MARK: What the window tells us

    /// The window shows `sessionId` (nil: none) and the work of `related` — the sessions it started, a
    /// Dispatch session's children. An attach, a hop, a repin, a child spawned. One call so the pair never
    /// disagrees for a moment.
    func update(sessionId: String?, related: [String] = []) {
        guard sessionId != self.sessionId || related != relatedSessionIds else { return }
        self.sessionId = sessionId
        self.relatedSessionIds = related
        publish()
    }

    /// The window closed (or stopped being a session surface): nothing is watched, no panel remains.
    func close() {
        coordinator.removeWindow(id: windowId)
        coordinatorWatch = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []
        hidePanel()
        panel = nil
        hosting = nil
    }

    /// On screen: ordered in, not minimized, and not occluded entirely.
    static func isOnScreen(_ window: NSWindow) -> Bool {
        window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
    }

    private func visibilityChanged() {
        guard let window else { return }
        let now = Self.isOnScreen(window)
        guard now != onScreen else { return }
        onScreen = now
        publish()
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
        coordinator.setWindow(MirrorWindow(id: windowId, kind: kind, sessionId: sessionId, relatedSessionIds: relatedSessionIds,
                                           width: width, isVisible: onScreen))
        scheduleRefresh()
    }

    // MARK: The panel

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
        guard let window, coordinator.isEligible(windowId: windowId), window.isVisible,
              let shown = coordinator.shownSession(forWindow: windowId) else {
            hidePanel()
            return
        }
        showPanel(for: coordinator.state(for: shown), over: window)
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
