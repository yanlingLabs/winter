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
        profilePath: URL? = OfficeSandboxTests.repoSandboxProfilePath, timeout: TimeInterval = 15.0,
        serviceName: String? = nil
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
        // Fix-round-2 Test A — lets this same driver parameterize `launch-services-query`'s target
        // mach service, reusing all of the process-spawn/pipe/timeout machinery below unchanged.
        if let serviceName { arguments += ["--probe-service-name", serviceName] }

        let process = Process()
        process.executableURL = helperURL
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        // Fix-round-2 (security re-review, Test B investigation) — `/dev/null`, not `Pipe()`: a
        // `Pipe()` nobody reads from is not a real discard, it is a bounded kernel buffer (~64KB)
        // that blocks the CHILD's write() once full, with nothing on this side ever draining it
        // (M5's own already-flagged class of bug — "reads the pipe only after the child exits …
        // would deadlock for any probe that writes more than a pipe buffer"). Empirically hit by
        // `launch-open-unregistered-scheme` (fix round 2's own Test B): `LSOpenCFURLRef` internally
        // triggers an NSXPCConnection error path inside LaunchServices that os_log-errors — and
        // ONLY when this process runs as a child of `xcodebuild test`'s own test host (never when
        // spawned bare, from a shell or a plain compiled binary — both proven instant, same
        // profile, same probe, `sample` confirms 100% of a 3s capture sitting in that single
        // `writev()`) — unified logging mirrors that error to THIS PROCESS's stderr, filling the
        // undrained pipe and wedging the child forever, misreading as a sandbox-caused hang. `/dev/
        // null` has no such buffer: a write to it never blocks, which is what "discard" always
        // meant here — the previous `Pipe()` just didn't deliver it.
        process.standardError = FileHandle.nullDevice
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
    ///
    /// Fix-round-2 N3 (security re-review) — this was, at the time, the ONLY capability-EXISTS-
    /// oriented test in this file: a future, well-intentioned tightening that accidentally dropped
    /// the `launchservicesd` grant entirely would correctly fail HERE as a regression, but nothing
    /// proved what is properly ABSENT elsewhere — so an accidental re-widening back toward the
    /// original four-grant profile had no test to catch it either. `test
    /// LaunchServicesAdjacentEndpointsAreDeniedUnderTheShippedProfile` (below) is this pin's
    /// deliberate DENIAL counterpart, added the same fix round — the two are a matched pair (one
    /// reachability pin, one denial pin), not two unrelated probes; read them together.
    func testLaunchServicesQueryMachLookupIsReachable() async throws {
        let (output, _) = try await runProbe(kind: "launch-services-query")
        XCTAssertTrue(output.contains("PROBE_RESULT: launch-services-query ok"), "got: \(output)")
    }

    /// Fix-round-2 Test A (security re-review) — the DENIAL counterpart to the reachability pin
    /// immediately above (see that test's own N3 paragraph for why this pairing matters). Pins
    /// that the three modern `lsd` sub-endpoints — `com.apple.lsd.openurl`, `com.apple.lsd.mapdb`,
    /// `com.apple.lsd.modifydb` — are all still genuinely DENIED under the shipped, minimized
    /// profile, which grants only the single legacy `com.apple.coreservices.launchservicesd` name
    /// (Experiment C). These three are not arbitrary: `.mapdb`/`.modifydb` are the exact two
    /// endpoints the two REJECTED higher-level LaunchServices API attempts documented in `main.
    /// swift`'s `launch-services-query` case actually touched (proven via `log stream` capture,
    /// fix round 1), and `.openurl` is the modern replacement for the legacy open-by-URL path this
    /// profile's one grant does NOT cover — the specific fact `testUnregisteredURLSchemeOpen
    /// NeverReachesAHandledLaunch` (Test B, below) goes on to verify has a real, request-level
    /// consequence, not just an unreached mach service. Side-effect-free by construction: this
    /// reuses the exact same read-only mach-lookup probe as the reachability pin above (`main.
    /// swift`'s `launch-services-query`, now parameterized via `--probe-service-name`) — no
    /// LaunchServices request is ever sent either way, in any of the three services.
    ///
    /// Asserting `sawConnectionInvalid=true` explicitly, not merely the coarser "denied" label, is
    /// the point — "denied" alone is also satisfied by a 3s timeout with no event at all, a
    /// weaker and less specific signal than an actual `XPC_ERROR_CONNECTION_INVALID`. The
    /// fix-round-2 review named this precisely: the correct "tripwire orientation" for a DENIAL pin
    /// is asserting the denial actually happened, not merely that an "ok" reading did not.
    func testLaunchServicesAdjacentEndpointsAreDeniedUnderTheShippedProfile() async throws {
        for service in ["com.apple.lsd.openurl", "com.apple.lsd.mapdb", "com.apple.lsd.modifydb"] {
            let (output, _) = try await runProbe(kind: "launch-services-query", serviceName: service)
            XCTAssertTrue(output.contains("PROBE_RESULT: launch-services-query denied"),
                          "service=\(service) got: \(output)")
            XCTAssertTrue(output.contains("sawConnectionInvalid=true"),
                          "service=\(service) must be a genuine XPC_ERROR_CONNECTION_INVALID denial, "
                            + "not merely a 3s timeout with no event — got: \(output)")
        }
    }

    /// Fix-round-2 Test B (security re-review) — **"the ship gate."** Companion to `main.swift`'s
    /// `launch-open-unregistered-scheme` probe kind (see that case's own doc comment for the full
    /// discriminator rationale) — this is the test that actually decides whether the one surviving
    /// grant (`com.apple.coreservices.launchservicesd`, Experiment C) is safe to ship. Runs WITH
    /// the real shipped profile AND WITHOUT the grant (a scratch copy of the shipped profile with
    /// only that one `(global-name ...)` line removed) so the WITH-grant reading is checked against
    /// a control, not read in isolation — the same with/without shape `testSandboxDisabledEscape
    /// HatchActuallyDisablesTheFenceAndDefaultDoesNot` already establishes above for the write
    /// fence.
    ///
    /// **The real reading, verified empirically, is `-10661` (`kLSExecutableIncorrectFormat`), not
    /// the `-10822` (`kLSServerCommunicationErr`) this test originally asserted before it was
    /// actually run against the real binary.** Caught and corrected in place rather than left
    /// silently wrong — see `task-10-report.md`'s fix-round-2 section for the full account,
    /// including a live-caught, unrelated test-infrastructure bug this investigation surfaced along
    /// the way (`runProbe`'s `stderr = Pipe()` deadlocking specifically under `xcodebuild test`'s
    /// own environment, fixed below in `runProbe` itself — this test's own first XCTest run hung
    /// for that reason, not a sandbox one; six direct, non-XCTest-hosted spawns had already shown
    /// the true, fast, -10661 reading before that infrastructure bug was even found).
    ///
    /// **Fix-round-3 (convergence re-review) — the mechanism this comment gave for -10661 was
    /// FALSIFIED, not merely unhedged; see `main.swift`'s own `launch-open-unregistered-scheme` case
    /// for the full, corrected account (the re-review's own 9 cells: 5 sandboxed -10661 / 4
    /// unsandboxed -10814 on the PRODUCTION bundled+embedded shape; `_LSAgentGetConnection` dying on
    /// denied `lsd.mapdb`/`.modifydb`/quarantine-resolution, before handler resolution; the
    /// scratch-profile flip; the grant-removal null result).** This test's own -10661 finding (WITH
    /// and WITHOUT the grant, identical) is real and still stands, but "the client-side rejection
    /// happens before ever needing to ask `lsd`" was wrong — it is the SANDBOX denying specific
    /// `lsd.*`/quarantine-resolution endpoints, not a local pre-`lsd` LaunchServices decision. This
    /// test also does not cover the production BUNDLED shape (`resolvedHelperURL()` spawns a bare
    /// `BUILT_PRODUCTS_DIR` executable) — the re-review ran that shape directly and it matched; a
    /// coverage note, not a defect. `testLaunchServicesAdjacentEndpointsAreDeniedUnderTheShippedProfile`
    /// (Test A, above) is now the LOAD-BEARING containment pin for this open path (see `main.swift`'s
    /// own comment for the precise, partial-coverage statement of what it does and does not pin) —
    /// any future widening of `com.apple.lsd.mapdb`/`.modifydb`, or a quarantine-resolution-adjacent
    /// service, is a SHIP-BLOCKER-CLASS change here, not a routine one. The REGISTERED/handled URL
    /// type follow-up this comment previously left fully open is now LARGELY CLOSED BY MECHANISM
    /// (again, see `main.swift`) — a mechanism-backed inference from the re-review's own cells, not a
    /// run cell of its own; the side-effecting stronger test itself was still never run.
    func testUnregisteredURLSchemeOpenNeverReachesAHandledLaunch() async throws {
        let (withGrantOutput, _) = try await runProbe(kind: "launch-open-unregistered-scheme")
        let withGrantStatus = try Self.extractProbeStatus(from: withGrantOutput)

        let shippedSource = try String(contentsOf: Self.repoSandboxProfilePath, encoding: .utf8)
        let grantLine = "  (global-name \"com.apple.coreservices.launchservicesd\")\n"
        XCTAssertTrue(shippedSource.contains(grantLine),
                      "sanity: the exact grant line this control removes must be present verbatim "
                        + "in the shipped profile, or this control is not testing what it claims to")
        let withoutGrantSource = shippedSource.replacingOccurrences(of: grantLine, with: "")
        let scratchProfile = makeScratchDirectory().appendingPathComponent("without-launchservicesd.sb")
        try withoutGrantSource.write(to: scratchProfile, atomically: true, encoding: .utf8)
        let (withoutGrantOutput, _) = try await runProbe(
            kind: "launch-open-unregistered-scheme", profilePath: scratchProfile)
        let withoutGrantStatus = try Self.extractProbeStatus(from: withoutGrantOutput)

        // THE SHIP GATE ITSELF. -10814 (kLSApplicationNotFoundErr) would mean LaunchServices
        // actually SERVICED this request — see the probe's own comment in main.swift for the full
        // consequence: a registered/handled URL type would, by that same code path, have gone on
        // to resolve a real handler and launch it, meaning this profile's one surviving grant makes
        // the whole-branch review's confused-deputy concern real, not merely theoretical.
        XCTAssertNotEqual(withGrantStatus, -10814,
            "kLSApplicationNotFoundErr — the request WAS serviced. SHIP BLOCKER per fix-round-2 "
                + "Test B's own mandate (task-10-report.md) — got \(withGrantOutput)")
        // The actual, repeatedly-verified reading (7 total observations across this investigation:
        // 6 direct spawns + this XCTest run, all identical) — pinned to the SPECIFIC code, not a
        // vague "any non-10814 failure counts," matching this file's own established preference
        // (see `testOutboundConnectIsDenied`'s own comment) for a precise, falsifiable value over a
        // loose category that could stay green for the wrong reason.
        XCTAssertEqual(withGrantStatus, -10661,
            "expected kLSExecutableIncorrectFormat (-10661) under the shipped profile — got "
                + "\(withGrantStatus); \(withGrantOutput)")

        // Control: removing a grant can only ever narrow what SBPL permits, never newly enable a
        // serviced request the WITH-grant run did not already produce (the same allow-rule
        // monotonicity the fix-round-2 review's own "airtight" verdict rests on) — so this must
        // also never be -10814, regardless of its exact value otherwise.
        XCTAssertNotEqual(withoutGrantStatus, -10814, "got: \(withoutGrantOutput)")
        // Disclosed, not concealed: this specific probe shape reads IDENTICALLY with and without
        // the grant. Fix round 2 read that as "the rejection happens before LaunchServices' client
        // code ever needs to consult `lsd`" — fix-round-3 (convergence re-review) FALSIFIED that
        // reading: the re-review's own cells show `lsd` IS consulted either way (`_LSAgentGetConnection`
        // runs regardless), and the identical reading instead reflects that
        // `com.apple.coreservices.launchservicesd` (the one grant this control toggles) was never the
        // relevant grant for THIS open path — the endpoints that actually gate it
        // (`lsd.mapdb`/`.modifydb`/quarantine-resolution) are absent from BOTH configurations this
        // control compares, so toggling a THIRD, irrelevant grant was never going to move this
        // reading. Not evidence the grant is a no-op in general — see this test's own doc comment
        // above, and `main.swift`'s own comment, for the corrected account and what it does and does
        // not establish.
        XCTAssertEqual(withGrantStatus, withoutGrantStatus,
            "if these ever diverge, this probe shape IS discriminating on the grant after all and "
                + "the doc comment above needs updating — with=\(withGrantOutput) without=\(withoutGrantOutput)")
    }

    /// Parses the `status=<n>` token `launch-open-unregistered-scheme` prints — a plain integer
    /// `OSStatus`, never string-matched against named constants, so a comparison against
    /// `-10814`/`-10661` above is exact rather than substring-fragile. Splits on whitespace (the
    /// `PROBE_RESULT:` line format throughout this probe family is space-separated `key=value`
    /// tokens) rather than scanning characters directly, to keep this simple to read correctly.
    private static func extractProbeStatus(from output: String) throws -> Int32 {
        for token in output.split(separator: " ") where token.hasPrefix("status=") {
            if let value = Int32(token.dropFirst("status=".count)) { return value }
        }
        throw NSError(domain: "OfficeSandboxTests", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "could not parse status= from probe output: \(output)"])
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
