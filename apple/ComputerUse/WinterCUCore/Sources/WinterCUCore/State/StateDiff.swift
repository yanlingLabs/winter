import Foundation

/// What a line shows about one node, compared facet by facet when diffing.
public struct CUNodeFacets: Sendable, Equatable {
    public var role: String
    public var name: String?
    /// The value as printed (`<redacted>` for secure fields), so a secure field's change never leaks.
    public var value: String?
    public var states: [String]
    public var items: Int?
    public var actions: [String]
    /// The full line, used for `+` entries.
    public var line: String
}

/// One stored observation of a target: the tree, plus per-ref facets for diffing. The helper keeps the
/// last 8 per target (spine §2.1).
public struct CUSnapshot: Sendable {
    public let id: String
    /// `within` ref the snapshot was scoped to; diffs only compare snapshots of the same scope.
    public let scope: Int?
    public let header: CUStateHeader
    public let roots: [CUNode]
    public let facets: [Int: CUNodeFacets]
    /// Refs in depth-first order.
    public let order: [Int]
    /// Each ref's parent ref (a root has none): the context a diff line gives an element the model has not seen.
    public let parents: [Int: Int]
    /// The refs whose own line the model has SEEN for this snapshot — the folded print's lines, or a diff's lines on top
    /// of what its base had shown. Nil: everything in it (a state printed whole, or one made without the print).
    public var shown: Set<Int>?

    public init(id: String, scope: Int?, header: CUStateHeader, roots: [CUNode],
                formatter: CUStateFormatter = CUStateFormatter(), shown: Set<Int>? = nil) {
        self.id = id
        self.scope = scope
        self.header = header
        self.roots = roots
        self.shown = shown
        var parents: [Int: Int] = [:]
        func link(_ n: CUNode) {
            for c in n.children {
                if parents[c.ref] == nil { parents[c.ref] = n.ref }
                link(c)
            }
        }
        roots.forEach(link)
        self.parents = parents
        var facets: [Int: CUNodeFacets] = [:]
        var order: [Int] = []
        for root in roots {
            for n in root.flattened() where facets[n.ref] == nil {
                order.append(n.ref)
                facets[n.ref] = CUNodeFacets(
                    role: n.roleWords,
                    name: n.name.map { formatter.cut($0) },
                    value: formatter.renderedValue(n),
                    states: n.states.words,
                    items: n.itemCount,
                    actions: CURoleWords.extraActions(n.actions),
                    line: formatter.line(n))
            }
        }
        self.facets = facets
        self.order = order
    }

    public var allNodes: [CUNode] { roots.flatMap { $0.flattened() } }
}

/// A diff between two snapshots of one target (spine §4):
///
///     Notes — focused [14] · settled 80 ms
///     + [27] button "Delete Note"
///     ~ [14] value "milk, eggs" → "milk, eggs, bread"
///     - [13]
///
/// `changedRatio` = changed elements / elements in either snapshot. Callers fall back to the full state
/// when it exceeds 0.5.
public struct CUStateDiff: Sendable, Equatable {
    public var added: [Int]
    public var removed: [Int]
    public var modified: [Int]
    /// Per modified ref, its facet changes (`value "a" → "b"`), in a fixed facet order.
    public var changes: [Int: [String]]
    public var changedRatio: Double
    /// Refs the model had NOT seen in the base (folded, or out of view) that the state shows now — scrolled into view,
    /// or a fold that opened: printed as `+` lines, with their context, though they did not change.
    public var surfaced: [Int] = []
    /// Modified refs the model had not seen: their change is printed with the element's line and its context.
    public var unseen: Set<Int> = []

    public var isEmpty: Bool { added.isEmpty && removed.isEmpty && modified.isEmpty && surfaced.isEmpty }

    /// `shownNow`: the refs the state would show now (its folded print's lines); with the base's own `shown`, what
    /// the model had not seen and sees now is surfaced. Either nil: nothing is (everything counts as seen).
    public static func compute(old: CUSnapshot, new: CUSnapshot, shownNow: Set<Int>? = nil) -> CUStateDiff {
        let f = CUStateFormatter()
        var added: [Int] = []
        var modified: [Int] = []
        var changes: [Int: [String]] = [:]
        for ref in new.order {
            guard let n = new.facets[ref] else { continue }
            guard let o = old.facets[ref] else { added.append(ref); continue }
            var c: [String] = []
            if o.role != n.role { c.append("role \(o.role) → \(n.role)") }
            if o.name != n.name { c.append("name \(show(o.name, f)) → \(show(n.name, f))") }
            if o.value != n.value { c.append("value \(o.value ?? "none") → \(n.value ?? "none")") }
            if o.states != n.states {
                c.append("states (\(o.states.joined(separator: ", "))) → (\(n.states.joined(separator: ", ")))")
            }
            if o.items != n.items { c.append("items \(o.items.map(String.init) ?? "none") → \(n.items.map(String.init) ?? "none")") }
            if o.actions != n.actions {
                let a = o.actions.isEmpty ? "none" : o.actions.joined(separator: ", ")
                let b = n.actions.isEmpty ? "none" : n.actions.joined(separator: ", ")
                c.append("actions \(a) → \(b)")
            }
            if !c.isEmpty { modified.append(ref); changes[ref] = c }
        }
        let newRefs = Set(new.order)
        let removed = old.order.filter { !newRefs.contains($0) }
        var surfaced: [Int] = []
        var unseen = Set<Int>()
        if let seen = old.shown {
            unseen = Set(modified.filter { !seen.contains($0) })
            if let now = shownNow {
                let changedRefs = Set(modified)
                surfaced = new.order.filter { now.contains($0) && old.facets[$0] != nil && !seen.contains($0) && !changedRefs.contains($0) }
            }
        }
        let union = Set(old.order).union(newRefs).count
        let changed = added.count + removed.count + modified.count + surfaced.count
        let ratio = union == 0 ? 0 : Double(changed) / Double(union)
        var d = CUStateDiff(added: added, removed: removed, modified: modified, changes: changes,
                            changedRatio: min(1, ratio))
        d.surfaced = surfaced
        d.unseen = unseen
        return d
    }

    /// What the model has seen once this diff is printed: the base's shown refs still there, plus every line it prints.
    public func shownAfter(old: CUSnapshot, new: CUSnapshot) -> Set<Int>? {
        guard let seen = old.shown else { return nil }
        let newRefs = Set(new.order)
        return seen.intersection(newRefs).union(added).union(surfaced).union(modified)
    }

    /// `[p] role "name"` for the nearest ancestor of `ref` the model has seen (the base's shown refs), for a line the
    /// model has no context for; nil when none is known.
    private func context(_ ref: Int, new: CUSnapshot, seen: Set<Int>?, _ f: CUStateFormatter) -> String? {
        var cur = new.parents[ref]
        while let p = cur {
            if seen?.contains(p) ?? true, let facets = new.facets[p] {
                return "in [\(p)] \(facets.role)" + (facets.name.map { $0.isEmpty ? "" : " " + f.quote($0) } ?? "")
            }
            cur = new.parents[p]
        }
        return nil
    }

    private static func show(_ s: String?, _ f: CUStateFormatter) -> String {
        guard let s, !s.isEmpty else { return "none" }
        return f.quote(s)
    }

    /// The diff text, capped at `lineCap` change lines.
    public func render(header: CUStateHeader, new: CUSnapshot, includeWindowTitle: Bool,
                       formatter f: CUStateFormatter = CUStateFormatter(), seen: Set<Int>? = nil) -> String {
        var lines = [f.header(header, includeWindow: includeWindowTitle)]
        var body: [String] = []
        for ref in added { if let l = new.facets[ref]?.line { body.append("+ " + l) } }
        // Not changed, but new to the model: scrolled into view, or out of a fold.
        for ref in surfaced {
            guard let l = new.facets[ref]?.line else { continue }
            body.append("+ " + l + " — now shown" + (context(ref, new: new, seen: seen, f).map { ", " + $0 } ?? ""))
        }
        for ref in modified {
            var text = "~ [\(ref)] " + (changes[ref] ?? []).joined(separator: "; ")
            if unseen.contains(ref), let l = new.facets[ref]?.line {
                text += " — " + l + (context(ref, new: new, seen: seen, f).map { ", " + $0 } ?? "")
            }
            body.append(text)
        }
        for ref in removed { body.append("- [\(ref)]") }
        if body.isEmpty { body.append("(no changes)") }
        if body.count > f.lineCap {
            let more = body.count - f.lineCap
            body = Array(body.prefix(f.lineCap))
            body.append("… (\(more) more changes — state({full:true}))")
        }
        lines.append(contentsOf: body)
        return lines.joined(separator: "\n")
    }
}
