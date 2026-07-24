import Foundation

/// 2e-iv Task 1: installs a thin `norma-dev` shell wrapper on `$PATH` and opens it in Terminal.app
/// via `open -a Terminal <path>`, so the CLI runs as a normal Terminal-owned process instead of
/// as a child of the (Automation-permission-gated) menu-bar app — no TCC prompt either way.
///
/// DEV-MODE ONLY (dev/dist split, Task 6): the wrapper script `exec`s `bun` straight against
/// `packages/cli/src/main.ts` out of a live repo checkout (see `wrapperScript(repoRoot:)`), and
/// bakes the dev profile's env (`NORMA_HOME`/`NORMA_PROFILE`) into the script itself — a Terminal
/// launched via `open -a` does not inherit this app's process env, so the wrapper cannot rely on
/// `AppProfile.bootstrapEnvironment()` having already run in its shell. Call sites gate this
/// class's use on `AppProfile.isDev`; the distribution app's `norma` command is a separate,
/// packaged-binary story (Task 7).
@MainActor
final class CliLauncher {
    /// Test seam: when set, `ensureWrapper()` writes here instead of computing
    /// `wrapperInstallPath()`. Production callers leave this `nil`.
    private let installPathOverride: URL?

    /// The repo checkout the generated wrapper `exec`s into. Settable so tests can pin it (and,
    /// in principle, so a future dev could point at a different checkout); production code relies
    /// on the `#filePath`-derived default below, which is only meaningful at runtime from a real
    /// build of this file — DEV-mode only, per the class doc above.
    var repoRoot: String

    init(installPathOverride: URL? = nil) {
        self.installPathOverride = installPathOverride
        self.repoRoot = Self.defaultRepoRoot
    }

    /// `#filePath` for this file is `<repoRoot>/apple/Norma/Sources/App/CliLauncher.swift`.
    /// Five `deletingLastPathComponent()` hops strip, in order: the filename itself, `App`,
    /// `Sources`, `Norma`, `apple` — leaving `<repoRoot>`. DEV-mode only (see class doc); tests
    /// never rely on this default, they set `repoRoot` explicitly.
    ///
    /// Debug-only: `#filePath` embeds the builder's absolute home path in the binary, and
    /// `-file-prefix-map` does not remap `#filePath` literals — so Release compiles the literal
    /// out entirely (the checkout path is meaningless in an installed app anyway; the wrapper
    /// then points at a nonexistent path exactly as it did when installed on any other machine).
    private static var defaultRepoRoot: String {
        #if DEBUG
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            url = url.deletingLastPathComponent()
        }
        return url.path
        #else
        return "/norma-dev-checkout-unavailable"
        #endif
    }

    /// Pure: the norma-dev wrapper's exact byte content. Sets the dev profile env (respecting
    /// explicit overrides) then execs the checkout CLI via bun.
    static func wrapperScript(repoRoot: String) -> String {
        """
        #!/bin/sh
        export NORMA_HOME="${NORMA_HOME:-$HOME/.norma-dev}"
        export NORMA_PROFILE="${NORMA_PROFILE:-dev}"
        exec /usr/bin/env bun "\(repoRoot)/packages/cli/src/main.ts" "$@"

        """
    }

    /// Where the wrapper gets installed: prefer Homebrew's `bin` (already on most macOS devs'
    /// `$PATH`) when it exists and is writable without sudo; otherwise fall back to the
    /// XDG-ish `~/.local/bin`, which the caller is responsible for getting onto `$PATH`.
    static func wrapperInstallPath(
        fileManager: FileManager = .default,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        let brewBinPath = "/opt/homebrew/bin"
        var isDirectory: ObjCBool = false
        let brewBinExists = fileManager.fileExists(atPath: brewBinPath, isDirectory: &isDirectory)
        if brewBinExists && fileManager.isWritableFile(atPath: brewBinPath) {
            return URL(fileURLWithPath: brewBinPath).appendingPathComponent("norma-dev")
        }
        return home.appendingPathComponent(".local/bin/norma-dev")
    }

    /// One-time migration: earlier dev builds installed the wrapper AS `norma`, which now
    /// belongs to the DISTRIBUTION app's symlink. Removes a sibling `norma` iff its content
    /// proves it was our bun wrapper (starts with the historical exec line) — a user-owned or
    /// dist-owned `norma` is never touched.
    static func removeLegacyNormaWrapper(besides installPath: URL) {
        let legacy = installPath.deletingLastPathComponent().appendingPathComponent("norma")
        guard let content = try? String(contentsOf: legacy, encoding: .utf8),
              content.hasPrefix("#!/bin/sh\nexec /usr/bin/env bun \""),
              content.contains("/packages/cli/src/main.ts\" \"$@\"") else { return }
        try? FileManager.default.removeItem(at: legacy)
    }

    /// Writes the wrapper script iff it's missing or its bytes have drifted from what
    /// `wrapperScript(repoRoot:)` would produce right now (e.g. the repo checkout moved), setting
    /// the executable bit only when it (re)writes. Idempotent otherwise — a no-op call neither
    /// rewrites the file nor touches its mtime. Returns the resolved install path either way.
    func ensureWrapper() throws -> URL {
        let path = installPathOverride ?? Self.wrapperInstallPath()
        Self.removeLegacyNormaWrapper(besides: path)
        let directory = path.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let newContent = Data(Self.wrapperScript(repoRoot: repoRoot).utf8)
        let existingContent = try? Data(contentsOf: path)
        guard existingContent != newContent else { return path }

        try newContent.write(to: path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
        return path
    }

    /// Ensures the wrapper is installed and up to date, then opens it in Terminal.app via
    /// `open -a Terminal <path>` — Terminal, not this app, becomes the wrapper's parent process,
    /// so no Automation/AppleEvents TCC prompt is ever triggered.
    ///
    /// The app has no NSAlert convention anywhere else (menu-bar-only UI, `OrbDebug.log` for
    /// diagnostics) — matching that, a failure here is non-fatal: it's logged and swallowed
    /// rather than surfaced as new UI.
    func openCli() {
        do {
            let wrapperPath = try ensureWrapper()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", "Terminal", wrapperPath.path]
            try process.run()
        } catch {
            OrbDebug.log("CliLauncher.openCli: failed to install/launch wrapper — \(error)")
        }
    }
}
