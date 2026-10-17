import CoreGraphics
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

    /// A run of consecutive static-text siblings (two or more) on one visual line, read as one line.
    struct TextRun {
        var refs: [Int]
        /// The pieces folded and joined — at a boundary with no whitespace on either side, a space unless their frames
        /// show them touching on one line (one word in two pieces: "$" + "12.99", a highlighted "Pub" + "lished"), so
        /// separate words never glue — with every run of whitespace one space and none at the ends. One pass.
        var line: String
        /// Where each piece begins in `line`, in unicode scalars (non-decreasing; a piece that is only whitespace begins
        /// where the space it folded into does).
        var starts: [Int]

        init(refs: [Int], pieces: [String], frames: [CGRect?] = []) {
            self.refs = refs
            var out = String.UnicodeScalarView()
            var count = 0
            var pendingSpace = false
            var starts: [Int] = []
            starts.reserveCapacity(pieces.count)
            for (k, raw) in pieces.enumerated() {
                let piece = raw.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
                // Two pieces with no whitespace between them are two words — a space between, never glued — unless they
                // touch on one line: then they are one word split in two.
                if k > 0, let f = piece.unicodeScalars.first, !f.properties.isWhitespace,
                   let l = pieces[k - 1].unicodeScalars.last, !l.properties.isWhitespace,
                   !CUFinder.touching(k - 1 < frames.count ? frames[k - 1] : nil, k < frames.count ? frames[k] : nil) {
                    pendingSpace = true
                }
                var began = false
                for u in piece.unicodeScalars {
                    if u.properties.isWhitespace { pendingSpace = true; continue }
                    if pendingSpace, count > 0 { out.append(" "); count += 1 }
                    pendingSpace = false
                    if !began { starts.append(count); began = true }
                    out.append(u)
                    count += 1
                }
                if !began { starts.append(count) }
            }
            line = String(out)
            self.starts = starts
        }

        func contains(_ want: String) -> Bool { line.contains(want) }

        /// The index of the piece where the FIRST occurrence of `want` (normalised: no space at its ends) begins, when
        /// it spans two or more pieces; nil when there is none or it sits inside one piece (that element's own match).
        /// Linear: one search of `line`, then a binary search of `starts` for each end of the match.
        func matchStart(_ want: String) -> Int? {
            guard !want.isEmpty, let r = line.range(of: want) else { return nil }
            let scalars = line.unicodeScalars
            let lo = scalars.distance(from: scalars.startIndex, to: r.lowerBound)
            let hi = scalars.distance(from: scalars.startIndex, to: r.upperBound) - 1
            // The last piece beginning at or before `offset`: the one whose text is there (both ends of a normalised
            // match are text, never a space a whitespace-only piece stands for).
            func piece(at offset: Int) -> Int {
                var a = 0, b = starts.count - 1, found = 0
                while a <= b {
                    let m = (a + b) / 2
                    if starts[m] <= offset { found = m; a = m + 1 } else { b = m - 1 }
                }
                return found
            }
            let first = piece(at: lo), last = piece(at: hi)
            return first == last ? nil : first
        }
    }

    /// Two pieces read as one line: both frames known, overlapping vertically (or with near-equal middles), the next
    /// beginning to the right of the previous one — or continuing the last line of a previous piece that wrapped (it is
    /// taller than one line and the next sits on its bottom line). Block elements stacked one under the other never do.
    static func sameLine(_ prev: CGRect?, _ next: CGRect?, container: CGRect? = nil) -> Bool {
        guard let p = prev, let n = next, p.height > 0, n.height > 0 else { return false }
        let overlap = min(p.maxY, n.maxY) - max(p.minY, n.minY)
        let lineHeight = min(p.height, n.height)
        let tol: CGFloat = 2
        let onOneLine = overlap >= lineHeight * 0.5 || abs(p.midY - n.midY) <= lineHeight * 0.25
        let nextWraps = n.height > p.height * 1.5, prevWraps = p.height > n.height * 1.5
        if onOneLine, !prevWraps, !nextWraps { return n.minX >= p.maxX - tol }
        // A wrapped previous piece: the next one continues on its bottom line.
        if prevWraps { return n.midY >= p.maxY - n.height && n.midY <= p.maxY + tol }
        // A wrapping next piece ("Note:" + a long value): it begins on the previous piece's line, to its right, and
        // flows on — its box starts on that line and reaches past the previous piece.
        if nextWraps { return abs(n.minY - p.minY) <= p.height * 0.5 && n.maxX > p.maxX }
        // The line broke between the two: the next begins the next line at the container's left edge, right under
        // the previous one, which ended near its right edge. Left-to-right only (no text direction is read: a
        // right-to-left wrap stays two lines).
        if let c = container, c.width > 0 {
            let gap = n.minY - p.maxY
            return gap >= -tol && gap <= lineHeight * 0.5
                && n.minX <= c.minX + tol && p.maxX >= c.maxX - lineHeight * 3
        }
        return false
    }

    /// Two pieces touching on one line: one word in two pieces (the next begins within 1.5 pt of the previous's end).
    static func touching(_ prev: CGRect?, _ next: CGRect?) -> Bool {
        guard let p = prev, let n = next, p.height > 0, n.height > 0 else { return false }
        let overlap = min(p.maxY, n.maxY) - max(p.minY, n.minY)
        return overlap >= min(p.height, n.height) * 0.5 && abs(n.minX - p.maxX) <= 1.5
    }

    /// Every run of consecutive static-text siblings on one visual line: the text a page shows in pieces. Measured on
    /// the Chrome Web Store dashboard (2026-10-14): its "Status: Published - public" is five static texts ("Status:",
    /// " ", "Published", " - ", "public"), so "Status: Published" matched no single element. Only static text joins — a
    /// run never spans a link, a button or a field, so unrelated controls side by side never read as one sentence — a
    /// secure element ends a run, never part of one, and pieces join only when their frames put them on one line (the
    /// reader folds wrapper groups away, so block paragraphs and log lines are siblings too: they never join). A piece
    /// with no frame joins nothing, except one that is only whitespace (Chrome's " " between two texts), which never
    /// decides a join. A piece is the element's value (its text as shown, spaces kept) or its name.
    static func textRuns(_ nodes: [CUNode]) -> [TextRun] {
        var out: [TextRun] = []
        for parent in nodes where parent.children.count > 1 {
            var refs: [Int] = []
            var pieces: [String] = []
            var frames: [CGRect?] = []
            var lastFrame: CGRect?
            var hasText = false
            func flush() {
                if pieces.count > 1 { out.append(TextRun(refs: refs, pieces: pieces, frames: frames)) }
                refs.removeAll(); pieces.removeAll(); frames.removeAll(); lastFrame = nil; hasText = false
            }
            for c in parent.children {
                guard c.role == "AXStaticText", !c.isSecure, let piece = c.value ?? c.name else { flush(); continue }
                let blank = piece.allSatisfy(\.isWhitespace)
                if !blank {
                    if hasText, !sameLine(lastFrame, c.frame, container: parent.frame) { flush() }
                    hasText = true
                    lastFrame = c.frame
                }
                refs.append(c.ref)
                pieces.append(piece)
                frames.append(c.frame)
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
