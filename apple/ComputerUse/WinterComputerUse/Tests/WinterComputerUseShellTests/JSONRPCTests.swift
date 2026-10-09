import Foundation
import WinterComputerUseShell
import WinterCUCore
import XCTest

final class JSONRPCTests: XCTestCase {
    private func parse(_ text: String) -> RPCInbound { RPCInbound.parse(Data(text.utf8)) }

    private func line(_ data: Data) throws -> JSONValue {
        XCTAssertEqual(data.last, 0x0A, "every outbound line ends in a newline")
        XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1, "and holds no other")
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    func testARequestParses() {
        XCTAssertEqual(parse(#"{"jsonrpc":"2.0","id":7,"method":"target.bind","params":{"app":"Notes"}}"#),
                       .request(id: .number(7), method: "target.bind", params: json(#"{"app":"Notes"}"#)))
        XCTAssertEqual(parse(#"{"jsonrpc":"2.0","id":"a-1","method":"status"}"#), .request(id: .string("a-1"), method: "status", params: nil))
    }

    func testANotificationIsRecognisedAndIgnored() {
        XCTAssertEqual(parse(#"{"jsonrpc":"2.0","method":"escPressed","params":{}}"#), .notification(method: "escPressed"))
    }

    func testMalformedLinesAreInvalidParams() {
        for text in ["not json", "[1,2]", #"{"id":1,"method":"status"}"#, #"{"jsonrpc":"2.0","id":1}"#,
                     #"{"jsonrpc":"2.0","id":1,"method":"status","params":[1]}"#, #"{"jsonrpc":"2.0","id":{"x":1},"method":"status"}"#] {
            guard case .invalid(_, let error) = parse(text) else { XCTFail("accepted: \(text)"); continue }
            XCTAssertEqual(error.code, "invalid_params", text)
        }
        guard case .invalid(let id, _) = parse(#"{"jsonrpc":"2.0","id":5,"method":"status","params":"x"}"#) else { return XCTFail() }
        XCTAssertEqual(id, .number(5), "the id is echoed when it could be read")
    }

    func testAResponseLine() throws {
        let out = try line(RPCOutbound.response(id: .number(3), result: AnyEncodable(EmptyResult())))
        XCTAssertEqual(out, json(#"{"jsonrpc":"2.0","id":3,"result":{}}"#))
    }

    func testAnErrorLineCarriesTheStringCodeInData() throws {
        let error = RPCError(code: "stale_ref", message: "[12] is gone — call state()", data: ["ref": .number(12)])
        let out = try line(RPCOutbound.error(id: .string("x"), error))
        XCTAssertEqual(out, json(#"{"jsonrpc":"2.0","id":"x","error":{"code":-32000,"message":"[12] is gone — call state()","data":{"code":"stale_ref","ref":12}}}"#))
        XCTAssertEqual(try line(RPCOutbound.error(id: .null, .invalidParams("bad")))["error"]?["code"], .number(-32602))
    }

    func testBusyIsRetryableByDefault() throws {
        let out = try line(RPCOutbound.error(id: .number(1), .busy("queue full")))
        XCTAssertEqual(out["error"]?["data"], json(#"{"code":"busy","retryable":true}"#))
        let told = RPCError(code: "busy", message: "no", data: ["retryable": .bool(false)])
        XCTAssertEqual(told.wireData["retryable"], .bool(false))
    }

    func testANotificationLine() throws {
        let data = try XCTUnwrap(RPCOutbound.notification(method: "escPressed", params: AnyEncodable(HelperNotification.escPressed(sessionIds: ["s_1"]).params)))
        XCTAssertEqual(try line(data), json(#"{"jsonrpc":"2.0","method":"escPressed","params":{"sessionIds":["s_1"]}}"#))
    }

    func testTheNotificationsShapes() {
        XCTAssertEqual(HelperNotification.targetLost(targetId: "t1", reason: "app_quit").params, json(#"{"targetId":"t1","reason":"app_quit"}"#))
        XCTAssertEqual(HelperNotification.permissionsChanged(accessibility: true, screenRecording: false).params,
                       json(#"{"permissions":{"accessibility":true,"screenRecording":false}}"#))
    }

    func testAResultOverTheSixteenMiBCapBecomesAnError() throws {
        struct Big: Encodable { let imageBase64: String }
        let big = Big(imageBase64: String(repeating: "A", count: RPCWire.maxResponseLineBytes))
        let out = try line(RPCOutbound.response(id: .number(9), result: AnyEncodable(big)))
        XCTAssertEqual(out["id"], .number(9))
        XCTAssertEqual(out["error"]?["data"]?["code"], .string("invalid_params"))
    }

    func testBase64SlashesAreNotEscaped() {
        let data = RPCOutbound.response(id: .number(1), result: AnyEncodable(["imageBase64": "/9j/4A=="]))
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains("/9j/4A=="))
    }

    func testErrorsMapOntoTheWireCodes() {
        XCTAssertEqual(RPCError.from(CancellationError()).code, "cancelled")
        let cu = RPCError.from(CUError(code: "permission_missing", message: "grant it", data: ["permission": .string("accessibility")]))
        XCTAssertEqual(cu, RPCError(code: "permission_missing", message: "grant it", data: ["permission": .string("accessibility")]))
        struct Weird: Error {}
        XCTAssertEqual(RPCError.from(Weird()).code, "unsupported")
        do {
            _ = try json(#"{"targetId":1}"#).decode(TargetReleaseParams.self)
        } catch {
            let e = RPCError.from(error)
            XCTAssertEqual(e.code, "invalid_params")
            XCTAssertTrue(e.message.contains("params.targetId"), e.message)
        }
    }
}
