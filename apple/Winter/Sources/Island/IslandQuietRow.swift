import SwiftUI

// The island's tab rows (`docs/claude/island.md`, "Island visual language" — user 2026-10-19: SHARED LANGUAGE, OWN
// SHAPES). Every tab speaks the usage plan block's language — no box behind anything, typography carrying the hierarchy
// (a clear white title over muted words, figures in the light tiny digits), one accent per source used sparingly, quiet
// at rest and LIFTING under the pointer (the title grows 12 % from its leading edge and the details and actions appear,
// on the Dispatch pill's spring, so what is below glides) — but each kind of data keeps the shape that fits it: a status
// dot, a glyph, a logo, words. A line only where there is a real amount (a plan window, a session's context, a
// watch's time left, the cost split by model), never a decorative bar. Actions and links are words, like the usage
// block's "Open usage ↗" (no filled capsule); a group is titled like a plan (no letter-spaced caps).

enum IslandQuietRow {
    /// From the island's edge to a row: the header's own inset — the usage block's left edge too.
    static let inset: CGFloat = IslandLayout.headerInset
    /// The mark's column (a status dot, a glyph, a logo) and the gap after it: every tab's titles start at one x.
    static let markWidth: CGFloat = 18
    static let markGap: CGFloat = 8
    /// Where a row's words start, from its leading edge.
    static var textLeading: CGFloat { markWidth + markGap }
    /// The title line's band: the title grown 12 % (`HoverLift.labelScale`) still fits.
    static let titleHeight: CGFloat = 20
    /// Between the title line and a line under it.
    static let lineGap: CGFloat = 1
    /// Between rows.
    static let rowGap: CGFloat = 6
    /// A row's lift: the room the grown title takes above and below it (the row grows on the spring, what is below
    /// glides).
    static func liftPadding(hovered: Bool) -> CGFloat { hovered ? 2 : 0 }
    /// After the grown title, so it never runs into the words beside it.
    static func titleTrailing(hovered: Bool) -> CGFloat { hovered ? 14 : 0 }
    /// A status dot, and a hollow one.
    static let dotSize: CGFloat = 7

    /// The title: a clear medium face, the usage block's scale (its plan names are the caption step, its lines the tiny
    /// one; a row's title sits one step above both).
    static var titleFont: Font { Typography.label(.medium) }
    /// Muted words: beside the title, and the lines under it.
    static var wordsFont: Font { Typography.tiny() }

    /// PURE: a title's ink — white, a touch brighter under the pointer; quieter for something that is over.
    static func titleOpacity(hovered: Bool, quiet: Bool = false) -> Double {
        hovered ? 1 : (quiet ? 0.65 : 0.92)
    }

    /// PURE: whether a row's actions show — under the pointer, or while one of them is in the middle of something (a
    /// Stop waiting for its second click, stopping, offering a force quit) or has failed: those never hide when the
    /// pointer drifts off.
    static func showsActions(hovered: Bool, busy: Bool) -> Bool { hovered || busy }
}

/// A tab's row: its mark, its title (lifting under the pointer) with muted words beside it, what trails the title line
/// (a status, a chevron), and the lines under it — a note worth scanning at rest, the details and actions the pointer
/// reveals. No surface: the row floats on the island's black.
struct IslandLiftRow<Mark: View, Trailing: View, Below: View>: View {
    let title: String
    /// Muted words right after the title (a folder, "2 servers"), cut at their head when the row is short of room.
    var side: String? = nil
    var titleLines = 1
    /// Something that is over (a finished session): its title is quieter.
    var quiet = false
    let hovered: Bool
    @ViewBuilder let mark: () -> Mark
    @ViewBuilder let trailing: () -> Trailing
    @ViewBuilder let below: () -> Below

    var body: some View {
        HStack(alignment: .top, spacing: IslandQuietRow.markGap) {
            mark()
                .frame(width: IslandQuietRow.markWidth, height: IslandQuietRow.titleHeight)
            VStack(alignment: .leading, spacing: IslandQuietRow.lineGap) {
                HStack(alignment: titleLines > 1 ? .firstTextBaseline : .center, spacing: 8) {
                    Text(title)
                        .font(IslandQuietRow.titleFont)
                        .foregroundStyle(Color.white.opacity(IslandQuietRow.titleOpacity(hovered: hovered, quiet: quiet)))
                        .lineLimit(titleLines)
                        .truncationMode(.tail)
                        .fixedSize(horizontal: false, vertical: titleLines > 1)
                        .hoverLiftLabel(hovered, anchor: titleLines > 1 ? .topLeading : .leading)
                        .padding(.trailing, IslandQuietRow.titleTrailing(hovered: hovered))
                        .layoutPriority(1)
                    if let side {
                        Text(side)
                            .font(IslandQuietRow.wordsFont)
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    Spacer(minLength: 8)
                    trailing()
                }
                .frame(minHeight: IslandQuietRow.titleHeight)
                below()
            }
        }
        .padding(.vertical, IslandQuietRow.liftPadding(hovered: hovered))
        .contentShape(Rectangle())
    }
}

/// A line of muted words under a row's title (its details, or a note), with what trails it (an action, ↗).
struct IslandRowWords<Trailing: View>: View {
    let text: String
    var color: Color = Theme.textMuted
    /// Content that must not vanish (a device's reason) may take a second line; it is cut at its tail past that.
    var lines = 1
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 8) {
            Text(text)
                .font(IslandQuietRow.wordsFont)
                .foregroundStyle(color)
                .lineLimit(lines)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: lines > 1)
            Spacer(minLength: 8)
            trailing()
        }
        .frame(minHeight: 16)
    }
}

extension IslandRowWords where Trailing == EmptyView {
    init(text: String, color: Color = Theme.textMuted, lines: Int = 1) {
        self.init(text: text, color: color, lines: lines) { EmptyView() }
    }
}

// MARK: - Marks

/// A row's status mark: a dot in its source's (or state's) colour, a hollow ring for something at rest, or a small glyph.
enum IslandStatusMark: Equatable {
    case dot(Color)
    case ring(Color)
    case glyph(String, Color)
}

struct IslandStatusMarkView: View {
    let mark: IslandStatusMark

    var body: some View {
        switch mark {
        case .dot(let color):
            Circle().fill(color).frame(width: IslandQuietRow.dotSize, height: IslandQuietRow.dotSize)
        case .ring(let color):
            Circle().stroke(color, lineWidth: 1.4)
                .frame(width: IslandQuietRow.dotSize - 0.5, height: IslandQuietRow.dotSize - 0.5)
        case .glyph(let symbol, let color):
            Image(systemName: symbol).font(Typography.tiny(.bold)).foregroundStyle(color)
        }
    }
}

/// A status as a small dot and a word ("● Connected", "● Running · 1.4.0") — what trails a device's or a server's title.
struct IslandStatusWord: View {
    let mark: IslandStatusMark
    var word: String? = nil

    var body: some View {
        HStack(spacing: 5) {
            IslandStatusMarkView(mark: mark)
            if let word, !word.isEmpty {
                Text(word)
                    .font(Typography.tinyDigits())
                    .foregroundStyle(Theme.textMuted)
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - Group titles, links, actions

/// A group's title, the plan header's own (user 2026-10-19, the third pass: shared language, own shapes): a clear name
/// in the plan names' face, and on the far right what it is from or how many, muted — never a letter-spaced caps label.
struct IslandGroupTitle: View {
    let title: String
    var meta: String? = nil
    /// What the meta says in a colour of its own (a limit reached, amber); nil = muted.
    var metaColor: Color? = nil

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(Typography.caption(.semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let meta, !meta.isEmpty {
                Text(meta)
                    .font(Typography.tiny())
                    .foregroundStyle(metaColor ?? Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .frame(minHeight: 18)
    }
}

/// The height of a row's small things — its link, its ports, its action — on the title line or the line under it.
enum IslandRowSmall {
    static let height: CGFloat = 18
}

/// A link as words, the usage block's "Open usage ↗": brighter than the words around it, an arrow after it.
struct IslandLinkWords: View {
    let text: String

    var body: some View {
        HStack(spacing: 3) {
            Text(text).font(Typography.tinyDigits(.medium))
            Image(systemName: "arrow.up.right").font(Typography.micro(.bold))
        }
        .foregroundStyle(Color.white.opacity(0.92))
        .lineLimit(1)
        .frame(height: IslandRowSmall.height)
    }
}

/// How a row's action reads: words, never a filled capsule — coloured only while the colour means something (a click
/// away from stopping: amber; from force quitting: red), muted while it is working.
enum IslandActionTone: Equatable {
    case plain, confirm, danger, busy

    /// PURE: the words' ink — a plain action brightens under the pointer.
    func ink(hovered: Bool) -> Color {
        switch self {
        case .plain: return Color.white.opacity(hovered ? 1 : 0.82)
        case .confirm: return pillReviewAmber
        case .danger: return Color(nsColor: .systemRed)
        case .busy: return Theme.textMuted
        }
    }
}

/// A row's action as words — Stop and its phases, a watch's Stop — on the line it ends.
struct IslandRowActionButton: View {
    let title: String
    var tone: IslandActionTone = .plain
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            IslandPointerReader { hovered in
                Text(title)
                    .font(Typography.tiny(.semibold))
                    .foregroundStyle(tone.ink(hovered: hovered && enabled))
                    .lineLimit(1)
                    .padding(.horizontal, 3)
                    .frame(height: IslandRowSmall.height)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(IslandPressStyle())
        .disabled(!enabled)
    }
}
