import XCTest
@testable import WinterKit

/// The mirror's frames are ~100-300 KB JSON lines, ten a second, on a socket that hands them over 16-64 KB
/// at a time. A Debug Winter Dev idle with a session open spent 2,146 of 2,241 samples in
/// `LineDecoder.push`: it searched the whole buffer from its start on every push and re-copied the
/// remainder after every line, so a long line arriving in small chunks, or a backlog of lines in one read,
/// cost the square of the bytes. These pin the corrected shape — and print the numbers (`BENCH …`).
final class LineDecoderPerformanceTests: XCTestCase {
    /// The decoder as it was, kept here as the baseline.
    private final class LegacyLineDecoder {
        private var buf = Data()
        func push(_ chunk: Data) -> [String] {
            buf.append(chunk)
            var lines: [String] = []
            while let nl = buf.firstIndex(of: 0x0a) {
                let lineData = buf[buf.startIndex..<nl]
                if !lineData.isEmpty { lines.append(String(decoding: lineData, as: UTF8.self)) }
                buf = Data(buf[buf.index(after: nl)...])
            }
            return lines
        }
    }

    private struct SeededGenerator: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// `count` lines of a `view.frame`-shaped notification, each about `size` bytes.
    private func frameLines(_ count: Int, size: Int = 80 * 1024) -> [String] {
        (0..<count).map { n in
            let payload = String(repeating: String(UnicodeScalar(UInt8(65 + n % 26))), count: size)
            return #"{"jsonrpc":"2.0","method":"view.frame","params":{"sessionId":"s_1","targetId":"t1","seq":\#(n),"jpeg":"\#(payload)","width":720,"height":540,"windowSize":[800,600]}}"#
        }
    }

    private func stream(of lines: [String]) -> Data { Data((lines.joined(separator: "\n") + "\n").utf8) }

    private func chunks(_ data: Data, maxChunk: Int, seed: UInt64 = 7) -> [Data] {
        var rng = SeededGenerator(state: seed)
        var out: [Data] = []
        var index = data.startIndex
        while index < data.endIndex {
            let size = Int.random(in: 1...maxChunk, using: &rng)
            let end = min(index + size, data.endIndex)
            out.append(data[index..<end])
            index = end
        }
        return out
    }

    // MARK: - Timing
    //
    // These tests compare timings, and on a shared CI runner a wall-clock reading includes however long the thread
    // waited for a core — tens of milliseconds at a time, against a workload of a few. So they read the CPU time of
    // THIS thread (it does not run while the thread is descheduled) and take the FASTEST of several rounds (what is
    // left of the noise — a cold cache, a busy sibling core — only ever adds). A bound between two such numbers
    // fails for an algorithm that got slower, not for a machine that was busy.

    /// CPU time this thread has used so far, in milliseconds.
    private func cpuMillis() -> Double { Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1_000_000 }

    private func cpuTime(_ body: () throws -> Void) rethrows -> Double {
        let start = cpuMillis()
        try body()
        return cpuMillis() - start
    }

    /// The least CPU time `body` took in `rounds` runs.
    private func fastest(of rounds: Int, _ body: () throws -> Void) rethrows -> Double {
        var best = Double.infinity
        for _ in 0..<rounds { best = min(best, try cpuTime(body)) }
        return best
    }

    // MARK: - Correctness

    func testRandomChunksReassembleEveryLineExactly() throws {
        let lines = frameLines(40, size: 20 * 1024)
        for maxChunk in [1, 7, 513, 4096, 65536] {
            let decoder = LineDecoder(maxLine: 16 * 1024 * 1024)
            var out: [String] = []
            for chunk in chunks(stream(of: lines), maxChunk: maxChunk) { out += try decoder.push(chunk) }
            XCTAssertEqual(out, lines, "max chunk \(maxChunk)")
        }
    }

    func testPushDataReturnsTheSameBytes() throws {
        let decoder = LineDecoder()
        let out = try decoder.pushData(Data("ab\n\ncd\nef".utf8))
        XCTAssertEqual(out, [Data("ab".utf8), Data("cd".utf8)])
        XCTAssertEqual(try decoder.pushData(Data("g\n".utf8)), [Data("efg".utf8)])
    }

    func testANewlineExactlyAtAChunkBoundaryAndALineSplitAcrossManyChunks() throws {
        let decoder = LineDecoder()
        XCTAssertEqual(try decoder.push(Data("one".utf8)), [])
        XCTAssertEqual(try decoder.push(Data("\n".utf8)), ["one"])
        XCTAssertEqual(try decoder.push(Data("t".utf8)), [])
        XCTAssertEqual(try decoder.push(Data("w".utf8)), [])
        XCTAssertEqual(try decoder.push(Data("o\nthree\n".utf8)), ["two", "three"])
        XCTAssertEqual(try decoder.push(Data()), [])
    }

    func testAnOversizedLineStillResetsAfterTheRewrite() throws {
        let decoder = LineDecoder(maxLine: 10)
        XCTAssertEqual(try decoder.push(Data("ab\n".utf8)), ["ab"])
        XCTAssertThrowsError(try decoder.push(Data(String(repeating: "x", count: 11).utf8)))
        XCTAssertEqual(try decoder.push(Data("ok\n".utf8)), ["ok"])
    }

    // MARK: - Linear

    /// A hundred 80 KB lines in random 1-64 KB chunks: twice the lines costs about twice the time, not four
    /// times (the old decoder's growth in a backlog).
    func testAHundredEightyKilobyteFramesInRandomChunksAreLinear() throws {
        func pieces(_ count: Int) -> [Data] { chunks(stream(of: frameLines(count)), maxChunk: 64 * 1024) }
        func run(_ pieces: [Data], expecting count: Int) throws {
            var total = 0
            let decoder = LineDecoder(maxLine: 16 * 1024 * 1024)
            for piece in pieces { total += try decoder.pushData(piece).count }
            XCTAssertEqual(total, count)
        }
        let small = pieces(100), large = pieces(200)
        try run(pieces(10), expecting: 10) // warm
        // Alternate the two sizes round by round, so whatever the machine is doing reaches both.
        var hundred = Double.infinity, twoHundred = Double.infinity
        for _ in 0..<9 {
            hundred = min(hundred, try cpuTime { try run(small, expecting: 100) })
            twoHundred = min(twoHundred, try cpuTime { try run(large, expecting: 200) })
        }
        print(String(format: "BENCH LineDecoder 100 frames x 80 KB in random <=64 KB chunks: %.1f ms; 200 frames: %.1f ms (ratio %.2f)",
                     hundred, twoHundred, twoHundred / max(hundred, 0.001)))
        XCTAssertLessThan(twoHundred, hundred * 3.2, "linear growth is 2x; the quadratic one is 4x and worse")
    }

    func testBeforeAndAfter() throws {
        let lines = frameLines(100)
        let data = stream(of: lines)
        print("BENCH LineDecoder 100 frames x 80 KB (\(data.count / 1024) KB total), before -> after:")
        for (label, maxChunk) in [("1 KB chunks", 1024), ("16 KB chunks", 16 * 1024), ("64 KB chunks", 64 * 1024)] {
            let pieces = chunks(data, maxChunk: maxChunk)
            var legacyCount = 0, count = 0
            let before = fastest(of: 3) {
                let legacy = LegacyLineDecoder()
                legacyCount = 0
                for piece in pieces { legacyCount += legacy.push(piece).count }
            }
            let after = try fastest(of: 3) {
                let decoder = LineDecoder(maxLine: 16 * 1024 * 1024)
                count = 0
                for piece in pieces { count += try decoder.pushData(piece).count }
            }
            XCTAssertEqual(legacyCount, 100)
            XCTAssertEqual(count, 100)
            print(String(format: "BENCH   %@: %.0f ms -> %.0f ms (%.0fx)", label, before, after, before / max(after, 0.001)))
        }
        // A backlog: every line arrives in one read.
        let before = fastest(of: 3) { _ = LegacyLineDecoder().push(data) }
        let after = try fastest(of: 3) { _ = try LineDecoder(maxLine: 16 * 1024 * 1024).pushData(data) }
        print(String(format: "BENCH   one read of all 100 lines: %.0f ms -> %.0f ms (%.0fx)", before, after, before / max(after, 0.001)))
        XCTAssertLessThan(after, before, "the backlog case is where the per-line re-copy hurt most")
    }

    // MARK: - The JSON half

    /// For the record: one 80 KB frame line parsed by the generic `Codable` tree and by `JSONSerialization`.
    /// A frame is one big string and a few small values, so they cost about the same (~0.1 ms) — the
    /// 2,146 samples were the line splitter. Printed, not asserted.
    func testParsingOneFrameLineIsCheapEitherWay() throws {
        let line = Data(frameLines(1)[0].utf8)
        let generic = fastest(of: 60) { _ = try? JSONDecoder().decode(JSONValue.self, from: line) }
        let native = fastest(of: 60) { _ = try? JSONSerialization.jsonObject(with: line) }
        print(String(format: "BENCH parse one 80 KB frame line: Codable JSONValue %.2f ms, JSONSerialization %.2f ms", generic, native))
        XCTAssertLessThan(max(generic, native), 5, "ten of these a second is nothing")
    }
}
