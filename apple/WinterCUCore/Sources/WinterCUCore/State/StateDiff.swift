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

    public init(id: String, scope: Int?, header: CUStateHeader, roots: [CUNode],
                formatter: CUStateFormatter = CUStateFormatter()) {
        self.id = id
        self.scope = scope
        self.header = header
        self.roots = roots
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

    public var isEmpty: Bool { added.isEmpty && removed.isEmpty && modified.isEmpty }

    public static func compute(old: CUSnapshot, new: CUSnapshot) -> CUStateDiff {
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
        let union = Set(old.order).union(newRefs).count
        let changed = added.count + removed.count + modified.count
        let ratio = union == 0 ? 0 : Double(changed) / Double(union)
        return CUStateDiff(added: added, removed: removed, modified: modified, changes: changes,
                           changedRatio: min(1, ratio))
    }

    private static func show(_ s: String?, _ f: CUStateFormatter) -> String {
        guard let s, !s.isEmpty else { return "none" }
        return f.quote(s)
    }

    /// The diff text, capped at `lineCap` change lines.
    public func render(header: CUStateHeader, new: CUSnapshot, includeWindowTitle: Bool,
                       formatter f: CUStateFormatter = CUStateFormatter()) -> String {
        var lines = [f.header(header, includeWindow: includeWindowTitle)]
        var body: [String] = []
        for ref in added { if let l = new.facets[ref]?.line { body.append("+ " + l) } }
        for ref in modified { body.append("~ [\(ref)] " + (changes[ref] ?? []).joined(separator: "; ")) }
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
