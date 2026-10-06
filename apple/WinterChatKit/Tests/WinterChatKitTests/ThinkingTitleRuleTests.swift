import Foundation
import XCTest
@testable import WinterChatKit

/// The thinking pill's title rule on the phone engine — the daemon's OWN fixture
/// (`packages/core/test/projector/fixtures/thinking-titles.json`: real reasoning from live runs plus
/// synthetic provider-heading, CJK and Unicode blocks) and the daemon's unit cases
/// (`thinking-title.test.ts`, `thinking-title-hardening.test.ts`), so both engines title every block
/// identically.
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

    private static func blocks() -> ThinkingBlocks {
        ThinkingBlocks(sessionId: "s", threadId: "main", provider: nil, model: nil,
                       stamp: .init(transientSeq: { 0 }, nextSeq: { 1 }, nowMs: { 0 }))
    }

    /// Streams `chunks` through a fresh `ThinkingBlocks`: every delta's title, and the persisted block's.
    private func persist(_ kind: String, _ chunks: [String]) -> (live: [String?], block: String?) {
        let b = Self.blocks()
        _ = b.accept(ProviderReasoningProgress(blockId: "rb", phase: .start, kind: kind, text: nil, part: nil))
        let liveTitles: [String?] = chunks.map { c in
            guard case .thinkingDelta(let d) = b.accept(ProviderReasoningProgress(blockId: "rb", phase: .delta, kind: kind, text: c, part: 0)).first
            else { return nil }
            return d.title
        }
        guard case .thinkingBlock(let block) = b.accept(ProviderReasoningProgress(blockId: "rb", phase: .end, kind: nil, text: nil, part: nil)).first
        else { XCTFail("no block"); return (liveTitles, nil) }
        return (liveTitles, block.title)
    }

    private static func split(_ text: String, _ size: Int) -> [String] {
        let units = Array(text.utf16)
        return stride(from: 0, to: units.count, by: size).map { String(decoding: units[$0..<min($0 + size, units.count)], as: UTF16.self) }
    }

    // MARK: the fixture

    func testEveryFixtureBlockGetsTheDaemonsTitle() throws {
        let f = try Self.fixture()
        XCTAssertEqual(f.blocks.count, 70)
        XCTAssertEqual(f.blocks.filter { $0.title != nil }.count, 61)
        for b in f.blocks {
            XCTAssertEqual(ThinkingTitle.derive(kind: b.kind, parts: [b.text], final: true), b.title, b.id)
        }
    }

    func testEveryFixtureBlockStreamedPersistsTheWholeTextTitleAcrossSplits() throws {
        for b in try Self.fixture().blocks {
            for size in b.text.utf16.count <= 1500 ? [1, 17, 160] : [17, 160] {
                XCTAssertEqual(persist(b.kind, Self.split(b.text, size)).block, b.title, "\(b.id) @\(size)")
            }
        }
    }

    // MARK: gerunds, patterns, filters

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

    // MARK: the bold heading

    func testTheBoldRuleRejectsLabelsAndLoneFileNamesButAcceptsHeadingsThatNameThem() {
        XCTAssertEqual(ThinkingHeading.lastValid("**Listing source files for inspection**\n\nI will run ls."), "Listing source files for inspection")
        for t in ["**src/calc.js:**", "**test/calc.test.js:**", "**src/format.js**", "**src/calc.js** (5 lines):", "**Lines per file (sorted by size):**", "**calc.js**", "**`calc.js`**", "**src/**"] {
            XCTAssertNil(ThinkingHeading.lastValid("\(t)\n1. body"), t)
        }
        XCTAssertEqual(ThinkingHeading.lastValid("**Inspecting package.json scripts**\n\nbody"), "Inspecting package.json scripts")
        XCTAssertEqual(ThinkingHeading.lastValid("**Reviewing Node.js setup**\n\nbody"), "Reviewing Node.js setup")
        XCTAssertEqual(ThinkingHeading.lastValid("**Checking `foo` usage**\n\nbody"), "Checking `foo` usage")
        XCTAssertNil(ThinkingHeading.lastValid("**Not a heading** for raw CoT"))
        XCTAssertEqual(ThinkingHeading.lastValid("**Foo**"), "Foo")
        XCTAssertNil(ThinkingHeading.lastValid("**Foo**", includeOpenLine: false))
        XCTAssertEqual(ThinkingTitle.derive(kind: "summary", parts: ["**Listing source files for inspection**\n\nLet me run the tests first."], final: true),
                       "Listing source files for inspection")
    }

    // MARK: review r1 — linear time

    /// The MINIMUM of three runs (review r2): a scheduling hiccup inflates one run, a backtracking
    /// blow-up all of them.
    private func timed(_ s: String) -> Double {
        var best = Double.infinity
        for _ in 0..<3 {
            let t0 = DispatchTime.now().uptimeNanoseconds
            _ = ActivityTitleRule.title(of: s, final: true)
            _ = ActivityTitleRule.title(of: s, final: false)
            _ = ThinkingHeading.lastValid(s)
            best = min(best, Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000)
        }
        return best
    }

    func testTheMeasuredAdversarialInputsFinishInMilliseconds() {
        for _ in 0..<20 { _ = timed("Let me read the files. **Heading**\n") }
        let adversarial = [
            String(repeating: "now  ", count: 22) + "xyz qq.", String(repeating: "now  ", count: 44) + "x.",
            String(repeating: "now   ", count: 14) + "xyz qq.", String(repeating: "so , ", count: 40) + "xyz qq.",
            String(repeating: "yes        ", count: 19) + "no.", String(repeating: "ok      ok      fine    yes     ", count: 6) + "x.",
            String(repeating: "now ,", count: 60), String(repeating: "I'll  ", count: 30) + "x.", String(repeating: "let me  ", count: 25) + "x.",
            String(repeating: "Checking ", count: 40) + "x.", String(repeating: "*", count: 400), String(repeating: "`a. b`", count: 60),
            String(repeating: "- ", count: 150) + "x.", String(repeating: ", so ", count: 60) + "x.", String(repeating: "— ", count: 150) + "x.",
            String(repeating: "now\u{3000}\u{3000}", count: 30) + "x.", String(repeating: "now\u{85}\u{85}", count: 30) + "x.", String(repeating: ".", count: 500) + "x",
        ]
        for s in adversarial {
            let ms = timed(s)
            XCTAssertLessThan(ms, 50, "\(s.prefix(24)) took \(ms) ms")
        }
    }

    func testAFuzzLoopOfRandomCandidatesStaysWithinBudget() {
        let toks = ["now", "so", "ok", "yes", "let me", "let", "me", "i'll", "i", "will", "need", "to", "check", "checking", "start", "by",
                    "and", "then", "just", "quickly", "—", "--", "-", ",", ";", ":", "(", ")", "`", "**", "i've", "found", "checked", "the", "a",
                    "that", "is", "go", "ahead", "double", "  ", "   ", "\t", " , ", "' ", "'", "。", "，", "检查"]
        var seed: UInt64 = 1
        func rnd() -> Double { seed = (seed &* 1103515245 &+ 12345) % 2147483648; return Double(seed) / 2147483648 }
        for _ in 0..<20 { _ = timed("Let me read the files.") }
        var worst = 0.0
        let t0 = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<2000 {
            var s = ""
            while s.utf16.count < 219 { s += toks[Int(rnd() * Double(toks.count))] + (rnd() < 0.5 ? " " : rnd() < 0.5 ? "  " : "") }
            let units = Array(s.utf16).prefix(219)
            worst = max(worst, timed(String(decoding: units, as: UTF16.self) + "."))
        }
        let total = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1_000_000
        XCTAssertLessThan(worst, 50, "worst candidate \(worst) ms")
        XCTAssertLessThan(total, 10_000, "2,000 candidates took \(total) ms")
    }

    // MARK: review r1 — Unicode, persisted titles, CJK

    func testUnicodeIsReadAsTheDaemonReadsIt() {
        XCTAssertEqual(final("Let me read the\u{0B}file."), "Reading the file")
        XCTAssertEqual(final("Let me read the\u{85}file."), "Reading the file")
        XCTAssertEqual(final("Checking\u{FEFF}the logs."), "Checking the logs")
        XCTAssertEqual(final("Checking the\u{200B} lo\u{202E}gs."), "Checking the logs")
        XCTAssertNil(final("Let me \u{17F}can the files."))
        XCTAssertNil(final("Let me chec\u{212A} the files."))
        XCTAssertEqual(final("LET ME READ THE FILES."), "Reading THE FILES")
        XCTAssertEqual(ThinkingTitle.derive(kind: "update", parts: ["Reading\u{202E} the\u{85}logs"]), "Reading the logs")
        let heading = ThinkingHeading.lastValid("**Reading\u{202E} the\u{200B} logs\u{07}**\nbody")
        XCTAssertEqual(heading, "Reading the logs")
    }

    func testNoProvisionalTitleCanBeRefutedByTextStillToCome() {
        let a = persist("exposed", ["Using the cache.", "Map is slower."])
        XCTAssertEqual(a.live, [nil, nil])
        XCTAssertNil(a.block)
        let b = persist("summary", ["**Foo**", " bar baz."])
        XCTAssertEqual(b.live, [nil, nil])
        XCTAssertNil(b.block)
        XCTAssertEqual(persist("exposed", ["Let me check calc.", "js now. Then"]).live, [nil, "Checking calc.js"])
        let c = persist("exposed", ["Using the cache.", " Map is slower."])
        XCTAssertEqual(c.live, [nil, "Using the cache"])
        XCTAssertEqual(c.block, "Using the cache")
        let d = persist("summary", ["**Foo**", "\nbar baz."])
        XCTAssertEqual(d.live, [nil, "Foo"])
        XCTAssertEqual(d.block, "Foo")
        XCTAssertNil(live("Let me read the files."))
        XCTAssertEqual(live("Let me read the files. "), "Reading the files")
    }

    func testABlockClosedWithoutItsEndStoresTheLastTitleItShowed() {
        func cut(_ kind: String, _ chunks: [String]) -> String? {
            let b = Self.blocks()
            _ = b.accept(ProviderReasoningProgress(blockId: "rb", phase: .start, kind: kind, text: nil, part: nil))
            for c in chunks { _ = b.accept(ProviderReasoningProgress(blockId: "rb", phase: .delta, kind: kind, text: c, part: 0)) }
            guard case .thinkingBlock(let block) = b.closeAll().first else { XCTFail("no block"); return nil }
            return block.title
        }
        XCTAssertEqual(cut("summary", ["**Busy**\n"]), "Busy")
        XCTAssertNil(cut("summary", ["**Busy**"]))
        XCTAssertEqual(cut("exposed", ["Let me read the files. "]), "Reading the files")
        XCTAssertNil(cut("exposed", ["Let me read the fi"]))
        XCTAssertEqual(cut("exposed", ["Let me read the files. Now let me run the te"]), "Reading the files")
    }

    func testHeadingsVersusTheActivityRule() {
        // Raw reasoning: late answer-draft headers never override the activity.
        XCTAssertEqual(ThinkingTitle.derive(kind: "exposed", parts: ["Let me read all the files.\n\n**`div` is wrong**\n\n**Riskiest: `div`**\n"]), "Reading all the files")
        // …an opening heading beats the activity in its own body, not after the next heading.
        XCTAssertEqual(ThinkingTitle.derive(kind: "exposed", parts: ["**Planning the fix**\n\nLet me read calc.js first.\n"]), "Planning the fix")
        XCTAssertEqual(ThinkingTitle.derive(kind: "exposed", parts: ["**Plan**\n\nSmall.\n\n**`wc -l` output**\n\nLet me check the tests now.\n"]), "Checking the tests")
        // Provider-written summaries keep their latest heading.
        XCTAssertEqual(ThinkingTitle.derive(kind: "summary", parts: ["**Planning the migration**\n\nLet me read the schema.\n\n**Reviewing constraints**\n\nLet me look at the keys.\n"]), "Reviewing constraints")
        // One code span is no heading.
        XCTAssertNil(ThinkingHeading.lastValid("**`div`**\nbody"))
    }

    func testTheLiveGateFixes() {
        XCTAssertNil(final("Adding a zero initial value to reduce would yield NaN for empty input."))
        XCTAssertEqual(final("Running the tests to make sure they are green."), "Running the tests")
        XCTAssertEqual(final("Checking pad to see if it is broken."), "Checking pad")
        XCTAssertEqual(final("So I'll guard for empty lists and return 0 instead."), "Guarding for empty lists")
        XCTAssertEqual(final("Let me check for hidden files and git log to be thorough."), "Checking for hidden files and git log")
        XCTAssertNil(final("Let me note this."))
        XCTAssertEqual(final("I found a bug in div."), "Found a bug in div")
    }

    func testCoordinatedVerbsAndAnswerWriting() {
        XCTAssertEqual(final("Let me implement and compute exact mean for random arrays."), "Implementing and computing exact mean for random arrays")
        XCTAssertEqual(final("Let me check and fix the tests."), "Checking and fixing the tests")
        XCTAssertEqual(final("Let me compute the theoretical bound and show the empirical ratio."), "Computing the theoretical bound")
        XCTAssertEqual(final("Let me compute the mean and show exact ratios."), "Computing the mean")
        XCTAssertEqual(final("Let me read the source and test files."), "Reading the source and test files")
        XCTAssertEqual(final("Let me check the logs and the config."), "Checking the logs and the config")
        XCTAssertEqual(final("Let me implement and compute exact mean for random arrays with heavy cancellation."),
                       "Implementing and computing exact mean for random arrays…")
        for s in ["Let me produce the final response.", "Now I'll generate the final answer.", "I'll keep code blocks.", "Let me compose the reply."] {
            XCTAssertEqual(final("Let me check the bound. \(s)"), "Checking the bound", s)
        }
        XCTAssertEqual(final("Let me write code to reproduce it."), "Writing code")
    }

    func testCJK() {
        XCTAssertEqual(live("让我想想。Let me read 配置文件。"), "Reading 配置文件")
        XCTAssertEqual(live("Let me read 配置文件！还有"), "Reading 配置文件")
        XCTAssertEqual(live("Let me read the files；"), "Reading the files")
        XCTAssertEqual(final("Let me check 这个函数的实现，看看它是否正确。"), "Checking 这个函数的实现")
        let unit = "配置文件和测试用例"
        XCTAssertEqual(final("I need to read \(String(repeating: unit, count: 10))。"),
                       "Reading \(String(String(repeating: unit, count: 4).prefix(32)))…")
        for s in ["让我读取文件。我需要检查代码。", "首先，我要检查这个项目的结构；然后运行测试！", "这是一个很小的项目"] {
            XCTAssertNil(final(s))
            XCTAssertNil(ThinkingTitle.derive(kind: "exposed", parts: [s], final: true))
        }
        XCTAssertEqual(ThinkingTitle.derive(kind: "summary", parts: ["**分析代码结构**\n\n内容"]), "分析代码结构")
    }
}
