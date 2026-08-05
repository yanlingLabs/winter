import XCTest
import NormaKit
@testable import Norma

/// app-shell T4: the code landing — tabs/chips (PURE), and the roster verbs + create flow (through
/// the real `ShellSessionHost`, on the wire). Reuses `ShellSessionHostTests`' `ShellScriptedTransport`/
/// `ShellTransportFactory` (same test target, `internal` by default) rather than a third copy.
@MainActor
final class ModeLandingViewTests: XCTestCase {
    private func rows() -> [SessionSummary] {
        [
            SessionSummary(sessionId: "s_active", title: "Active one", createdAt: 5, scope: "global", cwd: "/repo", mode: "code", activity: "active"),
            SessionSummary(sessionId: "s_idle", title: "Idle one", createdAt: 4, scope: "global", cwd: "/repo", mode: "code", activity: "idle"),
            SessionSummary(sessionId: "s_bg", title: "Background one", createdAt: 3, scope: "global", cwd: "/repo", mode: "code", activity: "background"),
            SessionSummary(sessionId: "s_archived", title: "Archived one", createdAt: 2, scope: "global", cwd: "/repo", mode: "code", activity: "archived"),
            SessionSummary(sessionId: "s_chat", title: "A chat", createdAt: 1, scope: "global", cwd: nil, mode: "chat", activity: nil),
        ]
    }

    // MARK: - Tabs (PURE)

    func testEveryTabHasANonEmptyTitle() {
        for tab in LandingTab.allCases {
            XCTAssertFalse(tab.title.isEmpty, "\(tab) needs a title")
        }
    }

    /// The hidden-by-default ruling: `.all` never surfaces an archived row.
    func testAllTabExcludesArchived() {
        let listed = landingTabRows(.all, in: rows()).map(\.sessionId)
        XCTAssertEqual(Set(listed), ["s_active", "s_idle", "s_bg", "s_chat"])
        XCTAssertFalse(listed.contains("s_archived"))
    }

    func testBackgroundTabListsOnlyBackgroundRows() {
        XCTAssertEqual(landingTabRows(.background, in: rows()).map(\.sessionId), ["s_bg"])
    }

    func testArchivedTabListsOnlyArchivedRows() {
        XCTAssertEqual(landingTabRows(.archived, in: rows()).map(\.sessionId), ["s_archived"])
    }

    /// Roster verbs (stop / background⇄clear / archive) render ONLY on the Background tab — never
    /// on Archived (resume-by-click is its only exit) and never on All.
    func testRosterVerbsOfferedOnlyOnTheBackgroundTab() {
        XCTAssertFalse(landingTabOffersRosterVerbs(.all))
        XCTAssertTrue(landingTabOffersRosterVerbs(.background))
        XCTAssertFalse(landingTabOffersRosterVerbs(.archived))
    }

    /// T3's carried ruling: the Archived tab's row SAYS what clicking does ("Resume") rather than
    /// repeating the chip's "Archived" state — every other tab keeps the chip.
    func testResumeAffordanceShowsOnlyOnTheArchivedTab() {
        XCTAssertFalse(landingRowShowsResumeAffordance(.all))
        XCTAssertFalse(landingRowShowsResumeAffordance(.background))
        XCTAssertTrue(landingRowShowsResumeAffordance(.archived))
    }

    /// Shared with `ShellSidebar`'s Recents list (T3 review as-m10, this task's carried ruling): an
    /// ordinary click must never reach — and so never silently un-archive — an archived session.
    func testExcludingArchivedDropsOnlyArchivedRows() {
        let kept = excludingArchived(rows()).map(\.sessionId)
        XCTAssertEqual(Set(kept), ["s_active", "s_idle", "s_bg", "s_chat"])
    }

    // MARK: - Chips (PURE)

    func testActivityChipStylePerKnownValue() {
        XCTAssertEqual(activityChipStyle("active"), .active)
        XCTAssertEqual(activityChipStyle("background"), .background)
        XCTAssertEqual(activityChipStyle("idle"), .idle)
        XCTAssertEqual(activityChipStyle("archived"), .archived)
        XCTAssertEqual(activityChipStyle("teleporting"), .other, "an unknown future value still gets SOME style")
        XCTAssertNil(activityChipStyle(nil), "absent = no chip at all")
    }

    /// Chat rows never chip: `SessionSummary.activity` is `nil` for a non-participating mode
    /// (`ACTIVITY_MODES`), and this is the function that turns that absence into "render nothing".
    func testActivityChipLabelIsNilForAbsentAndVerbatimOtherwise() {
        XCTAssertNil(activityChipLabel(nil))
        XCTAssertEqual(activityChipLabel("active"), "Active")
        XCTAssertEqual(activityChipLabel("background"), "Background")
        XCTAssertEqual(activityChipLabel("idle"), "Idle")
        XCTAssertEqual(activityChipLabel("archived"), "Archived")
        XCTAssertEqual(activityChipLabel("teleporting"), "teleporting", "unknown values render verbatim, never coerced")
    }

    func testActivityChipColorPerStyle() {
        XCTAssertEqual(activityChipColor(.active), .green)
        XCTAssertEqual(activityChipColor(.background), .blue)
        XCTAssertEqual(activityChipColor(.idle), .secondary)
        XCTAssertEqual(activityChipColor(.archived), .secondary)
        XCTAssertEqual(activityChipColor(.other), .secondary)
    }

    // MARK: - Harness (roster verbs + create, through the real host)

    private func makeHost(rows: [SessionSummary] = [], managementClient: NormaClient? = nil) -> (host: ShellSessionHost, factory: ShellTransportFactory) {
        let factory = ShellTransportFactory()
        let directory = SessionDirectory(lister: { rows })
        let host = ShellSessionHost(
            directory: directory,
            makeFeed: { sessionId in
                let session = SessionModel()
                let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                       mode: .pinned(sessionId: sessionId), session: session)
                return (feed, session)
            },
            managementClient: managementClient
        )
        return (host, factory)
    }

    /// A connected `NormaClient` on its OWN scripted transport — standing in for `AppModel.client`,
    /// the always-open connection roster verbs and the create flow ride (see
    /// `ShellSessionHost.managementClient`'s doc).
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

    /// `session.interrupt` reaches the wire for the ROW's session, over the management connection —
    /// never `makeFeed`'s attaching harness (`factory.made` stays empty throughout).
    func testInterruptFromRosterReachesTheWireForTheGivenSession() async {
        let (client, transport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)

        host.interruptFromRoster("S2")
        XCTAssertTrue(host.rosterActionInFlight.contains("S2"))

        await feedWaitUntil { transport.methods.contains("session.interrupt") }
        guard let call = transport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.interrupt" }) else {
            return XCTFail("session.interrupt never reached the wire: \(transport.methods)")
        }
        XCTAssertEqual((call["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        transport.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"result":{"ok":true,"wasRunning":true}}"#)

        await feedWaitUntil { !host.rosterActionInFlight.contains("S2") }
        XCTAssertTrue(factory.made.isEmpty, "a roster verb must NEVER mint an attaching harness")
    }

    /// The background⇄clear verb, verbatim, and NO attach.
    func testSetActivityFromRosterBackgroundsTheGivenSessionVerbatim() async {
        let (client, transport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)

        host.setActivityFromRoster("S2", target: "background")
        await feedWaitUntil { transport.methods.contains("session.setActivity") }
        guard let call = transport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setActivity" }) else {
            return XCTFail("session.setActivity never reached the wire: \(transport.methods)")
        }
        XCTAssertEqual((call["params"] as? [String: Any])?["sessionId"] as? String, "S2")
        XCTAssertEqual((call["params"] as? [String: Any])?["activity"] as? String, "background")
        transport.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"result":{"ok":true,"activity":"background"}}"#)

        await feedWaitUntil { !host.rosterActionInFlight.contains("S2") }
        XCTAssertNil(host.rosterRefusals["S2"])
        XCTAssertTrue(factory.made.isEmpty, "a roster verb must NEVER mint an attaching harness — the archived-row un-archive-by-attach trap")
    }

    /// A refusal surfaces VERBATIM, keyed to that row only.
    func testSetActivityFromRosterRefusalSurfacesVerbatimPerRow() async {
        let (client, transport) = await connectedManagementClient()
        let (host, _) = makeHost(managementClient: client)

        host.setActivityFromRoster("S2", target: "archived")
        await feedWaitUntil { transport.methods.contains("session.setActivity") }
        guard let call = transport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.setActivity" }) else {
            return XCTFail("session.setActivity never reached the wire")
        }
        transport.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"error":{"code":-32602,"message":"stop or background it first"}}"#)

        await feedWaitUntil { host.rosterRefusals["S2"] != nil }
        XCTAssertEqual(host.rosterRefusals["S2"], "stop or background it first")
        XCTAssertFalse(host.rosterActionInFlight.contains("S2"))
    }

    /// The archived-tab's whole reason for existing: an accidental attach (`makeFeed`) instead of the
    /// bare `managementClient` RPC would clear the archive flag as a SIDE EFFECT of a "Stop"/"Archive"
    /// click on a row the user never asked to resume. This proves the wire call went out on the
    /// management connection while the attaching factory made nothing, for BOTH verbs.
    func testRosterActionsNeverMintAnAttachingHarness() async {
        let (client, transport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)

        host.interruptFromRoster("S_archived")
        host.setActivityFromRoster("S_archived", target: "archived")
        await feedWaitUntil { transport.methods.filter { $0 == "session.interrupt" || $0 == "session.setActivity" }.count >= 2 }

        XCTAssertTrue(factory.made.isEmpty, "no harness — and so no session.attach — was ever minted: \(factory.made.count)")
        XCTAssertFalse(transport.methods.contains("session.attach"), "the management connection itself never attaches either")
    }

    /// No `managementClient` (the default) — every roster method no-ops rather than crashing.
    func testRosterActionsNoOpWithoutAManagementClient() {
        let (host, factory) = makeHost()
        host.interruptFromRoster("S1")
        host.setActivityFromRoster("S1", target: "archived")
        XCTAssertTrue(host.rosterActionInFlight.isEmpty)
        XCTAssertTrue(host.rosterRefusals.isEmpty)
        XCTAssertTrue(factory.made.isEmpty)
    }

    // MARK: - Create flow (the T8-wd seam, reused)

    /// `createSession(with:onCreated:)` is the TESTABLE half `startNewSession`'s AppKit sheet feeds
    /// (same split as `DetachedWindowController.newSession()`/`startSession(with:)`). Rides
    /// `managementClient` — no harness is minted by creation itself; navigating onto the fresh id is
    /// the caller's job.
    func testCreateSessionReachesTheWireAndInvokesOnCreated() async {
        let (client, transport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)

        var created: String?
        host.createSession(with: .folder("/tmp/proj")) { created = $0 }

        await feedWaitUntil { transport.methods.contains("session.create") }
        guard let call = transport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("session.create never reached the wire: \(transport.methods)")
        }
        let params = call["params"] as? [String: Any]
        XCTAssertEqual(params?["cwd"] as? String, "/tmp/proj")
        XCTAssertEqual(params?["approvalPolicy"] as? String, "auto")
        transport.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"result":{"sessionId":"S_new","trusted":true}}"#)

        await feedWaitUntil { created != nil }
        XCTAssertEqual(created, "S_new")
        XCTAssertTrue(factory.made.isEmpty, "creating a session must not itself attach anything — navigating does")
    }

    /// "No folder (outputs only)" omits `cwd` entirely — not an empty string, not a fallback to home.
    func testCreateSessionOmitsCwdForNoFolder() async {
        let (client, transport) = await connectedManagementClient()
        let (host, _) = makeHost(managementClient: client)

        host.createSession(with: .noFolder) { _ in }
        await feedWaitUntil { transport.methods.contains("session.create") }
        guard let call = transport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.create" }) else {
            return XCTFail("session.create never reached the wire")
        }
        XCTAssertNil((call["params"] as? [String: Any])?["cwd"], "outputs-only must omit the cwd key entirely")
    }

    /// `startNewSession` needs a window to hang the sheet on (`presentingWindow`, injected by
    /// `AppWindowController` in production) — with none (every test's default), it simply does not
    /// fire, never crashes.
    func testStartNewSessionNoOpsWithoutAPresentingWindow() async {
        let (client, transport) = await connectedManagementClient()
        let (host, _) = makeHost(managementClient: client)
        XCTAssertNil(host.presentingWindow)

        let sentBeforehand = transport.sent.count
        host.startNewSession { _ in XCTFail("must never fire without a window to present on") }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(transport.sent.count, sentBeforehand, "nothing new reaches the wire without a presenting window")
    }
}
