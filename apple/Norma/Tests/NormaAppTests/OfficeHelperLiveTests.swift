import XCTest
import CryptoKit
import AppKit
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
    /// Office Stage B Task 1 — the checked-in seatbelt profile SOURCE, passed via `--sandbox-profile`
    /// (DEBUG-only override, mirrors `--lok-root` exactly) so the standalone `BUILT_PRODUCTS_DIR`
    /// helper this file mostly spawns can find it without a full app embed. Never used by
    /// `testEmbeddedRootBootsAgainstTheRealBuiltAppAndBundleStaysUntouched`, which passes `nil`
    /// deliberately — that test's whole point is exercising `resolveSandboxProfilePath()`'s own
    /// DEFAULT (no-override) resolution against the real embedded `Contents/Resources/office-helper.sb`.
    private static var repoSandboxProfilePath: URL {
        repoRoot.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
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
        captureStderr: Bool = false,
        // Office Stage B Task 1 — defaults ON (the repo-checked-in profile source), same
        // always-pass-unless-embedded-root posture `installRoot` already has: EVERY test in this
        // file that does not explicitly override this spawns a FULLY SANDBOXED helper, with no
        // per-test change needed — "default sandboxed everywhere, including all live tests" is true
        // by construction, not by each test opting in. `nil` is reserved for
        // `testEmbeddedRootBootsAgainstTheRealBuiltAppAndBundleStaysUntouched`, which needs
        // main.swift's own DEFAULT (no `--sandbox-profile` override) resolution exercised for real.
        sandboxProfilePath: URL? = OfficeHelperLiveTests.repoSandboxProfilePath
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
        if let sandboxProfilePath { arguments += ["--sandbox-profile", sandboxProfilePath.path] }
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

    // MARK: - Office Stage B Task 1: lock-file probe (the seatbelt's own carried branch)
    //
    // Task 1 brief's own decision point: LOK's convention for a document opened for editing is to
    // write a sibling `.~lock.<name>#` marker beside it. Pre-seatbelt (this helper, today) that
    // write succeeds silently — nothing in Stage A ever noticed because nothing was watching for
    // it. Once the write fence denies anything outside `--state-path` (this task's own job), the
    // brief's own ruling is explicit: LOK must be observed to WARN-AND-CONTINUE (never widen the
    // fence to cover document directories) — and if it does not, the fix is a LOK-side knob that
    // stops the write from being attempted at all, not a wider fence.
    //
    // This test asserts the END-STATE invariant that must hold EITHER way: after opening a document
    // that lives in an ordinary writable directory (never `--state-path`), no `.~lock.*#` sibling
    // exists, and the open itself still succeeded. A pre-fence run against the then-unsandboxed
    // helper (this test's own first run, before `office-helper.sb`/main.swift's sandbox wiring
    // existed) confirmed the assertion was genuinely RED — LOK really does write the lock file when
    // nothing stops it — and this test now runs sandboxed BY DEFAULT (`spawnLiveHelper`'s own
    // `sandboxProfilePath` default), where it is GREEN: the warn-and-continue branch fired, not the
    // disable-at-source one — see task-1-report.md for both runs' evidence in full.
    func testOpeningADocumentInAWritableDirectoryLeavesNoLockFileBeside() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()

        let scratchDir = makeScratchDirectory()
        let fixtureData = try Data(contentsOf: Self.fixturesRoot.appendingPathComponent("gate.docx"))
        let docPath = scratchDir.appendingPathComponent("editable-gate.docx")
        try fixtureData.write(to: docPath)
        let lockPath = scratchDir.appendingPathComponent(".~lock.editable-gate.docx#")

        let docId = UUID().uuidString
        let metadata = try await helper.client.open(docId: docId, path: docPath.path)
        XCTAssertEqual(metadata.type, .text, "setup: gate.docx must still open as a text document")

        // A generous settle window — LOK's own lock-file write (if it happens at all) is
        // synchronous with `documentLoad`/`initializeForRendering` in every LO embedding this repo
        // has observed, but this gives any deferred-write implementation a fair chance to have
        // acted before this test reads the directory.
        try? await Task.sleep(nanoseconds: 500_000_000)

        let lockExistsWhileOpen = FileManager.default.fileExists(atPath: lockPath.path)
        let siblingsWhileOpen = (try? FileManager.default.contentsOfDirectory(atPath: scratchDir.path)) ?? []
        print("[lock-file probe] while open: lockExists=\(lockExistsWhileOpen) siblings=\(siblingsWhileOpen)")

        try await helper.client.close(docId: docId)
        try? await Task.sleep(nanoseconds: 200_000_000)
        let lockExistsAfterClose = FileManager.default.fileExists(atPath: lockPath.path)
        print("[lock-file probe] after close: lockExists=\(lockExistsAfterClose)")

        XCTAssertFalse(lockExistsWhileOpen, "no .~lock.*# sibling may exist while the document is open under the "
                        + "seatbelt — either LOK warn-and-continues past a denied write (fence stays narrow) or "
                        + "lock-file creation is disabled at the source (see LOKBridge's user-profile config)")
        XCTAssertFalse(lockExistsAfterClose, "no .~lock.*# sibling may exist after close either")
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

    // MARK: - Office Stage B Task 7 — autosave/ is the ONE state-path directory NOT wholesale-swept

    /// **The load-bearing counterpart to the sweep test immediately above — same two-sequential-
    /// boots-same-state-path shape, opposite claim.** `docs/`/`saves/` are wiped unconditionally at
    /// every boot (`LOKBridge.sweepStaleDocumentDirectories`, proven implicitly by every save/stage
    /// test in this file leaving no cross-boot leftovers) because nothing they hold survives being
    /// deleted — a staged copy re-stages, a rendered save is a one-shot temp already relocated.
    /// `autosave/` is the opposite: whatever is sitting there when a helper boots is the ONE thing a
    /// crash-recovery feature exists to NOT delete out from under the app's own next-open check.
    /// Proves this the SAME way `testStaleProfileDirectoriesAreSweptOnTheNextBootOfTheSameStatePath`
    /// proves the wipe: a file placed under the FIRST boot's own `autosave/`, that boot SIGKILLed
    /// (matching how a dead helper actually goes away once LOK is loaded — carry #4), a SECOND
    /// helper booted against the exact same `--state-path`, and the file still there afterward.
    ///
    /// Deliberately does not need a REAL autosaved sidecar (no wire traffic, no LOK document, no
    /// dirty timer) — `LOKBridge.init`'s own boot-time sweep call runs unconditionally, before
    /// anything document-shaped ever happens, so a bare marker file already proves the claim: this
    /// directory is either swept at boot or it is not, independent of what created its contents.
    func testAutosaveDirectorySurvivesAcrossASIGKILLAndRespawnUnlikeDocsAndSaves() async throws {
        try skipUnlessVendorPresent()
        let sharedStateDir = makeScratchDirectory()

        let first = try await spawnLiveHelper(stateDir: sharedStateDir)
        let autosaveDir = sharedStateDir.appendingPathComponent("autosave", isDirectory: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: autosaveDir.path),
                      "the boot-time sweep call (which also CREATES this directory, mirroring "
                      + "docs/saves) must have run")
        let markerPath = autosaveDir.appendingPathComponent("crashed-doc.odt")
        try "unsaved content from before the crash".write(to: markerPath, atomically: true, encoding: .utf8)

        // SIGKILL — matching the sweep test immediately above, and production
        // (`OfficeHelperSupervisor.forceKill`, carry #4) — confirmed fully reaped before the
        // second boot starts, so the "one live helper per state-path at a time" safety argument
        // both sweeps' own headers rely on genuinely holds.
        let killResult = kill(first.process.processIdentifier, SIGKILL)
        XCTAssertEqual(killResult, 0, "setup: kill(SIGKILL) syscall itself failed: errno \(errno)")
        first.process.waitUntilExit()
        let firstDied = await waitUntil(timeout: 5.0) { !first.process.isRunning }
        XCTAssertTrue(firstDied, "setup: first helper must be fully dead before the second boots against the same state path")

        let second = try await spawnLiveHelper(stateDir: sharedStateDir)

        XCTAssertEqual(try String(contentsOf: markerPath, encoding: .utf8), "unsaved content from before the crash",
                       "autosave/ must survive a crash+respawn — deleting it here is deleting the "
                       + "evidence crash recovery exists to find")

        // The sweep must not have left the second helper in a broken state.
        let docId = UUID().uuidString
        let metadata = try await second.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        XCTAssertEqual(metadata.type, .spreadsheet, "the second helper must still be fully functional")
        try await second.client.close(docId: docId)
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

        let helper = try await spawnLiveHelper(helperURL: embeddedHelperURL, installRoot: nil, sandboxProfilePath: nil)
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

    // Task 5.5: no base64 to decode anymore — `onTile` hands over raw pixel `Data` directly.
    private static func sha256Hex(_ raw: Data) -> String {
        SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
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

    // MARK: - Task 4, criteria 1+2+3: a real edit's raw INVALIDATE_TILES, its rects->keys
    // translation, and the resulting generation bump — all against ONE real edit, one still-open
    // document (spawning a fresh sandboxed helper is this file's expensive part; combining what
    // naturally shares one edit keeps the suite's wall-clock reasonable without weakening any one
    // criterion's own assertion).

    /// **Methodological note, preserved from this test's own earlier probe form.** The FIRST attempt
    /// opened `gate.ods` directly from the checked-in fixtures directory and observed NOTHING — no
    /// `INVALIDATE_TILES`, `ModifiedStatus` staying `false` — which read, on paper, like LOK's own
    /// unipoll/event-queueing model (`SfxLokHelper::postKeyEventAsync`, LibreOffice core source,
    /// read directly) might require a pump this dedicated-thread architecture never runs (`LOKBridge`
    /// never calls `runLoop`, the one thing that flips `vcl::lok::isUnipoll()` true). That theory was
    /// WRONG: the real cause was T2's own already-documented trap — a document opened from OUTSIDE
    /// `--state-path`, under this sandboxed helper, loads READ-ONLY (`LOKBridge.swift`'s
    /// `disableDocumentLockFile` header has the full account; `paste()`/`postKeyEvent` both still
    /// "succeed" against the in-memory model, but the modified flag can never flip against a
    /// read-only medium). Against a properly STAGED (inside `--state-path`) writable copy, a posted
    /// key applies promptly, with NO pump needed — proven by every assertion below, none of which
    /// needed a follow-up "unrelated LOK call" to make anything happen.
    func testARealEditFiresInvalidateTilesTranslatesToTheSameKeysTheStoreWouldAndBumpsTheGeneration() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper(captureStderr: true)

        var invalidatedEventPushes: [(rects: [OfficeTwipsRect], part: Int)] = []
        var invalidatedKeyPushes: [[TileKey]] = []
        let pushLock = NSLock()
        helper.client.onDocumentEvent = { _, event in
            guard case .invalidated(let rects, let part) = event else { return }
            pushLock.lock(); invalidatedEventPushes.append((rects, part)); pushLock.unlock()
        }
        helper.client.onInvalidated = { _, _, keys in
            pushLock.lock(); invalidatedKeyPushes.append(keys); pushLock.unlock()
        }

        // T2's own root-caused finding — see this test's own header. The copy must land INSIDE this
        // spawned helper's OWN `--state-path` (`helper.stateDir`), mirroring
        // `OfficeRuntime.stageDocument`'s real staging directory.
        let stagedPath = helper.stateDir.appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("gate-writable.ods").path
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: stagedPath).deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contentsOf: Self.fixturesRoot.appendingPathComponent("gate.ods")).write(to: URL(fileURLWithPath: stagedPath))

        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: stagedPath)

        let zoomPPT = 1000
        let originKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 5120) // exactly one tile span
        _ = try await helper.client.subscribeTiles(docId: docId, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)

        final class OriginTileCollector: @unchecked Sendable {
            private let lock = NSLock()
            private var pushes: [(generation: Int, pixels: Data)] = []
            func record(generation: Int, pixels: Data) { lock.lock(); pushes.append((generation, pixels)); lock.unlock() }
            func snapshot() -> [(generation: Int, pixels: Data)] { lock.lock(); defer { lock.unlock() }; return pushes }
        }
        let collector = OriginTileCollector()
        helper.client.onTile = { _, _, key, generation, _, _, pixels in
            guard key == originKey else { return }
            collector.record(generation: generation, pixels: pixels)
        }

        // Baseline paint, before any edit.
        try await helper.client.requestTiles(docId: docId, keys: [originKey])
        let baselineArrived = await waitUntil(timeout: 10) { collector.snapshot().count >= 1 }
        XCTAssertTrue(baselineArrived, "expected a baseline .tile push before any edit")
        let baseline = try XCTUnwrap(collector.snapshot().first)
        XCTAssertEqual(baseline.generation, 0, "a document's first-ever paint of any coordinate starts at generation 0")

        // The real edit: click inside A1 (its own bounding rect observed live, in this same test's
        // earlier probe form, as roughly "0, 0, 1265, 254" — (100, 100) twips is safely inside it),
        // type one character, commit it with Return (Calc's own cell-edit commit — ends the pending
        // edit rather than leaving it in-flight for anything after this to race).
        try await helper.client.postMouse(docId: docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 65, keyCode: 512) // 'A', KEY_A
        try await helper.client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 65, keyCode: 512)
        try await helper.client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280) // Return commits the cell edit
        try await helper.client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280)

        let invalidationArrived = await waitUntil(timeout: 10) { !invalidatedEventPushes.isEmpty && !invalidatedKeyPushes.isEmpty }
        XCTAssertTrue(invalidationArrived, "the edit must produce both the raw documentEvent push (to the "
                      + "opener) and the translated .invalidated key push (to the subscriber)")

        // CRITERION 1 — the 5-value part payload parses under LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK.
        let rawLines = (helper.stderrCapture?.linesSnapshot() ?? []).filter {
            $0.contains("[LOKBridge raw callback]") && $0.contains(" type=0 ")
        }
        XCTAssertFalse(rawLines.isEmpty, "expected at least one real LOK_CALLBACK_INVALIDATE_TILES firing")
        let firstRawLine = try XCTUnwrap(rawLines.first)
        let payloadRange = try XCTUnwrap(firstRawLine.range(of: " payload="))
        let rawPayload = String(firstRawLine[payloadRange.upperBound...])
        let fields = rawPayload.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        // Disclosed, real finding: this vendored LOK build's own real firing carries 6 fields, not
        // 5 ("x, y, width, height, part, <unidentified 6th value — always observed 0>") — the
        // header doc comment's own "@see LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK" names only the
        // part as position 5; the parser's own `fields.count >= 5` leniency (never `== 5`) already
        // covers this without any change, but the ASSERTION here is intentionally `>= 5`, not `==
        // 5`, so it stays true to what was actually observed rather than overclaiming a field count
        // no real firing in this codebase has ever produced.
        XCTAssertGreaterThanOrEqual(fields.count, 5, "criterion 1: a real firing must carry the part as a "
                                    + "5th value — observed \(fields.count) fields: \"\(rawPayload)\"")
        guard case .invalidated(_, let parsedPart) = OfficeDocumentEvent.parseInvalidateTiles(rawPayload) else {
            return XCTFail("criterion 1: the real \(fields.count)-value payload failed to parse: \"\(rawPayload)\"")
        }
        XCTAssertEqual(parsedPart, 0, "criterion 1: the real part value (position 4) parses correctly — "
                       + "gate.ods is single-part (the six-format matrix's own pin), so 0 is the only "
                       + "legitimate value a correct parser could report here")

        // CRITERION 2 — rects->keys against REAL LOK coordinates: the raw rects the OPENER's own
        // documentEvent push carried, independently run through the SAME TileMath the store itself
        // uses, must equal the keys the SUBSCRIBER's own .invalidated push actually reported —
        // proving the server's real rect->key translation (TileCache.invalidate ->
        // OfficeHelperServer's multicast) agrees with TileMath's own authority, against genuine LOK
        // numbers, not hand-built test fixtures.
        let firstEventPush = try XCTUnwrap(invalidatedEventPushes.first)
        let expectedKeys = Set(firstEventPush.rects.flatMap { rect in
            TileMath.tileCoordinates(rectTwips: rect, zoomPPT: zoomPPT).map {
                TileKey(part: firstEventPush.part, zoomPPT: zoomPPT, tileX: $0.tileX, tileY: $0.tileY)
            }
        })
        let actualKeys = Set(invalidatedKeyPushes.first ?? [])
        XCTAssertFalse(expectedKeys.isEmpty, "criterion 2 setup: the real edit's own rect must touch at least one tile")
        XCTAssertEqual(actualKeys, expectedKeys, "criterion 2: the server's real rect->key translation must "
                       + "match TileMath's own independently-computed key set for the SAME real rect")
        XCTAssertTrue(actualKeys.contains(originKey), "criterion 2: the edited cell (A1, inside the origin "
                      + "tile) must be among the bumped keys")

        // CRITERION 3 — same-document generation bump + a genuinely differing hash, on the
        // STILL-OPEN doc (no close/reopen — that is
        // `testReloadOfAModifiedFixtureCopyProducesADifferentTileHashAtTheSameCoordinates`'s own,
        // different proof, which explicitly does NOT establish this).
        try await helper.client.requestTiles(docId: docId, keys: [originKey])
        let repaintArrived = await waitUntil(timeout: 10) { collector.snapshot().count >= 2 }
        XCTAssertTrue(repaintArrived, "expected a SECOND .tile push for the origin key after the real edit")
        let repainted = collector.snapshot()[1]
        XCTAssertGreaterThan(repainted.generation, baseline.generation, "criterion 3: a real edit-triggered "
                             + "invalidation must bump the generation on the SAME open document")
        XCTAssertNotEqual(repainted.pixels, baseline.pixels, "criterion 3: the typed character must be "
                          + "visibly different — the same tile coordinate, genuinely different pixels")

        try await helper.client.close(docId: docId)
    }

    // MARK: - Task 4, criterion 4: multicast delivery against the REAL bridge (two connections)

    /// The REAL-bridge counterpart to `OfficeSupervisorTests
    /// .testMulticastInvalidationReachesBothSubscribersWithPerConnectionSeqAndCloseByNonOwnerIsRefused`
    /// (that test's own trigger is `NormaOfficeHelperFixture`'s synthetic `--mode multicastInvalidate`
    /// hook — proves the WIRE-LEVEL fan-out mechanics without booting real LOK). This test proves the
    /// same fan-out against a REAL edit: connection A opens+stages the document and subscribes;
    /// connection B (never the opener) subscribes to the SAME doc; a REAL keystroke posted on A's
    /// connection must multicast its `.invalidated` push to BOTH.
    func testMulticastInvalidationFromARealEditReachesBothSubscribersAgainstTheRealBridge() async throws {
        try skipUnlessVendorPresent()
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run — add it to the scheme's build list.")
        let stateDir = makeScratchDirectory()
        let socketPath = stateDir.appendingPathComponent("office.sock").path
        let token = "officelive-multicast-\(UUID().uuidString.prefix(8))"

        let process = Process()
        process.executableURL = helperURL
        process.arguments = ["--socket-path", socketPath, "--state-path", stateDir.path,
                              "--token", token, "--idle-exit-seconds", "30",
                              "--lok-root", Self.vendorProductSetRoot.path,
                              "--sandbox-profile", Self.repoSandboxProfilePath.path]
        try process.run()
        runningProcesses.append(process)
        let socketAppeared = await waitUntil(timeout: 60.0) { FileManager.default.fileExists(atPath: socketPath) }
        XCTAssertTrue(socketAppeared, "real helper never created its socket file")

        // Staged copy INSIDE --state-path — see the sibling criteria-1/2/3 test's own header for why.
        let stagedPath = stateDir.appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("gate-writable.ods").path
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: stagedPath).deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contentsOf: Self.fixturesRoot.appendingPathComponent("gate.ods")).write(to: URL(fileURLWithPath: stagedPath))

        let docId = UUID().uuidString
        let zoomPPT = 1000
        let originKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 5120)

        // Connection A: opens (becomes the OWNER), subscribes, paints the origin tile so the real
        // invalidation below has something already-cached to bump (an empty cache has nothing to
        // report — the sibling criteria-1/2/3 test's own baseline-paint step, for the same reason).
        let connectionA = OfficeWireConnection(socketPath: socketPath)
        openConnections.append(connectionA)
        try await connectionA.open()
        try await connectionA.send(.hello(seq: 1, role: .app, token: token))
        guard case .helloOk = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A hello failed") }
        try await connectionA.send(.open(seq: 2, docId: docId, path: stagedPath))
        guard case .opened = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A open failed") }
        try await connectionA.send(.subscribeTiles(seq: 3, docId: docId, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport))
        guard case .subscribed = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A subscribe failed") }

        final class PushCollector: @unchecked Sendable {
            private let lock = NSLock()
            private var invalidations: [[TileKey]] = []
            private var tileCount = 0
            func record(_ keys: [TileKey]) { lock.lock(); invalidations.append(keys); lock.unlock() }
            func recordTile() { lock.lock(); tileCount += 1; lock.unlock() }
            func snapshot() -> [[TileKey]] { lock.lock(); defer { lock.unlock() }; return invalidations }
            func tileCountSnapshot() -> Int { lock.lock(); defer { lock.unlock() }; return tileCount }
        }
        let collectorA = PushCollector()
        let collectorB = PushCollector()
        connectionA.onInvalidated = { _, _, keys in collectorA.record(keys) }
        // `.tile` is a PUSH, never delivered through `nextFrame`/`frameQueue` — see
        // `OfficeWireConnection.onTile`'s own header. `OfficeSupervisorTests`' own multicast test
        // (the fixture-backed sibling this one mirrors) uses the identical callback+poll shape.
        connectionA.onTile = { _, _, _, _, _, _, _ in collectorA.recordTile() }

        try await connectionA.send(.tileRequest(seq: 4, docId: docId, keys: [originKey]))
        guard case .tileRequestAccepted = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A tileRequest not accepted") }
        let sawOriginTile = await waitUntil(timeout: 10.0) { collectorA.tileCountSnapshot() >= 1 }
        XCTAssertTrue(sawOriginTile, "expected A's own baseline .tile push for the origin key")

        // Connection B: never opens — only subscribes to the doc A already opened, the SAME shape
        // the fixture-backed multicast test already established.
        let connectionB = OfficeWireConnection(socketPath: socketPath)
        openConnections.append(connectionB)
        try await connectionB.open()
        try await connectionB.send(.hello(seq: 1, role: .app, token: token))
        guard case .helloOk = await connectionB.nextFrame(timeout: 10.0) else { return XCTFail("B hello failed") }
        try await connectionB.send(.subscribeTiles(seq: 2, docId: docId, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport))
        guard case .subscribed = await connectionB.nextFrame(timeout: 10.0) else { return XCTFail("B subscribe failed") }
        connectionB.onInvalidated = { _, _, keys in collectorB.record(keys) }

        // The real edit, posted on A's own connection — a click + one character + Return, the same
        // shape the sibling criteria test uses.
        let seqAllocator = OfficeWireSeqAllocator()
        func sendA(_ build: (UInt64) -> OfficeWireFrame) async throws {
            let seq = seqAllocator.nextSeq() + 10 // clear of A's own earlier hand-minted seqs above
            try await connectionA.send(build(seq))
        }
        try await sendA { .mouseEvent(seq: $0, docId: docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0) }
        guard case .mouseEventOk = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A mouseDown not acked") }
        try await sendA { .mouseEvent(seq: $0, docId: docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0) }
        guard case .mouseEventOk = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A mouseUp not acked") }
        try await sendA { .keyEvent(seq: $0, docId: docId, part: 0, type: .keyInput, charCode: 65, keyCode: 512) }
        guard case .keyEventOk = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A keyDown not acked") }
        try await sendA { .keyEvent(seq: $0, docId: docId, part: 0, type: .keyUp, charCode: 65, keyCode: 512) }
        guard case .keyEventOk = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A keyUp not acked") }
        try await sendA { .keyEvent(seq: $0, docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280) }
        guard case .keyEventOk = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A Return not acked") }
        try await sendA { .keyEvent(seq: $0, docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280) }
        guard case .keyEventOk = await connectionA.nextFrame(timeout: 10.0) else { return XCTFail("A Return-up not acked") }

        let bothReceived = await waitUntil(timeout: 10.0) {
            !collectorA.snapshot().isEmpty && !collectorB.snapshot().isEmpty
        }
        XCTAssertTrue(bothReceived, "criterion 4: both subscribers must receive the SAME real edit's "
                      + "invalidated push — the multicast fan-out, against the real bridge, not the fixture")
        let keysA = Set(collectorA.snapshot().first ?? [])
        let keysB = Set(collectorB.snapshot().first ?? [])
        XCTAssertEqual(keysA, keysB, "criterion 4: both subscribers must see the IDENTICAL bumped key set "
                       + "for the same underlying invalidation")
        XCTAssertTrue(keysA.contains(originKey), "criterion 4: the edited cell's own tile must be among them")

        try await connectionA.send(.close(seq: 99, docId: docId))
        _ = await connectionA.nextFrame(timeout: 10.0)
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
            private var pushes: [(generation: Int, pixels: Data)] = []
            func record(generation: Int, pixels: Data) {
                lock.lock(); pushes.append((generation, pixels)); lock.unlock()
            }
            func snapshot() -> [(generation: Int, pixels: Data)] {
                lock.lock(); defer { lock.unlock() }; return pushes
            }
        }
        let collector = TileCollector()
        helper.client.onTile = { _, _, _, generation, _, _, pixels in collector.record(generation: generation, pixels: pixels) }

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
        print("[reload drill] before (original, orange fill): generation=\(beforePush.generation) sha256=\(Self.sha256Hex(beforePush.pixels))")
        print("[reload drill] after  (modified, blue fill):   generation=\(afterPush.generation) sha256=\(Self.sha256Hex(afterPush.pixels))")

        XCTAssertEqual(beforePush.generation, 0, "a fresh document's first-ever paint of any coordinate starts at generation 0")
        XCTAssertEqual(afterPush.generation, 0, "the RE-OPENED docId gets a BRAND NEW TileRenderer/TileCache — also starts at 0, "
                        + "not a continuation of the prior open's generation (see this test's own header)")
        XCTAssertNotEqual(beforePush.pixels, afterPush.pixels,
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
            let lock = NSLock(); var pixelsByKey: [TileKey: Data] = [:]
            func record(_ key: TileKey, _ pixels: Data) { lock.lock(); pixelsByKey[key] = pixels; lock.unlock() }
            func snapshot() -> [TileKey: Data] { lock.lock(); defer { lock.unlock() }; return pixelsByKey }
        }
        let box = Box()
        helper.client.onTile = { _, _, key, _, _, _, pixels in box.record(key, pixels) }
        try await helper.client.requestTiles(docId: docId, keys: Array(firstSubscribed))
        let allArrived = await waitUntil(timeout: 10.0) { box.snapshot().count >= firstSubscribed.count }
        XCTAssertTrue(allArrived, "expected a .tile push for every key in the first subscribe's own reported set")

        let firstPixels = box.snapshot()
        for (key, pixels) in firstPixels {
            XCTAssertEqual(pixels.count, TileMath.bytesPerTile, "\(key): tile byte count")
        }
        // At least the origin tile (which the six-format matrix already knows carries real
        // "NORMA GATE" content) must be non-blank; edge tiles at this viewport's far corners may
        // legitimately be blank if gate.xlsx's content doesn't reach that far — asserting non-blank
        // on the ORIGIN tile specifically is the honest, content-aware version of "non-blank."
        let originKey = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let originPixels = try XCTUnwrap(firstPixels[originKey])
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

    // MARK: - Fix round 1: the helper survives hostile wire-supplied tile geometry
    //
    // A reviewer transcribed and RAN three concrete inputs against the pre-fix code that trapped
    // the real helper process (SIGTRAP, exit 133) — killing every open document on every
    // connection, not just the offending request. These three tests drive the SAME class of input
    // over the REAL wire against the REAL live helper (not the fixture — the fixture's synthetic
    // bridge never touched the overflowing arithmetic to begin with) and assert a refusal FRAME,
    // never a crash — then prove the helper is still alive and answering by pinging it afterward,
    // which is the actual invariant this whole fix round exists to restore.

    /// Trap #1 (`indexRange`'s old unchecked `origin + length - 1`) driven through `subscribeTiles`:
    /// a viewport whose `x` sits 5 twips short of `Int64.max`, so adding even a tiny `width`
    /// overflows the arithmetic the OLD code used to compute which tiles it covers.
    func testHostileSubscribeTilesViewportOverflowIsRefusedAndTheHelperSurvives() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)

        let hostileViewport = OfficeTwipsRect(x: Int64.max - 5, y: 0, width: 100, height: 5120)
        do {
            _ = try await helper.client.subscribeTiles(docId: docId, part: 0, zoomPPT: 1000, viewportTwips: hostileViewport)
            XCTFail("expected a server refusal for an overflowing viewport, got a successful subscribe")
        } catch OfficeHelperClientError.serverError(let reason) {
            XCTAssertEqual(reason, "viewportTooLarge")
        }

        // The actual invariant this fix round restores: the helper is STILL ALIVE and answering —
        // a SIGTRAP here would have taken the whole process down, and this `ping` would either hang
        // (dead peer) or the connection would already be closed.
        try await helper.client.ping()
        try await helper.client.close(docId: docId)
    }

    /// Trap #2's NON-trapping variant (the reviewer's own "38 billion keys" measurement): a
    /// REPRESENTABLE-but-huge viewport — every intermediate count is a valid, non-overflowing
    /// Int64 value, so this is refused purely for exceeding `TileMath.maxTilesPerRectEnumeration`,
    /// distinctly from the overflow case above (see `TileMathTests.testEstimatedTileCountAllFour
    /// Outcomes` for the pure-math proof these are different code paths). Without the cap, this
    /// would attempt to enumerate roughly 1e14 tile keys building the `subscribed` reply.
    func testHugeButRepresentableViewportIsCappedNotEnumeratedAndTheHelperSurvives() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)

        let hugeViewport = OfficeTwipsRect(x: 0, y: 0, width: 5120 * 10_000_000, height: 5120 * 10_000_000)
        do {
            _ = try await helper.client.subscribeTiles(docId: docId, part: 0, zoomPPT: 1000, viewportTwips: hugeViewport)
            XCTFail("expected a server refusal for a huge viewport, got a successful subscribe")
        } catch OfficeHelperClientError.serverError(let reason) {
            XCTAssertEqual(reason, "viewportTooLarge")
        }

        try await helper.client.ping()
        try await helper.client.close(docId: docId)
    }

    /// Trap #2's TRAPPING variant, over the real wire — the coordinator's own instruction was to
    /// drive each of the three trap inputs over the wire; the two tests above cover trap #1 and
    /// trap #2's non-trapping OOM sibling, but not this, the actual `estimatedTileCount`
    /// multiplication-overflow branch itself. At the finest allowed zoom (`TileMath.maxZoomPPT`,
    /// span == 5 twips/tile) a length just under `Int64.max / 2` keeps `indexRange` itself
    /// representable (~4.6e18 twips, under `Int64.max`'s ~9.2e18) but produces a per-axis tile
    /// count around 9.2e17 — squaring that for a 2D viewport overflows `Int64` in the
    /// multiplication itself (see `TileMathTests.testEstimatedTileCountAllFourOutcomes`'s case (d)
    /// for the exact same shape proven purely). A handler-valid `zoomPPT` (comfortably inside
    /// `isZoomPPTValid`'s range) is the point — this must be refused by the OVERFLOW check inside
    /// `estimatedTileCount`, not by the earlier `isZoomPPTValid` guard.
    func testOverflowingViewportAtTheFinestValidZoomIsRefusedAndTheHelperSurvives() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)

        let overflowingViewport = OfficeTwipsRect(x: 0, y: 0, width: Int64.max / 2 - 1, height: Int64.max / 2 - 1)
        do {
            _ = try await helper.client.subscribeTiles(docId: docId, part: 0, zoomPPT: TileMath.maxZoomPPT, viewportTwips: overflowingViewport)
            XCTFail("expected a server refusal for a genuinely overflowing tile count, got a successful subscribe")
        } catch OfficeHelperClientError.serverError(let reason) {
            XCTAssertEqual(reason, "viewportTooLarge")
        }

        try await helper.client.ping()
        try await helper.client.close(docId: docId)
    }

    /// Trap #3 (`tileBoundsTwips`'s old unchecked `Int64(tileX) * span`) driven through
    /// `tileRequest`: ONE hostile key (`tileX: Int.max`) mixed into a batch alongside one normal
    /// key. The whole REQUEST is still accepted (`tileRequestAccepted`) — refusal happens per-key,
    /// matching this protocol's existing `.tile`/`.tileFailed` granularity, not a whole-batch
    /// rejection — so the normal key paints successfully while the hostile one fails cleanly.
    func testHostileTileRequestKeyFailsThatKeyAloneAndTheHelperSurvives() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)

        final class Outcomes: @unchecked Sendable {
            let lock = NSLock()
            var succeeded: [TileKey] = []
            var failed: [(TileKey, String)] = []
            func recordTile(_ key: TileKey) { lock.lock(); succeeded.append(key); lock.unlock() }
            func recordFailure(_ key: TileKey, _ reason: String) { lock.lock(); failed.append((key, reason)); lock.unlock() }
            func snapshot() -> (succeeded: [TileKey], failed: [(TileKey, String)]) {
                lock.lock(); defer { lock.unlock() }; return (succeeded, failed)
            }
        }
        let outcomes = Outcomes()
        helper.client.onTile = { _, _, key, _, _, _, _ in outcomes.recordTile(key) }
        helper.client.onTileFailed = { _, _, key, reason in outcomes.recordFailure(key, reason) }

        let normalKey = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let hostileKey = TileKey(part: 0, zoomPPT: 1000, tileX: Int.max, tileY: 0)
        try await helper.client.requestTiles(docId: docId, keys: [normalKey, hostileKey])

        let bothArrived = await waitUntil(timeout: 10.0) {
            let snapshot = outcomes.snapshot()
            return snapshot.succeeded.count >= 1 && snapshot.failed.count >= 1
        }
        XCTAssertTrue(bothArrived, "expected exactly one .tile push and one .tileFailed push")
        let final = outcomes.snapshot()
        XCTAssertEqual(final.succeeded, [normalKey])
        XCTAssertEqual(final.failed.map { $0.0 }, [hostileKey])

        try await helper.client.ping()
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
                var pushes: [Data] = []
                func record(_ pixels: Data) { lock.lock(); pushes.append(pixels); lock.unlock() }
                func snapshot() -> [Data] { lock.lock(); defer { lock.unlock() }; return pushes }
            }
            let box = Box()
            helper.client.onTile = { _, _, _, _, _, _, pixels in box.record(pixels) }

            // First request: real paint. Second, IDENTICAL request: a TileCache hit (stability).
            try await helper.client.requestTiles(docId: docId, keys: [key])
            let firstArrived = await waitUntil(timeout: 10.0) { box.snapshot().count >= 1 }
            XCTAssertTrue(firstArrived, "\(fixture): expected a .tile push")
            try await helper.client.requestTiles(docId: docId, keys: [key])
            let secondArrived = await waitUntil(timeout: 5.0) { box.snapshot().count >= 2 }
            XCTAssertTrue(secondArrived, "\(fixture): expected a SECOND .tile push (cache hit)")

            let pushes = box.snapshot()
            let raw = pushes[0]
            let second = pushes[1]
            XCTAssertEqual(raw, second, "\(fixture): pixel hash must be STABLE across two subscribes/requests")

            // Task 5.5: no base64 decode step anymore — `onTile` already hands over raw pixel
            // `Data`. This IS the tripwire the task exists to prove: hashing these bytes directly
            // (envelope changed, payload identical) must land on the EXACT SAME pinned hashes below
            // as rung 1's `Data(base64Encoded:)`-then-hash path did.
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
        // Task 5.5: `pixels.count` is now the REAL wire payload size (raw RGBA, no base64 inflation)
        // — see this test's own updated commentary below on what changed about these numbers.
        helper.client.onTile = { _, _, _, _, _, _, pixels in counter.record(byteCount: pixels.count) }

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
          Average wire payload: \(avgPayloadBytes) bytes/tile (raw RGBA — Task 5.5 rung 2: no base64 inflation, this IS the byte count on the wire)
        """)

        // The bar (per this task's own transport-decision framing): tile arrival is ASYNC over a
        // placeholder, not a 16ms-per-frame budget. A generous ceiling, not a tight pin — the
        // PRINTED numbers above are the real evidence this task's report cites; this just fails
        // the suite outright on a severe regression.
        //
        // Task 5.5 note (rung 2 supersedes the rung-1 accounting this comment used to carry):
        // `onTile` now hands over the pixel `Data` directly — `pixels.count` is the REAL wire byte
        // count with NOTHING left to decode afterward (no base64, no separate `Data(base64Encoded:)`
        // step a real pixel-consuming client would still owe under rung 1). warmPerTileMs/
        // coldPerTileMs are therefore the FULL, HONEST end-to-end numbers a real consumer sees —
        // socket transfer + ingest()'s header-line decode + payload-accumulation copy — with no
        // "+19ms" footnote to add on top the way rung 1's own version of this comment had to carry.
        // See task-5.5-report.md for the rung-1-vs-rung-2 before/after pair measured in the same
        // session as this comment's own ceiling below.
        XCTAssertLessThan(warmPerTileMs, 80, "transport-only per-tile cost ballooned past rung 2's own ceiling "
                            + "(measured ~26ms/tile under rung 1's base64-in-NDJSON; expect roughly raw-socket-plus-paint "
                            + "territory now, comfortably under this bar — see this test's own report entry for the real number)")
    }

    // MARK: - Task 4, I2/M4: the transport re-evaluation, measured against real edit traffic

    /// **Office Stage B Task 4 — the transport re-eval, measured, per the dispatch's own instruction:
    /// implement the bounded per-connection push queue ONLY if the numbers demand it.** Three
    /// scenarios, one spawned helper: (1) a type-burst ack-latency baseline on an otherwise-idle
    /// document; (2) the worst REALISTIC head-of-line case this codebase's own architecture actually
    /// has — a keystroke posted the instant a multi-tile paint batch is queued ahead of it on
    /// `LOKDedicatedThread` (never the `officeRequestQueue` app-side funnel, which this test does
    /// not exercise at all: that queue only orders SENDS, and `requestTiles`' own client call
    /// returns the moment `tileRequestAccepted` arrives, BEFORE any tile actually paints — see
    /// `OfficeHelperServer.handlePostAuthLine`'s `.tileRequest` case, `tileRequestAccepted` written
    /// before the paint loop starts. The REAL contention is `LOKDedicatedThread` itself: every
    /// `postKey`/`postMouse`/`paintTile` call — regardless of which app-side queue sent it —
    /// ultimately does `thread.sync { ... }`, and that thread runs exactly one job at a time,
    /// FIFO. A keystroke queued behind an already-in-flight 6-tile paint batch waits for every one
    /// of those 6 paints, not merely its own); (3) a `mouseDragged`-shaped burst (many `.move`
    /// posts in a row, the shape a real drag-select produces).
    func testTransportMeasurementTypeBurstMidPrefetchHeadOfLineAndDragBurstLatencies() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()

        let stagedPath = helper.stateDir.appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("gate-writable.ods").path
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: stagedPath).deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contentsOf: Self.fixturesRoot.appendingPathComponent("gate.ods")).write(to: URL(fileURLWithPath: stagedPath))
        let docId = UUID().uuidString
        _ = try await helper.client.open(docId: docId, path: stagedPath)
        try await helper.client.postMouse(docId: docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)

        // Scenario 1 — type-burst baseline, otherwise-idle document: 20 keystrokes, back to back,
        // each one's own full send-to-ack round trip timed individually.
        var typeBurstLatenciesMs: [Double] = []
        for _ in 0..<20 {
            let start = Date()
            try await helper.client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 65, keyCode: 512)
            typeBurstLatenciesMs.append(Date().timeIntervalSince(start) * 1000)
        }
        let typeBurstAvg = typeBurstLatenciesMs.reduce(0, +) / Double(typeBurstLatenciesMs.count)
        let typeBurstMax = typeBurstLatenciesMs.max() ?? 0

        // Scenario 2 — the worst realistic head-of-line case: queue a 6-tile paint batch (the
        // repo's own `OfficeTileCanvasView.prefetchChunkSize`), then IMMEDIATELY post one keystroke
        // — `tileRequestAccepted` returns before any of the 6 tiles paint, so this keystroke's own
        // `thread.sync` job genuinely lands BEHIND all 6 on the dedicated thread's queue.
        let prefetchKeys = (0..<6).map { TileKey(part: 0, zoomPPT: 1000, tileX: $0, tileY: 10) } // unpainted row, real cold paints
        try await helper.client.requestTiles(docId: docId, keys: prefetchKeys)
        let midPrefetchStart = Date()
        try await helper.client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 66, keyCode: 513)
        let midPrefetchLatencyMs = Date().timeIntervalSince(midPrefetchStart) * 1000

        // Scenario 3 — a mouseDragged-shaped burst: 40 `.move` posts in a row (a real drag-select
        // produces exactly this shape — one `postMouseEvent(LOK_MOUSEEVENT_MOUSEMOVE)` per dragged
        // pixel-ish delta), total elapsed AND per-call latency both recorded.
        let dragBurstStart = Date()
        var dragBurstLatenciesMs: [Double] = []
        for step in 0..<40 {
            let stepStart = Date()
            try await helper.client.postMouse(docId: docId, part: 0, type: .move, xTwips: Int64(100 + step * 20), yTwips: 100,
                                              count: 0, buttons: 1, modifiers: 0)
            dragBurstLatenciesMs.append(Date().timeIntervalSince(stepStart) * 1000)
        }
        let dragBurstTotalMs = Date().timeIntervalSince(dragBurstStart) * 1000
        let dragBurstAvg = dragBurstLatenciesMs.reduce(0, +) / Double(dragBurstLatenciesMs.count)

        try await helper.client.close(docId: docId)

        print("""
        [transport measurement, I2/M4] real edit traffic, one spawned helper, single connection:
          (1) TYPE-BURST (20 keystrokes, idle doc): avg \(String(format: "%.2f", typeBurstAvg))ms/keystroke, \
        max \(String(format: "%.2f", typeBurstMax))ms, total \(String(format: "%.1f", typeBurstLatenciesMs.reduce(0, +)))ms
          (2) MID-PREFETCH HEAD-OF-LINE (1 keystroke queued behind a 6-tile cold-paint batch): \
        \(String(format: "%.2f", midPrefetchLatencyMs))ms (vs. scenario 1's own \(String(format: "%.2f", typeBurstAvg))ms idle baseline — \
        the delta is this codebase's own real LOKDedicatedThread contention cost, not the app-side officeRequestQueue, which this test never touches)
          (3) DRAG-BURST (40 mousemove posts): \(String(format: "%.1f", dragBurstTotalMs))ms total, \
        avg \(String(format: "%.2f", dragBurstAvg))ms/move, \(String(format: "%.1f", 40.0 / (dragBurstTotalMs / 1000))) moves/sec effective
        """)

        // DECISION (task-4-report.md has the full writeup): informational assertions only — this is
        // a measurement, not a target. Every one of these completing without a timeout, on real
        // edit+paint traffic sharing one connection, is itself part of the evidence: nothing here
        // wedges the connection, even under the deliberately adversarial scenario 2.
        XCTAssertLessThan(typeBurstAvg, 200, "an idle-doc keystroke ack should not be anywhere near a "
                          + "human-perceptible lag floor (~100-200ms) — if this regresses past it, "
                          + "the bounded-queue redesign this task's own dispatch named becomes worth building")
        XCTAssertGreaterThan(midPrefetchLatencyMs, typeBurstAvg, "sanity: the adversarial scenario must "
                             + "actually BE slower than the idle baseline, or scenario 2 measured nothing real")
    }

    // MARK: - USER LIVE-GATE FIX #4, FIX 2 research: does LOK paint an infinite grid past documentSize?

    /// **Empirical, not documentary.** Today the canvas clamps its scrollable extent to
    /// `sizeTwips` (LOK's `getDocumentSize()` at open — the USED range), so a spreadsheet's grid
    /// stops where the content stops instead of continuing like Excel's own infinite empty grid. The
    /// only question that matters for whether extending the scrollable extent is even legitimate:
    /// does `paintPartTile` render something real (empty gridlines) for twips coordinates PAST
    /// `sizeTwips`, or blank/garbage? `TileRenderer.renderRaw` passes whatever bounds a key resolves
    /// to STRAIGHT to `paintPartTile` with no clamp against document size (only against
    /// `TileMath`'s own overflow-sanity bounds) — so this probe reaches real, unmodified LOK
    /// behavior, on OUR exact vendored pin, for OUR exact fixture. Requests three keys directly (no
    /// `subscribeTiles` viewport involved — that RPC's own viewport math is not what is being tested
    /// here): the ORIGIN tile (known non-blank content, the sanity baseline), one tile JUST past the
    /// used range (gate.xlsx is 26593x13005 twips at zoomPPT 1000 == 5120 twips/tile, so tile
    /// (5,2) is the last tile touching real content and (6,3) is the first tile entirely beyond it),
    /// and one FAR past it (tile (25,15), ~4x the document's own span beyond its edge). Dumps each as
    /// a PNG to a scratch directory (logged) for a direct visual read, and prints the raw distinct-
    /// color count each tile carries — a uniform single-color tile is unambiguous "blank"; more than
    /// a small handful of distinct colors in a regular pattern is the empirical signature of rendered
    /// gridlines. No assertion on the OUTCOME either way (this is `officeHarness`-style disclosure,
    /// the same posture `testFontconfigOverridePixelEffect...` already takes above) — only that the
    /// probe itself ran and produced real pixel data for every key.
    func testGateXlsxTilesPastTheUsedRangeEmpiricalInfiniteGridProbe() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper()
        let docId = UUID().uuidString
        let metadata = try await helper.client.open(docId: docId, path: Self.fixturesRoot.appendingPathComponent("gate.xlsx").path)
        print("[infinite-grid probe] gate.xlsx sizeTwips = \(metadata.sizeTwips.widthTwips) x \(metadata.sizeTwips.heightTwips)")

        final class Box: @unchecked Sendable {
            let lock = NSLock(); var pixelsByKey: [TileKey: Data] = [:]
            func record(_ key: TileKey, _ pixels: Data) { lock.lock(); pixelsByKey[key] = pixels; lock.unlock() }
            func snapshot() -> [TileKey: Data] { lock.lock(); defer { lock.unlock() }; return pixelsByKey }
        }
        let box = Box()
        helper.client.onTile = { _, _, key, _, _, _, pixels in box.record(key, pixels) }

        let originKey = TileKey(part: 0, zoomPPT: 1000, tileX: 0, tileY: 0)
        let justPastKey = TileKey(part: 0, zoomPPT: 1000, tileX: 6, tileY: 3)
        let farPastKey = TileKey(part: 0, zoomPPT: 1000, tileX: 25, tileY: 15)
        let probeKeys = [originKey, justPastKey, farPastKey]

        try await helper.client.requestTiles(docId: docId, keys: probeKeys)
        let arrived = await waitUntil(timeout: 15.0) { box.snapshot().count >= probeKeys.count }
        XCTAssertTrue(arrived, "expected a .tile push for every probe key")
        guard arrived else { try await helper.client.close(docId: docId); return }

        let pixelsByKey = box.snapshot()
        // Deliberately NOT `makeScratchDirectory()` — this run's whole point is a human (or an
        // agent's own Read-tool image view) looking at the PNGs AFTER the test finishes, and
        // `tearDown()` deletes every `scratchDirs` entry the moment this test method returns.
        let dumpDir = URL(fileURLWithPath: "/tmp/norma-livegate4-fix2-probe-pngs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dumpDir, withIntermediateDirectories: true)
        for (label, key) in [("origin-baseline", originKey), ("just-past-edge", justPastKey), ("far-past-edge", farPastKey)] {
            guard let pixels = pixelsByKey[key] else {
                XCTFail("\(label) tile (\(key.tileX),\(key.tileY)): no pixels arrived")
                continue
            }
            XCTAssertEqual(pixels.count, TileMath.bytesPerTile, "\(label): wrong byte count")
            let uniqueColors = Self.distinctRGBAColorCount(pixels)
            print("[infinite-grid probe] \(label) tile(\(key.tileX),\(key.tileY)): "
                    + "\(pixels.count) bytes, \(uniqueColors) distinct RGBA color(s)")
            if let png = Self.pngData(fromRGBARaw: pixels, side: TileMath.tilePixelSize) {
                let path = dumpDir.appendingPathComponent("gate-xlsx-tile-\(label)-\(key.tileX)x\(key.tileY).png")
                do {
                    try png.write(to: path)
                    print("[infinite-grid probe] wrote \(path.path)")
                } catch {
                    print("[infinite-grid probe] could not write PNG for \(label): \(error)")
                }
            } else {
                print("[infinite-grid probe] could not build a CGImage for \(label)")
            }
        }

        try await helper.client.close(docId: docId)
    }

    /// Distinct RGBA 32-bit color count across a raw pixel buffer — cheap, no image decode needed.
    private static func distinctRGBAColorCount(_ pixels: Data) -> Int {
        var colors = Set<UInt32>()
        var index = pixels.startIndex
        while index + 3 < pixels.endIndex {
            let value = (UInt32(pixels[index]) << 24) | (UInt32(pixels[index + 1]) << 16)
                        | (UInt32(pixels[index + 2]) << 8) | UInt32(pixels[index + 3])
            colors.insert(value)
            index += 4
        }
        return colors.count
    }

    /// Raw RGBA `Data` -> PNG `Data`, for a direct visual read of a probe tile — the same
    /// premultipliedLast/DeviceRGB construction `OfficeTileCanvasView.makeImage`/`TileRenderer` use
    /// for the real pixel path, re-wrapped through `NSBitmapImageRep` (test-only; production never
    /// needs a PNG, only the raw bytes straight into a `CGImage`).
    private static func pngData(fromRGBARaw pixels: Data, side: Int) -> Data? {
        guard pixels.count == side * side * 4, let provider = CGDataProvider(data: pixels as CFData) else { return nil }
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
        guard let image = CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32,
                                  bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: bitmapInfo,
                                  provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        let rep = NSBitmapImageRep(cgImage: image)
        return rep.representation(using: .png, properties: [:])
    }

    // MARK: - Office Stage B Task 2: a vendor-build limitation, found and pinned

    /// **Found while building Task 2's own live round-trip test, isolated by direct bisection
    /// (task-2-report.md has the full transcript): this vendored, from-source LibreOffice build's
    /// XLSX EXPORT filter does not work — `saveAs` against an xlsx destination `abort()`s the WHOLE
    /// HELPER PROCESS, independent of the seatbelt (reproduced identically with `--no-sandbox`),
    /// independent of any edit (reproduced on a completely untouched, freshly-opened document —
    /// `saveAs` alone is enough), and independent of the destination FORMAT STRING tried (`saveAs`'s
    /// own `pFormat`, both a literal LOK filter name and the bare-extension form `doc_saveAs`
    /// actually expects both reached this same crash once past the filter-resolution stage). ODF
    /// export (`calc8`/`writer8`/`impress8` — i.e. `.ods`/`.odt`/`.odp`) is unaffected — a real save,
    /// through this exact wire dispatch, produces a real, valid archive.
    ///
    /// **Root cause, corrected post-Task-2b (`ooxml-export-investigation.md` has the full
    /// backtrace): a missing dylib, not an unanswerable dialog.** The original write-up above
    /// attributed the crash to a LOK "Information" window callback this headless embedding has no
    /// way to answer — that theory is FALSIFIED: no window/dialog callback fires before the abort.
    /// The real mechanism is `product-set/Frameworks/` shipping without `libsal_textenclo.dylib`
    /// (59 dylibs present, none by that name), reached via a runtime `dlopen()` — not a link-time
    /// dependency, so it never showed up in a closure-recipe trace — inside the xlsx export path:
    /// `abort` -> `FullTextEncodingData::FullTextEncodingData()` -> `Impl_getTextEncodingData` ->
    /// `rtl_getBestWindowsCharsetFromTextEncoding` -> `XclFontData::FillFromVclFont` -> ... ->
    /// `doc_saveAs`. Also corrected: **`.pptx` export actually works** — confirmed via a different
    /// code path than xlsx's, never affected by the missing dylib above; only xlsx is pinned as
    /// reliably reproducing below, and this test's own scope was never "every OOXML format," only
    /// the ones it could verify (see the docx note ahead of the loop for why docx stays unpinned).
    ///
    /// This is a GAP IN THE VENDORED BINARY, not a bug in this task's own code — Stage A's own
    /// import-side testing (`testSixFormatsOpenWithSaneTypePartsAndSize`) never exercised export at
    /// all, so nothing before Task 2 had a reason to notice OOXML export specifically was never
    /// wired into whatever minimal LO module subset this vendor tree's from-source build selected.
    /// Task 2's own live round-trip test (`OfficeRuntimeLiveTests`) uses `.ods`/`.odt` — the two
    /// formats this environment can actually prove a save against — and this test is what PINS the
    /// limitation for the OOXML trio, so a future vendor tree rebuild that adds the missing filter
    /// module is a test going from skip-worthy-red to green, not a silent, unnoticed fix.
    ///
    /// **A pin, not an `XCTExpectFailure`**: this test asserts the CURRENT, real, disclosed behavior
    /// — ODF saves succeed, OOXML saves crash the helper — as a green test, the same posture this
    /// suite already takes toward the gate-table pixel hashes and the `gate.ods` width tolerance.
    /// The day a vendor tree rebuild adds a working OOXML export filter, the OOXML half of this test
    /// starts failing LOUDLY (the helper stays alive, `save` returns instead of the process dying),
    /// which is the correct trigger for a human to update this test's own claim, not a silent gap.
    func testKnownLimitationOOXMLExportIsNotAvailableInThisVendorBuildWhileODFExportWorks() async throws {
        try skipUnlessVendorPresent()

        // ODF: the real proof this task's own wire dispatch (save -> LOK saveAs -> a real file)
        // works end to end.
        for (fixture, format) in [("gate.ods", "ods"), ("gate.odt", "odt")] {
            let helper = try await spawnLiveHelper()
            let scratchDir = makeScratchDirectory()
            let docPath = scratchDir.appendingPathComponent("editable-\(fixture)").path
            try Data(contentsOf: Self.fixturesRoot.appendingPathComponent(fixture)).write(to: URL(fileURLWithPath: docPath))
            let docId = "odf-probe"
            _ = try await helper.client.open(docId: docId, path: docPath)
            let tempPath = try await helper.client.save(docId: docId, part: 0)
            XCTAssertTrue(FileManager.default.fileExists(atPath: tempPath), "\(fixture): saveAs must produce a real file")
            XCTAssertTrue(tempPath.hasSuffix(".\(format)"), "\(fixture): saved under its own format's extension")
            let size = (try? FileManager.default.attributesOfItem(atPath: tempPath)[.size] as? Int) ?? nil
            XCTAssertNotEqual(size, 0, "\(fixture): the saved file must have real content, not an empty stub")
        }

        // OOXML: the known, accepted gap — the helper process itself dies handling `saveAs`. Fired
        // as a detached Task (a synchronous `await` here would block on the client's own 15s
        // per-request timeout) and observed via `process.isRunning` instead, which is both faster
        // and the more direct claim ("the helper died"), matching this file's OWN established death-
        // detection idiom (`isProcessAlive`-style `kill(pid, 0)` polling used throughout this suite).
        //
        // `gate.xlsx` only — verified reliably (repeatedly, by hand, while isolating this finding:
        // task-2-report.md) to die within ~2s every time. `gate.docx` was observed inconsistently
        // (its own `saveAs` sometimes reports a real LOK-level `ERROR` callback rather than dying
        // outright within this test's own budget) — pinning an unreliable timing claim would make
        // this regression test itself flaky, which is worse than a narrower, fully-verified pin.
        for fixture in ["gate.xlsx"] {
            let helper = try await spawnLiveHelper()
            let scratchDir = makeScratchDirectory()
            let docPath = scratchDir.appendingPathComponent("editable-\(fixture)").path
            try Data(contentsOf: Self.fixturesRoot.appendingPathComponent(fixture)).write(to: URL(fileURLWithPath: docPath))
            let docId = "ooxml-probe"
            _ = try await helper.client.open(docId: docId, path: docPath)
            Task { _ = try? await helper.client.save(docId: docId, part: 0) }
            let died = await waitUntil(timeout: 15.0) { !helper.process.isRunning }
            XCTAssertTrue(died, "\(fixture): expected the KNOWN OOXML-export limitation to reproduce "
                          + "(the helper process dying) — if this timed out instead, either the "
                          + "limitation was fixed (update this test to assert success) or something "
                          + "NEW broke saveAs for OOXML formats specifically")
        }
    }

    // MARK: - Task 5: caret/selection/cell-cursor raw callback probe (the T4-lesson, applied again)

    /// **Task 5 — capture REAL payloads before writing a single parser line.** Mirrors
    /// `testRealLOKCallbackProbeCapturesRawPayloadsAndCrossChecksTheParsers`'s own methodology
    /// exactly (raw stderr capture of `LOKBridge.handleCallback`'s unconditional trace line), aimed
    /// at the five callback types this task's brief names: `LOK_CALLBACK_INVALIDATE_VISIBLE_CURSOR`
    /// (1), `LOK_CALLBACK_TEXT_SELECTION` (2), `_START` (3), `_END` (4), and `LOK_CALLBACK_CELL_CURSOR`
    /// (17).
    ///
    /// **Why more than one scenario per callback type — read this before trusting a single capture.**
    /// Source-reading ahead of this probe (LO core, pinned commit `11482c8f` — see `VERSION-PIN`)
    /// found the *payload-construction* code for these callbacks is NOT one shared function per type:
    /// `LOK_CALLBACK_INVALIDATE_VISIBLE_CURSOR` alone has independent emitters in `editeng/` (in-place
    /// text edit engines — Calc's in-cell edit, shape text) and `sfx2/source/view/lokhelper.cxx`'s
    /// `notifyCursorInvalidation` (the ordinary VCL document-window caret, reached via
    /// `vcl/source/window/cursor.cxx`) — and reading `notifyCursorInvalidation` itself raised a real
    /// question this probe is what actually answers: its `bControlEvent == false` branch never closes
    /// the `"rectangle"` value's own JSON quote before appending `" }"`, which LOOKS like it would
    /// produce structurally invalid JSON — every traced call site in this tree passes `true`, so the
    /// malformed branch may simply be dead in practice, but that is a claim about RUNTIME BEHAVIOR no
    /// amount of source-reading settles on its own. Four scenarios, therefore: Writer body typing
    /// (the vcl path), Writer shift-arrow AND drag selection (selection has its own independent
    /// per-app emitters too — `sw/source/core/crsr/viscrs.cxx` for Writer), and Calc cell
    /// navigation + in-cell edit (`sc/source/ui/view/gridwin.cxx`'s own `getCellCursor()` — a SIX-field
    /// payload per that source read: `x, y, width, height, col, row` in the non-print-twips mode this
    /// helper runs in, not the four-field shape the enum header's own doc comment would suggest by
    /// analogy with `INVALIDATE_TILES`).
    ///
    /// **This probe is deliberately observational first.** It prints every matching raw line for
    /// visual inspection (`grep '\[caret probe\]' <test log>` if the printed lines below scroll past),
    /// then asserts only the WEAK, format-agnostic properties that must hold no matter which of the
    /// several possible real shapes each callback turns out to use: `type=<n>` is one of the five,
    /// `payload=` is present, and (once real output is read back) the specific field-count/shape
    /// assertions this task's parser is built against — added in a follow-up pass once the FIRST run's
    /// output is actually read, matching `testRealLOKCallbackProbeCapturesRawPayloadsAndCrossChecksThe
    /// Parsers`'s own two-pass history (that test's own committed form already has its assertions;
    /// this one starts the same way that one did, before its own fields.count>=5 finding existed).
    func testRealLOKCallbackProbeCapturesCaretSelectionAndCellCursorRawPayloads() async throws {
        try skipUnlessVendorPresent()
        let helper = try await spawnLiveHelper(captureStderr: true)

        // MARK: Writer — body typing, shift-arrow selection, drag selection
        let writerStagedPath = helper.stateDir.appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("caret-probe-writer.odt").path
        try FileManager.default.createDirectory(
            at: URL(fileURLWithPath: writerStagedPath).deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contentsOf: Self.fixturesRoot.appendingPathComponent("gate.odt")).write(to: URL(fileURLWithPath: writerStagedPath))
        let writerDocId = UUID().uuidString
        _ = try await helper.client.open(docId: writerDocId, path: writerStagedPath)

        // A conservative in-body point — gate.odt's page is 12474x17406 twips (the six-format
        // matrix's own pin); (1200, 1200) sits well inside a default ~1440-twip margin's own text
        // area regardless of the seed content's exact layout. Exact placement is not load-bearing
        // for a PROBE (unlike the placement drills in section below) — LOK resolves a click to the
        // nearest valid text position regardless.
        try await helper.client.postMouse(docId: writerDocId, part: 0, type: .buttonDown, xTwips: 1200, yTwips: 1200, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: writerDocId, part: 0, type: .buttonUp, xTwips: 1200, yTwips: 1200, count: 1, buttons: 1, modifiers: 0)
        try? await Task.sleep(nanoseconds: 500_000_000)
        // Type "AB" — each keystroke's caret move is a fresh chance for INVALIDATE_VISIBLE_CURSOR.
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyInput, charCode: 65, keyCode: 512) // A
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyUp, charCode: 65, keyCode: 512)
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyInput, charCode: 66, keyCode: 513) // B
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyUp, charCode: 66, keyCode: 513)
        try? await Task.sleep(nanoseconds: 500_000_000)
        // Shift+Left x2 — a real text selection via the KEYBOARD door.
        let keyShift = 0x1000
        let keyLeft = 1026
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyInput, charCode: 0, keyCode: keyLeft | keyShift)
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyUp, charCode: 0, keyCode: keyLeft | keyShift)
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyInput, charCode: 0, keyCode: keyLeft | keyShift)
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyUp, charCode: 0, keyCode: keyLeft | keyShift)
        try? await Task.sleep(nanoseconds: 500_000_000)
        // A bare Left arrow collapses the selection — the "selection went away" shape.
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyInput, charCode: 0, keyCode: keyLeft)
        try await helper.client.postKey(docId: writerDocId, part: 0, type: .keyUp, charCode: 0, keyCode: keyLeft)
        try? await Task.sleep(nanoseconds: 500_000_000)
        // A drag selection via the MOUSE door — a genuinely different input path than shift-arrow.
        try await helper.client.postMouse(docId: writerDocId, part: 0, type: .buttonDown, xTwips: 1200, yTwips: 1200, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: writerDocId, part: 0, type: .move, xTwips: 2400, yTwips: 1200, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: writerDocId, part: 0, type: .move, xTwips: 3600, yTwips: 1200, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: writerDocId, part: 0, type: .buttonUp, xTwips: 3600, yTwips: 1200, count: 1, buttons: 1, modifiers: 0)
        try? await Task.sleep(nanoseconds: 500_000_000)

        try await helper.client.close(docId: writerDocId)
        try? await Task.sleep(nanoseconds: 500_000_000)

        // MARK: Calc — cell navigation (CELL_CURSOR) + in-cell edit (INVALIDATE_VISIBLE_CURSOR again)
        let calcStagedPath = helper.stateDir.appendingPathComponent("docs", isDirectory: true)
            .appendingPathComponent("caret-probe-calc.ods").path
        try Data(contentsOf: Self.fixturesRoot.appendingPathComponent("gate.ods")).write(to: URL(fileURLWithPath: calcStagedPath))
        let calcDocId = UUID().uuidString
        _ = try await helper.client.open(docId: calcDocId, path: calcStagedPath)

        // A1, proven safe by testARealEditFiresInvalidateTiles...'s own precedent.
        try await helper.client.postMouse(docId: calcDocId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: calcDocId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100, count: 1, buttons: 1, modifiers: 0)
        try? await Task.sleep(nanoseconds: 500_000_000)
        // A distant cell — several rows/columns over (row height ~254 twips, so 2000 twips is
        // several rows down; column width varies but 3000 twips is comfortably a different column).
        try await helper.client.postMouse(docId: calcDocId, part: 0, type: .buttonDown, xTwips: 3000, yTwips: 2000, count: 1, buttons: 1, modifiers: 0)
        try await helper.client.postMouse(docId: calcDocId, part: 0, type: .buttonUp, xTwips: 3000, yTwips: 2000, count: 1, buttons: 1, modifiers: 0)
        try? await Task.sleep(nanoseconds: 500_000_000)
        // Enter in-cell edit mode — Calc's OWN edit-engine caret, a plausible SECOND
        // INVALIDATE_VISIBLE_CURSOR emitter distinct from Writer's vcl-level one.
        try await helper.client.postKey(docId: calcDocId, part: 0, type: .keyInput, charCode: 67, keyCode: 514) // C
        try await helper.client.postKey(docId: calcDocId, part: 0, type: .keyUp, charCode: 67, keyCode: 514)
        try? await Task.sleep(nanoseconds: 500_000_000)
        try await helper.client.postKey(docId: calcDocId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280) // Return commits
        try await helper.client.postKey(docId: calcDocId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280)
        try? await Task.sleep(nanoseconds: 500_000_000)

        try await helper.client.close(docId: calcDocId)
        try? await Task.sleep(nanoseconds: 500_000_000)

        // MARK: Cross-check — every raw line for types 1/2/3/4/17 must parse under its own parser.
        //
        // **First-run finding, disclosed rather than chased further**: the drag-selection scenario
        // above (mouseDown/move/move/buttonUp at three DISCRETE, separately-async-posted twips
        // points) produced NO `TEXT_SELECTION_START`/`_END` firing at all — the total counts below
        // (`3=2, 4=2`) match EXACTLY the two shift-arrow keystrokes and leave nothing over for the
        // drag. Whether the drag ALSO produced a redundant EMPTY `TEXT_SELECTION` is not
        // individually isolated (see `sawSelectionEmpty`'s own comment near the bottom of this
        // function). Plausible mechanism for the drag producing no real selection at all, not
        // confirmed: T4's own fix-round-4 finding (NEW-3, task-4-report.md) already established that
        // EVERY posted input event re-asserts the current view and grabs focus at DISPATCH time
        // (`LOKPostAsyncEvent`) — three independently-posted mouse events may not preserve VCL's own
        // continuous drag-tracking state the way one genuine, uninterrupted OS gesture would. Left
        // disclosed rather than chased: this task's own parser is payload-shape-agnostic to WHICH
        // input door produced a firing, and the keyboard door already proves the real shape live.
        let interestingTypes: Set<Int32> = [1, 2, 3, 4, 17]
        let rawLines = (helper.stderrCapture?.linesSnapshot() ?? []).filter { $0.contains("[LOKBridge raw callback]") }
        var perType: [Int32: Int] = [:]
        var sawCaretRect = false, sawSelectionRect = false, sawSelectionEmpty = false
        var sawSelectionStart = false, sawSelectionEnd = false
        var sawCellCursorAt = false, sawCellCursorEmpty = false
        for line in rawLines {
            guard let typeRange = line.range(of: "type="), let payloadRange = line.range(of: " payload=") else { continue }
            guard let type = Int32(line[typeRange.upperBound..<payloadRange.lowerBound]) else { continue }
            guard interestingTypes.contains(type) else { continue }
            perType[type, default: 0] += 1
            let payload = String(line[payloadRange.upperBound...])
            print("[caret probe] type=\(type) payload=\"\(payload)\"")
            switch type {
            case 1:
                guard case .caretRect(let rect) = OfficeDocumentEvent.parseCaretRect(payload) else {
                    return XCTFail("a REAL INVALIDATE_VISIBLE_CURSOR payload failed to parse: \"\(payload)\"")
                }
                sawCaretRect = true
                XCTAssertEqual(rect.width, 0, "every real caret rect observed has zero width (a caret has no horizontal extent)")
            case 2:
                guard case .textSelection(let rects) = OfficeDocumentEvent.parseTextSelection(payload) else {
                    return XCTFail("a REAL TEXT_SELECTION payload failed to parse: \"\(payload)\"")
                }
                if rects.isEmpty { sawSelectionEmpty = true } else { sawSelectionRect = true }
            case 3:
                guard case .textSelectionStart = OfficeDocumentEvent.parseTextSelectionStart(payload) else {
                    return XCTFail("a REAL TEXT_SELECTION_START payload failed to parse: \"\(payload)\"")
                }
                sawSelectionStart = true
            case 4:
                guard case .textSelectionEnd = OfficeDocumentEvent.parseTextSelectionEnd(payload) else {
                    return XCTFail("a REAL TEXT_SELECTION_END payload failed to parse: \"\(payload)\"")
                }
                sawSelectionEnd = true
            case 17:
                guard case .cellCursor(let cell) = OfficeDocumentEvent.parseCellCursor(payload) else {
                    return XCTFail("a REAL CELL_CURSOR payload failed to parse: \"\(payload)\"")
                }
                switch cell {
                case .at: sawCellCursorAt = true
                case .empty: sawCellCursorEmpty = true
                }
            default:
                break
            }
        }
        print("[caret probe] SUMMARY by type: \(perType.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ", "))")

        // Every scenario this probe actually drove DID produce real traffic (unlike the drag-
        // selection disclosure above) — these are real assertions, not the "vacuously true for zero
        // firings" honesty clause `testRealLOKCallbackProbeCapturesRawPayloadsAndCrossChecksTheParsers`
        // uses for callbacks that may or may not fire incidentally.
        XCTAssertTrue(sawCaretRect, "Writer typing and Calc in-cell edit must both produce a real caret rect")
        XCTAssertTrue(sawSelectionRect, "Shift-arrow selection must produce a real, non-empty TEXT_SELECTION")
        XCTAssertTrue(sawSelectionStart, "a real selection must produce TEXT_SELECTION_START")
        XCTAssertTrue(sawSelectionEnd, "a real selection must produce TEXT_SELECTION_END")
        XCTAssertTrue(sawCellCursorAt, "a real Calc cell click must produce a real CELL_CURSOR rect+col+row")
        XCTAssertTrue(sawCellCursorEmpty, "entering Calc in-cell edit mode must produce CELL_CURSOR \"EMPTY\"")
        // `sawSelectionEmpty` is observed (this run's own capture: 3 of the 5 total TEXT_SELECTION
        // firings carried an empty payload) but deliberately NOT asserted here — this test's own raw
        // line filter reads type+payload only, not `docId`, so which specific step(s) among "the
        // very first click," "the bare-arrow collapse," "the drag selection," and "Calc's own
        // initial no-selection state" produced which empty firing was not individually isolated.
        // Not chased further: the PARSER (this test's actual subject) already has real, both-shapes
        // coverage from `testParseTextSelectionCalcsBareEMPTYAlsoMeansNoSelection`/`...Real
        // CapturedShapes`, and every one of these 3 empty firings above already parsed correctly as
        // `.textSelection([])` without tripping the XCTFail branch.
        _ = sawSelectionEmpty
    }
}

/// `Process.TerminationReason.uncaughtSignal`'s raw value, for the SIGTERM measurement's log line
/// — spelled out explicitly (not just the enum case name) so the printed measurement is
/// self-contained even read out of context (e.g. pasted into the task-3 report).
private let ProcessTerminationReasonUncaughtSignalRawValue = Process.TerminationReason.uncaughtSignal.rawValue
