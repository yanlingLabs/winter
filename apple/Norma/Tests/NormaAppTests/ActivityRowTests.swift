import XCTest
@testable import Norma

final class ActivityRowTests: XCTestCase {
    func testGlyphMapping() {
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .tool(name: "bash", detail: nil))).glyph, "⚙")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .tool(name: "bash", detail: nil))).label, "bash")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "pending"))).glyph, "☐")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "in_progress"))).glyph, "◐")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "completed"))).glyph, "☑")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .subagent(agentType: "general"))).glyph, "⌥")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .subagentDone)).glyph, "✓")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .worktree(entered: true, detail: "wt-1"))).glyph, "⛿")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .worktree(entered: false, detail: "wt-1"))).glyph, "⟲")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .interaction(InteractionRecord(callId: "a1", ask: .approval(toolName: "bash", summary: "needs approval"))))).glyph, "⚠")
        XCTAssertEqual(activityGlyphAndLabel(.init(kind: .task(subject: "Do X", status: "weird"))).glyph, "☐", "unknown status falls back to pending glyph")
    }

    // LIVE-GATE G3: `.tool`'s detail, when present, folds into the label as "name: detail".
    func testGlyphMappingWithDetail() {
        let mapped = activityGlyphAndLabel(.init(kind: .tool(name: "bash", detail: "ls -la")))
        XCTAssertEqual(mapped.glyph, "⚙")
        XCTAssertEqual(mapped.label, "bash: ls -la")
    }
}
