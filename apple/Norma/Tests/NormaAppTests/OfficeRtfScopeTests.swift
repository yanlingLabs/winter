import XCTest
@testable import Norma

/// office-format review F-2/F-3/F-4 — the RTF containment check, pinned against REAL engine output.
///
/// **Why these are unit tests and not only live drills.** The defect this file exists to prevent
/// shipped past five live arms, a forced red, and a code review of the drills themselves — because
/// every fixture in play carried bold on an *automatic character style*, which RTF inlines per-run
/// inside the body. That is the one carrier where the leak structurally cannot appear. The bug was
/// not that the drills were sloppy; it was that they were all run on the single document shape
/// incapable of exposing it.
///
/// So the shapes that DO expose it are captured as bytes (`Fixtures/office/rtf/`, straight from
/// `getTextSelection("text/rtf")` on a real agent view) and asserted here, deterministically, with
/// no engine in the loop. Delete `officeRtfBody`'s call site and these go red immediately.
final class OfficeRtfScopeTests: XCTestCase {

    private static var rtfRoot: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<1 { url = url.deletingLastPathComponent() }
        return url.appendingPathComponent("Fixtures/office/rtf", isDirectory: true)
    }

    private func dump(_ name: String) throws -> String {
        let url = Self.rtfRoot.appendingPathComponent(name)
        try XCTSkipIf(!FileManager.default.fileExists(atPath: url.path), "\(name) fixture missing")
        return try String(contentsOf: url, encoding: .utf8)
    }

    // MARK: - The leaks (F-2, F-3)

    /// ⛔ **F-2.** Every Writer document carries LibreOffice's stock `caption` paragraph style, and
    /// RTF emits it as `…\ai\ltrch\fs24\i caption;` inside `{\stylesheet}`. Scanning the whole
    /// string therefore reports ITALIC on a document that has none — the check becomes a constant
    /// function of the requested value, and `italic:true` is confirmed no matter what the engine did.
    func testItalicLeaksFromTheStockCaptionStyleUntilTheScanIsBodyScoped() throws {
        let rtf = try dump("pristine-no-bold-no-italic.rtf")
        // The leak is real and this fixture really does contain it — asserted, so the test cannot
        // pass merely because the fixture stopped exhibiting the problem.
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(rtf, "i"),
                      "fixture must still exhibit the stylesheet leak, or this test proves nothing")
        XCTAssertTrue(rtf.contains("caption;"), "the leak's source is the stock caption style")

        let body = OfficeRtfScope.officeRtfBody(rtf)
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "i"),
                       "a document with no italic anywhere must not confirm italic")
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "b"), "nor bold")
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "ul"), "nor underline")
    }

    /// ⛔ **F-3.** Bold carried by a NAMED PARAGRAPH STYLE lands in the stylesheet header, so
    /// selecting a *plain* word elsewhere still finds `\b`. The ordinary case: any document with a
    /// heading — including one `docs format style:"heading1"` just produced — makes every subsequent
    /// `bold:true` self-confirming.
    func testBoldLeaksFromANamedParagraphStyleWhenAPlainWordIsSelected() throws {
        let rtf = try dump("plain-word-selected-bold-named-style.rtf")
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(rtf, "b"),
                      "fixture must still exhibit the leak, or this test proves nothing")
        // The BODY really was scoped to the selection all along — the selected plain word is there
        // and the heading's text is not. That is what makes this a consumer bug, not an instrument bug.
        XCTAssertTrue(rtf.contains("PLAINWORD"), "the selected plain word is in the RTF")
        XCTAssertFalse(rtf.contains("A Bold Heading"), "the heading's TEXT is correctly absent")

        let body = OfficeRtfScope.officeRtfBody(rtf)
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "b"),
                       "selecting a plain word must not confirm bold just because the document has a bold style")
    }

    // MARK: - The true positives — body-scoping must not trade one error for the other

    func testGenuineBoldSurvivesBodyScoping() throws {
        let body = OfficeRtfScope.officeRtfBody(try dump("one-of-three-genuinely-bold.rtf"))
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(body, "b"), "real bold in the body must still be found")
    }

    func testGenuineItalicSurvivesBodyScoping() throws {
        let body = OfficeRtfScope.officeRtfBody(try dump("genuine-italic-selected.rtf"))
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(body, "i"), "real italic in the body must still be found")
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "b"), "and bold must not be invented")
    }

    /// The sharpest of the true-positive arms: this dump leaks `\i` from the stylesheet AND carries a
    /// genuine `\ul` in the body, so it fails if the stripper is too weak OR too strong.
    func testGenuineUnderlineSurvivesWhileTheItalicLeakIsRemovedFromTheSameDump() throws {
        let rtf = try dump("genuine-underline-selected.rtf")
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(rtf, "i"), "unscoped: the leak is present")
        let body = OfficeRtfScope.officeRtfBody(rtf)
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(body, "ul"), "real underline must survive")
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "i"), "the leaked italic must not")
    }

    // MARK: - F-4: the check is EXISTENTIAL, and that is a property, not a bug to hide

    /// The dump has three matched occurrences and exactly ONE is genuinely bold. The check answers
    /// "bold present" — which is TRUE and useful, and is emphatically not "all three are bold".
    /// Pinned so nobody later reads `verified` as universal coverage; the model-facing sentence says
    /// "in at least one of the N occurrences" for exactly this reason.
    func testTheCheckIsExistentialOverAMultiOccurrenceSelectionNotUniversal() throws {
        let rtf = try dump("one-of-three-genuinely-bold.rtf")
        let body = OfficeRtfScope.officeRtfBody(rtf)
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(body, "b"),
                      "one bold occurrence out of three still reads as present")
        // The evidence that it cannot be universal: RTF merges runs, so the body carries a single
        // `\b` group rather than three independently-attributed ones.
        let boldOccurrences = body.components(separatedBy: "\\b").count - 1
        XCTAssertLessThan(boldOccurrences, 3,
                          "the serializer does not preserve per-occurrence attribution, so a "
                              + "universal claim is not computable from this string")
    }

    // MARK: - The stripper's own mechanics

    /// Brace matching must honour RTF's escapes, or a literal `\}` in the user's text unbalances the
    /// scan and silently eats the rest of the document.
    func testEscapedBracesInTextDoNotUnbalanceTheGroupScan() {
        let rtf = #"{\rtf1{\stylesheet{\s16\i caption;}}\pard KEEP \{ and \} and \\ done}"#
        let body = OfficeRtfScope.officeRtfBody(rtf)
        XCTAssertTrue(body.contains("KEEP"), "body text after escaped braces must survive: \(body)")
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "i"), "the stylesheet must still be stripped")
    }

    /// `{\*\…}` ignorable destinations are stripped by the `\*` rule alone, without naming each one.
    func testIgnorableDestinationsAreStrippedByTheStarRule() {
        let rtf = #"{\rtf1{\*\generator LibreOffice\b\i;}\pard BODY}"#
        let body = OfficeRtfScope.officeRtfBody(rtf)
        XCTAssertTrue(body.contains("BODY"))
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "b"))
        XCTAssertFalse(OfficeRtfScope.officeRtfHasControlWord(body, "i"))
    }

    /// A body group that merely STARTS with a formatting control word is not a destination and must
    /// be kept — otherwise the stripper eats exactly the runs it is supposed to inspect.
    func testABodyRunGroupIsNotMistakenForADestination() {
        let rtf = #"{\rtf1{\stylesheet{\s16\i caption;}}\pard {\b BOLDRUN} tail}"#
        let body = OfficeRtfScope.officeRtfBody(rtf)
        XCTAssertTrue(body.contains("BOLDRUN"), "the bold run must survive: \(body)")
        XCTAssertTrue(OfficeRtfScope.officeRtfHasControlWord(body, "b"), "and still read as bold")
    }
}
