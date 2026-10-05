import Foundation

/// ── THE THINKING PILL'S TITLE RULE, PHONE ENGINE (2026-10-05, user ruling) ─────────────────────
///
/// The faithful Swift port of the daemon's `packages/core/src/projector/thinking-title.ts`: the
/// provider's own BOLD HEADING first, else an ACTIVITY title inferred from the prose by fixed rules
/// (no model call), else none. Both engines must title a block identically, so this port works on
/// UTF-16 units and the same ASCII regexes (no `\b`), and its tests run the daemon's own fixture
/// (`packages/core/test/projector/fixtures/thinking-titles.json`). Change both together.

// MARK: - JS-compatible text helpers

/// JS `\s` for one UTF-16 unit (whitespace and line terminators).
@inline(__always) func jsSpace(_ u: UInt16) -> Bool {
    switch u {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
}

/// JS `String.prototype.trim` on UTF-16 units.
func jsTrim(_ s: String) -> String {
    let u = Array(s.utf16)
    var a = 0, b = u.count
    while a < b, jsSpace(u[a]) { a += 1 }
    while b > a, jsSpace(u[b - 1]) { b -= 1 }
    return a == 0 && b == u.count ? s : String(decoding: u[a..<b], as: UTF16.self)
}

/// Non-overlapping occurrences, left to right (`s.split(sub).length - 1`).
func countOccurrences(_ s: String, _ sub: String) -> Int {
    let h = Array(s.utf16), n = Array(sub.utf16)
    guard !n.isEmpty, h.count >= n.count else { return 0 }
    var count = 0, i = 0
    while i + n.count <= h.count {
        if Array(h[i..<(i + n.count)]) == n { count += 1; i += n.count } else { i += 1 }
    }
    return count
}

/// A compiled pattern with JS-like helpers (NSRegularExpression works in UTF-16 units, like JS).
struct JSRegex {
    let re: NSRegularExpression
    init(_ pattern: String, caseInsensitive: Bool = false) {
        // swiftlint:disable:next force_try
        re = try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
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

enum ThinkingHeading {
    private static let lineBreaks: Set<UInt16> = [0x0A, 0x0D, 0x2028, 0x2029]
    private static let star: UInt16 = 0x2A
    static let fileToken = JSRegex(#"[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]{0,4}(?![A-Za-z0-9])"#)
    static let maxWords = 10

    /// `isTitleHeading`: not a label (`…:`), not a path, code or file name, at most 10 words.
    static func isTitle(_ inner: String) -> Bool {
        if inner.isEmpty || inner.hasSuffix(":") { return false }
        if inner.contains("/") || inner.contains("`") || fileToken.test(inner) { return false }
        return inner.components(separatedBy: " ").count <= maxWords
    }

    /// `lastValidHeading`: per line, optional spaces/tabs, `**`, at least one unit, the FIRST closing
    /// `**` after it, then nothing but spaces/tabs to the line's end. The last valid one wins, clipped.
    static func lastValid(_ text: String) -> String? {
        var found: String?
        let units = Array(text.utf16)
        var lineStart = 0
        var i = 0
        while i <= units.count {
            if i == units.count || lineBreaks.contains(units[i]) {
                if let inner = headingInner(units[lineStart..<i]) {
                    let collapsed = ThinkingTitle.collapse(String(decoding: inner, as: UTF16.self))
                    if isTitle(collapsed) { found = collapsed }
                }
                lineStart = i + 1
            }
            i += 1
        }
        return found.map(ThinkingTitle.clip)
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
    static let segmentHead = 16

    private static func words(_ lists: String...) -> Set<String> {
        Set(lists.joined(separator: " ").split(separator: " ").map(String.init))
    }
    private static func alt(_ list: String) -> String { list.split(separator: " ").joined(separator: "|") }

    private static let leadWords = "now first firstly also quickly carefully actually just then next still again briefly finally lastly so ok okay alright right and but well anyway instead meanwhile second secondly third thirdly further simply really properly directly thoroughly wait hmm ah oh great good perfect fine sure yes yeah"
    private static let midWords = "now first also quickly carefully actually just then next still again briefly finally properly really simply directly thoroughly systematically further explicitly manually separately immediately quick"
    private static let lead = #"^(?:(?:"# + alt(leadWords) + #")(?![A-Za-z'])\s*,?\s+)*"#
    private static let mid = #"(?:(?:"# + alt(midWords) + #")(?![A-Za-z'])\s+)*"#
    private static let modal = [
        "let me", "let's", "let us",
        "i'll need to", "i will need to", "i'll have to", "i will have to", "i'll", "i will",
        "i'd like to", "i would like to", "i want to", "i need to", "i should", "i must", "i have to",
        "i'm going to", "i am going to", "i'm about to", "i am about to", "i'm ready to", "i am ready to",
        "i'm planning to", "i am planning to", "i plan to",
        "we need to", "we should", "we'll", "we will",
        "it's time to", "time to",
    ].map { $0.replacingOccurrences(of: " ", with: #"\s+"#) }.joined(separator: "|")
    private static let stop = #"(?=[\s,.:;!?]|$)"#

    private static let pStartBy = JSRegex(lead + "(?:" + modal + #")\s+"# + mid + #"(?:start|begin)\s+(?:off\s+)?by\s+([a-z]+ing)"# + stop + "(.*)$", caseInsensitive: true)
    private static let pModal = JSRegex(lead + "(?:" + modal + #")\s+"# + mid + "([a-z][a-z-]*)" + stop + "(.*)$", caseInsensitive: true)
    private static let pIm = JSRegex(lead + #"i(?:'m|\s+am)\s+"# + mid + "([a-z]+ing)" + stop + "(.*)$", caseInsensitive: true)
    private static let pFound = JSRegex(lead + #"(?:i(?:'ve|\s+have)\s+(?:(?:just|now|also|already)\s+)*)?(found|confirmed|identified|spotted)"# + stop + "(.*)$", caseInsensitive: true)
    private static let pastSteps = "checked double-checked counted ran reviewed examined inspected verified tested searched scanned explored gathered analyzed analysed compared traced read opened grepped listed located measured reran re-ran"
    private static let pPast = JSRegex(lead + #"i(?:'ve|\s+have)?\s+(?:(?:just|now|also|already|quickly|carefully|first)\s+)*("# + alt(pastSteps) + ")" + stop + "(.*)$", caseInsensitive: true)
    private static let pGerund = JSRegex(lead + "([a-z]+ing)" + stop + "(.*)$", caseInsensitive: true)

    private static let goAnd = JSRegex(#"^\s+(?:(?:ahead|through|back|on)\s+)?and\s+([a-z][a-z-]*)(?=[\s,.:;!?]|$)(.*)$"#, caseInsensitive: true)
    private static let doubleCheck = JSRegex(#"^[\s\-]+check(?=[\s,.:;!?]|$)(.*)$"#, caseInsensitive: true)
    private static let toVerb = JSRegex(#"^\s+to\s+([a-z][a-z-]*)(?=[\s,.:;!?]|$)(.*)$"#, caseInsensitive: true)
    private static let byGerund = JSRegex(#"^\s+by\s+([a-z]+ing)(?=[\s,.:;!?]|$)(.*)$"#, caseInsensitive: true)

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

    private static let purposes = "identify see understand find confirm check figure determine get make know verify ensure learn decide catch spot locate gather compare validate inspect review map trace reproduce isolate avoid prevent count orient answer"
    private static let nextVerbs = "check read run look lay write fix add verify confirm try give review examine inspect identify count find explore compare make keep summarize glance outline produce present provide propose suggest finalize mention explain describe grep focus dig figure determine think consider decide proceed continue begin maybe possibly am i"
    private static func w(_ s: String) -> String { s.replacingOccurrences(of: " ", with: #"\s+"#) + "(?![A-Za-z])" }
    private static let cutWords = (
        [#"to\s+(?:"# + alt(purposes) + ")(?![A-Za-z])"]
        + ["in order to", "so that", "so", "because", "before", "after", "which", "since", "then", "and then", "and also", "while", "whereas", "though", "although", "but", "or if", "or whether"].map(w)
        + [#"and\s+(?:"# + alt(nextVerbs) + ")(?![A-Za-z])",
           #"by\s+[a-z]+ing(?![A-Za-z])"#,
           #"that\s+(?:might|could|would|may|will|can|should|is|are|was|were)(?![A-Za-z])"#]
    ).joined(separator: "|")
    private static let cut = JSRegex(#"\s+(?:"# + cutWords + #")|\s+\(|\s+[-–]+\s|\s*—|[,;:!?]"#, caseInsensitive: true)
    private static let clause = JSRegex(#",\s+(?=(?:so|and|then|but|now|next|i'll|i will|i'm|i am|i need|i should|i want|let me|let's)(?![A-Za-z]))|;\s+|\s*—\s*|\s+–\s+|\s+--\s+|:\s+"#, caseInsensitive: true)
    static let structureLine = JSRegex(#"^(?:[-*+•]\s|[0-9]{1,3}[.)](?:\s|$)|#{1,6}(?:\s|$)|\||>)"#)
    static let fenceLine = JSRegex(#"^(?:```|~~~)"#)
    private static let trailingPunctuation = JSRegex(#"[.,;:!?…]+$"#)

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
        let v = verb.lowercased()
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

    private static func tokens(_ s: String) -> [String] {
        let u = Array(s.utf16)
        let mask = protectedMask(u)
        var out: [String] = []
        var cur: [UInt16] = []
        for i in 0..<u.count {
            let c = u[i]
            if !mask[i] && c != 0x60 && jsSpace(c) {
                if !cur.isEmpty { out.append(String(decoding: cur, as: UTF16.self)) }
                cur = []
            } else {
                cur.append(c)
            }
        }
        if !cur.isEmpty { out.append(String(decoding: cur, as: UTF16.self)) }
        return out
    }

    private static func bare(_ w: String) -> String {
        String(String.UnicodeScalarView(w.lowercased().unicodeScalars.filter { ($0 >= "a" && $0 <= "z") || $0 == "'" || $0 == "-" }))
    }

    private static func trimTail(_ list: [String]) -> [String] {
        var out = list
        while let last = out.last {
            let ns = last as NSString
            var stripped = last
            if let r = trailingPunctuation.matches(last).first { stripped = ns.substring(to: r.location) }
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
        var end = u.count
        for r in cut.matches(rest) where !mask[r.location] { end = r.location; break }
        var list = trimTail(tokens(String(decoding: u[0..<end], as: UTF16.self)))
        if list.count > titleMaxWords - 1 {
            list = trimTail(Array(list.prefix(titleMaxWords - 1)))
            if list.isEmpty { return "" }
            return list.joined(separator: " ") + "…"
        }
        return list.joined(separator: " ")
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

    private static func build(_ verbIng: String, _ rest: String, _ shape: Shape) -> RuleTitle? {
        var verb = verbIng.lowercased()
        var tail = rest
        if shape != .found {
            if notGerunds.contains(verb) { return nil }
            if shape == .gerund && isStatement(tail) { return nil }
            if verb == "starting" || verb == "beginning" || verb == "continuing",
               let m = toVerb.exec(tail), let v2 = m[1], !stopVerbs.contains(v2.lowercased()) {
                verb = gerund(v2)
                tail = m[2] ?? ""
            }
            if let by = byGerund.exec(tail), let g = by[1], !notGerunds.contains(g.lowercased()) {
                verb = g.lowercased()
                tail = by[2] ?? ""
            }
        }
        let object = shortenObject(tail)
        if countOccurrences(object, "`") % 2 != 0 { return nil }
        let objectWords = tokens(object).map(bare).filter { !$0.isEmpty }
        if metaVerbs.contains(verb) && (objectWords.isEmpty || objectWords.contains(where: metaObjects.contains)) { return nil }
        var weak = false
        if objectWords.isEmpty {
            if shape == .found || generic.contains(verb) { return nil }
            weak = true
        } else if objectWords.allSatisfy(pronounish.contains) {
            return nil
        }
        let head = verb.prefix(1).uppercased() + verb.dropFirst()
        return RuleTitle(title: ThinkingTitle.clip(object.isEmpty ? head : head + " " + object), weak: weak)
    }

    private static func matchCandidate(_ c: String) -> RuleTitle? {
        if let m = pStartBy.exec(c) { return build(m[1] ?? "", m[2] ?? "", .gerund) }
        if let m = pModal.exec(c) {
            var verb = (m[1] ?? "").lowercased()
            var rest = m[2] ?? ""
            if stopVerbs.contains(verb) { return nil }
            if verb == "go" || verb == "try" || verb == "come" {
                if let g = goAnd.exec(rest) { verb = (g[1] ?? "").lowercased(); rest = g[2] ?? "" }
                if stopVerbs.contains(verb) { return nil }
            }
            if verb == "double", let d = doubleCheck.exec(rest) { return build("double-checking", d[1] ?? "", .converted) }
            return build(gerund(verb), rest, .converted)
        }
        if let m = pIm.exec(c) { return build(m[1] ?? "", m[2] ?? "", .converted) }
        if let m = pFound.exec(c) ?? pPast.exec(c) { return build(m[1] ?? "", m[2] ?? "", .found) }
        if let m = pGerund.exec(c) { return build(m[1] ?? "", m[2] ?? "", .gerund) }
        return nil
    }

    /// `evaluateSentence`: the latest matching candidate of a complete sentence.
    static func evaluateSentence(_ segment: String) -> RuleTitle? {
        var s = jsTrim(segment.replacingOccurrences(of: "\u{2018}", with: "'").replacingOccurrences(of: "\u{2019}", with: "'"))
        if s.isEmpty { return nil }
        if countOccurrences(s, "**") % 2 != 0 { return nil }
        s = s.replacingOccurrences(of: "**", with: "")
        let u = Array(s.utf16)
        let mask = protectedMask(u)
        var starts = [0]
        for r in clause.matches(s) where !mask[r.location] { starts.append(r.location + r.length) }
        for start in starts.reversed() {
            let c = jsTrim(String(decoding: u[start...], as: UTF16.self))
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
    /// at run time, checks this list's length against the file's construction sites, and applies its
    /// rule to each one.
    static var compiledPatterns: [String] {
        [pStartBy, pModal, pIm, pFound, pPast, pGerund, goAnd, doubleCheck, toVerb, byGerund, cut, clause,
         structureLine, fenceLine, trailingPunctuation, ThinkingHeading.fileToken].map(\.re.pattern)
    }
}

/// `ActivityTitleTracker`: the activity rule over a stream, incremental — each unit is looked at
/// once and only a just-COMPLETED sentence is evaluated. See the daemon's twin for the contract.
final class ActivityTitleTracker {
    private var seg: [UInt16] = []
    private var segHead: [UInt16] = []
    private var segOverlong = false
    private var segAtLineStart = true
    private var segInCode = false
    private var lineSkip = false
    private var inFence = false
    private var prev: UInt16 = 0
    private var committed: ActivityTitleRule.RuleTitle?

    private static func isLineBreak(_ c: UInt16) -> Bool { c == 0x0A || c == 0x0D || c == 0x2028 || c == 0x2029 }
    private static func isSentenceEnd(_ c: UInt16) -> Bool { c == 0x2E || c == 0x21 || c == 0x3F }

    func push(_ text: String) {
        for c in text.utf16 {
            if Self.isLineBreak(c) {
                endSegment()
                segAtLineStart = true
                lineSkip = false
            } else if Self.isSentenceEnd(prev) && !segInCode && jsSpace(c) {
                endSegment()
                segAtLineStart = false
            } else {
                if c == 0x60 { segInCode.toggle() }
                if segHead.count < ActivityTitleRule.segmentHead { segHead.append(c) }
                if !segOverlong {
                    if seg.count >= ActivityTitleRule.segmentMax { segOverlong = true; seg = [] } else { seg.append(c) }
                }
            }
            prev = c
        }
    }

    func title(final: Bool) -> String? {
        var best = committed
        // The trailing sentence counts at the block's end, or once it already ends with . ! ?
        if !segOverlong, !seg.isEmpty,
           final || seg.last(where: { !jsSpace($0) }).map(Self.isSentenceEnd) == true,
           readable(commit: false) {
            best = ActivityTitleRule.prefer(best, ActivityTitleRule.evaluateSentence(String(decoding: seg, as: UTF16.self)))
        }
        return best?.title
    }

    private func readable(commit: Bool) -> Bool {
        if segAtLineStart {
            let start = segHead.firstIndex(where: { !jsSpace($0) }) ?? segHead.count
            let head = String(decoding: segHead[start...], as: UTF16.self)
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
        let empty = !overlong && seg.allSatisfy(jsSpace)
        let readable = empty ? !inFence : readable(commit: true)
        if readable && !overlong && !empty {
            committed = ActivityTitleRule.prefer(committed, ActivityTitleRule.evaluateSentence(String(decoding: seg, as: UTF16.self)))
        }
        seg = []
        segHead = []
        segOverlong = false
        segInCode = false
    }
}
