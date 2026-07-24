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
        // Belt-and-suspenders: `Bundle.main.resourceURL` is only nil for a malformed/non-bundle
        // process, which never happens for a real, launched app bundle — unreachable in practice,
        // but a guarded fallback costs nothing and can't crash.
        guard let url = Bundle.main.resourceURL else { return "/Applications/Norma.app/Contents/Resources/norma-core" }
        return url.appendingPathComponent("norma-core").path
    }

    /// Pure decision: what to do given the current state of the destination path.
    ///
    /// Spec rule (dev/dist-split design §3): the installer refuses to overwrite a `norma` that is
    /// not a symlink into a Norma.app — surfacing it instead of touching it. A non-symlink real
    /// file at `linkPath` is unconditionally foreign (we never create plain files there). A symlink
    /// is ours to repair ONLY when it points somewhere shaped like `Norma.app/Contents/Resources/
    /// norma-core` — covering a stale/moved app location (old path, renamed volume) as well as an
    /// exact-match already-installed link — never a symlink pointing anywhere else. A foreign
    /// symlink (e.g. a user's own `norma -> ~/mytools/norma`) is user data we did not create and
    /// must never silently delete; refusing + surfacing it is the only safe move.
    static func plan(existingDestination: String?, isSymlink: Bool, symlinkTarget: String?, expectedTarget: String) -> CliInstallAction {
        guard let dest = existingDestination else { return .install }
        guard isSymlink else { return .refuseForeign(dest) }
        if let target = symlinkTarget, target == expectedTarget { return .alreadyInstalled }
        guard let target = symlinkTarget, target.contains("Norma.app/Contents/Resources/norma-core") else {
            return .refuseForeign(dest)
        }
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
        case .alreadyInstalled: return action
        case .refuseForeign(let path):
            // Surfaces what the disabled menu title only alludes to ("see logs") — makes that
            // claim actually true.
            OrbDebug.log("CliInstaller: refusing to overwrite foreign norma at \(path) (not a symlink into a Norma.app)")
            return action
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
    ///
    /// DD branch review (I2): a GUI app launched via LaunchServices does NOT inherit the user's
    /// shell PATH — it gets LaunchServices' own minimal `/usr/bin:/bin:/usr/sbin:/sbin`, which
    /// never contains brew's `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel /
    /// legacy). Reading `env PATH` alone therefore made the "already on PATH, skip the offer"
    /// check dead in production: `PATH` is always PRESENT (never nil), so the old `?? "…"` fallback
    /// — sized for the nil case — never actually ran. Fixed by always scanning PATH's own dirs
    /// PLUS the hardcoded brew locations, regardless of what PATH already contains.
    static func normaOnPath(pathVar: String? = ProcessInfo.processInfo.environment["PATH"], extraDirs: [String] = ["/usr/local/bin", "/opt/homebrew/bin"]) -> Bool {
        let pathDirs = (pathVar ?? "").split(separator: ":").map(String.init)
        let dirs = Set(pathDirs + extraDirs)
        return dirs.contains { dir in
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
