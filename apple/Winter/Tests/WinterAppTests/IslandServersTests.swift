import Darwin
import XCTest
@testable import Winter

/// The island's Servers tab: the user's own processes listening on a TCP port (made-up process lists — no real process
/// is ever signalled here), their names, one row per server, the words, and Stop's two clicks with its pid-reuse guard.
@MainActor
final class IslandServersTests: XCTestCase {
    private let me: uid_t = 501
    private let home = "/Users/me"
    private let ownPid: Int32 = 9_999
    private let epoch: UInt64 = 1_800_000_000

    /// A process in its own process group unless `group` says otherwise.
    private func process(_ pid: Int32, parent: Int32 = 1, group: Int32? = nil, uid: uid_t? = nil, path: String,
                         args: [String]? = nil, cwd: String? = "/Users/me/code", tcp: [UInt16] = [], command: String = "",
                         started: UInt64? = nil) -> ServerProcess {
        ServerProcess(identity: ServerProcessIdentity(pid: pid, uid: uid ?? me, startSeconds: started ?? epoch, startMicros: 7),
                      ppid: parent, pgid: group ?? pid, path: path, command: command, cwd: cwd, tcpPorts: tcp, arguments: args)
    }

    private func rows(_ list: [ServerProcess]) -> [IslandServerRow] {
        IslandServers.rows(list, user: me, ownPid: ownPid, home: home)
    }

    private func name(_ path: String, _ args: [String]?, cwd: String? = "/Users/me/code") -> String {
        IslandServers.displayName(process(10, path: path, args: args, cwd: cwd, tcp: [1]))
    }

    // MARK: Inclusion and exclusion

    func testOnlyTheUsersOwnTCPListenersOutsideTheSystemAppsWinterAndAgentsAreListed() {
        let node = "/opt/homebrew/bin/node"
        let list = [
            process(100, path: node, args: ["node", "bot.js"], tcp: [3000]),
            process(101, path: node, args: ["node", "quiet.js"]),
            process(102, path: "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter", tcp: [7000]),
            process(103, path: "/Applications/Spotify.app/Contents/MacOS/Spotify", tcp: [57621]),
            process(104, path: "/Users/me/Library/Application Support/Claude/claude.app/Contents/MacOS/claude", tcp: [4000]),
            process(105, path: "/Users/me/winter/dist/dev/winter-core", tcp: [4001]),
            process(106, path: "/Users/me/winter/dist/winter", tcp: [4100]),
            process(ownPid, path: "/Users/me/Build/Winter Dev.app/Contents/MacOS/Winter Dev", tcp: [4200]),
            process(107, uid: 502, path: node, args: ["node", "theirs.js"], tcp: [4300]),
            process(108, path: "/usr/bin/python3", args: ["python3", "-m", "http.server"], tcp: [8000]),
            process(109, path: "/usr/bin/ssh-agent", tcp: [4400]),
            process(110, path: "/usr/libexec/sharingd", tcp: [5000]),
            process(111, path: "/usr/sbin/cupsd", tcp: [631]),
            process(112, path: "/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/sbin/launchd_sim", tcp: [4500]),
            process(113, path: "/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python",
                    args: ["python3", "-m", "uvicorn", "app:app"], tcp: [8001]),
            process(114, path: "/Applications/Editor.app/Contents/Resources/node", args: ["node", "lsp.js"], tcp: [9229]),
            process(115, path: "", tcp: [57608], command: "mydaemon"),
            process(116, path: "/Library/Developer/CommandLineTools/usr/bin/python3", args: ["python3", "serve.py"], tcp: [8002]),
            process(117, path: "/usr/local/bin/waifus", tcp: [3888]),
            process(118, path: "/sbin/launchd", tcp: [4600]),
            process(119, path: "/Library/Apple/System/Library/thing", tcp: [1234]),
            // A framework's Python.app inside a GUI app is the app's; inside Xcode it is Xcode's own Python.
            process(120, path: "/Applications/Foo.app/Contents/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python",
                    args: ["python3", "plugin.py"], tcp: [4700]),
            process(121, path: "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python",
                    args: ["python3", "notebook.py"], tcp: [8003]),
            // The coding-agent CLIs: by executable, npm script or package, or their installer's versions folder.
            process(130, path: "/opt/homebrew/Caskroom/codex/0.162.1/bin/codex", tcp: [64504]),
            process(131, path: "/opt/homebrew/Cellar/opencode/2.0.30/bin/opencode", tcp: [49374]),
            process(132, path: node, args: ["node", "/opt/homebrew/bin/claude"], tcp: [63611]),
            process(133, path: node, args: ["node", "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"], tcp: [63612]),
            process(134, path: node, args: ["node", "/opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js"], tcp: [63613]),
            process(135, path: "/Users/me/.local/share/claude/versions/2.1.299", tcp: [63614]),
            process(136, path: "/Users/me/.local/bin/cursor-agent", tcp: [63615]),
            process(137, path: node, args: ["node", "/opt/homebrew/lib/node_modules/@github/copilot/index.js"], tcp: [63616]),
            // Winter's infrastructure (an MCP server under the daemon, a helper under this app): never a row.
            process(140, path: "/Users/me/winter/dist/dev/winter-core"),
            process(141, parent: 140, path: node, args: ["node", "mcp-server.js"], tcp: [4800]),
            process(142, parent: ownPid, path: "/usr/local/bin/helper-server", tcp: [4900]),
        ]
        XCTAssertEqual(Set(rows(list).map(\.name)), ["bot", "http.server", "uvicorn", "mydaemon", "serve", "waifus", "notebook"])
        // Each rule on its own.
        let excluded: [Int32] = [101, 102, 103, 104, 105, 106, ownPid, 107, 109, 110, 111, 112, 114, 118, 119, 120,
                                 130, 131, 132, 133, 134, 135, 136, 137]
        for p in list where excluded.contains(p.pid) {
            XCTAssertFalse(IslandServers.qualifies(p, user: me, ownPid: ownPid), "\(p.pid) \(p.path)")
        }
        XCTAssertNil(IslandServers.interpreter("ssh-agent"))
        XCTAssertEqual(IslandServers.interpreter("Python"), .python)
        XCTAssertEqual(IslandServers.interpreter("python3.12"), .python)
        XCTAssertEqual(IslandServers.interpreter("perl5.34"), .perl)
        XCTAssertNil(IslandServers.interpreter("pythonista"))
        XCTAssertEqual(IslandServers.agentWord("@anthropic-ai/claude-code"), "claude")
        XCTAssertEqual(IslandServers.agentWord("opencode-ai"), "opencode")
        XCTAssertEqual(IslandServers.agentWord("claude-code@latest"), "claude")
        XCTAssertEqual(IslandServers.agentWord("cursor-agent"), "cursor-agent")
        XCTAssertEqual(IslandServers.agentWord("vite"), "vite")
        XCTAssertTrue(IslandServers.isWinter(path: "/Applications/Winter Dev.app/Contents/Helpers/x", command: ""))
        XCTAssertTrue(IslandServers.isWinter(path: "", command: "winter-core"))
        XCTAssertFalse(IslandServers.isWinter(path: "/Users/me/winter-docs/server", command: "server"))
    }

    /// Winter's own infrastructure is hidden; a server a Winter session ran through its shell is the user's: shown.
    func testAServerASessionRanThroughItsShellIsListedButWintersInfrastructureIsNot() {
        let node = "/opt/homebrew/bin/node"
        let list = [
            // winter-core → node mcp-server: no shell between — hidden.
            process(200, path: "/Users/me/.winter/bin/winter-core"),
            process(201, parent: 200, path: node, args: ["node", "mcp-server.js"], tcp: [4800]),
            // winter-core → node → node: still no shell — hidden.
            process(202, parent: 200, path: node, args: ["node", "launcher.js"]),
            process(203, parent: 202, path: node, args: ["node", "inspector.js"], tcp: [4801]),
            // winter (a code session) → bash -c … → bun dev: the user's dev server — shown.
            process(210, parent: 200, path: "/Users/me/.winter/bin/winter"),
            process(211, parent: 210, path: "/bin/bash", args: nil),
            process(212, parent: 211, path: "/opt/homebrew/bin/bun", args: ["bun", "run", "src/index.ts"],
                    cwd: "/Users/me/shop", tcp: [5173]),
            // Winter.app → zsh (the Dispatch pill's terminal) → python: shown; this app → a helper directly: hidden.
            process(220, path: "/Applications/Winter.app/Contents/MacOS/Winter"),
            process(221, parent: 220, path: "/bin/zsh"),
            process(222, parent: 221, path: "/usr/bin/python3", args: ["python3", "-m", "http.server"], tcp: [8000]),
            process(223, parent: ownPid, path: "/usr/local/bin/helper-server", tcp: [4900]),
            process(224, parent: ownPid, path: "/bin/sh", command: "sh"),
            process(225, parent: 224, path: "/usr/local/bin/devd", tcp: [4901]),
        ]
        XCTAssertEqual(Set(rows(list).map(\.name)), ["shop", "http.server", "devd"])

        // Through a package runner's own `sh -c` (npx, npm exec, bunx, uvx): still Winter's — hidden.
        let runners = [
            process(230, path: "/Users/me/.winter/bin/winter-core"),
            process(231, parent: 230, path: node, args: ["node", "/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js", "-y", "@acme/mcp"]),
            process(232, parent: 231, path: "/bin/sh"),
            process(233, parent: 232, path: node, args: ["node", "/Users/me/.npm/_npx/1/node_modules/@acme/mcp/index.js"], tcp: [4802]),
            process(234, parent: 230, path: node, args: ["node", "/opt/homebrew/bin/npm", "exec", "--", "@acme/other"]),
            process(235, parent: 234, path: "/bin/sh"),
            process(236, parent: 235, path: "/usr/local/bin/other-mcp", tcp: [4803]),
            process(237, parent: 230, path: "/opt/homebrew/bin/bun", args: ["bunx", "@acme/third"]),
            process(238, parent: 237, path: "/bin/sh"),
            process(239, parent: 238, path: "/usr/local/bin/third-mcp", tcp: [4804]),
            process(240, parent: 230, path: "/Users/me/.local/bin/uvx"),
            process(241, parent: 240, path: "/bin/sh"),
            process(242, parent: 241, path: "/usr/local/bin/py-mcp", tcp: [4805]),
            // The user's own `npx vite` in their terminal: shown.
            process(250, path: "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
            process(251, parent: 250, path: "/bin/zsh"),
            process(252, parent: 251, path: node, args: ["node", "/opt/homebrew/bin/npx", "vite"]),
            process(253, parent: 252, path: "/bin/sh"),
            process(254, parent: 253, path: node, args: ["node", "/Users/me/site/node_modules/.bin/vite"], tcp: [5174]),
        ]
        XCTAssertEqual(rows(runners).map(\.name), ["vite"])
        XCTAssertTrue(IslandServers.isPackageRunner(process(1, path: "/opt/homebrew/bin/pnpm", args: ["pnpm", "dlx", "x"])))
        XCTAssertTrue(IslandServers.isPackageRunner(process(1, path: "/opt/homebrew/bin/uv", args: ["uv", "tool", "run", "x"])))
        XCTAssertFalse(IslandServers.isPackageRunner(process(1, path: node, args: ["node", "/opt/homebrew/bin/npm", "run", "dev"])))
        XCTAssertTrue(IslandServers.isShell(process(1, path: "/opt/homebrew/bin/fish")))
        XCTAssertTrue(IslandServers.isShell(process(1, path: "", command: "dash")))
        XCTAssertFalse(IslandServers.isShell(process(1, path: "/opt/homebrew/bin/tmux")))
    }

    /// The real machine's chains (user 2026-10-18): an MCP server a coding agent started — through its CLI, through
    /// Claude's app (its `disclaimer` helper), through `npm exec` — is the agent's, hidden, as Winter's are; a dev server
    /// an agent ran through its bash tool is the user's, listed.
    func testAnAgentsMCPServersAreHiddenButAServerItRanThroughItsShellIsListed() {
        let node = "/opt/homebrew/bin/node"
        let mcp = ["node", "/Users/me/.npm/_npx/4f2a/node_modules/.bin/video-extract-mcp"]
        let npmExec = ["npm exec video-extract-mcp@latest"]
        let list = [
            // codex ← codex ← video-extract-mcp@latest (npm exec) ← node
            process(300, path: "/opt/homebrew/Caskroom/codex/0.162.1/bin/codex"),
            process(301, parent: 300, path: "/opt/homebrew/Caskroom/codex/0.162.1/bin/codex"),
            process(302, parent: 301, path: node, args: npmExec, command: "video-extract-mcp@latest"),
            process(303, parent: 302, path: node, args: mcp, tcp: [50001]),
            // Claude (the desktop app) ← disclaimer ← video-extract-mcp@latest ← node
            process(310, path: "/Applications/Claude.app/Contents/MacOS/Claude"),
            process(311, parent: 310, path: "/Applications/Claude.app/Contents/Helpers/disclaimer"),
            process(312, parent: 311, path: node, args: npmExec, command: "video-extract-mcp@latest"),
            process(313, parent: 312, path: node, args: mcp, tcp: [50002]),
            // Terminal ← login ← claude ← video-extract-mcp@latest ← node
            process(320, path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"),
            process(321, parent: 320, path: "/usr/bin/login"),
            process(322, parent: 321, path: "/Users/me/.local/share/claude/versions/2.1.299"),
            process(323, parent: 322, path: node, args: npmExec, command: "video-extract-mcp@latest"),
            process(324, parent: 323, path: node, args: mcp, tcp: [50003]),
            // claude's bash tool: claude → zsh -c → bun dev — the user's.
            process(325, parent: 322, path: "/bin/zsh"),
            process(326, parent: 325, path: "/opt/homebrew/bin/bun", args: ["bun", "run", "src/index.ts"], cwd: "/Users/me/shop",
                    tcp: [5173]),
            // Cursor's and Antigravity's helpers start MCP servers too.
            process(330, path: "/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)"),
            process(331, parent: 330, path: node, args: mcp, tcp: [50004]),
            process(332, path: "/Applications/Antigravity.app/Contents/MacOS/Electron"),
            process(333, parent: 332, path: node, args: mcp, tcp: [50005]),
        ]
        XCTAssertEqual(rows(list).map(\.name), ["shop"])
        for path in ["/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", "/Applications/Codex.app/Contents/MacOS/Codex",
                     "/Applications/Windsurf.app/Contents/MacOS/Electron", "/Applications/Devin.app/Contents/MacOS/Devin",
                     "/Applications/Claude.app/Contents/Helpers/disclaimer"] {
            XCTAssertTrue(IslandServers.isAgent(process(1, path: path)), path)
        }
        XCTAssertFalse(IslandServers.isAgent(process(1, path: "/Applications/Spotify.app/Contents/MacOS/Spotify")))
    }

    /// A user's own server named like an agent is the user's: only an agent's exact executable or script name, its npm
    /// package or its installer's layout hides one.
    func testAServerNamedLikeAnAgentIsStillListed() {
        let node = "/opt/homebrew/bin/node"
        let list = [
            process(10, path: node, args: ["node", "/Users/me/copilot/index.js"], tcp: [3000], started: epoch + 4),
            process(11, path: "/opt/homebrew/bin/bun", args: ["bun", "/Users/me/gemini-ai/src/index.ts"], tcp: [3001],
                    started: epoch + 3),
            process(12, path: node, args: ["node", "claude-cli.js"], tcp: [3002], started: epoch + 2),
            process(13, path: "/usr/bin/python3", args: ["python3", "claude.py"], tcp: [3003], started: epoch + 1),
        ]
        XCTAssertEqual(rows(list).map(\.name), ["copilot", "gemini-ai", "claude-cli", "claude"])
        XCTAssertTrue(list.allSatisfy { !IslandServers.isAgentCLI($0) })
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
        XCTAssertEqual(name("/opt/homebrew/bin/node", ["node", "/Users/me/app/node_modules/next/dist/bin/next", "dev"]), "next dev")
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
        XCTAssertEqual(name("/usr/bin/ruby", ["ruby", "bin/rails", "server"]), "rails server")
        XCTAssertEqual(name("/opt/homebrew/bin/php", ["php", "-S", "localhost:8000", "-t", "public"]), "php")
        XCTAssertEqual(name("/opt/homebrew/bin/php", ["php", "-S", "localhost:8000", "router.php"]), "router")
        // Not an interpreter, or no arguments read: the executable.
        XCTAssertEqual(name("/usr/local/bin/waifus", ["waifus", "remote"]), "waifus")
        XCTAssertEqual(name("/opt/homebrew/bin/node", nil), "node")
        // `go run`: its temporary build is named by the folder it runs in.
        XCTAssertEqual(name("/private/var/folders/x/T/go-build123/b001/exe/main", nil, cwd: "/Users/me/gosrv"), "gosrv")
    }

    /// A bin script is named by its command and subcommand (user 2026-10-18: two `discord-waifus` rows were one name),
    /// its package kept as the third line's secondary words.
    func testABinScriptIsNamedByItsCommandAndSubcommand() {
        let node = "/opt/homebrew/bin/node"
        let waifus = "/opt/homebrew/lib/node_modules/@waifucave/discord-waifus/bin/waifus.mjs"
        let list = [
            process(400, path: node, args: ["node", waifus, "remote", "--foreground", "--no-open", "--data-root", "/Users/me/.waifus"],
                    cwd: "/Users/me/Discord Waifus", tcp: [3888], started: epoch + 1),
            process(410, path: node, args: ["node", waifus, "start", "--foreground", "--data-root", "/Users/me/.waifus"],
                    cwd: "/Users/me/Discord Waifus", tcp: [61010], started: epoch),
            process(420, path: node, args: ["node", "/Users/me/site/node_modules/.bin/vite"], tcp: [5173], started: epoch - 1),
        ]
        let result = rows(list)
        XCTAssertEqual(result.map(\.name), ["waifus remote", "waifus start", "vite"])
        XCTAssertEqual(result.map(\.package), ["@waifucave/discord-waifus", "@waifucave/discord-waifus", nil],
                       "a package its name already says is not repeated")
        XCTAssertEqual(IslandServers.detailLine(result[0], hovered: false), "Discord Waifus · @waifucave/discord-waifus")
        XCTAssertEqual(IslandServers.detailLine(result[0], hovered: true), "~/Discord Waifus · @waifucave/discord-waifus")
        XCTAssertEqual(IslandServers.detailLine(result[2], hovered: false), "code")

        // No subcommand, or a first argument that is a path or a file: the command alone.
        XCTAssertEqual(name(node, ["node", waifus]), "waifus")
        XCTAssertEqual(name(node, ["node", waifus, "--data-root", "/Users/me/.waifus"]), "waifus")
        XCTAssertEqual(name(node, ["node", "bin/serve.js", "./public"]), "serve")
        XCTAssertEqual(name(node, ["node", "/Users/me/api/bin/www"]), "www")
        XCTAssertEqual(name(node, ["node", "/Users/me/.npm/_npx/4f2a/node_modules/.bin/video-extract-mcp"]), "video-extract-mcp")
        // A venv's bin, any interpreter.
        XCTAssertEqual(name("/Users/me/svc/.venv/bin/python3", ["python3", "/Users/me/svc/.venv/bin/uvicorn", "app:app", "--port", "8000"]),
                       "uvicorn app:app")
        // An entry file in bin/ is still its package's folder.
        XCTAssertEqual(name(node, ["node", "/Users/me/api/bin/index.js"]), "api")
        XCTAssertTrue(IslandServers.isSubcommand("remote"))
        XCTAssertFalse(IslandServers.isSubcommand("server.js"))
        XCTAssertFalse(IslandServers.isSubcommand("/tmp/x"))
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

    func testAZombieIsGone() {
        XCTAssertFalse(LibprocServerProcessSource.isRunning(status: UInt32(SZOMB)))
        XCTAssertTrue(LibprocServerProcessSource.isRunning(status: UInt32(SRUN)))
        XCTAssertTrue(LibprocServerProcessSource.isRunning(status: UInt32(SSLEEP)))
    }

    // MARK: One row per server

    func testAServersWorkersAreOneRowButAServerItStartedApartIsNot() {
        let node = "/opt/homebrew/bin/node"
        let list = [
            process(80, path: "/bin/zsh"),
            // `npm run dev` (its own job's group) listens on nothing; its child is the server.
            process(95, parent: 80, path: node, args: ["node", "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js", "run", "dev"]),
            process(100, parent: 95, group: 95, path: node, args: ["node", "server.js"], tcp: [3000], started: epoch),
            // Forked workers: the same group, or the same binary in a group of their own.
            process(101, parent: 100, group: 95, path: node, args: ["node", "worker.js"], tcp: [3001, 3000], started: epoch + 2),
            process(102, parent: 100, group: 102, path: node, args: ["node", "worker.js"], tcp: [3001], started: epoch + 2),
            // Through a shell: its own row, even in the job's group.
            process(103, parent: 100, group: 95, path: "/bin/sh"),
            process(104, parent: 103, group: 95, path: "/opt/homebrew/bin/python3", args: ["python3", "-m", "sidecar"],
                    tcp: [3002], started: epoch + 3),
            // Another server it launched in a group of its own: its own row, its own Stop.
            process(106, parent: 100, group: 106, path: "/opt/homebrew/bin/redis-server", tcp: [6379], started: epoch + 4),
            // Under another user's listener: its own row (the walk stops at a process that is not the user's).
            process(300, uid: 502, path: node, tcp: [9000]),
            process(301, parent: 300, path: node, args: ["node", "child.js"], tcp: [9001], started: epoch + 30),
        ]
        let result = rows(list)
        XCTAssertEqual(result.map(\.name), ["child", "redis-server", "sidecar", "server"], "newest first")
        let server = result[3]
        XCTAssertEqual(server.members.map(\.pid), [100, 101, 102], "the top first")
        XCTAssertEqual(server.tcpPorts, [3000, 3001])
        XCTAssertEqual(server.portsLine, ":3000 :3001")
        XCTAssertEqual(server.folder, "code")
        XCTAssertEqual(server.folderPath, "~/code")
        XCTAssertEqual(server.id, "100-\(epoch)-7")
        XCTAssertEqual(server.startedAt, Date(timeIntervalSince1970: TimeInterval(epoch) + 0.000007))
        XCTAssertEqual(result[1].members.map(\.pid), [106])
        XCTAssertEqual(result[2].members.map(\.pid), [104])
    }

    /// The re-review's case: a notebook's or an editor's terminal runs the same interpreter as the server around it
    /// (a venv's python resolves to the base one) — never one row, so Stop on one never reaches the other.
    func testTheSameBinaryJoinsOnlyADirectParentAndNeverAcrossAShell() {
        let python = "/opt/homebrew/Cellar/python@3.13/3.13.1/Frameworks/Python.framework/Versions/3.13/bin/python3.13"
        let node = "/opt/homebrew/bin/node"
        let list = [
            // Jupyter → its terminal's bash → python -m http.server: the same python, even the same group.
            process(700, group: 700, path: python, args: ["python3", "-m", "jupyterlab"], tcp: [8888], started: epoch),
            process(701, parent: 700, group: 700, path: "/bin/bash"),
            process(702, parent: 701, group: 700, path: python, args: ["python3", "-m", "http.server"], tcp: [8000],
                    started: epoch + 1),
            // code-server → bash → node server.js: the same node.
            process(800, group: 800, path: node, args: ["node", "/usr/local/lib/code-server/out/node/entry.js"], tcp: [8080],
                    started: epoch + 2),
            process(801, parent: 800, group: 801, path: "/bin/bash"),
            process(802, parent: 801, group: 802, path: node, args: ["node", "server.js"], tcp: [3000], started: epoch + 3),
            // The same node two levels down through a non-shell (its own group): not a forked worker.
            process(900, group: 900, path: node, args: ["node", "gateway.js"], tcp: [7000], started: epoch + 4),
            process(901, parent: 900, group: 901, path: node, args: ["node", "spawner.js"]),
            process(902, parent: 901, group: 902, path: node, args: ["node", "api.js"], tcp: [7001], started: epoch + 5),
            // A direct child on the same binary in its own group IS a forked worker.
            process(910, group: 910, path: "/usr/local/bin/gunicorn", tcp: [5000], started: epoch + 6),
            process(911, parent: 910, group: 911, path: "/usr/local/bin/gunicorn", tcp: [5000], started: epoch + 6),
        ]
        let result = rows(list)
        XCTAssertEqual(result.map(\.name), ["gunicorn", "api", "gateway", "server", "entry", "http.server", "jupyterlab"])
        XCTAssertEqual(result.first?.members.map(\.pid), [910, 911])
        XCTAssertTrue(result.dropFirst().allSatisfy { $0.members.count == 1 })
    }

    /// The review's case: an agent session (or tmux) that starts two servers never makes them one row — Stop on one
    /// must never reach the session or the other server.
    func testServersAnAgentSessionOrTmuxStartedAreSeparateRows() {
        let list = [
            // Claude Code (npm, under node), itself listening — hidden, and it heads nothing.
            process(500, path: "/opt/homebrew/bin/node", args: ["node", "/opt/homebrew/bin/claude"], tcp: [63611]),
            process(501, parent: 500, group: 500, path: "/bin/bash"),
            process(502, parent: 501, group: 500, path: "/opt/homebrew/bin/bun", args: ["bun", "run", "src/index.ts"],
                    cwd: "/Users/me/dashboard", tcp: [5173], started: epoch + 1),
            process(503, parent: 501, group: 500, path: "/usr/bin/python3", args: ["python3", "-m", "http.server"],
                    tcp: [8000], started: epoch + 2),
            // tmux: each pane's shell and job in a group of their own.
            process(600, path: "/opt/homebrew/bin/tmux"),
            process(601, parent: 600, path: "/bin/zsh"),
            process(602, parent: 601, path: "/opt/homebrew/bin/node", args: ["node", "a.js"], tcp: [4001], started: epoch + 3),
            process(603, parent: 600, path: "/bin/zsh"),
            process(604, parent: 603, path: "/opt/homebrew/bin/node", args: ["node", "b.js"], tcp: [4002], started: epoch + 4),
        ]
        let result = rows(list)
        XCTAssertEqual(result.map(\.name), ["b", "a", "http.server", "dashboard"])
        XCTAssertTrue(result.allSatisfy { $0.members.count == 1 })
        XCTAssertFalse(result.flatMap(\.members).contains { $0.pid == 500 }, "the agent session is never a member")
    }

    func testAParentLoopEnds() {
        // Never in a real table (a race between two reads at most): the walk ends, and each is listed.
        let list = [process(10, parent: 11, group: 10, path: "/usr/local/bin/a", tcp: [1]),
                    process(11, parent: 10, group: 10, path: "/usr/local/bin/b", tcp: [2])]
        XCTAssertFalse(rows(list).isEmpty)
        XCTAssertEqual(Set(rows(list).flatMap(\.members).map(\.pid)), [10, 11])
    }

    // MARK: Words

    func testThePortsUptimeAndFolderWords() {
        XCTAssertEqual(IslandServers.portsLine([8080, 3000, 3000]), ":3000 :8080")
        XCTAssertEqual(IslandServers.portsLine([]), "")
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
        func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
        typealias M = IslandServerStopMachine
        // A first click asks; it lapses after the confirm window.
        var (phase, action) = M.tap(nil, now: t0)
        XCTAssertEqual(phase, .confirming(at: t0))
        XCTAssertNil(action)
        XCTAssertEqual(M.settle(phase, now: at(2.9), alive: true), phase)
        XCTAssertNil(M.settle(phase, now: at(3.1), alive: true))
        // A double click is one click: the confirm stays.
        (phase, action) = M.tap(.confirming(at: t0), now: at(0.2))
        XCTAssertEqual(phase, .confirming(at: t0))
        XCTAssertNil(action)
        // A late second click asks again rather than stopping.
        (phase, action) = M.tap(.confirming(at: t0), now: at(4))
        XCTAssertEqual(phase, .confirming(at: at(4)))
        XCTAssertNil(action)
        // Two clicks in time: SIGTERM.
        (phase, action) = M.tap(.confirming(at: t0), now: at(1))
        XCTAssertEqual(phase, .stopping(sentAt: at(1)))
        XCTAssertEqual(action, .terminate)
        XCTAssertEqual(M.tap(phase, now: at(2)).1, nil, "no second signal while stopping")
        XCTAssertEqual(M.settle(phase, now: at(5.9), alive: true), phase)
        XCTAssertNil(M.settle(phase, now: at(6), alive: false), "it went")
        XCTAssertEqual(M.settle(phase, now: at(6), alive: true), .forceOffered)
        // Force quit: two clicks again, a double click still one.
        (phase, action) = M.tap(.forceOffered, now: at(10))
        XCTAssertEqual(phase, .confirmingForce(at: at(10)))
        XCTAssertNil(action)
        XCTAssertEqual(M.tap(phase, now: at(10.1)).1, nil)
        XCTAssertEqual(M.settle(phase, now: at(13.5), alive: true), .forceOffered)
        (phase, action) = M.tap(phase, now: at(12))
        XCTAssertEqual(phase, .killing(sentAt: at(12)))
        XCTAssertEqual(action, .kill)
        XCTAssertNil(M.settle(phase, now: at(17), alive: false))
        XCTAssertNil(M.deadline(nil))
        XCTAssertNil(M.deadline(.forceOffered))
        XCTAssertEqual(M.deadline(.stopping(sentAt: t0)), at(5))
    }

    private final class FakeSource: ServerProcessSource {
        var list: [ServerProcess] = []
        var alive: [Int32: ServerProcessIdentity] = [:]
        var paths: [Int32: String] = [:]
        func processes() -> [ServerProcess] { list }
        func identity(of pid: Int32) -> ServerProcessIdentity? { alive[pid] }
        func path(of pid: Int32) -> String { paths[pid] ?? "/opt/homebrew/bin/node" }
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
        model.parentPid = 1
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
        [process(100, group: 100, path: "/opt/homebrew/bin/node", args: ["node", "bot.js"], tcp: [3000]),
         process(101, parent: 100, group: 100, path: "/opt/homebrew/bin/node", args: ["node", "worker.js"], tcp: [3001])]
    }

    func testStopAsksTwiceThenTerminatesTheServerThenOffersForceQuit() async {
        let h = await harness(bot)
        XCTAssertTrue(h.model.loaded)
        XCTAssertEqual(h.model.rows.map(\.name), ["bot"])
        let row = h.model.rows[0]

        // One click asks; a double click's second half changes nothing (and arms nothing more); 3 s later it lapses.
        h.model.tap(row)
        XCTAssertEqual(h.model.stops[row.id], .confirming(at: clock))
        clock.addTimeInterval(0.1)
        h.model.tap(row)
        XCTAssertEqual(scheduled.count, 1, "one wake-up for the lapse")
        clock.addTimeInterval(3.2)
        fire()
        XCTAssertNil(h.model.stops[row.id])
        XCTAssertTrue(scheduled.isEmpty, "nothing armed at rest")
        XCTAssertTrue(h.signaller.sent.isEmpty)

        // Two clicks in time: SIGTERM to the top, then its worker. The confirm's wake-up, superseded, does nothing.
        h.model.tap(row)
        clock.addTimeInterval(1)
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent, ["TERM 100", "TERM 101"])
        XCTAssertEqual(h.model.stops[row.id], .stopping(sentAt: clock))
        XCTAssertEqual(scheduled.count, 2)
        scheduled.first?()
        XCTAssertEqual(h.model.stops[row.id], .stopping(sentAt: clock), "a superseded wake-up does nothing")
        scheduled.removeFirst()
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent.count, 2, "no second signal while it stops")
        XCTAssertEqual(scheduled.count, 1, "the same deadline is not armed twice")

        // Still alive 5 s later: Force quit, two clicks again.
        clock.addTimeInterval(5)
        fire()
        XCTAssertEqual(h.model.stops[row.id], .forceOffered)
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent.count, 2)
        clock.addTimeInterval(0.5)
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent.suffix(2), ["KILL 100", "KILL 101"])

        // It goes: the next wake-up drops the phase and the row.
        h.source.alive = [:]
        clock.addTimeInterval(5)
        fire()
        XCTAssertNil(h.model.stops[row.id])
        XCTAssertTrue(h.model.rows.isEmpty)
    }

    func testAConfirmSurvivesARefresh() async {
        let h = await harness(bot)
        let row = h.model.rows[0]
        h.model.tap(row)
        await h.model.refresh()
        XCTAssertEqual(h.model.stops[row.id], .confirming(at: clock), "the 5 s refresh never resets a Stop?")
        clock.addTimeInterval(1)
        h.model.tap(h.model.rows[0])
        XCTAssertEqual(h.signaller.sent, ["TERM 100", "TERM 101"])
    }

    func testAServerThatStopsInTimeGetsNoForceQuit() async {
        let h = await harness(bot)
        let row = h.model.rows[0]
        h.model.tap(row)
        clock.addTimeInterval(1)
        h.model.tap(row)
        XCTAssertEqual(h.signaller.sent, ["TERM 100", "TERM 101"])
        h.source.alive = [:]
        h.source.list = []
        await h.model.refresh()
        XCTAssertTrue(h.model.rows.isEmpty)
        XCTAssertTrue(h.model.stops.isEmpty, "a gone row's Stop goes with it")
    }

    func testAReusedPidOrAProtectedProcessIsNeverSignalled() async {
        let h = await harness(bot)
        let row = h.model.rows[0]
        // 100 ended and its pid went to a new process (another start time); 101 is now another user's.
        h.source.alive[100] = ServerProcessIdentity(pid: 100, uid: me, startSeconds: epoch + 500, startMicros: 0)
        h.source.alive[101] = ServerProcessIdentity(pid: 101, uid: 0, startSeconds: epoch, startMicros: 7)
        h.model.tap(row)
        clock.addTimeInterval(1)
        h.model.tap(row)
        XCTAssertTrue(h.signaller.sent.isEmpty)
        XCTAssertNil(h.model.stops[row.id], "nothing left to stop")

        // Whatever a row says: never another user's, launchd, this app, its parent or a Winter process.
        func identity(_ pid: Int32, uid: uid_t? = nil) -> ServerProcessIdentity {
            ServerProcessIdentity(pid: pid, uid: uid ?? me, startSeconds: epoch, startMicros: 0)
        }
        let source = FakeSource()
        for pid: Int32 in [1, 300, 400, 401, 402, 403] { source.alive[pid] = identity(pid, uid: pid == 300 ? 502 : nil) }
        source.paths[402] = "/Users/me/winter/dist/dev/winter-core"
        source.paths[403] = "/Applications/Winter.app/Contents/Helpers/WinterHelper.app/Contents/MacOS/WinterHelper"
        let signaller = FakeSignaller()
        let members = [identity(1), identity(300, uid: 502), identity(400), identity(401), identity(402), identity(403)]
        XCTAssertEqual(IslandServers.signal(SIGTERM, members, user: me, ownPid: 400, parentPid: 401, source: source,
                                            signaller: signaller), 0)
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

    /// The detection core on real sockets of THIS process (nothing is signalled): a TCP listener on 127.0.0.1 (and on
    /// ::1 with the same port when it is free there — still one port), a Unix-socket listener and a connected TCP
    /// socket. Against a scan taken before any of them, the process gains exactly the listener's port, in the right
    /// byte order; without the TCP listeners it gains nothing — the Unix listener and the connections add no port.
    func testTheLiveSourceReportsThisProcesssTCPListenerOnly() throws {
        func bindAndListen<T>(_ fd: Int32, _ address: inout T) -> Bool {
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<T>.size)) }
            }
            return bound == 0 && Darwin.listen(fd, 4) == 0
        }
        func localPort(_ fd: Int32) -> UInt16 {
            var address = sockaddr_in()
            var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
            }
            return UInt16(bigEndian: address.sin_port)
        }
        func loopback(_ port: UInt16) -> sockaddr_in {
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = port.bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            return address
        }

        let source = LibprocServerProcessSource()
        let baseline = Set(try XCTUnwrap(source.processes().first { $0.pid == getpid() }).tcpPorts)

        let v4 = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(v4, 0)
        var any = loopback(0)
        XCTAssertTrue(bindAndListen(v4, &any))
        let port = localPort(v4)
        XCTAssertNotEqual(port, 0)

        let v6 = socket(AF_INET6, SOCK_STREAM, 0)
        var address6 = sockaddr_in6()
        address6.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        address6.sin6_family = sa_family_t(AF_INET6)
        address6.sin6_port = port.bigEndian
        address6.sin6_addr = in6addr_loopback
        let v6Listening = bindAndListen(v6, &address6)
        if v6Listening {
            var bound6 = sockaddr_in6()
            var length6 = socklen_t(MemoryLayout<sockaddr_in6>.size)
            _ = withUnsafeMutablePointer(to: &bound6) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(v6, $0, &length6) }
            }
            XCTAssertEqual(UInt16(bigEndian: bound6.sin6_port), port, "the ::1 listener shares the port")
        } else {
            print("IslandServers socket test: the v6 part is skipped — ::1 port \(port) could not be bound (errno \(errno))")
        }

        let socketPath = (NSTemporaryDirectory() as NSString).appendingPathComponent("srv-\(UUID().uuidString.prefix(8)).sock")
        let unix = socket(AF_UNIX, SOCK_STREAM, 0)
        var unixAddress = sockaddr_un()
        unixAddress.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        unixAddress.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        withUnsafeMutableBytes(of: &unixAddress.sun_path) { raw in raw.copyBytes(from: pathBytes.prefix(raw.count - 1)) }
        XCTAssertTrue(bindAndListen(unix, &unixAddress), "a Unix listener at \(socketPath)")
        defer {
            close(unix)
            unlink(socketPath)
        }

        let client = socket(AF_INET, SOCK_STREAM, 0)
        var target = loopback(port)
        let connected = withUnsafePointer(to: &target) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(client, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        XCTAssertEqual(connected, 0)
        let accepted = Darwin.accept(v4, nil, nil)
        defer {
            close(client)
            close(accepted)
        }
        let clientPort = localPort(client)

        XCTAssertNotEqual(clientPort, port)
        let mine = try XCTUnwrap(source.processes().first { $0.pid == getpid() })
        XCTAssertEqual(mine.tcpPorts.filter { $0 == port }.count, 1, "the port once, v4 and v6 (v6 bound: \(v6Listening))")
        XCTAssertEqual(Set(mine.tcpPorts), baseline.union([port]),
                       "exactly the listener's port is new — never the connected sockets' (\(clientPort)) or the Unix listener")

        // Without its TCP listeners (the Unix listener and both connected sockets still open) nothing is new: no row.
        close(v4)
        close(v6)
        let after = try XCTUnwrap(source.processes().first { $0.pid == getpid() })
        XCTAssertEqual(Set(after.tcpPorts), baseline)
        var asServer = after
        asServer.path = "/usr/local/bin/fixture"
        asServer.tcpPorts = after.tcpPorts.filter { !baseline.contains($0) }
        XCTAssertTrue(IslandServers.rows([asServer], user: getuid(), ownPid: 0, home: NSHomeDirectory()).isEmpty,
                      "a Unix listener alone makes no row")
    }
}
