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

    private func makeHost(rows: [SessionSummary] = []) -> (host: ShellSessionHost, factory: ShellTransportFactory) {
        let factory = ShellTransportFactory()
        let directory = SessionDirectory(lister: { rows })
        let host = ShellSessionHost(directory: directory, makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                   mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        })
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
}
