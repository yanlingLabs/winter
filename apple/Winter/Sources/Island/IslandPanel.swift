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
    /// The panel took the keyboard (true) or no longer holds it (false: `rest()`, or the user clicked elsewhere).
    var onKeyInputChange: ((Bool) -> Void)?
    private var resting = false

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
                // The app the user was typing in, given back by `rest()` (the Dispatch pill's rule).
                externalFocus = ExternalFocusSnapshot.captureCurrent()
                acceptsKeyInput = true
                makeKey()
                onKeyInputChange?(true)
            }
        }
        if event.type == .keyDown, let onKeyDown, onKeyDown(event) { return }
        super.sendEvent(event)
    }

    /// Take the keyboard for a click that needs it besides a text field's (a shelf item selected, so ⌘C reaches the
    /// island). `rest()` gives it back to the app that had it.
    func takeKeyboard() {
        guard !acceptsKeyInput else { return }
        externalFocus = ExternalFocusSnapshot.captureCurrent()
        acceptsKeyInput = true
        makeKey()
        onKeyInputChange?(true)
    }

    /// Stop taking the keyboard, and hand it back to the app that had it before the text-field click.
    func rest() {
        guard acceptsKeyInput else { return }
        acceptsKeyInput = false
        let wasKey = isKeyWindow
        resting = true
        if wasKey { resignKey() }
        resting = false
        if wasKey { externalFocus?.restore() }
        externalFocus = nil
        onKeyInputChange?(false)
    }

    /// The user took the keyboard elsewhere (a click in another window): the panel lets go, restoring nothing — the
    /// click already chose where focus goes.
    override func resignKey() {
        super.resignKey()
        guard !resting, acceptsKeyInput else { return }
        acceptsKeyInput = false
        externalFocus = nil
        onKeyInputChange?(false)
    }

    private var externalFocus: ExternalFocusSnapshot?

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

/// A hosting view that takes the FIRST click on a panel that is not key (no click is swallowed to make it key), and —
/// when given `fileDrop` — takes files dragged onto it (the island's Shelf).
final class IslandHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// Files dragged over this view: file URLs only, read exactly as the composer reads them.
    var fileDrop: IslandFileDrop? {
        didSet {
            if fileDrop != nil { registerForDraggedTypes([.fileURL]) } else { unregisterDraggedTypes() }
        }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard let fileDrop, !IslandFileDrop.urls(sender.draggingPasteboard).isEmpty else { return [] }
        fileDrop.entered()
        return .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard fileDrop != nil, !IslandFileDrop.urls(sender.draggingPasteboard).isEmpty else { return [] }
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) { fileDrop?.exited() }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { fileDrop != nil }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let fileDrop else { return false }
        let urls = IslandFileDrop.urls(sender.draggingPasteboard)
        fileDrop.exited()
        return !urls.isEmpty && fileDrop.drop(urls)
    }
}

/// What a drop target on the island does with dragged files.
struct IslandFileDrop {
    /// A drag with files came over it.
    var entered: () -> Void
    /// It left (or dropped).
    var exited: () -> Void
    /// The files were dropped; true when taken.
    var drop: ([URL]) -> Bool

    /// PURE-ish: the file URLs on a drag's pasteboard (the composer's own read: `readObjects` with file URLs only).
    static func urls(_ pasteboard: NSPasteboard) -> [URL] {
        (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
}
