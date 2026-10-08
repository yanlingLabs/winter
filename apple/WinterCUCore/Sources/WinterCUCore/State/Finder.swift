import Foundation

/// `target.find` over an observed tree. Matching is case- and diacritic-insensitive:
/// - a string query matches an element whose name, value, role words or identifier contains it;
/// - `{role}` matches the role words or the raw AX role (`button`, `AXButton`, `text field`);
/// - `{name}` matches the name; `{text}` matches the name or the value.
/// Fields of an object query must all match. Secure values are never searched or returned.
public enum CUFinder {
    public static let maxResults = 50

    public static func find(_ query: CUFindQuery, in roots: [CUNode], formatter: CUStateFormatter = CUStateFormatter())
        -> [CUElementSummary] {
        var out: [CUElementSummary] = []
        for root in roots {
            for n in root.flattened() where matches(query, n) {
                out.append(summary(n, formatter: formatter))
                if out.count >= maxResults { return out }
            }
        }
        return out
    }

    public static func summary(_ n: CUNode, formatter: CUStateFormatter = CUStateFormatter()) -> CUElementSummary {
        let value: String? = n.isSecure ? "<redacted>" : n.value.flatMap { $0.isEmpty || $0 == n.name ? nil : formatter.cut($0) }
        return CUElementSummary(ref: n.ref, role: n.roleWords, name: n.name.flatMap { $0.isEmpty ? nil : formatter.cut($0) },
                                value: value)
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
