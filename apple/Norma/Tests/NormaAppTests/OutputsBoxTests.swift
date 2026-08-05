import XCTest
@testable import Norma

/// app-shell T8 (spec §3): the outputs box's pure plumbing — path convention, the code/cowork mode
/// gate, and the recursive listing `ShellSessionHost`/`OutputsWatcher` both read through. All
/// filesystem-touching tests use a temp directory (never `~/.norma` — the standing test rule);
/// `OutputsWatcherTests` covers the watcher's own diffing/vanish-tolerance seam.
final class OutputsBoxTests: XCTestCase {
    /// `realpath(3)` AFTER creating the directory — `FileManager.enumerator(at:)` (`listOutputFiles`
    /// itself) reports the fully `/private`-resolved form of `/tmp`/`/var`, while Foundation's own
    /// `URL.resolvingSymlinksInPath()`/`NSString.resolvingSymlinksInPath` both special-case those two
    /// and leave them un-resolved (verified empirically) — the raw POSIX call is the only one that
    /// agrees with what the code under test actually returns.
    private func makeTempHome() -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("OutputsBoxTests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var buf = [Int8](repeating: 0, count: Int(PATH_MAX))
        guard realpath(dir.path, &buf) != nil else { return dir.path }
        return String(cString: buf)
    }

    private func removeIfPresent(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    // MARK: - Path convention

    func testOutputsRootPathAppendsOutputsUnderHome() {
        XCTAssertEqual(outputsRootPath(home: "/tmp/dd-home"), "/tmp/dd-home/outputs")
    }

    func testOutputsSessionPathAppendsSessionIdUnderTheRoot() {
        XCTAssertEqual(outputsSessionPath(home: "/tmp/dd-home", sessionId: "s_1"), "/tmp/dd-home/outputs/s_1")
    }

    /// Profile-resolution pin (spec §3 / the dev-dist-blindness class): a dev-profile `NORMA_HOME`
    /// override must flow straight through to the outputs path, never a literal `~/.norma` — the
    /// exact chain `AppDelegate.boot()`/`ShellSessionHost.refreshOutputFiles` both use
    /// (`outputsRootPath(home: AppProfile.normaHome)`).
    func testOutputsRootPathIsProfileResolvedThroughAppProfileNormaHome() {
        setenv("NORMA_HOME", "/tmp/dd-outputs-dev-home", 1)
        defer { unsetenv("NORMA_HOME") }
        XCTAssertEqual(outputsRootPath(home: AppProfile.normaHome), "/tmp/dd-outputs-dev-home/outputs")
        XCTAssertFalse(outputsRootPath(home: AppProfile.normaHome).contains(NSHomeDirectory() + "/.norma"),
                       "must never fall back to the literal ~/.norma while an explicit override is set")
    }

    // MARK: - listOutputFiles (recursive, sorted, vanish-tolerant)

    func testListOutputFilesListsRecursivelyAndSorted() {
        let home = makeTempHome()
        defer { removeIfPresent(home) }
        let sessionDir = URL(fileURLWithPath: outputsSessionPath(home: home, sessionId: "s_1"))
        let nested = sessionDir.appendingPathComponent("nested", isDirectory: true)
        try! FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        try! Data("b".utf8).write(to: sessionDir.appendingPathComponent("b.txt"))
        try! Data("a".utf8).write(to: nested.appendingPathComponent("a.txt"))

        let files = listOutputFiles(home: home, sessionId: "s_1").map(\.path)
        XCTAssertEqual(files, files.sorted(), "the box's order is stable")
        XCTAssertEqual(Set(files), Set([
            sessionDir.appendingPathComponent("b.txt").path,
            nested.appendingPathComponent("a.txt").path,
        ]))
    }

    /// VANISH-TOLERANT: a session directory that was never created (or has been `rmSync`'d away —
    /// SP2's own shape) must read as "no files," never throw or crash.
    func testListOutputFilesToleratesAMissingSessionDirectory() {
        let home = makeTempHome()
        defer { removeIfPresent(home) }
        XCTAssertEqual(listOutputFiles(home: home, sessionId: "s_never_existed"), [])
    }

    func testListOutputFilesToleratesADirectoryRemovedAfterCreation() {
        let home = makeTempHome()
        defer { removeIfPresent(home) }
        let sessionDir = URL(fileURLWithPath: outputsSessionPath(home: home, sessionId: "s_1"))
        try! FileManager.default.createDirectory(at: sessionDir, withIntermediateDirectories: true)
        try! Data("x".utf8).write(to: sessionDir.appendingPathComponent("x.txt"))
        XCTAssertEqual(listOutputFiles(home: home, sessionId: "s_1").count, 1)

        try! FileManager.default.removeItem(at: sessionDir)
        XCTAssertEqual(listOutputFiles(home: home, sessionId: "s_1"), [], "vanished mid-watch — empty, not a crash")
    }

    // MARK: - outputsBoxEligible (code/cowork only — mirrors the daemon's `participatesInActivity`)

    func testOutputsBoxEligibleForCodeAndCoworkOnly() {
        XCTAssertTrue(outputsBoxEligible(mode: "code"))
        XCTAssertTrue(outputsBoxEligible(mode: "cowork"))
        XCTAssertTrue(outputsBoxEligible(mode: nil), "absent mode defaults to code, the store-wide convention")
        XCTAssertFalse(outputsBoxEligible(mode: "chat"))
        XCTAssertFalse(outputsBoxEligible(mode: "dispatch"))
        XCTAssertFalse(outputsBoxEligible(mode: "some-future-mode"), "fails closed on an unrecognized value")
    }
}
