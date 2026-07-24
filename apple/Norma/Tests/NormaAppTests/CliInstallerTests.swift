import XCTest
@testable import Norma

// `CliInstaller` is `@MainActor` (it's an AppKit-adjacent installer — NSAlert, Bundle.main), so
// `plan()` — though pure — is main-actor-isolated too; a nonisolated test method can't call it
// synchronously. Same explicit-`@MainActor` posture as the sibling `CliLauncherTests`.
@MainActor
final class CliInstallerTests: XCTestCase {
    private let target = "/Applications/Norma.app/Contents/Resources/norma-core"

    func testPlanFreshInstall() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: nil, isSymlink: false, symlinkTarget: nil, expectedTarget: target), .install)
    }
    func testPlanHealthy() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/norma", isSymlink: true, symlinkTarget: target, expectedTarget: target), .alreadyInstalled)
    }
    func testPlanBrokenOrMovedSymlinkRepairs() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/norma", isSymlink: true, symlinkTarget: "/Applications/Old.app/x", expectedTarget: target), .repair)
    }
    func testPlanForeignFileRefused() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/norma", isSymlink: false, symlinkTarget: nil, expectedTarget: target), .refuseForeign("/usr/local/bin/norma"))
    }
    func testSymlinkIntoAnyNormaAppCountsAsOursForRepair() {
        XCTAssertEqual(CliInstaller.plan(existingDestination: "/usr/local/bin/norma", isSymlink: true, symlinkTarget: "/somewhere/Norma.app/Contents/Resources/norma-core", expectedTarget: target), .repair)
    }
}
