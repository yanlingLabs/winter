import AppKit

// The fixture's shared context: the log, the steal mode, and the focus plumbing every window uses.

/// Everything that can gain focus reports an id; the window turns that into `focus {id}` and the steal trigger.
protocol FocusIdentifiable: AnyObject {
    var focusID: String { get }
}

@MainActor
final class Fixture {
    /// One per process; windows reach it without threading a reference through every initializer.
    static var shared: Fixture!

    let role: String
    let run: String
    private let log: FixtureLog
    private(set) var stealMode: StealMode = .off
    private var pendingSteals: [DispatchWorkItem] = []

    init(role: String, run: String, log: FixtureLog) {
        self.role = role
        self.run = run
        self.log = log
    }

    func emit(_ ev: String, _ fields: [(String, JV)] = []) {
        log.event(ev, fields)
    }

    // MARK: Steal mode

    func setSteal(_ mode: StealMode) {
        stealMode = mode
        // A delayed steal armed under the old mode must not fire under the new one.
        cancelPendingSteals()
    }

    func cancelPendingSteals() {
        pendingSteals.forEach { $0.cancel() }
        pendingSteals.removeAll()
    }

    /// Logs the call, then makes it. `activated` is logged for every CALL, whether or not the system honours it
    /// (macOS 14+ may refuse a non-cooperative activation): the rig's front-app monitor is what observes the outcome.
    func activate(reason: String) {
        emit("activated", [("reason", .str(reason))])
        NSApp.activate(ignoringOtherApps: true)
    }

    func fire(_ trigger: StealTrigger) {
        switch StealPolicy.action(mode: stealMode, trigger: trigger) {
        case .none:
            break
        case .now(let reason):
            activate(reason: reason)
        case .after(let seconds, let reason):
            let item = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.activate(reason: reason) }
            }
            pendingSteals.append(item)
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
        }
    }

    /// `steals` is false for page elements that take focus but are not text entry (a button, a link).
    func focusGained(id: String, steals: Bool = true) {
        emit("focus", [("id", .str(id))])
        if steals { fire(.fieldFocus) }
    }
}

enum FocusID {
    /// The focus id of a window's first responder: a field's id (through its field editor), or the text view's.
    static func of(_ responder: NSResponder?) -> String? {
        if let textView = responder as? NSTextView, textView.isFieldEditor {
            return (textView.delegate as? FocusIdentifiable)?.focusID
        }
        return (responder as? FocusIdentifiable)?.focusID
    }
}

/// A main-role window. Focus is detected at the ONE door every focus change goes through — `makeFirstResponder` —
/// rather than by KVO or `becomeFirstResponder` overrides: clicks, tabbing, accessibility `AXFocused` and
/// programmatic focus all land here, and the field editor's takeover (which re-enters `makeFirstResponder`)
/// is de-duplicated by remembering the last id.
final class FixtureWindow: NSWindow {
    private var lastFocusID: String?

    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let accepted = super.makeFirstResponder(responder)
        if accepted { noteFocus() }
        return accepted
    }

    // The memory above is about focus INSIDE this window. Clicking from another window back into a field that
    // is still this window's first responder moves no first responder at all, so without these two overrides
    // Form.name -> Web.first -> Form.name would log nothing the second time. A window regaining key status
    // with a field in place is, to anyone watching, that field gaining focus again: `focus` is logged, but it
    // does not fire the steal trigger — a window only becomes key in an already-active app, so stealing there
    // would be a second, pointless activation per round trip.
    override func becomeKey() {
        lastFocusID = nil
        super.becomeKey()
        noteFocus(steals: false)
    }

    override func resignKey() {
        lastFocusID = nil
        super.resignKey()
    }

    private func noteFocus(steals: Bool = true) {
        let id = FocusID.of(firstResponder)
        guard id != lastFocusID else { return }
        // Leaving a field (id == nil) forgets it, so coming back logs again.
        lastFocusID = id
        if let id { Fixture.shared.focusGained(id: id, steals: steals) }
    }
}

/// The user-role window: every key that reaches it is input that leaked into "the user's app".
final class UserWindow: NSWindow {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown {
            Fixture.shared.emit("user.key", [("chars", .str(event.characters ?? ""))])
        }
        super.sendEvent(event)
    }
}

/// Container with a top-left origin, so layout code reads like the screen.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// Positions a new window in the deterministic grid. The main screen is `NSScreen.screens.first` (the one with
/// the menu bar): `NSScreen.main` follows the KEY window, which an inactive app does not have.
@MainActor
func makeFixtureWindow(title: String, slot: Int, fullScreenPrimary: Bool = false) -> FixtureWindow {
    let window = FixtureWindow(contentRect: NSRect(origin: .zero, size: WindowGrid.contentSize),
                               styleMask: [.titled, .closable, .miniaturizable, .resizable],
                               backing: .buffered, defer: false)
    window.title = title
    window.isReleasedWhenClosed = false
    window.isRestorable = false
    window.tabbingMode = .disallowed
    // Without this, toggleFullScreen is a no-op for the window.
    if fullScreenPrimary { window.collectionBehavior = [.fullScreenPrimary] }
    place(window, slot: slot)
    return window
}

@MainActor
func place(_ window: NSWindow, slot: Int) {
    let visible = (NSScreen.screens.first ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    window.setFrameTopLeftPoint(WindowGrid.topLeft(slot: slot, visible: visible))
}
