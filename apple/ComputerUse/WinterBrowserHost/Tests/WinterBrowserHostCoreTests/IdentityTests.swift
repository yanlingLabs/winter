import Foundation
import WinterBrowserHostCore
import XCTest

final class IdentityTests: XCTestCase {
    private let home = "/Users/someone"
    private func info(_ id: String?) -> (String) -> (bundleId: String?, version: String?) {
        { _ in (id, "1.9.0") }
    }

    func testTheHelperItShipsInDecidesTheProfileHomeAndDaemon() throws {
        let dist = try HostIdentity.resolve(executablePath: "/Applications/Winter.app/Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host",
                                            userHome: home, testHooks: nil, helperInfo: info("com.winter.computeruse"))
        XCTAssertEqual(dist.profile, .dist)
        XCTAssertEqual(dist.socketPath, "/Users/someone/.winter/run/browser.sock")
        XCTAssertEqual(dist.daemonRequirement, #"identifier "winter-core" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
        XCTAssertEqual(dist.allowedExtensionIds, ExtensionIds.dist)
        XCTAssertEqual(dist.hostVersion, "1.9.0")

        let dev = try HostIdentity.resolve(executablePath: "/repo/dist/dev/Winter Computer Use Dev.app/Contents/MacOS/winter-browser-host",
                                           userHome: home, testHooks: nil, helperInfo: info("com.winter.computeruse.dev"))
        XCTAssertEqual(dev.profile, .dev)
        XCTAssertEqual(dev.socketPath, "/Users/someone/.winter-dev/run/browser.sock")
        XCTAssertEqual(dev.daemonRequirement, #"identifier "com.winter.core.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
        XCTAssertEqual(dev.allowedExtensionIds, ["jikdcokcpbacalfeipkognejnlnobbbf"])
    }

    func testOutsideTheHelperAndWithoutTestHooksItRefuses() {
        XCTAssertThrowsError(try HostIdentity.resolve(executablePath: "/tmp/winter-browser-host", userHome: home, testHooks: nil, helperInfo: info(nil))) { error in
            XCTAssertEqual(error as? HostIdentityError, .notInsideTheHelper("/tmp/winter-browser-host"))
        }
        XCTAssertThrowsError(try HostIdentity.resolve(executablePath: "/x/Other.app/Contents/MacOS/winter-browser-host", userHome: home, testHooks: nil, helperInfo: info("com.example.other")))
        XCTAssertThrowsError(try HostIdentity.resolve(executablePath: "/x/Winter Computer Use Test.app/Contents/MacOS/winter-browser-host", userHome: home, testHooks: nil, helperInfo: info("com.winter.computeruse.test"))) { error in
            XCTAssertEqual(error as? HostIdentityError, .testBuildRequired)
        }
    }

    func testATestBuildServesTheHomeAndFakeDaemonItIsGiven() throws {
        let hooks = HostTestHooks(home: "/tmp/wh", daemonRequirement: "always")
        let standalone = try HostIdentity.resolve(executablePath: "/repo/.build/debug/winter-browser-host", userHome: home, testHooks: hooks, helperInfo: info(nil))
        XCTAssertEqual(standalone.profile, .test)
        XCTAssertEqual(standalone.socketPath, "/tmp/wh/run/browser.sock")
        XCTAssertEqual(standalone.daemonRequirement, "always")
        XCTAssertEqual(standalone.allowedExtensionIds, ExtensionIds.dev)
        XCTAssertThrowsError(try HostIdentity.resolve(executablePath: "/repo/.build/debug/winter-browser-host", userHome: home,
                                                      testHooks: HostTestHooks(home: nil, daemonRequirement: "always"), helperInfo: info(nil)))
        XCTAssertThrowsError(try HostIdentity.resolve(executablePath: "/repo/.build/debug/winter-browser-host", userHome: home,
                                                      testHooks: HostTestHooks(home: "/tmp/wh", daemonRequirement: nil), helperInfo: info(nil)))
        XCTAssertThrowsError(try HostIdentity.resolve(executablePath: "/repo/.build/debug/winter-browser-host", userHome: home,
                                                      testHooks: HostTestHooks(home: "relative", daemonRequirement: "always"), helperInfo: info(nil)))
        let inTestHelper = try HostIdentity.resolve(executablePath: "/v/Winter Computer Use Test.app/Contents/MacOS/winter-browser-host", userHome: home,
                                                    testHooks: hooks, helperInfo: info("com.winter.computeruse.test"))
        XCTAssertEqual(inTestHelper.profile, .test)
    }

    func testInsideAnInstalledWinterTheHooksAreIgnored() throws {
        let hooks = HostTestHooks(home: "/tmp/elsewhere", daemonRequirement: "always")
        let installed = try HostIdentity.resolve(executablePath: "/Applications/Winter.app/Contents/Helpers/Winter Computer Use.app/Contents/MacOS/winter-browser-host",
                                                 userHome: home, testHooks: hooks, helperInfo: info("com.winter.computeruse"))
        XCTAssertEqual(installed.socketPath, "/Users/someone/.winter/run/browser.sock")
        XCTAssertNotEqual(installed.daemonRequirement, "always")
        // A test build in a dev helper outside Winter.app may be pointed elsewhere.
        let devTest = try HostIdentity.resolve(executablePath: "/repo/dist/dev/Winter Computer Use Dev.app/Contents/MacOS/winter-browser-host",
                                               userHome: home, testHooks: hooks, helperInfo: info("com.winter.computeruse.dev"))
        XCTAssertEqual(devTest.socketPath, "/tmp/elsewhere/run/browser.sock")
        XCTAssertEqual(devTest.daemonRequirement, "always")
    }

    func testEnclosingApp() {
        XCTAssertEqual(HostIdentity.enclosingApp(executablePath: "/a/B.app/Contents/MacOS/winter-browser-host"), "/a/B.app")
        XCTAssertNil(HostIdentity.enclosingApp(executablePath: "/a/B.app/Contents/Resources/winter-browser-host"))
        XCTAssertNil(HostIdentity.enclosingApp(executablePath: "/usr/local/bin/winter-browser-host"))
        XCTAssertTrue(HostIdentity.isEmbeddedInApp(bundlePath: "/Applications/Winter.app/Contents/Helpers/Winter Computer Use.app"))
        XCTAssertFalse(HostIdentity.isEmbeddedInApp(bundlePath: "/repo/dist/dev/Winter Computer Use Dev.app"))
    }

    func testOrigins() {
        let id = "jikdcokcpbacalfeipkognejnlnobbbf"
        XCTAssertTrue(ExtensionIds.originAllowed("chrome-extension://\(id)/", allowed: [id]))
        for bad in ["chrome-extension://\(id)", "chrome-extension://\(id)/x", "https://\(id)/", "chrome-extension://\(id.uppercased())/",
                    "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/", "", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"] {
            XCTAssertFalse(ExtensionIds.originAllowed(bad, allowed: [id]), bad)
        }
        XCTAssertFalse(ExtensionIds.originAllowed("chrome-extension://\(id)/", allowed: ExtensionIds.dist))
    }

    func testCodeIdentities() {
        XCTAssertEqual(HostCodeIdentity.requirement(identifier: HostCodeIdentity.devHostIdentifier),
                       #"identifier "com.winter.browserhost.dev" and anchor apple generic and certificate leaf[subject.OU] = "37N77U9RSZ""#)
        XCTAssertEqual(HostCodeIdentity.distNativeHostName, "com.winter.browser")
        XCTAssertEqual(HostCodeIdentity.devNativeHostName, "com.winter.browser.dev")
        XCTAssertEqual(HostProtocol.browserHost, 1)
        XCTAssertEqual(HostProtocol.extensionProtocol, 1)
    }
}
