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
    private let icon: NSImage?
    private let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    private let panel: DesktopPromptPanel
    private var shown = false
    private var slot = -1

    init(_ model: CUDesktopPromptModel) {
        self.model = model
        state = DesktopIslandState(secondsLeft: model.secondsLeft(now: SystemClock().now),
                                   fraction: model.fractionLeft(now: SystemClock().now))
        icon = Self.icon(bundleId: model.bundleId)
        panel = DesktopPromptPanel(contentRect: CGRect(x: 0, y: 0, width: DesktopIslandGeometry.width, height: 160))
        super.init()
        // Its window name (the window list's), so a reader of the list can tell this panel from the helper's others.
        panel.title = model.title
        panel.setAccessibilityLabel(model.title)
    }

    func show(countdown: String, slot: Int) {
        let now = clock.now
        state.secondsLeft = model.secondsLeft(now: now)
        state.fraction = model.fractionLeft(now: now)
        guard !shown || slot != self.slot else { return }
        self.slot = slot
        place(slot: slot)
        if !shown {
            shown = true
            if NSApp.isHidden { NSApp.unhideWithoutActivation() }
            panel.orderFrontRegardless()
            // Drawn closed first, then sprung open on the next turn of the run loop.
            DispatchQueue.main.async { [state] in state.open = true }
        }
    }

    /// Closed, not merely hidden: the window leaves the window list's on-screen set at once, and goes with this
    /// object (the controller drops it).
    func close() {
        shown = false
        panel.orderOut(nil)
        panel.close()
    }

    /// Hangs from the top centre of the screen the pointer is on (where the user is), out of its camera housing
    /// when it has one; a second prompt floats `slot` islands down.
    private func place(slot: Int) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
        let frame = screen?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let geometry = DesktopIslandGeometry.make(housing: screen.flatMap(Self.housing),
                                                  menuBarHeight: frame.maxY - (screen?.visibleFrame.maxY ?? frame.maxY),
                                                  contentHeight: contentHeight(), slot: slot)
        let view = DesktopIslandView(model: model, geometry: geometry, icon: icon, state: state, reduceMotion: reduceMotion)
        let host = FirstClickHostingView(rootView: view)
        host.sizingOptions = []
        panel.contentView = host
        let m = DesktopIslandGeometry.margin
        let width = geometry.size.width + 2 * m
        let height = geometry.size.height + m + (geometry.attached ? 0 : m)
        // Slot 0 hangs from the top edge; each later one floats below the island above it.
        let top = slot == 0 ? frame.maxY
            : frame.maxY - CGFloat(slot) * (geometry.size.height + DesktopIslandGeometry.gap) - m
        panel.setFrame(CGRect(x: frame.midX - width / 2, y: top - height, width: width, height: height), display: true)
    }

    /// The open island's content height below the top inset, measured once at its width.
    private func contentHeight() -> CGFloat {
        let measure = NSHostingView(rootView: DesktopIslandContent(model: model, icon: icon, state: state)
            .frame(width: DesktopIslandGeometry.width))
        return ceil(measure.fittingSize.height)
    }

    /// The camera housing's size on `screen`, nil when it has none.
    static func housing(of screen: NSScreen) -> CGSize? {
        let top = screen.safeAreaInsets.top
        guard top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea else { return nil }
        let width = screen.frame.width - left.width - right.width
        return width > 0 ? CGSize(width: width, height: top) : nil
    }

    /// The app's own icon, looked up by bundle id (so the island shows the real app, not a name the model chose).
    static func icon(bundleId: String) -> NSImage? {
        guard !bundleId.isEmpty, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            return nil
        }
        return NSWorkspace.shared.icon(forFile: url.path)
    }
}
