import Foundation

// MARK: - Release notes: HTML → blocks (2026-09-18)
//
// PURE. Nothing here imports AppKit, SwiftUI or Sparkle, and nothing here touches the text system:
// `parseReleaseNotesHTML` is a function from a string to an array of values, so every case below is
// a table test away from being pinned. `UpdatesPanel` renders these blocks in Winter's own type.
//
// WHY NOT `NSAttributedString(html:)`. It was the previous pass's answer and it was the wrong one
// twice over. It drags the authored document's own fonts and colours into a themed, dark-mode-aware
// panel — Times New Roman on black — and `TypographyTests` bans a font constructed anywhere outside
// the two token files, which an imported HTML document does by definition. It is also `@MainActor`
// and impure, so none of it could be pinned. The previous pass reacted by FLATTENING the parse to
// `attributed.string`, which was defensible while the feed's `<description>` was a single plain
// line — and is wrong now that it carries headings, lists and code fences.
//
// THE CONTRACT THIS PARSES (measured against every `<description>` `scripts/release-lib.ts`'s
// `appcastDescription`/`releaseNotesHtml` has ever produced, all ten shipped releases):
//
// - the first element is always `<p>Winter agent SDK x · Claude Agent SDK y</p>`, verbatim and
//   first — metadata, rendered as the quiet subtitle rather than as body copy;
// - then the notes: `p`, `h2`, `ul`/`li`, `pre`/`code`, inline `code`, `strong` (`h1`/`h3` are
//   supported by the generator and unused so far; handled anyway);
// - entities are exactly `&amp;`, `&lt;`, `&gt;` — the wider set below is cheap insurance against a
//   generator change, not a case anything emits today;
// - NO attributes on any tag, ever (the code fence's info string is validated and dropped);
// - `pre` only ever appears as `<pre><code>…</code></pre>`, its content escaped text with real
//   newlines; a `<ul>` contains only `<li>`; an `<li>` carries text plus `code`/`strong`;
// - nested lists, tables, links, images, blockquotes, rules and ordered lists CANNOT occur —
//   `releaseNotesHtml` throws on each and the release preflight fails before the build.
//
// Which is why there is no nesting depth on `bullet` and no attribute model. What there IS, because
// this parses bytes off a network feed rather than a function call: total tolerance. Anything
// outside the contract — an unknown tag, an unclosed one, a stray `<` — degrades to its text
// content. Raw markup must never reach the screen, and a malformed byte must never lose the notes.
//
// And the OLD feed still has to work: every item live today (0.111.0 – 0.114.4) carries a single
// TAGLESS line, which is the path that renders for every update a user can actually be offered.
// That must come out as one ordinary paragraph, unchanged in feel.

/// One inline run inside a block — text plus the two marks the contract can put on it.
///
/// A struct rather than an enum because the marks COMPOSE: `<strong><code>x</code></strong>` is one
/// run that is both, and an enum of styles would have to spell the product.
struct ReleaseNotesRun: Equatable {
    var text: String
    var isStrong: Bool
    var isCode: Bool

    init(_ text: String, strong: Bool = false, code: Bool = false) {
        self.text = text
        self.isStrong = strong
        self.isCode = code
    }
}

/// A block of rendered notes. The renderer switches on exactly this and nothing else.
enum ReleaseNotesBlock: Equatable {
    /// The leading SDK version line — metadata, set quiet. Promoted from the first paragraph only
    /// when it came from a real `<p>` AND something follows it (see `parseReleaseNotesHTML`).
    case subtitle([ReleaseNotesRun])
    /// `h1`…`h6`, clamped to 1…6. The renderer maps the level onto the type ladder.
    case heading(level: Int, runs: [ReleaseNotesRun])
    case paragraph([ReleaseNotesRun])
    /// One `<li>`. Flat by contract — nested lists cannot reach the feed.
    case bullet([ReleaseNotesRun])
    /// A `<pre><code>` fence, already entity-decoded, newlines intact.
    case code(String)
}

/// PURE: the one entry point the panel calls. Plain-text notes bypass the parser entirely and
/// become a single paragraph, which is also what a tagless HTML body produces — Sparkle's default
/// format is HTML, so today's one-liners arrive flagged as HTML and must not read as markup.
func releaseNotesBlocks(_ notes: ReleaseNotes) -> [ReleaseNotesBlock] {
    guard notes.isHTML else {
        let text = notes.body.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? [] : [.paragraph([ReleaseNotesRun(text)])]
    }
    return parseReleaseNotesHTML(notes.body)
}

// MARK: - The parser

/// PURE: the HTML of an appcast `<description>` → the blocks that render it.
///
/// One left-to-right pass, no lookahead beyond the tag currently being read, no recursion and no
/// regular expressions. Unknown elements are transparent: their tags are dropped and their text
/// flows into whatever block is open, so a widened generator degrades rather than breaks.
func parseReleaseNotesHTML(_ html: String) -> [ReleaseNotesBlock] {
    var state = ReleaseNotesParseState()
    for token in releaseNotesTokens(html) {
        state.consume(token)
    }
    state.flush()
    return state.finished()
}

/// What the tokenizer hands the state machine. Comments and doctypes never become tokens at all.
enum ReleaseNotesToken: Equatable {
    case text(String)
    case start(String)
    case end(String)
}

/// PURE: HTML → tokens. Exposed (not private) so the tokenizer's own degradations — a bare `<`, an
/// unterminated tag — can be pinned directly rather than only through their rendered consequence.
func releaseNotesTokens(_ html: String) -> [ReleaseNotesToken] {
    let chars = Array(html)
    var tokens: [ReleaseNotesToken] = []
    var text = ""
    var i = 0

    func flushText() {
        if !text.isEmpty { tokens.append(.text(text)); text = "" }
    }

    while i < chars.count {
        guard chars[i] == "<" else {
            text.append(chars[i])
            i += 1
            continue
        }
        // `<!-- … -->` and `<!doctype …>`: structural noise, never content.
        if chars.count - i >= 4, chars[i + 1] == "!", chars[i + 2] == "-", chars[i + 3] == "-" {
            if let close = releaseNotesIndex(of: "-->", in: chars, from: i + 4) {
                flushText()
                i = close + 3
                continue
            }
            // Unterminated comment: everything after it is comment. Nothing sane follows.
            flushText()
            break
        }
        if i + 1 < chars.count, chars[i + 1] == "!" || chars[i + 1] == "?" {
            if let close = releaseNotesIndex(of: ">", in: chars, from: i + 1) {
                flushText()
                i = close + 1
                continue
            }
            text.append(chars[i]); i += 1; continue
        }

        var j = i + 1
        var isEnd = false
        if j < chars.count, chars[j] == "/" { isEnd = true; j += 1 }
        var name = ""
        // A tag name STARTS with a letter — HTML's own rule, and load-bearing here: without it
        // `3 <4` reads as an element named `4` whose attribute skip then runs to the next `>`
        // anywhere in the document, swallowing the rest of the paragraph. (Measured: `a < b and
        // 3 <4</p>` lost everything from `<4` onward.)
        if j < chars.count, chars[j].isLetter {
            while j < chars.count, chars[j].isLetter || chars[j].isNumber {
                name.append(chars[j]); j += 1
            }
        }
        // A `<` that does not begin a tag is just a `<`. Real in prose ("a < b", "3 <4") and the
        // one way a stray angle bracket could otherwise eat the rest of the notes.
        guard !name.isEmpty else { text.append(chars[i]); i += 1; continue }
        // Attributes cannot occur in this feed, but a tolerant skip costs three lines and means a
        // widened generator degrades to "tag understood, attributes ignored" rather than to prose
        // with `class="language-sh"` printed in it. Quoted values may contain `>`.
        var quote: Character?
        while j < chars.count {
            let c = chars[j]
            if let q = quote {
                if c == q { quote = nil }
            } else if c == "\"" || c == "'" {
                quote = c
            } else if c == ">" {
                break
            }
            j += 1
        }
        guard j < chars.count, chars[j] == ">" else {
            // A well-formed tag NAME with no closing `>` left in the buffer: the description was
            // truncated mid-tag. Dropping the remainder is the only degradation that honours "raw
            // markup never reaches the screen" — echoing the bytes would print `<p` as prose.
            // (A bare `<` in prose never lands here: it fails the name check above.)
            flushText()
            break
        }
        flushText()
        tokens.append(isEnd ? .end(name.lowercased()) : .start(name.lowercased()))
        i = j + 1
    }
    flushText()
    return tokens
}

/// The block currently being accumulated.
private enum ReleaseNotesPending: Equatable {
    /// `explicit` distinguishes a real `<p>` from a paragraph opened implicitly by loose text —
    /// the whole basis of the subtitle promotion, and of a tagless one-liner staying body copy.
    case paragraph(explicit: Bool)
    case heading(level: Int)
    case bullet
}

private struct ReleaseNotesParseState {
    private var blocks: [ReleaseNotesBlock] = []
    private var runs: [ReleaseNotesRun] = []
    private var pending: ReleaseNotesPending?
    private var strongDepth = 0
    private var codeDepth = 0
    private var listDepth = 0
    private var inPre = false
    private var preText = ""
    /// Whether the FIRST block emitted came from a real `<p>`. Recorded at emit time because the
    /// promotion decision needs to know what follows, which is only known at the end.
    private var firstBlockWasExplicitParagraph = false

    mutating func consume(_ token: ReleaseNotesToken) {
        if inPre { consumeInsidePre(token); return }
        switch token {
        case .text(let raw):
            append(text: raw)
        case .start(let name):
            start(name)
        case .end(let name):
            end(name)
        }
    }

    // MARK: Inside a fence

    /// A `<pre>` swallows everything until its close: no whitespace collapse, no inline styling, and
    /// the `<code>` the generator always nests inside it is transparent. A tag that is neither is
    /// dropped rather than printed — a fence shows code, never markup.
    private mutating func consumeInsidePre(_ token: ReleaseNotesToken) {
        switch token {
        case .text(let raw):
            preText += decodeReleaseNotesEntities(raw)
        case .start("br"):
            preText += "\n"
        case .end("pre"):
            inPre = false
            let trimmed = preText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { emit(.code(trimmed)) }
            preText = ""
        case .start, .end:
            break
        }
    }

    // MARK: Tags

    private mutating func start(_ name: String) {
        switch name {
        case "pre":
            flush()
            inPre = true
            preText = ""
        case "h1", "h2", "h3", "h4", "h5", "h6":
            flush()
            pending = .heading(level: Int(String(name.dropFirst())) ?? 2)
        case "p":
            // A `<p>` inside a list item is a LOOSE list — markdown emits it whenever items are
            // blank-line separated. Breaking the bullet into a paragraph there would shred every
            // list, so the item stays open and the paragraph becomes a soft break inside it.
            if listDepth > 0, pending == .bullet {
                if !runs.isEmpty { softBreak() }
                return
            }
            flush()
            pending = .paragraph(explicit: true)
        case "ul", "ol":
            flush()
            listDepth += 1
        case "li":
            flush()
            pending = .bullet
        case "strong", "b":
            strongDepth += 1
        case "code", "tt", "kbd", "samp":
            codeDepth += 1
        case "br":
            softBreak()
        case "hr":
            flush()
        default:
            // Transparent: the element vanishes, its text does not.
            break
        }
    }

    private mutating func end(_ name: String) {
        switch name {
        case "p":
            if listDepth > 0, pending == .bullet { return }
            flush()
        case "h1", "h2", "h3", "h4", "h5", "h6", "li":
            flush()
        case "ul", "ol":
            flush()
            listDepth = max(0, listDepth - 1)
        case "strong", "b":
            strongDepth = max(0, strongDepth - 1)
        case "code", "tt", "kbd", "samp":
            codeDepth = max(0, codeDepth - 1)
        case "pre":
            // `</pre>` with no `<pre>`: nothing to close.
            break
        default:
            break
        }
    }

    // MARK: Text

    private mutating func append(text raw: String) {
        // Collapse BEFORE decoding, and only ASCII whitespace: `&nbsp;` is U+00A0, which
        // `CharacterSet.whitespaces` contains — decode-then-collapse would quietly turn every
        // non-breaking space into an ordinary one. Order and character class both matter.
        let collapsed = collapseReleaseNotesWhitespace(raw)
        guard !collapsed.isEmpty else { return }
        let decoded = decodeReleaseNotesEntities(collapsed)
        // Loose text outside any element opens an IMPLICIT paragraph — which is the whole tagless
        // one-liner path. Implicit, so it is never promoted to the subtitle.
        if pending == nil {
            guard !decoded.trimmingCharacters(in: .whitespaces).isEmpty else { return }
            pending = .paragraph(explicit: false)
        }
        runs.append(ReleaseNotesRun(decoded, strong: strongDepth > 0, code: codeDepth > 0))
    }

    /// A `<br>`, or the seam between two paragraphs of a loose list item.
    private mutating func softBreak() {
        guard pending != nil, !runs.isEmpty else { return }
        runs[runs.count - 1].text += "\n"
    }

    // MARK: Block boundaries

    mutating func flush() {
        defer {
            runs = []
            pending = nil
            // An unclosed `<strong>`/`<code>` dies at its block rather than bleeding into the next
            // one — the containing degradation for the commonest malformation there is.
            strongDepth = 0
            codeDepth = 0
        }
        guard let pending else { return }
        let normalized = normalizeReleaseNotesRuns(runs)
        guard !normalized.isEmpty else { return }
        switch pending {
        case .paragraph(let explicit):
            if blocks.isEmpty { firstBlockWasExplicitParagraph = explicit }
            emit(.paragraph(normalized))
        case .heading(let level):
            emit(.heading(level: min(max(level, 1), 6), runs: normalized))
        case .bullet:
            emit(.bullet(normalized))
        }
    }

    private mutating func emit(_ block: ReleaseNotesBlock) {
        blocks.append(block)
    }

    func finished() -> [ReleaseNotesBlock] {
        // The subtitle promotion, deliberately conservative on BOTH sides. It needs a real `<p>`,
        // so a tagless one-liner stays body copy; and it needs something to be a subtitle TO, so a
        // description that is nothing but one `<p>` reads as notes rather than as quiet metadata.
        guard blocks.count >= 2, firstBlockWasExplicitParagraph,
              case .paragraph(let runs) = blocks[0]
        else { return blocks }
        var promoted = blocks
        promoted[0] = .subtitle(runs)
        return promoted
    }
}

// MARK: - Run normalization

/// PURE: merge adjacent runs that carry the same marks, trim the block's outer edges, drop empties.
///
/// Merging is not cosmetic. An ignored `<a>` or a decoded entity splits what is visually one phrase
/// into three identically-styled runs, which makes `[ReleaseNotesRun]` equality in a test depend on
/// tokenizer internals rather than on rendered meaning — and makes the renderer concatenate three
/// `Text`s where one would do.
func normalizeReleaseNotesRuns(_ runs: [ReleaseNotesRun]) -> [ReleaseNotesRun] {
    var merged: [ReleaseNotesRun] = []
    for run in runs where !run.text.isEmpty {
        if var last = merged.last, last.isStrong == run.isStrong, last.isCode == run.isCode {
            last.text += run.text
            merged[merged.count - 1] = last
        } else {
            merged.append(run)
        }
    }
    // Trim the BLOCK's edges, never each run: `Faster <strong>everything</strong>.` must keep the
    // space after "Faster".
    while let first = merged.first {
        let trimmed = String(first.text.drop(while: { $0 == " " || $0 == "\n" }))
        if trimmed.isEmpty { merged.removeFirst() } else { merged[0].text = trimmed; break }
    }
    while let last = merged.last {
        var text = last.text
        while let c = text.last, c == " " || c == "\n" { text.removeLast() }
        if text.isEmpty { merged.removeLast() } else { merged[merged.count - 1].text = text; break }
    }
    return merged
}

// MARK: - Whitespace and entities

/// PURE: every run of ASCII whitespace becomes one space.
///
/// ASCII only, on purpose: U+00A0 (`&nbsp;`) must survive, and it is a member of
/// `CharacterSet.whitespaces`. Runs on the RAW text so that indentation and the newlines between
/// generated blocks — both purely cosmetic in this feed — never reach a run.
func collapseReleaseNotesWhitespace(_ text: String) -> String {
    var out = ""
    var pendingSpace = false
    for c in text {
        if c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{0B}" || c == "\u{0C}" {
            // A LEADING run collapses to a space too, rather than vanishing: the space between
            // `</code>` and the next word lives in the following text node's leading whitespace,
            // and dropping it would weld the two together. The block's outer edges are trimmed
            // once, at the end, by `normalizeReleaseNotesRuns`.
            pendingSpace = true
            continue
        }
        if pendingSpace { out.append(" "); pendingSpace = false }
        out.append(c)
    }
    if pendingSpace { out.append(" ") }
    return out
}

/// PURE: decode HTML entities in ONE left-to-right pass.
///
/// One pass is the whole correctness story: `&amp;lt;` is the text `&lt;`, not `<`. Re-scanning the
/// output — the obvious implementation, and the wrong one — would decode it twice and silently turn
/// an escaped example into live markup. An unrecognised entity is left exactly as written, because
/// showing `&foo;` is honest and dropping it is not.
func decodeReleaseNotesEntities(_ text: String) -> String {
    guard text.contains("&") else { return text }
    let chars = Array(text)
    var out = ""
    var i = 0
    while i < chars.count {
        guard chars[i] == "&" else { out.append(chars[i]); i += 1; continue }
        // A name or numeric reference is short; the cap keeps a lone `&` in prose from scanning to
        // the end of a 3800-character description looking for a `;`.
        var j = i + 1
        var body = ""
        while j < chars.count, j - i <= 10, chars[j] != ";" {
            body.append(chars[j]); j += 1
        }
        guard j < chars.count, chars[j] == ";", !body.isEmpty,
              let decoded = releaseNotesEntityValue(body)
        else { out.append(chars[i]); i += 1; continue }
        out += decoded
        i = j + 1
    }
    return out
}

/// PURE: the body of an entity (between `&` and `;`) → its text, or nil when it is not one.
private func releaseNotesEntityValue(_ body: String) -> String? {
    if body.hasPrefix("#") {
        let digits = body.dropFirst()
        let scalar: UInt32?
        if digits.hasPrefix("x") || digits.hasPrefix("X") {
            scalar = UInt32(digits.dropFirst(), radix: 16)
        } else {
            scalar = UInt32(digits, radix: 10)
        }
        guard let scalar, let unicode = Unicode.Scalar(scalar) else { return nil }
        return String(Character(unicode))
    }
    // The generator emits exactly the first three. The rest are insurance, not a shipped case.
    switch body.lowercased() {
    case "amp": return "&"
    case "lt": return "<"
    case "gt": return ">"
    case "quot": return "\""
    case "apos": return "'"
    case "nbsp": return "\u{00A0}"
    default: return nil
    }
}

/// PURE: index of `needle` in `haystack` at or after `from`, or nil.
private func releaseNotesIndex(of needle: String, in haystack: [Character], from: Int) -> Int? {
    let pattern = Array(needle)
    guard !pattern.isEmpty, haystack.count >= pattern.count else { return nil }
    var i = max(0, from)
    while i + pattern.count <= haystack.count {
        var k = 0
        while k < pattern.count, haystack[i + k] == pattern[k] { k += 1 }
        if k == pattern.count { return i }
        i += 1
    }
    return nil
}
