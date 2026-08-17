import AppKit
import XCTest
@testable import Norma

// MARK: - The banner, as a pure function

/// editor-product Task 9 — **the conflict state machine, driven with no runtime, no watcher and no
/// view.** Every precedence claim the task makes is a row here.
@MainActor
final class EditorConflictReducerTests: XCTestCase {

    private let states: [EditorTabBanner] = [
        .none, .conflict(.changed), .conflict(.deleted), .transientError("Couldn't save")
    ]

    /// **The whole matrix, written out.** Four states × eight events, as literal expectations rather
    /// than as rules re-derived in the test — a table is the only form in which "exhaustive" is
    /// visible, and the only one where a future change to the reducer has to be RE-DECIDED here
    /// rather than silently agreed with.
    func testEveryStateAnswersEveryEvent() {
        let error = EditorTabBanner.transientError("Couldn't save")
        let rows: [(EditorTabBanner, EditorBannerEvent, EditorTabBanner)] = [
            // .none
            (.none, .externalChange(dirty: false), .none),
            (.none, .externalChange(dirty: true), .conflict(.changed)),
            (.none, .externalDeleted, .conflict(.deleted)),
            (.none, .reloadChosen, .none),
            (.none, .keepChosen, .none),
            (.none, .saveFailed("Couldn't save"), error),
            (.none, .saveSucceeded, .none),
            (.none, .transientErrorExpired, .none),
            (.none, .dismissed, .none),

            // .conflict(.changed) — the actionable state; only a resolution or a deletion moves it
            (.conflict(.changed), .externalChange(dirty: false), .none),
            (.conflict(.changed), .externalChange(dirty: true), .conflict(.changed)),
            (.conflict(.changed), .externalDeleted, .conflict(.deleted)),
            (.conflict(.changed), .reloadChosen, .none),
            (.conflict(.changed), .keepChosen, .none),
            (.conflict(.changed), .saveFailed("Couldn't save"), .conflict(.changed)),
            (.conflict(.changed), .saveSucceeded, .none),
            (.conflict(.changed), .transientErrorExpired, .conflict(.changed)),
            (.conflict(.changed), .dismissed, .none),

            // .conflict(.deleted)
            (.conflict(.deleted), .externalChange(dirty: false), .none),
            (.conflict(.deleted), .externalChange(dirty: true), .conflict(.changed)),
            (.conflict(.deleted), .externalDeleted, .conflict(.deleted)),
            (.conflict(.deleted), .reloadChosen, .none),
            (.conflict(.deleted), .keepChosen, .none),
            (.conflict(.deleted), .saveFailed("Couldn't save"), .conflict(.deleted)),
            (.conflict(.deleted), .saveSucceeded, .none),
            (.conflict(.deleted), .transientErrorExpired, .conflict(.deleted)),
            (.conflict(.deleted), .dismissed, .none),

            // .transientError — yields to everything, and leaves on its own
            (error, .externalChange(dirty: false), error),
            (error, .externalChange(dirty: true), .conflict(.changed)),
            (error, .externalDeleted, .conflict(.deleted)),
            (error, .reloadChosen, .none),
            (error, .keepChosen, .none),
            (error, .saveFailed("second"), .transientError("second")),
            (error, .saveSucceeded, .none),
            (error, .transientErrorExpired, .none),
            (error, .dismissed, .none)
        ]
        for (state, event, expected) in rows {
            XCTAssertEqual(EditorConflictReducer.reduce(state, event), expected,
                           "\(state) + \(event) must be \(expected)")
        }
        XCTAssertEqual(rows.count, 36, "four states × nine events — the matrix is the point")
    }

    /// **The precedence rule, stated as its own test because it is the decision this task had to
    /// make**: a conflict is actionable and a failed save is a report, so the report yields.
    func testAConflictOutranksASaveFailure() {
        for kind in [EditorConflictKind.changed, .deleted] {
            let after = EditorConflictReducer.reduce(.conflict(kind), .saveFailed("Couldn't save"))
            XCTAssertEqual(after, .conflict(kind),
                           "a save failure must not take down a banner the user still has to answer")
        }
        // …and in the other direction it does move, immediately, rather than queueing behind the
        // 5-second timer.
        XCTAssertEqual(EditorConflictReducer.reduce(.transientError("x"), .externalChange(dirty: true)),
                       .conflict(.changed))
    }

    /// A successful save RESOLVES a conflict: the file now holds this buffer, so "changed on disk"
    /// has stopped being true. (This is the third way to answer the banner, beside its two buttons.)
    func testASuccessfulSaveResolvesAConflict() {
        for state in states {
            XCTAssertEqual(EditorConflictReducer.reduce(state, .saveSucceeded), .none)
        }
    }

    /// The timer can only ever clear what armed it — a conflict raised while it was running must
    /// survive its fire.
    func testTheTransientTimerClearsOnlyATransientError() {
        XCTAssertEqual(EditorConflictReducer.reduce(.transientError("x"), .transientErrorExpired), .none)
        XCTAssertEqual(EditorConflictReducer.reduce(.conflict(.changed), .transientErrorExpired),
                       .conflict(.changed))
    }
}

// MARK: - What a change on disk MEANS

@MainActor
final class EditorDiskChangeTests: XCTestCase {

    /// **Content first, the note bag second** — and the second row is the one that matters: a file
    /// that has not moved consumes NOTHING, whatever the bag holds, so a stray note cannot be spent
    /// on an event that was not a change.
    func testTheVerdictReadsBytesBeforeItReadsIntentions() {
        XCTAssertEqual(editorDiskChange(diskText: "a", baseline: "a", expectedWrites: 0), .unchanged)
        XCTAssertEqual(editorDiskChange(diskText: "a", baseline: "a", expectedWrites: 2), .unchanged)
        XCTAssertEqual(editorDiskChange(diskText: "b", baseline: "a", expectedWrites: 1), .ours)
        XCTAssertEqual(editorDiskChange(diskText: "b", baseline: "a", expectedWrites: 0),
                       .external(text: "b"))
    }

    /// A missing file is a deletion however many writes are outstanding: our own writes never delete.
    func testAMissingFileIsADeletionWhateverTheBagSays() {
        XCTAssertEqual(editorDiskChange(diskText: nil, baseline: "a", expectedWrites: 0), .deleted)
        XCTAssertEqual(editorDiskChange(diskText: nil, baseline: "a", expectedWrites: 3), .deleted)
        XCTAssertEqual(editorDiskChange(diskText: nil, baseline: nil, expectedWrites: 0), .deleted)
    }

    /// **A file that came BACK is a change, not a match** — the baseline is `nil` after a deletion
    /// precisely so that a `git checkout` restoring the exact bytes still clears the banner it
    /// raised.
    func testAFileThatCameBackIsAChangeEvenIfTheBytesAreIdentical() {
        XCTAssertEqual(editorDiskChange(diskText: "a", baseline: nil, expectedWrites: 0),
                       .external(text: "a"))
    }
}

// MARK: - The watcher, wired to the runtime

/// One fake watch. Holds the closure the runtime installed so a test can fire it, and records that
/// it was stopped — the two things a lifecycle claim needs.
@MainActor
final class EditorFakeWatcher: FileTreeWatching {
    let path: String
    let onChange: () -> Void
    private(set) var isStopped = false

    init(path: String, onChange: @escaping () -> Void) {
        self.path = path
        self.onChange = onChange
    }

    func fire() { onChange() }
    func stop() { isStopped = true }
}

@MainActor
final class EditorWatcherRecorder {
    private(set) var created: [String] = []
    private(set) var watchers: [String: EditorFakeWatcher] = [:]
    /// When true the factory answers `nil` — the "nothing could be watched" path.
    var refuse = false

    var factory: EditorFileWatcherFactory {
        { [unowned self] path, onChange in
            self.created.append(path)
            guard !self.refuse else { return nil }
            let watcher = EditorFakeWatcher(path: path, onChange: onChange)
            self.watchers[path] = watcher
            return watcher
        }
    }
}

/// editor-product Task 9 — **the watcher, the suppression and the banner, driven through the real
/// runtime.**
///
/// The watch itself is a double (two kernel event sources are not a unit test's to own), but every
/// decision downstream of it is real: the reads are real (`readFile`'s production default wherever
/// bytes matter), the saves go through the real coordinator and the real atomic write, and the
/// banner is read off the runtime's own published state.
@MainActor
final class EditorWatcherTests: XCTestCase {

    private var doubles: [AnyObject] = []
    private var runtimes: [EditorRuntime] = []
    private var scratchDirectories: [URL] = []

    override func tearDown() {
        for runtime in runtimes { runtime.teardown() }
        runtimes.removeAll()
        doubles.removeAll()
        for directory in scratchDirectories { try? FileManager.default.removeItem(at: directory) }
        scratchDirectories.removeAll()
        super.tearDown()
    }

    // MARK: Lifecycle

    /// **Armed at model-open — before the first save of that file is even possible** (T8's seam
    /// obligation, answered structurally: the coordinator's `hasModel` gate reads the very table
    /// `modelOpened` fills) — and stopped when the model closes.
    func testAModelIsWatchedFromTheMomentItOpensUntilItCloses() async throws {
        let harness = makeRuntime()
        boot(harness)

        XCTAssertEqual(harness.watchers.created, [], "nothing is watched before anything is open")
        await open(harness, path: Self.file)
        XCTAssertEqual(harness.watchers.created, [Self.file])
        let watcher = try XCTUnwrap(harness.watchers.watchers[Self.file])
        XCTAssertFalse(watcher.isStopped)

        harness.runtime.close(Self.file)
        XCTAssertTrue(watcher.isStopped, "the watch goes with the model it describes")
        XCTAssertNil(harness.runtime.knownDiskText(for: Self.file),
                     "and so does what we knew about the file's bytes")
    }

    /// Teardown stops every watch — the dependency `performTeardown` states at its own site: it also
    /// drops the expected-write bag, which is only safe because nothing is left to consume a note.
    func testTeardownStopsEveryWatch() async throws {
        let harness = makeRuntime()
        boot(harness)
        await open(harness, path: Self.file)
        await open(harness, path: Self.otherFile)
        let watchers = harness.watchers.watchers.values
        XCTAssertEqual(watchers.count, 2)

        harness.runtime.teardown()

        XCTAssertTrue(watchers.allSatisfy(\.isStopped))
        XCTAssertEqual(harness.runtime.expectedWriteCount(for: Self.file), 0)
    }

    /// A factory that cannot watch anything is not a failure: the model opens, the tab works, and
    /// the file simply does not track disk.
    func testAWatchThatCouldNotBeStartedLeavesTheModelWorking() async {
        let harness = makeRuntime()
        harness.watchers.refuse = true
        boot(harness)
        await open(harness, path: Self.file)

        XCTAssertNotNil(harness.runtime.stateSnapshot.models[Self.file])
        XCTAssertEqual(harness.runtime.stateSnapshot.banners, [:])
    }

    /// **The wiring itself**: the closure the runtime handed the watcher really reaches the handler.
    /// Every other test drives `fileChangedOnDisk` directly (it is the documented door, and it is
    /// awaitable); this one proves that door is the one the watcher knocks on.
    func testTheWatchersOwnCallbackReachesTheHandler() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("engine.ts").path
        try "one\n".write(toFile: path, atomically: true, encoding: .utf8)
        let harness = makeRuntime(realReader: true)
        boot(harness)
        await open(harness, path: path)
        drain(harness.cef)

        try "two\n".write(toFile: path, atomically: true, encoding: .utf8)
        try XCTUnwrap(harness.watchers.watchers[path]).fire()

        await waitUntil("the reload the fire produced") {
            self.cdpTypes(harness.cef).contains("applyExternalContent")
        }
    }

    // MARK: The conflict matrix

    /// Clean model + a change on disk → **silent reload**, no banner. The bytes that reach the page
    /// are the ones just read, not the ones the model was opened with.
    func testACleanModelIsReloadedSilently() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        try "two\n".write(toFile: path, atomically: true, encoding: .utf8)

        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), ["applyExternalContent"])
        XCTAssertTrue(try XCTUnwrap(cdpPayloads(harness.cef).first).contains("two"))
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none,
                       "a clean model has nothing to ask the user about")
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "two\n")
    }

    /// **Dirty model + a change on disk → the banner, and NOTHING else.** The absence of the reload
    /// is the assertion that matters: an auto-reload here is the data loss this task exists to
    /// prevent.
    func testADirtyModelBannersAndIsNeverReloadedUnderneathTheUser() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        markDirty(harness, path: path)
        try "two\n".write(toFile: path, atomically: true, encoding: .utf8)

        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), [], "the user's edits are not overwritten")
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .conflict(.changed))
    }

    /// Reload re-READS: the bytes applied are the file's as it is NOW, not the ones the banner was
    /// raised with minutes ago.
    func testReloadAppliesAFreshReadAndClearsTheBanner() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        markDirty(harness, path: path)
        try "two\n".write(toFile: path, atomically: true, encoding: .utf8)
        await harness.runtime.fileChangedOnDisk(path)
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .conflict(.changed))
        drain(harness.cef)

        // The file moves AGAIN while the banner is on screen.
        try "three\n".write(toFile: path, atomically: true, encoding: .utf8)
        await harness.runtime.reloadFromDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), ["applyExternalContent"])
        XCTAssertTrue(try XCTUnwrap(cdpPayloads(harness.cef).first).contains("three"),
                      "reload applies what is on disk now — never the text the banner remembered")
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "three\n")
    }

    /// Keep mine dismisses and touches nothing: no reload, and the buffer is left exactly as it is.
    func testKeepMineDismissesAndLeavesTheBufferAlone() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        markDirty(harness, path: path)
        try "two\n".write(toFile: path, atomically: true, encoding: .utf8)
        await harness.runtime.fileChangedOnDisk(path)
        drain(harness.cef)

        harness.runtime.keepMine(path)

        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
        XCTAssertEqual(cdpTypes(harness.cef), [])
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "two\n",
                       "the baseline stays at what the watcher saw, so the next ⌘S is an ordinary "
                       + "overwrite and a FURTHER external change is a fresh conflict")
    }

    /// A deleted file banners rather than hiding the buffer — and the file coming back clears it,
    /// even when it comes back byte-identical (a `git checkout` of a deleted file).
    func testADeletedFileBannersAndComingBackClearsIt() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        try FileManager.default.removeItem(atPath: path)

        await harness.runtime.fileChangedOnDisk(path)
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .conflict(.deleted))
        XCTAssertNil(harness.runtime.knownDiskText(for: path))
        XCTAssertEqual(cdpTypes(harness.cef), [], "nothing is applied for a file that is not there")

        try "one\n".write(toFile: path, atomically: true, encoding: .utf8)
        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
        XCTAssertEqual(cdpTypes(harness.cef), ["applyExternalContent"])
    }

    /// **A read that fails for any reason OTHER than "not there" is not a deletion.** A permissions
    /// flap or a device error must leave the editor holding what it has and say nothing — a banner
    /// claiming the file was deleted because a network volume hiccuped is a lie the user acts on.
    func testATransientReadFailureIsNotADeletion() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("engine.ts").path
        try "one\n".write(toFile: path, atomically: true, encoding: .utf8)
        let reader = FlakyReader(text: "one\n")
        doubles.append(reader)
        let harness = makeRuntime(readFile: reader.read)
        boot(harness)
        await open(harness, path: path)
        drain(harness.cef)

        reader.failure = EditorFileReadError.notUTF8(path: path)
        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
        XCTAssertEqual(cdpTypes(harness.cef), [])
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "one\n",
                       "the baseline survives a read we could not make")
    }

    // MARK: Suppression — our own writes

    /// A real save, through the real coordinator and the real atomic write, is silent when its own
    /// event arrives: no reload, no banner, and the runtime knows exactly what it wrote.
    func testOurOwnSaveIsSilentWhenItsOwnEventArrives() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        let outcome = await save(harness, path: path, answering: "typed\n")
        XCTAssertEqual(outcome, .saved)
        drain(harness.cef)

        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), [], "our own write is not an external change")
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "typed\n")
    }

    /// **THE double-save-fast case — the invisible failure, pinned.**
    ///
    /// Two saves back to back are two renames, and a debounce can coalesce their events into ONE
    /// fire. A design that consumed one note per event would leave a note standing, and that note
    /// would silently swallow the NEXT genuine external change — the failure nobody sees. Here the
    /// bag is empty after both saves (a note's lifetime ends with its write, not with an event), so
    /// the external change that follows is seen.
    func testTwoFastSavesLeaveNoLingeringNoteAndTheNextExternalChangeIsSeen() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")

        let first = await save(harness, path: path, answering: "first\n")
        let second = await save(harness, path: path, answering: "second\n")
        XCTAssertEqual([first, second], [.saved, .saved])
        drain(harness.cef)

        XCTAssertEqual(harness.runtime.expectedWriteCount(for: path), 0,
                       "no note may outlive the write it stood for")
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "second\n")

        // ONE fire for both renames, exactly as a debounce would deliver it.
        await harness.runtime.fileChangedOnDisk(path)
        XCTAssertEqual(cdpTypes(harness.cef), [], "both saves were ours")
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)

        // …and now somebody ELSE writes the file.
        try "theirs\n".write(toFile: path, atomically: true, encoding: .utf8)
        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), ["applyExternalContent"],
                       "the change after our saves is external and MUST be seen — a lingering note "
                       + "would have swallowed it silently")
        XCTAssertTrue(try XCTUnwrap(cdpPayloads(harness.cef).first).contains("theirs"))
    }

    /// The belt the counted bag still is: an event that arrives before the write's own continuation
    /// has run finds bytes the baseline has not caught up with, and the note is what explains them.
    func testANoteExplainsAnEventThatBeatsTheWritesOwnContinuation() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        // Exactly the state the save flow is in between its rename and its continuation: the bytes
        // have moved, the note is filed, the baseline has not been updated yet.
        try "written\n".write(toFile: path, atomically: true, encoding: .utf8)
        harness.runtime.noteExpectedWrite(path: path)

        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), [], "the note explained it")
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
        XCTAssertEqual(harness.runtime.expectedWriteCount(for: path), 0, "and it was consumed")
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "written\n")
    }

    // MARK: The BOM comparator

    /// **A BOM'd file nobody touched must never banner** — T8's second seam obligation, driven end
    /// to end through the REAL reader and REAL bytes.
    ///
    /// The model holds the text WITHOUT the three leading bytes (Foundation's UTF-8 decoder strips
    /// them and says nothing), so a comparator that diffed raw disk bytes against it would find a
    /// difference on this file from the moment it opened — a phantom "changed on disk" over a file
    /// nobody edited, on every watcher fire, forever.
    func testAnUntouchedBOMdFileNeverBanners() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("bom.ts").path
        var bytes = Data(EditorFileContents.utf8BOM)
        bytes.append(contentsOf: "let a = 1\n".utf8)
        try bytes.write(to: URL(fileURLWithPath: path))

        let harness = makeRuntime(realReader: true)
        boot(harness)
        await open(harness, path: path)
        drain(harness.cef)
        XCTAssertTrue(harness.runtime.fileHadBOM(path), "the reader remembered the BOM")
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "let a = 1\n",
                       "and the baseline is the POST-STRIP text, which is what the page holds")

        // Every fire, not just one: a phantom would repeat.
        await harness.runtime.fileChangedOnDisk(path)
        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), [])
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
    }

    /// …and a BOM'd file that genuinely changed is still seen — the comparator strips, it does not
    /// go blind. The BOM answer is re-asked by the same read, so a file that LOST its BOM stops
    /// having one re-emitted by the next save.
    func testAnEditedBOMdFileIsSeenAndItsBOMAnswerIsReAsked() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("bom.ts").path
        var bytes = Data(EditorFileContents.utf8BOM)
        bytes.append(contentsOf: "let a = 1\n".utf8)
        try bytes.write(to: URL(fileURLWithPath: path))

        let harness = makeRuntime(realReader: true)
        boot(harness)
        await open(harness, path: path)
        drain(harness.cef)

        // Somebody rewrites it WITHOUT the BOM.
        try "let a = 2\n".write(toFile: path, atomically: true, encoding: .utf8)
        await harness.runtime.fileChangedOnDisk(path)

        XCTAssertEqual(cdpTypes(harness.cef), ["applyExternalContent"])
        XCTAssertFalse(harness.runtime.fileHadBOM(path),
                       "the file has no BOM now, so the next save must not invent one")
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "let a = 2\n")
    }

    // MARK: Save failures, and the precedence

    /// A failed save shows T8's own sentence and takes itself down after
    /// `editorTransientErrorDuration` — both clocks are the injected one, so nothing here waits.
    func testAFailedSaveShowsItsSentenceAndClearsItselfOnTheClock() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")

        let outcome = await failingSave(harness, path: path)
        XCTAssertEqual(outcome, .failed(EditorSaveCoordinator.pullTimeoutMessage))
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path),
                       .transientError(EditorSaveCoordinator.pullTimeoutMessage),
                       "T8 produced this sentence and nothing surfaced it until now")

        harness.scheduler.current = harness.scheduler.current
            .addingTimeInterval(editorTransientErrorDuration)
        XCTAssertTrue(harness.scheduler.fireNextTimer(), "the 5 s timer was armed")

        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
    }

    /// The precedence rule where it is actually enforced: a save that fails while a conflict is up
    /// changes nothing on screen, and a save that SUCCEEDS resolves the conflict.
    func testAConflictOutranksASaveFailureAndASuccessfulSaveResolvesIt() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")
        markDirty(harness, path: path)
        try "theirs\n".write(toFile: path, atomically: true, encoding: .utf8)
        await harness.runtime.fileChangedOnDisk(path)
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .conflict(.changed))
        drain(harness.cef)

        // A save that fails leaves the conflict exactly where it was.
        let failed = await failingSave(harness, path: path)
        XCTAssertEqual(failed, .failed(EditorSaveCoordinator.pullTimeoutMessage))
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .conflict(.changed))
        XCTAssertFalse(harness.scheduler.liveTimers.contains { _ in true },
                       "and no transient timer was armed for a banner that never appeared")

        // A save that succeeds resolves it: the file now holds this buffer.
        let saved = await save(harness, path: path, answering: "mine\n")
        XCTAssertEqual(saved, .saved)
        XCTAssertEqual(harness.runtime.stateSnapshot.banner(for: path), .none)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "mine\n")
    }

    /// A save whose outcome lands after its model closed says nothing. It arrives after two awaits,
    /// and by then the tab may be gone — a banner keyed to a path nothing renders is a sentence
    /// nobody can dismiss.
    func testASaveOutcomeForAModelThatClosedMidFlightSaysNothing() async throws {
        let (harness, path) = try await openedFile(contents: "one\n")

        let outcome = await failingSave(harness, path: path, closingMidway: true)

        XCTAssertEqual(outcome, .failed(EditorSaveCoordinator.pullTimeoutMessage))
        XCTAssertEqual(harness.runtime.stateSnapshot.banners, [:])
    }

    // MARK: The stale-read guard

    /// **Two overlapping reads, and the older one — carrying genuinely older bytes — resumes last.**
    ///
    /// Without the generation guard it would compare its stale text against a baseline the newer
    /// read has already moved, find a difference, and push an intermediate version of the file into
    /// the buffer: a change announced out of thin air, and the user's editor regressed to a state
    /// the file passed through on its way somewhere else.
    func testAStaleReadCannotSpeakOverALaterOne() async throws {
        let path = "/repo/src/engine.ts"
        // Call 0 is the open; call 1 is the read this test holds; call 2 is the read that overtakes
        // it. The bytes differ at every step, which is what makes the assertion below a tripwire
        // rather than a coincidence.
        let reader = GatedReader(answers: ["one\n", "two\n", "three\n"], gateIndex: 1)
        doubles.append(reader)
        let harness = makeRuntime(readFile: reader.read)
        boot(harness)
        await open(harness, path: path)
        drain(harness.cef)
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "one\n")

        let stale = Task { await harness.runtime.fileChangedOnDisk(path) }
        await waitUntil("the older read to be in flight") { reader.isWaiting }
        // A second fire runs to completion while the first is still blocked.
        await harness.runtime.fileChangedOnDisk(path)
        XCTAssertEqual(cdpTypes(harness.cef), ["applyExternalContent"])
        XCTAssertTrue(try XCTUnwrap(cdpPayloads(harness.cef).first).contains("three"))
        drain(harness.cef)

        reader.openGate()
        await stale.value

        XCTAssertEqual(cdpTypes(harness.cef), [],
                       "the older read resumed last and said nothing — its generation was spent")
        XCTAssertEqual(harness.runtime.knownDiskText(for: path), "three\n",
                       "and it did not drag the baseline back to the version it had read")
    }

    /// The same guard from the other side: a read still in flight when its MODEL closes says
    /// nothing when it resumes.
    func testAReadThatResumesAfterTheModelClosedDoesNothing() async throws {
        let path = "/repo/src/engine.ts"
        let reader = GatedReader(answers: ["one\n", "two\n"], gateIndex: 1)
        doubles.append(reader)
        let harness = makeRuntime(readFile: reader.read)
        boot(harness)
        await open(harness, path: path)
        drain(harness.cef)

        let inFlight = Task { await harness.runtime.fileChangedOnDisk(path) }
        await waitUntil("the read to be in flight") { reader.isWaiting }
        harness.runtime.close(path)
        drain(harness.cef)

        reader.openGate()
        await inFlight.value

        XCTAssertEqual(cdpTypes(harness.cef), [])
        XCTAssertEqual(harness.runtime.stateSnapshot.banners, [:])
    }

    // MARK: The real watcher

    /// **The one test that runs the REAL `DispatchSourceFileWatcher` against a real file** — T7's own
    /// precedent for this kind of machinery (deterministic fakes everywhere, plus one real at a wide
    /// margin), and the only place the class's central claim actually executes.
    ///
    /// It walks the probe recorded in that class's doc, in order, as a permanent tripwire rather
    /// than a scratch script:
    ///
    ///   * **row A** — an in-place `O_TRUNC` rewrite, the shape the daemon's own `writeFileSync`
    ///     tools make. The directory fd sees NOTHING for this; only the file source does, so a fire
    ///     here is the file half working.
    ///   * **row B** — a `rename(2)` replacement, which orphans the inode the file source holds. The
    ///     directory source is what delivers it, so a fire here is the directory half working.
    ///   * **rows C/D** — another in-place write, now against the NEW inode. Without the re-arm
    ///     performed as part of consuming the previous fire, this fires nowhere at all: neither the
    ///     orphaned file source nor the directory (no entry changed). That silence is the invisible
    ///     failure this whole design exists to prevent, and this is where it would show up.
    ///
    /// 50 ms debounce against a 3 s wait — a 60× margin, the same shape `FileTreeModelTests`' single
    /// real watcher uses.
    func testTheRealWatcherSeesInPlaceWritesBeforeAndAfterARename() async throws {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("watched.ts").path
        try "one\n".write(toFile: path, atomically: true, encoding: .utf8)

        let fires = FireCounter()
        let watcher = try XCTUnwrap(DispatchSourceFileWatcher(path: path, debounceInterval: 0.05) {
            fires.bump()
        }, "the real watcher could not open the directory it was given")
        defer { watcher.stop() }

        Self.rewriteInPlace(path, "two\n")
        await waitUntil("the in-place rewrite (probe row A — the file source's own half)") {
            fires.count >= 1
        }

        let temporary = directory.appendingPathComponent(".watched.ts.tmp")
        try "three\n".write(toFile: temporary.path, atomically: true, encoding: .utf8)
        XCTAssertEqual(rename(temporary.path, path), 0)
        await waitUntil("the rename replacement (row B — the directory source's own half)") {
            fires.count >= 2
        }

        Self.rewriteInPlace(path, "four\n")
        await waitUntil("an in-place write AFTER the rename (rows C/D — the RE-ARM, and the whole "
                        + "answer to the re-arm race)") { fires.count >= 3 }

        watcher.stop()
        let afterStop = fires.count
        Self.rewriteInPlace(path, "five\n")
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(fires.count, afterStop, "a stopped watcher is stopped")
    }

    /// An `open(O_TRUNC) + write + close` — the same inode, no rename, exactly what `writeFileSync`
    /// does. Spelled out rather than routed through Foundation so there is no doubt about which
    /// syscall shape the assertion above is about.
    private static func rewriteInPlace(_ path: String, _ text: String) {
        // `Darwin.open` explicitly: this suite has its own `open(_:path:)` helper, which shadows the
        // global one and turns this line into a call that opens a MODEL.
        let fd = Darwin.open(path, O_WRONLY | O_TRUNC)
        guard fd >= 0 else { return XCTFail("could not open \(path) for an in-place rewrite") }
        let bytes = Array(text.utf8)
        _ = bytes.withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
        close(fd)
    }

    /// Counts fires. `@MainActor` because that is where the watcher delivers them, and where the
    /// waiting condition reads them.
    @MainActor
    private final class FireCounter {
        private(set) var count = 0
        func bump() { count += 1 }
    }

    // MARK: The page's own half

    /// **The source pin for the undo-preserving upgrade**, extended by editor-product Task 11 for
    /// the EOL step and the undo-isolation boundary around it. No test in this bundle can run the
    /// page, so the claim is pinned where it lives: the body applies a full-range
    /// `pushEditOperations` edit, pushes the EOL BEFORE it (the vendored `applyEdits` rewrites
    /// inserted text to the model's own ending otherwise), and snapshots the saved version AFTER —
    /// `setValue`, whose `_setValueFromTextBuffer` clears the command manager, is gone from it, and
    /// so — since Task 11 — is `setEOL`, whose own vendored body never reaches `_commandManager`
    /// either (an agent's EOL flip used to survive ⌘Z; Task 9's review named the gap). The whole
    /// change is bracketed by two `pushStackElement()` calls so it lands as its OWN undo unit:
    /// without the first, a user's still-open keystroke would absorb the agent's change into it
    /// (Monaco's `canAppend` has no time or edit-kind test — only an explicit boundary closes an
    /// element); without the second, the user's NEXT keystroke would merge into the agent's.
    func testTheEditorPageAppliesExternalContentAsAnUndoPreservingEdit() throws {
        let source = try XCTUnwrap(Self.pageFile(named: "editor.js"),
                                   "editor.js is in neither the built bundle nor the source tree")
        let code = try String(contentsOf: source, encoding: .utf8)
        let body = try XCTUnwrap(applyExternalContentBody(in: code),
                                 "editor.js no longer defines applyExternalContent")

        XCTAssertFalse(body.contains("setValue("),
                       "setValue clears the model's command manager — an agent's edit must stay "
                       + "undoable")
        // editor-product Task 11: `setEOL` is gone from this function entirely.
        // `TextModel.setEOL`'s own vendored body never reaches `_commandManager` — which is why an
        // agent's EOL flip used to survive ⌘Z, and the next ⌘S would write a whole-file EOL diff
        // nobody asked for. `pushEOL` is the undoable twin (same buffer mutation, recorded).
        XCTAssertFalse(body.contains("setEOL("),
                       "setEOL is invisible to undo — an agent's EOL flip would survive ⌘Z")
        let pushEOL = try XCTUnwrap(body.range(of: "pushEOL("),
                                    "without pushEOL the edit is rewritten to the model's OWN ending "
                                    + "(the same hazard setEOL used to guard against), and an agent's "
                                    + "EOL flip would be invisible to undo")
        let edit = try XCTUnwrap(body.range(of: "pushEditOperations("))
        let fullRange = try XCTUnwrap(body.range(of: "getFullModelRange()"),
                                      "the edit must replace the WHOLE model, not a guess at a range")
        let saved = try XCTUnwrap(body.range(of: "entry.savedVersionId = "))
        XCTAssertTrue(pushEOL.lowerBound < edit.lowerBound)
        XCTAssertTrue(edit.lowerBound < fullRange.upperBound)
        XCTAssertTrue(edit.lowerBound < saved.lowerBound,
                      "the saved point is snapshotted AFTER the edit, or the model would report "
                      + "itself dirty over text that is exactly what is on disk")

        // editor-product Task 11: the undo-isolation boundary — load-bearing, not hygiene. A future
        // cleanup that drops either call silently reintroduces the merge this task closed.
        let firstBoundary = try XCTUnwrap(body.range(of: "pushStackElement()"),
                                          "the agent's change must seal off whatever the user had "
                                          + "open, or one \u{2318}Z would erase the user's edit and "
                                          + "the agent's change together")
        XCTAssertTrue(firstBoundary.lowerBound < pushEOL.lowerBound,
                      "the boundary must be sealed BEFORE the EOL/edit pair, not after")
        let secondBoundary = try XCTUnwrap(
            body.range(of: "pushStackElement()", range: edit.upperBound..<body.endIndex),
            "the agent's change must ALSO seal itself off afterwards, or the user's next keystroke "
            + "would merge into it")
        XCTAssertTrue(edit.lowerBound < secondBoundary.lowerBound)
        XCTAssertTrue(secondBoundary.lowerBound < saved.lowerBound,
                      "the boundary closes the agent's own undo unit before anything else runs")

        XCTAssertTrue(body.contains("entry.applyingExternal = true"),
                      "the transition suppression is still what stops the tab dot blinking")
        XCTAssertTrue(body.contains("entry.lastPull = null"),
                      "a pull the external write invalidated must still be forgotten")
        XCTAssertTrue(body.contains("refreshDirty(entry)"))
    }

    // MARK: - Doubles

    /// A reader that answers real text and can be made to throw on demand.
    private final class FlakyReader: @unchecked Sendable {
        private let text: String
        var failure: Error?
        init(text: String) { self.text = text }
        /// `nonisolated`: this type is nested inside a `@MainActor` test case, so global-actor
        /// isolation propagates into it — and a reader is handed to a seam that runs it on a
        /// DETACHED executor. Without this the closure carries MainActor isolation into a
        /// `@Sendable` position, which is a warning today and an error under Swift 6.
        nonisolated var read: @Sendable (String) throws -> EditorFileContents {
            { [self] _ in
                if let failure { throw failure }
                return EditorFileContents(text: text)
            }
        }
    }

    /// A reader with a SCRIPT — one answer per call, in call order — where one nominated call is
    /// held mid-flight, so two reads for one path genuinely overlap and the older one carries
    /// genuinely older bytes.
    ///
    /// `DispatchSemaphore` rather than a Swift continuation deliberately: the read runs on a
    /// detached executor and blocking one of those threads is exactly the situation being modelled —
    /// with a timeout, so a broken test fails instead of hanging the suite.
    private final class GatedReader: @unchecked Sendable {
        private let answers: [String]
        private let gateIndex: Int
        private let gate = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var calls = 0
        private var waiting = false

        init(answers: [String], gateIndex: Int) {
            self.answers = answers
            self.gateIndex = gateIndex
        }

        func openGate() { gate.signal() }
        var isWaiting: Bool { lock.lock(); defer { lock.unlock() }; return waiting }

        nonisolated var read: @Sendable (String) throws -> EditorFileContents {
            { [self] _ in
                lock.lock()
                let index = calls
                calls += 1
                let answer = index < answers.count ? answers[index] : (answers.last ?? "")
                let holdHere = index == gateIndex
                if holdHere { waiting = true }
                lock.unlock()
                if holdHere {
                    _ = gate.wait(timeout: .now() + 5)
                    lock.lock()
                    waiting = false
                    lock.unlock()
                }
                return EditorFileContents(text: answer)
            }
        }
    }

    // MARK: - The harness

    private static let file = "/repo/src/engine.ts"
    private static let otherFile = "/repo/src/panel.ts"

    private struct RuntimeHarness {
        let runtime: EditorRuntime
        let cef: EditorCEFRecorder
        let slot: EditorSlotRecorder
        let hub: EditorBridgeHub
        let scheduler: EditorFakeScheduler
        let watchers: EditorWatcherRecorder
    }

    private func makeRuntime(realReader: Bool = false,
                             readFile: (@Sendable (String) throws -> EditorFileContents)? = nil)
    -> RuntimeHarness {
        let cef = EditorCEFRecorder()
        cef.browserIds = [41]
        let slot = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: slot.slot)
        let scheduler = EditorFakeScheduler()
        let watchers = EditorWatcherRecorder()
        doubles.append(contentsOf: [cef, slot, hub, scheduler, watchers] as [AnyObject])
        // `realReader` leaves `readFile` at its PRODUCTION default rather than passing
        // `EditorRuntime.readTextFile` explicitly — the same two-branch shape `EditorSaveTests`
        // uses, and for a concrete reason: that static lives on a `@MainActor` type, so naming it
        // as a value carries MainActor isolation into a `@Sendable` parameter (a warning today, an
        // error under Swift 6). The default argument is evaluated in the initialiser's own context
        // and has no such problem.
        let explicitReader: (@Sendable (String) throws -> EditorFileContents)?
        if let readFile {
            explicitReader = readFile
        } else if realReader {
            explicitReader = nil
        } else {
            explicitReader = { _ in EditorFileContents(text: "let a = 1\n") }
        }
        let runtime: EditorRuntime
        if let explicitReader {
            runtime = EditorRuntime(sessionId: "S1", hub: hub, driver: cef.driver,
                                    scheduler: scheduler.scheduler,
                                    colorScheme: { .dark },
                                    readFile: explicitReader,
                                    makeWatcher: watchers.factory)
        } else {
            runtime = EditorRuntime(sessionId: "S1", hub: hub, driver: cef.driver,
                                    scheduler: scheduler.scheduler,
                                    colorScheme: { .dark },
                                    makeWatcher: watchers.factory)
        }
        runtimes.append(runtime)
        return RuntimeHarness(runtime: runtime, cef: cef, slot: slot, hub: hub,
                              scheduler: scheduler, watchers: watchers)
    }

    /// A booted runtime holding one REAL file, read through the production reader.
    private func openedFile(contents: String) async throws -> (RuntimeHarness, String) {
        let directory = try scratchDirectory()
        let path = directory.appendingPathComponent("engine.ts").path
        try contents.write(toFile: path, atomically: true, encoding: .utf8)
        let harness = makeRuntime(realReader: true)
        boot(harness)
        await open(harness, path: path)
        drain(harness.cef)
        return (harness, path)
    }

    private func boot(_ harness: RuntimeHarness) {
        harness.runtime.prewarm()
        harness.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        harness.cef.answerNextCDP()   // setTheme
    }

    /// Open a path and let the page's acknowledgement land — which is what mints the model, and so
    /// what arms the watch.
    private func open(_ harness: RuntimeHarness, path: String) async {
        await harness.runtime.openFile(path)
        drain(harness.cef)
    }

    /// The page reporting a keystroke, through the real hub.
    private func markDirty(_ harness: RuntimeHarness, path: String) {
        harness.slot.deliver(
            browserId: 41, queryId: 7,
            request: #"{"type":"modelDirtyChanged","path":"\#(path)","dirty":true}"#)
        XCTAssertEqual(harness.runtime.stateSnapshot.models[path]?.dirty, true)
    }

    /// A save through the REAL coordinator and the REAL atomic write, with the test standing in for
    /// the page's `contentResponse`.
    private func save(_ harness: RuntimeHarness, path: String,
                      answering text: String) async -> SaveOutcome {
        let save = Task { await harness.runtime.save(path) }
        await waitUntil("the pull") { self.cdpTypes(harness.cef).contains("pullContent") }
        let seq = harness.runtime.saveCoordinator.pendingPullSeqs.first ?? 0
        drain(harness.cef)
        harness.runtime.saveCoordinator.deliverContentResponse(path: path, seq: seq, text: text)
        return await save.value
    }

    /// **A save that genuinely fails, deterministically**: the pull is never answered and the
    /// coordinator's own 5 s timer is fired off the injected clock. The real flow, the real
    /// sentence, no wall clock.
    ///
    /// `closingMidway` closes the model while the save is in flight — the shape a departure or a
    /// tab close makes underneath a save that is still waiting.
    private func failingSave(_ harness: RuntimeHarness, path: String,
                             closingMidway: Bool = false) async -> SaveOutcome {
        let save = Task { await harness.runtime.save(path) }
        await waitUntil("the pull") { self.cdpTypes(harness.cef).contains("pullContent") }
        drain(harness.cef)
        if closingMidway {
            harness.runtime.close(path)
            drain(harness.cef)
        }
        harness.scheduler.current = harness.scheduler.current
            .addingTimeInterval(EditorSaveCoordinator.pullTimeout)
        XCTAssertTrue(harness.scheduler.fireNextTimer(), "the pull timeout was armed")
        return await save.value
    }

    @discardableResult
    private func drain(_ cef: EditorCEFRecorder) -> [String] {
        let types = cdpTypes(cef)
        while cef.answerNextCDP() {}
        return types
    }

    /// The outstanding bridge messages by wire type, read out of the CDP payloads by CONTENT —
    /// never by position (Task 4's `setTheme` shifted every index once already).
    private func cdpTypes(_ cef: EditorCEFRecorder) -> [String] {
        let known = ["setTheme", "openModel", "activateModel", "closeModel", "pullContent",
                     "applyExternalContent", "markSaved"]
        return cef.cdp.compactMap { entry in
            guard let params = entry.params else { return nil }
            return known.first { params.contains(#"\"type\":\""# + $0 + #"\""#) }
        }
    }

    private func cdpPayloads(_ cef: EditorCEFRecorder) -> [String] {
        cef.cdp.compactMap(\.params)
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
            .appendingPathComponent("norma-conflict-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        scratchDirectories.append(directory)
        return directory
    }

    /// The body of `applyExternalContent`, so the pin's ordering claims cannot accidentally read
    /// another function's lines.
    private func applyExternalContentBody(in code: String) -> String? {
        guard let start = code.range(of: "function applyExternalContent(") else { return nil }
        guard let end = code.range(of: "\n}\n", range: start.upperBound..<code.endIndex) else {
            return nil
        }
        return String(code[start.lowerBound..<end.upperBound])
    }

    /// One of the page's own files, wherever it can be found — the bundle first, then the source
    /// tree, exactly as the other page pins look for it.
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
}
