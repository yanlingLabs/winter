import XCTest
import AppKit

/// panel-cef Task 3: the runtime pin for Norma's entry point.
///
/// This suite exists because the thing it checks has NO compile-time failure mode. Installing a
/// custom `NSApplication` subclass is the one hard prerequisite CEF has of its host
/// (`CefScopedSendingEvent` messages `[NSApp setHandlingSendEvent:]` on whatever `NSApp` is),
/// and the mechanism every CEF sample uses for it — `Info.plist`'s `NSPrincipalClass` — is
/// silently ignored by SwiftUI's `App` lifecycle. Norma shipped `NSPrincipalClass: NSApplication`
/// for its whole life; it compiled, it validated, it launched, and it did nothing. Two written
/// documents believed it worked until someone ran it (`docs/research/2026-08-09-cef-pump.md`).
/// So: a runtime assertion, or no guard at all.
///
/// The pin is deliberately by CLASS NAME rather than `NSApp is NormaApplication`. A bridging
/// header is not a module interface — `NormaApplication` is exposed to the app target's own
/// Swift through `Support/NormaBridge.h`, but `@testable import Norma` does not re-export it, so
/// the test bundle cannot name the type. The string is what the pump report measured and is
/// exactly as load-bearing.
@MainActor
final class NormaApplicationTests: XCTestCase {

    /// `Sources/App/main.swift` must have won the race for the `NSApplication` singleton.
    ///
    /// A failure here means SwiftUI got there first and `NSApp` is a `SwiftUI.AppKitApplication`
    /// — i.e. `@main` came back onto `NormaApp`, `main.swift` was renamed or dropped from the
    /// target, or `NSApplication.shared` stopped dispatching `+sharedApplication` to the
    /// receiving subclass. In that state CEF cannot be initialised at all, and nothing else in
    /// the build or the launch would tell you.
    func testNSAppIsNormaApplicationAndNotSwiftUIsPrivateSubclass() {
        let actual = NSStringFromClass(type(of: NSApp!))
        XCTAssertEqual(
            actual, "NormaApplication",
            "NSApp is \(actual) — main.swift did not claim the NSApplication singleton before "
                + "NormaApp.main(). CEF's CefScopedSendingEvent requires NSApp to answer "
                + "-setHandlingSendEvent:, which a stock NSApplication (or SwiftUI's private "
                + "AppKitApplication) does not. See Sources/App/main.swift."
        )
    }

    /// The `CefAppProtocol` half: `NSApp` must actually answer CEF's two selectors.
    ///
    /// CEF checks CONFORMANCE, not class identity — `CefScopedSendingEvent` casts `NSApp` to
    /// `NSApplication<CefAppProtocol>*` and messages `-isHandlingSendEvent` /
    /// `-setHandlingSendEvent:` on it. So conformance is what this asserts, resolved through the
    /// ObjC runtime by name: the test bundle cannot import `include/cef_application_mac.h` (it is
    /// C++, and deliberately confined to `NormaApplication.mm` so no CEF type reaches Swift), and
    /// `NSProtocolFromString` needs no header. A nil protocol here means the conformance was
    /// dropped from the class extension — clang only emits the protocol record because something
    /// declares it.
    ///
    /// Note what this does NOT require: CEF being present, loaded or initialised.
    /// `CefScopedSendingEvent` is header-inline and compiles to plain ObjC message sends, so the
    /// conformance is live in every build, Debug included.
    func testNSAppConformsToCefAppProtocolSoCefScopedSendingEventCanDriveIt() {
        let cefAppProtocol = NSProtocolFromString("CefAppProtocol")
        XCTAssertNotNil(
            cefAppProtocol,
            "the CefAppProtocol runtime record is missing — nothing in the app declares conformance "
                + "to it any more (NormaApplication.mm's class extension)"
        )
        XCTAssertTrue(
            NSApp!.conforms(to: cefAppProtocol!),
            "NSApp does not conform to CefAppProtocol; CefScopedSendingEvent would message a class "
                + "that cannot answer it"
        )
        XCTAssertTrue(
            NSApp!.responds(to: Selector(("isHandlingSendEvent"))),
            "CrAppProtocol's -isHandlingSendEvent is missing from NSApp"
        )
        XCTAssertTrue(
            NSApp!.responds(to: Selector(("setHandlingSendEvent:"))),
            "CrAppControlProtocol's -setHandlingSendEvent: is missing from NSApp — this is the "
                + "selector CefScopedSendingEvent's constructor and destructor both call"
        )
    }

    /// The deleted key stays deleted.
    ///
    /// Re-adding `NSPrincipalClass` would be worse than useless here: pointed at
    /// `NormaApplication` it would advertise an installation mechanism that provably does not
    /// run under SwiftUI, re-creating the precise false confidence that made the original plan
    /// wrong. `Bundle.main` under a unit test is the TEST HOST's bundle — the real `Norma.app`.
    func testAppBundleDeclaresNoPrincipalClassBecauseSwiftUIWouldIgnoreIt() {
        XCTAssertNil(
            Bundle.main.object(forInfoDictionaryKey: "NSPrincipalClass"),
            "Norma.app declares NSPrincipalClass again. SwiftUI's App.main() ignores it, so it "
                + "cannot install NormaApplication and can only mislead; main.swift is the real "
                + "installation. (The test bundle's own INFOPLIST_KEY_NSPrincipalClass is a "
                + "different, working mechanism and is not what this asserts on.)"
        )
    }
}
