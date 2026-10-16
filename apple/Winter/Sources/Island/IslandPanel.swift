import AppKit
import SwiftUI

/// The island's panels: borderless, non-activating, over the menu bar on every Space (a full-screen app's included),
/// never in a capture, and NEVER key — the user's focus stays where it is — EXCEPT when the user clicks into a text
/// field (a question's "Other" answer): `sendEvent` sees that mouse-down first and lets the panel take the keyboard for
/// the very same click, as the Dispatch pill's composer does. `rest()` gives it back.
final class IslandPanel: NSPanel {
    /// The panel may be key (a text field was clicked).
    private(set) var acceptsKeyInput = false
    /// A mouse-down reached the panel (window-local point, AppKit y-up), before AppKit handles it.
    var onMouseDown: ((CGPoint) -> Void)?
    /// Key-down while key (Esc closes the island).
    var onKeyDown: ((NSEvent) -> Bool)?

    override var canBecomeKey: Bool { acceptsKeyInput }
    override var canBecomeMain: Bool { false }

    init(level: NSWindow.Level) {
        super.init(contentRect: CGRect(x: 0, y: 0, width: 10, height: 10), styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: true)
        isOpaque = false
        backgroundColor = .clear
        // The island draws its own shadows (the panel's would follow the whole panel while its contents spring).
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovable = false
        becomesKeyOnlyIfNeeded = true
        self.level = level
        animationBehavior = .none
        sharingType = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        // Always dark: a black surface over arbitrary content, and the transcript's cards in the Needs-you list must
        // resolve their named colours to their dark halves.
        appearance = NSAppearance(named: .darkAqua)
    }

    /// Left where it is put: the island sits over the menu bar, which AppKit would otherwise push it below.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown {
            onMouseDown?(event.locationInWindow)
            if !acceptsKeyInput, Self.isTextInput(contentView?.hitTest(event.locationInWindow)) {
                acceptsKeyInput = true
                makeKey()
            }
        }
        if event.type == .keyDown, let onKeyDown, onKeyDown(event) { return }
        super.sendEvent(event)
    }

    /// Stop taking the keyboard.
    func rest() {
        guard acceptsKeyInput else { return }
        acceptsKeyInput = false
        if isKeyWindow { resignKey() }
    }

    /// PURE-ish: is this view (or one it sits in) where text is typed?
    static func isTextInput(_ view: NSView?) -> Bool {
        var v = view
        while let current = v {
            if current is NSTextView || current is NSTextField { return (current as? NSTextField)?.isEditable ?? true }
            v = current.superview
        }
        return false
    }
}

/// A hosting view that takes the FIRST click on a panel that is not key (no click is swallowed to make it key).
final class IslandHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
