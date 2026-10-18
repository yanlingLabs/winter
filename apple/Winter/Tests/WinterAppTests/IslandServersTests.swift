import Darwin
import XCTest
@testable import Winter

/// The island's Servers tab: the user's own listening processes (made-up process lists — no real process is ever
/// signalled here), their names, one row per tree, the words, and Stop's two clicks with its pid-reuse guard.
@MainActor
final class IslandServersTests: XCTestCase {
    private let me: uid_t = 501
    private let home = "/Users/me"
    private let ownPid: Int32 = 9_999
    private let epoch: UInt64 = 1_800_000_000

    private func process(_ pid: Int32, parent: Int32 = 1, uid: uid_t? = nil, path: String, args: [String]? = nil,
                         cwd: String? = "/Users/me/code", tcp: [UInt16] = [], unix: [String] = [], command: String = "",
                         started: UInt64? = nil) -> ServerProcess {
        ServerProcess(identity: ServerProcessIdentity(pid: pid, uid: uid ?? me, startSeconds: started ?? epoch, startMicros: 7),
                      ppid: parent, path: path, command: command, cwd: cwd, tcpPorts: tcp, unixSockets: unix,
                      arguments: args)
    }

    private func rows(_ list: [ServerProcess]) -> [IslandServerRow] {
        IslandServers.rows(list, user: me, ownPid: ownPid, home: home)
    }

    private func name(_ path: String, _ args: [String]?, cwd: String? = "/Users/me/code") -> String {
        IslandServers.displayName(process(10, path: path, args: args, cwd: cwd, tcp: [1]))
    }

    // MARK: Inclusion and exclusion

    func testOnlyTheUsersOwnListenersOutsideTheSystemAndAppsAreListed() {
        let list = [
            process(100, path: "/opt/homebrew/bin/node", args: ["node", "bot.js"], tcp: [3000]),
            process(101, path: "/opt/homebrew/bin/node", args: ["node", "quiet.js"]),
            process(102, path: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter", tcp: [7000]),
            process(103, path: "/Applications/Spotify.app/Contents/MacOS/Spotify", tcp: [57621]),
            process(104, path: "/Users/me/Library/Application Support/Claude/claude.app/Contents/MacOS/claude", unix: ["/tmp/c.sock"]),
            process(105, path: "/Users/me/winter/dist/dev/winter-core", unix: ["/Users/me/.winter-dev/run/core.sock"]),
            process(106, path: "/Users/me/winter/dist/winter", tcp: [4100]),
            process(ownPid, path: "/Users/me/Build/Winter Dev.app/Contents/MacOS/Winter Dev", tcp: [4200]),
            process(107, uid: 502, path: "/opt/homebrew/bin/node", args: ["node", "theirs.js"], tcp: [4300]),
            process(108, path: "/usr/bin/python3", args: ["python3", "-m", "http.server"], tcp: [8000]),
            process(109, path: "/usr/bin/ssh-agent", unix: ["/Users/me/.ssh/agent.sock"]),
            process(110, path: "/usr/libexec/sharingd", tcp: [5000]),
            process(111, path: "/usr/sbin/cupsd", tcp: [631]),
            process(112, path: "/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim", unix: ["/tmp/sim.sock"]),
            process(113, path: "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
                    args: ["python3", "-m", "uvicorn", "app:app"], tcp: [8001]),
            process(114, path: "/Applications/Editor.app/Contents/Resources/node", args: ["node", "lsp.js"], tcp: [9229]),
            process(115, path: "", tcp: [57608], command: "mydaemon"),
            process(116, path: "/Library/Developer/CommandLineTools/usr/bin/python3", args: ["python3", "serve.py"], tcp: [8002]),
            process(117, path: "/usr/local/bin/waifus", tcp: [3888]),
            process(118, path: "/sbin/launchd", unix: ["/var/run/l.sock"]),
            process(119, path: "/Library/Apple/System/Library/thing", tcp: [1234]),
        ]
        XCTAssertEqual(Set(rows(list).map(\.name)), ["bot", "http.server", "uvicorn", "mydaemon", "serve", "waifus"])
        // Each rule on its own.
        let excluded: [Int32] = [101, 102, 103, 104, 105, 106, ownPid, 107, 109, 110, 111, 112, 114, 118, 119]
        for p in list where excluded.contains(p.pid) {
            XCTAssertFalse(IslandServers.qualifies(p, user: me, ownPid: ownPid), "\(p.pid) \(p.path)")
        }
        XCTAssertNil(IslandServers.interpreter("ssh-agent"))
        XCTAssertEqual(IslandServers.interpreter("Python"), .python)
        XCTAssertEqual(IslandServers.interpreter("python3.12"), .python)
        XCTAssertEqual(IslandServers.interpreter("perl5.34"), .perl)
        XCTAssertNil(IslandServers.interpreter("pythonista"))
    }

    // MARK: Names

    func testAnInterpreterIsNamedByWhatItRuns() {
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "/Users/me/waifus/bot.js", "remote"]), "bot")
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "--inspect", "-r", "dotenv/config", "server.mjs"]), "server")
        // An index or main file: its package's folder (past src/dist).
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "index.js"], cwd: "/Users/me/waifus"), "waifus")
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "dist/index.js"], cwd: "/Users/me/api"), "api")
        XCTAssertEqual(name("/opt/homebrew/bin/bun", ["bun", "run", "src/index.ts"], cwd: "/Users/me/dashboard"), "dashboard")
        XCTAssertEqual(name("/opt/homebrew/bin/bun", ["bun", "--watch", "/Users/me/srv/relay/index.ts"]), "relay")
        XCTAssertEqual(name("/opt/homebrew/bin/deno", ["deno", "run", "-A", "main.ts"], cwd: "/Users/me/edge"), "edge")
        // A package's own bin, and a runner's script.
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "/Users/me/app/node_modules/.bin/vite"]), "vite")
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "/Users/me/app/node_modules/next/dist/bin/next", "dev"]), "next")
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "/Users/me/app/node_modules/@acme/cli/bin.js"]), "@acme/cli")
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "/Users/me/app/node_modules/tsx/dist/cli.mjs", "src/bot.ts"]), "bot")
        // Python: the module after -m, else the script.
        XCTAssertEqual(name("/usr/bin/python3", ["python3", "-m", "http.server", "8000"]), "http.server")
        XCTAssertEqual(name("/usr/bin/python3", ["python3", "-u", "-W", "ignore", "app.py"]), "app")
        XCTAssertEqual(name("/usr/bin/python3", ["python3", "-mflask", "run"]), "flask")
        XCTAssertEqual(name("/usr/bin/python3", ["python3", "/Users/me/svc/__main__.py"]), "svc")
        XCTAssertEqual(name("/usr/bin/python3", ["python3", "-c", "import x"]), "python3", "no script: the interpreter")
        // Java, Ruby, PHP.
        XCTAssertEqual(name("/usr/bin/java", ["java", "-Xmx1g", "-jar", "build/libs/game-server.jar"]), "game-server")
        XCTAssertEqual(name("/usr/bin/java", ["java", "-cp", "lib/*", "com.example.Server"]), "Server")
        XCTAssertEqual(name("/usr/bin/ruby", ["ruby", "bin/rails", "server"]), "rails")
        XCTAssertEqual(name("/opt/homebrew/bin/php", ["php", "-S", "localhost:8000", "-t", "public"]), "php")
        XCTAssertEqual(name("/opt/homebrew/bin/php", ["php", "-S", "localhost:8000", "router.php"]), "router")
        // Not an interpreter, or no arguments read: the executable.
        XCTAssertEqual(name("/usr/local/bin/waifus", ["waifus", "remote"]), "waifus")
        XCTAssertEqual(name("/opt/homebrew/bin/node", nil), "node")
        // `go run`: its temporary build is named by the folder it runs in.
        XCTAssertEqual(name("/private/var/folders/x/T/go-build123/b001/exe/main", nil, cwd: "/Users/me/gosrv"), "gosrv")
    }

    func testProcArgsAreParsed() {
        var bytes: [UInt8] = []
        withUnsafeBytes(of: Int32(3)) { bytes.append(contentsOf: $0) }
        for part in ["/opt/homebrew/bin/node", "", "", "node", "bot.js", "remote", "PATH=/usr/bin", "HOME=/Users/me"] {
            bytes.append(contentsOf: Array(part.utf8) + [0])
        }
        XCTAssertEqual(LibprocServerProcessSource.parseProcArgs(bytes), ["node", "bot.js", "remote"])
        XCTAssertNil(LibprocServerProcessSource.parseProcArgs([1, 0]))
        XCTAssertNil(LibprocServerProcessSource.parseProcArgs([0, 0, 0, 0, 65, 0]))
    }

    // MARK: One row per tree

    func testAServersForkedWorkersAreOneRowUnderItsTopListener() {
        let node = "/opt/homebrew/bin/node"
        let list = [
            process(80, path: "/bin/zsh"),
            // `npm run dev` listens on nothing; its child is the server.
            process(95, parent: 80, path: node, args: ["node", "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js", "run", "dev"]),
            process(100, parent: 95, path: node, args: ["node", "server.js"], tcp: [3000], started: epoch),
            process(101, parent: 100, path: node, args: ["node", "worker.js"], tcp: [3001, 3000], started: epoch + 2),
            process(102, parent: 100, path: node, args: ["node", "worker.js"], tcp: [3001], started: epoch + 2),
            // Through a shell that listens on nothing.
            process(103, parent: 100, path: "/bin/sh"),
            process(104, parent: 103, path: "/opt/homebrew/bin/python3", args: ["python3", "-m", "sidecar"], unix: ["/tmp/s.sock"]),
            // Another server, started later.
            process(200, path: "/usr/local/bin/waifus", tcp: [3888], started: epoch + 60),
            // Under another user's listener: its own row (the walk stops at a process that is not the user's).
            process(300, uid: 502, path: "/opt/homebrew/bin/node", tcp: [9000]),
            process(301, parent: 300, path: "/opt/homebrew/bin/node", args: ["node", "child.js"], tcp: [9001], started: epoch + 30),
        ]
        let result = rows(list)
        XCTAssertEqual(result.map(\.name), ["waifus", "child", "server"], "newest first")
        let server = result[2]
        XCTAssertEqual(server.members.map(\.pid), [100, 101, 102, 104], "the top first")
        XCTAssertEqual(server.tcpPorts, [3000, 3001])
        XCTAssertEqual(server.unixSockets, 1)
        XCTAssertEqual(server.portsLine, ":3000 :3001 socket")
        XCTAssertEqual(server.folder, "code")
        XCTAssertEqual(server.folderPath, "~/code")
        XCTAssertEqual(server.id, "100-\(epoch)-7")
        XCTAssertEqual(server.startedAt, Date(timeIntervalSince1970: TimeInterval(epoch) + 0.000007))
    }

    func testAParentLoopEnds() {
        // Never in a real table (a race between two reads at most): the walk ends, and each is listed.
        let list = [process(10, parent: 11, path: "/usr/local/bin/a", tcp: [1]),
                    process(11, parent: 10, path: "/usr/local/bin/b", tcp: [2])]
        XCTAssertEqual(rows(list).count, 2)
    }

    // MARK: Words

    func testThePortsUptimeAndFolderWords() {
        XCTAssertEqual(IslandServers.portsLine(tcp: [8080, 3000, 3000], unixSockets: 0), ":3000 :8080")
        XCTAssertEqual(IslandServers.portsLine(tcp: [], unixSockets: 1), "socket")
        XCTAssertEqual(IslandServers.portsLine(tcp: [3000], unixSockets: 2), ":3000 2 sockets")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func up(_ ago: TimeInterval) -> String { IslandServers.uptime(since: now.addingTimeInterval(-ago), now: now) }
        XCTAssertEqual(up(30), "just started")
        XCTAssertEqual(up(12 * 60 + 40), "up 12 min")
        XCTAssertEqual(up(3 * 3600), "up 3 h")
        XCTAssertEqual(up(3 * 3600 + 5 * 60), "up 3 h 5 min")
        XCTAssertEqual(up(2 * 86400), "up 2 d")
        XCTAssertEqual(up(2 * 86400 + 4 * 3600 + 59), "up 2 d 4 h")
        XCTAssertEqual(IslandServers.folderName("/Users/me/Discord Waifus"), "Discord Waifus")
        XCTAssertEqual(IslandServers.folderName("/"), "/")
        XCTAssertNil(IslandServers.folderName(""))
        XCTAssertEqual(IslandServers.abbreviated("/Users/me/code/x", home: home), "~/code/x")
        XCTAssertEqual(IslandServers.abbreviated("/Users/me", home: home), "~")
        XCTAssertEqual(IslandServers.abbreviated("/Users/meadow/x", home: home), "/Users/meadow/x")
    }

    // MARK: Stop

    func testStopsStateMachine() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        typealias M = IslandServerStopMachine
        // A first click asks; it lapses after the confirm window.
        var (phase, action) = M.tap(nil, now: t0)
        XCTAssertEqual(phase, .confirming(until: t0.addingTimeInterval(3)))
        XCTAssertNil(action)
        XCTAssertEqual(M.settle(phase, now: t0.addingTimeInterval(2.9), alive: true), phase)
        XCTAssertNil(M.settle(phase, now: t0.addingTimeInterval(3.1), alive: true))
        // A late second click asks again rather than stopping.
        (phase, action) = M.tap(.confirming(until: t0), now: t0.addingTimeInterval(4))
        XCTAssertEqual(phase, .confirming(until: t0.addingTimeInterval(7)))
        XCTAssertNil(action)
        // Two clicks in time: SIGTERM.
        (phase, action) = M.tap(.confirming(until: t0.addingTimeInterval(3)), now: t0.addingTimeInterval(1))
        XCTAssertEqual(phase, .stopping(sentAt: t0.addingTimeInterval(1)))
        XCTAssertEqual(action, .terminate)
        XCTAssertEqual(M.tap(phase, now: t0.addingTimeInterval(2)).1, nil, "no second signal while stopping")
        XCTAssertEqual(M.settle(phase, now: t0.addingTimeInterval(5.9), alive: true), phase)
        XCTAssertNil(M.settle(phase, now: t0.addingTimeInterval(6), alive: false), "it went")
        XCTAssertEqual(M.settle(phase, now: t0.addingTimeInterval(6), alive: true), .forceOffered)
        // Force quit: two clicks again.
        (phase, action) = M.tap(.forceOffered, now: t0.addingTimeInterval(10))
        XCTAssertEqual(phase, .confirmingForce(until: t0.addingTimeInterval(13)))
        XCTAssertNil(action)
        XCTAssertEqual(M.settle(phase, now: t0.addingTimeInterval(13.5), alive: true), .forceOffered)
        (phase, action) = M.tap(phase, now: t0.addingTimeInterval(12))
        XCTAssertEqual(phase, .killing(sentAt: t0.addingTimeInterval(12)))
        XCTAssertEqual(action, .kill)
        XCTAssertNil(M.settle(phase, now: t0.addingTimeInterval(17), alive: false))
        XCTAssertNil(M.deadline(nil))
        XCTAssertNil(M.deadline(.forceOffered))
        XCTAssertEqual(M.deadline(.stopping(sentAt: t0)), t0.addingTimeInterval(5))
    }

    private final class FakeSource: ServerProcessSource {
        var list: [ServerProcess] = []
        var alive: [Int32: ServerProcessIdentity] = [:]
        func processes() -> [ServerProcess] { list }
        func identity(of pid: Int32) -> ServerProcessIdentity? { alive[pid] }
    }

    private final class FakeSignaller: ServerSignaller {
        var sent: [String] = []
        func send(_ signal: Int32, to pid: Int32) -> Bool {
            sent.append("\(signal == SIGTERM ? "TERM" : signal == SIGKILL ? "KILL" : "\(signal)") \(pid)")
            return true
        }
    }

    private struct Harness {
        let model: IslandServersModel
        let source: FakeSource
        let signaller: FakeSignaller
    }

    private var clock = Date(timeIntervalSince1970: 1_800_000_000)
    private var scheduled: [(@MainActor () -> Void)] = []

    private func harness(_ list: [ServerProcess]) async -> Harness {
        let source = FakeSource()
        source.list = list
        for p in list { source.alive[p.pid] = p.identity }
        let signaller = FakeSignaller()
        let model = IslandServersModel()
        model.source = source
        model.signaller = signaller
        model.user = me
        model.ownPid = ownPid
        model.home = home
        model.now = { [unowned self] in self.clock }
        model.schedule = { [unowned self] _, action in self.scheduled.append(action) }
        await model.refresh()
        return Harness(model: model, source: source, signaller: signaller)
    }

    /// Fires every wake-up the model armed.
    private func fire() {
        let pending = scheduled
        scheduled = []
        pending.forEach { $0() }
    }

    private var bot: [ServerProcess] {
        [process(100, path: "/opt/homebrew/bin/node", args: ["node", "bot.js"], tcp: [3000]),
         process(101, parent: 100, path: "/opt/homebrew/bin/node", args: ["node", "worker.js"], tcp: [3001])]
    }

    func testStopAsksTwiceThenTerminatesTheTreeThenOffersForceQuit() async {
        let h = await harness(bot)
        XCTAssertTrue(h.model.loaded)
        XCTAssertEqual(h.model.rows.map(\.name), ["bot"])
        let row = h.model.rows[0]

        // One click asks; nothing is signalled; 3 s later it lapses.
        h.model.tap(row)
        XCTAssertEqual(h.model.stops[row.id], .confirming(until: clock.addingTimeInterval(3)))
        XCTAssertEqual(scheduled.count, 1, "one wake-up for the lapse")
        clock.addTimeInterval(3.2)
        fire()
        XCTAssertNil(h.model.stops[row.id])
        XCTAssertTrue(scheduled.isEmpty, "nothing armed at rest")
        XCTAssertTrue(h.signaller.sent.isEmpty)

        // Two clicks in time: SIGTERM to the top, then its worker.
        h.model.tap(row)
        clock.addTimeInterval(1)
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent, ["TERM 100", "TERM 101"])
        XCTAssertEqual(h.model.stops[row.id], .stopping(sentAt: clock))
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent.count, 2, "no second signal while it stops")

        // Still alive 5 s later: Force quit, two clicks again.
        scheduled.removeAll()
        clock.addTimeInterval(5)
        h.model.settle()
        XCTAssertEqual(h.model.stops[row.id], .forceOffered)
        h.model.tap(row)
        XCTAssertTrue(h.signaller.sent.count == 2)
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent.suffix(2), ["KILL 100", "KILL 101"])

        // It goes: the next wake-up drops the phase and the row.
        h.source.alive = [:]
        clock.addTimeInterval(5)
        fire()
        XCTAssertNil(h.model.stops[row.id])
        XCTAssertTrue(h.model.rows.isEmpty)
    }

    func testAServerThatStopsInTimeGetsNoForceQuit() async {
        let h = await harness(bot)
        let row = h.model.rows[0]
        h.model.tap(row)
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent, ["TERM 100", "TERM 101"])
        scheduled.removeAll()
        h.source.alive = [:]
        h.source.list = []
        await h.model.refresh()
        XCTAssertTrue(h.model.rows.isEmpty)
        XCTAssertTrue(h.model.stops.isEmpty, "a gone row's Stop goes with it")
    }

    func testAReusedPidIsNeverSignalled() async {
        let h = await harness(bot)
        let row = h.model.rows[0]
        // 100 ended and its pid went to a new process (another start time); 101 is now another user's.
        h.source.alive[100] = ServerProcessIdentity(pid: 100, uid: me, startSeconds: epoch + 500, startMicros: 0)
        h.source.alive[101] = ServerProcessIdentity(pid: 101, uid: 0, startSeconds: epoch, startMicros: 7)
        h.model.tap(row)
        h.model.tap(row)
        XCTAssertTrue(h.signaller.sent.isEmpty)
        XCTAssertNil(h.model.stops[row.id], "nothing left to stop")

        // A member recorded as another user's is never signalled, whatever the table says.
        let theirs = ServerProcessIdentity(pid: 300, uid: 502, startSeconds: epoch, startMicros: 0)
        let source = FakeSource()
        source.alive[300] = theirs
        let signaller = FakeSignaller()
        XCTAssertEqual(IslandServers.signal(SIGTERM, [theirs], user: me, source: source, signaller: signaller), 0)
        XCTAssertEqual(IslandServers.signal(SIGTERM, [ServerProcessIdentity(pid: 1, uid: me, startSeconds: 0, startMicros: 0)],
                                            user: me, source: source, signaller: signaller), 0, "never launchd")
        XCTAssertTrue(signaller.sent.isEmpty)
    }

    // MARK: The tab

    func testTheServersTabIsRegisteredLastAndRefreshesItsModel() async {
        XCTAssertEqual(IslandTabRegistry.tabs.last, IslandTabRegistry.servers)
        XCTAssertEqual(IslandTabRegistry.servers.symbol, "server.rack")
        var tabs = IslandTabState()
        XCTAssertTrue(tabs.select("servers"))
        XCTAssertEqual(tabs.selected?.title, "Servers")

        let source = FakeSource()
        source.list = bot
        let servers = IslandServersModel()
        servers.source = source
        servers.user = me
        let models = IslandTabModels(shelf: IslandShelfStore(persistence: IslandShelfPersistence(
            fileURL: FileManager.default.temporaryDirectory.appendingPathComponent("servers-tab-\(UUID().uuidString).json"))),
                                     servers: servers)
        await models.refresh(tab: IslandTabRegistry.devices.id)
        XCTAssertFalse(servers.loaded, "no scan for another tab")
        await models.refresh(tab: IslandTabRegistry.servers.id, periodic: true)
        XCTAssertEqual(servers.rows.map(\.name), ["bot"])
    }

    // MARK: The live source

    /// The real libproc scan runs and returns the user's processes — which ones is not asserted. Logs the scan's time.
    func testTheLiveSourceScans() {
        let source = LibprocServerProcessSource()
        var times: [Double] = []
        var processes: [ServerProcess] = []
        for _ in 0..<5 {
            let start = DispatchTime.now().uptimeNanoseconds
            processes = source.processes()
            times.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        let user = getuid()
        XCTAssertFalse(processes.isEmpty)
        XCTAssertTrue(processes.allSatisfy { $0.uid == user })
        XCTAssertEqual(source.identity(of: getpid())?.uid, user)
        let rows = IslandServers.rows(processes, user: user, ownPid: getpid(), home: NSHomeDirectory())
        let sorted = times.sorted()
        print("IslandServers live scan: \(processes.count) processes, \(processes.filter(\.listens).count) listening, "
              + "\(rows.count) rows; median \(String(format: "%.2f", sorted[2])) ms, max \(String(format: "%.2f", sorted[4])) ms")
        XCTAssertLessThan(sorted[2], 200, "a scan stays light (logged above; a few ms on a dev Mac)")
    }
}
