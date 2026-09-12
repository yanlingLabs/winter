import XCTest
@testable import Winter

/// Lifecycle T6 (T4 review finding 5f): `migrateFromLaunchdAgent` — the Swift mirror of
/// `packages/cli/src/launchd.ts`'s `migrateFromLaunchdAgent`. Entirely seamed via
/// `LaunchdMigrationDeps` (never `.live` here) — these tests never touch a real plist path, spawn
/// a real `launchctl`, or read this machine's real `~/Library/LaunchAgents`.
final class LaunchdMigrationTests: XCTestCase {
    func testNoOpWhenPlistIsAbsent() {
        var bootoutCalled = false
        var removedPaths: [String] = []
        migrateFromLaunchdAgent(deps: LaunchdMigrationDeps(
            plistPath: { "/fake/com.winter.core.plist" },
            exists: { _ in false },
            remove: { removedPaths.append($0) },
            bootout: { bootoutCalled = true }
        ))

        XCTAssertFalse(bootoutCalled, "never installed (or already migrated) — nothing to tear down")
        XCTAssertTrue(removedPaths.isEmpty)
    }

    func testBootsOutThenRemovesWhenPlistIsPresent() {
        var order: [String] = []
        migrateFromLaunchdAgent(deps: LaunchdMigrationDeps(
            plistPath: { "/fake/com.winter.core.plist" },
            exists: { _ in true },
            remove: { path in order.append("remove:\(path)") },
            bootout: { order.append("bootout") }
        ))

        XCTAssertEqual(order, ["bootout", "remove:/fake/com.winter.core.plist"], "bootout must precede remove — a KeepAlive agent that relaunches after the plist is gone would still be alive to do so")
    }

    /// A failing `bootout`/`remove` (permissions, e.g.) must not crash or block the caller —
    /// `migrateFromLaunchdAgent` isn't even a `throws` function, so there's no error path to
    /// swallow: a deps closure that "fails" just does nothing observable, exactly like the real
    /// `NSLog`-and-continue posture in `LaunchdMigrationDeps.live`.
    func testSurvivesANoOpBootoutAndRemove() {
        migrateFromLaunchdAgent(deps: LaunchdMigrationDeps(
            plistPath: { "/fake/com.winter.core.plist" },
            exists: { _ in true },
            remove: { _ in /* no-op, simulating a failed unlink */ },
            bootout: { /* no-op, simulating a failed launchctl bootout */ }
        )) // must not crash
    }
}
