import AppKit
import Foundation
import NormaKit

enum CliInstallAction: Equatable {
    case install, repair, alreadyInstalled
    case refuseForeign(String)
}

/// Distribution-build installer for the global `norma` command:
/// `/usr/local/bin/norma -> <Norma.app>/Contents/Resources/norma-core`. The app-bundle path is
/// stable across Sparkle updates, so the symlink survives them. Pure decision core + thin
/// effectful shell; the admin fallback (osascript "with administrator privileges") runs only
/// when the direct filesystem write fails.
///
/// DEV builds never call any of the effectful entry points here (`install()`/
/// `offerOnFirstLaunchIfNeeded()` short-circuit, and `MenuBarController` never mounts the menu
/// item that would fire `install()`) — dev's own CLI story is `CliLauncher`'s `norma-dev` wrapper
/// (Task 6). This is the DISTRIBUTION app's `norma` command (Task 7).
@MainActor
enum CliInstaller {
    static let linkPath = "/usr/local/bin/norma"

    static var expectedTarget: String {
        Bundle.main.resourceURL!.appendingPathComponent("norma-core").path
    }

    /// Pure decision: what to do given the current state of the destination path.
    ///
    /// `refuseForeign` fires ONLY for a non-symlink real file at `linkPath` — we never created
    /// that, so we never touch it. ANY symlink there is presumed ours to manage: a dangling
    /// symlink, one pointing at a stale/moved app location, or even a wholly unrelated target all
    /// repair to the current `expectedTarget` (only WE would ever have put a symlink at this exact
    /// path via `install()`, so there's no "foreign symlink" case to guard against — unlike a real
    /// file, which could easily be a user's own script). Exact-match is the only thing that counts
    /// as already installed.
    static func plan(existingDestination: String?, isSymlink: Bool, symlinkTarget: String?, expectedTarget: String) -> CliInstallAction {
        guard let dest = existingDestination else { return .install }
        guard isSymlink else { return .refuseForeign(dest) }
        if let target = symlinkTarget, target == expectedTarget { return .alreadyInstalled }
        return .repair
    }

    /// Read-only probe: folds the REAL destination state through `plan()` without mutating
    /// anything. Factored out of `install()` (which calls this, then acts on the result) so the
    /// menu item can title itself — both when the menu is first built and right after `install()`
    /// runs — using the exact same probing logic, never duplicated.
    static func currentPlan() -> CliInstallAction {
        let fm = FileManager.default
        var isSymlink = false
        var symlinkTarget: String? = nil
        var existing: String? = nil
        if fm.fileExists(atPath: linkPath) || (try? fm.destinationOfSymbolicLink(atPath: linkPath)) != nil {
            existing = linkPath
            if let t = try? fm.destinationOfSymbolicLink(atPath: linkPath) { isSymlink = true; symlinkTarget = t }
        }
        return plan(existingDestination: existing, isSymlink: isSymlink, symlinkTarget: symlinkTarget, expectedTarget: expectedTarget)
    }

    /// Effectful: probe the destination and execute the plan. Returns the action taken.
    @discardableResult
    static func install() -> CliInstallAction {
        let action = currentPlan()
        switch action {
        case .alreadyInstalled, .refuseForeign: return action
        case .install, .repair:
            let fm = FileManager.default
            do {
                try? fm.removeItem(atPath: linkPath)
                try fm.createDirectory(atPath: "/usr/local/bin", withIntermediateDirectories: true)
                try fm.createSymbolicLink(atPath: linkPath, withDestinationPath: expectedTarget)
            } catch {
                installWithAdminPrivileges()
            }
            return action
        }
    }

    /// Single admin prompt via osascript; ln -sfn is idempotent.
    private static func installWithAdminPrivileges() {
        let script = "do shell script \"mkdir -p /usr/local/bin && ln -sfn '\(expectedTarget)' '\(linkPath)'\" with administrator privileges"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        try? p.run(); p.waitUntilExit()
    }

    /// True when a WORKING `norma` resolves anywhere on PATH (covers brew's cask-linked binary).
    static func normaOnPath() -> Bool {
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin"
        return path.split(separator: ":").contains { dir in
            FileManager.default.isExecutableFile(atPath: "\(dir)/norma")
        }
    }

    /// First-launch offer (dist only): once per NORMA_HOME, and only when no norma is on PATH.
    static func offerOnFirstLaunchIfNeeded() {
        guard !AppProfile.isDev else { return }
        let marker = URL(fileURLWithPath: NormaPaths.homeDirectory()).appendingPathComponent("app-state/cli-install-offered")
        guard !FileManager.default.fileExists(atPath: marker.path) else { return }
        try? FileManager.default.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data().write(to: marker)
        guard !normaOnPath() else { return }
        let alert = NSAlert()
        alert.messageText = "Install the norma command?"
        alert.informativeText = "Adds `norma` to /usr/local/bin so you can use Norma from the terminal. You can do this later from the menu bar."
        alert.addButton(withTitle: "Install")
        alert.addButton(withTitle: "Not Now")
        if alert.runModal() == .alertFirstButtonReturn { install() }
    }
}
