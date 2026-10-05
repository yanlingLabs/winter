import Foundation
import XCTest
@testable import WinterChatKit

/// The thinking pill's title rule on the phone engine — the daemon's OWN fixture
/// (`packages/core/test/projector/fixtures/thinking-titles.json`, real reasoning from live runs) and
/// the daemon's unit cases (`packages/core/test/projector/thinking-title.test.ts`), so both engines
/// title every block identically.
final class ThinkingTitleRuleTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Block: Decodable { let id: String; let kind: String; let title: String?; let text: String }
        let blocks: [Block]
    }

    private static func fixture() throws -> Fixture {
        // Tests/WinterChatKitTests/<this file> → the repo root is four levels up.
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("packages/core/test/projector/fixtures/thinking-titles.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func final(_ s: String) -> String? { ActivityTitleRule.title(of: s, final: true) }
    private func live(_ s: String) -> String? { ActivityTitleRule.title(of: s, final: false) }

    func testEveryFixtureBlockGetsTheDaemonsTitle() throws {
        let f = try Self.fixture()
        XCTAssertEqual(f.blocks.count, 49)
        for b in f.blocks {
            XCTAssertEqual(ThinkingTitle.derive(kind: b.kind, parts: [b.text], final: true), b.title, b.id)
        }
    }

    func testEveryFixtureBlockStreamedThroughThinkingBlocksPersistsTheSameTitle() throws {
        for b in try Self.fixture().blocks {
            for size in b.text.utf16.count <= 1500 ? [1, 17, 160] : [17, 160] {
                let blocks = ThinkingBlocks(sessionId: "s", threadId: "main", provider: nil, model: nil,
                                            stamp: .init(transientSeq: { 0 }, nextSeq: { 1 }, nowMs: { 0 }))
                let units = Array(b.text.utf16)
                var i = 0
                while i < units.count {
                    let chunk = String(decoding: units[i..<min(i + size, units.count)], as: UTF16.self)
                    _ = blocks.accept(ProviderReasoningProgress(blockId: "rb", phase: .delta, kind: b.kind, text: chunk, part: 0))
                    i += size
                }
                let end = blocks.accept(ProviderReasoningProgress(blockId: "rb", phase: .end, kind: nil, text: nil, part: nil))
                guard case .thinkingBlock(let block) = end.first else { return XCTFail("no block for \(b.id)") }
                XCTAssertEqual(block.title, b.title, "\(b.id) @\(size)")
            }
        }
    }

    func testGerunds() {
        XCTAssertEqual(["read", "examine", "write", "use", "take", "lie", "tie", "see", "agree", "be", "dye", "panic", "quit", "verify", "try"].map(ActivityTitleRule.gerund),
                       ["reading", "examining", "writing", "using", "taking", "lying", "tying", "seeing", "agreeing", "being", "dyeing", "panicking", "quitting", "verifying", "trying"])
        XCTAssertEqual(["run", "skip", "plan", "scan", "stop", "get", "set", "put", "map", "dig", "drop", "step", "swap", "wrap", "cut", "sum", "grep"].map(ActivityTitleRule.gerund),
                       ["running", "skipping", "planning", "scanning", "stopping", "getting", "setting", "putting", "mapping", "digging", "dropping", "stepping", "swapping", "wrapping", "cutting", "summing", "grepping"])
        XCTAssertEqual(["begin", "commit", "submit", "refer", "occur", "debug", "rerun", "forget", "control"].map(ActivityTitleRule.gerund),
                       ["beginning", "committing", "submitting", "referring", "occurring", "debugging", "rerunning", "forgetting", "controlling"])
        XCTAssertEqual(["visit", "edit", "open", "listen", "limit", "filter", "answer", "consider", "deliver", "remember", "fix", "show"].map(ActivityTitleRule.gerund),
                       ["visiting", "editing", "opening", "listening", "limiting", "filtering", "answering", "considering", "delivering", "remembering", "fixing", "showing"])
        XCTAssertEqual(ActivityTitleRule.gerund("re-examine"), "re-examining")
    }

    func testPatternsAndShortening() {
        XCTAssertEqual(final("Scanning the project source and test files to identify every bug."), "Scanning the project source and test files")
        XCTAssertEqual(final("I am now identifying the riskiest function."), "Identifying the riskiest function")
        XCTAssertEqual(final("Let me first take a look at the working directory to see what's there."), "Taking a look at the working directory")
        XCTAssertEqual(final("Let me start by exploring the project directory to understand what we're working with."), "Exploring the project directory")
        XCTAssertEqual(final("I'll go through and read all the files."), "Reading all the files")
        XCTAssertEqual(final("Let me double check the imports."), "Double-checking the imports")
        XCTAssertEqual(final("Let me verify by checking git status."), "Checking git status")
        XCTAssertEqual(final("Found two bugs in src/calc.js."), "Found two bugs in src/calc.js")
        XCTAssertEqual(final("I checked the git log."), "Checked the git log")
        XCTAssertEqual(final("It's a small project, so I'll just read through all the files."), "Reading through all the files")
        XCTAssertEqual(final("There's no useful history to inspect—I'll just count lines per file and read through the contents directly."), "Counting lines per file")
        XCTAssertEqual(final("Then I will plan the pow(a,b) implementation and test coverage."), "Planning the pow(a,b) implementation and test coverage")
        XCTAssertEqual(final("I'll run `find . -type f | xargs wc -l` to count lines per file, then check the git log."), "Running `find . -type f | xargs wc -l`")
        XCTAssertEqual(final("Let me read the first second third fourth fifth sixth seventh eighth ninth file."), "Reading the first second third fourth fifth sixth seventh…")
        XCTAssertNil(final("```js\n// Let me read the file.\n```\n"))
        XCTAssertNil(final("1. Let me read the file.\n- Let me run the tests.\n## Checking the build\n| Reading | x |\n"))
    }

    func testMisfireFilters() {
        XCTAssertNil(final("Reassigning the string parameter works fine in JavaScript."))
        XCTAssertNil(final("Passing a number like `42` will return the raw value."))
        XCTAssertNil(final("Dividing by zero when the array is empty also produces invalid output."))
        XCTAssertEqual(final("Checking whether the missing test imports are a code bug."), "Checking whether the missing test imports are a code…")
        XCTAssertNil(final("Missing sub/mul tests aren't really bugs."))
        XCTAssertNil(final("Interesting findings."))
        XCTAssertNil(final("Running `find"))
        XCTAssertNil(final("Let me analyze them."))
        XCTAssertNil(final("Let me think."))
        XCTAssertEqual(final("Let me run node to confirm it. Let me test."), "Running node")
        XCTAssertEqual(final("Let me read the logs. Let me write a concise final answer."), "Reading the logs")
        XCTAssertEqual(final("Drafting the one-line fixes now."), "Drafting the one-line fixes")
        XCTAssertNil(final("**Checking the\ntests**"))
    }

    func testTheBoldHeadingFix() {
        XCTAssertEqual(ThinkingHeading.lastValid("**Listing source files for inspection**\n\nI will run ls."), "Listing source files for inspection")
        for t in ["**src/calc.js:**", "**test/calc.test.js:**", "**src/format.js**", "**src/calc.js** (5 lines):", "**Lines per file (sorted by size):**", "**calc.js**"] {
            XCTAssertNil(ThinkingHeading.lastValid("\(t)\n1. body"), t)
        }
        XCTAssertNil(ThinkingHeading.lastValid("**Not a heading** for raw CoT"))
        XCTAssertEqual(ThinkingTitle.derive(kind: "summary", parts: ["**Listing source files for inspection**\n\nLet me run the tests first."], final: true),
                       "Listing source files for inspection")
    }

    func testStreaming() {
        XCTAssertNil(live("Let me read the fi"))
        XCTAssertNil(live("Let me read the files"))
        XCTAssertEqual(live("Let me read the files."), "Reading the files")
        XCTAssertEqual(final("Let me read the files"), "Reading the files")
        let t = ActivityTitleTracker()
        t.push("Let me read src/calc.")
        XCTAssertEqual(t.title(final: false), "Reading src/calc")
        t.push("js first. The")
        XCTAssertEqual(t.title(final: false), "Reading src/calc.js")
    }
}
