import XCTest
import NormaKit
@testable import Norma

/// working-directories T8: the pure decisions behind the create-time picker sheet and the
/// mid-session working-folders chip (`WorkingDirs.swift`). SwiftUI bodies and AppKit panels aren't
/// unit-testable, so this drives the rules directly — the same posture as `ModelPickerTests` /
/// `WindowTaskSectionTests`.
final class WorkingDirsTests: XCTestCase {
    private func row(_ id: String, createdAt: Int, dirs: [SessionDirEntry]?, mode: String? = nil) -> SessionSummary {
        SessionSummary(sessionId: id, title: nil, createdAt: createdAt, scope: "global",
                       cwd: dirs?.first?.path, mode: mode, dirs: dirs)
    }

    // MARK: - recentWorkingDirs

    func testRecentsAreLockedPrimariesNewestFirst() {
        let rows = [
            row("s_1", createdAt: 10, dirs: [SessionDirEntry(path: "/a", locked: true)]),
            row("s_2", createdAt: 30, dirs: [SessionDirEntry(path: "/c", locked: true)]),
            row("s_3", createdAt: 20, dirs: [SessionDirEntry(path: "/b", locked: true)]),
        ]
        XCTAssertEqual(recentWorkingDirs(rows), ["/c", "/b", "/a"])
    }

    /// An UNLOCKED primary is a folder that was picked and never written in — offering it as a
    /// "recent project" is how one mistaken pick propagates itself forward through every sheet.
    func testUnlockedPrimariesAreNotRecents() {
        let rows = [
            row("s_1", createdAt: 20, dirs: [SessionDirEntry(path: "/picked-never-used", locked: false)]),
            row("s_2", createdAt: 10, dirs: [SessionDirEntry(path: "/worked-in", locked: true)]),
        ]
        XCTAssertEqual(recentWorkingDirs(rows), ["/worked-in"])
    }

    /// SECONDARIES never appear: `dirs[0]` is the primary by position, and a secondary is a grant,
    /// not the project.
    func testSecondariesAreNotRecents() {
        let rows = [row("s_1", createdAt: 10, dirs: [
            SessionDirEntry(path: "/project", locked: true),
            SessionDirEntry(path: "/granted-extra", locked: true),
        ])]
        XCTAssertEqual(recentWorkingDirs(rows), ["/project"])
    }

    func testRecentsAreDistinctKeepingTheNewestPosition() {
        let rows = [
            row("s_1", createdAt: 10, dirs: [SessionDirEntry(path: "/repo", locked: true)]),
            row("s_2", createdAt: 30, dirs: [SessionDirEntry(path: "/repo", locked: true)]),
            row("s_3", createdAt: 20, dirs: [SessionDirEntry(path: "/other", locked: true)]),
        ]
        XCTAssertEqual(recentWorkingDirs(rows), ["/repo", "/other"])
    }

    /// A chat/dispatch row carries NO dirs at all (the daemon's participation gate) — it contributes
    /// nothing, and a workdir-less code session (`[]`) contributes nothing either.
    func testNonParticipatingAndWorkdirLessRowsContributeNothing() {
        let rows = [
            row("s_chat", createdAt: 30, dirs: nil, mode: "chat"),
            row("s_bare", createdAt: 20, dirs: []),
            row("s_code", createdAt: 10, dirs: [SessionDirEntry(path: "/repo", locked: true)]),
        ]
        XCTAssertEqual(recentWorkingDirs(rows), ["/repo"])
        XCTAssertEqual(recentWorkingDirs([row("s_chat", createdAt: 1, dirs: nil, mode: "chat")]), [])
    }

    func testRecentsAreCapped() {
        let rows = (0..<20).map { row("s_\($0)", createdAt: $0, dirs: [SessionDirEntry(path: "/p\($0)", locked: true)]) }
        XCTAssertEqual(recentWorkingDirs(rows).count, maxRecentWorkingDirs)
        XCTAssertEqual(recentWorkingDirs(rows, limit: 2), ["/p19", "/p18"])
    }

    /// `sorted(by:)` is not stable and two sessions can share a `createdAt` — the order must not flip
    /// between renders, or the preselected default moves under the user's cursor.
    func testTiedTimestampsOrderDeterministically() {
        let rows = [
            row("s_a", createdAt: 5, dirs: [SessionDirEntry(path: "/a", locked: true)]),
            row("s_b", createdAt: 5, dirs: [SessionDirEntry(path: "/b", locked: true)]),
        ]
        XCTAssertEqual(recentWorkingDirs(rows), recentWorkingDirs(rows.reversed()))
    }

    // MARK: - The create sheet's choice

    func testInitialChoiceIsTheNewestRecentElseNoFolder() {
        XCTAssertEqual(initialWorkingDirChoice(recents: ["/newest", "/older"]), .folder("/newest"))
        XCTAssertEqual(initialWorkingDirChoice(recents: []), .noFolder,
                       "no previous projects ⇒ the session runs workdir-less (design doc §1)")
    }

    /// "No folder" must send NO cwd — that absence is what makes the daemon write `dirs = []`. A
    /// home-directory fallback here would silently adopt the whole home tree as writable.
    func testNoFolderSendsNoCwd() {
        XCTAssertNil(WorkingDirChoice.noFolder.cwdParam)
        XCTAssertEqual(WorkingDirChoice.folder("/repo").cwdParam, "/repo")
    }

    @MainActor
    func testPickerModelPreselectsAndTracksAPickedFolder() {
        let model = WorkingDirPickerModel(recents: ["/newest", "/older"])
        XCTAssertEqual(model.choice, .folder("/newest"), "untouched, Start uses the preselected default")
        XCTAssertEqual(model.folderRows, ["/newest", "/older"])

        model.folderPicked("/brand/new")
        XCTAssertEqual(model.choice, .folder("/brand/new"))
        XCTAssertEqual(model.folderRows, ["/brand/new", "/newest", "/older"],
                       "a just-picked folder heads the list without joining the real recents")

        model.folderPicked("/older")
        XCTAssertEqual(model.folderRows, ["/newest", "/older"], "picking an existing recent adds no duplicate row")
    }

    @MainActor
    func testPickerModelWithNoRecentsDefaultsToNoFolder() {
        let model = WorkingDirPickerModel(recents: [])
        XCTAssertEqual(model.choice, .noFolder)
        XCTAssertEqual(model.folderRows, [])
    }

    @MainActor
    func testPickerModelStartAndCancelReportTheChoice() {
        let model = WorkingDirPickerModel(recents: ["/repo"])
        var started: WorkingDirChoice?
        var cancelled = false
        model.onStart = { started = $0 }
        model.onCancel = { cancelled = true }

        model.start()
        XCTAssertEqual(started, .folder("/repo"))

        model.choice = .noFolder
        model.start()
        XCTAssertEqual(started, .noFolder)

        model.cancel()
        XCTAssertTrue(cancelled)
    }

    // MARK: - The mid-session chip

    /// The chip's gate is the DAEMON's participation answer relayed, not a mode list mirrored here:
    /// absent dirs = no working-directory concept (chat/dispatch), `[]` = a real workdir-less session
    /// that needs the adopt door most of all.
    func testChipVisibilityDistinguishesAbsentFromEmpty() {
        XCTAssertFalse(dirsMenuIsVisible(nil))
        XCTAssertTrue(dirsMenuIsVisible([]))
        XCTAssertTrue(dirsMenuIsVisible([SessionDirEntry(path: "/repo", locked: true)]))
    }

    func testChipLabelNamesThePrimaryOrTheWorkdirLessState() {
        XCTAssertEqual(dirsChipLabel([SessionDirEntry(path: "/Users/k/Code/Norma v2", locked: true),
                                      SessionDirEntry(path: "/tmp/x", locked: false)]), "Norma v2")
        XCTAssertEqual(dirsChipLabel([]), "No folder")
        XCTAssertEqual(dirsChipLabel(nil), "No folder")
    }

    func testDisplayNameFallsBackToTheFullPathWhenThereIsNoLeaf() {
        XCTAssertEqual(workingDirDisplayName("/repo/pkg"), "pkg")
        XCTAssertEqual(workingDirDisplayName("/"), "/")
        XCTAssertEqual(workingDirDisplayName(""), "")
    }

    /// Mirrors `remove`'s two refusals: index 0 is a POSITION (the daemon points at setPrimary), and
    /// a locked entry is permanent for the session's lifetime.
    func testRemoveIsOfferedOnlyForUnlockedNonPrimaries() {
        let dirs = [
            SessionDirEntry(path: "/primary", locked: true),
            SessionDirEntry(path: "/locked-extra", locked: true),
            SessionDirEntry(path: "/loose-extra", locked: false),
        ]
        XCTAssertFalse(dirEntryIsRemovable(dirs, index: 0), "the primary is never removable")
        XCTAssertFalse(dirEntryIsRemovable(dirs, index: 1), "a locked entry is permanent")
        XCTAssertTrue(dirEntryIsRemovable(dirs, index: 2))
        XCTAssertFalse(dirEntryIsRemovable(dirs, index: 9), "out of range is an answer, not a crash")

        // An UNLOCKED primary is still not removable — that refusal is about position, not lock.
        XCTAssertFalse(dirEntryIsRemovable([SessionDirEntry(path: "/p", locked: false)], index: 0))
    }

    /// `setPrimary` refuses outright over a locked `dirs[0]`; on an EMPTY set it is the door that
    /// establishes the primary and exits workdir-less mode.
    func testPrimaryIsReplaceableUnlessLocked() {
        XCTAssertTrue(dirsPrimaryIsReplaceable([]))
        XCTAssertTrue(dirsPrimaryIsReplaceable([SessionDirEntry(path: "/p", locked: false)]))
        XCTAssertFalse(dirsPrimaryIsReplaceable([SessionDirEntry(path: "/p", locked: true),
                                                 SessionDirEntry(path: "/x", locked: false)]))
    }

    /// The confirm names the FULL path — two same-named folders in different trees must not read
    /// identically at the exact moment the user is asked to widen the write fence.
    func testConfirmMessageNamesTheOpAndTheFullPath() {
        XCTAssertEqual(workingDirConfirmMessage(op: .add, path: "/Users/k/one/build"),
                       "Add /Users/k/one/build as a working folder for this session?")
        XCTAssertEqual(workingDirConfirmMessage(op: .setPrimary, path: "/Users/k/two/build"),
                       "Make /Users/k/two/build this session's primary working folder?")
        XCTAssertTrue(workingDirConfirmDetail.contains("write"),
                      "the confirm must say what it grants — a working directory IS the write fence")
    }
}
