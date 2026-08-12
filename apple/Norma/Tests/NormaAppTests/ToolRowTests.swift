import XCTest
@testable import Norma

/// mac-chat-parity Task 2 — the pure logic behind the transcript's tool rows: per-call status,
/// the run's aggregate status, the bounded output preview, the collapsed-row failure summary, and
/// the expansion model the row renders.
///
/// **What this file does NOT cover, in every case below: the drawn row.** `TranscriptToolGroupRow`
/// is a SwiftUI `View` with no seam this suite can drive — nothing here proves a glyph is visible,
/// that the chevron rotates, that the output block has a background, that the expand target is big
/// enough to hit, or that any of it is legible. Those are the user's live gate (spec §9 item 2).
/// What IS proven here is that the row is *given* the right things to draw: the same convention
/// `ActivityRowTests`/`ActivityGroupingTests` already use for this file's view layer.
final class ToolRowTests: XCTestCase {
    private func call(
        detail: String? = nil,
        output: String? = nil,
        isError: Bool = false,
        callId: String? = nil
    ) -> ToolCallRecord {
        ToolCallRecord(callId: callId, detail: detail, output: output, isError: isError)
    }

    private func run(_ name: String, _ calls: [ToolCallRecord]) -> [ToolRunEntry] {
        [ToolRunEntry(name: name, calls: calls)]
    }

    // MARK: - Per-call status

    /// The failure mark comes from `isError` and nothing else — a failed `bash` was pixel-identical
    /// to a successful one before Task 2 because the reducer never kept the flag.
    func testAFailedCallReadsAsFailed() {
        XCTAssertEqual(
            toolCallStatus(output: "ENOENT: no such file", isError: true, turnIsLive: false),
            .failed
        )
        XCTAssertEqual(
            toolCallStatus(output: "ENOENT: no such file", isError: true, turnIsLive: true),
            .failed
        )
    }

    func testACallWithAResultAndNoErrorReadsAsSucceeded() {
        XCTAssertEqual(toolCallStatus(output: "1146 pass", isError: false, turnIsLive: false), .succeeded)
        XCTAssertEqual(toolCallStatus(output: "", isError: false, turnIsLive: true), .succeeded)
    }

    /// An empty result is still a RESULT — the tool ran and printed nothing. Only `nil` means "no
    /// result was ever seen".
    func testAnEmptyResultIsStillAResult() {
        XCTAssertEqual(toolCallStatus(output: "", isError: false, turnIsLive: false), .succeeded)
    }

    func testAResultlessCallIsRunningOnlyWhileTheTurnIsLive() {
        XCTAssertEqual(toolCallStatus(output: nil, isError: false, turnIsLive: true), .running)
    }

    /// **Task 1's handoff, pinned.** No `tool_result` is ever emitted for a call the user ESC'd —
    /// the engine's tool loop has no abort branch that synthesises one — so `output` stays `nil`
    /// PERMANENTLY. Deriving "running" from `output == nil` alone would render a replayed aborted
    /// turn as perpetually running, forever. `.unfinished` is a separate status from `.failed`
    /// because nothing reported an error: the call simply never came back.
    func testAResultlessCallOnAFinishedTurnIsUnfinishedNotRunning() {
        XCTAssertEqual(toolCallStatus(output: nil, isError: false, turnIsLive: false), .unfinished)
        XCTAssertNotEqual(toolCallStatus(output: nil, isError: false, turnIsLive: false), .running)
    }

    /// Defensive ordering: `isError` wins even without an output. The daemon always sends both
    /// together, so this is a guard against a second producer, not a live shape.
    func testIsErrorWinsOverAMissingOutput() {
        XCTAssertEqual(toolCallStatus(output: nil, isError: true, turnIsLive: true), .failed)
    }

    // MARK: - Run status (what the collapsed row's one glyph says)

    func testARunOfSucceededCallsReadsAsSucceeded() {
        let entries = run("bash", [call(output: "a"), call(output: "b")])
        XCTAssertEqual(toolRunStatus(entries, turnIsLive: false), .succeeded)
    }

    /// Precedence is iOS's (research §2.2): a live call outranks a finished failure, because the
    /// row is not done saying what happened yet — the glyph flips to the failure once the run ends.
    func testRunningOutranksFailed() {
        let entries = run("bash", [call(output: "boom", isError: true), call(output: nil)])
        XCTAssertEqual(toolRunStatus(entries, turnIsLive: true), .running)
    }

    func testFailedOutranksUnfinishedAndSucceeded() {
        let entries = run("bash", [call(output: "ok"), call(output: "boom", isError: true), call(output: nil)])
        XCTAssertEqual(toolRunStatus(entries, turnIsLive: false), .failed)
    }

    func testUnfinishedOutranksSucceeded() {
        let entries = run("bash", [call(output: "ok"), call(output: nil)])
        XCTAssertEqual(toolRunStatus(entries, turnIsLive: false), .unfinished)
    }

    func testAggregateSpansEveryEntryOfTheRunNotJustTheFirst() {
        let entries = [
            ToolRunEntry(name: "read", calls: [call(output: "ok")]),
            ToolRunEntry(name: "bash", calls: [call(output: "boom", isError: true)]),
        ]
        XCTAssertEqual(toolRunStatus(entries, turnIsLive: false), .failed)
    }

    /// Every status maps to a distinct glyph, so the four are visually separable at all. Colour is
    /// deliberately NOT part of the mapping (see the row's own doc) and is not asserted here.
    func testEveryStatusHasItsOwnGlyphAndSpokenLabel() {
        let all: [ToolCallStatus] = [.running, .succeeded, .failed, .unfinished]
        XCTAssertEqual(Set(all.map(toolStatusSymbol)).count, all.count)
        XCTAssertEqual(Set(all.map(toolStatusAccessibilityLabel)).count, all.count)
    }

    // MARK: - Output preview

    /// Nothing to draw when no result was ever seen — the status glyph is what speaks then.
    func testNoResultMeansNoOutputBlock() {
        XCTAssertNil(toolOutputPreview(nil))
    }

    /// An empty result yields an EMPTY preview rather than no preview: the row still shows a block
    /// (the view draws "No output" in it), which is how "ran and printed nothing" is told apart
    /// from "never came back".
    func testAnEmptyResultStillGetsABlock() {
        XCTAssertEqual(toolOutputPreview(""), ToolOutputPreview(text: "", elision: nil))
    }

    func testAShortResultIsShownWholeWithNoElision() {
        XCTAssertEqual(
            toolOutputPreview("1146 pass, 0 fail"),
            ToolOutputPreview(text: "1146 pass, 0 fail", elision: nil)
        )
    }

    /// Tool output almost always ends in a newline; a trailing blank line inside the block is pure
    /// noise. Leading whitespace is preserved — indentation is meaning.
    func testTrailingBlankSpaceIsTrimmedButLeadingIndentIsNot() {
        XCTAssertEqual(
            toolOutputPreview("  indented\n\n\n"),
            ToolOutputPreview(text: "  indented", elision: nil)
        )
    }

    func testALongResultIsClippedToTheLineBoundAndSaysHowMuchIsWithheld() {
        let body = (1...10).map { "line \($0)" }.joined(separator: "\n")
        let preview = toolOutputPreview(body, maxLines: 3, maxCharacters: 10_000)
        XCTAssertEqual(preview?.text, "line 1\nline 2\nline 3")
        XCTAssertEqual(preview?.elision, "… \(body.count - 20) more characters")
    }

    /// The line bound cannot see a single enormous line (a minified JSON blob, a `base64` dump), so
    /// the character bound exists alongside it.
    func testAWideSingleLineResultIsClippedToTheCharacterBound() {
        let body = String(repeating: "x", count: 500)
        let preview = toolOutputPreview(body, maxLines: 40, maxCharacters: 100)
        XCTAssertEqual(preview?.text, String(repeating: "x", count: 100))
        XCTAssertEqual(preview?.elision, "… 400 more characters")
    }

    /// The reducer stores its truncation marker INSIDE the string (Task 1), at the end — so any
    /// renderer-side clip cuts it off, and the user would see neither the rest of the output nor
    /// any hint that more of it ever existed. It is lifted out of the body and into the note, so it
    /// survives the clip.
    func testTheStoredTruncationMarkerSurvivesARendererClip() {
        let cap = SessionReducer.maxToolOutputCharacters
        let body = String(repeating: "y", count: 300)
        let stored = body + "\n[… truncated at \(cap) characters]"
        let preview = toolOutputPreview(stored, maxLines: 40, maxCharacters: 100)
        XCTAssertEqual(preview?.text, String(repeating: "y", count: 100))
        XCTAssertEqual(
            preview?.elision,
            "… 200 more characters; the result was truncated at \(cap) characters"
        )
    }

    /// …and it is never left sitting in the body as though the tool had printed it.
    func testTheStoredTruncationMarkerIsNotShownAsOutput() {
        let cap = SessionReducer.maxToolOutputCharacters
        let preview = toolOutputPreview("short\n[… truncated at \(cap) characters]")
        XCTAssertEqual(preview?.text, "short")
        XCTAssertEqual(preview?.elision, "… the result was truncated at \(cap) characters")
    }

    /// A tool that legitimately prints something marker-shaped but at a different number is NOT
    /// treated as the reducer's marker — the match is built from the reducer's own constant.
    func testAMarkerShapedLineFromTheToolItselfIsLeftAlone() {
        let text = "hello\n[… truncated at 12 characters]"
        XCTAssertEqual(toolOutputPreview(text), ToolOutputPreview(text: text, elision: nil))
    }

    // MARK: - Failure summary (what the COLLAPSED row shows without being expanded)

    /// The complaint this task fixes is "I can't see what the tool did"; a failure the user has to
    /// expand to read would be a smaller version of it. The collapsed row therefore carries the
    /// failure's first line, which is where every tool puts its error.
    func testTheCollapsedRowShowsTheFirstLineOfTheFirstFailure() {
        let entries = run("bash", [
            call(output: "fine"),
            call(output: "error: no such file\n  at foo.ts:1\n  at bar.ts:2", isError: true),
            call(output: "later failure", isError: true),
        ])
        XCTAssertEqual(toolRunFailureSummary(entries), "error: no such file")
    }

    func testThereIsNoFailureSummaryWithoutAFailure() {
        XCTAssertNil(toolRunFailureSummary(run("bash", [call(output: "fine"), call(output: nil)])))
    }

    /// A failure whose output is blank has nothing to say — the glyph alone speaks, and an empty
    /// line is not drawn.
    func testABlankFailureOutputHasNoSummary() {
        XCTAssertNil(toolRunFailureSummary(run("bash", [call(output: "\n   \n", isError: true)])))
        XCTAssertNil(toolRunFailureSummary(run("bash", [call(output: nil, isError: true)])))
    }

    /// One line, bounded — the collapsed row is a single line of chrome, not a place for a stack
    /// trace.
    func testTheFailureSummaryIsBounded() {
        let long = String(repeating: "e", count: 400)
        let summary = toolRunFailureSummary(run("bash", [call(output: long, isError: true)]))
        XCTAssertEqual(summary, String(repeating: "e", count: maxFailureSummaryCharacters) + "…")
    }

    // MARK: - Expansion model

    /// Expanding shows EVERY call — including the ones with neither a detail nor a result, which
    /// used to contribute no line at all (research §2.3's five-`browser`-calls-expand-to-nothing).
    func testExpansionListsEveryCallInOrderAcrossEntries() {
        let entries = [
            ToolRunEntry(name: "read", calls: [call(detail: "/a", output: "contents of a"), call()]),
            ToolRunEntry(name: "bash", calls: [call(detail: "pnpm test", output: "boom", isError: true)]),
        ]
        let expansion = toolRunExpansion(entries, turnIsLive: false)
        XCTAssertEqual(expansion.lines.map(\.name), ["read", "read", "bash"])
        XCTAssertEqual(expansion.lines.map(\.detail), ["/a", nil, "pnpm test"])
        XCTAssertEqual(expansion.lines.map(\.status), [.succeeded, .unfinished, .failed])
        XCTAssertEqual(expansion.lines[0].output, ToolOutputPreview(text: "contents of a", elision: nil))
        XCTAssertNil(expansion.lines[1].output)
        XCTAssertEqual(expansion.lines[2].output, ToolOutputPreview(text: "boom", elision: nil))
        XCTAssertNil(expansion.note)
    }

    func testExpansionMarksStillRunningCallsWhileTheTurnIsLive() {
        let entries = run("bash", [call(output: "done"), call()])
        XCTAssertEqual(toolRunExpansion(entries, turnIsLive: true).lines.map(\.status), [.succeeded, .running])
    }

    /// A marathon run (the reducer keeps up to 200 calls per exchange) must not turn one click into
    /// hundreds of monospaced blocks. Every call still gets its LINE — those are cheap and are the
    /// record of what ran; only the blocks are budgeted, and the row says how many it withheld.
    func testAnEnormousRunBudgetsItsOutputBlocksAndSaysSo() {
        let entries = run("bash", (0..<30).map { call(detail: "cmd \($0)", output: "out \($0)") })
        let expansion = toolRunExpansion(entries, turnIsLive: false, maxOutputBlocks: 25)
        XCTAssertEqual(expansion.lines.count, 30)
        XCTAssertEqual(expansion.lines.filter { $0.output != nil }.count, 25)
        XCTAssertNil(expansion.lines[25].output)
        XCTAssertEqual(expansion.note, "… output for 5 more calls is not shown")
    }

    /// Calls with no result don't consume the budget — otherwise a run of in-flight calls could
    /// spend it all on blocks that draw nothing.
    func testResultlessCallsDoNotSpendTheOutputBudget() {
        let entries = run("bash", [call(), call(), call(output: "shown")])
        let expansion = toolRunExpansion(entries, turnIsLive: false, maxOutputBlocks: 1)
        XCTAssertEqual(expansion.lines[2].output, ToolOutputPreview(text: "shown", elision: nil))
        XCTAssertNil(expansion.note)
    }

    func testAnEmptyRunExpandsToNothingAndClaimsNothing() {
        let expansion = toolRunExpansion([], turnIsLive: false)
        XCTAssertEqual(expansion.lines, [])
        XCTAssertNil(expansion.note)
        XCTAssertEqual(toolRunStatus([], turnIsLive: false), .succeeded)
    }
}
