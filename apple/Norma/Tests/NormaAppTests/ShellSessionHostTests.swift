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
}
