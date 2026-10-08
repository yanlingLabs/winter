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

    public init(appName: String, windowTitle: String?, focusedRef: Int?, settle: CUSettleNote?) {
        self.appName = appName
        self.windowTitle = windowTitle
        self.focusedRef = focusedRef
        self.settle = settle
    }
}

/// Renders the full state (spine §4):
///
///     Notes — window "Groceries" · focused [14] · settled 120 ms
///     [1] window "Groceries"
///       [2] toolbar
///         [3] button "New Note"
///
/// Two spaces per level. Lines past `lineCap` are folded by collapsing the largest subtrees first, as
/// `(<n> more — state({within:<ref>}))`. A subtree that holds the focused element is collapsed only
/// when nothing else is left to fold, so the model keeps sight of where input goes.
public struct CUStateFormatter: Sendable {
    public var lineCap: Int
    public var valueCap: Int

    public init(lineCap: Int = 300, valueCap: Int = 200) {
        self.lineCap = max(1, lineCap)
        self.valueCap = valueCap
    }

    // MARK: header

    public func header(_ h: CUStateHeader, includeWindow: Bool = true) -> String {
        var parts: [String] = []
        if includeWindow, let title = h.windowTitle { parts.append("window \(quote(title))") }
        if let f = h.focusedRef { parts.append("focused [\(f)]") }
        if let s = h.settle { parts.append(s.text) }
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

    public func full(header h: CUStateHeader, roots: [CUNode]) -> String {
        var lines = [header(h)]
        lines.append(contentsOf: body(roots: roots, focusedRef: h.focusedRef))
        return lines.joined(separator: "\n")
    }

    /// The indented lines of `roots`, folded to `lineCap`.
    public func body(roots: [CUNode], focusedRef: Int?) -> [String] {
        // Flatten into an indexable list with parent links and depths.
        struct Item { var node: CUNode; var parent: Int?; var depth: Int; var visibleDescendants: Int }
        var items: [Item] = []
        func add(_ n: CUNode, parent: Int?, depth: Int) {
            let idx = items.count
            items.append(Item(node: n, parent: parent, depth: depth, visibleDescendants: 0))
            for c in n.children { add(c, parent: idx, depth: depth + 1) }
        }
        for r in roots { add(r, parent: nil, depth: 0) }
        // Descendant counts, bottom-up (children always follow their parent in `items`).
        for i in stride(from: items.count - 1, through: 0, by: -1) {
            if let p = items[i].parent { items[p].visibleDescendants += 1 + items[i].visibleDescendants }
        }
        // The focus path is collapsed last.
        var focusPath = Set<Int>()
        if let f = focusedRef, var i = items.firstIndex(where: { $0.node.ref == f }) {
            while let p = items[i].parent { focusPath.insert(p); i = p }
        }

        var collapsed = Set<Int>()
        // hidden[i]: some ancestor of i is collapsed. Parents precede children, so one forward pass works.
        var hidden = [Bool](repeating: false, count: items.count)
        func recount() -> Int {
            var shown = 0
            for i in items.indices {
                if let p = items[i].parent { hidden[i] = hidden[p] || collapsed.contains(p) } else { hidden[i] = false }
                if !hidden[i] { shown += 1 }
            }
            return shown
        }
        var total = recount()
        while total > lineCap {
            // Largest subtree first; the focus path only when nothing else is left; roots last of all.
            var best: Int?
            for pass in 0..<3 {
                for i in items.indices where items[i].visibleDescendants > 0 && !collapsed.contains(i) && !hidden[i] {
                    if pass < 2, items[i].parent == nil { continue }
                    if pass == 0, focusPath.contains(i) { continue }
                    if best == nil || items[i].visibleDescendants > items[best!].visibleDescendants { best = i }
                }
                if best != nil { break }
            }
            guard let b = best else { break }
            collapsed.insert(b)
            total = recount()
        }

        var out: [String] = []
        for i in items.indices where !hidden[i] {
            let n = items[i].node
            var text = String(repeating: "  ", count: items[i].depth) + line(n)
            if collapsed.contains(i) {
                text += " " + Self.collapseMarker(count: n.descendantCount, ref: n.ref)
            } else if n.unreadChildren > 0 {
                text += " " + Self.collapseMarker(count: n.unreadChildren, ref: n.ref)
            }
            out.append(text)
        }
        return out
    }
}
