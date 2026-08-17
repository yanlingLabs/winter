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
        callId: String? = nil,
        fileDiff: FileDiffRef? = nil
    ) -> ToolCallRecord {
        ToolCallRecord(callId: callId, detail: detail, output: output, isError: isError,
                       fileDiff: fileDiff)
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

    // MARK: - The in-flight placeholder (fix round 1, Important-1)

    /// An expanded call that has not come back drew a bare tool name and nothing else, which reads
    /// as "this tool did nothing" rather than "this tool has not finished". iOS says "Running…"
    /// there. Does NOT cover that the words are drawn in the block chrome, only that they exist —
    /// and deliberately does not cover any animation, because there is none: this file's content
    /// renders under the orb morph's scale/blur/opacity bands, where repeating animation is banned.
    func testARunningCallSaysSoWhereItsOutputWouldBe() {
        XCTAssertEqual(toolCallOutputPlaceholder(.running), "Running…")
    }

    /// No other state fills the block with words. `.unfinished` in particular stays silent: on a
    /// replayed aborted turn every interrupted call would otherwise repeat the same line, and its
    /// glyph already carries it.
    func testOnlyARunningCallGetsWordsInPlaceOfOutput() {
        XCTAssertNil(toolCallOutputPlaceholder(.succeeded))
        XCTAssertNil(toolCallOutputPlaceholder(.failed))
        XCTAssertNil(toolCallOutputPlaceholder(.unfinished))
    }

    // MARK: - Expansion identity (fix round 1, Minor-5)

    /// Expansion state used to be keyed by a run's POSITION in `groupActivity`'s output. The
    /// reducer caps an exchange's activity at 200 items and drops the OLDEST, so during a marathon
    /// turn every surviving group shifts down — and an open expansion would land on a neighbouring
    /// run's output. The key follows the run instead.
    ///
    /// This drives the key function against real `groupActivity` output before and after an
    /// eviction. It does NOT cover the `@State` set in `TranscriptExchangeRow` that consumes the
    /// key, nor what SwiftUI draws.
    func testTheExpansionKeyFollowsTheRunNotItsPosition() {
        let evicted = ActivityItem(kind: .tool(name: "read", detail: "/old", callId: "c0"))
        let breaker = ActivityItem(kind: .interaction(InteractionRecord(callId: "a1", ask: .approval(toolName: "bash", summary: "needs approval"))))
        let survivor = [
            ActivityItem(kind: .tool(name: "bash", detail: "a", callId: "c1")),
            ActivityItem(kind: .tool(name: "bash", detail: "b", callId: "c2")),
        ]

        let before = groupActivity([evicted, breaker] + survivor)
        let after = groupActivity(Array(([evicted, breaker] + survivor).dropFirst(2)))
        guard case .toolRun(let runBefore) = before[2], case .toolRun(let runAfter) = after[0] else {
            return XCTFail("expected the same run at index 2 before eviction and index 0 after")
        }

        // The run moved from group index 2 to group index 0 — the positional key the old scheme
        // used therefore changed by construction, while this one does not.
        XCTAssertEqual(
            toolRunExpansionKey(runBefore, fallbackIndex: 2),
            toolRunExpansionKey(runAfter, fallbackIndex: 0)
        )
    }

    func testTwoDifferentRunsNeverShareAnExpansionKey() {
        let a = [ToolRunEntry(name: "bash", calls: [call(callId: "c1")])]
        let b = [ToolRunEntry(name: "bash", calls: [call(callId: "c2")])]
        XCTAssertNotEqual(toolRunExpansionKey(a, fallbackIndex: 0), toolRunExpansionKey(b, fallbackIndex: 0))
    }

    /// A run whose calls carry no `callId` — the pre-Task-1 shape, still reachable from tests —
    /// falls back to the positional key. No worse than the old behaviour, and the prefix keeps it
    /// from ever colliding with a real callId.
    func testARunWithNoCallIdFallsBackToItsPosition() {
        let entries = [ToolRunEntry(name: "bash", calls: [call()])]
        XCTAssertEqual(toolRunExpansionKey(entries, fallbackIndex: 3), "index:3")
        XCTAssertNotEqual(
            toolRunExpansionKey(entries, fallbackIndex: 3),
            toolRunExpansionKey([ToolRunEntry(name: "bash", calls: [call(callId: "3")])], fallbackIndex: 9)
        )
    }

    /// The key is the run's FIRST callId wherever it appears, so a leading call built without one
    /// does not push the run onto the positional fallback.
    func testTheKeyIsTheFirstCallIdInTheRunEvenIfEarlierCallsLackOne() {
        let entries = [
            ToolRunEntry(name: "read", calls: [call()]),
            ToolRunEntry(name: "bash", calls: [call(callId: "c7")]),
        ]
        XCTAssertEqual(toolRunExpansionKey(entries, fallbackIndex: 0), "call:c7")
    }

    func testAnEmptyRunExpandsToNothingAndClaimsNothing() {
        let expansion = toolRunExpansion([], turnIsLive: false)
        XCTAssertEqual(expansion.lines, [])
        XCTAssertNil(expansion.note)
        XCTAssertEqual(toolRunStatus([], turnIsLive: false), .succeeded)
    }

    // MARK: - diff-tabs Task 9: the diff chip

    private func diff(_ path: String, added: Int, removed: Int, diffId: String = "d1") -> FileDiffRef {
        FileDiffRef(path: path, added: added, removed: removed, diffId: diffId)
    }

    /// The chip PRINTS the last two path components and the counts in the ruled order — `-N` first,
    /// then `+M` (design spec §3's `path -33 +198`). The order is not cosmetic: it is the same order
    /// the daemon's own confirmation string uses, so the transcript and the tool's own words agree.
    func testTheChipShowsTheLastTwoPathComponentsAndTheCountsRemovedFirst() {
        let ref = diff("packages/core/src/agent/engine.ts", added: 198, removed: 33)
        XCTAssertEqual(fileDiffChipDisplayPath(ref.path), "agent/engine.ts")
        XCTAssertEqual(fileDiffChipRemovedText(ref), "-33")
        XCTAssertEqual(fileDiffChipAddedText(ref), "+198")
        XCTAssertEqual(fileDiffChipText(ref), "agent/engine.ts -33 +198")
    }

    /// The path is the tool argument AS RECEIVED (`FileDiffRef`'s own doc) — relative, absolute, a
    /// bare filename, spaces and all. Every one of these is a STRING operation; nothing resolves a
    /// path or touches the disk.
    func testTheChipPathTailIsTotalOverEveryShapeTheWireCanCarry() {
        XCTAssertEqual(fileDiffChipDisplayPath("/Users/k/norma v2/core.ts"), "norma v2/core.ts")
        XCTAssertEqual(fileDiffChipDisplayPath("src/engine.ts"), "src/engine.ts")
        XCTAssertEqual(fileDiffChipDisplayPath("engine.ts"), "engine.ts",
                       "one component is the whole answer, not a truncated two")
        XCTAssertEqual(fileDiffChipDisplayPath("./engine.ts"), "./engine.ts")
        XCTAssertEqual(fileDiffChipDisplayPath("a//b//c.ts"), "b/c.ts",
                       "an empty component must not eat one of the two")
        XCTAssertEqual(fileDiffChipDisplayPath("/engine.ts"), "engine.ts")
        XCTAssertEqual(fileDiffChipDisplayPath(""), "")
    }

    /// **Notebook reserialization, carried from Task 6's review as a display obligation.** A first
    /// edit to an externally-formatted `.ipynb` legitimately reports whole-file-scale counts, because
    /// the tool diffs against its own reserialization. The chip renders what the counts say — it does
    /// not second-guess, clamp or abbreviate them.
    func testTheChipRendersWholeFileScaleNotebookCountsVerbatim() {
        let ref = diff("notebooks/analysis.ipynb", added: 4_812, removed: 4_796)
        XCTAssertEqual(fileDiffChipText(ref), "notebooks/analysis.ipynb -4796 +4812")
    }

    /// A run with no diffs offers no chip — which is every run in every session that predates the
    /// feature, and every run of tools that touch no files.
    func testARunWithNoDiffsOffersNoChip() {
        let entries = run("bash", [call(detail: "pnpm test", output: "1146 pass")])
        XCTAssertTrue(toolRunDiffChips(entries).isEmpty)
        XCTAssertEqual(toolRunCollapsedDiffChips(entries), ToolRunDiffChips(chips: [], note: nil))
        XCTAssertNil(toolRunExpansion(entries, turnIsLive: false).lines[0].fileDiff)
    }

    /// Chips come from the calls that CARRY a diff, in call order, across entries — and only from
    /// those. The gate is the diff's presence, never the tool's name (`ToolCallRecord.fileDiff`).
    func testChipsComeFromTheCallsThatCarryADiffInOrder() {
        let entries = [
            ToolRunEntry(name: "edit", calls: [
                call(detail: "a.ts", output: "ok", fileDiff: diff("src/a.ts", added: 3, removed: 1, diffId: "d1")),
                call(detail: "b.ts", output: "ok"),
            ]),
            ToolRunEntry(name: "read", calls: [call(detail: "c.ts", output: "…")]),
            ToolRunEntry(name: "write", calls: [
                call(detail: "d.ts", output: "ok", fileDiff: diff("src/d.ts", added: 9, removed: 0, diffId: "d2")),
            ]),
        ]
        XCTAssertEqual(toolRunDiffChips(entries).map(\.diffId), ["d1", "d2"])
        // The expansion carries each call's own diff on its own line — so every chip the collapsed
        // row bounds away is still reachable by expanding.
        XCTAssertEqual(toolRunExpansion(entries, turnIsLive: false).lines.map { $0.fileDiff?.diffId },
                       ["d1", nil, nil, "d2"])
    }

    /// The collapsed row is BOUNDED — a 40-edit turn must not push forty chip rows between two
    /// sentences of prose — and it SAYS what it withheld, so a diff is never silently unreachable.
    func testTheCollapsedRowBoundsItsChipsAndNamesWhatItWithheld() {
        let entries = run("edit", (0..<9).map {
            call(detail: "f\($0).ts", output: "ok", fileDiff: diff("src/f\($0).ts", added: 1, removed: 1, diffId: "d\($0)"))
        })
        let bounded = toolRunCollapsedDiffChips(entries, max: 6)
        XCTAssertEqual(bounded.chips.map(\.diffId), ["d0", "d1", "d2", "d3", "d4", "d5"])
        XCTAssertEqual(bounded.note, "… 3 more files — expand to open their diffs")
        // Under the bound: every chip, no note. (A fresh single-call run — `run(_:_:)` builds ONE
        // entry holding every call, so slicing the entry array above would not have shortened it.)
        let few = toolRunCollapsedDiffChips(
            run("edit", [call(output: "ok", fileDiff: diff("src/only.ts", added: 1, removed: 1))]),
            max: 6)
        XCTAssertEqual(few.chips.count, 1)
        XCTAssertNil(few.note)
        // Exactly one over: singular prose, not "1 more files".
        let seven = run("edit", (0..<7).map {
            call(output: "ok", fileDiff: diff("src/g\($0).ts", added: 1, removed: 1, diffId: "g\($0)"))
        })
        XCTAssertEqual(toolRunCollapsedDiffChips(seven, max: 6).note,
                       "… 1 more file — expand to open its diff")
    }

    /// **The transcript never reaches for the shell.**
    ///
    /// The diff chip is the first thing in `ChatContent/` that causes a panel tab to open, and the
    /// obvious way to build it — read `ShellSessionHost` directly — would weld this shared surface to
    /// the one window that has a panel, breaking the orb's morph window and every detached window
    /// that render the very same views. The door is a plain closure (`WindowContentView.onOpenDiff`)
    /// and this is what keeps it one.
    ///
    /// Comments are stripped first, so writing down the reason (this file's own doc comments name the
    /// type repeatedly) is not itself a violation — the `TranscriptBrandTests`/`ComposerChromeTests`
    /// convention.
    ///
    /// editor-product Task 6: `"openFileTab"` joins the banned list — the SECOND transcript→panel
    /// door (`WindowContentView.onOpenFile`) is built on the identical closure discipline, and this
    /// is the pin that keeps it that way.
    func testChatContentNeverReachesForTheShellHost() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ChatContent")
        var scanned = 0
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        while let url = walker?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let code = try String(contentsOf: url, encoding: .utf8)
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.drop(while: { $0 == " " }).hasPrefix("//") ? "" : String($0) }
                .joined(separator: "\n")
            for name in ["ShellSessionHost", "PanelStore", "openPanelTab", "activatePanelTab",
                         "openFileTab"] {
                XCTAssertFalse(code.contains(name),
                               "\(url.lastPathComponent) reaches for \(name) — the diff/file doors "
                               + "must stay closures the window layer injects")
            }
            scanned += 1
        }
        XCTAssertEqual(scanned, 12, "ChatContent's file count changed — confirm the new file is scanned")
    }

    // MARK: - editor-product Task 6: the file door's row-level gate

    /// Every tool that could plausibly be confused for a file path, and the four that actually are
    /// one. `glob`/`grep`/`ls` deliberately share `SessionModel.extractToolDetail`'s switch arm with
    /// the four file-door tools but are EXCLUDED from `fileDoorToolNames` — this is the pin that
    /// would catch a future author "helpfully" widening the set to match that other grouping.
    func testOnlyTheFourFileDoorToolsAreEverConsideredAPath() {
        for name in ["read", "write", "edit", "notebook_edit"] {
            XCTAssertTrue(toolDetailIsClickablePath(name: name, detail: "/repo/a.ts",
                                                    sessionHasWorkingDirectory: false),
                          "\(name) is one of the four — an absolute detail must be clickable")
        }
        for name in ["glob", "grep", "ls", "bash", "browser", "lsp", "web_fetch", "computer"] {
            XCTAssertFalse(toolDetailIsClickablePath(name: name, detail: "/repo/a.ts",
                                                     sessionHasWorkingDirectory: true),
                           "\(name) is not a file-door tool, even with an absolute-looking detail "
                           + "and a session that has a working directory")
        }
    }

    /// The shape gate: absolute is unconditional; relative needs the session's own working
    /// directory to resolve against, exactly the resolution `ShellSessionHost.resolvedFilePath`
    /// performs against the SAME fact.
    func testAnAbsolutePathIsAlwaysClickableAndARelativeOneOnlyWithASessionCwd() {
        XCTAssertTrue(toolDetailIsClickablePath(name: "read", detail: "/repo/a.ts",
                                                sessionHasWorkingDirectory: false),
                      "reads carry no path fence — a dirless session can still open an absolute path")
        XCTAssertFalse(toolDetailIsClickablePath(name: "edit", detail: "src/a.ts",
                                                 sessionHasWorkingDirectory: false),
                       "a relative path with nothing to resolve it against must not invite a click")
        XCTAssertTrue(toolDetailIsClickablePath(name: "edit", detail: "src/a.ts",
                                                sessionHasWorkingDirectory: true))
    }

    func testAnEmptyDetailIsNeverClickable() {
        XCTAssertFalse(toolDetailIsClickablePath(name: "read", detail: "",
                                                 sessionHasWorkingDirectory: true))
    }

    /// **`SessionModel.clipToolDetail` truncates SILENTLY** — no marker, unlike the output preview's
    /// truncation note — so a detail sitting AT the ceiling might be a cut prefix of a real, longer,
    /// still-openable path. Refusing it is the safe failure; a path comfortably under the ceiling was
    /// never touched by the clip and must still be offered.
    func testADetailAtTheClipCeilingIsRefusedAsPossiblyTruncated() {
        let atCeiling = "/" + String(repeating: "a", count: SessionReducer.maxToolDetailCharacters - 1)
        XCTAssertEqual(atCeiling.count, SessionReducer.maxToolDetailCharacters)
        XCTAssertFalse(toolDetailIsClickablePath(name: "read", detail: atCeiling,
                                                 sessionHasWorkingDirectory: true),
                       "a detail this long might be `clipToolDetail`'s silent cut of a longer path")

        let underCeiling = "/" + String(repeating: "a", count: SessionReducer.maxToolDetailCharacters - 2)
        XCTAssertEqual(underCeiling.count, SessionReducer.maxToolDetailCharacters - 1)
        XCTAssertTrue(toolDetailIsClickablePath(name: "read", detail: underCeiling,
                                                sessionHasWorkingDirectory: true),
                      "comfortably under the ceiling — clipToolDetail never touched this one")
    }

    // MARK: - editor-product Task 6: the row itself (with-closure → Button, nil → today's plain text)

    /// Depth-first search for a value of type `T` anywhere inside `value`'s reflection tree — the
    /// `PanelWebChromeTests`/`ComposerChromeTests` technique: no window, no host, nothing mounted,
    /// only the declarative view VALUE `body` already produced. The depth allowance is generous
    /// (SwiftUI's own `if`/`HStack` storage adds several unseen levels of its own between a `body`
    /// and a custom leaf type — measured deeper here than `PanelWebChromeTests`' own two-level
    /// `AnyView` case, so its `6` is not reused blind).
    private static func firstDescendant<T>(_ type: T.Type, in value: Any, depth: Int = 0) -> T? {
        if let hit = value as? T { return hit }
        guard depth < 12 else { return nil }
        for child in Mirror(reflecting: value).children {
            if let hit = firstDescendant(type, in: child.value, depth: depth + 1) { return hit }
        }
        return nil
    }

    private func line(name: String = "read", detail: String? = "/repo/a.ts") -> ToolRunCallLine {
        ToolRunCallLine(name: name, detail: detail, status: .succeeded, output: nil, fileDiff: nil)
    }

    /// **The pin: a wired door plus a clickable path becomes a REAL `ToolRowFilePathButton`,
    /// carrying the exact path and the exact closure the row was handed** — not merely "some button
    /// appeared", which a stray unrelated `Button` elsewhere in the tree could satisfy vacuously.
    @MainActor
    func testAClickablePathRendersAsAButtonWiredToTheExactPathAndClosure() throws {
        var opened: String?
        let view = ToolRunCallDetailText(line: line(detail: "/repo/src/a.ts"),
                                         onOpenFile: { opened = $0 },
                                         sessionHasWorkingDirectory: false)
        let button = try XCTUnwrap(
            Self.firstDescendant(ToolRowFilePathButton.self, in: view.body),
            "an absolute path on a file-door tool with a wired closure must render a clickable button")
        XCTAssertEqual(button.path, "/repo/src/a.ts")
        button.onOpen(button.path)
        XCTAssertEqual(opened, "/repo/src/a.ts", "the button's action must be the SAME closure the "
                       + "row was handed, invoked with the SAME path it displays")
    }

    /// **`onOpenFile == nil` → no button anywhere in the tree.** This is the "byte-identical to
    /// today" pin's view-layer half: the `else` branch is the untouched pre-Task-6 expression, and
    /// this proves nothing upstream of it ever reaches a `ToolRowFilePathButton` when the door isn't
    /// wired — regardless of how clickable the path would otherwise look.
    @MainActor
    func testANilDoorNeverRendersAButtonEvenForAnObviouslyClickablePath() {
        let view = ToolRunCallDetailText(line: line(detail: "/repo/src/a.ts"),
                                         onOpenFile: nil, sessionHasWorkingDirectory: true)
        XCTAssertNil(Self.firstDescendant(ToolRowFilePathButton.self, in: view.body),
                    "no door wired -> today's plain text, unchanged")
    }

    /// A wired door is necessary but not sufficient — every gate `toolDetailIsClickablePath` enforces
    /// must actually reach the view, not just the pure function's own unit tests above.
    @MainActor
    func testAWiredDoorStillRefusesEveryShapeTheGateRefuses() {
        let nonFileTool = ToolRunCallDetailText(line: line(name: "bash", detail: "/repo/a.ts"),
                                                onOpenFile: { _ in }, sessionHasWorkingDirectory: true)
        XCTAssertNil(Self.firstDescendant(ToolRowFilePathButton.self, in: nonFileTool.body),
                    "bash's detail is a shell command, never a file-door path")

        let relativeNoCwd = ToolRunCallDetailText(line: line(detail: "src/a.ts"),
                                                  onOpenFile: { _ in }, sessionHasWorkingDirectory: false)
        XCTAssertNil(Self.firstDescendant(ToolRowFilePathButton.self, in: relativeNoCwd.body),
                    "a relative path with nothing to resolve it against must not become a button")

        let noDetail = ToolRunCallDetailText(line: line(detail: nil),
                                             onOpenFile: { _ in }, sessionHasWorkingDirectory: true)
        XCTAssertNil(Self.firstDescendant(ToolRowFilePathButton.self, in: noDetail.body),
                    "no detail at all -> the bare tool-name fallback, never a button")
    }

    /// A relative path DOES become a button once the session has somewhere to resolve it —
    /// the positive mirror of the refusal above, so the gate is proven both ways at the view layer.
    @MainActor
    func testAWiredDoorOffersARelativePathOnceTheSessionHasAWorkingDirectory() throws {
        let view = ToolRunCallDetailText(line: line(name: "edit", detail: "src/a.ts"),
                                         onOpenFile: { _ in }, sessionHasWorkingDirectory: true)
        _ = try XCTUnwrap(Self.firstDescendant(ToolRowFilePathButton.self, in: view.body))
    }
}
