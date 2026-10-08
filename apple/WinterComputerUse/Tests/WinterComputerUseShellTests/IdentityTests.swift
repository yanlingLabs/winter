import Foundation
import WinterComputerUseShell
import XCTest

final class IdentityTests: XCTestCase {
    private var userHome = ""

    override func setUpWithError() throws {
        userHome = try makeTempHome()
        for name in [".winter", ".winter-dev", "elsewhere"] {
            try FileManager.default.createDirectory(atPath: (userHome as NSString).appendingPathComponent(name), withIntermediateDirectories: true)
        }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: userHome)
    }

    private let standalone = "/Users/someone/repo/dist/dev/Winter Computer Use Dev.app"
    private let embedded = "/Applications/Winter.app/Contents/Helpers/Winter Computer Use.app"

    private func resolve(_ bundleId: String?, path: String? = nil, env: [String: String] = [:], hooks: HelperTestHooks? = nil) throws -> HelperIdentity {
        try HelperIdentity.resolve(bundleIdentifier: bundleId, bundlePath: path ?? standalone, environment: env,
                                   userHome: userHome, helperVersion: "0.124.0", testHooks: hooks)
    }

    private func home(_ name: String) -> String { (userHome as NSString).appendingPathComponent(name) }

    func testTheDistHelperServesTheDistHomeAndAcceptsOnlyTheShippedDaemon() throws {
        let id = try resolve("com.winter.computeruse", path: embedded, env: ["WINTER_CU_HOME": home("elsewhere")])
        XCTAssertEqual(id.profile, .dist)
        XCTAssertEqual(id.home, home(".winter"))
        XCTAssertEqual(id.homeSource, "default")
        XCTAssertEqual(id.socketPath, home(".winter") + "/run/computer-use.sock")
        XCTAssertEqual(id.daemonRequirement, #"identifier "winter-core" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
        XCTAssertEqual(id.appRequirement, #"identifier "com.winter.app" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
        XCTAssertEqual(id.idleQuitSeconds, 600)
        // WINTER_CU_HOME is never honoured by the shipped identity, wherever the copy sits.
        XCTAssertEqual(try resolve("com.winter.computeruse", env: ["WINTER_CU_HOME": home("elsewhere")]).home, home(".winter"))
    }

    func testTheDevHelperServesTheDevHomeAndAcceptsTheSignedDevDaemon() throws {
        let id = try resolve("com.winter.computeruse.dev")
        XCTAssertEqual(id.profile, .dev)
        XCTAssertEqual(id.home, home(".winter-dev"))
        XCTAssertEqual(id.daemonRequirement, #"identifier "com.winter.core.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
        XCTAssertEqual(id.appRequirement, #"identifier "com.winter.app.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
    }

    func testWinterCUHomeMovesADevBuildButNotACopyInsideAnApp() throws {
        let moved = try resolve("com.winter.computeruse.dev", env: ["WINTER_CU_HOME": home("elsewhere")])
        XCTAssertEqual(moved.home, home("elsewhere"))
        XCTAssertEqual(moved.homeSource, "WINTER_CU_HOME")
        let installed = try resolve("com.winter.computeruse.dev", path: "/Applications/Winter Dev.app/Contents/Helpers/Winter Computer Use Dev.app",
                                    env: ["WINTER_CU_HOME": home("elsewhere")])
        XCTAssertEqual(installed.home, home(".winter-dev"))
        XCTAssertThrowsError(try resolve("com.winter.computeruse.dev", env: ["WINTER_CU_HOME": "relative/home"])) {
            XCTAssertEqual($0 as? HelperIdentityError, .relativeHome("relative/home"))
        }
    }

    func testTheHelperNeverCreatesAHome() throws {
        try FileManager.default.removeItem(atPath: home(".winter-dev"))
        XCTAssertThrowsError(try resolve("com.winter.computeruse.dev")) {
            XCTAssertEqual($0 as? HelperIdentityError, .homeMissing(self.home(".winter-dev")))
        }
    }

    func testTheTestProfileNeedsATestBuildAFakeDaemonIdentityAndAHome() throws {
        let hooks = HelperTestHooks(daemonRequirement: "always", idleSeconds: 3)
        XCTAssertThrowsError(try resolve("com.winter.computeruse.test", env: ["WINTER_CU_HOME": home("elsewhere")]))
        XCTAssertThrowsError(try resolve("com.winter.computeruse.test", env: ["WINTER_CU_HOME": home("elsewhere")],
                                         hooks: HelperTestHooks(daemonRequirement: nil, idleSeconds: nil)))
        XCTAssertThrowsError(try resolve("com.winter.computeruse.test", hooks: hooks)) {
            XCTAssertEqual($0 as? HelperIdentityError, .missingHomeOverride)
        }
        let id = try resolve("com.winter.computeruse.test", env: ["WINTER_CU_HOME": home("elsewhere")], hooks: hooks)
        XCTAssertEqual(id.profile, .test)
        XCTAssertEqual(id.daemonRequirement, "always")
        XCTAssertEqual(id.appRequirement, "never", "no fake app identity given: no app client")
        XCTAssertEqual(id.idleQuitSeconds, 3)
        let withApp = try resolve("com.winter.computeruse.test", env: ["WINTER_CU_HOME": home("elsewhere")],
                                  hooks: HelperTestHooks(daemonRequirement: "always", idleSeconds: nil, appRequirement: "anchor apple"))
        XCTAssertEqual(withApp.appRequirement, "anchor apple")
    }

    func testTestHooksChangeNothingForTheDevAndDistIdentities() throws {
        let hooks = HelperTestHooks(daemonRequirement: "always", idleSeconds: 3)
        let dev = try resolve("com.winter.computeruse.dev", hooks: hooks)
        XCTAssertEqual(dev.daemonRequirement, WinterCodeIdentity.requirement(identifier: "com.winter.core.dev"))
        XCTAssertEqual(dev.idleQuitSeconds, 600)
        let dist = try resolve("com.winter.computeruse", hooks: hooks)
        XCTAssertEqual(dist.daemonRequirement, WinterCodeIdentity.requirement(identifier: "winter-core"))
    }

    func testAnUnknownBundleRefusesToStart() {
        XCTAssertThrowsError(try resolve("com.example.impostor"))
        XCTAssertThrowsError(try resolve("com.winter.computeruse.xcode-debug"), "an Xcode Debug build of the helper never serves a home")
        XCTAssertThrowsError(try resolve(nil))
    }

    func testCanonicalPathsCompareThroughSymlinks() throws {
        let link = home("link")
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: home(".winter-dev"))
        XCTAssertEqual(HelperIdentity.canonicalPath(link), HelperIdentity.canonicalPath(home(".winter-dev")))
        XCTAssertEqual(HelperIdentity.canonicalPath("/tmp"), "/private/tmp")
        XCTAssertNil(HelperIdentity.canonicalPath(home("nope")))
    }

    func testOnlyTheContentsHelpersShapeCountsAsInstalled() {
        XCTAssertTrue(HelperIdentity.isEmbeddedInApp(bundlePath: embedded))
        XCTAssertTrue(HelperIdentity.isEmbeddedInApp(bundlePath: embedded + "/"))
        XCTAssertFalse(HelperIdentity.isEmbeddedInApp(bundlePath: standalone))
        XCTAssertFalse(HelperIdentity.isEmbeddedInApp(bundlePath: "/x/Helpers/Winter Computer Use.app"))
        XCTAssertFalse(HelperIdentity.isEmbeddedInApp(bundlePath: "/x/Winter.app/Contents/MacOS/Winter Computer Use.app"))
    }
}
