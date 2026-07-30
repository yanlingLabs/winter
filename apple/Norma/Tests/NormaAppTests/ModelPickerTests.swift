import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 10 (Chat Slice D): the header's model menu (`WindowContentView`'s `modelMenuButton`/
/// `modelMenuContent`, beside the existing ⋯ policy picker). Same PURE-HELPER idiom as
/// `PolicyMenuTests` — nothing here drives the live popover/Button UI (not independently unit
/// testable, see that file's own note); this covers the pure decisions behind it
/// (`modelDisplayLabel`/`sessionModelOptions`/`modelMenuIsVisible`), the adapter's in-flight
/// discipline (a STUBBED `onSetModel`, mirroring `PolicyMenuTests.testSessionPolicyUpdatesOnlyOnSuccess`),
/// `AppModel.setSessionModel`'s real wire shape (mirrors `testAppModelSetSessionPolicyWireShape`),
/// and the T1-deferred `listSessions()` → `SessionSummary.model` threading this task closes.
final class ModelPickerTests: XCTestCase {
    // MARK: - Pure decisions

    /// "model set → shown; model nil → 'default' shown" (brief's own wording for the picker's
    /// current-selection label).
    func testModelDisplayLabelShowsModelOrDefault() {
        XCTAssertEqual(modelDisplayLabel("gpt-5.6-sol"), "gpt-5.6-sol", "a set model is shown verbatim")
        XCTAssertEqual(modelDisplayLabel("gpt-5.6-luna"), "gpt-5.6-luna")
        XCTAssertEqual(modelDisplayLabel(nil), "Default", "no override shows the labeled default, not a blank/misleading value")
    }

    /// The picker's offered slugs — hardcoded mirror of `CODEX_MODELS`
    /// (`packages/core/src/providers/codex-config.ts`), same precedent as `sessionPolicyModes`.
    func testSessionModelOptionsIsTheCodexCatalogue() {
        XCTAssertEqual(sessionModelOptions, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    }

    /// THE ASYMMETRY: unlike the policy picker (hidden for chat — plan-immunity), the model menu
    /// must show for EVERY mode, chat included. A test that would fail immediately if someone
    /// "fixed" `modelMenuIsVisible` by copying the policy button's `!isChatSession` predicate.
    func testModelMenuIsVisibleRegardlessOfChatSession() {
        XCTAssertTrue(modelMenuIsVisible(isChatSession: true), "the model menu must show for chat — the deliberate asymmetry vs the policy picker")
        XCTAssertTrue(modelMenuIsVisible(isChatSession: false))
    }

    // MARK: - Adapter in-flight discipline (stubbed onSetModel, mirrors PolicyMenuTests)

    @MainActor
    func testModelChangeInFlightFlipsSynchronouslyAroundOnSetModel() async throws {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        XCTAssertFalse(adapter.modelChangeInFlight)

        var receivedModel = "unset"
        var receivedWasNil = false
        adapter.onSetModel = { [adapter] model in
            adapter.modelChangeInFlight = true
            receivedWasNil = model == nil
            receivedModel = model ?? "unset"
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 20_000_000)
                adapter.modelChangeInFlight = false
            }
        }

        adapter.onSetModel("gpt-5.6-luna")
        XCTAssertTrue(adapter.modelChangeInFlight, "must flip in-flight SYNCHRONOUSLY, before the RPC resolves")
        XCTAssertEqual(receivedModel, "gpt-5.6-luna", "selecting a model must pass that exact value through")
        XCTAssertFalse(receivedWasNil)
        await waitUntil { !adapter.modelChangeInFlight }

        adapter.onSetModel(nil)
        XCTAssertTrue(adapter.modelChangeInFlight)
        XCTAssertTrue(receivedWasNil, "selecting \"default\" must pass nil through, clearing the override")
        await waitUntil { !adapter.modelChangeInFlight }
    }

    // MARK: - AppModel → wire shape

    /// Local copy of `AppModelTests`'/`PolicyMenuTests`' scripted-transport handshake helpers — see
    /// `PolicyMenuTests`' identical copy for why each test file keeps its own instance-method
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

    /// "selecting a model sends setModel with the right value; selecting 'default' sends null" —
    /// the real wire shape, mirroring `PolicyMenuTests.testAppModelSetSessionPolicyWireShape`.
    @MainActor
    func testAppModelSetSessionModelWireShapeSendsStringThenLiteralNull() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let responded = model.setSessionModel("gpt-5.6-luna")
        await waitUntilSent(t, 4)
        let setReq = lineJSON(t.sent[3])
        XCTAssertEqual(setReq["method"] as? String, "session.setModel")
        let setParams = setReq["params"] as? [String: Any]
        XCTAssertEqual(setParams?["sessionId"] as? String, "s_1")
        XCTAssertEqual(setParams?["model"] as? String, "gpt-5.6-luna")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setReq["id"] as! Int),"result":{}}"#)
        let ok = await responded
        XCTAssertTrue(ok)

        async let respondedClear = model.setSessionModel(nil)
        await waitUntilSent(t, 5)
        let clearReq = lineJSON(t.sent[4])
        XCTAssertEqual(clearReq["method"] as? String, "session.setModel")
        XCTAssertTrue(
            (clearReq["params"] as? [String: Any])?["model"] is NSNull,
            "selecting \"default\" must send a literal JSON null, not an omitted key"
        )
        t.feed(#"{"jsonrpc":"2.0","id":\#(clearReq["id"] as! Int),"result":{}}"#)
        let okClear = await respondedClear
        XCTAssertTrue(okClear)
    }

    /// No focused session yet: `setSessionModel` must fail closed (false), never crash / send with
    /// an empty sessionId — mirrors `PolicyMenuTests.testAppModelSetSessionPolicyFailsWithoutFocusedSession`.
    @MainActor
    func testAppModelSetSessionModelFailsWithoutFocusedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let ok = await model.setSessionModel("gpt-5.6-sol")
        XCTAssertFalse(ok)
        XCTAssertTrue(t.sent.isEmpty, "no RPC should go out with no focused session")
    }

    // MARK: - T1 deferred item, closed: listSessions() → SessionSummary.model, end to end

    /// Proves `model` genuinely threads from the wire through `NormaKit.listSessions()` into
    /// `AppModel.directory.rows` — not merely decoded and dropped. Mirrors
    /// `PolicyMenuTests.testOrbUpdateIsChatSessionTracksARealDirectoryRoundTrip`'s "real scripted
    /// round trip, not a hand-fed array" posture, EXCEPT the directory's own boot-time
    /// `startInitialLoad()` reliably races transport-not-yet-connected in a headless test (its
    /// `listSessions()` throws "not connected" immediately, `refresh()`'s `try?` swallows it, and
    /// nothing else retries — the real app's `SessionSidebar.task` is what normally re-triggers
    /// it, and nothing here mounts one). So this drives `directory.refresh()` EXPLICITLY, once the
    /// boot handshake has fully settled, and answers THAT specific `session.list` call.
    @MainActor
    func testAppModelDirectoryThreadsModelFromSessionList() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let refreshed: Void = model.directory.refresh()
        await waitUntilSent(t, 4)
        let listReq = lineJSON(t.sent[3])
        XCTAssertEqual(listReq["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"sessions":[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch","model":"gpt-5.6-luna"},{"sessionId":"s_2","scope":"global","createdAt":2,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await refreshed

        XCTAssertEqual(model.directory.rows.first { $0.sessionId == "s_1" }?.model, "gpt-5.6-luna")
        XCTAssertNil(model.directory.rows.first { $0.sessionId == "s_2" }?.model, "absent on the wire threads through as nil")
    }
}
