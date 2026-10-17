import Foundation
import XCTest
@testable import Winter

/// Where Winter.app's own CEF finds its Chromium (`WinterChromium`): the nested Winter Headless helper's
/// `Contents/Frameworks` — pure path arithmetic, checked with no CEF and no file system.
final class WinterChromiumTests: XCTestCase {
    private let app = URL(fileURLWithPath: "/Applications/Winter.app")
    private func existing(_ paths: [String]) -> (String) -> Bool { { paths.contains($0) } }
    private func chromium(in helper: String) -> [String] {
        let frameworks = "/Applications/Winter.app/Contents/Helpers/\(helper)/Contents/Frameworks"
        return ["\(frameworks)/Chromium Embedded Framework.framework/Chromium Embedded Framework",
                "\(frameworks)/Winter Helper.app/Contents/MacOS/Winter Helper"]
    }

    func testAReleaseBuildRunsItsCEFFromTheNestedHelpersFrameworks() throws {
        let location = try XCTUnwrap(WinterChromium.location(appBundle: app, exists: existing(chromium(in: "Winter Headless.app"))))
        XCTAssertEqual(location.framework.path,
                       "/Applications/Winter.app/Contents/Helpers/Winter Headless.app/Contents/Frameworks/Chromium Embedded Framework.framework")
        XCTAssertEqual(location.subprocessExecutable.path,
                       "/Applications/Winter.app/Contents/Helpers/Winter Headless.app/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper")
        XCTAssertEqual(location.executable(of: "Winter Helper (Renderer)").path,
                       "/Applications/Winter.app/Contents/Helpers/Winter Headless.app/Contents/Frameworks/Winter Helper (Renderer).app/Contents/MacOS/Winter Helper (Renderer)")
    }

    func testWinterDevRunsItsCEFFromItsOwnNestedHelperTheSameWay() throws {
        let location = try XCTUnwrap(WinterChromium.location(appBundle: app, exists: existing(chromium(in: "Winter Headless Dev.app"))))
        XCTAssertEqual(location.frameworks.path, "/Applications/Winter.app/Contents/Helpers/Winter Headless Dev.app/Contents/Frameworks")
    }

    /// The old layout (Winter.app's own Contents/Frameworks) is never read: there is no second copy to fall back to.
    func testWintersOwnFrameworksAreNeverRead() {
        let old = ["/Applications/Winter.app/Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
                   "/Applications/Winter.app/Contents/Frameworks/Winter Helper.app/Contents/MacOS/Winter Helper"]
        XCTAssertNil(WinterChromium.location(appBundle: app, exists: existing(old)))
    }

    func testAHelperMissingItsSubprocessOrFrameworkIsNoLocation() {
        XCTAssertNil(WinterChromium.location(appBundle: app, exists: existing([chromium(in: "Winter Headless.app")[0]])))
        XCTAssertNil(WinterChromium.location(appBundle: app, exists: existing([chromium(in: "Winter Headless.app")[1]])))
        XCTAssertNil(WinterChromium.location(appBundle: app, exists: { _ in false }))
    }

    func testTheFiveSubprocessBundlesAreChromiumsOwnRoles() {
        XCTAssertEqual(WinterChromium.subprocessBundleNames,
                       ["Winter Helper", "Winter Helper (Alerts)", "Winter Helper (GPU)", "Winter Helper (Plugin)", "Winter Helper (Renderer)"])
    }
}
