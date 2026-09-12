import XCTest
@testable import Winter

/// 2e-ii Task 2: lockstep twin of `packages/cli/test/subagent-display.test.ts` — glyph/label/alive
/// use the SAME fixtures on both sides. `subagentActiveMs` is Swift-only (window shows time).
final class SubagentDisplayTests: XCTestCase {
    func testGlyphs() {
        XCTAssertEqual(subagentGlyph("queued"), "◌")
        XCTAssertEqual(subagentGlyph("working"), "●")
        XCTAssertEqual(subagentGlyph("done"), "✓")
        XCTAssertEqual(subagentGlyph("weird"), "◌")
    }

    func testLabelDescriptionWins() {
        XCTAssertEqual(subagentLabel(description: "explore auth module", prompt: "long prompt here"), "explore auth module")
        XCTAssertEqual(subagentLabel(description: "  padded  ", prompt: "p"), "padded")
    }

    func testLabelPromptFallback() {
        XCTAssertEqual(subagentLabel(description: nil, prompt: "short prompt"), "short prompt")
        XCTAssertEqual(subagentLabel(description: "", prompt: "first line\nsecond line"), "first line")
        XCTAssertEqual(subagentLabel(description: "   ", prompt: String(repeating: "x", count: 45)), String(repeating: "x", count: 39) + "…")
        XCTAssertEqual(subagentLabel(description: nil, prompt: String(repeating: "x", count: 40)), String(repeating: "x", count: 40))
    }

    /// Caps by UNICODE CODE POINTS, not UTF-16 units or grapheme clusters — lockstep with TS
    /// (never cuts a surrogate pair).
    func testLabelCodePointCapLockstepWithTS() {
        // 45 flag emoji (each = 2 code points, 90 total): 39 code points = 19 full flags + one
        // lone regional indicator, never a corrupt half-surrogate.
        XCTAssertEqual(subagentLabel(description: nil, prompt: String(repeating: "🇦🇺", count: 45)), String(repeating: "🇦🇺", count: 19) + "🇦" + "…")
        // 40-code-point ASCII prompt still fits untruncated (existing behavior preserved).
        XCTAssertEqual(subagentLabel(description: nil, prompt: String(repeating: "x", count: 40)), String(repeating: "x", count: 40))
    }

    func testAnyAlive() {
        XCTAssertFalse(anySubagentAlive([]))
        XCTAssertFalse(anySubagentAlive(["done", "done"]))
        XCTAssertTrue(anySubagentAlive(["done", "queued"]))
        XCTAssertTrue(anySubagentAlive(["working"]))
    }

    func testActiveMs() {
        XCTAssertEqual(subagentActiveMs(activeMs: 0, activeSince: nil, status: "queued", nowMs: 99_999), 0)
        XCTAssertEqual(subagentActiveMs(activeMs: 5_000, activeSince: nil, status: "done", nowMs: 99_999), 5_000)
        XCTAssertEqual(subagentActiveMs(activeMs: 5_000, activeSince: 10_000, status: "working", nowMs: 12_500), 7_500)
        // Open span exists but status regressed (defensive) — open span NOT counted.
        XCTAssertEqual(subagentActiveMs(activeMs: 5_000, activeSince: 10_000, status: "done", nowMs: 12_500), 5_000)
        // Clock skew: now behind since must clamp, not go negative.
        XCTAssertEqual(subagentActiveMs(activeMs: 0, activeSince: 10_000, status: "working", nowMs: 9_000), 0)
    }
}
