import XCTest
@testable import Norma

/// editor-product Task 7: `FileTreeModel` — lazy children, a watcher per expanded node, roots =
/// the session's own working directories.
///
/// Two layers, tested two ways. `sortedTreeEntries`/`listTreeEntries` are pure(-ish) disk reads,
/// driven directly against temp-dir fixtures (`OutputsWatcherTests`/`OutputsBoxTests`' own
/// `makeTempHome` convention, copied here per this project's "each suite keeps its own copy" house
/// rule). `FileTreeModel` itself is driven with a FAKE watcher factory for every test EXCEPT one:
/// the real `DispatchSourceDirectoryWatcher` gets its own end-to-end proof, isolated from the tree
/// logic, using a short injected debounce and the app's own `waitUntil` polling idiom
/// (`EditorTabTests`' own precedent) rather than `XCTestExpectation` — a real DispatchSource event
/// only lands once the run loop actually turns, which `await Task.sleep` guarantees and a bare
/// `wait(for:timeout:)` does not.
@MainActor
final class FileTreeModelTests: XCTestCase {

    // MARK: - Temp-dir harness

    private func makeTempRoot(_ label: String = "FileTreeModelTests") -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("\(label)-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var buf = [Int8](repeating: 0, count: Int(PATH_MAX))
        guard realpath(dir.path, &buf) != nil else { return dir.path }
        return String(cString: buf)
    }

    private func removeIfPresent(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    private func touch(_ path: String, contents: String = "x") {
        try! Data(contents.utf8).write(to: URL(fileURLWithPath: path))
    }

    private func mkdir(_ path: String) {
        try! FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    private func waitUntil(_ label: String, _ condition: () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "timed out waiting for \(label)", file: file, line: line)
    }

    // MARK: - sortedTreeEntries (pure — no filesystem at all)

    func testSortedTreeEntriesPutsDirectoriesFirstThenCaseInsensitiveByName() {
        let entries = [
            FileTreeEntry(path: "/r/zebra.txt", name: "zebra.txt", isDirectory: false),
            FileTreeEntry(path: "/r/Banana", name: "Banana", isDirectory: true),
            FileTreeEntry(path: "/r/apple.txt", name: "apple.txt", isDirectory: false),
            FileTreeEntry(path: "/r/avocado", name: "avocado", isDirectory: true),
        ]
        let sorted = sortedTreeEntries(entries)
        XCTAssertEqual(sorted.map(\.name), ["avocado", "Banana", "apple.txt", "zebra.txt"],
                       "both directories sort ahead of both files, and 'Banana' sorts before "
                           + "'avocado' only by ignoring case would fail — it must not")
    }

    func testSortedTreeEntriesIsCaseInsensitiveWithinTheSameKind() {
        let entries = [
            FileTreeEntry(path: "/r/Zed.txt", name: "Zed.txt", isDirectory: false),
            FileTreeEntry(path: "/r/apple.txt", name: "apple.txt", isDirectory: false),
            FileTreeEntry(path: "/r/Banana.txt", name: "Banana.txt", isDirectory: false),
        ]
        XCTAssertEqual(sortedTreeEntries(entries).map(\.name), ["apple.txt", "Banana.txt", "Zed.txt"])
    }

    // MARK: - listTreeEntries (one real disk read)

    func testListTreeEntriesReadsOneLevelSortedDirsFirst() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/zzz-dir")
        mkdir(root + "/aaa-dir")
        touch(root + "/bbb-file.txt")

        let entries = listTreeEntries(of: root)
        XCTAssertEqual(entries.map(\.name), ["aaa-dir", "zzz-dir", "bbb-file.txt"])
        XCTAssertEqual(entries.map(\.isDirectory), [true, true, false])
        XCTAssertEqual(entries.map(\.path), [root + "/aaa-dir", root + "/zzz-dir", root + "/bbb-file.txt"])
    }

    func testListTreeEntriesFiltersHiddenEntries() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        touch(root + "/.hidden-file")
        mkdir(root + "/.hidden-dir")
        touch(root + "/visible.txt")

        XCTAssertEqual(listTreeEntries(of: root).map(\.name), ["visible.txt"])
    }

    /// VANISH-TOLERANT, the same posture `OutputsBox`/`OutputsWatcher` keep — a directory the
    /// session's own row still names but that no longer exists (deleted underneath an open Files
    /// tab) answers `[]`, never throws or crashes.
    func testListTreeEntriesAnswersEmptyForAMissingDirectory() {
        XCTAssertEqual(listTreeEntries(of: "/tmp/definitely-does-not-exist-\(UUID().uuidString)"), [])
    }

    // MARK: - The watcher fake

    /// One fake watcher — records its own `stop()` rather than touching the filesystem. `onStop`
    /// lets the FACTORY (below) keep a live count without this type needing to know about it.
    @MainActor
    private final class FakeFileTreeWatcher: FileTreeWatching {
        private(set) var stopped = false
        let onStop: () -> Void
        init(onStop: @escaping () -> Void) { self.onStop = onStop }
        func stop() {
            guard !stopped else { return }
            stopped = true
            onStop()
        }
    }

    /// The seam `FileTreeModel(makeWatcher:)` takes in every test below except the one real-watcher
    /// proof. `liveCount` is "collapse releases the watcher" made OBSERVABLE without reading
    /// `FileTreeNode.watcher` (which is `fileprivate` to `FileTreeModel.swift` on purpose — only the
    /// model itself may touch a node's watcher). `fire(_:)` is the synchronous test seam this file's
    /// own doc comment and the task brief both call for: driving "a change happened" without any
    /// real DispatchSource or any real timing, so the tree-refresh tests below cannot flake.
    @MainActor
    private final class FakeWatcherFactory {
        private(set) var liveCount = 0
        private(set) var madePaths: [String] = []
        private var firers: [String: () -> Void] = [:]

        func make(path: String, onChange: @escaping () -> Void) -> FileTreeWatching? {
            madePaths.append(path)
            firers[path] = onChange
            liveCount += 1
            return FakeFileTreeWatcher { [weak self] in self?.liveCount -= 1 }
        }

        @discardableResult
        func fire(_ path: String) -> Bool {
            guard let onChange = firers[path] else { return false }
            onChange()
            return true
        }
    }

    private func makeModel(_ factory: FakeWatcherFactory) -> FileTreeModel {
        FileTreeModel(makeWatcher: { path, onChange in factory.make(path: path, onChange: onChange) })
    }

    // MARK: - Roots, sections, and the root's own auto-expand

    func testASingleRootBecomesOneSectionAutoExpandedWithNoRootRowOfItsOwn() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        touch(root + "/a.txt")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)

        model.setRoots([root])

        XCTAssertEqual(model.sections.count, 1)
        XCTAssertEqual(model.sections[0].rootPath, root)
        XCTAssertTrue(model.sections[0].node.isExpanded, "a root reads and watches immediately")
        XCTAssertEqual(model.sections[0].node.children.map(\.name), ["a.txt"])
        XCTAssertEqual(factory.liveCount, 1, "the root itself gets exactly one watcher")
    }

    func testMultipleRootsBecomeOneSectionEachWithIndependentContents() {
        let rootA = makeTempRoot("A")
        let rootB = makeTempRoot("B")
        defer { removeIfPresent(rootA); removeIfPresent(rootB) }
        touch(rootA + "/only-in-a.txt")
        touch(rootB + "/only-in-b.txt")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)

        model.setRoots([rootA, rootB])

        XCTAssertEqual(model.sections.map(\.rootPath), [rootA, rootB], "order preserved")
        XCTAssertEqual(model.sections[0].node.children.map(\.name), ["only-in-a.txt"])
        XCTAssertEqual(model.sections[1].node.children.map(\.name), ["only-in-b.txt"])
        XCTAssertEqual(factory.liveCount, 2, "one watcher per root")
    }

    /// **Idempotent against its own prior output** — the same paths, called again, leave the
    /// existing sections (and every watcher below them) untouched rather than tearing the tree down
    /// and rebuilding it. This is what stops a `SessionDirectory.$rows` publish that changes some
    /// OTHER field (title, activity) from collapsing whatever the user had open.
    func testSetRootsWithTheIdenticalPathsIsANoOpAndChurnsNoWatchers() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)

        model.setRoots([root])
        model.expand(model.sections[0].node.children[0]) // expand "sub" too
        XCTAssertEqual(factory.liveCount, 2)
        let rootNodeBefore = model.sections[0].node
        let subNodeBefore = model.sections[0].node.children[0]

        model.setRoots([root])

        XCTAssertEqual(factory.liveCount, 2, "no watcher was stopped or restarted")
        XCTAssertTrue(model.sections[0].node === rootNodeBefore, "the root node is the SAME object")
        XCTAssertTrue(model.sections[0].node.children[0] === subNodeBefore, "…and so is 'sub'")
        XCTAssertTrue(subNodeBefore.isExpanded, "expand state survived the no-op call")
    }

    func testSetRootsWithDifferentPathsReleasesEveryWatcherTheOldTreeHeld() {
        let rootA = makeTempRoot("A")
        let rootB = makeTempRoot("B")
        defer { removeIfPresent(rootA); removeIfPresent(rootB) }
        mkdir(rootA + "/sub")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)

        model.setRoots([rootA])
        model.expand(model.sections[0].node.children[0])
        XCTAssertEqual(factory.liveCount, 2, "root + 'sub', both watched")

        model.setRoots([rootB])

        XCTAssertEqual(factory.liveCount, 1, "rootA's two watchers stopped; rootB's root gets one")
        XCTAssertEqual(model.sections.map(\.rootPath), [rootB])
    }

    // MARK: - Lazy expansion: the whole point

    /// **Children are not read until `expand` is called — never merely because a node exists or is
    /// on screen.** `setRoots` reads the ROOT's own level (that is what "the tree shows the repo"
    /// means without a click), but a directory ONE level down must stay untouched until its own
    /// disclosure is opened.
    func testExpandReadsOneLevelAndNeverReadsDeeperUntilAskedAgain() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        touch(root + "/sub/inner.txt")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)

        model.setRoots([root])
        let sub = model.sections[0].node.children.first { $0.name == "sub" }
        guard let sub else { return XCTFail("expected a 'sub' child") }
        XCTAssertTrue(sub.children.isEmpty, "sub's own contents were never read by setRoots")
        XCTAssertFalse(sub.isExpanded)
        XCTAssertFalse(factory.madePaths.contains(sub.path), "no watcher for an unexpanded node")

        model.expand(sub)

        XCTAssertTrue(sub.isExpanded)
        XCTAssertEqual(sub.children.map(\.name), ["inner.txt"], "NOW it reads — exactly on request")
        XCTAssertTrue(factory.madePaths.contains(sub.path))
    }

    /// The row's tap: closed -> open reads; open -> closed releases. `toggle` is the one entry
    /// point the view layer calls, and it must round-trip.
    func testToggleOpensThenClosesTheSameNode() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        let sub = model.sections[0].node.children[0]

        model.toggle(sub)
        XCTAssertTrue(sub.isExpanded)
        XCTAssertEqual(factory.liveCount, 2)

        model.toggle(sub)
        XCTAssertFalse(sub.isExpanded)
        XCTAssertEqual(factory.liveCount, 1, "closing released sub's watcher, root's remains")
    }

    // MARK: - Collapse: bound memory

    /// **"Collapse releases children + watcher"** (design spec), pinned at every level: collapsing a
    /// node with its OWN expanded child releases both watchers and both children arrays, not merely
    /// the immediate level.
    func testCollapseReleasesTheWholeSubtreesChildrenAndWatchersRecursively() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        mkdir(root + "/sub/nested")
        touch(root + "/sub/nested/leaf.txt")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        let sub = model.sections[0].node.children[0]
        model.expand(sub)
        let nested = sub.children[0]
        model.expand(nested)
        XCTAssertEqual(factory.liveCount, 3, "root, sub, nested — all three watched")
        XCTAssertEqual(nested.children.map(\.name), ["leaf.txt"])

        model.collapse(sub)

        XCTAssertFalse(sub.isExpanded)
        XCTAssertTrue(sub.children.isEmpty, "sub's children released…")
        XCTAssertFalse(nested.isExpanded, "…including nested's own expand state")
        XCTAssertEqual(factory.liveCount, 1, "only the root's watcher survives — sub's AND nested's stopped")
    }

    /// Re-expanding after a collapse reads fresh — exactly like a first expand, never a stale cache.
    func testReExpandingAfterCollapseReadsFreshFromDisk() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        let sub = model.sections[0].node.children[0]
        model.expand(sub)
        model.collapse(sub)
        touch(root + "/sub/new-since-collapse.txt")

        model.expand(sub)

        XCTAssertEqual(sub.children.map(\.name), ["new-since-collapse.txt"])
        XCTAssertEqual(factory.liveCount, 2)
    }

    // MARK: - Watcher-driven refresh (the fake's synchronous fire seam)

    /// The watcher's own automatic path: a fire (production: the debounced DispatchSource callback;
    /// here: `FakeWatcherFactory.fire`, driven synchronously so this test cannot flake on real
    /// filesystem timing) re-reads the node it watches and nothing else.
    func testAWatcherFireRereadsOnlyItsOwnNodeAndPicksUpNewEntries() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        XCTAssertTrue(model.sections[0].node.children.isEmpty)

        touch(root + "/created-after-watch.txt")
        XCTAssertTrue(factory.fire(root), "the fake root watcher must exist to fire")

        XCTAssertEqual(model.sections[0].node.children.map(\.name), ["created-after-watch.txt"])
    }

    /// A watcher fires only on ITS OWN path — the sibling's fire above must never touch this node.
    func testAWatcherFireOnOneRootNeverTouchesAnother() {
        let rootA = makeTempRoot("A")
        let rootB = makeTempRoot("B")
        defer { removeIfPresent(rootA); removeIfPresent(rootB) }
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([rootA, rootB])

        touch(rootA + "/only-a.txt")
        factory.fire(rootA)

        XCTAssertEqual(model.sections[0].node.children.map(\.name), ["only-a.txt"])
        XCTAssertTrue(model.sections[1].node.children.isEmpty, "rootB was never fired")
    }

    /// **Deleting an entry releases ITS subtree**, not merely drops it from the array — a fire that
    /// picks up a deletion of an EXPANDED child must stop that child's own watcher too.
    func testAWatcherFireThatPicksUpADeletionReleasesTheDeletedSubtree() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        let sub = model.sections[0].node.children[0]
        model.expand(sub)
        XCTAssertEqual(factory.liveCount, 2)

        try! FileManager.default.removeItem(atPath: root + "/sub")
        factory.fire(root)

        XCTAssertTrue(model.sections[0].node.children.isEmpty)
        XCTAssertEqual(factory.liveCount, 1,
                       "sub's watcher was stopped when sub disappeared — root's own survives, since "
                           + "root itself was never deleted, only its child")
    }

    // MARK: - Identity preservation across a reload — what makes refresh non-destructive

    /// The heart of "refresh does not collapse what is open": a node reload finds STILL PRESENT
    /// keeps the exact same object — proved by reference identity, not merely equal content — so its
    /// `isExpanded`/`children`/watcher survive.
    func testReloadPreservesNodeIdentityForEntriesThatStillExist() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        let subBefore = model.sections[0].node.children[0]
        model.expand(subBefore)

        touch(root + "/new-sibling.txt") // an unrelated addition at the SAME level as 'sub'
        factory.fire(root)

        let subAfter = model.sections[0].node.children.first { $0.name == "sub" }
        XCTAssertTrue(subAfter === subBefore, "the SAME node object, not a fresh one")
        XCTAssertTrue(subAfter?.isExpanded == true, "…so its expand state survived")
        XCTAssertEqual(factory.liveCount, 2, "no watcher churn for the untouched entry")
    }

    // MARK: - Manual refresh (the chrome's button)

    func testRefreshAllRereadsEveryExpandedNodeWithoutDisturbingWhichOnesAreExpanded() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        let sub = model.sections[0].node.children[0]
        model.expand(sub)

        touch(root + "/sub/new.txt")
        touch(root + "/top-level-new.txt")
        model.refreshAll()

        XCTAssertEqual(model.sections[0].node.children.map(\.name).sorted(),
                       ["sub", "top-level-new.txt"])
        XCTAssertEqual(sub.children.map(\.name), ["new.txt"], "the expanded child was refreshed too")
        XCTAssertTrue(sub.isExpanded, "expansion untouched by a manual refresh")
    }

    /// `refreshAll` must not read a COLLAPSED node's contents — it is not a second expand-everything
    /// button.
    func testRefreshAllNeverReadsACollapsedNode() {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        mkdir(root + "/sub")
        touch(root + "/sub/hidden-from-refresh.txt")
        let factory = FakeWatcherFactory()
        let model = makeModel(factory)
        model.setRoots([root])
        let sub = model.sections[0].node.children[0]
        XCTAssertFalse(sub.isExpanded)

        model.refreshAll()

        XCTAssertTrue(sub.children.isEmpty, "still unread — refreshAll respects collapse, same as expand")
    }

    // MARK: - Real DispatchSource end-to-end (isolated from the tree; short debounce, generous wait)

    /// **The one test that touches the real OS watcher.** Everything above drives the tree with a
    /// fake, deterministic seam by design — this test exists so "the real thing actually works" is
    /// proved at least once, isolated from `FileTreeModel` so a flake here can never be confused with
    /// a tree-logic bug. A SHORT injected debounce (`0.05s`, not the production `0.3s`) keeps the
    /// wait bounded; the assertion is deliberately LOOSE (at least one fire, eventually) rather than
    /// an exact count — real filesystem event coalescing on APFS is not guaranteed to produce exactly
    /// one raw event per `write(2)`, and asserting more than "it fires" would be pinning OS behavior
    /// this file has no business asserting.
    func testARealDispatchSourceWatcherEventuallyFiresAfterADiskChange() async {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        var fireCount = 0
        let watcher = DispatchSourceDirectoryWatcher(path: root, debounceInterval: 0.05) {
            fireCount += 1
        }
        guard let watcher else { return XCTFail("open(O_EVTONLY) refused a real, existing directory") }

        touch(root + "/a.txt")

        await waitUntil("the real watcher to fire at least once") { fireCount >= 1 }

        watcher.stop()
    }
}
