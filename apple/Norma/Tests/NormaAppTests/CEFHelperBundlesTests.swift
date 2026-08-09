import XCTest
import Foundation

/// panel-cef Task 4: the runtime pin for the five CEF helper bundles.
///
/// "Build and land" (the brief's own words) has no compile-time failure mode of its own — a
/// helper target could silently stop being embedded (dropped from the scheme's `build.targets`,
/// the "Embed CEF helpers" postCompileScript's name list drifting from a target's actual
/// PRODUCT_NAME, ...) and nothing would fail to compile. The exact nested path is also load-
/// bearing, not cosmetic: CEF locates each helper by a hardcoded relative-path convention
/// (`cef_scoped_library_loader_mac.mm` walks `../Frameworks/Chromium Embedded Framework...` from
/// the MAIN app, and `../../..` from a HELPER back to the same framework; the browser process
/// launches `Contents/Frameworks/Norma Helper<suffix>.app` by name) — not a preference this test
/// could safely relax.
///
/// `Bundle.main` under this test host is `Norma.app` itself, the real as-built bundle, not a
/// fixture — see `NormaApplicationTests`'s own comment on the same mechanism.
final class CEFHelperBundlesTests: XCTestCase {

    /// Suffixes measured from CEF's own `cmake/cef_variables.cmake:398-404`
    /// (docs/research/2026-08-09-cef-spike.md, correction #1): base, Alerts, GPU, Plugin,
    /// Renderer — five, not the four an earlier plan draft assumed.
    private static let suffixes = ["", " (Alerts)", " (GPU)", " (Plugin)", " (Renderer)"]

    private static var frameworksDir: URL {
        Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks", isDirectory: true)
    }

    func testAllFiveHelperExecutablesLandAtTheExactContractedPath() throws {
        for suffix in Self.suffixes {
            let bundleName = "Norma Helper\(suffix).app"
            let executablePath = Self.frameworksDir
                .appendingPathComponent(bundleName, isDirectory: true)
                .appendingPathComponent("Contents/MacOS/Norma Helper\(suffix)", isDirectory: false)

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
            let bundleName = "Norma Helper\(suffix).app"
            let bundleURL = Self.frameworksDir.appendingPathComponent(bundleName, isDirectory: true)
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
            let bundleName = "Norma Helper\(suffix).app"
            let bundleURL = Self.frameworksDir.appendingPathComponent(bundleName, isDirectory: true)
            let helperBundle = try XCTUnwrap(
                Bundle(url: bundleURL), "could not load helper bundle at \(bundleURL.path)"
            )
            let identifier = try XCTUnwrap(
                helperBundle.bundleIdentifier, "\(bundleName) has no CFBundleIdentifier"
            )
            XCTAssertTrue(
                identifier.hasPrefix("com.norma.app.cefhelper"),
                "\(bundleName)'s bundle id \(identifier) is not under the expected namespace"
            )
            XCTAssertTrue(
                seen.insert(identifier).inserted,
                "duplicate CFBundleIdentifier \(identifier) — \(bundleName) collides with another helper"
            )
        }
    }
}
