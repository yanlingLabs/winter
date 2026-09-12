import Darwin
import Foundation

// -----------------------------------------------------------------------------------------------
// Lifecycle T6 (T4 review finding 5f): tears down the OLD `com.norma.core` launchd `KeepAlive`
// agent (`packages/cli/src/launchd.ts`'s pre-rename `installDaemon`) — superseded by
// `DaemonSupervisor` embedding winter-core directly (Task 2). A leftover KeepAlive agent would
// otherwise relaunch a daemon the app just killed, permanently defeating "app quit -> daemon
// quit" for that user, so this MUST complete before `DaemonSupervisor.start()`'s socket-exists
// probe — see the call site (`AppDelegate.boot()`, which runs this first, before constructing the
// supervisor).
//
// Winter Phase 9b (P9b-6): this teardown targets the HISTORICAL launchd label from BEFORE the
// Norma->Winter rename, not this app's current identity — `LegacyNames.launchdAgentLabel` is
// `"com.norma.core"` deliberately, never rewritten to `"com.winter.core"`. A machine that never
// ran a pre-rename build simply has no such agent installed, and this stays a no-op for it.
// -----------------------------------------------------------------------------------------------

private let launchdAgentLabel = LegacyNames.launchdAgentLabel

/// Injectable seam mirroring `launchd.ts`'s `MigrateLaunchdDeps` — production defaults touch the
/// real filesystem/launchctl; tests supply fakes/spies so migration never runs against a real
/// user's home directory or launchd from the test process.
struct LaunchdMigrationDeps {
    var plistPath: () -> String
    var exists: (String) -> Bool
    var remove: (String) -> Void
    var bootout: () -> Void
}

extension LaunchdMigrationDeps {
    static let live = LaunchdMigrationDeps(
        plistPath: {
            (NSHomeDirectory() as NSString).appendingPathComponent("Library/LaunchAgents/\(launchdAgentLabel).plist")
        },
        exists: { FileManager.default.fileExists(atPath: $0) },
        remove: { path in try? FileManager.default.removeItem(atPath: path) },
        bootout: {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["bootout", "gui/\(getuid())/\(launchdAgentLabel)"]
            do {
                try process.run()
                // Blocks the calling (main) thread briefly — deliberate: the caller's contract is
                // that migration COMPLETES before it proceeds to the supervisor's socket probe, and
                // `launchctl bootout` returns promptly either way (loaded or not).
                process.waitUntilExit()
            } catch {
                NSLog("[LaunchdMigration] launchctl bootout failed to launch: \(error)")
            }
        }
    )
}

/// No-op if the plist was never installed (fresh installs, or a machine already migrated). NEVER
/// throws — a failed bootout/remove (permissions, already gone, etc.) must not block the app from
/// starting. Mirrors `launchd.ts`'s `migrateFromLaunchdAgent` exactly: same label, same plist path,
/// same bootout-then-remove order.
func migrateFromLaunchdAgent(deps: LaunchdMigrationDeps = .live) {
    let path = deps.plistPath()
    guard deps.exists(path) else { return }
    deps.bootout()
    deps.remove(path)
}
