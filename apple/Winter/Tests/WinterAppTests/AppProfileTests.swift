import XCTest
import WinterKit
@testable import Winter

final class AppProfileTests: XCTestCase {
    func testProfileConstantsAreConsistent() {
        #if DEBUG
        XCTAssertTrue(AppProfile.isDev)
        XCTAssertEqual(AppProfile.displayName, "Winter Dev")
        XCTAssertTrue(AppProfile.defaultWinterHome.hasSuffix("/.winter-dev"))
        XCTAssertEqual(winterHelperMachServiceName, "com.winter.helper.dev")
        XCTAssertEqual(AppProfile.keychainService, "com.winter.core.dev")
        #else
        XCTAssertFalse(AppProfile.isDev)
        XCTAssertEqual(AppProfile.displayName, "Winter")
        XCTAssertTrue(AppProfile.defaultWinterHome.hasSuffix("/.winter"))
        XCTAssertEqual(winterHelperMachServiceName, "com.winter.helper")
        XCTAssertEqual(AppProfile.keychainService, "com.winter.core")
        #endif
    }

    func testBootstrapRespectsExistingEnv() {
        // An explicit WINTER_HOME in the env must always win (tests, power users).
        setenv("WINTER_HOME", "/tmp/dd-apptest-home", 1)
        AppProfile.bootstrapEnvironment()
        XCTAssertEqual(ProcessInfo.processInfo.environment["WINTER_HOME"], "/tmp/dd-apptest-home")
        unsetenv("WINTER_HOME")
        // DD branch review rider: leave WINTER_PROFILE exactly as clean as WINTER_HOME above — this
        // test process's env must not leak a stray WINTER_PROFILE into whichever test runs next.
        unsetenv("WINTER_PROFILE")
    }

    // MARK: - winterHome / socket resolution (devfix, socket strand)

    /// No explicit override present (the common case, and every other test here cleans up after
    /// itself) — `winterHome` must equal this profile's own compiled-in default.
    func testWinterHomeDefaultsToProfileHomeWhenUnset() {
        XCTAssertNil(ProcessInfo.processInfo.environment["WINTER_HOME"])
        XCTAssertEqual(AppProfile.winterHome, AppProfile.defaultWinterHome)
    }

    /// An explicit `WINTER_HOME` always wins — same precedence `bootstrapEnvironment()` promises,
    /// but read via the raw POSIX `getenv`/`setenv` pair rather than `ProcessInfo.environment`
    /// (the live-gate-found discrepancy: the two are not guaranteed to agree in a real app-bundle
    /// process the way they do in a bare script).
    func testWinterHomeRespectsExplicitOverride() {
        setenv("WINTER_HOME", "/tmp/dd-winterhome-override", 1)
        defer { unsetenv("WINTER_HOME") }
        XCTAssertEqual(AppProfile.winterHome, "/tmp/dd-winterhome-override")
    }

    /// Both profiles must resolve to THEIR OWN socket, not the other profile's — the exact bug the
    /// live gate caught: a dev app dialing `~/.winter/run/core.sock` (dist).
    func testSocketPathDerivedFromWinterHomeMatchesProfile() {
        let socket = WinterPaths.socketPath(home: AppProfile.winterHome)
        #if DEBUG
        XCTAssertTrue(socket.hasSuffix("/.winter-dev/run/core.sock"))
        #else
        XCTAssertTrue(socket.hasSuffix("/.winter/run/core.sock"))
        XCTAssertFalse(socket.contains(".winter-dev"))
        #endif
    }
}
