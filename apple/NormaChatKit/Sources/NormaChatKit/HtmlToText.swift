import Foundation

/// Swift port of `packages/core/src/agent/tools/web.ts`'s `htmlToText` — the whole-page HTML→text
/// cleaner behind chat mode's ReadPage (headings → `#`, links → `text (href)`, list items → `- `).
///
/// PORTED FAITHFULLY, INCLUDING THE ALGORITHM SHAPE. The TS was rewritten (whole-branch review,
/// Critical 2 follow-up) from five textbook `<tag[\s\S]*?</tag>` lazy-scan regexes to a LINEARIZED
/// two-pass form: opens and closes scanned separately by single-pass regexes with no
/// "lazy-scan-to-a-required-later-token" shape, paired by a monotonic pointer that only ever
/// advances forward. The lazy form is quadratic on many opens with a distant/absent close — a
/// model-chosen URL froze the TS daemon's event loop ~58 s per 3 MB page. This port must never
/// "simplify" back to the combined form; that reopens the same DoS, here on a phone.
///
/// The TS carries two ACCEPTED divergence classes from its own pre-linearization behavior (see
/// web.ts's "EXACTNESS CAVEAT / PRICE OF LINEARITY" comment), both confined to malformed HTML:
/// (A) headings whose open tag swallowed a later heading open (`<h3<h2>`), (B) pathological `href`
/// values (`<a href="href=">`). Both are pinned as cleaner vectors, so this port reproduces the
/// LINEARIZED behavior — the fixtures are the contract, not the pre-rewrite TS.
///
/// ## JS-exactness notes (why this file avoids the obvious Swift shortcuts)
///
/// - **UTF-16 offsets.** JS string indices are UTF-16 code units; so are `NSRange`s from
///   `NSRegularExpression`. Every offset here is a UTF-16 offset over a materialized `[UInt16]`, so
///   an emoji or a CJK page can never shift a slice boundary relative to the TS.
/// - **No `.caseInsensitive`.** ICU case-insensitivity does FULL Unicode case folding, so `/k/i`
///   matches U+212A KELVIN SIGN and `/s/i` matches U+017F LATIN SMALL LETTER LONG S — JS's
///   non-`u`-flag `i` does neither. Every case-insensitive token below is spelled as an explicit
///   ASCII class (`[Ss][Cc]…`) or matched by an ASCII-folding literal scan instead.
/// - **`\s` is spelled out.** ICU's `\s` omits U+000B and U+FEFF, both of which JS's `\s` includes.
/// - **`\b` is spelled out.** ICU's `\w` includes Unicode letters; JS's is `[A-Za-z0-9_]`. The one
///   `\b` in the TS (`<li\b`) always follows a word character, so it is exactly a negative
///   lookahead on the JS `\w` set.
/// - **`trim()` is spelled out.** JS trims its `\s` set plus the line terminators; Swift's
///   `.whitespacesAndNewlines` differs at U+0085 and U+FEFF.

// MARK: - JS character-class equivalents

/// Exactly JS's `\s` (ES non-`u` flag): the ICU class differs at U+000B and U+FEFF.
private let jsWhitespaceScalars = "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}"
    + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
    + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"

/// The same set as a regex character class. Safe to interpolate: it contains no `]`, `^`, `-` or
/// `\`, so nothing inside needs escaping.
private let jsWS = "[" + jsWhitespaceScalars + "]"

/// Exactly JS `String.prototype.trim()`'s set: WhiteSpace ∪ LineTerminator.
private let jsTrimSet = CharacterSet(charactersIn: jsWhitespaceScalars)

// MARK: - UTF-16 text buffer

/// A string plus its materialized UTF-16 code units, so every slice is an O(1)-indexed, O(k)-copied
/// operation on JS-identical offsets. Bridging a native (UTF-8-backed) Swift `String` to `NSString`
/// and indexing it per match would transcode repeatedly; materializing once keeps every pass linear.
struct Utf16Text {
    let string: String
    let units: [UInt16]

    init(_ string: String) {
        self.string = string
        self.units = Array(string.utf16)
    }

    var count: Int { units.count }
    var fullRange: NSRange { NSRange(location: 0, length: units.count) }

    /// Slice boundaries here are always tag boundaries (ASCII), so this never splits a surrogate
    /// pair — the same property the TS's `String.prototype.slice` relies on.
    func slice(_ from: Int, _ to: Int) -> String {
        guard to > from, from >= 0, to <= units.count else { return "" }
        return String(decoding: units[from ..< to], as: UTF16.self)
    }
}

/// One matched open tag: its UTF-16 span plus the regex capture the renderer needs (an anchor's
/// `href`, a heading's level).
struct TagOpen {
    let start: Int
    let end: Int
    let capture: String
}

struct TagClose {
    let start: Int
    let end: Int
}

// MARK: - compiled patterns

/// Compiled once. Every pattern here is a compile-time constant, so a failure is a programmer
/// error, not a runtime condition.
private func compile(_ pattern: String) -> NSRegularExpression {
    guard let re = try? NSRegularExpression(pattern: pattern) else {
        preconditionFailure("NormaChatKit: invalid built-in regex \(pattern)")
    }
    return re
}

private enum Patterns {
    /// `/<a\s[^>]*href="([^"]+)"[^>]*>/gi`. `([^"]+)` may legitimately span a `>` — that is the
    /// backtracking behaviour PRICE-OF-LINEARITY class (B) is pinned on, and ICU reproduces it.
    static let anchorOpen = compile("<[Aa]\(jsWS)[^>]*[Hh][Rr][Ee][Ff]=\"([^\"]++)\"[^>]*+>")
    /// `/<h([1-6])[^>]*>/gi`
    static let headingOpen = compile("<[Hh]([1-6])[^>]*+>")
    /// `/<\/h([1-6])>/gi`
    static let headingClose = compile("</[Hh]([1-6])>")
    /// `/<li\b[^>]*>/gi` — see the `\b` note in this file's header.
    static let listItem = compile("<[Ll][Ii](?![0-9A-Za-z_])[^>]*+>")
    /// `/<br\s*\/?>/gi`
    static let lineBreak = compile("<[Bb][Rr]\(jsWS)*/?>")
    /// `/<\/(p|div|h[1-6]|li|tr)>/gi`
    static let closingBlock = compile("</([Pp]|[Dd][Ii][Vv]|[Hh][1-6]|[Ll][Ii]|[Tt][Rr])>")
    /// `/<[^>]+>/g` — kept only as the reference spelling. The pass itself runs through
    /// `stripTags`, which is exactly equivalent and linear; see that function.
    static let anyTag = compile("<[^>]++>")
    /// `/\n+/g` — the collapse `extractTitle` / link-text extraction apply.
    static let newlineRun = compile("\n+")
    /// `/<h1[^>]*>([\s\S]*?)<\/h1>/i` — deliberately the LAZY form, exactly as the TS keeps it: it
    /// runs once (first match only), so there is no quadratic multi-open scan to linearize.
    static let firstH1 = compile("<[Hh]1[^>]*>([\\s\\S]*?)</[Hh]1>")
    /// `/<title[^>]*>([\s\S]*?)<\/title>/i`
    static let firstTitle = compile("<[Tt][Ii][Tt][Ll][Ee][^>]*>([\\s\\S]*?)</[Tt][Ii][Tt][Ll][Ee]>")
}

/// The bare, `>`-less open tokens the TS uses for script/style/head. Deliberately NOT `<script[^>]*>`
/// — the original lazy regex never required its own open tag to be terminated, and a differential
/// fuzz run caught a real byte-divergence class from "fixing" that (web.ts's own comment).
private enum Literals {
    static let scriptOpen = Array("<script".utf16)
    static let scriptClose = Array("</script>".utf16)
    static let styleOpen = Array("<style".utf16)
    static let styleClose = Array("</style>".utf16)
    static let headOpen = Array("<head".utf16)
    static let headClose = Array("</head>".utf16)
    /// `/<\/a>/gi` — deliberately not whitespace-tolerant, matching the TS literal exactly.
    static let anchorClose = Array("</a>".utf16)
}

// MARK: - scanning primitives

@inline(__always) private func asciiFold(_ unit: UInt16) -> UInt16 {
    (unit >= 65 && unit <= 90) ? unit + 32 : unit
}

/// Non-overlapping, ASCII-case-insensitive literal scan — the JS `/literal/gi` `exec` loop, whose
/// `lastIndex` also jumps past each match. `needle` must already be lowercase ASCII.
private func findLiteral(_ needle: [UInt16], in haystack: [UInt16]) -> [Int] {
    guard !needle.isEmpty, haystack.count >= needle.count else { return [] }
    var hits: [Int] = []
    var i = 0
    let last = haystack.count - needle.count
    while i <= last {
        var k = 0
        while k < needle.count, asciiFold(haystack[i + k]) == needle[k] { k += 1 }
        if k == needle.count {
            hits.append(i)
            i += needle.count
        } else {
            i += 1
        }
    }
    return hits
}

private func matchOpens(_ re: NSRegularExpression, _ text: Utf16Text) -> [TagOpen] {
    re.matches(in: text.string, options: [], range: text.fullRange).map { m in
        let capture: String
        if m.numberOfRanges > 1, m.range(at: 1).location != NSNotFound {
            let r = m.range(at: 1)
            capture = text.slice(r.location, r.location + r.length)
        } else {
            capture = ""
        }
        return TagOpen(start: m.range.location, end: m.range.location + m.range.length, capture: capture)
    }
}

/// The shared linear mechanism behind the four same-tag-name passes (script/style/head/anchor) —
/// the exact equivalent of `html.replace(/OPEN[\s\S]*?CLOSE/gi, render)`.
///
/// Every open pairs with the FIRST close anywhere after it. An open that starts before the previous
/// pair's own close is treated as nested/already-consumed and left as literal text — the same thing
/// the original lazy regex's `lastIndex` jump did. An open with no close anywhere after it (and
/// every later open, once closes are exhausted) ends the scan, matching the original's "no match".
private func replacePaired(
    _ text: Utf16Text,
    opens: [TagOpen],
    closes: [TagClose],
    render: (TagOpen, String) -> String
) -> String {
    guard !opens.isEmpty, !closes.isEmpty else { return text.string }

    var out = ""
    out.reserveCapacity(text.string.utf8.count)
    var cursor = 0
    var closePtr = 0

    for open in opens {
        if open.start < cursor { continue }
        while closePtr < closes.count, closes[closePtr].start < open.end { closePtr += 1 }
        if closePtr >= closes.count { break }

        let close = closes[closePtr]
        closePtr += 1
        out += text.slice(cursor, open.start)
        out += render(open, text.slice(open.end, close.start))
        cursor = close.end
    }
    out += text.slice(cursor, text.count)
    return out
}

private func stripPairedLiteral(_ html: String, open: [UInt16], close: [UInt16]) -> String {
    let text = Utf16Text(html)
    let opens = findLiteral(open, in: text.units).map { TagOpen(start: $0, end: $0 + open.count, capture: "") }
    let closes = findLiteral(close, in: text.units).map { TagClose(start: $0, end: $0 + close.count) }
    return replacePaired(text, opens: opens, closes: closes) { _, _ in "" }
}

/// `<h1-6>…</h(SAME LEVEL)>` — the one shape `replacePaired` cannot handle, because the TS regex's
/// `\1` backreference requires the close to be the SAME level as its open. Six per-level close lists
/// and six per-level pointers, but ONE shared cursor across all levels (an open of any level nested
/// inside an already-matched span of any level is skipped). Exhausting one level's closes does NOT
/// end the scan — unlike `replacePaired`'s single-tag `break` — because another level's opens can
/// still match; the TS `continue`s here for exactly that reason.
private func convertHeadings(_ html: String) -> String {
    let text = Utf16Text(html)
    var closesByLevel: [[Int]] = Array(repeating: [], count: 7) // index 1...6
    for m in Patterns.headingClose.matches(in: text.string, options: [], range: text.fullRange) {
        let levelRange = m.range(at: 1)
        let level = Int(text.slice(levelRange.location, levelRange.location + levelRange.length)) ?? 0
        if (1 ... 6).contains(level) { closesByLevel[level].append(m.range.location) }
    }

    let opens = matchOpens(Patterns.headingOpen, text)
    guard !opens.isEmpty else { return text.string }

    var pointers = [Int](repeating: 0, count: 7)
    var out = ""
    out.reserveCapacity(text.string.utf8.count)
    var cursor = 0

    for open in opens {
        guard let level = Int(open.capture), (1 ... 6).contains(level) else { continue }
        if open.start < cursor { continue }

        let list = closesByLevel[level]
        var p = pointers[level]
        while p < list.count, list[p] < open.end { p += 1 }
        pointers[level] = p
        if p >= list.count { continue } // this level is exhausted — literal text, keep scanning

        let closeStart = list[p]
        pointers[level] = p + 1
        out += text.slice(cursor, open.start)
        out += "\n\(String(repeating: "#", count: level)) \(text.slice(open.end, closeStart))\n"
        cursor = closeStart + 5 // "</hN>".count
    }
    out += text.slice(cursor, text.count)
    return out
}

private func convertAnchors(_ html: String) -> String {
    let text = Utf16Text(html)
    let opens = matchOpens(Patterns.anchorOpen, text)
    let closes = findLiteral(Literals.anchorClose, in: text.units)
        .map { TagClose(start: $0, end: $0 + Literals.anchorClose.count) }
    return replacePaired(text, opens: opens, closes: closes) { open, inner in "\(inner) (\(open.capture))" }
}

/// The final tag strip, `html.replace(/<[^>]+>/g, "")`, as a single monotonic forward scan.
///
/// Exactly equivalent, and the equivalence is easy to see: the regex's leftmost match at a `<` is
/// `<`, then the run of characters up to the FIRST `>` after it (that run is non-`>` by
/// construction), then that `>` — with at least one character in between, since `[^>]+` cannot match
/// empty. So there is nothing for a regex engine to search for that a forward pointer does not
/// already know.
///
/// Why it is hand-written rather than left to ICU. On markup with no `>` after some point — an
/// unterminated tag, i.e. exactly the malformed shape the rest of this file is hardened against —
/// `<[^>]+>` is O(n²): at EVERY `<` the engine consumes to end-of-string and then fails. Making the
/// quantifier possessive (`[^>]++`) removes the futile backtracking but not the forward re-scan, so
/// it only bought ~25%. Measured on 20,000 unterminated `<script x` tokens (180 KB) in debug:
/// **36 s greedy → 27 s possessive → 3 ms here.**
///
/// This is a deliberate, disclosed PERFORMANCE-ONLY divergence from `web.ts`, which still has the
/// quadratic form (measured 2.1 s on the same input under V8 — same O(n²), a ~17x smaller constant
/// than ICU's, which is why it has not bitten the daemon as hard). Output is byte-identical: the 14
/// cleaner vectors and the 28,000-case differential against the live TS both pass unchanged. Worth
/// porting BACK to `web.ts` — see the fix-round notes in task-6-report.md.
///
/// The single early exit (`no '>' anywhere after here`) is what makes the worst case cheap: if no
/// `>` remains, no match can start at this position or any later one.
func stripTags(_ text: Utf16Text) -> String {
    let units = text.units
    let lt: UInt16 = 0x3C // "<"
    let gt: UInt16 = 0x3E // ">"

    var out = ""
    out.reserveCapacity(text.string.utf8.count)
    var copied = 0
    var i = 0
    var gtPtr = 0 // monotonic — never rewinds across the whole scan

    while i < units.count {
        guard units[i] == lt else {
            i += 1
            continue
        }
        if gtPtr <= i { gtPtr = i + 1 }
        while gtPtr < units.count, units[gtPtr] != gt { gtPtr += 1 }
        if gtPtr >= units.count { break } // no close anywhere after this "<" — nothing more can match
        if gtPtr > i + 1 { // `[^>]+` needs at least one character, so "<>" is not a tag
            out += text.slice(copied, i)
            copied = gtPtr + 1
            i = gtPtr + 1
        } else {
            i += 1
        }
    }
    out += text.slice(copied, units.count)
    return out
}

private func replaceAll(_ re: NSRegularExpression, in string: String, with template: String) -> String {
    re.stringByReplacingMatches(in: string,
                                options: [],
                                range: NSRange(location: 0, length: string.utf16.count),
                                withTemplate: template)
}

// MARK: - public surface

/// The byte-faithful mirror of TS `htmlToText(html) -> string`. Same shape as the source so the two
/// can be diffed line-for-line; `htmlToTextLines` is the split-applied form callers actually store.
public func htmlToText(_ html: String) -> String {
    var out = html
    out = stripPairedLiteral(out, open: Literals.scriptOpen, close: Literals.scriptClose)
    out = stripPairedLiteral(out, open: Literals.styleOpen, close: Literals.styleClose)
    out = stripPairedLiteral(out, open: Literals.headOpen, close: Literals.headClose)
    // structure worth keeping (user design): headings → #, links → text (url), list items → "- "
    out = convertHeadings(out)
    out = convertAnchors(out)

    out = replaceAll(Patterns.listItem, in: out, with: "\n- ")
    out = replaceAll(Patterns.lineBreak, in: out, with: "\n")
    out = replaceAll(Patterns.closingBlock, in: out, with: "\n")
    out = stripTags(Utf16Text(out)) // == replace(/<[^>]+>/g, ""), linear — see stripTags

    // Entity order matters and mirrors the TS exactly: `&amp;` first, so `&amp;lt;` decodes to the
    // literal text `&lt;` rather than to `<`.
    out = out.replacingOccurrences(of: "&amp;", with: "&")
    out = out.replacingOccurrences(of: "&lt;", with: "<")
    out = out.replacingOccurrences(of: "&gt;", with: ">")
    out = out.replacingOccurrences(of: "&quot;", with: "\"")
    out = out.replacingOccurrences(of: "&#39;", with: "'")
    out = out.replacingOccurrences(of: "&nbsp;", with: " ")

    return out
        .components(separatedBy: "\n")
        .map { $0.trimmingCharacters(in: jsTrimSet) }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
}

/// `htmlToText(html).split("\n")` — the shape `CleanPage.lines` stores and the shape
/// `cleaner-vectors.json` pins.
///
/// SPLIT CONVENTION (Task 4 fix-1 review): JS `"".split("\n")` is `[""]` — ONE empty line. Swift's
/// `split(separator:)` defaults to `omittingEmptySubsequences: true` and would return `[]` for the
/// empty page and silently swallow blank lines everywhere else. `components(separatedBy:)` is the
/// JS-equivalent and is the only correct choice here.
public func htmlToTextLines(_ html: String) -> [String] {
    htmlToText(html).components(separatedBy: "\n")
}

/// TS `page-core.ts`'s own small `extractTitle` (h1, else `<title>`, run through the cleaner and
/// collapsed to one line). `"-"` when neither is present or both clean to nothing.
func extractTitle(_ html: String) -> String {
    let range = NSRange(location: 0, length: html.utf16.count)
    let match = Patterns.firstH1.firstMatch(in: html, options: [], range: range)
        ?? Patterns.firstTitle.firstMatch(in: html, options: [], range: range)
    guard let match, match.numberOfRanges > 1, match.range(at: 1).location != NSNotFound else { return "-" }

    let text = Utf16Text(html)
    let inner = match.range(at: 1)
    let collapsed = collapseToOneLine(htmlToText(text.slice(inner.location, inner.location + inner.length)))
    return collapsed.isEmpty ? "-" : collapsed
}

/// TS `htmlToText(x).replace(/\n+/g, " ").trim()`.
func collapseToOneLine(_ text: String) -> String {
    replaceAll(Patterns.newlineRun, in: text, with: " ").trimmingCharacters(in: jsTrimSet)
}

/// Exposed for `PageFetcher`'s link extraction, which needs the same anchor open/close pairing the
/// cleaner uses but has to run on the RAW html (the cleaner rewrites `<a>` into `text (href)` prose
/// and so destroys the structure a link list needs). ONE pairing implementation, two callers.
func anchorSpans(_ text: Utf16Text) -> (opens: [TagOpen], closes: [TagClose]) {
    let opens = matchOpens(Patterns.anchorOpen, text)
    let closes = findLiteral(Literals.anchorClose, in: text.units)
        .map { TagClose(start: $0, end: $0 + Literals.anchorClose.count) }
    return (opens, closes)
}
