import Foundation

/// diff-tabs Task 10: what one line of a rendered diff IS.
///
/// Deliberately five cases rather than three: the two NON-line rows (`hunkSeparator`,
/// `truncatedBanner`) are things the renderer must DRAW — a thin rule, a banner — and modelling them
/// as rows keeps `PanelDiffTab`'s `LazyVStack` a single homogeneous list instead of a list plus a
/// side-channel of "and there was a gap after row 7".
enum DiffRowKind: Equatable {
    /// An unchanged line — present in both files, carries both numbers.
    case context
    /// A `+` line: new file only.
    case added
    /// A `-` line: old file only.
    case removed
    /// A `@@ …` header. Carries no numbers of its own (the rows AFTER it carry them); its `text` is
    /// the raw header line, and the renderer draws a rule rather than that text (design spec § 4).
    case hunkSeparator
    /// The daemon's `[patch truncated]` marker (`packages/core/src/diffs/store.ts`'s
    /// `TRUNCATION_MARKER`) — the patch was cut at 1 MiB and what follows is missing.
    case truncatedBanner
}

/// One row of a parsed unified diff. `oldLine`/`newLine` are 1-based file line numbers, `nil` on the
/// side the row does not exist on (`added` has no old line; `removed` has no new one) and on both
/// sides for the two non-line kinds.
///
/// `text` is the line WITHOUT its `+`/`-`/space marker — the marker is `kind`, and a renderer that
/// wants to print one derives it. For `hunkSeparator` and `truncatedBanner` it is the raw source
/// line, kept verbatim: prettifying is presentation, and a parser that swallowed the original would
/// leave a test unable to say WHICH header it parsed.
struct DiffRow: Equatable {
    let kind: DiffRowKind
    let oldLine: Int?
    let newLine: Int?
    let text: String
}

/// diff-tabs Task 10: the unified-diff parser — **pure, total, and non-throwing**.
///
/// Its input is exactly what `computeLineDiff` (`packages/core/src/diffs/myers.ts`) emits and the
/// diff store persists: **hunk sections only**, no `---`/`+++` file header (the store's own header
/// line owns file metadata, and `panel.readDiff` returns `path` beside the patch rather than inside
/// it). Every rule below was verified against that emitter's real output rather than against the
/// unified-diff format in the abstract — see `DiffParserTests`' `realEmitterOutput` fixture, which is
/// a patch this repo's own Myers module printed.
///
/// **Total by construction: there is no failure mode and no thrown error.** A diff tab's whole job is
/// to show what the daemon stored; a parser that could refuse would turn a cosmetic malformation
/// into the calm-but-empty "Diff unavailable" state, which is reserved for "the patch is GONE"
/// (`PanelDiffTabModel`). So every unrecognised line is DROPPED and parsing continues — the
/// defensive choice documented at each site below.
enum UnifiedDiffParser {
    /// The daemon's marker, byte for byte (`store.ts`'s `TRUNCATION_MARKER`, minus its newline).
    /// A body line can never collide with it: every line the emitter writes inside a hunk starts
    /// with a space, `-`, `+` or `\`.
    static let truncationMarker = "[patch truncated]"

    /// `@@ -a[,b] +c[,d] @@`. The counts are optional purely defensively — this emitter always
    /// writes them — and an omitted count means 1, per the unified-diff format.
    private static let hunkHeaderPattern = try? NSRegularExpression(
        pattern: #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@"#)

    /// Parse a patch into rows, in order.
    ///
    /// The counter rules, all three confirmed against the real emitter:
    ///
    ///  - `@@ -a,b +c,d @@` opens a hunk: the old counter starts at `a`, the new at `c`.
    ///  - **A ZERO count means "the other side inserted HERE", and its counter starts at `start + 1`**
    ///    — `-a,0` positions an insertion AFTER old line `a` (the emitter's real
    ///    `@@ -2,0 +3,2 @@` inserts two lines after old line 2), and `+c,0` mirrors it for a
    ///    deletion (`@@ -2,2 +1,0 @@` deletes old lines 2-3, which sat after new line 1). The
    ///    adjusted counter is never actually CONSUMED — a zero count means that side contributes no
    ///    rows to the hunk — so this rule is about being right rather than about being visible, and
    ///    it is pinned that way (`testAnInsertionOnlyHunkNumbersTheNewSideAndLeavesTheOldSideNil`).
    ///  - `\ No newline at end of file` is METADATA about the line before it: dropped from the row
    ///    list entirely (the renderer shows nothing for it), and it advances no counter. The row it
    ///    describes is already emitted and stays.
    static func parse(_ patch: String) -> [DiffRow] {
        var rows: [DiffRow] = []
        // `nil` means "no hunk is open" — body lines before the first header have no numbering to
        // belong to and are dropped (see the `guard` below).
        var oldCounter: Int?
        var newCounter: Int?

        // `omittingEmptySubsequences: false` keeps interior blank lines addressable; the trailing
        // empty component every `"…\n"` patch ends with is dropped by the empty-line guard below,
        // which is the same door garbage takes.
        for rawLine in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)

            if line == truncationMarker {
                rows.append(DiffRow(kind: .truncatedBanner, oldLine: nil, newLine: nil, text: line))
                continue
            }

            if line.hasPrefix("@@") {
                guard let header = parseHunkHeader(line) else {
                    // A `@@` line that does not parse CLOSES the hunk rather than leaving the old
                    // counters running: the numbers after an unreadable header are unknowable, and
                    // rows numbered from the PREVIOUS hunk would be confidently wrong — worse than
                    // absent. Body lines are then dropped until a header that does parse.
                    oldCounter = nil
                    newCounter = nil
                    continue
                }
                oldCounter = header.oldStart
                newCounter = header.newStart
                rows.append(DiffRow(kind: .hunkSeparator, oldLine: nil, newLine: nil, text: line))
                continue
            }

            guard var old = oldCounter, var new = newCounter, let marker = line.first else {
                // No open hunk, or an empty line (including the trailing split artifact). Dropped.
                continue
            }
            let text = String(line.dropFirst())

            switch marker {
            case " ":
                rows.append(DiffRow(kind: .context, oldLine: old, newLine: new, text: text))
                old += 1
                new += 1
            case "-":
                rows.append(DiffRow(kind: .removed, oldLine: old, newLine: nil, text: text))
                old += 1
            case "+":
                rows.append(DiffRow(kind: .added, oldLine: nil, newLine: new, text: text))
                new += 1
            case "\\":
                // `\ No newline at end of file` — metadata, dropped, counters untouched.
                continue
            default:
                // GARBAGE inside a hunk: dropped, and **the counters do not advance**. Advancing
                // would misnumber every remaining row in the hunk (a permanent, silent, off-by-N
                // lie about the file); dropping costs exactly the unrenderable line itself.
                continue
            }
            oldCounter = old
            newCounter = new
        }
        return rows
    }

    private static func parseHunkHeader(_ line: String) -> (oldStart: Int, newStart: Int)? {
        guard let regex = hunkHeaderPattern else { return nil }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = regex.firstMatch(in: line, range: range) else { return nil }

        func number(_ index: Int) -> Int? {
            guard let r = Range(match.range(at: index), in: line) else { return nil }
            return Int(line[r])
        }
        guard let oldStart = number(1), let newStart = number(3) else { return nil }
        // An absent count is 1 (format default), never 0 — only a written `,0` triggers the
        // insertion-point adjustment.
        let oldCount = number(2) ?? 1
        let newCount = number(4) ?? 1
        return (oldStart: oldCount == 0 ? oldStart + 1 : oldStart,
                newStart: newCount == 0 ? newStart + 1 : newStart)
    }
}
