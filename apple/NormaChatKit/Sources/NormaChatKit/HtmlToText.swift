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

/// WHAT IS **NOT** HERE, and must never come back (chat-d T6c, mirroring `web.ts` fix rounds 1-3):
/// every pattern whose unbounded quantifier is followed by a required `>` — the whole open-tag class.
/// Their reference spellings live in the doc comments of the scanners that replaced them, deliberately
/// as prose rather than as compiled constants:
///
///     /<a\s[^>]*href="([^"]+)"[^>]*>/gi   -> scanAnchorOpens    (was Patterns.anchorOpen, CUBIC)
///     /<h([1-6])[^>]*>/gi                -> scanHeadingOpens   (was Patterns.headingOpen)
///     /<li\b[^>]*>/gi                    -> replaceListItems   (was Patterns.listItem)
///     /<h1[^>]*>([\s\S]*?)<\/h1>/i       -> firstElementInner  (was Patterns.firstH1)
///     /<title[^>]*>([\s\S]*?)<\/title>/i -> firstElementInner  (was Patterns.firstTitle)
///     /<[^>]+>/g                         -> stripTags          (was Patterns.anyTag, unused)
private enum Patterns {
    /// `/<\/h([1-6])>/gi`
    static let headingClose = compile("</[Hh]([1-6])>")
    /// `/<br\s*\/?>/gi` — `\s*` can only consume WHITESPACE and it sits behind a required non-whitespace
    /// literal, so the runs it consumes across candidates are disjoint: linear, not quadratic. (The same
    /// proof the TS tripwire's whitespace exemption records.)
    static let lineBreak = compile("<[Bb][Rr]\(jsWS)*/?>")
    /// `/<\/(p|div|h[1-6]|li|tr)>/gi`
    static let closingBlock = compile("</([Pp]|[Dd][Ii][Vv]|[Hh][1-6]|[Ll][Ii]|[Tt][Rr])>")
    /// `/\n+/g` — the collapse `extractTitle` / link-text extraction apply.
    static let newlineRun = compile("\n+")
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
    /// The `href="` the anchor scan searches for, lowercase (the scan folds A-Z as JS's `i` flag does).
    static let hrefOpen = Array("href=\"".utf16)
}

// MARK: - scanning primitives

private let ltUnit: UInt16 = 0x3C // "<"
private let gtUnit: UInt16 = 0x3E // ">"
private let quoteUnit: UInt16 = 0x22 // '"'

/// Exactly `jsWhitespaceScalars` as UTF-16 code units — every member is BMP, so one unit each.
private let jsWhitespaceUnits: Set<UInt16> = Set(jsWhitespaceScalars.utf16)

@inline(__always) private func asciiFold(_ unit: UInt16) -> UInt16 {
    (unit >= 65 && unit <= 90) ? unit + 32 : unit
}

@inline(__always) private func isJsWhitespace(_ unit: UInt16) -> Bool { jsWhitespaceUnits.contains(unit) }

/// JS `\w` == `[0-9A-Za-z_]` (ICU's includes Unicode letters) — the `\b` in `/<li\b/` spelled out.
@inline(__always) private func isJsWordUnit(_ unit: UInt16) -> Bool {
    (unit >= 48 && unit <= 57) || (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || unit == 95
}

// ---------------------------------------------------------------------------------------------
// THE OPEN-TAG SCAN CLASS, and the primitive that closes it.
//
// Ported from `packages/core/src/agent/tools/web.ts` (Task 6b fix rounds 1-3, which needed three
// rounds because each one fixed the instances it was handed). THE CLASS: a pattern with an unbounded
// quantifier (`[^>]*`, `[^"]+`) followed by a REQUIRED `>` is quadratic on input where that `>` never
// arrives — at every candidate start position the engine consumes to end-of-string and then fails. The
// anchor pattern stacked THREE unbounded quantifiers on one span, which is CUBIC. Possessive
// quantifiers (`[^>]*+`, which is what this file used) remove the futile BACKTRACKING but not the
// forward re-scan; this file's own note that possessive "only bought ~25%" applies verbatim, and ICU's
// constant is far larger than V8's. On the daemon the same shapes cost 13.2 s of blocked event loop on
// a 14.6 KB page, charged TWICE per fetch (the cleaner's anchor pass AND the link extractor) — and the
// phone carries the identical double charge through `convertAnchors` + `anchorSpans`.
//
// THE FIX IS STRUCTURAL. Every open-tag pattern is now (a) a quantifier-free candidate test — a
// hand-written ASCII scan rather than a regex, because ICU would allocate an `NSTextCheckingResult` per
// candidate and the case/whitespace classes have to be JS's anyway — plus (b) a scan bounded by a
// monotonic `>` pointer that never rewinds.
//
// THE BOUND IS THE LOAD-BEARING HALF (review of TS fix round 3, Critical 3). The intermediate TS
// version advanced a scan pointer but left the `href="` SEARCH unbounded, which made ORDINARY markup
// quadratic — `<a name="sN">Section</a>` repeated cost 12.13 s at 510 KB against 0.32 ms for the regex
// it replaced, on a page nobody would call adversarial. `scanAnchorOpens` below passes the span end as
// an upper bound to that search; that alone makes the examined regions disjoint across spans.

/// The shared primitive: the first `>` at or after `at`, or -1 when none remains.
///
/// CONTRACT: `at` must be non-decreasing across calls on one finder. Every caller scans candidates left
/// to right, so this holds. It is what makes the whole scan linear — the pointer crosses the document
/// once in total, not once per candidate. It is also why the cached answer stays CORRECT when two
/// candidates share a span: if there is no `>` in `[a1, g)` then there is none in `[a2, g)` for any
/// `a2 > a1`.
private struct GtFinder {
    private let units: [UInt16]
    private var ptr = 0

    init(_ units: [UInt16]) { self.units = units }

    mutating func next(_ at: Int) -> Int {
        if ptr < at { ptr = at }
        while ptr < units.count, units[ptr] != gtUnit { ptr += 1 }
        return ptr >= units.count ? -1 : ptr
    }
}

/// ASCII-case-insensitive `indexOf` over `[from, until)`. `needleLower` must already be lowercase ASCII.
///
/// `until` is not politeness: an unbounded search followed by a required terminator is the same defect
/// whether a regex engine or a hand-written loop performs it (review Critical 3). Callers that run once
/// per DOCUMENT may pass `units.count`; a caller that runs once per CANDIDATE must pass the bound its
/// answer could possibly come from.
private func indexOfAsciiCI(_ units: [UInt16], _ needleLower: [UInt16], from: Int, until: Int) -> Int {
    let n = min(until, units.count)
    let m = needleLower.count
    guard m > 0 else { return max(0, from) }
    var i = max(0, from)
    while i + m <= n {
        var k = 0
        while k < m, asciiFold(units[i + k]) == needleLower[k] { k += 1 }
        if k == m { return i }
        i += 1
    }
    return -1
}

private func indexOfUnit(_ units: [UInt16], _ unit: UInt16, from: Int) -> Int {
    var i = max(0, from)
    while i < units.count {
        if units[i] == unit { return i }
        i += 1
    }
    return -1
}

/// `/<h([1-6])[^>]*>/gi`, linearly. `[^>]*` cannot cross a `>`, so the match ends at the FIRST `>` at or
/// after the candidate token — there is nothing to search for that the pointer does not already know.
/// No `>` after a candidate means no match for it or for any later one, hence the early return.
///
/// `internal`, not `private`, only so the tuple differential can compare it against the regex it
/// replaced. Not part of any public surface.
func scanHeadingOpens(_ text: Utf16Text) -> [TagOpen] {
    let units = text.units
    let n = units.count
    var opens: [TagOpen] = []
    var finder = GtFinder(units)
    var i = 0
    while i + 3 <= n {
        guard units[i] == ltUnit, asciiFold(units[i + 1]) == 0x68 /* h */,
              units[i + 2] >= 0x31, units[i + 2] <= 0x36 /* 1-6 */ else {
            i += 1 // exactly what a failed `exec` candidate does: advance one position
            continue
        }
        let gt = finder.next(i + 3)
        if gt < 0 { break }
        opens.append(TagOpen(start: i, end: gt + 1, capture: text.slice(i + 2, i + 3)))
        i = gt + 1 // the global regex's own `lastIndex` jump past the match
    }
    return opens
}

/// `/<a\s[^>]*href="([^"]+)"[^>]*>/gi`, linearly — the cubic one, and the only site whose equivalence is
/// not obvious, so here is the whole derivation (it is the TS's, verified there against the real regex on
/// 500,000 randomized documents as full `(start, end, capture)` tuple lists, and re-verified here).
///
/// For a candidate `<a` + one `\s` at `i` (token ending at `i+3`):
///
///  1. `[^>]*` cannot cross a `>`, so `href="` must lie entirely inside `[i+3, spanEnd)` where `spanEnd`
///     is the first `>` at or after `i+3`. No `>` at all after `i+3` ⇒ no match here or later ⇒ stop.
///  2. `([^"]+)` cannot match a `"`, and backtracking it to a shorter run would need a `"` where there
///     is none — so the value is EXACTLY the text from after `href="` to the NEXT `"`, and that `"` must
///     exist. It may legitimately cross a `>`; that is PRICE-OF-LINEARITY class (B) (`<a href="href=">`),
///     pinned as a cleaner vector, and reproduced here.
///  3. The trailing `[^>]*>` then needs a `>` after that closing quote — necessarily the FIRST one.
///  4. The leading `[^>]*` is GREEDY, so the engine tries `href="` occurrences RIGHT TO LEFT and takes
///     the first that completes 2-3: the winner is the RIGHTMOST VIABLE occurrence, where "viable" means
///     it has a closing `"` and a `>` after that quote — neither of which depends on `i`.
///
/// That last point is what makes this O(1) per candidate: viability is a property of the SPAN, so the
/// rightmost viable occurrence is computed once per span and candidates sharing a span reuse it.
func scanAnchorOpens(_ text: Utf16Text) -> [TagOpen] {
    let units = text.units
    let n = units.count
    var opens: [TagOpen] = []
    var spanFinder = GtFinder(units)
    var quoteGtFinder = GtFinder(units)

    var cachedSpanEnd = -1 // the span the cache below describes
    var bestHref = -1 // rightmost VIABLE `href="` in that span, or -1
    var bestQuote = -1 // its closing `"`
    var bestEnd = -1 // its match end (first `>` after that quote, +1)
    var hrefScanFrom = 0 // monotonic; belt-and-braces next to the `until` bound below

    var i = 0
    while i + 3 <= n {
        guard units[i] == ltUnit, asciiFold(units[i + 1]) == 0x61 /* a */,
              isJsWhitespace(units[i + 2]) else {
            i += 1
            continue
        }
        let start = i
        let tokenEnd = i + 3 // just past `<a` + the one whitespace unit
        let spanEnd = spanFinder.next(tokenEnd)
        if spanEnd < 0 { break } // no `>` after this candidate, nor after any later one

        if spanEnd != cachedSpanEnd {
            cachedSpanEnd = spanEnd
            bestHref = -1
            bestQuote = -1
            bestEnd = -1
            var p = max(hrefScanFrom, tokenEnd)
            while p + 6 <= spanEnd {
                // BOUNDED BY `spanEnd`. Without the bound this search runs forward past the span — to
                // the next `href="` anywhere in the document, or to the end — and the result is then
                // thrown away by the range test below, so the next href-less span re-walks the same
                // ground. That is quadratic on ORDINARY markup with no hostile input at all. An
                // occurrence at or past `spanEnd` can never be viable for this span, so there was never
                // a reason to look there.
                let at = indexOfAsciiCI(units, Literals.hrefOpen, from: p, until: spanEnd)
                if at < 0 { break }
                // `quote > at + 6` because `([^"]+)` needs at least ONE character: `href=""` does not
                // match, and the engine then keeps backtracking to an EARLIER occurrence rather than
                // giving up — so an empty value simply is not viable.
                let quote = indexOfUnit(units, quoteUnit, from: at + 6)
                if quote > at + 6 {
                    let gt = quoteGtFinder.next(quote + 1)
                    if gt >= 0 { // keep the RIGHTMOST viable
                        bestHref = at
                        bestQuote = quote
                        bestEnd = gt + 1
                    }
                }
                p = at + 1 // occurrences may overlap (`href="href="`), so advance by one
            }
            hrefScanFrom = spanEnd
        }

        if bestHref < tokenEnd || bestEnd < 0 {
            i = tokenEnd // `exec`'s `lastIndex` after a candidate that did not complete a match
            continue
        }
        opens.append(TagOpen(start: start, end: bestEnd, capture: text.slice(bestHref + 6, bestQuote)))
        if bestEnd >= n { break }
        i = bestEnd // the global regex's own jump past the match
    }
    return opens
}

/// `html.replace(/<li\b[^>]*>/gi, "\n- ")` as a monotonic forward scan — the SAME bug and the same fix
/// as `stripTags`, and measurably worse per byte than it on the daemon (54 s at 781 KB there).
///
/// Equivalence: `[^>]*` cannot cross a `>`, so the match at a given `<li` open ends at the FIRST `>` at
/// or after the open token. `copied` reproduces the global replace's own jump past each match (so a
/// `<li` nested inside an already-consumed match is not separately matched), and the early exit is what
/// makes the worst case cheap: if no `>` follows this open, none follows any later one either.
func replaceListItems(_ text: Utf16Text) -> String {
    let units = text.units
    let n = units.count
    var out = ""
    out.reserveCapacity(text.string.utf8.count)
    var copied = 0
    var gtPtr = 0 // monotonic — never rewinds across the whole scan
    var i = 0
    while i + 3 <= n {
        guard units[i] == ltUnit, asciiFold(units[i + 1]) == 0x6C /* l */,
              asciiFold(units[i + 2]) == 0x69 /* i */ else {
            i += 1
            continue
        }
        let tokenEnd = i + 3 // just past `<li`
        // `\b`: the preceding character is always `i`, a JS word character, so the boundary holds iff the
        // next character is a non-word one — or the string ends, where the original then fails for want
        // of a `>`, as does this scan.
        if tokenEnd < n, isJsWordUnit(units[tokenEnd]) {
            i += 1
            continue
        }
        if gtPtr < tokenEnd { gtPtr = tokenEnd }
        while gtPtr < n, units[gtPtr] != gtUnit { gtPtr += 1 }
        if gtPtr >= n { break } // no ">" after this open, nor after any later one
        out += text.slice(copied, i) + "\n- "
        copied = gtPtr + 1
        i = copied
    }
    out += text.slice(copied, n)
    return out
}

/// `html.match(/<TAG[^>]*>([\s\S]*?)<\/TAG>/i)?.[1]` — the first such element's inner text, or `nil` when
/// the regex would not have matched at all — as a BOUNDED forward scan.
///
/// Why only the FIRST `<TAG` occurrence needs looking at (this is where the daemon's O(n²) came from: the
/// regex is non-global, but a FAILING match still retries at every `<h1` position). For a candidate open
/// at `i`, `[^>]*` cannot cross a `>`, so the open tag's end is FORCED to the first `>` at or after
/// `i + 1 + tag.count` — the engine can never backtrack to a different one. And the first `>` after a
/// LATER candidate is at or after that same position, so if no `</TAG>` exists after the first
/// candidate's `>`, none exists after any later candidate's either. The first candidate decides the whole
/// match: no loop, no retry, no re-scan.
///
/// The two `indexOfAsciiCI` calls here deliberately keep the whole-document bound: they run once per
/// document, not once per candidate.
func firstElementInner(_ text: Utf16Text, _ tag: String) -> String? {
    let units = text.units
    let open = indexOfAsciiCI(units, Array("<\(tag)".utf16), from: 0, until: units.count)
    if open < 0 { return nil }
    let openEnd = indexOfUnit(units, gtUnit, from: open + tag.utf16.count + 1)
    if openEnd < 0 { return nil }
    let close = indexOfAsciiCI(units, Array("</\(tag)>".utf16), from: openEnd + 1, until: units.count)
    if close < 0 { return nil }
    return text.slice(openEnd + 1, close)
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

    let opens = scanHeadingOpens(text)
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
    let opens = scanAnchorOpens(text)
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
/// This WAS a disclosed PERFORMANCE-ONLY divergence from `web.ts`, which had the quadratic form
/// (measured 2.1 s on the same input under V8 — same O(n²), a ~17x smaller constant than ICU's, which is
/// why it bit the daemon less hard). It is no longer a divergence: Task 6b ported this function BACK to
/// `web.ts`, whose own `stripTags` doc comment now credits this one. Output is byte-identical: the 14
/// cleaner vectors and the 28,000-case differential against the live TS both pass unchanged.
///
/// The single early exit (`no '>' anywhere after here`) is what makes the worst case cheap: if no
/// `>` remains, no match can start at this position or any later one.
func stripTags(_ text: Utf16Text) -> String {
    let units = text.units
    var out = ""
    out.reserveCapacity(text.string.utf8.count)
    var copied = 0
    var i = 0
    var gtPtr = 0 // monotonic — never rewinds across the whole scan

    while i < units.count {
        guard units[i] == ltUnit else {
            i += 1
            continue
        }
        if gtPtr <= i { gtPtr = i + 1 }
        while gtPtr < units.count, units[gtPtr] != gtUnit { gtPtr += 1 }
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

    out = replaceListItems(Utf16Text(out)) // == .replace(/<li\b[^>]*>/gi, "\n- "), linear — see replaceListItems
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

/// TS `web.ts`'s `extractTitle` (h1, else `<title>`, run through the cleaner and collapsed to one line).
/// `"-"` when neither is present or both clean to nothing.
///
/// `??` and not `||` is deliberate and preserved from the TS: an h1 that matched but captured the EMPTY
/// string short-circuits to `"-"` rather than falling through to `<title>`, because `""` is not nullish
/// in JS and `""` is not `nil` here.
func extractTitle(_ html: String) -> String {
    let text = Utf16Text(html)
    guard let src = firstElementInner(text, "h1") ?? firstElementInner(text, "title") else { return "-" }
    let collapsed = collapseToOneLine(htmlToText(src))
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
    let opens = scanAnchorOpens(text)
    let closes = findLiteral(Literals.anchorClose, in: text.units)
        .map { TagClose(start: $0, end: $0 + Literals.anchorClose.count) }
    return (opens, closes)
}
