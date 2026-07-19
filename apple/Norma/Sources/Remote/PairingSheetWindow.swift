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
    private let container = PairingSheetContainer()
    private var didClose = false

    /// The live pairing model, once the (async, relay-homing) stack is up and `attach(model:)` has
    /// run — `nil` while the panel is still in its "Preparing…" state. A pure passthrough to the
    /// single source of truth (`container.model`) so the two can't desync; read by the `onClosed`
    /// teardown to `stop()` it only if it was ever attached (a close during homing has no model).
    var model: PairingSheetModel? { container.model }

    /// Registry-removal hook (mirrors `DashboardWindowController.onClosed`) — fires exactly once.
    var onClosed: ((PairingSheetWindowController) -> Void)?

    /// Test-only read-through, same convention as `DashboardWindowController.windowForTesting`
    /// (unused today — this feature has no app-side unit tests per the SP2b T5 global constraint
    /// — kept for parity/consistency with the rest of this app's window controllers).
    var windowForTesting: NSWindow? { window }

    /// Built model-less so the panel can be shown IMMEDIATELY (in `PairingSheetContainerView`'s
    /// "Preparing…" state) on the menu click, rather than only after the cold-start relay homing
    /// inside `RemoteHost.openPairingWindow()` finishes. The caller shows the window, then calls
    /// `attach(model:)` once the stack is up.
    init(frame: NSRect) {
        let window = NSPanel(
            contentRect: frame,
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Pair a Device"
        window.isReleasedWhenClosed = false // this controller owns the window's lifetime
        // A pairing panel must stay on screen while the user scans the QR on a SEPARATE device. An
        // NSPanel defaults `hidesOnDeactivate` to true, so the instant this menu-bar accessory app
        // resigns active (the user looks at their phone) the panel would auto-hide — the QR
        // "vanishing" mid-scan and only reappearing, already advanced to the 4-word confirm, when
        // the window is next re-shown. Pin it visible.
        window.hidesOnDeactivate = false
        self.window = window
        super.init()
        window.delegate = self
        window.contentView = NSHostingView(rootView: PairingSheetContainerView(container: container))
        window.setFrame(frame, display: true)
    }

    /// Swaps the "Preparing…" placeholder for the live pairing sheet, once
    /// `RemoteHost.openPairingWindow()` (bind + homing) has produced a model.
    func attach(model: PairingSheetModel) {
        container.model = model
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
