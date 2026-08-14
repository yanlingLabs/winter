import XCTest
import AppKit
import NormaKit
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

    // MARK: - 2. The renderer's state machine

    override func tearDown() {
        // `PanelDiffTabModels` is process-global (like `PanelWebTabModels`): a model left behind
        // would be handed to the next test that asks for the same tab id, along with its already-
        // finished load.
        PanelDiffTabModels.removeAllForTesting()
        super.tearDown()
    }

    private func payload(patch: String = "@@ -1,1 +1,1 @@\n-old\n+new\n",
                         path: String = "packages/core/src/engine.ts",
                         added: Int = 1, removed: Int = 1, truncated: Bool = false) -> PanelDiffPayload {
        PanelDiffPayload(path: path, added: added, removed: removed, patch: patch, truncated: truncated)
    }

    /// The ordinary path: a tab starts on the spinner, and one fetch later it is holding parsed rows.
    func testTheModelStartsLoadingAndLandsOnLoadedRows() async {
        let model = PanelDiffTabModel(tabId: "t1", diffId: "diff_1", sessionId: "s_1") { _, _ in
            self.payload()
        }
        XCTAssertEqual(model.state, .loading, "a fresh model is on the spinner before anything runs")

        await model.loadForTesting()

        guard case .loaded(let loaded) = model.state else {
            return XCTFail("expected .loaded, got \(model.state)")
        }
        XCTAssertEqual(loaded.rows.map(\.kind), [.hunkSeparator, .removed, .added])
        XCTAssertEqual(loaded.payload.path, "packages/core/src/engine.ts")
        XCTAssertEqual(loaded.language, "typescript", "the language comes from the file's extension")
    }

    /// The session and diff ids reach the fetch VERBATIM — a model that dialled with the wrong
    /// session would get a NOT_FOUND and render the calm state, which looks exactly like a deleted
    /// patch.
    func testTheFetchIsCalledWithTheTabsOwnSessionAndDiffIds() async {
        var seen: [(String, String)] = []
        let model = PanelDiffTabModel(tabId: "t1", diffId: "diff_7", sessionId: "s_9") { session, diff in
            seen.append((session, diff))
            return self.payload()
        }
        await model.loadForTesting()
        XCTAssertEqual(seen.count, 1)
        XCTAssertEqual(seen.first?.0, "s_9")
        XCTAssertEqual(seen.first?.1, "diff_7")
    }

    /// **A thrown fetch is the calm state, not a crash and not an error banner.** The daemon throws
    /// NOT_FOUND for a patch that is gone (deleted with its session, never captured, minted for
    /// another session) and INVALID_PARAMS for a malformed id; both, and every transport failure,
    /// land here.
    func testAThrownFetchLandsOnTheUnavailableState() async {
        struct Gone: Error {}
        let model = PanelDiffTabModel(tabId: "t1", diffId: "diff_ghost", sessionId: "s_1") { _, _ in
            throw Gone()
        }
        await model.loadForTesting()
        XCTAssertEqual(model.state, .unavailable)
    }

    /// A `.diff` tab with no `diffId` is unavailable BY INSPECTION — it must never become a fetch
    /// with an empty id. Structurally possible (`PanelTab.diffId` is optional for every other kind),
    /// never expected.
    func testANilDiffIdIsUnavailableWithoutEverFetching() async {
        let model = PanelDiffTabModel(tabId: "t1", diffId: nil, sessionId: "s_1") { _, _ in
            XCTFail("a tab with no diffId must not reach the daemon")
            return self.payload()
        }
        await model.loadForTesting()
        XCTAssertEqual(model.state, .unavailable)
    }

    /// The same, for a model that never learned its session.
    func testANilSessionIsUnavailableWithoutEverFetching() async {
        let model = PanelDiffTabModel(tabId: "t1", diffId: "diff_1", sessionId: nil) { _, _ in
            XCTFail("a model with no session must not reach the daemon")
            return self.payload()
        }
        await model.loadForTesting()
        XCTAssertEqual(model.state, .unavailable)
    }

    /// **Fetch ONCE, ever.** Not once per appear: the content view's `onAppear` fires again on every
    /// tab switch back, on a window move and on a re-render, and the patch behind a diff tab cannot
    /// change — a second request would be pure waste, and a second request that FAILED would replace
    /// a loaded tab with an empty one.
    func testASecondLoadNeverRefetches() async {
        var calls = 0
        let model = PanelDiffTabModel(tabId: "t1", diffId: "diff_1", sessionId: "s_1") { _, _ in
            calls += 1
            return self.payload()
        }
        await model.loadForTesting()
        model.startLoadingIfNeeded()
        model.startLoadingIfNeeded()
        await model.loadForTesting()
        XCTAssertEqual(calls, 1)
    }

    /// The registry hands the SAME model back for the same tab — which is what makes "fetch once"
    /// survive the `.id(tabId)` rebuild `ShellPanel` performs on every tab switch.
    func testTheRegistryReturnsTheSameModelForATabAndAFreshOneAfterDiscard() {
        let tab = PanelTab(tabId: "t1", kind: .diff, url: nil, title: "engine.ts", diffId: "diff_1")
        let first = PanelDiffTabModels.model(for: tab, host: nil, sessionId: "s_1")
        XCTAssertTrue(first === PanelDiffTabModels.model(for: tab, host: nil, sessionId: "s_1"))

        PanelDiffTabModels.discard(tabId: "t1")
        XCTAssertFalse(first === PanelDiffTabModels.model(for: tab, host: nil, sessionId: "s_1"),
                       "a closed tab's model is released, not resurrected")
    }

    /// A cached model whose `diffId` disagrees with the tab's is REPLACED. It cannot happen — a diff
    /// tab is frozen — but the alternative is a tab confidently showing a different edit's diff.
    func testARegistryModelIsReplacedIfTheTabsDiffIdEverChanges() {
        let first = PanelDiffTabModels.model(
            for: PanelTab(tabId: "t1", kind: .diff, url: nil, title: nil, diffId: "diff_1"),
            host: nil, sessionId: "s_1")
        let second = PanelDiffTabModels.model(
            for: PanelTab(tabId: "t1", kind: .diff, url: nil, title: nil, diffId: "diff_2"),
            host: nil, sessionId: "s_1")
        XCTAssertFalse(first === second)
        XCTAssertEqual(second.diffId, "diff_2")
    }

    /// The session can still be re-pointed before the load starts (the factory runs on every render
    /// pass, and the first one can precede the shell knowing its session) — and not after, because
    /// by then the answer is already on its way.
    func testBindRepointsTheSessionOnlyBeforeTheLoadStarts() async {
        var seen: [String] = []
        let model = PanelDiffTabModel(tabId: "t1", diffId: "diff_1", sessionId: nil) { session, _ in
            seen.append(session)
            return self.payload()
        }
        model.bind(sessionId: "s_1")
        XCTAssertEqual(model.sessionId, "s_1")
        await model.loadForTesting()
        model.bind(sessionId: "s_2")
        XCTAssertEqual(model.sessionId, "s_1", "a bound-then-loaded model does not re-point")
        XCTAssertEqual(seen, ["s_1"])
    }

    /// The factory produces a `PanelDiffTab` wired to the registry's model for that tab — the
    /// replacement for Task 9's placeholder arm, asserted from the factory's own side.
    func testTheFactoryReturnsADiffTabWiredToTheRegistrysModel() {
        let tab = PanelTab(tabId: "t1", kind: .diff, url: nil, title: "engine.ts", diffId: "diff_1")
        guard let content = panelTabContent(for: tab, host: nil, sessionId: "s_1") as? PanelDiffTab else {
            return XCTFail("the factory no longer routes .diff to PanelDiffTab")
        }
        XCTAssertEqual(content.kind, .diff)
        XCTAssertEqual(content.title, "engine.ts")
        XCTAssertTrue(content.model === PanelDiffTabModels.model(for: tab, host: nil, sessionId: "s_1"))
    }

    // MARK: - 3. Copy

    /// **The RAW patch, byte for byte** — hunk headers and `\ No newline` markers included. What is
    /// on screen is a rendering; what a person pastes into `git apply` has to be the artifact.
    ///
    /// Driven against a NAMED pasteboard, never `.general`: this suite runs on the developer's own
    /// Mac and a test that wrote to the system pasteboard would silently eat their clipboard.
    func testCopyPutsTheRawPatchOnThePasteboard() async {
        let patch = "@@ -1,2 +1,2 @@\n alpha\n-beta\n\\ No newline at end of file\n+beta!\n"
        let model = PanelDiffTabModel(tabId: "t1", diffId: "diff_1", sessionId: "s_1") { _, _ in
            self.payload(patch: patch)
        }
        let board = NSPasteboard(name: .init("NormaDiffRenderTests"))
        XCTAssertFalse(model.copyPatch(to: board), "nothing to copy while loading")

        await model.loadForTesting()
        XCTAssertTrue(model.copyPatch(to: board))
        XCTAssertEqual(board.string(forType: .string), patch)
        board.clearContents()
    }

    // MARK: - 4. The pure presentation decisions

    /// The gutter is as wide as the largest number it must hold, in digits — both columns equal, so
    /// a hunk at line 9 and one at line 1204 do not draw two differently-indented blocks.
    func testTheGutterWidthComesFromTheLargestLineNumbersDigitCount() {
        func rows(_ patch: String) -> [DiffRow] { UnifiedDiffParser.parse(patch) }
        XCTAssertEqual(diffGutterDigits(rows("@@ -1,2 +1,2 @@\n a\n b\n")), 1)
        XCTAssertEqual(diffGutterDigits(rows("@@ -9,2 +9,2 @@\n a\n b\n")), 2, "row 2 of the hunk is line 10")
        XCTAssertEqual(diffGutterDigits(rows("@@ -1200,5 +1200,5 @@\n a\n")), 4)
        XCTAssertEqual(diffGutterDigits([]), 1, "an empty parse still lays out")
        XCTAssertEqual(diffGutterDigits(rows("\(UnifiedDiffParser.truncationMarker)\n")), 1,
                       "a banner-only patch has no numbers at all")
        // The two sides are asymmetric here (the old side reaches 8, the new side only 6) and the
        // widest of the two is what the columns are sized to.
        XCTAssertEqual(diffGutterDigits(rows("@@ -8,1 +6,1 @@\n a\n")), 1)
        // The widest number can appear MID-hunk rather than in the header: this hunk opens at 99 and
        // its second row is line 100, so the columns are three digits wide even though every number
        // in the header is two.
        XCTAssertEqual(diffGutterDigits(rows("@@ -99,2 +6,2 @@\n a\n b\n")), 3)
    }

    /// The extension → language map, including the two honest `nil`s: an unknown extension and no
    /// extension at all both mean "the highlighter's generic branch", never a guess.
    func testTheExtensionToLanguageMapping() {
        let expected: [String: String?] = [
            "a/b/Engine.swift": "swift", "tools/run.py": "python", "web/app.js": "javascript",
            "web/app.jsx": "javascript", "src/engine.ts": "typescript", "src/View.tsx": "typescript",
            "package.json": "json", "site/index.html": "html", "site/index.htm": "html",
            "Info.plist": "xml", "icon.svg": "xml", "data.xml": "xml", "site/main.css": "css",
            "scripts/build.sh": "shell", "scripts/build.bash": "shell", "scripts/build.zsh": "shell",
            "ci/config.yml": "yaml", "ci/config.yaml": "yaml", "README.md": "markdown",
            "notes.txt": nil, "Makefile": nil, "archive.tar.gz": nil, "": nil,
        ]
        for (path, language) in expected {
            XCTAssertEqual(diffSyntaxLanguage(forPath: path), language, "for \(path)")
        }
        // Case-insensitive: a `.SWIFT` file is still Swift.
        XCTAssertEqual(diffSyntaxLanguage(forPath: "A/B/Thing.SWIFT"), "swift")
    }

    /// The ± column is the only channel that survives greyscale, colour blindness and a screen
    /// reader — the washes and the roles are both colour.
    func testEveryRowKindHasItsMarkerCharacter() {
        XCTAssertEqual(diffRowMarker(.added), "+")
        XCTAssertEqual(diffRowMarker(.removed), "-")
        XCTAssertEqual(diffRowMarker(.context), " ")
        XCTAssertEqual(diffRowMarker(.hunkSeparator), " ")
        XCTAssertEqual(diffRowMarker(.truncatedBanner), " ")
    }

    /// The gutter's mono width is measured from `Typography.syntaxCodeNS` — the SAME face
    /// `SyntaxHighlighter` stamps into the code beside it, which is what keeps the numbers and their
    /// lines on one baseline and one advance. Asserted as a relationship, not a point value: the
    /// literal number belongs to the type token, and this surface introduces none of its own.
    func testTheMonoColumnWidthTracksTheCodeFace() {
        XCTAssertEqual(panelDiffMonoWidth(characters: 0), 0)
        let one = panelDiffMonoWidth(characters: 1)
        XCTAssertGreaterThan(one, 0)
        XCTAssertEqual(panelDiffMonoWidth(characters: 4), ceil(one * 4), accuracy: 1,
                       "the face is monospaced, so n characters is n advances")
        let expected = ceil(("0000" as NSString)
            .size(withAttributes: [.font: Typography.syntaxCodeNS]).width)
        XCTAssertEqual(panelDiffMonoWidth(characters: 4), expected)
    }

    /// **The nomination is monospace-aware, and raw character count would get it backwards.** A CJK
    /// glyph is two advances wide and one character long, so a 30-kanji line renders wider than a
    /// 50-character ASCII line that beats it on count — and with `sampling: 1` only the nominated
    /// line is measured at all, which is what makes this test able to tell the two rules apart.
    func testTheWidestLineIsNominatedByRenderedWidthNotByCharacterCount() {
        let kanji = String(repeating: "漢", count: 30)
        let ascii = String(repeating: "x", count: 50)
        XCTAssertGreaterThan(ascii.count, kanji.count, "the ASCII line wins on raw count…")
        XCTAssertGreaterThan(diffApproxWidthUnits(kanji), diffApproxWidthUnits(ascii),
                             "…and loses on rendered width, which is the rule that matters")

        let rows = UnifiedDiffParser.parse("@@ -1,2 +1,2 @@\n \(ascii)\n \(kanji)\n")
        let attributes: [NSAttributedString.Key: Any] = [.font: Typography.syntaxCodeNS]
        let kanjiWidth = ceil((kanji as NSString).size(withAttributes: attributes).width)
        XCTAssertEqual(diffMeasuredTextWidth(rows, sampling: 1), kanjiWidth,
                       "one sample must land on the line that actually renders widest")

        XCTAssertEqual(diffApproxWidthUnits(""), 0)
        XCTAssertEqual(diffApproxWidthUnits("abc"), 3, "plain ASCII is one unit per character")
    }

    /// Content width is MEASURED, not multiplied out of a character count: a tab or a CJK glyph is
    /// wider than a digit, and an under-estimated content width clips the full-row tint short of the
    /// line it is tinting.
    func testTheMeasuredContentWidthBeatsANaiveCharacterCount() {
        let wide = UnifiedDiffParser.parse("@@ -1,2 +1,2 @@\n \(String(repeating: "漢", count: 20))\n short\n")
        let naive = panelDiffMonoWidth(characters: 20)
        XCTAssertGreaterThan(diffMeasuredTextWidth(wide), naive,
                             "20 CJK glyphs are wider than 20 digits — measuring is the point")

        // And it is the WIDEST line that wins, not the last one.
        let rows = UnifiedDiffParser.parse("@@ -1,3 +1,3 @@\n \(String(repeating: "x", count: 80))\n a\n b\n")
        XCTAssertEqual(diffMeasuredTextWidth(rows),
                       ceil((String(repeating: "x", count: 80) as NSString)
                           .size(withAttributes: [.font: Typography.syntaxCodeNS]).width))
        XCTAssertEqual(diffMeasuredTextWidth([]), 0)
    }

    /// Everything the row list needs is derived ONCE, at load, from a patch that cannot change.
    func testALoadedDiffDerivesItsLayoutOnceFromThePatch() {
        let loaded = PanelDiffLoaded(payload: payload(
            patch: "@@ -98,2 +98,2 @@\n a\n-b\n+B\n", path: "src/app.py"))
        XCTAssertEqual(loaded.language, "python")
        XCTAssertEqual(loaded.gutterDigits, 2)
        XCTAssertEqual(loaded.numberColumnWidth, panelDiffMonoWidth(characters: 2))
        XCTAssertGreaterThan(loaded.gutterWidth, 2 * loaded.numberColumnWidth,
                             "the gutter is two number columns PLUS the marker and its gaps")
        XCTAssertGreaterThan(loaded.contentWidth, loaded.gutterWidth,
                             "…and the content is the gutter plus the widest line")
    }
}
