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
//
// Everything the binder does to AppKit goes through `MirrorPanelHosting`, and only when what is to be on
// screen CHANGED (which session's mirror, where): ordering a child window front or re-framing it on every
// coordinator publish would move windows around for nothing — each of those is a window-server round trip
// the parent window can observe.
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

/// Where the mirror is put on screen. The AppKit one is `AppKitMirrorPanelHost`; a test passes a recording one.
@MainActor
protocol MirrorPanelHosting: AnyObject {
    /// Shows `state`'s mirror in `frame` (screen coordinates) as a child of `window`.
    func present(state: MirrorSessionState, frame: NSRect, over window: NSWindow)
    /// Takes the mirror down.
    func dismiss()
}

/// The real thing: one `MirrorChildPanel`, one `NSHostingView` per session shown. Idempotent — an AppKit call is
/// made only for what differs from the panel's actual state.
@MainActor
final class AppKitMirrorPanelHost: MirrorPanelHosting {
    private var panel: MirrorChildPanel?
    private var hosting: NSHostingView<MirrorPanelContent>?
    private var shownState: MirrorSessionState?

    func present(state: MirrorSessionState, frame: NSRect, over window: NSWindow) {
        let panel = self.panel ?? MirrorChildPanel()
        self.panel = panel
        if shownState !== state || hosting == nil {
            let host = NSHostingView(rootView: MirrorPanelContent(state: state))
            panel.contentView = host
            hosting = host
            shownState = state
        }
        if panel.frame != frame { panel.setFrame(frame, display: true) }
        if panel.parent !== window { window.addChildWindow(panel, ordered: .above) }
        if !panel.isVisible { panel.orderFront(nil) }
    }

    func dismiss() {
        guard let panel else { return }
        panel.parent?.removeChildWindow(panel)
        if panel.isVisible { panel.orderOut(nil) }
        shownState = nil
        hosting = nil
        panel.contentView = nil
    }
}

/// What the binder reads off its window: a seam so a test can describe a window without showing one.
struct MirrorWindowFacts: Equatable {
    var frame: NSRect
    /// Ordered in (the panel can only be shown over a window that is).
    var isVisible: Bool
    /// Ordered in, not minimized, not wholly covered — what frames are worth capturing for.
    var isOnScreen: Bool

    @MainActor
    static func read(_ window: NSWindow) -> MirrorWindowFacts {
        MirrorWindowFacts(frame: window.frame, isVisible: window.isVisible,
                          isOnScreen: window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible))
    }
}

@MainActor
final class MirrorWindowBinder {
    private let coordinator: MirrorCoordinator
    private let windowId: String
    private let kind: MirrorWindowKind
    private weak var window: NSWindow?
    private let host: any MirrorPanelHosting
    private let facts: @MainActor (NSWindow) -> MirrorWindowFacts

    private(set) var sessionId: String?
    private var relatedSessionIds: [String] = []
    private var width: CGFloat
    /// The window is on screen (see `MirrorWindow.isVisible`): last value sent to the coordinator.
    private var onScreen: Bool

    private var coordinatorWatch: AnyCancellable?
    private var observers: [NSObjectProtocol] = []
    private var refreshScheduled = false
    /// What is on screen now: which session's mirror, and its frame. Nil when no panel is.
    private var presented: (state: ObjectIdentifier, frame: NSRect)?

    /// How often `refresh()` ran, and how many times it actually put something on or took it off the screen
    /// (tests: both must stop growing once events stop).
    private(set) var refreshCount = 0
    private(set) var presentCount = 0

    init(coordinator: MirrorCoordinator, windowId: String = UUID().uuidString, kind: MirrorWindowKind, window: NSWindow,
         sessionId: String?, host: (any MirrorPanelHosting)? = nil,
         facts: @escaping @MainActor (NSWindow) -> MirrorWindowFacts = { MirrorWindowFacts.read($0) }) {
        self.coordinator = coordinator
        self.windowId = windowId
        self.kind = kind
        self.window = window
        self.sessionId = sessionId
        self.host = host ?? AppKitMirrorPanelHost()
        self.facts = facts
        let initial = facts(window)
        self.width = initial.frame.width
        self.onScreen = initial.isOnScreen
        // The coordinator re-publishes when a window's eligibility changes and when a session's mirror comes up,
        // goes down or changes hands — not for a frame, a cursor or a size.
        coordinatorWatch = coordinator.objectWillChange.sink { [weak self] _ in self?.scheduleRefresh() }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.windowResized() }
        })
        // The window moving carries the child panel with it (AppKit); only a resize changes where the panel sits.
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
        dismiss()
    }

    /// On screen: ordered in, not minimized, and not occluded entirely.
    static func isOnScreen(_ window: NSWindow) -> Bool { MirrorWindowFacts.read(window).isOnScreen }

    private func visibilityChanged() {
        guard let window else { return }
        let now = facts(window).isOnScreen
        guard now != onScreen else { return }
        onScreen = now
        publish()
    }

    private func windowResized() {
        guard let window else { return }
        let frame = facts(window).frame
        if frame.width != width {
            width = frame.width
            publish()
        } else {
            scheduleRefresh() // the height changed: the panel's place with it (idempotent when nothing moved)
        }
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

    /// Settles what should be on screen and touches AppKit only if that differs from what is.
    func refresh() {
        refreshCount += 1
        guard let window else { return dismiss() }
        let facts = self.facts(window)
        guard coordinator.isEligible(windowId: windowId), facts.isVisible,
              let shown = coordinator.shownSession(forWindow: windowId) else {
            return dismiss()
        }
        let state = coordinator.state(for: shown)
        let frame = mirrorPanelFrame(parent: facts.frame, size: state.panelSize)
        if let presented, presented.state == ObjectIdentifier(state), presented.frame == frame { return }
        presented = (ObjectIdentifier(state), frame)
        presentCount += 1
        host.present(state: state, frame: frame, over: window)
    }

    private func dismiss() {
        guard presented != nil else { return }
        presented = nil
        presentCount += 1
        host.dismiss()
    }
}
