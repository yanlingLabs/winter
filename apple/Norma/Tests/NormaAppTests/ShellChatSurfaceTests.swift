import XCTest
import NormaKit
@testable import Norma

/// app-shell T3: the chat landing's row filter and the `/background` affordance — its visibility
/// rule (PURE), the wiring gate that keeps it off every pre-existing surface, and its RPC + verbatim
/// refusal on the wire.
@MainActor
final class ShellChatSurfaceTests: XCTestCase {
    private func rows() -> [SessionSummary] {
        [
            SessionSummary(sessionId: "s_chat_new", title: "Second chat", createdAt: 5, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_chat_old", title: nil, createdAt: 4, scope: "global", cwd: nil, mode: "chat"),
            SessionSummary(sessionId: "s_code", title: "Code", createdAt: 3, scope: "global", cwd: "/repo", mode: "code"),
            SessionSummary(sessionId: "s_absent", title: "Absent mode", createdAt: 2, scope: "global", cwd: "/repo", mode: nil),
            SessionSummary(sessionId: "s_dispatch", title: "Dispatch", createdAt: 1, scope: "global", cwd: nil, mode: "dispatch"),
            SessionSummary(sessionId: "s_future", title: "Future", createdAt: 0, scope: "global", cwd: nil, mode: "quantum"),
        ]
    }

    // MARK: - The landing list's filter (PURE)

    /// The chat landing lists chat rows and nothing else, in the directory's own (newest-first)
    /// order.
    func testChatLandingListsOnlyChatRows() {
        let listed = sessionRows(for: .chat, in: rows()).map(\.sessionId)
        XCTAssertEqual(listed, ["s_chat_new", "s_chat_old"])
    }

    /// The wire's two conventions, both landing on `.code` and therefore on the CODE landing (T4),
    /// never on chat's: an ABSENT mode is a plain code session, and an unknown future mode degrades
    /// to code rather than vanishing from every list.
    func testAbsentAndUnknownModesBelongToTheCodeLanding() {
        let code = sessionRows(for: .code, in: rows()).map(\.sessionId)
        XCTAssertEqual(code, ["s_code", "s_absent", "s_future"])
        XCTAssertEqual(sessionRows(for: .dispatch, in: rows()).map(\.sessionId), ["s_dispatch"])
        XCTAssertTrue(sessionRows(for: .cowork, in: rows()).isEmpty)
    }

    // MARK: - The empty-state copy (PURE) — App shell T6 review fix

    /// The empty state must name the ACTUAL create door — "New Chat" (`AppDelegate.newChat()`),
    /// not "Chat" (which only browses this landing since App shell T6's retarget). The first
    /// retarget pass briefly left this copy pointed at the wrong entry; pinned directly so it can't
    /// silently drift again.
    func testChatLandingEmptyStateNamesTheActualCreateDoor() {
        XCTAssertEqual(chatLandingEmptyStateSubtitle, "Start one from the menu bar's New Chat entry.")
        XCTAssertTrue(chatLandingEmptyStateSubtitle.contains("New Chat"), "must name the entry that actually creates a session")
        XCTAssertFalse(chatLandingEmptyStateSubtitle.contains("'s Chat entry"), "must not name the browse-only \"Chat\" entry as if it created something")
    }

    // MARK: - The `/background` verb's visibility (PURE)

    /// The daemon's own rules, mirrored: a participating session offers the verb that moves it,
    /// a non-participating one offers none, and ARCHIVED offers none either — both background verbs
    /// are refused on an archived session ("session is archived — resume it first"), so the only
    /// honest affordance there is the Archived tab's resume, which is T4's.
    func testBackgroundVerbOfferedPerActivity() {
        XCTAssertEqual(backgroundVerbOffered(activity: "active"), .background)
        XCTAssertEqual(backgroundVerbOffered(activity: "idle"), .background)
        XCTAssertEqual(backgroundVerbOffered(activity: "background"), .unbackground)
        XCTAssertNil(backgroundVerbOffered(activity: "archived"), "archived is immutable except through resume")
        XCTAssertNil(backgroundVerbOffered(activity: nil), "a chat/dispatch row has no lifecycle at all")
        XCTAssertNil(backgroundVerbOffered(activity: "teleporting"), "an unknown future state is not a licence to guess")
    }

    /// The wire strings are the daemon's vocabulary verbatim — `session.setActivity` accepts exactly
    /// these, and a label is never what reaches the wire.
    func testBackgroundVerbWireStrings() {
        XCTAssertEqual(BackgroundVerb.background.rawValue, "background")
        XCTAssertEqual(BackgroundVerb.unbackground.rawValue, "unbackground")
        for verb in [BackgroundVerb.background, .unbackground] {
            XCTAssertFalse(backgroundVerbLabel(verb).isEmpty)
            XCTAssertFalse(backgroundVerbExplanation(verb).isEmpty)
        }
    }

    /// Unknown values render VERBATIM rather than being coerced into a familiar word — the same
    /// "the daemon said it, so show it" posture the refusal sentences get.
    func testActivityDisplayLabel() {
        XCTAssertEqual(activityDisplayLabel("active"), "Active")
        XCTAssertEqual(activityDisplayLabel("background"), "Background")
        XCTAssertEqual(activityDisplayLabel("archived"), "Archived")
        XCTAssertEqual(activityDisplayLabel("teleporting"), "teleporting")
        XCTAssertEqual(activityDisplayLabel(nil), "—")
    }

    /// THE COMPATIBILITY GATE: the affordance is opt-in through `FieldStateAdapter.onSetActivity`,
    /// which every pre-existing surface leaves nil — so the orb's morph window and every detached
    /// window render no button no matter what the row says, and only a surface that can actually
    /// service the verb grows one.
    func testTheAffordanceIsOptInPerSurface() {
        let adapter = FieldStateAdapter(session: SessionModel())
        XCTAssertNil(adapter.onSetActivity, "no pre-existing surface wires this — the default is no affordance")
        XCTAssertFalse(adapter.activityChangeInFlight)
        XCTAssertNil(adapter.activityRefusal)
    }

    // MARK: - The verb on the wire (through the real host)

    private func makeHost(rows: [SessionSummary]) -> (host: ShellSessionHost, factory: ShellTransportFactory) {
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

    private func attachedHost(_ sessionId: String, rows: [SessionSummary]) async -> (ShellSessionHost, ShellScriptedTransport) {
        let (host, factory) = makeHost(rows: rows)
        await host.directory.refresh()
        host.setShellVisible(true)
        host.select(sessionId)
        let deadline = Date().addingTimeInterval(3)
        while factory.made.isEmpty && Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
        let t = factory.made[0]
        await feedWaitUntil { t.sent.count >= 1 }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await feedWaitUntil { t.sent.count >= 2 }
        let attach = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        return (host, t)
    }

    /// The shell's affordance fires `session.setActivity` against the session it is SHOWING, with
    /// the verb verbatim.
    func testBackgroundVerbReachesTheWireForTheShownSession() async {
        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: "/repo", mode: "code", activity: "active")]
        let (host, t) = await attachedHost("S1", rows: rows)
        defer { host.deselect() }

        guard let adapter = host.attachment?.adapter else { return XCTFail("an attached shell must have an adapter") }
        XCTAssertNotNil(adapter.onSetActivity, "the shell is the surface that wires the verb")
        adapter.onSetActivity?(BackgroundVerb.background.rawValue)

        await feedWaitUntil { t.methods.contains("session.setActivity") }
        guard let call = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setActivity" }) else {
            return XCTFail("the verb never reached the wire: \(t.methods)")
        }
        XCTAssertEqual((call["params"] as? [String: Any])?["sessionId"] as? String, "S1")
        XCTAssertEqual((call["params"] as? [String: Any])?["activity"] as? String, "background")
        XCTAssertTrue(adapter.activityChangeInFlight, "the affordance disables while the write is in flight")

        t.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"result":{"ok":true,"activity":"background"}}"#)
        await feedWaitUntil { adapter.activityChangeInFlight == false }
        XCTAssertNil(adapter.activityRefusal)
    }

    /// A refusal is shown VERBATIM — the daemon's sentence names the rule it enforced, and this is
    /// the seam where a client-side "couldn't change that" would erase it.
    func testRefusalSurfacesTheDaemonsSentenceVerbatim() async {
        let rows = [SessionSummary(sessionId: "S1", title: nil, createdAt: 1, scope: "global", cwd: "/repo", mode: "code", activity: "active")]
        let (host, t) = await attachedHost("S1", rows: rows)
        defer { host.deselect() }
        guard let adapter = host.attachment?.adapter else { return XCTFail("an attached shell must have an adapter") }

        adapter.onSetActivity?(BackgroundVerb.background.rawValue)
        await feedWaitUntil { t.methods.contains("session.setActivity") }
        guard let call = t.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setActivity" }) else {
            return XCTFail("the verb never reached the wire")
        }
        t.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"error":{"code":-32602,"message":"session is archived — resume it first"}}"#)

        await feedWaitUntil { adapter.activityRefusal != nil }
        XCTAssertEqual(adapter.activityRefusal, "session is archived — resume it first")
        XCTAssertFalse(adapter.activityChangeInFlight)
    }
}
