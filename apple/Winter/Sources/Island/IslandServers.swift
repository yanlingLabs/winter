import AppKit
import Darwin
import Foundation
import SwiftUI
import WinterCUPresentation

// The Winter island's Servers tab (`docs/claude/island.md`): the user's own processes listening on a TCP port — a
// server they started by hand (`waifus remote`, `bun dev`, `python3 -m http.server`) — with its name, ports, uptime
// and folder, and Stop. (User 2026-10-18: TCP ports only — a Unix socket alone is no server here — and no coding-agent
// CLIs.)
//
//   - DETECTION is the app's own, local process state (no daemon): libproc — `proc_listallpids`, `PROC_PIDTBSDINFO`
//     (uid, parent, process group, start time, zombie), `PROC_PIDLISTFDS` + `PROC_PIDFDSOCKETINFO` (a TCP socket in
//     `TSI_S_LISTEN`), `proc_pidpath`, `PROC_PIDVNODEPATHINFO` (the cwd) and, for an interpreter only,
//     `KERN_PROCARGS2` (its script). Nothing is spawned. A scan runs off the main thread only while the island is open
//     on this tab (the open island's refresh beat) — never in the background.
//   - EXCLUDED: Apple's and the system's (`/System`, `/usr/libexec`, `/usr/sbin`, `/usr/bin`, `/bin`, `/sbin`,
//     `/Library/Apple`, `/Library/Developer` — Xcode's tools and the simulators), anything inside a `.app` bundle (a GUI
//     app's ports are not a server you started), the coding agents (their CLIs, `agentCLIs`, and apps, `agentApps`),
//     and Winter's and the agents' infrastructure (`winter-core`, `winter`, its helpers, this app, an agent — and what
//     they start with no user's shell in between, an MCP server; a server one ran through its shell IS listed),
//     `launchd`. An interpreter (node, bun, deno, python, ruby, java, php, perl) under `/usr/bin` or
//     `/Library/Developer`, or in a framework's `Python.app` (Homebrew's, Xcode's), IS listed.
//   - ONE ROW per server: a listener goes under its nearest listening ancestor only when it is that server's own —
//     the same process group, or the same executable as its direct parent (a forked worker); never across a shell, so
//     never under tmux, a notebook's terminal or an agent session that merely started it: Stop never reaches an
//     unrelated server.
//   - STOP: two clicks within `confirmWindow` (a double click is one); SIGTERM to the row's processes, each re-checked
//     (still this user's, the same start time — a reused pid is never hit; never this app, its parent, launchd or a
//     Winter process) right before; still alive after `forceAfter` → "Force quit" (SIGKILL), two clicks again.

// MARK: - What a scan reads

/// A process's identity: its pid with the user and start time it had — a pid reused by a later process differs.
struct ServerProcessIdentity: Hashable {
    let pid: Int32
    let uid: uid_t
    let startSeconds: UInt64
    let startMicros: UInt64
}

/// One of the user's processes, as a scan saw it. A LISTENING one carries its details (cwd, arguments); the others
/// are there for the process tree (with their path when they are a listener's ancestor).
struct ServerProcess: Equatable {
    let identity: ServerProcessIdentity
    let ppid: Int32
    /// Its process group (`pbi_pgid`): a server's forked workers share it; a job a shell or an agent started has its own.
    var pgid: Int32 = 0
    /// The executable (`proc_pidpath`); empty when it could not be read (a deleted binary) or was not needed.
    var path: String = ""
    /// The kernel's short name (`pbi_name`, else `pbi_comm`): the name when the path is unknown.
    var command: String = ""
    var cwd: String?
    /// Listening TCP ports (each once: v4 and v6 listeners on one port are one).
    var tcpPorts: [UInt16] = []
    /// Where each port answers on loopback (`IslandLoopback`); a port bound only to another address has none and is
    /// never probed.
    var loopback: [UInt16: IslandLoopback] = [:]
    /// The process's argv (an interpreter's only).
    var arguments: [String]?

    var pid: Int32 { identity.pid }
    var uid: uid_t { identity.uid }
    var listens: Bool { !tcpPorts.isEmpty }
}

/// Where the processes come from: libproc live, a fake list in the tests.
protocol ServerProcessSource {
    /// The user's processes — every one (the tree is walked through a parent that listens on nothing), the listening
    /// ones with their path, cwd and, for an interpreter, their arguments; their ancestors with their path.
    func processes() -> [ServerProcess]
    /// The process with this pid now, while it runs (nil: gone, a zombie, or not readable).
    func identity(of pid: Int32) -> ServerProcessIdentity?
    /// Its executable now ("": unknown).
    func path(of pid: Int32) -> String
}

/// Sends a signal. Live: `kill(2)`.
protocol ServerSignaller {
    func send(_ signal: Int32, to pid: Int32) -> Bool
}

struct LiveServerSignaller: ServerSignaller {
    func send(_ signal: Int32, to pid: Int32) -> Bool { kill(pid, signal) == 0 }
}

// MARK: - The rules (pure)

enum IslandServers {
    /// Two clicks on Stop (or Force quit) within this many seconds.
    static let confirmWindow: TimeInterval = 3
    /// A second click this soon after the first is the same click (a double click never skips the confirm).
    static let doubleClickGuard: TimeInterval = 0.3
    /// After SIGTERM, how long a server has before Force quit is offered.
    static let forceAfter: TimeInterval = 5

    enum Interpreter: Equatable {
        case node, bun, deno, python, ruby, java, php, perl
    }

    /// Apple's and the system's — never a server the user started. (`/usr/bin` and `/Library/Developer` spare an
    /// interpreter: `/usr/bin/python3` runs Xcode's or the Command Line Tools' Python.)
    static let systemPrefixes = ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/", "/bin/", "/Library/Apple/"]
    static let interpreterPrefixes = ["/usr/bin/", "/Library/Developer/"]
    /// Winter's own executables (its app bundles — `Winter*.app` — are told by their path).
    static let winterNames: Set<String> = ["winter-core", "winter", "WinterHelper", "WinterOfficeHelper", "winter-browser-host"]
    /// The coding-agent CLIs (user 2026-10-18): never a row, never a server's group — by their executable's or
    /// script's own file name EXACTLY (`claude`, never `claude.py` or a `copilot/index.js`), their npm package, or
    /// their own installer's `<name>/versions/<v>`.
    static let agentCLIs: Set<String> = ["claude", "codex", "opencode", "agy", "cursor-agent", "devin", "gemini", "copilot"]
    /// The agents' npm packages (any other package is matched by `agentWord`, the only place a suffix is dropped).
    static let agentPackages: Set<String> = ["@anthropic-ai/claude-code", "@openai/codex", "opencode-ai", "@google/gemini-cli",
                                             "@github/copilot", "@cognition-ai/devin", "@cursor/cursor-agent"]
    /// Package runners (`npx`, `npm exec`, `pnpm dlx`, `bunx`, `uvx`): the shell one runs a package through is not the
    /// user's shell.
    static let packageRunners: Set<String> = ["npx", "bunx", "uvx", "pnpx"]

    /// The name the kernel or the path gives (the path's last component, else the short command).
    static func executableName(_ p: ServerProcess) -> String {
        let base = (p.path as NSString).lastPathComponent
        return base.isEmpty ? p.command : base
    }

    /// node, bun, deno, python (python3, python3.12, Python.app's `Python`), ruby, java, php, perl (perl5.34).
    static func interpreter(_ name: String) -> Interpreter? {
        let n = name.lowercased()
        switch n {
        case "node", "nodejs": return .node
        case "bun": return .bun
        case "deno": return .deno
        case "ruby": return .ruby
        case "java": return .java
        case "php": return .php
        default: break
        }
        if n.hasPrefix("python"), n.dropFirst(6).allSatisfy({ $0.isNumber || $0 == "." || $0 == "w" }) { return .python }
        if n.hasPrefix("perl"), n.dropFirst(4).allSatisfy({ $0.isNumber || $0 == "." }) { return .perl }
        return nil
    }

    /// Winter's own: one of its executables, or anything inside a `Winter*.app` (the app, Winter Dev, its helpers).
    static func isWinter(path: String, command: String) -> Bool {
        let base = (path as NSString).lastPathComponent
        if winterNames.contains(base) || winterNames.contains(command) { return true }
        return path.split(separator: "/").contains { $0.hasPrefix("Winter") && $0.hasSuffix(".app") }
    }

    /// The shells: one between Winter and a listener makes that listener a server a session ran for the user.
    static let shells: Set<String> = ["sh", "bash", "zsh", "fish", "dash"]

    static func isShell(_ p: ServerProcess) -> Bool {
        shells.contains(executableName(p)) || shells.contains(p.command)
    }

    /// A coding-agent CLI (`agentCLIs`): its executable's name or short command, or an interpreter's script's own file
    /// name, EXACTLY (`/opt/homebrew/bin/claude` under node); the npm package its script is in (`agentPackages`, or a
    /// package `agentWord` names an agent); or a path laid out as `<agent>/versions/<version>`. A script named after an
    /// agent's folder or with an extension (`copilot/index.js`, `claude.py`, `claude-cli.js`) is the user's own.
    static func isAgentCLI(_ p: ServerProcess) -> Bool {
        if agentCLIs.contains(executableName(p).lowercased()) || agentCLIs.contains(p.command.lowercased()) { return true }
        var script: String?
        if interpreter(executableName(p)) != nil { script = p.arguments?.dropFirst().first(where: { !$0.hasPrefix("-") }) }
        if let script {
            if agentCLIs.contains((script as NSString).lastPathComponent.lowercased()) { return true }
            if let package = nodeModulesPackage(script),
               agentPackages.contains(package.lowercased()) || agentCLIs.contains(agentWord(package)) { return true }
        }
        for path in [p.path, script ?? ""] {
            let parts = path.split(separator: "/").map { $0.lowercased() }
            for i in parts.indices.dropLast() where parts[i + 1] == "versions" && agentCLIs.contains(parts[i]) {
                return true
            }
        }
        return false
    }

    /// The coding agents' desktop apps (user 2026-10-18): anything inside one of these bundles — Claude's own
    /// (`disclaimer` included), ChatGPT, Codex, Cursor, Antigravity, Windsurf, Devin — is an agent's.
    static let agentApps: Set<String> = ["claude.app", "chatgpt.app", "codex.app", "cursor.app", "antigravity.app",
                                         "windsurf.app", "devin.app"]

    /// A coding agent: one of its CLIs (`isAgentCLI`) or anything inside one of its apps (`agentApps`).
    static func isAgent(_ p: ServerProcess) -> Bool {
        isAgentCLI(p) || p.path.split(separator: "/").contains { agentApps.contains($0.lowercased()) }
    }

    /// A package runner: `npx`, `bunx`, `uvx`, `pnpx` (the executable, argv[0] or a node script of that name), `npm
    /// exec`, `pnpm dlx`, `bun x`, `uv tool run`.
    static func isPackageRunner(_ p: ServerProcess) -> Bool {
        let name = executableName(p).lowercased()
        let args = p.arguments ?? []
        let words = args.dropFirst().filter { !$0.hasPrefix("-") }
        var names = [name, (args.first.map { ($0 as NSString).lastPathComponent } ?? "").lowercased()]
        if interpreter(name) != nil, let script = words.first {
            names.append((((script as NSString).lastPathComponent as NSString).deletingPathExtension).lowercased())
        }
        if names.contains(where: { packageRunners.contains($0) || $0 == "npx-cli" }) { return true }
        let rest = Set(words.map { $0.lowercased() })
        if names.contains(where: { $0 == "npm" || $0 == "npm-cli" }) && rest.contains("exec") { return true }
        if names.contains(where: { $0.hasPrefix("pnpm") }) && rest.contains("dlx") { return true }
        if name == "bun" && words.first == "x" { return true }
        if name == "uv" && words.prefix(2) == ["tool", "run"] { return true }
        return false
    }

    /// An npm package's name as an agent's: its last segment, lowercased, without `@version` or a `-code`/`-cli`/`-ai`
    /// suffix (`@anthropic-ai/claude-code` → "claude", `@google/gemini-cli` → "gemini", `opencode-ai` → "opencode").
    static func agentWord(_ name: String) -> String {
        var word = (name.split(separator: "/").last.map(String.init) ?? name).lowercased()
        if let at = word.firstIndex(of: "@"), at != word.startIndex { word = String(word[..<at]) }
        for suffix in ["-code", "-cli", "-ai"] where word.hasSuffix(suffix) && word.count > suffix.count {
            return String(word.dropLast(suffix.count))
        }
        return word
    }

    /// Whether the process is never a row: the system's, Apple's, a GUI app's, Winter's own, a coding agent, launchd.
    static func isExcluded(_ p: ServerProcess, ownPid: Int32) -> Bool {
        if p.pid <= 1 || p.pid == ownPid { return true }
        let name = executableName(p)
        if name == "launchd" || isWinter(path: p.path, command: p.command) || isAgentCLI(p) { return true }
        // An unknown path (a deleted binary) matches no path rule: listed by its short command.
        guard !p.path.isEmpty else { return false }
        let interpreted = interpreter(name) != nil
        if systemPrefixes.contains(where: p.path.hasPrefix) { return true }
        if !interpreted, interpreterPrefixes.contains(where: p.path.hasPrefix) { return true }
        // Inside a `.app` bundle: a GUI app's — except an interpreter in a framework's app (Python's `Python.app`)
        // whose framework is no GUI app's own (Xcode's is: `Xcode.app/…/Python3.framework/…/Python.app`).
        let parts = p.path.split(separator: "/").map { $0.lowercased() }
        guard let app = parts.lastIndex(where: { $0.hasSuffix(".app") }) else { return false }
        guard interpreted, let framework = parts[..<app].lastIndex(where: { $0.hasSuffix(".framework") }) else { return true }
        return parts[..<framework].contains { $0.hasSuffix(".app") && !$0.hasPrefix("xcode") }
    }

    /// A row's process: this user's, listening on a TCP port, not excluded.
    static func qualifies(_ p: ServerProcess, user: uid_t, ownPid: Int32) -> Bool {
        p.uid == user && p.listens && !isExcluded(p, ownPid: ownPid)
    }

    // MARK: Names

    /// What the row is called: an interpreter's script (or package, or module), else the executable's name.
    static func displayName(_ p: ServerProcess) -> String {
        let name = executableName(p)
        if let kind = interpreter(name), let args = p.arguments, args.count > 1,
           let script = scriptName(kind, arguments: Array(args.dropFirst()), cwd: p.cwd) {
            return script
        }
        // `go run`'s build is `main` in a temporary `go-build` folder: the folder it runs in names it.
        if name == "main", p.path.contains("/go-build"), let cwd = p.cwd, let folder = folderName(cwd) { return folder }
        return name
    }

    /// An interpreter's script from its arguments (argv without the interpreter): nil when it runs none (`-e`, a REPL).
    static func scriptName(_ kind: Interpreter, arguments: [String], cwd: String?) -> String? {
        switch kind {
        case .node, .bun, .deno: return jsScript(arguments, kind: kind, cwd: cwd)
        case .python: return pythonScript(arguments, cwd: cwd)
        case .ruby, .perl: return firstScript(arguments, valued: ["-I", "-r", "-C", "-M", "-x"], eval: ["-e", "-E"], cwd: cwd)
        case .php: return firstScript(arguments, valued: ["-S", "-t", "-c", "-d", "-z"], eval: ["-r", "-a"], cwd: cwd,
                                      fileFlag: "-f")
        case .java: return javaMain(arguments)
        }
    }

    /// Runners whose own script is not the server's: the next positional argument is (`tsx src/index.ts`).
    static let jsRunners: Set<String> = ["tsx", "ts-node", "ts-node-dev", "nodemon"]

    private static func jsScript(_ args: [String], kind: Interpreter, cwd: String?) -> String? {
        let valued: Set<String> = ["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
                                   "--title", "--input-type", "--config", "-c", "--env-file", "--preload", "--cwd"]
        let eval: Set<String> = ["-e", "--eval", "-p", "--print"]
        var i = 0
        var positional: [String] = []
        while i < args.count {
            let a = args[i]
            if eval.contains(a) { return nil }
            if valued.contains(a) { i += 2; continue }
            if a.hasPrefix("-") { i += 1; continue }
            positional.append(a)
            i += 1
        }
        // `bun run x`, `deno run -A x`, `deno serve x`; `bun x vite` / `bunx vite` name the package.
        if kind != .node, let first = positional.first, ["run", "serve", "x"].contains(first) { positional.removeFirst() }
        guard let script = positional.first else { return nil }
        // A runner's package (`node_modules/.bin/tsx src/bot.ts`): the script it runs.
        let package = nodeModulesPackage(script)
        if let package, jsRunners.contains(package), positional.count > 1 { return fileScriptName(positional[1], cwd: cwd) }
        // A bin script: its command and subcommand (`…/discord-waifus/bin/waifus.mjs remote` → "waifus remote").
        if let command = binCommand(script, next: positional.dropFirst().first) { return command }
        // Another script in a package: the package.
        return package ?? fileScriptName(script, cwd: cwd)
    }

    private static func pythonScript(_ args: [String], cwd: String?) -> String? {
        let valued: Set<String> = ["-W", "-X", "-Q"]
        var i = 0
        while i < args.count {
            let a = args[i]
            if a == "-m" { return i + 1 < args.count ? args[i + 1] : nil }
            if a.hasPrefix("-m"), a.count > 2, !a.hasPrefix("--") { return String(a.dropFirst(2)) }
            if a == "-c" { return nil }
            if valued.contains(a) { i += 2; continue }
            if a.hasPrefix("-") { i += 1; continue }
            return binCommand(a, next: args[(i + 1)...].first { !$0.hasPrefix("-") }) ?? fileScriptName(a, cwd: cwd)
        }
        return nil
    }

    private static func firstScript(_ args: [String], valued: Set<String>, eval: Set<String>, cwd: String?,
                                    fileFlag: String? = nil) -> String? {
        var i = 0
        while i < args.count {
            let a = args[i]
            if eval.contains(a) { return nil }
            if a == fileFlag { return i + 1 < args.count ? fileScriptName(args[i + 1], cwd: cwd) : nil }
            if valued.contains(a) { i += 2; continue }
            if a.hasPrefix("-") { i += 1; continue }
            return binCommand(a, next: args[(i + 1)...].first { !$0.hasPrefix("-") }) ?? fileScriptName(a, cwd: cwd)
        }
        return nil
    }

    /// A script in a `bin` folder (a package's bin, `node_modules/.bin`, a venv's): "<its name> <subcommand>" — the
    /// first argument after it that is not a flag, when that is a plain word (`remote`, `server`, `app:app`), never a
    /// path or a file —, else its name alone. Nil for any other script, or an entry file (`bin/index.js`).
    static func binCommand(_ script: String, next: String?) -> String? {
        let folder = ((script as NSString).deletingLastPathComponent as NSString).lastPathComponent
        guard folder == "bin" || folder == ".bin" else { return nil }
        let base = ((script as NSString).lastPathComponent as NSString).deletingPathExtension
        guard !base.isEmpty, !entryNames.contains(base) else { return nil }
        guard let next, isSubcommand(next) else { return base }
        return "\(base) \(next)"
    }

    /// A plain word: a letter, then letters, digits, `-`, `_` or `:` (at most 32).
    static func isSubcommand(_ word: String) -> Bool {
        guard let first = word.first, first.isLetter, word.count <= 32 else { return false }
        return word.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ":" }
    }

    /// The npm package an interpreter's script is in — the row's secondary words when its name does not already say
    /// it (`waifus remote` · `@waifucave/discord-waifus`).
    static func packageName(_ p: ServerProcess) -> String? {
        guard interpreter(executableName(p)) != nil, let args = p.arguments else { return nil }
        guard let package = args.dropFirst().lazy.compactMap(nodeModulesPackage).first else { return nil }
        let name = displayName(p)
        return name == package || name.hasPrefix(package + " ") ? nil : package
    }

    /// `-jar app.jar` → "app"; a main class `com.example.Server` → "Server"; `-m mod/com.x.Main` → "Main".
    private static func javaMain(_ args: [String]) -> String? {
        let valued: Set<String> = ["-cp", "-classpath", "--class-path", "-p", "--module-path", "--add-modules"]
        var i = 0
        while i < args.count {
            let a = args[i]
            if a == "-jar" {
                guard i + 1 < args.count else { return nil }
                return ((args[i + 1] as NSString).lastPathComponent as NSString).deletingPathExtension
            }
            if a == "-m" || a == "--module" {
                guard i + 1 < args.count else { return nil }
                return args[i + 1].split(separator: "/").last.flatMap { $0.split(separator: ".").last }.map(String.init)
            }
            if valued.contains(a) { i += 2; continue }
            if a.hasPrefix("-") { i += 1; continue }
            return a.split(separator: ".").last.map(String.init)
        }
        return nil
    }

    /// The files whose name says nothing: their package's folder names the row (`server/src/index.ts` → "server").
    static let entryNames: Set<String> = ["index", "main", "__main__", "mod"]
    /// Build and source folders skipped on the way to the package's (`dist`, `src`…).
    static let buildFolders: Set<String> = ["src", "dist", "lib", "build", "bin", "out", "source"]

    /// A script's name: its base name without the extension, or — for an entry file — its package's folder.
    static func fileScriptName(_ script: String, cwd: String?) -> String {
        let base = ((script as NSString).lastPathComponent as NSString).deletingPathExtension
        guard entryNames.contains(base) else { return base.isEmpty ? script : base }
        var full = script
        if !full.hasPrefix("/"), let cwd { full = (cwd as NSString).appendingPathComponent(script) }
        var folder = ((full as NSString).standardizingPath as NSString).deletingLastPathComponent
        while buildFolders.contains((folder as NSString).lastPathComponent) {
            folder = (folder as NSString).deletingLastPathComponent
        }
        return folderName(folder) ?? base
    }

    /// The package a script inside `node_modules` belongs to (`@scope/name` kept whole); nil outside one.
    static func nodeModulesPackage(_ script: String) -> String? {
        let parts = script.split(separator: "/").map(String.init)
        guard let at = parts.lastIndex(of: "node_modules"), at + 1 < parts.count else { return nil }
        let rest = Array(parts[(at + 1)...])
        if rest.first == ".bin", rest.count > 1 { return rest[1] }
        guard let first = rest.first else { return nil }
        if first.hasPrefix("@"), rest.count > 1 { return rest.prefix(2).joined(separator: "/") }
        return first
    }

    // MARK: Words

    /// A folder's last component ("/" stays "/"); nil for nothing.
    static func folderName(_ path: String) -> String? {
        guard !path.isEmpty else { return nil }
        if path == "/" { return "/" }
        let last = (path as NSString).lastPathComponent
        return last.isEmpty ? nil : last
    }

    /// The full folder, the home written `~`.
    static func abbreviated(_ path: String, home: String) -> String {
        guard !home.isEmpty, home != "/" else { return path }
        if path == home { return "~" }
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    /// A row's third line: its folder and the package it runs from ("Discord Waifus · @waifucave/discord-waifus"); under
    /// the pointer the whole folder.
    static func detailLine(_ row: IslandServerRow, hovered: Bool) -> String? {
        let folder = hovered ? (row.folderPath ?? row.folder) : row.folder
        let words = [folder, row.package].compactMap { $0 }
        return words.isEmpty ? nil : words.joined(separator: " · ")
    }

    /// "1 server", "2 servers".
    static func serversWord(_ count: Int) -> String { count == 1 ? "1 server" : "\(count) servers" }

    /// ":3000 :8080" — the TCP ports in order, each once.
    static func portsLine(_ ports: [UInt16]) -> String {
        Array(Set(ports)).sorted().map { ":\($0)" }.joined(separator: " ")
    }

    /// "just started", "up 12 min", "up 3 h 5 min", "up 2 d 4 h" — how long it has run.
    static func uptime(since start: Date, now: Date) -> String {
        let seconds = Int(now.timeIntervalSince(start))
        if seconds < 60 { return "just started" }
        let minutes = seconds / 60
        if minutes < 60 { return "up \(minutes) min" }
        let hours = minutes / 60
        if hours < 24 {
            let rest = minutes % 60
            return rest == 0 ? "up \(hours) h" : "up \(hours) h \(rest) min"
        }
        let days = hours / 24
        let restHours = hours % 24
        return restHours == 0 ? "up \(days) d" : "up \(days) d \(restHours) h"
    }

    // MARK: The row (the island's visual language: a logo, a name, a live dot; its links and ports in words under the pointer)

    /// PURE: a server's live dot through Stop's phases — green while it runs, amber while Stop waits for its second click,
    /// hollow while it is stopping, red while a force quit is offered or asked.
    static func mark(_ phase: IslandServerStopPhase?) -> IslandStatusMark {
        switch phase {
        case nil: return .dot(Color(nsColor: .systemGreen))
        case .confirming?: return .dot(pillReviewAmber)
        case .stopping?, .killing?: return .ring(Color.white.opacity(0.45))
        case .forceOffered?, .confirmingForce?: return .dot(Color(nsColor: .systemRed))
        }
    }

    /// PURE: the ports a row names under its links — every TCP port its shown links do not already carry.
    static func plainPorts(_ ports: [UInt16], links: [IslandServerLink]) -> [UInt16] {
        let linked = Set(links.map(\.port))
        return Array(Set(ports)).sorted().filter { !linked.contains($0) }
    }

    /// PURE: a server's state as words — its uptime, or Stop's ("Stopping…", "Still running").
    static func statusWords(_ row: IslandServerRow, phase: IslandServerStopPhase?, now: Date) -> String {
        switch phase {
        case .stopping?, .killing?: return "Stopping…"
        case .forceOffered?, .confirmingForce?: return "Still running"
        default: return uptime(since: row.startedAt, now: now)
        }
    }

    /// PURE: a server row as VoiceOver says it, at rest — its name, ports and state, and its whole folder (what the row
    /// shows only under the pointer).
    static func accessibilityLabel(_ row: IslandServerRow, phase: IslandServerStopPhase?, now: Date) -> String {
        var parts = [row.name, "\(row.portsLine) · \(statusWords(row, phase: phase, now: now))"]
        if let detail = detailLine(row, hovered: true) { parts.append(detail) }
        return parts.joined(separator: ", ")
    }

    /// PURE: Stop as a VoiceOver action through its phases — the button's own words ("Stop waifus", "Click again to stop
    /// waifus", "Force quit waifus", "Click again to force quit waifus"); none while it is stopping. The action is the
    /// button's: the same two clicks, the same guards.
    static func stopActionName(_ phase: IslandServerStopPhase?, name: String) -> String? {
        switch phase {
        case nil: return "Stop \(name)"
        case .confirming?: return "Click again to stop \(name)"
        case .stopping?, .killing?: return nil
        case .forceOffered?: return "Force quit \(name)"
        case .confirmingForce?: return "Click again to force quit \(name)"
        }
    }

    /// PURE: a bundle row's muted words beside its name — "2 servers" at rest (a single server with several links: its
    /// folder); under the pointer its count, its whole folder and its package.
    static func bundleWords(_ bundle: IslandServerBundle, hovered: Bool) -> String? {
        let count = bundle.isBundle ? serversWord(bundle.rows.count) : nil
        let folder = bundle.rows.first.flatMap { detailLine($0, hovered: hovered) }
        let words = hovered || count == nil ? [count, folder].compactMap { $0 } : [count].compactMap { $0 }
        return words.isEmpty ? nil : words.joined(separator: " · ")
    }

    // MARK: Rows

    /// The rows, newest first. Winter's and the agents' infrastructure (a listener with Winter or an agent up its tree
    /// and no user's shell in between — an MCP server) is never one. Each other listener is its own row unless its NEAREST listening ancestor
    /// is the same server — the same process group, or the same executable as its direct parent (a forked worker) —,
    /// in which case it joins that one's row. The walk up goes through parents that listen on nothing (`npm run dev` →
    /// `node server.js`) but never through a shell or a coding agent (hidden, it heads nothing), and stops at launchd
    /// or a process that is not the user's: a shell, tmux, a notebook's terminal or an agent session that started two
    /// servers never makes them one row, so Stop never reaches the other.
    static func rows(_ processes: [ServerProcess], user: uid_t, ownPid: Int32, home: String) -> [IslandServerRow] {
        let mine = processes.filter { $0.uid == user }
        var byPid: [Int32: ServerProcess] = [:]
        for p in mine where byPid[p.pid] == nil { byPid[p.pid] = p }

        /// The ancestors, nearest first (ending at launchd, a process that is not the user's, or a loop).
        func ancestors(_ p: ServerProcess) -> [ServerProcess] {
            var out: [ServerProcess] = []
            var seen: Set<Int32> = [p.pid]
            var parent = p.ppid
            while parent > 1, let a = byPid[parent], seen.insert(parent).inserted {
                out.append(a)
                parent = a.ppid
            }
            return out
        }
        // Winter's and the coding agents' own infrastructure: a Winter process (or this app) or an agent (`isAgent`: a
        // CLI, Claude's or another agent's app) up the tree with NO user's shell in between — an MCP server the daemon
        // or an agent started, through `npx` and its `sh -c` too. A server one ran through its
        // shell (`winter → bash -c … → bun dev`, `claude → zsh -c → vite`) is the user's, started on their behalf: listed.
        let underInfrastructure = { (p: ServerProcess) -> Bool in
            var seen: Set<Int32> = [p.pid]
            var parent = p.ppid
            while parent > 1 {
                // This app, whether or not the scan listed it.
                if parent == ownPid { return true }
                guard let a = byPid[parent], seen.insert(parent).inserted else { return false }
                if isWinter(path: a.path, command: a.command) || isAgent(a) { return true }
                // A user's shell ends it — not the `sh -c` a package runner (npx…) runs its package through.
                if isShell(a), !(byPid[a.ppid].map(isPackageRunner) ?? false) { return false }
                parent = a.ppid
            }
            return false
        }
        let qualifying = Set(mine.filter { qualifies($0, user: user, ownPid: ownPid) && !underInfrastructure($0) }.map(\.pid))

        /// The listener this one's row is: its nearest listening ancestor when that is the same server — its DIRECT
        /// parent running the same executable (a forked worker), or one in the same process group with no shell
        /// between — else itself. Never across a shell (Jupyter's or code-server's terminal runs the same `python` or
        /// `node` as the server around it) or an agent.
        func parentServer(_ p: ServerProcess) -> ServerProcess? {
            for a in ancestors(p) {
                if isShell(a) || isAgent(a) { return nil }
                guard qualifying.contains(a.pid) else { continue }
                let forkedWorker = a.pid == p.ppid && !p.path.isEmpty && a.path == p.path
                return forkedWorker || a.pgid == p.pgid ? a : nil
            }
            return nil
        }
        func head(_ p: ServerProcess) -> ServerProcess {
            var current = p
            var seen: Set<Int32> = [p.pid]
            while let next = parentServer(current), seen.insert(next.pid).inserted { current = next }
            return current
        }

        var groups: [Int32: [ServerProcess]] = [:]
        for pid in qualifying {
            guard let p = byPid[pid] else { continue }
            groups[head(p).pid, default: []].append(p)
        }
        return groups.compactMap { topPid, members -> IslandServerRow? in
            guard let top = byPid[topPid] else { return nil }
            let ordered = [top] + members.filter { $0.pid != topPid }.sorted { $0.pid < $1.pid }
            let start = Date(timeIntervalSince1970: TimeInterval(top.identity.startSeconds)
                             + TimeInterval(top.identity.startMicros) / 1_000_000)
            var loopback: [UInt16: IslandLoopback] = [:]
            for member in ordered {
                for (port, family) in member.loopback where loopback[port] != .v4 { loopback[port] = family }
            }
            let name = displayName(top)
            let root = packageRoot(top)
            return IslandServerRow(
                id: "\(top.pid)-\(top.identity.startSeconds)-\(top.identity.startMicros)",
                name: name,
                tcpPorts: Array(Set(ordered.flatMap(\.tcpPorts))).sorted(),
                startedAt: start,
                folder: top.cwd.flatMap(folderName),
                folderPath: top.cwd.map { abbreviated($0, home: home) },
                package: packageName(top),
                members: ordered.map(\.identity),
                loopback: loopback,
                cwd: top.cwd,
                packageRoot: root,
                bundleKey: bundleKey(name: name, packageRoot: root, cwd: top.cwd))
        }
        .sorted { $0.startedAt != $1.startedAt ? $0.startedAt > $1.startedAt : $0.id < $1.id }
    }

    // MARK: Bundles

    /// The project a server belongs to (user 2026-10-18: one project's servers are one row): the npm package it runs
    /// from — by its folder on disk when that is the project's own (inside its cwd: two projects' `vite`s stay two);
    /// a package from elsewhere (a global `http-server`, an npx one in `~/.npm/_npx`) is shared by every project that
    /// runs it, so it bundles only with the same cwd —, else its folder and command (the first word of its name:
    /// `waifus remote` and `waifus start` in one folder).
    static func bundleKey(name: String, packageRoot: String?, cwd: String?) -> String {
        if let packageRoot {
            if let cwd, packageRoot.hasPrefix(cwd.hasSuffix("/") ? cwd : cwd + "/") { return "package:\(packageRoot)" }
            return "package:\(packageRoot)\u{0}\(cwd ?? "")"
        }
        let command = name.split(separator: " ").first.map(String.init) ?? name
        guard let cwd else { return "name:\(command)" }
        return "folder:\(cwd)\u{0}\(command)"
    }

    /// The folder of the npm package an interpreter's script is in (`…/node_modules/@scope/name`); nil outside one.
    static func packageRoot(_ p: ServerProcess) -> String? {
        guard interpreter(executableName(p)) != nil, let args = p.arguments else { return nil }
        for script in args.dropFirst() {
            let parts = script.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
            guard let at = parts.lastIndex(of: "node_modules"), at + 1 < parts.count, parts[at + 1] != ".bin" else { continue }
            let end = parts[at + 1].hasPrefix("@") && at + 2 < parts.count ? at + 2 : at + 1
            return parts[...end].joined(separator: "/")
        }
        return nil
    }

    /// The rows by project, newest first: a bundle of one is a plain row.
    static func bundles(_ rows: [IslandServerRow]) -> [IslandServerBundle] {
        var order: [String] = []
        var byKey: [String: [IslandServerRow]] = [:]
        for row in rows {
            if byKey[row.bundleKey] == nil { order.append(row.bundleKey) }
            byKey[row.bundleKey, default: []].append(row)
        }
        return order.map { IslandServerBundle(key: $0, rows: byKey[$0] ?? []) }
    }

    // MARK: Signalling

    /// Sends `signal` to each member that is STILL the process the row saw — this user's, with the same start time
    /// (`source.identity` re-read right before, so a pid reused since is never hit) — and never, whatever the row says,
    /// to launchd, this app, its parent or a Winter process. How many were signalled.
    @discardableResult
    static func signal(_ signal: Int32, _ members: [ServerProcessIdentity], user: uid_t, ownPid: Int32, parentPid: Int32,
                       source: ServerProcessSource, signaller: ServerSignaller) -> Int {
        var sent = 0
        for m in members where m.uid == user && m.pid > 1 && m.pid != ownPid && m.pid != parentPid {
            guard let now = source.identity(of: m.pid), now == m, now.uid == user else { continue }
            guard !isWinter(path: source.path(of: m.pid), command: "") else { continue }
            if signaller.send(signal, to: m.pid) { sent += 1 }
        }
        return sent
    }

    /// Whether any member is still the process the row saw (a zombie is gone).
    static func anyAlive(_ members: [ServerProcessIdentity], source: ServerProcessSource) -> Bool {
        members.contains { source.identity(of: $0.pid) == $0 }
    }
}

/// One row: a server — its top process and that one's own listening workers.
struct IslandServerRow: Identifiable, Equatable {
    /// The top process's pid and start time.
    let id: String
    let name: String
    let tcpPorts: [UInt16]
    let startedAt: Date
    /// The cwd's last component, and the whole of it (`~` for the home) for the hover.
    let folder: String?
    let folderPath: String?
    /// The npm package a bin command comes from (`@waifucave/discord-waifus`), when its name does not say it.
    var package: String? = nil
    /// The top process first, then its listening workers.
    let members: [ServerProcessIdentity]
    /// Where each port answers on loopback (none: never probed).
    var loopback: [UInt16: IslandLoopback] = [:]
    /// The top process's folder, and its npm package's — where the icon ladder looks.
    var cwd: String? = nil
    var packageRoot: String? = nil
    /// Its project (`IslandServers.bundleKey`).
    var bundleKey: String = ""

    var portsLine: String { IslandServers.portsLine(tcpPorts) }
}

/// One project's servers (`IslandServers.bundles`): one row in the list — a bundle of several drills into its own page.
struct IslandServerBundle: Identifiable, Equatable {
    let key: String
    /// Newest first.
    let rows: [IslandServerRow]

    var id: String { key }
    var isBundle: Bool { rows.count > 1 }
    /// The id its "Stop all" is armed under.
    var stopId: String { "bundle:\(key)" }
    var members: [ServerProcessIdentity] { rows.flatMap(\.members) }
    var tcpPorts: [UInt16] { Array(Set(rows.flatMap(\.tcpPorts))).sorted() }

    /// The command its servers share ("waifus" for `waifus remote` and `waifus start`), else its package's or folder's
    /// name; a bundle of one is its server's name.
    var name: String {
        guard isBundle, let first = rows.first else { return rows.first?.name ?? "" }
        let words = rows.map { $0.name.split(separator: " ").first.map(String.init) ?? $0.name }
        if Set(words).count == 1 { return words[0] }
        if let root = first.packageRoot { return (root as NSString).lastPathComponent }
        return first.folder ?? first.name
    }
}

// MARK: - Stop (pure)

/// A row's Stop, two clicks each way: "Stop" → "Stop?" (`confirmWindow`) → SIGTERM → after `forceAfter`, still alive:
/// "Force quit" → "Force quit?" → SIGKILL. No phase: the plain Stop button. A confirm remembers when it was asked.
enum IslandServerStopPhase: Equatable {
    case confirming(at: Date)
    case stopping(sentAt: Date)
    case forceOffered
    case confirmingForce(at: Date)
    case killing(sentAt: Date)
}

enum IslandServerStopMachine {
    enum Action: Equatable { case terminate, kill }

    /// A click on the row's button. The second click of a confirm counts only after `doubleClickGuard` (a double click
    /// is one click) and within `confirmWindow` (later, it asks again).
    static func tap(_ phase: IslandServerStopPhase?, now: Date) -> (IslandServerStopPhase?, Action?) {
        switch phase {
        case nil:
            return (.confirming(at: now), nil)
        case .confirming(let at):
            let since = now.timeIntervalSince(at)
            if since < IslandServers.doubleClickGuard { return (phase, nil) }
            if since <= IslandServers.confirmWindow { return (.stopping(sentAt: now), .terminate) }
            return (.confirming(at: now), nil)
        case .forceOffered:
            return (.confirmingForce(at: now), nil)
        case .confirmingForce(let at):
            let since = now.timeIntervalSince(at)
            if since < IslandServers.doubleClickGuard { return (phase, nil) }
            if since <= IslandServers.confirmWindow { return (.killing(sentAt: now), .kill) }
            return (.confirmingForce(at: now), nil)
        case .stopping, .killing:
            return (phase, nil)
        }
    }

    /// Time passing: a confirm lapses; a signalled server still alive after `forceAfter` gets Force quit (one that
    /// went has no phase).
    static func settle(_ phase: IslandServerStopPhase?, now: Date, alive: Bool) -> IslandServerStopPhase? {
        switch phase {
        case .confirming(let at):
            return now.timeIntervalSince(at) > IslandServers.confirmWindow ? nil : phase
        case .confirmingForce(let at):
            return now.timeIntervalSince(at) > IslandServers.confirmWindow ? .forceOffered : phase
        case .stopping(let sentAt), .killing(let sentAt):
            guard now.timeIntervalSince(sentAt) >= IslandServers.forceAfter else { return phase }
            return alive ? .forceOffered : nil
        case .forceOffered, nil:
            return phase
        }
    }

    /// When the phase next changes by itself (nil: it waits for a click).
    static func deadline(_ phase: IslandServerStopPhase?) -> Date? {
        switch phase {
        case .confirming(let at), .confirmingForce(let at): return at.addingTimeInterval(IslandServers.confirmWindow + 0.05)
        case .stopping(let sentAt), .killing(let sentAt): return sentAt.addingTimeInterval(IslandServers.forceAfter)
        case .forceOffered, nil: return nil
        }
    }
}

// MARK: - The live source

/// libproc: the user's processes and their listening TCP ports. Spawns nothing. A few ms for ~1000 processes
/// (`IslandServersTests.testTheLiveSourceScans` logs the figure).
struct LibprocServerProcessSource: ServerProcessSource {
    func processes() -> [ServerProcess] {
        let user = getuid()
        let estimate = proc_listallpids(nil, 0)
        guard estimate > 0 else { return [] }
        // Room for processes started between the two calls.
        var pids = [Int32](repeating: 0, count: Int(estimate) + 64)
        let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        guard count > 0 else { return [] }
        var out: [ServerProcess] = []
        var index: [Int32: Int] = [:]
        for pid in pids.prefix(Int(count)) where pid > 0 {
            guard let info = Self.bsdInfo(pid), info.pbi_uid == user, Self.isRunning(status: info.pbi_status) else { continue }
            var p = ServerProcess(identity: Self.identity(info, pid: pid), ppid: Int32(bitPattern: info.pbi_ppid),
                                  pgid: Int32(bitPattern: info.pbi_pgid), command: Self.command(info))
            (p.tcpPorts, p.loopback) = Self.listeningPorts(pid)
            if p.listens {
                p.path = Self.path(pid)
                p.cwd = Self.cwd(pid)
                if IslandServers.interpreter(IslandServers.executableName(p)) != nil { p.arguments = Self.arguments(pid) }
            }
            index[pid] = out.count
            out.append(p)
        }
        // A listener's ancestors with their path and argv (Winter? an agent? a package runner?) — only theirs, each read
        // once.
        for i in out.indices where out[i].listens {
            var parent = out[i].ppid
            var seen: Set<Int32> = []
            while parent > 1, let j = index[parent], seen.insert(parent).inserted {
                if out[j].path.isEmpty {
                    out[j].path = Self.path(parent)
                    // Its argv too: an agent's script, a package runner's subcommand (`npm exec`).
                    out[j].arguments = Self.arguments(parent)
                }
                parent = out[j].ppid
            }
        }
        return out
    }

    func identity(of pid: Int32) -> ServerProcessIdentity? {
        guard let info = Self.bsdInfo(pid), Self.isRunning(status: info.pbi_status) else { return nil }
        return Self.identity(info, pid: pid)
    }

    func path(of pid: Int32) -> String { Self.path(pid) }

    /// PURE: a zombie (`SZOMB`) has exited — gone, whatever its pid still says.
    static func isRunning(status: UInt32) -> Bool { status != UInt32(SZOMB) }

    private static func identity(_ info: proc_bsdinfo, pid: Int32) -> ServerProcessIdentity {
        ServerProcessIdentity(pid: pid, uid: info.pbi_uid, startSeconds: info.pbi_start_tvsec, startMicros: info.pbi_start_tvusec)
    }

    private static func bsdInfo(_ pid: Int32) -> proc_bsdinfo? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return info
    }

    /// The TCP ports the process listens on (`TSI_S_LISTEN` only — a connected socket is not a server), each once: v4
    /// and v6 listeners on one port are one; and where each answers on loopback (`IslandLoopback.of`).
    private static func listeningPorts(_ pid: Int32) -> ([UInt16], [UInt16: IslandLoopback]) {
        let bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard bytes > 0 else { return ([], [:]) }
        let stride = MemoryLayout<proc_fdinfo>.stride
        var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(bytes) / stride + 16)
        let used = fds.withUnsafeMutableBytes { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
        guard used > 0 else { return ([], [:]) }
        var ports: [UInt16] = []
        var loopback: [UInt16: IslandLoopback] = [:]
        let size = Int32(MemoryLayout<socket_fdinfo>.size)
        for fd in fds.prefix(Int(used) / stride) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
            var socket = socket_fdinfo()
            guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &socket, size) == size,
                  socket.psi.soi_kind == Int32(SOCKINFO_TCP) else { continue }
            let info = socket.psi.soi_proto.pri_tcp
            guard info.tcpsi_state == TSI_S_LISTEN else { continue }
            // `insi_lport` is in network byte order.
            let ini = info.tcpsi_ini
            let port = UInt16(bigEndian: UInt16(truncatingIfNeeded: ini.insi_lport))
            if !ports.contains(port) { ports.append(port) }
            let family: IslandLoopback?
            if ini.insi_vflag & UInt8(INI_IPV4) != 0 {
                family = IslandLoopback.of(v4: UInt32(bigEndian: ini.insi_laddr.ina_46.i46a_addr4.s_addr))
            } else if ini.insi_vflag & UInt8(INI_IPV6) != 0 {
                family = IslandLoopback.of(v6: withUnsafeBytes(of: ini.insi_laddr.ina_6) { Array($0) })
            } else {
                family = nil
            }
            if let family, loopback[port] != .v4 { loopback[port] = family }
        }
        return (ports, loopback)
    }

    private static func path(_ pid: Int32) -> String {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return "" }
        return String(cString: buffer)
    }

    private static func command(_ info: proc_bsdinfo) -> String {
        let name = string(info.pbi_name)
        return name.isEmpty ? string(info.pbi_comm) : name
    }

    private static func cwd(_ pid: Int32) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
        let path = string(info.pvi_cdir.vip_path)
        return path.isEmpty ? nil : path
    }

    /// A fixed C char array (a tuple, as Swift imports it) up to its first NUL — never past its end.
    private static func string<T>(_ tuple: T) -> String {
        withUnsafeBytes(of: tuple) { raw in
            let bytes = raw.prefix { $0 != 0 }
            return String(decoding: bytes, as: UTF8.self)
        }
    }

    /// argv (`KERN_PROCARGS2`) — read for an interpreter only.
    private static func arguments(_ pid: Int32) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return nil }
        return parseProcArgs(Array(buffer.prefix(size)))
    }

    /// PURE: `KERN_PROCARGS2`'s layout — `argc` (an Int32), the executable's path, NUL padding, then `argc` strings.
    static func parseProcArgs(_ bytes: [UInt8]) -> [String]? {
        let head = MemoryLayout<Int32>.size
        guard bytes.count > head else { return nil }
        let argc = bytes.prefix(head).withUnsafeBytes { Int($0.loadUnaligned(as: Int32.self)) }
        guard argc > 0 else { return nil }
        var i = head
        // The executable's path, then its padding.
        while i < bytes.count, bytes[i] != 0 { i += 1 }
        while i < bytes.count, bytes[i] == 0 { i += 1 }
        var out: [String] = []
        while out.count < argc, i < bytes.count {
            let start = i
            while i < bytes.count, bytes[i] != 0 { i += 1 }
            out.append(String(decoding: bytes[start..<i], as: UTF8.self))
            i += 1
        }
        return out.isEmpty ? nil : out
    }
}

// MARK: - The model

/// The Servers tab's state: the rows from a scan (on open and on the open island's beat while this tab shows — never
/// in the background), their links and icons (probed on loopback, once per server and port, after a scan), the page
/// of the bundle drilled into, and each Stop.
@MainActor
final class IslandServersModel: ObservableObject {
    @Published private(set) var rows: [IslandServerRow] = []
    @Published private(set) var loaded = false
    @Published private(set) var stops: [String: IslandServerStopPhase] = [:]
    /// What each server's ports said (`IslandServers.probeKey`), kept while the server runs — each probed once.
    @Published private(set) var http: [String: IslandHTTPProbe] = [:]
    /// Each project's icon (`IslandServerBundle.key`).
    @Published private(set) var icons: [String: NSImage] = [:]
    /// The bundle whose page shows (nil: the list).
    @Published private(set) var openBundle: String?

    var source: ServerProcessSource = LibprocServerProcessSource()
    var signaller: ServerSignaller = LiveServerSignaller()
    var prober: IslandServerProber = IslandLiveServerProber()
    /// A link's click: the user's default browser.
    var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
    var now: () -> Date = { Date() }
    /// Runs the closure after the delay: ONE wake-up per row's armed confirm or stop, nothing while none is (the tests
    /// fire them by hand).
    var schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, action in
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(max(0, delay)))
            action()
        }
    }
    var user: uid_t = getuid()
    var ownPid: Int32 = getpid()
    var parentPid: Int32 = getppid()
    var home: String = NSHomeDirectory()
    /// Each Stop's one armed wake-up (its deadline): a newer one supersedes it, a second for the same is not armed.
    private var wakes: [String: Date] = [:]
    /// What each armed Stop signals: a server's processes, or a bundle's ("Stop all").
    private var targets: [String: [ServerProcessIdentity]] = [:]
    /// Which HTTP ports each project's icon was last looked for with: a new one (a page that came up) looks again.
    private var iconTried: [String: String] = [:]
    /// Ports that took the connection but answered late: how often, and when to ask again (`IslandServers.retryAfter`).
    private var retries: [String: (attempts: Int, next: Date)] = [:]
    /// A probe pass in flight (a refresh while one runs does not start another).
    private var probing = false

    var bundles: [IslandServerBundle] { IslandServers.bundles(rows) }

    func bundle(_ key: String) -> IslandServerBundle? { bundles.first { $0.key == key } }

    /// A scan, off the main thread, then the probes. `resetPage` (the island opened, or the tab was switched to): back to
    /// the list — the 5 s beat never moves the user off a page.
    func refresh(resetPage: Bool = false) async {
        if resetPage { openBundle = nil }
        let source = source
        let processes = await Task.detached(priority: .userInitiated) { source.processes() }.value
        apply(processes)
        await probe()
    }

    /// The rows from a scan; a gone row's Stop, probes and page go with it (a row still there keeps its Stop, mid-confirm
    /// included). Never probes (the offscreen gallery applies a made-up list).
    func apply(_ processes: [ServerProcess]) {
        rows = IslandServers.rows(processes, user: user, ownPid: ownPid, home: home)
        let ids = Set(rows.map(\.id)).union(bundles.map(\.stopId))
        stops = stops.filter { ids.contains($0.key) }
        wakes = wakes.filter { ids.contains($0.key) }
        targets = targets.filter { ids.contains($0.key) }
        let ports = Set(rows.flatMap { row in row.tcpPorts.map { IslandServers.probeKey(row, $0) } })
        http = http.filter { ports.contains($0.key) }
        retries = retries.filter { ports.contains($0.key) }
        if let open = openBundle, bundle(open) == nil { openBundle = nil }
        loaded = true
    }

    // MARK: Links and icons

    /// Probes each server's loopback ports with no answer yet (at most `IslandServerProbes.limit` at once; a late one
    /// again only once its backoff is over), then looks for the icon of each project whose HTTP ports changed. Off the
    /// main thread; only from `refresh`.
    func probe() async {
        guard !probing else { return }
        probing = true
        defer { probing = false }
        let time = now()
        let pending: [(key: String, host: IslandLoopback, port: UInt16, ports: Set<UInt16>)] = rows.flatMap { row in
            row.tcpPorts.compactMap { port in
                let key = IslandServers.probeKey(row, port)
                guard let host = row.loopback[port], http[key] == nil else { return nil }
                if let retry = retries[key], retry.next > time { return nil }
                return (key, host, port, Set(row.tcpPorts))
            }
        }
        let prober = prober
        let results = await IslandServerProbes.run(pending.map { job in { prober.probe(job.host, port: job.port, ports: job.ports) } })
        for (job, result) in zip(pending, results) {
            if result.late {
                // Not an answer (a dev server still compiling its first page): asked again later.
                let attempts = (retries[job.key]?.attempts ?? 0) + 1
                retries[job.key] = (attempts, now().addingTimeInterval(IslandServers.retryAfter(attempt: attempts)))
            } else {
                http[job.key] = result
                retries[job.key] = nil
            }
        }

        var lookups: [(key: String, signature: String, pages: [(probe: IslandHTTPProbe, host: IslandLoopback, port: UInt16)],
                       folders: [String])] = []
        for bundle in bundles {
            var pages: [(probe: IslandHTTPProbe, host: IslandLoopback, port: UInt16)] = []
            for row in bundle.rows {
                for link in IslandServers.links(row, http: http) {
                    if let probe = http[IslandServers.probeKey(row, link.port)] { pages.append((probe, link.host, link.port)) }
                }
            }
            pages.sort { $0.probe.isHTML != $1.probe.isHTML ? $0.probe.isHTML : $0.port < $1.port }
            let signature = pages.map { "\($0.port)\($0.probe.isHTML ? "h" : "")" }.joined(separator: ",")
            guard iconTried[bundle.key] != signature else { continue }
            var folders: [String] = []
            for row in bundle.rows {
                for folder in [row.cwd, row.packageRoot].compactMap({ $0 }) where !folders.contains(folder) { folders.append(folder) }
            }
            lookups.append((bundle.key, signature, pages, folders))
        }
        let found = await IslandServerProbes.run(lookups.map { job in { prober.icon(pages: job.pages, folders: job.folders) } })
        for (job, image) in zip(lookups, found) {
            iconTried[job.key] = job.signature
            // Already a small thumbnail, decoded off the main thread: only wrapped here.
            if let image { icons[job.key] = NSImage(cgImage: image, size: .zero) }
        }
    }

    /// A server's links, the page first.
    func links(_ row: IslandServerRow) -> [IslandServerLink] { IslandServers.links(row, http: http) }

    /// A bundle's one link on its row: a page first, else its first HTTP port.
    func link(_ bundle: IslandServerBundle) -> IslandServerLink? {
        bundle.rows.flatMap(links).sorted { $0.isHTML != $1.isHTML ? $0.isHTML : $0.port < $1.port }.first
    }

    /// Whether a bundle's row opens a page: several servers, or one with several links.
    func drills(_ bundle: IslandServerBundle) -> Bool {
        bundle.isBundle || bundle.rows.contains { links($0).count > 1 }
    }

    func open(_ link: IslandServerLink) { openURL(link.url) }

    // MARK: The page

    /// Drills into a bundle's page.
    func open(_ bundle: IslandServerBundle) { openBundle = bundle.key }

    /// Back to the list.
    func back() { openBundle = nil }

    // MARK: Stop

    /// A click on a row's Stop / Stop? / Force quit / Force quit?.
    func tap(_ row: IslandServerRow) { tap(id: row.id, members: row.members) }

    /// A click on a bundle's "Stop all" — the same two clicks and guards, for every one of its servers.
    func tapAll(_ bundle: IslandServerBundle) { tap(id: bundle.stopId, members: bundle.members) }

    private func tap(id: String, members: [ServerProcessIdentity]) {
        let (next, action) = IslandServerStopMachine.tap(stops[id], now: now())
        var phase = next
        if let action {
            targets[id] = members
            let sent = IslandServers.signal(action == .terminate ? SIGTERM : SIGKILL, members, user: user, ownPid: ownPid,
                                            parentPid: parentPid, source: source, signaller: signaller)
            // Nothing left to signal (it went, or its pid is someone else's now): the row goes at the next scan.
            if sent == 0 { phase = nil }
        }
        stops[id] = phase
        arm(id)
    }

    /// Re-judges every Stop against the clock (a lapsed confirm, a server still up after SIGTERM).
    func settle() {
        let time = now()
        for (id, phase) in stops {
            let members = targets[id] ?? rows.first { $0.id == id }?.members ?? bundles.first { $0.stopId == id }?.members ?? []
            let alive = IslandServers.anyAlive(members, source: source)
            stops[id] = IslandServerStopMachine.settle(phase, now: time, alive: alive)
            guard !alive, stops[id] == nil else { continue }
            let gone = Set(members)
            rows.removeAll { $0.id == id || Set($0.members).isSubset(of: gone) }
            if let open = openBundle, bundle(open) == nil { openBundle = nil }
        }
    }

    /// The Stop's next wake-up — once per deadline; one that a newer deadline replaced does nothing when it fires.
    private func arm(_ id: String) {
        guard let deadline = IslandServerStopMachine.deadline(stops[id]) else {
            wakes[id] = nil
            return
        }
        guard wakes[id] != deadline else { return }
        wakes[id] = deadline
        schedule(deadline.timeIntervalSince(now())) { [weak self] in
            guard let self, self.wakes[id] == deadline else { return }
            self.wakes[id] = nil
            self.settle()
            self.arm(id)
        }
    }

    /// Test seams.
    func setForTesting(_ rows: [IslandServerRow]) {
        self.rows = rows
        loaded = true
    }

    func setProbesForTesting(_ http: [String: IslandHTTPProbe]) { self.http = http }

    /// Test and gallery seam: Stop's phases as they would be — set directly, never by a click (nothing is signalled).
    func setStopsForTesting(_ stops: [String: IslandServerStopPhase]) { self.stops = stops }
}

// MARK: - The view

struct IslandServersTab: View {
    @ObservedObject var model: IslandServersModel
    var scrolls = true
    var now: () -> Date = { Date() }

    var body: some View {
        if !model.loaded {
            IslandEmptyTab(symbol: "server.rack", line: "Looking for servers…")
        } else if model.rows.isEmpty {
            IslandEmptyTab(symbol: "server.rack", line: "No servers running")
        } else if let key = model.openBundle, let bundle = model.bundle(key) {
            IslandTabScroll(scrolls: scrolls) { IslandServersPage(model: model, bundle: bundle, now: now()) }
        } else {
            IslandTabScroll(scrolls: scrolls) { list }
        }
    }

    private var list: some View {
        let time = now()
        return VStack(alignment: .leading, spacing: IslandQuietRow.rowGap) {
            ForEach(model.bundles) { bundle in
                if model.drills(bundle) {
                    IslandServerBundleRowView(model: model, bundle: bundle, now: time)
                } else if let row = bundle.rows.first {
                    IslandServerRowView(row: row, phase: model.stops[row.id], now: time, icon: model.icons[bundle.key],
                                        links: Array(model.links(row).prefix(1)), onLink: model.open) { model.tap(row) }
                }
            }
        }
        .padding(.horizontal, IslandQuietRow.inset)
        .padding(.top, 2)
        .padding(.bottom, IslandLayout.listInset)
    }
}

/// A bundle's page, inside the Servers tab: back (‹, in the rows' mark column), its name, how many servers and "Stop
/// all", then each of its servers as a row — its own Stop and every link.
struct IslandServersPage: View {
    @ObservedObject var model: IslandServersModel
    let bundle: IslandServerBundle
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: IslandQuietRow.rowGap) {
            HStack(spacing: IslandQuietRow.markGap) {
                // The island's "previous": back to the list.
                Button { model.back() } label: {
                    Image(systemName: "chevron.left")
                        .font(Typography.caption(.bold))
                        .foregroundStyle(Color.white)
                        .frame(width: IslandQuietRow.markWidth, height: IslandRowSmall.height + 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(IslandPressStyle())
                .accessibilityLabel("Back to servers")
                Text(bundle.name)
                    .font(IslandQuietRow.titleFont)
                    .foregroundStyle(Color.white)
                    .lineLimit(1)
                Text(IslandServers.serversWord(bundle.rows.count))
                    .font(IslandQuietRow.wordsFont)
                    .foregroundStyle(Theme.textMuted)
                Spacer(minLength: 8)
                IslandServerStopButton(phase: model.stops[bundle.stopId], name: "every \(bundle.name) server",
                                       idleTitle: "Stop all") { model.tapAll(bundle) }
            }
            .padding(.bottom, 2)
            ForEach(bundle.rows) { row in
                IslandServerRowView(row: row, phase: model.stops[row.id], now: now, icon: model.icons[bundle.key],
                                    links: model.links(row), onLink: model.open) { model.tap(row) }
            }
        }
        .padding(.horizontal, IslandQuietRow.inset)
        .padding(.bottom, IslandLayout.listInset)
    }
}

/// A bundle's row in the list (several servers, or one with several links), in the island's language: its logo stacked
/// as many times as it has servers (a project's servers share its one logo), its name and "2 servers" (muted), a live
/// dot and a chevron. Under the pointer the name lifts, its whole folder shows, and its ports, its one link and its
/// uptime appear under it in words. A click opens its page.
struct IslandServerBundleRowView: View {
    @ObservedObject var model: IslandServersModel
    let bundle: IslandServerBundle
    let now: Date

    var body: some View {
        HoverLiftReader(id: "server:\(bundle.key)") { hovered in
            IslandLiftRow(title: bundle.name, side: IslandServers.bundleWords(bundle, hovered: hovered), hovered: hovered) {
                IslandServerIconStack(image: model.icons[bundle.key], count: bundle.rows.count)
            } trailing: {
                HStack(spacing: 10) {
                    IslandStatusMarkView(mark: IslandServers.mark(nil))
                    Image(systemName: "chevron.right")
                        .font(Typography.tiny(.bold))
                        .foregroundStyle(hovered ? Color.white : Theme.textMuted)
                }
            } below: {
                if hovered {
                    let links = model.link(bundle).map { [$0] } ?? []
                    IslandServerDetails(links: links, ports: IslandServers.plainPorts(bundle.tcpPorts, links: links),
                                        status: IslandServers.uptime(since: oldest, now: now), onLink: model.open) { EmptyView() }
                        .transition(.opacity)
                }
            }
        }
        .onTapGesture { model.open(bundle) }
        // One element for VoiceOver, which never hovers: its words, and its link as an action (shown under the pointer).
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(bundle.name), \(secondLine)")
        .accessibilityAction { model.open(bundle) }
        .accessibilityAction(named: "Show its servers") { model.open(bundle) }
        .accessibilityActions {
            if let link = model.link(bundle) { Button("Open \(link.label)") { model.open(link) } }
        }
    }

    /// The bundle's oldest start: the project's uptime.
    private var oldest: Date { bundle.rows.map(\.startedAt).min() ?? now }

    private var secondLine: String {
        let ports = IslandServers.portsLine(bundle.tcpPorts)
        if bundle.isBundle { return "\(IslandServers.serversWord(bundle.rows.count)) · \(ports)" }
        guard let row = bundle.rows.first else { return ports }
        return "\(ports) · \(IslandServers.uptime(since: row.startedAt, now: now))"
    }
}

/// A server as a row in the island's language: its logo (else a small glyph), its name and folder (muted) and a small
/// live dot. Under the pointer the name lifts, the whole folder shows, and under it its links and ports in words
/// (a link opens the page), its uptime in words, and Stop — in the row's flow after the links. Once Stop is pressed the
/// details and Stop stay on screen through every phase whatever the pointer does. Stop's two clicks, its force quit and
/// every guard are `IslandServerStopMachine`'s and `IslandServersModel`'s, untouched.
struct IslandServerRowView: View {
    let row: IslandServerRow
    let phase: IslandServerStopPhase?
    let now: Date
    var icon: NSImage?
    /// Its links shown (the list: the page's one; a bundle's page: all).
    var links: [IslandServerLink] = []
    var onLink: (IslandServerLink) -> Void = { _ in }
    let onStop: () -> Void

    var body: some View {
        HoverLiftReader(id: "server:\(row.id)") { hovered in
            let actions = IslandQuietRow.showsActions(hovered: hovered, busy: phase != nil)
            IslandLiftRow(title: row.name, side: IslandServers.detailLine(row, hovered: hovered), hovered: hovered) {
                IslandServerIcon(image: icon)
            } trailing: {
                IslandStatusMarkView(mark: IslandServers.mark(phase))
            } below: {
                if actions {
                    IslandServerDetails(links: links, ports: IslandServers.plainPorts(row.tcpPorts, links: links),
                                        status: IslandServers.statusWords(row, phase: phase, now: now), onLink: onLink) {
                        IslandServerStopButton(phase: phase, name: row.name, action: onStop)
                    }
                    .transition(.opacity)
                }
            }
            .animation(HoverLift.animation, value: phase)
        }
        // One element for VoiceOver, which never hovers: its words, and Stop (the same two clicks) and every link as
        // its actions, whatever is shown.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(IslandServers.accessibilityLabel(row, phase: phase, now: now))
        .accessibilityActions {
            if let stop = IslandServers.stopActionName(phase, name: row.name) { Button(stop, action: onStop) }
            ForEach(links) { link in Button("Open \(link.label)") { onLink(link) } }
        }
    }
}

/// What a server row reveals under its name: its links (a page first) and its other ports in words, its uptime
/// (or Stop's state) in words, and — at its end, in the row's flow after the links — Stop.
struct IslandServerDetails<Stop: View>: View {
    let links: [IslandServerLink]
    let ports: [UInt16]
    let status: String
    let onLink: (IslandServerLink) -> Void
    @ViewBuilder let stop: () -> Stop

    var body: some View {
        HStack(spacing: 6) {
            ForEach(links) { link in IslandServerLinkButton(link: link) { onLink(link) } }
            ForEach(ports, id: \.self) { port in
                Text(":\(port)").font(Typography.tinyDigits(.medium)).foregroundStyle(Theme.textMuted).lineLimit(1)
            }
            Text(status)
                .font(Typography.tinyDigits())
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .padding(.leading, 2)
            Spacer(minLength: 8)
            stop()
        }
        .frame(minHeight: IslandRowSmall.height + 4)
    }
}

/// A row's mark: the server's own logo (its page's, its project's) with rounded corners, else the server glyph, muted.
struct IslandServerIcon: View {
    let image: NSImage?
    var size: CGFloat = 16

    var body: some View {
        if let image {
            Image(nsImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
                .accessibilityHidden(true)
        } else {
            Image(systemName: "server.rack")
                .font(Typography.caption(.semibold))
                .foregroundStyle(Theme.textMuted)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}

/// A project's servers as its logo stacked — one layer per server (up to three), the ones behind peeking out above and
/// to the right, fainter: the members share the project's one logo, so the stack says how many, not whose.
struct IslandServerIconStack: View {
    let image: NSImage?
    let count: Int

    static let size: CGFloat = 14
    static let step: CGFloat = 2.5

    var body: some View {
        let layers = max(1, min(count, 3))
        ZStack(alignment: .bottomLeading) {
            ForEach(Array((0..<layers).reversed()), id: \.self) { i in
                IslandServerIcon(image: image, size: Self.size)
                    .background(RoundedRectangle(cornerRadius: Self.size * 0.24, style: .continuous).fill(Color.black))
                    .opacity(i == 0 ? 1 : (i == 1 ? 0.55 : 0.3))
                    .offset(x: CGFloat(i) * Self.step, y: -CGFloat(i) * Self.step)
            }
        }
        .frame(width: Self.size + Self.step * 2, height: Self.size + Self.step * 2, alignment: .bottomLeading)
        .accessibilityHidden(true)
    }
}

/// A link to a server's page — "localhost:3888 ↗" as words, the usage block's "Open usage ↗" — opened in the default
/// browser.
struct IslandServerLinkButton: View {
    let link: IslandServerLink
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IslandLinkWords(text: link.label)
                .contentShape(Rectangle())
        }
        .buttonStyle(IslandPressStyle())
        .help("Open \(link.url.absoluteString)")
        .accessibilityLabel("Open \(link.label)")
    }
}

/// Stop through its phases, as words: "Stop" (or a bundle's "Stop all"); "Stop?" (amber) waiting for the second click;
/// "Stopping…" (muted); "Force quit", then "Force quit?" (red).
struct IslandServerStopButton: View {
    let phase: IslandServerStopPhase?
    let name: String
    /// At rest, these words instead of "Stop" ("Stop all").
    var idleTitle: String? = nil
    let action: () -> Void

    var body: some View {
        switch phase {
        case nil:
            IslandRowActionButton(title: idleTitle ?? "Stop", action: action)
                .accessibilityLabel("Stop \(name)")
        case .confirming?:
            IslandRowActionButton(title: idleTitle.map { "\($0)?" } ?? "Stop?", tone: .confirm, action: action)
                .accessibilityLabel("Click again to stop \(name)")
        case .stopping?, .killing?:
            IslandRowActionButton(title: "Stopping…", tone: .busy, enabled: false, action: action)
        case .forceOffered?:
            IslandRowActionButton(title: "Force quit", action: action)
                .accessibilityLabel("Force quit \(name)")
        case .confirmingForce?:
            IslandRowActionButton(title: "Force quit?", tone: .danger, action: action)
                .accessibilityLabel("Click again to force quit \(name)")
        }
    }
}
