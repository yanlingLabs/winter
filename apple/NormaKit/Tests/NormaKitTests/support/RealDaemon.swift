import Foundation
import NormaKit
import XCTest

// MARK: - RealDaemon

/// Errors surfaced while spawning/reading from the real daemon subprocess. Kept verbose (stderr
/// is folded into most cases) since a startup failure here usually means "the daemon itself threw
/// during boot" — the fastest way to find out why is to see what it printed.
enum RealDaemonError: Error, CustomStringConvertible {
    case setupFailed(String)
    case timedOut(stderr: String)
    case processExitedEarly(exitCode: Int32, stderr: String)
    case badOutput(line: String)

    var description: String {
        switch self {
        case .setupFailed(let why):
            return "RealDaemon: \(why)"
        case .timedOut(let stderr):
            return "RealDaemon: timed out waiting for the daemon's ready line — stderr so far:\n\(stderr)"
        case .processExitedEarly(let code, let stderr):
            return "RealDaemon: bun fixture exited early (code \(code)) before printing its ready line — stderr:\n\(stderr)"
        case .badOutput(let line):
            return "RealDaemon: could not decode fixture stdout as JSON: \(line)"
        }
    }
}

/// SP2a Task 1: a real-daemon Swift test harness. Spawns the ACTUAL bun daemon (`startDaemon`
/// from `@norma/core`) on a temp `NORMA_HOME`, with an EXPLICIT `FileSecretStore` — never the
/// live macOS Keychain, and never `packages/cli/src/main.ts`'s `daemon run` (whose CLI path
/// defaults to `KeychainSecretStore`: reading that token from Swift is infeasible, and spawning
/// it would touch the real, live daemon's Keychain entry — forbidden by this project's
/// never-touch-live-Keychain test rule). Mirrors the TS precedent
/// `packages/cli/test/daemon-sigterm.test.ts`'s `bun -e` fixture almost verbatim.
///
/// Used by SP2a's later tasks (the gateway gates + the E2E, Tasks 2 & 9) so those tests finally
/// exercise the gateway's daemon-facing bridge client against REAL `hub.attach` semantics instead
/// of a scripted/fake `NormaTransport`.
struct RealDaemon {
    let socketPath: String
    let harnessToken: String
    let remoteToken: String
    private let process: Process
    private let home: String
    private let stdoutPath: String
    private let stderrPath: String

    /// bun's resolution of a bare specifier like `@norma/core` walks up from the SPAWNED
    /// PROCESS'S CWD looking for `node_modules/@norma/core` — it does not consult the repo root.
    /// In this pnpm workspace, `node_modules/@norma/{core,protocol}` (symlinks into
    /// `packages/{core,protocol}`) exist ONLY under `packages/cli` — verified empirically:
    /// `bun -e 'import ... from "@norma/core"'` fails with "Cannot find module '@norma/core'"
    /// when run with the repo root as cwd, and succeeds when run from `packages/cli`. This is
    /// exactly why the TS precedent (`daemon-sigterm.test.ts`) spawns with
    /// `cwd: join(import.meta.dir, "..")` — i.e. `packages/cli` — rather than the repo root. So
    /// the spawned process's `currentDirectoryURL` here is `packages/cli`, not the bare repo root
    /// the task brief's mechanics sketch suggested (that sketch predates this empirical check).
    private static var cliPackageDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // .../support/RealDaemon.swift -> .../support
            .deletingLastPathComponent() // .../support -> .../NormaKitTests
            .deletingLastPathComponent() // .../NormaKitTests -> .../Tests
            .deletingLastPathComponent() // .../Tests -> .../NormaKit
            .deletingLastPathComponent() // .../NormaKit -> .../apple
            .deletingLastPathComponent() // .../apple -> repo root
            .appendingPathComponent("packages/cli")
    }

    /// Mirrors `daemon-sigterm.test.ts`'s fixture verbatim (module + shape), plus the `remote`
    /// token (this task's daemon.ts change exposes it on `RunningDaemon.tokens`) since Tasks 2 & 9
    /// need it for the gateway's daemon-facing bridge client, which authenticates as `"remote"`.
    private static let fixture = """
    import { startDaemon, FileSecretStore } from "@norma/core";
    const home = process.env.NORMA_HOME;
    const d = await startDaemon({ home, secrets: new FileSecretStore(home + "/secrets"), agentProvider: null });
    process.stdout.write(JSON.stringify({ socketPath: d.socketPath, harness: d.tokens.harness, remote: d.tokens.remote }) + "\\n");
    process.on("SIGTERM", () => { d.stop(); process.exit(0); });
    """

    /// iOS remote-path T2: the same daemon, booted with an INJECTED streaming `Provider` instead of
    /// `agentProvider: null`, so a `session.send` runs a REAL turn through the REAL `AgentEngine`
    /// and produces the events the phone path actually depends on — `assistant_delta` transients via
    /// `hub.broadcastTransient` (borrowed seq and all), a persisted `reasoning_item` carrying opaque
    /// provider state, and an oversized final message. Nothing here is faked below the provider
    /// boundary: the engine, the hub, the store, the IPC server and the gateway are all production
    /// code. (`agentProvider: {provider, model}` is the same injection seam packages/core's own
    /// tests use — daemon.ts's `startDaemon` option, "object: use this provider directly".)
    ///
    /// The stream is: six small text chunks (six `assistant_delta`s at ONE borrowed seq), one opaque
    /// `reasoning_item`, then a >1 MiB chunk. That last chunk is deliberate — uncapped it produces
    /// both an `assistant_delta` and a final `assistant_message` past the phone transport's hard
    /// 1 MiB de-framing limit, whose overflow silently ends the phone's inbound stream.
    static let streamingProviderFixture = """
    import { startDaemon, FileSecretStore } from "@norma/core";
    const home = process.env.NORMA_HOME;
    const CHUNKS = \(streamedChunksJSLiteral);
    const provider = {
      id: "conformance-fake",
      models: () => [{ id: "conformance-model", family: "conformance", contextWindow: 128000, supportsVision: false }],
      async *streamTurn() {
        for (const c of CHUNKS) yield { type: "text_delta", delta: c };
        yield { type: "reasoning_item", itemJson: "\(streamedReasoningSecret)" };
        yield { type: "text_delta", delta: "Z".repeat(\(oversizedChunkBytes)) };
        yield { type: "done", stopReason: "end_turn" };
      },
    };
    const d = await startDaemon({
      home, secrets: new FileSecretStore(home + "/secrets"),
      agentProvider: { provider, model: "conformance-model" },
    });
    process.stdout.write(JSON.stringify({ socketPath: d.socketPath, harness: d.tokens.harness, remote: d.tokens.remote }) + "\\n");
    process.on("SIGTERM", () => { d.stop(); process.exit(0); });
    """

    /// The six small chunks `streamingProviderFixture` streams, in order — and the expected
    /// `assistant_delta` sequence on the phone. The fixture's JS array is INTERPOLATED from this
    /// (`streamedChunksJSLiteral`), not hand-copied — writing the same list twice is the exact
    /// failure mode this whole task exists to remove.
    static let streamedChunks = ["Hel", "lo ", "from ", "the ", "real ", "engine"]
    /// `streamedChunks` as a JS array literal, for the fixture above. The chunks are plain ASCII
    /// with no quotes or backslashes, so a bare quote-and-join is sufficient and honest here.
    private static var streamedChunksJSLiteral: String {
        "[" + streamedChunks.map { "\"\($0)\"" }.joined(separator: ", ") + "]"
    }
    /// The opaque `reasoning_item.itemJson` that fixture persists. Stands in for the provider's
    /// `encrypted_content`: it must appear in the daemon's session log and NOWHERE on the wire to a
    /// phone.
    static let streamedReasoningSecret = "conformance-encrypted-content-must-not-cross-the-wire"
    /// Size of the fixture's final text chunk — past the phone's 1 MiB frame limit on purpose.
    static let oversizedChunkBytes = 1_500_000

    private struct FixtureOutput: Decodable {
        let socketPath: String
        let harness: String
        let remote: String
    }

    /// Spawns the daemon on a temp `NORMA_HOME` and waits (asynchronously) for its ready line.
    /// Throws if the fixture exits early or doesn't come up within the deadline. On ANY such throw
    /// it terminates the subprocess and removes the temp home + scratch files itself (the returned
    /// `RealDaemon`'s `stop()` is otherwise the only cleanup path). `fixtureOverride` is test-only —
    /// it lets a cleanup-on-failure test inject a fixture that exits early / prints garbage.
    static func start(fixtureOverride: String? = nil) async throws -> RealDaemon {
        // Rooted at `/tmp`, NOT `NSTemporaryDirectory()`: on macOS the latter resolves to a long
        // per-process path (`/var/folders/xx/.../T/`), and `home + "/run/core.sock"` then blows
        // past `sockaddr_un`'s ~104-byte `sun_path` limit. The daemon itself boots fine either way
        // (Bun's own unix-socket bind doesn't enforce that limit the same way) and happily prints
        // its ready line — but this harness's OWN self-test then crashes with an uncatchable
        // `EXC_BREAKPOINT`/SIGTRAP inside `NWEndpoint.unix(path:)` (confirmed via a crash report:
        // `UnixSocketTransport.init(path:)` -> `NWConnection(to: NWEndpoint.unix(path:...))`)
        // when it tries to actually CONNECT to that overlong path. `/tmp` is short and stable, so
        // `/tmp/norma-sp2a-<uuid>/run/core.sock` (~66 bytes) stays comfortably under the limit.
        let home = "/tmp/norma-sp2a-\(UUID().uuidString)"
        let stdoutPath = NSTemporaryDirectory() + "norma-sp2a-\(UUID().uuidString).stdout"
        let stderrPath = NSTemporaryDirectory() + "norma-sp2a-\(UUID().uuidString).stderr"

        guard FileManager.default.createFile(atPath: stdoutPath, contents: nil),
              FileManager.default.createFile(atPath: stderrPath, contents: nil) else {
            throw RealDaemonError.setupFailed("could not create scratch files for stdout/stderr capture")
        }
        guard let stdoutHandle = FileHandle(forWritingAtPath: stdoutPath),
              let stderrHandle = FileHandle(forWritingAtPath: stderrPath) else {
            throw RealDaemonError.setupFailed("could not open scratch files for writing")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", "-e", fixtureOverride ?? Self.fixture]
        process.currentDirectoryURL = cliPackageDir
        var env = ProcessInfo.processInfo.environment
        env["NORMA_HOME"] = home
        process.environment = env
        process.standardOutput = stdoutHandle
        process.standardError = stderrHandle

        try process.run()

        // Once the process is running, any failure BEFORE we return a RealDaemon (whose stop() is
        // the only cleanup path) must tear down the subprocess + temp home itself — otherwise a
        // slow/hung boot (.timedOut), a crashed fixture (.processExitedEarly), or a garbage line
        // leaks a zombie bun process and a stale /tmp/norma-sp2a-<uuid> for the rest of the session.
        func cleanupPartial() {
            if process.isRunning { process.terminate(); process.waitUntilExit() }
            try? FileManager.default.removeItem(atPath: home)
            try? FileManager.default.removeItem(atPath: stdoutPath)
            try? FileManager.default.removeItem(atPath: stderrPath)
        }

        let out: FixtureOutput
        do {
            let line = try await waitForFirstLine(process: process, stdoutPath: stdoutPath, stderrPath: stderrPath)
            guard let data = line.data(using: .utf8) else { throw RealDaemonError.badOutput(line: line) }
            do {
                out = try JSONDecoder().decode(FixtureOutput.self, from: data)
            } catch {
                throw RealDaemonError.badOutput(line: line) // malformed line → friendly error, not a raw DecodingError
            }
        } catch {
            cleanupPartial()
            throw error
        }

        return RealDaemon(
            socketPath: out.socketPath,
            harnessToken: out.harness,
            remoteToken: out.remote,
            process: process,
            home: home,
            stdoutPath: stdoutPath,
            stderrPath: stderrPath
        )
    }

    /// Polls the redirected stdout file until its first full (newline-terminated) line lands —
    /// mirrors the TS precedent's own `while (!existsSync...) await Bun.sleep(50)` poll loop, no
    /// blocking Pipe reads or extra threads needed. Requires an actual `\n` to have arrived (not
    /// just non-empty content) so a partial write mid-flush is never mistaken for the full JSON
    /// line. 20s deadline: `startDaemon` boots a full agent-less core (sessions store, hub, IPC
    /// server, routine scheduler, ...) — a couple of seconds on a warm machine, generous headroom
    /// for CI.
    private static func waitForFirstLine(
        process: Process, stdoutPath: String, stderrPath: String, timeoutSeconds: Double = 20
    ) async throws -> String {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if let data = FileManager.default.contents(atPath: stdoutPath),
               let text = String(data: data, encoding: .utf8),
               let newlineIndex = text.firstIndex(of: "\n") {
                let firstLine = String(text[..<newlineIndex])
                if !firstLine.isEmpty { return firstLine }
            }
            if !process.isRunning {
                throw RealDaemonError.processExitedEarly(
                    exitCode: process.terminationStatus,
                    stderr: readAll(stderrPath)
                )
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw RealDaemonError.timedOut(stderr: readAll(stderrPath))
    }

    private static func readAll(_ path: String) -> String {
        guard let data = FileManager.default.contents(atPath: path) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// SIGTERM + wait — the fixture's own handler calls `d.stop()` for a clean socket/lock
    /// release (mirroring the TS `daemon-sigterm` precedent's shutdown path) — then removes the
    /// temp `NORMA_HOME` and the redirected stdout/stderr scratch files. Idempotent: safe to call
    /// more than once (e.g. an explicit call plus a `defer` safety net).
    ///
    /// **The wait is BOUNDED, deliberately — do not restore `process.waitUntilExit()`.** That call
    /// has been observed to block FOREVER here even though the child had genuinely exited: no
    /// `bun -e` process left on the machine, and a `sample` of the stuck runner parked in
    /// `-[NSConcreteTask waitUntilExit]` under this very `defer`. It is a Foundation reaping race,
    /// nondeterministic (a different test hit it on each run of this suite, and an orphaned
    /// `xctest` process from a prior session's run was still resident on the machine when this was
    /// found — same signature). Unbounded, one occurrence wedges the ENTIRE suite: no summary line,
    /// no failure, no output at all, and an orphaned test runner left behind. Bounded, it costs at
    /// most a few seconds and escalates to SIGKILL. This changes no daemon behavior — only how long
    /// a test is willing to wait for a process that has already been told to die.
    func stop() {
        if process.isRunning {
            process.terminate() // SIGTERM — the fixture's handler runs d.stop() then exit(0)
            if !waitForExit(within: 5) {
                kill(process.processIdentifier, SIGKILL)
                _ = waitForExit(within: 2)
            }
        }
        try? FileManager.default.removeItem(atPath: home)
        try? FileManager.default.removeItem(atPath: stdoutPath)
        try? FileManager.default.removeItem(atPath: stderrPath)
    }

    /// Polls `isRunning` to a deadline instead of blocking in `waitUntilExit()` — see `stop()`.
    /// Returns whether the process was observed to have exited.
    private func waitForExit(within seconds: Double) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if !process.isRunning { return true }
            usleep(20_000)
        }
        return !process.isRunning
    }
}

// MARK: - Self-test

/// TDD Step 1 for SP2a Task 1: this asserted RED (compile failure — `RealDaemon` didn't exist)
/// before the harness above was written. It is the harness's OWN self-test, proving `start()`
/// yields a live socket a real `UnixSocketTransport` + `NormaClient.connect(role:)` can hello
/// against, and that `stop()` cleans up — before Tasks 2 & 9 build gateway-gate tests on top of
/// `RealDaemon.start()`.
final class RealDaemonTests: XCTestCase {
    func testStartHellosThenStopRemovesSocket() async throws {
        let daemon = try await RealDaemon.start()
        defer { daemon.stop() } // safety net if an assertion below throws first

        XCTAssertTrue(FileManager.default.fileExists(atPath: daemon.socketPath), "daemon should have created its socket")
        XCTAssertFalse(daemon.harnessToken.isEmpty)
        XCTAssertFalse(daemon.remoteToken.isEmpty)
        XCTAssertNotEqual(daemon.harnessToken, daemon.remoteToken)

        let client = NormaClient(
            makeTransport: { UnixSocketTransport(path: daemon.socketPath) },
            token: daemon.harnessToken,
            clientName: "real-daemon-self-test"
        )
        // A successful return IS the hello-succeeded signal (NormaClient.connect's own contract).
        try await client.connect(role: "harness")
        await client.close()

        daemon.stop() // idempotent alongside the `defer` above
        XCTAssertFalse(FileManager.default.fileExists(atPath: daemon.socketPath), "stop() should remove the socket")
    }

    /// A fixture that prints garbage (not the expected JSON) must make `start()` THROW `badOutput`
    /// AND clean up after itself — no leaked subprocess, no stale `/tmp/norma-sp2a-<uuid>` home.
    func testStartCleansUpOnBadOutput() async throws {
        func normaTempDirCount() -> Int {
            let items = (try? FileManager.default.contentsOfDirectory(atPath: "/tmp")) ?? []
            return items.filter { $0.hasPrefix("norma-sp2a-") }.count
        }
        let before = normaTempDirCount()

        do {
            _ = try await RealDaemon.start(fixtureOverride: "process.stdout.write('not-json\\n');")
            XCTFail("start() should have thrown on garbage fixture output")
        } catch let RealDaemonError.badOutput(line) {
            XCTAssertEqual(line, "not-json")
        }
        // Cleanup removes the temp home it created → count returns to baseline (no leak).
        XCTAssertEqual(normaTempDirCount(), before, "start() must remove its temp home on failure")
    }
}
