import Foundation
import WinterBrowserHostCore
import XCTest

final class FramingTests: XCTestCase {
    private func frame(_ s: String) -> Data {
        var length = UInt32(s.utf8.count).littleEndian
        var d = Data(bytes: &length, count: 4)
        d.append(Data(s.utf8))
        return d
    }

    // MARK: Chrome → host

    func testNativeMessagesAreDecodedAcrossAnyChunkBoundaries() {
        let stream = frame(#"{"a":1}"#) + frame(#"{"b":"two"}"#) + frame("{}")
        for chunk in [1, 2, 3, 5, 7, 64] {
            var decoder = NativeMessageDecoder()
            var out: [NativeMessageDecoder.Item] = []
            var i = 0
            while i < stream.count {
                out += decoder.push(stream.subdata(in: i ..< min(i + chunk, stream.count)))
                i += chunk
            }
            XCTAssertEqual(out, [.message(Data(#"{"a":1}"#.utf8)), .message(Data(#"{"b":"two"}"#.utf8)), .message(Data("{}".utf8))], "chunk \(chunk)")
        }
    }

    func testTheLengthIsLittleEndian() {
        var decoder = NativeMessageDecoder()
        let payload = String(repeating: "x", count: 300)
        let items = decoder.push(Data([0x2C, 0x01, 0x00, 0x00]) + Data(payload.utf8))
        XCTAssertEqual(items, [.message(Data(payload.utf8))])
    }

    func testAnOversizedMessageIsSkippedWholeAndTheStreamStaysInStep() {
        var decoder = NativeMessageDecoder(maxMessage: 10)
        let big = frame(String(repeating: "y", count: 25))
        let next = frame(#"{"ok":1}"#)
        var items = decoder.push(big.prefix(12))
        items += decoder.push(big.dropFirst(12) + next)
        XCTAssertEqual(items, [.oversized(25, prefix: Data(String(repeating: "y", count: 8).utf8)), .message(Data(#"{"ok":1}"#.utf8))])
    }

    func testTheExtensionMayNotSendMoreThan16MiB() {
        XCTAssertEqual(NativeMessageDecoder().maxMessage, 16 * 1024 * 1024)
        var decoder = NativeMessageDecoder()
        var length = UInt32(16 * 1024 * 1024 + 1).littleEndian
        XCTAssertEqual(decoder.push(Data(bytes: &length, count: 4)), [.oversized(16 * 1024 * 1024 + 1, prefix: Data())])
    }

    func testAnOversizedMessageKeepsItsStartToBeAnswered() {
        var decoder = NativeMessageDecoder(maxMessage: 10)
        let big = #"{"jsonrpc":"2.0","id":"d42","result":{"data":"xxxxxxxxxxxxxxxx"}}"#
        guard case .oversized(let length, let prefix) = decoder.push(frame(big)).first else { return XCTFail("expected oversized") }
        XCTAssertEqual(length, big.utf8.count)
        XCTAssertEqual(String(decoding: prefix, as: UTF8.self), big)
    }

    // MARK: host → Chrome

    func testFramingToChromeIsCappedAt1MiB() throws {
        let ok = Data(repeating: 0x61, count: 1024 * 1024)
        let framed = try XCTUnwrap(NativeMessageEncoder.frame(ok))
        XCTAssertEqual(framed.count, 4 + ok.count)
        XCTAssertEqual([UInt8](framed.prefix(4)), [0x00, 0x00, 0x10, 0x00])
        XCTAssertNil(NativeMessageEncoder.frame(Data(repeating: 0x61, count: 1024 * 1024 + 1)))
    }

    // MARK: daemon → host

    func testDaemonLinesSplitWithBlankLinesSkipped() throws {
        var decoder = LineDecoder()
        XCTAssertEqual(try decoder.push(Data("{\"a\":1}\n\n{\"b\"".utf8)), [Data("{\"a\":1}".utf8)])
        XCTAssertEqual(try decoder.push(Data(":2}\n".utf8)), [Data("{\"b\":2}".utf8)])
    }

    func testADaemonLineOverTheCapIsAProtocolViolation() {
        var decoder = LineDecoder(maxLine: 8)
        XCTAssertThrowsError(try decoder.push(Data("123456789".utf8)))
        var complete = LineDecoder(maxLine: 8)
        XCTAssertThrowsError(try complete.push(Data("123456789\n".utf8)))
        XCTAssertEqual(LineDecoder().maxLine, 1024 * 1024)
    }

    // MARK: host → daemon

    func testALineForTheDaemonCarriesTheMessageUnchangedButForInsignificantNewlines() {
        let pretty = Data("{\n  \"jsonrpc\": \"2.0\",\r\n  \"method\": \"x\"\n}".utf8)
        let line = LineEncoder.line(pretty)
        XCTAssertEqual(line.last, 0x0A)
        XCTAssertEqual(line.dropLast().filter { $0 == 0x0A || $0 == 0x0D }.count, 0)
        let reparsed = try? JSONSerialization.jsonObject(with: line.dropLast()) as? [String: String]
        XCTAssertEqual(reparsed, ["jsonrpc": "2.0", "method": "x"])
        let compact = Data(#"{"jsonrpc":"2.0","id":"e1","result":{"s":"a\nb"}}"#.utf8)
        XCTAssertEqual(LineEncoder.line(compact), compact + Data([0x0A]))
    }

    // MARK: envelopes

    func testEnvelopes() {
        XCTAssertEqual(Envelope.parse(Data(#"{"jsonrpc":"2.0","id":"d1","method":"tabs.list","params":{}}"#.utf8)), .request(id: "d1", method: "tabs.list"))
        XCTAssertEqual(Envelope.parse(Data(#"{"jsonrpc":"2.0","method":"cdp.event","params":{}}"#.utf8)), .notification(method: "cdp.event"))
        XCTAssertEqual(Envelope.parse(Data(#"{"jsonrpc":"2.0","id":"e3","result":{}}"#.utf8)), .response(id: "e3"))
        XCTAssertEqual(Envelope.parse(Data(#"{"jsonrpc":"2.0","id":"e3","error":{"code":1}}"#.utf8)), .response(id: "e3"))
        for bad in [#"{"id":"1","method":"x"}"#, #"{"jsonrpc":"1.0","method":"x"}"#, "[1,2]", "nope", #"{"jsonrpc":"2.0"}"#, #"{"jsonrpc":"2.0","id":null,"method":"x"}"#] {
            XCTAssertNil(Envelope.parse(Data(bad.utf8)), bad)
        }
    }
}
