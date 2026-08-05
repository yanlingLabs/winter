import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// app-shell T5: the dispatch surface's own tests. Two families:
///  - PURE: `fleetCounts`/`fleetStripTapDestination`, driven directly.
///  - the wire: `ShellSessionHost.apply(destination: .mode(.dispatch))` resolving `session.dispatch`
///    over the bare management connection and attaching through the ordinary `select` door — reuses
///    `ShellSessionHostTests`'/`ModeLandingViewTests`' `ShellScriptedTransport`/`ShellTransportFactory`
///    (same test target, `internal` by default); `makeHost`/`connectedManagementClient`/
///    `waitUntilMade`/`answerHandshake` are each file's own small copy, the established per-file
///    convention (`ShellSessionHostTests`/`ModeLandingViewTests` already duplicate `makeHost` rather
///    than share it).
@MainActor
final class DispatchSurfaceTests: XCTestCase {
    // MARK: - Fleet strip (PURE)

    private func rows() -> [SessionSummary] {
        [
            SessionSummary(sessionId: "s_active_1", title: "One", createdAt: 5, scope: "global", cwd: "/repo", mode: "code", activity: "active"),
            SessionSummary(sessionId: "s_active_2", title: "Two", createdAt: 4, scope: "global", cwd: "/repo", mode: "code", activity: "active"),
            SessionSummary(sessionId: "s_bg", title: "Three", createdAt: 3, scope: "global", cwd: "/repo", mode: "code", activity: "background"),
            SessionSummary(sessionId: "s_idle", title: "Four", createdAt: 2, scope: "global", cwd: "/repo", mode: "code", activity: "idle"),
            SessionSummary(sessionId: "s_archived", title: "Five", createdAt: 1, scope: "global", cwd: "/repo", mode: "code", activity: "archived"),
            SessionSummary(sessionId: "s_chat", title: "Chat", createdAt: 0, scope: "global", cwd: nil, mode: "chat", activity: nil),
            SessionSummary(sessionId: "s_dispatch", title: "Dispatch", createdAt: -1, scope: "global", cwd: nil, mode: "dispatch", activity: nil),
        ]
    }

    func testFleetCountsCountRunningAndBackgroundOnly() {
        let counts = fleetCounts(rows())
        XCTAssertEqual(counts.running, 2, "only activity == active counts as running")
        XCTAssertEqual(counts.background, 1)
    }

    func testFleetCountsAreZeroForEmptyRows() {
        let counts = fleetCounts([])
        XCTAssertEqual(counts.running, 0)
        XCTAssertEqual(counts.background, 0)
    }

    /// Dispatch/chat rows carry no `activity` at all (`ACTIVITY_MODES`) — a directory of ONLY
    /// non-participating rows must count nothing, not crash, not miscount by falling back to `mode`.
    func testFleetCountsIgnoreNonParticipatingModes() {
        let onlyNonParticipating = [
            SessionSummary(sessionId: "c1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: "chat", activity: nil),
            SessionSummary(sessionId: "d1", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "dispatch", activity: nil),
        ]
        let counts = fleetCounts(onlyNonParticipating)
        XCTAssertEqual(counts.running, 0)
        XCTAssertEqual(counts.background, 0)
    }

    /// The design's "tapping a count navigates to… the code landing" — pinned as a decision, not
    /// left to whatever the button closure happens to call (`DispatchSurface.fleetCountButton`).
    func testFleetStripTapDestinationIsTheCodeLanding() {
        XCTAssertEqual(fleetStripTapDestination(), .mode(.code))
    }

    // MARK: - Harness (dispatch resolution, through the real host)

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
    /// the always-open connection `session.dispatch` (and the roster verbs/create flow) ride.
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

    private func waitUntilMade(_ f: ShellTransportFactory, _ n: Int, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while f.made.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(f.made.count, n, "timed out waiting for \(n) connections", file: file, line: line)
    }

    private func waitUntilSent(_ t: ShellScriptedTransport, _ n: Int, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)", file: file, line: line)
    }

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

    /// RED (pre-fix): `apply(destination: .mode(.dispatch))` used to fall into the plain `deselect()`
    /// branch, same as any other mode — no `session.dispatch` call, no attach, ever.
    ///
    /// The fix: `.mode(.dispatch)` resolves `session.dispatch` over the bare management connection,
    /// THEN attaches the resolved id through the ordinary `makeFeed` harness — the exact
    /// two-connection shape roster verbs/create already establish (a bare RPC to find/act,
    /// `makeFeed` only ever to attach).
    func testApplyDispatchDestinationResolvesAndAttaches() async {
        let (client, mgmtTransport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)
        defer { host.deselect() }
        host.setShellVisible(true)

        host.apply(destination: .mode(.dispatch))
        XCTAssertEqual(host.dispatchResolution, .resolving)

        await feedWaitUntil { mgmtTransport.methods.contains("session.dispatch") }
        guard let call = mgmtTransport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.dispatch" }) else {
            return XCTFail("session.dispatch never reached the wire: \(mgmtTransport.methods)")
        }
        mgmtTransport.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"result":{"sessionId":"s_dispatch","created":false}}"#)

        await feedWaitUntil { host.attachedSessionId != nil }
        XCTAssertEqual(host.selection, "s_dispatch")
        XCTAssertEqual(host.attachedSessionId, "s_dispatch")
        XCTAssertEqual(host.dispatchResolution, .idle, "resolved — attachedSessionId is the live answer now")

        await waitUntilMade(factory, 1)
        await answerHandshake(factory.made[0], sessionId: "s_dispatch")
        XCTAssertEqual(factory.made[0].attachmentMethods, ["protocol.hello", "session.attach"])
    }

    /// The race: navigating AWAY from `.mode(.dispatch)` before `session.dispatch` resolves must
    /// attach NOTHING when the stale response finally arrives — the exact "two doubles bracket the
    /// untested middle" class this app has hit before elsewhere (T2's poll-vs-fresh-transient race is
    /// the same shape). Proven by answering the RPC only AFTER the shell has already moved on.
    func testDispatchResolutionAbandonedByANavigationAwayNeverAttaches() async {
        let (client, mgmtTransport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)
        defer { host.deselect() }
        host.setShellVisible(true) // proves the abandonment, not mere invisibility, is what stops the attach

        host.apply(destination: .mode(.dispatch))
        await feedWaitUntil { mgmtTransport.methods.contains("session.dispatch") }
        guard let call = mgmtTransport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.dispatch" }) else {
            return XCTFail("session.dispatch never reached the wire")
        }

        // The shell moves on BEFORE the RPC answers — a mode landing that needs no session.
        host.apply(destination: .mode(.code))
        XCTAssertNil(host.selection)
        XCTAssertEqual(host.dispatchResolution, .idle)

        // The stale response finally arrives.
        mgmtTransport.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"result":{"sessionId":"s_dispatch","created":false}}"#)
        try? await Task.sleep(nanoseconds: 150_000_000)

        XCTAssertNil(host.selection, "a stale dispatch resolution must not resurrect a selection the shell has moved on from")
        XCTAssertNil(host.attachedSessionId)
        XCTAssertEqual(host.dispatchResolution, .idle)
        XCTAssertTrue(factory.made.isEmpty, "no harness must ever be minted for an abandoned resolution")
    }

    /// Failure → `.failed`, attaching nothing; `retryDispatchResolution()` re-issues the SAME RPC and
    /// a subsequent success attaches normally — the "Try Again" door `DispatchSurface`'s failed state
    /// wires to this method.
    func testDispatchResolutionFailureShowsFailedAndRetrySucceeds() async {
        let (client, mgmtTransport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)
        defer { host.deselect() }
        host.setShellVisible(true)

        host.apply(destination: .mode(.dispatch))
        await feedWaitUntil { mgmtTransport.methods.contains("session.dispatch") }
        guard let call1 = mgmtTransport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.dispatch" }) else {
            return XCTFail("session.dispatch never reached the wire")
        }
        mgmtTransport.feed(#"{"jsonrpc":"2.0","id":\#(call1["id"] as! Int),"error":{"code":-32603,"message":"unreachable"}}"#)

        await feedWaitUntil { host.dispatchResolution == .failed }
        XCTAssertNil(host.selection, "a failed resolution attaches nothing")
        XCTAssertTrue(factory.made.isEmpty)

        host.retryDispatchResolution()
        XCTAssertEqual(host.dispatchResolution, .resolving)
        await feedWaitUntil { mgmtTransport.methods.filter { $0 == "session.dispatch" }.count >= 2 }
        guard let call2 = mgmtTransport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.dispatch" }) else {
            return XCTFail("the retry never reached the wire")
        }
        mgmtTransport.feed(#"{"jsonrpc":"2.0","id":\#(call2["id"] as! Int),"result":{"sessionId":"s_dispatch","created":false}}"#)

        await feedWaitUntil { host.attachedSessionId != nil }
        XCTAssertEqual(host.attachedSessionId, "s_dispatch")
        XCTAssertEqual(host.dispatchResolution, .idle)
    }

    /// No `managementClient` (every test that doesn't inject one, and never reachable in production —
    /// see `selectDispatch`'s doc) — the same silent no-op the roster verbs give that case, not a
    /// crash and not a permanently "resolving" state.
    func testApplyDispatchDestinationNoOpsWithoutAManagementClient() {
        let (host, factory) = makeHost()
        host.apply(destination: .mode(.dispatch))
        XCTAssertNil(host.selection)
        XCTAssertEqual(host.dispatchResolution, .idle)
        XCTAssertTrue(factory.made.isEmpty)
    }

    /// Navigating onto dispatch while ALREADY attached elsewhere hops (detach-then-attach, one
    /// connection) exactly like any other cross-session hop — dispatch gets no special-cased
    /// attachment behavior once its id is known.
    func testApplyDispatchDestinationHopsFromAnAlreadyAttachedSession() async {
        let (client, mgmtTransport) = await connectedManagementClient()
        let (host, factory) = makeHost(managementClient: client)
        defer { host.deselect() }
        host.setShellVisible(true)
        host.select("S1")
        await waitUntilMade(factory, 1)
        let t = factory.made[0]
        await answerHandshake(t, sessionId: "S1")

        host.apply(destination: .mode(.dispatch))
        await feedWaitUntil { mgmtTransport.methods.contains("session.dispatch") }
        guard let call = mgmtTransport.sent.map({ feedLineJSON($0) }).last(where: { $0["method"] as? String == "session.dispatch" }) else {
            return XCTFail("session.dispatch never reached the wire")
        }
        mgmtTransport.feed(#"{"jsonrpc":"2.0","id":\#(call["id"] as! Int),"result":{"sessionId":"s_dispatch","created":true}}"#)

        await feedWaitUntil { t.methods.filter { $0 == "session.attach" }.count >= 2 }
        XCTAssertEqual(host.attachedSessionId, "s_dispatch")
        XCTAssertEqual(factory.made.count, 1, "a hop onto dispatch moves the attachment on the SAME socket")
        for aborting in ["session.interrupt", "agent.stop", "session.setActivity"] {
            XCTAssertFalse(t.methods.contains(aborting), "hopping onto dispatch must never send \(aborting): \(t.methods)")
        }
    }
}
