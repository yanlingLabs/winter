import AppKit
import SwiftUI

/// The desktop-switch prompt's panel: never key or main, never activates the helper, never in a capture
/// (`sharingType = .none`), on every Space — so it is on the user's CURRENT desktop, a full-screen app's
/// included — above the menu bar, hanging from the top centre of the screen the user is on.
final class DesktopPromptPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(contentRect: CGRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        // The island draws its own shadow (the panel's would follow the whole panel while it springs open).
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovable = false
        becomesKeyOnlyIfNeeded = true
        ignoresMouseEvents = false
        level = .statusBar
        animationBehavior = .none
        sharingType = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
    }

    /// Left where it is put: the island sits over the menu bar, which AppKit would otherwise push it below.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

@MainActor struct AppKitDesktopPromptFactory: DesktopPromptSurfaceFactory {
    func make(_ model: CUDesktopPromptModel) -> DesktopPromptSurface { AppKitDesktopPrompt(model) }
}

/// One prompt as an island (`DesktopIslandView`) in its own panel.
@MainActor final class AppKitDesktopPrompt: NSObject, DesktopPromptSurface {
    var onSwitch: (() -> Void)? {
        get { state.onSwitch }
        set { state.onSwitch = newValue }
    }
    var onRefuse: (() -> Void)? {
        get { state.onRefuse }
        set { state.onRefuse = newValue }
    }

    private let model: CUDesktopPromptModel
    private let state: DesktopIslandState
    private let clock: CUClock = SystemClock()
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    private let panel: DesktopPromptPanel
    private var shown = false
    private var slot = -1
    /// The app the user was in when the pill appeared, and the watch that gives it the front back.
    private var userApp: NSRunningApplication?
    private var activationWatch: NSObjectProtocol?
    /// Mouse-move monitors while it shows: the pill grows under the pointer. (A panel that is never key, of an app
    /// that is not active, gets no hover of its own — the Dispatch pill reads the pointer the same way.)
    private var pointerMonitors: [Any] = []

    init(_ model: CUDesktopPromptModel) {
        self.model = model
        state = DesktopIslandState(secondsLeft: model.secondsLeft(now: SystemClock().now))
        panel = DesktopPromptPanel(contentRect: CGRect(x: 0, y: 0, width: 400, height: 120))
        super.init()
        // Its window name (the window list's), so a reader of the list can tell this panel from the helper's others.
        panel.title = model.title
        panel.setAccessibilityLabel(model.title)
    }

    func show(countdown: String, slot: Int) {
        let now = clock.now
        state.secondsLeft = model.secondsLeft(now: now)
        guard !shown || slot != self.slot else { return }
        self.slot = slot
        place(slot: slot)
        if !shown {
            shown = true
            if NSApp.isHidden { NSApp.unhideWithoutActivation() }
            guardFocus()
            watchPointer()
            panel.orderFrontRegardless()
            // Born now; the frame driver stops once the liquid has settled.
            state.bornAt = Date()
            DispatchQueue.main.asyncAfter(deadline: .now() + DesktopIslandFluid.settle + 0.05) { [state] in
                if state.returningAt == nil { state.still = true }
            }
        }
    }

    /// Closed, not merely hidden: the window leaves the window list's on-screen set, and goes with this object (the
    /// controller drops it). Answered on its own buttons, the pill first goes back into the housing; answered on the
    /// card or cancelled, it goes at once.
    func close() {
        shown = false
        if let activationWatch { NotificationCenter.default.removeObserver(activationWatch) }
        activationWatch = nil
        for monitor in pointerMonitors { NSEvent.removeMonitor(monitor) }
        pointerMonitors = []
        state.pointer = nil
        let panel = panel
        guard state.answeredHere, state.bornAt != nil, !reduceMotion else {
            panel.orderOut(nil)
            panel.close()
            return
        }
        state.returningAt = Date()
        state.still = false
        DispatchQueue.main.asyncAfter(deadline: .now() + DesktopIslandFluid.settle / DesktopIslandFluid.returnSpeed + 0.05) {
            panel.orderOut(nil)
            panel.close()
        }
    }

    /// Born from the camera housing at the top centre of the screen the pointer is on (where the user is), or from
    /// the top edge without one; a second prompt floats below the first.
    private func place(slot: Int) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let housing = screen.flatMap(Self.housing)
        let menuBar = frame.maxY - (screen?.visibleFrame.maxY ?? frame.maxY)
        let geometry = DesktopIslandGeometry.make(housing: housing, menuBarHeight: menuBar,
                                                  pillWidth: DesktopIslandGeometry.pillWidth(for: model.headline), slot: slot)
        let view = DesktopIslandView(model: model, geometry: geometry, state: state, reduceMotion: reduceMotion)
        let host = FirstClickHostingView(rootView: view)
        host.sizingOptions = []
        panel.contentView = host
        let size = geometry.panelSize
        let top = frame.maxY - DesktopIslandGeometry.panelTop(slot: slot, housing: housing, menuBarHeight: menuBar)
        panel.setFrame(CGRect(x: frame.midX - size.width / 2, y: top - size.height, width: size.width, height: size.height),
                       display: true)
    }

    /// The pill never takes the user's focus: the panel never becomes key and never activates this app, and should
    /// this app become active anyway while it shows (an app started from a terminal is made active by macOS at its
    /// launch), the front goes straight back to the app the user was in.
    private func guardFocus() {
        let me = NSRunningApplication.current
        if let front = NSWorkspace.shared.frontmostApplication, front != me { userApp = front }
        let hand = { [weak self] in
            guard let self, self.shown, let app = self.userApp, !app.isTerminated else { return }
            NSApp.yieldActivation(to: app)
            app.activate(from: me, options: [])
        }
        activationWatch = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification,
                                                                 object: NSApp, queue: .main) { _ in
            MainActor.assumeIsolated { hand() }
        }
        if NSApp.isActive { hand() }
    }

    private func watchPointer() {
        let moved = { [weak self] in self?.pointerMoved() }
        if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { _ in
            MainActor.assumeIsolated { moved() }
        }) { pointerMonitors.append(m) }
        if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: { event in
            MainActor.assumeIsolated { moved() }
            return event
        }) { pointerMonitors.append(m) }
        pointerMoved()
    }

    /// Where the pointer is over the panel (top-left origin), nil outside it.
    private func pointerMoved() {
        let mouse = NSEvent.mouseLocation
        let frame = panel.frame
        let local = CGPoint(x: mouse.x - frame.minX, y: frame.maxY - mouse.y)
        let point: CGPoint? = frame.contains(mouse) ? local : nil
        if state.pointer != point { state.pointer = point }
    }

    /// The camera housing's size on `screen`, nil when it has none.
    static func housing(of screen: NSScreen) -> CGSize? { CUScreenHousing.size(of: screen) }

}

/// The camera housing of a screen — shared with Winter.app's island, which is born from the same place.
public enum CUScreenHousing {
    /// The housing's size on `screen` (the band between the menu bar's two usable areas), nil when it has none.
    @MainActor public static func size(of screen: NSScreen) -> CGSize? {
        let top = screen.safeAreaInsets.top
        guard top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea else { return nil }
        let width = screen.frame.width - left.width - right.width
        return width > 0 ? CGSize(width: width, height: top) : nil
    }
}
