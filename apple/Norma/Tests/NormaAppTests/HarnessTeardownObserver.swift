import XCTest
import AppKit
@testable import Norma

/// Rider 2 (as-m26, USER-MANDATED): the harness-wide dock-ghost teardown — now the DOCK SEAM's
/// test half (the structural fix for the persisting ghost class).
///
/// The suite's test host is the REAL Norma.app (`TEST_HOST`), and many cases exercise the
/// dock-presence machinery (`AppDelegate.syncDockPresence` → `DockPolicy.apply(.regular)`, the
/// shell/detached promotion paths, the outputs-panel click-through doors). The first round of this
/// observer only RESTORED the real activation policy after each case — which structurally cannot
/// cover a host killed/cancelled mid-case, or promoted by late async work after its final case:
/// xcodebuild's parallel testing runs MANY host clones, and any clone that EXITS promoted leaves a
/// dead process's stale Dock tile behind (the user's "dozens of ghost icons, vanish on a tap").
///
/// The seam closes those windows for good: `init` (bundle load, BEFORE any test) swaps
/// `DockPolicy.apply` — the ONE production door to `NSApp.setActivationPolicy` — for the
/// `recordedPolicies` recorder. Under test the host can never REALLY promote; tests assert the
/// recorded SEQUENCE of applied policies instead of real end states (stronger: every transition).
/// The after-case window sweep + policy restore below stay as belt-and-suspenders for raw
/// bypasses, and a TRIPWIRE (the teardown block `testCaseWillStart` registers on every case)
/// asserts the real `NSApp.activationPolicy()` still equals the captured launch policy at the end
/// of every case — a future raw `setActivationPolicy` that bypasses the seam fails the offending
/// case by name instead of silently re-opening the ghost class.
///
/// Registration: this class is the test bundle's `NSPrincipalClass`
/// (`INFOPLIST_KEY_NSPrincipalClass` in `project.yml`'s NormaAppTests target — the target has no
/// Info.plist file; its plist is build-generated, so the INFOPLIST_KEY_ setting is how the key
/// reaches it). XCTest instantiates the principal class once at bundle load, BEFORE any test runs;
/// `init()` captures the host's true at-launch activation policy, installs the recorder, and
/// registers with `XCTestObservationCenter`. `@objc(HarnessTeardownObserver)` pins the bare ObjC
/// name the plist value resolves through — no Swift module prefix to drift.
///
/// Per-case promotions stay LEGAL: the machinery under test needs them momentarily — they just
/// land in the recorder now, never on the real Dock. Order matters: the tripwire runs INSIDE the
/// case (a teardown block — before `testCaseDidFinish`, so the restore below can't mask the drift
/// it looks for); then `testCaseDidFinish` sweeps windows out FIRST and restores the policy
/// SECOND — `orderOut` on the shell window re-enters `syncDockPresence` via `onVisibilityChange`,
/// so restoring after the sweep makes the captured launch policy the final real writer no matter
/// what the sweep triggers (the sweep's re-entrant syncs themselves only reach the recorder) —
/// and clears the recorder LAST, so each case reads exactly its own applications.
@objc(HarnessTeardownObserver)
final class HarnessTeardownObserver: NSObject, XCTestObservation {

    /// The single instance XCTest constructs via the principal-class mechanism — nil means the
    /// plist wiring broke (the registration pin in `HarnessTeardownObserverTests` asserts on it).
    private(set) static var installed: HarnessTeardownObserver?

    /// Dock seam: every policy the host TRIED to apply since the last case finished — the recorder
    /// `init` swaps in for `DockPolicy.apply`. Policy-asserting tests (`AppLifecycleTests`,
    /// `AppShellTests`, the registration triple) read transition sequences off this;
    /// `testCaseDidFinish` clears it after every case.
    @MainActor private(set) static var recordedPolicies: [NSApplication.ActivationPolicy] = []

    /// The host's activation policy at bundle load, before any test has run. For this suite that
    /// is `.accessory`: the host app is `LSUIElement` AND `applicationDidFinishLaunching` applies
    /// `.accessory` before its unit-test guard — both happen pre-tests, through the REAL applier
    /// (the swap below hasn't happened yet at app launch). Captured, not assumed (the observer
    /// restores whatever the host actually launched with); the registration pin re-proves the
    /// `.accessory` fact every run.
    let launchPolicy: NSApplication.ActivationPolicy

    override init() {
        launchPolicy = Self.onMain { NSApp.activationPolicy() }
        super.init()
        Self.installed = self
        // The seam swap — from here on, nothing in the host can really promote: every production
        // policy write lands in the recorder. This is what covers the windows the after-case
        // restore can't (host killed mid-case; late async promotion after the final case).
        Self.onMain { DockPolicy.apply = { Self.recordedPolicies.append($0) } }
        // Desktop hygiene (see HarnessQuiet): from here on the suite cannot bring the host forward,
        // cannot take the user's keyboard, and paints every window it orders in at alpha 0. Same
        // bundle-load moment and same motivation as the dock seam above — a suite hosted in the
        // real app must not hijack the machine it runs on.
        HarnessQuiet.install()
        XCTestObservationCenter.shared.addTestObserver(self)
    }

    // MARK: - pure decisions (unit-pinned in HarnessTeardownObserverTests)

    /// Restore iff the finished case left the policy different from the captured at-launch policy.
    /// With the seam in place this only ever fires on a raw `setActivationPolicy` bypass — the
    /// same drift the tripwire fails the case for; this is the half that also FIXES it.
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

    /// The tripwire (dock seam): after EVERY case, the REAL `NSApp.activationPolicy()` must still
    /// equal the captured launch policy — the seam recorder means no test can have really changed
    /// it, so any drift is a raw `NSApp.setActivationPolicy` bypassing `DockPolicy.apply`, i.e.
    /// the ghost-tile class re-opening. Implemented as a teardown block registered at case START:
    /// teardown blocks run INSIDE the case lifecycle (after the method + `tearDown`, before
    /// `testCaseDidFinish`), so the `XCTFail` attributes to the offending case by name AND runs
    /// before `cleanUpAfterCase`'s restore could mask the drift. Registered-first means LIFO runs
    /// it LAST, after the case's own teardown blocks — even their late cleanup is accounted.
    /// NOT `testCase.record(XCTIssue)` in `testCaseDidFinish`: empirically (scratch raw-promote
    /// proof during the seam work) that raises `Assertion failure in -[XCTestCaseRun
    /// recordFailureWithDescription:…]` — the run has already stopped — and the uncaught exception
    /// CRASHES the host… which would itself strand a really-promoted host: the exact ghost class.
    func testCaseWillStart(_ testCase: XCTestCase) {
        testCase.addTeardownBlock { [launchPolicy] in
            Self.onMain {
                let real = NSApp.activationPolicy()
                guard real != launchPolicy else { return }
                XCTFail(
                    "Dock tripwire: the REAL NSApp.activationPolicy() is \(real.rawValue) after "
                        + "\(testCase.name), but the host launched with \(launchPolicy.rawValue) — a raw "
                        + "NSApp.setActivationPolicy bypassed DockPolicy.apply; route it through the seam "
                        + "(DockPolicy.swift) or the ghost Dock tiles come back."
                )
            }
        }
    }

    func testCaseDidFinish(_ testCase: XCTestCase) {
        Self.onMain {
            self.cleanUpAfterCase()
            Self.recordedPolicies.removeAll()
        }
    }

    /// Residual meter for `HarnessQuiet`: the class name of every window that was still on screen
    /// at FULL opacity when a case finished — i.e. one that reached the user's display around the
    /// dimming hooks (a sheet, an alert, an AppKit-internal path, or one of the infrastructure
    /// classes `HarnessQuiet.shouldDim` deliberately spares). Reported rather than asserted: the
    /// honest answer to "what will the user still see?" is a measurement, and a hard assertion here
    /// would fail the suite for surfaces that are legitimately exempt.
    @MainActor private(set) static var undimmedVisibleClasses: Set<String> = []

    func testBundleDidFinish(_ testBundle: Bundle) {
        Self.onMain {
            guard !Self.undimmedVisibleClasses.isEmpty else { return }
            print(
                "[HarnessQuiet] windows seen on screen at full opacity during this run: "
                    + Self.undimmedVisibleClasses.sorted().joined(separator: ", ")
            )
        }
    }

    /// Windows first, policy last (see the type doc). `orderOut`, never `close` — closing would
    /// tear down controller state mid-suite in ways later cases don't expect; ordering out is
    /// exactly what production's own hide path does. The restore write stays RAW (deliberate
    /// belt-and-suspenders): routing it through the seam would make it record instead of actually
    /// fixing real drift after a bypass — this and `DockPolicy.apply`'s production default are the
    /// only two `NSApp.setActivationPolicy` writes in the repo.
    @MainActor
    private func cleanUpAfterCase() {
        for window in NSApp.windows where window.isVisible && window.alphaValue == 1.0 {
            // Residual meter (see `undimmedVisibleClasses`): anything the user could still SEE.
            Self.undimmedVisibleClasses.insert(NSStringFromClass(type(of: window)))
        }
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
