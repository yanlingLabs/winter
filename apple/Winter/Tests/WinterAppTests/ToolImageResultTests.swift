import XCTest
@testable import Winter

/// A tool result that carried images arrives as text with one `[image]` placeholder per image (the images
/// are not in the session log). The expanded row must not print the placeholders: it draws the text
/// without them and a chip ("Screenshot" / "N images") under it, or only the chip when nothing else was
/// said. These tests pin the parsing and what the expansion is handed; the chip itself is a SwiftUI view.
final class ToolImageResultTests: XCTestCase {
    private func call(_ output: String?, isError: Bool = false) -> ToolCallRecord {
        ToolCallRecord(callId: nil, detail: nil, output: output, isError: isError)
    }

    private func lines(_ name: String, _ outputs: [String?], maxBlocks: Int = 25) -> [ToolRunCallLine] {
        toolRunExpansion([ToolRunEntry(name: name, calls: outputs.map { call($0) })], turnIsLive: false,
                         maxOutputBlocks: maxBlocks).lines
    }

    // MARK: - Parsing

    func testAResultOfOnlyPlaceholdersIsNoTextAndACount() {
        XCTAssertEqual(toolOutputSplittingImages("[image][image]").text, "")
        XCTAssertEqual(toolOutputSplittingImages("[image][image]").imageCount, 2)
        XCTAssertEqual(toolOutputSplittingImages("[image]").imageCount, 1)
        XCTAssertEqual(toolOutputSplittingImages("[image]\n[image]\n").text, "")
        XCTAssertEqual(toolOutputSplittingImages("[image]\n[image]\n").imageCount, 2)
    }

    func testPlaceholdersAreTakenOutOfTextAndNoBlankLineIsLeftBehind() {
        let onOwnLine = toolOutputSplittingImages("Notes — window \"Groceries\"\n[image]\nsettled 80 ms")
        XCTAssertEqual(onOwnLine.text, "Notes — window \"Groceries\"\nsettled 80 ms")
        XCTAssertEqual(onOwnLine.imageCount, 1)

        let trailing = toolOutputSplittingImages("settled 80 ms[image]")
        XCTAssertEqual(trailing.text, "settled 80 ms")
        XCTAssertEqual(trailing.imageCount, 1)

        let several = toolOutputSplittingImages("first[image] then\n[image][image]\nlast")
        XCTAssertEqual(several.text, "first then\nlast")
        XCTAssertEqual(several.imageCount, 3)
    }

    func testTextWithoutPlaceholdersIsReturnedByteForByte() {
        for text in ["", "plain", "  indented\n\ttabbed  \n", "[images] are not placeholders", "[Image]", "[ image ]"] {
            let split = toolOutputSplittingImages(text)
            XCTAssertEqual(split.text, text)
            XCTAssertEqual(split.imageCount, 0)
        }
    }

    func testTheChipSaysScreenshotOrACount() {
        XCTAssertEqual(toolImageChipText(1), "Screenshot")
        XCTAssertEqual(toolImageChipText(2), "2 images")
        XCTAssertEqual(toolImageChipText(5), "5 images")
    }

    // MARK: - The expansion

    func testAnImageOnlyResultHasNoTextBlockButCountsItsImages() {
        let line = lines("computer_v2", ["[image][image]"])[0]
        XCTAssertNil(line.output)
        XCTAssertEqual(line.imageCount, 2)
        XCTAssertEqual(line.status, .succeeded, "it is a finished call, not a missing result")
    }

    func testTextAndImagesGiveATextBlockWithoutThePlaceholdersAndTheCount() {
        let line = lines("computer_v2", ["Notes — settled 80 ms\n[image]"])[0]
        XCTAssertEqual(line.output?.text, "Notes — settled 80 ms")
        XCTAssertEqual(line.imageCount, 1)
    }

    /// The placeholders are for every tool that can carry an image, the old ones included.
    func testTheOldComputerAndBrowserToolsAreHandledToo() {
        for name in ["computer", "Computer", "browser", "Browser", "read", "ComputerV2"] {
            let line = lines(name, ["Screenshot taken [image]"])[0]
            XCTAssertEqual(line.output?.text, "Screenshot taken", name)
            XCTAssertEqual(line.imageCount, 1, name)
        }
    }

    /// A shell, a search or a listing prints text, and a literal "[image]" in it is content.
    func testTextOnlyToolsKeepALiteralPlaceholder() {
        for name in ["bash", "grep", "glob", "ls", "edit", "write"] {
            let line = lines(name, ["![alt][image]\n[image]"])[0]
            XCTAssertEqual(line.output?.text, "![alt][image]\n[image]", name)
            XCTAssertEqual(line.imageCount, 0, name)
        }
        XCTAssertTrue(toolOutputMayCarryImages("computer_v2"))
        XCTAssertFalse(toolOutputMayCarryImages("bash"))
    }

    func testAnEmptyResultStillSaysNoOutputAndARunningCallStillRuns() {
        let empty = toolRunExpansion([ToolRunEntry(name: "computer_v2", calls: [call("")])], turnIsLive: false).lines[0]
        XCTAssertEqual(empty.output?.text, "", "an empty result is a result — the block says 'No output'")
        XCTAssertEqual(empty.imageCount, 0)

        let running = toolRunExpansion([ToolRunEntry(name: "computer_v2", calls: [call(nil)])], turnIsLive: true).lines[0]
        XCTAssertNil(running.output)
        XCTAssertEqual(running.imageCount, 0)
        XCTAssertEqual(running.status, .running)
    }

    /// A text block is drawn per call within a budget; an image-only result draws none and spends none.
    func testAnImageOnlyResultSpendsNoOutputBudget() {
        let expansion = toolRunExpansion(
            [ToolRunEntry(name: "computer_v2", calls: [call("[image]"), call("[image]"), call("ok"), call("later")])],
            turnIsLive: false, maxOutputBlocks: 1)
        XCTAssertEqual(expansion.lines.map { $0.output?.text }, [nil, nil, "ok", nil])
        XCTAssertEqual(expansion.lines.map(\.imageCount), [1, 1, 0, 0])
        XCTAssertEqual(expansion.note, "… output for 1 more call is not shown")
    }

    // MARK: - The collapsed failure line

    func testTheFailureLineNeverShowsAPlaceholder() {
        let failed = [ToolRunEntry(name: "computer_v2", calls: [call("[image]\nStaleRef: ref 14 is gone", isError: true)])]
        XCTAssertEqual(toolRunFailureSummary(failed), "StaleRef: ref 14 is gone")

        let onlyImages = [ToolRunEntry(name: "computer_v2", calls: [call("[image]", isError: true)])]
        XCTAssertNil(toolRunFailureSummary(onlyImages))

        let shell = [ToolRunEntry(name: "bash", calls: [call("[image] not found", isError: true)])]
        XCTAssertEqual(toolRunFailureSummary(shell), "[image] not found", "a shell's output is left alone")
    }
}
