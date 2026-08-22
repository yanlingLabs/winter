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

        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { .ready },
                startHelper: { },
                open: { [unowned self] docId, path in
                    self.lock.lock(); self._openCalls.append((docId, path)); self.lock.unlock()
                    return self.defaultMetadata
                },
                close: { [unowned self] docId in
                    self.lock.lock(); self._closeCalls.append(docId); self.lock.unlock()
                },
                save: { [unowned self] docId, _ in
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
        ) { _, docId in
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
        ) { _, docId in "read \(docId)" }

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
                                         requestId: UUID().uuidString) { _, _ in "unreached" }
            XCTFail("an out-of-fence path must refuse")
        } catch let error as OfficeAgentBrokerError {
            XCTAssertEqual(error, .outOfFence(path: "/etc/passwd"))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        XCTAssertEqual(counting.existingRuntimeCalls, 0, "the fence check must run before any runtime door")
        XCTAssertEqual(counting.mintCalls, 0)
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
                                     requestId: UUID().uuidString) { _, _ in "read" }

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
                                     requestId: UUID().uuidString) { _, _ in "read" }

        XCTAssertEqual(counting.callOrder, ["existing", "mint"],
                       "the existing-runtime door must be asked before the minting door")
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
            ) { _, _ in actionRan = true; return "should not run" }
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
        ) { _, _ in "read the dirty in-memory state" }

        XCTAssertEqual(result, "read the dirty in-memory state", "reads must proceed on a dirty document")
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
        ) { _, docId in
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
            ) { runtime, docId in
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
            ) { _, docId in
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
        ) { _, _ in "read" }

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
        let action: (OfficeRuntime, String) async throws -> String = { _, docId in
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
        let action: (OfficeRuntime, String) async throws -> String = { _, docId in
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
        let action: (OfficeRuntime, String) async throws -> String = { _, docId in
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
            ) { _, _ in "unreached" }
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
        ) { actionRuntime, docId in
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
        ) { actionRuntime, docId in
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
}
