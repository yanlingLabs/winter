import Foundation
import XCTest
@testable import WinterChatKit

/// THE STRUCTURAL TRIPWIRE for the HTML-scanning regex class, on the Swift side — the mirror of
/// `packages/core/test/agent/tools/regex-shapes.test.ts`, and the reason both exist: Task 6b found the
/// SAME defect in a different pattern three rounds running, because each round's tests were written
/// around the instances that round was handed. Patching named sites is losing; this makes the CLASS
/// unrepresentable.
///
/// THE CLASS: a pattern with an UNBOUNDED quantifier (`[^>]*`, `[^"]+`, `[\s\S]*?`, `.*`) that is not the
/// last thing in the pattern — it can consume arbitrarily far and then requires a terminator hostile
/// input can simply omit. At every candidate start position the engine consumes to end-of-string and
/// fails, which is quadratic; stack two on one span and it is cubic.
///
/// WHY THE SWIFT SIDE NEEDS ITS OWN, AND WHY IT LOOKS DIFFERENT. Swift has no regex literal here: every
/// pattern is a STRING CONSTANT handed to `NSRegularExpression`, so a lexer looking for `/…/` would find
/// nothing at all. It also has POSSESSIVE quantifiers (`[^>]*+`), which this file used to rely on — they
/// remove the futile backtracking but not the forward re-scan, so they are exactly as quadratic and the
/// rule below treats them identically. And ICU's constant is far larger than V8's: the shapes this task
/// removed measured 18-41 s at 20,000 candidates, against 0.08 s for the scans that replaced them, and
/// the cubic one did not finish 50 KB in ten minutes.
///
/// THE RULE ENFORCED BELOW: every regex pattern in live Swift code in `Sources/WinterChatKit` that
/// mentions `<` or `>` must either carry no unbounded class/dot quantifier, or have that quantifier as its
/// final element, or have its only unbounded quantifiers be whitespace-only and non-leading, or be named
/// in `allowed` with a proof. A pattern that cannot be read statically (built from a variable) fails
/// closed rather than passing unexamined.
final class RegexShapeTripwireTests: XCTestCase {
    /// `<repo>/apple/WinterChatKit/Sources/WinterChatKit`, derived from this file's own path exactly as
    /// `ParityFixtures` derives the fixture directory.
    private static let sourceDir: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 3 { url.deleteLastPathComponent() } // RegexShapeTripwireTests.swift, WinterChatKitTests, Tests
        return url.appending(path: "Sources/WinterChatKit")
    }()

    /// DERIVED, not hardcoded, and RECURSIVE (the TS gate's review Minor 7: a non-recursive derivation
    /// follows code added beside a file but not code lifted out of it).
    private static func sourceFiles() throws -> [String] {
        let files = try FileManager.default
            .subpathsOfDirectory(atPath: sourceDir.path(percentEncoded: false))
            .filter { $0.hasSuffix(".swift") }
            .sorted()
        return files
    }

    private static func read(_ relative: String) throws -> String {
        try String(contentsOf: sourceDir.appending(path: relative), encoding: .utf8)
    }

    /// Frozen copy of `HtmlToText.swift`'s `jsWhitespaceScalars`, as a character class. `Patterns.lineBreak`
    /// interpolates that constant into its pattern, so the tripwire has to expand it to classify it — and a
    /// frozen copy is the right kind of copy: one that notices when the original changes.
    private static let jsWhitespaceClass = "[\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}"
        + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
        + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]"

    /// Patterns that match the dangerous SHAPE but are provably safe, each with the proof. EMPTY, exactly
    /// as on the TS side: the one candidate (`<[Bb][Rr]\(jsWS)*/?>`) is covered by the whitespace
    /// exemption's proof instead of by an entry here.
    private static let allowed: [String] = []

    /// The ONE regex this gate cannot read as a literal, and why that is sound: `HtmlToText.swift`'s
    /// `compile(_ pattern: String)` helper forwards its parameter to `NSRegularExpression(pattern:)`, so the
    /// site reads `pattern` rather than a literal — while every one of its CALL SITES is a literal and IS
    /// checked. Its presence is asserted, not assumed, so renaming or rewriting the helper trips the gate
    /// instead of quietly widening this hole.
    private static let analyzedIndirection = (file: "HtmlToText.swift", argumentPrefix: "pattern)")

    /// The SECOND unreadable site, checked another way: `ThinkingTitleRule.swift`'s `JSRegex` (the
    /// thinking pill's title rule, a port of the daemon's) builds its patterns from word lists, so no
    /// literal exists to read. They are read at RUN TIME instead (`ActivityTitleRule.compiledPatterns`,
    /// tied to the file's `JSRegex(` construction sites by count) and held to the same rule —
    /// `testTheThinkingTitleRulesRuntimePatternsPassTheRule`.
    private static let runtimeCheckedIndirection = (file: "ThinkingTitleRule.swift", argumentPrefix: "pattern, options:")

    // MARK: - the Swift-source lexer

    private struct FoundPattern {
        let line: Int
        let pattern: String
    }

    /// Every regex pattern built from a STRING LITERAL in live code, plus every regex built some other way
    /// (which is reported separately and fails the gate — an unreadable pattern must never pass silently).
    ///
    /// A lexer, not a regex scan, for the same reason the TS gate needs one: this package's doc comments
    /// deliberately QUOTE the dangerous patterns as reference spellings (that is how the fixes record what
    /// they replaced), so a scan that cannot tell code from comments would cry wolf forever.
    private static func regexPatterns(in src: String) -> (found: [FoundPattern], opaque: [FoundPattern]) {
        let chars = Array(src)
        var found: [FoundPattern] = []
        var opaque: [FoundPattern] = []
        var i = 0
        var line = 1

        /// The two ways this package builds a regex. `compile(` is `HtmlToText.swift`'s own helper.
        let triggers = ["NSRegularExpression(pattern:", "compile("]

        func startsWith(_ needle: String, at index: Int) -> Bool {
            let n = Array(needle)
            guard index + n.count <= chars.count else { return false }
            for k in 0 ..< n.count where chars[index + k] != n[k] { return false }
            return true
        }

        /// Reads a Swift string literal at `index` (plain or raw `#"…"#`), returning its contents and the
        /// index just past it. `nil` when there is no literal there.
        func readLiteral(at index: Int) -> (String, Int)? {
            var j = index
            var hashes = 0
            while j < chars.count, chars[j] == "#" { hashes += 1; j += 1 }
            guard j < chars.count, chars[j] == "\"" else { return nil }
            j += 1
            var out = ""
            while j < chars.count {
                if hashes == 0, chars[j] == "\\" {
                    // Keep escapes AS WRITTEN: `\\s` in Swift source is the regex's `\s`, and the rule below
                    // reads regex syntax, so the regex-level spelling is what it must see.
                    if j + 1 < chars.count, chars[j + 1] == "\\" { out.append("\\"); j += 2; continue }
                    if j + 1 < chars.count, chars[j + 1] == "n" { out.append("\n"); j += 2; continue }
                    if j + 1 < chars.count, chars[j + 1] == "\"" { out.append("\""); j += 2; continue }
                    if j + 1 < chars.count, chars[j + 1] == "(" {
                        // A string interpolation. Expand the ONE the sources use and refuse to guess at any
                        // other, so an interpolated pattern can never slip through unexamined.
                        if startsWith("\\(jsWS)", at: j) {
                            out += jsWhitespaceClass
                            j += "\\(jsWS)".count
                            continue
                        }
                        out += "\u{FFFD}UNEXPANDED-INTERPOLATION"
                        j += 2
                        continue
                    }
                    out.append(chars[j])
                    j += 1
                    continue
                }
                if chars[j] == "\"" {
                    var k = j + 1
                    var seen = 0
                    while k < chars.count, chars[k] == "#", seen < hashes { seen += 1; k += 1 }
                    if seen == hashes { return (out, k) }
                }
                if chars[j] == "\n" { return nil } // unterminated: not a literal after all
                out.append(chars[j])
                j += 1
            }
            return nil
        }

        while i < chars.count {
            if chars[i] == "\n" { line += 1; i += 1; continue }
            if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "/" {
                while i < chars.count, chars[i] != "\n" { i += 1 }
                continue
            }
            if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "*" {
                var depth = 1
                i += 2
                while i < chars.count, depth > 0 {
                    if chars[i] == "\n" { line += 1 }
                    if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "*" { depth += 1; i += 2; continue }
                    if chars[i] == "*", i + 1 < chars.count, chars[i + 1] == "/" { depth -= 1; i += 2; continue }
                    i += 1
                }
                continue
            }
            if let trigger = triggers.first(where: { startsWith($0, at: i) }),
               !(i >= 5 && String(chars[(i - 5) ..< i]) == "func ") { // the helper's DECLARATION, not a call
                var j = i + trigger.count
                while j < chars.count, chars[j] == " " || chars[j] == "\n" {
                    if chars[j] == "\n" { line += 1 }
                    j += 1
                }
                if let (pattern, next) = readLiteral(at: j) {
                    found.append(FoundPattern(line: line, pattern: pattern))
                    i = next
                } else {
                    // Not a literal — a variable, a ternary, a concatenation. Cannot be read statically.
                    var preview = ""
                    var k = j
                    while k < chars.count, chars[k] != "\n", preview.count < 60 { preview.append(chars[k]); k += 1 }
                    opaque.append(FoundPattern(line: line, pattern: preview))
                    i = j
                }
                continue
            }
            if chars[i] == "\"" || chars[i] == "#" {
                if let (_, next) = readLiteral(at: i) { i = next; continue }
            }
            i += 1
        }
        return (found, opaque)
    }

    // MARK: - the rule

    private static func classIsWhitespaceOnly(_ body: String) -> Bool {
        if body.isEmpty || body.hasPrefix("^") { return false }
        let scalars = Array(body.unicodeScalars)
        var i = 0
        while i < scalars.count {
            if scalars[i] == "\\" {
                guard i + 1 < scalars.count, scalars[i + 1] == "s" || scalars[i + 1] == "t"
                    || scalars[i + 1] == "n" || scalars[i + 1] == "r" || scalars[i + 1] == "f"
                    || scalars[i + 1] == "v" else { return false }
                i += 2
                continue
            }
            if scalars[i] == "-" { return false } // a range could reach non-whitespace
            guard jsWhitespaceClass.unicodeScalars.contains(scalars[i]) else { return false }
            i += 1
        }
        return true
    }

    /// The Swift port of the TS gate's rule, with one addition Swift needs: POSSESSIVE quantifiers
    /// (`[^>]*+`, `([^"]++)`) are unbounded exactly as their greedy forms are, so `*+`/`++` must be read as
    /// quantified. See the TS function for the whitespace exemption's proof; both halves of it (non-leading,
    /// no alternation) are self-tested below.
    static func unboundedQuantifierBeforeMore(_ source: String) -> Bool {
        let s = Array(source)
        let hasAlternation = source.contains("|")
        var sawLiteralBefore = false
        var i = 0
        while i < s.count {
            var atomIsScanning = false
            var atomIsWhitespaceOnly = false
            if s[i] == "\\" {
                let next: Character? = i + 1 < s.count ? s[i + 1] : nil
                atomIsScanning = next.map { "sSwWdD".contains($0) } ?? false
                atomIsWhitespaceOnly = next == "s"
                i += 2
            } else if s[i] == "[" {
                let bodyStart = i + 1
                i += 1
                while i < s.count, s[i] != "]" {
                    if s[i] == "\\" { i += 1 }
                    i += 1
                }
                atomIsWhitespaceOnly = classIsWhitespaceOnly(String(s[bodyStart ..< min(i, s.count)]))
                i += 1
                atomIsScanning = true
            } else if s[i] == "(" {
                let start = i
                var depth = 0
                while i < s.count {
                    if s[i] == "\\" { i += 2; continue }
                    if s[i] == "[" {
                        i += 1
                        while i < s.count, s[i] != "]" {
                            if s[i] == "\\" { i += 1 }
                            i += 1
                        }
                    } else if s[i] == "(" {
                        depth += 1
                    } else if s[i] == ")" {
                        depth -= 1
                        if depth == 0 { i += 1; break }
                    }
                    i += 1
                }
                let body = String(s[start ..< min(i, s.count)])
                atomIsScanning = body.contains("[") || body.contains(".")
                    || body.contains("\\s") || body.contains("\\S") || body.contains("\\w")
                    || body.contains("\\W") || body.contains("\\d") || body.contains("\\D")
            } else if s[i] == "." {
                atomIsScanning = true
                i += 1
            } else {
                let next: Character? = i + 1 < s.count ? s[i + 1] : nil
                let optional = next == "?" || next == "*" || next == "{"
                if !optional, !"^$|?*+(){}".contains(s[i]) { sawLiteralBefore = true }
                i += 1
                continue
            }
            var quantified = false
            var matchesAtLeastOne = true
            if i < s.count, s[i] == "*" || s[i] == "+" {
                quantified = true
                matchesAtLeastOne = s[i] == "+"
                i += 1
                // POSSESSIVE (`*+`, `++`) or LAZY (`*?`, `+?`) — both are still unbounded.
                if i < s.count, s[i] == "+" || s[i] == "?" { i += 1 }
            } else if i < s.count, s[i] == "{" {
                if let close = source.range(of: "}", range: source.index(source.startIndex, offsetBy: i) ..< source.endIndex) {
                    let closeOffset = source.distance(from: source.startIndex, to: close.lowerBound)
                    let quantifier = String(s[i ... closeOffset])
                    if quantifier.hasSuffix(",}"), quantifier.dropFirst().dropLast(2).allSatisfy(\.isNumber),
                       !quantifier.dropFirst().dropLast(2).isEmpty {
                        quantified = true
                    }
                    matchesAtLeastOne = !(quantifier.hasPrefix("{0,") || quantifier == "{0}")
                    i = closeOffset + 1
                    if i < s.count, s[i] == "+" || s[i] == "?" { i += 1 }
                }
            } else if i < s.count, s[i] == "?" {
                matchesAtLeastOne = false
                i += 1
            }
            let whitespaceExempt = atomIsWhitespaceOnly && sawLiteralBefore && !hasAlternation
            if quantified, atomIsScanning, !whitespaceExempt, i < s.count { return true }
            if matchesAtLeastOne { sawLiteralBefore = true }
        }
        return false
    }

    private static func mentionsMarkup(_ pattern: String) -> Bool {
        pattern.contains("<") || pattern.contains(">")
    }

    // MARK: - self-tests (a gate that cannot fire is theatre)

    func testTheRuleFiresOnEveryPatternThisTaskRemoved() {
        for offender in [
            "<[Aa]\(Self.jsWhitespaceClass)[^>]*[Hh][Rr][Ee][Ff]=\"([^\"]++)\"[^>]*+>", // the cubic one
            "<[Hh]([1-6])[^>]*+>",
            "<[Ll][Ii](?![0-9A-Za-z_])[^>]*+>",
            "<[Hh]1[^>]*>([\\s\\S]*?)</[Hh]1>",
            "<[Tt][Ii][Tt][Ll][Ee][^>]*>([\\s\\S]*?)</[Tt][Ii][Tt][Ll][Ee]>",
            "<[^>]++>",
            "<script[\\s\\S]*?</script>", // the pre-T6 shape the whole family started as
            "<x(?:[^>])*>", // group-wrapped spellings of the same thing
            "<x(?:[^>]|\"[^\"]*\")*>",
            "<x(?:.)+>",
            "<x[^>]{2,}>", // an open-ended bounded quantifier is still unbounded
        ] {
            XCTAssertTrue(Self.mentionsMarkup(offender) && Self.unboundedQuantifierBeforeMore(offender),
                          "the rule failed to fire on \(offender)")
        }
    }

    func testTheRuleDoesNotFireOnThePatternsThatSurvived() {
        for safe in ["</[Hh]([1-6])>", "</([Pp]|[Dd][Ii][Vv]|[Hh][1-6]|[Ll][Ii]|[Tt][Rr])>",
                     "\n+", "<[^>]+", "^[0-9a-f]{1,4}$", "lines ([0-9]+)-([0-9]+) of ([0-9]+)>"] {
            XCTAssertFalse(Self.unboundedQuantifierBeforeMore(safe), "the rule cried wolf on \(safe)")
        }
    }

    func testTheWhitespaceExemptionCoversTheLiveInstanceAndNothingLooser() {
        // EXEMPT: whitespace-only unbounded quantifier behind a required non-whitespace literal.
        XCTAssertFalse(Self.unboundedQuantifierBeforeMore("<[Bb][Rr]\(Self.jsWhitespaceClass)*/?>"))
        XCTAssertFalse(Self.unboundedQuantifierBeforeMore("</\\s*task-notification\\s*>"))
        // NOT exempt: each breaks one half of the proof, and each is genuinely quadratic.
        for unsafe in ["\\s*<x>", "\\s+x>", "<x>|\\s*y", "x?\\s*<y>", "<x[^>]*\\s*>", "<x\\S*>", "<x[\\s\\S]*>"] {
            XCTAssertTrue(Self.unboundedQuantifierBeforeMore(unsafe), "the exemption swallowed \(unsafe)")
        }
    }

    func testTheLexerReadsLiveCodeAndIgnoresTheReferenceSpellingsInComments() throws {
        let files = try Self.sourceFiles()
        XCTAssertTrue(files.contains("HtmlToText.swift"))
        XCTAssertTrue(files.contains("PageFetcher.swift"))
        XCTAssertGreaterThan(files.count, 10, "the derivation returned almost nothing — every check would be vacuous")

        let html = try Self.read("HtmlToText.swift")
        let (found, opaque) = Self.regexPatterns(in: html)
        // Exactly one unreadable site, and it is the documented `compile` indirection.
        XCTAssertEqual(opaque.count, 1, "unexpected unreadable regex site(s): \(opaque)")
        XCTAssertTrue(opaque.first?.pattern.hasPrefix(Self.analyzedIndirection.argumentPrefix) ?? false,
                      "the `compile` helper's forwarding site changed shape: \(opaque)")
        // It really sees the four survivors…
        let sources = found.map(\.pattern)
        XCTAssertTrue(sources.contains("</[Hh]([1-6])>"), "lexer found \(sources)")
        XCTAssertTrue(sources.contains("\n+"))
        XCTAssertTrue(sources.contains(where: { $0.hasPrefix("<[Bb][Rr]") && $0.contains("\u{FEFF}") }),
                      "the `\\(jsWS)` interpolation was not expanded: \(sources)")
        // …and none of the removed spellings, every one of which appears in this file's COMMENTS.
        for removed in ["<[^>]++>", "<[Hh]([1-6])[^>]*+>", "<[Ll][Ii](?![0-9A-Za-z_])[^>]*+>"] {
            XCTAssertFalse(sources.contains(removed), "the lexer leaked a commented reference spelling: \(removed)")
        }
        XCTAssertTrue(html.contains("/<[^>]+>/g"), "sanity: the reference spellings ARE in this file's comments")
    }

    /// THE GATE.
    func testNoLiveRegexInTheKitScansUnboundedlyPastAMissingGt() throws {
        var offenders: [String] = []
        var unreadable: [String] = []
        var sawAnalyzedIndirection = false
        var sawRuntimeCheckedIndirection = false
        for file in try Self.sourceFiles() {
            let (found, opaque) = Self.regexPatterns(in: try Self.read(file))
            for p in opaque {
                if file == Self.analyzedIndirection.file,
                   p.pattern.hasPrefix(Self.analyzedIndirection.argumentPrefix) {
                    sawAnalyzedIndirection = true
                    continue
                }
                if file == Self.runtimeCheckedIndirection.file,
                   p.pattern.hasPrefix(Self.runtimeCheckedIndirection.argumentPrefix) {
                    sawRuntimeCheckedIndirection = true
                    continue   // checked at run time — see `testTheThinkingTitleRulesRuntimePatternsPassTheRule`
                }
                unreadable.append("\(file):\(p.line)  \(p.pattern)")
            }
            for p in found {
                guard Self.mentionsMarkup(p.pattern) else { continue }
                guard Self.unboundedQuantifierBeforeMore(p.pattern) else { continue }
                guard !Self.allowed.contains(p.pattern) else { continue }
                offenders.append("\(file):\(p.line)  \(p.pattern)")
            }
        }
        XCTAssertEqual(unreadable.joined(separator: "\n"), "",
                       "a regex built from something other than a literal cannot be checked — fail closed")
        XCTAssertTrue(sawAnalyzedIndirection,
                      "the `compile` helper's forwarding site is gone — re-derive what this gate may skip")
        XCTAssertTrue(sawRuntimeCheckedIndirection,
                      "the `JSRegex` forwarding site is gone — re-derive what this gate may skip (and its runtime check)")
        XCTAssertEqual(offenders.joined(separator: "\n"), "")
    }

    /// The runtime half of the gate for `ThinkingTitleRule.swift`: exactly one opaque site (its `JSRegex`
    /// forwarding `pattern`), `JSRegex` is FILEPRIVATE (so no other file can build one past this gate),
    /// `compiledPatterns` names one pattern per construction site in the file (so a new regex cannot be
    /// added without being listed), and EVERY one passes both rules — the markup rule above where it
    /// applies, and, for all of them, the nested/adjacent unbounded-quantifier audit (review r1: the
    /// title rule's lead-word pattern backtracked for seconds on the daemon's main thread).
    func testTheThinkingTitleRulesRuntimePatternsPassTheRule() throws {
        let src = try Self.read(Self.runtimeCheckedIndirection.file)
        let (found, opaque) = Self.regexPatterns(in: src)
        XCTAssertEqual(found.count, 0, "a literal here would be checked by the main gate; this file has none: \(found)")
        XCTAssertEqual(opaque.count, 1, "unexpected unreadable regex site(s): \(opaque)")
        XCTAssertTrue(opaque.first?.pattern.hasPrefix(Self.runtimeCheckedIndirection.argumentPrefix) ?? false,
                      "the `JSRegex` forwarding site changed shape: \(opaque)")
        XCTAssertTrue(src.contains("fileprivate struct JSRegex"), "JSRegex must stay fileprivate to this file")
        let constructionSites = src.components(separatedBy: "JSRegex(").count - 1
        let patterns = ActivityTitleRule.compiledPatterns
        XCTAssertEqual(patterns.count, constructionSites, "compiledPatterns must list every JSRegex the file builds")
        XCTAssertEqual(Set(patterns).count, patterns.count)
        for p in patterns {
            if Self.mentionsMarkup(p) { XCTAssertFalse(Self.unboundedQuantifierBeforeMore(p), "unbounded scan before more in \(p)") }
            XCTAssertEqual(Self.quantifierHazards(p), [], "nested/adjacent unbounded quantifiers in \(p)")
        }
    }

    func testTheQuantifierAuditFiresOnTheShapesThatBacktrack() {
        XCTAssertFalse(Self.quantifierHazards(#"^(?:(?:now|so)(?![A-Za-z'])\s*,?\s+)*"#).isEmpty)   // the old lead-word pattern
        XCTAssertFalse(Self.quantifierHazards(#"\s*,?\s+"#).isEmpty)
        XCTAssertFalse(Self.quantifierHazards(#"(a+)+b"#).isEmpty)
        XCTAssertFalse(Self.quantifierHazards(#"(?:x\s+)*"#).isEmpty)
        XCTAssertEqual(Self.quantifierHazards(#"^[ \t]*\*\*(.+?)\*\*(.*)$"#), [])
        XCTAssertEqual(Self.quantifierHazards(#"^(?:(?:now|so)(?![a-z'])(?: ?,)? )*([a-z]+ing)(?=[ ,]|\z)([^\n]*)\z"#), [])
    }

    /// The Swift port of the daemon's `quantifierHazards` (`thinking-title-hardening.test.ts`): a quantified
    /// group whose body holds an unbounded quantifier, or two unbounded runs with only optional atoms
    /// between them (a lookaround delimits). An approximation that errs toward flagging.
    static func quantifierHazards(_ pattern: String) -> [String] {
        var hazards: [String] = []
        struct Shape { var startsUnbounded = false; var endsUnbounded = false; var hasUnbounded = false }
        func skipClass(_ s: [Character], _ i: Int) -> Int {
            var j = i + 1
            while j < s.count, s[j] != "]" { if s[j] == "\\" { j += 1 }; j += 1 }
            return j + 1
        }
        func groupEnd(_ s: [Character], _ i: Int) -> Int {
            var depth = 0
            var j = i
            while j < s.count {
                let c = s[j]
                if c == "\\" { j += 2; continue }
                if c == "[" { j = skipClass(s, j); continue }
                if c == "(" { depth += 1 } else if c == ")" { depth -= 1; if depth == 0 { return j + 1 } }
                j += 1
            }
            return s.count
        }
        func scan(_ s: [Character]) -> Shape {
            var shape = Shape()
            var prevEnds = false
            var first = true
            var i = 0
            while i < s.count {
                let c = s[i]
                if c == "|" { prevEnds = false; first = true; i += 1; continue }
                var atom = Shape()
                var zeroWidth = false
                var isGroup = false
                if c == "\\" { i += 2 }
                else if c == "[" { i = skipClass(s, i) }
                else if c == "(" {
                    isGroup = true
                    let end = groupEnd(s, i)
                    var body = String(s[(i + 1)..<max(i + 1, end - 1)])
                    if body.hasPrefix("?=") || body.hasPrefix("?!") || body.hasPrefix("?<=") || body.hasPrefix("?<!") { zeroWidth = true }
                    for prefix in ["?<=", "?<!", "?:", "?=", "?!"] where body.hasPrefix(prefix) { body.removeFirst(prefix.count); break }
                    atom = scan(Array(body))
                    i = end
                } else if c == "^" || c == "$" { zeroWidth = true; i += 1 }
                else { i += 1 }
                var unbounded = false
                var optional = zeroWidth
                let q: Character? = i < s.count ? s[i] : nil
                if q == "*" || q == "+" { unbounded = true; if q == "*" { optional = true }; i += 1 }
                else if q == "?" { optional = true; i += 1 }
                else if q == "{", let close = s[i...].firstIndex(of: "}") {
                    let body = String(s[(i + 1)..<close])
                    if body.hasSuffix(","), body.dropLast().allSatisfy(\.isNumber), !body.dropLast().isEmpty { unbounded = true }
                    if body == "0" || body.hasPrefix("0,") { optional = true }
                    i = close + 1
                }
                if let q, "*+?}".contains(q), i < s.count, s[i] == "?" || s[i] == "+" { i += 1 }   // lazy / possessive
                if unbounded && atom.hasUnbounded { hazards.append("nested unbounded quantifier") }
                if isGroup && zeroWidth {
                    shape.hasUnbounded = shape.hasUnbounded || atom.hasUnbounded
                    prevEnds = false
                    continue
                }
                let starts = isGroup ? atom.startsUnbounded : unbounded
                let ends = isGroup ? atom.endsUnbounded : unbounded
                if prevEnds && starts { hazards.append("adjacent unbounded quantifiers") }
                shape.hasUnbounded = shape.hasUnbounded || unbounded || atom.hasUnbounded
                if first && !zeroWidth { shape.startsUnbounded = shape.startsUnbounded || starts }
                if !zeroWidth { first = false }
                if ends { prevEnds = true } else if !optional { prevEnds = false }
                shape.endsUnbounded = ends || (optional && shape.endsUnbounded)
            }
            return shape
        }
        _ = scan(Array(pattern))
        return hazards
    }

    func testTheAllowlistIsEmptyAndAddingToItMustBeDeliberate() {
        XCTAssertEqual(Self.allowed, [])
    }

    /// The scope invariant, mirroring the TS gate's: every file carrying one of the guarded scanners must be
    /// inside the scanned set, so lifting one into a new file (or a new target) fails loudly rather than
    /// silently escaping coverage.
    func testEveryFileCarryingAGuardedScannerIsInScope() throws {
        let symbols = ["scanAnchorOpens", "scanHeadingOpens", "stripTags", "replaceListItems",
                       "firstElementInner", "extractLinks"]
        let files = try Self.sourceFiles()
        var carriers: [String] = []
        for file in files where try symbols.contains(where: Self.read(file).contains) {
            carriers.append(file)
        }
        XCTAssertTrue(carriers.contains("HtmlToText.swift"))
        XCTAssertTrue(carriers.contains("PageFetcher.swift"))
        XCTAssertGreaterThan(carriers.count, 1)
    }
}
