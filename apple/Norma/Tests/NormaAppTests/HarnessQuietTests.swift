import XCTest
import AppKit
@testable import Norma

/// The pins for `HarnessQuiet` — the test-bundle-only hooks that stop this suite hijacking the
/// desktop it runs on (see that type's doc for why each lever was chosen against measurement).
///
/// MUTATION CONTRACT: every behavioural assertion below must go RED when the single
/// `HarnessQuiet.install()` call is removed from `HarnessTeardownObserver.init` — that is the whole
/// point of the counters being read rather than the hooks being inspected. A test that merely
/// asserted "the counter went up" would still red on removal (installation is what increments it),
/// but the activation pin also asserts the REAL end state (`NSApp.isActive` stays false after a
/// runloop turn), which is what proves the call did not reach AppKit rather than merely being
/// tallied on the way past.
@MainActor
final class HarnessQuietTests: XCTestCase {

    /// A throwaway on-screen window for the ordering pins. `.titled` (not borderless) so it is an
    /// ordinary, fully opaque window — the kind the dimming has to actually work on.
    private func makeProbeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 200, y: 200, width: 320, height: 240),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.backgroundColor = .red
        window.isOpaque = true
        return window
    }

    // MARK: - Focus: the app must never come forward

    /// The headline theft. Asserts BOTH halves: the call was intercepted (counter), and the app
    /// really did not activate (`isActive` still false after a runloop turn long enough for a real
    /// activation to have landed). The second half is the one that cannot be satisfied by a hook
    /// that tallies and then forwards.
    func testActivateIgnoringOtherAppsNeverReachesNSApp() async {
        let before = HarnessQuiet.suppressedActivations

        NSApp.activate(ignoringOtherApps: true)

        XCTAssertGreaterThan(
            HarnessQuiet.suppressedActivations, before,
            "NSApp.activate(ignoringOtherApps:) must be intercepted by the harness, not performed"
        )
        // A real activation is asynchronous — give it far longer than it would need.
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertFalse(
            NSApp.isActive,
            "the test host must never come to the front — this is the call that steals the user's "
                + "keyboard mid-sentence while the suite runs"
        )
    }

    /// The modern no-arg spelling (macOS 14+). Nothing in `Sources/` calls it today, but it is one
    /// `NSApp.activate()` away from being the same bug, and the hook costs one line.
    func testModernNoArgActivateNeverReachesNSApp() async {
        let before = HarnessQuiet.suppressedActivations

        NSApp.activate()

        XCTAssertGreaterThan(
            HarnessQuiet.suppressedActivations, before,
            "the no-arg NSApplication.activate() must be intercepted too"
        )
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertFalse(NSApp.isActive, "the no-arg spelling must not bring the host forward either")
    }

    /// The restore-side vector, and the one that steals focus for a DIFFERENT app:
    /// `OrbWindowController.finishCollapse()` → `externalFocus?.restore()` →
    /// `NSRunningApplication.activate(options:)` on whichever app was frontmost when the case
    /// expanded the field. Every expand→collapse case in `SurfaceWindowTests` /
    /// `MorphTimerReentrancyTests` runs it, so without this hook the suite yanks the user back to
    /// the app they have since left.
    func testRunningApplicationActivateIsInert() async {
        let before = HarnessQuiet.suppressedActivations

        _ = NSRunningApplication.current.activate(options: [])

        XCTAssertGreaterThan(
            HarnessQuiet.suppressedActivations, before,
            "NSRunningApplication.activate(options:) must be intercepted — it is ExternalFocusSnapshot's door"
        )
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertFalse(NSApp.isActive, "activating our own NSRunningApplication must not front the host")
    }

    /// The non-activating panel's keyboard grab. `makeKey()` takes system key focus WITHOUT
    /// activating the app, so no-oping `NSApp.activate` alone leaves the field panel still stealing
    /// the user's typing — this is the hook that closes it.
    func testMakeKeyIsInert() {
        let window = makeProbeWindow()
        window.orderFront(nil)
        defer { window.orderOut(nil) }
        let before = HarnessQuiet.suppressedKeyGrabs

        window.makeKey()

        XCTAssertGreaterThan(
            HarnessQuiet.suppressedKeyGrabs, before,
            "makeKey() must be intercepted — it is how the Spotlight-style field panel takes focus"
        )
        XCTAssertFalse(window.isKeyWindow, "an intercepted makeKey must leave the window non-key")
    }

    // MARK: - Visibility: windows arrive transparent, but still "visible"

    func testOrderFrontDimsTheWindowButLeavesItVisible() {
        let window = makeProbeWindow()
        XCTAssertEqual(
            window.alphaValue, 1.0, accuracy: 0.0001,
            "a fresh NSWindow starts fully opaque — without this the assertion below would be vacuous"
        )

        window.orderFront(nil)
        defer { window.orderOut(nil) }

        XCTAssertEqual(window.alphaValue, 0.0, accuracy: 0.0001, "an ordered-in window must arrive transparent")
        XCTAssertTrue(
            window.isVisible,
            "isVisible must stay TRUE — 54 assertions across this suite poll it, which is exactly "
                + "why alpha is the lever and orderOut/setIsVisible are not"
        )
    }

    func testOrderFrontRegardlessDimsTheWindowButLeavesItVisible() {
        let window = makeProbeWindow()
        XCTAssertEqual(window.alphaValue, 1.0, accuracy: 0.0001, "precondition: starts opaque")

        window.orderFrontRegardless()
        defer { window.orderOut(nil) }

        XCTAssertEqual(window.alphaValue, 0.0, accuracy: 0.0001)
        XCTAssertTrue(window.isVisible)
    }

    /// `makeKeyAndOrderFront:` is re-expressed as its order-front half alone: the window still
    /// arrives (and still reports visible), but the key grab is dropped.
    func testMakeKeyAndOrderFrontDimsAndNeverTakesKey() {
        let window = makeProbeWindow()
        XCTAssertEqual(window.alphaValue, 1.0, accuracy: 0.0001, "precondition: starts opaque")
        let keyGrabsBefore = HarnessQuiet.suppressedKeyGrabs

        window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil) }

        XCTAssertEqual(window.alphaValue, 0.0, accuracy: 0.0001)
        XCTAssertTrue(window.isVisible, "the order-front half must still happen")
        XCTAssertGreaterThan(
            HarnessQuiet.suppressedKeyGrabs, keyGrabsBefore,
            "the key half must be dropped, not performed"
        )
        XCTAssertFalse(window.isKeyWindow)
    }

    /// The production path, not just raw `NSWindow`s: the orb panel is what the user actually
    /// watches expand and collapse across the suite. `OrbWindowController.show()` orders its
    /// `KeyableNonActivatingPanel` in via `orderFrontRegardless()`.
    func testOrbControllerShowDimsItsRealPanel() {
        let controller = OrbWindowController(session: SessionModel())
        controller.show()
        defer { controller.hide() }

        let panels = NSApp.windows.filter {
            NSStringFromClass(type(of: $0)).contains("KeyableNonActivatingPanel") && $0.isVisible
        }
        guard let panel = panels.first else {
            return XCTFail("OrbWindowController.show() must put its panel on screen — none found")
        }
        XCTAssertEqual(
            panel.alphaValue, 0.0, accuracy: 0.0001,
            "the orb panel is the surface the user watches morph across the whole suite"
        )
        XCTAssertTrue(panel.isVisible, "the panel is still ordered in — SurfaceWindowTests polls exactly this")
    }

    // MARK: - The pure decision

    func testShouldDimSparesTheHostsOwnInfrastructureWindows() {
        XCTAssertFalse(HarnessQuiet.shouldDim(windowClassName: "NSStatusBarWindow"), "the menu-bar item is not ours to hide")
        XCTAssertFalse(HarnessQuiet.shouldDim(windowClassName: "NSMenuWindowManagerWindow"))
        XCTAssertFalse(HarnessQuiet.shouldDim(windowClassName: "_NSFullScreenTileWindow"), "private AppKit windows stay untouched")
    }

    /// The trap that cost a debugging round, pinned with the REAL name the runtime reports (printed
    /// from a live host, not invented): a `private` Swift class reaches the ObjC runtime mangled
    /// with a leading underscore, so the "spare private AppKit windows" rule swallowed the orb
    /// panel — the single most-shown window in the suite — until `_Tt` was excepted ahead of it.
    /// `HarnessTeardownObserver.shouldOrderOut` still carries the unfixed version of this rule, so
    /// its post-case sweep has never ordered the orb panel out; the dimming above is what makes
    /// that harmless rather than visible.
    func testShouldDimCatchesSwiftMangledPrivateAppClasses() {
        XCTAssertTrue(
            HarnessQuiet.shouldDim(
                windowClassName: "_TtC5NormaP33_D87F03A9DDDF9A6DA5F5A83835FCB2EF25KeyableNonActivatingPanel"
            ),
            "the orb panel's mangled private-class name must NOT be mistaken for a private AppKit window"
        )
    }

    func testShouldDimCoversEveryWindowTheAppItselfShows() {
        XCTAssertTrue(HarnessQuiet.shouldDim(windowClassName: "NSWindow"))
        XCTAssertTrue(HarnessQuiet.shouldDim(windowClassName: "NSPanel"))
        XCTAssertTrue(HarnessQuiet.shouldDim(windowClassName: "KeyableNonActivatingPanel"))
        XCTAssertTrue(HarnessQuiet.shouldDim(windowClassName: "Norma.OutputsPanelWindow"))
    }
}
