import Foundation

/// `target.find` over an observed tree. Matching is case- and diacritic-insensitive:
/// - a string query matches an element whose name, value, role words or identifier contains it;
/// - `{role}` matches the role words or the raw AX role (`button`, `AXButton`, `text field`);
/// - `{name}` matches the name; `{text}` matches the name or the value.
/// Fields of an object query must all match. Secure values are never searched or returned.
/// A text (a string query, or `{text}` with no `name`) also matches a run of consecutive static-text siblings read as
/// one line — `waitFor`'s rule (`textRuns`) — answering the run's element where the matched text begins.
public enum CUFinder {
    public static let maxResults = 50

    public static func find(_ query: CUFindQuery, in roots: [CUNode], formatter: CUStateFormatter = CUStateFormatter())
        -> [CUElementSummary] {
        var out: [CUElementSummary] = []
        for root in roots {
            let nodes = root.flattened()
            var hits = IndexSet(nodes.indices.filter { matches(query, nodes[$0]) })
            if let (want, role) = runQuery(query) {
                var index: [Int: Int] = [:]
                for (i, n) in nodes.enumerated() where index[n.ref] == nil { index[n.ref] = i }
                for run in textRuns(nodes) {
                    guard let start = run.matchStart(want), let i = index[run.refs[start]] else { continue }
                    if let role, !matches(.fields(role: role, name: nil, text: nil), nodes[i]) { continue }
                    hits.insert(i)
                }
            }
            for i in hits {
                out.append(summary(nodes[i], formatter: formatter))
                if out.count >= maxResults { return out }
            }
        }
        return out
    }

    /// The text a query asks runs for, normalised, and the role it also requires: a string query, or `{text}` without
    /// a `name` (a run has no name of its own). Nil for anything else.
    static func runQuery(_ q: CUFindQuery) -> (String, String?)? {
        switch q {
        case .text(let t):
            let w = norm(t)
            return w.isEmpty ? nil : (w, nil)
        case .fields(let role, let name, let text):
            guard name == nil, let text else { return nil }
            let w = norm(text)
            return w.isEmpty ? nil : (w, role)
        }
    }

    /// Folded, with every run of whitespace one space.
    static func norm(_ s: String) -> String {
        fold(s).split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// A run of consecutive static-text siblings (two or more), read as one line.
    struct TextRun {
        var refs: [Int]
        var pieces: [String]

        /// The line, joined as the pieces are and joined with spaces (both normalised).
        func lines(_ r: ClosedRange<Int>) -> [String] {
            let p = pieces[r]
            return [CUFinder.norm(p.joined()), CUFinder.norm(p.joined(separator: " "))]
        }

        func contains(_ want: String) -> Bool { lines(0...(pieces.count - 1)).contains { $0.contains(want) } }

        /// The index of the piece where the FIRST occurrence of `want` that spans two or more pieces begins; nil when
        /// none does (a phrase inside one piece is that element's own match). The first piece whose prefix of the run
        /// holds it is where it ends; the last start from which it still holds up to there is where it begins.
        func matchStart(_ want: String) -> Int? {
            guard contains(want) else { return nil }
            guard let end = pieces.indices.first(where: { j in lines(0...j).contains { $0.contains(want) } }) else { return nil }
            guard let start = (0...end).last(where: { i in lines(i...end).contains { $0.contains(want) } }), start < end
            else { return nil }
            return start
        }
    }

    /// Every run of consecutive static-text siblings: the text a page shows in pieces. Measured on the Chrome Web Store
    /// dashboard (2026-10-14): its "Status: Published - public" is five static texts ("Status:", " ", "Published",
    /// " - ", "public"), so "Status: Published" matched no single element. Only static text joins — a run never spans a
    /// link, a button or a field, so unrelated controls side by side never read as one sentence — and a secure element
    /// ends a run, never part of one. A piece is the element's value (its text as shown, spaces kept) or its name.
    static func textRuns(_ nodes: [CUNode]) -> [TextRun] {
        var out: [TextRun] = []
        for parent in nodes where parent.children.count > 1 {
            var run = TextRun(refs: [], pieces: [])
            func flush() {
                if run.pieces.count > 1 { out.append(run) }
                run = TextRun(refs: [], pieces: [])
            }
            for c in parent.children {
                guard c.role == "AXStaticText", !c.isSecure, let piece = c.value ?? c.name else { flush(); continue }
                run.refs.append(c.ref)
                run.pieces.append(piece)
            }
            flush()
        }
        return out
    }

    public static func summary(_ n: CUNode, formatter: CUStateFormatter = CUStateFormatter()) -> CUElementSummary {
        // A long value is cut, and says how long it is and where it reads whole (round 13's queue, item 2 of round 14).
        let value: String? = n.isSecure ? "<redacted>" : n.value.flatMap { v in
            if v.isEmpty || v == n.name { return nil }
            guard v.count > formatter.valueCap else { return v }
            return formatter.cut(v) + " (\(v.count) characters — \(CUStateFormatter.wholeHint(ref: n.ref, count: v.count)))"
        }
        let words = n.states.words
        return CUElementSummary(ref: n.ref, role: n.roleWords, name: n.name.flatMap { $0.isEmpty ? nil : formatter.cut($0) },
                                value: value, states: words.isEmpty ? nil : words)
    }

    public static func matches(_ query: CUFindQuery, _ n: CUNode) -> Bool {
        let value = n.isSecure ? nil : n.value
        switch query {
        case .text(let q):
            let q = fold(q)
            guard !q.isEmpty else { return false }
            return [n.name, value, n.roleWords, n.identifier].contains { $0.map { fold($0).contains(q) } ?? false }
        case .fields(let role, let name, let text):
            if role == nil && name == nil && text == nil { return false }
            if let role {
                let r = fold(role)
                let words = fold(n.roleWords)
                let raw = fold(n.role)
                let sub = n.subrole.map(fold)
                guard words == r || raw == r || sub == r || CURoleWords.split(role).lowercased() == words
                else { return false }
            }
            if let name {
                guard let have = n.name, fold(have).contains(fold(name)) else { return false }
            }
            if let text {
                let t = fold(text)
                guard [n.name, value].contains(where: { $0.map { fold($0).contains(t) } ?? false }) else { return false }
            }
            return true
        }
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
