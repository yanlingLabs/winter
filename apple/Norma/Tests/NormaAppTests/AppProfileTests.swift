import XCTest
import NormaKit
@testable import Norma

final class AppProfileTests: XCTestCase {
    func testProfileConstantsAreConsistent() {
        #if DEBUG
        XCTAssertTrue(AppProfile.isDev)
        XCTAssertEqual(AppProfile.displayName, "Norma Dev")
        XCTAssertTrue(AppProfile.defaultNormaHome.hasSuffix("/.norma-dev"))
        XCTAssertEqual(normaHelperMachServiceName, "com.norma.helper.dev")
        XCTAssertEqual(AppProfile.keychainService, "com.norma.core.dev")
        #else
        XCTAssertFalse(AppProfile.isDev)
        XCTAssertEqual(AppProfile.displayName, "Norma")
        XCTAssertTrue(AppProfile.defaultNormaHome.hasSuffix("/.norma"))
        XCTAssertEqual(normaHelperMachServiceName, "com.norma.helper")
        XCTAssertEqual(AppProfile.keychainService, "com.norma.core")
        #endif
    }

    func testBootstrapRespectsExistingEnv() {
        // An explicit NORMA_HOME in the env must always win (tests, power users).
        setenv("NORMA_HOME", "/tmp/dd-apptest-home", 1)
        AppProfile.bootstrapEnvironment()
        XCTAssertEqual(ProcessInfo.processInfo.environment["NORMA_HOME"], "/tmp/dd-apptest-home")
        unsetenv("NORMA_HOME")
        // DD branch review rider: leave NORMA_PROFILE exactly as clean as NORMA_HOME above — this
        // test process's env must not leak a stray NORMA_PROFILE into whichever test runs next.
        unsetenv("NORMA_PROFILE")
    }

    // MARK: - normaHome / socket resolution (devfix, socket strand)

    /// No explicit override present (the common case, and every other test here cleans up after
    /// itself) — `normaHome` must equal this profile's own compiled-in default.
    func testNormaHomeDefaultsToProfileHomeWhenUnset() {
        XCTAssertNil(ProcessInfo.processInfo.environment["NORMA_HOME"])
        XCTAssertEqual(AppProfile.normaHome, AppProfile.defaultNormaHome)
    }

    /// An explicit `NORMA_HOME` always wins — same precedence `bootstrapEnvironment()` promises,
    /// but read via the raw POSIX `getenv`/`setenv` pair rather than `ProcessInfo.environment`
    /// (the live-gate-found discrepancy: the two are not guaranteed to agree in a real app-bundle
    /// process the way they do in a bare script).
    func testNormaHomeRespectsExplicitOverride() {
        setenv("NORMA_HOME", "/tmp/dd-normahome-override", 1)
        defer { unsetenv("NORMA_HOME") }
        XCTAssertEqual(AppProfile.normaHome, "/tmp/dd-normahome-override")
    }

    /// Both profiles must resolve to THEIR OWN socket, not the other profile's — the exact bug the
    /// live gate caught: a dev app dialing `~/.norma/run/core.sock` (dist).
    func testSocketPathDerivedFromNormaHomeMatchesProfile() {
        let socket = NormaPaths.socketPath(home: AppProfile.normaHome)
        #if DEBUG
        XCTAssertTrue(socket.hasSuffix("/.norma-dev/run/core.sock"))
        #else
        XCTAssertTrue(socket.hasSuffix("/.norma/run/core.sock"))
        XCTAssertFalse(socket.contains(".norma-dev"))
        #endif
    }
}
