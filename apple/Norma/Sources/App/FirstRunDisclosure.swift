import AppKit
import SwiftUI

// -----------------------------------------------------------------------------------------------
// First-run disclosure (BYOK T2, spec §3) — a one-time modal shown on first launch only. The
// UserDefaults gate is a pure, seam-testable pair of functions (not buried in `AppDelegate`) so a
// unit test can drive the "shown once, suppressed after" contract without spinning up a real
// window or booting the whole app — mirrors `LoginItemController`'s own injectable-`defaults`
// convention (`LoginItemController.hasUserMadeChoice`).
// -----------------------------------------------------------------------------------------------

let firstRunDisclosureShownKey = "norma.firstRunDisclosureShown"

/// `true` iff the disclosure has never been shown against these `defaults` — `AppDelegate.boot()`
/// checks this (real `UserDefaults.standard` in production; an isolated `UserDefaults(suiteName:)`
/// in tests) before presenting the window.
func shouldShowFirstRunDisclosure(defaults: UserDefaults) -> Bool {
    !defaults.bool(forKey: firstRunDisclosureShownKey)
}

/// Marks the disclosure as shown — called once, at presentation time, NOT deferred to either
/// button or the window's close. So the sheet can never reappear on a later launch regardless of
/// how (or whether) the user dismissed it: a button click, the red traffic light, or quitting Norma
/// entirely before touching it. Matches spec §3's "shown once; never gates functionality" — the
/// only thing this flag controls is whether the window is offered again, never any app behavior.
func markFirstRunDisclosureShown(defaults: UserDefaults) {
    defaults.set(true, forKey: firstRunDisclosureShownKey)
}

// -----------------------------------------------------------------------------------------------
// FirstRunDisclosureView — the window's content. Same plain-language disclosure as `ProviderPane`
// (`normaProviderDisclosureText`, `ProviderPane.swift`) — one non-affiliation/account-risk text,
// never two different tellings of the same risk.
// -----------------------------------------------------------------------------------------------

struct FirstRunDisclosureView: View {
    let onSetupApiKey: () -> Void
    let onSignInWithChatGPT: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Before you start").font(Typography.paneTitle)
            Text(normaProviderDisclosureText)
                .font(Typography.label())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("I'll sign in with ChatGPT") { onSignInWithChatGPT() }
                Button("Set up my API key") { onSetupApiKey() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

// -----------------------------------------------------------------------------------------------
// FirstRunDisclosureWindowController — a standalone native window. This app has no main window at
// first launch (just the orb + menu bar), so the disclosure can't be a SwiftUI `.sheet` attached to
// some other already-open view, unlike `ConsentSheet` (which rides on the already-open
// `PluginManagerView`). Same construction style as `DashboardWindowController`/
// `DetachedWindowController` — titled+closable, this controller owns the window's lifetime — but
// deliberately non-resizable/non-miniaturizable: a fixed-size, one-time informational dialog, not a
// working window.
// -----------------------------------------------------------------------------------------------

@MainActor
final class FirstRunDisclosureWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private var didClose = false

    /// One-shot close hook (same convention as `DashboardWindowController.onClosed`/
    /// `DetachedWindowController.onClosed`) — `AppDelegate` nils its stored ref out through this.
    var onClosed: ((FirstRunDisclosureWindowController) -> Void)?

    /// Test-only read-through, same convention as `DashboardWindowController.windowForTesting`.
    var windowForTesting: NSWindow? { window }

    /// Both closures ALSO close the window after running — a click on either button is a completed
    /// decision (spec §3: "Dismiss never blocks anything"), never left open waiting for a second
    /// action.
    init(onSetupApiKey: @escaping () -> Void, onSignInWithChatGPT: @escaping () -> Void) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 260),
            styleMask: [.titled, .closable],
            backing: .buffered, defer: false)
        window.title = "Norma"
        window.isReleasedWhenClosed = false // this controller owns the window's lifetime
        self.window = window
        super.init()
        window.delegate = self
        window.contentView = NSHostingView(rootView: FirstRunDisclosureView(
            onSetupApiKey: { [weak self] in
                onSetupApiKey()
                self?.close()
            },
            onSignInWithChatGPT: { [weak self] in
                onSignInWithChatGPT()
                self?.close()
            }
        ))
        window.center()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Programmatic close — goes through the SAME AppKit `windowWillClose` path the user's own red
    /// traffic light does, same posture as `DashboardWindowController.close()`.
    func close() {
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard !didClose else { return }
        didClose = true
        onClosed?(self)
    }
}
