import XCTest
@testable import Norma

final class AppProfileTests: XCTestCase {
    func testProfileConstantsAreConsistent() {
        #if DEBUG
        XCTAssertTrue(AppProfile.isDev)
        XCTAssertEqual(AppProfile.displayName, "Norma Dev")
        XCTAssertTrue(AppProfile.defaultNormaHome.hasSuffix("/.norma-dev"))
        XCTAssertEqual(normaHelperMachServiceName, "com.norma.helper.dev")
        #else
        XCTAssertFalse(AppProfile.isDev)
        XCTAssertEqual(AppProfile.displayName, "Norma")
        XCTAssertTrue(AppProfile.defaultNormaHome.hasSuffix("/.norma"))
        XCTAssertEqual(normaHelperMachServiceName, "com.norma.helper")
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
}
