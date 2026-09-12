import XCTest
@testable import Winter

final class MessageFormattingTests: XCTestCase {
    func testFencedCodeSplits() {
        let blocks = FormattedMessageBlock.parse("hi\n```swift\nlet x = 1\n```\nbye")
        XCTAssertEqual(blocks.count, 3)
        if case .code(let lang, let code) = blocks[1].kind {
            XCTAssertEqual(lang, "swift"); XCTAssertTrue(code.contains("let x = 1"))
        } else { XCTFail("middle block must be code") }
    }
    func testMarkdownBlocksParse() {
        let md = MessageTextFormatter.chatMarkdownBlocks("# Title\n- a\n- b\n> quoted")
        XCTAssertTrue(md.contains { if case .heading = $0.kind { return true }; return false })
        XCTAssertTrue(md.contains { if case .bullet = $0.kind { return true }; return false })
        XCTAssertTrue(md.contains { if case .quote = $0.kind { return true }; return false })
    }
    func testInlineStylesProduceAttributedRuns() {
        let s = MessageTextFormatter.chatInlineAttributedString(
            "**bold** and `code`", colorScheme: .light,
            baseFont: .systemFont(ofSize: 13), codeFont: .monospacedSystemFont(ofSize: 12, weight: .regular),
            lineSpacing: 2)
        XCTAssertGreaterThan(s.runs.count, 1, "bold+code must produce multiple attribute runs")
    }
    func testHighlighterColorsKeywords() {
        let s = SyntaxHighlighter.highlighted("let x = 1", language: "swift", colorScheme: .dark)
        XCTAssertGreaterThan(s.runs.count, 1)
    }
}
