import Darwin
import Foundation
import SwiftUI
import WinterCUPresentation

// The Winter island's Servers tab (`docs/claude/island.md`): the user's own processes listening on a TCP port or a
// Unix-domain socket — a server they started by hand (`waifus remote`, `bun dev`, `python3 -m http.server`) — with
// its name, ports, uptime and folder, and Stop.
//
//   - DETECTION is the app's own, local process state (no daemon): libproc — `proc_listallpids`, `PROC_PIDTBSDINFO`
//     (uid, parent, start time), `PROC_PIDLISTFDS` + `PROC_PIDFDSOCKETINFO` (a TCP socket in `TSI_S_LISTEN`, a Unix
//     socket with `SO_ACCEPTCONN`), `proc_pidpath`, `PROC_PIDVNODEPATHINFO` (the cwd) and, for an interpreter only,
//     `KERN_PROCARGS2` (its script). Nothing is spawned. A scan runs off the main thread only while the island is open
//     on this tab (the open island's refresh beat) — never in the background.
//   - EXCLUDED: Apple's and the system's (`/System`, `/usr/libexec`, `/usr/sbin`, `/usr/bin`, `/bin`, `/sbin`,
//     `/Library/Apple`, `/Library/Developer` — Xcode's tools and the simulators), anything inside a `.app` bundle (a GUI
//     app's ports are not a server you started), Winter's own (`winter-core`, `winter`, this app), `launchd`. An
//     interpreter (node, bun, deno, python, ruby, java, php, perl) under `/usr/bin` or `/Library/Developer`, or in a
//     `.framework`'s `Python.app`, IS listed.
//   - ONE ROW per process tree: a listener's top ancestor that listens too, with the union of their ports.
//   - STOP: two clicks within `confirmWindow`; SIGTERM to the row's processes, each re-checked (still this user's, the
//     same start time — a reused pid is never hit) right before; still alive after `forceAfter` → "Force quit"
//     (SIGKILL), two clicks again.

// MARK: - What a scan reads

/// A process's identity: its pid with the user and start time it had — a pid reused by a later process differs.
struct ServerProcessIdentity: Hashable {
    let pid: Int32
    let uid: uid_t
    let startSeconds: UInt64
    let startMicros: UInt64
}

/// One of the user's processes, as a scan saw it. Only a LISTENING one carries its path's details (cwd, arguments);
/// the others are there for the process tree.
struct ServerProcess: Equatable {
    let identity: ServerProcessIdentity
    let ppid: Int32
    /// The executable (`proc_pidpath`); empty when it could not be read (a deleted binary).
    var path: String = ""
    /// The kernel's short name (`pbi_name`, else `pbi_comm`): the name when the path is unknown.
    var command: String = ""
    var cwd: String?
    /// Listening TCP ports.
    var tcpPorts: [UInt16] = []
    /// Listening Unix-domain sockets' paths (an unnamed one: "").
    var unixSockets: [String] = []
    /// The process's argv (an interpreter's only).
    var arguments: [String]?

    var pid: Int32 { identity.pid }
    var uid: uid_t { identity.uid }
    var listens: Bool { !tcpPorts.isEmpty || !unixSockets.isEmpty }
}

/// Where the processes come from: libproc live, a fake list in the tests.
protocol ServerProcessSource {
    /// The user's processes — every one (the tree walks through a parent that listens on nothing), the listening ones
    /// with their path, cwd and, for an interpreter, their arguments.
    func processes() -> [ServerProcess]
    /// The process with this pid now (nil: gone, or not readable).
    func identity(of pid: Int32) -> ServerProcessIdentity?
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
    /// After SIGTERM, how long a server has before Force quit is offered.
    static let forceAfter: TimeInterval = 5

    enum Interpreter: Equatable {
        case node, bun, deno, python, ruby, java, php, perl
    }

    /// Apple's and the system's — never a server the user started. (`/usr/bin` and `/Library/Developer` spare an
    /// interpreter: `/usr/bin/python3` runs Xcode's or the Command Line Tools' Python.)
    static let systemPrefixes = ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/", "/bin/", "/Library/Apple/"]
    static let interpreterPrefixes = ["/usr/bin/", "/Library/Developer/"]
    /// Winter's own processes, by executable name (the app itself is excluded by pid and by its `.app`).
    static let winterNames: Set<String> = ["winter-core", "winter"]

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

    /// Whether the process is never a row: the system's, Apple's, a GUI app's, Winter's own, launchd.
    static func isExcluded(_ p: ServerProcess, ownPid: Int32) -> Bool {
        if p.pid <= 1 || p.pid == ownPid { return true }
        let name = executableName(p)
        if name == "launchd" || winterNames.contains(name) { return true }
        // An unknown path (a deleted binary) matches no path rule: listed by its short command.
        guard !p.path.isEmpty else { return false }
        let interpreted = interpreter(name) != nil
        if systemPrefixes.contains(where: p.path.hasPrefix) { return true }
        if !interpreted, interpreterPrefixes.contains(where: p.path.hasPrefix) { return true }
        // Inside a `.app` bundle: a GUI app's — except an interpreter in a framework's app (Python's `Python.app`).
        let parts = p.path.split(separator: "/")
        if let app = parts.lastIndex(where: { $0.lowercased().hasSuffix(".app") }) {
            let inFramework = parts[..<app].contains { $0.lowercased().hasSuffix(".framework") }
            if !(interpreted && inFramework) { return true }
        }
        return false
    }

    /// A row's process: this user's, listening, not excluded.
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
        // A package's own bin (`node_modules/.bin/vite` resolves to `node_modules/vite/bin/vite.js`): the package —
        // or, for a runner, the script it runs.
        if let package = nodeModulesPackage(script) {
            if jsRunners.contains(package), positional.count > 1 { return fileScriptName(positional[1], cwd: cwd) }
            return package
        }
        return fileScriptName(script, cwd: cwd)
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
            return fileScriptName(a, cwd: cwd)
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
            return fileScriptName(a, cwd: cwd)
        }
        return nil
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

    /// ":3000 :8080 socket" — the TCP ports in order, then the Unix sockets ("socket", "2 sockets").
    static func portsLine(tcp: [UInt16], unixSockets: Int) -> String {
        var words = Array(Set(tcp)).sorted().map { ":\($0)" }
        if unixSockets == 1 { words.append("socket") } else if unixSockets > 1 { words.append("\(unixSockets) sockets") }
        return words.joined(separator: " ")
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

    // MARK: Rows

    /// The rows: each qualifying process under its TOP qualifying ancestor (a server's forked workers, a watcher's
    /// child) — the walk goes through parents that listen on nothing (`npm run dev` → `node server.js`) and stops at
    /// launchd or a process that is not the user's. Newest first.
    static func rows(_ processes: [ServerProcess], user: uid_t, ownPid: Int32, home: String) -> [IslandServerRow] {
        let mine = processes.filter { $0.uid == user }
        var byPid: [Int32: ServerProcess] = [:]
        for p in mine where byPid[p.pid] == nil { byPid[p.pid] = p }
        let qualifying = Set(mine.filter { qualifies($0, user: user, ownPid: ownPid) }.map(\.pid))

        func top(_ pid: Int32) -> Int32 {
            var top = pid
            var seen: Set<Int32> = [pid]
            var parent = byPid[pid]?.ppid
            while let ppid = parent, ppid > 1, let p = byPid[ppid], seen.insert(ppid).inserted {
                if qualifying.contains(ppid) { top = ppid }
                parent = p.ppid
            }
            return top
        }

        var groups: [Int32: [ServerProcess]] = [:]
        for pid in qualifying {
            guard let p = byPid[pid] else { continue }
            groups[top(pid), default: []].append(p)
        }
        return groups.compactMap { topPid, members -> IslandServerRow? in
            guard let head = byPid[topPid] else { return nil }
            let ordered = [head] + members.filter { $0.pid != topPid }.sorted { $0.pid < $1.pid }
            let sockets = Set(ordered.flatMap(\.unixSockets))
            let start = Date(timeIntervalSince1970: TimeInterval(head.identity.startSeconds)
                             + TimeInterval(head.identity.startMicros) / 1_000_000)
            return IslandServerRow(
                id: "\(head.pid)-\(head.identity.startSeconds)-\(head.identity.startMicros)",
                name: displayName(head),
                tcpPorts: Array(Set(ordered.flatMap(\.tcpPorts))).sorted(),
                unixSockets: sockets.count,
                startedAt: start,
                folder: head.cwd.flatMap(folderName),
                folderPath: head.cwd.map { abbreviated($0, home: home) },
                members: ordered.map(\.identity))
        }
        .sorted { $0.startedAt != $1.startedAt ? $0.startedAt > $1.startedAt : $0.id < $1.id }
    }

    // MARK: Signalling

    /// Sends `signal` to each member that is STILL the process the row saw — this user's, with the same start time
    /// (`source.identity` re-read right before, so a pid reused since is never hit). How many were signalled.
    @discardableResult
    static func signal(_ signal: Int32, _ members: [ServerProcessIdentity], user: uid_t, source: ServerProcessSource,
                       signaller: ServerSignaller) -> Int {
        var sent = 0
        for m in members where m.uid == user && m.pid > 1 {
            guard let now = source.identity(of: m.pid), now == m, now.uid == user else { continue }
            if signaller.send(signal, to: m.pid) { sent += 1 }
        }
        return sent
    }

    /// Whether any member is still the process the row saw.
    static func anyAlive(_ members: [ServerProcessIdentity], source: ServerProcessSource) -> Bool {
        members.contains { source.identity(of: $0.pid) == $0 }
    }
}

/// One row: a process tree that listens.
struct IslandServerRow: Identifiable, Equatable {
    /// The top process's pid and start time.
    let id: String
    let name: String
    let tcpPorts: [UInt16]
    let unixSockets: Int
    let startedAt: Date
    /// The cwd's last component, and the whole of it (`~` for the home) for the hover.
    let folder: String?
    let folderPath: String?
    /// The top process first, then its listening descendants.
    let members: [ServerProcessIdentity]

    var portsLine: String { IslandServers.portsLine(tcp: tcpPorts, unixSockets: unixSockets) }
}

// MARK: - Stop (pure)

/// A row's Stop, two clicks each way: "Stop" → "Stop?" (`confirmWindow`) → SIGTERM → after `forceAfter`, still alive:
/// "Force quit" → "Force quit?" → SIGKILL. No phase: the plain Stop button.
enum IslandServerStopPhase: Equatable {
    case confirming(until: Date)
    case stopping(sentAt: Date)
    case forceOffered
    case confirmingForce(until: Date)
    case killing(sentAt: Date)
}

enum IslandServerStopMachine {
    enum Action: Equatable { case terminate, kill }

    /// A click on the row's button.
    static func tap(_ phase: IslandServerStopPhase?, now: Date) -> (IslandServerStopPhase?, Action?) {
        switch phase {
        case nil:
            return (.confirming(until: now.addingTimeInterval(IslandServers.confirmWindow)), nil)
        case .confirming(let until):
            if now <= until { return (.stopping(sentAt: now), .terminate) }
            return (.confirming(until: now.addingTimeInterval(IslandServers.confirmWindow)), nil)
        case .forceOffered:
            return (.confirmingForce(until: now.addingTimeInterval(IslandServers.confirmWindow)), nil)
        case .confirmingForce(let until):
            if now <= until { return (.killing(sentAt: now), .kill) }
            return (.confirmingForce(until: now.addingTimeInterval(IslandServers.confirmWindow)), nil)
        case .stopping, .killing:
            return (phase, nil)
        }
    }

    /// Time passing: a confirm lapses; a signalled server still alive after `forceAfter` gets Force quit (one that
    /// went has no phase).
    static func settle(_ phase: IslandServerStopPhase?, now: Date, alive: Bool) -> IslandServerStopPhase? {
        switch phase {
        case .confirming(let until):
            return now > until ? nil : phase
        case .confirmingForce(let until):
            return now > until ? .forceOffered : phase
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
        case .confirming(let until), .confirmingForce(let until): return until.addingTimeInterval(0.05)
        case .stopping(let sentAt), .killing(let sentAt): return sentAt.addingTimeInterval(IslandServers.forceAfter)
        case .forceOffered, nil: return nil
        }
    }
}

// MARK: - The live source

/// libproc: the user's processes and their listening sockets. Spawns nothing. A few ms for ~1000 processes
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
        for pid in pids.prefix(Int(count)) where pid > 0 {
            guard let info = Self.bsdInfo(pid), info.pbi_uid == user else { continue }
            var p = ServerProcess(identity: Self.identity(info, pid: pid), ppid: Int32(bitPattern: info.pbi_ppid))
            let (tcp, unix) = Self.listeningSockets(pid)
            if !tcp.isEmpty || !unix.isEmpty {
                p.tcpPorts = tcp
                p.unixSockets = unix
                p.path = Self.path(pid)
                p.command = Self.command(info)
                p.cwd = Self.cwd(pid)
                if IslandServers.interpreter(IslandServers.executableName(p)) != nil { p.arguments = Self.arguments(pid) }
            }
            out.append(p)
        }
        return out
    }

    func identity(of pid: Int32) -> ServerProcessIdentity? {
        Self.bsdInfo(pid).map { Self.identity($0, pid: pid) }
    }

    private static func identity(_ info: proc_bsdinfo, pid: Int32) -> ServerProcessIdentity {
        ServerProcessIdentity(pid: pid, uid: info.pbi_uid, startSeconds: info.pbi_start_tvsec, startMicros: info.pbi_start_tvusec)
    }

    private static func bsdInfo(_ pid: Int32) -> proc_bsdinfo? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return info
    }

    /// The listening TCP ports and Unix sockets among the process's descriptors (each port once: v4 and v6 listeners
    /// on one port are one).
    private static func listeningSockets(_ pid: Int32) -> ([UInt16], [String]) {
        let bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard bytes > 0 else { return ([], []) }
        let stride = MemoryLayout<proc_fdinfo>.stride
        var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(bytes) / stride + 16)
        let used = fds.withUnsafeMutableBytes { proc_pidinfo(pid, PROC_PIDLISTFDS, 0, $0.baseAddress, Int32($0.count)) }
        guard used > 0 else { return ([], []) }
        var tcp: [UInt16] = []
        var unix: [String] = []
        let size = Int32(MemoryLayout<socket_fdinfo>.size)
        for fd in fds.prefix(Int(used) / stride) where fd.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
            var socket = socket_fdinfo()
            guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &socket, size) == size else { continue }
            switch socket.psi.soi_kind {
            case Int32(SOCKINFO_TCP):
                let info = socket.psi.soi_proto.pri_tcp
                guard info.tcpsi_state == TSI_S_LISTEN else { continue }
                // `insi_lport` is in network byte order.
                let port = UInt16(bigEndian: UInt16(truncatingIfNeeded: info.tcpsi_ini.insi_lport))
                if !tcp.contains(port) { tcp.append(port) }
            case Int32(SOCKINFO_UN):
                guard socket.psi.soi_options & Int16(SO_ACCEPTCONN) != 0 else { continue }
                let path = Self.string(socket.psi.soi_proto.pri_un.unsi_addr.ua_sun.sun_path)
                if !unix.contains(path) { unix.append(path) }
            default:
                continue
            }
        }
        return (tcp, unix)
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
/// in the background), and each row's Stop.
@MainActor
final class IslandServersModel: ObservableObject {
    @Published private(set) var rows: [IslandServerRow] = []
    @Published private(set) var loaded = false
    @Published private(set) var stops: [String: IslandServerStopPhase] = [:]

    var source: ServerProcessSource = LibprocServerProcessSource()
    var signaller: ServerSignaller = LiveServerSignaller()
    var now: () -> Date = { Date() }
    /// Runs the closure after the delay: ONE wake-up per armed confirm or stop, nothing while none is (the tests fire
    /// them by hand).
    var schedule: (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, action in
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(max(0, delay)))
            action()
        }
    }
    var user: uid_t = getuid()
    var ownPid: Int32 = getpid()
    var home: String = NSHomeDirectory()

    /// A scan, off the main thread.
    func refresh() async {
        let source = source
        let processes = await Task.detached(priority: .userInitiated) { source.processes() }.value
        apply(processes)
    }

    /// The rows from a scan; a gone row's Stop goes with it.
    func apply(_ processes: [ServerProcess]) {
        rows = IslandServers.rows(processes, user: user, ownPid: ownPid, home: home)
        let ids = Set(rows.map(\.id))
        stops = stops.filter { ids.contains($0.key) }
        loaded = true
    }

    /// A click on a row's Stop / Stop? / Force quit / Force quit?.
    func tap(_ row: IslandServerRow) {
        let (next, action) = IslandServerStopMachine.tap(stops[row.id], now: now())
        var phase = next
        if let action {
            let sent = IslandServers.signal(action == .terminate ? SIGTERM : SIGKILL, row.members, user: user,
                                            source: source, signaller: signaller)
            // Nothing left to signal (it went, or its pid is someone else's now): the row goes at the next scan.
            if sent == 0 { phase = nil }
        }
        stops[row.id] = phase
        arm(row)
    }

    /// Re-judges every row's Stop against the clock (a lapsed confirm, a server still up after SIGTERM).
    func settle() {
        let time = now()
        for row in rows {
            guard let phase = stops[row.id] else { continue }
            let alive = IslandServers.anyAlive(row.members, source: source)
            stops[row.id] = IslandServerStopMachine.settle(phase, now: time, alive: alive)
            if !alive, stops[row.id] == nil { rows.removeAll { $0.id == row.id } }
        }
    }

    private func arm(_ row: IslandServerRow) {
        guard let deadline = IslandServerStopMachine.deadline(stops[row.id]) else { return }
        let id = row.id
        schedule(deadline.timeIntervalSince(now())) { [weak self] in
            guard let self, self.stops[id] != nil else { return }
            self.settle()
            if let row = self.rows.first(where: { $0.id == id }) { self.arm(row) }
        }
    }

    /// Test seam.
    func setForTesting(_ rows: [IslandServerRow]) {
        self.rows = rows
        loaded = true
    }
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
        } else {
            IslandTabScroll(scrolls: scrolls) { rows }
        }
    }

    private var rows: some View {
        let time = now()
        return VStack(alignment: .leading, spacing: IslandLayout.rowGap) {
            ForEach(model.rows) { row in
                IslandServerRowView(row: row, phase: model.stops[row.id], now: time) { model.tap(row) }
            }
        }
        .padding(.horizontal, IslandLayout.listInset)
        .padding(.bottom, IslandLayout.listInset)
    }
}

struct IslandServerRowView: View {
    let row: IslandServerRow
    let phase: IslandServerStopPhase?
    let now: Date
    let onStop: () -> Void

    var body: some View {
        IslandHoverSurface { hovered in
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "server.rack")
                    .font(Typography.label(.semibold))
                    .foregroundStyle(islandToneColor(.ok))
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Color.white.opacity(0.08)))
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.name)
                        .font(Typography.composerField())
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("\(row.portsLine) · \(statusLine)")
                        .font(Typography.captionDigits(.medium))
                        .foregroundStyle(phase == nil ? Theme.textMuted : pillReviewAmber)
                        .lineLimit(1)
                    if let folder = row.folder {
                        // The whole folder under the pointer (the island's panels are never key, so a tooltip may not
                        // show).
                        Text(hovered ? (row.folderPath ?? folder) : folder)
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .truncationMode(.head)
                            .help(row.folderPath ?? folder)
                    }
                }
                Spacer(minLength: 8)
                IslandServerStopButton(phase: phase, name: row.name, action: onStop)
            }
            .padding(12)
        }
    }

    private var statusLine: String {
        switch phase {
        case .stopping?, .killing?: return "Stopping…"
        case .forceOffered?, .confirmingForce?: return "Still running"
        default: return IslandServers.uptime(since: row.startedAt, now: now)
        }
    }
}

/// Stop's button through its phases: the white stop circle; "Stop?" (amber) waiting for the second click; "Stopping…"
/// (dimmed); "Force quit", then "Force quit?" (red).
struct IslandServerStopButton: View {
    let phase: IslandServerStopPhase?
    let name: String
    let action: () -> Void

    var body: some View {
        switch phase {
        case nil:
            IslandAnswerButton(role: .refuse, symbol: "stop.fill", action: action)
                .accessibilityLabel("Stop \(name)")
        case .confirming?:
            capsule("Stop?", fill: pillReviewAmber, text: Color.black)
                .accessibilityLabel("Click again to stop \(name)")
        case .stopping?, .killing?:
            capsule("Stopping…", fill: Color.white.opacity(0.1), text: Color.white, enabled: false)
        case .forceOffered?:
            capsule("Force quit", fill: Color.white.opacity(0.1), text: Color.white)
                .accessibilityLabel("Force quit \(name)")
        case .confirmingForce?:
            capsule("Force quit?", fill: Color(nsColor: .systemRed), text: Color.white)
                .accessibilityLabel("Click again to force quit \(name)")
        }
    }

    private func capsule(_ title: String, fill: Color, text: Color, enabled: Bool = true) -> some View {
        Button(action: action) {
            Text(title)
                .font(Typography.caption(.semibold))
                .foregroundStyle(text)
                .padding(.horizontal, 12)
                .frame(height: IslandCircleButtonStyle.size)
                .background(Capsule().fill(fill))
                .contentShape(Capsule())
                .pillHoverGlow(fill)
        }
        .buttonStyle(IslandPressStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
    }
}
