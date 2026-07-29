import XCTest
@testable import NormaKit

/// devfix (socket strand): `NormaPaths.socketPath()`/`settingsPath()` derive `$NORMA_HOME ?? ~/.norma`
/// independently at each call site — the SAME independent-re-derivation shape as the keychain-service
/// bug this follows. The `home:`-taking overloads let a caller that has ALREADY resolved its own
/// profile-correct home (e.g. the app's `AppProfile.normaHome`) pass it explicitly instead of trusting
/// this type to agree. Pure string-joining, no env/filesystem touched — no seam needed beyond the
/// parameter itself.
final class NormaPathsTests: XCTestCase {
    func testSocketPathWithExplicitHome() {
        XCTAssertEqual(NormaPaths.socketPath(home: "/tmp/norma-home"), "/tmp/norma-home/run/core.sock")
    }

    func testSettingsPathWithExplicitHome() {
        XCTAssertEqual(NormaPaths.settingsPath(home: "/tmp/norma-home"), "/tmp/norma-home/settings.json")
    }

    /// The no-arg overloads must keep resolving through `homeDirectory()` unchanged — every
    /// pre-existing dist caller (DaemonSupervisor, CliInstaller, UpdaterCoordinator) still compiles
    /// and behaves exactly as before this devfix.
    func testNoArgOverloadsStillMatchHomeDirectory() {
        XCTAssertEqual(NormaPaths.socketPath(), NormaPaths.socketPath(home: NormaPaths.homeDirectory()))
        XCTAssertEqual(NormaPaths.settingsPath(), NormaPaths.settingsPath(home: NormaPaths.homeDirectory()))
    }
}
