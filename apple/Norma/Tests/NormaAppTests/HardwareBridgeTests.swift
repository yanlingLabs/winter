import XCTest
import WinterKit
import WinterProtocol
@testable import Winter

/// The `HelperCalling` stub — no ServiceManagement, no XPC. Deliberately NOT a real
/// `HelperClient`: constructing one queries live `SMAppService` state (a backgroundtaskmanagementd
/// round-trip), which measurably destabilized the suite's 60Hz-timer animation tests when done
/// from inside the test run (see the `HelperCalling` doc comment in `HardwareBridge.swift`).
@MainActor
private final class StubHelper: HelperCalling {
    var status: HelperApprovalStatus
    var setCalls: [Int] = []
    var getCalls = 0
    var reply: (resultJson: String?, errorJson: String?) = (nil, nil)

    init(status: HelperApprovalStatus) {
        self.status = status
    }

    func setChargeLimit(_ percent: Int) async -> (resultJson: String?, errorJson: String?) {
        setCalls.append(percent)
        return reply
    }

    func getChargeLimit() async -> (resultJson: String?, errorJson: String?) {
        getCalls += 1
        return reply
    }
}

/// Task 4 (4c): `hardwarePlan` (the pure verb-switch/mapping core, `HardwareBridge.swift`) +
/// `HardwareBridge.handle`'s respond wiring over a scripted transport with a stubbed helper. The
/// XPC round-trip itself (`HelperClient.setChargeLimit`/`getChargeLimit` against a real
/// `WinterHelper`) is LIVE-GATE territory (Task 6), never exercised here — mirrors how
/// `ChargeLimitPlanTests` covers `chargeLimitPlan` while `SMCController`'s IOKit surface stays
/// untested.
@MainActor
final class HardwareBridgeTests: XCTestCase {
    // MARK: - Pure decision core: hardwarePlan

    private func errorCode(_ plan: HardwarePlan) -> String? {
        if case .error(let code, _) = plan { return code }
        return nil
    }

    func testUnknownVerbIsTypedError() {
        XCTAssertEqual(errorCode(hardwarePlan(verb: "spinFans", argsJson: "{}", helperApproved: true)), "unknown_verb")
    }

    func testUnknownVerbWinsOverMissingApproval() {
        // Ordering pin: a caller bug (verb this bridge never heard of) is reported as such even
        // while the helper is unapproved — never masked as helper_not_approved.
        XCTAssertEqual(errorCode(hardwarePlan(verb: "spinFans", argsJson: "{}", helperApproved: false)), "unknown_verb")
    }

    func testSetChargeLimitWithoutApprovalIsHelperNotApproved() {
        XCTAssertEqual(errorCode(hardwarePlan(verb: "setChargeLimit", argsJson: #"{"percent":80}"#, helperApproved: false)), "helper_not_approved")
    }

    func testGetChargeLimitWithoutApprovalIsHelperNotApproved() {
        XCTAssertEqual(errorCode(hardwarePlan(verb: "getChargeLimit", argsJson: "", helperApproved: false)), "helper_not_approved")
    }

    func testSetChargeLimitParsesPercentFromArgsJson() {
        XCTAssertEqual(hardwarePlan(verb: "setChargeLimit", argsJson: #"{"percent":80}"#, helperApproved: true), .setChargeLimit(percent: 80))
        XCTAssertEqual(hardwarePlan(verb: "setChargeLimit", argsJson: #"{"percent":100}"#, helperApproved: true), .setChargeLimit(percent: 100))
    }

    /// Range/value validation is NOT re-derived app-side — the helper's own `chargeLimitPlan`
    /// (`HelperSources/SMCController.swift`) owns that table and replies invalid_range/
    /// unsupported_value itself. The bridge plans the call and passes the number through verbatim.
    func testSetChargeLimitDoesNotRevalidateRangeAppSide() {
        XCTAssertEqual(hardwarePlan(verb: "setChargeLimit", argsJson: #"{"percent":30}"#, helperApproved: true), .setChargeLimit(percent: 30))
    }

    func testSetChargeLimitMalformedArgsIsInvalidArgs() {
        XCTAssertEqual(errorCode(hardwarePlan(verb: "setChargeLimit", argsJson: "", helperApproved: true)), "invalid_args")
        XCTAssertEqual(errorCode(hardwarePlan(verb: "setChargeLimit", argsJson: "not json", helperApproved: true)), "invalid_args")
        XCTAssertEqual(errorCode(hardwarePlan(verb: "setChargeLimit", argsJson: "{}", helperApproved: true)), "invalid_args")
        XCTAssertEqual(errorCode(hardwarePlan(verb: "setChargeLimit", argsJson: #"{"percent":"eighty"}"#, helperApproved: true)), "invalid_args")
    }

    func testGetChargeLimitIgnoresArgsJson() {
        // getChargeLimit takes no args — HardwareBroker.request() defaults argsJson to "" and a
        // caller-supplied blob is irrelevant; both plan to the same call.
        XCTAssertEqual(hardwarePlan(verb: "getChargeLimit", argsJson: "", helperApproved: true), .getChargeLimit)
        XCTAssertEqual(hardwarePlan(verb: "getChargeLimit", argsJson: #"{"anything":1}"#, helperApproved: true), .getChargeLimit)
    }

    // MARK: - handle(hardware_requested) → hardware.respond over the wire

    private func sessionEvent(_ json: String) -> SessionEvent {
        try! JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    private func hardwareRequestedEvent(requestId: String = "hwreq_1", verb: String, argsJson: String = "{}") -> SessionEvent {
        sessionEvent(#"{"type":"hardware_requested","seq":1,"sessionId":"plugin_1","ts":0,"threadId":"main","requestId":"\#(requestId)","verb":"\#(verb)","argsJson":\#(jsonEncodedString(argsJson))}"#)
    }

    /// `argsJson` is itself a STRING field on the wire (a JSON string containing JSON) —
    /// double-encode it so the outer literal is valid JSON (same helper posture as
    /// `PeripheralProviderTests.JSONEncodedString`).
    private func jsonEncodedString(_ s: String) -> String {
        let data = try! JSONEncoder().encode(s)
        return String(data: data, encoding: .utf8)!
    }

    /// Mirrors `PeripheralProviderTests.connectedProvider()` — a real `WinterClient` handshake over
    /// a scripted transport, so `handle()`'s `hardwareRespond` RPC bytes can be asserted on.
    private func connectedBridge(helper: StubHelper) async throws -> (HardwareBridge, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "hardware-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (HardwareBridge(client: client, helperClient: helper), t)
    }

    private func ackLastSent(_ t: FeedScriptedTransport, index: Int) {
        let req = feedLineJSON(t.sent[index])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"ok":true}}"#)
    }

    func testUnknownVerbRespondsWithTypedErrorOverTheWire() async throws {
        let helper = StubHelper(status: .enabled)
        let (bridge, t) = try await connectedBridge(helper: helper)

        async let handled: Void = bridge.handle(hardwareRequestedEvent(verb: "spinFans"))

        // t.sent[0] is already "protocol.hello" from connectedBridge()'s own handshake.
        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        XCTAssertEqual(respond["method"] as? String, "hardware.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertEqual(params?["requestId"] as? String, "hwreq_1")
        XCTAssertNil(params?["resultJson"])
        let errorString = params?["error"] as? String
        XCTAssertNotNil(errorString, "expected an error for an unknown verb")
        // The error string is itself the {code, message} JSON envelope (HelperService.errorJson's
        // shape) — core passes it through verbatim as provider_error's message.
        let envelope = feedLineJSON(errorString!)
        XCTAssertEqual(envelope["code"] as? String, "unknown_verb")
        XCTAssertTrue(helper.setCalls.isEmpty && helper.getCalls == 0, "an unknown verb must never reach the helper")

        ackLastSent(t, index: 1)
        await handled
    }

    func testUnapprovedHelperRespondsHelperNotApprovedOverTheWire() async throws {
        let helper = StubHelper(status: .requiresApproval)
        let (bridge, t) = try await connectedBridge(helper: helper)

        async let handled: Void = bridge.handle(hardwareRequestedEvent(verb: "setChargeLimit", argsJson: #"{"percent":80}"#))

        await feedWaitUntil { t.sent.count >= 2 }
        let respond = feedLineJSON(t.sent[1])
        XCTAssertEqual(respond["method"] as? String, "hardware.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertNil(params?["resultJson"])
        let envelope = feedLineJSON((params?["error"] as? String) ?? "{}")
        XCTAssertEqual(envelope["code"] as? String, "helper_not_approved")
        XCTAssertTrue(helper.setCalls.isEmpty, "an unapproved helper must never be called")

        ackLastSent(t, index: 1)
        await handled
    }

    func testApprovedSetChargeLimitRoutesToHelperAndRespondsResult() async throws {
        let helper = StubHelper(status: .enabled)
        helper.reply = (#"{"percent":80,"mechanism":"CHWA"}"#, nil)
        let (bridge, t) = try await connectedBridge(helper: helper)

        async let handled: Void = bridge.handle(hardwareRequestedEvent(verb: "setChargeLimit", argsJson: #"{"percent":80}"#))

        await feedWaitUntil { t.sent.count >= 2 }
        XCTAssertEqual(helper.setCalls, [80], "the parsed percent goes to the helper verbatim")
        let respond = feedLineJSON(t.sent[1])
        XCTAssertEqual(respond["method"] as? String, "hardware.respond")
        let params = respond["params"] as? [String: Any]
        XCTAssertNil(params?["error"])
        XCTAssertEqual(params?["resultJson"] as? String, #"{"percent":80,"mechanism":"CHWA"}"#, "the helper's resultJson passes through untouched")

        ackLastSent(t, index: 1)
        await handled
    }

    func testApprovedGetChargeLimitHelperErrorPassesThroughAsError() async throws {
        // The helper's own errorJson (e.g. smc_error) rides the respond's `error` field verbatim —
        // core wraps it as provider_error with this exact string as the message.
        let helper = StubHelper(status: .enabled)
        helper.reply = (nil, #"{"code":"smc_error","message":"boom"}"#)
        let (bridge, t) = try await connectedBridge(helper: helper)

        async let handled: Void = bridge.handle(hardwareRequestedEvent(verb: "getChargeLimit", argsJson: ""))

        await feedWaitUntil { t.sent.count >= 2 }
        XCTAssertEqual(helper.getCalls, 1)
        let respond = feedLineJSON(t.sent[1])
        let params = respond["params"] as? [String: Any]
        XCTAssertNil(params?["resultJson"])
        XCTAssertEqual(params?["error"] as? String, #"{"code":"smc_error","message":"boom"}"#)

        ackLastSent(t, index: 1)
        await handled
    }

    func testHandleIgnoresUnrelatedSessionEventTypes() async throws {
        let helper = StubHelper(status: .enabled)
        let (bridge, t) = try await connectedBridge(helper: helper)
        await bridge.handle(sessionEvent(#"{"type":"turn_started","seq":1,"sessionId":"s_1","ts":0,"threadId":"main"}"#))
        // Nothing beyond the handshake's protocol.hello ever hits the wire.
        XCTAssertEqual(t.sent.count, 1)
        XCTAssertTrue(helper.setCalls.isEmpty && helper.getCalls == 0)
    }
}
