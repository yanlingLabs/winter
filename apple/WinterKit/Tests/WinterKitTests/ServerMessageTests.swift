import XCTest
import WinterProtocol
@testable import WinterKit

final class ServerMessageTests: XCTestCase {
    func testResponseWithResult() throws {
        let m = parseServerLine(#"{"jsonrpc":"2.0","id":3,"result":{"ok":true,"lastSeq":42}}"#)
        guard case .response(let id, .success(let v)) = m else { return XCTFail("\(m)") }
        XCTAssertEqual(id, 3)
        XCTAssertEqual(v["ok"]?.boolValue, true)
        XCTAssertEqual(v["lastSeq"]?.intValue, 42)
    }

    func testResponseWithError() throws {
        let m = parseServerLine(#"{"jsonrpc":"2.0","id":9,"error":{"code":-32001,"message":"invalid token for role"}}"#)
        guard case .response(let id, .failure(let e)) = m else { return XCTFail("\(m)") }
        XCTAssertEqual(id, 9)
        XCTAssertEqual(e, RpcError(code: -32001, message: "invalid token for role"))
    }

    /// WB-C1's decode half: a JSON-RPC error's optional `data` is kept, not discarded. The shape
    /// driven here is the real one — `sync.push`'s `ERR.DIVERGED` (-32006), whose `data.lastSeq` is
    /// the branch point the phone's fork/re-push logic keys on and which used to be dropped right
    /// here, one layer below the gateway that then dropped it a second time.
    func testResponseErrorKeepsStructuredData() throws {
        let m = parseServerLine(#"{"jsonrpc":"2.0","id":4,"error":{"code":-32006,"message":"diverged","data":{"lastSeq":17}}}"#)
        guard case .response(let id, .failure(let e)) = m else { return XCTFail("\(m)") }
        XCTAssertEqual(id, 4)
        XCTAssertEqual(e.code, -32006)
        XCTAssertEqual(e.data?["lastSeq"]?.intValue, 17)
        // An error WITHOUT `data` still decodes to nil — nothing invented, and the existing
        // `RpcError(code:message:)` equality above keeps holding.
        guard case .response(_, .failure(let plain)) = parseServerLine(#"{"jsonrpc":"2.0","id":5,"error":{"code":-1,"message":"x"}}"#) else { return XCTFail() }
        XCTAssertNil(plain.data)
    }

    /// Winter Phase 8d (Task 4.2, Interfaces block): `RpcError.handoffCode` reads `error.data.code`
    /// against the four `HandoffRpcCode` raw values — `session.setModel`'s own typed refusals
    /// (`ipc/server.ts`'s `RpcFailure` third argument for `confirmation_required`/`lossy_fork`/
    /// `blocked`, and the `refused` outcome's `handoff_disabled` case).
    func testHandoffCodeParsesTheFourKnownCodesAndNilsOnEverythingElse() throws {
        func handoffCode(_ line: String) -> HandoffRpcCode? {
            guard case .response(_, .failure(let e)) = parseServerLine(line) else { XCTFail("expected a failure response"); return nil }
            return e.handoffCode
        }
        XCTAssertEqual(handoffCode(#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"x","data":{"code":"handoff_confirmation_required","warnings":["reasoning state may be lost"]}}}"#), .confirmationRequired)
        XCTAssertEqual(handoffCode(#"{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"x","data":{"code":"handoff_disabled"}}}"#), .disabled)
        XCTAssertEqual(handoffCode(#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"x","data":{"code":"handoff_lossy_fork"}}}"#), .lossyFork)
        XCTAssertEqual(handoffCode(#"{"jsonrpc":"2.0","id":4,"error":{"code":-32603,"message":"x","data":{"code":"handoff_blocked"}}}"#), .blocked)
        // A refusal with NO data at all, and one with a code this enum deliberately does not carry
        // (`runtime_selection_refused` — a plain refusal, not one of the four confirm/disable/error
        // shapes a picker treats specially) — both `nil`, never a crash or a guessed case.
        XCTAssertNil(handoffCode(#"{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"x"}}"#))
        XCTAssertNil(handoffCode(#"{"jsonrpc":"2.0","id":6,"error":{"code":-32602,"message":"x","data":{"code":"runtime_selection_refused"}}}"#))
    }

    /// Winter Phase 10b (D1-4, W18-23): `error.data` gains an additive `portable` array alongside
    /// `warnings` — `RpcError.data` is generic `JSONValue?` (this file's own header), so the extra
    /// field needs no schema change here at all, and this test PROVES it rather than assuming it:
    /// the line decodes cleanly, `handoffCode` still resolves, `warnings` still reads exactly as
    /// before, AND the new `portable` field is itself readable through the same subscript —
    /// "tolerates" both directions (a newer daemon that sends it, and this kit's own code that does
    /// not yet act on it, WS-18 W18-23: "Swift decodes only `warnings` today, so it ignores
    /// `portable` until 10c").
    func testHandoffConfirmationRequiredDataToleratesTheAdditivePortableField() throws {
        let line = #"{"jsonrpc":"2.0","id":7,"error":{"code":-32602,"message":"x","data":{"code":"handoff_confirmation_required","warnings":["reasoning state may be lost"],"portable":["deepseek","GLM"]}}}"#
        guard case .response(let id, .failure(let e)) = parseServerLine(line) else { return XCTFail("expected a failure response") }
        XCTAssertEqual(id, 7)
        XCTAssertEqual(e.handoffCode, .confirmationRequired)
        XCTAssertEqual((e.data?["warnings"]?.arrayValue ?? []).compactMap { $0.stringValue }, ["reasoning state may be lost"])
        XCTAssertEqual((e.data?["portable"]?.arrayValue ?? []).compactMap { $0.stringValue }, ["deepseek", "GLM"])
    }

    func testEventNotificationDecodesSessionEvent() throws {
        let line = #"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_delta","seq":7,"sessionId":"s_1","ts":1,"threadId":"main","delta":"tok"}}"#
        guard case .event(.assistantDelta(let d)) = parseServerLine(line) else { return XCTFail() }
        XCTAssertEqual(d.delta, "tok")
        XCTAssertEqual(d.threadId, "main")
    }

    func testUnknownEventTypeWrapsRawInsteadOfCrashing() throws {
        let line = #"{"jsonrpc":"2.0","method":"event","params":{"type":"mystery_v99","seq":1,"sessionId":"s","ts":0}}"#
        guard case .unknownEvent(let raw) = parseServerLine(line) else { return XCTFail() }
        XCTAssertTrue(raw.contains("mystery_v99"))
    }

    func testGarbageLineIsUnrecognized() throws {
        guard case .unrecognized = parseServerLine("not json at all") else { return XCTFail() }
        guard case .unrecognized = parseServerLine(#"{"jsonrpc":"2.0"}"#) else { return XCTFail() }
    }

    func testJSONValueRoundTrip() throws {
        let v = JSONValue.object(["a": .array([.number(1), .string("x"), .bool(false), .null])])
        let data = try JSONEncoder().encode(v)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), v)
    }
}
