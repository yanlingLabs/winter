import AppKit
import ObjectiveC

/// TEST-BUNDLE-ONLY desktop hygiene: while the app suite runs, it must not hijack the machine it
/// runs on. `NormaAppTests` is hosted IN the real Norma.app (`TEST_HOST`) and ~1718 cases drive the
/// REAL AppKit surfaces — so a plain run used to steal the user's keyboard mid-sentence and paint
/// orbs/shells/panels over whatever they were doing, once per case, for every mutation round.
///
/// Nothing here lives in `Sources/`: every hook is an ObjC method-implementation swap installed
/// from `HarnessTeardownObserver.init` (the test bundle's `NSPrincipalClass`, run once at bundle
/// load BEFORE any case). Production code is byte-identical to what ships — the same reason the
/// dock seam records rather than branches.
///
/// Two levers, chosen against measurement rather than intuition:
///
/// 1. FOCUS — the activation calls become inert. `NSApp.activate(ignoringOtherApps:)` is the
///    obvious one (`AppDelegate:159`, `AppWindowController:291`, `FirstRunDisclosure:109`, both CEF
///    spikes), but it is NOT the whole theft: the orb's field panel is a Spotlight-style
///    NON-ACTIVATING panel (`KeyableNonActivatingPanel`, `styleMask` `.nonactivatingPanel`) that
///    takes system key focus via `makeKey()` WITHOUT activating the app — which is precisely why
///    `ExternalFocusSnapshot` exists ("before the field steals key focus"). So `makeKey` is hooked
///    too, and `makeKeyAndOrderFront:` is re-expressed as its order-front half alone. The third
///    vector is the restore side: `finishCollapse()` → `externalFocus?.restore()` →
///    `NSRunningApplication.activate(options:)`, which yanks the user back to whatever app was
///    frontmost when the case expanded the field — hooked as well.
///
/// 2. VISIBILITY — windows are ordered in at `alphaValue = 0`. Alpha, not `orderOut`/`setIsVisible`
///    /off-screen, for three measured reasons: 54 assertions across the suite poll `isVisible`, and
///    alpha does not disturb it; `alphaValue` appears NOWHERE in `Sources/`, so no production code
///    reads it or can fight it back to 1; and an alpha-0 window is still COMPOSITED, so the window
///    springs `SurfaceWindowTests` polls keep ticking (moving windows off-screen risks starving
///    them exactly the way an idle display was measured to — the diagnosed cause of that suite's
///    six-sighting flake).
///
/// The alpha is set BEFORE the original ordering call as well as after, so a window is composited
/// transparent from its very first frame — there is no one-frame flash at full opacity.
///
/// `ignoresMouseEvents` is deliberately NOT touched. The obvious worry — "an invisible window that
/// still hit-tests silently swallows the user's clicks, which is worse than a visible one" — was
/// measured and does not apply: `NSWindow.windowNumber(at:belowWindowWithWindowNumber:)` (the
/// window server's own event-shape query) at an alpha-0 window's centre returns a DIFFERENT window,
/// and returns the window itself again the moment alpha goes back up. Fully transparent windows are
/// excluded from event delivery, so alpha-0 windows do not take clicks. That matters beyond
/// tidiness: `ignoresMouseEvents` is live production state toggled at 60Hz by the morph hit-test
/// (`OrbWindowController:1354`), which also READS it (`let wasAccepting = !panel.ignoresMouseEvents`)
/// — forcing the setter would corrupt that logic's own change-detection invariant.
enum HarnessQuiet {

    // MARK: - Observable counters (the pins in `HarnessQuietTests` read these)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var _suppressedActivations = 0
    nonisolated(unsafe) private static var _suppressedKeyGrabs = 0
    nonisolated(unsafe) private static var _dimmedWindows = 0
    nonisolated(unsafe) private static var installed = false

    /// Every app-level activation the suite TRIED to perform: `NSApplication`'s two `activate`
    /// spellings plus `NSRunningApplication.activate(options:)`.
    static var suppressedActivations: Int { lock.withLock { _suppressedActivations } }

    /// Every `makeKey` / `makeKeyAndOrderFront:` the suite tried — the non-activating panel's
    /// keyboard grab.
    static var suppressedKeyGrabs: Int { lock.withLock { _suppressedKeyGrabs } }

    /// Every window this forced from opaque to transparent as it was ordered in.
    static var dimmedWindows: Int { lock.withLock { _dimmedWindows } }

    // MARK: - Pure decision (unit-pinned)

    /// Which windows get dimmed. Mirrors `HarnessTeardownObserver.shouldOrderOut`'s conservatism:
    /// never the host's own infrastructure surfaces — the menu-bar status item window
    /// (`NSStatusBarWindow`), menu windows, or any private (`_`-prefixed) AppKit window class.
    /// Everything the app itself puts on screen (shell, detached chats, orb panel, outputs) is
    /// fair game.
    static func shouldDim(windowClassName: String) -> Bool {
        if windowClassName.hasPrefix("NSStatusBar") { return false }
        if windowClassName.hasPrefix("NSMenu") { return false }
        // `_Tt…` is a SWIFT-MANGLED name, not a private AppKit one — a Swift class that is
        // `private`/nested reaches the ObjC runtime mangled, and the app's own orb panel is exactly
        // that: `private final class KeyableNonActivatingPanel` arrives as
        // `_TtC5NormaP33_<hash>25KeyableNonActivatingPanel`. Measured, not guessed (the orb pin
        // printed it). This clause must come FIRST: the blanket `_` rule below would otherwise
        // spare the single most-shown window in the whole suite.
        if windowClassName.hasPrefix("_Tt") { return true }
        if windowClassName.hasPrefix("_") { return false }
        return true
    }

    // MARK: - Installation

    private typealias VoidSelfIMP = @convention(c) (NSWindow, Selector) -> Void
    private typealias VoidSelfSenderIMP = @convention(c) (NSWindow, Selector, Any?) -> Void

    /// The genuine AppKit implementations the ordering hooks call through to, keyed
    /// `"<class>.<selector>"`. A dictionary rather than two fields because the hooks are installed
    /// per CLASS: `NSPanel` overrides the ordering methods, so a swap on `NSWindow` alone silently
    /// misses every panel — which is most of this app's surface (the orb's
    /// `KeyableNonActivatingPanel`, the outputs panel). Measured, not assumed: the orb pin in
    /// `HarnessQuietTests` failed at alpha 1.0 with only the `NSWindow` swap in place.
    nonisolated(unsafe) private static var originals: [String: IMP] = [:]

    /// Classes whose ordering methods get hooked. Only classes that declare their OWN
    /// implementation are touched (see `hasOwnImplementation`) — swapping an INHERITED method would
    /// reach through and overwrite the superclass's entry a second time, capturing this hook as its
    /// own "original" and recursing forever.
    private static let orderingClasses: [AnyClass] = [NSWindow.self, NSPanel.self]

    /// Called once from `HarnessTeardownObserver.init` at bundle load, before any case runs.
    /// Idempotent: a second call would re-capture the ALREADY-swapped implementation as the
    /// "original" and the ordering hooks would then recurse into themselves.
    static func install() {
        let alreadyInstalled: Bool = lock.withLock {
            if installed { return true }
            installed = true
            return false
        }
        guard !alreadyInstalled else { return }

        // --- Focus: nothing may bring the host forward or take the keyboard ---

        let activateIgnoringOtherApps: @convention(block) (NSApplication, ObjCBool) -> Void = { _, _ in
            countActivation()
        }
        replaceMethod(NSApplication.self, "activateIgnoringOtherApps:", with: activateIgnoringOtherApps)

        let activateModern: @convention(block) (NSApplication) -> Void = { _ in countActivation() }
        replaceMethod(NSApplication.self, "activate", with: activateModern)

        // `ExternalFocusSnapshot.restore()`'s door — this one activates ANOTHER app (whichever was
        // frontmost when the case expanded the field), so it yanks the user out of wherever they
        // have since moved. Returning true reports "activated" to the caller's `!app.activate(...)`
        // fallback so it does not try the second spelling.
        let runningActivate: @convention(block) (NSRunningApplication, UInt) -> ObjCBool = { _, _ in
            countActivation()
            return ObjCBool(true)
        }
        replaceMethod(NSRunningApplication.self, "activateWithOptions:", with: runningActivate)

        // The non-activating panel's keyboard grab — see the type doc: this is a SEPARATE theft
        // from app activation, and the one that eats the user's typing. NOTE the selector: Swift's
        // `NSWindow.makeKey()` is ObjC `makeKeyWindow`, NOT `makeKey` — hooking the Swift spelling
        // silently matches nothing (the `testMakeKeyIsInert` pin caught exactly that).
        let makeKeyWindow: @convention(block) (NSWindow) -> Void = { _ in countKeyGrab() }
        for cls in orderingClasses {
            replaceOwnMethod(cls, "makeKeyWindow", with: makeKeyWindow)
        }

        // Re-expressed as its order-front half alone. Calling `orderFront:` here goes back through
        // the ordering hooks below (an ObjC message send, not a direct call), so the window still
        // really arrives and still gets dimmed — only the key grab is dropped. This never recurses:
        // `orderFront:`'s own hook calls the captured original IMP, not the selector.
        let makeKeyAndOrderFront: @convention(block) (NSWindow, Any?) -> Void = { window, sender in
            countKeyGrab()
            window.orderFront(sender)
        }
        for cls in orderingClasses {
            replaceOwnMethod(cls, "makeKeyAndOrderFront:", with: makeKeyAndOrderFront)
        }

        // --- Visibility: windows arrive, and report visible, but are composited transparent ---

        for cls in orderingClasses {
            let className = NSStringFromClass(cls)

            let frontKey = "\(className).orderFront:"
            if let original = ownImplementation(cls, "orderFront:") {
                originals[frontKey] = original
                let orderFront: @convention(block) (NSWindow, Any?) -> Void = { window, sender in
                    dim(window)
                    if let original = originals[frontKey] {
                        unsafeBitCast(original, to: VoidSelfSenderIMP.self)(
                            window, NSSelectorFromString("orderFront:"), sender
                        )
                    }
                    dim(window)
                }
                replaceMethod(cls, "orderFront:", with: orderFront)
            }

            let regardlessKey = "\(className).orderFrontRegardless"
            if let original = ownImplementation(cls, "orderFrontRegardless") {
                originals[regardlessKey] = original
                let orderFrontRegardless: @convention(block) (NSWindow) -> Void = { window in
                    dim(window)
                    if let original = originals[regardlessKey] {
                        unsafeBitCast(original, to: VoidSelfIMP.self)(
                            window, NSSelectorFromString("orderFrontRegardless")
                        )
                    }
                    dim(window)
                }
                replaceMethod(cls, "orderFrontRegardless", with: orderFrontRegardless)
            }
        }
    }

    // MARK: - Internals

    /// True iff `cls` declares this selector ITSELF rather than inheriting it. The distinction is
    /// load-bearing: `class_getInstanceMethod` happily returns the SUPERCLASS's `Method` for an
    /// inherited selector, and `method_setImplementation` on that would rewrite the superclass's
    /// implementation — so hooking an "inherited" method a second time overwrites the first hook
    /// and makes it its own original, i.e. an infinite loop on the next call.
    private static func hasOwnImplementation(_ cls: AnyClass, _ selector: Selector) -> Bool {
        guard let superclass = class_getSuperclass(cls) else { return true }
        return class_getInstanceMethod(cls, selector) != class_getInstanceMethod(superclass, selector)
    }

    /// The IMP this class's OWN implementation resolves to right now — read before `replaceMethod`
    /// overwrites it, so the ordering hooks capture the genuine AppKit implementation rather than
    /// each other. Nil when the class merely inherits the selector (nothing to hook there: the
    /// superclass hook already covers it).
    private static func ownImplementation(_ cls: AnyClass, _ selectorName: String) -> IMP? {
        let selector = NSSelectorFromString(selectorName)
        guard hasOwnImplementation(cls, selector),
              let method = class_getInstanceMethod(cls, selector) else { return nil }
        return method_getImplementation(method)
    }

    /// `replaceMethod`, but only where the class implements the selector itself.
    private static func replaceOwnMethod(_ cls: AnyClass, _ selectorName: String, with block: Any) {
        guard hasOwnImplementation(cls, NSSelectorFromString(selectorName)) else { return }
        replaceMethod(cls, selectorName, with: block)
    }

    /// Swaps one method's implementation for a block. Silently does nothing if the selector is not
    /// present on this OS — deliberate: a missing spelling is a hook that is not needed, and a
    /// bundle-load crash here would take the whole suite down.
    private static func replaceMethod(_ cls: AnyClass, _ selectorName: String, with block: Any) {
        guard let method = class_getInstanceMethod(cls, NSSelectorFromString(selectorName)) else { return }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }

    /// Composite the window transparent. Idempotent, and skipped entirely for the infrastructure
    /// classes `shouldDim` spares.
    private static func dim(_ window: NSWindow) {
        guard shouldDim(windowClassName: NSStringFromClass(type(of: window))) else { return }
        guard window.alphaValue != 0 else { return }
        window.alphaValue = 0
        countDim()
    }

    private static func countActivation() { lock.withLock { _suppressedActivations += 1 } }
    private static func countKeyGrab() { lock.withLock { _suppressedKeyGrabs += 1 } }
    private static func countDim() { lock.withLock { _dimmedWindows += 1 } }
}
