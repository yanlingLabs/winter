import Foundation

/// App→CLI handoff: what went wrong, for the shell to surface VISIBLY (honesty-of-affordance —
/// a handoff failure is never a silent no-op; Task 3's caller presents these, it doesn't log-and-drop).
enum HandoffError: Error, Equatable {
    case cliMissing(String)      // dist bundle binary absent — message carries the path
    case scriptWriteFailed(String)
    case openFailed(Int32)       // open's exit code
}

/// App→CLI handoff (SP4 Plan 1, Task 1): builds and launches the per-invocation script that
/// moves a code session into Terminal — `cd` into the session's main dir, then `exec` the CLI's
/// `resume <sessionId>` against an ABSOLUTE binary (never the `norma`/`norma-dev` globals; R2).
///
/// The script ALWAYS bakes `export NORMA_HOME=…` + `export NORMA_PROFILE=…` — in BOTH profiles —
/// because a Terminal launched via `open -a` inherits NOTHING of this app's process env; a script
/// without them reproduces the dev/dist profile-blindness class (the CLI would dial the wrong
/// daemon's socket and keychain). Same lesson `CliLauncher`'s wrapper learned; see that class doc.
///
/// Launch follows the proven `CliLauncher` pattern: write a `#!/bin/sh` script, then
/// `Process` → `/usr/bin/open -a Terminal <script>` — Terminal, not this app, parents the CLI,
/// so no Automation/AppleEvents TCC prompt. The real `open` is a live-gate item; the pure
/// builder below carries the unit coverage (byte-pinned in `HandoffLauncherTests`).
enum HandoffLauncher {
    /// Pure: POSIX single-quoting. Wraps in `'…'`, escaping embedded single quotes as `'\''`
    /// (close, literal quote, reopen) — safe for any path/id interpolated into the script.
    static func shellSingleQuoted(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Pure: the handoff script's exact byte content. Both profiles bake NORMA_HOME/NORMA_PROFILE
    /// (see the class doc for why); every interpolated value is single-quoted via
    /// `shellSingleQuoted`. Dev execs the checkout CLI through bun; dist execs the bundled
    /// `norma-core` binary directly.
    static func handoffScript(dev: Bool, normaHome: String, cliPath: String,
                              dir: String, sessionId: String) -> String {
        let home = shellSingleQuoted(normaHome)
        let d = shellSingleQuoted(dir)
        let sid = shellSingleQuoted(sessionId)
        let execLine = dev
            ? "exec /usr/bin/env bun \(shellSingleQuoted(cliPath)) resume \(sid)"
            : "exec \(shellSingleQuoted(cliPath)) resume \(sid)"
        return """
        #!/bin/sh
        export NORMA_HOME=\(home)
        export NORMA_PROFILE='\(dev ? "dev" : "dist")'
        cd \(d)
        \(execLine)

        """
    }

    /// `#filePath` for this file is `<repoRoot>/apple/Norma/Sources/App/HandoffLauncher.swift` —
    /// the same directory as `CliLauncher.swift`, so the same five `deletingLastPathComponent()`
    /// hops strip the filename, `App`, `Sources`, `Norma`, `apple`, leaving `<repoRoot>`; then
    /// down to the checkout CLI entry point. DEV-mode only: `moveToCli` reaches here iff
    /// `AppProfile.isDev`, and `#filePath` embeds the builder's absolute path, so Release
    /// compiles the literal out entirely (mirroring `CliLauncher.defaultRepoRoot`).
    private static func checkoutMainTs() -> String {
        #if DEBUG
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            url = url.deletingLastPathComponent()
        }
        return url.appendingPathComponent("packages/cli/src/main.ts").path
        #else
        // Unreachable: dist builds have AppProfile.isDev == false, and moveToCli only calls
        // this on the dev branch. A sentinel path keeps the symbol total without baking one.
        return "/norma-dev-checkout-unavailable/packages/cli/src/main.ts"
        #endif
    }

    /// Effectful: resolves the CLI path (dev: bun + checkout via `#filePath`; dist: the app's own
    /// `Bundle.main` `norma-core` — works with no symlink installed), writes the per-invocation
    /// temp script 0755, `open -a Terminal <script>`, then schedules best-effort cleanup.
    /// Runs `open` synchronously — it returns fast (it doesn't wait on Terminal).
    /// Failures come back as a typed `Result` for the caller to SURFACE; they're also logged
    /// via `OrbDebug` for diagnostics.
    static func moveToCli(sessionId: String, dir: String) -> Result<Void, HandoffError> {
        let dev = AppProfile.isDev
        let cliPath: String
        if dev {
            cliPath = checkoutMainTs()
        } else {
            guard let url = Bundle.main.resourceURL?.appendingPathComponent("norma-core"),
                  FileManager.default.isExecutableFile(atPath: url.path) else {
                let missing = Bundle.main.resourceURL?.path ?? "<no bundle>"
                OrbDebug.log("HandoffLauncher.moveToCli: bundled norma-core missing at \(missing)")
                return .failure(.cliMissing(missing))
            }
            cliPath = url.path
        }
        let script = handoffScript(dev: dev, normaHome: AppProfile.normaHome,
                                   cliPath: cliPath, dir: dir, sessionId: sessionId)
        let target = FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-handoff-\(sessionId)-\(UUID().uuidString).sh")
        do {
            try script.write(to: target, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755],
                                                  ofItemAtPath: target.path)
        } catch {
            OrbDebug.log("HandoffLauncher.moveToCli: script write failed at \(target.path) — \(error)")
            return .failure(.scriptWriteFailed(target.path))
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", "Terminal", target.path]
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            OrbDebug.log("HandoffLauncher.moveToCli: open failed to run — \(error)")
            return .failure(.openFailed(-1))
        }
        // Best-effort cleanup — Terminal reads the script promptly; a leaked one is inert.
        DispatchQueue.global().asyncAfter(deadline: .now() + 60) {
            try? FileManager.default.removeItem(at: target)
        }
        guard process.terminationStatus == 0 else {
            OrbDebug.log("HandoffLauncher.moveToCli: open exited \(process.terminationStatus)")
            return .failure(.openFailed(process.terminationStatus))
        }
        return .success(())
    }
}
