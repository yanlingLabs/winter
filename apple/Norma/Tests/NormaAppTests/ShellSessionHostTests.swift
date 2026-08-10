import XCTest
import AppKit
import NormaProtocol
import NormaKit
@testable import Norma

/// Scripted-transport double, `Shell`-prefixed per `SessionFeedTests`' established convention (each
/// suite keeps its own copy). The difference that matters here: these are minted by a FACTORY, one
/// per connection, because the shell's DETACH *is* the socket closing — the daemon has no
/// `session.detach` RPC (`packages/protocol/src/methods.ts`'s `METHODS` has no such entry; the
/// server detaches a client in its socket `close(...)` handler, `packages/core/src/ipc/server.ts`).
/// Seeing one transport per connection is therefore the only way to observe the policy table's
/// detach rows at all.
final class ShellScriptedTransport: NormaTransport, @unchecked Sendable {
    let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let lock = NSLock()
    private var _sent: [String] = []
    private var _closeCallCount = 0
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return _sent }
    var closeCallCount: Int { lock.lock(); defer { lock.unlock() }; return _closeCallCount }

    init() {
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
    }
    func open() async throws {}
    func send(_ data: Data) async throws {
        lock.lock(); defer { lock.unlock() }
        _sent.append(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines))
    }
    func close() {
        lock.lock(); _closeCallCount += 1; lock.unlock()
        cont.yield(.closed(nil)); cont.finish()
    }
    func feed(_ line: String) { cont.yield(.data(Data((line + "\n").utf8))) }

    /// Every RPC method name this connection has been asked for, in order — the "call shape" the
    /// attachment-policy pins assert against.
    var methods: [String] { sent.compactMap { feedLineJSON($0)["method"] as? String } }

    /// `methods` without the picker-catalogue fetch, which the host fires on connect and which is a
    /// READ, not an attachment operation — it lands asynchronously after the handshake, so leaving
    /// it in an exact-sequence assertion would only buy a race.
    var attachmentMethods: [String] { methods.filter { $0 != "sync.config" } }
}

/// Mints (and remembers) one `ShellScriptedTransport` per `NormaClient.connect()`.
final class ShellTransportFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var _made: [ShellScriptedTransport] = []
    var made: [ShellScriptedTransport] { lock.lock(); defer { lock.unlock() }; return _made }

    func make() -> NormaTransport {
        let t = ShellScriptedTransport()
        lock.lock(); _made.append(t); lock.unlock()
        return t
    }
}

@MainActor
final class ShellSessionHostTests: XCTestCase {
    // MARK: - Harness

    private func makeHost(rows: [SessionSummary] = [], outputsWatcher: OutputsWatcher? = nil) -> (host: ShellSessionHost, factory: ShellTransportFactory) {
        let factory = ShellTransportFactory()
        let directory = SessionDirectory(lister: { rows })
        let host = ShellSessionHost(directory: directory, makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                   mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        }, outputsWatcher: outputsWatcher)
        return (host, factory)
    }

    private func waitUntilSent(_ t: ShellScriptedTransport, _ n: Int, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)", file: file, line: line)
    }

    private func waitUntilMade(_ f: ShellTransportFactory, _ n: Int, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while f.made.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(f.made.count, n, "timed out waiting for \(n) connections", file: file, line: line)
    }

    /// Drives one pinned harness's handshake to attached: hello, then the attach for `sessionId`.
    @discardableResult
    private func answerHandshake(_ t: ShellScriptedTransport, sessionId: String, file: StaticString = #filePath, line: UInt = #line) async -> Int {
        await waitUntilSent(t, 1, file: file, line: line)
        let hello = feedLineJSON(t.sent[0])
        XCTAssertEqual(hello["method"] as? String, "protocol.hello", file: file, line: line)
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2, file: file, line: line)
        let attach = feedLineJSON(t.sent[1])
        XCTAssertEqual(attach["method"] as? String, "session.attach", file: file, line: line)
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, sessionId, file: file, line: line)
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        return attach["id"] as! Int
    }

    // MARK: - The policy table, as a pure decision (spec §1)

    /// Every row of the spec's attachment table, driven directly. This is the decision the host
    /// executes; the wiring tests below prove it actually reaches the wire.
    func testAttachmentPolicyTable() {
        // Visible, a session selected, nothing attached yet → attach THAT session.
        XCTAssertEqual(shellAttachmentAction(selection: "S1", attached: nil, shellVisible: true), .attach("S1"))
        // …and once attached to it, nothing more to do (a re-select must not re-attach).
        XCTAssertEqual(shellAttachmentAction(selection: "S1", attached: "S1", shellVisible: true), .none)
        // Hop to another session → detach previous, attach new (one move; see `ShellSessionHost.hop`).
        XCTAssertEqual(shellAttachmentAction(selection: "S2", attached: "S1", shellVisible: true), .hop("S2"))
        // Window hidden → detach, whatever is selected.
        XCTAssertEqual(shellAttachmentAction(selection: "S1", attached: "S1", shellVisible: false), .detach)
        XCTAssertEqual(shellAttachmentAction(selection: "S2", attached: "S1", shellVisible: false), .detach)
        // Hidden and already detached → nothing (idempotent: a repeated hide must not churn).
        XCTAssertEqual(shellAttachmentAction(selection: "S1", attached: nil, shellVisible: false), .none)
        // Showing no session at all (a mode landing, the dashboard) → detach; "attached to THAT
        // session only" means attached to nothing when there is no session on screen.
        XCTAssertEqual(shellAttachmentAction(selection: nil, attached: "S1", shellVisible: true), .detach)
        XCTAssertEqual(shellAttachmentAction(selection: nil, attached: nil, shellVisible: true), .none)
        // A hidden shell with a selection but no attachment must NOT attach — the row above is what
        // stops a hidden window from holding a session derived-active.
        XCTAssertEqual(shellAttachmentAction(selection: "S1", attached: nil, shellVisible: false), .none)
    }

    // MARK: - Row 1: visible, session selected → attached to THAT session only

    func testSelectAttachesTheSelectedSession() async {
        let (host, factory) = makeHost()
        defer { host.deselect() }
        host.setShellVisible(true)

        host.select("S1")
        XCTAssertEqual(host.attachedSessionId, "S1", "the attachment target flips synchronously")

        await waitUntilMade(factory, 1)
        XCTAssertEqual(factory.made.count, 1, "exactly ONE harness — attached to that session only")
        await answerHandshake(factory.made[0], sessionId: "S1")
        XCTAssertEqual(factory.made[0].attachmentMethods, ["protocol.hello", "session.attach"])
    }

    /// A hidden shell attaches to NOTHING — no harness is even minted. (The policy's whole point:
    /// no session stays derived-active because a hidden window is holding it.)
    func testSelectingWhileHiddenNeverAttaches() async {
        let (host, factory) = makeHost()
        host.select("S1")
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertEqual(host.selection, "S1", "the selection is remembered…")
        XCTAssertNil(host.attachedSessionId, "…but a hidden shell holds no attachment")
        XCTAssertTrue(factory.made.isEmpty, "not even a socket: \(factory.made.count) connections")
    }

    // MARK: - Row 2: hop → detach previous, attach new, NEVER an abort

    /// The mid-turn hop. Two things are asserted, and the second is the important one:
    ///   1. the new session is attached on the SAME connection — which is exactly "detach previous,
    ///      attach new": the daemon's `session.attach` handler detaches this connection's previous
    ///      hub client BEFORE attaching the new one ("re-attach = move semantics",
    ///      `packages/core/src/ipc/server.ts`, and `SessionHub.attach`'s own `if (prev && prev !==
    ///      sessionId) this.detach(client)`).
    ///   2. NOTHING that could abort a running turn is ever sent. The app-kind auto-background
    ///      semantics are the daemon's (`sessions/activity-enforcement.ts`) and are pinned in
    ///      `packages/core`; the app's half of the contract is that a hop asks for an attach and
    ///      nothing else — no interrupt, no agent.stop, no activity write.
    func testHopDetachesThePreviousAndAttachesTheNewWithNoAbort() async {
        let (host, factory) = makeHost()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")

        host.select("S2")
        XCTAssertEqual(host.attachedSessionId, "S2", "the target flips synchronously, before the round trip")

        await waitUntilSent(t, 3)
        let attach = feedLineJSON(t.sent[2])
        XCTAssertEqual(attach["method"] as? String, "session.attach")
        XCTAssertEqual((attach["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        XCTAssertEqual(factory.made.count, 1, "a hop moves the attachment on the SAME socket — no second connection")
        XCTAssertEqual(t.methods.filter { $0 == "protocol.hello" }.count, 1)
        for aborting in ["session.interrupt", "agent.stop", "session.setActivity"] {
            XCTAssertFalse(t.methods.contains(aborting), "a hop must never send \(aborting): \(t.methods)")
        }
        XCTAssertEqual(t.attachmentMethods, ["protocol.hello", "session.attach", "session.attach"],
                       "a hop is an attach and nothing else: \(t.methods)")
    }

    // MARK: - Row 3: hidden/closed → detach (and re-showing re-attaches the same selection)

    func testHidingDetachesAndReShowingReAttachesTheSameSelection() async {
        let (host, factory) = makeHost()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.setShellVisible(false)
        XCTAssertNil(host.attachedSessionId, "a hidden shell is detached")
        XCTAssertEqual(host.selection, "S1", "…but it remembers what it was showing")
        await feedWaitUntil { factory.made[0].closeCallCount >= 1 }
        XCTAssertGreaterThanOrEqual(factory.made[0].closeCallCount, 1,
                                    "detach IS the socket closing — there is no session.detach RPC")

        host.setShellVisible(true)
        XCTAssertEqual(host.attachedSessionId, "S1", "re-showing re-attaches the remembered selection")
        await waitUntilMade(factory, 2)
        await answerHandshake(factory.made[1], sessionId: "S1")
        XCTAssertEqual(factory.made[1].attachmentMethods, ["protocol.hello", "session.attach"])
    }

    /// Navigating the shell somewhere that is not a session (a mode landing, the dashboard) detaches
    /// too — the "attached to THAT session only" invariant read in the other direction.
    func testNavigatingAwayFromASessionDetaches() async {
        let (host, factory) = makeHost()
        host.setShellVisible(true)
        host.apply(destination: .session("S1"))
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.apply(destination: .mode(.code))

        XCTAssertNil(host.selection)
        XCTAssertNil(host.attachedSessionId)
        await feedWaitUntil { factory.made[0].closeCallCount >= 1 }
        XCTAssertGreaterThanOrEqual(factory.made[0].closeCallCount, 1)
        XCTAssertEqual(factory.made.count, 1, "detaching must not open anything")
    }

    // MARK: - Row 4: a detached window closing while the shell shows the same session

    /// The shell holds its OWN harness, so a detached window's close is not the last detach — the
    /// daemon's abort path (`remaining === 0`, `sessions/activity-enforcement.ts`) is never reached
    /// and nothing aborts. The app-side half of that contract, which is what this asserts: closing a
    /// detached window pinned to the SAME session leaves the shell's attachment completely alone —
    /// same socket, still open, no re-attach, still targeting S1.
    func testDetachedWindowCloseLeavesTheShellsAttachmentAlone() async {
        let (host, factory) = makeHost()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let shellTransport = factory.made[0]
        await answerHandshake(shellTransport, sessionId: "S1")

        // A detached window on the same session, with its own harness (spec: harness-per-window).
        let windowTransport = ShellScriptedTransport()
        let windowSession = SessionModel()
        let windowFeed = SessionFeed(makeTransport: { windowTransport }, token: "tok", clientName: "orb",
                                     mode: .pinned(sessionId: "S1"), session: windowSession)
        let window = DetachedWindowController(feed: windowFeed, session: windowSession,
                                              frame: NSRect(x: 0, y: 0, width: 560, height: 640), title: "S1")
        window.show()
        await waitUntilSent(windowTransport, 1)

        window.close()
        await feedWaitUntil { windowTransport.closeCallCount >= 1 }
        // as-m6 (promoted one-liner, final whole-branch review): the wait above asserted nothing
        // of its own — if detached-close became a no-op, R4's pin below would still pass
        // vacuously (the shell was never touching the window's own socket anyway). Pin the value
        // the wait was actually waiting on.
        XCTAssertGreaterThanOrEqual(windowTransport.closeCallCount, 1)
        try? await Task.sleep(nanoseconds: 120_000_000)

        XCTAssertEqual(host.attachedSessionId, "S1", "the shell is still attached to the session it is showing")
        XCTAssertEqual(shellTransport.closeCallCount, 0, "the shell's own socket must not close")
        XCTAssertEqual(shellTransport.attachmentMethods, ["protocol.hello", "session.attach"],
                       "no re-attach, no repair, nothing: \(shellTransport.methods)")
        XCTAssertEqual(factory.made.count, 1)
    }

    // MARK: - The hosted surface's own wiring

    /// A submit in the shell targets the CURRENTLY selected session, read fresh — the exact
    /// closure-capture correctness fix `DetachedWindowController.selectSession` documents, which a
    /// second host would otherwise have to rediscover the hard way.
    func testSubmitTargetsTheSessionTheShellHoppedTo() async {
        let (host, factory) = makeHost()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")

        host.select("S2")
        await waitUntilSent(t, 3)

        guard let adapter = host.attachment?.adapter else { return XCTFail("a visible shell showing a session must have an adapter") }
        adapter.onSubmit("hello S2")

        // Found by METHOD, not by index: the on-connect catalogue fetch lands somewhere in this
        // transcript too, and an index would be asserting on that race instead of on the submit.
        await feedWaitUntil { t.methods.contains("session.send") }
        guard let send = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.send" }) else {
            return XCTFail("the composer's submit never reached the wire: \(t.methods)")
        }
        XCTAssertEqual((send["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        XCTAssertEqual((send["params"] as? [String: Any])?["text"] as? String, "hello S2")
    }

    /// The hosted view's right column is the WorkSidebar and nothing else — the shell's own
    /// `NavigationSplitView` sidebar is the session switcher, so the inner one is opted out of.
    func testHostedSidebarWiringIsRightOnlyAndTracksTheSelection() {
        let (host, _) = makeHost()
        let wiring = host.sidebarWiring
        XCTAssertFalse(wiring.showsSessionSwitcher, "the shell brings its own session switcher")
        XCTAssertNil(wiring.currentSessionId())
        host.setShellVisible(true)
        host.select("S1")
        XCTAssertEqual(host.sidebarWiring.currentSessionId(), "S1", "the work column reads the live selection")
        host.deselect()
    }

    /// Chat identity follows the hop, off the directory's own `mode` field — the same re-derivation
    /// `DetachedWindowController.selectSession` performs (and the same shared helper, so there is
    /// one implementation of "is this session chat", not two).
    func testHopReDerivesChatIdentityFromTheDirectory() async {
        let rows = [
            SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code"),
            SessionSummary(sessionId: "S2", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "chat"),
        ]
        let (host, factory) = makeHost(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        XCTAssertFalse(host.attachment?.adapter.isChatSession ?? true)

        host.select("S2")
        XCTAssertTrue(host.attachment?.adapter.isChatSession ?? false, "hopping onto a chat row flips chat identity on")

        host.select("S1")
        XCTAssertFalse(host.attachment?.adapter.isChatSession ?? true, "…and back off again")
    }

    /// IMP-1 fix (final whole-branch review, "the fourth door"): the restored New-Chat pin, at the
    /// GENERAL mechanism `reconcileIsChatSession` implements — `attachFresh` derives `isChatSession`
    /// exactly ONCE, off whatever `directory.rows` holds at attach time. A session attached before
    /// its own row has loaded (the New-Chat race: `AppDelegate.newChat()` creates then immediately
    /// summons `.session(id)`, always losing the `session_created` broadcast's own refresh round
    /// trip) reads `false` there — this proves the row's LATER arrival, with no further navigation
    /// at all (no hop, no re-select), self-heals it: a plain `directory.refresh()`, exactly what
    /// the daemon's broadcast triggers in production, must flip the ALREADY-attached session's
    /// picker gate back on.
    func testAttachFreshSelfHealsIsChatSessionWhenTheRowLandsAfterAttach() async {
        let lister = StubSessionLister()
        let factory = ShellTransportFactory()
        let directory = SessionDirectory(lister: lister.list)
        let host = ShellSessionHost(directory: directory, makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                   mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        })
        defer { host.deselect() }

        host.setShellVisible(true)
        host.select("s_new_chat") // lister.rows is still empty — the fresh row hasn't loaded yet
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "s_new_chat")

        XCTAssertFalse(
            host.attachment?.adapter.isChatSession ?? true,
            "the row hasn't loaded at attach time — derives false, same as before this fix"
        )

        // The row lands — no hop, no re-selection, just the directory's own refresh (what the
        // daemon's session_created broadcast triggers in production).
        lister.rows = [SessionSummary(sessionId: "s_new_chat", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "chat")]
        await directory.refresh()

        XCTAssertTrue(
            host.attachment?.adapter.isChatSession ?? false,
            "the fresh row landing on an ALREADY-attached session must self-heal isChatSession — the restored New-Chat pin"
        )
    }

    // MARK: - AppDelegate wiring (no socket: the shell is hidden throughout)

    /// The shell's host is real, shares the app's ONE `SessionDirectory` (so every surface reads the
    /// same rows), and — the load-bearing half — a navigation that lands on a session while the
    /// window is hidden records the selection WITHOUT minting a harness.
    func testSummonAppWindowWiresAHostThatStaysDetachedWhileHidden() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.summonAppWindow()
        guard let controller = delegate.appWindow, let host = controller.host else {
            return XCTFail("summonAppWindow() must wire a session host")
        }
        XCTAssertTrue(host.directory === delegate.appModel?.directory, "one directory for every shell surface")

        controller.hide()
        controller.navigation.navigate(to: .session("s_never_attached"))

        XCTAssertEqual(host.selection, "s_never_attached")
        XCTAssertNil(host.attachedSessionId, "a hidden shell never attaches — not even for a fresh navigation")
        XCTAssertNil(host.attachment)
    }

    // MARK: - app-shell T8: the outputs box (temp-dir fixtures throughout — never ~/.norma)

    /// `realpath(3)` AFTER creating the directory: `/tmp`/`/var` are themselves symlinks
    /// (`/private/tmp`, `/private/var`), and `FileManager.enumerator(at:)` (`listOutputFiles`)
    /// reports the fully-resolved form — a fixture root that stayed un-resolved would never
    /// string-equal what the production code reports, for a reason that has nothing to do with the
    /// behavior under test. Foundation's OWN symlink resolvers (`URL.resolvingSymlinksInPath()`,
    /// `NSString.resolvingSymlinksInPath`) both special-case `/var`/`/tmp` and leave them
    /// un-resolved (verified empirically) — the raw POSIX call is the only one that matches.
    private func makeTempHome() -> String {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ShellSessionHostOutputsTests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var buf = [Int8](repeating: 0, count: Int(PATH_MAX))
        guard realpath(dir.path, &buf) != nil else { return dir.path }
        return String(cString: buf)
    }

    private func writeOutputFile(home: String, sessionId: String, name: String) -> URL {
        let dir = URL(fileURLWithPath: outputsSessionPath(home: home, sessionId: sessionId))
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(name)
        try! Data(name.utf8).write(to: file)
        return file
    }

    /// Profile-resolution pin at the HOST level (spec §3 / the dev-dist-blindness class):
    /// `refreshOutputFiles` reads `AppProfile.normaHome`, so a dev-profile `NORMA_HOME` override
    /// must be exactly what a code session's box lists from — never a literal `~/.norma`.
    /// `OutputsBoxTests` pins the same chain at the pure-helper level; this closes the loop through
    /// the real host.
    func testSelectingACodeSessionListsExistingOutputFilesFromTheProfileResolvedHome() async {
        let home = makeTempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        setenv("NORMA_HOME", home, 1)
        defer { unsetenv("NORMA_HOME") }
        let file = writeOutputFile(home: home, sessionId: "S1", name: "report.md")

        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code")]
        let (host, _) = makeHost(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh() // load the row so `mode(of:)` reads the REAL "code", not the not-yet-loaded default
        host.setShellVisible(true)
        host.select("S1")

        XCTAssertEqual(host.outputFiles.map(\.path), [file.path])
    }

    /// The structural "never a hollow box" gate: a chat session's box stays empty even when files
    /// happen to exist on disk under its sessionId — chat/dispatch never populate `outputFiles` at
    /// all, not merely "the view chooses to hide a non-empty list."
    func testChatSessionNeverPopulatesOutputFilesEvenWhenFilesExistOnDisk() async {
        let home = makeTempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        setenv("NORMA_HOME", home, 1)
        defer { unsetenv("NORMA_HOME") }
        _ = writeOutputFile(home: home, sessionId: "S_chat", name: "stray.txt")

        let rows = [SessionSummary(sessionId: "S_chat", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "chat")]
        let (host, _) = makeHost(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh() // load the row — an UNLOADED row is now its OWN ineligible case (fail-closed), never a guess
        host.setShellVisible(true)
        host.select("S_chat")

        XCTAssertEqual(host.outputFiles, [])
    }

    /// Review fix (T8): the "never a hollow box" guarantee must be OWNED here, not borrowed from the
    /// out-of-file fact that chat/dispatch never acquire fs tools. An UNKNOWN row (not yet in
    /// `directory.rows` — a genuinely reachable trigger: navigate to an existing session before its
    /// row has loaded) must fail CLOSED, never default-guess "code eligible". And it must SELF-HEAL:
    /// once the row arrives (a fold or a refresh), eligibility recomputes true for a real code
    /// session and the box populates on the very next call through either site —
    /// `refreshOutputFiles` (proven by the `select` below finding nothing) and `applyOutputsChange`
    /// (proven by the watcher tick after the row loads) both route through the one gate, so this one
    /// test covers both directions at both call sites.
    func testOutputsBoxFailsClosedOnAnUnknownRowThenRecoversOnceItLoads() async {
        let home = makeTempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        // A REAL file already sits on disk for S1 — the only way to observe fail-OPEN vs
        // fail-CLOSED: an empty result is meaningless (and would pass either way) unless there is
        // something on disk the wrong answer could have picked up.
        let file = writeOutputFile(home: home, sessionId: "S1", name: "preexisting.md")

        var rows: [SessionSummary] = [] // S1's row is UNKNOWN to the directory at first
        let directory = SessionDirectory(lister: { rows })
        let factory = ShellTransportFactory()
        let watcher = OutputsWatcher(home: home)
        let host = ShellSessionHost(directory: directory, makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                   mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        }, outputsWatcher: watcher)
        defer { host.deselect() }
        setenv("NORMA_HOME", home, 1)
        defer { unsetenv("NORMA_HOME") }
        host.setShellVisible(true)
        host.select("S1")

        XCTAssertEqual(host.outputFiles, [],
                       "S1's row hasn't loaded yet — fail CLOSED; \(file.path) exists on disk, so a fail-OPEN default would have listed it")

        // The row ARRIVES (a session.list fold/refresh) while still attached to S1 — no hop needed.
        rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code")]
        await directory.refresh()

        // The watcher's own tick re-evaluates eligibility FRESH — the self-healing path both call
        // sites share, now that S1's row says a real code session.
        watcher.onChange?("S1", [file.path])
        XCTAssertEqual(host.outputFiles.map(\.path), [file.path],
                       "the row loading recomputes eligibility true — the box recovers")
    }

    /// A hop re-lists for the NEW session — the old session's files never bleed into the new one.
    func testHopRelistsOutputFilesForTheNewSession() async {
        let home = makeTempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        setenv("NORMA_HOME", home, 1)
        defer { unsetenv("NORMA_HOME") }
        let file1 = writeOutputFile(home: home, sessionId: "S1", name: "one.md")
        let file2 = writeOutputFile(home: home, sessionId: "S2", name: "two.md")

        let rows = [
            SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code"),
            SessionSummary(sessionId: "S2", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "code"),
        ]
        let (host, _) = makeHost(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        XCTAssertEqual(host.outputFiles.map(\.path), [file1.path])

        host.select("S2")
        XCTAssertEqual(host.outputFiles.map(\.path), [file2.path], "the hop must not keep S1's files around")
    }

    /// Detaching (hide, or navigate off the session) clears both the box and any open viewer —
    /// there is nothing left to show for a session the shell isn't attached to.
    func testDetachClearsOutputFilesAndClosesTheViewer() async {
        let home = makeTempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        setenv("NORMA_HOME", home, 1)
        defer { unsetenv("NORMA_HOME") }
        let file = writeOutputFile(home: home, sessionId: "S1", name: "one.md")
        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code")]
        let (host, _) = makeHost(rows: rows)
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        XCTAssertEqual(host.outputFiles.map(\.path), [file.path])
        host.showOutputFile(file)
        XCTAssertEqual(host.openOutputFile, file)

        host.setShellVisible(false)

        XCTAssertEqual(host.outputFiles, [])
        XCTAssertNil(host.openOutputFile)
    }

    /// The box's own click door: opens the third panel on the clicked file; the panel's close button
    /// clears it again. This is the state transition the view's `onSelect`/`onClose` closures ride —
    /// the SwiftUI wiring itself is presence-only (AppKit/QuickLook-backed, not unit-testable, same
    /// posture `WorkingDirsTests`/`FileViewerTests` document).
    func testShowAndCloseOutputFile() {
        let (host, _) = makeHost()
        XCTAssertNil(host.openOutputFile)
        let file = URL(fileURLWithPath: "/tmp/dd/report.md")
        host.showOutputFile(file)
        XCTAssertEqual(host.openOutputFile, file)
        host.closeOutputFile()
        XCTAssertNil(host.openOutputFile)
    }

    // MARK: - The watcher wiring: the box filters to the SHOWN session; a second consumer composes

    /// The core contract behind "design the callback surface for both consumers": a live change for
    /// the session the shell is currently attached to updates the box; a change for any OTHER
    /// session must not touch it — the box only ever shows what it's showing.
    func testWatcherOnChangeUpdatesOnlyTheShownSession() async {
        let home = makeTempHome()
        defer { try? FileManager.default.removeItem(atPath: home) }
        let rows = [
            SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code"),
            SessionSummary(sessionId: "S2", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "code"),
        ]
        let watcher = OutputsWatcher(home: home)
        let (host, _) = makeHost(rows: rows, outputsWatcher: watcher)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        XCTAssertEqual(host.outputFiles, [], "nothing on disk yet")

        watcher.onChange?("S2", ["/tmp/somewhere/S2/ignored.txt"])
        XCTAssertEqual(host.outputFiles, [], "a change for a session the shell ISN'T showing must not touch the box")

        watcher.onChange?("S1", ["/tmp/somewhere/S1/new.txt"])
        XCTAssertEqual(host.outputFiles, [URL(fileURLWithPath: "/tmp/somewhere/S1/new.txt")])
    }

    /// COMPOSE, NEVER REPLACE (`OutputsWatcher.onChange`'s own doc comment — the seam T9's floating
    /// panel must also respect): a pre-existing `onChange` handler set BEFORE `ShellSessionHost` is
    /// constructed must still fire after the host wires its own — proving `init` composed onto it
    /// rather than clobbering it.
    func testHostComposesOntoAPreExistingOnChangeHandlerRatherThanReplacingIt() async {
        let watcher = OutputsWatcher(home: makeTempHome())
        var previousHandlerFired = false
        watcher.onChange = { _, _ in previousHandlerFired = true }

        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code")]
        let (host, _) = makeHost(rows: rows, outputsWatcher: watcher)
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")

        watcher.onChange?("S1", [])

        XCTAssertTrue(previousHandlerFired, "the handler present BEFORE construction must still run")
    }

    // MARK: - cli-handoff T3: "Move to CLI" — the host verb + the true move

    /// The full production wiring loop for the handoff pins: a REAL `ShellNavigationModel` wired
    /// both directions exactly as `AppWindowController.init` wires it (destination changes reach
    /// `apply(destination:)`; the host's true move navigates through `navigate(to:)`) — so "the
    /// normal apply path" in these tests is the same loop production takes, not a shortcut.
    private func makeNavigatedHost(rows: [SessionSummary]) -> (host: ShellSessionHost, factory: ShellTransportFactory, nav: ShellNavigationModel) {
        let (host, factory) = makeHost(rows: rows)
        let nav = ShellNavigationModel()
        nav.onDestinationChange = { [weak host] destination in host?.apply(destination: destination) }
        host.navigateForHandoff = { [weak nav] destination in nav?.navigate(to: destination) }
        return (host, factory, nav)
    }

    /// The handoff's directory is the WIRE row's `dirs[0]` — the pre-designated primary
    /// (`packages/core/src/sessions/dirs.ts`), the SAME source the working-folders chip reads
    /// (`dirsChipLabel(currentSidebarSessionSummary?.dirs)`) — with `NSHomeDirectory()` as the
    /// workdir-less fallback. NEVER the `cwd` alias: the daemon overwrites `cwd` from the dirs set
    /// at list time, so reading it would be a second, echo-shaped source for the same fact.
    func testHandoffDirectoryResolvesDirsFirstWithHomeFallback() {
        let full = SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global",
                                  cwd: "/Users/u/proj", mode: "code",
                                  dirs: [SessionDirEntry(path: "/Users/u/proj", locked: true),
                                         SessionDirEntry(path: "/Users/u/extra", locked: false)])
        XCTAssertEqual(handoffDirectory(row: full), "/Users/u/proj", "dirs[0] — the primary by position")

        // Workdir-less (`dirs == []` is a REAL state, never conflated with nil) falls back to
        // $HOME — and a stale-looking `cwd` must not be consulted on the way down.
        let workdirLess = SessionSummary(sessionId: "S2", title: nil, createdAt: 1, scope: "global",
                                         cwd: "/stale/alias", mode: "code", dirs: [])
        XCTAssertEqual(handoffDirectory(row: workdirLess), NSHomeDirectory())

        // `dirs == nil` (a daemon predating the field) and a missing row both fall back too — a
        // total function, never a guess at a wire fact that isn't there.
        let nilDirs = SessionSummary(sessionId: "S3", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code")
        XCTAssertEqual(handoffDirectory(row: nilDirs), NSHomeDirectory())
        XCTAssertEqual(handoffDirectory(row: nil), NSHomeDirectory())
    }

    /// Failure copy: every `HandoffError` case renders a sentence carrying its payload — the
    /// honesty-of-affordance floor (the alert can only be as informative as this string).
    func testHandoffFailureMessagesCarryTheirPayloads() {
        XCTAssertTrue(handoffFailureMessage(.cliMissing("/x/Resources")).contains("/x/Resources"))
        XCTAssertTrue(handoffFailureMessage(.scriptWriteFailed("/y/script.sh")).contains("/y/script.sh"))
        XCTAssertTrue(handoffFailureMessage(.openFailed(3)).contains("3"))
    }

    /// The TRUE MOVE (spec §1, ruling R1): a successful launch for the CURRENTLY-ATTACHED session
    /// navigates the shell to the Code landing through the normal apply path — which detaches
    /// app-kind (the daemon auto-backgrounds if mid-turn, never aborts). The wire pins are the
    /// app's half of that contract: the move is a launch + a socket close and NOTHING else — no
    /// setActivity, no interrupt, no extra attach.
    func testMoveToCliOnTheAttachedSessionLaunchesThenNavigatesToTheCodeLanding() async {
        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global",
                                   cwd: "/Users/u/proj", mode: "code",
                                   dirs: [SessionDirEntry(path: "/Users/u/proj", locked: true)], activity: "idle")]
        let (host, factory, nav) = makeNavigatedHost(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        nav.navigate(to: .session("S1"))
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")

        var launched: [(sessionId: String, dir: String)] = []
        host.handoffLaunch = { launched.append(($0, $1)); return nil }

        host.moveToCli(sessionId: "S1")

        XCTAssertEqual(launched.count, 1)
        XCTAssertEqual(launched.first?.sessionId, "S1")
        XCTAssertEqual(launched.first?.dir, "/Users/u/proj", "the WIRE row's dirs[0], the chip's own source")
        XCTAssertEqual(nav.destination, .mode(.code), "the true move: the shell steps aside to the Code landing")
        XCTAssertNil(host.selection)
        XCTAssertNil(host.attachedSessionId, "the attachment drops (app-kind — hop-away semantics, never an abort)")
        await feedWaitUntil { t.closeCallCount >= 1 }
        XCTAssertGreaterThanOrEqual(t.closeCallCount, 1, "the detach IS the socket closing")
        XCTAssertEqual(factory.made.count, 1, "no extra harness is ever minted for a move")
        for aborting in ["session.interrupt", "agent.stop", "session.setActivity"] {
            XCTAssertFalse(t.methods.contains(aborting), "a move must never send \(aborting): \(t.methods)")
        }
        XCTAssertEqual(t.attachmentMethods, ["protocol.hello", "session.attach"],
                       "the move's whole wire story is the one attach it already had: \(t.methods)")
    }

    /// A LANDING-ROW trigger for a session the shell is NOT attached to launches only — no
    /// navigation (the shell is already exactly where a move would land it), and no attach is ever
    /// minted for it (the same "a roster action must never attach" discipline the roster verbs pin:
    /// an attach here would silently un-archive nothing today, but it would be a second door onto
    /// the trap).
    func testMoveToCliFromALandingRowLaunchesWithoutNavigatingOrAttaching() async {
        let rows = [SessionSummary(sessionId: "S2", title: nil, createdAt: 1, scope: "global",
                                   cwd: nil, mode: "code",
                                   dirs: [SessionDirEntry(path: "/Users/u/proj2", locked: false)], activity: "idle")]
        let (host, factory) = makeHost(rows: rows)
        await host.directory.refresh()
        host.setShellVisible(true) // showing the code LANDING: visible, no session selected, detached

        var launched: [(sessionId: String, dir: String)] = []
        var navigations: [ShellDestination] = []
        host.handoffLaunch = { launched.append(($0, $1)); return nil }
        host.navigateForHandoff = { navigations.append($0) }

        host.moveToCli(sessionId: "S2")

        XCTAssertEqual(launched.count, 1)
        XCTAssertEqual(launched.first?.dir, "/Users/u/proj2")
        XCTAssertTrue(navigations.isEmpty, "launch only — a non-attached session moves nothing")
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertTrue(factory.made.isEmpty, "the handoff must NEVER mint an attaching harness")
        XCTAssertNil(host.attachedSessionId)
    }

    /// FAILURE (the honesty-of-affordance pin): a launch error presents visibly through the seam
    /// and the app does NOT step aside — the session the Terminal never got stays exactly where it
    /// was: same selection, same attachment, socket open, wire untouched.
    func testMoveToCliFailureNeverNavigatesAndPresentsTheErrorVisibly() async {
        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global",
                                   cwd: "/Users/u/proj", mode: "code",
                                   dirs: [SessionDirEntry(path: "/Users/u/proj", locked: true)], activity: "idle")]
        let (host, factory, nav) = makeNavigatedHost(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        nav.navigate(to: .session("S1"))
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")

        var presented: [HandoffError] = []
        host.handoffLaunch = { _, _ in .openFailed(3) }
        host.presentHandoffFailure = { presented.append($0) }

        host.moveToCli(sessionId: "S1")

        XCTAssertEqual(presented, [.openFailed(3)], "the failure is PRESENTED via the seam, never log-only")
        XCTAssertEqual(nav.destination, .session("S1"),
                       "no navigation — the app must not step aside from a session the Terminal never got")
        XCTAssertEqual(host.attachedSessionId, "S1")
        try? await Task.sleep(nanoseconds: 120_000_000)
        XCTAssertEqual(t.closeCallCount, 0, "the attachment's socket stays open")
        XCTAssertEqual(t.attachmentMethods, ["protocol.hello", "session.attach"], "the wire is untouched: \(t.methods)")
        XCTAssertEqual(factory.made.count, 1)
    }

    /// Defense-in-depth behind the affordance gate: the host verb re-checks eligibility and
    /// launches NOTHING for a row the affordance should never have rendered on — archived, a
    /// non-code mode, or a row not loaded at all (no row = no wire dirs to read; a launch would be
    /// guessing). The affordances' ABSENCE itself is pinned by `testMoveToCliOfferedMatrix` in
    /// ModeLandingViewTests — both surfaces render off that one gate.
    func testMoveToCliRefusesIneligibleRowsWithoutLaunching() async {
        let rows = [
            SessionSummary(sessionId: "s_archived", title: nil, createdAt: 2, scope: "global", cwd: "/repo",
                           mode: "code", dirs: [SessionDirEntry(path: "/repo", locked: true)], activity: "archived"),
            SessionSummary(sessionId: "s_chat", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "chat"),
        ]
        let (host, factory) = makeHost(rows: rows)
        await host.directory.refresh()
        host.setShellVisible(true)

        var launched = 0
        var presented = 0
        var navigations = 0
        host.handoffLaunch = { _, _ in launched += 1; return nil }
        host.presentHandoffFailure = { _ in presented += 1 }
        host.navigateForHandoff = { _ in navigations += 1 }

        host.moveToCli(sessionId: "s_archived")
        host.moveToCli(sessionId: "s_chat")
        host.moveToCli(sessionId: "s_unknown") // no row at all

        XCTAssertEqual(launched, 0)
        XCTAssertEqual(presented, 0, "a refusal is not a launch failure — nothing to present")
        XCTAssertEqual(navigations, 0)
        XCTAssertTrue(factory.made.isEmpty)
    }

    /// The workdir-less fallback THROUGH the verb: `dirs == []` (a real state — writable only in
    /// $OUTDIR/$TMPDIR/$MEMDIR) hands Terminal $HOME, never the row's `cwd` alias and never a
    /// refusal (spec §1: "$HOME fallback for workdir-less").
    func testMoveToCliFallsBackToHomeForAWorkdirLessSession() async {
        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global",
                                   cwd: "/stale/alias", mode: "code", dirs: [], activity: "idle")]
        let (host, _) = makeHost(rows: rows)
        await host.directory.refresh()
        host.setShellVisible(true)

        var launched: [(sessionId: String, dir: String)] = []
        host.handoffLaunch = { launched.append(($0, $1)); return nil }

        host.moveToCli(sessionId: "S1")

        XCTAssertEqual(launched.count, 1)
        XCTAssertEqual(launched.first?.dir, NSHomeDirectory())
    }

    // MARK: - chatgpt-ui T2: the new-chat page's create-on-send flow (spec §2 — the wire pins)

    /// A connected `NormaClient` on its OWN scripted transport — standing in for `AppModel.client`
    /// (the management connection the create rides), the exact `ModeLandingViewTests` idiom.
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

    private func makeHostWithManagement(rows: [SessionSummary] = []) async -> (host: ShellSessionHost, factory: ShellTransportFactory, mgmt: ShellScriptedTransport) {
        let (client, transport) = await connectedManagementClient()
        let factory = ShellTransportFactory()
        let directory = SessionDirectory(lister: { rows })
        let host = ShellSessionHost(directory: directory, makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                   mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        }, managementClient: client)
        return (host, factory, transport)
    }

    /// THE ordering pin (spec §2): first send ⇒ exactly ONE `session.create` (mode `"chat"`,
    /// `cwd` ABSENT) on the MANAGEMENT connection — then, on the created session's OWN harness,
    /// attach strictly BEFORE `session.send`, with the typed text as the verbatim payload. The
    /// text is seeded into the attached composer at attach (the carry — no empty beat) and clears
    /// only once the send actually lands.
    func testFirstSendCreatesOnceThenAttachesThenSendsInWireOrder() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)

        var landed: [String] = []
        host.sendFirstChatMessage("  the first message  ") { id in
            landed.append(id)
            host.apply(destination: .session(id)) // the page's navigate, at the host's own seam
        }
        XCTAssertEqual(host.newChatCreate, .creating)

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("the first send must ride session.create on the management connection: \(mgmt.methods)")
        }
        let params = create["params"] as? [String: Any]
        XCTAssertEqual(params?["mode"] as? String, "chat")
        XCTAssertEqual(params?["scope"] as? String, "global")
        XCTAssertEqual(params?["approvalPolicy"] as? String, "auto")
        XCTAssertNil(params?["cwd"], "cwd ABSENT — the established chat-create shape")
        XCTAssertTrue(factory.made.isEmpty, "nothing attaches before the create lands")

        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_chat_new","trusted":true}}"#)

        await waitUntilMade(factory, 1)
        XCTAssertEqual(landed, ["s_chat_new"], "success navigates — once")
        XCTAssertEqual(host.newChatCreate, .idle)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_chat_new")

        // The carry: the trimmed text sits in the attached composer before the send lands.
        await feedWaitUntil { host.attachment != nil }
        XCTAssertEqual(host.attachment?.adapter.composerDraft, "the first message",
                       "the typed text (trimmed) carries into the attached composer — no empty beat, no lost keystrokes")

        await feedWaitUntil { t.methods.contains("session.send") }
        guard let send = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.send" }) else {
            return XCTFail("the pending first message must send on the ATTACHED harness: \(t.methods)")
        }
        XCTAssertEqual((send["params"] as? [String: Any])?["sessionId"] as? String, "s_chat_new")
        XCTAssertEqual((send["params"] as? [String: Any])?["text"] as? String, "the first message",
                       "the send text IS the first message payload, verbatim")
        XCTAssertEqual(Array(t.attachmentMethods.prefix(3)), ["protocol.hello", "session.attach", "session.send"],
                       "attach strictly before send — the daemon refuses sends on an unattached connection")
        XCTAssertTrue(mgmt.methods.allSatisfy { $0 != "session.send" }, "the send never rides the management connection")

        t.feed(#"{"jsonrpc":"2.0","id":\#(send["id"] as! Int),"result":{"seq":1}}"#)
        await feedWaitUntil { host.attachment?.adapter.composerDraft == "" }
        XCTAssertEqual(host.attachment?.adapter.composerDraft, "", "the carried draft clears once the send lands")

        let creates = mgmt.methods.filter { $0 == "session.create" } + factory.made.flatMap(\.methods).filter { $0 == "session.create" }
        XCTAssertEqual(creates.count, 1, "exactly ONE create, ever, for the whole flow")
    }

    /// The double-send race (decided: BLOCK): a second submit while the create is in flight is a
    /// no-op — ONE create total, one navigation, and the text is still in the page's composer the
    /// whole time so nothing is lost by the block.
    func testDoubleSendWhileCreateInFlightYieldsExactlyOneCreate() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)

        var landed: [String] = []
        host.sendFirstChatMessage("first press") { landed.append($0) }
        host.sendFirstChatMessage("second press") { landed.append($0) } // the race: create still in flight

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1,
                       "the second send while a create is in flight must NOT mint a second create")

        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_once","trusted":true}}"#)
        await feedWaitUntil { !landed.isEmpty }
        XCTAssertEqual(landed, ["s_once"], "one create, one navigation")
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1, "still exactly one after the response")
    }

    /// The unreachable-daemon matrix (decided: VISIBLE failure, no navigation): an RpcError
    /// publishes the daemon's sentence VERBATIM; a host with no management client at all (the
    /// degraded shape) publishes the house fallback; neither ever fires `onCreated`. A whitespace
    /// -only submit does nothing at all (no state churn, no RPC).
    func testFirstSendFailurePublishesVisiblyAndNeverNavigates() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)

        var navigated = false
        host.sendFirstChatMessage("hello") { _ in navigated = true }
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"error":{"code":1,"message":"chat is temporarily unavailable"}}"#)

        await feedWaitUntil { host.newChatCreate != .creating }
        XCTAssertEqual(host.newChatCreate, .failed("chat is temporarily unavailable"),
                       "the daemon's own sentence, verbatim — the house refusal discipline")
        XCTAssertFalse(navigated, "a failed create never navigates")
        XCTAssertTrue(factory.made.isEmpty, "a failed create never attaches")

        // A retry can fire again after a failure (the block is per-in-flight-create, not forever).
        host.sendFirstChatMessage("hello again") { _ in navigated = true }
        await feedWaitUntil { mgmt.methods.filter { $0 == "session.create" }.count == 2 }
        XCTAssertEqual(host.newChatCreate, .creating, "a failure never wedges the page — the next Enter retries")

        // The degraded shape: no management client at all → the house fallback, synchronously.
        let (bare, _) = makeHost()
        var bareNavigated = false
        bare.sendFirstChatMessage("hello") { _ in bareNavigated = true }
        XCTAssertEqual(bare.newChatCreate, .failed(newChatUnreachableMessage))
        XCTAssertFalse(bareNavigated)

        // Whitespace-only: nothing happens at all.
        let (empty, _) = makeHost()
        empty.sendFirstChatMessage("   \n ") { _ in XCTFail("an empty submit must not create") }
        XCTAssertEqual(empty.newChatCreate, .idle, "an empty submit is a no-op, not a failure")
    }

    /// T2 fix round 1 — the reviewer's exact scenario (the single-slot overwrite, proved
    /// PLAUSIBLE: `.creating` lifts at create-ack before delivery, the page shows no in-flight
    /// feedback, so a slow attach invites navigate-away → re-enter → re-send): send A → navigate
    /// away → re-enter → send B ⇒ TWO creates, TWO sessions, EACH message delivered to ITS OWN
    /// session on ITS OWN attach (wire-verified), and ONLY the current page's create navigates —
    /// the departed create delivers QUIETLY (its session sits in Recents; no yank). Late delivery
    /// is a commitment: message A lands when s_first's attach eventually happens — here via the
    /// HOP path (the shell is on s_second when the user opens s_first from Recents), which is the
    /// natural Recents click and the delivery path a naive onConnected-only wiring misses.
    func testDepartedCreatesMessageStillDeliversAndOnlyTheCurrentPagesCreateNavigates() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        var navigations: [String] = []
        // Send A from the page, then leave BEFORE the create acks (the slow-create beat).
        host.sendFirstChatMessage("message A") { navigations.append($0) }
        host.apply(destination: .mode(.chat))

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let createA = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("send A must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(createA["id"] as! Int),"result":{"sessionId":"s_first","trusted":true}}"#)

        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(navigations, [], "a DEPARTED page's create delivers quietly — it must never yank navigation")

        // Re-enter the page (a NEW page instance), send B — the current-instance create.
        host.apply(destination: .newChat)
        host.sendFirstChatMessage("message B") { [weak host] id in
            navigations.append(id)
            host?.apply(destination: .session(id))
        }
        await feedWaitUntil { mgmt.methods.filter { $0 == "session.create" }.count == 2 }
        guard let createB = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("send B must create its OWN session: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(createB["id"] as! Int),"result":{"sessionId":"s_second","trusted":true}}"#)

        await feedWaitUntil { !navigations.isEmpty }
        XCTAssertEqual(navigations, ["s_second"], "ONLY the current page instance's create navigates")
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 2, "two sends, two sessions — no lost create")

        // B delivers on ITS OWN attach (the navigation just selected s_second).
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_second")
        await feedWaitUntil { t.methods.contains("session.send") }
        guard let sendB = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.send" }) else {
            return XCTFail("message B must deliver on s_second's attach: \(t.methods)")
        }
        XCTAssertEqual((sendB["params"] as? [String: Any])?["sessionId"] as? String, "s_second")
        XCTAssertEqual((sendB["params"] as? [String: Any])?["text"] as? String, "message B")
        t.feed(#"{"jsonrpc":"2.0","id":\#(sendB["id"] as! Int),"result":{"seq":1}}"#)

        // A delivers LATE, on s_first's OWN attach — the user opens it from Recents while the
        // shell is attached to s_second: a HOP (one session.attach on the SAME connection).
        host.apply(destination: .session("s_first"))
        await feedWaitUntil { t.methods.filter { $0 == "session.attach" }.count == 2 }
        guard let attachA = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.attach" }) else {
            return XCTFail("the hop must re-attach on the same connection: \(t.methods)")
        }
        XCTAssertEqual((attachA["params"] as? [String: Any])?["sessionId"] as? String, "s_first")
        t.feed(#"{"jsonrpc":"2.0","id":\#(attachA["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await feedWaitUntil { t.methods.filter { $0 == "session.send" }.count == 2 }
        guard let sendA = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.send" }) else {
            return XCTFail("message A must STILL deliver, on s_first's own attach — the commitment; the slot must not have been overwritten by B: \(t.methods)")
        }
        XCTAssertEqual((sendA["params"] as? [String: Any])?["sessionId"] as? String, "s_first",
                       "A delivers into ITS session — never cross-delivered")
        XCTAssertEqual((sendA["params"] as? [String: Any])?["text"] as? String, "message A",
                       "the departed first message is a commitment — never silently dropped (the single-slot overwrite bug)")
        // The wire order on the hop: A's send comes strictly AFTER s_first's attach.
        let hopTrace = t.attachmentMethods
        XCTAssertTrue(hopTrace.lastIndex(of: "session.attach")! < hopTrace.lastIndex(of: "session.send")!,
                      "attach-before-send holds on the late/hop delivery too: \(hopTrace)")
    }

    /// Navigating to the page detaches whatever was attached (spec §2: NO session on the page)
    /// and issues no RPCs of its own; a stale create failure clears on entry so the page always
    /// starts clean.
    func testApplyNewChatDetachesAndStartsThePageClean() async {
        let (host, factory) = makeHost()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")
        XCTAssertEqual(host.attachedSessionId, "S1")

        host.apply(destination: .newChat)

        XCTAssertNil(host.attachedSessionId, "the page shows no session — the attachment drops")
        XCTAssertNil(host.attachment)
        await feedWaitUntil { t.closeCallCount == 1 } // the close rides a Task — wait, don't race it
        XCTAssertEqual(t.closeCallCount, 1, "the detach IS the socket closing")
        let methods = t.methods
        XCTAssertFalse(methods.contains("session.create"), "arriving on the page mints nothing")

        // A stale failure from a previous visit clears on re-entry.
        host.sendFirstChatMessage("x") { _ in } // no management client → failed
        XCTAssertEqual(host.newChatCreate, .failed(newChatUnreachableMessage))
        host.apply(destination: .newChat)
        XCTAssertEqual(host.newChatCreate, .idle, "the page starts clean on every entry")
    }

    /// panel-shell T10b: the SAME "starts clean on every entry" contract as `newChatCreate`
    /// directly above, now covering the page's own draft. `NewChatPage.draft` is hoisted onto
    /// `host.newChatDraft` so it survives `ShellRootView`'s `.maximized` teardown of `detail` (see
    /// `testNewChatPageDraftIsNotViewLocalState` in `AppShellTests.swift` for the structural half
    /// of this proof). Hoisting alone would silently overturn `NewChatPage`'s own pre-existing,
    /// documented "drops on navigate-away" ruling as an unintended side effect — this pins that the
    /// clear still fires on a GENUINE arrival at the page, driven by `apply(destination:)` exactly
    /// like `newChatCreate`'s reset, so the pre-existing contract survives unchanged. (The OTHER
    /// half of that contract — that the `.maximized` toggle never reaches `apply` at all, so a
    /// redundant re-navigation or hide/re-summon never clears it — is a structural fact of
    /// `ShellRootView`/`PanelPresentation`'s wiring, verified by reading `ShellPanel.swift`'s and
    /// `ShellSidebar.swift`'s `toggleMaximized`/`toggleVisible` call sites: both mutate only the
    /// panel's own local `@State`, never `nav`/`host`. There is no view-mounting harness in this
    /// suite to drive that half as its own XCTest — see `CardWiringTests`' own doc for the same
    /// posture on mounting `PendingCardsView`.)
    func testApplyNewChatClearsAStaleDraftOnEveryEntry() async {
        let (host, factory) = makeHost()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")

        host.apply(destination: .newChat)
        host.newChatDraft = "half-typed idea"

        host.apply(destination: .mode(.chat)) // leave the page — a genuine navigate-away
        host.apply(destination: .newChat)     // …and a genuine fresh entry
        XCTAssertEqual(host.newChatDraft, "",
                       "a stale draft from a previous visit clears on re-entry, exactly like newChatCreate")
    }

    // MARK: - panel-shell T8: the tab strip's mutation RPCs — bare, on the ATTACHED session

    /// The strip's three controls (`+`/click/`×`) each fire exactly one bare RPC on the management
    /// connection, targeted at the session the shell is currently ATTACHED to. What actually bites
    /// if wrong — and what this pins — is the WIRE SHAPE: the method names, the `sessionId`/
    /// `tabId` params, and above all that `openPanelTab` sends no `tabId` key at all (the daemon
    /// mints it, methods.ts's own doc on `PanelOpenTabParams`) — a caller-supplied `tabId` there
    /// would be exactly the bug that makes an agent-opened and a user-opened tab distinguishable
    /// downstream.
    ///
    /// Review fix (round 1): this test does NOT prove "applies nothing locally", and its name no
    /// longer claims to — `ShellSessionHost` holds no `PanelStore` reference at all, so there is
    /// structurally nothing here for a result to mutate; that guarantee comes from the type
    /// signatures (see `ShellSessionHost`'s own panel-tab-strip section), not from anything this
    /// test could observe failing.
    func testPanelTabControlsFireBareRPCsOnTheAttachedSession() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        XCTAssertEqual(host.attachedSessionId, "S1")

        host.openPanelTab(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("the '+' must fire panel.openTab: \(mgmt.methods)")
        }
        let openParams = open["params"] as? [String: Any]
        XCTAssertEqual(openParams?["sessionId"] as? String, "S1")
        XCTAssertEqual(openParams?["kind"] as? String, "web")
        XCTAssertNil(openParams?["tabId"], "the daemon mints tabId — the caller must never send one")

        host.activatePanelTab("t1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("a tab click must fire panel.activateTab: \(mgmt.methods)")
        }
        let activateParams = activate["params"] as? [String: Any]
        XCTAssertEqual(activateParams?["sessionId"] as? String, "S1")
        XCTAssertEqual(activateParams?["tabId"] as? String, "t1")

        host.closePanelTab("t1")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        guard let close = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.closeTab" }) else {
            return XCTFail("a tab's × must fire panel.closeTab: \(mgmt.methods)")
        }
        let closeParams = close["params"] as? [String: Any]
        XCTAssertEqual(closeParams?["sessionId"] as? String, "S1")
        XCTAssertEqual(closeParams?["tabId"] as? String, "t1")

        // Feed every result back — a smoke check that receiving them doesn't crash or disturb the
        // attachment, not a mutation pin: there is nothing on this host that COULD react to them.
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"minted-1"}}"#)
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(activate["id"] as! Int),"result":{"ok":true}}"#)
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(close["id"] as! Int),"result":{"ok":true}}"#)
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(host.attachedSessionId, "S1", "receiving the responses doesn't disturb the attachment")
    }

    /// No attached session (nothing selected, or the shell is hidden) → `activatePanelTab`/
    /// `closePanelTab` are still silent no-ops — never a crash, and never a call on the wire.
    /// Unlike `openPanelTab` (panel-shell T12: auto-creates a session and opens a tab in it — see
    /// the tests just above), there is no session-less "activate the nth tab" or "close this
    /// tabId" to perform: both verbs act on a tab that would have to already exist, and with no
    /// attached session there is no tab list to look one up in. This is NOT the same test the
    /// pre-T12 code had — `openPanelTab` deliberately dropped out of this assertion; folding it
    /// back in would silently start testing "hasn't gotten far enough within 150ms" instead of
    /// "no-op", since the auto-create path leaves an unanswered `session.create` in flight rather
    /// than returning early.
    func testActivateAndCloseTabControlsAreNoOpsWithNoAttachedSession() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.activatePanelTab("t1")
        host.closePanelTab("t1")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(mgmt.methods.filter { $0.hasPrefix("panel.") }.isEmpty,
                      "no session attached — activate/close should still fire nothing: \(mgmt.methods)")
    }

    /// panel-cef Task 6b review (Minor 6): **`openPanelTab(url:)` is a panel-url PRODUCER, and it
    /// runs through `PanelURLPolicy` like every other one.**
    ///
    /// Every call site passes `nil` today, so nothing was broken — but "every call site happens to
    /// pass nil" is a coincidence, not an invariant, and this repo has a recorded incident
    /// (`turn_completed.contextTokens`) of a second producer emitting past an ungated consumer for
    /// exactly that reason. The daemon refuses too (`PanelOpenTabParams`'s `superRefine`); this is
    /// the producer-side half, not a replacement.
    ///
    /// All three directions, because a refuse-only assertion cannot tell a policy from a broken
    /// method: `.web` + hostile url → nothing on the wire; `.web` + https → the RPC, carrying the
    /// url; `.document` + a local path → the RPC, because the guard is KIND-CONDITIONAL exactly
    /// like the daemon's (the spec's LibreOffice/Monaco slots legitimately carry a path).
    func testOpenPanelTabRunsItsURLThroughTheSchemePolicy() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        XCTAssertEqual(host.attachedSessionId, "S1")

        host.openPanelTab(kind: .web, url: "javascript:alert(document.cookie)")
        host.openPanelTab(kind: .web, url: "file:///Users/someone/.ssh/id_rsa")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(mgmt.methods.filter { $0 == "panel.openTab" }.isEmpty,
                      "a url outside the allowlist must never reach the wire: \(mgmt.methods)")

        host.openPanelTab(kind: .web, url: "https://example.com/docs")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let allowed = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("an allowed url must still open a tab: \(mgmt.methods)")
        }
        XCTAssertEqual((allowed["params"] as? [String: Any])?["url"] as? String, "https://example.com/docs")

        // Kind-conditional: a non-web tab's local path is NOT held to the web allowlist.
        host.openPanelTab(kind: .document, url: "file:///Users/someone/report.docx")
        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.openTab" }.count == 2 }
        guard let doc = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }),
              (doc["params"] as? [String: Any])?["kind"] as? String == "document" else {
            return XCTFail("a .document tab's path must not be refused by the WEB allowlist: \(mgmt.methods)")
        }
        XCTAssertEqual((doc["params"] as? [String: Any])?["url"] as? String,
                       "file:///Users/someone/report.docx")
    }

    /// **A popup opens a panel tab in the session ITS OWN browser belongs to** — the whole Swift
    /// half of the popup route, from the model CEF drives down to the bytes on the socket.
    ///
    /// The three things it pins, each of which is a way the route can be wrong while compiling and
    /// while leaving every other test green:
    ///
    ///  1. **It happens at all.** `openPopupAsTab` must reach `panel.openTab` — the daemon-minted
    ///     door — rather than doing nothing (the pre-change behaviour: CEF cancelled the popup and
    ///     that was the end of it) or opening a browser some other way.
    ///  2. **The SESSION is the browser's, not whatever the shell is attached to.** The host here is
    ///     attached to `S2` while the popup's tab belongs to `S1`, so an implementation that read
    ///     `attachedSessionId` — the natural thing to write, and what every other caller of
    ///     `openPanelTab` gets — files the tab in the wrong session and this reds. That divergence
    ///     is exactly what the assertion is for: with both ids equal it would pass either way.
    ///  3. **The url is the PAGE's, so the policy runs on it.** A `javascript:` popup must reach
    ///     nothing at all; the allowed one immediately after is what stops that assertion passing
    ///     for a route that is simply broken.
    ///
    /// **What it does not cover, stated rather than implied:** that `OnBeforePopup` actually calls
    /// the observer, and that `PanelCEFView.makeNSView` actually registers one. CEF never starts
    /// under XCTest (`CEFRuntimeTests.testTheRuntimeRefusesToStartCEFUnderXCTest` pins that refusal)
    /// and `makeNSView` needs a SwiftUI `Context` no test can build, so the C++→model hop is
    /// unreachable from this host. `CEFRuntimeTests` covers what is reachable of that half — the
    /// cancel VALUE, and the routing block's presence in the built product — and is equally explicit
    /// about its own limits. This is the same posture `PanelWebTabModel.apply(url:title:…)` was
    /// split out for: test the entry point CEF drives, not a parallel one.
    func testAPopupOpensAPanelTabInTheSessionItsOwnBrowserBelongsTo() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        PanelWebTabModels.removeAllForTesting()
        defer { PanelWebTabModels.removeAllForTesting() }

        host.setShellVisible(true)
        host.select("S2")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S2")
        XCTAssertEqual(host.attachedSessionId, "S2")

        // The browser the popup comes from belongs to S1 — deliberately NOT the attached session.
        let model = PanelWebTabModels.model(
            for: PanelTab(tabId: "t1", kind: .web, url: "https://example.com", title: nil),
            host: host, sessionId: "S1")

        model.openPopupAsTab(url: "javascript:alert(document.cookie)")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(mgmt.methods.filter { $0 == "panel.openTab" }.isEmpty,
                      "a popup url outside the allowlist must never reach the wire — the URL is "
                          + "chosen by the PAGE, which is the untrusted input PanelURLPolicy exists "
                          + "for: \(mgmt.methods)")

        model.openPopupAsTab(url: "https://example.com/popup")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("a gestured popup must open a panel tab, not vanish: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1",
                       "the popup's tab belongs to the session ITS BROWSER is in (S1), not to "
                           + "whatever the shell is attached to (S2) — reading attachedSessionId "
                           + "here would put a real, visible tab in a session the user never "
                           + "browsed in")
        XCTAssertEqual(params?["kind"] as? String, "web")
        XCTAssertEqual(params?["url"] as? String, "https://example.com/popup",
                       "the popup's own destination is what the tab opens at")
        XCTAssertNil(params?["tabId"], "the daemon mints tabId — the caller must never send one")
    }

    // MARK: - panel-shell T12 (bug found at the live gate, 2026-08-08): "+" with no attached
    // session used to be exactly the silent no-op the test just above pins — `openPanelTab`'s own
    // `guard let sessionId = attachedSessionId else { return }` returned before firing anything.
    // User ruling: auto-create — the button always works. These two tests are written and run
    // against the OLD (pre-fix) code first to capture real RED, then the fix lands and the test
    // just above is split (activate/close keep their no-op contract; openPanelTab does not).

    /// Test 1 (the task's own requirement, literally): "+" with no attached session results in a
    /// session AND a tab. Uses the EXISTING call shape (no trailing closure) so RED against the
    /// pre-fix code is BEHAVIORAL — a timeout waiting for a `session.create` that never arrives,
    /// asserted via the file's own `guard let ... else { XCTFail }` idiom — never a compile error.
    ///
    /// The create shape mirrors `sendFirstChatMessage`'s own exactly
    /// (`testFirstSendCreatesOnceThenAttachesThenSendsInWireOrder` above): scope global,
    /// approvalPolicy auto, mode chat, cwd ABSENT. This reuses the app's ONE
    /// create-a-session-with-nothing-else-required mechanism rather than inventing a second one —
    /// `mode: "code"` would need a cwd (or the "no folder" default), dragging
    /// `WorkingDirPickerSheetController` into a `+` click and breaking "the button always works".
    func testOpenPanelTabWithNoAttachedSessionStillCreatesASessionAndOpensATab() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        XCTAssertNil(host.attachedSessionId, "nothing attached yet — the exact bug's precondition")

        host.openPanelTab(kind: .web)

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("'+' with no attached session must still create one: \(mgmt.methods)")
        }
        let params = create["params"] as? [String: Any]
        XCTAssertEqual(params?["mode"] as? String, "chat")
        XCTAssertEqual(params?["scope"] as? String, "global")
        XCTAssertEqual(params?["approvalPolicy"] as? String, "auto")
        XCTAssertNil(params?["cwd"], "no cwd — the sendFirstChatMessage shape, reused verbatim")

        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_panel_new","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("the freshly created session must have its tab opened: \(mgmt.methods)")
        }
        let openParams = open["params"] as? [String: Any]
        XCTAssertEqual(openParams?["sessionId"] as? String, "s_panel_new", "the tab opens in the session JUST created")
        XCTAssertEqual(openParams?["kind"] as? String, "web")
        XCTAssertNil(openParams?["tabId"], "the daemon mints tabId — the caller must never send one, even on this path")
    }

    /// Test 1's ordering half, plus the full round trip through attach and `PanelStore`. Uses the
    /// NEW `onSessionCreated` callback, so RED against the pre-fix code is a COMPILE error
    /// (`openPanelTab` has no such parameter yet) — accepted, per this plan's own convention
    /// elsewhere (Task 1 Step 2: "cannot find 'panelMaxWidth' in scope").
    ///
    /// Deliberately deviates from the bug report's literal word order ("create a session, attach to
    /// it, then open the tab in it"): the fix opens the tab and awaits its ACK **before** firing
    /// `onSessionCreated` (which drives the navigate → attach chain). `panel.openTab` is a bare
    /// `managementClient` RPC that never requires attachment (this file's own T8/T9 doc), so
    /// nothing requires waiting for the harness; doing it this way instead GUARANTEES the
    /// `panel.list` snapshot `attachFresh` fires next (Task 9) already reflects the tab, because
    /// its request cannot be sent on the SAME `managementClient` connection until the openTab
    /// response has already been received. Attaching first and racing `panel.openTab` against
    /// `attachFresh`'s own `panel.list` fetch (a SEPARATE in-flight call on the same connection)
    /// would leave a narrow window where the very first snapshot misses the tab — this ordering
    /// closes that window by construction instead of by luck.
    func testOpenPanelTabWithNoAttachedSessionOpensTheTabBeforeAttachingThenNavigates() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)

        var navigatedTo: [String] = []
        host.openPanelTab(kind: .web) { sessionId in
            navigatedTo.append(sessionId)
            host.apply(destination: .session(sessionId)) // the host's own navigate seam (line ~874's precedent)
        }

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_panel_new2","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("must open the tab: \(mgmt.methods)")
        }

        // The ordering pin: nothing navigates or attaches while the tab-open call is still in flight.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(navigatedTo.isEmpty, "must not navigate before the tab-open ack lands")
        XCTAssertTrue(factory.made.isEmpty, "must not attach before the tab-open ack lands")

        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"minted-1"}}"#)

        await feedWaitUntil { !navigatedTo.isEmpty }
        XCTAssertEqual(navigatedTo, ["s_panel_new2"], "navigates onto the created session exactly once")
        XCTAssertEqual(host.attachedSessionId, "s_panel_new2", "the button's whole promise: a session ends up attached")

        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "s_panel_new2")

        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let list = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("attach must fetch panel.list, same as any other attach (Task 9)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"tabs":[{"tabId":"minted-1","kind":"web","url":null,"title":null}],"activeTabId":"minted-1"}}"#)
        await feedWaitUntil { !host.panelStore.tabs.isEmpty }
        XCTAssertEqual(host.panelStore.tabs.map(\.tabId), ["minted-1"], "the panel actually shows the tab — the whole point of the bug report")
    }

    /// panel-shell T12 follow-up (advisor review, post-commit self-check): the SAME double-send race
    /// `sendFirstChatMessage`'s own in-flight guard closes
    /// (`testDoubleSendWhileCreateInFlightYieldsExactlyOneCreate` above) exists on this path too, and
    /// its cost is HIGHER here. `attachedSessionId` only flips once the FIRST create's ack completes
    /// the navigate → attach chain (`onSessionCreated` → `nav.navigate` → `apply` → `select` →
    /// `attachFresh`), so two rapid "+" clicks with nothing attached would each see
    /// `attachedSessionId == nil` and mint their OWN session, before this fix. Requirement 2 (this
    /// same task) makes the orphaned extra one worse than it would have been pre-T12: it carries a
    /// `panel_tab_opened` event, so `emptySessionIds` never reaps it — permanent sidebar litter from
    /// one double-click, not the pre-existing "gone in 10 minutes" cost. RED against the code before
    /// this follow-up: two `session.create` calls.
    func testDoubleOpenPanelTabWhileAutoCreateInFlightYieldsExactlyOneCreate() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)

        host.openPanelTab(kind: .web)
        host.openPanelTab(kind: .web) // the race: the first auto-create is still in flight

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1,
                       "a second '+' while the first auto-create is in flight must NOT mint a second session")

        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create at least once: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_panel_once","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1, "still exactly one after the response")
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 1, "and exactly one tab, not two")
    }

    // MARK: - panel-shell T15: "+" on the new-chat page BINDS rather than navigating
    //
    // Today (pre-fix) `ShellPanel`'s "+" always calls `openPanelTab(kind:onSessionCreated:)`, whose
    // completion navigates — on the new-chat page that yanks the user onto the fresh session and
    // strands `newChatDraft`. `openPanelTabForNewChatPage` does not exist on the pre-fix host at
    // all, so every test below is a COMPILE-ERROR RED against unmodified code — the same accepted
    // convention Task 12's own tests use (Task 1 Step 2: "cannot find … in scope").

    /// Requirement 1 + 2, the task's own headline test: "+" binds — creates the session and opens
    /// the tab, but never attaches — and the FIRST SEND reuses that exact session (one create,
    /// ever) rather than minting a second and orphaning the tab-holding original.
    func testBindThenSendProducesExactlyOneSessionAndSendsIntoTheTabsSession() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web)

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("'+' must still create a session: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_bound","trusted":true}}"#)

        // The bind's own tab-open — `newChatBoundSessionId` is set only AFTER this acks.
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("'+' must open the tab: \(mgmt.methods)")
        }
        XCTAssertEqual((open["params"] as? [String: Any])?["sessionId"] as? String, "s_bound")
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)

        // The bind's own panel-priming panel.list (no live pump while unattached — see
        // `openPanelTabForNewChatPage`'s doc) — this is the FIRST of two panel.list calls this
        // test will see; the second comes from the send's existence-verify below.
        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let primeList = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("binding must prime the panel via panel.list: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(primeList["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":null,"title":null}],"activeTabId":"t1"}}"#)
        await feedWaitUntil { !host.panelStore.tabs.isEmpty }
        XCTAssertEqual(host.panelStore.tabs.map(\.tabId), ["t1"], "the panel shows the tab without ever attaching")
        XCTAssertNil(host.attachedSessionId, "binding must NOT attach — the whole point of the task")

        var navigatedTo: [String] = []
        host.sendFirstChatMessage("hello there") { id in
            navigatedTo.append(id)
            host.apply(destination: .session(id))
        }

        // Send's own existence-verify panel.list — the SECOND one.
        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.list" }.count == 2 }
        guard let verifyList = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "panel.list" }).last else {
            return XCTFail("send must verify the bound session still exists: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(verifyList["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":null,"title":null}],"activeTabId":"t1"}}"#)

        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1,
                       "send must reuse the bound session, not mint a second one")

        await feedWaitUntil { !navigatedTo.isEmpty }
        XCTAssertEqual(navigatedTo, ["s_bound"], "navigates onto the SAME session the tab is in")

        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_bound")
        await feedWaitUntil { t.methods.contains("session.send") }
        guard let send = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.send" }) else {
            return XCTFail("must send into the bound session: \(t.methods)")
        }
        XCTAssertEqual((send["params"] as? [String: Any])?["sessionId"] as? String, "s_bound",
                       "the message lands in the session the tab is in")
        XCTAssertEqual((send["params"] as? [String: Any])?["text"] as? String, "hello there")
    }

    /// Requirement 3: a SECOND "+" while still bound (the sequential case — Task 12's
    /// `panelAutoCreateInFlight` only covers concurrent double-clicks during one round trip) opens
    /// a tab in the SAME session, never a second create.
    func testSecondBindWhileBoundOpensATabInTheSameSessionNotASecondCreate() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_bound2","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open1 = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("must open the first tab: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open1["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)

        // `newChatBoundSessionId` is set synchronously right after the openTab ack, immediately
        // before the priming `panel.list` is sent — waiting for that call to be SENT (not
        // necessarily answered) is enough to know the second "+" will see the binding.
        await feedWaitUntil { mgmt.methods.contains("panel.list") }

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.openTab" }.count == 2 }

        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1,
                       "a second '+' while bound must NOT mint a second session")
        let opens = mgmt.sent.map({ feedLineJSON($0) }).filter { $0["method"] as? String == "panel.openTab" }
        XCTAssertEqual(opens.count, 2)
        for open in opens {
            XCTAssertEqual((open["params"] as? [String: Any])?["sessionId"] as? String, "s_bound2",
                           "both opens target the SAME bound session")
        }
        XCTAssertNil(host.attachedSessionId, "still not attached — binding never navigates")
    }

    /// Requirement 4, the acceptance case: the bound session was deleted underneath the page (the
    /// cleaner/reaper, per Task 14/16's own semantics) — send must not throw the message away. This
    /// pins the "re-create" half of the task's offered pair ("re-create, or attach while bound").
    func testSendWithBoundSessionDeletedUnderneathDoesNotLoseTheMessage() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_gone","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("must open the tab: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)

        // The bind's own priming panel.list — answered so it can't be confused with the verify call.
        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let primeList = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("bind must prime the panel: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(primeList["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":null,"title":null}],"activeTabId":"t1"}}"#)
        await feedWaitUntil { !host.panelStore.tabs.isEmpty }

        // Simulate the cleaner/reaper having deleted "s_gone" in the background — send now.
        var navigatedTo: [String] = []
        host.sendFirstChatMessage("don't lose me") { id in
            navigatedTo.append(id)
            host.apply(destination: .session(id))
        }

        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.list" }.count == 2 }
        guard let verifyList = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "panel.list" }).last else {
            return XCTFail("send must verify the bound session still exists: \(mgmt.methods)")
        }
        // The daemon's own NOT_FOUND mapping for an unknown/deleted session (server.ts's panel.list
        // handler — the same ERR.NOT_FOUND every panel RPC throws for a vanished sessionId).
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(verifyList["id"] as! Int),"error":{"code":-32004,"message":"unknown session: s_gone"}}"#)

        // Falls back to a fresh create — the message must still land somewhere.
        await feedWaitUntil { mgmt.methods.filter { $0 == "session.create" }.count == 2 }
        guard let create2 = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "session.create" }).last else {
            return XCTFail("must fall back to a fresh create when the bound session is gone: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create2["id"] as! Int),"result":{"sessionId":"s_fresh","trusted":true}}"#)

        await feedWaitUntil { !navigatedTo.isEmpty }
        XCTAssertEqual(navigatedTo, ["s_fresh"], "falls back to the freshly created session")

        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_fresh")
        await feedWaitUntil { t.methods.contains("session.send") }
        guard let send = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.send" }) else {
            return XCTFail("the message must still be sent, into the fresh session: \(t.methods)")
        }
        XCTAssertEqual((send["params"] as? [String: Any])?["text"] as? String, "don't lose me",
                       "the message is never thrown away")
    }

    /// Requirement 4's OTHER half: "+" itself, not just send, must survive the bound session having
    /// vanished — a second "+" against a gone session must not silently dead-end (the exact "click
    /// that does nothing with no explanation" class Task 12 existed to kill). Falls back to an
    /// ordinary auto-create, as if this were the page's first "+".
    func testSecondBindWithTheBoundSessionGoneFallsBackToANewCreateRatherThanADeadClick() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_will_vanish","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open1 = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("must open the first tab: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open1["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.list") } // the bind has committed

        // Second "+" — but the bound session is gone by the time this lands.
        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.openTab" }.count == 2 }
        guard let open2 = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "panel.openTab" }).last else {
            return XCTFail("must attempt the second open: \(mgmt.methods)")
        }
        XCTAssertEqual((open2["params"] as? [String: Any])?["sessionId"] as? String, "s_will_vanish")
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open2["id"] as! Int),"error":{"code":-32004,"message":"unknown session: s_will_vanish"}}"#)

        // Must fall back to a fresh create rather than dead-ending.
        await feedWaitUntil { mgmt.methods.filter { $0 == "session.create" }.count == 2 }
        guard let create2 = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "session.create" }).last else {
            return XCTFail("a gone bound session must fall back to auto-create, not dead-end: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create2["id"] as! Int),"result":{"sessionId":"s_replacement","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.openTab" }.count == 3 }
        let opens = mgmt.sent.map({ feedLineJSON($0) }).filter { $0["method"] as? String == "panel.openTab" }
        XCTAssertEqual((opens[2]["params"] as? [String: Any])?["sessionId"] as? String, "s_replacement",
                       "the replacement tab opens in the freshly created session")
    }

    /// Requirement 4 / mutation guard: `closePanelTab` must reach the BOUND session while nothing
    /// is attached — today it guards on `attachedSessionId` alone, so the "×" no-ops on an
    /// un-navigated new-chat page (the exact dead path the task names). This is what makes closing
    /// the last tab of a bound session live — the path Task 16's reaper eventually acts on.
    func testClosePanelTabTargetsTheBoundSessionWhileUnattached() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_close_bound","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("must open the tab: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.list") } // the bind has committed

        XCTAssertNil(host.attachedSessionId, "the precondition this test exists for: bound, not attached")
        host.closePanelTab("t1")

        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        guard let close = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.closeTab" }) else {
            return XCTFail("the × must fire panel.closeTab against the BOUND session, not no-op: \(mgmt.methods)")
        }
        XCTAssertEqual((close["params"] as? [String: Any])?["sessionId"] as? String, "s_close_bound")
        XCTAssertEqual((close["params"] as? [String: Any])?["tabId"] as? String, "t1")
    }

    /// Mutation guard for the OTHER two mechanisms the three headline tests never exercise on their
    /// own: (a) leaving `.newChat` for a bound-but-unattached session hides its tab from the panel
    /// (the disclosed decision — see `apply(destination:)`'s own T15 doc comment for the "why"),
    /// and (b) a fresh `.newChat` entry starts clean, so a stale binding from an abandoned visit is
    /// never silently reused by a later "+".
    ///
    /// Whole-branch review Minor 4: also pins that `newChatBoundSessionId` ITSELF clears
    /// IMMEDIATELY on leaving to ANY unattached destination — not only, eventually, on the next
    /// `.newChat` entry. Pre-fix, only `panelStore.detach()` ran on the `.mode(.chat)` hop
    /// (asserted just below); the binding stayed live-but-stale until whatever LATER touched
    /// `.newChat` cleared it, which the rest of this test's own flow couldn't distinguish from
    /// "cleared immediately" — both produce the same eventual outcome after returning to
    /// `.newChat`. The direct assertion right after the `.mode(.chat)` hop is what closes that gap:
    /// it fails pre-fix (the binding is still `"s_stale_bound"` there) even though every assertion
    /// later in this same test already passed.
    func testApplyNewChatClearsAStaleBindingAndThePanelDisplayOnEveryEntry() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_stale_bound","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("must open the tab: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)

        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let list = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("bind must prime the panel: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":null,"title":null}],"activeTabId":"t1"}}"#)
        await feedWaitUntil { !host.panelStore.tabs.isEmpty }

        host.apply(destination: .mode(.chat)) // leave WITHOUT sending — a genuine navigate-away
        XCTAssertEqual(host.panelStore.tabs, [],
                       "leaving an unattached bound session's page hides its tab from the panel (T15's disclosed decision)")
        // Minor 4: the BINDING itself, not just the panel's display, must clear here — immediately,
        // on THIS destination change, not deferred until some later `.newChat` entry. Left live
        // on an unrelated landing, it is inert only because the panel is empty (no tabs to close
        // against it) — a two-mechanism invariant with no test of its own until this line.
        XCTAssertNil(host.newChatBoundSessionId,
                     "the binding must clear on ANY unattached destination change, not only on returning to .newChat")

        host.apply(destination: .newChat) // a genuine fresh entry
        XCTAssertNil(host.attachedSessionId)

        // A fresh "+" here must auto-create again — the abandoned session must never be silently
        // reused by a page instance that never bound to it. Asserting the COUNT directly (not
        // merely that a create exists) matters: this branch's own history includes a test that
        // compared a count against itself — `.last` over "every session.create ever sent" would
        // find the FIRST bind's create and pass vacuously even if the stale binding were reused.
        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.filter { $0 == "session.create" }.count == 2 }
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 2,
                       "a fresh page instance's '+' must create anew, not silently adopt the stale binding: \(mgmt.methods)")
        guard let create2 = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "session.create" }).last else {
            return XCTFail("must create a second time: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create2["id"] as! Int),"result":{"sessionId":"s_fresh_visit","trusted":true}}"#)

        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.openTab" }.count == 2 }
        let openSessionIds = mgmt.sent.map({ feedLineJSON($0) })
            .filter { $0["method"] as? String == "panel.openTab" }
            .compactMap { ($0["params"] as? [String: Any])?["sessionId"] as? String }
        XCTAssertEqual(openSessionIds.count, 2, "one open per bind — this one must NOT reuse s_stale_bound: \(mgmt.methods)")
        XCTAssertEqual(openSessionIds.first, "s_stale_bound")
        XCTAssertEqual(openSessionIds.last, "s_fresh_visit",
                       "the fresh instance's open must target its OWN new session, not the abandoned one")
    }

    // MARK: - panel-shell T15, whole-branch review Important 1: "+" and send raced each other's
    // in-flight create — two independent booleans (`panelAutoCreateInFlight`,
    // `newChatCreate != .creating`) that never cross-checked. Both directions below double-created:
    // the orphan carries an open tab (permanently immune to both auto-delete doors, Task 12 R2 /
    // Task 14) with no binding pointing at it, so it is also unreachable to close from the panel —
    // worse than the pre-existing double-click race Task 12's own `panelAutoCreateInFlight` guard
    // already covers, which only ever produced a session with NO tab attached to it.

    /// Direction A: "+" first — its create is still in flight (unanswered) when Enter fires. Fixed
    /// by `autoCreateForNewChatPage` ALSO setting `newChatCreate = .creating` for its own duration,
    /// so `sendFirstChatMessage`'s EXISTING guard (`newChatCreate != .creating`) blocks the send —
    /// Task 2's own double-Enter ruling, reused rather than a new mechanism, per the review.
    func testPlusThenSendWhileThePlusCreateIsInFlightBlocksTheSendRatherThanDoubleCreating() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web) // "+" — its create is now in flight, unanswered
        var navigatedTo: [String] = []
        host.sendFirstChatMessage("don't double-create me") { id in
            navigatedTo.append(id)
            host.apply(destination: .session(id))
        }

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1,
                       "the send must be BLOCKED while the '+' create is in flight, not mint its own: \(mgmt.methods)")
        XCTAssertTrue(navigatedTo.isEmpty, "the blocked send must never navigate")
        XCTAssertTrue(factory.made.isEmpty, "the blocked send must never attach")

        // The "+"'s own create still resolves normally — the block is on SEND, not on the "+".
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must have created exactly once: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_plus_first","trusted":true}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("must open the tab: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)
        await feedWaitUntil { host.newChatBoundSessionId != nil }
        XCTAssertEqual(host.newChatBoundSessionId, "s_plus_first", "the '+' completes its own bind, unaffected by the blocked send")
    }

    /// Direction B: Enter first — send's create is still in flight (unanswered) when "+" fires.
    /// Fixed by `autoCreateForNewChatPage`'s OWN guard widening to `newChatCreate != .creating` —
    /// the two doors now share ONE gate rather than two independent ones.
    func testSendThenPlusWhileTheSendCreateIsInFlightBlocksThePlusRatherThanDoubleCreating() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        var navigatedTo: [String] = []
        host.sendFirstChatMessage("first") { id in
            navigatedTo.append(id)
            host.apply(destination: .session(id))
        }
        host.openPanelTabForNewChatPage(kind: .web) // "+" — send's create is already in flight

        await feedWaitUntil { mgmt.methods.contains("session.create") }
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1,
                       "the '+' must be BLOCKED while send's create is in flight, not mint its own: \(mgmt.methods)")
        XCTAssertTrue(mgmt.methods.filter { $0 == "panel.openTab" }.isEmpty,
                      "no tab must open for a session that was never created")
        XCTAssertNil(host.newChatBoundSessionId, "the blocked '+' must not bind to anything")

        // Send's own create still resolves normally — the block is on "+", not on SEND.
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must have created exactly once: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_send_first","trusted":true}}"#)
        await feedWaitUntil { !navigatedTo.isEmpty }
        XCTAssertEqual(navigatedTo, ["s_send_first"], "send completes its own create+navigate, unaffected by the blocked '+'")
    }

    // MARK: - panel-shell T9: the live pump + the panel.list fetch on attach/hop

    /// The two landmines Task 7's review carried into this task, proven end to end (not just at the
    /// pure `PanelStore`/`PanelTabsBySession` level — `PanelSessionSwapTests.swift` covers those):
    /// there is exactly ONE pump (this test drives events over the SAME `factory.made[0]` transport
    /// `answerHandshake` already uses — no second subscriber exists to feed instead), and it is
    /// filtered to the ATTACHED session. Mirrors `SessionFeedTests
    /// .testPinnedFeedAppliesOnlyItsSessionsEvents`'s proof for `SessionModel` exactly.
    ///
    /// review round 1, Important 2: merely asserting `panelStore.tabs` doesn't change right after
    /// feeding a foreign event does NOT pin the pump's `e.sessionId == attached` guard
    /// (`ShellSessionHost.swift`) — `PanelStore` has its OWN internal publish gate
    /// (`sessionId == currentSessionId`), which blocks the SAME foreign session from being
    /// *published* regardless of whether the pump's guard exists at all. Deleting the pump's guard
    /// would still pass that assertion: the foreign event would reach `PanelStore.apply`, get
    /// silently cached under its OWN session id, and only surface on a LATER switch to it. Hopping
    /// to the foreign session and checking BEFORE any `panel.list` response can land is what
    /// actually distinguishes "the pump filtered it" from "the store cached it but hasn't shown it
    /// yet" — with the guard present that hop publishes `[]` (never cached); with it deleted, the
    /// leaked event surfaces as `["other"]` the moment the hop's `switchSession` republishes
    /// whatever `PanelTabsBySession` already silently holds for that id.
    func testPanelStoreReceivesOnlyTheAttachedSessionsLiveEvents() async {
        let (host, factory) = makeHost()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { host.attachment?.session.state.status != .disconnected }

        // an event for the ATTACHED session (S1) DOES reach the store
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"panel_tab_opened","seq":1,"sessionId":"S1","ts":0,"tabId":"mine","kind":"web","url":null,"title":null}}"#)
        await feedWaitUntil { !host.panelStore.tabs.isEmpty }
        XCTAssertEqual(host.panelStore.tabs.map(\.tabId), ["mine"])

        // an event for a DIFFERENT session, fed while still attached to S1, must never reach
        // PanelStore.apply AT ALL — proven by hopping to S2 (no `panel.list` response fed; `makeHost`
        // carries no `managementClient`, so `refreshPanelTabs` no-ops and cannot mask the leak) and
        // checking BEFORE anything else could seed it. `switchSession(to:)` republishes whatever
        // `PanelTabsBySession` already holds for "S2" — `[]` only if the leaked event never landed.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"panel_tab_opened","seq":2,"sessionId":"S2","ts":0,"tabId":"other","kind":"web","url":null,"title":null}}"#)
        try? await Task.sleep(nanoseconds: 150_000_000)

        host.select("S2") // a hop: S1 is already attached
        XCTAssertEqual(host.panelStore.tabs, [],
                       "a foreign session's panel event reached PanelStore.apply — the pump's sessionId filter is gone")
    }

    /// `panel.list` fires on attach (the instant-display seed), targeted at the new session, over
    /// the management connection — same as the three mutation RPCs above.
    func testAttachFetchesPanelListForTheNewSessionAndSeedsTheStore() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let list = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("attach must fetch panel.list for the new session: \(mgmt.methods)")
        }
        XCTAssertEqual((list["params"] as? [String: Any])?["sessionId"] as? String, "S1")

        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":"https://a","title":"A"}],"activeTabId":"t1"}}"#)
        await feedWaitUntil { !host.panelStore.tabs.isEmpty }
        XCTAssertEqual(host.panelStore.tabs.map(\.tabId), ["t1"])
        XCTAssertEqual(host.panelStore.activeTabId, "t1")
    }

    /// A hop swaps which session's tabs are shown — never merges — and re-fetches `panel.list` for
    /// the NEW session, on the SAME socket a hop always reuses
    /// (`testHopDetachesThePreviousAndAttachesTheNewWithNoAbort`'s own wire-mechanics precedent).
    func testHopSwapsPanelTabsAndFetchesTheNewSessions() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)

        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")

        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let list1 = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("attach must fetch panel.list: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(list1["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":null,"title":null}],"activeTabId":null}}"#)
        await feedWaitUntil { !host.panelStore.tabs.isEmpty }
        XCTAssertEqual(host.panelStore.tabs.map(\.tabId), ["t1"])

        host.select("S2") // S1 is already attached — this is a hop, not a fresh attach
        XCTAssertEqual(host.panelStore.tabs, [], "switching must show S2 empty INSTANTLY, never S1's leftover tab")

        // The SAME connection, never a second one — but NOT necessarily at a fixed index: the
        // picker catalogue's own `sync.config` fetch (`onConnected`) rides this same transport and
        // can interleave. Find the second `session.attach` by content, the same `.last(where:)`
        // idiom already used for `panel.list` above, rather than assuming a position.
        await feedWaitUntil { t.methods.filter { $0 == "session.attach" }.count == 2 }
        guard let secondAttach = t.sent.map({ feedLineJSON($0) }).last(where: {
            $0["method"] as? String == "session.attach" && ($0["params"] as? [String: Any])?["sessionId"] as? String == "S2"
        }) else {
            return XCTFail("the hop must re-attach on the SAME connection, targeted at S2: \(t.methods)")
        }
        t.feed(#"{"jsonrpc":"2.0","id":\#(secondAttach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)

        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.list" }.count == 2 }
        guard let list2 = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("the hop must fetch panel.list for S2: \(mgmt.methods)")
        }
        XCTAssertEqual((list2["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(list2["id"] as! Int),"result":{"tabs":[{"tabId":"t2","kind":"web","url":null,"title":null}],"activeTabId":null}}"#)
        await feedWaitUntil { host.panelStore.tabs.map(\.tabId) == ["t2"] }
        XCTAssertEqual(host.panelStore.tabs.map(\.tabId), ["t2"], "S2 shows only its own tab, never merged with S1's")
        XCTAssertEqual(factory.made.count, 1, "a hop stays on the SAME socket")
    }
}
