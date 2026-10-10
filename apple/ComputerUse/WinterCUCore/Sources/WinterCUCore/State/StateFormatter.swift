import Foundation

/// How long the observation waited for the UI to settle, for the header.
public enum CUSettleNote: Sendable, Equatable {
    case settled(ms: Int)
    case notSettled(ms: Int)

    var text: String {
        switch self {
        case .settled(let ms): return "settled \(ms) ms"
        case .notSettled(let ms): return "not settled after \(ms) ms"
        }
    }
}

public struct CUStateHeader: Sendable, Equatable {
    public var appName: String
    public var windowTitle: String?
    public var focusedRef: Int?
    /// nil when the caller asked for no settle wait (the clause is then omitted).
    public var settle: CUSettleNote?
    /// Where typed text goes in the focused element — "caret 12/40" or `selected 3–9 ("hello")` — when its text
    /// can be read; never for a secure field (`CUStateFormatter.caretNote`).
    public var caret: String?
    /// What the focus is when it is not an element of the tree shown (a web page's hidden input, another window).
    public var focusText: String?
    /// The page this state is of (its number in this window: it goes up when the page changes) and the state's own
    /// number — refs from an earlier page are gone. Nil when the window shows no web page / for a diff base.
    public var page: Int?
    public var stateNumber: Int?
    /// The read stopped at its budget (nodes or time): at least this many elements were not read.
    public var unread: Int?

    public init(appName: String, windowTitle: String?, focusedRef: Int?, settle: CUSettleNote?,
                caret: String? = nil, focusText: String? = nil, page: Int? = nil, stateNumber: Int? = nil, unread: Int? = nil) {
        self.appName = appName
        self.windowTitle = windowTitle
        self.focusedRef = focusedRef
        self.settle = settle
        self.caret = caret
        self.focusText = focusText
        self.page = page
        self.stateNumber = stateNumber
        self.unread = unread
    }
}

/// Renders the full state (spine §4):
///
///     Notes — window "Groceries" · focused [14] · settled 120 ms
///     [1] window "Groceries"
///       [2] toolbar
///         [3] button "New Note"
///
/// Two spaces per level. Lines past `lineCap` (`fullLineCap` for a `full: true` state) are folded by collapsing
/// subtrees as `(<n> more — state({within:<ref>}))`, in this order:
/// 1. the window's chrome — what lies outside a web page's content (toolbars, tab bars, a page's own menu bar
///    included only when it is outside the page) — largest first;
/// 2. subtrees INSIDE the page's content, largest first — the page itself (its web area, or the scroll area holding
///    it) is never folded wholesale while anything else can be;
/// 3. a subtree that holds the focused element, so the model keeps sight of where input goes;
/// 4. the page's content itself; 5. a root, last of all.
/// A window with no web page has no content: largest first, the focus last, as ever.
public struct CUStateFormatter: Sendable {
    public var lineCap: Int
    /// The cap of a `full: true` state: everything the read saw, up to this hard cap. The reader stops at
    /// `AXTreeReader.defaultMaxNodes` elements, so a full state is not folded at all in practice; when it is, its
    /// last line says so.
    public var fullLineCap: Int
    /// …and in bytes (UTF-8, its lines and their newlines): the daemon cuts a ComputerV2 result's text at 64 KiB, so a
    /// full state stays well inside it — its own cut line must survive (a state cut mid-tree by the result's cap
    /// blanks every later print of that script).
    public var fullByteCap: Int
    public var valueCap: Int

    public static let defaultFullLineCap = AXTreeReader.defaultMaxNodes
    public static let defaultFullByteCap = 48 * 1024

    public init(lineCap: Int = 300, fullLineCap: Int = CUStateFormatter.defaultFullLineCap,
                fullByteCap: Int = CUStateFormatter.defaultFullByteCap, valueCap: Int = 200) {
        self.lineCap = max(1, lineCap)
        self.fullLineCap = max(self.lineCap, fullLineCap)
        self.fullByteCap = max(1024, fullByteCap)
        self.valueCap = valueCap
    }

    // MARK: header

    public func header(_ h: CUStateHeader, includeWindow: Bool = true) -> String {
        var parts: [String] = []
        if includeWindow, let title = h.windowTitle { parts.append("window \(quote(title))") }
        if let f = h.focusedRef {
            parts.append("focused [\(f)]")
            if let c = h.caret { parts.append(c) }
        } else if let text = h.focusText {
            parts.append(text)
        }
        // No focus the app reports: nothing said here — a keyboard act that needs one says so (`focus_unknown`).
        if let s = h.settle { parts.append(s.text) }
        if let p = h.page { parts.append("page \(p)") }
        if let n = h.stateNumber { parts.append("state \(n)") }
        if let u = h.unread, u > 0 {
            parts.append("read cut short: at least \(u.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))) elements not read (the \"more\" markers show where)")
        }
        return parts.isEmpty ? h.appName : "\(h.appName) — " + parts.joined(separator: " · ")
    }

    // MARK: one line

    /// The line of one node without indentation and without a collapse marker.
    public func line(_ n: CUNode) -> String {
        var s = "[\(n.ref)] \(n.roleWords)"
        if let name = n.name, !name.isEmpty { s += " " + quote(cut(name)) }
        if let v = renderedValue(n) { s += " value=" + v }
        var paren: [String] = []
        if let count = n.itemCount { paren.append(count == 1 ? "1 item" : "\(count) items") }
        paren.append(contentsOf: n.states.words)
        if !paren.isEmpty { s += " (" + paren.joined(separator: ", ") + ")" }
        let extra = CURoleWords.extraActions(n.actions)
        if !extra.isEmpty { s += " actions: " + extra.joined(separator: ", ") }
        return s
    }

    /// `"…"` (cut at `valueCap`), `<redacted>` for secure fields, nil when there is nothing to show.
    public func renderedValue(_ n: CUNode) -> String? {
        if n.isSecure { return "<redacted>" }
        guard let v = n.value, !v.isEmpty, v != n.name else { return nil }
        return quote(cut(v))
    }

    /// Where typed text goes in a focused text element: "caret 12/40" (the caret's UTF-16 offset and the text's
    /// length, as accessibility counts), or `selected 3–9 ("hello")` with the selected text cut to 40 characters.
    /// Nil for a secure field (not even its length), a value that is only zero-width filler (a canvas editor's
    /// input target: its numbers would mean nothing), or no readable range. Pure.
    public static let caretTextCap = 40
    public func caretNote(value: String?, selection: NSRange?, secure: Bool) -> String? {
        guard !secure, let value, let r = selection, r.location >= 0, r.length >= 0 else { return nil }
        guard value.isEmpty || value.unicodeScalars.contains(where: { !["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}", "\u{2060}"].contains($0) })
        else { return nil }
        let ns = value as NSString
        guard r.location + r.length <= ns.length else { return nil }
        if r.length == 0 { return "caret \(r.location)/\(ns.length)" }
        let selected = ns.substring(with: r)
        let shown = selected.count <= Self.caretTextCap ? selected : String(selected.prefix(Self.caretTextCap)) + "…"
        return "selected \(r.location)–\(r.location + r.length) (\(quote(shown)))"
    }

    func cut(_ s: String) -> String {
        s.count <= valueCap ? s : String(s.prefix(valueCap)) + "…"
    }

    func quote(_ s: String) -> String {
        var out = "\""
        for ch in s {
            switch ch {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default: out.append(ch)
            }
        }
        return out + "\""
    }

    static func collapseMarker(count: Int, ref: Int) -> String {
        "(\(count) more — state({within:\(ref)}))"
    }

    // MARK: full tree

    /// `viewportFirst` (a non-full, whole-window state): when the tree must fold, what lies OUTSIDE the visible
    /// viewport — outside the window, or outside the visible rect of the scroll area it sits in — is folded
    /// first, one `… n more out of view` line per parent, so the on-screen links, buttons, headings and
    /// fields of a big web page survive. Only then are large subtrees collapsed.
    /// `whole` (the model asked for `full: true`): the cap is `fullLineCap`, and a state that had to fold anyway
    /// ends with a line saying so.
    public func full(header h: CUStateHeader, roots: [CUNode], viewportFirst: Bool = false, whole: Bool = false) -> String {
        var lines = [header(h)]
        lines.append(contentsOf: body(roots: roots, focusedRef: h.focusedRef, viewportFirst: viewportFirst, whole: whole))
        return lines.joined(separator: "\n")
    }

    static func outOfViewMarker(count: Int, ref: Int) -> String {
        "… \(count) more out of view — scroll, or state({within:\(ref)})"
    }

    /// The last line of a `full: true` state that still had to fold: at its line cap, or at its byte cap (`kb`).
    static func wholeCutMarker(cap: Int, folded: Int, kb: Int? = nil) -> String {
        let n = { (v: Int) in v.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))) }
        return "… the full state is cut at \(kb.map { "\($0) KB" } ?? "\(n(cap)) lines"): "
            + "\(n(folded)) elements are folded behind the \"more\" markers above — read each with state({within})"
    }

    /// A collapsed element whose own children are what it discloses — sub-rows (an outline row's nested rows, a
    /// tree item's group of items) — keeps them folded. One whose children are its own cells (an AppKit outline
    /// row: its name is in them) does not: folding them would hide what it is. Pure.
    static func foldsWhenCollapsed(_ n: CUNode) -> Bool {
        guard n.states.contains(.collapsed), !n.children.isEmpty, n.role == "AXRow" else { return false }
        func isRows(_ c: CUNode) -> Bool {
            c.role == "AXRow" || (c.role == "AXGroup" && !c.children.isEmpty && c.children.allSatisfy { $0.role == "AXRow" })
        }
        return n.children.contains(where: isRows)
    }

    /// The indented lines of `roots`, folded to `lineCap` (`fullLineCap` when `whole`).
    public func body(roots: [CUNode], focusedRef: Int?, viewportFirst: Bool = false, whole: Bool = false) -> [String] {
        let cap = whole ? fullLineCap : lineCap
        let byteCap = whole ? fullByteCap : Int.max
        // Flatten into an indexable list with parent links and depths, and whether each element lies outside
        // the visible rect it is clipped to (the window at the top, narrowed by every scroll area below it).
        struct Item { var node: CUNode; var parent: Int?; var depth: Int; var visibleDescendants: Int; var outOfView: Bool; var bytes: Int
                      var childIndex: Int }
        var items: [Item] = []
        var childrenOf: [Int: [Int]] = [:]
        func add(_ n: CUNode, parent: Int?, depth: Int, clip: CGRect?, childIndex: Int) {
            let idx = items.count
            let framed = n.frame.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
            let out = parent != nil && clip != nil && framed != nil && !framed!.intersects(clip!)
            // Its line's size (indentation, newline): the byte cap counts only when `whole`.
            let bytes = whole ? depth * 2 + line(n).utf8.count + 1 : 0
            items.append(Item(node: n, parent: parent, depth: depth, visibleDescendants: 0, outOfView: out, bytes: bytes,
                              childIndex: childIndex))
            if let parent { childrenOf[parent, default: []].append(idx) }
            var childClip = clip
            if let f = framed {
                if parent == nil { childClip = f } else if n.role == "AXScrollArea" { childClip = clip.map { $0.intersection(f) } ?? f }
            }
            for (k, c) in n.children.enumerated() { add(c, parent: idx, depth: depth + 1, clip: childClip, childIndex: k) }
        }
        for (k, r) in roots.enumerated() { add(r, parent: nil, depth: 0, clip: nil, childIndex: k) }
        // Descendant counts, bottom-up (children always follow their parent in `items`).
        for i in stride(from: items.count - 1, through: 0, by: -1) {
            if let p = items[i].parent { items[p].visibleDescendants += 1 + items[i].visibleDescendants }
        }
        // The focus path is collapsed last, and never folded away as out of view.
        var focusPath = Set<Int>()
        if let f = focusedRef, var i = items.firstIndex(where: { $0.node.ref == f }) {
            focusPath.insert(i)
            while let p = items[i].parent { focusPath.insert(p); i = p }
        }
        // The topmost out-of-view elements (their parent is in view).
        var elidable = Set<Int>()
        for i in items.indices where items[i].outOfView && !focusPath.contains(i) {
            if let p = items[i].parent, !items[p].outOfView || focusPath.contains(p) { elidable.insert(i) }
        }

        // The page's content: each OUTERMOST web area, with the chain above it (the scroll area holding it, …) — the
        // `contentPath` is folded only when nothing else can be; `inContent[i]`: i lies inside a page.
        var contentPath = Set<Int>()
        var inContent = [Bool](repeating: false, count: items.count)
        for i in items.indices {
            if let p = items[i].parent, inContent[p] { inContent[i] = true; continue }
            guard items[i].node.role == "AXWebArea" else { continue }
            inContent[i] = true
            var j: Int? = i
            while let k = j { contentPath.insert(k); j = items[k].parent }
        }

        // An element that says it is collapsed and holds what it discloses (an outline row's sub-rows) keeps them
        // folded from the start — reachable with `within` (where it is the root, and shown open) — unless the
        // focus is inside it.
        var collapsed = Set<Int>(items.indices.filter {
            items[$0].parent != nil && Self.foldsWhenCollapsed(items[$0].node) && !focusPath.contains($0)
        })
        var eliding = false
        // hidden[i]: some ancestor of i is collapsed or i is folded out of view. Parents precede children, so
        // one forward pass works. `shown[i]`: i's descendants still shown.
        var hidden = [Bool](repeating: false, count: items.count)
        var shown = [Int](repeating: 0, count: items.count)
        // The bytes of each element's shown descendants (a `full` state's byte budget folds by them).
        var shownBytes = [Int](repeating: 0, count: items.count)
        var summaries = Set<Int>()
        // A `full` state's tail cut: from this child on, a parent's children are folded behind one marker line.
        var tailFrom: [Int: Int] = [:]
        // The shown lines' bytes, a marker counted at its longest (60 bytes per folded line, 90 per marker line).
        var bytes = 0
        func recount() -> Int {
            var lines = 0
            bytes = 0
            summaries.removeAll()
            for i in items.indices {
                if let p = items[i].parent {
                    hidden[i] = hidden[p] || collapsed.contains(p) || tailFrom[p].map { items[i].childIndex >= $0 } == true
                } else { hidden[i] = false }
                if eliding, elidable.contains(i), !hidden[i] {
                    hidden[i] = true
                    if let p = items[i].parent { summaries.insert(p) }
                }
                if !hidden[i] {
                    lines += 1
                    bytes += items[i].bytes + (collapsed.contains(i) ? 60 : 0)
                }
            }
            bytes += (summaries.count + tailFrom.keys.filter { !hidden[$0] && !collapsed.contains($0) }.count) * 90
            for i in items.indices { shown[i] = 0; shownBytes[i] = 0 }
            for i in stride(from: items.count - 1, through: 0, by: -1) where !hidden[i] {
                if let p = items[i].parent {
                    shown[p] += 1 + shown[i]
                    shownBytes[p] += items[i].bytes + shownBytes[i]
                }
            }
            return lines + summaries.count + tailFrom.keys.filter { !hidden[$0] && !collapsed.contains($0) }.count
        }
        var total = recount()
        if viewportFirst, total > cap, !elidable.isEmpty {
            eliding = true
            total = recount()
        }
        let preFolded = collapsed
        // The byte cap leaves room for the header and the cut line itself.
        let bodyBytes = byteCap == Int.max ? Int.max : byteCap - 512
        while total > cap || bytes > bodyBytes {
            // Largest subtree first, in tiers: the chrome outside the page, then inside the page, then the focus
            // path, then the page itself, roots last of all. A `full` state keeps as much as fits: the largest
            // subtree no bigger than a few times what is over (in lines), so a long list is folded in parts, not
            // wholesale for a few kilobytes too many.
            var best: Int?
            func size(_ i: Int) -> Int { eliding ? shown[i] : items[i].visibleDescendants }
            // Only the byte cap binds: weighed in bytes, and a fold that hides less than its marker costs is none.
            let byBytes = total <= cap
            func weight(_ i: Int) -> Int { byBytes ? shownBytes[i] : size(i) }
            let over = byBytes ? bytes - bodyBytes : total - cap
            let fitting = whole ? 4 * over : Int.max
            let minWeight = byBytes ? 150 : 1
            for pass in 0..<5 {
                var smallestEnough: Int?
                for i in items.indices where size(i) > 0 && weight(i) >= minWeight && !collapsed.contains(i) && !hidden[i] {
                    if pass < 4, items[i].parent == nil { continue }
                    if pass < 3, contentPath.contains(i) { continue }
                    if pass < 2, focusPath.contains(i) { continue }
                    if pass == 0, inContent[i] { continue }
                    if weight(i) <= fitting {
                        if best == nil || weight(i) > weight(best!) { best = i }
                    } else if smallestEnough == nil || weight(i) < weight(smallestEnough!) {
                        smallestEnough = i
                    }
                }
                if best == nil { best = smallestEnough }
                if best != nil { break }
            }
            guard let b = best else { break }
            // A `full` state whose chosen subtree is clearly bigger than what is over (a long list): its first children
            // stay, the rest is folded behind one marker — as much as fits, not the list wholesale.
            if whole, weight(b) * 4 > over * 5, let kids = childrenOf[b]?.filter({ !hidden[$0] }), kids.count > 1 {
                var hid = 0
                var from = kids.count
                while from > 1, hid < over + (byBytes ? 90 : 1) {
                    from -= 1
                    let k = kids[from]
                    hid += byBytes ? items[k].bytes + shownBytes[k] : 1 + shown[k]
                }
                tailFrom[b] = items[kids[from]].childIndex
                total = recount()
                continue
            }
            collapsed.insert(b)
            total = recount()
        }
        // What the cap folded (the pre-folded collapsed rows are no cut): said at the end of a `full: true` state.
        let cutBy = collapsed.subtracting(preFolded)

        // Elements folded out of view, per parent (the parent's line is followed by one marker line).
        var outOfViewCount: [Int: Int] = [:]
        if eliding {
            for i in elidable { if let p = items[i].parent, summaries.contains(p) { outOfViewCount[p, default: 0] += 1 + items[i].node.descendantCount } }
        }
        // What each tail cut folded (its children from the cut on, with everything under them).
        var tailCount: [Int: Int] = [:]
        for (p, from) in tailFrom where !hidden[p] && !collapsed.contains(p) {
            tailCount[p] = (childrenOf[p] ?? []).filter { items[$0].childIndex >= from }.reduce(0) { $0 + 1 + items[$1].node.descendantCount }
        }
        var marked = Set<Int>()
        var tailMarked = Set<Int>()
        var out: [String] = []
        for i in items.indices {
            if hidden[i] {
                if eliding, elidable.contains(i), let p = items[i].parent, summaries.contains(p), !marked.contains(p) {
                    marked.insert(p)
                    out.append(String(repeating: "  ", count: items[i].depth)
                               + Self.outOfViewMarker(count: outOfViewCount[p] ?? 0, ref: items[p].node.ref))
                }
                if let p = items[i].parent, let n = tailCount[p], let from = tailFrom[p], items[i].childIndex == from, !tailMarked.contains(p) {
                    tailMarked.insert(p)
                    out.append(String(repeating: "  ", count: items[i].depth) + "… " + Self.collapseMarker(count: n, ref: items[p].node.ref))
                }
                continue
            }
            let n = items[i].node
            var text = String(repeating: "  ", count: items[i].depth) + line(n)
            if collapsed.contains(i) {
                text += " " + Self.collapseMarker(count: n.descendantCount, ref: n.ref)
            } else if n.unreadChildren > 0 {
                text += " " + Self.collapseMarker(count: n.unreadChildren, ref: n.ref)
            }
            out.append(text)
        }
        if whole, !cutBy.isEmpty || eliding || !tailCount.isEmpty {
            let folded = cutBy.filter { !hidden[$0] }.reduce(0) { $0 + items[$1].node.descendantCount }
                + outOfViewCount.values.reduce(0, +) + tailCount.values.reduce(0, +)
            // Which cap cut it: the lines, unless the lines would have fit.
            let byLines = items.count > cap
            out.append(Self.wholeCutMarker(cap: cap, folded: folded, kb: byLines ? nil : byteCap / 1024))
        }
        return out
    }
}
