import Foundation
import XCTest
@testable import NormaChatKit

/// THE TWO GATES ON THE OPEN-TAG SCANNERS, and why one of them is not enough.
///
/// `HtmlToText.swift`'s five open-tag patterns were replaced by hand-written bounded scans (chat-d T6c,
/// mirroring `web.ts`'s Task 6b fix rounds 1-3). Two independent kinds of failure can follow from that,
/// and each needs its own kind of test:
///
///  1. A WRONG ANSWER — the scan and the regex disagree on some malformed shape. Caught by the tuple
///     differentials below, which compare the scanners against FROZEN COPIES of the exact patterns they
///     replaced, over a mechanically generated adversarial corpus.
///  2. A RIGHT ANSWER, SLOWLY — the scan is byte-identical and quadratic. **This is what actually
///     happened on the daemon.** The intermediate TS fix advanced a scan pointer but left one search
///     unbounded, and ORDINARY named-anchor markup went from 0.32 ms to 12.13 s at 510 KB — byte-
///     identical throughout, so every differential stayed green across two review rounds. Caught only by
///     the SCAN-CODE CEILINGS below, which drive the real scan functions end-to-end through
///     `htmlToText` / `extractLinks` / `extractTitle`.
///
/// The differentials are necessary and INSUFFICIENT. That is the whole reason this file has a timing
/// half, and the reason the timing half's headline case is ordinary markup rather than a hostile page:
/// the T6b implementer's own lesson was "I built every adversarial shape from the failure mode I'd just
/// been taught, and the input I never tried was ordinary HTML."
///
/// (`PageCoreTests`'s existing linearity probes cover the PAIRING passes — `replacePaired`,
/// `convertHeadings`'s per-level pointers, `extractLinks`'s loop. This file covers the OPEN-TAG SCANS
/// that feed them, which is a different class in different code.)
final class HtmlToTextScanTests: XCTestCase {
    // MARK: - frozen oracles

    /// Frozen COPY of `HtmlToText.swift`'s `jsWS`. A copy, deliberately: an oracle that imports the code
    /// under test cannot detect a change to it.
    private static let ws = "[\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}"
        + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
        + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]"

    private static func re(_ pattern: String) -> NSRegularExpression {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern)
    }

    /// The five patterns the scanners replaced, exactly as they were spelled before this task, plus the
    /// final-strip reference spelling. Every one of them is the dangerous shape — that is the point.
    private static let oracleAnchorOpen = re("<[Aa]\(ws)[^>]*[Hh][Rr][Ee][Ff]=\"([^\"]++)\"[^>]*+>")
    private static let oracleHeadingOpen = re("<[Hh]([1-6])[^>]*+>")
    private static let oracleListItem = re("<[Ll][Ii](?![0-9A-Za-z_])[^>]*+>")
    private static let oracleFirstH1 = re("<[Hh]1[^>]*>([\\s\\S]*?)</[Hh]1>")
    private static let oracleFirstTitle = re("<[Tt][Ii][Tt][Ll][Ee][^>]*>([\\s\\S]*?)</[Tt][Ii][Tt][Ll][Ee]>")
    private static let oracleAnyTag = re("<[^>]++>")

    /// `(start, end, capture)` for every match of `re`, in the shape the scanners produce.
    private static func oracleTuples(_ re: NSRegularExpression, _ html: String) -> [String] {
        let text = Utf16Text(html)
        return re.matches(in: html, options: [], range: text.fullRange).map { m in
            var capture = ""
            if m.numberOfRanges > 1, m.range(at: 1).location != NSNotFound {
                let r = m.range(at: 1)
                capture = text.slice(r.location, r.location + r.length)
            }
            return "\(m.range.location),\(m.range.location + m.range.length),\(capture)"
        }
    }

    private static func scanTuples(_ opens: [TagOpen]) -> [String] {
        opens.map { "\($0.start),\($0.end),\($0.capture)" }
    }

    private static func oracleFirstInner(_ re: NSRegularExpression, _ html: String) -> String? {
        let text = Utf16Text(html)
        guard let m = re.firstMatch(in: html, options: [], range: text.fullRange),
              m.numberOfRanges > 1, m.range(at: 1).location != NSNotFound else { return nil }
        let r = m.range(at: 1)
        return text.slice(r.location, r.location + r.length)
    }

    // MARK: - the corpus

    /// Deterministic PRNG (SplitMix64) — a fuzz corpus that cannot be reproduced is not a gate.
    private struct Rng {
        private var state: UInt64
        init(seed: UInt64) { state = seed }
        mutating func next() -> UInt64 {
            state = state &+ 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
        mutating func pick<T>(_ xs: [T]) -> T { xs[Int(next() % UInt64(xs.count))] }
        mutating func int(_ upper: Int) -> Int { Int(next() % UInt64(upper)) }
    }

    /// Every token is chosen to sit ON one of the derivations' edges: overlapping `href="` runs, an empty
    /// value (`href=""`, which the regex refuses and then BACKTRACKS past — the case that cost the TS
    /// 1,503 divergences in 300,000), a quoted `>` that closes the span, `href` spelled across a span
    /// boundary, `<h10` (the level digit followed by more digits), `<lithium` (the `\b`), the whole JS
    /// whitespace set including the four members ICU's `\s` disagrees about, and astral/CJK text so a
    /// UTF-16-indexed scan cannot split a character undetected.
    private static let vocabulary: [String] = [
        "<a ", "<a\t", "<a\u{00A0}", "<a\u{000B}", "<a\u{3000}", "<a\u{FEFF}", "<A ", "<a", "<ax ",
        "href=\"", "HREF=\"", "hReF=\"", "href='", "xhref=\"", "hrefx=\"", "data-x=\"href=\"",
        "href=\"\"", "href=\">", "hre", "f=\"", "\"", "'", ">", "<", ">\"", "x=\">\"", "title=\"a>b\"",
        "</a>", "</A>", "<h1", "<h6", "<h7", "<h10", "<h1>", "</h1>", "</h6>", "<H2 ",
        "<li", "<li>", "<li ", "<LI", "<lithium>", "<li1>", "<li_x>", "<li-x>", "<link rel=x>",
        "<title", "<title>", "</title>", "</TITLE>", "<titlex>",
        "<script", "</script>", "<br>", "</p>", "<>", "<<", ">>", "/", "=", " ", "\n", "\t",
        "x", "yy", "zzz", "0", "名前", "🙂", "🇯🇵",
    ]

    private static func randomDoc(_ rng: inout Rng) -> String {
        var out = ""
        let tokens = 4 + rng.int(24)
        for _ in 0 ..< tokens { out += rng.pick(vocabulary) }
        return out
    }

    // MARK: - differentials (a wrong answer)

    func testAnchorScannerIsTupleIdenticalToTheRegexItReplaced() {
        var rng = Rng(seed: 0xC0FF_EE00)
        var divergences: [String] = []
        var docsWithMatches = 0
        for _ in 0 ..< 20_000 {
            let doc = Self.randomDoc(&rng)
            let mine = Self.scanTuples(scanAnchorOpens(Utf16Text(doc)))
            let theirs = Self.oracleTuples(Self.oracleAnchorOpen, doc)
            if !mine.isEmpty { docsWithMatches += 1 }
            if mine != theirs, divergences.count < 5 {
                divergences.append("\(doc.debugDescription)\n  scan: \(mine)\n  regex: \(theirs)")
            }
        }
        // Liveness: a corpus the scanner never matches would make the comparison vacuous.
        XCTAssertGreaterThan(docsWithMatches, 1_000, "corpus barely exercises the anchor scanner")
        XCTAssertEqual(divergences.joined(separator: "\n"), "")
    }

    func testHeadingScannerIsTupleIdenticalToTheRegexItReplaced() {
        var rng = Rng(seed: 0x5390_0539)
        var divergences: [String] = []
        var docsWithMatches = 0
        for _ in 0 ..< 20_000 {
            let doc = Self.randomDoc(&rng)
            let mine = Self.scanTuples(scanHeadingOpens(Utf16Text(doc)))
            let theirs = Self.oracleTuples(Self.oracleHeadingOpen, doc)
            if !mine.isEmpty { docsWithMatches += 1 }
            if mine != theirs, divergences.count < 5 {
                divergences.append("\(doc.debugDescription)\n  scan: \(mine)\n  regex: \(theirs)")
            }
        }
        XCTAssertGreaterThan(docsWithMatches, 1_000, "corpus barely exercises the heading scanner")
        XCTAssertEqual(divergences.joined(separator: "\n"), "")
    }

    func testListItemScanIsByteIdenticalToTheReplaceItReplaced() {
        var rng = Rng(seed: 0xBEEF_0001)
        var divergences: [String] = []
        var docsChanged = 0
        for _ in 0 ..< 20_000 {
            let doc = Self.randomDoc(&rng)
            let mine = replaceListItems(Utf16Text(doc))
            let theirs = Self.oracleListItem.stringByReplacingMatches(
                in: doc, options: [], range: NSRange(location: 0, length: doc.utf16.count), withTemplate: "\n- ")
            if mine != doc { docsChanged += 1 }
            if mine != theirs, divergences.count < 5 {
                divergences.append("\(doc.debugDescription)\n  scan: \(mine.debugDescription)\n  regex: \(theirs.debugDescription)")
            }
        }
        XCTAssertGreaterThan(docsChanged, 1_000, "corpus barely exercises the list-item scan")
        XCTAssertEqual(divergences.joined(separator: "\n"), "")
    }

    func testFirstElementInnerIsIdenticalToBothLazyRegexesItReplaced() {
        var rng = Rng(seed: 0xFEED_1234)
        var divergences: [String] = []
        var h1Hits = 0
        var titleHits = 0
        for _ in 0 ..< 20_000 {
            let doc = Self.randomDoc(&rng)
            let text = Utf16Text(doc)
            let mineH1 = firstElementInner(text, "h1")
            let theirsH1 = Self.oracleFirstInner(Self.oracleFirstH1, doc)
            let mineTitle = firstElementInner(text, "title")
            let theirsTitle = Self.oracleFirstInner(Self.oracleFirstTitle, doc)
            if mineH1 != nil { h1Hits += 1 }
            if mineTitle != nil { titleHits += 1 }
            if (mineH1 != theirsH1 || mineTitle != theirsTitle), divergences.count < 5 {
                divergences.append("""
                \(doc.debugDescription)
                  h1    scan: \(String(describing: mineH1))  regex: \(String(describing: theirsH1))
                  title scan: \(String(describing: mineTitle))  regex: \(String(describing: theirsTitle))
                """)
            }
        }
        XCTAssertGreaterThan(h1Hits, 100, "corpus barely produces a matching <h1>")
        XCTAssertGreaterThan(titleHits, 100, "corpus barely produces a matching <title>")
        XCTAssertEqual(divergences.joined(separator: "\n"), "")
    }

    func testStripTagsIsByteIdenticalToTheFinalStripRegex() {
        var rng = Rng(seed: 0x0BAD_F00D)
        var divergences: [String] = []
        for _ in 0 ..< 20_000 {
            let doc = Self.randomDoc(&rng)
            let mine = stripTags(Utf16Text(doc))
            let theirs = Self.oracleAnyTag.stringByReplacingMatches(
                in: doc, options: [], range: NSRange(location: 0, length: doc.utf16.count), withTemplate: "")
            if mine != theirs, divergences.count < 5 {
                divergences.append("\(doc.debugDescription)\n  scan: \(mine.debugDescription)\n  regex: \(theirs.debugDescription)")
            }
        }
        XCTAssertEqual(divergences.joined(separator: "\n"), "")
    }

    /// The boundary the `until: spanEnd` bound enforces, walked by hand rather than sampled: `href="`
    /// occupies `[at, at+6)`, and the pre-bound code admitted it iff `at + 6 <= spanEnd`. A bound one
    /// character too tight would silently drop hrefs; one too loose is the quadratic. Both directions are
    /// visible here as a tuple difference.
    func testTheSpanBoundIsExactAtItsOwnBoundary() {
        let cases = [
            #"<a href="A">"#, // ordinary
            #"<a hre>f="A">"#, // href split across the span boundary — must NOT match
            #"<a hr>ef="A">"#,
            #"<a ><a href="A">"#, // href immediately after the span end
            #"<a href=">"#, // the `>` is inside href= itself
            #"<a href="A"x>"#, // 5 characters of span room after the quote
            #"<a href="">"#, // empty value: not viable, the engine backtracks past it
            #"<a x href="A" href="B">"#, // rightmost viable wins
            #"<a href="A" href="Z>"#, // rightmost is not viable — falls back to the left one
            #"<a href="a>b">"#, // class (B): the value legitimately crosses a `>`
            #"<a name="s1">Section</a><a name="s2">Section</a>"#, // ORDINARY named anchors: no href at all
            #"<a name="s1">x</a><a href="/real">y</a>"#, // …then one real link
            "<a ", "<a >", "<a href=\"A\"", #"<a href="A">"# + String(repeating: "x", count: 40),
        ]
        for html in cases {
            XCTAssertEqual(Self.scanTuples(scanAnchorOpens(Utf16Text(html))),
                           Self.oracleTuples(Self.oracleAnchorOpen, html),
                           "anchor scan diverged on \(html.debugDescription)")
        }
    }

    // MARK: - scan-code ceilings (a right answer, slowly)

    // CEILING CALIBRATION — measured against MUTANTS of this task's own code, then restored. Debug build,
    // which is how `swift test` runs, so these are the numbers the gate actually sees. Two mutants, each
// BYTE-IDENTICAL to the shipped code and only slow, which is the whole point:
    //
    //   A — every scanner restored to the possessive regex it replaced (== the PRE-T6c file, i.e. what
    //       the phone was actually paying before this task).
    //   M — `scanAnchorOpens`'s `href="` search unbounded, with the `at + 6 > spanEnd` range test that
    //       made it byte-identical (== the TS's intermediate fix `6f78a57d`, which stayed green through
    //       two review rounds of differentials and was found only by a timing gate).
    //
    //   probe (20,000 candidates unless noted)              shipped    mutant           ratio
    //   ORDINARY named anchors, 5,000 (157 KB) — cleaner      0.037 s    4.71 s (M)       127x
    //   ORDINARY named anchors, 5,000 — extractLinks          0.006 s    4.70 s (M)       783x
    //   ORDINARY named anchors, 10,000 (317 KB)               0.074 s   19.14 s (M)       259x
    //   ORDINARY named anchors, 20,000 (657 KB)               0.157 s   83.08 s (M)       529x
    //   anchor: 12-char spans + one distant match             0.080 s   34.46 s (M)       431x
    //   anchor: 5,000 unterminated `href="` (50 KB)           0.015 s   >600 s (A, killed) >40000x
    //   heading opens, no `>`                                 0.086 s   41.24 s (A)       479x
    //   list-item opens, no `>`                               0.085 s   38.60 s (A)       454x
    //   final strip, no `>`                                   0.079 s   17.94 s (A)       227x
    //   extractTitle, no `>` on any h1 candidate              0.006 s   27.95 s (A)      4658x
    //   extractTitle, open closes but `</h1>` never does      0.007 s   28.48 s (A)      4069x
    //
    // SITE ISOLATION: a third mutant restoring ONLY the list-item regex left every other probe within
    // noise (anchor 0.036 s, heading 0.075 s, strip 0.065 s, title 0.006 s) and drove its own probe to
    // 18.88 s — so a ceiling here can only be met by fixing its own site, not by being lucky elsewhere.
    //
    // A 1 s ceiling — the same one `PageCoreTests` uses for the pairing passes — sits 6.4x above the
    // slowest shipped run in the gated set and 4.7x below the SMALLEST mutant breach. The ordinary-anchor
    // series is asserted at three doubling sizes rather than one, because a single size cannot show the
    // difference between "slow" and "superlinear".
    private static let ceiling = Duration.seconds(1)

    private func assertFast(_ what: String, _ body: () -> Void,
                            file: StaticString = #filePath, line: UInt = #line) {
        let started = ContinuousClock.now
        body()
        let elapsed = ContinuousClock.now - started
        XCTAssertLessThan(elapsed, Self.ceiling, "\(what) went superlinear: \(elapsed)", file: file, line: line)
    }

    /// THE HEADLINE CASE, and the one nobody thought to try: a classic named-anchor page. Every `<a` has
    /// attributes but no `href`, so every span's answer is "no viable href here" — which is precisely the
    /// answer an unbounded search walks the rest of the document to find, throws away, and then re-walks
    /// for the next span. No hostile input, no malformed markup, and quadratic.
    ///
    /// Charged TWICE per fetch on the phone, exactly as on the daemon: `convertAnchors` inside the
    /// cleaner and `anchorSpans` inside `extractLinks`.
    func testOrdinaryNamedAnchorMarkupStaysLinear() {
        for count in [5_000, 10_000, 20_000] {
            let doc = (0 ..< count).map { #"<a name="s\#($0)">Section \#($0)</a>"# }.joined()
            assertFast("cleaner on \(count) ordinary named anchors (\(doc.utf8.count) B)") {
                _ = htmlToText(doc)
            }
            assertFast("extractLinks on \(count) ordinary named anchors") {
                _ = extractLinks(doc, baseURL: "https://base.test/")
            }
        }
    }

    /// The generalisation of the same gap: "many candidates, no LOCAL match, one distant match". Spans are
    /// 12 characters wide — deliberately past the 6-character floor below which a bounded search cannot
    /// look anywhere at all, which is what hid the defect from a narrower probe.
    func testEveryScannerStaysLinearOnManyCandidatesWithOneDistantMatch() {
        let filler = String(repeating: "x", count: 12)
        let count = 20_000

        // Anchor: 20k href-less spans, then one real anchor at the very end.
        let anchors = String(repeating: "<a \(filler)>", count: count) + #"<a href="/real">t</a>"#
        assertFast("anchor opens, distant match") { _ = htmlToText(anchors) }
        assertFast("anchor opens, distant match (links)") { _ = extractLinks(anchors, baseURL: "https://base.test/") }

        // The variant that makes an href permanently out of range: a QUOTED `>` closes each span.
        let quoted = String(repeating: #"<a x=">" "#, count: count) + #"<a href="/real">t</a>"#
        assertFast("anchor opens, quoted '>' closes the span") { _ = htmlToText(quoted) }

        // Heading, list item, final strip: many candidates whose `>` never arrives.
        assertFast("heading opens, no '>'") { _ = htmlToText(String(repeating: "<h1 \(filler)", count: count)) }
        assertFast("list-item opens, no '>'") { _ = htmlToText(String(repeating: "<li \(filler)", count: count)) }
        assertFast("final strip, no '>'") { _ = htmlToText(String(repeating: "<p \(filler)", count: count)) }

        // extractTitle's two scans: 20k `<h1` opens with no `>`, then a real title far away.
        let titles = String(repeating: "<h1 \(filler)", count: count) + "<title>t</title>"
        assertFast("extractTitle, no '>' on any h1 candidate") { _ = extractTitle(titles) }
        // …and the failing-close exit: the open tag closes, `</h1>` never arrives.
        assertFast("extractTitle, open closes but </h1> never does") {
            _ = extractTitle(String(repeating: "<h1>t</h1x>", count: count))
        }
    }

    /// The historical CUBIC shape — `<a href="x` repeated, no closing quote — which is what made the
    /// anchor pattern the worst instance in the family. The possessive `([^"]++)` this file used blocks the
    /// cubic but not the quadratic, and ICU's constant is brutal: mutant A did not finish 50 KB in ten
    /// minutes (killed), where the shipped scan does 800 KB in 0.24 s. On the daemon the same shape was
    /// 15.5 s at 19.5 KB, so the phone was strictly worse off than the Mac here.
    func testTheHistoricalCubicShapeIsFlat() {
        for count in [5_000, 20_000, 80_000] {
            let doc = String(repeating: #"<a href="x"#, count: count)
            assertFast("cleaner on \(count) unterminated href (\(doc.utf8.count) B)") { _ = htmlToText(doc) }
            assertFast("extractLinks on \(count) unterminated href") {
                _ = extractLinks(doc, baseURL: "https://base.test/")
            }
        }
    }

    /// A BUDGET, not a superlinearity gate — and labelled as one so nobody mistakes it for a mutant test.
    /// Mutant A is FASTER here (1.13 s against the shipped 1.36 s): on ordinary markup ICU's possessive
    /// regexes beat a hand-written debug-build scan by ~20% end-to-end, which is the price paid for
    /// removing the 227x-40,000x worst cases above. What this test pins is that the phone can put the
    /// FULL 5 MB read cap through the cleaner at all — flat per byte: 1.25 MB 0.357 s, 2.5 MB 0.687 s,
    /// 5 MB 1.355 s.
    func testTheFullReadCapOfOrdinaryMarkupStaysWithinBudget() {
        var doc = ""
        var i = 0
        while doc.utf8.count < 5_000_000 {
            doc += #"<a name="s\#(i)">Section \#(i)</a><li x>item<br><p>text</p>"#
            i += 1
        }
        let budget = Duration.seconds(4) // 3x the measured 1.355 s
        for (what, body) in [("cleaner", { _ = htmlToText(doc) }), ("extractTitle", { _ = extractTitle(doc) })]
            as [(String, () -> Void)] {
            let started = ContinuousClock.now
            body()
            let elapsed = ContinuousClock.now - started
            XCTAssertLessThan(elapsed, budget, "\(what) on a 5 MB ordinary page: \(elapsed)")
        }
    }
}
