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

    // ── the live suite's test instance (`bun run e2e:cu-live`) ───────────────────────────────────────────────
    private let devDaemon = #"identifier "com.winter.core.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#
    private let devApp = #"identifier "com.winter.app.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#
    private let testDaemon = #"identifier "com.winter.core.cutest" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#
    private let testApp = #"identifier "com.winter.app.cutest" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#

    /// A fake temp dir with a live run dir (and its home) and a look-alike outside it.
    private func liveDirs() throws -> (temp: String, liveHome: String) {
        let temp = home("tmp")
        let liveHome = (temp as NSString).appendingPathComponent("winter-cu-live-abc123/home")
        try FileManager.default.createDirectory(atPath: liveHome, withIntermediateDirectories: true)
        return (temp, liveHome)
    }

    private func resolveDev(env: [String: String], temp: String, path: String? = nil) throws -> HelperIdentity {
        try HelperIdentity.resolve(bundleIdentifier: "com.winter.computeruse.dev", bundlePath: path ?? standalone, environment: env,
                                   userHome: userHome, helperVersion: "0.124.0", testHooks: nil, temporaryDirectory: temp)
    }

    func testADevHelperForALiveTestHomeAcceptsOnlyTheTestIdentities() throws {
        let (temp, liveHome) = try liveDirs()
        let id = try resolveDev(env: ["WINTER_CU_HOME": liveHome], temp: temp)
        XCTAssertTrue(id.liveTest)
        XCTAssertEqual(id.daemonRequirement, testDaemon)
        XCTAssertEqual(id.appRequirement, testApp)
    }

    func testTheNormalDevHelperKeepsRejectingTheTestIdentities() throws {
        let (temp, liveHome) = try liveDirs()
        // The default dev home, another WINTER_CU_HOME, a look-alike outside the temp dir, the run dir itself, a
        // marker-less temp dir, and a copy installed inside an app (WINTER_CU_HOME ignored): all keep the dev rule.
        let lookAlike = home("winter-cu-live-xyz/home")
        let runDirOnly = (temp as NSString).appendingPathComponent("winter-cu-live-abc123")
        let plainTemp = (temp as NSString).appendingPathComponent("not-live/home")
        for path in [lookAlike, plainTemp] { try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true) }
        let cases: [(String, [String: String], String?)] = [
            ("the default dev home", [:], nil),
            ("another WINTER_CU_HOME", ["WINTER_CU_HOME": home("elsewhere")], nil),
            ("a look-alike outside the temp dir", ["WINTER_CU_HOME": lookAlike], nil),
            ("the run dir itself", ["WINTER_CU_HOME": runDirOnly], nil),
            ("a temp home without the marker", ["WINTER_CU_HOME": plainTemp], nil),
            ("a copy inside an app", ["WINTER_CU_HOME": liveHome], "/Applications/Winter Dev.app/Contents/Helpers/Winter Computer Use Dev.app"),
        ]
        for (name, env, path) in cases {
            let id = try resolveDev(env: env, temp: temp, path: path)
            XCTAssertFalse(id.liveTest, name)
            XCTAssertEqual(id.daemonRequirement, devDaemon, name)
            XCTAssertEqual(id.appRequirement, devApp, name)
            XCTAssertFalse(id.daemonRequirement.contains("cutest"), name)
        }
        // The shipped helper never: not even for a live-test home.
        let dist = try HelperIdentity.resolve(bundleIdentifier: "com.winter.computeruse", bundlePath: standalone, environment: ["WINTER_CU_HOME": liveHome],
                                              userHome: userHome, helperVersion: "0.124.0", testHooks: nil, temporaryDirectory: temp)
        XCTAssertFalse(dist.liveTest)
        XCTAssertFalse(dist.daemonRequirement.contains("cutest"))
    }

    func testTheLiveTestHomeRuleItself() throws {
        let (temp, liveHome) = try liveDirs()
        XCTAssertTrue(HelperIdentity.isLiveTestHome(HelperIdentity.canonicalPath(liveHome)!, temporaryDirectory: temp))
        XCTAssertFalse(HelperIdentity.isLiveTestHome(HelperIdentity.canonicalPath(liveHome)!, temporaryDirectory: home("elsewhere")))
        XCTAssertFalse(HelperIdentity.isLiveTestHome(HelperIdentity.canonicalPath(temp)!, temporaryDirectory: temp))
        XCTAssertFalse(HelperIdentity.isLiveTestHome("/x/winter-cu-live-/home", temporaryDirectory: "/x"))
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
