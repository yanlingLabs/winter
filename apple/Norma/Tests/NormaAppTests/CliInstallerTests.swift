import XCTest
@testable import Winter

// `CliInstaller` is `@MainActor` (it's an AppKit-adjacent installer — NSAlert, Bundle.main), so
// `plan()` — though pure — is main-actor-isolated too; a nonisolated test method can't call it
// synchronously. Same explicit-`@MainActor` posture as the sibling `CliLauncherTests`.
@MainActor
final class CliInstallerTests: XCTestCase {
    private let target = "/Applications/Winter.app/Contents/Resources/winter-core"

    func testPlanFreshInstall() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: nil, isSymlink: false, symlinkTarget: nil, expectedTarget: target), .install)
    }
    func testPlanHealthy() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/winter", isSymlink: true, symlinkTarget: target, expectedTarget: target), .alreadyInstalled)
    }
    func testPlanBrokenOrMovedSymlinkRepairs() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/winter", isSymlink: true, symlinkTarget: "/Volumes/Old/Winter.app/Contents/Resources/winter-core", expectedTarget: target), .repair)
    }
    func testPlanForeignFileRefused() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/winter", isSymlink: false, symlinkTarget: nil, expectedTarget: target), .refuseForeign("/usr/local/bin/winter"))
    }
    func testSymlinkIntoAnyWinterAppCountsAsOursForRepair() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/winter", isSymlink: true, symlinkTarget: "/somewhere/Winter.app/Contents/Resources/winter-core", expectedTarget: target), .repair)
    }
    func testPlanForeignSymlinkRefused() {
        XCTAssertEqual(
            CliInstaller.plan(existingDestination: "/usr/local/bin/winter", isSymlink: true, symlinkTarget: "/Users/me/mytools/winter", expectedTarget: target),
            .refuseForeign("/usr/local/bin/winter"))
    }

    // MARK: - DD branch review (I2): winterOnPath's LaunchServices PATH gap
    //
    // A real GUI-launched process's `PATH` is LaunchServices' minimal
    // `/usr/bin:/bin:/usr/sbin:/sbin` — it never contains brew's `/usr/local/bin`/
    // `/opt/homebrew/bin`. These tests stand up a temp directory with an actual executable
    // literally named `winter` so they never depend on brew (or any real `winter`) being installed
    // on the test host, and never touch the real `/usr/local/bin`/`/opt/homebrew/bin`.

    private func makeFakeWinterDir() -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("CliInstallerTests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let binary = dir.appendingPathComponent("winter")
        try! Data().write(to: binary)
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        return dir.path
    }

    /// The regression itself: a literal LaunchServices-minimal PATH, with `extraDirs` pointing
    /// nowhere real, must not report `winter` as found. Deliberately does NOT pass the real
    /// production `extraDirs` default here (this dev machine may have a real brew-linked `winter`
    /// at `/opt/homebrew/bin` from separate testing) — a nonexistent fake dir isolates the
    /// assertion from that.
    func testWinterOnPathFalseWhenNowhereOnPathOrExtraDirs() {
        let fakeDir = FileManager.default.temporaryDirectory.appendingPathComponent("CliInstallerTests-empty-\(UUID().uuidString)").path
        XCTAssertFalse(CliInstaller.winterOnPath(pathVar: "/usr/bin:/bin:/usr/sbin:/sbin", extraDirs: [fakeDir]))
    }

    /// The fix: even when PATH itself (LaunchServices-minimal) has nothing, a working `winter`
    /// living in one of the hardcoded `extraDirs` must still be found.
    func testWinterOnPathTrueWhenOnlyInExtraDirs() {
        let fakeDir = makeFakeWinterDir()
        defer { try? FileManager.default.removeItem(atPath: fakeDir) }
        XCTAssertTrue(CliInstaller.winterOnPath(pathVar: "/usr/bin:/bin:/usr/sbin:/sbin", extraDirs: [fakeDir]))
    }

    /// `winter` found via PATH itself (not an extra dir) must also be found — the fix adds to the
    /// scan, it doesn't replace PATH scanning.
    func testWinterOnPathTrueWhenOnPathVar() {
        let fakeDir = makeFakeWinterDir()
        defer { try? FileManager.default.removeItem(atPath: fakeDir) }
        XCTAssertTrue(CliInstaller.winterOnPath(pathVar: "/usr/bin:\(fakeDir):/bin", extraDirs: []))
    }

    /// A nil PATH (never actually happens for a real process, but the seam accepts it) must not
    /// crash and must still fall through to `extraDirs`.
    func testWinterOnPathHandlesNilPathVar() {
        let fakeDir = makeFakeWinterDir()
        defer { try? FileManager.default.removeItem(atPath: fakeDir) }
        XCTAssertFalse(CliInstaller.winterOnPath(pathVar: nil, extraDirs: []))
        XCTAssertTrue(CliInstaller.winterOnPath(pathVar: nil, extraDirs: [fakeDir]))
    }
}
