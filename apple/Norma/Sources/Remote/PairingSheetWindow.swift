import AppKit
import NormaKit
import SwiftUI

/// SP2b Task 5: the pairing sheet's approved content size — a small utility panel, not a main
/// window (see `AppDelegate.hasMainWindow`'s own doc comment: this deliberately does NOT
/// participate in dock-promotion/quit-blocking, since it's a transient dev/setup surface, not a
/// "real" chat/dashboard window).
let pairingSheetDefaultSize = CGSize(width: 360, height: 460)

/// `pairingSheetDefaultSize` CENTERED in `visibleFrame`. PURE (no `NSScreen` dependency), same
/// posture as `centeredDashboardFrame` (`DashboardWindowController.swift`).
func centeredPairingSheetFrame(visibleFrame: CGRect) -> CGRect {
    let size = pairingSheetDefaultSize
    return CGRect(
        x: visibleFrame.midX - size.width / 2,
        y: visibleFrame.midY - size.height / 2,
        width: size.width,
        height: size.height
    )
}

/// Hosts `PairingSheetView` in an `NSPanel` (SP2b T5 brief) — follows `DashboardWindowController`'s
/// construction idiom (delegate-driven one-shot `onClosed`, `isReleasedWhenClosed = false`, this
/// controller owns the window's whole lifetime) but is otherwise much simpler: no toolbar/sidebar,
/// a single titled+closable panel around one SwiftUI view.
@MainActor
final class PairingSheetWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private var didClose = false

    /// Registry-removal hook (mirrors `DashboardWindowController.onClosed`) — fires exactly once.
    var onClosed: ((PairingSheetWindowController) -> Void)?

    /// Test-only read-through, same convention as `DashboardWindowController.windowForTesting`
    /// (unused today — this feature has no app-side unit tests per the SP2b T5 global constraint
    /// — kept for parity/consistency with the rest of this app's window controllers).
    var windowForTesting: NSWindow? { window }

    init(model: PairingSheetModel, frame: NSRect) {
        let window = NSPanel(
            contentRect: frame,
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Pair a Device"
        window.isReleasedWhenClosed = false // this controller owns the window's lifetime
        self.window = window
        super.init()
        window.delegate = self
        window.contentView = NSHostingView(rootView: PairingSheetView(model: model))
        window.setFrame(frame, display: true)
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Programmatic close — same AppKit `windowWillClose` path the user's own red traffic light
    /// takes (mirrors `DashboardWindowController.close()`).
    func close() {
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard !didClose else { return }
        didClose = true
        onClosed?(self)
    }
}
