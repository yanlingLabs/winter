import XCTest
import AppKit
import SwiftUI
@testable import Norma

/// diff-tabs Task 10 — the diff tab: the parser, the renderer's state machine, and the pure
/// presentation decisions around them.
///
/// **The parser fixtures are the load-bearing half.** Every expected `[DiffRow]` array below was
/// numbered BY HAND from the patch text beside it, then cross-checked against the shape this repo's
/// own emitter produces: `realEmitterOutput` is a patch printed by
/// `computeLineDiff` (`packages/core/src/diffs/myers.ts`) at author time, pasted verbatim. That
/// matters because the two rules a unified-diff parser can get silently wrong — where a `,0` hunk's
/// counter starts, and whether `\ No newline at end of file` advances anything — are invisible in
/// any patch that lacks them, and every one of the daemon's own patches is a valid input.
@MainActor
final class DiffRenderTests: XCTestCase {
    // MARK: - 1. The parser, fixture by fixture

    /// A patch this repo's Myers module actually printed (diffing a 10-line file into an 11-line one
    /// with one line changed and one appended). Two hunks, both with real context — the ordinary
    /// case, and the one that proves the counters survive a hunk boundary rather than restarting.
    private let realEmitterOutput = """
        @@ -1,6 +1,6 @@
         one
         two
        -three
        +THREE
         four
         five
         six
        @@ -8,3 +8,4 @@
         eight
         nine
         ten
        +eleven

        """

    func testASingleHunkParsesToExactlyNumberedRows() {
        let patch = """
            @@ -1,4 +1,4 @@
             import Foundation
            -let a = 1
            +let a = 2
             let b = 3
             let c = 4

            """
        XCTAssertEqual(UnifiedDiffParser.parse(patch), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -1,4 +1,4 @@"),
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "import Foundation"),
            DiffRow(kind: .removed, oldLine: 2, newLine: nil, text: "let a = 1"),
            DiffRow(kind: .added, oldLine: nil, newLine: 2, text: "let a = 2"),
            DiffRow(kind: .context, oldLine: 3, newLine: 3, text: "let b = 3"),
            DiffRow(kind: .context, oldLine: 4, newLine: 4, text: "let c = 4"),
        ])
    }

    /// Two hunks: the second header RESETS both counters to its own start, and the rows after it are
    /// numbered from there rather than continuing the first hunk's run.
    func testTwoHunksEachRestartFromTheirOwnHeader() {
        XCTAssertEqual(UnifiedDiffParser.parse(realEmitterOutput), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -1,6 +1,6 @@"),
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "one"),
            DiffRow(kind: .context, oldLine: 2, newLine: 2, text: "two"),
            DiffRow(kind: .removed, oldLine: 3, newLine: nil, text: "three"),
            DiffRow(kind: .added, oldLine: nil, newLine: 3, text: "THREE"),
            DiffRow(kind: .context, oldLine: 4, newLine: 4, text: "four"),
            DiffRow(kind: .context, oldLine: 5, newLine: 5, text: "five"),
            DiffRow(kind: .context, oldLine: 6, newLine: 6, text: "six"),
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -8,3 +8,4 @@"),
            DiffRow(kind: .context, oldLine: 8, newLine: 8, text: "eight"),
            DiffRow(kind: .context, oldLine: 9, newLine: 9, text: "nine"),
            DiffRow(kind: .context, oldLine: 10, newLine: 10, text: "ten"),
            DiffRow(kind: .added, oldLine: nil, newLine: 11, text: "eleven"),
        ])
    }

    /// **`-a,0` — the insertion-point rule.** This exact patch is real emitter output: inserting `X`
    /// and `Y` after old line 2 of `a\nb\nc\n` prints `@@ -2,0 +3,2 @@`. The new side numbers from
    /// 3; the old side contributes no rows at all, so its (adjusted) counter is never consumed.
    func testAnInsertionOnlyHunkNumbersTheNewSideAndLeavesTheOldSideNil() {
        let patch = """
            @@ -2,0 +3,2 @@
            +X
            +Y

            """
        XCTAssertEqual(UnifiedDiffParser.parse(patch), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -2,0 +3,2 @@"),
            DiffRow(kind: .added, oldLine: nil, newLine: 3, text: "X"),
            DiffRow(kind: .added, oldLine: nil, newLine: 4, text: "Y"),
        ])
    }

    /// **`+c,0` — the mirror.** Real emitter output for deleting `b` and `c` from `a\nb\nc\nd\n`:
    /// `@@ -2,2 +1,0 @@`. The old side numbers from 2; the new side contributes nothing.
    func testADeletionOnlyHunkNumbersTheOldSideAndLeavesTheNewSideNil() {
        let patch = """
            @@ -2,2 +1,0 @@
            -b
            -c

            """
        XCTAssertEqual(UnifiedDiffParser.parse(patch), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -2,2 +1,0 @@"),
            DiffRow(kind: .removed, oldLine: 2, newLine: nil, text: "b"),
            DiffRow(kind: .removed, oldLine: 3, newLine: nil, text: "c"),
        ])
    }

    /// **The no-newline marker is DROPPED and the line it describes is KEPT** — and it advances no
    /// counter, which is the part that would go wrong silently: treating it as a body line would
    /// shift every subsequent number in the hunk by one. Real emitter output (`alpha\nbeta` →
    /// `alpha\nbeta!`, neither file newline-terminated), so both sides carry a marker.
    func testTheNoNewlineMarkerIsDroppedButItsLineSurvives() {
        let patch = """
            @@ -1,2 +1,2 @@
             alpha
            -beta
            \\ No newline at end of file
            +beta!
            \\ No newline at end of file

            """
        XCTAssertEqual(UnifiedDiffParser.parse(patch), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -1,2 +1,2 @@"),
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "alpha"),
            DiffRow(kind: .removed, oldLine: 2, newLine: nil, text: "beta"),
            DiffRow(kind: .added, oldLine: nil, newLine: 2, text: "beta!"),
        ])
    }

    /// The daemon's truncation marker becomes its own row — the banner the renderer draws — and
    /// nothing before it is disturbed.
    func testTheTruncationMarkerBecomesABannerRow() {
        let patch = """
            @@ -1,2 +1,2 @@
             a
            -b
            +B
            \(UnifiedDiffParser.truncationMarker)

            """
        XCTAssertEqual(UnifiedDiffParser.parse(patch), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -1,2 +1,2 @@"),
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .removed, oldLine: 2, newLine: nil, text: "b"),
            DiffRow(kind: .added, oldLine: nil, newLine: 2, text: "B"),
            DiffRow(kind: .truncatedBanner, oldLine: nil, newLine: nil,
                    text: UnifiedDiffParser.truncationMarker),
        ])
        XCTAssertEqual(UnifiedDiffParser.truncationMarker, "[patch truncated]",
                       "the marker is the daemon's literal (diffs/store.ts's TRUNCATION_MARKER) — "
                           + "changing it here silently stops recognising real truncated patches")
    }

    /// An empty patch is the emitter's own answer for "nothing changed" (`computeLineDiff` returns
    /// `patch: ""` when every op is `eq`), so it must be an ordinary empty result rather than
    /// anything the renderer treats as broken.
    func testAnEmptyPatchParsesToNoRows() {
        XCTAssertEqual(UnifiedDiffParser.parse(""), [])
        XCTAssertEqual(UnifiedDiffParser.parse("\n"), [])
    }

    /// **Defensive, and the behaviour is a decision:** a line inside a hunk that carries none of the
    /// four legal prefixes is DROPPED, and the counters DO NOT ADVANCE — so the rows after it keep
    /// the numbers they would have had. (Advancing would misnumber the rest of the hunk; refusing
    /// the whole patch would turn a cosmetic malformation into "Diff unavailable".)
    func testGarbageInsideAHunkIsDroppedWithoutDisturbingTheNumbering() {
        let patch = """
            @@ -1,2 +1,2 @@
             a
            !!! not a diff line
            -b
            +B

            """
        XCTAssertEqual(UnifiedDiffParser.parse(patch), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -1,2 +1,2 @@"),
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .removed, oldLine: 2, newLine: nil, text: "b"),
            DiffRow(kind: .added, oldLine: nil, newLine: 2, text: "B"),
        ])
    }

    /// Body lines before any header have no numbering to belong to — dropped rather than guessed at.
    func testBodyLinesBeforeAnyHeaderAreDropped() {
        XCTAssertEqual(UnifiedDiffParser.parse(" orphan\n-orphan\n+orphan\n"), [])
    }

    /// An unreadable `@@` line CLOSES the hunk: the rows after it would otherwise be numbered from
    /// the previous header, which is confidently wrong rather than merely absent.
    func testAnUnparseableHeaderClosesTheHunkInsteadOfNumberingFromTheOldOne() {
        let patch = """
            @@ -1,1 +1,1 @@
             kept
            @@ garbage header @@
             dropped
            +dropped

            """
        XCTAssertEqual(UnifiedDiffParser.parse(patch), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -1,1 +1,1 @@"),
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "kept"),
        ])
    }

    /// The format's omitted-count form (`@@ -5 +7 @@` means one line each side). This emitter always
    /// writes counts, so this pins the defensive branch — and, more importantly, pins that an ABSENT
    /// count is read as 1 rather than as the `,0` insertion-point case.
    func testAnOmittedCountMeansOneAndNeverTriggersTheZeroAdjustment() {
        XCTAssertEqual(UnifiedDiffParser.parse("@@ -5 +7 @@\n context\n"), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -5 +7 @@"),
            DiffRow(kind: .context, oldLine: 5, newLine: 7, text: "context"),
        ])
    }

    /// A blank line in the file is a context row with EMPTY text (the emitter writes it as a lone
    /// space), not a dropped line — losing it would shift the diff against the file it describes.
    func testABlankFileLineSurvivesAsAnEmptyContextRow() {
        XCTAssertEqual(UnifiedDiffParser.parse("@@ -1,2 +1,2 @@\n a\n \n"), [
            DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: "@@ -1,2 +1,2 @@"),
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .context, oldLine: 2, newLine: 2, text: ""),
        ])
    }

    /// Leading whitespace inside a line is CONTENT and must survive intact — only the one marker
    /// character is stripped. An indentation-eating parser would make every diff of real code lie.
    func testOnlyTheMarkerCharacterIsStripped() {
        let rows = UnifiedDiffParser.parse("@@ -1,1 +1,1 @@\n     indented(4)\n")
        XCTAssertEqual(rows.last?.text, "    indented(4)")
    }
}
