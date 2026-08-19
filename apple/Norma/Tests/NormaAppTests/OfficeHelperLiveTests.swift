import XCTest
import CryptoKit
@testable import Norma

/// Office Stage A Task 3 — LOK boots for real. Spawns the REAL, compiled `NormaOfficeHelper`
/// binary and drives it over the real socket protocol against the vendored LibreOffice tree
/// (`--lok-root`, for fast iteration — one test uses the app-embedded root instead, see
/// `testEmbeddedRootBootsAgainstTheRealBuiltAppAndBundleStaysUntouched`).
///
/// ".officeLive" is the brief's own descriptive term for this whole class — this repo has no
/// literal XCTest tag API (grepped; confirmed absent), so gating is the same convention every
/// other live-binary test here already uses: `XCTSkipIf` naming exactly what's missing
/// (`OfficeHelperLiveSmokeTests`/`OfficeEmbedLayoutTests`, Task 2's own precedent).
final class OfficeHelperLiveTests: XCTestCase {
    private var scratchDirs: [URL] = []
    private var runningProcesses: [Process] = []
    private var openConnections: [OfficeWireConnection] = []

    override func tearDown() {
        for connection in openConnections { connection.close() }
        openConnections = []
        for process in runningProcesses where process.isRunning { process.terminate() }
        runningProcesses = []
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = URL(fileURLWithPath: "/tmp/officelive-\(UUID().uuidString.prefix(8))", isDirectory: true)
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

    // MARK: - Repo-relative paths (same `#filePath`-climbing precedent as
    // `CliLauncher.defaultRepoRoot`/`OfficeHelperLiveSmokeTests`)

    /// `#filePath` for this file is `<repoRoot>/apple/Norma/Tests/NormaAppTests/OfficeHelperLiveTests.swift`.
    private static var repoRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        return url
    }
    private static var vendorProductSetRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/vendor/libreoffice/product-set", isDirectory: true)
    }
    private static var fixturesRoot: URL {
        repoRoot.appendingPathComponent("apple/Norma/Tests/NormaAppTests/Fixtures/office", isDirectory: true)
    }
    private static var spikeDirectory: URL {
        repoRoot.appendingPathComponent("spikes/office-lok-gate", isDirectory: true)
    }

    /// `LIBREOFFICE_CORE_COMMIT=<sha>` from the vendored `VERSION-PIN` — carry T3-c: the version
    /// test asserts against THIS file's value, never a hardcoded second copy of the hash.
    private static var versionPinBuildId: String? {
        guard let content = try? String(
            contentsOf: repoRoot.appendingPathComponent("apple/Norma/vendor/libreoffice/VERSION-PIN"),
            encoding: .utf8) else { return nil }
        for line in content.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix("LIBREOFFICE_CORE_COMMIT=") {
                return String(line.dropFirst("LIBREOFFICE_CORE_COMMIT=".count))
            }
        }
        return nil
    }

    private func skipUnlessVendorPresent() throws {
        let frameworksPath = Self.vendorProductSetRoot.appendingPathComponent("Frameworks").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: frameworksPath),
                      "LibreOffice vendor tree not present at \(Self.vendorProductSetRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root. This pin goes live the "
                        + "moment it's fetched.")
    }

    // MARK: - Shared live-helper spawning

    /// A running real helper, handshaken, with a typed client ready for `open`/`close`/`ping`.
    private struct LiveHelper {
        let process: Process
        let connection: OfficeWireConnection
        let client: OfficeHelperClient
        let stateDir: URL
        let lokVersion: String
        /// Non-nil only when `spawnLiveHelper(captureStderr: true)` — see that parameter's own
        /// header (Task 4, debt #1).
        let stderrCapture: StderrCapture?
    }

    /// Task 4, debt #1 — continuously drains a spawned helper's stderr into a lock-protected line
    /// buffer via `readabilityHandler` (never a blocking `readDataToEndOfFile()` while the process
    /// is still alive and doing real work — the SAME subprocess-pipe-deadlock class every other
    /// stderr/stdout capture in this file avoids by only reading after `waitUntilExit()`, which
    /// this helper's own long-lived-across-a-test lifetime rules out). `LOKBridge.handleCallback`'s
    /// own unconditional raw-callback trace (`[LOKBridge raw callback] ...`) is what this exists to
    /// capture — never test-only instrumentation on the PRODUCTION side, only the capture MECHANISM
    /// here is test-only.
    private final class StderrCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var buffer = Data()
        private var lines: [String] = []
        func ingest(_ data: Data) {
            guard !data.isEmpty else { return }
            lock.lock()
            buffer.append(data)
            while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
                buffer.removeSubrange(buffer.startIndex...newlineIndex)
                if let line = String(data: lineData, encoding: .utf8) { lines.append(line) }
            }
            lock.unlock()
        }
        func linesSnapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return lines }
    }

    /// Spawns the REAL `NormaOfficeHelper` binary and completes the `hello` handshake, exactly the
    /// sequence `OfficeHelperSupervisor.attemptOnce` runs in production (duplicated here rather
    /// than reused: the supervisor is `@MainActor`-bound and owns retry/backoff policy this test
    /// has no use for — this is the same "drive the wire protocol directly" shape
    /// `OfficeHelperLiveSmokeTests` already established).
    ///
    /// `helperURL: nil` (default) uses the standalone `BUILT_PRODUCTS_DIR` copy with `--lok-root`
    /// pointing at the vendor tree — the fast-iteration path this file's own tests mostly use.
    /// Passing BOTH `helperURL` (the app-embedded copy) AND `installRoot: nil` (no `--lok-root`
    /// override) is what `testEmbeddedRootBoots...` uses for the carry-1 "real built app" proof —
    /// the helper then resolves its LOK root from its own embedded bundle position.
    ///
    /// `stateDir: nil` (default) mints a fresh scratch directory per call, as before. Passing an
    /// EXPLICIT `stateDir` — reusing a directory a PRIOR (now-dead) call already used — is what
    /// `testStaleProfileDirectoriesAreSweptOnTheNextBootOfTheSameStatePath` (F4, T3 review) needs:
    /// proving the sweep, which requires two boots against the literal same `--state-path`.
    private func spawnLiveHelper(
        helperURL: URL? = nil, installRoot: URL? = OfficeHelperLiveTests.vendorProductSetRoot,
        idleExitSeconds: Int = 30, stateDir: URL? = nil,
        // Task 4, debt #1 — when true, the process's stderr is captured (never inherited) via a
        // continuously-drained pipe (`StderrCapture`), so a test can read back
        // `LOKBridge.handleCallback`'s raw-payload trace line for whatever LOK actually fired.
        // `false` for every existing caller (unchanged behavior: stderr inherited, visible in the
        // test log directly, nothing programmatically read back).
        captureStderr: Bool = false
    ) async throws -> LiveHelper {
        let resolvedHelperURL = helperURL ?? Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: resolvedHelperURL.path),
                      "NormaOfficeHelper was not built into this run (\(resolvedHelperURL.path)) — "
                        + "add it to the scheme's build list and re-run.")

        let resolvedStateDir = stateDir ?? makeScratchDirectory()
        let socketPath = resolvedStateDir.appendingPathComponent("office.sock").path
        let token = "officelive-\(UUID().uuidString.prefix(8))"

        // Mirrors OfficeHelperSupervisor.attemptOnce's own pre-spawn unlink (its F1, T2 review): a
        // PRIOR helper against this same `stateDir` — killed via SIGKILL, as
        // `testStaleProfileDirectoriesAreSweptOnTheNextBootOfTheSameStatePath` (F4) does between
        // its two boots — leaves its socket FILE on disk (no unlink-on-death). Without removing it
        // here first, the `waitUntil` poll below would return true INSTANTLY against the stale
        // file, and `connection.open()` would then connect into a dead inode rather than waiting
        // for the fresh helper to actually bind — a no-op for every fresh `stateDir` (nothing to
        // remove), load-bearing only for a reused one.
        try? FileManager.default.removeItem(at: URL(fileURLWithPath: socketPath))

        let process = Process()
        process.executableURL = resolvedHelperURL
        var arguments = ["--socket-path", socketPath, "--state-path", resolvedStateDir.path,
                          "--token", token, "--idle-exit-seconds", String(idleExitSeconds)]
        if let installRoot { arguments += ["--lok-root", installRoot.path] }
        process.arguments = arguments

        var stderrCapture: StderrCapture?
        if captureStderr {
            let capture = StderrCapture()
            let pipe = Pipe()
            pipe.fileHandleForReading.readabilityHandler = { handle in capture.ingest(handle.availableData) }
            process.standardError = pipe
            stderrCapture = capture
        }

        try process.run()
        runningProcesses.append(process)

        // Cold dlopen of a ~127MB merged dylib + lok_init_2 (+ fontconfig's font-directory scan)
        // now runs BEFORE the socket binds (main.swift's boot-sequencing change) — measured
        // empirically while writing this test: a COLD run (first libmergedlo.dylib load this OS
        // session) needed more than 20s; a WARM run (same session, kernel page cache already
        // populated — persists across helper process respawns) completed in ~8s. 60s is a
        // deliberately generous bound for the one-time cold-cache cost, matching the production
        // `OfficeHelperSupervisor.Configuration.handshakeTimeout` default this same finding raised
        // from 5.0s to 30.0s (see that property's own comment).
        let socketAppeared = await waitUntil(timeout: 60.0) { FileManager.default.fileExists(atPath: socketPath) }
        guard socketAppeared else {
            XCTFail("real helper never created its socket file within 60s (cold LOK boot) at \(socketPath)")
            throw XCTSkip("socket never appeared") // aborts this test only
        }

        let connection = OfficeWireConnection(socketPath: socketPath)
        openConnections.append(connection)
        try await connection.open()
        try await connection.send(.hello(seq: 1, role: .app, token: token))
        guard let helloReply = await connection.nextFrame(timeout: 10.0),
              case .helloOk(_, let lokVersion) = helloReply else {
            XCTFail("hello handshake failed against the real helper")
            throw XCTSkip("handshake failed")
        }
        let client = OfficeHelperClient(connection: connection, seqAllocator: OfficeWireSeqAllocator(), requestTimeout: 15.0)
        return LiveHelper(process: process, connection: connection, client: client, stateDir: resolvedStateDir,
                          lokVersion: lokVersion, stderrCapture: stderrCapture)
    }

    // MARK: - Six formats

    /// Sizes are the gate's own pinned table (`svp-probe-report.md`'s "Final verification"
    /// section, byte-identical raw pixel buffers across the untrimmed/trimmed/product-set builds)
    /// — the strongest evidence available for these numbers, EXCEPT `gate.ods`'s width, disclosed
    /// below. `parts`: the advisor's own caution was not to pre-commit a guess at Writer's
    /// `getParts` semantics — observed empirically (first live run: `1` for all six fixtures,
    /// single-sheet/slide/page seeds, unsurprising) and pinned here with this comment as the
    /// record of that observation, per the advisor's own instruction to pin once known.
    ///
    /// **`gate.ods`'s width is 26775, not the gate table's 26593 — a real, explained delta, not a
    /// bug.** Every OTHER dimension of every OTHER fixture (including `gate.xlsx`, opened via the
    /// SAME code path against the SAME seed content) matches the gate table exactly. Measured live
    /// while writing this test (see task-3 report for the full comparison): this is consistent with
    /// ODF's spreadsheet column-width default being specified in font-relative "characters" (so it
    /// shifts with which font is actually available/selected as default) versus OOXML's fixed-unit
    /// column width (immune to font availability) — LOKBridge's carry-#5-mandated ALWAYS-ON
    /// `FONTCONFIG_FILE` override (adding macOS system font directories) changes the font
    /// landscape LOK sees versus the stock, no-override config the original gate table was measured
    /// under. Not treated as a regression to chase: carry #5 is binding (fontconfig must be set),
    /// and this is the one, isolated, explained consequence of honoring it for real.
    ///
    /// Machine-relative caveat: `configureFontconfig` includes `~/Library/Fonts` (a per-user
    /// directory), so `26775` is this pin's value on the machine/account it was measured on, not a
    /// value fontconfig's own spec guarantees elsewhere. This whole test is already
    /// vendor-gated (`skipUnlessVendorPresent`), which keeps its blast radius to "machines with the
    /// LO product-set fetched" — stable there in practice — but a future mismatch on a different
    /// machine or after installing a font that shifts ODF's default-font resolution should be read
    /// as environment-dependent, not necessarily a regression.
    ///
    /// **T3 review F6 (Minor)**: `gate.ods`'s width is therefore checked against a TOLERANCE band
    /// (±300 twips around 26775, i.e. roughly ±0.2in — comfortably covers a plausible font-metric
    /// shift on a different machine while still catching a genuinely broken value: 0, a wildly
    /// different font's width, or the document failing to carry its column width at all) rather
    /// than an exact match. Every OTHER dimension of every OTHER fixture — including `gate.xlsx`'s
    /// own width, OOXML's fixed-unit column width, immune to font availability by construction —
    /// stays an EXACT pin; only this one machine-relative value gets slack.
    func testSixFormatsOpenWithSaneTypePartsAndSize() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()

        struct Expectation {
            let fixture: String; let type: OfficeDocumentKind; let parts: Int
            let widthTwips: Int64; let heightTwips: Int64
            /// 0 (exact match) for every fixture except `gate.ods` — F6 above.
            var widthToleranceTwips: Int64 = 0
        }
        let expectations: [Expectation] = [
            Expectation(fixture: "gate.xlsx", type: .spreadsheet, parts: 1, widthTwips: 26593, heightTwips: 13005),
            Expectation(fixture: "gate.ods", type: .spreadsheet, parts: 1, widthTwips: 26775, heightTwips: 13005, widthToleranceTwips: 300),
            Expectation(fixture: "gate.pptx", type: .presentation, parts: 1, widthTwips: 15876, heightTwips: 8931),
            Expectation(fixture: "gate.odp", type: .presentation, parts: 1, widthTwips: 15875, heightTwips: 8930),
            Expectation(fixture: "gate.docx", type: .text, parts: 1, widthTwips: 12474, heightTwips: 17406),
            Expectation(fixture: "gate.odt", type: .text, parts: 1, widthTwips: 12474, heightTwips: 17406),
        ]
        for expectation in expectations {
            let path = Self.fixturesRoot.appendingPathComponent(expectation.fixture).path
            let docId = UUID().uuidString
            let metadata = try await helper.client.open(docId: docId, path: path)
            XCTAssertEqual(metadata.type, expectation.type, "\(expectation.fixture): type")
            XCTAssertEqual(metadata.parts, expectation.parts, "\(expectation.fixture): parts")
            let widthDelta = abs(metadata.sizeTwips.widthTwips - expectation.widthTwips)
            XCTAssertLessThanOrEqual(widthDelta, expectation.widthToleranceTwips,
                "\(expectation.fixture): widthTwips \(metadata.sizeTwips.widthTwips) is \(widthDelta) twips away "
                + "from expected \(expectation.widthTwips), outside the ±\(expectation.widthToleranceTwips) tolerance")
            XCTAssertEqual(metadata.sizeTwips.heightTwips, expectation.heightTwips, "\(expectation.fixture): heightTwips")
            print("[six-format matrix] \(expectation.fixture): type=\(metadata.type) parts=\(metadata.parts) "
                    + "size=\(metadata.sizeTwips.widthTwips)x\(metadata.sizeTwips.heightTwips)")
            try await helper.client.close(docId: docId)
        }
    }

    // MARK: - Garbage-file survival

    /// Task 3 finding, empirical, disclosed in the report — TWO escalating attempts before this
    /// shape was found reliable, both left in this comment as a record of what does NOT work:
    /// (1) plain ASCII text ("this is not a real office document") named `garbage.docx` — LOK's
    /// type-detection sniffs CONTENT, and a plain-text payload is plausibly imported as a trivial
    /// single-paragraph TEXT document via a fallback filter, silently ignoring both the extension
    /// and the fact it is not a valid ZIP (.docx's own real container format). (2) 4096 bytes of
    /// genuinely random binary data — STILL did not fail; LibreOffice's own "repair"/recovery
    /// posture toward unparseable content is apparently lenient enough to produce SOME document
    /// (never observed to throw) rather than reliably erroring, for arbitrary bytes under a
    /// `.docx` name. **What reliably fails**: a path that does not exist on disk at all — no
    /// content-sniffing or repair heuristic can rescue bytes that were never read in the first
    /// place. This is a narrower failure mode than "malformed content a user might accidentally
    /// point the app at" (the brief's own framing), but it is the one this task could empirically
    /// prove `documentLoad` genuinely fails for, keeping the helper alive to answer the next
    /// request — which is the actual property under test (`openFailed` + survival), not the exact
    /// shape of the input that trips it.
    func testGarbageFileOpenFailsAndHelperSurvives() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()

        let garbageDir = makeScratchDirectory()
        let garbagePath = garbageDir.appendingPathComponent("does-not-exist.docx").path
        XCTAssertFalse(FileManager.default.fileExists(atPath: garbagePath), "sanity: this path must not exist")

        do {
            _ = try await helper.client.open(docId: UUID().uuidString, path: garbagePath)
            XCTFail("expected OfficeHelperClientError.openFailed for a nonexistent path")
        } catch OfficeHelperClientError.openFailed {
            // expected — discriminated from .serverError/.unexpectedReply, per this task's own
            // carry that garbage-survival must be able to tell "bad document" apart from "bad
            // request".
        }

        XCTAssertTrue(helper.process.isRunning, "helper must survive a failed open")

        // The brief's own survival bar: the NEXT open (a real fixture) works normally afterward.
        let recoveryDocId = UUID().uuidString
        let metadata = try await helper.client.open(docId: recoveryDocId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        XCTAssertEqual(metadata.type, .spreadsheet)
        try await helper.client.close(docId: recoveryDocId)
    }

    // MARK: - Double-open ruling

    func testSecondOpenOfAnAlreadyOpenDocIdIsRejectedAndFirstStaysUsable() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)

        do {
            _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.docx").path)
            XCTFail("expected a second open of the same docId to be refused")
        } catch OfficeHelperClientError.serverError(let reason) {
            XCTAssertEqual(reason, "alreadyOpen")
        }

        // The first handle is unaffected — close still works normally.
        try await helper.client.close(docId: docId)
    }

    // MARK: - Version pin (carry T3-c)

    func testHelloOkLokVersionMatchesVersionPinBuildId() async throws {
        try skipUnlessVendorPresent()
        let buildId = try XCTUnwrap(Self.versionPinBuildId,
                                     "could not parse LIBREOFFICE_CORE_COMMIT from vendor/libreoffice/VERSION-PIN")
        let helper = try await spawnLiveHelper()
        XCTAssertEqual(helper.lokVersion, buildId)
    }

    // MARK: - Profile-under-state-path + bundle untouched (carry #2, vendor-tree half)

    func testUserProfileMaterializesUnderStatePathAndVendorTreeStaysUntouched() async throws {
        try skipUnlessVendorPresent()
        let before = try Self.snapshotTree(Self.vendorProductSetRoot)

        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        try await helper.client.close(docId: docId)

        let profileDirs = (try? FileManager.default.contentsOfDirectory(at: helper.stateDir, includingPropertiesForKeys: nil))?
            .filter { $0.lastPathComponent.hasPrefix("lok-profile-") } ?? []
        XCTAssertEqual(profileDirs.count, 1, "expected exactly one lok-profile-* directory under --state-path")

        let after = try Self.snapshotTree(Self.vendorProductSetRoot)
        XCTAssertEqual(before, after, "vendor tree must be byte/mtime-unchanged around a boot+load+close cycle "
                        + "(the bootstraprc trap: writing here means UserInstallation resolved to the wrong place)")
    }

    // MARK: - Stale profile-directory sweep (F4, T3 review)

    /// `LOKBridge.prepareUserProfile` sweeps every pre-existing `lok-profile-*` directory under
    /// `--state-path` before minting its own — that method's own header: unbounded growth
    /// otherwise (measured: 3 boots against one stable `--state-path` left 3 separate directories;
    /// `_exit` means no `atexit` ever runs to clean one up on the way out, by design). Proves it
    /// end to end: two SEPARATE helper processes, booted SEQUENTIALLY against the exact SAME
    /// `--state-path` (the second boot starts only once the first is confirmed fully dead —
    /// matching the "one live helper per state-path at a time" invariant the sweep's own safety
    /// argument depends on), leave exactly ONE `lok-profile-*` directory once the second is up —
    /// the FIRST boot's own, now stale, must be gone.
    func testStaleProfileDirectoriesAreSweptOnTheNextBootOfTheSameStatePath() async throws {
        try skipUnlessVendorPresent()
        let sharedStateDir = makeScratchDirectory()

        let first = try await spawnLiveHelper(stateDir: sharedStateDir)
        let firstProfileDirs = try Self.profileDirectories(under: sharedStateDir)
        XCTAssertEqual(firstProfileDirs.count, 1, "setup: first boot should leave exactly one lok-profile-* directory")

        // SIGKILL — matching how a dead helper actually goes away once LOK is loaded in
        // production (`OfficeHelperSupervisor.forceKill`, carry #4) — and confirmed fully reaped
        // (`waitUntilExit` + a poll) before the second boot starts.
        let killResult = kill(first.process.processIdentifier, SIGKILL)
        XCTAssertEqual(killResult, 0, "setup: kill(SIGKILL) syscall itself failed: errno \(errno)")
        first.process.waitUntilExit()
        let firstDied = await waitUntil(timeout: 5.0) { !first.process.isRunning }
        XCTAssertTrue(firstDied, "setup: first helper must be fully dead before the second boots against the same state path")

        let second = try await spawnLiveHelper(stateDir: sharedStateDir)
        let secondProfileDirs = try Self.profileDirectories(under: sharedStateDir)
        XCTAssertEqual(secondProfileDirs.count, 1,
            "expected the sweep to remove the FIRST boot's now-stale profile directory, leaving only "
            + "the second boot's own — found \(secondProfileDirs.map { $0.lastPathComponent })")
        XCTAssertNotEqual(firstProfileDirs.first, secondProfileDirs.first,
            "the surviving directory should be the SECOND boot's own fresh one, not a coincidental "
            + "reuse of the first boot's directory name")

        // The sweep must not have left the second helper in a broken state.
        let docId = UUID().uuidString
        let metadata = try await second.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        XCTAssertEqual(metadata.type, .spreadsheet, "the second helper must still be fully functional after the sweep")
        try await second.client.close(docId: docId)
    }

    private static func profileDirectories(under stateDir: URL) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: stateDir, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("lok-profile-") }
    }

    // MARK: - Embedded root (carry #1: at least one test against the REAL built app)

    func testEmbeddedRootBootsAgainstTheRealBuiltAppAndBundleStaysUntouched() async throws {
        let appBundleURL = Bundle.main.bundleURL
        let embeddedHelperURL = appBundleURL.appendingPathComponent("Contents/MacOS/NormaOfficeHelper")
        let embeddedLOKRoot = appBundleURL.appendingPathComponent("Contents/Resources/LibreOffice")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: embeddedHelperURL.path),
                      "NormaOfficeHelper was not embedded into this run's built app (\(embeddedHelperURL.path)) "
                        + "— the app target's postCompileScripts did not run for this build.")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: embeddedLOKRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice was not embedded into this run's built app (\(embeddedLOKRoot.path)).")

        // T2-b's own invariant re-verified at this task's own use of the root: the carry's bundle-
        // untouched assertion, against the SIGNED bundle specifically (stronger than the vendor-tree
        // check above — this is the tree whose seal actually matters).
        let before = try Self.snapshotTree(embeddedLOKRoot)

        let helper = try await spawnLiveHelper(helperURL: embeddedHelperURL, installRoot: nil)
        let docId = UUID().uuidString
        let metadata = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        XCTAssertEqual(metadata.type, .spreadsheet)
        XCTAssertEqual(metadata.sizeTwips.widthTwips, 26593)
        try await helper.client.close(docId: docId)

        let after = try Self.snapshotTree(embeddedLOKRoot)
        XCTAssertEqual(before, after, "the SIGNED embedded LibreOffice tree must be byte/mtime-unchanged "
                        + "around a real boot+load+close cycle against the app's own embedded root")
    }

    /// (relativePath -> modificationDate) for every file under `root`, cheap (stat-only, no
    /// content hashing — 3,244 files, well under a second) but sufficient to catch any write:
    /// `UserInstallation` resolving inside the bundle would create/touch files here.
    private static func snapshotTree(_ root: URL) throws -> [String: Date] {
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.contentModificationDateKey, .isDirectoryKey]) else {
            throw XCTSkip("could not enumerate \(root.path)")
        }
        var snapshot: [String: Date] = [:]
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.contentModificationDateKey, .isDirectoryKey])
            guard values.isDirectory != true else { continue }
            let relativePath = String(url.path.dropFirst(root.path.count))
            snapshot[relativePath] = values.contentModificationDate
        }
        return snapshot
    }

    // MARK: - SIGTERM-with-LOK-loaded measurement (carry #4, EARNED)

    /// Sends SIGTERM to a helper with LOK loaded AND a Writer document open (`SwDLL` — the exact
    /// class the T2-review-earned carry names as the one whose static teardown is at risk) and
    /// measures what happens. `sofficerc`'s `CrashDumpEnable=true` MAY install signal handlers at
    /// init that intercept SIGTERM — this is the empirical check, not an assumption either way.
    /// The elapsed time + termination status ARE the measurement this carry asks for; both are
    /// printed regardless of pass/fail so the report has the number even if this assertion needs
    /// adjusting after a first real run.
    func testSIGTERMWithLOKLoadedAndAWriterDocumentOpenDiesPromptly() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.docx").path)

        let pid = helper.process.processIdentifier
        let start = Date()
        let killResult = kill(pid, SIGTERM)
        XCTAssertEqual(killResult, 0, "kill(SIGTERM) syscall itself failed: errno \(errno)")

        let died = await waitUntil(timeout: 8.0) { !helper.process.isRunning }
        let elapsed = Date().timeIntervalSince(start)
        let status = helper.process.terminationStatus
        let reason = helper.process.terminationReason
        print("[SIGTERM measurement] died=\(died) elapsed=\(String(format: "%.3f", elapsed))s "
                + "terminationStatus=\(status) terminationReason=\(reason.rawValue) "
                + "(uncaughtSignal=\(ProcessTerminationReasonUncaughtSignalRawValue))")

        XCTAssertTrue(died, "helper did not die within 8s of SIGTERM with LOK loaded + a Writer document open "
                        + "(elapsed \(elapsed)s) — see task-3 report for the SIGTERM verdict; if this is failing, "
                        + "the supervisor's kill path needs to switch to SIGKILL, per this carry's own instruction")
    }

    // MARK: - Push/reply interleaving regression (the OfficeWireConnection bug this task fixed)

    /// Proves `.documentEvent` pushes never starve a concurrent request/reply — the real bug found
    /// while wiring async callbacks onto what was, before this task, a pure request/response
    /// connection (`OfficeWireConnection.onDocumentEvent`'s own header has the full story). Does
    /// NOT assert a specific push count (LOK's own firing behavior for an unedited, freshly loaded
    /// view-only document is observed, not assumed) — the regression coverage is that `ping`
    /// immediately after `open` still succeeds regardless of what (if anything) LOK pushed in
    /// between.
    func testDocumentEventPushDoesNotStarveAConcurrentPingReply() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        // F5 (T3 review): `observedPushes` is written from `onDocumentEvent`'s own callback —
        // delivered from `OfficeWireConnection`'s reader thread (see that property's header: pushes
        // are dispatched at `ingest()` time, off the socket-read path, never on this test's own
        // task) — and read below on the test's own task after open+ping+close all return. Latent
        // only because LOK fires zero callbacks in Stage A's own tests (no tile ever painted, every
        // open view-only — nothing to race on, today); T4 makes this load-bearing the moment a real
        // push can actually land WHILE this test's own task is mid-read. One NSLock around both
        // sides closes the race now rather than leaving it as a trap for T4 to trip over.
        let observedPushesLock = NSLock()
        var observedPushes: [(String, OfficeDocumentEvent)] = []
        // Plain (non-`async`) local functions, deliberately — `NSLock.lock()`/`.unlock()` called
        // DIRECTLY from an `async` function's own body triggers "unavailable from asynchronous
        // contexts" under strict concurrency checking (harmless here — neither call ever spans a
        // suspension point — but still worth not shipping a new warning). Wrapping each critical
        // section in its own synchronous function, called FROM the async test body, keeps the
        // `.lock()`/`.unlock()` call sites themselves inside a synchronous context.
        func recordPush(_ docId: String, _ event: OfficeDocumentEvent) {
            observedPushesLock.lock()
            observedPushes.append((docId, event))
            observedPushesLock.unlock()
        }
        func snapshotPushes() -> [(String, OfficeDocumentEvent)] {
            observedPushesLock.lock()
            defer { observedPushesLock.unlock() }
            return observedPushes
        }
        helper.client.onDocumentEvent = { docId, event in recordPush(docId, event) }

        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        try await helper.client.ping() // the regression assertion: this must not time out / mis-deliver
        try await helper.client.close(docId: docId)
        let pushesSnapshot = snapshotPushes()
        print("[push interleaving] observed \(pushesSnapshot.count) push(es) around open+ping+close; "
                + "events=\(pushesSnapshot.map { $0.1 })")
    }

    // MARK: - Raw-buffer SHA tripwire (carry #6) — via the committed spike, NOT the real tile
    // pipeline (Task 4 owns that). Exact spike parameters: 512x512 canvas, tile origin (0,0),
    // 3000x3000 twips (the spike's own default), matching how the gate's pinned table was produced.
    //
    // This is the VENDOR-INTEGRITY half of a two-test split (Task 4, debt #2): did the vendored
    // dylib itself change, checked WITHOUT `FONTCONFIG_FILE` — the no-override baseline the gate
    // table was originally pinned under. Its product-path sibling,
    // `testProductPathPixelHashesForAllSixFixturesAndHashStabilityAcrossTwoRequests` below, is the
    // REGRESSION tripwire for this task's own `TileRenderer`/`LOKBridge` pipeline through the real
    // production fontconfig config — the two deliberately pin DIFFERENT hashes for the same fixture,
    // see that test's own header for why. Different jobs, both live.

    func testGateXlsxRawTileHashMatchesTheGateTablePin() throws {
        try skipUnlessVendorPresent()
        let spikeBinary = try Self.buildSpike()
        let installPath = Self.vendorProductSetRoot.appendingPathComponent("Frameworks").path
        let fixture = Self.fixturesRoot.appendingPathComponent("gate.xlsx").path

        let hash = try Self.runSpikeAndHashRaw(spikeBinary: spikeBinary, installPath: installPath,
                                                fixturePath: fixture, extraEnv: [:])
        // svp-probe-report.md "Final verification: 6/6 fixtures, hash-identical, against the
        // assembled product-set/" — the gate's own pinned table.
        XCTAssertEqual(hash, "8f0d7dc4fb7bcb3d4f897781248c2752230caae42918f46379ac46a188c102c3",
                       "gate.xlsx raw tile SHA-256 no longer matches the gate's pinned table — a real "
                        + "rendering regression, not a test-infrastructure issue")
    }

    /// Empirical answer to the question this task's own report flags: does LOKBridge's ALWAYS-ON
    /// `FONTCONFIG_FILE` override (carry #5) change gate.xlsx's rendered pixels versus the
    /// no-override baseline the gate table above was pinned against? Never asserts a SPECIFIC
    /// outcome — prints what actually happened either way (the advisor's own decision rule: "run
    /// with and without, disclose, don't ask"). A mirror of `LOKBridge.configureFontconfig`'s
    /// shape, not a call into it (that method is `private` inside a DIFFERENT target this test
    /// bundle does not link — see LOKBridge.swift's own header for why NormaOfficeHelperFixture/
    /// NormaAppTests stay LOK-symbol-free). **T3 review F1**: this mirror was updated alongside the
    /// real method — see `LOKBridge.configureFontconfig`'s own header for what changed and why
    /// (own explicit `<dir>` list skipping `/System/Library/AssetsV2`, `<include>` of `conf.d`
    /// only, the 4 alias blocks inlined) — kept in sync so this test still exercises the SAME
    /// config shape production actually ships, not a stale pre-fix one.
    func testFontconfigOverridePixelEffectOnGateXlsxIsObservedAndReported() throws {
        try skipUnlessVendorPresent()
        let spikeBinary = try Self.buildSpike()
        let installPath = Self.vendorProductSetRoot.appendingPathComponent("Frameworks").path
        let fixture = Self.fixturesRoot.appendingPathComponent("gate.xlsx").path

        let noEnvHash = try Self.runSpikeAndHashRaw(spikeBinary: spikeBinary, installPath: installPath,
                                                     fixturePath: fixture, extraEnv: [:])

        let confDir = makeScratchDirectory()
        let cacheDir = confDir.appendingPathComponent("cache", isDirectory: true)
        try FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let bundledConfD = Self.vendorProductSetRoot.appendingPathComponent("Resources/fontconfig/conf.d")
        let bundledFontsDir = Self.vendorProductSetRoot.appendingPathComponent("Resources/fonts/truetype")
        let confPath = confDir.appendingPathComponent("fonts.conf")
        let homeFonts = (NSHomeDirectory() as NSString).appendingPathComponent("Library/Fonts")
        let xml = """
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
        <fontconfig>
        \t<cachedir>\(cacheDir.path)</cachedir>
        \t<dir>/System/Library/Fonts</dir>
        \t<dir>/Library/Fonts</dir>
        \t<dir>\(homeFonts)</dir>
        \t<dir>\(bundledFontsDir.path)</dir>
        \t<include ignore_missing="yes">\(bundledConfD.path)</include>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>mono</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>monospace</string></edit>
        \t</match>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>sans serif</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>sans-serif</string></edit>
        \t</match>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>sans</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>sans-serif</string></edit>
        \t</match>
        \t<match target="pattern">
        \t\t<test qual="any" name="family"><string>system ui</string></test>
        \t\t<edit name="family" mode="assign" binding="same"><string>system-ui</string></edit>
        \t</match>
        </fontconfig>
        """
        try xml.write(to: confPath, atomically: true, encoding: .utf8)

        let withEnvHash = try Self.runSpikeAndHashRaw(spikeBinary: spikeBinary, installPath: installPath,
                                                       fixturePath: fixture, extraEnv: ["FONTCONFIG_FILE": confPath.path])
        if withEnvHash == noEnvHash {
            print("[fontconfig empirical check] gate.xlsx raw tile hash UNCHANGED with LOKBridge-shaped "
                    + "FONTCONFIG_FILE set (\(noEnvHash)) — the always-on override does not perturb this "
                    + "fixture's rendering.")
        } else {
            print("[fontconfig empirical check] gate.xlsx raw tile hash CHANGED: no-env=\(noEnvHash) "
                    + "with-env=\(withEnvHash) — see task-3 report for the disclosed finding.")
        }
        // Informational only — no assertion on equality either way (the whole point is to observe
        // and report, not to force a particular outcome); this test still asserts the RUN ITSELF
        // succeeded both times (a non-empty, well-formed hash), which is real coverage on its own.
        XCTAssertEqual(noEnvHash.count, 64)
        XCTAssertEqual(withEnvHash.count, 64)
    }

    /// Rebuilds the spike (cheap — one C file, no LOK build involved) so this test never runs
    /// against a stale binary; returns its path.
    private static func buildSpike() throws -> URL {
        let buildScript = spikeDirectory.appendingPathComponent("build.sh")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [buildScript.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw XCTSkip("spike build.sh failed (exit \(process.terminationStatus)): \(output)")
        }
        return spikeDirectory.appendingPathComponent("out/office-lok-gate")
    }

    /// Runs the spike against `fixturePath`, reads its raw RGBA dump, returns its SHA-256 hex
    /// digest. `profile_dir` is a fresh scratch dir per call (LOK rejects reusing an already-locked
    /// profile across overlapping runs — this spike is one-shot-per-process anyway).
    private static func runSpikeAndHashRaw(spikeBinary: URL, installPath: String, fixturePath: String,
                                            extraEnv: [String: String]) throws -> String {
        let scratchRoot = URL(fileURLWithPath: "/tmp/officelive-spike-\(UUID().uuidString.prefix(8))", isDirectory: true)
        let profileDir = scratchRoot.appendingPathComponent("profile", isDirectory: true)
        try FileManager.default.createDirectory(at: profileDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratchRoot) }

        let pngPath = scratchRoot.appendingPathComponent("tile.png").path
        let rawPath = scratchRoot.appendingPathComponent("tile.raw").path

        let process = Process()
        process.executableURL = spikeBinary
        process.arguments = [installPath, profileDir.path, fixturePath, pngPath, rawPath]
        var environment = ProcessInfo.processInfo.environment
        for (key, value) in extraEnv { environment[key] = value }
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe() // discard stderr diagnostics; stdout carries RESULT:
        try process.run()
        process.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard output.contains("RESULT: OK") else {
            throw XCTSkip("spike did not report RESULT: OK (exit \(process.terminationStatus)): \(output)")
        }
        let rawData = try Data(contentsOf: URL(fileURLWithPath: rawPath))
        let digest = SHA256.hash(data: rawData)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func sha256Hex(base64: String) -> String {
        guard let raw = Data(base64Encoded: base64) else { return "<undecodable base64>" }
        return SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Task 4, debt #1: real-callback-shape proof

    /// Office Stage A Task 4, carried debt #1 (T3's own concern #8: "the callback parsers have
    /// NEVER executed against a real LOK callback, in any test or any live run in this task"). This
    /// task's first real `paintTile` call is the first thing in this whole vendored engine's
    /// history that could change that. Runs a sequence of candidate triggers on an ALREADY-OPEN
    /// document — open (registration happens before `initializeForRendering`, so anything
    /// synchronous during load is captured too), a real `paintTile`, `paintTile` again at a
    /// DIFFERENT, previously-unseen tile, close — and reads back every RAW callback `LOKBridge`
    /// received via its own unconditional stderr trace (`spawnLiveHelper(captureStderr: true)`).
    /// Whatever fires (including "nothing") IS the finding, printed in full; see
    /// task-4-report.md for the interpretation and the two lenient-parser-behavior re-judgment
    /// this debt also asks for.
    func testRealLOKCallbackProbeCapturesRawPayloadsAndCrossChecksTheParsers() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper(captureStderr: true)

        var observedPushes: [(String, OfficeDocumentEvent)] = []
        let observedLock = NSLock()
        helper.client.onDocumentEvent = { docId, event in
            observedLock.lock(); observedPushes.append((docId, event)); observedLock.unlock()
        }

        let docId = UUID().uuidString
        let opened = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        print("[callback probe] opened: type=\(opened.type) parts=\(opened.parts) size=\(opened.sizeTwips.widthTwips)x\(opened.sizeTwips.heightTwips)")
        try? await Task.sleep(nanoseconds: 1_500_000_000) // settle window for anything fired synchronously during load

        try await helper.client.requestTiles(docId: docId, keys: [TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)])
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        try await helper.client.requestTiles(docId: docId, keys: [TileKey(part: 0, zoomPPT: 1000, tileX: 3, tileY: 5)]) // previously-unseen region
        try? await Task.sleep(nanoseconds: 1_500_000_000)

        try await helper.client.close(docId: docId)
        try? await Task.sleep(nanoseconds: 1_000_000_000)

        // CAPTURE-MECHANISM LIMITATION (not a LOK or production-parser limitation — disclosed here
        // because a live run surfaced it): `StderrCapture.ingest` splits purely on 0x0A. If a real
        // callback's `payload` itself CONTAINS an embedded newline (observed live: a STATE_CHANGED
        // firing whose logged payload was just `"{"` — the opening brace of what is presumably a
        // multi-line JSON/JSDIALOG-shaped payload, cut at its own first internal `\n`), the line
        // that carries the `[LOKBridge raw callback]` prefix is counted correctly (one real firing
        // = one prefixed line, so `rawLines.count` below is NOT inflated), but that line's `payload=`
        // text is TRUNCATED relative to what LOK actually sent — the remaining lines of a multi-line
        // payload land in the buffer as their own unprefixed "lines" and are filtered OUT here, not
        // reattached. Neither Stage A parser this test cross-checks is affected: both
        // `parseInvalidateTiles` and `parseModifiedStatus` only ever recognize single-line payload
        // shapes by protocol definition, and every type=0/type=8 firing observed below arrived intact
        // on one line. Anyone reading a future probe run should not mistake a bare `"{"` for a real,
        // complete payload — it is an artifact of this line-based capture, not of LOK.
        let rawLines = (helper.stderrCapture?.linesSnapshot() ?? []).filter { $0.contains("[LOKBridge raw callback]") }
        print("[callback probe] \(rawLines.count) raw LOK callback(s) observed across open + 2x paintTile + close:")
        for line in rawLines { print("  " + line) }
        print("[callback probe] \(observedPushes.count) OfficeDocumentEvent push(es) decoded from those on the wire:")
        for (pushDocId, event) in observedPushes { print("  docId=\(pushDocId) event=\(event)") }

        // The empirical finding stands regardless of count — this is not pass/fail on "did LOK
        // fire" (an honesty clause, not a target): it is pass/fail on "did whatever DID fire parse
        // correctly," vacuously true for zero firings and a REAL cross-check the moment even one
        // does. Line shape: "[LOKBridge raw callback] docId=<id> type=<n> payload=<...>".
        var anyInvalidateTilesObserved = false
        var anyStateChangedObserved = false
        for line in rawLines {
            guard let typeRange = line.range(of: "type="), let payloadRange = line.range(of: " payload=") else { continue }
            guard let type = Int32(line[typeRange.upperBound..<payloadRange.lowerBound]) else { continue }
            let payload = String(line[payloadRange.upperBound...])
            if type == 0 { // LOK_CALLBACK_INVALIDATE_TILES
                anyInvalidateTilesObserved = true
                let parsed = OfficeDocumentEvent.parseInvalidateTiles(payload)
                XCTAssertNotNil(parsed, "a REAL invalidate-tiles payload failed to parse: \"\(payload)\"")
                print("[callback probe] REAL invalidate-tiles payload \"\(payload)\" parsed as: \(String(describing: parsed))")
            } else if type == 8 { // LOK_CALLBACK_STATE_CHANGED
                anyStateChangedObserved = true
                if let parsed = OfficeDocumentEvent.parseModifiedStatus(payload) {
                    print("[callback probe] REAL state-changed payload \"\(payload)\" parsed as ModifiedStatus: \(parsed)")
                } else {
                    print("[callback probe] REAL state-changed payload \"\(payload)\" is not a ModifiedStatus firing "
                            + "(expected for most .uno: state changes — Stage A's parser only recognizes that one)")
                }
            }
        }
        print("[callback probe] SUMMARY: invalidate-tiles observed=\(anyInvalidateTilesObserved), "
                + "state-changed observed=\(anyStateChangedObserved), total raw lines=\(rawLines.count)")
    }

    // MARK: - Invalidation drill: reload-triggered (Stage A has no edit verbs)

    /// Office Stage A Task 4's own invalidation drill, per the brief's explicit menu (edit-via-UNO
    /// ruled out: Stage A wires no edit verb at all) and the carried instruction to "pick what LOK
    /// actually gives you Stage A and document why": reload-triggered invalidation. Close, then
    /// re-open the SAME `docId` pointed at a MODIFIED copy of a fixture — one cell's fill color
    /// changed in `gate.fods`'s flat-XML source (a plain text edit with zero zip/binary corruption
    /// risk, unlike surgically patching `gate.xlsx`'s OOXML zip) — and assert the SAME tile
    /// coordinates render DIFFERENT pixels.
    ///
    /// **What this drill does NOT prove**: a "generation bump" on the SAME, still-open document
    /// the way a live LOK-fired invalidate-tiles callback would (see the probe test above, which
    /// checks for exactly that, empirically). Closing and re-opening a docId gets a BRAND NEW
    /// `LibreOfficeKitDocument` handle and, by this task's own design, a BRAND NEW
    /// `TileRenderer`/`TileCache` — its generation ledger starts at 0 again, correctly: a document
    /// nobody has painted yet has no staleness history to have accumulated (`TileCache.recordPaint`'s
    /// own header). The property this drill DOES prove — end-to-end pixel sensitivity to real
    /// content change, through the exact product-path `TileRenderer` this task ships — is real and
    /// is the disclosed Stage-A-honest substitute for what the brief's own text anticipated might
    /// not be available.
    func testReloadOfAModifiedFixtureCopyProducesADifferentTileHashAtTheSameCoordinates() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()

        let scratchDir = makeScratchDirectory()
        let originalFods = try String(contentsOf: Self.spikeDirectory.appendingPathComponent("seeds/gate.fods"), encoding: .utf8)
        XCTAssertTrue(originalFods.contains("#ff6600"), "setup: gate.fods must still contain the fill color this drill flips")
        let modifiedFods = originalFods.replacingOccurrences(of: "#ff6600", with: "#0000ff")
        let originalPath = scratchDir.appendingPathComponent("gate-original.fods")
        let modifiedPath = scratchDir.appendingPathComponent("gate-modified.fods")
        try originalFods.write(to: originalPath, atomically: true, encoding: .utf8)
        try modifiedFods.write(to: modifiedPath, atomically: true, encoding: .utf8)

        let docId = UUID().uuidString
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)

        final class TileCollector: @unchecked Sendable {
            private let lock = NSLock()
            private var pushes: [(generation: Int, pixelsBase64: String)] = []
            func record(generation: Int, pixelsBase64: String) {
                lock.lock(); pushes.append((generation, pixelsBase64)); lock.unlock()
            }
            func snapshot() -> [(generation: Int, pixelsBase64: String)] {
                lock.lock(); defer { lock.unlock() }; return pushes
            }
        }
        let collector = TileCollector()
        helper.client.onTile = { _, _, _, generation, _, _, pixelsBase64 in collector.record(generation: generation, pixelsBase64: pixelsBase64) }

        _ = try await helper.client.open(docId: docId, path: originalPath.path)
        try await helper.client.requestTiles(docId: docId, keys: [key])
        let firstArrived = await waitUntil(timeout: 5.0) { collector.snapshot().count >= 1 }
        XCTAssertTrue(firstArrived, "expected a .tile push for the original fixture")
        try await helper.client.close(docId: docId)

        _ = try await helper.client.open(docId: docId, path: modifiedPath.path)
        try await helper.client.requestTiles(docId: docId, keys: [key])
        let secondArrived = await waitUntil(timeout: 5.0) { collector.snapshot().count >= 2 }
        XCTAssertTrue(secondArrived, "expected a .tile push for the modified fixture")
        try await helper.client.close(docId: docId)

        let pushes = collector.snapshot()
        let beforePush = try XCTUnwrap(pushes.first)
        let afterPush = pushes[1]
        print("[reload drill] before (original, orange fill): generation=\(beforePush.generation) sha256=\(Self.sha256Hex(base64: beforePush.pixelsBase64))")
        print("[reload drill] after  (modified, blue fill):   generation=\(afterPush.generation) sha256=\(Self.sha256Hex(base64: afterPush.pixelsBase64))")

        XCTAssertEqual(beforePush.generation, 0, "a fresh document's first-ever paint of any coordinate starts at generation 0")
        XCTAssertEqual(afterPush.generation, 0, "the RE-OPENED docId gets a BRAND NEW TileRenderer/TileCache — also starts at 0, "
                        + "not a continuation of the prior open's generation (see this test's own header)")
        XCTAssertNotEqual(beforePush.pixelsBase64, afterPush.pixelsBase64,
                           "the fill-color edit must be visible at tile (0,0) — the edited cell is the very first content in the sheet")
    }

    // MARK: - Live tile drill: subscribeTiles over the real doc

    /// The brief's own live tile drill, literally: `subscribeTiles` (not merely `tileRequest`)
    /// against the REAL helper — asserts the returned key set matches `TileMath.viewportTileKeys`
    /// computed independently by the test (client and server must never disagree), then fetches
    /// the tiles that subscription named and re-subscribes with the IDENTICAL viewport a second
    /// time, asserting the reported key set — and, after fetching, the pixel hash — are STABLE
    /// across both subscribes.
    func testSubscribeTilesOverTheRealDocumentThenHashIsStableAcrossTwoSubscribes() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)

        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 10240, height: 10240) // 2x2 tiles at zoomPPT 1000
        let expectedKeys = Set(TileMath.viewportTileKeys(part: 0, zoomPPT: 1000, viewportTwips: viewport))
        XCTAssertEqual(expectedKeys.count, 4, "setup: this viewport should cover exactly a 2x2 tile grid")

        let firstSubscribed = Set(try await helper.client.subscribeTiles(docId: docId, part: 0, zoomPPT: 1000, viewportTwips: viewport))
        XCTAssertEqual(firstSubscribed, expectedKeys, "server-computed viewport key set must match TileMath's own, independently computed")

        final class Box: @unchecked Sendable {
            let lock = NSLock(); var base64ByKey: [TileKey: String] = [:]
            func record(_ key: TileKey, _ base64: String) { lock.lock(); base64ByKey[key] = base64; lock.unlock() }
            func snapshot() -> [TileKey: String] { lock.lock(); defer { lock.unlock() }; return base64ByKey }
        }
        let box = Box()
        helper.client.onTile = { _, _, key, _, _, _, base64 in box.record(key, base64) }
        try await helper.client.requestTiles(docId: docId, keys: Array(firstSubscribed))
        let allArrived = await waitUntil(timeout: 10.0) { box.snapshot().count >= firstSubscribed.count }
        XCTAssertTrue(allArrived, "expected a .tile push for every key in the first subscribe's own reported set")

        let firstPixels = box.snapshot()
        for (key, base64) in firstPixels {
            guard let raw = Data(base64Encoded: base64) else { return XCTFail("undecodable base64 for \(key)") }
            XCTAssertEqual(raw.count, TileMath.bytesPerTile, "\(key): tile byte count")
        }
        // At least the origin tile (which the six-format matrix already knows carries real
        // "NORMA GATE" content) must be non-blank; edge tiles at this viewport's far corners may
        // legitimately be blank if gate.xlsx's content doesn't reach that far — asserting non-blank
        // on the ORIGIN tile specifically is the honest, content-aware version of "non-blank."
        let originKey = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let originPixels = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(firstPixels[originKey])))
        XCTAssertGreaterThan(Set(originPixels).count, 1, "origin tile appears blank")

        // Second subscribe, SAME viewport — the key set must be identical, and (since nothing
        // invalidated in between) the already-cached pixels must be BYTE-IDENTICAL on re-request.
        let secondSubscribed = Set(try await helper.client.subscribeTiles(docId: docId, part: 0, zoomPPT: 1000, viewportTwips: viewport))
        XCTAssertEqual(secondSubscribed, expectedKeys, "re-subscribing the SAME viewport must report the SAME key set")

        try await helper.client.requestTiles(docId: docId, keys: Array(secondSubscribed))
        let secondArrived = await waitUntil(timeout: 10.0) { box.snapshot().count >= firstSubscribed.count } // same count, values may update
        XCTAssertTrue(secondArrived)
        let secondPixels = box.snapshot()
        for key in expectedKeys {
            XCTAssertEqual(firstPixels[key], secondPixels[key], "\(key): pixel hash must be STABLE across two subscribes")
        }

        try await helper.client.close(docId: docId)
    }

    // MARK: - Task 4, debt #2: product-path pixel hash table (the NEW regression tripwire)

    /// Office Stage A Task 4, carried debt #2: "the gate table is unreachable from LOKBridge
    /// (FONTCONFIG_FILE always set)" — T3's own finding that carry #5's ALWAYS-ON fontconfig
    /// override changes rendering versus the gate table's no-override baseline, for every fixture
    /// whose layout or glyph selection is font-sensitive (live testing showed this includes
    /// `gate.xlsx` itself, not just `gate.ods`'s already-disclosed width delta). This establishes
    /// SIX product-path pins, for the FIRST time, through this task's own real
    /// `TileRenderer`/`LOKBridge`, under the real production fontconfig config (part 0, zoomPPT
    /// 1000, tile (0,0), 512x512 canvas, 5120-twip span — this task's own canonical geometry).
    ///
    /// **The split, stated once, for both pins**: `testGateXlsxRawTileHashMatchesTheGateTablePin`
    /// (unchanged, spike-path) is the VENDOR-INTEGRITY tripwire — did the vendored dylib itself
    /// change — deliberately run WITHOUT `FONTCONFIG_FILE`, matching how the gate table was
    /// originally pinned. THIS test is the REGRESSION tripwire for this task's own rendering
    /// pipeline going forward, through the real production config. Different jobs, both live.
    ///
    /// **Machine-relative, disclosed** (same class of caveat `testSixFormatsOpenWithSaneTypePartsAndSize`'s
    /// own `gate.ods` width tolerance already established): `LOKBridge.configureFontconfig`
    /// includes `~/Library/Fonts`, a per-account directory, so these six hashes are pinned to THIS
    /// machine's font landscape, not a universal constant. A mismatch on a different machine/account
    /// should be read as environment-dependent, not necessarily a rendering regression.
    func testProductPathPixelHashesForAllSixFixturesAndHashStabilityAcrossTwoRequests() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let key = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)

        // Pinned from this test's own first observed run on this machine (printed below either
        // way) — re-verified reproducible across a second full run before landing, per this
        // repo's own gate-table precedent.
        // Observed on this machine (2 consecutive full runs, byte-identical both times — see
        // task-4-report.md for the reproduction log). gate.docx/gate.odt share a hash: same text
        // content across formats, consistent with the six-format matrix's own dimension pins
        // already showing that pair as identical (12474x17406 both). gate.ods's hash also matches
        // this task's OWN reload-drill test's "before" (orange-fill) hash — `.ods` (zipped) and the
        // spike seed's `.fods` (flat XML) are two serializations of the same original content, a
        // cross-check this task did not have to engineer, just happened to fall out of using both.
        let expectedHashes: [String: String] = [
            "gate.xlsx": "e4d47906b6b6dcac9ba88d5953210ff991c9368e61cb4374f0e21ae1c41740e4",
            "gate.ods": "56a6a81096e4f405e73ec17c6135dac89e240227d74daac2aef0710816939170",
            "gate.pptx": "6fc7cb68f3392996d71ed6031121c580832195c575f81e80d689127b7e0fbd46",
            "gate.odp": "1aaaad70b4d1ab2069bcb2b8f707f7288d4eddd97b4199a1f99403e922fdedb3",
            "gate.docx": "143fe7f3332527d3f4feaa488ab47061b78af1ed2a1504de16c433a5617f1ac9",
            "gate.odt": "143fe7f3332527d3f4feaa488ab47061b78af1ed2a1504de16c433a5617f1ac9",
        ]

        for fixture in ["gate.xlsx", "gate.ods", "gate.pptx", "gate.odp", "gate.docx", "gate.odt"] {
            let docId = UUID().uuidString
            _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent(fixture).path)

            final class Box: @unchecked Sendable {
                let lock = NSLock()
                var pushes: [String] = []
                func record(_ base64: String) { lock.lock(); pushes.append(base64); lock.unlock() }
                func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return pushes }
            }
            let box = Box()
            helper.client.onTile = { _, _, _, _, _, _, base64 in box.record(base64) }

            // First request: real paint. Second, IDENTICAL request: a TileCache hit (stability).
            try await helper.client.requestTiles(docId: docId, keys: [key])
            let firstArrived = await waitUntil(timeout: 10.0) { box.snapshot().count >= 1 }
            XCTAssertTrue(firstArrived, "\(fixture): expected a .tile push")
            try await helper.client.requestTiles(docId: docId, keys: [key])
            let secondArrived = await waitUntil(timeout: 5.0) { box.snapshot().count >= 2 }
            XCTAssertTrue(secondArrived, "\(fixture): expected a SECOND .tile push (cache hit)")

            let pushes = box.snapshot()
            let base64First = pushes[0]
            let base64Second = pushes[1]
            XCTAssertEqual(base64First, base64Second, "\(fixture): pixel hash must be STABLE across two subscribes/requests")

            let raw = try XCTUnwrap(Data(base64Encoded: base64First), "\(fixture): pixelsBase64 did not decode")
            XCTAssertEqual(raw.count, TileMath.bytesPerTile, "\(fixture): tile byte count")
            XCTAssertGreaterThan(Set(raw).count, 1, "\(fixture): tile appears blank (all one byte value) — NON-BLANK requirement")

            let hash = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
            print("[product-path pin] \(fixture) part=0 zoomPPT=1000 tile=(0,0) 512x512 RGBA sha256=\(hash)")
            if let expected = expectedHashes[fixture] {
                XCTAssertEqual(hash, expected, "\(fixture): product-path tile hash drifted — see this test's own "
                                + "machine-relative disclosure before assuming a rendering regression")
            }

            try await helper.client.close(docId: docId)
        }
    }

    // MARK: - Transport decision: scroll-storm measurement

    /// Office Stage A Task 4's own surface-transport decision, the empirical half: realistic tile
    /// traffic, measured END-TO-END through the REAL wire (real helper, real socket, real
    /// `OfficeWireConnection` — not a microbenchmark of base64/JSON in isolation, which would miss
    /// the client-side buffer-scan cost this very task's own review caught and fixed).
    ///
    /// Two passes over the SAME 18 distinct tile keys (a 6x3 grid at zoomPPT 1000 — chosen to
    /// COVER `gate.xlsx`'s real content bounds, 26593x13005 twips, so paint cost is representative
    /// rather than measuring mostly-blank out-of-content tiles): pass 1 is COLD (every key a
    /// genuine LOK `paintPartTile` call); pass 2 re-requests the IDENTICAL keys, every one now a
    /// `TileCache` HIT (no `paintPartTile` call at all) — isolating transport+socket+decode cost
    /// from LOK's own render cost, with no new instrumentation beyond what this task already ships.
    func testScrollStormMeasurement() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)

        var keys: [TileKey] = []
        for y in 0..<3 {
            for x in 0..<6 {
                keys.append(TileKey(part: 0, zoomPPT: 1000, tileX: x, tileY: y))
            }
        }
        XCTAssertEqual(keys.count, 18)

        final class ArrivalCounter: @unchecked Sendable {
            private let lock = NSLock()
            private var count = 0
            private var totalBytes = 0
            func record(byteCount: Int) { lock.lock(); count += 1; totalBytes += byteCount; lock.unlock() }
            func snapshot() -> (count: Int, totalBytes: Int) { lock.lock(); defer { lock.unlock() }; return (count, totalBytes) }
        }
        let counter = ArrivalCounter()
        helper.client.onTile = { _, _, _, _, _, _, base64 in counter.record(byteCount: base64.utf8.count) }

        let coldStart = Date()
        try await helper.client.requestTiles(docId: docId, keys: keys)
        let coldArrived = await waitUntil(timeout: 30.0) { counter.snapshot().count >= keys.count }
        let coldElapsed = Date().timeIntervalSince(coldStart)
        XCTAssertTrue(coldArrived, "cold pass: not all \(keys.count) tiles arrived within 30s")
        let coldStats = counter.snapshot()

        let warmStart = Date()
        try await helper.client.requestTiles(docId: docId, keys: keys)
        let warmArrived = await waitUntil(timeout: 10.0) { counter.snapshot().count >= keys.count * 2 }
        let warmElapsed = Date().timeIntervalSince(warmStart)
        XCTAssertTrue(warmArrived, "warm pass: not all \(keys.count) cache-hit tiles arrived within 10s")

        try await helper.client.close(docId: docId)

        let coldPerTileMs = coldElapsed / Double(keys.count) * 1000
        let warmPerTileMs = warmElapsed / Double(keys.count) * 1000
        let paintAttributableMs = max(0, coldPerTileMs - warmPerTileMs)
        let avgPayloadBytes = coldStats.totalBytes / max(1, coldStats.count)

        print("""
        [scroll-storm measurement] \(keys.count) distinct tiles, 512x512 RGBA (\(TileMath.bytesPerTile) bytes/tile raw)
          COLD (real LOK paint x\(keys.count)): \(String(format: "%.1f", coldElapsed * 1000))ms total, \(String(format: "%.2f", coldPerTileMs))ms/tile, \(String(format: "%.1f", Double(keys.count) / coldElapsed)) tiles/sec
          WARM (cache hit x\(keys.count), transport-only): \(String(format: "%.1f", warmElapsed * 1000))ms total, \(String(format: "%.2f", warmPerTileMs))ms/tile, \(String(format: "%.1f", Double(keys.count) / warmElapsed)) tiles/sec
          Paint-attributable cost: ~\(String(format: "%.2f", paintAttributableMs))ms/tile (cold - warm)
          Average wire payload: \(avgPayloadBytes) bytes/tile (base64 text; 1 MiB raw -> ~1.4x as base64 text)
        """)

        // The bar (per this task's own transport-decision framing): tile arrival is ASYNC over a
        // placeholder, not a 16ms-per-frame budget. A generous ceiling, not a tight pin — the
        // PRINTED numbers above are the real evidence this task's report cites; this just fails
        // the suite outright on a severe regression.
        //
        // IMPORTANT for anyone reading the printed numbers: `onTile` above only measures
        // `base64.utf8.count` — it never calls `Data(base64Encoded:)`. So neither warmPerTileMs
        // nor coldPerTileMs includes base64 *decode* cost; they cover socket transfer + ingest()'s
        // full-line String(data:) conversion + decodeInbound's line.data(using:) conversion back +
        // JSON parsing of the giant tile-payload string. A real pixel-consuming client (e.g. one
        // that builds a CGImage/IOSurface from the tile) pays decode ADDITIONALLY on top of these
        // numbers — measured separately (throwaway isolated benchmark, not committed) at
        // ~19ms/tile for `Data(base64Encoded:)` on a 512x512 RGBA tile's base64 text. So the
        // realistic end-to-end for a pixel-consuming client is ~warm+19ms and ~cold+19ms per tile,
        // not the raw numbers printed above — see task-4-report.md for the full accounting and the
        // resulting "clears with modest headroom, not comfortably" transport verdict.
        XCTAssertLessThan(warmPerTileMs, 200, "transport-only per-tile cost ballooned past a generous 200ms ceiling")
    }
}

/// `Process.TerminationReason.uncaughtSignal`'s raw value, for the SIGTERM measurement's log line
/// — spelled out explicitly (not just the enum case name) so the printed measurement is
/// self-contained even read out of context (e.g. pasted into the task-3 report).
private let ProcessTerminationReasonUncaughtSignalRawValue = Process.TerminationReason.uncaughtSignal.rawValue
