import XCTest
@testable import WinterKit

final class LineDecoderTests: XCTestCase {
    func testSplitsCompleteLines() throws {
        let d = LineDecoder()
        let lines = try d.push(Data("{\"a\":1}\n{\"b\":2}\n".utf8))
        XCTAssertEqual(lines, ["{\"a\":1}", "{\"b\":2}"])
    }

    func testBuffersPartialLineAcrossChunks() throws {
        let d = LineDecoder()
        XCTAssertEqual(try d.push(Data("{\"a\":".utf8)), [])
        XCTAssertEqual(try d.push(Data("1}\n".utf8)), ["{\"a\":1}"])
    }

    func testUTF8MultibyteSplitAcrossChunkBoundary() throws {
        let d = LineDecoder()
        let bytes = Array("héllo ✓\n".utf8) // é and ✓ are multi-byte
        let cut = 3 // splits inside the é sequence
        XCTAssertEqual(try d.push(Data(bytes[0..<cut])), [])
        XCTAssertEqual(try d.push(Data(bytes[cut...])), ["héllo ✓"])
    }

    func testBlankLinesSkipped() throws {
        let d = LineDecoder()
        XCTAssertEqual(try d.push(Data("\n\n{\"a\":1}\n\n".utf8)), ["{\"a\":1}"])
    }

    func testOversizedLineThrowsAndResets() throws {
        let d = LineDecoder(maxLine: 8)
        XCTAssertThrowsError(try d.push(Data(String(repeating: "x", count: 9).utf8))) { err in
            XCTAssertEqual(err as? LineDecoderError, .lineTooLong(max: 8))
        }
        // buffer was reset: decoder is usable again
        XCTAssertEqual(try d.push(Data("ok\n".utf8)), ["ok"])
    }

    func testMultipleLinesInOneChunkPlusRemainder() throws {
        let d = LineDecoder()
        XCTAssertEqual(try d.push(Data("a\nb\nc".utf8)), ["a", "b"])
        XCTAssertEqual(try d.push(Data("\n".utf8)), ["c"])
    }
}
