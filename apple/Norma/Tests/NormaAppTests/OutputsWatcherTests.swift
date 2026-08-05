import XCTest
@testable import Norma

/// app-shell T8 (spec §3): the watcher's own SEAM — everything here is the PURE half (path→sessionId
/// diffing, `handleRawPaths`' orchestration) driven directly with temp-dir fixtures. The real
/// `FSEventStreamCreate`/`start()` registration is LIVE-GATED, not exercised here — this file's own
/// doc split mirrors `OutputsWatcher`'s own header comment.
@MainActor
final class OutputsWatcherTests: XCTestCase {
    /// `realpath(3)` AFTER creating the directory — see `OutputsBoxTests.makeTempHome`'s identical
    /// doc comment for why (`FileManager.enumerator`'s `/private`-resolved output vs Foundation's
    /// own symlink resolvers, which special-case `/tmp`/`/var` and leave them alone).
    private func makeTempHome() -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("OutputsWatcherTests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var buf = [Int8](repeating: 0, count: Int(PATH_MAX))
        guard realpath(dir.path, &buf) != nil else { return dir.path }
        return String(cString: buf)
    }

    private func removeIfPresent(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    // MARK: - sessionIdsTouched (pure string manipulation — no filesystem access at all)

    func testSessionIdsTouchedExtractsTheFirstPathComponentUnderRoot() {
        let ids = OutputsWatcher.sessionIdsTouched(
            outputsRoot: "/tmp/dd-root/outputs",
            changedPaths: ["/tmp/dd-root/outputs/s_1/report.md", "/tmp/dd-root/outputs/s_1/nested/x.txt"]
        )
        XCTAssertEqual(ids, ["s_1"], "one session, even nested — and deduped")
    }

    func testSessionIdsTouchedCollectsEverySessionInTheBatch() {
        let ids = OutputsWatcher.sessionIdsTouched(
            outputsRoot: "/tmp/dd-root/outputs",
            changedPaths: ["/tmp/dd-root/outputs/s_1/a.txt", "/tmp/dd-root/outputs/s_2/b.txt"]
        )
        XCTAssertEqual(ids, ["s_1", "s_2"])
    }

    func testSessionIdsTouchedIgnoresPathsOutsideTheRoot() {
        let ids = OutputsWatcher.sessionIdsTouched(
            outputsRoot: "/tmp/dd-root/outputs",
            changedPaths: ["/tmp/dd-root/settings.json", "/tmp/elsewhere/outputs/s_1/a.txt"]
        )
        XCTAssertEqual(ids, [])
    }

    /// The root itself (no session component at all) contributes nothing — there is no sessionId to
    /// attribute a bare `outputs/` touch to.
    func testSessionIdsTouchedIgnoresTheBareRoot() {
        let ids = OutputsWatcher.sessionIdsTouched(outputsRoot: "/tmp/dd-root/outputs", changedPaths: ["/tmp/dd-root/outputs"])
        XCTAssertEqual(ids, [])
    }

    // MARK: - handleRawPaths (the orchestration seam a test CAN drive without any real FSEventStream)

    func testHandleRawPathsFiresOnChangeWithTheSessionsCurrentFiles() {
        let home = makeTempHome()
        defer { removeIfPresent(home) }
        let sessionDir = URL(fileURLWithPath: outputsSessionPath(home: home, sessionId: "s_1"))
        try! FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
        let file = sessionDir.appendingPathComponent("report.md")
        try! Data("hi".utf8).write(to: file)

        let watcher = OutputsWatcher(home: home)
        var seen: [(String, [String])] = []
        watcher.onChange = { seen.append(($0, $1)) }

        watcher.handleRawPaths([file.path])

        XCTAssertEqual(seen.count, 1)
        XCTAssertEqual(seen[0].0, "s_1")
        XCTAssertEqual(seen[0].1, [file.path])
    }

    func testHandleRawPathsFiresOnceEachForEverySessionTouched() {
        let home = makeTempHome()
        defer { removeIfPresent(home) }
        for id in ["s_1", "s_2"] {
            let dir = URL(fileURLWithPath: outputsSessionPath(home: home, sessionId: id))
            try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try! Data("x".utf8).write(to: dir.appendingPathComponent("out.txt"))
        }
        let watcher = OutputsWatcher(home: home)
        var touchedIds: Set<String> = []
        watcher.onChange = { sessionId, _ in touchedIds.insert(sessionId) }

        watcher.handleRawPaths([
            outputsSessionPath(home: home, sessionId: "s_1") + "/out.txt",
            outputsSessionPath(home: home, sessionId: "s_2") + "/out.txt",
        ])

        XCTAssertEqual(touchedIds, ["s_1", "s_2"])
    }

    /// VANISH-TOLERANT, at the orchestration level (spec §3's pinned requirement): a session whose
    /// directory is removed BETWEEN the raw event firing and this handler re-listing it must report
    /// an empty file list, never crash or hang — the same `store.deleteSession` `rmSync` shape SP2
    /// already established.
    func testHandleRawPathsToleratesTheSessionDirectoryVanishingBeforeItRelists() {
        let home = makeTempHome()
        defer { removeIfPresent(home) }
        let sessionDir = URL(fileURLWithPath: outputsSessionPath(home: home, sessionId: "s_1"))
        try! FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
        let file = sessionDir.appendingPathComponent("gone.txt")
        try! Data("x".utf8).write(to: file)

        // The whole directory disappears before the watcher gets a chance to re-list it — exactly
        // the race a real FSEvents batch can report a path for and then have deleted underneath it.
        try! FileManager.default.removeItem(at: sessionDir)

        let watcher = OutputsWatcher(home: home)
        var seen: [(String, [String])] = []
        watcher.onChange = { seen.append(($0, $1)) }

        watcher.handleRawPaths([file.path]) // must not throw/crash

        guard let reported = seen.first else {
            return XCTFail("the session must still be reported (even though its directory vanished): \(seen)")
        }
        XCTAssertEqual(seen.count, 1)
        XCTAssertEqual(reported.0, "s_1")
        XCTAssertEqual(reported.1, [], "…with an empty file list, not a stale or crashed read")
    }

    /// A batch that touches no real session (e.g. only the root itself changed) fires `onChange` for
    /// nobody — there is nothing to report.
    func testHandleRawPathsFiresNothingForAnUnattributablePath() {
        let home = makeTempHome()
        defer { removeIfPresent(home) }
        let watcher = OutputsWatcher(home: home)
        var callCount = 0
        watcher.onChange = { _, _ in callCount += 1 }
        watcher.handleRawPaths([outputsRootPath(home: home)])
        XCTAssertEqual(callCount, 0)
    }
}
