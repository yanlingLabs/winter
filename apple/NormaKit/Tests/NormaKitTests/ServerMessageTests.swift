import XCTest
import NormaProtocol
@testable import NormaKit

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
