import XCTest
@testable import Norma
#if canImport(Darwin)
import Darwin
#endif

/// Office Stage B Task 1 — the seatbelt. Spawns the REAL, compiled `NormaOfficeHelper` binary
/// directly (same "drive the real process, not a double" posture `OfficeHelperLiveTests` already
/// established) but stays focused on sandbox-specific probes that do NOT need LibreOfficeKit or the
/// vendor tree at all — `main.swift` applies and self-asserts the sandbox BEFORE ever resolving the
/// LOK install root, so every test in this file runs fast and unconditionally (no
/// `skipUnlessVendorPresent()` gate anywhere here). The six-format-sandboxed-render proof and the
/// lock-file probe DO need LOK and live in `OfficeHelperLiveTests` instead, per the brief's own file
/// split — this file is "does the fence itself hold," that file is "does the helper still do real
/// work behind it."
final class OfficeSandboxTests: XCTestCase {
    private var scratchDirs: [URL] = []
    private var runningProcesses: [Process] = []

    override func tearDown() {
        for process in runningProcesses where process.isRunning { process.terminate() }
        runningProcesses = []
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/officesandbox-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    // MARK: - Repo-relative paths (same `#filePath`-climbing precedent as `OfficeHelperLiveTests`)

    /// `#filePath` for this file is `<repoRoot>/apple/Norma/Tests/NormaAppTests/OfficeSandboxTests.swift`
    /// — the identical nesting depth `OfficeHelperLiveTests.repoRoot` climbs from, duplicated here
    /// rather than shared: this codebase's own precedent (`CliLauncher.defaultRepoRoot` alongside
    /// `OfficeHelperLiveTests.repoRoot`) is a small per-file climb, not a shared test-utility file.
    private static var repoRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url
    }
    private static var repoSandboxProfilePath: URL {
        repoRoot.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
    }

    private func resolvedHelperURL() throws -> URL {
        let url = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: url.path),
                      "NormaOfficeHelper was not built into this run (\(url.path)) — add it to the "
                        + "scheme's build list and re-run.")
        return url
    }

    // MARK: - Probe driver

    /// Spawns the real helper in `--sandbox-probe` mode, waits for it to exit (probe mode never
    /// binds a socket or touches LOK — it applies the sandbox, attempts one operation, prints one
    /// `PROBE_RESULT:` line, and `_exit(0)`s, so this is fast: no cold-LOK-boot budget needed), and
    /// returns its captured stdout. `Pipe` + `waitUntilExit()` + `readDataToEndOfFile()` — safe
    /// specifically BECAUSE the process is already confirmed exited by the time stdout is drained
    /// (the same precedent `buildSpike()`/`runSpikeAndHashRaw()` in `OfficeHelperLiveTests` already
    /// use for a short-lived helper process, avoiding the blocking-pipe-read-while-still-running
    /// deadlock class this repo's own comments call out elsewhere for LONG-lived processes).
    @discardableResult
    private func runProbe(
        kind: String, noSandbox: Bool = false, outsideDir: URL? = nil,
        profilePath: URL? = OfficeSandboxTests.repoSandboxProfilePath, timeout: TimeInterval = 15.0
    ) async throws -> (stdout: String, exitCode: Int32) {
        let helperURL = try resolvedHelperURL()
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        var arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                          "--token", "officesandbox-\(UUID().uuidString.prefix(8))",
                          "--sandbox-probe", kind]
        if let profilePath { arguments += ["--sandbox-profile", profilePath.path] }
        if noSandbox { arguments.append("--no-sandbox") }
        if let outsideDir { arguments += ["--probe-outside-dir", outsideDir.path] }

        let process = Process()
        process.executableURL = helperURL
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe() // discard — keeps the log focused on PROBE_RESULT lines
        try process.run()
        runningProcesses.append(process)

        let exited = await waitUntil(timeout: timeout) { !process.isRunning }
        guard exited else {
            XCTFail("probe process (kind=\(kind)) did not exit within \(timeout)s")
            process.terminate()
            return ("", -1)
        }
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (output, process.terminationStatus)
    }

    // MARK: - Two-sided sandbox_check pin
    //
    // "Do not trust a remembered value for sandbox_check's type/flag constant: pin it with a
    // two-sided probe" (this task's own methodology) — proven here BEHAVIORALLY, not by trusting a
    // self-reported log line: the SAME write-outside-fence probe must be denied when the profile is
    // applied and must succeed when `--no-sandbox` explicitly bypasses it. This is the load-bearing
    // regression tripwire for `sandboxDisabledForDebugHarness`/`sandbox_check` both being wired
    // correctly, from the outside, against the real compiled binary.
    func testSandboxDisabledEscapeHatchActuallyDisablesTheFenceAndDefaultDoesNot() async throws {
        let outsideDefault = makeScratchDirectory()
        let (defaultOut, _) = try await runProbe(kind: "write-outside-fence", noSandbox: false, outsideDir: outsideDefault)
        XCTAssertTrue(defaultOut.contains("PROBE_RESULT: write-outside-fence denied"),
                      "default (no --no-sandbox) must be sandboxed — got: \(defaultOut)")

        let outsideEscape = makeScratchDirectory()
        let (escapeOut, _) = try await runProbe(kind: "write-outside-fence", noSandbox: true, outsideDir: outsideEscape)
        XCTAssertTrue(escapeOut.contains("PROBE_RESULT: write-outside-fence ok"),
                      "--no-sandbox must actually disable the fence — got: \(escapeOut)")
    }

    // MARK: - Write fence

    func testOutOfFenceWriteIsDenied() async throws {
        let outsideDir = makeScratchDirectory()
        let (output, _) = try await runProbe(kind: "write-outside-fence", outsideDir: outsideDir)
        XCTAssertTrue(output.contains("PROBE_RESULT: write-outside-fence denied"), "got: \(output)")
        let siblings = (try? FileManager.default.contentsOfDirectory(atPath: outsideDir.path)) ?? []
        XCTAssertTrue(siblings.isEmpty, "the denied write must not have left a file behind: \(siblings)")
    }

    /// The sanity control for the test above: a write UNDER `--state-path` (where the fence's own
    /// `(subpath (param "STATE_PATH"))` rule allows it) must still succeed — proving `deny default`
    /// is not accidentally denying EVERYTHING, which would make the out-of-fence test above pass
    /// for the wrong reason.
    func testInFenceWriteSucceeds() async throws {
        let (output, _) = try await runProbe(kind: "write-inside-fence")
        XCTAssertTrue(output.contains("PROBE_RESULT: write-inside-fence ok"), "got: \(output)")
    }

    // MARK: - Network fence

    /// Fix round 1 (task review, Important): asserting only `rc != 0` (any failure counts as
    /// "denied") is not the same claim as "the SANDBOX denied this" — an offline machine (no route
    /// to 1.1.1.1) can fail `connect()` with `ENETDOWN`/`EHOSTUNREACH` from the network stack
    /// itself, before the sandbox's own check ever runs, and the probe's "ok"/"denied" label would
    /// still read "denied" either way. This repo runs Wi-Fi-off drills routinely (CLAUDE.md's own
    /// "never launch the dist app" hard-rule neighbors several test-isolation notes in this same
    /// vein) — a green run here must mean "the fence denied it," not "the network happened to be
    /// unreachable for an unrelated reason," or this test could stay green with a completely broken
    /// `(deny network*)` rule. `EPERM` is the specific errno a real sandbox denial produces here —
    /// measured directly (main.swift's own header / task-1-report.md: a standalone C harness under
    /// this exact profile shape) — so asserting the FULL `"denied errno=\(EPERM)"` string, not just
    /// `"denied"`, is what makes this test fail on a broken fence even on a machine where the
    /// underlying network happens to be down for an unrelated reason too.
    func testOutboundConnectIsDenied() async throws {
        let (output, _) = try await runProbe(kind: "connect-outbound")
        XCTAssertTrue(output.contains("PROBE_RESULT: connect-outbound denied errno=\(EPERM)"), "got: \(output)")
    }

    /// Fix-round Experiment C (whole-branch review) — the ONE mach-lookup this profile grants
    /// beyond T1's original baseline, and the one the review's own rationale flagged as the
    /// scarier of the four originally-widened candidates (a potential `(deny process-exec)`/
    /// `(deny network*)` bypass via a confused-deputy launch request, not merely data exfiltration).
    /// Against the REAL, shipped profile (this test's own default `profilePath`), the mach-lookup
    /// must be genuinely reachable — proving the office-helper.sb comment's own claim empirically,
    /// the same "do not trust a remembered value, pin it behaviorally" methodology this file's own
    /// two-sided `sandbox_check` pin above already established. The reverse case (denied without
    /// this grant) was proven interactively during this fix round's own minimization — not
    /// re-pinned here as a second fixture file, to avoid a second, driftable copy of "what T1's
    /// baseline alone looks like" existing in this repo.
    func testLaunchServicesQueryMachLookupIsReachable() async throws {
        let (output, _) = try await runProbe(kind: "launch-services-query")
        XCTAssertTrue(output.contains("PROBE_RESULT: launch-services-query ok"), "got: \(output)")
    }

    /// M4 (whole-branch review) — the profile's own core containment posture, pinned against the
    /// SOURCE file directly (never the embedded copy: the release pipeline's own `codesign --verify
    /// --deep --strict` already covers embed-time integrity — see `scripts/release.ts`'s office-
    /// helper.sb existence check and its own comment for why that is a byte-copy guarantee, not
    /// something this test needs to re-prove). A future edit that accidentally loosens either line
    /// fails here first, not in a live probe run.
    func testDenyDefaultAndDenyNetworkArePresentInTheSourceProfile() throws {
        let source = try String(contentsOf: Self.repoSandboxProfilePath, encoding: .utf8)
        XCTAssertTrue(source.contains("(deny default)"), "the profile's own default-deny posture is missing")
        XCTAssertTrue(source.contains("(deny network*)"), "the profile's own explicit network denial is missing")
    }

    // MARK: - Fail-closed: a missing/unreadable profile refuses to serve, in EITHER config
    //
    // Advisor-suggested cheap drill: exercises the fail-closed branch (`fail(...)` on an unreadable
    // profile) without needing a Release build — this runs BEFORE `resolveInstallRoot`/`LOKBridge`
    // in main.swift's own boot sequence, so it needs neither the vendor tree nor `--lok-root`. The
    // helper must never create its socket file — the process dies from `fail()`'s own `_exit(1)`
    // before `OfficeHelperServer.start()` is ever reached.
    func testHelperRefusesToBootWhenSandboxProfileIsMissing() async throws {
        let helperURL = try resolvedHelperURL()
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        let missingProfile = stateDir.appendingPathComponent("does-not-exist.sb")
        XCTAssertFalse(FileManager.default.fileExists(atPath: missingProfile.path), "sanity: must not exist")

        let process = Process()
        process.executableURL = helperURL
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", "officesandbox-\(UUID().uuidString.prefix(8))",
                              "--sandbox-profile", missingProfile.path]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        try process.run()
        runningProcesses.append(process)

        let exited = await waitUntil(timeout: 10.0) { !process.isRunning }
        XCTAssertTrue(exited, "a helper with no readable sandbox profile must exit promptly, not hang")
        XCTAssertEqual(process.terminationStatus, 1, "fail() exits 1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath),
                        "the helper must never have reached OfficeHelperServer.start() — no socket file may appear")
    }
}
