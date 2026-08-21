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
        // office live-gate Bug 2 fix-round (caught by the touched-class run, not designed up front):
        // `panelDidReveal` now mints an `officeRuntime(for:)` for EVERY dirs-session reveal, not only
        // the office-specific tests that opt into `officeFactory()`. Left at its class default
        // (`OfficeRuntime(sessionId:driver:)` closing over a REAL, freshly-minted `OfficeHelperSupervisor
        // .production()`), the dozens of unrelated tests in this file that reveal the panel on a dirs
        // row (chat/new-session/dispatch flows with nothing to do with office) would each spawn a REAL
        // `NormaOfficeHelper` subprocess — measured directly: two such tests raced for the same
        // machine-global `com.norma.app.dev` office socket (one "listening", the other "bind() failed:
        // File exists"), and a real LibreOfficeKit instance later crashed with an uncaught
        // `com::sun::star::lang::WrappedTargetRuntimeException`, which is what turned `xcodebuild test`'s
        // overall verdict into `** TEST FAILED **` even though every individual `XCTAssert` in the run
        // still reported 0 failures. `EditorRuntime`'s equivalent default is harmless only because
        // nothing in a bare XCTest process ever calls `CefInitialize` — Office's default driver has no
        // such guard: `OfficeHelperSupervisor.start()` unconditionally `Process().run()`s the real
        // bundled binary the moment ANY runtime's `.ensureHelperReady` effect fires. `OfficeDriverRecorder`
        // (below) defaults its own `state` to `.ready`, so the late-joiner branch in
        // `OfficeRuntime.perform`'s `.ensureHelperReady` case folds synchronously and never even
        // schedules a `startHelper` `Task` — the safe, fully inert default every test gets for free
        // unless it explicitly installs its own recorder via `officeFactory()` afterward (last write
        // wins — `host.makeOfficeRuntime = office.make` below simply overwrites this).
        // NOT `OfficeDriverRecorder()` inline inside the closure: the recorder's OWN driver closures
        // capture it `[unowned self]` (mirroring every other production Driver, which assumes ITS
        // owner outlives it) — a recorder built and read in the same expression has no strong
        // reference anywhere and is deallocated the instant `.driver` returns, so the FIRST actual
        // call (`helperState()`, from `.ensureHelperReady`) reads a dangling `unowned self` and
        // crashes the whole test host with "Attempted to read an unowned reference but object was
        // already destroyed" — measured directly, mid fix-round, on `testRequestCloseTabOnADirtyTab
        // SaveChoiceThatFailsKeepsTheTabOpen`. `officeDefault` here is captured STRONGLY by the
        // `makeOfficeRuntime` closure (default Swift capture semantics for a `let` reference), and
        // that closure is itself retained by `host` for the test's whole lifetime — the same
        // retain-via-`officeDoubles.append` job `officeFactory()` does explicitly, done implicitly
        // here through the closure capture instead.
        let officeDefault = OfficeDriverRecorder()
        host.makeOfficeRuntime = { sessionId, _ in OfficeRuntime(sessionId: sessionId, driver: officeDefault.driver) }
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

    // MARK: - mac-chat-parity T4: the policy readout follows the session, off the wire

    /// The seed's two call sites at once — `attachFresh` (the first select) and `hop` (every later
    /// one). Before T4 this readout had no wire source at all: it sat at `"auto"` until this surface
    /// itself changed it, so a session running `bypass` claimed "Auto" for the whole attachment.
    ///
    /// The final hop is the one that matters most: it lands on a row that reports NOTHING, and the
    /// readout must fall back to its unknown placeholder rather than keep showing the previous
    /// session's `bypass` — a policy label is a claim about the session on screen.
    func testSelectAndHopSeedThePolicyReadoutFromTheDirectoryRow() async {
        let rows = [
            SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code", approvalPolicy: "bypass"),
            SessionSummary(sessionId: "S2", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "code", approvalPolicy: "plan"),
            SessionSummary(sessionId: "S3", title: nil, createdAt: 3, scope: "global", cwd: nil, mode: "code"),
        ]
        let (host, factory) = makeHost(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)

        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicy, "bypass",
                       "attachFresh seeds off the row — no setPolicy has been called")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicyKnown, true)

        host.select("S2")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicy, "plan", "the hop re-derives it")

        host.select("S3")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicy, "auto",
                       "a row that reports nothing resets to the placeholder — never the departed session's plan")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicyKnown, false,
                       "…and says so, so a persistent row can decline to claim anything")
    }

    /// The heal's WIRING, not just its rule (which `PolicyMenuTests` pins on the adapter directly):
    /// `attachFresh` seeds once off whatever the directory holds, so a session attached before its
    /// row loaded — the New-Chat race above, and any caller that attaches ahead of the directory's
    /// refresh — would otherwise show "unknown" for the rest of that attachment, with nothing ever
    /// reading the row again. Same door as `isChatSession`'s own self-heal, same trigger: a plain
    /// `directory.refresh()`, which is exactly what the daemon's broadcast causes in production.
    func testAttachFreshSelfHealsThePolicyWhenTheRowLandsAfterAttach() async {
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
        host.select("s_new") // lister.rows is still empty — the row hasn't loaded yet
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "s_new")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicyKnown, false,
                       "nothing has been learned yet — the placeholder is not an answer")

        lister.rows = [SessionSummary(sessionId: "s_new", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code", approvalPolicy: "bypass")]
        await directory.refresh()

        XCTAssertEqual(host.attachment?.adapter.sessionPolicy, "bypass",
                       "the row landing on an ALREADY-attached session must heal the readout")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicyKnown, true)
    }

    /// mac-chat-parity T4 fix round 1 (Minor 1): the shell's OWN `onSetPolicy` wiring, driven end to
    /// end rather than reimplemented by a stub. `PolicyMenuTests.testSessionPolicyUpdatesOnlyOnSuccess`
    /// pins the SHAPE against a hand-written closure, which stays green if this wirer reverts to a
    /// bare `adapter.sessionPolicy = policy`.
    ///
    /// The harm that reversion causes is narrow but real, and this test's premise: the session was
    /// attached before its row loaded, so the readout is UNKNOWN. A bare assignment moves the value
    /// without certifying it — and `healSessionPolicyIfUnknown`, which is one-way precisely so it
    /// cannot overwrite a known value, would then be free to overwrite this one with whatever a
    /// `session.list` already in flight happens to carry. Adopting marks it known, which is what
    /// closes that window.
    func testASuccessfulSetPolicyThroughTheShellsOwnWiringCertifiesTheValue() async {
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
        host.select("s_1") // no row yet — the readout starts unknown
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_1")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicyKnown, false)

        host.attachment?.adapter.onSetPolicy("bypass")
        XCTAssertEqual(host.attachment?.adapter.policyChangeInFlight, true, "flipped synchronously")
        await waitUntilSent(t, 3)
        let set = feedLineJSON(t.sent[2])
        XCTAssertEqual(set["method"] as? String, "session.setPolicy")
        XCTAssertEqual((set["params"] as? [String: Any])?["sessionId"] as? String, "s_1")
        XCTAssertEqual((set["params"] as? [String: Any])?["policy"] as? String, "bypass")
        t.feed(#"{"jsonrpc":"2.0","id":\#(set["id"] as! Int),"result":{"ok":true}}"#)

        await waitUntilFalse { host.attachment?.adapter.policyChangeInFlight ?? true }
        XCTAssertEqual(host.attachment?.adapter.sessionPolicy, "bypass")
        XCTAssertEqual(host.attachment?.adapter.sessionPolicyKnown, true,
                       "the daemon accepting the write IS an answer — a bare assignment would leave this false and let a heal overwrite it")

        // The heal must now decline to touch it, even handed a row that disagrees — the point of
        // certifying the value rather than merely moving it.
        lister.rows = [SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "code", approvalPolicy: "ask")]
        await directory.refresh()
        XCTAssertEqual(host.attachment?.adapter.sessionPolicy, "bypass",
                       "a list result carrying the pre-change policy must not undo the user's own confirmed change")
    }

    private func waitUntilFalse(_ cond: @MainActor () -> Bool) async {
        let deadline = Date().addingTimeInterval(3)
        while cond() && Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
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
        // office live-gate Bug 2 fix-round: same reason as `makeHost`'s identical line — this is the
        // heavier-used of the two host factories (the panel-tab/file-door/diff-door door tests all
        // need a management client), so it is the bigger share of the real-spawn exposure `panelDidReveal`
        // now carries. See `makeHost`'s own comment for the measured crash this closes.
        // NOT `OfficeDriverRecorder()` inline inside the closure: the recorder's OWN driver closures
        // capture it `[unowned self]` (mirroring every other production Driver, which assumes ITS
        // owner outlives it) — a recorder built and read in the same expression has no strong
        // reference anywhere and is deallocated the instant `.driver` returns, so the FIRST actual
        // call (`helperState()`, from `.ensureHelperReady`) reads a dangling `unowned self` and
        // crashes the whole test host with "Attempted to read an unowned reference but object was
        // already destroyed" — measured directly, mid fix-round, on `testRequestCloseTabOnADirtyTab
        // SaveChoiceThatFailsKeepsTheTabOpen`. `officeDefault` here is captured STRONGLY by the
        // `makeOfficeRuntime` closure (default Swift capture semantics for a `let` reference), and
        // that closure is itself retained by `host` for the test's whole lifetime — the same
        // retain-via-`officeDoubles.append` job `officeFactory()` does explicitly, done implicitly
        // here through the closure capture instead.
        let officeDefault = OfficeDriverRecorder()
        host.makeOfficeRuntime = { sessionId, _ in OfficeRuntime(sessionId: sessionId, driver: officeDefault.driver) }
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
    /// posture on mounting the transcript's interaction cards.)
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

    // MARK: - diff-tabs Task 9: the transcript chip's door

    private func diffRef(_ path: String = "packages/core/src/agent/engine.ts",
                         diffId: String = "d_9f2a") -> FileDiffRef {
        FileDiffRef(path: path, added: 198, removed: 33, diffId: diffId)
    }

    /// The DECISION, on its own: dedupe by `diffId`, else mint titled with the file's last path
    /// component. Pure, so every edge is cheap to state — and the edges are the point, because each
    /// one is a way a duplicate tab or a wrong activation gets shipped.
    func testTheDiffChipDecisionDedupesByDiffIdAndTitlesTheMintWithTheBasename() {
        let ref = diffRef()
        XCTAssertEqual(panelDiffTabAction(tabs: [], ref: ref), .mint(title: "engine.ts"))

        let open = PanelTab(tabId: "t7", kind: .diff, url: nil, title: "engine.ts", diffId: "d_9f2a")
        XCTAssertEqual(panelDiffTabAction(tabs: [open], ref: ref), .activate(tabId: "t7"))

        // A DIFFERENT diff of the same file is a different tab — the file is not the key.
        XCTAssertEqual(panelDiffTabAction(tabs: [open], ref: diffRef(diffId: "d_other")),
                       .mint(title: "engine.ts"))
        // Tabs that carry no diffId (every web tab, every pre-feature tab) never match.
        let web = PanelTab(tabId: "t1", kind: .web, url: "https://a", title: "A")
        XCTAssertEqual(panelDiffTabAction(tabs: [web], ref: ref), .mint(title: "engine.ts"))
        // A relative path titles from its last component, same as an absolute one.
        XCTAssertEqual(panelDiffTabAction(tabs: [], ref: diffRef("src/a.ts")),
                       .mint(title: "a.ts"))
    }

    /// **The first click: one `panel.openTab`, kind `diff`, carrying the `diffId` and the basename —
    /// and the panel is revealed.**
    ///
    /// The wire shape is what bites: a mint that dropped `diffId` would open a tab the renderer
    /// (Task 10) cannot read a patch for, and one that dropped `kind` would open a web tab. The
    /// `tabId` is still the daemon's to mint, exactly as for the strip's "+".
    func testAChipClickMintsADiffTabWithItsDiffIdAndBasenameAndRevealsThePanel() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openDiffTab(diffRef(), sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("a chip click with nothing open must mint a tab: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["kind"] as? String, "diff")
        XCTAssertEqual(params?["diffId"] as? String, "d_9f2a")
        XCTAssertEqual(params?["title"] as? String, "engine.ts")
        XCTAssertNil(params?["tabId"], "the daemon mints tabId — the chip must never send one")
        XCTAssertNil(params?["url"], "a diff tab has no url at all")
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.activateTab" }.count, 0,
                       "nothing was open to activate: \(mgmt.methods)")
        XCTAssertEqual(revealed, 1, "a tab nobody can see is not an opened diff")
    }

    /// **The second click: `panel.activateTab` on the tab the first click opened, and NO second
    /// mint.** The store is seeded the way production seeds it after an attach — through
    /// `applyFetchedSnapshot`, the `panel.list` path — so this exercises the same state the dedupe
    /// actually reads in the field.
    func testASecondChipClickActivatesTheOpenTabInsteadOfMintingASecond() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t7", kind: .diff, url: nil, title: "engine.ts", diffId: "d_9f2a")],
            activeTabId: nil)

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openDiffTab(diffRef(), sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("a chip for an already-open diff must activate it: \(mgmt.methods)")
        }
        let params = activate["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["tabId"] as? String, "t7")
        // The whole point: no duplicate tab. Given a beat, in case a mint were racing behind it.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0,
                       "one frozen tab per edit — a second click must never mint: \(mgmt.methods)")
        XCTAssertEqual(revealed, 1, "an activate behind a hidden panel is a click that does nothing")
    }

    /// The dedupe reads the CHIP'S OWN session, not whatever the shell is attached to. Here the
    /// shell is attached to `S2` while the chip belongs to `S1` — the shape a hop between click and
    /// call produces — so an implementation that read `attachedSessionId` would miss `S1`'s open tab
    /// and mint a duplicate. With both ids equal the assertion would pass either way, which is why
    /// they differ.
    func testTheDedupeReadsTheChipsOwnSessionNotTheAttachedOne() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S2")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S2")
        XCTAssertEqual(host.attachedSessionId, "S2")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t7", kind: .diff, url: nil, title: "engine.ts", diffId: "d_9f2a")],
            activeTabId: nil)

        host.openDiffTab(diffRef(), sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("the chip's own session's tab must be activated: \(mgmt.methods)")
        }
        XCTAssertEqual((activate["params"] as? [String: Any])?["sessionId"] as? String, "S1",
                       "the activate targets the chip's session, not the attached one")
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0)
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
    /// the observer, and that the production create (`BrowserRuntime.create`, which absorbed the
    /// registration from `PanelCEFView.makeNSView` in browser-runtime T3) actually registers one
    /// against a REAL browser. CEF never starts under XCTest
    /// (`CEFRuntimeTests.testTheRuntimeRefusesToStartCEFUnderXCTest` pins that refusal), so the
    /// C++→model hop is unreachable from this host. (That the create registers all three observers
    /// at all, in order, is `BrowserRuntimeTests
    /// .testCreateWiresTheThreeObserversThenSeedsThenCreates`.) `CEFRuntimeTests` covers what is reachable of that half — the
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

    /// b2-agent-browser T3: **a `panel_command` reaches the consumer hook**, including one whose
    /// `sessionId` is not the shell's current attachment.
    ///
    /// Both halves are the pin. The first is the wire itself: without `onPanelCommand` on the pump,
    /// the event decodes into `PanelStore.apply`, is recognised by nothing (its own doc says so) and
    /// vanishes, exactly as it has since Plan A.
    ///
    /// **The second models the HOP RACE, and fix round 1 corrected what this docstring claimed it
    /// modelled.** The daemon never fans a command out to a connection not attached to its session
    /// (`broadcastTransient` → `attachments.get(sessionId)`, `packages/core/src/sessions/hub.ts`), so
    /// "a command for another session arrives" is not a daemon behaviour. What IS real is that
    /// `hop(to:)` flips `attachedSessionId` synchronously while the departing session's in-flight
    /// events are still crossing this socket — an event whose `sessionId` is no longer the attached
    /// one, on an attachment that was genuinely ours when it was dispatched. Feeding a foreign-session
    /// command on the live socket is exactly that shape, and it is the only way to exercise it without
    /// racing a real hop. Move the call inside the guard and the second assertion reds.
    func testPanelCommandsReachTheConsumerHookIncludingForAnotherSession() async {
        let (host, factory) = makeHost()
        defer { host.deselect() }
        var seen: [(sessionId: String, commandId: String, action: String)] = []
        host.onPanelCommand = { seen.append(($0.sessionId, $0.commandId, $0.action)) }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")
        await feedWaitUntil { host.attachment?.session.state.status != .disconnected }

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"panel_command","seq":1,"sessionId":"S1","ts":0,"commandId":"c1","tabId":"t1","action":"read","deadlineMs":15000}}"#)
        await feedWaitUntil { !seen.isEmpty }
        XCTAssertEqual(seen.map(\.commandId), ["c1"])
        XCTAssertEqual(seen.first?.action, "read")

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"panel_command","seq":2,"sessionId":"S2","ts":0,"commandId":"c2","tabId":"t9","action":"back","deadlineMs":15000}}"#)
        await feedWaitUntil { seen.count > 1 }
        XCTAssertEqual(seen.map(\.commandId), ["c1", "c2"],
                       "a command whose sessionId is not the shell's current attachment was dropped "
                           + "— that is the hop race (attachedSessionId flips synchronously while "
                           + "the departing session's in-flight commands are still arriving), and "
                           + "their tabs' browsers are still live in this runtime")
        XCTAssertEqual(seen.last?.sessionId, "S2")
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

    // MARK: - mac-chat-parity Task 7 (spec §5): the pre-session model/effort, held and STAMPED
    //
    // The user's ruling is hold-and-stamp, not create-then-set: the second leaves a window in which
    // a turn fired immediately after the create resolves at the GLOBAL effort, and the new-chat page
    // fires a turn the instant the session exists. So the choice rides `session.create`'s own params
    // — and, on the bound-session REUSE branch (which creates nothing), rides `session.setModel` and
    // `session.setEffort` before the send.

    /// Binds the page to `sessionId` through the "+" door, answering its three round trips. Returns
    /// the create's own params so a caller can assert what (if anything) that create stamped.
    @discardableResult
    private func bindViaPlus(_ host: ShellSessionHost, _ mgmt: ShellScriptedTransport,
                             sessionId: String) async -> [String: Any]? {
        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            XCTFail("'+' must create: \(mgmt.methods)")
            return nil
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"\#(sessionId)","trusted":true}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            XCTFail("'+' must open the tab: \(mgmt.methods)")
            return nil
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let prime = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            XCTFail("the bind must prime the panel: \(mgmt.methods)")
            return nil
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(prime["id"] as! Int),"result":{"tabs":[],"activeTabId":null}}"#)
        await feedWaitUntil { host.newChatBoundSessionId == sessionId }
        return create["params"] as? [String: Any]
    }

    /// Answers the reuse branch's existence-verify `panel.list`, so the send can proceed.
    private func answerReuseVerify(_ mgmt: ShellScriptedTransport) async {
        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.list" }.count == 2 }
        guard let verify = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "panel.list" }).last else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(verify["id"] as! Int),"result":{"tabs":[],"activeTabId":null}}"#)
    }

    /// Feeds a catalogue onto the page's chip through its real door (`onOpen` → `sync.config`).
    private func feedNewChatCatalogue(_ host: ShellSessionHost, _ mgmt: ShellScriptedTransport,
                                      models: String) async {
        host.newChatModelControl.onOpen()
        await feedWaitUntil { mgmt.methods.contains("sync.config") }
        guard let cfg = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "sync.config" }) else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(cfg["id"] as! Int),"result":{"provider":"codex-oauth","exaKey":null,"dangerousDomains":[],"defaultModel":"srv-a","models":\#(models),"defaultEffort":"high","clientEfforts":["ultra"]}}"#)
        await feedWaitUntil { !host.newChatCatalogue.models.isEmpty }
    }

    /// The headline pin: a choice held on the page reaches the create that mints its session.
    func testTheHeldModelAndEffortRideTheFirstSendsCreate() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        host.setNewChatModel("srv-b")
        host.setNewChatEffort("high")

        host.sendFirstChatMessage("hello") { _ in }
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("the first send must still ride session.create: \(mgmt.methods)")
        }
        let params = create["params"] as? [String: Any]
        XCTAssertEqual(params?["model"] as? String, "srv-b", "the held model is STAMPED, never set afterwards")
        XCTAssertEqual(params?["effort"] as? String, "high")
        XCTAssertEqual(params?["mode"] as? String, "chat", "…on the same create, unchanged in every other way")
        XCTAssertNil(params?["cwd"])
    }

    /// …and an UNPICKED page sends exactly the create it always sent — both keys ABSENT, not null.
    /// (`session.create`'s zod reads absence as "no override"; a null is a value it refuses.)
    func testAnUnpickedPageSendsTheCreateExactlyAsBefore() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.sendFirstChatMessage("hello") { _ in }
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        let params = create["params"] as? [String: Any]
        XCTAssertNil(params?["model"], "nothing picked ⇒ the key is absent")
        XCTAssertNil(params?["effort"])
    }

    /// The page's OTHER birth door (panel-shell T15's "+"): it mints the page's session too, so it
    /// stamps the held choice for the same reason the send's create does.
    func testThePlusDoorStampsTheHeldChoiceOnTheSessionItBinds() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        host.setNewChatModel("srv-b")
        host.setNewChatEffort("max")

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("'+' must still create: \(mgmt.methods)")
        }
        let params = create["params"] as? [String: Any]
        XCTAssertEqual(params?["model"] as? String, "srv-b")
        XCTAssertEqual(params?["effort"] as? String, "max")
    }

    /// **The reuse branch — the trap the spec named.** A "+" bound the page to a session BEFORE the
    /// user picked, so there is no create left to stamp: the send applies the held choice with
    /// `session.setModel` then `session.setEffort`, and **awaits both before the send**.
    ///
    /// The ORDER is load-bearing, not cosmetic: `session.setEffort` validates against the session's
    /// CURRENT model (`assertEffortSelectable`, `ipc/server.ts:476-489`), so effort-first would
    /// validate a perfectly legal held pair against the daemon's default model and can throw.
    ///
    /// Sequencing is pinned as sequencing (not as end-state): while each set is unanswered, the flow
    /// must not have moved on. "No turn has fired on a session minted for a panel tab" is true of
    /// today's flows but is not structural — that session is real, listed, and reachable by another
    /// client.
    func testTheBoundSessionsReuseAppliesTheHeldChoiceBeforeTheSend() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        // "+" binds a session, before any pick.
        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("'+' must create: \(mgmt.methods)")
        }
        XCTAssertNil((create["params"] as? [String: Any])?["model"], "nothing was picked when '+' fired")
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_bound","trusted":true}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("'+' must open the tab: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let primeList = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else {
            return XCTFail("the bind must prime the panel: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(primeList["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":null,"title":null}],"activeTabId":"t1"}}"#)
        await feedWaitUntil { host.newChatBoundSessionId == "s_bound" }

        // NOW the user picks, and sends.
        host.setNewChatModel("srv-b")
        host.setNewChatEffort("high")
        host.sendFirstChatMessage("hello there") { id in host.apply(destination: .session(id)) }

        // The existence-verify the reuse branch already did.
        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.list" }.count == 2 }
        guard let verify = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "panel.list" }).last else {
            return XCTFail("send must verify the bound session: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(verify["id"] as! Int),"result":{"tabs":[{"tabId":"t1","kind":"web","url":null,"title":null}],"activeTabId":"t1"}}"#)

        // setModel FIRST — and while it is unanswered, nothing else has happened.
        await feedWaitUntil { mgmt.methods.contains("session.setModel") }
        guard let setModel = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setModel" }) else {
            return XCTFail("the held model must be applied to the reused session: \(mgmt.methods)")
        }
        XCTAssertEqual((setModel["params"] as? [String: Any])?["sessionId"] as? String, "s_bound")
        XCTAssertEqual((setModel["params"] as? [String: Any])?["model"] as? String, "srv-b")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertFalse(mgmt.methods.contains("session.setEffort"),
                       "effort must wait for the model — it is validated against the session's CURRENT model")
        XCTAssertTrue(factory.made.isEmpty, "nothing attaches (and so nothing sends) before the stamps land")
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(setModel["id"] as! Int),"result":{}}"#)

        await feedWaitUntil { mgmt.methods.contains("session.setEffort") }
        guard let setEffort = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setEffort" }) else {
            return XCTFail("the held effort must be applied too: \(mgmt.methods)")
        }
        XCTAssertEqual((setEffort["params"] as? [String: Any])?["effort"] as? String, "high")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(factory.made.isEmpty, "the send waits for BOTH stamps")
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(setEffort["id"] as! Int),"result":{}}"#)

        // …and only then the ordinary attach-then-send.
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_bound")
        await feedWaitUntil { t.methods.contains("session.send") }
        XCTAssertEqual(mgmt.methods.filter { $0 == "session.create" }.count, 1, "still exactly one create")
    }

    /// **A refused stamp must never eat the message** (the user's own ruling): the message outranks
    /// the stamp, and a dead Send button over a failed effort RPC is precisely what this design
    /// exists to prevent. A `setModel` that comes back an error still lets the effort stamp and the
    /// send through.
    func testAFailedStampStillSendsTheMessage() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.openPanelTabForNewChatPage(kind: .web)
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("'+' must create: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(create["id"] as! Int),"result":{"sessionId":"s_bound","trusted":true}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(open["id"] as! Int),"result":{"ok":true,"tabId":"t1"}}"#)
        await feedWaitUntil { mgmt.methods.contains("panel.list") }
        guard let primeList = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.list" }) else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(primeList["id"] as! Int),"result":{"tabs":[],"activeTabId":null}}"#)
        await feedWaitUntil { host.newChatBoundSessionId == "s_bound" }

        host.setNewChatModel("srv-b")
        host.setNewChatEffort("high")
        host.sendFirstChatMessage("say it anyway") { id in host.apply(destination: .session(id)) }

        await feedWaitUntil { mgmt.methods.filter { $0 == "panel.list" }.count == 2 }
        guard let verify = mgmt.sent.map({ feedLineJSON($0) }).filter({ $0["method"] as? String == "panel.list" }).last else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(verify["id"] as! Int),"result":{"tabs":[],"activeTabId":null}}"#)

        await feedWaitUntil { mgmt.methods.contains("session.setModel") }
        guard let setModel = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setModel" }) else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(setModel["id"] as! Int),"error":{"code":1,"message":"unknown model 'srv-b'"}}"#)

        await feedWaitUntil { mgmt.methods.contains("session.setEffort") }
        guard let setEffort = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setEffort" }) else { return }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(setEffort["id"] as! Int),"error":{"code":1,"message":"effort refused"}}"#)

        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_bound")
        await feedWaitUntil { t.methods.contains("session.send") }
        guard let send = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.send" }) else {
            return XCTFail("a refused stamp must not eat the message: \(t.methods)")
        }
        XCTAssertEqual((send["params"] as? [String: Any])?["text"] as? String, "say it anyway")
        XCTAssertEqual(host.newChatCreate, .idle, "…and the page is not left stuck mid-create either")
    }

    /// The held choice follows the DRAFT, not the binding: a choice made on an abandoned visit must
    /// never be silently adopted by the next one (the same standing-lie class one surface over).
    func testAFreshNewChatEntryClearsTheHeldModelAndEffort() async {
        let (host, _, _) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        host.setNewChatModel("srv-b")
        host.setNewChatEffort("high")
        host.newChatDraft = "half a thought"

        host.apply(destination: .mode(.code)) // walk away…
        host.apply(destination: .newChat)     // …and come back
        XCTAssertNil(host.newChatModel, "a previous visit's pick must not be inherited")
        XCTAssertNil(host.newChatEffort)
        XCTAssertEqual(host.newChatDraft, "", "the pre-existing contract this rides on")
    }

    /// **The negative scope.** The held choice belongs to the new-chat page's doors and nowhere else:
    /// the folder-picker create (`createSession(with:)`, the landings' "New") must never inherit it —
    /// it is a different surface, with its own picker, minting a CODE session.
    func testTheFolderCreateNeverInheritsTheNewChatPagesHeldChoice() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        host.setNewChatModel("srv-b")
        host.setNewChatEffort("high")

        host.createSession(with: .folder("/tmp/proj")) { _ in }
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        let params = create["params"] as? [String: Any]
        XCTAssertEqual(params?["cwd"] as? String, "/tmp/proj", "the premise: this IS the folder door")
        XCTAssertNil(params?["model"], "the page's pick must not leak onto another surface's create")
        XCTAssertNil(params?["effort"])
    }

    /// …and neither does the OTHER panel auto-create — the one reached from every landing that is not
    /// the new-chat page (`openPanelTab`'s own no-attached-session branch, which NAVIGATES rather than
    /// binding; `ShellPanel`/`ShellSidebar` route the new-chat page to `openPanelTabForNewChatPage`
    /// instead precisely so the page's draft is not stranded). It cannot mint the page's session, so
    /// it must not carry the page's choice.
    func testThePlainPanelAutoCreateIsNotANewChatDoorAndCarriesNoHeldChoice() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        host.setNewChatModel("srv-b")
        host.setNewChatEffort("high")

        host.openPanelTab(kind: .web) { _ in }
        await feedWaitUntil { mgmt.methods.contains("session.create") }
        guard let create = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("must create: \(mgmt.methods)")
        }
        let params = create["params"] as? [String: Any]
        XCTAssertNil(params?["model"])
        XCTAssertNil(params?["effort"])
    }

    /// The page's chip has no adapter to fetch its catalogue through, so the host fetches it on the
    /// MANAGEMENT connection — the same `sync.config` the orb already reads there
    /// (`AppModel.fetchModelCatalogue`), fired when the chip is about to be read (the header's own
    /// "a snapshot, refreshed exactly when it is about to be read" convention).
    func testTheNewChatChipFetchesItsCatalogueOnTheManagementConnection() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        XCTAssertEqual(host.newChatCatalogue, .empty, "nothing fetched until something asks")

        host.newChatModelControl.onOpen()
        await feedWaitUntil { mgmt.methods.contains("sync.config") }
        guard let cfg = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "sync.config" }) else {
            return XCTFail("the chip's open must fetch the catalogue: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(cfg["id"] as! Int),"result":{"provider":"codex-oauth","exaKey":null,"dangerousDomains":[],"defaultModel":"srv-a","models":[{"id":"srv-a","efforts":["low","high"]}],"defaultEffort":"high","clientEfforts":["ultra"]}}"#)
        await feedWaitUntil { host.newChatCatalogue.models.count == 1 }
        XCTAssertEqual(host.newChatCatalogue.models.map(\.id), ["srv-a"])
    }

    // MARK: - Fix round 1: the re-pick, and the effort a new model does not accept

    /// **The dropped clear.** Pick a model → "+" (the create stamps it, and binds) → re-pick
    /// **Default** → send. The session is really pinned to the stamped model, so "Default" must go
    /// out as a literal `null` — the clear. Before this fix the reuse branch's `if let model` was
    /// false and NOTHING was sent: the chip read "Default model" while the session stayed pinned and
    /// the first turn ran at the old model, which is the mirrored form of exactly the wrong-selection
    /// window hold-and-stamp exists to close.
    func testAnExplicitDefaultRePickAfterTheBindClearsWhatTheBindStamped() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        host.setNewChatModel("srv-b")
        host.setNewChatEffort("high")

        let stamped = await bindViaPlus(host, mgmt, sessionId: "s_bound")
        XCTAssertEqual(stamped?["model"] as? String, "srv-b", "the premise: the '+' create DID stamp it")
        XCTAssertEqual(stamped?["effort"] as? String, "high")

        // …and now the user changes their mind, on both axes.
        host.setNewChatModel(nil)
        host.setNewChatEffort(nil)
        XCTAssertNil(host.newChatModel, "the chip now reads Default — the session must be made to agree")

        host.sendFirstChatMessage("hello") { id in host.apply(destination: .session(id)) }
        await answerReuseVerify(mgmt)

        await feedWaitUntil { mgmt.methods.contains("session.setModel") }
        guard let setModel = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setModel" }) else {
            return XCTFail("an explicit Default must CLEAR the session's override: \(mgmt.methods)")
        }
        XCTAssertTrue((setModel["params"] as? [String: Any])?["model"] is NSNull,
                      "a literal null — the wire's own clear (NormaClient.setModel), never an omitted key")
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(setModel["id"] as! Int),"result":{}}"#)

        await feedWaitUntil { mgmt.methods.contains("session.setEffort") }
        guard let setEffort = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setEffort" }) else {
            return XCTFail("…and so must the effort half: \(mgmt.methods)")
        }
        XCTAssertTrue((setEffort["params"] as? [String: Any])?["effort"] is NSNull)
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(setEffort["id"] as! Int),"result":{}}"#)

        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_bound")
        await feedWaitUntil { t.methods.contains("session.send") }
    }

    /// The other half of the tri-state, and the reason it is a tri-state rather than an
    /// unconditional null-send: an axis the user NEVER TOUCHED is not written at all. That bound
    /// session is real, listed and reachable by another client (the same argument the sequencing pin
    /// rests on), so this page must not clear an override it did not set.
    func testAnAxisTheUserNeverTouchedIsNeverWrittenOnTheReuseBranch() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        await bindViaPlus(host, mgmt, sessionId: "s_bound")
        host.setNewChatModel("srv-b") // ONLY the model — the effort axis is never touched

        host.sendFirstChatMessage("hello") { id in host.apply(destination: .session(id)) }
        await answerReuseVerify(mgmt)

        await feedWaitUntil { mgmt.methods.contains("session.setModel") }
        guard let setModel = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setModel" }) else {
            return XCTFail("the touched axis must be written: \(mgmt.methods)")
        }
        mgmt.feed(#"{"jsonrpc":"2.0","id":\#(setModel["id"] as! Int),"result":{}}"#)

        // Asserted HERE, before the send-dependent half, and proven by the mutation run: an
        // unconditional write sends its `setEffort` in this beat AND then stalls the send waiting
        // for a response nobody feeds — so an assertion placed after the send would red on a
        // TIMEOUT rather than on the claim it is making.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertFalse(mgmt.methods.contains("session.setEffort"),
                       "an untouched axis must not be cleared — this page never set it")

        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "s_bound")
        await feedWaitUntil { t.methods.contains("session.send") }
        XCTAssertFalse(mgmt.methods.contains("session.setEffort"), "…and still not by send time")
    }

    /// **Fix round 1, the second Important.** An effort picked while no model is pinned is validated
    /// against the catalogue's DEFAULT model; picking a model that does not accept it leaves a pair
    /// the daemon refuses (`assertEffortSelectable`, reached by `session.create` too) — with no
    /// provider change involved. It is cleared on the model change, so the "+" door cannot become a
    /// click that silently does nothing, and the menu cannot go on showing an illegal value checked.
    ///
    /// A COMPATIBLE effort must survive the same change: this clears what the daemon would refuse,
    /// never merely what changed.
    func testAnEffortTheNewlyPickedModelCannotAcceptIsClearedAndACompatibleOneSurvives() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)
        await feedNewChatCatalogue(host, mgmt,
                                   models: #"[{"id":"srv-a","efforts":["none","low","high"]},{"id":"srv-b","efforts":["high","max"]}]"#)

        // Picked with NO model pinned: the offered list came from the catalogue's default (srv-a).
        host.setNewChatEffort("low")
        XCTAssertEqual(host.newChatEffort, "low")

        host.setNewChatModel("srv-b") // srv-b accepts high/max — "low" is now refusable
        XCTAssertNil(host.newChatEffort,
                     "an effort the model in force does not accept must not survive the model change")

        // …and the compatible direction: "high" is accepted by both models.
        host.setNewChatEffort("high")
        host.setNewChatModel("srv-a")
        XCTAssertEqual(host.newChatEffort, "high", "a legal effort must survive — this clears refusals, not changes")
    }

    /// …and it NEVER clears on silence: an empty wire list means the daemon has told us nothing about
    /// this model (an unlisted model, a BYOK endpoint that cannot enumerate, or a catalogue not
    /// fetched yet). The same "empty is a real answer and never a licence to guess" rule
    /// `effortPickerOptions` keeps, applied in the one direction that can destroy a user's pick.
    func testAnEffortIsNeverClearedByAModelTheCatalogueSaysNothingAbout() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        // 1. Nothing fetched at all.
        host.setNewChatEffort("low")
        host.setNewChatModel("srv-b")
        XCTAssertEqual(host.newChatEffort, "low", "an unfetched catalogue knows nothing and must clear nothing")

        // 2. A real catalogue, an unlisted model.
        await feedNewChatCatalogue(host, mgmt, models: #"[{"id":"srv-a","efforts":["none","low","high"]}]"#)
        host.setNewChatModel("unheard-of")
        XCTAssertEqual(host.newChatEffort, "low", "…and neither does a model it does not list")
    }

    /// The catalogue LANDING is the other moment we learn enough to judge — a pick made before any
    /// fetch was never checked against anything.
    func testACatalogueThatLandsLateInvalidatesAnEffortThatWasNeverCheckable() async {
        let (host, _, mgmt) = await makeHostWithManagement()
        host.setShellVisible(true)
        host.apply(destination: .newChat)

        host.setNewChatModel("srv-b")
        host.setNewChatEffort("low") // legal-looking: nothing has said otherwise yet
        await feedNewChatCatalogue(host, mgmt,
                                   models: #"[{"id":"srv-a","efforts":["none","low","high"]},{"id":"srv-b","efforts":["high","max"]}]"#)
        XCTAssertNil(host.newChatEffort, "once the daemon has said, an effort srv-b refuses cannot stay held")
    }

    // MARK: - editor-product T3: the editor runtime table (pre-warm on reveal, release on departure)

    /// A runtime factory whose every CEF call is recorded — the `makeEditorRuntime` seam's whole
    /// reason for existing: without it a test that reveals a panel would construct a runtime wired
    /// to the real C surface, which nothing under XCTest may touch.
    private struct EditorFactory {
        let make: (String) -> EditorRuntime
        let cef: EditorCEFRecorder
        let slot: EditorSlotRecorder
        let hub: EditorBridgeHub
        let scheduler: EditorFakeScheduler
    }

    /// **Every double a live `EditorRuntime` reaches through an `[unowned self]` closure, held for
    /// the whole test.**
    ///
    /// Not belt-and-braces — measured, as a crash, on the first run. The doubles hand out closure
    /// structs (`CEFDriver`, `Scheduler`, `Slot`) that capture their recorder unowned, exactly as
    /// `BrowserRuntimeTests`' do; a recorder a test never mentions AGAIN (the slot recorder, in the
    /// tests that only assert on the table) is released the moment the local factory value is last
    /// used, and the runtime's next hub registration reads a dangling reference. Holding them here
    /// ties their lifetime to the test case rather than to a local's last mention.
    private var editorDoubles: [AnyObject] = []

    /// office-plumbing Task 5: same reasoning as `editorDoubles` immediately above — a recorder a
    /// test never mentions again after building its factory would otherwise be released the moment
    /// the local factory value is last used, and a runtime's `[unowned self]`-capturing driver
    /// closure would then read a dangling reference the next time an effect fires.
    private var officeDoubles: [AnyObject] = []

    override func tearDown() {
        editorDoubles.removeAll()
        officeDoubles.removeAll()
        super.tearDown()
    }

    /// editor-product Task 10: `makeWatcher`/`saveEditor` are ADDITIVE overrides (both default to
    /// `nil`, i.e. `EditorRuntime`'s own production defaults) — for the tab-close gate's tests, which
    /// need to observe a watcher actually stopping (`EditorWatcherRecorder`, borrowed from
    /// `EditorConflictTests` on the same "doubles, not copies" terms `EditorTabTests` already states)
    /// or need a save to resolve WITHOUT real CDP/disk plumbing.
    private func editorFactory(files: [String: String] = [:], browserId: Int32 = 41,
                               makeWatcher: EditorFileWatcherFactory? = nil,
                               saveEditor: EditorSaveCoordinator.Editor? = nil) -> EditorFactory {
        let cef = EditorCEFRecorder()
        cef.browserIds = [browserId]
        let slot = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: slot.slot)
        let scheduler = EditorFakeScheduler()
        editorDoubles.append(contentsOf: [cef, slot, hub, scheduler] as [AnyObject])
        return EditorFactory(make: { sessionId in
            EditorRuntime(sessionId: sessionId, hub: hub, driver: cef.driver,
                          scheduler: scheduler.scheduler,
                          readFile: { path in
                              guard let text = files[path] else {
                                  throw NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError)
                              }
                              return EditorFileContents(text: text)
                          },
                          saveEditor: saveEditor,
                          makeWatcher: makeWatcher ?? { path, onChange in
                              DispatchSourceFileWatcher(path: path, onChange: onChange)
                          })
        }, cef: cef, slot: slot, hub: hub, scheduler: scheduler)
    }

    /// The bridge messages a runtime has sent and not yet been answered for, by wire type — same
    /// shape and same reasoning as `EditorTabTests`' own copy (each suite keeps its own; the
    /// recorders are shared, this reader is not worth sharing across a module boundary of tests).
    private func cdpTypes(_ cef: EditorCEFRecorder) -> [String] {
        let known = ["setTheme", "openModel", "activateModel", "closeModel", "pullContent",
                     "applyExternalContent", "markSaved"]
        return cef.cdp.compactMap { entry in
            guard let params = entry.params else { return nil }
            return known.first { params.contains(#"\"type\":\""# + $0 + #"\""#) }
        }
    }

    private func codeRow(_ sessionId: String, dirs: [SessionDirEntry]?) -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global",
                       cwd: dirs?.first?.path, mode: "code", dirs: dirs)
    }

    /// The two decisions, on their own — the shape of every pure pin in this file.
    func testTheEditorPreWarmTargetIsASessionWithRealWorkingDirectories() {
        let rows = [
            codeRow("S_dirs", dirs: [SessionDirEntry(path: "/repo", locked: false)]),
            codeRow("S_dirless", dirs: []),
            codeRow("S_degenerate", dirs: [SessionDirEntry(path: "", locked: false)]),
            SessionSummary(sessionId: "S_chat", title: nil, createdAt: 2, scope: "global",
                           cwd: nil, mode: "chat")
        ]
        XCTAssertEqual(editorPrewarmTarget(sessionId: "S_dirs", rows: rows), "S_dirs")
        XCTAssertNil(editorPrewarmTarget(sessionId: "S_dirless", rows: rows),
                     "[] is a real workdir-less session — an editor with no root to reach is a "
                     + "hidden Chromium nobody can put a file in")
        XCTAssertNil(editorPrewarmTarget(sessionId: "S_degenerate", rows: rows),
                     "fix round 1: a [{path: \"\"}] row used to pass !dirs.isEmpty and prewarm a "
                     + "REAL hidden EditorRuntime/Chromium for a session editorTabSessionRoots (the "
                     + "authoritative gate the Files tab/code-tab door/transcript all use) already "
                     + "classifies as dirless — same predicate, now mirrored here too")
        XCTAssertNil(editorPrewarmTarget(sessionId: "S_chat", rows: rows),
                     "nil dirs = no working-directory concept at all")
        XCTAssertNil(editorPrewarmTarget(sessionId: "S_unlisted", rows: rows),
                     "a row that has not loaded yet is never guessed at")
        XCTAssertNil(editorPrewarmTarget(sessionId: nil, rows: rows))
    }

    func testOnlyACleanEditorIsReleasedWhenTheShellLeavesItsSession() {
        XCTAssertTrue(editorRuntimeReleasedOnDeparture(dirtyModels: 0))
        XCTAssertFalse(editorRuntimeReleasedOnDeparture(dirtyModels: 1),
                       "a detach is not a quit — ⌘W warns about nothing, and T10's gate is what "
                       + "stands between unsaved work and losing it")
    }

    func testAPanelRevealPreWarmsExactlyOneEditorForASessionWithDirectories() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory) = makeHost(rows: rows)
        defer { host.deselect() }
        let editor = editorFactory()
        host.makeEditorRuntime = editor.make
        // The row has to be LOADED before the reveal can read its `dirs` — an unloaded row is its
        // own ineligible case (`editorPrewarmTarget` never guesses), the same discipline
        // `moveToCliOffered`'s own tests follow.
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.panelDidReveal()
        host.panelDidReveal()

        XCTAssertEqual(host.editorRuntimes.count, 1)
        XCTAssertEqual(editor.cef.createdURLs, [EditorRuntime.pageURL],
                       "a second reveal finds the runtime already there, and prewarm is idempotent")
        XCTAssertEqual(host.existingEditorRuntime(for: "S1")?.stateSnapshot.phase, .booting)
        XCTAssertEqual(editor.hub.registeredBrowserIds, [41],
                       "registration is keyed on the browser id, learned after the create")
    }

    func testAPanelRevealCreatesNoEditorForADirlessOrChatSession() async {
        for row in [codeRow("S1", dirs: []),
                    SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global",
                                   cwd: nil, mode: "chat")] {
            let (host, factory) = makeHost(rows: [row])
            let editor = editorFactory()
            host.makeEditorRuntime = editor.make
            await host.directory.refresh()
            host.setShellVisible(true)
            host.select("S1")
            await waitUntilMade(factory, 1)
            await answerHandshake(factory.made[0], sessionId: "S1")

            host.panelDidReveal()

            XCTAssertEqual(host.editorRuntimes.count, 0, "row: \(row.mode ?? "?") dirs=\(String(describing: row.dirs))")
            XCTAssertEqual(editor.cef.createdURLs, [])
            host.deselect()
        }
    }

    // MARK: - office live-gate Bug 2: office joins the same pre-warm door

    /// **The fix itself, driven through the real `panelDidReveal` door** (mirrors
    /// `testAPanelRevealPreWarmsExactlyOneEditorForASessionWithDirectories` exactly, one level over).
    /// `office.recorder.state` is forced to `.notStarted` — the recorder defaults to `.ready`
    /// (`OfficeDriverRecorder`'s own default), which would fold `.ensureHelperReady` synchronously via
    /// the late-joiner branch and never touch `startHelper` at all, proving nothing about THIS ask.
    func testAPanelRevealAlsoBootsTheOfficeHelperForASessionWithDirectories() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory) = makeHost(rows: rows)
        defer { host.deselect() }
        let editor = editorFactory()
        host.makeEditorRuntime = editor.make
        let office = officeFactory()
        office.recorder.state = .notStarted
        host.makeOfficeRuntime = office.make
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.panelDidReveal()
        host.panelDidReveal()

        await officeWaitUntil(timeout: 2) { office.recorder.startHelperCalls >= 1 }
        XCTAssertEqual(host.officeRuntimes.count, 1)
        XCTAssertEqual(office.recorder.startHelperCalls, 1,
                       "a second reveal finds the runtime already past `.idle` — idempotent, the same "
                       + "'prewarm is idempotent' claim the editor's own test makes one door over")
        XCTAssertEqual(office.recorder.openCalls.count, 0,
                       "the pre-warm must NEVER open a document — only ask the shared helper to be "
                       + "ready (Bug 2's own 'NOT opening any document')")
    }

    /// **The guard rail**: dirless/chat sessions must never spawn the office helper either — the
    /// STRONGER pin, not merely "no runtime in the table" but "the shared supervisor itself was never
    /// even minted," since `officeRuntime(for:)` is the one call that reaches for it at all and
    /// `panelDidReveal`'s guard must return before ever calling it.
    func testAPanelRevealNeverBootsTheOfficeHelperForADirlessOrChatSession() async {
        for row in [codeRow("S1", dirs: []),
                    SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global",
                                   cwd: nil, mode: "chat")] {
            let (host, factory) = makeHost(rows: [row])
            let editor = editorFactory()
            host.makeEditorRuntime = editor.make
            let office = officeFactory()
            office.recorder.state = .notStarted
            host.makeOfficeRuntime = office.make
            await host.directory.refresh()
            host.setShellVisible(true)
            host.select("S1")
            await waitUntilMade(factory, 1)
            await answerHandshake(factory.made[0], sessionId: "S1")

            host.panelDidReveal()

            XCTAssertEqual(host.officeRuntimes.count, 0, "row: \(row.mode ?? "?") dirs=\(String(describing: row.dirs))")
            XCTAssertNil(host.officeHelperSupervisor,
                        "never minted at all for a dirless/chat session — not just \"no runtime,\" the "
                        + "shared supervisor was never even reached for")
            XCTAssertEqual(office.recorder.startHelperCalls, 0)
            host.deselect()
        }
    }

    /// The departure policy, driven through the REAL door the shell uses when its window hides.
    func testHidingTheShellReleasesACleanEditorAndKeepsOneWithUnsavedWork() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]

        // Clean: released.
        let (host, factory) = makeHost(rows: rows)
        let editor = editorFactory()
        host.makeEditorRuntime = editor.make
        // The row has to be LOADED before the reveal can read its `dirs` — an unloaded row is its
        // own ineligible case (`editorPrewarmTarget` never guesses), the same discipline
        // `moveToCliOffered`'s own tests follow.
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        host.panelDidReveal()
        XCTAssertEqual(host.editorRuntimes.count, 1)

        host.setShellVisible(false)
        XCTAssertEqual(host.editorRuntimes.count, 0, "a clean editor is rebuilt on demand — the "
                       + "spec's reattach rule re-reads each file on first activation")
        XCTAssertEqual(editor.cef.closeCount, 1)
        XCTAssertEqual(editor.hub.registeredBrowserIds, [])

        // Dirty: kept.
        let (host2, factory2) = makeHost(rows: rows)
        defer { host2.deselect() }
        let editor2 = editorFactory(files: ["/repo/a.ts": "const a = 1;\n"])
        host2.makeEditorRuntime = editor2.make
        await host2.directory.refresh()
        host2.setShellVisible(true)
        host2.select("S1")
        await waitUntilMade(factory2, 1)
        await answerHandshake(factory2.made[0], sessionId: "S1")
        host2.panelDidReveal()
        guard let runtime = host2.existingEditorRuntime(for: "S1") else {
            return XCTFail("the reveal built no runtime")
        }
        editor2.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        // editor-product Task 4: `ready` now ALSO sends `setTheme`, synchronously and ahead of
        // anything queued — one more pending CDP call to drain before the one that acks `openModel`.
        editor2.cef.answerNextCDP() // setTheme — no state effect
        await runtime.openFile("/repo/a.ts")
        editor2.cef.answerNextCDP() // openModel — records the model
        editor2.slot.deliver(browserId: 41, queryId: 2,
                             request: #"{"type":"modelDirtyChanged","path":"/repo/a.ts","dirty":true}"#)
        XCTAssertEqual(runtime.stateSnapshot.dirtyCount, 1)

        host2.setShellVisible(false)
        XCTAssertEqual(host2.editorRuntimes.count, 1, "hiding the window must never destroy unsaved edits")
        XCTAssertEqual(editor2.cef.closeCount, 0)
        XCTAssertEqual(runtime.stateSnapshot.dirtyCount, 1)
    }

    /// The explicit door — for a session that is genuinely going away, whatever it is holding.
    func testTeardownEditorRuntimeReleasesItWhateverItHolds() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory) = makeHost(rows: rows)
        defer { host.deselect() }
        let editor = editorFactory(files: ["/repo/a.ts": "x"])
        host.makeEditorRuntime = editor.make
        // The row has to be LOADED before the reveal can read its `dirs` — an unloaded row is its
        // own ineligible case (`editorPrewarmTarget` never guesses), the same discipline
        // `moveToCliOffered`'s own tests follow.
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        host.panelDidReveal()
        guard let runtime = host.existingEditorRuntime(for: "S1") else {
            return XCTFail("the reveal built no runtime")
        }
        editor.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        // editor-product Task 4: drain the ready-triggered `setTheme` first — see the identical note
        // in `testHidingTheShellReleasesACleanEditorAndKeepsOneWithUnsavedWork`.
        editor.cef.answerNextCDP() // setTheme — no state effect
        await runtime.openFile("/repo/a.ts")
        editor.cef.answerNextCDP() // openModel — records the model
        editor.slot.deliver(browserId: 41, queryId: 2,
                            request: #"{"type":"modelDirtyChanged","path":"/repo/a.ts","dirty":true}"#)

        host.teardownEditorRuntime(for: "S1")

        XCTAssertEqual(host.editorRuntimes.count, 0)
        XCTAssertEqual(editor.cef.closeCount, 1)
        XCTAssertEqual(editor.hub.registeredBrowserIds, [])
        XCTAssertNil(host.existingEditorRuntime(for: "S1"))
    }

    // MARK: - editor-product Task 10: the tab-close gate

    /// A save flow the test controls completely — no real CDP round trip and no real disk, so a
    /// save's OUTCOME can be scripted deterministically. `coordinator` is filled in AFTER the
    /// runtime that holds it exists (`EditorRuntime.saveCoordinator` is `private(set) lazy`, so
    /// reading it forces construction, exactly as calling `save(_:)` for real would).
    @MainActor
    private final class ScriptedSaveEditor {
        weak var coordinator: EditorSaveCoordinator?
        var writeError: Error?
        var answerText = "scripted"

        var seam: EditorSaveCoordinator.Editor {
            EditorSaveCoordinator.Editor(
                hasModel: { _ in true },
                pull: { [weak self] path, seq in
                    self?.coordinator?.deliverContentResponse(path: path, seq: seq, text: self?.answerText ?? "")
                },
                markSaved: { _, _ in },
                noteExpectedWrite: { _ in },
                withdrawExpectedWrite: { _ in },
                write: { [weak self] _, _ in
                    if let error = self?.writeError { throw error }
                })
        }
    }

    /// Drive one session to `.ready` with `path` open and dirty, and register its `.code` tab in the
    /// panel — the setup every test below shares. Returns the live runtime, or fails the CURRENT
    /// test cleanly (`XCTUnwrap`, `EditorSaveTests`' own posture for an "async setup that should
    /// structurally never fail") rather than crashing the whole process.
    private func makeDirtyCodeTab(host: ShellSessionHost, factory: ShellTransportFactory,
                                  editor: EditorFactory, sessionId: String, path: String,
                                  tabId: String) async throws -> EditorRuntime {
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select(sessionId)
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: sessionId)
        host.panelDidReveal()
        let runtime = try XCTUnwrap(host.existingEditorRuntime(for: sessionId), "the reveal built no runtime")
        editor.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        editor.cef.answerNextCDP() // setTheme — no state effect
        await runtime.openFile(path)
        editor.cef.answerNextCDP() // openModel — records the model
        editor.slot.deliver(browserId: 41, queryId: 2,
                            request: #"{"type":"modelDirtyChanged","path":"\#(path)","dirty":true}"#)
        XCTAssertEqual(runtime.stateSnapshot.dirtyCount, 1, "setup must leave the file dirty")
        host.panelStore.applyFetchedSnapshot(
            sessionId: sessionId,
            tabs: [PanelTab(tabId: tabId, kind: .code, url: path, title: (path as NSString).lastPathComponent)],
            activeTabId: nil)
        return runtime
    }

    /// **T9's ⚠️, pinned: a CLEAN code tab's × now closes the runtime's model AND stops its
    /// watcher.** Before this task `closePanelTab` alone left the page model open and the watcher's
    /// two file descriptors running — released only when the WHOLE runtime eventually was.
    func testRequestCloseTabOnACleanCodeTabClosesTheModelAndStopsTheWatcherSilently() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let watchers = EditorWatcherRecorder()
        let editor = editorFactory(files: ["/repo/a.ts": "x"], makeWatcher: watchers.factory)
        host.makeEditorRuntime = editor.make
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        host.panelDidReveal()
        guard let runtime = host.existingEditorRuntime(for: "S1") else {
            return XCTFail("the reveal built no runtime")
        }
        editor.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        editor.cef.answerNextCDP() // setTheme
        await runtime.openFile("/repo/a.ts")
        editor.cef.answerNextCDP() // openModel — records the CLEAN model
        XCTAssertNotNil(runtime.stateSnapshot.models["/repo/a.ts"])
        XCTAssertEqual(runtime.stateSnapshot.dirtyCount, 0, "this tab stays clean — no dirtyChanged fired")
        guard let watcher = watchers.watchers["/repo/a.ts"] else {
            return XCTFail("the open must have armed a watcher")
        }
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1", tabs: [PanelTab(tabId: "t1", kind: .code, url: "/repo/a.ts", title: "a.ts")],
            activeTabId: nil)
        var sheetsPresented = 0
        host.presentDirtyCloseSheet = { _, _, _ in sheetsPresented += 1 }

        host.requestCloseTab("t1")

        XCTAssertEqual(sheetsPresented, 0, "a clean tab must never show the sheet")
        XCTAssertNil(runtime.stateSnapshot.models["/repo/a.ts"], "the model must be closed")
        XCTAssertTrue(watcher.isStopped, "T9's ⚠️ — the watcher's two file descriptors must be released")
        XCTAssertEqual(cdpTypes(editor.cef), ["closeModel"],
                       "runtime.close(path) must send closeModel to the page, not just move Swift's "
                       + "own state — T9's ⚠️")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        guard let close = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.closeTab" }) else {
            return XCTFail("requestCloseTab must still fire panel.closeTab for a clean tab: \(mgmt.methods)")
        }
        XCTAssertEqual((close["params"] as? [String: Any])?["tabId"] as? String, "t1")
    }

    /// A non-`.code` tab (or a code tab with no file — unreachable through any shipped door) is the
    /// gate's own no-op shape: straight through to the unconditional `closePanelTab`, no sheet, and
    /// no runtime ever touched.
    func testRequestCloseTabOnANonCodeTabClosesUnconditionallyWithoutTouchingAnyRuntime() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1", tabs: [PanelTab(tabId: "t1", kind: .web, url: "https://a", title: "A")],
            activeTabId: nil)
        var sheetsPresented = 0
        host.presentDirtyCloseSheet = { _, _, _ in sheetsPresented += 1 }

        host.requestCloseTab("t1")

        XCTAssertEqual(sheetsPresented, 0)
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        XCTAssertEqual(host.editorRuntimes.count, 0, "a .web tab's close must never mint or touch an editor")
    }

    /// The dirty sheet's Cancel: nothing closes, nothing saves, the tab and its model are untouched.
    func testRequestCloseTabOnADirtyTabCancelChoiceLeavesEverythingOpen() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let editor = editorFactory(files: ["/repo/a.ts": "x"])
        host.makeEditorRuntime = editor.make
        let runtime = try await makeDirtyCodeTab(host: host, factory: factory, editor: editor,
                                                sessionId: "S1", path: "/repo/a.ts", tabId: "t1")
        var presentedBasename: String?
        host.presentDirtyCloseSheet = { basename, _, respond in
            presentedBasename = basename
            respond(.cancel)
        }

        host.requestCloseTab("t1")

        XCTAssertEqual(presentedBasename, "a.ts")
        try? await Task.sleep(nanoseconds: 100_000_000) // given a beat, in case a close were racing behind it
        XCTAssertFalse(mgmt.methods.contains("panel.closeTab"), "Cancel must never fire the RPC")
        XCTAssertNotNil(runtime.stateSnapshot.models["/repo/a.ts"], "the model must still be open")
        XCTAssertEqual(runtime.stateSnapshot.dirtyCount, 1, "still dirty — nothing was saved or discarded")
    }

    /// The dirty sheet's Discard: closes without ever asking the save coordinator for anything.
    func testRequestCloseTabOnADirtyTabDiscardChoiceClosesWithoutSaving() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let editor = editorFactory(files: ["/repo/a.ts": "x"])
        host.makeEditorRuntime = editor.make
        let runtime = try await makeDirtyCodeTab(host: host, factory: factory, editor: editor,
                                                sessionId: "S1", path: "/repo/a.ts", tabId: "t1")
        host.presentDirtyCloseSheet = { _, _, respond in respond(.discard) }

        host.requestCloseTab("t1")

        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        XCTAssertNil(runtime.stateSnapshot.models["/repo/a.ts"], "discard still closes the model")
        XCTAssertFalse(editor.cef.cdp.contains { $0.params?.contains(#"\"type\":\"pullContent\""#) == true },
                       "Discard must never pull the buffer's content — nothing here is ever saved")
    }

    /// The dirty sheet's Save, when the save FAILS: the tab stays open (T9's banner already carries
    /// the sentence — closing here would take the explanation away with it). Cheap and deterministic
    /// — the pull is simply never answered, and the fake scheduler's own 5 s timer fires it.
    func testRequestCloseTabOnADirtyTabSaveChoiceThatFailsKeepsTheTabOpen() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let editor = editorFactory(files: ["/repo/a.ts": "x"])
        host.makeEditorRuntime = editor.make
        let runtime = try await makeDirtyCodeTab(host: host, factory: factory, editor: editor,
                                                sessionId: "S1", path: "/repo/a.ts", tabId: "t1")
        host.presentDirtyCloseSheet = { _, _, respond in respond(.save) }

        host.requestCloseTab("t1")

        await feedWaitUntil { self.cdpTypes(editor.cef).contains("pullContent") }
        XCTAssertTrue(editor.scheduler.fireNextTimer(), "the 5 s pull timeout must be armed")
        try? await Task.sleep(nanoseconds: 100_000_000) // let the failed save's continuation run
        XCTAssertFalse(mgmt.methods.contains("panel.closeTab"), "a failed save must not close the tab")
        XCTAssertNotNil(runtime.stateSnapshot.models["/repo/a.ts"], "the model is untouched by a failed save")
    }

    /// The dirty sheet's Save, when the save SUCCEEDS: closes only once the outcome is known, and
    /// AFTER it — scripted so the outcome is deterministic without a real CDP round trip or disk.
    func testRequestCloseTabOnADirtyTabSaveChoiceThatSucceedsClosesAfterSaving() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let scripted = ScriptedSaveEditor()
        let editor = editorFactory(files: ["/repo/a.ts": "x"], saveEditor: scripted.seam)
        host.makeEditorRuntime = editor.make
        let runtime = try await makeDirtyCodeTab(host: host, factory: factory, editor: editor,
                                                sessionId: "S1", path: "/repo/a.ts", tabId: "t1")
        scripted.coordinator = runtime.saveCoordinator
        host.presentDirtyCloseSheet = { _, _, respond in respond(.save) }

        host.requestCloseTab("t1")

        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        XCTAssertNil(runtime.stateSnapshot.models["/repo/a.ts"], "a successful save must close the model")
        guard let close = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.closeTab" }) else {
            return XCTFail("a successful save must still close the tab: \(mgmt.methods)")
        }
        XCTAssertEqual((close["params"] as? [String: Any])?["tabId"] as? String, "t1")
    }

    /// **Obligation 3 (T5 handoff, "T10 decides" — the ruling is CLEAR it): closing a failed-open
    /// tab drops its `openFailures` entry, so a later reopen mints a fresh read instead of showing
    /// the stale sentence forever.** A failed-open tab is not dirty (no model at all), so this takes
    /// the SILENT path — no sheet.
    func testRequestCloseTabOnAFailedOpenClearsTheOpenFailureForAFreshReopen() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let editor = editorFactory(files: [:]) // "/repo/missing.ts" is nowhere in this dictionary
        host.makeEditorRuntime = editor.make
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        host.panelDidReveal()
        guard let runtime = host.existingEditorRuntime(for: "S1") else {
            return XCTFail("the reveal built no runtime")
        }
        editor.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        editor.cef.answerNextCDP() // setTheme
        await runtime.openFile("/repo/missing.ts")
        XCTAssertEqual(runtime.stateSnapshot.openFailures["/repo/missing.ts"], .notFound)
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t1", kind: .code, url: "/repo/missing.ts", title: "missing.ts")],
            activeTabId: nil)
        host.presentDirtyCloseSheet = { _, _, _ in
            XCTFail("a failed open holds no model — it is not dirty, and must never ask")
        }

        host.requestCloseTab("t1")

        XCTAssertNil(runtime.stateSnapshot.openFailures["/repo/missing.ts"],
                    "closing must clear the failure so a later reopen mints a fresh read")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
    }

    /// **Obligation 4 (T3-carried, progress ledger): a dirty runtime whose session has since
    /// vanished from the daemon's own list is still retained, and still counted.** Nothing prunes
    /// `editorRuntimes` in response to a row disappearing — this is what makes the quit gate's own
    /// gather (`quitDirtyFilePaths`) tolerate a daemon-deleted session BY CONSTRUCTION: it reads
    /// `EditorRuntimeState` alone, never a session's row.
    func testTheEditorRuntimeTableRetainsADeadSessionsDirtyRuntimeForTheQuitGateToCount() async {
        final class MutableRowsBox: @unchecked Sendable { var rows: [SessionSummary] = [] }
        let box = MutableRowsBox()
        box.rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let directory = SessionDirectory(lister: { box.rows })
        let factory = ShellTransportFactory()
        let host = ShellSessionHost(directory: directory, makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                   mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        })
        defer { host.deselect() }
        let editor = editorFactory(files: ["/repo/a.ts": "x"])
        host.makeEditorRuntime = editor.make
        // office live-gate Bug 2 fix-round: this test's own raw host construction (not `makeHost`)
        // predates office's pre-warm entirely — S1 has real dirs and the `panelDidReveal()` below now
        // also reaches for `officeRuntime(for:)`. Without this, left at the class default, this test
        // is the exact one MEASURED spawning a real `NormaOfficeHelper` (see `makeHost`'s own comment).
        // NOT `OfficeDriverRecorder()` inline inside the closure: the recorder's OWN driver closures
        // capture it `[unowned self]` (mirroring every other production Driver, which assumes ITS
        // owner outlives it) — a recorder built and read in the same expression has no strong
        // reference anywhere and is deallocated the instant `.driver` returns, so the FIRST actual
        // call (`helperState()`, from `.ensureHelperReady`) reads a dangling `unowned self` and
        // crashes the whole test host with "Attempted to read an unowned reference but object was
        // already destroyed" — measured directly, mid fix-round, on `testRequestCloseTabOnADirtyTab
        // SaveChoiceThatFailsKeepsTheTabOpen`. `officeDefault` here is captured STRONGLY by the
        // `makeOfficeRuntime` closure (default Swift capture semantics for a `let` reference), and
        // that closure is itself retained by `host` for the test's whole lifetime — the same
        // retain-via-`officeDoubles.append` job `officeFactory()` does explicitly, done implicitly
        // here through the closure capture instead.
        let officeDefault = OfficeDriverRecorder()
        host.makeOfficeRuntime = { sessionId, _ in OfficeRuntime(sessionId: sessionId, driver: officeDefault.driver) }
        await directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        host.panelDidReveal()
        guard let runtime = host.existingEditorRuntime(for: "S1") else {
            return XCTFail("the reveal built no runtime")
        }
        editor.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        editor.cef.answerNextCDP() // setTheme
        await runtime.openFile("/repo/a.ts")
        editor.cef.answerNextCDP() // openModel
        editor.slot.deliver(browserId: 41, queryId: 2,
                            request: #"{"type":"modelDirtyChanged","path":"/repo/a.ts","dirty":true}"#)
        XCTAssertEqual(runtime.stateSnapshot.dirtyCount, 1)

        // The daemon-deleted-session shape: the row is simply gone from the next `session.list`.
        box.rows = []
        await directory.refresh()
        XCTAssertNil(directory.rows.first(where: { $0.sessionId == "S1" }), "the row really is gone")

        XCTAssertEqual(host.editorRuntimes.count, 1, "a dead session's dirty runtime is still retained")
        XCTAssertEqual(quitDirtyFilePaths(runtimeStates: host.editorRuntimes.values.map(\.stateSnapshot)),
                       ["/repo/a.ts"], "and the quit gate's own gather still counts its dirty file")
    }

    // MARK: - editor-product Task 6: the file door

    /// The DECISION, on its own — the file door's mirror of
    /// `testTheDiffChipDecisionDedupesByDiffIdAndTitlesTheMintWithTheBasename`: dedupe by absolute
    /// PATH over `.code` tabs, else mint titled with the basename.
    func testTheFileDoorDecisionDedupesByPathOverCodeTabsAndTitlesTheMintWithTheBasename() {
        XCTAssertEqual(panelFileTabAction(tabs: [], path: "/repo/engine.ts", openFailures: []),
                       .mint(title: "engine.ts"))

        let open = PanelTab(tabId: "t7", kind: .code, url: "/repo/engine.ts", title: "engine.ts")
        XCTAssertEqual(panelFileTabAction(tabs: [open], path: "/repo/engine.ts", openFailures: []),
                       .activate(tabId: "t7", retryOpen: false))

        // A DIFFERENT path is a different tab.
        XCTAssertEqual(panelFileTabAction(tabs: [open], path: "/repo/other.ts", openFailures: []),
                       .mint(title: "other.ts"))

        // A `.web` tab sharing the SAME url string never matches — unlike the diff door's `diffId`,
        // `url` is not unique to `.code`, so the kind filter is load-bearing.
        let web = PanelTab(tabId: "t1", kind: .web, url: "/repo/engine.ts", title: "A")
        XCTAssertEqual(panelFileTabAction(tabs: [web], path: "/repo/engine.ts", openFailures: []),
                       .mint(title: "engine.ts"))

        // A relative path titles from its last component too — the door itself never hands this
        // function one (resolution happens first), but the pure function makes no such assumption.
        XCTAssertEqual(panelFileTabAction(tabs: [], path: "src/a.ts", openFailures: []),
                       .mint(title: "a.ts"))
    }

    /// The retry branch (Task 5's review HANDOFFS), decided PURELY: an existing tab whose path
    /// currently sits in `openFailures` asks for a re-read; a DIFFERENT path's failure must never
    /// leak onto this one's flag, and a MINT never carries the flag at all.
    func testTheFileDoorDecisionRetriesOnlyAnExistingTabWhosePathIsCurrentlyFailed() {
        let open = PanelTab(tabId: "t7", kind: .code, url: "/repo/a.ts", title: "a.ts")
        XCTAssertEqual(
            panelFileTabAction(tabs: [open], path: "/repo/a.ts", openFailures: ["/repo/a.ts"]),
            .activate(tabId: "t7", retryOpen: true))
        XCTAssertEqual(
            panelFileTabAction(tabs: [open], path: "/repo/a.ts", openFailures: ["/repo/other.ts"]),
            .activate(tabId: "t7", retryOpen: false), "a different path's failure must not leak")
        XCTAssertEqual(panelFileTabAction(tabs: [open], path: "/repo/a.ts", openFailures: []),
                       .activate(tabId: "t7", retryOpen: false))
        XCTAssertEqual(
            panelFileTabAction(tabs: [], path: "/repo/a.ts", openFailures: ["/repo/a.ts"]),
            .mint(title: "a.ts"), "no existing tab -> nothing to retry, regardless of openFailures")
    }

    /// The resolution step, ahead of the dedupe: absolute untouched, relative joined to the PRIMARY
    /// directory only (never a second root, never the daemon's `cwd` alias), no base -> untouched.
    func testResolvedFilePathJoinsARelativePathAgainstThePrimaryDirectoryOnly() {
        let tworoot = codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false),
                                           SessionDirEntry(path: "/other", locked: false)])
        XCTAssertEqual(resolvedFilePath("src/a.ts", row: tworoot), "/repo/src/a.ts",
                       "the PRIMARY root only — never the second")
        XCTAssertEqual(resolvedFilePath("/already/absolute.ts", row: tworoot), "/already/absolute.ts",
                       "an absolute path is returned untouched, never re-rooted")
        XCTAssertEqual(resolvedFilePath("src/a.ts", row: nil), "src/a.ts",
                       "no row at all -> nothing to resolve against, returned untouched")
        XCTAssertEqual(resolvedFilePath("src/a.ts", row: codeRow("S1", dirs: [])), "src/a.ts",
                       "a genuinely workdir-less row -> untouched, same as no row")
        // editor-product Task 7: the companion case to the predicate reconciliation
        // (`EditorTabTests.testADegenerateEmptyPathEntryReadsAsDirlessNotPresent`) — this function's
        // OWN guard already required a real, non-empty primary, unaffected by that fix; pinned here
        // too so both halves of the reconciliation are on record in the same place a reviewer would
        // look for either.
        XCTAssertEqual(
            resolvedFilePath("src/a.ts", row: codeRow("S1", dirs: [SessionDirEntry(path: "", locked: false)])),
            "src/a.ts", "a non-empty dirs array whose only entry has no real path -> untouched")
    }

    /// **Mint: one `panel.openTab`, kind `code`, carrying the RESOLVED absolute path and the
    /// basename — and the panel is revealed.** Mirrors
    /// `testAChipClickMintsADiffTabWithItsDiffIdAndBasenameAndRevealsThePanel`.
    func testAFileDoorClickWithNoExistingTabMintsACodeTabWithAbsolutePathAndBasenameAndRevealsThePanel() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openFileTab("/repo/src/engine.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("a file-door click with nothing open must mint a tab: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["kind"] as? String, "code")
        XCTAssertEqual(params?["url"] as? String, "/repo/src/engine.ts")
        XCTAssertEqual(params?["title"] as? String, "engine.ts")
        XCTAssertNil(params?["tabId"], "the daemon mints tabId — the door must never send one")
        XCTAssertNil(params?["diffId"], "a code tab carries no diffId")
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.activateTab" }.count, 0,
                       "nothing was open to activate: \(mgmt.methods)")
        XCTAssertEqual(revealed, 1, "a tab nobody can see is not an opened file")
    }

    /// **The second click: `panel.activateTab` on the tab the first click opened, and NO second
    /// mint.** Mirrors `testASecondChipClickActivatesTheOpenTabInsteadOfMintingASecond`.
    func testASecondFileDoorClickOnTheSamePathActivatesInsteadOfMintingASecondTab() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t7", kind: .code, url: "/repo/src/engine.ts", title: "engine.ts")],
            activeTabId: nil)

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openFileTab("/repo/src/engine.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("a file door click for an already-open path must activate it: \(mgmt.methods)")
        }
        let params = activate["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["tabId"] as? String, "t7")
        // The whole point: no duplicate tab. Given a beat, in case a mint were racing behind it.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0,
                       "one tab per file — a second click must never mint: \(mgmt.methods)")
        XCTAssertEqual(revealed, 1, "an activate behind a hidden panel is a click that does nothing")
    }

    /// The dedupe reads the CALLER'S OWN session, not whatever the shell is attached to — the file
    /// door's mirror of `testTheDedupeReadsTheChipsOwnSessionNotTheAttachedOne`.
    func testTheFileDoorDedupeReadsTheCallersOwnSessionNotTheAttachedOne() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S2")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S2")
        XCTAssertEqual(host.attachedSessionId, "S2")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t7", kind: .code, url: "/repo/engine.ts", title: "engine.ts")],
            activeTabId: nil)

        host.openFileTab("/repo/engine.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("the caller's own session's tab must be activated: \(mgmt.methods)")
        }
        XCTAssertEqual((activate["params"] as? [String: Any])?["sessionId"] as? String, "S1",
                       "the activate targets the caller's session, not the attached one")
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0)
    }

    /// End to end: a relative click mints with the RESOLVED absolute url on the wire; the SAME file
    /// clicked again, spelled absolutely, must ACTIVATE that tab rather than mint a second — proof
    /// that resolution happens BEFORE the dedupe, not merely that the two paths look alike.
    func testAFileDoorClickResolvesARelativePathBeforeDedupingSoBothSpellingsCollide() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.openFileTab("src/engine.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("the relative-path mint never reached the wire: \(mgmt.methods)")
        }
        XCTAssertEqual((open["params"] as? [String: Any])?["url"] as? String, "/repo/src/engine.ts",
                       "the wire only ever sees the RESOLVED absolute path")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t1", kind: .code, url: "/repo/src/engine.ts", title: "engine.ts")],
            activeTabId: nil)
        host.openFileTab("/repo/src/engine.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 1,
                       "the relative and absolute spellings of the same file must collide on ONE tab")
    }

    /// A mutable stand-in disk — the daemon or the user's own fix (the agent creating a file)
    /// changes what a SECOND read finds, which a value-typed `files` dictionary (every other runtime
    /// harness in this file) cannot express. `@unchecked Sendable` + a lock: `readFile` is
    /// `@Sendable` and runs off the main actor (`EditorRuntime.openAndSend`'s `Task.detached`) —
    /// `ShellScriptedTransport`'s own precedent, top of this file.
    private final class MutableDisk: @unchecked Sendable {
        private let lock = NSLock()
        private var _files: [String: String]
        init(_ files: [String: String] = [:]) { _files = files }
        func set(_ path: String, _ text: String) {
            lock.lock(); _files[path] = text; lock.unlock()
        }
        func read(_ path: String) throws -> String {
            lock.lock(); defer { lock.unlock() }
            guard let text = _files[path] else {
                throw NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError)
            }
            return text
        }
    }

    /// `editorFactory(files:)`'s sibling, off a `MutableDisk` rather than a fixed dictionary — see
    /// that type's own doc for why the retry test below needs it.
    private func editorFactory(disk: MutableDisk, browserId: Int32 = 41) -> EditorFactory {
        let cef = EditorCEFRecorder()
        cef.browserIds = [browserId]
        let slot = EditorSlotRecorder()
        let hub = EditorBridgeHub(slot: slot.slot)
        let scheduler = EditorFakeScheduler()
        editorDoubles.append(contentsOf: [cef, slot, hub, scheduler] as [AnyObject])
        return EditorFactory(make: { sessionId in
            EditorRuntime(sessionId: sessionId, hub: hub, driver: cef.driver,
                          scheduler: scheduler.scheduler,
                          readFile: { path in try EditorFileContents(text: disk.read(path)) })
        }, cef: cef, slot: slot, hub: hub, scheduler: scheduler)
    }

    /// **The binding obligation, proven with a REAL runtime: activating a tab whose read PREVIOUSLY
    /// FAILED does not merely bring it to the front — it asks the runtime to read the file again,
    /// which is what lets the sentence clear once the agent creates the file (Task 5's review,
    /// HANDOFFS: "activation alone leaves a stale File not found forever").**
    func testActivatingATabWhoseReadPreviouslyFailedRetriesTheOpenAndClearsTheFailureOnceItSucceeds() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        let disk = MutableDisk()
        let editor = editorFactory(disk: disk)
        host.makeEditorRuntime = editor.make
        host.panelDidReveal()
        guard let runtime = host.existingEditorRuntime(for: "S1") else {
            return XCTFail("the reveal built no runtime")
        }
        editor.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        editor.cef.answerNextCDP() // setTheme

        // First read: the file is not there yet. A failed read records NO model and reaches no CDP
        // call at all — the read happens BEFORE anything is sent to the page.
        await runtime.openFile("/repo/a.ts")
        XCTAssertEqual(runtime.stateSnapshot.openFailures["/repo/a.ts"], .notFound)
        XCTAssertEqual(editor.cef.cdp.count, 0)

        // The tab already exists — as if the first click's mint had folded.
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t9", kind: .code, url: "/repo/a.ts", title: "a.ts")],
            activeTabId: nil)

        // The agent has since created the file — a real fix, not a test-only flag.
        disk.set("/repo/a.ts", "const a = 1;\n")

        host.openFileTab("/repo/a.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0,
                       "an existing tab must never be re-minted")

        // The retry: a second read reaches the page, off the SAME runtime.
        await feedWaitUntil { !editor.cef.cdp.isEmpty }
        XCTAssertTrue(runtime.stateSnapshot.openFailures.isEmpty,
                      "the retry clears the stale failure the instant it re-asks")
        editor.cef.answerNextCDP() // openModel
        XCTAssertNotNil(runtime.stateSnapshot.models["/repo/a.ts"],
                        "the retry actually re-read the file the agent had since created")
    }

    /// **The negative: an already-open, HEALTHY tab is never re-read on activate.** Proven with a
    /// REAL runtime (not merely the pure decision above), so a door that ignored `retryOpen` and
    /// called `openFile` unconditionally would surface here as a spurious `activateModel` CDP call.
    func testActivatingAHealthyExistingTabNeverRetriesAnything() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        let disk = MutableDisk(["/repo/a.ts": "const a = 1;\n"])
        let editor = editorFactory(disk: disk)
        host.makeEditorRuntime = editor.make
        host.panelDidReveal()
        guard let runtime = host.existingEditorRuntime(for: "S1") else {
            return XCTFail("the reveal built no runtime")
        }
        editor.slot.deliver(browserId: 41, queryId: 1, request: #"{"type":"ready"}"#)
        editor.cef.answerNextCDP() // setTheme
        await runtime.openFile("/repo/a.ts")
        editor.cef.answerNextCDP() // openModel — a healthy model, no failure recorded
        XCTAssertTrue(runtime.stateSnapshot.openFailures.isEmpty)

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t9", kind: .code, url: "/repo/a.ts", title: "a.ts")],
            activeTabId: nil)

        host.openFileTab("/repo/a.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        // Given a beat, in case a spurious retry were racing behind the activate.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(editor.cef.cdp.count, 0,
                       "an already-open, non-failed file must not be re-read on activate")
    }

    // MARK: - editor-product Task 7: the Files tab's door

    /// The DECISION, on its own — mirrors `testTheFileDoorDecisionDedupesByPathOverCodeTabsAndTitlesTheMintWithTheBasename`
    /// one door up, minus per-item identity: there is at most ONE `.files` tab per session, so the
    /// KIND ALONE is the whole test, and every edge here is "does the kind filter actually work".
    func testTheFilesTabActionDedupesByKindAloneAndMintsWhenNoneIsOpen() {
        XCTAssertEqual(panelFilesTabAction(tabs: []), .mint)

        let open = PanelTab(tabId: "t7", kind: .files, url: nil, title: "Files")
        XCTAssertEqual(panelFilesTabAction(tabs: [open]), .activate(tabId: "t7"))

        // Every OTHER kind present, but no `.files` tab -> still mint. The kind filter is
        // load-bearing here, not redundant — a session can freely hold web/code/diff tabs with no
        // Files tab at all.
        let others = [
            PanelTab(tabId: "t1", kind: .web, url: "https://a", title: "A"),
            PanelTab(tabId: "t2", kind: .code, url: "/repo/a.ts", title: "a.ts"),
            PanelTab(tabId: "t3", kind: .diff, url: nil, title: "b.ts", diffId: "d_1"),
        ]
        XCTAssertEqual(panelFilesTabAction(tabs: others), .mint)

        // The Files tab sitting AMONG other kinds is still found and activated — order-independent.
        XCTAssertEqual(panelFilesTabAction(tabs: others + [open]), .activate(tabId: "t7"))
        XCTAssertEqual(panelFilesTabAction(tabs: [open] + others), .activate(tabId: "t7"))
    }

    /// **The first open: one `panel.openTab`, kind `files`, NO url, titled "Files" — and the panel is
    /// revealed.** Also the door's own de facto proof that `PanelURLPolicy.mayOpenTab(kind: .files,
    /// url: nil)` allows it through (`openPanelTab`'s policy guard sits ahead of every branch) — a
    /// refusal there would show up here as no `panel.openTab` ever reaching the wire.
    func testAFilesTabOpenWithNoExistingTabMintsWithNoUrlTitledFilesAndRevealsThePanel() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openFilesTab(sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("a Files-tab open with nothing open must mint a tab: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["kind"] as? String, "files")
        XCTAssertEqual(params?["title"] as? String, "Files")
        XCTAssertNil(params?["url"], "a Files tab carries no url")
        XCTAssertNil(params?["diffId"], "…nor a diffId")
        XCTAssertNil(params?["tabId"], "the daemon mints tabId — the door must never send one")
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.activateTab" }.count, 0,
                       "nothing was open to activate: \(mgmt.methods)")
        XCTAssertEqual(revealed, 1, "a tab nobody can see is not an opened tree")
    }

    /// **The second open: `panel.activateTab` on the tab the first open minted, and NO second
    /// mint** — one Files tab per session, exactly like the strip's "+" is one tab per click but
    /// this door is one tab EVER per session.
    func testASecondFilesTabOpenActivatesInsteadOfMintingASecondTab() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t7", kind: .files, url: nil, title: "Files")],
            activeTabId: nil)

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openFilesTab(sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("a Files-tab open for an already-open session must activate it: \(mgmt.methods)")
        }
        let params = activate["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["tabId"] as? String, "t7")
        // The whole point: no duplicate tab. Given a beat, in case a mint were racing behind it.
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0,
                       "one Files tab per session — a second open must never mint: \(mgmt.methods)")
        XCTAssertEqual(revealed, 1, "an activate behind a hidden panel is a click that does nothing")
    }

    /// The door targets the NAMED session, not whatever the shell is attached to — structurally
    /// guaranteed here (`sessionId:` is required, no attached-session fallback branch exists), but
    /// pinned end to end anyway for parity with `openFileTab`/`openDiffTab`'s own identical proofs.
    func testAFilesTabOpenTargetsTheNamedSessionNotTheAttachedOne() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S2")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S2")
        XCTAssertEqual(host.attachedSessionId, "S2")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t7", kind: .files, url: nil, title: "Files")],
            activeTabId: nil)

        host.openFilesTab(sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("the named session's tab must be activated: \(mgmt.methods)")
        }
        XCTAssertEqual((activate["params"] as? [String: Any])?["sessionId"] as? String, "S1",
                       "the activate targets the NAMED session, not the attached one")
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0)
    }

    // MARK: - office-plumbing Task 5: the office runtime table

    /// Every `Driver` call any `OfficeRuntime` minted through `officeFactory()` makes, recorded —
    /// the `makeOfficeRuntime` seam's whole reason for existing, mirroring `EditorCEFRecorder`'s own
    /// (a raw helper spawn is exactly as unreachable under XCTest as a raw CEF call). ONE recorder
    /// per factory, shared across every session it mints — the real architecture's own shape (one
    /// app-wide client), not a test convenience shortcut.
    private final class OfficeDriverRecorder: @unchecked Sendable {
        // T6 review F3 + re-review Minor: every field a driver closure can touch runs off the main
        // actor when called concurrently (a nested type does NOT inherit its enclosing `@MainActor`
        // test class's isolation), and test code sets these same fields from MainActor — so EVERY
        // shared mutable field is guarded, not just the call-log arrays F3 first closed (~25% of
        // `testTeardownOfficeRuntimeRemovesItFromTheTable` failed before that fix). Same lock-backed
        // shape as `ShellScriptedTransport`/`ShellTransportFactory`/`MutableDisk`, this file's own
        // established precedent. The lock is NEVER held across an `await` — see `open`'s and
        // `requestTiles`'s suspend/resume dances, which release it before suspending and re-take it
        // only for the plain synchronous reads/writes on either side.
        private let lock = NSLock()

        /// Office Stage B Task 2b — every recorder gets its OWN scratch state directory by default
        /// (a fresh UUID-named temp path, never pre-created: `OfficeRuntime.stageDocument`'s own
        /// `createDirectory(withIntermediateDirectories: true)` brings the whole chain, `docs/`
        /// included, into existence on first stage). A default parameter rather than a threaded-in
        /// requirement so every existing `OfficeDriverRecorder()` call site in this file — there are
        /// several, scattered across unrelated sections — keeps compiling unchanged; only tests that
        /// actually care about WHERE staging lands (none yet) need to pass one explicitly.
        let stateDirectory: URL
        init(stateDirectory: URL = FileManager.default.temporaryDirectory
                 .appendingPathComponent("OfficeDriverRecorder-\(UUID().uuidString)", isDirectory: true)) {
            self.stateDirectory = stateDirectory
        }

        private var _openCalls: [(docId: String, path: String)] = []
        private var _closeCalls: [String] = []
        /// Office Stage B Task 2 — every `save` call, in order.
        private var _saveCalls: [String] = []
        private var _subscribeCalls: [String] = []
        private var _unsubscribeCalls: [String] = []
        private var _startHelperCalls = 0
        /// office-plumbing Task 6 — every `requestTiles` call, in order: `(docId, keys)`.
        private var _requestCalls: [(docId: String, keys: [TileKey])] = []
        /// T6 review F2's own drill — every `requestTiles` call refused via `requestTilesShouldFail`,
        /// recorded before the throw so a test can wait on the failure path having actually run
        /// rather than racing its own assertions against the Task that runs it.
        private var _requestFailureCalls: [(docId: String, keys: [TileKey])] = []

        var openCalls: [(docId: String, path: String)] { lock.lock(); defer { lock.unlock() }; return _openCalls }
        var closeCalls: [String] { lock.lock(); defer { lock.unlock() }; return _closeCalls }
        var saveCalls: [String] { lock.lock(); defer { lock.unlock() }; return _saveCalls }
        var subscribeCalls: [String] { lock.lock(); defer { lock.unlock() }; return _subscribeCalls }
        var unsubscribeCalls: [String] { lock.lock(); defer { lock.unlock() }; return _unsubscribeCalls }
        var startHelperCalls: Int { lock.lock(); defer { lock.unlock() }; return _startHelperCalls }
        var requestCalls: [(docId: String, keys: [TileKey])] {
            lock.lock(); defer { lock.unlock() }; return _requestCalls
        }
        var requestFailureCalls: [(docId: String, keys: [TileKey])] {
            lock.lock(); defer { lock.unlock() }; return _requestFailureCalls
        }

        private var _state: OfficeHelperSupervisor.State = .ready
        var state: OfficeHelperSupervisor.State {
            get { lock.lock(); defer { lock.unlock() }; return _state }
            set { lock.lock(); _state = newValue; lock.unlock() }
        }
        /// Office Stage B Task 2b — replaces the old path-keyed `openFailures`/`openMetadata` dicts.
        /// Post-staging, the `open` closure below observes the STAGED path (a UUID-derived name under
        /// `stateDirectory`, unpredictable from a test), never the real path a test wrote to disk — a
        /// dictionary keyed by "the path the test expects to see" is structurally unreachable now, not
        /// just inconvenient. The two tests that used to inject a failure by real path ("garbage
        /// file") instead now use a real scratch file that genuinely doesn't exist yet, so STAGING
        /// itself fails before `open` is ever reached — a more representative failure mode than a
        /// driver-level stub. The one remaining test that needs the DRIVER itself (not staging) to
        /// fail once — proving a retry reaches the driver a second time — consumes this one-shot flag.
        /// `openMetadata` had no test setting it at all (confirmed by grep before removal); it was
        /// dead the moment staging intercepted the path, same reasoning, one less thing to keep in
        /// sync with a real filesystem.
        private var _failNextOpenReason: String?
        var failNextOpenReason: String? {
            get { lock.lock(); defer { lock.unlock() }; return _failNextOpenReason }
            set { lock.lock(); _failNextOpenReason = newValue; lock.unlock() }
        }
        /// Office Stage B Task 2 — docId -> reason; when set, `save` throws `.saveFailed` instead of
        /// returning a temp path. Mirrors `openFailures`' own shape exactly.
        private var _saveFailures: [String: String] = [:]
        var saveFailures: [String: String] {
            get { lock.lock(); defer { lock.unlock() }; return _saveFailures }
            set { lock.lock(); _saveFailures = newValue; lock.unlock() }
        }
        /// Office Stage B Task 2 — the temp path `save` reports back for a docId; defaults to a
        /// deterministic `/tmp` path so most tests never need to set this at all.
        private var _saveTempPaths: [String: String] = [:]
        var saveTempPaths: [String: String] {
            get { lock.lock(); defer { lock.unlock() }; return _saveTempPaths }
            set { lock.lock(); _saveTempPaths = newValue; lock.unlock() }
        }
        private var _defaultMetadata = OfficeDocumentMetadata(
            type: .spreadsheet, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 100, heightTwips: 100))
        var defaultMetadata: OfficeDocumentMetadata {
            get { lock.lock(); defer { lock.unlock() }; return _defaultMetadata }
            set { lock.lock(); _defaultMetadata = newValue; lock.unlock() }
        }
        /// office-plumbing Task 6 — what `subscribeTiles` reports as the current viewport's key set,
        /// per docId. Empty (the pre-Task-6 default) unless a test opts in — most existing office
        /// tests never look at tiles at all, and an empty reply means `perform`'s `.subscribe` case
        /// has nothing to request, so `requestCalls` simply stays empty for them too.
        private var _subscribeReplies: [String: [TileKey]] = [:] // docId -> keys
        var subscribeReplies: [String: [TileKey]] {
            get { lock.lock(); defer { lock.unlock() }; return _subscribeReplies }
            set { lock.lock(); _subscribeReplies = newValue; lock.unlock() }
        }
        /// T6 review F2's own drill: when set, `requestTiles` throws instead of recording a success —
        /// proves a thrown send leaves its keys requestable again rather than stuck in-flight forever.
        private var _requestTilesShouldFail = false
        var requestTilesShouldFail: Bool {
            get { lock.lock(); defer { lock.unlock() }; return _requestTilesShouldFail }
            set { lock.lock(); _requestTilesShouldFail = newValue; lock.unlock() }
        }

        /// Carry 6's own drill: an `open` does not return until `resumeNextOpen()` is called — the
        /// seam that lets a test park an open MID-FLIGHT, drive a teardown while it is still
        /// outstanding, and only then let it resolve.
        ///
        /// Office Stage B Task 2b — **path-agnostic now; was keyed by the path the driver's own
        /// `open` closure receives.** Post-staging that is always the STAGED path (a UUID-derived
        /// name under `stateDirectory`, minted internally by `OfficeRuntime.makeDocId`), which no
        /// test can predict ahead of the very call it needs to suspend — "suspend THIS path" is no
        /// longer an expressible ask. "Suspend the next open, whatever path it turns out to carry"
        /// still is: a one-shot flag, mirroring `failNextOpenReason`'s identical shape (same fix,
        /// same root cause, applied to the other seam that used to be keyed by a real path). The
        /// only caller (`testTeardownWhileAnOpenIsInFlightResolvesWithoutResurrectingOrLeakingThe
        /// Document`) only ever has one open in flight at a time, so one shot is enough.
        private var nextOpenSuspended = false
        private var pendingOpenContinuation: CheckedContinuation<Void, Never>?

        func suspendNextOpen() {
            lock.lock(); nextOpenSuspended = true; lock.unlock()
        }
        func resumeNextOpen() {
            lock.lock()
            let continuation = pendingOpenContinuation
            pendingOpenContinuation = nil
            lock.unlock()
            continuation?.resume() // resumed OUTSIDE the lock — never resume a continuation while holding it
        }

        /// T6 re-review's own scratch proof, made permanent: gates `requestTiles` so a test can hold
        /// ONE call outstanding while firing a second, overlapping `subscribeTiles` — proving the
        /// second sees the first's keys as already in flight rather than issuing a duplicate. A
        /// single gate, held until `resumeRequestTiles()` — unlike `suspendNextOpen`'s consumed-on-
        /// first-open one-shot above — since every test that needs this only ever holds back one
        /// call at a time.
        private var requestTilesSuspended = false
        private var pendingRequestTilesContinuations: [CheckedContinuation<Void, Never>] = []

        func suspendRequestTiles() {
            lock.lock(); requestTilesSuspended = true; lock.unlock()
        }
        func resumeRequestTiles() {
            lock.lock()
            requestTilesSuspended = false
            let continuations = pendingRequestTilesContinuations
            pendingRequestTilesContinuations = []
            lock.unlock()
            for continuation in continuations { continuation.resume() } // outside the lock, same reason as above
        }

        var driver: OfficeRuntime.Driver {
            OfficeRuntime.Driver(
                helperState: { [unowned self] in self.state },
                startHelper: { [unowned self] in
                    self.lock.lock(); self._startHelperCalls += 1; self.lock.unlock()
                },
                open: { [unowned self] docId, path in
                    self.lock.lock(); self._openCalls.append((docId, path)); self.lock.unlock()
                    self.lock.lock()
                    let shouldSuspend = self.nextOpenSuspended
                    self.nextOpenSuspended = false
                    self.lock.unlock()
                    if shouldSuspend {
                        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                            self.lock.lock()
                            self.pendingOpenContinuation = continuation
                            self.lock.unlock()
                        }
                    }
                    self.lock.lock()
                    let failReason = self._failNextOpenReason
                    self._failNextOpenReason = nil
                    self.lock.unlock()
                    if let failReason {
                        throw OfficeHelperClientError.openFailed(reason: failReason)
                    }
                    return self.defaultMetadata
                },
                close: { [unowned self] docId in
                    self.lock.lock(); self._closeCalls.append(docId); self.lock.unlock()
                },
                save: { [unowned self] docId, _ in
                    self.lock.lock(); self._saveCalls.append(docId); self.lock.unlock()
                    if let reason = self.saveFailures[docId] {
                        throw OfficeHelperClientError.saveFailed(reason: reason)
                    }
                    return self.saveTempPaths[docId] ?? "/tmp/officedriverrecorder-\(docId).saved"
                },
                subscribeTiles: { [unowned self] docId, _, _, _ in
                    self.lock.lock(); self._subscribeCalls.append(docId); self.lock.unlock()
                    return self.subscribeReplies[docId] ?? []
                },
                unsubscribeTiles: { [unowned self] docId in
                    self.lock.lock(); self._unsubscribeCalls.append(docId); self.lock.unlock()
                },
                requestTiles: { [unowned self] docId, keys in
                    self.lock.lock()
                    let wasSuspended = self.requestTilesSuspended
                    self.lock.unlock()
                    if wasSuspended {
                        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                            self.lock.lock()
                            self.pendingRequestTilesContinuations.append(continuation)
                            self.lock.unlock()
                        }
                    }
                    if self.requestTilesShouldFail {
                        self.lock.lock(); self._requestFailureCalls.append((docId, keys)); self.lock.unlock()
                        throw OfficeHelperClientError.timedOut
                    }
                    self.lock.lock(); self._requestCalls.append((docId, keys)); self.lock.unlock()
                },
                postKey: { _, _, _, _, _ in }, postMouse: { _, _, _, _, _, _, _, _ in },
                postExtTextInput: { _, _, _, _ in },
                stateDirectory: stateDirectory)
        }
    }

    private struct OfficeFactory {
        let make: (String, OfficeRuntime.Driver) -> OfficeRuntime
        let recorder: OfficeDriverRecorder
    }

    /// `_` ignores the driver `officeRuntime(for:)` itself computes (the production `officeDriver`
    /// closing over the host's real, never-started `OfficeHelperSupervisor`) — safe to build and
    /// discard: constructing that object touches no process, no socket, nothing XCTest cannot own
    /// (`OfficeHelperSupervisor.init` only sets up its `AsyncStream`; a spawn happens only inside
    /// `start()`, which nothing here ever calls). Every runtime this factory mints uses the
    /// recorder's OWN driver instead.
    private func officeFactory() -> OfficeFactory {
        let recorder = OfficeDriverRecorder()
        officeDoubles.append(recorder)
        return OfficeFactory(make: { sessionId, _ in
            OfficeRuntime(sessionId: sessionId, driver: recorder.driver)
        }, recorder: recorder)
    }

    private func officeWaitUntil(timeout: TimeInterval, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline {
                XCTFail("timed out waiting for a condition to become true")
                return
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// Office Stage B Task 2b sweep — most of this section's tests use a literal path like `/a.xlsx`
    /// purely as a `documents` dictionary key. Now that `OfficeRuntime.open` genuinely STAGES (a real
    /// `copyfile(3)`) the path before ever reaching the driver, a literal that names no real file
    /// fails at that staging step (ENOENT) instead of ever reaching `documents[path]` — the driver's
    /// own `open` closure is never even called. Mints a real, empty scratch file with a `prefix` (so
    /// a failure message prints something recognizable, e.g. "a-<uuid>.xlsx", rather than a bare
    /// UUID) directly under `FileManager.default.temporaryDirectory` — the exact per-test-local idiom
    /// `testActivatingATabWhosePathIsInOpenFailuresAlsoRetriesTheOpen`/`testTheRouterRetriesAFailed
    /// OfficeOpenOnActivateThroughTheSameDoorOpenDocumentTabUses` already established for `badPath`,
    /// factored out once it started repeating, unchanged, across a dozen more tests in this same set
    /// of sections. Always `.xlsx` — every literal this sweep replaces already was.
    private func makeScratchOfficePath(_ prefix: String) -> String {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString).xlsx").path
        try? Data().write(to: URL(fileURLWithPath: path))
        return path
    }

    func testOfficeRuntimeIsMintedOnFirstUseAndReusedThereafter() {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make

        let first = host.officeRuntime(for: "S1")
        XCTAssertNil(host.existingOfficeRuntime(for: "S2"), "minting for S1 must not create S2's")
        let again = host.officeRuntime(for: "S1")
        XCTAssertTrue(first === again, "one office runtime per session — a second ask reuses it")
        XCTAssertEqual(host.officeRuntimes.count, 1)
    }

    /// The shared-supervisor design claim, made checkable: minting a SECOND session's runtime must
    /// not mint a second supervisor — `OfficeHelperSupervisor` is app-wide (T2's own design: one
    /// socket path per state directory), not one per session the way `editorRuntimes`' CEF browsers
    /// are.
    func testTwoSessionsShareTheSameAppWideSupervisorInstance() {
        let (host, _) = makeHost()
        _ = host.officeRuntime(for: "S1")
        guard let supervisorAfterFirst = host.officeHelperSupervisor else {
            return XCTFail("minting a runtime must mint the shared supervisor")
        }
        _ = host.officeRuntime(for: "S2")
        XCTAssertTrue(host.officeHelperSupervisor === supervisorAfterFirst,
                      "the SAME supervisor instance serves every session")
    }

    func testTeardownOfficeRuntimeRemovesItFromTheTableAndClosesEveryOpenDocument() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        let bPath = makeScratchOfficePath("b")
        runtime.open(aPath)
        runtime.open(bPath)
        await officeWaitUntil(timeout: 2) {
            runtime.stateSnapshot.documents.count == 2
        }

        host.teardownOfficeRuntime(for: "S1")

        XCTAssertNil(host.existingOfficeRuntime(for: "S1"))
        XCTAssertEqual(host.officeRuntimes.count, 0)
        // `performTeardown`'s closes are fire-and-forget Tasks (obligation 5's own reasoning: no
        // attempt to wait out an in-flight request) — waited out HERE only so the test itself does
        // not return while one is still orphaned mid-flight (a leaked Task touching a
        // by-then-deallocated recorder is exactly the unowned-reference crash class this file is
        // already known for; see `officeDoubles`' own doc).
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 2 }
        XCTAssertEqual(office.recorder.closeCalls.count, 2, "both open documents are closed on teardown")
        try? FileManager.default.removeItem(atPath: aPath)
        try? FileManager.default.removeItem(atPath: bPath)
    }

    /// **Office Stage B Task 3 — the Stage A "always releases" claim these two tests used to pin is
    /// now false, and this is the rewrite: clean released, dirty RETAINED.** Mirrors
    /// `testHidingTheShellReleasesACleanEditorAndKeepsOneWithUnsavedWork`'s own two-host shape
    /// exactly, including the reason (two independent hosts, since the first host's clean release
    /// tears the runtime down and there is nothing left to make dirty afterward). Driven through the
    /// REAL door the shell uses on a hop — `releaseOfficeRuntimeIfClean` fires synchronously inside
    /// `hop(to:)`, well before any round trip (`testHopDetachesThePreviousAndAttachesTheNewWithNoAbort`'s
    /// own pin), so this test never needs a second `factory.made` connection or its reply —
    /// `host.select("S2")` alone is the trigger, on both hosts.
    func testHopReleasesACleanOfficeRuntimeAndKeepsOneWithUnsavedWork() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)]),
                   codeRow("S2", dirs: [SessionDirEntry(path: "/repo2", locked: false)])]

        // Clean: released.
        let (host, factory) = makeHost(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        let runtime = host.officeRuntime(for: "S1")
        let gatePath = makeScratchOfficePath("gate")
        runtime.open(gatePath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[gatePath] != nil }
        XCTAssertEqual(host.officeRuntimes.count, 1)

        host.select("S2")

        XCTAssertEqual(host.officeRuntimes.count, 0, "a clean office runtime is rebuilt on demand")
        // See the identical comment in `testTeardownOfficeRuntimeRemovesItFromTheTableAnd
        // ClosesEveryOpenDocument` — waited out so the test does not return with an orphaned close
        // Task still in flight.
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        XCTAssertEqual(office.recorder.closeCalls.count, 1, "the open document was closed on the way out")
        try? FileManager.default.removeItem(atPath: gatePath)

        // Dirty: kept.
        let (host2, factory2) = makeHost(rows: rows)
        defer { host2.deselect() }
        let office2 = officeFactory()
        host2.makeOfficeRuntime = office2.make
        await host2.directory.refresh()
        host2.setShellVisible(true)
        host2.select("S1")
        await waitUntilMade(factory2, 1)
        await answerHandshake(factory2.made[0], sessionId: "S1")
        let runtime2 = host2.officeRuntime(for: "S1")
        let gatePath2 = makeScratchOfficePath("gate2")
        runtime2.open(gatePath2)
        await officeWaitUntil(timeout: 2) { runtime2.stateSnapshot.documents[gatePath2] != nil }
        let docId2 = try XCTUnwrap(runtime2.stateSnapshot.documents[gatePath2]?.docId)
        runtime2.handle(documentEvent: .modifiedChanged(true), docId: docId2)
        XCTAssertEqual(runtime2.stateSnapshot.documents[gatePath2]?.dirty, true, "setup must leave the document dirty")

        host2.select("S2")

        XCTAssertEqual(host2.officeRuntimes.count, 1, "hopping away must never destroy unsaved office edits")
        XCTAssertEqual(office2.recorder.closeCalls.count, 0)
        XCTAssertEqual(runtime2.stateSnapshot.documents[gatePath2]?.dirty, true)
        try? FileManager.default.removeItem(atPath: gatePath2)
    }

    /// Hiding the shell (⌘W / window close) detaches exactly like a hop does — same policy, same
    /// clean-only-release door (`detachCurrent`), driven via `setShellVisible(false)`. Same rewrite
    /// as the hop test immediately above, for the identical reason.
    func testHidingTheShellReleasesACleanOfficeRuntimeAndKeepsOneWithUnsavedWork() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]

        // Clean: released.
        let (host, factory) = makeHost(rows: rows)
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        let runtime = host.officeRuntime(for: "S1")
        let gatePath = makeScratchOfficePath("gate")
        runtime.open(gatePath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[gatePath] != nil }

        host.setShellVisible(false)

        XCTAssertEqual(host.officeRuntimes.count, 0)
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        XCTAssertEqual(office.recorder.closeCalls.count, 1)
        try? FileManager.default.removeItem(atPath: gatePath)

        // Dirty: kept.
        let (host2, factory2) = makeHost(rows: rows)
        defer { host2.deselect() }
        let office2 = officeFactory()
        host2.makeOfficeRuntime = office2.make
        await host2.directory.refresh()
        host2.setShellVisible(true)
        host2.select("S1")
        await waitUntilMade(factory2, 1)
        await answerHandshake(factory2.made[0], sessionId: "S1")
        let runtime2 = host2.officeRuntime(for: "S1")
        let gatePath2 = makeScratchOfficePath("gate2")
        runtime2.open(gatePath2)
        await officeWaitUntil(timeout: 2) { runtime2.stateSnapshot.documents[gatePath2] != nil }
        let docId2 = try XCTUnwrap(runtime2.stateSnapshot.documents[gatePath2]?.docId)
        runtime2.handle(documentEvent: .modifiedChanged(true), docId: docId2)

        host2.setShellVisible(false)

        XCTAssertEqual(host2.officeRuntimes.count, 1, "hiding the window must never destroy unsaved office edits")
        XCTAssertEqual(office2.recorder.closeCalls.count, 0)
        XCTAssertEqual(runtime2.stateSnapshot.documents[gatePath2]?.dirty, true)
        try? FileManager.default.removeItem(atPath: gatePath2)
    }

    // MARK: - Office Stage B Task 3: the document tab-close gate

    /// `makeDirtyCodeTab`'s own `.document` mirror: drive one session to a real open, DIRTY document
    /// (`runtime.handle(documentEvent: .modifiedChanged(true), docId:)` — the same test door
    /// `OfficeRuntimeLiveTests`' own `becameDirty` wait proves is the real LOK callback's shape,
    /// driven directly rather than through a live helper) and register its `.document` tab in the
    /// panel. Returns the docId alongside the runtime/path — `OfficeDriverRecorder`'s `save`/
    /// `saveFailures`/`saveTempPaths` seams are all keyed by docId, never by path.
    private func makeDirtyDocumentTab(host: ShellSessionHost, factory: ShellTransportFactory,
                                      sessionId: String, tabId: String, scratchPrefix: String)
        async throws -> (runtime: OfficeRuntime, path: String, docId: String) {
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select(sessionId)
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: sessionId)
        let runtime = host.officeRuntime(for: sessionId)
        let path = makeScratchOfficePath(scratchPrefix)
        runtime.open(path)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[path] != nil }
        let docId = try XCTUnwrap(runtime.stateSnapshot.documents[path]?.docId)
        runtime.handle(documentEvent: .modifiedChanged(true), docId: docId)
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true, "setup must leave the document dirty")
        host.panelStore.applyFetchedSnapshot(
            sessionId: sessionId,
            tabs: [PanelTab(tabId: tabId, kind: .document, url: path, title: (path as NSString).lastPathComponent)],
            activeTabId: nil)
        return (runtime, path, docId)
    }

    /// A clean document tab's `×` takes the silent path — no sheet — and `closePanelTab`'s own
    /// inline close still runs (Office Stage B Task 3's own header on `requestCloseTab`: the gate
    /// DECIDES ONLY, `closePanelTab` stays the one closer for a `.document` tab).
    func testRequestCloseTabOnACleanDocumentTabClosesSilently() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")
        let runtime = host.officeRuntime(for: "S1")
        let path = makeScratchOfficePath("clean")
        runtime.open(path)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[path] != nil }
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, false, "setup must leave the document clean")
        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1", tabs: [PanelTab(tabId: "t1", kind: .document, url: path, title: "clean.xlsx")],
            activeTabId: nil)
        var sheetsPresented = 0
        host.presentDirtyCloseSheet = { _, _, _ in sheetsPresented += 1 }

        host.requestCloseTab("t1")

        XCTAssertEqual(sheetsPresented, 0, "a clean document tab must never show the sheet")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        XCTAssertEqual(office.recorder.closeCalls.count, 1, "closePanelTab's own inline close must still run")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// The dirty sheet's Cancel: nothing closes, nothing saves, the tab and its document are untouched.
    func testRequestCloseTabOnADirtyDocumentTabCancelChoiceLeavesEverythingOpen() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (runtime, path, _) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "cancel")
        var presentedBasename: String?
        host.presentDirtyCloseSheet = { basename, _, respond in
            presentedBasename = basename
            respond(.cancel)
        }

        host.requestCloseTab("t1")

        XCTAssertEqual(presentedBasename, (path as NSString).lastPathComponent)
        try? await Task.sleep(nanoseconds: 100_000_000) // given a beat, in case a close were racing behind it
        XCTAssertFalse(mgmt.methods.contains("panel.closeTab"), "Cancel must never fire the RPC")
        XCTAssertNotNil(runtime.stateSnapshot.documents[path], "the document must still be open")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true, "still dirty — nothing was saved or discarded")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// **T2b composition, pinned explicitly**: a document already in conflict (an external write
    /// raced a still-dirty document) is still DIRTY — `officeDocumentIsDirty` reads the same `dirty`
    /// bit the conflict machinery leaves untouched, and the gate never inspects `documentConflicts`
    /// at all — so the close gate must show the sheet exactly as the plain-dirty case does. This does
    /// not exercise a new branch; the task's own dispatch context explicitly named this composition
    /// as an obligation ("a document sitting in conflict state is still DIRTY — gates fire"), so it
    /// is pinned here rather than left to code-reading alone.
    func testRequestCloseTabOnADirtyDocumentTabInConflictStillShowsTheSheet() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (runtime, path, _) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "conflict")

        // Race an external write onto the already-dirty document — same shape as
        // `testExternalWriteBetweenNoteExpectedWriteAndTheOwningSavesWithdrawOnADirtyDocumentRaisesAConflict`
        // (OfficeRuntimeReducerTests), minus the expected-write note: this wants a plain, untracked
        // external write, which `officeDiskChange` classifies `.external` with no identity to match.
        try Data("external bytes landed while this document was still dirty".utf8)
            .write(to: URL(fileURLWithPath: path))
        runtime.fileChangedOnDisk(path)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documentConflicts[path] != nil }
        XCTAssertEqual(runtime.stateSnapshot.documentConflicts[path], .changed, "setup: genuinely "
                       + "conflicted, not merely dirty")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true, "setup: a conflict never "
                       + "silently clears dirty")

        var presentedBasename: String?
        host.presentDirtyCloseSheet = { basename, _, respond in
            presentedBasename = basename
            respond(.cancel)
        }

        host.requestCloseTab("t1")

        XCTAssertEqual(presentedBasename, (path as NSString).lastPathComponent, "the sheet must still "
                       + "fire — conflict never bypasses the dirty gate, it only adds a banner on top of it")
        try? await Task.sleep(nanoseconds: 100_000_000) // given a beat, in case a close were racing behind it
        XCTAssertFalse(mgmt.methods.contains("panel.closeTab"), "Cancel must never fire the RPC")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// **Fix round 1 (task review, IMPORTANT-1) — the `.deleted` half of the pair above.** Deleting
    /// the file out from under a dirty document raises `.deleted`, never `.changed` — the SAME gate
    /// claim, the OTHER conflict kind, and the specific kind that matters here: `.deleted` is the
    /// only conflict kind `PanelDocumentTabModel.closeTab()`'s own conflict-banner "Close" button
    /// ever targets (`OfficeConflictBannerView.body`'s `.deleted` case is the only one offering a
    /// Close action at all — see that view's own switch). This test proves the GATE'S decision is
    /// correct for `.deleted` specifically, driven directly through `requestCloseTab`; the actual
    /// wiring bug the review caught — `closeTab()` reaching `closePanelTab` instead of this gate — is
    /// separately pinned by `testPanelDocumentTabModelCloseTabRoutesADeletionConflictThroughTheGate`
    /// immediately below, which drives the SAME `.deleted` setup through the real caller.
    func testRequestCloseTabOnADirtyDocumentTabInDeletionConflictStillShowsTheSheet() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (runtime, path, _) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "delconflict")

        try? FileManager.default.removeItem(atPath: path)
        runtime.fileChangedOnDisk(path)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documentConflicts[path] != nil }
        XCTAssertEqual(runtime.stateSnapshot.documentConflicts[path], .deleted, "setup: a deletion "
                       + "conflict specifically, not `.changed`")
        XCTAssertEqual(runtime.stateSnapshot.documents[path]?.dirty, true, "setup: `.deleted` "
                       + "conflicts are raised only on an already-dirty document "
                       + "(`OfficeRuntimeReducer.externalDeleted`'s own `guard doc.dirty`)")

        var presentedBasename: String?
        host.presentDirtyCloseSheet = { basename, _, respond in
            presentedBasename = basename
            respond(.cancel)
        }

        host.requestCloseTab("t1")

        XCTAssertEqual(presentedBasename, (path as NSString).lastPathComponent, "the sheet must fire "
                       + "for a deletion conflict exactly as it does for a plain dirty tab")
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(mgmt.methods.contains("panel.closeTab"), "Cancel must never fire the RPC")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// **The wiring pin itself (task review, IMPORTANT-1).** Drives the real caller —
    /// `PanelDocumentTabModel.closeTab()`, the conflict banner's own "Close" button — instead of
    /// calling `host.requestCloseTab` directly the way every other test in this section does.
    /// Pre-fix, `closeTab()` called `host?.closePanelTab(tabId)` directly: this exact setup (a
    /// `.deleted` conflict, always dirty by construction) would have closed the document with NO
    /// sheet, no Save/Discard/Cancel choice, silently discarding the unsaved edits — the review's own
    /// "one click from silent discard" finding. Post-fix, `closeTab()` calls
    /// `host?.requestCloseTab(tabId)`, the same gate the panel's own `×` uses, so this must now show
    /// the sheet exactly like `testRequestCloseTabOnADirtyDocumentTabInDeletionConflictStillShowsThe
    /// Sheet` immediately above — the only difference is which caller asks.
    func testPanelDocumentTabModelCloseTabRoutesADeletionConflictThroughTheGate() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (runtime, path, _) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "banner-close")

        try? FileManager.default.removeItem(atPath: path)
        runtime.fileChangedOnDisk(path)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documentConflicts[path] == .deleted }

        // The conflict banner's own model — constructed and bound exactly as
        // `PanelDocumentTabModels.model(for:host:sessionId:)` would for this tab, mirroring
        // `PanelDocumentTabTests`' own `makeHost`-adjacent tests. `closeTab()` reads only `self.host`
        // (set synchronously by `bind`, before its own deferred `activate()` Task even runs) and
        // `self.tabId` — no need to await anything model-side before calling it.
        let model = PanelDocumentTabModel(tabId: "t1", path: path)
        model.bind(host: host, sessionId: "S1")
        var presentedBasename: String?
        host.presentDirtyCloseSheet = { basename, _, respond in
            presentedBasename = basename
            respond(.cancel)
        }

        model.closeTab()

        XCTAssertEqual(presentedBasename, (path as NSString).lastPathComponent, "the banner's Close "
                       + "button must reach the SAME gated sheet the × does — this is the exact "
                       + "regression IMPORTANT-1 caught")
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(mgmt.methods.contains("panel.closeTab"), "Cancel must never fire the RPC, "
                       + "from this caller either")
        XCTAssertNotNil(runtime.stateSnapshot.documents[path], "pre-fix this caller would have closed "
                        + "the document with no sheet at all — still open proves the gate, not the "
                        + "old direct door, was reached")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// The dirty sheet's Discard: closes without ever asking the save door for anything.
    func testRequestCloseTabOnADirtyDocumentTabDiscardChoiceClosesWithoutSaving() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (runtime, path, _) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "discard")
        host.presentDirtyCloseSheet = { _, _, respond in respond(.discard) }

        host.requestCloseTab("t1")

        XCTAssertNil(runtime.stateSnapshot.documents[path], "discard still closes the document — synchronous "
                     + "in the reducer's own state (`OfficeRuntimeReducer.closeRequested`)")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        XCTAssertTrue(office.recorder.saveCalls.isEmpty, "Discard must never save")
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        try? FileManager.default.removeItem(atPath: path)
    }

    /// The dirty sheet's Save, when the save FAILS: the tab stays open — the reducer's own
    /// `documentBanners[path]` already carries the sentence, mirroring the editor's identical posture
    /// toward T9's banner.
    func testRequestCloseTabOnADirtyDocumentTabSaveChoiceThatFailsKeepsTheTabOpen() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (runtime, path, docId) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "savefail")
        office.recorder.saveFailures[docId] = "disk full"
        host.presentDirtyCloseSheet = { _, _, respond in respond(.save) }

        host.requestCloseTab("t1")

        await officeWaitUntil(timeout: 2) { office.recorder.saveCalls.contains(docId) }
        try? await Task.sleep(nanoseconds: 100_000_000) // let the failed save's outcome settle
        XCTAssertFalse(mgmt.methods.contains("panel.closeTab"), "a failed save must not close the tab")
        XCTAssertNotNil(runtime.stateSnapshot.documents[path], "the document is untouched by a failed save")
        XCTAssertNotNil(runtime.stateSnapshot.documentBanners[path], "the failure banner must be up")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// The dirty sheet's Save, when the save SUCCEEDS: closes only once the outcome is known, and
    /// AFTER it. `saveTempPaths` points at a REAL file with real bytes — `OfficeRuntime.placeAtomically`
    /// copies FROM it, so a nonexistent temp would fail the save (`testSaveAndAwaitOutcomeReturnsFailed
    /// WhenThePlaceCannotFindTheHelpersTempFile`'s own case, deliberately not this one).
    func testRequestCloseTabOnADirtyDocumentTabSaveChoiceThatSucceedsClosesAfterSaving() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (_, path, docId) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "savesucceed")
        let renderedPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("rendered-\(UUID().uuidString).xlsx").path
        try Data("rendered".utf8).write(to: URL(fileURLWithPath: renderedPath))
        office.recorder.saveTempPaths[docId] = renderedPath
        host.presentDirtyCloseSheet = { _, _, respond in respond(.save) }

        host.requestCloseTab("t1")

        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        XCTAssertEqual(try? String(contentsOfFile: path, encoding: .utf8), "rendered",
                       "a successful save must land on the real path before the tab closes")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// **The closing loop the brief's own context note names**: a runtime RETAINED dirty by one
    /// departure, reattached, and made clean again by closing its (now only) dirty tab through the
    /// sheet — releases on the NEXT departure exactly as a runtime that was always clean would. No
    /// eager release is invented here: `resolveDirtyDocumentTabClose`'s own `.close` branch only ever
    /// calls `closePanelTab` (which closes the DOCUMENT, not the runtime) — the same shape the
    /// editor's own `resolveDirtyTabClose` `.close` case already takes. It is `releaseOfficeRuntimeIfClean`,
    /// reached by the SUBSEQUENT departure, that notices the runtime is clean again and finally lets it go.
    func testClosingTheLastDirtyDocumentTabThroughTheSheetLetsTheNextDepartureReleaseTheRuntime() async throws {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)]),
                   codeRow("S2", dirs: [SessionDirEntry(path: "/repo2", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let (runtime, path, _) = try await makeDirtyDocumentTab(
            host: host, factory: factory, sessionId: "S1", tabId: "t1", scratchPrefix: "retain")

        // First departure: dirty, retained.
        host.select("S2")
        XCTAssertEqual(host.officeRuntimes.count, 1, "the dirty runtime must survive the first departure")
        XCTAssertTrue(host.existingOfficeRuntime(for: "S1") === runtime, "the SAME retained runtime, not a fresh mint")

        // Reattach — `attachedSessionId` (and so `panelTargetSessionId`) flips synchronously, ahead
        // of any round trip (`testHopDetachesThePreviousAndAttachesTheNewWithNoAbort`'s own pin), so
        // this test never needs to feed a second `session.attach` reply on the per-session transport
        // to make the assertions below true.
        host.select("S1")
        XCTAssertTrue(host.officeRuntime(for: "S1") === runtime, "returning finds the SAME retained runtime")

        // Discard through the sheet — the runtime's own last document closes, and the runtime becomes clean.
        host.presentDirtyCloseSheet = { _, _, respond in respond(.discard) }
        host.requestCloseTab("t1")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        XCTAssertNil(runtime.stateSnapshot.documents[path], "the document itself is closed")
        XCTAssertEqual(host.officeRuntimes.count, 1, "closing the tab must not itself tear the runtime "
                       + "down — no eager release exists for office, mirroring the editor's own gate")
        // Drain the fire-and-forget close before proceeding, exactly like every other Discard/close
        // test in this file — otherwise the in-flight Task can still be holding `runtime`/`office`
        // when `tearDown` clears `officeDoubles`, an orphaned-Task-touches-a-deallocated-recorder
        // crash class this file's own doc comments name repeatedly. Count is 1, not 2: the second
        // departure's own teardown (below) walks zero docIds since this document already closed.
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }

        // Second departure: now clean, released.
        host.select("S2")
        XCTAssertEqual(host.officeRuntimes.count, 0, "the runtime the first departure retained is "
                       + "finally released once it has nothing left to protect")
        try? FileManager.default.removeItem(atPath: path)
    }

    /// The fan-out itself: `broadcastOfficeHelperEvent` is the ONE consumer's routing logic, tested
    /// directly with a synthetic event — no real supervisor stream can be driven from a test (see
    /// `broadcastOfficeHelperEvent`'s own doc for why the routing is split out for exactly this).
    func testBroadcastOfficeHelperEventFansOutHelperDiedToEveryRuntimeAndClearsWhatEachHeld() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let r1 = host.officeRuntime(for: "S1")
        let r2 = host.officeRuntime(for: "S2")
        let aPath = makeScratchOfficePath("a")
        let bPath = makeScratchOfficePath("b")
        r1.open(aPath)
        r2.open(bPath)
        await officeWaitUntil(timeout: 2) {
            r1.stateSnapshot.documents[aPath] != nil && r2.stateSnapshot.documents[bPath] != nil
        }

        host.broadcastOfficeHelperEvent(.helperDied)

        for runtime in [r1, r2] {
            XCTAssertEqual(runtime.stateSnapshot.phase, .failed)
            XCTAssertTrue(runtime.stateSnapshot.documents.isEmpty)
            XCTAssertEqual(runtime.stateSnapshot.failureReason, "The office helper stopped unexpectedly.")
        }
        try? FileManager.default.removeItem(atPath: aPath)
        try? FileManager.default.removeItem(atPath: bPath)
    }

    /// The quit path's process-kill door, at the host level: walks the table (every runtime's
    /// documents close) and stops the shared supervisor. The STRICT ordering claim (table-walk
    /// strictly before the kill) is pinned at `AppLifecycleTests`' level, mirroring
    /// `EditorQuitGate`'s own spy-based order pins — this test proves the OUTCOME, not the sequence.
    func testTeardownAllOfficeRuntimesAndStopHelperEmptiesTheTableAndStopsTheSupervisor() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let r1 = host.officeRuntime(for: "S1")
        _ = host.officeRuntime(for: "S2")
        let aPath = makeScratchOfficePath("a")
        r1.open(aPath)
        await officeWaitUntil(timeout: 2) { r1.stateSnapshot.documents[aPath] != nil }

        let count = host.teardownAllOfficeRuntimesAndStopHelper()

        XCTAssertEqual(count, 2, "both sessions' runtimes were torn down")
        XCTAssertEqual(host.officeRuntimes.count, 0)
        XCTAssertEqual(host.officeHelperSupervisor?.state, .stopped)
        // Hygiene, not an assertion: let r1's fire-and-forget close settle before this test returns
        // so nothing is left orphaned to touch the recorder after `officeDoubles` releases it.
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        try? FileManager.default.removeItem(atPath: aPath)
    }

    /// A host that never touched office at all must tolerate the quit leg — no supervisor was ever
    /// minted, so there is nothing to kill.
    func testTeardownAllOfficeRuntimesAndStopHelperToleratesAHostThatNeverTouchedOffice() {
        let (host, _) = makeHost()
        XCTAssertNil(host.officeHelperSupervisor)
        let count = host.teardownAllOfficeRuntimesAndStopHelper()
        XCTAssertEqual(count, 0)
        XCTAssertNil(host.officeHelperSupervisor, "still never minted — asking to stop must not "
                     + "construct one just to immediately stop it")
    }

    /// **Carry 6**: a teardown that lands WHILE an open is still awaiting its reply must reset
    /// synchronously (never wait for the reply), and the late reply must neither resurrect the
    /// torn-down runtime nor leak the document it just opened on the shared helper.
    ///
    /// Office Stage B Task 2b: `suspendOpen(forPath:)`/`resumeOpen(forPath:)` used to key on the
    /// exact path the driver's own `open` closure receives — before staging, that WAS the real path
    /// this test names directly. Post-staging, the driver only ever observes the STAGED path (a
    /// UUID-derived name under `office.recorder.stateDirectory`, minted internally from a fresh
    /// docId), which cannot be predicted ahead of the call that needs suspending — so the recorder's
    /// seam is now `suspendNextOpen()`/`resumeNextOpen()`, path-agnostic and one-shot (see that
    /// seam's own doc on the recorder for the full reasoning, mirroring `failNextOpenReason`'s
    /// identical shape for the identical root cause).
    func testTeardownWhileAnOpenIsInFlightResolvesWithoutResurrectingOrLeakingTheDocument() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        office.recorder.suspendNextOpen()

        runtime.open(aPath)
        await officeWaitUntil(timeout: 2) { office.recorder.openCalls.count == 1 }
        XCTAssertEqual(runtime.stateSnapshot.phase, .ready, "the phase transition is synchronous — "
                       + "only the wire round trip for THIS open is still outstanding")
        XCTAssertTrue(runtime.stateSnapshot.documents.isEmpty, "not recorded until the reply lands")

        host.teardownOfficeRuntime(for: "S1")
        XCTAssertEqual(runtime.stateSnapshot, OfficeRuntimeState(), "teardown resets synchronously "
                       + "even with the open still awaiting its reply")
        XCTAssertEqual(host.officeRuntimes.count, 0)

        office.recorder.resumeNextOpen()
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }

        XCTAssertEqual(runtime.stateSnapshot, OfficeRuntimeState(), "the late resume must not "
                       + "resurrect the torn-down runtime")
        // Office Stage B Task 2b — the old `openCalls.map(\.path) == ["/a.xlsx"]` compared against
        // the REAL path; the driver only ever sees the STAGED one now, so "opened exactly once" and
        // "for this path" are asserted separately: a count, plus the closest recoverable identity
        // check (staged under the recorder's own state directory, with the real path's extension
        // preserved — the same two-part pattern `PanelDocumentTabTests
        // .testActivatingResolvesTheRuntimeAndOpensThePathExactlyOnce` already uses).
        XCTAssertEqual(office.recorder.openCalls.count, 1, "opened exactly once")
        let stagedPath = office.recorder.openCalls[0].path
        XCTAssertTrue(stagedPath.hasPrefix(office.recorder.stateDirectory.path),
                      "the recorded open carried the STAGED path, never \(aPath) itself: \(stagedPath)")
        XCTAssertEqual((stagedPath as NSString).pathExtension, "xlsx")
        XCTAssertEqual(office.recorder.closeCalls.count, 1, "the now-orphaned document is closed "
                       + "rather than leaked on the shared helper — never a second open either")
        try? FileManager.default.removeItem(atPath: aPath)
    }

    // MARK: - office-plumbing Task 6: the pixel-fetch half of `.subscribe`

    private func tileKey(_ x: Int, _ y: Int, part: Int = 0, zoomPPT: Int = 1000) -> TileKey {
        TileKey(part: part, zoomPPT: zoomPPT, tileX: x, tileY: y)
    }

    private let sampleViewport = OfficeTwipsRect(x: 0, y: 0, width: 5120, height: 5120)

    /// `.subscribe`'s effect performer must consume the `[TileKey]` `subscribeTiles` reports and ask
    /// for their pixels through `requestTiles` — the door T4/T5 deliberately left as a documented
    /// no-op ("T6 owns consuming the returned `[TileKey]`", `OfficeRuntime.perform`'s own prior
    /// comment). A pristine store has nothing cached and nothing in flight, so every reported key is
    /// requested.
    func testSubscribingRequestsExactlyTheKeysSubscribeTilesReportedWhenNothingIsCachedOrInFlight() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        runtime.open(aPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[aPath] != nil }
        let docId = runtime.stateSnapshot.documents[aPath]!.docId
        let keys = [tileKey(0, 0), tileKey(1, 0), tileKey(0, 1)]
        office.recorder.subscribeReplies[docId] = keys

        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)

        // T6 re-review F2: anchor on the recorder's append. `markRequested` now runs SYNCHRONOUSLY,
        // in program order, before `driver.requestTiles` is even called (see that call's own
        // comment) — so observing the append already implies the mark landed first; no separate wait
        // on the store is needed.
        await officeWaitUntil(timeout: 2) { !office.recorder.requestCalls.isEmpty }
        XCTAssertEqual(office.recorder.requestCalls.count, 1)
        XCTAssertEqual(office.recorder.requestCalls[0].docId, docId)
        XCTAssertEqual(Set(office.recorder.requestCalls[0].keys), Set(keys))
        XCTAssertEqual(runtime.tileStore.inFlightCountForTesting, 3, "every requested key is tracked in flight")
        try? FileManager.default.removeItem(atPath: aPath)
    }

    /// Obligation 3: a second subscribe covering an overlapping viewport must not re-request a key
    /// that is already cached (arrived) or already in flight (requested, no answer yet) — the "big
    /// batch pins the connection" amplifier the T5.5 review carried forward. `tileStore.ingest` is
    /// called directly here, standing in for a real `onTile` push (which needs a live wire — the
    /// routing that DELIVERS a push to the right store is proven separately, live, in
    /// `OfficeRuntimeLiveTests`; this test is about the FILTERING decision alone).
    func testASecondSubscribeSkipsKeysAlreadyCachedOrStillInFlight() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        runtime.open(aPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[aPath] != nil }
        let docId = runtime.stateSnapshot.documents[aPath]!.docId
        let (k0, k1, k2) = (tileKey(0, 0), tileKey(1, 0), tileKey(0, 1))
        office.recorder.subscribeReplies[docId] = [k0, k1]

        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)
        // T6 re-review F2: anchor on the recorder's append — `markRequested` now runs synchronously
        // before `driver.requestTiles` is called, so the append implies the mark, AND (unlike a
        // store-only anchor) this specific condition also guarantees call #1's own append precedes
        // call #2's, which `requestCalls[1]` below depends on.
        await officeWaitUntil(timeout: 2) { office.recorder.requestCalls.count == 1 }

        // k0 "arrives" (a stand-in for the real push); k1 stays in flight, untouched.
        runtime.tileStore.ingest(docId: docId, key: k0, generation: 0, pixels: Data(repeating: 1, count: 4))

        // A scrolled viewport now needs k0 (cached), k1 (still in flight) and k2 (genuinely new).
        office.recorder.subscribeReplies[docId] = [k0, k1, k2]
        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)

        await officeWaitUntil(timeout: 2) { office.recorder.requestCalls.count == 2 }
        XCTAssertEqual(office.recorder.requestCalls[1].docId, docId)
        XCTAssertEqual(office.recorder.requestCalls[1].keys, [k2],
                       "only the genuinely-missing key is requested a second time")
        try? FileManager.default.removeItem(atPath: aPath)
    }

    /// T6 review F2, re-reviewed: a thrown `requestTiles` must not strand its keys in flight forever.
    /// `markRequested` runs synchronously, BEFORE the send (closing the round-2 duplicate-request
    /// window — see `OfficeTileStore.markRequested`'s own doc) — so a throw genuinely DOES mark the
    /// keys in flight first, then the `catch` must explicitly free them via `markFailed`, or they
    /// strand exactly as a real, still-outstanding request would. `.timedOut` stands in for the one
    /// throw path that does not already coincide with a store eviction (the original review's own
    /// finding).
    func testAThrowingRequestTilesLeavesItsKeysRequestableAgainRatherThanStuckInFlightForever() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        runtime.open(aPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[aPath] != nil }
        let docId = runtime.stateSnapshot.documents[aPath]!.docId
        let keys = [tileKey(0, 0), tileKey(1, 0)]
        office.recorder.subscribeReplies[docId] = keys
        office.recorder.requestTilesShouldFail = true

        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)

        // Wait on the failure path itself having run (recorded before the throw) rather than on the
        // store's in-flight count, which would read as trivially "zero" even before the Task starts.
        await officeWaitUntil(timeout: 2) { !office.recorder.requestFailureCalls.isEmpty }
        XCTAssertTrue(office.recorder.requestCalls.isEmpty, "a thrown send is never recorded as a successful request")
        // The failure record lands off-actor, INSIDE the driver closure, before the throw — the
        // catch's `markFailed` calls only run afterward, back on MainActor, so a separate poll is
        // needed here (unlike the assertion above, which reads the same recorder the failure record
        // itself lives on): without it, this can observe the SYNCHRONOUS `markRequested` mark before
        // the catch has had a chance to clear it.
        await officeWaitUntil(timeout: 2) { runtime.tileStore.inFlightCountForTesting == 0 }
        XCTAssertEqual(runtime.tileStore.keysNeedingRequest(docId: docId, candidates: keys), keys,
                       "the failed keys are requestable again once the catch clears them, not stuck in flight forever")

        // A subsequent subscribe, now with a healthy driver, must actually re-request them.
        office.recorder.requestTilesShouldFail = false
        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)
        await officeWaitUntil(timeout: 2) { !office.recorder.requestCalls.isEmpty }
        XCTAssertEqual(Set(office.recorder.requestCalls[0].keys), Set(keys))
        try? FileManager.default.removeItem(atPath: aPath)
    }

    /// T6 re-review's own empirical proof, made permanent: gate the first `requestTiles` mid-flight,
    /// fire a second, overlapping `subscribeTiles` for the identical viewport before the first's
    /// round trip resolves, and confirm only ONE `requestTiles` call ever fires for the shared keys.
    /// Under the shape this replaces (mark in-flight only after a successful send), the second
    /// subscribe's own `keysNeedingRequest` would still see these keys as unrequested while the first
    /// sits gated, and issue a genuine duplicate — this is exactly what the reviewer measured to
    /// prove the round-1 fix reopened obligation 3's "big-batch amplifier."
    func testOverlappingSubscribesRacingOneGatedSendIssueExactlyOneRequestForTheSharedKeys() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        runtime.open(aPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[aPath] != nil }
        let docId = runtime.stateSnapshot.documents[aPath]!.docId
        let keys = [tileKey(0, 0), tileKey(1, 0)]
        office.recorder.subscribeReplies[docId] = keys
        office.recorder.suspendRequestTiles()

        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)
        // The gate holds `requestTiles` itself, not `markRequested` — which runs synchronously
        // BEFORE the gated call is even reached (program order, no `await` in between; see
        // `OfficeTileStore.markRequested`'s own doc). Waiting on the store here, rather than on the
        // recorder, is deliberate: it is the only observable signal available while the send sits
        // gated, and it is exactly the signal the second subscribe below depends on.
        await officeWaitUntil(timeout: 2) { runtime.tileStore.inFlightCountForTesting == 2 }

        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)
        // The second subscribe's own `subscribeTiles` round trip is NOT gated — only `requestTiles`
        // is — so it completes quickly regardless of the first call sitting parked, and with these
        // keys already marked in flight, its `needed` set is empty: no second `requestTiles` call is
        // even attempted, gated or otherwise.
        await officeWaitUntil(timeout: 2) { office.recorder.subscribeCalls.count == 2 }

        office.recorder.resumeRequestTiles()
        await officeWaitUntil(timeout: 2) { !office.recorder.requestCalls.isEmpty }
        XCTAssertEqual(office.recorder.requestCalls.count, 1,
                       "the second, overlapping subscribe must not issue a duplicate request for keys "
                       + "the first has already marked in flight")
        XCTAssertEqual(Set(office.recorder.requestCalls[0].keys), Set(keys))
        try? FileManager.default.removeItem(atPath: aPath)
    }

    // MARK: - office live-gate fix #3: whole-document tile residency's own door

    /// `prefetchTilesChunk` bypasses `subscribeTiles` entirely (the canvas already knows exactly
    /// which keys it wants — see that method's own header) but reaches the SAME `requestTiles` wire
    /// call and the SAME store filtering/marking as `.subscribe`'s own effect, since both now share
    /// `requestNeeded` internally.
    func testPrefetchTilesChunkRequestsExactlyItsGivenKeysBypassingSubscribeTiles() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        runtime.open(aPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[aPath] != nil }
        let docId = runtime.stateSnapshot.documents[aPath]!.docId
        let keys = [tileKey(0, 0), tileKey(1, 0)]

        await runtime.prefetchTilesChunk(path: aPath, keys: keys)

        XCTAssertEqual(office.recorder.subscribeCalls.count, 0, "prefetch never calls subscribeTiles")
        XCTAssertEqual(office.recorder.requestCalls.count, 1)
        XCTAssertEqual(office.recorder.requestCalls[0].docId, docId)
        XCTAssertEqual(Set(office.recorder.requestCalls[0].keys), Set(keys))
        XCTAssertEqual(runtime.tileStore.inFlightCountForTesting, 2)
        try? FileManager.default.removeItem(atPath: aPath)
    }

    /// The store-filtering half: a key already cached, or already requested by an ordinary
    /// `subscribeTiles`-driven ask, must not be re-requested by an overlapping prefetch chunk — the
    /// SAME `requestNeeded`/`keysNeedingRequest` discipline `.subscribe`'s own tests already pin,
    /// extended to prove the TWO call paths (ordinary subscribe and prefetch) share it correctly.
    func testPrefetchTilesChunkSkipsKeysAlreadyCachedOrInFlightFromAnOrdinarySubscribe() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        runtime.open(aPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[aPath] != nil }
        let docId = runtime.stateSnapshot.documents[aPath]!.docId
        let (k0, k1, k2) = (tileKey(0, 0), tileKey(1, 0), tileKey(0, 1))
        office.recorder.subscribeReplies[docId] = [k0]

        runtime.subscribeTiles(path: aPath, part: 0, zoomPPT: 1000, viewportTwips: sampleViewport)
        await officeWaitUntil(timeout: 2) { office.recorder.requestCalls.count == 1 }
        XCTAssertEqual(Set(office.recorder.requestCalls[0].keys), [k0])

        // A prefetch chunk covering k0 (already in flight from the ordinary subscribe above), k1
        // (genuinely new) and k2 (genuinely new) must only request the two new ones.
        await runtime.prefetchTilesChunk(path: aPath, keys: [k0, k1, k2])

        XCTAssertEqual(office.recorder.requestCalls.count, 2, "one call from the subscribe, one from the prefetch chunk")
        XCTAssertEqual(Set(office.recorder.requestCalls[1].keys), [k1, k2],
                       "k0 is already in flight — the prefetch chunk must not re-request it")
        try? FileManager.default.removeItem(atPath: aPath)
    }

    /// A prefetch chunk for a path with no open document (closed, or never opened) is a harmless
    /// no-op — mirrors `.subscribeRequested`'s own `documents[path] != nil` guard, since a reload or
    /// close can land between a canvas's prefetch chunks (`OfficeRuntime.prefetchTilesChunk`'s own doc).
    func testPrefetchTilesChunkForAnUnopenedPathIsAHarmlessNoOp() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")

        await runtime.prefetchTilesChunk(path: "/never-opened.xlsx", keys: [tileKey(0, 0)])

        XCTAssertTrue(office.recorder.requestCalls.isEmpty)
    }

    /// The routing half of tile delivery (`ShellSessionHost.officeRuntime(owning:)`) — a linear scan
    /// by docId, deliberately not a maintained reverse index (see that method's own doc). Exercised
    /// directly here since the closures that CALL it (`wireOfficeTileCallbacks`) only ever fire off
    /// a real `OfficeHelperClient`'s pushes — proven end to end, live, in `OfficeRuntimeLiveTests`.
    func testOfficeRuntimeOwningDocIdFindsTheRuntimeThatHoldsIt() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let r1 = host.officeRuntime(for: "S1")
        let r2 = host.officeRuntime(for: "S2")
        let aPath = makeScratchOfficePath("a")
        let bPath = makeScratchOfficePath("b")
        r1.open(aPath)
        r2.open(bPath)
        await officeWaitUntil(timeout: 2) {
            r1.stateSnapshot.documents[aPath] != nil && r2.stateSnapshot.documents[bPath] != nil
        }
        let docIdA = r1.stateSnapshot.documents[aPath]!.docId
        let docIdB = r2.stateSnapshot.documents[bPath]!.docId

        XCTAssertTrue(host.officeRuntime(owning: docIdA) === r1)
        XCTAssertTrue(host.officeRuntime(owning: docIdB) === r2)
        XCTAssertNil(host.officeRuntime(owning: "no-such-doc"))
        try? FileManager.default.removeItem(atPath: aPath)
        try? FileManager.default.removeItem(atPath: bPath)
    }

    /// Store hygiene: a helper death must clear EVERY runtime's tile store, not just the one that
    /// happened to trigger it — `OfficeRuntime.handle(supervisorEvent:)`'s own `.helperDied`/
    /// `.helperUnavailable` cases, mirroring the reducer's own "every runtime, every phase" fan-out
    /// (see `OfficeRuntimeState.Phase`'s doc).
    func testHelperDeathEvictsEveryRuntimesTileStore() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let r1 = host.officeRuntime(for: "S1")
        let r2 = host.officeRuntime(for: "S2")
        let aPath = makeScratchOfficePath("a")
        let bPath = makeScratchOfficePath("b")
        r1.open(aPath)
        r2.open(bPath)
        await officeWaitUntil(timeout: 2) {
            r1.stateSnapshot.documents[aPath] != nil && r2.stateSnapshot.documents[bPath] != nil
        }
        let docIdA = r1.stateSnapshot.documents[aPath]!.docId
        let docIdB = r2.stateSnapshot.documents[bPath]!.docId
        r1.tileStore.ingest(docId: docIdA, key: tileKey(0, 0), generation: 0, pixels: Data([1]))
        r2.tileStore.ingest(docId: docIdB, key: tileKey(0, 0), generation: 0, pixels: Data([2]))
        XCTAssertEqual(r1.tileStore.cachedCountForTesting, 1)
        XCTAssertEqual(r2.tileStore.cachedCountForTesting, 1)

        host.broadcastOfficeHelperEvent(.helperDied)

        XCTAssertEqual(r1.tileStore.cachedCountForTesting, 0, "S1's store is cleared too, not just S2's")
        XCTAssertEqual(r2.tileStore.cachedCountForTesting, 0)
        try? FileManager.default.removeItem(atPath: aPath)
        try? FileManager.default.removeItem(atPath: bPath)
    }

    /// A document close must release its own tiles from the store — `OfficeRuntime.perform`'s
    /// `.helperClose` case — without touching a DIFFERENT document's cached pixels.
    func testClosingADocumentEvictsOnlyItsOwnTilesFromTheStore() async {
        let (host, _) = makeHost()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        let runtime = host.officeRuntime(for: "S1")
        let aPath = makeScratchOfficePath("a")
        let bPath = makeScratchOfficePath("b")
        runtime.open(aPath)
        runtime.open(bPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents.count == 2 }
        let docIdA = runtime.stateSnapshot.documents[aPath]!.docId
        let docIdB = runtime.stateSnapshot.documents[bPath]!.docId
        runtime.tileStore.ingest(docId: docIdA, key: tileKey(0, 0), generation: 0, pixels: Data([1]))
        runtime.tileStore.ingest(docId: docIdB, key: tileKey(0, 0), generation: 0, pixels: Data([2]))

        runtime.close(aPath)

        XCTAssertNil(runtime.tileStore.tile(docId: docIdA, key: tileKey(0, 0)), "a.xlsx's tile is gone")
        XCTAssertNotNil(runtime.tileStore.tile(docId: docIdB, key: tileKey(0, 0)), "b.xlsx's tile is untouched")
        // Hygiene, not an assertion (mirrors `testTeardownOfficeRuntimeRemovesItFromTheTableAnd
        // ClosesEveryOpenDocument`'s own comment): let the fire-and-forget close settle before this
        // test returns, so nothing is left orphaned to touch `office.recorder` (an `[unowned self]`
        // closure struct) after `officeDoubles` releases it in `tearDown`.
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        try? FileManager.default.removeItem(atPath: aPath)
        try? FileManager.default.removeItem(atPath: bPath)
    }

    // MARK: - office-plumbing Task 6: the document door — mirrors `openFileTab`'s own wire-level
    // proofs, at the smaller set this door actually needs (path resolution is `resolvedFilePath`'s
    // own, already-pinned proof; this is about the `.document` kind and the retry obligation).

    /// **Mint: one `panel.openTab`, kind `document`, carrying the absolute path and basename — and
    /// the panel is revealed.** Mirrors `testAFileDoorClickWithNoExistingTabMintsACodeTabWith
    /// AbsolutePathAndBasenameAndRevealsThePanel`.
    func testADocumentDoorClickWithNoExistingTabMintsADocumentTabAndRevealsThePanel() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openDocumentTab("/repo/gate.xlsx", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("a document-door click with nothing open must mint a tab: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "S1")
        XCTAssertEqual(params?["kind"] as? String, "document")
        XCTAssertEqual(params?["url"] as? String, "/repo/gate.xlsx")
        XCTAssertEqual(params?["title"] as? String, "gate.xlsx")
        XCTAssertNil(params?["diffId"])
        XCTAssertEqual(revealed, 1, "a tab nobody can see is not an opened document")
    }

    /// **The second click: `panel.activateTab`, no second mint.** Mirrors `testASecondFileDoorClick
    /// OnTheSamePathActivatesInsteadOfMintingASecondTab`.
    func testASecondDocumentDoorClickOnTheSamePathActivatesInsteadOfMintingASecondTab() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t7", kind: .document, url: "/repo/gate.xlsx", title: "gate.xlsx")],
            activeTabId: nil)

        host.openDocumentTab("/repo/gate.xlsx", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        guard let activate = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.activateTab" }) else {
            return XCTFail("a document door click for an already-open path must activate it: \(mgmt.methods)")
        }
        XCTAssertEqual((activate["params"] as? [String: Any])?["tabId"] as? String, "t7")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(mgmt.methods.filter { $0 == "panel.openTab" }.count, 0,
                       "one tab per document — a second click must never mint: \(mgmt.methods)")
    }

    /// **The retry obligation**: an existing tab whose path currently sits in the runtime's
    /// `openFailures` gets a fresh `open()` alongside the activate — mirrors editor's own HANDOFFS
    /// obligation (`openFileTab`'s doc), applied to `OfficeRuntime.open` instead of
    /// `EditorRuntime.openFile` (no `Task` needed here: `OfficeRuntime.open` is not `async`).
    ///
    /// Office Stage B Task 2b: the failure this test drills is now staged at a REAL scratch path
    /// that genuinely doesn't exist yet, not a driver-level stub keyed by path — post-staging, the
    /// driver only ever observes the STAGED path (a UUID-derived name under the recorder's
    /// `stateDirectory`), so a `openFailures[realPath]` dictionary on the recorder is structurally
    /// unreachable (see the recorder's own doc on `failNextOpenReason`, which replaces it). This is
    /// in fact a MORE representative drill than the old stub: it is this file's first coverage of
    /// the staging-failure branch of `openAndDispatch`'s catch block (the "stage itself failed"
    /// half of its own doc comment), not just the "wire `open` failed" half.
    func testActivatingATabWhosePathIsInOpenFailuresAlsoRetriesTheOpen() async {
        // **No `select`/`deselect` here, deliberately** (unlike this section's other two document-
        // door tests): `openDocumentTab` reaches `openPanelTab`'s EXPLICIT `sessionId:` door, which
        // needs no attachment at all (`ShellSessionHost.openPanelTab`'s own doc). This test's own
        // retry SUCCEEDS (the file gets created before the retry), which means the runtime holds a
        // genuinely open document by the time this function returns — a `defer { host.deselect() }`
        // here would fire `releaseOfficeRuntimeIfClean`'s ALWAYS-release policy (Stage A office tabs
        // are never dirty) synchronously, spawning a NEW fire-and-forget `driver.close` `Task` this
        // test has no `await` point left to settle before `officeDoubles` releases the recorder in
        // `tearDown` — exactly the unowned-reference crash class this file's own recorder doc warns
        // about. Simplest fix: nothing here needs an attach at all.
        let (host, _, mgmt) = await makeHostWithManagement()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make

        let badPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("bad-\(UUID().uuidString).xlsx").path
        // Deliberately NOT created yet — staging (`copyfile`) fails before the driver's `open` is
        // ever reached, a genuine "garbage/missing file" rather than a simulated one.
        let runtime = host.officeRuntime(for: "S1")
        runtime.open(badPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.openFailures[badPath] != nil }
        try? Data().write(to: URL(fileURLWithPath: badPath)) // "the file got fixed"

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t9", kind: .document, url: badPath, title: "bad.xlsx")],
            activeTabId: nil)

        host.openDocumentTab(badPath, sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[badPath] != nil }
        XCTAssertNotNil(runtime.stateSnapshot.documents[badPath],
                        "the retry, now that the file genuinely exists, must reach a genuinely open document")
        XCTAssertEqual(office.recorder.openCalls.count, 1,
                       "only the SUCCEEDING retry ever reaches the driver — the first attempt failed at staging, before the wire open")
        // Hygiene, not an assertion: the retry SUCCEEDS, so this runtime now holds a genuinely open
        // document — release it explicitly and wait for the resulting close to settle, rather than
        // leaving it for a test-ending `deselect()` this test deliberately does not call (see the
        // header comment on why that would be unsafe here).
        host.teardownOfficeRuntime(for: "S1")
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        try? FileManager.default.removeItem(atPath: badPath)
    }

    /// **`closePanelTab`'s own new leg**: closing a `.document` tab must reach the runtime's own
    /// `close(path)` — unconditionally, unlike `.code` (gated by `requestCloseTab`; Stage A documents
    /// are never dirty, so there is nothing here for a gate to protect — see `closePanelTab`'s own
    /// comment). Unlike the retry test above, `select`/`deselect` IS safe here: by the time `defer {
    /// host.deselect() }` fires, this test has already awaited the close to completion, so the
    /// runtime's `documents` is empty and `deselect`'s own `releaseOfficeRuntimeIfClean` -> `teardown`
    /// walks zero docIds — no second close `Task` to leave dangling.
    func testClosingADocumentTabReachesTheRuntimesOwnCloseDoor() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        let runtime = host.officeRuntime(for: "S1")
        let gatePath = makeScratchOfficePath("gate")
        runtime.open(gatePath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[gatePath] != nil }
        let docId = runtime.stateSnapshot.documents[gatePath]!.docId

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t1", kind: .document, url: gatePath, title: "gate.xlsx")],
            activeTabId: nil)

        host.closePanelTab("t1")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        XCTAssertEqual(office.recorder.closeCalls, [docId])
        XCTAssertTrue(runtime.stateSnapshot.documents.isEmpty, "the reducer's own close removed the entry")
        try? FileManager.default.removeItem(atPath: gatePath)
    }

    /// A `.code` tab whose `url` happens to equal an open document's path must NOT trigger an office
    /// close — the kind filter (`tab.kind == .document`) is load-bearing, mirroring
    /// `panelDocumentTabAction`'s own identical guard against a coincidentally-matching `.code` tab.
    /// This test tears down explicitly (not via `deselect`) since the document is DELIBERATELY still
    /// open when the assertion runs — see the header comment on the test above for why that ordering
    /// matters for safety, not just tidiness.
    func testClosingANonDocumentTabNeverReachesTheOfficeCloseDoor() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        let runtime = host.officeRuntime(for: "S1")
        let gatePath = makeScratchOfficePath("gate")
        runtime.open(gatePath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.documents[gatePath] != nil }

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t1", kind: .code, url: gatePath, title: "gate.xlsx")],
            activeTabId: nil)

        host.closePanelTab("t1")
        await feedWaitUntil { mgmt.methods.contains("panel.closeTab") }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(office.recorder.closeCalls.count, 0, "a same-path .code tab must not close the document")

        // Hygiene: the document this test opened is still open — release it explicitly, then
        // deselect (nothing left for it to close, so it is safe here too).
        host.teardownOfficeRuntime(for: "S1")
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        host.deselect()
        try? FileManager.default.removeItem(atPath: gatePath)
    }

    // MARK: - office-plumbing Task 7: the ONE router both UI doors call

    /// **Mint, office extension → `.document`.** Mirrors `testADocumentDoorClickWithNoExistingTab
    /// MintsADocumentTabAndRevealsThePanel`, through the router instead of `openDocumentTab` directly
    /// — proves the router's OWN dispatch decision, not merely that the underlying door still works.
    func testTheRouterMintsADocumentTabForAnOfficeExtensionAndRevealsThePanel() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, factory, mgmt) = await makeHostWithManagement(rows: rows)
        defer { host.deselect() }
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        var revealed = 0
        host.onRevealPanel = { revealed += 1 }

        host.openFileOrDocumentTab("/repo/gate.xlsx", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("the router must reach the wire for an office extension: \(mgmt.methods)")
        }
        let params = open["params"] as? [String: Any]
        XCTAssertEqual(params?["kind"] as? String, "document")
        XCTAssertEqual(params?["url"] as? String, "/repo/gate.xlsx")
        XCTAssertEqual(revealed, 1)
    }

    /// **Mint, code extension → `.code`.** The router's negative case: an ordinary source file must
    /// keep opening exactly as it did before this task existed.
    func testTheRouterMintsACodeTabForACodeExtension() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.openFileOrDocumentTab("/repo/src/engine.ts", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("the router must reach the wire for a code extension: \(mgmt.methods)")
        }
        XCTAssertEqual((open["params"] as? [String: Any])?["kind"] as? String, "code")
    }

    /// **Mint, unrecognized extension → `.code`.** The editor's own established fallback — a file
    /// this router does not specifically recognize as office still opens exactly as before.
    func testTheRouterMintsACodeTabForAnUnrecognizedExtension() async {
        let (host, factory, mgmt) = await makeHostWithManagement()
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "S1")

        host.openFileOrDocumentTab("/repo/whatever.foo", sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.openTab") }
        guard let open = mgmt.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "panel.openTab" }) else {
            return XCTFail("the router must reach the wire for an unrecognized extension: \(mgmt.methods)")
        }
        XCTAssertEqual((open["params"] as? [String: Any])?["kind"] as? String, "code")
    }

    /// **The fire-time belt, at the wire**: a dirless session's office click through the router must
    /// mint NOTHING — the belt refuses before `openDocumentTab` (and therefore `openPanelTab`) is
    /// ever reached. `openFileOrDocumentTab`'s own doc names the race this guards: a session hop
    /// landing between the transcript's render-time gate and an in-flight click.
    func testTheRouterRefusesToMintADocumentTabWhenTheSessionHasNoWorkingDirectory() async {
        let rows = [codeRow("S1", dirs: [])]
        let (host, _, mgmt) = await makeHostWithManagement(rows: rows)
        await host.directory.refresh()

        host.openFileOrDocumentTab("/repo/gate.xlsx", sessionId: "S1")
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertFalse(mgmt.methods.contains("panel.openTab"),
                       "a dirless session must never mint an office document tab: \(mgmt.methods)")
    }

    /// **The retry obligation survives the router**: an existing document tab whose path currently
    /// sits in the runtime's `openFailures` still gets a fresh `open()` alongside the activate when
    /// reached through `openFileOrDocumentTab` — proves the router's `.document` branch delegates to
    /// the real door rather than reimplementing a thinner version of it. Hygiene mirrors
    /// `testActivatingATabWhosePathIsInOpenFailuresAlsoRetriesTheOpen` exactly (that test's own doc
    /// explains why: this retry SUCCEEDS, leaving a genuinely open document, so `select`/`deselect`
    /// would spawn an unawaited close `Task` — no attach is needed here either, `openPanelTab`'s
    /// explicit `sessionId:` door).
    ///
    /// Office Stage B Task 2b: unlike the sibling test above, THIS drill specifically wants the
    /// DRIVER invoked twice (proving the retry reaches the real door a second time, not just that
    /// the reducer's own state recovers) — so the failure here must be at the wire-open layer, not
    /// staging. The file exists for real on both attempts; `failNextOpenReason` makes only the
    /// FIRST driver-level open fail, mirroring what `openFailures["/repo/bad.xlsx"] = "garbage
    /// file"` used to simulate before staging made a path-keyed driver stub unreachable (see the
    /// recorder's own doc on why).
    func testTheRouterRetriesAFailedOfficeOpenOnActivateThroughTheSameDoorOpenDocumentTabUses() async {
        let rows = [codeRow("S1", dirs: [SessionDirEntry(path: "/repo", locked: false)])]
        let (host, _, mgmt) = await makeHostWithManagement(rows: rows)
        await host.directory.refresh()
        let office = officeFactory()
        host.makeOfficeRuntime = office.make

        let badPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("bad-\(UUID().uuidString).xlsx").path
        try? Data().write(to: URL(fileURLWithPath: badPath)) // exists for real on BOTH attempts
        let runtime = host.officeRuntime(for: "S1")
        office.recorder.failNextOpenReason = "garbage file" // consumed by the FIRST open only
        runtime.open(badPath)
        await officeWaitUntil(timeout: 2) { runtime.stateSnapshot.openFailures[badPath] != nil }

        host.panelStore.applyFetchedSnapshot(
            sessionId: "S1",
            tabs: [PanelTab(tabId: "t9", kind: .document, url: badPath, title: "bad.xlsx")],
            activeTabId: nil)

        host.openFileOrDocumentTab(badPath, sessionId: "S1")
        await feedWaitUntil { mgmt.methods.contains("panel.activateTab") }
        await officeWaitUntil(timeout: 2) { office.recorder.openCalls.count == 2 }
        XCTAssertEqual(office.recorder.openCalls.count, 2,
                       "the first (failed-at-the-driver) open plus the retry from re-clicking through the router")
        XCTAssertTrue(office.recorder.openCalls.allSatisfy { $0.path.hasPrefix(office.recorder.stateDirectory.path) },
                      "both opens carry a STAGED path, never \(badPath) itself: \(office.recorder.openCalls)")

        // Hygiene, not an assertion: the retry SUCCEEDS, so this runtime now holds a genuinely open
        // document — release it explicitly and wait for the resulting close to settle.
        host.teardownOfficeRuntime(for: "S1")
        await officeWaitUntil(timeout: 2) { office.recorder.closeCalls.count == 1 }
        try? FileManager.default.removeItem(atPath: badPath)
    }
}
