import XCTest
import Foundation
@testable import Winter

/// panel-cef Task 4: the runtime pin for the five CEF helper bundles — which, since the user's ruling
/// on ONE Chromium, live in the nested Winter Headless helper's `Contents/Frameworks` beside the
/// framework (`WinterChromium`), never in Winter.app's own.
///
/// "Build and land" (the brief's own words) has no compile-time failure mode of its own — a
/// helper target could silently stop being embedded (dropped from the WinterHeadless target's
/// dependencies, the "Embed Winter's Chromium" postCompileScript's name list drifting from a
/// target's actual PRODUCT_NAME, ...) and nothing would fail to compile. The relative layout is
/// also load-bearing, not cosmetic: a HELPER finds the framework at `../../..` from its own
/// executable (`cef_scoped_library_loader_mac.mm`), and the browser process launches
/// `<frameworks>/Winter Helper<suffix>.app` by name — not a preference this test could safely relax.
///
/// `Bundle.main` under this test host is `Winter.app` itself, the real as-built bundle, not a
/// fixture — see `WinterApplicationTests`'s own comment on the same mechanism.
final class CEFHelperBundlesTests: XCTestCase {

    /// Suffixes measured from CEF's own `cmake/cef_variables.cmake:398-404`
    /// (docs/research/2026-08-09-cef-spike.md, correction #1): base, Alerts, GPU, Plugin,
    /// Renderer — five, not the four an earlier plan draft assumed.
    private static let suffixes = ["", " (Alerts)", " (GPU)", " (Plugin)", " (Renderer)"]

    private static var frameworksDir: URL {
        get throws {
            try XCTUnwrap(WinterChromium.location(appBundle: Bundle.main.bundleURL),
                          "no Chromium in the nested Winter Headless helper of \(Bundle.main.bundleURL.path)").frameworks
        }
    }

    /// ONE Chromium: the nested helper carries it, and Winter.app's own Contents/Frameworks holds none of it.
    func testTheOneChromiumIsInTheNestedHelperAndNotInWintersOwnFrameworks() throws {
        let frameworks = try Self.frameworksDir
        XCTAssertEqual(frameworks.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().lastPathComponent,
                       "Helpers", "the Chromium is not in a nested helper: \(frameworks.path)")
        let own = Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks", isDirectory: true)
        for name in [WinterChromium.frameworkName] + WinterChromium.subprocessBundleNames.map({ "\($0).app" }) {
            XCTAssertFalse(FileManager.default.fileExists(atPath: own.appendingPathComponent(name).path),
                           "a second Chromium: \(name) is in Winter.app's own Contents/Frameworks")
        }
    }

    func testAllFiveHelperExecutablesLandAtTheExactContractedPath() throws {
        for suffix in Self.suffixes {
            let bundleName = "Winter Helper\(suffix).app"
            let executablePath = try Self.frameworksDir
                .appendingPathComponent(bundleName, isDirectory: true)
                .appendingPathComponent("Contents/MacOS/Winter Helper\(suffix)", isDirectory: false)

            var isDirectory: ObjCBool = false
            let exists = FileManager.default.fileExists(
                atPath: executablePath.path, isDirectory: &isDirectory
            )
            XCTAssertTrue(
                exists && !isDirectory.boolValue,
                "missing helper executable at the exact contracted path: \(executablePath.path) "
                    + "— CEF looks there by convention, not preference (Task 4 brief)"
            )
        }
    }

    /// Every helper Info.plist must keep `LSUIElement` — a helper bundle showing up in the Dock
    /// or Cmd-Tab would be an immediately visible regression, five times over.
    func testAllFiveHelpersAreUIElementsWithNoDockPresence() throws {
        for suffix in Self.suffixes {
            let bundleName = "Winter Helper\(suffix).app"
            let bundleURL = try Self.frameworksDir.appendingPathComponent(bundleName, isDirectory: true)
            let helperBundle = try XCTUnwrap(
                Bundle(url: bundleURL), "could not load helper bundle at \(bundleURL.path)"
            )
            XCTAssertEqual(
                helperBundle.object(forInfoDictionaryKey: "LSUIElement") as? Bool, true,
                "\(bundleName) is missing LSUIElement — it would show a Dock icon"
            )
        }
    }

    /// Each of the five must resolve to a DISTINCT bundle identifier — CEF doesn't care, but two
    /// co-installed bundles sharing one CFBundleIdentifier is its own class of macOS bug
    /// (LaunchServices/Spotlight registration), and it's exactly the kind of thing that silently
    /// works in a single ad-hoc build and breaks later.
    func testAllFiveHelpersHaveDistinctBundleIdentifiers() throws {
        var seen = Set<String>()
        for suffix in Self.suffixes {
            let bundleName = "Winter Helper\(suffix).app"
            let bundleURL = try Self.frameworksDir.appendingPathComponent(bundleName, isDirectory: true)
            let helperBundle = try XCTUnwrap(
                Bundle(url: bundleURL), "could not load helper bundle at \(bundleURL.path)"
            )
            let identifier = try XCTUnwrap(
                helperBundle.bundleIdentifier, "\(bundleName) has no CFBundleIdentifier"
            )
            XCTAssertTrue(
                identifier.hasPrefix("com.winter.app.cefhelper"),
                "\(bundleName)'s bundle id \(identifier) is not under the expected namespace"
            )
            XCTAssertTrue(
                seen.insert(identifier).inserted,
                "duplicate CFBundleIdentifier \(identifier) — \(bundleName) collides with another helper"
            )
        }
    }
}
