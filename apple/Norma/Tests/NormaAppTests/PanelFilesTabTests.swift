import NormaKit
import XCTest
@testable import Norma

/// editor-product Task 7: `PanelFilesTabModel` — the glue between a session's rows and its
/// `FileTreeModel`, and the registry that keeps one per tab id.
///
/// `FileTreeModelTests` covers the tree's own mechanics exhaustively with a fake watcher; this file
/// covers what is NEW here — resolving roots off `SessionDirectory.$rows` (mirroring
/// `EditorTabTests`' own proofs for `PanelEditorTabModel`, at the smaller scale this tab actually
/// has: no runtime, no CEF, no bridge), routing a click through the Task-6 door, and the registry's
/// session-departure prune (`ShellSessionHost.prunePanelTabModelsOnSessionChange`).
@MainActor
final class PanelFilesTabTests: XCTestCase {
    override func tearDown() {
        PanelFilesTabModels.removeAllForTesting()
        super.tearDown()
    }

    // MARK: - Harness (this suite's own copy — "Shell"-prefixed convention, ShellSessionHostTests'
    // own doc comment)

    private func dirRow(_ sessionId: String, dirs: [SessionDirEntry]?) -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global",
                       cwd: dirs?.first?.path, mode: "code", dirs: dirs)
    }

    /// A mutable row source, so a test can make a session's row ARRIVE — mirrors `EditorTabTests
    /// .RowsBox` for the identical reason (the create-then-navigate race).
    private final class RowsBox: @unchecked Sendable {
        var rows: [SessionSummary] = []
    }

    private func makeHost(_ box: RowsBox) async -> ShellSessionHost {
        let directory = SessionDirectory(lister: { box.rows })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        await directory.refresh()
        return host
    }

    /// A management-connected host with NO session attach — `openFile` reaches
    /// `openPanelTab`'s EXPLICIT `sessionId:` door, which needs no attachment at all
    /// (`ShellSessionHost.openPanelTab`'s own doc: "a named session needs neither the attach read
    /// nor the auto-create"), so this suite's harness is lighter than `ShellSessionHostTests`' own
    /// (no `ShellTransportFactory`, no handshake dance).
    private func connectedManagementClient() async -> (client: NormaClient, transport: ShellScriptedTransport) {
        let transport = ShellScriptedTransport()
        let client = NormaClient(makeTransport: { transport }, token: "tok", clientName: "orb")
        let connectTask = Task { try? await client.connect() }
        await feedWaitUntil { transport.sent.count >= 1 }
        let hello = feedLineJSON(transport.sent[0])
        transport.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await connectTask.value
        return (client, transport)
    }

    private func makeHostWithManagement(rows: [SessionSummary] = []) async -> (host: ShellSessionHost, mgmt: ShellScriptedTransport) {
        let (client, transport) = await connectedManagementClient()
        let directory = SessionDirectory(lister: { rows })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil }, managementClient: client)
        return (host, transport)
    }

    private func makeTempRoot(_ label: String = "PanelFilesTabTests") -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("\(label)-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var buf = [Int8](repeating: 0, count: Int(PATH_MAX))
        guard realpath(dir.path, &buf) != nil else { return dir.path }
        return String(cString: buf)
    }

    private func removeIfPresent(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }

    private func waitUntil(_ label: String, _ condition: () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "timed out waiting for \(label)", file: file, line: line)
    }

    // MARK: - Roots resolution (EditorTabSessionRoots reused verbatim — Task 6 review's binding
    // obligation)

    func testADirlessSessionShowsNoRootsAndTheTreeStaysEmpty() async {
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [])]
        let host = await makeHost(box)
        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")
        model.activate()

        XCTAssertEqual(model.roots, .none)
        XCTAssertTrue(model.tree.sections.isEmpty)
        XCTAssertNil(model.primaryRootPath)
    }

    func testASessionWithDirsPopulatesTheTreesRoots() async {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: root, locked: false)])]
        let host = await makeHost(box)
        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")
        model.activate()

        XCTAssertEqual(model.roots, .present)
        XCTAssertEqual(model.tree.sections.map(\.rootPath), [root])
        XCTAssertEqual(model.primaryRootPath, root)
    }

    /// The row has not arrived yet -> `.unknown`, a wait, never the dirless claim (the same
    /// create-then-navigate race `EditorTabSessionRoots`'s own doc names) — and it self-corrects once
    /// `SessionDirectory.$rows` publishes, with nobody re-asking.
    func testALateArrivingRowPopulatesTheTreeWithoutAnybodyAsking() async {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        let box = RowsBox()
        let host = await makeHost(box)
        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")
        model.activate()

        XCTAssertEqual(model.roots, .unknown)
        XCTAssertTrue(model.tree.sections.isEmpty)

        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: root, locked: false)])]
        await host.directory.refresh()

        XCTAssertEqual(model.roots, .present)
        XCTAssertEqual(model.tree.sections.map(\.rootPath), [root])
    }

    /// The predicate reconciliation (Task 6 review, landed by Task 7 in `editorTabSessionRoots`
    /// itself and pinned again from `EditorTabTests`): a degenerate `dirs: [{path: ""}]` row must
    /// read `.none` here too, exactly like a genuinely dirless one — this model asks the identical
    /// question, off the identical function.
    func testADegenerateEmptyPathRootReadsAsDirlessNotPresent() async {
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: "", locked: false)])]
        let host = await makeHost(box)
        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")
        model.activate()

        XCTAssertEqual(model.roots, .none)
        XCTAssertTrue(model.tree.sections.isEmpty)
    }

    /// Fix round 1: `editorTabSessionRoots` only gates the FIRST entry, so a SECOND, degenerate
    /// entry — `dirs: [{path: realRoot}, {path: ""}]` — used to reach `setRoots` unfiltered and mint
    /// a phantom section. Unfixed, this was not a no-op: `URL(fileURLWithPath: "")` resolves to the
    /// PROCESS's own cwd (verified empirically with a throwaway probe, not assumed), and
    /// `listTreeEntries` lists it like any other root — a real, populated, blank-headed section
    /// showing wherever the daemon happens to be running from. Exact equality below pins both halves:
    /// the real root present, and nothing else alongside it.
    func testAMultiRootRowWithOneEmptyEntrySkipsOnlyThatEntry() async {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: root, locked: false),
                                        SessionDirEntry(path: "", locked: false)])]
        let host = await makeHost(box)
        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")
        model.activate()

        XCTAssertEqual(model.roots, .present)
        XCTAssertEqual(model.tree.sections.map(\.rootPath), [root],
                       "the empty second entry must never become its own section")
    }

    // MARK: - The tree row's door (routes through ShellSessionHost.openFileTab, never a parallel path)

    func testOpenFileRoutesThroughTheHostsFileDoorForTheSessionThisModelIsBoundTo() async {
        let rows = [dirRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, mgmt) = await makeHostWithManagement(rows: rows)
        await host.directory.refresh()

        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")

        model.openFile("/repo/engine.ts")

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("openFile must reach the wire through openFileTab: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["kind"] as? String, "code")
        XCTAssertEqual(params?["url"] as? String, "/repo/engine.ts")
        XCTAssertEqual(params?["title"] as? String, "engine.ts")
        XCTAssertNil(params?["diffId"], "a code tab opened from the tree carries no diffId")
    }

    /// No host, no session bound yet (the beat before `bind` has run at all) — `openFile` must do
    /// nothing rather than crash.
    func testOpenFileIsANoOpWithNoHostOrSessionBound() {
        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.openFile("/repo/engine.ts")
    }

    // MARK: - office-plumbing Task 7: the tree door routes office extensions to a document tab

    /// The SAME door, an office-extension path — mints a `.document` tab instead of `.code`, through
    /// the router (`ShellSessionHost.openFileOrDocumentTab`), not a second tree-only mechanism.
    func testOpenFileRoutesAnOfficeExtensionThroughTheHostsDocumentDoor() async {
        let rows = [dirRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, mgmt) = await makeHostWithManagement(rows: rows)
        await host.directory.refresh()

        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")

        model.openFile("/repo/gate.xlsx")

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("an office path clicked in the tree must reach the wire: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["kind"] as? String, "document")
        XCTAssertEqual(params?["url"] as? String, "/repo/gate.xlsx")
        XCTAssertEqual(params?["title"] as? String, "gate.xlsx")
    }

    /// **Dedupe/activate through the REAL tree door**: a second click on the same office path must
    /// activate the tab the first click minted, never open a second. `panelDocumentTabAction`'s own
    /// table is already pinned in `PanelDocumentTabTests`; this proves the TREE actually reaches it,
    /// mirroring `testAFileDoorClickWithNoExistingTabMintsACodeTabWith...`'s sibling proof for `.code`
    /// (`ShellSessionHostTests`) at this tab's own smaller scale.
    func testClickingTheSameOfficePathTwiceInTheTreeActivatesInsteadOfMintingASecondTab() async {
        let rows = [dirRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, mgmt) = await makeHostWithManagement(rows: rows)
        await host.directory.refresh()

        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")

        model.openFile("/repo/gate.xlsx")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }

        // The first click's mint folds into the session's tab list — a real second click only ever
        // sees a tab that has already folded, so the harness folds it explicitly here too.
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "d1", kind: .document, url: "/repo/gate.xlsx", title: "gate.xlsx")],
            activeTabId: nil)

        model.openFile("/repo/gate.xlsx")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("the second click must activate the existing document tab: \(mgmt.methods)")
        }
        XCTAssertEqual((activate["params"] as? [String: Any])?["tabId"] as? String, "d1")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 1,
                       "one tab per office file — the second click must never mint a second")
    }

    /// The router's fire-time belt covers the tree "for free" too — even though the tree shows no
    /// rows at all for a dirless session (so this path is not reachable through real UI), a direct
    /// call proves the router itself, not the tree's own absence of rows, is what refuses it.
    func testOpenFileForAnOfficePathIsANoOpWhenTheSessionHasNoWorkingDirectory() async {
        let rows = [dirRow("S1", dirs: [])]
        let (host, mgmt) = await makeHostWithManagement(rows: rows)
        await host.directory.refresh()

        let model = PanelFilesTabModel(tabId: "t1", tree: FileTreeModel())
        model.bind(host: host, sessionId: "S1")

        model.openFile("/repo/gate.xlsx")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertFalse(mgmt.methods.contains("panel.openTab"),
                       "a dirless session must never mint an office document tab: \(mgmt.methods)")
    }

    // MARK: - The registry

    func testTheRegistryCachesBySameTabIdAndAFreshModelReplacesADiscardedOne() {
        let tab = PanelTab(tabId: "t1", kind: .files, url: nil, title: nil)
        let first = PanelFilesTabModels.model(for: tab, host: nil, sessionId: nil)
        let again = PanelFilesTabModels.model(for: tab, host: nil, sessionId: nil)
        XCTAssertTrue(first === again, "the SAME model for the SAME tabId, across render passes")

        PanelFilesTabModels.discard(tabId: "t1")
        let afterDiscard = PanelFilesTabModels.model(for: tab, host: nil, sessionId: nil)
        XCTAssertFalse(afterDiscard === first, "a discarded tab's model is never reused")
    }

    /// `discard` releases the tab's tree — the direct proof `PanelFilesTabModel.deactivate` (called
    /// through `PanelFilesTabModels.discard`) actually tears the watcher/subscription down, not
    /// merely that the registry forgets the object.
    func testDiscardingATabReleasesItsTreesSections() async {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: [SessionDirEntry(path: root, locked: false)])]
        let host = await makeHost(box)
        let tab = PanelTab(tabId: "t1", kind: .files, url: nil, title: nil)
        let model = PanelFilesTabModels.model(for: tab, host: host, sessionId: "S1")
        model.activate()
        await waitUntil("the root to populate") { !model.tree.sections.isEmpty }

        PanelFilesTabModels.discard(tabId: "t1")

        XCTAssertTrue(model.tree.sections.isEmpty, "deactivate() released every section (and its watcher)")
    }

    // MARK: - Session-departure prune (advisor-flagged: the SAME "wires that act" class Task 5's
    // fix round 1 closed for the editor — a Files tab's model holds a live `$rows` subscription AND
    // live DispatchSource watchers, so it must be released on a session hop, not only on an explicit
    // tab close)

    /// **The real watcher, deliberately** (no fake factory here): this proves the actual resource —
    /// a real open file descriptor behind a real `DispatchSourceDirectoryWatcher` — is released on a
    /// session hop even though the Files tab itself stays open (never `discard`ed). Mirrors
    /// `EditorTabTests.testTheSessionListPollAloneNeverResurrectsADepartedSessionsEditor`'s own
    /// shape: departure driven through the REAL door (`PanelStore.switchSession`), the model read
    /// back through the REGISTRY, since the registry outliving the tab is the mechanism under test.
    func testASessionHopReleasesADepartedSessionsFilesTreeEvenThoughItsTabStaysOpen() async {
        let root = makeTempRoot()
        defer { removeIfPresent(root) }
        let dirs = [SessionDirEntry(path: root, locked: false)]
        let box = RowsBox()
        box.rows = [dirRow("S1", dirs: dirs), dirRow("S2", dirs: dirs)]
        let host = await makeHost(box)

        host.panelStore.switchSession(to: "S1")
        let tab = PanelTab(tabId: "t1", kind: .files, url: nil, title: "Files")
        let model = PanelFilesTabModels.model(for: tab, host: host, sessionId: "S1")
        model.activate()
        await waitUntil("S1's root to populate") { !model.tree.sections.isEmpty }
        XCTAssertEqual(model.tree.sections.map(\.rootPath), [root])

        // The hop: the panel leaves S1 for S2. The Files tab is NOT closed — `discard(tabId:)` is
        // never called — only the SESSION changes, which is what
        // `prunePanelTabModelsOnSessionChange` reacts to via `panelStore.$tabs`.
        host.panelStore.switchSession(to: "S2")

        await waitUntil("the departed model's tree to release") { model.tree.sections.isEmpty }

        // The genuine return mints a FRESH model — the retired one left the registry with the
        // session it belonged to, exactly like the editor's own equivalent proof.
        host.panelStore.switchSession(to: "S1")
        let returned = PanelFilesTabModels.model(for: tab, host: host, sessionId: "S1")
        XCTAssertFalse(returned === model, "a fresh model for the genuine return")
        returned.activate()
        await waitUntil("the return's own re-read") { !returned.tree.sections.isEmpty }
        XCTAssertEqual(returned.tree.sections.map(\.rootPath), [root])
    }
}
