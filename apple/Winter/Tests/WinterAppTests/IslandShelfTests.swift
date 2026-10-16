import AppKit
import XCTest
@testable import Winter

/// The island's Shelf: it keeps PATHS AND BOOKMARKS ONLY — never a copy, never a write outside its own metadata file —
/// persists across a restart, follows a file that moves or is renamed, shows a deleted one as missing, and copies a
/// file URL to the pasteboard only on the user's action (a private named pasteboard here, never the user's).
@MainActor
final class IslandShelfTests: XCTestCase {
    private var root: URL!
    private var files: URL!
    private var storeDir: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("winter-island-shelf-\(UUID().uuidString)")
        files = root.appendingPathComponent("files", isDirectory: true)
        storeDir = root.appendingPathComponent("store", isDirectory: true)
        try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        addTeardownBlock { [root] in try? FileManager.default.removeItem(at: root!) }
    }

    private var persistence: IslandShelfPersistence {
        IslandShelfPersistence(fileURL: storeDir.appendingPathComponent("shelf.json"))
    }

    @discardableResult
    private func makeFile(_ name: String, in dir: URL? = nil, contents: String = "hello") -> URL {
        let url = (dir ?? files).appendingPathComponent(name)
        FileManager.default.createFile(atPath: url.path, contents: Data(contents.utf8))
        return url
    }

    /// Every file under `dir`, relative, with its size and modification date.
    private func tree(_ dir: URL) -> [String: String] {
        var out: [String: String] = [:]
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
        while let url = e?.nextObject() as? URL {
            let v = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            out[url.path.replacingOccurrences(of: dir.path, with: "")] = "\(v?.fileSize ?? -1)|\(v?.contentModificationDate?.timeIntervalSince1970 ?? 0)"
        }
        return out
    }

    func testAddingKeepsOnlyABookmarkAndThePathAndWritesNothingButItsOwnMetadata() throws {
        let a = makeFile("report.pdf")
        let b = makeFile("photo.png")
        let before = tree(files)
        let shelf = IslandShelfStore(persistence: persistence)
        XCTAssertEqual(shelf.add([a, b]), 2)
        XCTAssertEqual(shelf.items.map(\.name), ["photo.png", "report.pdf"], "the newest first")
        XCTAssertEqual(shelf.items.map(\.lastPath), [b.path, a.path])
        // The files are untouched (no copy beside them, nothing modified)…
        XCTAssertEqual(tree(files), before)
        // …and the store wrote exactly one file: its own metadata, holding no file contents.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: storeDir.path), ["shelf.json"])
        let metadata = try String(contentsOf: storeDir.appendingPathComponent("shelf.json"), encoding: .utf8)
        XCTAssertFalse(metadata.contains("hello"), "never a file's contents")
        XCTAssertLessThan(try Data(contentsOf: storeDir.appendingPathComponent("shelf.json")).count, 16_000)
        // Re-adding the same file moves it to the front instead of a second entry.
        XCTAssertEqual(shelf.add([a]), 0)
        XCTAssertEqual(shelf.items.map(\.name), ["report.pdf", "photo.png"])
        // Not a file URL, or a file that is not there: nothing.
        XCTAssertEqual(shelf.add([URL(string: "https://example.com/x")!, files.appendingPathComponent("nope.txt")]), 0)
        XCTAssertEqual(shelf.items.count, 2)
    }

    func testTheListSurvivesARestart() async throws {
        let a = makeFile("a.txt")
        let first = IslandShelfStore(persistence: persistence)
        first.add([a])
        let second = IslandShelfStore(persistence: persistence)
        XCTAssertTrue(second.items.isEmpty, "nothing is read until the shelf is first used")
        await second.resolveAll()
        XCTAssertEqual(second.items.map(\.lastPath), [a.path])
        XCTAssertEqual(second.url(of: second.items[0].id)?.resolvingSymlinksInPath().path, a.resolvingSymlinksInPath().path)
    }

    func testABookmarkFollowsAMoveAndARenameAcrossARestart() async throws {
        let original = makeFile("Screenshot 1.png")
        let shelf = IslandShelfStore(persistence: persistence)
        shelf.add([original])
        let id = shelf.items[0].id
        // Moved to another folder (a same-volume move, as macOS files a screenshot from its temporary folder)…
        let elsewhere = root.appendingPathComponent("Desktop", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        let moved = elsewhere.appendingPathComponent("Screenshot 1.png")
        try FileManager.default.moveItem(at: original, to: moved)
        await shelf.resolveAll()
        XCTAssertEqual(shelf.url(of: id)?.resolvingSymlinksInPath().path, moved.resolvingSymlinksInPath().path)
        XCTAssertEqual(URL(fileURLWithPath: shelf.items[0].lastPath).resolvingSymlinksInPath().path,
                       moved.resolvingSymlinksInPath().path, "the last known path follows")
        // …then renamed; a fresh store (a restart) still finds it.
        let renamed = elsewhere.appendingPathComponent("Pricing table.png")
        try FileManager.default.moveItem(at: moved, to: renamed)
        let restarted = IslandShelfStore(persistence: persistence)
        await restarted.resolveAll()
        XCTAssertEqual(restarted.url(of: id)?.resolvingSymlinksInPath().path, renamed.resolvingSymlinksInPath().path)
        XCTAssertEqual(restarted.items[0].name, "Pricing table.png")
        XCTAssertEqual(try String(contentsOf: renamed, encoding: .utf8), "hello", "the file itself is never touched")
    }

    func testADeletedFileShowsAsMissingAndRemovingItLeavesTheFileSystemAlone() async throws {
        let a = makeFile("gone.txt")
        let b = makeFile("kept.txt")
        let shelf = IslandShelfStore(persistence: persistence)
        shelf.add([a, b])
        try FileManager.default.removeItem(at: a)
        await shelf.resolveAll()
        let goneId = try XCTUnwrap(shelf.items.first { $0.name == "gone.txt" }?.id)
        let keptId = try XCTUnwrap(shelf.items.first { $0.name == "kept.txt" }?.id)
        XCTAssertEqual(shelf.resolution(of: goneId), .missing)
        XCTAssertNil(shelf.url(of: goneId))
        XCTAssertFalse(shelf.copy(goneId, to: NSPasteboard(name: .init("winter-island-test-\(UUID().uuidString)"))))
        shelf.remove(goneId)
        shelf.remove(keptId)
        XCTAssertTrue(shelf.items.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: b.path), "removing from the shelf never deletes the file")
        let reloaded = IslandShelfStore(persistence: persistence)
        reloaded.loadIfNeeded()
        XCTAssertTrue(reloaded.items.isEmpty, "the removal is persisted")
    }

    func testAScreenshotWhoseTemporaryFileWasCopiedAwayIsFoundByNameInTheScreenshotFolder() async throws {
        let temp = root.appendingPathComponent("TemporaryItems/NSIRD_screencaptureui_ab12", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        let shot = makeFile("Screenshot 2026-10-16 at 09.41.12.png", in: temp)
        let folder = root.appendingPathComponent("Screenshots", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let shelf = IslandShelfStore(persistence: persistence)
        shelf.screenshotFolder = { folder }
        shelf.add([shot])
        let id = shelf.items[0].id
        // Copied to its final place and the temporary one deleted (a new file: the bookmark cannot follow).
        try FileManager.default.copyItem(at: shot, to: folder.appendingPathComponent(shot.lastPathComponent))
        try FileManager.default.removeItem(at: shot)
        await shelf.resolveAll()
        XCTAssertEqual(shelf.url(of: id)?.lastPathComponent, shot.lastPathComponent)
        XCTAssertEqual(shelf.url(of: id)?.deletingLastPathComponent().resolvingSymlinksInPath().path,
                       folder.resolvingSymlinksInPath().path)
        XCTAssertEqual(shelf.items[0].lastPath.hasSuffix("Screenshots/\(shot.lastPathComponent)"), true, "the found file is persisted")
        XCTAssertTrue(IslandShelfBookmarks.isScreenshotTemporary(temp.appendingPathComponent("x.png").path))
        XCTAssertFalse(IslandShelfBookmarks.isScreenshotTemporary(files.appendingPathComponent("x.png").path),
                       "an ordinary file is never matched by name")
    }

    func testAnOlderOrDifferentFileOfTheSameNameIsNeverAttachedToAScreenshot() async throws {
        let temp = root.appendingPathComponent("TemporaryItems/NSIRD_screencaptureui_cd34", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        let folder = root.appendingPathComponent("Screenshots", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let shelf = IslandShelfStore(persistence: persistence)
        shelf.screenshotFolder = { folder }

        // 1. A same-name file in the screenshot folder that is OLDER than the shelving (a day before): not this one.
        let shot = makeFile("Screenshot 2026-10-16 at 10.00.00.png", in: temp, contents: "new shot")
        let older = makeFile(shot.lastPathComponent, in: folder, contents: "new shot")
        try FileManager.default.setAttributes([.creationDate: Date().addingTimeInterval(-86_400)], ofItemAtPath: older.path)
        shelf.add([shot])
        let item = shelf.items[0]
        try FileManager.default.removeItem(at: shot)
        await shelf.resolveAll()
        XCTAssertEqual(shelf.resolution(of: item.id), .missing)
        XCTAssertEqual(shelf.items[0].lastPath, item.lastPath, "a missing item keeps its path…")
        XCTAssertEqual(shelf.items[0].bookmark, item.bookmark, "…and its bookmark: nothing is rewritten")

        // 2. A same-name file made after the shelving but of another size: not this one either.
        let shot2 = makeFile("Screenshot 2026-10-16 at 10.05.00.png", in: temp, contents: "twelve bytes")
        shelf.add([shot2])
        let item2 = try XCTUnwrap(shelf.items.first { $0.name == shot2.lastPathComponent })
        try FileManager.default.removeItem(at: shot2)
        makeFile(shot2.lastPathComponent, in: folder, contents: "a different, longer file")
        await shelf.resolveAll()
        XCTAssertEqual(shelf.resolution(of: item2.id), .missing)
        XCTAssertNil(IslandShelfBookmarks.screenshotFallback(lastPath: shot2.path, addedAt: item2.addedAt, size: item2.size, folder: folder))
    }

    func testCopyPutsTheFileURLOnTheGivenPasteboardOnlyWhenAsked() throws {
        let a = makeFile("copy-me.txt")
        let pasteboard = NSPasteboard(name: .init("winter-island-test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        let shelf = IslandShelfStore(persistence: persistence)
        shelf.add([a])
        XCTAssertNil(pasteboard.string(forType: .fileURL), "adding puts nothing on any pasteboard")
        XCTAssertFalse(shelf.copySelected(to: pasteboard), "nothing selected")
        var selections = 0
        shelf.onSelect = { selections += 1 }
        shelf.select(shelf.items[0].id)
        XCTAssertEqual(selections, 1, "a selection lets the island take the keyboard for ⌘C")
        XCTAssertTrue(shelf.copySelected(to: pasteboard))
        let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
        XCTAssertEqual(urls?.map { $0.resolvingSymlinksInPath().path }, [a.resolvingSymlinksInPath().path])
    }

    func testTheShelfIsBoundedAndLivesInTheAppsOwnSupportFolder() {
        let shelf = IslandShelfStore(persistence: persistence)
        let many = (0..<(IslandShelfStore.maxItems + 5)).map { makeFile("f\($0).txt") }
        shelf.add(many)
        XCTAssertEqual(shelf.items.count, IslandShelfStore.maxItems)
        XCTAssertEqual(shelf.items.first?.name, "f\(IslandShelfStore.maxItems + 4).txt")
        let path = IslandShelfPersistence.appDefault(bundleId: "com.winter.app.dev").fileURL.path
        XCTAssertTrue(path.hasSuffix("Library/Application Support/com.winter.app.dev/Island/shelf.json"), path)
        XCTAssertFalse(path.contains("/.winter"), "never the daemon's home")
    }

    func testTheDropReadsFileURLsOnlyLikeTheComposer() {
        let pasteboard = NSPasteboard(name: .init("winter-island-test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        let a = makeFile("dropped.txt")
        pasteboard.clearContents()
        pasteboard.writeObjects([a as NSURL, URL(string: "https://example.com")! as NSURL])
        XCTAssertEqual(IslandFileDrop.urls(pasteboard).map(\.lastPathComponent), ["dropped.txt"])
    }
}
