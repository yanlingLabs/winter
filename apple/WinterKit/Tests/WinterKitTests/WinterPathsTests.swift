import XCTest
@testable import WinterKit

/// devfix (socket strand): `WinterPaths.socketPath()`/`settingsPath()` derive `$WINTER_HOME ?? ~/.winter`
/// independently at each call site — the SAME independent-re-derivation shape as the keychain-service
/// bug this follows. The `home:`-taking overloads let a caller that has ALREADY resolved its own
/// profile-correct home (e.g. the app's `AppProfile.winterHome`) pass it explicitly instead of trusting
/// this type to agree. Pure string-joining, no env/filesystem touched — no seam needed beyond the
/// parameter itself.
final class WinterPathsTests: XCTestCase {
    func testSocketPathWithExplicitHome() {
        XCTAssertEqual(WinterPaths.socketPath(home: "/tmp/winter-home"), "/tmp/winter-home/run/core.sock")
    }

    func testSettingsPathWithExplicitHome() {
        XCTAssertEqual(WinterPaths.settingsPath(home: "/tmp/winter-home"), "/tmp/winter-home/settings.json")
    }

    /// The no-arg overloads must keep resolving through `homeDirectory()` unchanged — every
    /// pre-existing dist caller (DaemonSupervisor, CliInstaller, UpdaterCoordinator) still compiles
    /// and behaves exactly as before this devfix.
    func testNoArgOverloadsStillMatchHomeDirectory() {
        XCTAssertEqual(WinterPaths.socketPath(), WinterPaths.socketPath(home: WinterPaths.homeDirectory()))
        XCTAssertEqual(WinterPaths.settingsPath(), WinterPaths.settingsPath(home: WinterPaths.homeDirectory()))
    }
}
