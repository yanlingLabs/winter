import AppKit
import NormaKit
import XCTest
@testable import Norma

/// office-agent-tools T2 — `OfficeAgentBroker`: the single app-side door every agent office verb
/// (task 3+'s `sheets`/`slides`/`docs`) goes through. Every PURE/behavioral test below drives a real
/// `OfficeRuntime` backed by a FAKE `Driver` (this file's own `BrokerOfficeDriverRecorder`, mirroring
/// `ShellSessionHostTests.OfficeDriverRecorder`'s established shape — each test file keeps its own
/// copy, that file's own precedent) — no real helper, no real LOK, fast and deterministic. The two
/// live drills at the bottom of this file are the exception: real supervisor, real helper, real
/// vendored LibreOffice, gated exactly like `OfficeRuntimeLiveTests` (skip, never fail, when the
/// engine isn't present in this run).
@MainActor
final class OfficeAgentBrokerTests: XCTestCase {

    // MARK: - Rule 5 (the fence): pure, no runtime at all

    func testFenceRefusesWhenDirsIsNil() {
        XCTAssertNil(officeAgentResolvedPathWithinFence("/repo/a.xlsx", dirs: nil))
    }

    func testFenceRefusesWhenDirsIsEmpty() {
        XCTAssertNil(officeAgentResolvedPathWithinFence("/repo/a.xlsx", dirs: []))
    }

    func testFenceResolvesAnAbsolutePathInsideThePrimary() {
        let dirs = [SessionDirEntry(path: "/repo", locked: true)]
        XCTAssertEqual(officeAgentResolvedPathWithinFence("/repo/sub/a.xlsx", dirs: dirs), "/repo/sub/a.xlsx")
    }

    func testFenceResolvesAnAbsolutePathInsideASecondaryRoot() {
        let dirs = [SessionDirEntry(path: "/repo", locked: true), SessionDirEntry(path: "/granted", locked: false)]
        XCTAssertEqual(officeAgentResolvedPathWithinFence("/granted/a.xlsx", dirs: dirs), "/granted/a.xlsx")
    }

    func testFenceRefusesAPathOutsideEveryRoot() {
        let dirs = [SessionDirEntry(path: "/repo", locked: true)]
        XCTAssertNil(officeAgentResolvedPathWithinFence("/etc/passwd", dirs: dirs))
    }

    /// The trailing-separator discipline `resolveWithinAny` itself relies on: a sibling directory
    /// that merely shares a STRING prefix with a root is not inside it.
    func testFenceRefusesAPrefixLookalikeSiblingDirectory() {
        let dirs = [SessionDirEntry(path: "/x/proj", locked: true)]
        XCTAssertNil(officeAgentResolvedPathWithinFence("/x/proj-evil/a.xlsx", dirs: dirs))
    }

    /// **Whole-branch review F4 (CRITICAL).** A REAL directory and a REAL `symlink`, never a
    /// transcription of the fence body — this is the app-side half of the same pin
    /// `sheets.test.ts`'s own "a path through an in-root symlink that LEAVES the root" carries.
    ///
    /// This side is the **load-bearing** one: it runs inside the process that performs the write,
    /// immediately before `OfficeRuntime.open`/edit/save, and the daemon is not the only possible
    /// caller. Pre-fix both fences did pure string work, so this path matched the root by prefix and
    /// `placeAtomically`'s `rename()` landed the overwrite outside every working directory.
    func testFenceRefusesAPathThroughAnInRootSymlinkThatLeavesTheRoot() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("office-fence-\(UUID().uuidString.prefix(8))", isDirectory: true)
        let proj = base.appendingPathComponent("proj", isDirectory: true)
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: proj, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: outside.appendingPathComponent("secret.xlsx"))
        try FileManager.default.createSymbolicLink(at: proj.appendingPathComponent("link"),
                                                   withDestinationURL: outside)
        defer { try? FileManager.default.removeItem(at: base) }

        let dirs = [SessionDirEntry(path: proj.path, locked: true)]
        let viaLink = proj.appendingPathComponent("link").appendingPathComponent("secret.xlsx").path
        XCTAssertNil(officeAgentResolvedPathWithinFence(viaLink, dirs: dirs),
                     "a path that string-matches the root but RESOLVES outside it must refuse")
    }

    /// The control arm, so the fix cannot be an over-refusal that simply bans symlinks: a link that
    /// stays INSIDE the root still passes, and the RETURN value is the caller's own spelling — the
    /// `resolveWithinAny` contract. That return contract is load-bearing beyond tidiness: the broker
    /// matches `documents[resolvedPath]` to decide whether to ADOPT the user's already-open tab, so
    /// returning the link-resolved spelling here would silently stop adopting and open a second copy.
    func testFenceAllowsAnInRootSymlinkThatStaysInsideAndReturnsTheCallersSpelling() throws {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("office-fence-\(UUID().uuidString.prefix(8))", isDirectory: true)
        let proj = base.appendingPathComponent("proj", isDirectory: true)
        let sub = proj.appendingPathComponent("sub", isDirectory: true)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        try Data("x".utf8).write(to: sub.appendingPathComponent("budget.xlsx"))
        try FileManager.default.createSymbolicLink(at: proj.appendingPathComponent("link"),
                                                   withDestinationURL: sub)
        defer { try? FileManager.default.removeItem(at: base) }

        let dirs = [SessionDirEntry(path: proj.path, locked: true)]
        let viaLink = proj.appendingPathComponent("link").appendingPathComponent("budget.xlsx").path
        XCTAssertEqual(officeAgentResolvedPathWithinFence(viaLink, dirs: dirs), viaLink)
    }

    func testFenceResolvesWhenTheTargetIsARootItself() {
        let dirs = [SessionDirEntry(path: "/repo", locked: true)]
        XCTAssertEqual(officeAgentResolvedPathWithinFence("/repo", dirs: dirs), "/repo")
    }

    func testFenceResolvesARelativePathAgainstThePrimary() {
        let dirs = [SessionDirEntry(path: "/repo", locked: true)]
        XCTAssertEqual(officeAgentResolvedPathWithinFence("sub/a.xlsx", dirs: dirs), "/repo/sub/a.xlsx")
    }

    /// Mirrors `resolvedFilePath`'s own precedent exactly: a degenerate empty PRIMARY does not fall
    /// through to a later, non-empty root — there is nothing sensible to resolve a relative path
    /// against, so it refuses rather than guessing.
    func testFenceRefusesARelativePathWhenThePrimaryIsEmpty() {
        let dirs = [SessionDirEntry(path: "", locked: true), SessionDirEntry(path: "/repo", locked: false)]
        XCTAssertNil(officeAgentResolvedPathWithinFence("a.xlsx", dirs: dirs))
    }

    // MARK: - This file's own fake Driver (mirrors ShellSessionHostTests.OfficeDriverRecorder's shape)

    private final class BrokerOfficeDriverRecorder: @unchecked Sendable {
        private let lock = NSLock()

        let stateDirectory: URL
        init(stateDirectory: URL = FileManager.default.temporaryDirectory
                .appendingPathComponent("OfficeAgentBrokerTests-\(UUID().uuidString)", isDirectory: true)) {
            self.stateDirectory = stateDirectory
        }

        private var _openCalls: [(docId: String, path: String)] = []
        var openCalls: [(docId: String, path: String)] { lock.lock(); defer { lock.unlock() }; return _openCalls }
        private var _closeCalls: [String] = []
        var closeCalls: [String] { lock.lock(); defer { lock.unlock() }; return _closeCalls }
        private var _saveCalls: [String] = []
        var saveCalls: [String] { lock.lock(); defer { lock.unlock() }; return _saveCalls }

        private var _saveFailures: [String: String] = [:]
        var saveFailures: [String: String] {
            get { lock.lock(); defer { lock.unlock() }; return _saveFailures }
            set { lock.lock(); _saveFailures = newValue; lock.unlock() }
        }
        private var _saveTempPaths: [String: String] = [:]
        var saveTempPaths: [String: String] {
            get { lock.lock(); defer { lock.unlock() }; return _saveTempPaths }
            set { lock.lock(); _saveTempPaths = newValue; lock.unlock() }
        }
        private var _defaultMetadata = OfficeDocumentMetadata(
            type: .spreadsheet, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100))
        var defaultMetadata: OfficeDocumentMetadata {
            get { lock.lock(); defer { lock.unlock() }; return _defaultMetadata }
            set { lock.lock(); _defaultMetadata = newValue; lock.unlock() }
        }
        /// Coordinator review F2 (2026-08-22) — an OPTIONAL gate awaited as `open`'s own FIRST line,
        /// before `_openCalls` is even appended to. Unset (the default, every OTHER test in this
        /// file), `open` behaves exactly as before. Set, it lets a test hold an open GENUINELY,
        /// deterministically suspended — not "probably still running" the way a bare `Task.sleep` race
        /// would be — so a test can assert the runtime is OBSERVABLY still mid-open (in
        /// `opensInFlight`, not yet in `documents`) rather than hoping for a lucky Task-scheduling
        /// order. `Driver.open` is already `async throws` (Stage B's own signature, unrelated to this
        /// fix), so this needs no new async machinery — only something for the closure to `await`.
        private var _openGate: (@Sendable () async -> Void)?
        var openGate: (@Sendable () async -> Void)? {
            get { lock.lock(); defer { lock.unlock() }; return _openGate }
            set { lock.lock(); _openGate = newValue; lock.unlock() }
        }

        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { .ready },
                startHelper: { },
                open: { [weak self] docId, path in
                    // crash-fix round 1 (Family B): `OfficeRuntime.perform` fires this Driver's
                    // calls as fire-and-forget `Task`s that routinely outlive the test (see
                    // broker-crash-investigation.md §2) — `[unowned self]` on a LOCAL recorder read
                    // after the test returns was `swift_abortRetainUnowned`. `[weak self]` + a
                    // straggler-safe fallback turns that host-killing abort into a dropped no-op,
                    // which is the correct semantics for "the test that owned me is over."
                    guard let self else { throw CancellationError() }
                    if let gate = self.openGate { await gate() }
                    self.lock.lock(); self._openCalls.append((docId, path)); self.lock.unlock()
                    return self.defaultMetadata
                },
                close: { [weak self] docId in
                    guard let self else { return }
                    self.lock.lock(); self._closeCalls.append(docId); self.lock.unlock()
                },
                save: { [weak self] docId, _ in
                    guard let self else { throw CancellationError() }
                    self.lock.lock(); self._saveCalls.append(docId); self.lock.unlock()
                    if let reason = self.saveFailures[docId] {
                        throw OfficeHelperClientError.saveFailed(reason: reason)
                    }
                    return self.saveTempPaths[docId] ?? "/tmp/officeagentbrokertests-\(docId).saved"
                },
                subscribeTiles: { _, _, _, _ in [] },
                unsubscribeTiles: { _ in },
                requestTiles: { _, _ in },
                postKey: { _, _, _, _, _ in }, postMouse: { _, _, _, _, _, _, _, _ in },
                postExtTextInput: { _, _, _, _ in },
                clipboardCopy: { _, _ in nil },
                clipboardCut: { _, _ in nil },
                clipboardPaste: { _, _, _ in },
                undo: { _ in },
                redo: { _ in },
                sheetsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsRead: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsSet: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsResize: { _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsManageSheet: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                sheetsFormat: { _, _, _, _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: sheets not implemented") },
                slidesInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
                slidesRead: { _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
                slidesSetText: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
                slidesManagePage: { _, _, _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: slides not implemented") },
                docsInfo: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
                docsRead: { _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
                docsReplace: { _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
                docsInsert: { _, _, _, _ in throw OfficeHelperClientError.serverError(reason: "fake driver: docs not implemented") },
                stateDirectory: stateDirectory)
        }
    }

    private var scratchDirs: [URL] = []

    override func tearDown() {
        for dir in scratchDirs { try? FileManager.default.removeItem(at: dir) }
        scratchDirs = []
        super.tearDown()
    }

    private func makeScratchDirectory() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("officeagentbroker-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        scratchDirs.append(dir)
        return dir
    }

    /// `OfficeRuntime.open` genuinely stages (copies) its argument before ever reaching a driver —
    /// mirrors `PanelDocumentTabTests`' own header on this exact point. Every path this file opens
    /// through a real `OfficeRuntime` needs a real, readable file on disk first.
    private func writeDummyFile(at path: String) {
        try? Data().write(to: URL(fileURLWithPath: path))
    }

    private func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return true
    }

    private func codeRow(_ sessionId: String, dirs: [SessionDirEntry]?) -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global",
                       cwd: dirs?.first?.path, mode: "code", dirs: dirs)
    }

    /// A real `ShellSessionHost`, wired the same way production `ShellSessionHost.officeAgentBroker`
    /// is, but with `makeOfficeRuntime` substituted for `office`'s fake driver — this exercises the
    /// REAL wiring this task added to `ShellSessionHost.swift`, not a hand-rolled `Host`.
    private func makeHost(office: BrokerOfficeDriverRecorder, dirs: [SessionDirEntry]?,
                          sessionId: String = "S1") -> ShellSessionHost {
        let directory = SessionDirectory(lister: { [self.codeRow(sessionId, dirs: dirs)] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeRuntime = { sid, _ in OfficeRuntime(sessionId: sid, driver: office.driver) }
        return host
    }

    // MARK: - Rules 1 & 2: adopt-or-open, close-only-what-you-opened

    func testAdoptsAnAlreadyOpenDocumentAndNeverClosesOrReopensIt() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("adopt.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup: the document never opened")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        XCTAssertEqual(office.openCalls.count, 1, "setup sanity")

        var seenDocId: String?
        let result = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
        ) { _, docId, _ in
            seenDocId = docId
            return "read"
        }

        XCTAssertEqual(result, "read")
        XCTAssertEqual(seenDocId, originalDocId, "the broker must hand the ACTION the already-open document")
        XCTAssertEqual(office.openCalls.count, 1, "adoption must never open a second time")
        XCTAssertEqual(office.closeCalls.count, 0, "an adopted document must never be closed by the agent")
        XCTAssertNotNil(runtime.stateSnapshot.documents[path], "the tab's own document must still be open")
    }

    func testOpensAPathThatIsNotCurrentlyOpenAndClosesItAfterward() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("open.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        XCTAssertNil(host.existingOfficeRuntime(for: "S1"), "setup: nothing has touched office yet")

        let result = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
        ) { _, docId, _ in "read \(docId)" }

        XCTAssertTrue(result.hasPrefix("read "))
        XCTAssertEqual(office.openCalls.count, 1, "a not-open path must be opened exactly once")
        let runtime = try XCTUnwrap(host.existingOfficeRuntime(for: "S1"), "opening must have minted a runtime")
        XCTAssertNil(runtime.stateSnapshot.documents[path],
                     "a document THIS call opened must be closed once the verb is done")
        // The reducer's own `documents[path]` removal above is synchronous, but the DRIVER-level
        // `close` closure runs inside a spawned effect Task — asserting on `closeCalls` immediately
        // would race MainActor's own scheduling of that Task. `documents[path] == nil` already proves
        // rule 2 at the state layer; this additionally proves the driver was actually told.
        let closed = await waitUntil { office.closeCalls.count == 1 }
        XCTAssertTrue(closed, "the driver's own close was never called")
        let closedDocId = try XCTUnwrap(office.closeCalls.first)
        XCTAssertEqual(closedDocId, office.openCalls.first?.docId, "the SAME docId that was opened must be closed")
    }

    // MARK: - "Never mint a runtime just to read" — call-order/count proof via a hand-rolled Host

    @MainActor
    private final class CountingHost {
        private(set) var existingRuntimeCalls = 0
        private(set) var mintCalls = 0
        private(set) var callOrder: [String] = []
        var existingRuntimeAnswer: OfficeRuntime?
        var mintAnswer: OfficeRuntime?
        var dirsAnswer: [SessionDirEntry]?

        var host: OfficeAgentBroker.Host {
            .init(
                existingRuntime: { [weak self] _ in
                    self?.existingRuntimeCalls += 1
                    self?.callOrder.append("existing")
                    return self?.existingRuntimeAnswer
                },
                runtime: { [weak self] _ in
                    self?.mintCalls += 1
                    self?.callOrder.append("mint")
                    return self?.mintAnswer
                },
                workingDirectories: { [weak self] _ in self?.dirsAnswer })
        }
    }

    func testFenceRefusalNeverTouchesAnyRuntimeDoor() async {
        let counting = CountingHost()
        counting.dirsAnswer = [SessionDirEntry(path: "/repo", locked: true)]
        let broker = OfficeAgentBroker(host: counting.host)

        do {
            _ = try await broker.perform(sessionId: "S1", path: "/etc/passwd", access: .read,
                                         requestId: UUID().uuidString) { _, _, _ in "unreached" }
            XCTFail("an out-of-fence path must refuse")
        } catch let error as OfficeAgentBrokerError {
            XCTAssertEqual(error, .outOfFence(path: "/etc/passwd"))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertEqual(counting.existingRuntimeCalls, 0, "the fence check must run before any runtime door")
        XCTAssertEqual(counting.mintCalls, 0)
    }

    /// Coordinator review F4 (2026-08-22) — the v1 scope ruling must be stated PLAINLY in the
    /// refusal, and worded ACCESS-NEUTRAL: the fence refuses a READ exactly as it refuses a WRITE (this
    /// very test uses `.read`), so wording it "agent office writes are limited to..." would misdescribe
    /// what just happened to THIS call.
    func testFenceRefusalMessageStatesTheWorkingDirectoriesScopeAccessNeutrally() async {
        let counting = CountingHost()
        counting.dirsAnswer = [SessionDirEntry(path: "/repo", locked: true)]
        let broker = OfficeAgentBroker(host: counting.host)

        do {
            _ = try await broker.perform(sessionId: "S1", path: "/etc/passwd", access: .read,
                                         requestId: UUID().uuidString) { _, _, _ in "unreached" }
            XCTFail("an out-of-fence path must refuse")
        } catch let error as OfficeAgentBrokerError {
            XCTAssertTrue(error.message.contains("working directories"), "must state the v1 scope "
                          + "plainly: \(error.message)")
            XCTAssertFalse(error.message.lowercased().contains("write"), "must be access-neutral — this "
                          + "call was a READ: \(error.message)")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testAdoptionNeverReachesTheMintingDoor() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("a.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: office.driver)
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup")

        let counting = CountingHost()
        counting.existingRuntimeAnswer = runtime
        counting.dirsAnswer = [SessionDirEntry(path: scratch.path, locked: true)]
        let broker = OfficeAgentBroker(host: counting.host)

        _ = try await broker.perform(sessionId: "S1", path: path, access: .read,
                                     requestId: UUID().uuidString) { _, _, _ in "read" }

        XCTAssertEqual(counting.existingRuntimeCalls, 1)
        XCTAssertEqual(counting.mintCalls, 0, "an adopted read must never reach the minting door")
    }

    func testOpeningAskAsExistingFirstThenMints() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("a.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let runtime = OfficeRuntime(sessionId: "S1", driver: office.driver)

        let counting = CountingHost()
        counting.existingRuntimeAnswer = nil
        counting.mintAnswer = runtime
        counting.dirsAnswer = [SessionDirEntry(path: scratch.path, locked: true)]
        let broker = OfficeAgentBroker(host: counting.host)

        _ = try await broker.perform(sessionId: "S1", path: path, access: .read,
                                     requestId: UUID().uuidString) { _, _, _ in "read" }

        XCTAssertEqual(counting.callOrder, ["existing", "mint"],
                       "the existing-runtime door must be asked before the minting door")
    }

    // MARK: - Coordinator review F2 (2026-08-22): joining an in-flight open counts as adoption

    /// **The other half of the double-open fix — the broker's own ownership decision, not the
    /// reducer's dispatch guard.** `OfficeRuntimeState.opensInFlight` (this fix round) stops a SECOND
    /// `.helperOpen` from ever being dispatched, but that alone does not make THIS call's `adopted`
    /// decision correct: without the broker-side branch this test pins, a path someone ELSE is already
    /// opening would still fall to the "mint fresh" `else`, `adopted` would still land `false`, and the
    /// `defer` would still close the document the OTHER caller opened once this call finishes — rule
    /// 2's own failure mode, surviving the reducer fix untouched.
    ///
    /// **Made fully deterministic with a GATED driver `open`, not a hopeful `Task.sleep` race.** The
    /// runtime is driven into "opening, not yet open" by a DIRECT `runtime.open(path)` call (bypassing
    /// the broker entirely — simulating a tab's own open) whose underlying driver call is held open on
    /// an explicit continuation this test controls; `perform` is then started, and — because nothing
    /// can resolve the shared open until this test releases the gate — the assertions made BEFORE
    /// release are not probabilistic, they are things that are logically impossible to be false yet.
    func testBrokerJoinsAnAlreadyInFlightOpenAsAdoptionRatherThanMintingASecondOne() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("inflight.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        final class Gate: @unchecked Sendable {
            private let lock = NSLock()
            private var release: (() -> Void)?
            func hold() -> @Sendable () async -> Void {
                { await withCheckedContinuation { continuation in
                    self.lock.lock(); self.release = { continuation.resume() }; self.lock.unlock()
                } }
            }
            func open() {
                lock.lock(); let r = release; release = nil; lock.unlock()
                r?()
            }
        }
        let gate = Gate()
        office.openGate = gate.hold()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path) // someone else's (a tab's) open — deliberately NOT through the broker
        // `opensInFlight`, not `pendingOpens`, is what lands here, synchronously, with THIS fake
        // driver — `OfficeRuntime.perform`'s own `.ensureHelperReady` handler has a documented
        // "late-joiner" fast path that folds the WHOLE idle→starting→ready→flush→helperOpen cascade
        // synchronously whenever `driver.helperState()` already reports `.ready` (this recorder's
        // own `helperState: { .ready }`), which is also the common REAL-WORLD case (the shared
        // helper outlives any one document). Only a genuine cold boot (helper not yet started)
        // leaves `pendingOpens` observable for real wall-clock time — see the broker's own comment at
        // its `pendingOpens` join clause for that half, which this fake driver's always-ready shape
        // cannot exercise.
        XCTAssertTrue(runtime.stateSnapshot.opensInFlight.contains(path), "setup: never registered "
                      + "in-flight")
        XCTAssertNil(runtime.stateSnapshot.documents[path], "setup: must not have landed yet — the "
                     + "gate holds the driver's own open shut")

        final class ResultBox: @unchecked Sendable { var value: String? }
        let resultBox = ResultBox()
        let performTask = Task<String, Error> { @MainActor in
            let value = try await host.officeAgentBroker.perform(
                sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
            ) { _, docId, _ in "read \(docId)" }
            resultBox.value = value
            return value
        }

        // The gate has not been released, so the shared open CANNOT have resolved — `perform` cannot
        // possibly have returned yet. This is not a timing guess; it is a logical consequence of the
        // gate still being held.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertNil(resultBox.value, "perform must still be waiting on the shared, still-gated open")

        gate.open()

        let result = try await performTask.value
        XCTAssertTrue(result.hasPrefix("read "))
        let closed = await waitUntil(timeout: 0.3) { office.closeCalls.count > 0 }
        XCTAssertFalse(closed, "joining an in-flight open must never close it — it was not this call's "
                       + "own to open")
        XCTAssertEqual(office.openCalls.count, 1, "only ONE open may ever reach the driver — the "
                       + "broker's own redundant `open()` call (inside `awaitOpen`) must be suppressed "
                       + "by the reducer's in-flight guard, not produce a second driver call")
    }

    // MARK: - Coordinator re-review, 2026-08-22, finding 2: the docId-mismatch belt's own leak

    /// **Pins the re-review's own finding, does not fix it** — see the `defer`'s own comment in
    /// `OfficeAgentBroker.runOnce` for the full disclosure. The docId re-verify at that `defer` exists
    /// to stop rule 2 from closing a document THIS call never opened (the mirror-interleaving/reload
    /// race); this test proves the flip side of that same correctness: on a genuine mismatch, the
    /// REPLACEMENT document is never closed by anyone afterward — not by this call (correctly, it is
    /// not this call's to close), and not by whatever replaced it either (nothing here re-runs rule
    /// 1). Session-bounded, not corrupting — this call's own action result is unaffected — but a real
    /// resource hold with no active cleanup path.
    func testDocIdMismatchOnDeferSkipsTheCloseAndLeavesTheReplacementDocumentOpen() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("mismatch.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()
        let runtime = host.officeRuntime(for: "S1")

        final class Gate: @unchecked Sendable {
            private let lock = NSLock()
            private var release: (() -> Void)?
            func hold() -> @Sendable () async -> Void {
                { await withCheckedContinuation { continuation in
                    self.lock.lock(); self.release = { continuation.resume() }; self.lock.unlock()
                } }
            }
            func open() {
                lock.lock(); let r = release; release = nil; lock.unlock()
                r?()
            }
        }
        let actionGate = Gate()
        let heldAction = actionGate.hold()

        final class ResultBox: @unchecked Sendable { var value: String? }
        let resultBox = ResultBox()
        let performTask = Task<String, Error> { @MainActor in
            let value = try await host.officeAgentBroker.perform(
                sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
            ) { _, docId, _ in
                await heldAction()
                return "read \(docId)"
            }
            resultBox.value = value
            return value
        }

        // Wait for this call's own open (D1) to land — `action` cannot be running before it does.
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup: this call's own open never landed")
        let d1 = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        // Simulate the re-review's own named trigger — an external change during the action window
        // causing a reload — as a manual close+reopen of the SAME path. The broker's own call is
        // parked inside `action`, gated, and does not observe or drive any of this: from its point of
        // view this happens "while it wasn't looking," exactly as an external reload would.
        runtime.close(path)
        let reclosedLanded = await waitUntil { runtime.stateSnapshot.documents[path] == nil }
        XCTAssertTrue(reclosedLanded, "setup: the manual close of D1 never landed")
        runtime.open(path)
        let reopenLanded = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(reopenLanded, "setup: the manual reopen (D2) never landed")
        let d2 = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        XCTAssertNotEqual(d1, d2, "setup: the reopen must mint a DIFFERENT docId, or this test proves "
                          + "nothing")

        // Release `action` — it returns, `perform` reaches the `defer`, which now finds
        // `documents[path]?.docId == d2`, not `d1` (this call's own docId), and must skip its close.
        actionGate.open()
        let result = try await performTask.value
        XCTAssertEqual(result, "read \(d1)", "the action itself is unaffected — it already captured D1's "
                       + "own docId before any of this happened")

        // Bounded negative wait, not an immediate check — a wrongful close (if the guard were broken)
        // runs through the same async effect performer every OTHER close in this file already has to
        // wait for; an immediate count check could go green while it is still in flight. Mirrors
        // `testBrokerJoinsAnAlreadyInFlightOpenAsAdoptionRatherThanMintingASecondOne`'s own idiom for
        // the identical reason.
        let wrongfullyClosed = await waitUntil(timeout: 0.3) { office.closeCalls.count > 1 }
        XCTAssertFalse(wrongfullyClosed, "the mismatch must suppress the close — D2 is not this call's "
                       + "to close")
        XCTAssertEqual(office.closeCalls, [d1], "exactly the test's OWN manual close of D1, never a "
                       + "second one — from the defer — closing D2")

        // The leak itself, checked AFTER the negative-wait window above, not merely immediately after
        // `perform` returns: D2 is still open, with no owner — nobody closed it, and nothing here
        // adopted it either.
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.docId, d2, "the replacement document must "
                       + "still be open — this is the leak the re-review found, disclosed, not fixed")
    }

    // MARK: - Office Stage C: the MIRROR interleaving, and the tab it used to strand

    /// **The whole interleaving, through the real broker, with a real tab model joined to it.**
    /// The mirror of `testBrokerJoinsAnAlreadyInFlightOpenAsAdoptionRatherThanMintingASecondOne`:
    /// there a tab opened first and the broker joined it; here the BROKER opens first and a
    /// `PanelDocumentTabModel` joins, so `adopted` correctly lands `false`, rule 2's `defer`
    /// correctly closes what this call opened — and the tab that joined loses its view.
    ///
    /// **This test does not change what the broker does.** Rule 2 still fires: `closeCalls` is
    /// asserted non-empty below, deliberately. What it pins is that the tab left behind is
    /// RECOVERABLE — `.closedUnderTab` with the Reopen affordance, then one automatic re-open that
    /// lands — instead of `.renderState(.booting)` with a spent gate, which is what this exact
    /// sequence produced before Stage C and what `OfficeAgentBroker`'s rule-1 comment disclosed.
    ///
    /// Every ordering here is held by a latch, never by a sleep: the broker's own open is suspended
    /// inside the fake driver until this test releases it, the action is suspended until this test
    /// releases it, and the tab's re-open is suspended on a third latch so the `.closedUnderTab`
    /// state can be observed rather than raced past.
    func testTheMirrorInterleavingLeavesTheJoinedTabRecoverableRatherThanSpinning() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("mirror.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        /// Like this file's other `Gate`, but it REMEMBERS having been opened — a latch released
        /// before the thing it gates ever runs must not deadlock, and this test re-arms the driver
        /// gate mid-flight, where that ordering is not under its control.
        final class Latch: @unchecked Sendable {
            private let lock = NSLock()
            private var release: (() -> Void)?
            private var isOpen = false
            func wait() async {
                await withCheckedContinuation { continuation in
                    lock.lock()
                    if isOpen { lock.unlock(); continuation.resume(); return }
                    release = { continuation.resume() }
                    lock.unlock()
                }
            }
            func open() {
                lock.lock(); isOpen = true; let r = release; release = nil; lock.unlock()
                r?()
            }
        }
        let firstOpen = Latch(), action = Latch(), reopen = Latch()
        office.openGate = { await firstOpen.wait() }

        let runtime = host.officeRuntime(for: "S1")
        let performTask = Task<String, Error> { @MainActor in
            try await host.officeAgentBroker.perform(
                sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
            ) { _, docId, adopted in
                XCTAssertFalse(adopted, "setup: THIS call must be the OPENER — that is the mirror case")
                await action.wait()
                return "read \(docId)"
            }
        }
        let inFlight = await waitUntil { runtime.stateSnapshot.opensInFlight.contains(path) }
        XCTAssertTrue(inFlight, "setup: the broker's own open never registered in flight")

        // The tab joins the broker's in-flight open — the real door, `PanelDocumentTabModel`, not a
        // bare `runtime.open(path)`: the gate this fix re-arms lives on the model.
        let model = PanelDocumentTabModel(tabId: "t1", path: path)
        model.bind(host: host, sessionId: "S1")
        model.activate()
        let asked = await waitUntil { model.hasRequestedOpen }
        XCTAssertTrue(asked, "setup: the tab never asked, so it never joined")

        firstOpen.open()
        let shown = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(shown, "setup: the shared open never landed")
        XCTAssertEqual(office.openCalls.count, 1, "setup: ONE driver open — the tab joined, it did "
                       + "not mint a second")
        guard case .showCanvas = model.plan else {
            return XCTFail("setup: the joined tab must be showing the canvas before the close")
        }

        // Hold the tab's eventual re-open so the state it lands in is observable, not raced past.
        office.openGate = { await reopen.wait() }
        action.open()
        _ = try await performTask.value

        let closed = await waitUntil { runtime.stateSnapshot.documents[path] == nil }
        XCTAssertTrue(closed, "rule 2 must still fire — this fix does not weaken it")
        XCTAssertEqual(office.closeCalls.count, 1, "and it must reach the driver, exactly once")

        let recoverable = await waitUntil {
            model.plan == .renderState(.closedUnderTab(reason: officeDocumentClosedUnderTabReason))
        }
        XCTAssertTrue(recoverable, "pre-fix the joined tab fell through to .renderState(.booting): "
                      + "an indefinite spinner, no error text, no Reopen affordance")

        // **`opensInFlight`, not `openCalls`, is what proves the re-arm here** — this fake driver's
        // `open` appends to `openCalls` only AFTER awaiting its gate, and that gate is deliberately
        // still held, so a count of 2 is not yet observable. The reducer registering the path
        // in-flight is: it means the model's deferred `open()` really was dispatched.
        let rearmed = await waitUntil { runtime.stateSnapshot.opensInFlight.contains(path) }
        XCTAssertTrue(rearmed, "pre-fix `openRequestedPaths` was spent for this model's whole "
                      + "lifetime, so nothing ever self-healed")

        reopen.open()
        let secondOpen = await waitUntil { office.openCalls.count == 2 }
        XCTAssertTrue(secondOpen, "and it must reach the driver as a genuine second open")
        let restored = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(restored, "the automatic re-open must actually land")
        guard case .showCanvas = model.plan else {
            return XCTFail("the joined tab must get its canvas back")
        }
    }

    // MARK: - Rule 3: dirty refusal

    func testRefusesAWriteOnADirtyAdoptedDocumentNamingTheTab() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("dirty.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup")
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        runtime.handle(documentEvent: .modifiedChanged(true), docId: docId)
        let dirtied = await waitUntil { runtime.stateSnapshot.documents[path]?.dirty == true }
        XCTAssertTrue(dirtied, "setup: the document never became dirty")

        var actionRan = false
        do {
            _ = try await host.officeAgentBroker.perform(
                sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString
            ) { _, _, _ in actionRan = true; return "should not run" }
            XCTFail("a write on a dirty adopted document must refuse")
        } catch let error as OfficeAgentBrokerError {
            guard case .documentDirty(let refusedPath) = error else {
                return XCTFail("expected .documentDirty, got \(error)")
            }
            XCTAssertEqual(refusedPath, path)
            XCTAssertTrue(error.message.contains("dirty.xlsx"), "the refusal must name the tab: \(error.message)")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertFalse(actionRan, "the write's own action must never run once refused")
        XCTAssertEqual(office.saveCalls.count, 0, "a refused write must never reach save-through")
        XCTAssertEqual(office.closeCalls.count, 0, "a dirty-refused ADOPTED document must never be closed")
    }

    func testAllowsAReadOnADirtyAdoptedDocument() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("dirty-read.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup")
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        runtime.handle(documentEvent: .modifiedChanged(true), docId: docId)
        let dirtied = await waitUntil { runtime.stateSnapshot.documents[path]?.dirty == true }
        XCTAssertTrue(dirtied, "setup")

        let result = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
        ) { _, _, _ in "read the dirty in-memory state" }

        XCTAssertEqual(result, "read the dirty in-memory state", "reads must proceed on a dirty document")
    }

    // MARK: - Coordinator review F3 (2026-08-22): read-only-format refusal runs before the action

    /// Mirrors `testFenceRefusalNeverTouchesAnyRuntimeDoor`'s own shape and reasoning: the read-only
    /// check is pure and path-only, so it must refuse before EITHER runtime door is ever consulted —
    /// there is nothing to adopt or open a write verb was always going to be refused on.
    func testReadOnlyFormatRefusalOnAWriteNeverTouchesAnyRuntimeDoor() async {
        let counting = CountingHost()
        counting.dirsAnswer = [SessionDirEntry(path: "/repo", locked: true)]
        let broker = OfficeAgentBroker(host: counting.host)

        do {
            _ = try await broker.perform(sessionId: "S1", path: "/repo/locked.xlsm", access: .write,
                                         requestId: UUID().uuidString) { _, _, _ in "unreached" }
            XCTFail("a write on a read-only format must refuse")
        } catch let error as OfficeAgentBrokerError {
            guard case .saveFailed(let path, let reason) = error else {
                return XCTFail("expected .saveFailed, got \(error)")
            }
            XCTAssertEqual(path, "/repo/locked.xlsm")
            XCTAssertTrue(reason.contains("can't be saved"), "unexpected reason: \(reason)")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertEqual(counting.existingRuntimeCalls, 0, "the read-only refusal must run before any "
                       + "runtime door — nothing to adopt or open here")
        XCTAssertEqual(counting.mintCalls, 0)
    }

    /// **The scenario the review actually named**: an ADOPTED read-only-format document (already open
    /// in the user's own tab) must refuse a write BEFORE `action` runs — pre-fix, this predicate was
    /// consulted only after `action` had already mutated the adopted document with no way to persist
    /// or roll back the edit.
    func testRefusesAWriteOnAnAdoptedReadOnlyFormatDocumentBeforeTheActionRuns() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("locked.xlsm").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup")
        XCTAssertEqual(office.openCalls.count, 1, "setup sanity")

        var actionRan = false
        do {
            _ = try await host.officeAgentBroker.perform(
                sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString
            ) { _, _, _ in actionRan = true; return "should not run" }
            XCTFail("a write on a read-only-format document must refuse")
        } catch let error as OfficeAgentBrokerError {
            guard case .saveFailed(let refusedPath, let reason) = error else {
                return XCTFail("expected .saveFailed, got \(error)")
            }
            XCTAssertEqual(refusedPath, path)
            XCTAssertTrue(reason.contains("can't be saved"), "unexpected reason: \(reason)")
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertFalse(actionRan, "the action must never run once a read-only format is refused")
        XCTAssertEqual(office.saveCalls.count, 0, "a refused write must never reach save-through")
        XCTAssertEqual(office.closeCalls.count, 0, "an adopted document must never be closed by the agent")
        XCTAssertEqual(office.openCalls.count, 1, "adoption must never open a second time")
    }

    /// Reads are unaffected — a read-only format is still perfectly readable.
    func testAllowsAReadOnAReadOnlyFormatDocument() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("locked.odg").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let result = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
        ) { _, _, _ in "read a read-only format" }

        XCTAssertEqual(result, "read a read-only format")
    }

    // MARK: - Rule 4: save-through

    func testWriteVerbSavesThroughAndReturnsTheActionsResultOnSuccess() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("write.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let renderedPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("rendered-\(UUID().uuidString).xlsx").path
        try Data("rendered bytes".utf8).write(to: URL(fileURLWithPath: renderedPath))

        let result = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString
        ) { _, docId, _ in
            office.saveTempPaths[docId] = renderedPath
            return "wrote 3 cells"
        }

        XCTAssertEqual(result, "wrote 3 cells", "a successful save-through returns the ACTION's own result")
        XCTAssertEqual(office.saveCalls.count, 1, "a write verb must save exactly once")
        XCTAssertEqual(try? String(contentsOfFile: path, encoding: .utf8), "rendered bytes",
                       "the rendered bytes must have LANDED on the real path, not merely been requested")
    }

    /// **The drain, pinned.** This task's own live drills found that closing a document immediately
    /// after `saveAndAwaitOutcome` resolves `.saved` — before LOK's own, separate
    /// `.uno:ModifiedStatus=false` callback lands — kills the shared office helper roughly 4 times out
    /// of 5 (`task-2-report.md`'s evidence table). `runOnce` now drains `dirty` back to `!= true`
    /// before it returns OR lets rule 2's `defer` close anything. Proven here the same way a real edit
    /// would drive it: the action injects `.modifiedChanged(true)` directly on the runtime (the fake
    /// driver has no LOK behind it to fire the callback itself), `perform` must NOT return and rule
    /// 2's close must NOT fire while dirty is still `true` after a successful save, and both must
    /// happen once — and only once — the (also directly injected) `.modifiedChanged(false)` arrives,
    /// mirroring LOK's own later, asynchronous round trip.
    func testWriteVerbDrainsDirtyBeforeReturningAndBeforeClosingASelfOpenedDocument() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("drain.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        final class ResultBox: @unchecked Sendable { var value: String? }
        let resultBox = ResultBox()

        let performTask = Task<String, Error> { @MainActor in
            let value = try await host.officeAgentBroker.perform(
                sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString
            ) { runtime, docId, _ in
                // A rendered file the driver's own `saveTempPaths` names — mirrors every OTHER
                // write-success test's own setup (`testWriteVerbSavesThroughAndReturnsTheActions
                // ResultOnSuccess`): the recorder's un-set fallback path never exists on disk, so
                // WITHOUT this, `placeAtomically`'s own stat-before-rename throws and the save
                // resolves `.failed` — never reaching the drain this test exists to prove at all.
                let rendered = FileManager.default.temporaryDirectory
                    .appendingPathComponent("drain-\(UUID().uuidString).xlsx").path
                try? Data("edited bytes".utf8).write(to: URL(fileURLWithPath: rendered))
                office.saveTempPaths[docId] = rendered
                // The realistic flow: a real edit's own `.uno:ModifiedStatus=true` callback would
                // land through exactly this door (`ShellSessionHost.wireOfficeTileCallbacks`'s own
                // routing) — injected directly since the fake driver has nothing behind it to fire it.
                runtime.handle(documentEvent: .modifiedChanged(true), docId: docId)
                return "edited"
            }
            resultBox.value = value
            return value
        }

        let runtime = host.officeRuntime(for: "S1")
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup: never opened")
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)

        let saved = await waitUntil { office.saveCalls.count == 1 }
        XCTAssertTrue(saved, "setup: save never reached the driver")

        // A beat for `perform` to have wrongly returned/closed already, if the drain were absent.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertNil(resultBox.value, "perform must not return while dirty is still true after a "
                     + "successful save — the drain must still be waiting")
        XCTAssertEqual(office.closeCalls.count, 0, "rule 2's close must not fire before the drain resolves")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true,
                       "sanity: still dirty — no ModifiedStatus=false injected yet")

        // LOK's own later, separate callback, arriving asynchronously exactly as it does in production.
        runtime.handle(documentEvent: .modifiedChanged(false), docId: docId)

        let result = try await performTask.value
        XCTAssertEqual(result, "edited")
        // The driver-level close runs inside a spawned effect Task (the same race
        // `testOpensAPathThatIsNotCurrentlyOpenAndClosesItAfterward` already documents and waits
        // out) — `performTask.value` resuming proves the REDUCER's state settled, not that the
        // driver has been told yet.
        let closed = await waitUntil { office.closeCalls.count == 1 }
        XCTAssertTrue(closed, "close must fire only once the drain has resolved")
    }

    /// **CHARACTERIZATION — pins what the broker's drain does TODAY on the path it cannot cover,
    /// deliberately NOT written to make a fix look present.** Sibling to
    /// `testWriteVerbDrainsDirtyBeforeReturningAndBeforeClosingASelfOpenedDocument` directly above,
    /// which pins the drain genuinely WAITING when `dirty == true`. This one pins the opposite leg:
    /// when `dirty` is already `!= true` at the moment `.saved` lands, `drainDirty` performs **no
    /// wait at all** — `perform` returns and rule 2's `defer` closes with nothing ever waited for.
    ///
    /// **Why that leg matters, and why it is not merely theoretical.** `OfficeRuntimeReducer`'s
    /// `.saveSucceeded` arm clears `dirty` SYNCHRONOUSLY, with no LOK callback behind it, for the two
    /// app-held cases `restoredPendingSave` (a recovery-sidecar restore) and `saveFailedPendingSave`
    /// (a retry succeeding after an earlier failure) — pinned by
    /// `OfficeRuntimeReducerTests.testSaveSucceededClearsDirtyAndRestoredPendingSaveWhenSetByARestore`,
    /// against the ordinary-edit control `testSaveSucceededDoesNotForceDirtyFalseForAnOrdinaryEdit`.
    /// So on those two REACHABLE paths the drain characterized here is **inert**, and a close follows
    /// a successful save with zero barrier — the very shape `main`'s own fix-round review
    /// (IMPORTANT-1) identified and closed for the dirty-close SHEET by replacing the `dirty` barrier
    /// with an unconditional real helper round trip (`OfficeRuntime.drainUntilClean`). The broker's
    /// own drain has not had that treatment; see `drainDirty`'s own header for the divergence and why
    /// it is documented rather than patched.
    ///
    /// **On the construction, stated plainly rather than overclaimed.** This drives the inert leg by
    /// never making the document dirty in the first place, not by staging a real sidecar restore
    /// (which needs a live helper, an autosave sidecar and a crash — `OfficeRuntimeLiveTests`' own
    /// recovery drill). That is a faithful probe of THIS function specifically because `drainDirty`
    /// reads nothing but `documents[path]?.dirty`: every route to `dirty != true` at `.saved` enters
    /// the identical branch, so what is measured here is exactly what the recovery routes get. The
    /// reducer tests named above pin those routes actually reaching this state; this test pins what
    /// the drain then does about it. Neither half is inferred.
    ///
    /// **Removing `drainDirty`'s `dirty == true` entry guard would NOT change this result** — the
    /// barrier below it is a `runtime.$state.sink` whose own `dirty != true` check resolves on
    /// `@Published`'s synchronous replay to a new subscriber (this file's own `awaitOpen` header
    /// states and depends on that replay). The guard is a fast path to a conclusion the sink reaches
    /// regardless; the unsound part is the `dirty`-watching BARRIER, not the guard. Measured, not
    /// argued: with the guard deleted this suite ran 37/37 indistinguishable.
    func testCharacterizationWriteVerbsDrainDoesNotWaitAtAllWhenDirtyIsAlreadyClearAtSaveTime() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("draininert.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        final class DirtyAtSaveBox: @unchecked Sendable { var value: Bool? }
        let dirtyAtSave = DirtyAtSaveBox()

        let started = Date()
        let result = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString
        ) { runtime, docId, _ in
            let rendered = FileManager.default.temporaryDirectory
                .appendingPathComponent("draininert-\(UUID().uuidString).xlsx").path
            try? Data("edited bytes".utf8).write(to: URL(fileURLWithPath: rendered))
            office.saveTempPaths[docId] = rendered
            // **The whole point: NO `.modifiedChanged(true)` injection.** The sibling test above
            // injects it to drive the waiting leg; withholding it leaves `dirty == false` when
            // `.saved` lands, which is the state the two reducer-cleared cases also arrive in.
            dirtyAtSave.value = runtime.stateSnapshot.documents[path]?.dirty
            return "edited"
        }
        let elapsed = Date().timeIntervalSince(started)

        XCTAssertEqual(result, "edited")
        XCTAssertEqual(dirtyAtSave.value, false, "setup: this test is only meaningful if the document "
                       + "really is clean when the save lands — otherwise it silently becomes a "
                       + "duplicate of the waiting-leg test above")

        // The characterization itself: no barrier ran. Nothing ever injected a
        // `.modifiedChanged(false)`, and yet `perform` returned — so the drain waited for nothing.
        // The bound is deliberately far below `drainDirty`'s own 15s timeout: this pins that the
        // drain returned IMMEDIATELY, not that it merely finished eventually by timing out.
        XCTAssertLessThan(elapsed, 5.0, "the drain must have returned without waiting — an elapsed "
                          + "time near drainDirty's own 15s bound would mean it blocked and timed "
                          + "out instead, which is DIFFERENT behaviour than this pins")

        let closed = await waitUntil { office.closeCalls.count == 1 }
        XCTAssertTrue(closed, "rule 2's defer still closes what this call opened")
        XCTAssertEqual(office.saveCalls.count, 1, "sanity: the save really did run — an inert drain "
                       + "after NO save would prove nothing about the drain at all")
    }


    /// **Deliberately built on the ADOPTED shape, not the open-fresh one.** An open-fresh write that
    /// fails is closed by this call's own `defer` the instant the error propagates (rule 2 — close
    /// only what you opened, unconditionally) — a document nobody was ever watching, so there is
    /// nothing left afterward to assert `dirty` against; the failure is still reported honestly, it
    /// just leaves no in-memory copy to inspect. Stage B's own C1 lesson ("a failed place must leave
    /// the document dirty") is a promise to whoever is WATCHING the tab, so this proves it on a
    /// document a call adopted rather than opened, where that promise actually has a reader.
    func testFailedSaveSurfacesAsTheVerbsFailureAndLeavesAnAdoptedDocumentDirty() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("savefail.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(path)
        let opened = await waitUntil { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertTrue(opened, "setup")

        do {
            _ = try await host.officeAgentBroker.perform(
                sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString
            ) { _, docId, _ in
                office.saveFailures[docId] = "disk full"
                return "should not be reported as success"
            }
            XCTFail("a save that fails at the place step must surface as the verb's own failure")
        } catch let error as OfficeAgentBrokerError {
            guard case .saveFailed(let failedPath, let reason) = error else {
                return XCTFail("expected .saveFailed, got \(error)")
            }
            XCTAssertEqual(failedPath, path)
            XCTAssertEqual(reason, "disk full", "the mapped reason must reach the caller, not a generic string")
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        // Rule 2, a bonus proof on the failure path: an ADOPTED document is never closed, whatever
        // the outcome. Stage B's own C1 lesson: a failed place must leave the document DIRTY —
        // proven here by asking the runtime itself, never by trusting the thrown error alone.
        XCTAssertNotNil(runtime.stateSnapshot.documents[path], "a failed write must never close an adopted document")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true,
                       "a failed save must leave the document dirty for whoever looks next")
    }

    func testReadVerbNeverSaves() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("read.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        _ = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .read, requestId: UUID().uuidString
        ) { _, _, _ in "read" }

        XCTAssertEqual(office.saveCalls.count, 0, "a read verb must never save")
    }

    // MARK: - The double-mutation story: requestId-keyed replay

    func testReplayWithTheSameRequestIdReturnsTheFirstOutcomeWithoutRerunningTheAction() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("replay.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        var runCount = 0
        let requestId = UUID().uuidString
        let action: (OfficeRuntime, String, Bool) async throws -> String = { _, docId, _ in
            runCount += 1
            office.saveTempPaths[docId] = office.saveTempPaths[docId] ?? {
                let rendered = FileManager.default.temporaryDirectory
                    .appendingPathComponent("replay-\(UUID().uuidString).xlsx").path
                try? Data("v1".utf8).write(to: URL(fileURLWithPath: rendered))
                return rendered
            }()
            return "attempt \(runCount)"
        }

        let first = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: requestId, action: action)
        let second = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: requestId, action: action)

        XCTAssertEqual(first, second, "a replayed requestId must return the FIRST outcome")
        XCTAssertEqual(first, "attempt 1")
        XCTAssertEqual(runCount, 1, "the action must not re-run for a sequential replay either")
        XCTAssertEqual(office.saveCalls.count, 1, "a replay must not save a second time")
    }

    /// **The pinned test for this task's own hard requirement.** A completed-outcome-only cache
    /// would pass a SEQUENTIAL replay test (attempt 1 fully finished before attempt 2 starts) while
    /// still double-applying the exact scenario the requirement exists for: a retry that arrives
    /// WHILE attempt 1 is still in flight, because that is precisely why the daemon's deadline fired.
    /// This test forces that overlap directly: attempt 1 is gated mid-ACTION on a test-controlled
    /// flag, attempt 2 (same `requestId`) is issued while attempt 1 is still blocked there, then the
    /// gate is released — proving the action ran exactly once and both callers observed the identical
    /// outcome, not merely that a LATER call finds an earlier one's memo.
    func testReplayJoinsAnInFlightAttemptRatherThanRerunningTheAction() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("concurrent-replay.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        let renderedPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("concurrent-replay-rendered-\(UUID().uuidString).xlsx").path
        try Data("rendered".utf8).write(to: URL(fileURLWithPath: renderedPath))

        var runCount = 0
        var gateOpen = false
        let requestId = UUID().uuidString
        let action: (OfficeRuntime, String, Bool) async throws -> String = { _, docId, _ in
            runCount += 1
            office.saveTempPaths[docId] = renderedPath
            while !gateOpen { try? await Task.sleep(nanoseconds: 5_000_000) }
            return "the one true outcome"
        }

        let task1 = Task { try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: requestId, action: action) }

        // Wait until attempt 1 has genuinely reached (and is blocked inside) the action — i.e.,
        // fence/adopt-or-open have already run, and only the gate stands between it and save-through.
        let reachedAction = await waitUntil { runCount == 1 }
        XCTAssertTrue(reachedAction, "attempt 1 never reached its own action")

        // Issue attempt 2 with the SAME token WHILE attempt 1 is still blocked mid-action.
        let task2 = Task { try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: requestId, action: action) }
        // Give attempt 2 a real chance to (wrongly) launch a second, independent run before the gate
        // opens — if the cache only memoized completed outcomes, this is exactly where it would.
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(runCount, 1, "a second call with the same token must not start a second run")

        gateOpen = true
        let result1 = try await task1.value
        let result2 = try await task2.value

        XCTAssertEqual(runCount, 1, "the action must have run exactly once, ever, for this token")
        XCTAssertEqual(result1, "the one true outcome")
        XCTAssertEqual(result2, result1, "both callers must observe the SAME outcome")
        XCTAssertEqual(office.saveCalls.count, 1, "save-through must not double-fire for one token")
    }

    func testADifferentRequestIdRunsTheActionAgain() async throws {
        let scratch = makeScratchDirectory()
        let path = scratch.appendingPathComponent("distinct.xlsx").path
        writeDummyFile(at: path)
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: scratch.path, locked: true)])
        await host.directory.refresh()

        var runCount = 0
        let action: (OfficeRuntime, String, Bool) async throws -> String = { _, docId, _ in
            runCount += 1
            let rendered = FileManager.default.temporaryDirectory
                .appendingPathComponent("distinct-\(UUID().uuidString).xlsx").path
            try? Data("x".utf8).write(to: URL(fileURLWithPath: rendered))
            office.saveTempPaths[docId] = rendered
            return "run \(runCount)"
        }

        _ = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString, action: action)
        _ = try await host.officeAgentBroker.perform(
            sessionId: "S1", path: path, access: .write, requestId: UUID().uuidString, action: action)

        XCTAssertEqual(runCount, 2, "two DIFFERENT tokens are two genuinely different attempts")
    }

    // MARK: - ShellSessionHost wiring

    func testShellSessionHostOfficeAgentBrokerIsTheSameInstanceAcrossAccesses() {
        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        XCTAssertTrue(host.officeAgentBroker === host.officeAgentBroker, "a lazily-minted singleton, not a fresh one per access")
    }

    func testShellSessionHostOfficeAgentBrokerRefusesOutOfFenceUsingTheRealDirectory() async throws {
        let office = BrokerOfficeDriverRecorder()
        let host = makeHost(office: office, dirs: [SessionDirEntry(path: "/repo", locked: true)])
        await host.directory.refresh()

        do {
            _ = try await host.officeAgentBroker.perform(
                sessionId: "S1", path: "/somewhere/else.xlsx", access: .read, requestId: UUID().uuidString
            ) { _, _, _ in "unreached" }
            XCTFail("a path outside the real session's own dirs must refuse")
        } catch let error as OfficeAgentBrokerError {
            XCTAssertEqual(error, .outOfFence(path: "/somewhere/else.xlsx"))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertNil(host.existingOfficeRuntime(for: "S1"), "an out-of-fence refusal must never mint a runtime")
    }

    // MARK: - Live drills (real supervisor, real helper, real vendored LibreOffice)
    //
    // Gated exactly like `OfficeRuntimeLiveTests`: skip, never fail, when the engine is not present
    // in this run's `BUILT_PRODUCTS_DIR`. Second-copy hygiene throughout — a scratch state directory
    // under `/tmp`, never `~/.norma*`.

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
    private static var sandboxProfilePath: URL {
        repoRoot.appendingPathComponent("apple/Norma/Sources/OfficeHelper/office-helper.sb", isDirectory: false)
    }

    /// A single "T" keystroke, delivered through the raw `OfficeHelperClient` and AWAITED at every
    /// step — mirroring `OfficeRuntimeLiveTests.postRealEdit` verbatim, not merely "in shape".
    ///
    /// **Why not `OfficeRuntime.postKeyEvent(path:)`/`postMouseEvent(path:)`, this file's own first
    /// attempt: those doors are fire-and-forget API surface, real regardless of the drain fix below.**
    /// They append to `OfficeRuntime`'s own `inputChainTail` and return immediately; the caller has no
    /// way to await delivery, so `dirty == true` only proves the FIRST posted event landed, not the
    /// last. **This file's build 2/3 failures were originally attributed to that gap — WRONG, corrected
    /// after the fact:** repeated isolated reruns showed this SAME awaited `client.postKey` mechanism
    /// (used here from the start of build 4 onward, no chain-tail possible) still failed the
    /// close-then-reopen live drill roughly 4 times out of 5. The actual cause was the broker closing
    /// immediately after a successful save, before LOK's own `.uno:ModifiedStatus=false` callback
    /// landed — fixed by `OfficeAgentBroker.drainDirty`, not by anything about how these keystrokes are
    /// posted. Builds 2–5's own account, and the diagnostic matrix that found the real cause, are in
    /// `task-2-report.md`'s appendix.
    ///
    /// The fire-and-forget fact about `postKeyEvent(path:)`/`postMouseEvent(path:)` stands on its own
    /// regardless: `dirty == true` still only proves the FIRST posted event landed, and Task 3's
    /// mutation verbs (which will very likely use these exact doors, or ones shaped like them) should
    /// know that going in — disclosed in this file's own concerns list in the task report as an API
    /// hazard, not the helper-kill mechanism it was first mistaken for.
    private func typeOneCharacter(client: OfficeHelperClient, docId: String) async throws {
        try await client.postMouse(docId: docId, part: 0, type: .buttonDown, xTwips: 100, yTwips: 100,
                                   count: 1, buttons: 1, modifiers: 0)
        try await client.postMouse(docId: docId, part: 0, type: .buttonUp, xTwips: 100, yTwips: 100,
                                   count: 1, buttons: 1, modifiers: 0)
        let keyCode = 531 | 0x1000 // "T" (postRealEdit's own table, OfficeRuntimeLiveTests.swift)
        let charCode = Int(Character("T").asciiValue!)
        try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: charCode, keyCode: keyCode)
        try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: charCode, keyCode: keyCode)
        // `postRealEdit`'s own comment (`OfficeRuntimeLiveTests.swift`): Return "commits a pending
        // Calc cell edit (Calc's own semantics)" — without it the typed character can sit in an
        // uncommitted cell editor when save fires. Harmless for Writer (a paragraph break).
        try await client.postKey(docId: docId, part: 0, type: .keyInput, charCode: 0, keyCode: 1280)
        try await client.postKey(docId: docId, part: 0, type: .keyUp, charCode: 0, keyCode: 1280)
    }

    private func waitUntilLive(timeout: TimeInterval, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return true
    }

    /// **Adoption repaints an open tab.** Proven the same way `OfficeRuntimeLiveTests` proves "the
    /// SAME open document, not a reload in disguise": the docId the action receives is asserted equal
    /// to the docId a plain `runtime.open` already produced before the broker was ever called, and
    /// the document is STILL open, under that SAME docId, afterward — the mechanism that causes a
    /// live canvas subscribed to that docId to repaint (LOK's own invalidation, unchanged by this
    /// task) rather than the screen-capture proof itself, which is the UI-level gate's job (design
    /// spec §8), not this one's.
    func testLiveAdoptionEditsTheAlreadyOpenDocumentInPlaceAndNeverClosesIt() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.ods fixture missing")

        let stateDir = makeScratchDirectory()
        let scratch = makeScratchDirectory()
        let docPath = scratch.appendingPathComponent("adopt-live.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        let runtime = host.officeRuntime(for: "S1")
        runtime.open(docPath)
        let opened = await waitUntilLive(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(opened, "setup: gate.ods never settled — phase \(runtime.stateSnapshot.phase)")
        let originalDocId = try XCTUnwrap(runtime.stateSnapshot.documents[docPath]?.docId,
                                          "setup: \(runtime.stateSnapshot.openFailures[docPath] ?? "no reason")")

        let beforeStat = officeFileStat(atPath: docPath)

        // "Adoption repaints an open tab" — a stat/inode change alone proves A save landed, not that
        // THE EDIT landed (any save mints a fresh inode, and even a no-op re-render can shift
        // zip-internal bytes). Painting BEFORE the edit and comparing pixels AFTER, mirroring
        // `OfficeRuntimeLiveTests.testSaveThroughTheRealEditDoor...`'s own proof shape, is what turns
        // this into an observed repaint rather than an inference from docId equality.
        let zoomPPT = 1000
        let tileKey = TileKey(part: 0, zoomPPT: zoomPPT, tileX: 0, tileY: 0)
        let viewport = officeViewportTwips(scrollOrigin: .zero, visibleSize: CGSize(width: 256, height: 256),
                                           zoomPPT: zoomPPT)
        runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let paintedBefore = await waitUntilLive(timeout: 30) {
            runtime.tileStore.tile(docId: originalDocId, key: tileKey) != nil
        }
        XCTAssertTrue(paintedBefore, "the pre-edit tile never arrived")
        let pixelsBefore = try XCTUnwrap(runtime.tileStore.tile(docId: originalDocId, key: tileKey)).pixels

        guard let client = host.officeHelperSupervisor?.client else {
            XCTFail("no live client to drive the real edit door through")
            return
        }

        let broker = OfficeAgentBroker(host: .init(
            existingRuntime: { host.existingOfficeRuntime(for: $0) },
            runtime: { host.officeRuntime(for: $0) },
            workingDirectories: { _ in [SessionDirEntry(path: scratch.path, locked: true)] }))

        let result = try await broker.perform(
            sessionId: "S1", path: docPath, access: .write, requestId: UUID().uuidString
        ) { actionRuntime, docId, _ in
            XCTAssertEqual(docId, originalDocId, "adoption must reuse the ALREADY-open document")
            try await self.typeOneCharacter(client: client, docId: docId)
            let dirtied = await self.waitUntilLive(timeout: 15) {
                actionRuntime.stateSnapshot.documents[docPath]?.dirty == true
            }
            XCTAssertTrue(dirtied, "the edit never landed")
            return "edited"
        }
        XCTAssertEqual(result, "edited")

        XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.docId, originalDocId,
                       "adoption must never close/reopen the tab's own document")
        let becameClean = await waitUntilLive(timeout: 15) { runtime.stateSnapshot.documents[docPath]?.dirty == false }
        XCTAssertTrue(becameClean, "save-through must clear the dirty dot on success")
        XCTAssertNotEqual(officeFileStat(atPath: docPath), beforeStat, "the save never reached the real path")

        runtime.subscribeTiles(path: docPath, part: 0, zoomPPT: zoomPPT, viewportTwips: viewport)
        let repainted = await waitUntilLive(timeout: 30) {
            // Deliberately NOT `tile(...)?.pixels != pixelsBefore`: the tile store can EVICT a slot
            // during its own invalidate-then-refetch cycle, and `nil != .some(pixelsBefore)` reads
            // `true` in that window — a wait phrased that way can go green on "the tile vanished",
            // never having observed a new, different tile at all. Requiring a PRESENT tile that
            // differs is what makes this an observed repaint rather than an artifact of eviction
            // timing.
            guard let pixels = runtime.tileStore.tile(docId: originalDocId, key: tileKey)?.pixels else {
                return false
            }
            return pixels != pixelsBefore
        }
        XCTAssertTrue(repainted, "the canvas never repainted — the edit's own tile invalidation never "
                      + "arrived (or arrived with the SAME pixels the pre-edit paint already had)")

        runtime.close(docPath)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// **A not-open document round-trips and is closed after.** Proven by: the bytes on disk changed
    /// (the write really happened), those bytes are a well-formed ODF zip carrying the typed edit (not
    /// merely "different" — the house norm, "a write is proven by the saved file's own bytes, never by
    /// a return code," made literal), the document is gone from `documents[path]` the instant the
    /// broker call returns (rule 2, self-opened is self-closed), and reopening it shows the edit was
    /// genuinely persisted, not merely staged (the "round-trip" the brief's own step line names).
    ///
    /// **This is also this task's committed regression tripwire for the helper-kill bug the drain
    /// fixes** (`OfficeAgentBroker.drainDirty`'s own header, `task-2-report.md`'s evidence table):
    /// close-then-immediate-reopen on the SAME runtime is exactly the shape that measured ~4/5 fatal
    /// to the shared helper before the drain existed. Left on the same runtime deliberately, not moved
    /// to a fresh host/supervisor — a fresh host would prove the WRITE survived but could no longer
    /// prove the HELPER did, which is the half of this drill that actually caught the bug.
    func testLiveANotOpenDocumentRoundTripsThroughTheBrokerAndIsClosedAfterward() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.ods fixture missing")

        let stateDir = makeScratchDirectory()
        let scratch = makeScratchDirectory()
        let docPath = scratch.appendingPathComponent("open-live.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: docPath))

        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }
        XCTAssertNil(host.existingOfficeRuntime(for: "S1"), "setup: nothing has touched office yet")

        let beforeStat = officeFileStat(atPath: docPath)

        let broker = OfficeAgentBroker(host: .init(
            existingRuntime: { host.existingOfficeRuntime(for: $0) },
            runtime: { host.officeRuntime(for: $0) },
            workingDirectories: { _ in [SessionDirEntry(path: scratch.path, locked: true)] }))

        let result = try await broker.perform(
            sessionId: "S1", path: docPath, access: .write, requestId: UUID().uuidString
        ) { actionRuntime, docId, _ in
            // Looked up here, not before `perform`: the broker itself mints the runtime (this path
            // is not yet open), and only that minting brings the supervisor — and its client — into
            // existence. By the time this closure runs the broker has already opened the document,
            // so the supervisor is guaranteed live.
            guard let client = host.officeHelperSupervisor?.client else {
                XCTFail("no live client to drive the real edit door through")
                return "unreached"
            }
            try await self.typeOneCharacter(client: client, docId: docId)
            let dirtied = await self.waitUntilLive(timeout: 15) {
                actionRuntime.stateSnapshot.documents[docPath]?.dirty == true
            }
            XCTAssertTrue(dirtied, "the edit never landed")
            return "edited"
        }
        XCTAssertEqual(result, "edited")

        let runtime = try XCTUnwrap(host.existingOfficeRuntime(for: "S1"), "opening must have minted a runtime")
        XCTAssertNil(runtime.stateSnapshot.documents[docPath],
                     "a document this call opened itself must be closed once the verb is done — "
                       + "close is synchronous in the reducer's own state")
        XCTAssertNotEqual(officeFileStat(atPath: docPath), beforeStat, "the save never reached the real path")

        // The house norm made literal, BEFORE any reopen: a well-formed ODF zip (PK signature, the
        // mimetype/content.xml entries a valid .ods must carry) with the typed edit inside it — proven
        // from the saved file's own bytes, independent of whether LOK can later re-parse them. This is
        // what pinned, empirically, that the bug the drain fixes was ALWAYS a helper-liveness problem,
        // never a corruption one: every diagnostic sample this task collected, including every failing
        // one, passed exactly this check (`task-2-report.md`'s evidence table).
        let savedBytes = try Data(contentsOf: URL(fileURLWithPath: docPath))
        XCTAssertEqual(savedBytes.prefix(4), Data([0x50, 0x4B, 0x03, 0x04]), "not a well-formed zip")
        XCTAssertTrue(savedBytes.range(of: Data("mimetype".utf8)) != nil, "missing the ODF mimetype entry")
        XCTAssertTrue(savedBytes.range(of: Data("content.xml".utf8)) != nil, "missing content.xml")

        // Round-trip: reopen and confirm the edit was genuinely persisted, not merely staged.
        runtime.open(docPath)
        let reopened = await waitUntilLive(timeout: 90) {
            runtime.stateSnapshot.documents[docPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the saved file never reopened — phase \(runtime.stateSnapshot.phase)")
        XCTAssertNotNil(runtime.stateSnapshot.documents[docPath],
                        "reopen failed — phase=\(runtime.stateSnapshot.phase) reason="
                          + "\(runtime.stateSnapshot.openFailures[docPath] ?? "no reason recorded") — "
                          + "the bytes above already proved this is not corruption; see "
                          + "OfficeAgentBroker.drainDirty and task-2-report.md if this regresses")
        XCTAssertEqual(runtime.stateSnapshot.documents[docPath]?.dirty, false,
                       "a fresh reopen of the saved bytes starts clean")

        runtime.close(docPath)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }

    /// **M4 (coordinator review, 2026-08-22): the self-opened READ close path had no live coverage.**
    /// Every `info`/read verb on a not-currently-open document does open → action → IMMEDIATE close,
    /// with no save and no drain — the same undrained-close SHAPE the drain fix exists for, but on a
    /// path the report's own mechanism (LOK's pending post-save `ModifiedStatus=false`) says should be
    /// safe: nothing was ever saved, so there is nothing pending left to race. This drill confirms that
    /// reasoning empirically instead of leaving it asserted. **Proof mirrors how the drain bug was
    /// actually caught**: not the close returning cleanly (it always did, even under the original bug),
    /// but a SUBSEQUENT open of a DIFFERENT document succeeding afterward, on the SAME shared helper —
    /// run repeatedly in isolation before trusting it, given this task's own history of a coincidence
    /// (build 4's single pass) being misread as proof (`task-2-report.md`'s evidence table).
    func testLiveASelfOpenedReadClosesImmediatelyWithNoDrainAndTheHelperSurvives() async throws {
        let helperURL = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("NormaOfficeHelper")
        try XCTSkipIf(!FileManager.default.fileExists(atPath: helperURL.path),
                      "NormaOfficeHelper was not built into this run's BUILT_PRODUCTS_DIR "
                        + "(\(helperURL.path)) — add it to the scheme's build list and re-run.")
        let vendorRoot = Self.vendorProductSetRoot
        try XCTSkipIf(!FileManager.default.fileExists(atPath: vendorRoot.appendingPathComponent("Frameworks").path),
                      "LibreOffice vendor tree not present at \(vendorRoot.path) — run "
                        + "`bun run libreoffice:fetch` from the repo root.")
        let fixturePath = Self.fixturesRoot.appendingPathComponent("gate.ods").path
        try XCTSkipIf(!FileManager.default.fileExists(atPath: fixturePath), "gate.ods fixture missing")

        let stateDir = makeScratchDirectory()
        let scratch = makeScratchDirectory()
        let firstPath = scratch.appendingPathComponent("read-close-live.ods").path
        let secondPath = scratch.appendingPathComponent("read-close-live-2.ods").path
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: firstPath))
        try Data(contentsOf: URL(fileURLWithPath: fixturePath)).write(to: URL(fileURLWithPath: secondPath))

        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.makeOfficeHelperSupervisor = {
            OfficeHelperSupervisor(configuration: OfficeHelperSupervisor.Configuration(
                helperExecutableURL: helperURL,
                socketDirectory: stateDir,
                extraArguments: ["--lok-root", vendorRoot.path, "--sandbox-profile", Self.sandboxProfilePath.path]))
        }

        let broker = OfficeAgentBroker(host: .init(
            existingRuntime: { host.existingOfficeRuntime(for: $0) },
            runtime: { host.officeRuntime(for: $0) },
            workingDirectories: { _ in [SessionDirEntry(path: scratch.path, locked: true)] }))

        // The read verb this drill targets: open → action (no mutation) → immediate close, no save.
        let result = try await broker.perform(
            sessionId: "S1", path: firstPath, access: .read, requestId: UUID().uuidString
        ) { _, docId, _ in "read \(docId)" }
        XCTAssertTrue(result.hasPrefix("read "))

        let runtime = try XCTUnwrap(host.existingOfficeRuntime(for: "S1"), "opening must have minted a runtime")
        XCTAssertNil(runtime.stateSnapshot.documents[firstPath], "a self-opened read must close immediately")

        // The actual proof: the SAME shared helper opens a SECOND, different document afterward —
        // exactly how the drain bug was originally caught (a subsequent open failing on a helper the
        // prior close had silently killed).
        runtime.open(secondPath)
        let reopened = await waitUntilLive(timeout: 90) {
            runtime.stateSnapshot.documents[secondPath] != nil || runtime.stateSnapshot.phase == .failed
        }
        XCTAssertTrue(reopened, "the second document never opened — phase \(runtime.stateSnapshot.phase)")
        XCTAssertNotNil(runtime.stateSnapshot.documents[secondPath],
                        "the shared helper did not survive an immediate close after a self-opened READ "
                          + "— phase=\(runtime.stateSnapshot.phase) reason="
                          + "\(runtime.stateSnapshot.openFailures[secondPath] ?? "no reason recorded")")

        runtime.close(secondPath)
        _ = host.teardownAllOfficeRuntimesAndStopHelper()
    }
}
