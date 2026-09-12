import Foundation
import WinterKit
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
/// from `@winter/core`) on a temp `WINTER_HOME`, with an EXPLICIT `FileSecretStore` — never the
/// live macOS Keychain, and never `packages/cli/src/main.ts`'s `daemon run` (whose CLI path
/// defaults to `KeychainSecretStore`: reading that token from Swift is infeasible, and spawning
/// it would touch the real, live daemon's Keychain entry — forbidden by this project's
/// never-touch-live-Keychain test rule). Mirrors the TS precedent
/// `packages/cli/test/daemon-sigterm.test.ts`'s `bun -e` fixture almost verbatim.
///
/// Used by SP2a's later tasks (the gateway gates + the E2E, Tasks 2 & 9) so those tests finally
/// exercise the gateway's daemon-facing bridge client against REAL `hub.attach` semantics instead
/// of a scripted/fake `WinterTransport`.
struct RealDaemon {
    let socketPath: String
    let harnessToken: String
    let remoteToken: String
    private let process: Process
    private let home: String
    private let stdoutPath: String
    private let stderrPath: String

    /// bun's resolution of a bare specifier like `@winter/core` walks up from the SPAWNED
    /// PROCESS'S CWD looking for `node_modules/@winter/core` — it does not consult the repo root.
    /// In this pnpm workspace, `node_modules/@winter/{core,protocol}` (symlinks into
    /// `packages/{core,protocol}`) exist ONLY under `packages/cli` — verified empirically:
    /// `bun -e 'import ... from "@winter/core"'` fails with "Cannot find module '@winter/core'"
    /// when run with the repo root as cwd, and succeeds when run from `packages/cli`. This is
    /// exactly why the TS precedent (`daemon-sigterm.test.ts`) spawns with
    /// `cwd: join(import.meta.dir, "..")` — i.e. `packages/cli` — rather than the repo root. So
    /// the spawned process's `currentDirectoryURL` here is `packages/cli`, not the bare repo root
    /// the task brief's mechanics sketch suggested (that sketch predates this empirical check).
    private static var cliPackageDir: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // .../support/RealDaemon.swift -> .../support
            .deletingLastPathComponent() // .../support -> .../WinterKitTests
            .deletingLastPathComponent() // .../WinterKitTests -> .../Tests
            .deletingLastPathComponent() // .../Tests -> .../WinterKit
            .deletingLastPathComponent() // .../WinterKit -> .../apple
            .deletingLastPathComponent() // .../apple -> repo root
            .appendingPathComponent("packages/cli")
    }

    /// Mirrors `daemon-sigterm.test.ts`'s fixture verbatim (module + shape), plus the `remote`
    /// token (this task's daemon.ts change exposes it on `RunningDaemon.tokens`) since Tasks 2 & 9
    /// need it for the gateway's daemon-facing bridge client, which authenticates as `"remote"`.
    private static let fixture = """
    import { startDaemon, FileSecretStore } from "@winter/core";
    const home = process.env.WINTER_HOME;
    const d = await startDaemon({ home, secrets: new FileSecretStore(home + "/secrets"), agentProvider: null });
    process.stdout.write(JSON.stringify({ socketPath: d.socketPath, harness: d.tokens.harness, remote: d.tokens.remote }) + "\\n");
    process.on("SIGTERM", async () => { await d.stop(); process.exit(0); });
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
    import { startDaemon, FileSecretStore } from "@winter/core";
    const home = process.env.WINTER_HOME;
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
    process.on("SIGTERM", async () => { await d.stop(); process.exit(0); });
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

    /// Spawns the daemon on a temp `WINTER_HOME` and waits (asynchronously) for its ready line.
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
        // `/tmp/winter-sp2a-<uuid>/run/core.sock` (~66 bytes) stays comfortably under the limit.
        let home = "/tmp/winter-sp2a-\(UUID().uuidString)"
        let stdoutPath = NSTemporaryDirectory() + "winter-sp2a-\(UUID().uuidString).stdout"
        let stderrPath = NSTemporaryDirectory() + "winter-sp2a-\(UUID().uuidString).stderr"

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
        env["WINTER_HOME"] = home
        process.environment = env
        process.standardOutput = stdoutHandle
        process.standardError = stderrHandle

        try process.run()

        // Once the process is running, any failure BEFORE we return a RealDaemon (whose stop() is
        // the only cleanup path) must tear down the subprocess + temp home itself — otherwise a
        // slow/hung boot (.timedOut), a crashed fixture (.processExitedEarly), or a garbage line
        // leaks a zombie bun process and a stale /tmp/winter-sp2a-<uuid> for the rest of the session.
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

    /// Polls the redirected stdout file until a line that decodes as the fixture's OWN JSON hello
    /// (`FixtureOutput`'s `{socketPath, harness, remote}` shape) lands — mirrors the TS
    /// precedent's own `while (!existsSync...) await Bun.sleep(50)` poll loop, no blocking Pipe
    /// reads or extra threads needed.
    ///
    /// Winter Phase 8d (P8d-19, whole-branch review / Lane 1's new CI Swift job): this used to
    /// trust the very FIRST newline-terminated line as the hello, which broke the instant
    /// `startDaemon` (`packages/core/src/daemon.ts`, the 8b credential-material hotfix) started
    /// printing its OWN boot narration to stdout before ever returning — `credentials: …`,
    /// `runtime-state: runtime recovery: …`, `runtime-sdk: directory recovery — …`, `winter-core …
    /// listening on …` all land on the SAME stdout stream, ahead of the fixture's
    /// `process.stdout.write(JSON.stringify(...))` call, which only runs after `startDaemon`
    /// resolves. ~29 tests across `RealDaemonTests`/`GatewayGateTests`/`IrohE2ETests`/
    /// `PairingE2ETests`/`FakePhoneConformanceTests` failed decoding a narration line as JSON.
    ///
    /// Fixed by trying EVERY complete line seen so far, in order, on every poll — the first one
    /// that decodes as `FixtureOutput` wins and is returned (the caller re-decodes it itself,
    /// unchanged, so `.badOutput`'s wrapping stays exactly as it was); every earlier line is
    /// recorded as skipped rather than trusted. A still-running process with only narration lines
    /// so far keeps polling (the new, correct behaviour); a process that has ALREADY EXITED
    /// without ever printing a decodable line returns the LAST line it printed — preserving the
    /// pre-fix contract for a fixture that prints garbage and exits immediately
    /// (`testStartCleansUpOnBadOutput`'s own `.badOutput("not-json")` expectation) — or throws
    /// `.processExitedEarly` if it printed nothing decodable at all, exactly as before. Requires an
    /// actual `\n` to have arrived per line (not just non-empty content) so a partial write
    /// mid-flush is never mistaken for a complete line. 20s deadline: `startDaemon` boots a full
    /// agent-less core (sessions store, hub, IPC server, routine scheduler, ...) — a couple of
    /// seconds on a warm machine, generous headroom for CI.
    ///
    /// Winter Phase 9a (P9a-11, Lane K): the "DIFFERENT, deeper failure class" this fix's own
    /// commit message carried forward (`CancellationError()`/`IrohError ConnectionLost
    /// (LocallyClosed)` on `FakePhoneConformanceTests`/`GatewayGateTests`/`IrohE2ETests`, 13 tests
    /// by name, skipped in `ci.yml`'s `WINTERKIT_SKIP`) is CLASSIFIED, not fixed here — bisected
    /// (this worktree, this fixture unchanged at every step) to `ed6ebeca6c1fce175ef0e818361fb3662b38d6ca`
    /// ("feat(core): Dispatch on the Winter leg — winterLeg.dispatch defaults to true", Task 17
    /// Step 1, pre-dating 8d entirely): `session.dispatch {}`'s default mode now mints on the
    /// Winter leg and requires a resolvable `winter` executable at create time — this fixture sets
    /// no `WINTER_RUNTIME_EXECUTABLE` and stages no bundle/home binary (matching WinterKit's actual CI
    /// `swift` job, which never builds/installs one), so every one of the 13 tests that seeds a
    /// real session via `session.dispatch` fails there. Over `ScriptedRemoteConn`/`LoopbackListener`
    /// (`GatewayGateTests`) the failure surfaces as a plain `RpcError`/`CancellationError` from
    /// `WinterClient`; over the REAL Iroh transport (`IrohE2ETests`, `FakePhoneConformanceTests`) the
    /// resulting local `close()` is what the Iroh FFI reports to the peer as `ConnectionLost
    /// (LocallyClosed)` — confirmed by re-running with `WINTER_RUNTIME_EXECUTABLE` UNSET, which
    /// reproduces `IrohError { kind: Stream, message: "ConnectionLost(LocallyClosed)" }` verbatim on
    /// `FakePhoneConformanceTests/testStreamingDeltasReachThePhone_...`. None of this is an Iroh FFI
    /// bug or a WinterKit Swift bug — it is `packages/core`'s dispatch-mode default, out of this
    /// lane's edit scope (`apple/WinterKit/**` only).
    ///
    /// Providing a REAL, resolvable `winter` binary (`WINTER_RUNTIME_EXECUTABLE` pointed at a signed
    /// `dist/winter`) makes 8 of the 13 pass outright (measured: `IrohE2ETests` scenarios B/C's
    /// early phase, `FakePhoneConformanceTests` ×3, `GatewayGateTests` G2/G3/R1/T6b). The remaining
    /// 5 — `GatewayGateTests` G1/R2, `IrohE2ETests` scenarios C/D, `FakePhoneConformanceTests`'s
    /// streaming test — still fail even then, for a SECOND cause layered on the same commit: a
    /// real, credential-less Winter turn synchronously emits `agentError`+`turnCompleted` "noise"
    /// (a model-capability refusal — no reasoning-effort vocabulary on the default dispatch model)
    /// that these tests' strict exact-frame-count assertions were never written to tolerate (they
    /// assumed dispatch-mode's pre-`ed6ebeca` quiet, no-op engine behaviour); the streaming test's
    /// own `agentProvider` injection (this file's `streamingProviderFixture`) is simply never
    /// consulted by the Winter leg at all, so its synthetic chunks never reach the wire (0 of 6).
    /// Both causes live in `packages/core`/the Winter routing behaviour, not here — WAIVED, not
    /// fixed, by Lane K; see the lane report for the full per-test breakdown. A P9 carry: Lane N's
    /// platform-package winter-resolution work (P9a-8/9a-9) would give CI's `swift` job a real
    /// `winter` via `bun install` alone, likely un-skipping the first 8 structurally; the remaining
    /// 5 need a `packages/core` fix (suppress turn-attempt noise for a fresh, credential-less
    /// dispatch-mode session used as a pure event-log seed, and/or restore an Winter-leg-honored
    /// `agentProvider`-equivalent test seam) that is out of WinterKit's scope.
    private static func waitForFirstLine(
        process: Process, stdoutPath: String, stderrPath: String, timeoutSeconds: Double = 20
    ) async throws -> String {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var skipped: [String] = []
        while Date() < deadline {
            if let data = FileManager.default.contents(atPath: stdoutPath),
               let text = String(data: data, encoding: .utf8) {
                // `dropLast()`: splitting "a\nb\n" by "\n" yields ["a", "b", ""] (a trailing empty
                // component after the final newline) — dropping it leaves exactly the COMPLETE
                // lines. Splitting "a\npartial" (no trailing newline yet) yields ["a", "partial"] —
                // dropping the last element correctly excludes the still-being-written partial line
                // too, the same "requires an actual \n" guarantee the original version had.
                let completeLines = text.split(separator: "\n", omittingEmptySubsequences: false).dropLast()
                for substring in completeLines {
                    let candidate = String(substring)
                    guard !candidate.isEmpty else { continue }
                    if let lineData = candidate.data(using: .utf8),
                       (try? JSONDecoder().decode(FixtureOutput.self, from: lineData)) != nil {
                        return candidate // the real hello — every earlier narration line is discarded
                    }
                    if !skipped.contains(candidate) { skipped.append(candidate) }
                }
            }
            if !process.isRunning {
                // Nothing ever decoded as the hello and the process is gone: hand the caller the
                // LAST line it printed (its own JSON decode will fail and wrap this as
                // `.badOutput`, unchanged from before this fix) — or, if it printed no line at
                // all, the original `.processExitedEarly`.
                if let last = skipped.last { return last }
                throw RealDaemonError.processExitedEarly(
                    exitCode: process.terminationStatus,
                    stderr: readAll(stderrPath)
                )
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        let skippedNote = skipped.isEmpty ? "" : "\n(non-hello stdout line(s) seen while waiting: \(skipped.joined(separator: " | ")))"
        throw RealDaemonError.timedOut(stderr: readAll(stderrPath) + skippedNote)
    }

    private static func readAll(_ path: String) -> String {
        guard let data = FileManager.default.contents(atPath: path) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// SIGTERM + wait — the fixture's own handler calls `d.stop()` for a clean socket/lock
    /// release (mirroring the TS `daemon-sigterm` precedent's shutdown path) — then removes the
    /// temp `WINTER_HOME` and the redirected stdout/stderr scratch files. Idempotent: safe to call
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
/// yields a live socket a real `UnixSocketTransport` + `WinterClient.connect(role:)` can hello
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

        let client = WinterClient(
            makeTransport: { UnixSocketTransport(path: daemon.socketPath) },
            token: daemon.harnessToken,
            clientName: "real-daemon-self-test"
        )
        // A successful return IS the hello-succeeded signal (WinterClient.connect's own contract).
        try await client.connect(role: "harness")
        await client.close()

        daemon.stop() // idempotent alongside the `defer` above
        XCTAssertFalse(FileManager.default.fileExists(atPath: daemon.socketPath), "stop() should remove the socket")
    }

    /// A fixture that prints garbage (not the expected JSON) must make `start()` THROW `badOutput`
    /// AND clean up after itself — no leaked subprocess, no stale `/tmp/winter-sp2a-<uuid>` home.
    func testStartCleansUpOnBadOutput() async throws {
        func winterTempDirCount() -> Int {
            let items = (try? FileManager.default.contentsOfDirectory(atPath: "/tmp")) ?? []
            return items.filter { $0.hasPrefix("winter-sp2a-") }.count
        }
        let before = winterTempDirCount()

        do {
            _ = try await RealDaemon.start(fixtureOverride: "process.stdout.write('not-json\\n');")
            XCTFail("start() should have thrown on garbage fixture output")
        } catch let RealDaemonError.badOutput(line) {
            XCTAssertEqual(line, "not-json")
        }
        // Cleanup removes the temp home it created → count returns to baseline (no leak).
        XCTAssertEqual(winterTempDirCount(), before, "start() must remove its temp home on failure")
    }

    /// Winter Phase 8d (P8d-19, whole-branch review / Lane 1's new CI Swift job): reproduces the
    /// exact regression shape SYNTHETICALLY (no real daemon needed) — `startDaemon`'s real boot
    /// narration (`credentials: …`, `runtime-state: runtime recovery: …`, `winter-core … listening
    /// on …`, the 8b credential-material hotfix) lands on stdout BEFORE the fixture's own JSON
    /// hello line, and the pre-fix `waitForFirstLine` trusted the very first line blindly — which
    /// broke `RealDaemonTests`/`GatewayGateTests`/`IrohE2ETests`/`PairingE2ETests`/
    /// `FakePhoneConformanceTests` (~29 tests) the moment that narration shipped. Proves `start()`
    /// skips every non-hello line, in order, and still resolves to the real envelope.
    func testStartSkipsNarrationLinesBeforeTheJSONHello() async throws {
        let fixture = """
        console.log("credentials: openai absent, codex-oauth absent");
        console.log("runtime-state: runtime recovery: ok, 0 session(s), 0 parked, 0 child(ren) interrupted, 0 corrupt");
        console.log("runtime-sdk: directory recovery — 0 entr(ies), 0 stale, 0 cursor(s), 0 held, 0 parked");
        console.log("winter-core 0.2.014 listening on /tmp/does-not-exist/core.sock");
        process.stdout.write(JSON.stringify({ socketPath: "/tmp/winter-p8d19-fake.sock", harness: "h", remote: "r" }) + "\\n");
        """
        let daemon = try await RealDaemon.start(fixtureOverride: fixture)
        defer { daemon.stop() }
        XCTAssertEqual(daemon.socketPath, "/tmp/winter-p8d19-fake.sock")
        XCTAssertEqual(daemon.harnessToken, "h")
        XCTAssertEqual(daemon.remoteToken, "r")
    }
}
