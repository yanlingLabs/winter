import Foundation
import XCTest
@testable import NormaChatKit

/// The cleaner's ONLY correctness anchor: `packages/protocol/generated/fixtures/cleaner-vectors.json`,
/// computed from the live TS `htmlToText` at `pnpm protocol:generate` time. This test ITERATES the
/// JSON — it never hand-copies a case — so a vector added on the TS side is automatically enforced
/// here, and a vector whose expected output changes fails loudly instead of drifting.
final class HtmlToTextTests: XCTestCase {
    /// SPLIT CONVENTION (Task 4 fix-1 review, and the single likeliest way to get this port wrong):
    /// the vectors were produced with JS `htmlToText(html).split("\n")`, where the EMPTY string
    /// yields `[""]` — one empty line, not zero lines. Swift's `split(separator:)` defaults to
    /// `omittingEmptySubsequences: true` and yields `[]`, which fails the "empty page" vector (and
    /// silently drops blank lines everywhere else). `components(separatedBy:)` is the JS-equivalent.
    func testEveryCleanerVectorMatchesExactly() throws {
        let vectors = try ParityFixtures.cleanerVectors()
        XCTAssertEqual(vectors.count, 14, "expected 14 cleaner vectors — regenerate via `pnpm protocol:generate`")

        for vector in vectors {
            let actual = htmlToTextLines(vector.html)
            XCTAssertEqual(actual, vector.lines, "cleaner vector mismatch: \(vector.name)")
        }
    }

    /// The `-> String` shape is the byte-faithful mirror of the TS function; `htmlToTextLines` is
    /// exactly that string put through the JS split convention. Pinned so the two can never drift.
    func testLinesIsTheStringFormPutThroughTheJsSplitConvention() throws {
        for vector in try ParityFixtures.cleanerVectors() {
            XCTAssertEqual(htmlToTextLines(vector.html), htmlToText(vector.html).components(separatedBy: "\n"),
                           "lines/string forms disagree for: \(vector.name)")
        }
    }

    func testEmptyPageIsOneEmptyLineNotZeroLines() {
        XCTAssertEqual(htmlToTextLines(""), [""])
        XCTAssertEqual("".split(separator: "\n").map(String.init), [], "sanity: the WRONG Swift default this convention guards against")
    }
}
