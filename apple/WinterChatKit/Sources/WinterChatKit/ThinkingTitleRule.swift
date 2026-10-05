import Foundation

/// ── THE THINKING PILL'S TITLE RULE, PHONE ENGINE (2026-10-05, user ruling) ─────────────────────
///
/// The faithful Swift port of the daemon's `packages/core/src/projector/thinking-title.ts`: the
/// provider's own BOLD HEADING first, else an ACTIVITY title inferred from the prose by fixed rules
/// (no model call), else none. Both engines must title a block identically; the tests run the
/// daemon's own fixture (`packages/core/test/projector/fixtures/thinking-titles.json`). Change both
/// together.
///
/// ENGINE-INDEPENDENT BY CONSTRUCTION (review r1): everything works on UTF-16 units; every text a rule
/// reads is CLEANED first (`cleanText`: JS whitespace + NEL → one space, control/zero-width/bidi
/// units dropped, ‘’ → '); matching runs on an ASCII-only lower-cased copy with NO case-insensitive
/// option, a literal space instead of `\s`, `[^\n\r\u{2028}\u{2029}]` instead of `.` and `\z` instead
/// of `$` — so ICU and V8 cannot disagree. No pattern nests or abuts unbounded quantifiers
/// (`RegexShapeTripwireTests` audits every one at run time; the tests fuzz them on a time budget).

// MARK: - text helpers (UTF-16, engine-independent)

/// Whitespace for every rule here: JS `\s` (incl. line terminators and U+FEFF) plus NEL (U+0085).
@inline(__always) func isSpaceUnit(_ u: UInt16) -> Bool {
    switch u {
    case 0x09...0x0D, 0x20, 0x85, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}

/// Units no title may carry: C0/C1 controls, DEL, zero-width and bidi controls.
@inline(__always) func isDroppedUnit(_ u: UInt16) -> Bool {
    u <= 0x1F || (0x7F...0x9F).contains(u) || (0x200B...0x200F).contains(u) || (0x202A...0x202E).contains(u)
        || (0x2060...0x2064).contains(u) || (0x2066...0x2069).contains(u) || u == 0x061C
}

/// `cleanText`: whitespace runs → one space (trimmed), controls/zero-width/bidi dropped, ‘’ → '.
func cleanText(_ s: String) -> String {
    var out: [UInt16] = []
    out.reserveCapacity(s.utf16.count)
    var space = false
    for u in s.utf16 {
        if isSpaceUnit(u) { space = !out.isEmpty; continue }
        if isDroppedUnit(u) { continue }
        if space { out.append(0x20); space = false }
        out.append(u == 0x2018 || u == 0x2019 ? 0x27 : u)
    }
    return String(decoding: out, as: UTF16.self)
}

/// A–Z → a–z, nothing else (same length: positions map back to the original).
func asciiLower(_ s: String) -> String {
    String(decoding: s.utf16.map { (0x41...0x5A).contains($0) ? $0 + 0x20 : $0 }, as: UTF16.self)
}

/// Han, kana and Hangul: a run of them is words without spaces.
@inline(__always) func isCjkScalar(_ v: UInt32) -> Bool {
    (0x3040...0x30FF).contains(v) || (0x3400...0x4DBF).contains(v) || (0x4E00...0x9FFF).contains(v)
        || (0xF900...0xFAFF).contains(v) || (0xAC00...0xD7AF).contains(v) || (0x20000...0x2FFFF).contains(v)
}

/// Non-overlapping occurrences, left to right (`s.split(sub).length - 1`).
func countOccurrences(_ s: String, _ sub: String) -> Int {
    let h = Array(s.utf16), n = Array(sub.utf16)
    guard !n.isEmpty, h.count >= n.count else { return 0 }
    var count = 0, i = 0
    outer: while i + n.count <= h.count {
        for k in 0..<n.count where h[i + k] != n[k] { i += 1; continue outer }
        count += 1
        i += n.count
    }
    return count
}

/// A compiled pattern with JS-like helpers (NSRegularExpression works in UTF-16 units, like JS).
/// FILEPRIVATE: every pattern of this file is built here, so `RegexShapeTripwireTests` can tie its
/// runtime audit to this file's construction sites.
fileprivate struct JSRegex {
    let re: NSRegularExpression
    init(_ pattern: String) {
        // swiftlint:disable:next force_try
        re = try! NSRegularExpression(pattern: pattern, options: [])
    }
    func test(_ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }
    /// The first match's groups (`nil` for a group that did not take part), or `nil`.
    func exec(_ s: String) -> [String?]? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
    }
    /// Every match: its start (UTF-16) and length.
    func matches(_ s: String) -> [NSRange] {
        re.matches(in: s, range: NSRange(location: 0, length: (s as NSString).length)).map(\.range)
    }
}

// MARK: - 1. the provider's bold heading

/// A title and where it starts in its part (UTF-16 offset).
struct Placed: Equatable { let title: String; let pos: Int }

/// What a part's headings say about its title (`HeadingFacts` in the daemon).
struct HeadingFacts {
    var latest: Placed?
    var opening: Placed?
    var protectEnd: Int?
    var lines: [Int] = []
}

/// `decideTitle`: a `summary` part that OPENS with a heading is provider-written (OpenAI, Gemini) and
/// keeps its latest heading; otherwise (any `exposed` part, a raw-looking `summary`) an activity title
/// beats every heading, except an opening heading over the rule titles of its own body; with no
/// activity title, the latest heading.
func decideTitle(kind: String, _ h: HeadingFacts, _ rule: Placed?) -> String? {
    if kind == "summary", h.opening != nil { return h.latest?.title ?? rule?.title }
    if let rule {
        guard let opening = h.opening else { return rule.title }
        if let end = h.protectEnd, rule.pos >= end { return rule.title }
        return opening.title
    }
    return h.latest?.title
}

enum ThinkingHeading {
    private static let lineBreaks: Set<UInt16> = [0x0A, 0x0D, 0x2028, 0x2029]
    private static let star: UInt16 = 0x2A
    fileprivate static let fileToken = JSRegex(#"[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]{0,4}(?![A-Za-z0-9])"#)
    fileprivate static let singleToken = JSRegex(#"^[A-Za-z0-9_./-]+\z"#)
    static let maxWords = 10

    /// `isTitleHeading`: not a label (`…:`), at most 10 words, not ONE code span, and not ONLY a path
    /// or file token.
    static func isTitle(_ inner: String) -> Bool {
        if inner.isEmpty || inner.hasSuffix(":") { return false }
        if inner.components(separatedBy: " ").count > maxWords { return false }
        let u = Array(inner.utf16)
        if u.count >= 3, u.first == 0x60, u.last == 0x60, !u[1..<(u.count - 1)].contains(0x60) { return false }   // `^`[^`]+`$`
        let bare = inner.replacingOccurrences(of: "`", with: "")
        if singleToken.test(bare) && (bare.contains("/") || fileToken.test(bare)) { return false }
        return true
    }

    /// `scanHeadings`: the headings of `text` — the last valid one, the part's OPENING heading (its first
    /// non-blank line, a valid heading), where that heading's body ends (the next heading-shaped line)
    /// and every heading-shaped line's offset. A line counts once a line break has CLOSED it, or with
    /// `final` at the end of the text too. `base` is added to every offset.
    static func scan(_ text: String, final: Bool, base: Int = 0) -> HeadingFacts {
        var facts = HeadingFacts()
        let units = Array(text.utf16)
        var firstContent = 0
        while firstContent < units.count, isSpaceUnit(units[firstContent]) { firstContent += 1 }
        var firstLineStart = 0
        if firstContent > 0 {
            var k = firstContent - 1
            while k >= 0 { if units[k] == 0x0A { firstLineStart = k + 1; break }; k -= 1 }
        }
        var lineStart = 0
        var i = 0
        while i <= units.count {
            if i == units.count || lineBreaks.contains(units[i]) {
                if let inner = headingInner(units[lineStart..<i]), final || i < units.count {
                    facts.lines.append(base + lineStart)
                    if facts.opening != nil && facts.protectEnd == nil { facts.protectEnd = base + lineStart }
                    let cleaned = cleanText(String(decoding: inner, as: UTF16.self))
                    if isTitle(cleaned) {
                        let placed = Placed(title: ThinkingTitle.clip(cleaned), pos: base + lineStart)
                        facts.latest = placed
                        if lineStart == firstLineStart && lineStart <= firstContent { facts.opening = placed }
                    }
                }
                lineStart = i + 1
            }
            i += 1
        }
        return facts
    }

    /// `lastValidHeading(text, includeOpenLine)`.
    static func lastValid(_ text: String, includeOpenLine: Bool = true) -> String? {
        scan(text, final: includeOpenLine).latest?.title
    }

    private static func headingInner(_ line: ArraySlice<UInt16>) -> ArraySlice<UInt16>? {
        var p = line.startIndex
        while p < line.endIndex, line[p] == 0x20 || line[p] == 0x09 { p += 1 }
        guard p + 1 < line.endIndex, line[p] == star, line[p + 1] == star else { return nil }
        let innerStart = p + 2
        var q = innerStart + 1
        while q + 1 < line.endIndex {
            if line[q] == star, line[q + 1] == star {
                var r = q + 2
                while r < line.endIndex, line[r] == 0x20 || line[r] == 0x09 { r += 1 }
                return r == line.endIndex ? line[innerStart..<q] : nil
            }
            q += 1
        }
        return nil
    }
}

// MARK: - 2. the activity rule

enum ActivityTitleRule {
    static let segmentMax = 600
    static let candidateMax = 220
    static let titleMaxWords = 9
    static let cjkCharsPerWord = 4
    static let maxClauses = 8
    static let segmentHead = 16

    private static func words(_ lists: String...) -> Set<String> {
        Set(lists.joined(separator: " ").split(separator: " ").map(String.init))
    }
    private static func alt(_ list: String) -> String { list.split(separator: " ").joined(separator: "|") }

    private static let leadWords = "now first firstly also quickly carefully actually just then next still again briefly finally lastly so ok okay alright right and but well anyway instead meanwhile second secondly third thirdly further simply really properly directly thoroughly wait hmm ah oh great good perfect fine sure yes yeah"
    private static let midWords = "now first also quickly carefully actually just then next still again briefly finally properly really simply directly thoroughly systematically further explicitly manually separately immediately quick"
    private static let lead = "^(?:(?:" + alt(leadWords) + ")(?![a-z'])(?: ?,)? )*"
    private static let mid = "(?:(?:" + alt(midWords) + ")(?![a-z']) )*"
    private static let modal = [
        "let me", "let's", "let us",
        "i'll need to", "i will need to", "i'll have to", "i will have to", "i'll", "i will",
        "i'd like to", "i would like to", "i want to", "i need to", "i should", "i must", "i have to",
        "i'm going to", "i am going to", "i'm about to", "i am about to", "i'm ready to", "i am ready to",
        "i'm planning to", "i am planning to", "i plan to",
        "we need to", "we should", "we'll", "we will",
        "it's time to", "time to",
    ].joined(separator: "|")
    private static let end = #"(?=[ ,.:;!?，。；：！？]|\z)"#
    /// JS `(.*)$` over line-free text.
    private static let rest = #"([^\n\r  ]*)\z"#
    private static let pastSteps = "checked double-checked counted ran reviewed examined inspected verified tested searched scanned explored gathered analyzed analysed compared traced read opened grepped listed located measured reran re-ran"

    fileprivate static let pStartBy = JSRegex(lead + "(?:" + modal + ") " + mid + "(?:start|begin) (?:off )?by ([a-z]+ing)" + end + rest)
    fileprivate static let pModal = JSRegex(lead + "(?:" + modal + ") " + mid + "([a-z][a-z-]*)" + end + rest)
    fileprivate static let pIm = JSRegex(lead + "i(?:'m| am) " + mid + "([a-z]+ing)" + end + rest)
    fileprivate static let pFound = JSRegex(lead + "(?:i(?:'ve| have) (?:(?:just|now|also|already) )*)?(found|confirmed|identified|spotted)" + end + rest)
    fileprivate static let pPast = JSRegex(lead + "i(?:'ve| have)? (?:(?:just|now|also|already|quickly|carefully|first) )*(" + alt(pastSteps) + ")" + end + rest)
    fileprivate static let pGerund = JSRegex(lead + "([a-z]+ing)" + end + rest)

    fileprivate static let goAnd = JSRegex("^ (?:(?:ahead|through|back|on) )?and ([a-z][a-z-]*)" + end + rest)
    fileprivate static let doubleCheck = JSRegex(#"^[ \-]check"# + end + rest)
    fileprivate static let toVerb = JSRegex("^ to ([a-z][a-z-]*)" + end + rest)
    fileprivate static let byGerund = JSRegex("^ by ([a-z]+ing)" + end + rest)

    private static let stopVerbs = words("not never be been being have has had also probably maybe likely definitely certainly so the a an it this that there here just")
    private static let notGerunds = words(
        "interesting existing missing remaining following corresponding surprising confusing amazing nothing something everything anything",
        "string strings during thing things king ring bring spring sing wing swing sting morning evening ceiling according including regarding",
        "concerning pending outstanding upcoming ongoing trailing leading underlying misleading promising boring willing ending being")
    private static let generic = words(
        "thinking analyzing analysing continuing proceeding starting working beginning going trying doing getting having looking seeing",
        "considering reconsidering reflecting pondering reasoning focusing moving waiting wondering deciding finishing finalizing")
    private static let metaVerbs = words("writing giving presenting keeping answering providing composing responding replying formatting wrapping finalizing drafting putting outputting delivering sharing stating summarizing framing phrasing structuring crafting preparing leaving")
    private static let metaObjects = words(
        "answer answers response reply final concise concisely clear clearly tight short brief briefly bullet bullets sentence sentences",
        "prose summary report up it them this that output findings together list user message words paragraph paragraphs format plan",
        "recommendation conclusion verdict")
    private static let pronounish = words(
        "it them this that these those things everything something anything more all both stuff again now here there further",
        "at into over through on for with about to up out in a an the bit little closer deeper look one")
    private static let finite = words(
        "is are was were will would can could should may might must does did has had isn't aren't wasn't weren't doesn't don't didn't",
        "won't wouldn't can't cannot couldn't shouldn't hasn't haven't works returns increases decreases means uses throws yields produces",
        "requires seems appears becomes breaks fails gives makes causes prevents ensures depends")
    private static let subordinators = words("whether if that what which how why where when who whose to for because so since while as than until unless before after though although")
    private static let trailingAdverbs = words("now next first then again too also here directly quickly briefly carefully")
    private static let trailingDangling = words("the a an and or of to for with in on at by as from etc")
    private static let trailingPunctuation: Set<UInt16> = Set("．.,;:!?…。，；：！？、".utf16)

    private static let purposes = "identify see understand find confirm check figure determine get make know verify ensure learn decide catch spot locate gather compare validate inspect review map trace reproduce isolate avoid prevent count orient answer"
    private static let nextVerbs = "check read run look lay write fix add verify confirm try give review examine inspect identify count find explore compare make keep summarize glance outline produce present provide propose suggest finalize mention explain describe grep focus dig figure determine think consider decide proceed continue begin maybe possibly am i"
    private static let cutWords = (
        ["to (?:" + alt(purposes) + ")(?![a-z])"]
        + ["in order to", "so that", "so", "because", "before", "after", "which", "since", "then", "and then", "and also", "while", "whereas", "though", "although", "but", "or if", "or whether"].map { $0 + "(?![a-z])" }
        + ["and (?:" + alt(nextVerbs) + ")(?![a-z])",
           "by [a-z]+ing(?![a-z])",
           "that (?:might|could|would|may|will|can|should|is|are|was|were)(?![a-z])"]
    ).joined(separator: "|")
    fileprivate static let cut = JSRegex(" (?:" + cutWords + #")| \(| (?:-{1,3}|–) |—|[,;:!?，；：！？、]"#)
    fileprivate static let clause = JSRegex(", (?=(?:so|and|then|but|now|next|i'll|i will|i'm|i am|i need|i should|i want|let me|let's)(?![a-z]))|; | ?— ?| – | -- |: ")
    fileprivate static let structureLine = JSRegex(#"^(?:[-*+•] |[0-9]{1,3}[.)](?: |\z)|#{1,6}(?: |\z)|\||>)"#)
    fileprivate static let fenceLine = JSRegex(#"^(?:```|~~~)"#)

    // MARK: gerunds

    private static let irregularGerunds: [String: String] = [
        "be": "being", "see": "seeing", "flee": "fleeing", "free": "freeing", "agree": "agreeing", "lie": "lying", "die": "dying", "tie": "tying",
        "dye": "dyeing", "eye": "eyeing", "hoe": "hoeing", "toe": "toeing", "shoe": "shoeing", "ski": "skiing", "singe": "singeing",
        "panic": "panicking", "mimic": "mimicking", "picnic": "picnicking", "traffic": "trafficking", "quit": "quitting", "quiz": "quizzing",
    ]
    private static let doubledMulti = words("begin commit submit admit omit permit refer prefer occur debug rerun forget control regret recur compel expel propel equip deter incur infer confer defer patrol unwrap unzip upset overlap reset recap remap rewrap outrun rebut transmit emit acquit")
    private static let neverDoubled = words("visit edit open listen limit target exit audit filter render answer consider develop order offer enter gather cover deliver remember happen travel cancel label model level")
    private static let vowels: Set<Character> = ["a", "e", "i", "o", "u"]

    private static func vowelGroups(_ v: String) -> Int {
        var groups = 0
        var inGroup = false
        for ch in v {
            let isVowel = vowels.contains(ch)
            if isVowel && !inGroup { groups += 1 }
            inGroup = isVowel
        }
        return groups
    }

    private static func doublesFinal(_ v: String) -> Bool {
        if neverDoubled.contains(v) { return false }
        if doubledMulti.contains(v) { return true }
        let chars = Array(v)
        guard chars.count >= 3, vowelGroups(v) == 1 else { return false }
        let a = chars[chars.count - 3], b = chars[chars.count - 2], c = chars[chars.count - 1]
        return !vowels.contains(a) && vowels.contains(b) && !vowels.contains(c) && !"wxy".contains(c)
    }

    /// `gerundOf`: the -ing form of a base verb, lower case.
    static func gerund(_ verb: String) -> String {
        let v = asciiLower(verb)
        if let hyphen = v.lastIndex(of: "-"), hyphen != v.startIndex, v.index(after: hyphen) != v.endIndex {
            return String(v[...hyphen]) + gerund(String(v[v.index(after: hyphen)...]))
        }
        if let irregular = irregularGerunds[v] { return irregular }
        if v.hasSuffix("ie") { return String(v.dropLast(2)) + "ying" }
        if v.hasSuffix("ee") || v.hasSuffix("ye") || v.hasSuffix("oe") { return v + "ing" }
        if v.hasSuffix("e") && v.count > 2 { return String(v.dropLast()) + "ing" }
        if doublesFinal(v) { return v + String(v.last!) + "ing" }
        return v + "ing"
    }

    // MARK: shortening

    /// For each unit: inside inline code or parentheses/brackets.
    private static func protectedMask(_ u: [UInt16]) -> [Bool] {
        var mask = [Bool](repeating: false, count: u.count)
        var code = false
        var depth = 0
        for i in 0..<u.count {
            let c = u[i]
            if c == 0x60 { code.toggle() }
            else if !code && (c == 0x28 || c == 0x5B) { depth += 1 }
            else if !code && (c == 0x29 || c == 0x5D) && depth > 0 { depth -= 1 }
            mask[i] = code || depth > 0
        }
        return mask
    }

    /// Space-separated words of CLEANED text, a code span or bracket group staying inside its word.
    private static func tokens(_ s: String) -> [String] {
        let u = Array(s.utf16)
        let mask = protectedMask(u)
        var out: [String] = []
        var cur: [UInt16] = []
        for i in 0..<u.count {
            if !mask[i] && u[i] == 0x20 {
                if !cur.isEmpty { out.append(String(decoding: cur, as: UTF16.self)) }
                cur = []
            } else {
                cur.append(u[i])
            }
        }
        if !cur.isEmpty { out.append(String(decoding: cur, as: UTF16.self)) }
        return out
    }

    private static func bare(_ w: String) -> String {
        String(decoding: asciiLower(w).utf16.filter { (0x61...0x7A).contains($0) || $0 == 0x27 || $0 == 0x2D }, as: UTF16.self)
    }

    private static func cjkCount(_ w: String) -> Int { w.unicodeScalars.filter { isCjkScalar($0.value) }.count }
    private static func weightOf(_ w: String) -> Int { max(1, (cjkCount(w) + cjkCharsPerWord - 1) / cjkCharsPerWord) }

    private static func cjkPrefix(_ w: String, _ n: Int) -> String {
        var out = String.UnicodeScalarView()
        var seen = 0
        for s in w.unicodeScalars {
            if isCjkScalar(s.value) {
                if seen == n { break }
                seen += 1
            }
            out.append(s)
        }
        return String(out)
    }

    private static func stripTrailingPunctuation(_ w: String) -> String {
        var u = Array(w.utf16)
        while let last = u.last, trailingPunctuation.contains(last) { u.removeLast() }
        return String(decoding: u, as: UTF16.self)
    }

    private static func trimTail(_ list: [String]) -> [String] {
        var out = list
        while let last = out.last {
            let stripped = stripTrailingPunctuation(last)
            if stripped.isEmpty { out.removeLast(); continue }
            if stripped != last { out[out.count - 1] = stripped; continue }
            let b = bare(last)
            if trailingAdverbs.contains(b) || trailingDangling.contains(b) { out.removeLast(); continue }
            return out
        }
        return out
    }

    private static func shortenObject(_ rest: String) -> String {
        let u = Array(rest.utf16)
        let mask = protectedMask(u)
        var stop = u.count
        for r in cut.matches(asciiLower(rest)) where !mask[r.location] { stop = r.location; break }
        let list = trimTail(tokens(String(decoding: u[0..<stop], as: UTF16.self)))
        var budget = titleMaxWords - 1
        var kept: [String] = []
        for w in list {
            let weight = weightOf(w)
            if weight <= budget { kept.append(w); budget -= weight; continue }
            if budget > 0 && cjkCount(w) > 0 { kept.append(cjkPrefix(w, budget * cjkCharsPerWord)) }
            let cutList = trimTail(kept)
            return cutList.isEmpty ? "" : cutList.joined(separator: " ") + "…"
        }
        return kept.joined(separator: " ")
    }

    private static let clauseBreaks: Set<UInt16> = [0x2C, 0x3B, 0x3A, 0x2014, 0x2013, 0x28]   // , ; : — – (

    private static func isStatement(_ rest: String) -> Bool {
        let u = Array(rest.utf16)
        let stopAt = u.firstIndex(where: { clauseBreaks.contains($0) }) ?? u.count
        var finiteCount = 0
        var subordinate = false
        for t in tokens(String(decoding: u[0..<stopAt], as: UTF16.self)) {
            let b = bare(t)
            if subordinators.contains(b) { subordinate = true }
            else if finite.contains(b) {
                finiteCount += 1
                if !subordinate || finiteCount >= 2 { return true }
            }
        }
        return false
    }

    struct RuleTitle: Equatable { let title: String; let weak: Bool }

    private enum Shape { case converted, gerund, found }

    /// `execTail`: an anchored pattern ending in the rest group, run on the lower-cased copy: its first
    /// group (lower case) and the REST in its original casing (a suffix of `s`).
    private static func execTail(_ re: JSRegex, _ s: String, _ lower: String? = nil) -> (word: String, rest: String)? {
        guard let m = re.exec(lower ?? asciiLower(s)) else { return nil }
        let tail = m[m.count - 1] ?? ""
        let u = Array(s.utf16)
        let restUnits = u[(u.count - tail.utf16.count)...]
        return (m.count > 2 ? (m[1] ?? "") : "", String(decoding: restUnits, as: UTF16.self))
    }

    private static func build(_ verbIng: String, _ rest: String, _ shape: Shape) -> RuleTitle? {
        var verb = asciiLower(verbIng)
        var tail = rest
        if shape != .found {
            if notGerunds.contains(verb) { return nil }
            if shape == .gerund && isStatement(tail) { return nil }
            if verb == "starting" || verb == "beginning" || verb == "continuing",
               let m = execTail(toVerb, tail), !stopVerbs.contains(m.word) {
                verb = gerund(m.word)
                tail = m.rest
            }
            if let by = execTail(byGerund, tail), !notGerunds.contains(by.word) {
                verb = by.word
                tail = by.rest
            }
        }
        let object = shortenObject(tail)
        if countOccurrences(object, "`") % 2 != 0 { return nil }
        let objectWords = tokens(object).map(bare).filter { !$0.isEmpty }
        let hasCjk = cjkCount(object) > 0
        if metaVerbs.contains(verb) && ((objectWords.isEmpty && !hasCjk) || objectWords.contains(where: metaObjects.contains)) { return nil }
        var weak = false
        if objectWords.isEmpty && !hasCjk {
            if shape == .found || generic.contains(verb) { return nil }
            weak = true
        } else if !hasCjk && objectWords.allSatisfy(pronounish.contains) {
            return nil
        }
        let head = verb.prefix(1).uppercased() + verb.dropFirst()
        return RuleTitle(title: ThinkingTitle.clip(object.isEmpty ? head : head + " " + object), weak: weak)
    }

    private static func matchCandidate(_ c: String) -> RuleTitle? {
        let low = asciiLower(c)
        if let m = execTail(pStartBy, c, low) { return build(m.word, m.rest, .gerund) }
        if let m = execTail(pModal, c, low) {
            var verb = m.word
            var rest = m.rest
            if stopVerbs.contains(verb) { return nil }
            if verb == "go" || verb == "try" || verb == "come" {
                if let g = execTail(goAnd, rest) { verb = g.word; rest = g.rest }
                if stopVerbs.contains(verb) { return nil }
            }
            if verb == "double", let d = execTail(doubleCheck, rest) { return build("double-checking", d.rest, .converted) }
            return build(gerund(verb), rest, .converted)
        }
        if let m = execTail(pIm, c, low) { return build(m.word, m.rest, .converted) }
        if let m = execTail(pFound, c, low) ?? execTail(pPast, c, low) { return build(m.word, m.rest, .found) }
        if let m = execTail(pGerund, c, low) { return build(m.word, m.rest, .gerund) }
        return nil
    }

    /// `evaluateSentence`: the latest matching candidate of a complete sentence.
    static func evaluateSentence(_ segment: String) -> RuleTitle? {
        if countOccurrences(segment, "**") % 2 != 0 { return nil }
        let s = cleanText(segment.replacingOccurrences(of: "**", with: ""))
        if s.isEmpty { return nil }
        let u = Array(s.utf16)
        let mask = protectedMask(u)
        var clauses: [Int] = []
        for r in clause.matches(asciiLower(s)) where !mask[r.location] { clauses.append(r.location + r.length) }
        let starts = [0] + clauses.suffix(maxClauses)   // the sentence, and its latest `maxClauses` clauses
        for start in starts.reversed() {
            let c = cleanText(String(decoding: u[start...], as: UTF16.self))
            if c.isEmpty || c.utf16.count > candidateMax || c.hasPrefix("`") { continue }
            if let r = matchCandidate(c) { return r }
        }
        return nil
    }

    /// The later of two matches, unless the later one is weak and the earlier one is not.
    static func prefer(_ earlier: RuleTitle?, _ later: RuleTitle?) -> RuleTitle? {
        guard let later else { return earlier }
        if let earlier, later.weak && !earlier.weak { return earlier }
        return later
    }

    /// PURE: the activity title of a whole text (`activityTitleOf`).
    static func title(of text: String, final: Bool) -> String? {
        let t = ActivityTitleTracker()
        t.push(text)
        return t.title(final: final)
    }

    /// EVERY pattern this file compiles (one per construction of a JSRegex). Its patterns are built
    /// from word lists, so `RegexShapeTripwireTests` cannot read them as literals; it reads them here,
    /// at run time, checks this list's length against the file's construction sites, and audits each.
    static var compiledPatterns: [String] {
        [pStartBy, pModal, pIm, pFound, pPast, pGerund, goAnd, doubleCheck, toVerb, byGerund, cut, clause,
         structureLine, fenceLine, ThinkingHeading.fileToken, ThinkingHeading.singleToken].map(\.re.pattern)
    }
}

/// `ActivityTitleTracker`: the activity rule over a stream, incremental — each unit is looked at
/// once and only a just-COMPLETED sentence is evaluated. While streaming only complete sentences
/// count (no provisional titles, review r2); at the end the trailing sentence counts too. Each title
/// carries its sentence's start offset. See the daemon's twin for the contract.
final class ActivityTitleTracker {
    private var seg: [UInt16] = []
    private var segHead: [UInt16] = []
    private var segOverlong = false
    private var segAtLineStart = true
    private var segInCode = false
    private var segStart = 0
    private var total = 0
    private var lineSkip = false
    private var inFence = false
    private var prev: UInt16 = 0
    private var committed: (rule: ActivityTitleRule.RuleTitle, pos: Int)?

    private static func isLineBreak(_ u: UInt16) -> Bool { u == 0x0A || u == 0x0D || u == 0x2028 || u == 0x2029 }
    private static func isAsciiSentenceEnd(_ u: UInt16) -> Bool { u == 0x2E || u == 0x21 || u == 0x3F }
    private static func isCjkSentenceEnd(_ u: UInt16) -> Bool { u == 0x3002 || u == 0xFF01 || u == 0xFF1F || u == 0xFF1B }

    func push(_ text: String) {
        for u in text.utf16 {
            if Self.isLineBreak(u) {
                endSegment()
                segAtLineStart = true
                lineSkip = false
            } else if Self.isAsciiSentenceEnd(prev) && !segInCode && isSpaceUnit(u) {
                endSegment()
                segAtLineStart = false
            } else {
                append(u)
                if Self.isCjkSentenceEnd(u) && !segInCode {
                    endSegment()
                    segAtLineStart = false
                }
            }
            prev = u
            total += 1
        }
    }

    private func append(_ u: UInt16) {
        if segHead.isEmpty { segStart = total }
        if u == 0x60 { segInCode.toggle() }
        if segHead.count < ActivityTitleRule.segmentHead { segHead.append(u) }
        if !segOverlong {
            if seg.count >= ActivityTitleRule.segmentMax { segOverlong = true; seg = [] } else { seg.append(u) }
        }
    }

    /// The latest match among COMPLETE sentences, with its offset; with `final` the trailing sentence
    /// counts too.
    func placed(final: Bool) -> Placed? {
        var best = committed
        if final, !segOverlong, !seg.isEmpty, readable(commit: false),
           let r = ActivityTitleRule.evaluateSentence(String(decoding: seg, as: UTF16.self)) {
            best = Self.prefer(best, (r, segStart))
        }
        return best.map { Placed(title: $0.rule.title, pos: $0.pos) }
    }

    func title(final: Bool) -> String? { placed(final: final)?.title }

    private static func prefer(_ earlier: (rule: ActivityTitleRule.RuleTitle, pos: Int)?,
                               _ later: (rule: ActivityTitleRule.RuleTitle, pos: Int)) -> (rule: ActivityTitleRule.RuleTitle, pos: Int)? {
        if let earlier, later.rule.weak && !earlier.rule.weak { return earlier }
        return later
    }

    private func readable(commit: Bool) -> Bool {
        if segAtLineStart {
            let head = cleanText(String(decoding: segHead, as: UTF16.self))
            if ActivityTitleRule.fenceLine.test(head) {
                if commit { inFence.toggle(); lineSkip = true }
                return false
            }
            if inFence { return false }
            if ActivityTitleRule.structureLine.test(head) {
                if commit { lineSkip = true }
                return false
            }
            return true
        }
        return !inFence && !lineSkip
    }

    private func endSegment() {
        let overlong = segOverlong
        let empty = !overlong && seg.allSatisfy(isSpaceUnit)
        let readable = empty ? !inFence : readable(commit: true)
        if readable && !overlong && !empty,
           let r = ActivityTitleRule.evaluateSentence(String(decoding: seg, as: UTF16.self)) {
            committed = Self.prefer(committed, (r, segStart))
        }
        seg = []
        segHead = []
        segOverlong = false
        segInCode = false
    }
}
