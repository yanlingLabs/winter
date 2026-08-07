import XCTest
import AppKit

/// Rider 2 (as-m26, USER-MANDATED): the harness-wide dock-ghost teardown.
///
/// The suite's test host is the REAL Norma.app (`TEST_HOST`), and many cases exercise the
/// dock-presence machinery (`AppDelegate.syncDockPresence` → `NSApp.setActivationPolicy(.regular)`,
/// the shell/detached promotion paths, the outputs-panel click-through doors). A promoted policy or
/// a stray visible window that outlives its test case keeps the host process in the Dock for the
/// rest of the run — and xcodebuild's parallel testing runs MANY host clones, so one leaky case
/// class = dozens of ghost Norma icons on the user's Dock. Two cases had already been patched
/// per-test (`OutputsPanelTests`' click-through `defer { hide() }` pair — left in place, they are
/// also test-local correctness); the user's Dock was the third instance of the class, which
/// converts the fix to mandatory harness-wide hygiene: this observer.
///
/// Registration: this class is the test bundle's `NSPrincipalClass`
/// (`INFOPLIST_KEY_NSPrincipalClass` in `project.yml`'s NormaAppTests target — the target has no
/// Info.plist file; its plist is build-generated, so the INFOPLIST_KEY_ setting is how the key
/// reaches it). XCTest instantiates the principal class once at bundle load, BEFORE any test runs;
/// `init()` captures the host's true at-launch activation policy and registers with
/// `XCTestObservationCenter`. `@objc(HarnessTeardownObserver)` pins the bare ObjC name the plist
/// value resolves through — no Swift module prefix to drift.
///
/// Per-case promotions stay LEGAL: the machinery under test needs them momentarily, and every
/// assertion about a promoted policy runs DURING its own case — this observer only cleans AFTER
/// each case. Cleanup order matters: windows out FIRST, policy restored LAST — `orderOut` on the
/// shell window re-enters `syncDockPresence` via `onVisibilityChange`, so restoring last makes the
/// captured launch policy the final writer no matter what the sweep triggers.
@objc(HarnessTeardownObserver)
final class HarnessTeardownObserver: NSObject, XCTestObservation {

    /// The single instance XCTest constructs via the principal-class mechanism — nil means the
    /// plist wiring broke (the registration pin in `HarnessTeardownObserverTests` asserts on it).
    private(set) static var installed: HarnessTeardownObserver?

    /// The host's activation policy at bundle load, before any test has run. For this suite that
    /// is `.accessory`: the host app is `LSUIElement` AND `applicationDidFinishLaunching` sets
    /// `.accessory` before its unit-test guard — both happen pre-tests. Captured, not assumed
    /// (the observer restores whatever the host actually launched with); the registration pin
    /// re-proves the `.accessory` fact every run.
    let launchPolicy: NSApplication.ActivationPolicy

    override init() {
        launchPolicy = Self.onMain { NSApp.activationPolicy() }
        super.init()
        Self.installed = self
        XCTestObservationCenter.shared.addTestObserver(self)
    }

    // MARK: - pure decisions (unit-pinned in HarnessTeardownObserverTests)

    /// Restore iff the finished case left the policy different from the captured at-launch policy.
    static func shouldRestore(
        launchPolicy: NSApplication.ActivationPolicy,
        currentPolicy: NSApplication.ActivationPolicy
    ) -> Bool {
        currentPolicy != launchPolicy
    }

    /// Which windows the post-case sweep may `orderOut`. Conservative: only VISIBLE windows, and
    /// never the host's own infrastructure surfaces — the menu-bar status item window
    /// (`NSStatusBarWindow`), menu windows, or any private (`_`-prefixed) AppKit window class.
    /// Everything a test creates and leaves showing (shell, detached chats, orb panel) is fair game.
    static func shouldOrderOut(windowClassName: String, isVisible: Bool) -> Bool {
        guard isVisible else { return false }
        if windowClassName.hasPrefix("NSStatusBar") { return false }
        if windowClassName.hasPrefix("NSMenu") { return false }
        if windowClassName.hasPrefix("_") { return false }
        return true
    }

    // MARK: - XCTestObservation

    func testCaseDidFinish(_ testCase: XCTestCase) {
        Self.onMain { self.cleanUpAfterCase() }
    }

    /// Windows first, policy last (see the type doc). `orderOut`, never `close` — closing would
    /// tear down controller state mid-suite in ways later cases don't expect; ordering out is
    /// exactly what production's own hide path does.
    @MainActor
    private func cleanUpAfterCase() {
        for window in NSApp.windows
        where Self.shouldOrderOut(windowClassName: NSStringFromClass(type(of: window)), isVisible: window.isVisible) {
            window.orderOut(nil)
        }
        if Self.shouldRestore(launchPolicy: launchPolicy, currentPolicy: NSApp.activationPolicy()) {
            NSApp.setActivationPolicy(launchPolicy)
        }
    }

    /// Runs `body` on the main thread synchronously, whichever thread the caller is on. XCTest
    /// fires observation callbacks on the thread the case ran on (main for this suite's
    /// `@MainActor` classes); the else-branch is the belt for any future off-main case — and the
    /// reason `init` never bare-asserts main-actor isolation (a crash there would kill the whole
    /// suite at bundle load).
    private static func onMain<T>(_ body: @MainActor () -> T) -> T {
        if Thread.isMainThread {
            return MainActor.assumeIsolated(body)
        } else {
            return DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
        }
    }
}
