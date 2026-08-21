import AppKit
import NormaKit
import XCTest
@testable import Norma

/// editor-product Task 8 — **the save flow: the pull, the timeout, the atomic write, the anchored
/// acknowledgement, and the three triggers that all land in it.**
///
/// What is driven here and what is not: the coordinator is driven through a scripted `Editor` seam
/// and a scheduler under the test's thumb, so every ordering claim (note → write → markSaved) is
/// asserted rather than hoped for; the atomic write is driven against a REAL temporary directory,
/// because "leaves no tmp behind" is a claim about a file system and a double could not be wrong
/// about it; and the three triggers are driven through their real doors — the page's message
/// through the hub, the tab's slot through the registry, the menu item through its own validation.
///
/// The doubles are this suite's own (`EditorRuntimeTests`' convention), except the CEF/slot
/// recorders, which are borrowed exactly as `EditorTabTests` borrows them.
@MainActor
final class EditorSaveTests: XCTestCase {

    // MARK: - Fixtures

    /// Held for the whole test — the seams hand out closure structs that capture these, and one a
    /// test never mentions again is released at its local's last use (`ShellSessionHostTests`
    /// measured that as a real crash).
    private var doubles: [AnyObject] = []
    private var runtimes: [EditorRuntime] = []
    private var scratchDirectories: [URL] = []

    override func tearDown() {
        for runtime in runtimes { runtime.teardown() }
        runtimes.removeAll()
        doubles.removeAll()
        for directory in scratchDirectories { try? FileManager.default.removeItem(at: directory) }
        scratchDirectories.removeAll()
        PanelEditorTabModels.removeAllForTesting()
        super.tearDown()
    }

    private static let file = "/repo/src/engine.ts"

    /// **The scripted editor.** Every seam call is recorded IN ORDER in `log` — which is the only
    /// way the ordering claims can be made at all, since "the note was filed before the write" is
    /// invisible to any per-call counter.
    @MainActor
    private final class EditorDouble {
        private(set) var log: [String] = []
        private(set) var pulls: [(path: String, seq: UInt64)] = []
        private(set) var writes: [(path: String, text: String)] = []
        private(set) var acks: [(path: String, seq: UInt64)] = []
        private(set) var notes: [String] = []
        private(set) var withdrawals: [String] = []

        /// What the page holds open.
        var models: Set<String> = [EditorSaveTests.file]
        /// When set, the write throws it.
        var writeError: Error?
        /// When set, the pull is answered SYNCHRONOUSLY — a page that replies on the same call
        /// stack, which is also the shape that proves the waiter is registered before the ask.
        var synchronousAnswer: String?
        /// Set by the test so the synchronous answer has somewhere to go.
        weak var coordinator: EditorSaveCoordinator?

        var seam: EditorSaveCoordinator.Editor {
            EditorSaveCoordinator.Editor(
                hasModel: { [self] path in models.contains(path) },
                pull: { [self] path, seq in
                    log.append("pull(\(seq))")
                    pulls.append((path, seq))
                    if let text = synchronousAnswer {
                        coordinator?.deliverContentResponse(path: path, seq: seq, text: text)
                    }
                },
                markSaved: { [self] path, seq in
                    log.append("markSaved(\(seq))")
                    acks.append((path, seq))
                },
                noteExpectedWrite: { [self] path in
                    log.append("note")
                    notes.append(path)
                },
                withdrawExpectedWrite: { [self] path in
                    log.append("withdraw")
                    withdrawals.append(path)
                },
                write: { [self] path, text in
                    log.append("write")
                    writes.append((path, text))
                    if let error = writeError { throw error }
                })
        }
    }

    private struct SaveHarness {
        let coordinator: EditorSaveCoordinator
        let editor: EditorDouble
        let scheduler: EditorFakeScheduler
    }

    private func makeCoordinator() -> SaveHarness {
        let editor = EditorDouble()
        let scheduler = EditorFakeScheduler()
        doubles.append(contentsOf: [editor, scheduler] as [AnyObject])
        let coordinator = EditorSaveCoordinator(sessionId: "S1", editor: editor.seam,
                                                scheduler: scheduler.scheduler)
        editor.coordinator = coordinator
        return SaveHarness(coordinator: coordinator, editor: editor, scheduler: scheduler)
    }

    private func waitUntil(_ label: String, _ condition: () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTAssertTrue(condition(), "timed out waiting for \(label)", file: file, line: line)
    }

    private func scratchDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("norma-save-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        scratchDirectories.append(directory)
        return directory
    }

    // MARK: - The loop

    /// **The happy path, and the ordering that makes it safe.**
    ///
    /// `note` before `write` because T9's watcher will see the rename and must already know it was
    /// ours; `write` before `markSaved` because an acknowledgement for bytes that are not on disk is
    /// a dot cleared over unsaved work. Asserted as a SEQUENCE, since each of those is invisible to
    /// a count.
    func testASaveNotesTheWriteWritesThenAcknowledgesWithThePullsOwnSeq() async {
        let harness = makeCoordinator()
        harness.editor.synchronousAnswer = "let a = 1\n"

        let outcome = await harness.coordinator.save(path: Self.file)

        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(harness.editor.log, ["pull(1)", "note", "write", "markSaved(1)"])
        XCTAssertEqual(harness.editor.notes, [Self.file])
        XCTAssertEqual(harness.editor.writes.first?.text, "let a = 1\n",
                       "what the page answered is what is written — byte for byte")
        XCTAssertEqual(harness.editor.acks.first?.seq, harness.editor.pulls.first?.seq,
                       "the acknowledgement carries the PULL's own seq; a fresh number would fail "
                       + "closed at the page and the dot would never clear")
        XCTAssertEqual(harness.editor.withdrawals, [])
        XCTAssertEqual(harness.coordinator.savesInFlight, [], "the coalescing entry is cleared")
    }

    /// **A pull may legally go unanswered, so silence must be the failure detector.** The three
    /// causes (unknown path, `getValue()` throwing, an over-8-MiB reply refused by the decoder) are
    /// indistinguishable from here, which is why the sentence names none of them.
    func testAnUnansweredPullFailsTheSaveOnTheClockAndWritesNothing() async {
        let harness = makeCoordinator()

        let save = Task { await harness.coordinator.save(path: Self.file) }
        await waitUntil("the pull") { harness.editor.pulls.count == 1 }
        XCTAssertEqual(harness.coordinator.pendingPullSeqs, [1])

        XCTAssertTrue(harness.scheduler.fireNextTimer(), "the 5 s pull timeout must be armed")
        let outcome = await save.value

        XCTAssertEqual(outcome, .failed(EditorSaveCoordinator.pullTimeoutMessage))
        XCTAssertEqual(harness.editor.log, ["pull(1)"],
                       "nothing is written and nothing is acknowledged for a save that never had "
                       + "the bytes")
        XCTAssertEqual(harness.coordinator.pendingPullSeqs, [])
        XCTAssertEqual(harness.coordinator.savesInFlight, [])
    }

    /// The timeout is armed at 5 s from the scheduler's own clock, not at some other figure.
    func testThePullTimeoutIsFiveSecondsFromTheSchedulersClock() async {
        let harness = makeCoordinator()
        let start = harness.scheduler.current

        let save = Task { await harness.coordinator.save(path: Self.file) }
        await waitUntil("the pull") { harness.editor.pulls.count == 1 }

        XCTAssertEqual(harness.scheduler.liveTimers.count, 1)
        XCTAssertEqual(harness.scheduler.liveTimers.first?.fireAt,
                       start.addingTimeInterval(EditorSaveCoordinator.pullTimeout))
        XCTAssertEqual(EditorSaveCoordinator.pullTimeout, 5)

        harness.scheduler.fireNextTimer()
        _ = await save.value
    }

    /// **A failed write takes its own note back.** A note is consumed by a file-system EVENT, and a
    /// rename that never happened produces none — the note would sit there and swallow the next
    /// genuine external change to that file.
    func testAWriteThatThrowsFailsWithItsOwnSentenceWithdrawsTheNoteAndNeverAcknowledges() async {
        let harness = makeCoordinator()
        harness.editor.synchronousAnswer = "let a = 1\n"
        harness.editor.writeError = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError,
                                            userInfo: [NSLocalizedDescriptionKey: "No permission."])

        let outcome = await harness.coordinator.save(path: Self.file)

        XCTAssertEqual(outcome, .failed("No permission."),
                       "the file system's own sentence, not a sentence about the file system")
        XCTAssertEqual(harness.editor.log, ["pull(1)", "note", "write", "withdraw"])
        XCTAssertTrue(harness.editor.acks.isEmpty, "a save that did not write must never acknowledge")
    }

    /// **`.noModel` is not a failure.** ⌘S with the panel showing something else, or a save button on
    /// a tab whose runtime a departure released: nothing to save, nothing to say, and nothing sent.
    func testAPathThePageDoesNotHoldIsNoModelAndPullsNothing() async {
        let harness = makeCoordinator()
        harness.editor.models = []

        let outcome = await harness.coordinator.save(path: Self.file)

        XCTAssertEqual(outcome, .noModel)
        XCTAssertEqual(harness.editor.log, [])
        XCTAssertEqual(harness.coordinator.lastMintedSeq, 0, "a save that never asked burns no seq")
    }

    /// **A second trigger for the same file joins the first save rather than starting a second.**
    ///
    /// Not an optimisation: the page remembers ONE pull per model, so a second pull supersedes the
    /// first, and the first save's `markSaved` would then fail closed — a file written to disk with
    /// its dot still showing dirty. Both callers get the one outcome.
    func testASecondSaveForTheSamePathCoalescesOntoTheFirst() async {
        let harness = makeCoordinator()

        let first = Task { await harness.coordinator.save(path: Self.file) }
        await waitUntil("the first pull") { harness.editor.pulls.count == 1 }
        let second = Task { await harness.coordinator.save(path: Self.file) }
        await waitUntil("the second trigger to join") { harness.coordinator.savesInFlight == [Self.file] }

        harness.coordinator.deliverContentResponse(path: Self.file, seq: 1, text: "one")

        let outcomes = await [first.value, second.value]
        XCTAssertEqual(outcomes, [.saved, .saved])
        XCTAssertEqual(harness.editor.pulls.count, 1, "ONE pull for two triggers")
        XCTAssertEqual(harness.editor.writes.count, 1)
        XCTAssertEqual(harness.editor.log, ["pull(1)", "note", "write", "markSaved(1)"])
    }

    /// A save that has FINISHED is not in flight: the coalescing entry is cleared inside the task
    /// body, so the next ⌘S is a real second save rather than a replay of the first one's answer.
    func testTheSeqIsMonotonicAcrossSavesAndEachAcknowledgementCarriesItsOwn() async {
        let harness = makeCoordinator()
        harness.editor.synchronousAnswer = "one"
        let first = await harness.coordinator.save(path: Self.file)
        harness.editor.synchronousAnswer = "two"
        let second = await harness.coordinator.save(path: Self.file)
        XCTAssertEqual([first, second], [.saved, .saved])

        XCTAssertEqual(harness.editor.pulls.map(\.seq), [1, 2])
        XCTAssertEqual(harness.editor.acks.map(\.seq), [1, 2])
        XCTAssertEqual(harness.editor.writes.map(\.text), ["one", "two"],
                       "the second save wrote the second answer — it is not the first one's replay")
        XCTAssertEqual(harness.coordinator.lastMintedSeq, 2)
    }

    /// Two DIFFERENT files save side by side — they share nothing but the counter.
    func testTwoDifferentPathsSaveConcurrently() async {
        let harness = makeCoordinator()
        let other = "/repo/src/panel.ts"
        harness.editor.models = [Self.file, other]

        let first = Task { await harness.coordinator.save(path: Self.file) }
        await waitUntil("the first pull") { harness.editor.pulls.count == 1 }
        let second = Task { await harness.coordinator.save(path: other) }
        await waitUntil("the second pull") { harness.editor.pulls.count == 2 }

        harness.coordinator.deliverContentResponse(path: other, seq: 2, text: "b")
        harness.coordinator.deliverContentResponse(path: Self.file, seq: 1, text: "a")

        let outcomes = await [first.value, second.value]
        XCTAssertEqual(outcomes, [.saved, .saved])
        // By CONTENT, never by resumption order: two independent saves finish on the executor's
        // schedule, and pinning that schedule would be pinning Swift's runtime rather than this flow.
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: harness.editor.writes.map { ($0.path, $0.text) }),
                       [Self.file: "a", other: "b"], "each save wrote ITS own answer")
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: harness.editor.acks.map { ($0.path, $0.seq) }),
                       [Self.file: 1, other: 2], "…and acknowledged with ITS own pull's seq")
    }

    /// **An answer nobody is waiting for is dropped**, in both of its shapes: a superseded/late seq,
    /// and an answer whose path is not the one that pull asked about. Fail closed — writing another
    /// model's bytes into this file is the one mistake this flow must never make.
    func testAnUncorrelatedContentResponseIsDroppedRatherThanUsed() async {
        let harness = makeCoordinator()

        harness.coordinator.deliverContentResponse(path: Self.file, seq: 99, text: "nobody asked")
        XCTAssertEqual(harness.editor.log, [], "an answer with no waiter cannot start anything")

        let save = Task { await harness.coordinator.save(path: Self.file) }
        await waitUntil("the pull") { harness.editor.pulls.count == 1 }

        harness.coordinator.deliverContentResponse(path: "/repo/src/other.ts", seq: 1, text: "wrong file")
        XCTAssertEqual(harness.coordinator.pendingPullSeqs, [1],
                       "the pull is still outstanding — a mismatched path is not its answer")

        harness.coordinator.deliverContentResponse(path: Self.file, seq: 1, text: "right file")
        let outcome = await save.value
        XCTAssertEqual(outcome, .saved)
        XCTAssertEqual(harness.editor.writes.first?.text, "right file")
    }

    /// A late answer arriving after the timeout has already failed the save changes nothing — the
    /// waiter is gone, and the outcome was reported.
    func testAnAnswerArrivingAfterTheTimeoutIsIgnored() async {
        let harness = makeCoordinator()

        let save = Task { await harness.coordinator.save(path: Self.file) }
        await waitUntil("the pull") { harness.editor.pulls.count == 1 }
        harness.scheduler.fireNextTimer()
        let timedOut = await save.value
        XCTAssertEqual(timedOut, .failed(EditorSaveCoordinator.pullTimeoutMessage))

        harness.coordinator.deliverContentResponse(path: Self.file, seq: 1, text: "too late")

        XCTAssertTrue(harness.editor.writes.isEmpty, "nothing is written by an answer to a dead pull")
        XCTAssertTrue(harness.editor.acks.isEmpty)
    }

    // MARK: - The write itself

    /// tmp + rename in the same directory: the destination ends up holding exactly what was written,
    /// and **no temporary file is left beside it**.
    func testTheAtomicWriteReplacesTheFileAndLeavesNoTemporaryBehind() throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("engine.ts").path
        try Data("old\n".utf8).write(to: URL(fileURLWithPath: path))

        try EditorSaveCoordinator.writeAtomically("new — café\r\n", to: path)

        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)),
                       Data("new — café\r\n".utf8), "compared as BYTES, never as a String")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path),
                       ["engine.ts"], "no .norma-save-… survives a successful write")
    }

    /// A brand-new file is created by the same path — the save flow never requires the file to exist
    /// (an editor buffer can outlive the file on disk).
    func testTheAtomicWriteCreatesAFileThatWasNotThere() throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("fresh.ts").path

        try EditorSaveCoordinator.writeAtomically("hello\n", to: path)

        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "hello\n")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["fresh.ts"])
    }

    /// **A save must not silently disarm an executable.** A fresh temporary file is born with the
    /// process's umask, so the original's mode is carried across explicitly.
    func testTheAtomicWriteKeepsTheOriginalsPermissions() throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("script.sh").path
        try Data("#!/bin/sh\n".utf8).write(to: URL(fileURLWithPath: path))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)

        try EditorSaveCoordinator.writeAtomically("#!/bin/sh\necho hi\n", to: path)

        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: path)[.posixPermissions]
                                 as? NSNumber)
        XCTAssertEqual(mode.uint16Value & 0o777, 0o755)
    }

    /// A write that cannot happen throws and **still leaves nothing behind** — including in the
    /// directory it could not write into, which is where a naive tmp file would have landed.
    func testTheAtomicWriteThrowsAndLeavesNothingWhenTheDirectoryIsNotThere() throws {
        let directory = try scratchDirectory()
        let missing = directory.appendingPathComponent("no-such-folder/engine.ts").path

        XCTAssertThrowsError(try EditorSaveCoordinator.writeAtomically("x", to: missing))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }

    // MARK: - The watcher-suppression seam (T9 consumes this)

    /// **One event per note**, which is why the bag counts rather than being a set: two saves in
    /// quick succession are two renames and two events.
    func testTheExpectedWriteBagCountsNotesAndConsumesOnePerCall() {
        let harness = makeRuntime()

        XCTAssertFalse(harness.runtime.consumeExpectedWrite(path: Self.file),
                       "an event nobody announced is somebody ELSE's edit")
        harness.runtime.noteExpectedWrite(path: Self.file)
        harness.runtime.noteExpectedWrite(path: Self.file)
        XCTAssertEqual(harness.runtime.expectedWriteCount(for: Self.file), 2)

        XCTAssertTrue(harness.runtime.consumeExpectedWrite(path: Self.file))
        XCTAssertTrue(harness.runtime.consumeExpectedWrite(path: Self.file))
        XCTAssertFalse(harness.runtime.consumeExpectedWrite(path: Self.file),
                       "…and the third event is not ours, whatever the first two were")
        XCTAssertEqual(harness.runtime.expectedWriteCount(for: Self.file), 0)
    }

    /// Notes are per path, and teardown drops the whole bag: a note that outlived its page could
    /// only ever suppress somebody else's change.
    func testTheExpectedWriteBagIsPerPathAndClearedByTeardown() {
        let harness = makeRuntime()
        harness.runtime.noteExpectedWrite(path: Self.file)

        XCTAssertEqual(harness.runtime.expectedWriteCount(for: "/repo/src/panel.ts"), 0)
        XCTAssertFalse(harness.runtime.consumeExpectedWrite(path: "/repo/src/panel.ts"))

        harness.runtime.teardown()
        XCTAssertEqual(harness.runtime.expectedWriteCount(for: Self.file), 0)
    }

    /// The real runtime's own save really does file a note before it writes, and withdraw it when
    /// the write fails — the seam and the flow, wired to each other rather than only to doubles.
    func testTheRuntimesOwnSaveFilesAndWithdrawsNotesThroughTheRealSeam() async throws {
        let harness = makeRuntime()
        boot(harness)
        // A path that cannot be written: the parent directory does not exist. The runtime's reader
        // is a double, so the file need not exist to be opened — only the WRITE is real here.
        let path = try scratchDirectory().appendingPathComponent("no-such-folder/engine.ts").path
        await harness.runtime.openFile(path)
        drain(harness.cef)

        let save = Task { await harness.runtime.save(path) }
        await waitUntil("the pull") { self.cdpTypes(harness.cef).contains("pullContent") }
        drain(harness.cef)
        harness.slot.deliver(browserId: 41, queryId: 9,
                             request: #"{"type":"contentResponse","path":"\#(path)","seq":1,"text":"x"}"#)

        let outcome = await save.value
        guard case .failed = outcome else {
            return XCTFail("a write into a missing directory must fail, not answer \(outcome)")
        }
        XCTAssertEqual(harness.runtime.expectedWriteCount(for: path), 0,
                       "the note the save filed was taken back when the write threw")
        XCTAssertTrue(cdpTypes(harness.cef).isEmpty, "and nothing was acknowledged")
    }

    // MARK: - The three triggers

    /// **Trigger 3: the page's own ⌘S**, arriving as a bridge message and landing in the coordinator
    /// — the wire T3 left deliberately unrouted, now routed.
    func testThePagesOwnSaveRequestReachesTheCoordinator() async {
        let editor = EditorDouble()
        doubles.append(editor)
        let harness = makeRuntime(saveEditor: editor.seam)
        boot(harness)

        harness.slot.deliver(browserId: 41, queryId: 2,
                             request: #"{"type":"saveRequested","path":"\#(Self.file)"}"#)

        await waitUntil("the page's ⌘S to become a pull") { editor.pulls.count == 1 }
        XCTAssertEqual(editor.pulls.first?.path, Self.file)
    }

    /// **Trigger 2: the code tab's save button** — the slot T5 left as a placeholder, filled at model
    /// CREATION so the chrome's `isPlaceholder` read is right on the very first render.
    func testTheTabsSaveButtonIsWiredAtCreationAndSavesThroughTheRuntime() async {
        let editor = EditorDouble()
        doubles.append(editor)
        let harness = makeRuntime(saveEditor: editor.seam)
        boot(harness)
        let host = await makeHost(dirs: [SessionDirEntry(path: "/repo", locked: false)])
        host.makeEditorRuntime = { _ in harness.runtime }

        let tab = PanelTab(tabId: "t1", kind: .code, url: Self.file, title: "engine.ts")
        let model = PanelEditorTabModels.model(for: tab, host: host, sessionId: "S1")
        XCTAssertNotNil(model.onSaveRequested,
                        "the chrome reads this as a plain var to decide isPlaceholder — a slot "
                        + "filled later would leave the button drawn quiet on the first render")
        model.activate()
        await waitUntil("the file to reach the page") { self.cdpTypes(harness.cef).contains("openModel") }
        drain(harness.cef)

        model.onSaveRequested?()

        await waitUntil("the button to become a pull") { editor.pulls.count == 1 }
        XCTAssertEqual(editor.pulls.first?.path, Self.file)
    }

    /// **A retired tab model's button fires nothing.** The closure captures the tab id and resolves
    /// through the registry, so a view still holding a departed session's model cannot save through
    /// it — T5's own review note, honoured structurally rather than by a guard nobody would run.
    func testASaveThroughARetiredTabModelDoesNothing() async {
        let editor = EditorDouble()
        doubles.append(editor)
        let harness = makeRuntime(saveEditor: editor.seam)
        boot(harness)
        let host = await makeHost(dirs: [SessionDirEntry(path: "/repo", locked: false)])
        host.makeEditorRuntime = { _ in harness.runtime }

        let tab = PanelTab(tabId: "t1", kind: .code, url: Self.file, title: "engine.ts")
        let model = PanelEditorTabModels.model(for: tab, host: host, sessionId: "S1")
        model.activate()
        await waitUntil("the file to reach the page") { self.cdpTypes(harness.cef).contains("openModel") }
        drain(harness.cef)
        let button = model.onSaveRequested

        // The tab goes away — the registry lets go, and the model retires.
        PanelEditorTabModels.discard(tabId: "t1")
        button?()

        // A real save would have pulled by now; give the hop a chance to prove it did not.
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(editor.pulls.isEmpty, "a held closure from a retired model must reach nothing")
    }

    /// **Trigger 1: the app's ⌘S** — what it saves, and when it is allowed to.
    func testTheMenuItemSavesTheActiveCodeTabAndIsDisabledWhenThereIsNone() throws {
        var active: String?
        var saved: [String] = []
        let command = EditorSaveMenuCommand(activePath: { active }, performSave: { saved.append($0) })
        let item = command.makeMenuItem()

        XCTAssertEqual(item.keyEquivalent, "s")
        XCTAssertEqual(item.keyEquivalentModifierMask, [.command])
        XCTAssertTrue(item.target === command)
        XCTAssertFalse(command.validateMenuItem(item), "no code tab in front — nothing to save")

        let action = try XCTUnwrap(item.action)
        _ = item.target?.perform(action, with: item)
        XCTAssertEqual(saved, [], "…and firing it anyway does nothing")

        active = Self.file
        XCTAssertTrue(command.validateMenuItem(item))
        _ = item.target?.perform(action, with: item)
        XCTAssertEqual(saved, [Self.file])
    }

    /// Installed once, installed twice — one ⌘S either way. Two items sharing one key equivalent is
    /// a menu where the wrong one wins.
    func testInstallingTheMenuItemIsIdempotentAndCreatesTheFileMenuIfThereIsNone() throws {
        let command = EditorSaveMenuCommand(activePath: { nil }, performSave: { _ in })
        let mainMenu = NSMenu(title: "MainMenu")
        mainMenu.addItem(withTitle: "Norma", action: nil, keyEquivalent: "").submenu = NSMenu(title: "Norma")

        command.install(in: mainMenu)
        command.install(in: mainMenu)

        let file = try XCTUnwrap(mainMenu.items.first(where: { $0.title == "File" })?.submenu)
        XCTAssertEqual(file.items.filter { $0.keyEquivalent == "s" }.count, 1)
        XCTAssertEqual(mainMenu.items.filter { $0.title == "File" }.count, 1)
        XCTAssertEqual(mainMenu.items.first?.title, "Norma", "the app menu stays first")

        // An existing File menu is used rather than a second one being made.
        let withFile = NSMenu(title: "MainMenu")
        let fileItem = withFile.addItem(withTitle: "File", action: nil, keyEquivalent: "")
        fileItem.submenu = NSMenu(title: "File")
        fileItem.submenu?.addItem(withTitle: "Close", action: nil, keyEquivalent: "w")
        command.install(in: withFile)
        XCTAssertEqual(withFile.items.count, 1)
        XCTAssertEqual(fileItem.submenu?.items.map(\.title), ["Close", "Save"])

        command.install(in: nil)   // an app with no main menu: nothing to do, and no crash
    }

    /// PURE: ⌘S saves the tab the user is LOOKING at, and only if it is a file.
    func testTheMenuTargetIsTheActiveCodeTabAndNothingElse() {
        let code = PanelTab(tabId: "t1", kind: .code, url: Self.file, title: "engine.ts")
        let web = PanelTab(tabId: "t2", kind: .web, url: "https://example.com", title: "Example")
        let pathless = PanelTab(tabId: "t3", kind: .code, url: nil, title: nil)

        XCTAssertEqual(editorSaveMenuTarget(tabs: [code, web], activeTabId: "t1")?.tabId, "t1")
        XCTAssertNil(editorSaveMenuTarget(tabs: [code, web], activeTabId: "t2"),
                     "a web tab in front is not a file to save — never reach past it to a code tab")
        XCTAssertNil(editorSaveMenuTarget(tabs: [code, pathless], activeTabId: "t3"))
        XCTAssertNil(editorSaveMenuTarget(tabs: [code], activeTabId: nil))
        XCTAssertNil(editorSaveMenuTarget(tabs: [], activeTabId: "t1"))
    }

    /// The host half of the menu door: it reads the panel it is showing NOW, and it never mints an
    /// editor to save into.
    func testTheHostResolvesTheActiveCodeTabAndSavesThroughTheExistingRuntimeOnly() async {
        let editor = EditorDouble()
        doubles.append(editor)
        let harness = makeRuntime(saveEditor: editor.seam)
        boot(harness)
        let host = await makeHost(dirs: [SessionDirEntry(path: "/repo", locked: false)])
        host.makeEditorRuntime = { _ in harness.runtime }
        host.panelStore.switchSession(to: "S1")
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t1", kind: .code, url: Self.file, title: "engine.ts")],
            activeTabId: "t1")

        XCTAssertEqual(host.activeCodeTabPath, Self.file)
        let withoutRuntime = await host.saveActiveCodeTab()
        XCTAssertEqual(withoutRuntime, .noModel,
                       "no runtime exists for this session yet, and a SAVE must not mint one")
        XCTAssertEqual(host.editorRuntimes.count, 0)
        XCTAssertTrue(editor.pulls.isEmpty)

        // With an editor actually standing, the same door saves through it.
        host.editorRuntime(for: "S1")
        let save = Task { await host.saveActiveCodeTab() }
        await waitUntil("the menu save to become a pull") { editor.pulls.count == 1 }
        XCTAssertEqual(editor.pulls.first?.path, Self.file)
        harness.runtime.saveCoordinator.deliverContentResponse(path: Self.file, seq: 1, text: "x")
        let outcome = await save.value
        XCTAssertEqual(outcome, .saved)
    }

    // MARK: - Line endings

    /// **The page's EOL step, mirrored** — strict majority of CR-BEARING terminators, ties to LF.
    func testTheCRLFDominanceRuleIsAStrictMajorityWithTiesGoingToLF() {
        XCTAssertTrue(MonacoTextBuffer.opensWithCRLF("a\r\nb\r\nc"), "uniform CRLF")
        XCTAssertFalse(MonacoTextBuffer.opensWithCRLF("a\nb\nc"), "uniform LF")
        XCTAssertFalse(MonacoTextBuffer.opensWithCRLF("a\r\nb\nc"),
                       "an exact tie is an LF text — the vendored rule is `p > b/2`, never `>=`")
        XCTAssertTrue(MonacoTextBuffer.opensWithCRLF("a\r\nb\r\nc\nd"), "CRLF in the majority")
        XCTAssertFalse(MonacoTextBuffer.opensWithCRLF("a\nb\nc\r\nd"), "LF in the majority")
        XCTAssertTrue(MonacoTextBuffer.opensWithCRLF("a\rb\rc"),
                      "lone CRs are CR-BEARING terminators too — Monaco makes them CRLF")
        XCTAssertFalse(MonacoTextBuffer.opensWithCRLF("no newlines"), "no terminator, no dominance")
        XCTAssertFalse(MonacoTextBuffer.opensWithCRLF(""))
    }

    /// **The ruling, stated as a round trip: a file's dominant ending survives a save.**
    ///
    /// A uniformly-CRLF Windows file comes back byte for byte — it is NOT turned into an LF file by
    /// being opened — and a mixed file is unified to whichever ending it mostly already had.
    func testASavedFileKeepsItsDominantLineEndingAndMixedFilesUnifyToIt() {
        let crlf = "a\r\nb\r\nc\r\n"
        XCTAssertEqual(Array(MonacoTextBuffer.savedText(forFileOpenedWith: crlf).utf8),
                       Array(crlf.utf8), "compared as BYTES — the whole claim is byte identity")

        let lf = "a\nb\nc\n"
        XCTAssertEqual(MonacoTextBuffer.savedText(forFileOpenedWith: lf), lf)

        // Mixed, CRLF dominant → all CRLF. Mixed, LF dominant → all LF (fixture A's own shape).
        XCTAssertEqual(MonacoTextBuffer.savedText(forFileOpenedWith: "a\r\nb\r\nc\nd"), "a\r\nb\r\nc\r\nd")
        XCTAssertEqual(MonacoTextBuffer.savedText(forFileOpenedWith: "a\nb\nc\r\nd"), "a\nb\nc\nd")

        // The expectation helper and the rule agree with each other by construction: whatever
        // `opensWithCRLF` answers is the ending every terminator comes back as.
        for sample in ["a\r\nb\r\nc", "a\nb\r\nc\r\n", "x\ry\nz", "plain", "a\r\nb\nc"] {
            let saved = MonacoTextBuffer.savedText(forFileOpenedWith: sample)
            guard saved.contains(where: { $0 == "\r" || $0 == "\n" }) else { continue }
            XCTAssertEqual(saved.contains("\r\n"), MonacoTextBuffer.opensWithCRLF(sample), sample.debugDescription)
            XCTAssertFalse(saved.contains(where: { $0 == "\r" }) && !saved.contains("\r\n"),
                           "no lone CR survives: \(sample.debugDescription)")
        }
    }

    /// **The page really carries the EOL step, in the one place it is safe.**
    ///
    /// A source pin rather than an execution, for the reason every other `editor.js` pin in this repo
    /// is one: no test in this bundle can run the page. The ORDER assertion is the point — a `setEOL`
    /// that fired after the saved-version snapshot would make a freshly-opened CRLF file report
    /// itself dirty with nothing the user could do about it.
    func testTheEditorPageAppliesTheEOLRuleBeforeItSnapshotsTheSavedVersion() throws {
        let source = try XCTUnwrap(Self.pageFile(named: "editor.js"),
                                   "editor.js is in neither the built bundle nor the source tree")
        let code = try String(contentsOf: source, encoding: .utf8)

        let setEOL = try XCTUnwrap(code.range(of: "model.setEOL(dominantEOLIsCRLF(text)"),
                                   "editor.js no longer applies the EOL rule at open")
        let savedVersion = try XCTUnwrap(code.range(of: "savedVersionId: model.getAlternativeVersionId()"),
                                         "editor.js no longer snapshots the saved version at open")
        XCTAssertTrue(setEOL.lowerBound < savedVersion.lowerBound,
                      "setEOL bumps the model's version id when it changes anything — snapshotting "
                      + "the saved point first would open the file DIRTY")
        // Fix round 1: BOTH branches, so the one line insures the whole normalisation rule rather
        // than half of it — an LF-dominant MIXED file is as much a claim as a CRLF one.
        XCTAssertTrue(code.contains("monaco.editor.EndOfLineSequence.CRLF"))
        XCTAssertTrue(code.contains("monaco.editor.EndOfLineSequence.LF"),
                      "the LF branch must be asserted too — otherwise savedText's expectation for a "
                      + "mixed LF-dominant file rests on a normalisation this guard exists to stop "
                      + "depending on")

        XCTAssertTrue(code.contains("carriageBearing * 2 > total"),
                      "the page's dominance rule must stay a STRICT majority (ties to LF), the same "
                      + "comparison the vendored `_getEOL` makes")
        XCTAssertFalse(code.contains("carriageBearing * 2 >= total"))
    }

    // MARK: - The BOM the decoder eats (fix round 1)

    /// **The fact the whole ruling rests on, measured here rather than remembered:**
    /// `String(data:encoding: .utf8)` STRIPS a leading `EF BB BF`, so the text handed to the page can
    /// never carry it back — and `readTextFile` is therefore the only place it can be noticed at all.
    func testTheReaderRemembersALeadingBOMAndKeepsItOutOfTheText() throws {
        let directory = try scratchDirectory()
        let withBOM = directory.appendingPathComponent("bom.ts").path
        let withoutBOM = directory.appendingPathComponent("plain.ts").path
        var bytes = Data([0xEF, 0xBB, 0xBF])
        bytes.append(contentsOf: "let a = 1\n".utf8)
        try bytes.write(to: URL(fileURLWithPath: withBOM))
        try Data("let a = 1\n".utf8).write(to: URL(fileURLWithPath: withoutBOM))

        let bommed = try EditorRuntime.readTextFile(withBOM)
        XCTAssertTrue(bommed.hadBOM)
        XCTAssertEqual(bommed.text, "let a = 1\n")
        XCTAssertNotEqual(bommed.text.unicodeScalars.first, "\u{FEFF}",
                          "the decoder ate it — which is exactly why `hadBOM` has to exist")

        let plain = try EditorRuntime.readTextFile(withoutBOM)
        XCTAssertFalse(plain.hadBOM)
        XCTAssertEqual(plain.text, "let a = 1\n")
    }

    /// The write puts the three bytes back, never invents them, and never doubles one.
    func testTheAtomicWriteRestoresABOMWithoutInventingOrDoublingOne() throws {
        let directory = try scratchDirectory()
        let restored = directory.appendingPathComponent("restored.ts").path
        let plain = directory.appendingPathComponent("plain.ts").path
        let already = directory.appendingPathComponent("already.ts").path

        try EditorSaveCoordinator.writeAtomically("let a = 1\n", to: restored, withBOM: true)
        try EditorSaveCoordinator.writeAtomically("let a = 1\n", to: plain)
        try EditorSaveCoordinator.writeAtomically("\u{FEFF}let a = 1\n", to: already, withBOM: true)

        var expected = Data([0xEF, 0xBB, 0xBF])
        expected.append(contentsOf: "let a = 1\n".utf8)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: restored)), expected)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: plain)), Data("let a = 1\n".utf8),
                       "a file with no BOM must never gain one")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: already)), expected,
                       "a buffer that already begins with U+FEFF keeps exactly the one it has")
    }

    /// **The bug, end to end: ⌘S on an UNTOUCHED Visual-Studio-authored file.** `performSave` has no
    /// dirty gate, so this is one keystroke away at all times — and before the fix it rewrote the
    /// file three bytes shorter, silently. Real reader, real write, real bytes compared.
    func testSavingAnUntouchedBOMdFileLeavesItsBytesIdentical() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("windows.ts").path
        var original = Data([0xEF, 0xBB, 0xBF])
        original.append(contentsOf: "let a = 1\r\nlet b = 2\r\n".utf8)
        try original.write(to: URL(fileURLWithPath: path))

        let harness = makeRuntime(realReader: true)
        boot(harness)
        // What the page would answer for an untouched buffer: the text the reader produced, put
        // through the save-round-trip rule (uniform CRLF — unchanged, and the BOM is not in it).
        let outcome = await saveThroughTheRealPath(
            harness, path: path,
            answering: MonacoTextBuffer.savedText(forFileOpenedWith: "let a = 1\r\nlet b = 2\r\n"))

        XCTAssertEqual(outcome, .saved)
        XCTAssertTrue(harness.runtime.fileHadBOM(path), "the reader's answer is remembered per path")
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), original,
                       "a save of a file nobody edited must not change one byte of it")
    }

    /// The edited case: the BOM survives, and so does the edit.
    func testSavingAnEditedBOMdFileKeepsTheBOMAndTakesTheNewContent() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("windows.ts").path
        var original = Data([0xEF, 0xBB, 0xBF])
        original.append(contentsOf: "let a = 1\n".utf8)
        try original.write(to: URL(fileURLWithPath: path))

        let harness = makeRuntime(realReader: true)
        boot(harness)
        let outcome = await saveThroughTheRealPath(harness, path: path, answering: "let a = 2\n")

        XCTAssertEqual(outcome, .saved)
        var expected = Data([0xEF, 0xBB, 0xBF])
        expected.append(contentsOf: "let a = 2\n".utf8)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), expected)
    }

    /// …and a file that never had one does not acquire one from the save path.
    func testSavingAFileWithNoBOMNeverInventsOne() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("plain.ts").path
        try Data("let a = 1\n".utf8).write(to: URL(fileURLWithPath: path))

        let harness = makeRuntime(realReader: true)
        boot(harness)
        let outcome = await saveThroughTheRealPath(harness, path: path, answering: "let a = 2\n")

        XCTAssertEqual(outcome, .saved)
        XCTAssertFalse(harness.runtime.fileHadBOM(path))
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), Data("let a = 2\n".utf8))
    }

    /// The memory is per path and does not outlive the model: a closed file's answer goes with it,
    /// so a later save can never put three bytes in front of a file that no longer has any.
    func testTheBOMMemoryIsForgottenWhenTheModelClosesAndAtTeardown() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("bom.ts").path
        var bytes = Data([0xEF, 0xBB, 0xBF])
        bytes.append(contentsOf: "let a = 1\n".utf8)
        try bytes.write(to: URL(fileURLWithPath: path))

        let harness = makeRuntime(realReader: true)
        boot(harness)
        await harness.runtime.openFile(path)
        drain(harness.cef)
        XCTAssertTrue(harness.runtime.fileHadBOM(path))

        harness.runtime.close(path)
        XCTAssertFalse(harness.runtime.fileHadBOM(path))

        await harness.runtime.openFile(path)
        drain(harness.cef)
        XCTAssertTrue(harness.runtime.fileHadBOM(path), "a re-open re-answers the question")
        harness.runtime.teardown()
        XCTAssertFalse(harness.runtime.fileHadBOM(path))
    }

    // MARK: - Helpers borrowed from the runtime suite

    private struct RuntimeHarness {
        let runtime: EditorRuntime
        let cef: EditorCEFRecorder
        let slot: EditorSlotRecorder
        let hub: EditorBridgeHub
        let scheduler: EditorFakeScheduler
    }

    /// `realReader: true` leaves `readFile` at its PRODUCTION default — the only way the BOM drills
    /// can be honest, since the fact under test is one only the real byte-level read can produce
    /// (`EditorTabTests` takes the same "use the real reader" posture for the missing-file path).
    private func makeRuntime(saveEditor: EditorSaveCoordinator.Editor? = nil,
                             realReader: Bool = false) -> RuntimeHarness {
        let cef = EditorCEFRecorder()
        cef.browserIds = [41]
        let slot = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: slot.slot)
        let scheduler = EditorFakeScheduler()
        doubles.append(contentsOf: [cef, slot, hub, scheduler] as [AnyObject])
        let runtime: EditorRuntime
        if realReader {
            runtime = EditorRuntime(sessionId: "S1", hub: hub, driver: cef.driver,
                                    scheduler: scheduler.scheduler,
                                    colorScheme: { .dark },
                                    saveEditor: saveEditor)
        } else {
            runtime = EditorRuntime(sessionId: "S1", hub: hub, driver: cef.driver,
                                    scheduler: scheduler.scheduler,
                                    colorScheme: { .dark },
                                    readFile: { _ in EditorFileContents(text: "let a = 1\n") },
                                    saveEditor: saveEditor)
        }
        runtimes.append(runtime)
        return RuntimeHarness(runtime: runtime, cef: cef, slot: slot, hub: hub, scheduler: scheduler)
    }

    /// Open `path` through the REAL read path and answer the pull the save then sends with `text`,
    /// standing in for the page. Returns the save's outcome.
    private func saveThroughTheRealPath(_ harness: RuntimeHarness, path: String,
                                        answering text: String) async -> SaveOutcome {
        await harness.runtime.openFile(path)
        drain(harness.cef)
        let save = Task { await harness.runtime.save(path) }
        await waitUntil("the pull") { self.cdpTypes(harness.cef).contains("pullContent") }
        // The seq is the coordinator's own, read back rather than assumed.
        let seq = harness.runtime.saveCoordinator.pendingPullSeqs.first ?? 0
        drain(harness.cef)
        harness.runtime.saveCoordinator.deliverContentResponse(path: path, seq: seq, text: text)
        return await save.value
    }

    private func boot(_ harness: RuntimeHarness) {
        harness.runtime.prewarm()
        harness.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        XCTAssertEqual(cdpTypes(harness.cef), ["setTheme"], "page-ready sends the brand first (T4)")
        harness.cef.answerNextCDP()
    }

    /// The outstanding bridge messages by wire type, read out of the CDP payloads by CONTENT — never
    /// by position (Task 4's `setTheme` shifted every index once already).
    private func cdpTypes(_ cef: EditorCEFRecorder) -> [String] {
        let known = ["setTheme", "openModel", "activateModel", "closeModel", "pullContent",
                     "applyExternalContent", "markSaved"]
        return cef.cdp.compactMap { entry in
            guard let params = entry.params else { return nil }
            return known.first { params.contains(#"\"type\":\""# + $0 + #"\""#) }
        }
    }

    @discardableResult
    private func drain(_ cef: EditorCEFRecorder) -> [String] {
        let types = cdpTypes(cef)
        while cef.answerNextCDP() {}
        return types
    }

    private func makeHost(dirs: [SessionDirEntry]?) async -> ShellSessionHost {
        let row = SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global",
                                 cwd: dirs?.first?.path, mode: "code", dirs: dirs)
        let rows = [row]
        let directory = SessionDirectory(lister: { rows })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        await directory.refresh()
        return host
    }

    /// One of the page's own files, wherever it can be found — the bundle first, then the source
    /// tree, exactly as `EditorPlumbingTests`' own pins look for it.
    private static func pageFile(named name: String) -> URL? {
        let bundled = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/EditorAssets/app/\(name)")
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // NormaAppTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // Norma
            .appendingPathComponent("Resources/EditorAssets/app/\(name)")
        return [bundled, source].first { FileManager.default.fileExists(atPath: $0.path) }
    }

    // MARK: - Office Stage B Task 6: the deferred zoom menu pass

    /// Installed once, installed twice — one Zoom In/Zoom Out/Actual Size trio either way. Mirrors
    /// `testInstallingTheMenuItemIsIdempotentAndCreatesTheFileMenuIfThereIsNone` above exactly, one
    /// menu title over (`View`, not `File`) and matched by action selector rather than `target ===
    /// self` — `OfficeCanvasMenuInstaller.install`'s own header states why (`target: nil`
    /// throughout, no shared command object to compare against).
    func testInstallingTheZoomMenuItemsIsIdempotentAndCreatesTheViewMenuIfThereIsNone() throws {
        let mainMenu = NSMenu(title: "MainMenu")
        mainMenu.addItem(withTitle: "Norma", action: nil, keyEquivalent: "").submenu = NSMenu(title: "Norma")

        OfficeCanvasMenuInstaller.install(in: mainMenu)
        OfficeCanvasMenuInstaller.install(in: mainMenu)

        let view = try XCTUnwrap(mainMenu.items.first(where: { $0.title == "View" })?.submenu)
        XCTAssertEqual(view.items.map(\.title), ["Zoom In", "Zoom Out", "Actual Size"],
                       "exactly one of each, no duplicates from the second install")
        XCTAssertEqual(mainMenu.items.filter { $0.title == "View" }.count, 1)
        XCTAssertEqual(mainMenu.items.first?.title, "Norma", "the app menu stays first")

        let zoomIn = try XCTUnwrap(view.items.first(where: { $0.title == "Zoom In" }))
        XCTAssertEqual(zoomIn.keyEquivalent, "+")
        XCTAssertEqual(zoomIn.keyEquivalentModifierMask, [.command])
        XCTAssertNil(zoomIn.target, "target: nil — routes through the responder chain, never a command object")
        let zoomOut = try XCTUnwrap(view.items.first(where: { $0.title == "Zoom Out" }))
        XCTAssertEqual(zoomOut.keyEquivalent, "-")
        let actualSize = try XCTUnwrap(view.items.first(where: { $0.title == "Actual Size" }))
        XCTAssertEqual(actualSize.keyEquivalent, "0")

        // An existing View menu is used rather than a second one being made, and whatever else
        // lives in it survives untouched.
        let withView = NSMenu(title: "MainMenu")
        let viewItem = withView.addItem(withTitle: "View", action: nil, keyEquivalent: "")
        viewItem.submenu = NSMenu(title: "View")
        viewItem.submenu?.addItem(withTitle: "Show Sidebar", action: nil, keyEquivalent: "")
        OfficeCanvasMenuInstaller.install(in: withView)
        XCTAssertEqual(withView.items.count, 1)
        XCTAssertEqual(viewItem.submenu?.items.map(\.title), ["Show Sidebar", "Zoom In", "Zoom Out", "Actual Size"])

        OfficeCanvasMenuInstaller.install(in: nil)   // an app with no main menu: nothing to do, and no crash
    }

    // MARK: - Review fix round 1 (I-1): the Edit-menu belt

    /// A bare main menu (no Edit submenu at all) gets a real one, with all five standard verbs.
    func testEditActionsBeltCreatesTheEditMenuAndAddsAllFiveWhenNoneExist() throws {
        let mainMenu = NSMenu(title: "MainMenu")
        mainMenu.addItem(withTitle: "Norma", action: nil, keyEquivalent: "").submenu = NSMenu(title: "Norma")

        OfficeCanvasMenuInstaller.installEditActionsIfAbsent(in: mainMenu)

        let edit = try XCTUnwrap(mainMenu.items.first(where: { $0.title == "Edit" })?.submenu)
        XCTAssertEqual(edit.items.map(\.title), ["Undo", "Redo", "Cut", "Copy", "Paste"])

        let undo = try XCTUnwrap(edit.items.first(where: { $0.title == "Undo" }))
        XCTAssertEqual(undo.action, #selector(OfficeTileCanvasView.undo(_:)))
        XCTAssertEqual(undo.keyEquivalent, "z")
        XCTAssertEqual(undo.keyEquivalentModifierMask, [.command])
        XCTAssertNil(undo.target, "target: nil — routes through the responder chain")

        let redo = try XCTUnwrap(edit.items.first(where: { $0.title == "Redo" }))
        XCTAssertEqual(redo.action, #selector(OfficeTileCanvasView.redo(_:)))
        XCTAssertEqual(redo.keyEquivalent, "z")
        XCTAssertEqual(redo.keyEquivalentModifierMask, [.command, .shift], "⇧⌘Z, distinct from Undo's ⌘Z")

        let copy = try XCTUnwrap(edit.items.first(where: { $0.title == "Copy" }))
        XCTAssertEqual(copy.action, #selector(OfficeTileCanvasView.copy(_:)))
        XCTAssertEqual(copy.keyEquivalent, "c")
    }

    /// **The load-bearing property**: a pre-existing item carrying the REAL `copy:` action — this
    /// test's own stand-in for "SwiftUI already provided it" — must survive completely untouched
    /// (same title, same object identity), while the four ABSENT verbs are filled in around it.
    /// This is what distinguishes "install-if-absent" from `OfficeCanvasMenuInstaller.install`'s
    /// own remove-then-add pattern for zoom items — see `installEditActionsIfAbsent`'s own header.
    func testEditActionsBeltNeverReplacesAPreExistingItemForTheSameAction() throws {
        let mainMenu = NSMenu(title: "MainMenu")
        let editItem = mainMenu.addItem(withTitle: "Edit", action: nil, keyEquivalent: "")
        let editSubmenu = NSMenu(title: "Edit")
        editItem.submenu = editSubmenu
        let swiftUICopy = NSMenuItem(title: "Copy", action: #selector(OfficeTileCanvasView.copy(_:)), keyEquivalent: "c")
        swiftUICopy.keyEquivalentModifierMask = [.command]
        editSubmenu.addItem(swiftUICopy)

        OfficeCanvasMenuInstaller.installEditActionsIfAbsent(in: mainMenu)

        XCTAssertTrue(editSubmenu.items.contains(where: { $0 === swiftUICopy }),
                      "the pre-existing Copy item must survive as the SAME object, never removed/replaced")
        XCTAssertEqual(editSubmenu.items.filter { $0.action == #selector(OfficeTileCanvasView.copy(_:)) }.count, 1,
                       "exactly one Copy — the belt must not add a second, competing item for an action already present")
        XCTAssertEqual(Set(editSubmenu.items.compactMap(\.title)),
                       ["Copy", "Undo", "Redo", "Cut", "Paste"], "the four ABSENT verbs get filled in around it")
    }

    /// Installed once, installed twice — no duplicates, mirroring the zoom installer's own
    /// idempotence test above (this one is naturally idempotent by construction — see the method's
    /// own header — rather than by an explicit remove-then-add step).
    func testEditActionsBeltIsANoOpOnceAllFiveAreAlreadyPresent() throws {
        let mainMenu = NSMenu(title: "MainMenu")
        OfficeCanvasMenuInstaller.installEditActionsIfAbsent(in: mainMenu)
        OfficeCanvasMenuInstaller.installEditActionsIfAbsent(in: mainMenu)

        let edit = try XCTUnwrap(mainMenu.items.first(where: { $0.title == "Edit" })?.submenu)
        XCTAssertEqual(edit.items.map(\.title), ["Undo", "Redo", "Cut", "Copy", "Paste"], "no duplicates from the second call")
        XCTAssertEqual(mainMenu.items.filter { $0.title == "Edit" }.count, 1, "no second Edit menu either")

        OfficeCanvasMenuInstaller.installEditActionsIfAbsent(in: nil)   // no main menu: nothing to do, no crash
    }
}
