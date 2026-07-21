import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 4 (2d-iii): the ⋯ menu's approval-mode picker. Covers `FieldStateAdapter.sessionPolicy`'s
/// seed/update-on-success discipline (mirrors `CardWiringTests.testAdapterInFlightLifecycle`'s
/// in-flight idiom for the three respond callbacks, simplified to a single session-wide flag — see
/// `policyChangeInFlight`'s doc) and the `AppModel.setSessionPolicy` → wire shape (mirrors
/// `CardWiringTests.testAppModelRespondApprovalWireShape`). Nothing here drives the live popover/
/// `Button` UI — same posture as `CardWiringTests`' own note: that isn't independently
/// unit-testable, only the plumbing behind it is.
final class PolicyMenuTests: XCTestCase {
    // MARK: - Adapter seed / in-flight / update-on-success

    @MainActor
    func testSessionPolicySeededAuto() {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        XCTAssertEqual(adapter.sessionPolicy, "auto", "orb-created-session default (AppModel.ensureFocusedSession) — no wire read seeds this; session.list/session.attach don't expose approvalPolicy (see sessionPolicy's doc)")
        XCTAssertFalse(adapter.policyChangeInFlight)
    }

    @MainActor
    func testSessionPolicyUpdatesOnlyOnSuccess() async throws {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        var stubSucceeds = true

        // Exact wiring shape the brief specifies for GlassRootView/DetachedWindowController — a
        // STUB (not a real AppModel/NormaClient) so this test locks down the discipline itself:
        // in-flight flipped SYNCHRONOUSLY, cleared once the stub resolves, and `sessionPolicy`
        // bumped to the new value ONLY on success.
        adapter.onSetPolicy = { [adapter] policy in
            adapter.policyChangeInFlight = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 20_000_000)
                let ok = stubSucceeds
                adapter.policyChangeInFlight = false
                if ok { adapter.sessionPolicy = policy }
            }
        }

        adapter.onSetPolicy("ask")
        XCTAssertTrue(adapter.policyChangeInFlight, "must flip in-flight SYNCHRONOUSLY, before the RPC resolves")
        await waitUntil { !adapter.policyChangeInFlight }
        XCTAssertEqual(adapter.sessionPolicy, "ask", "a successful flip updates the last-known value")

        stubSucceeds = false
        adapter.onSetPolicy("plan")
        XCTAssertTrue(adapter.policyChangeInFlight)
        await waitUntil { !adapter.policyChangeInFlight }
        XCTAssertEqual(adapter.sessionPolicy, "ask", "a FAILED flip must not lie about the new value — stays at the last-known-good one")
    }

    // MARK: - AppModel → wire shape

    /// Local copy of `AppModelTests`' scripted-transport handshake helpers — see
    /// `CardWiringTests`' identical copy for why each test file keeps its own instance-method
    /// versions (`AppScriptedTransport`/`lineJSON`/`waitUntil` are target-wide free/internal
    /// symbols; `answerHandshake`/`waitUntilSent` are not).
    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    func answerHandshake(_ t: AppScriptedTransport, sessions: String) async {
        await waitUntilSent(t, 1)
        let hello = lineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":\#(sessions)}}"#)
    }

    @MainActor
    func testAppModelSetSessionPolicyWireShape() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let responded = model.setSessionPolicy("plan")
        await waitUntilSent(t, 4)
        let setPolicy = lineJSON(t.sent[3])
        XCTAssertEqual(setPolicy["method"] as? String, "session.setPolicy")
        let params = setPolicy["params"] as? [String: Any]
        XCTAssertEqual(params?["sessionId"] as? String, "s_1")
        XCTAssertEqual(params?["policy"] as? String, "plan")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setPolicy["id"] as! Int),"result":{"ok":true}}"#)
        let ok = await responded
        XCTAssertTrue(ok)
    }

    /// No focused session yet: `setSessionPolicy` must fail closed (false), never crash / send with
    /// an empty sessionId — mirrors `sendOrSteer`'s/the three respond methods' own guard.
    @MainActor
    func testAppModelSetSessionPolicyFailsWithoutFocusedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let ok = await model.setSessionPolicy("auto")
        XCTAssertFalse(ok)
        XCTAssertTrue(t.sent.isEmpty, "no RPC should go out with no focused session")
    }

    // MARK: - SP-policies Task 14: six-mode list + bypass danger

    /// The picker's offered modes — wire-identical to the CLI's `POLICY_ORDER`
    /// (`packages/cli/src/tui/app.tsx`) and the protocol's `ApprovalPolicy` enum
    /// (`packages/protocol/src/methods.ts`), in restrictiveness order.
    func testSessionPolicyModesIsSixValuesInRestrictivenessOrder() {
        XCTAssertEqual(sessionPolicyModes, ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"])
    }

    /// `bypass` is the only mode that auto-approves everything (including dangerous-domain
    /// calls, SP-policies Task 10) — the picker row's danger treatment must key off exactly this.
    func testBypassIsTheOnlyDangerousMode() {
        for policy in sessionPolicyModes {
            XCTAssertEqual(isPolicyDangerous(policy), policy == "bypass", "\(policy)'s danger flag")
        }
    }

    /// Every mode gets a readable label — not a bare `.capitalized` (which would render the
    /// hyphenated modes as "Dont-Ask"/"Accept-Edits").
    func testPolicyDisplayLabelsAreReadableForEveryMode() {
        let labels = sessionPolicyModes.map(policyDisplayLabel)
        XCTAssertEqual(labels, ["Plan", "Don't Ask", "Ask", "Accept Edits", "Auto", "Bypass"])
    }
}
