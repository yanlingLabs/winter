import SwiftUI

// -----------------------------------------------------------------------------------------------
// The Library panel's shared detail-side chrome (2026-09-17).
//
// Three of the five tabs (Hooks, MCP tools, Agents) are waiting on daemon work that is NOT in this
// session's hands, and the whole point of building them now is that the waiting must READ as
// waiting — never as an empty list, and never as a broken one. "No hooks" and "the daemon cannot
// tell us about hooks yet" are different facts about the world, and a user who cannot tell them
// apart will file the second as a bug against the first.
//
// So the pending state is a real, named component rather than a `Text("TODO")` per tab: one
// vocabulary, one look, and — crucially — one place that carries the sentence naming WHAT each tab
// is blocked on. When the daemon lands its half, the tab deletes its `LibraryPendingNote` and feeds
// the list it already renders; nothing else about the tab changes.
//
// Everything here is Typography/Theme tokens only (the `TypographyTests` sweep is recursive over
// `Sources/`, so a raw `.font(.headline)` anywhere in this directory reds the suite).
// -----------------------------------------------------------------------------------------------

/// The detail side's outer padding. One constant rather than a per-tab number so the five tabs
/// line up with each other along the divider — the panel is small enough that a 4 pt difference
/// between tabs reads as a rendering glitch when you click between them.
let libraryDetailPadding: CGFloat = 18

/// The gap between a detail tab's header and its body.
let libraryDetailSpacing: CGFloat = 12

/// A tab's own header: the tab name, plus whatever trailing control the tab owns (a Refresh
/// button, usually).
///
/// The floating panel's chrome already says "Library" — this says which of the five you are
/// looking at. Repeating the tab name from the column is deliberate: the column is a 176 pt strip
/// of five words and the eye does not reliably carry which one is lit across the divider.
struct LibraryTabHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(Typography.paneTitle)
            Spacer(minLength: 8)
            trailing()
        }
    }
}

extension LibraryTabHeader where Trailing == EmptyView {
    init(title: String) {
        self.init(title: title, trailing: { EmptyView() })
    }
}

/// The honest "this half is not reportable yet" state.
///
/// `waitingOn` is the load-bearing field: it names the MISSING PIECE in the daemon's own
/// vocabulary (the RPC, or the schema field) rather than saying "coming soon". A user reading it
/// learns something true about why the list is empty; a maintainer reading it learns exactly which
/// landing unblocks the tab. Both audiences are served by the same sentence, which is why there is
/// only one.
struct LibraryPendingNote: View {
    /// What the tab WILL show — written as the fact, not as a promise ("Hooks declared by an
    /// installed plugin", not "Hooks will appear here").
    let subject: String
    /// The daemon-side thing that has to land first, named concretely.
    let waitingOn: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "clock")
                .font(Typography.label())
                .foregroundStyle(Theme.textMuted)
            VStack(alignment: .leading, spacing: 3) {
                Text(subject)
                    .font(Typography.label())
                    .foregroundStyle(Theme.textSecondary)
                Text(waitingOn)
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                .fill(Theme.rowHover)
        )
    }
}

/// A quiet one-line annotation under a list — the place a tab explains a rule the rows themselves
/// cannot ("the only toggle here is the plugin's own"). Distinct from `LibraryPendingNote`: this
/// describes SHIPPED behaviour, so it wears no clock and no fill.
struct LibraryFootnote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Typography.caption())
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A group heading inside a detail list (a plugin's name over its hooks, a source over its
/// servers). The same uppercase-caption treatment `DashboardSurface`'s own group headers wear, so
/// the two surfaces read as one app.
struct LibraryGroupHeader: View {
    let title: String
    /// The quiet right-hand fact — a count, a status word. Empty renders nothing.
    var detail: String = ""

    var body: some View {
        HStack(spacing: 6) {
            Text(title.uppercased())
                .font(Typography.tiny(.semibold))
                .foregroundStyle(Theme.textMuted)
            Spacer(minLength: 4)
            if !detail.isEmpty {
                Text(detail)
                    .font(Typography.tiny())
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .padding(.horizontal, 8)
    }
}

/// One non-interactive list row inside a tab — the shape every tab's rows share.
///
/// Rendered through `ShellSidebarRowStyle` on a `Button` with no action rather than a bare
/// `HStack`, deliberately: the panel sets `shellRowFillIsVibrant = false`, so this picks up the
/// OPAQUE hover grey and every row in the panel (including the tab column's own) hovers
/// identically. A row that does not hover in a surface where its neighbours do reads as disabled.
struct LibraryRow<Trailing: View>: View {
    let systemImage: String
    let title: String
    /// The second line. Empty renders a single-line row rather than a blank gap.
    var subtitle: String = ""
    /// Monospaced subtitle — for a wire name or a shell command, where character alignment is the
    /// whole point of reading it.
    var subtitleIsMono: Bool = false
    /// The row's ink. `nil` takes the primary text tone; an error row passes `.red` (the same
    /// semantic style `SkillsPane`/`PluginManagerView` already use for their error lines).
    var tint: Color?
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(Typography.label())
                .foregroundStyle(tint ?? Theme.textMuted)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typography.control())
                    .foregroundStyle(tint ?? Theme.textPrimary)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(subtitleIsMono ? Typography.captionMono() : Typography.caption())
                        .foregroundStyle(Theme.textMuted)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }
}

extension LibraryRow where Trailing == EmptyView {
    init(systemImage: String, title: String, subtitle: String = "",
         subtitleIsMono: Bool = false, tint: Color? = nil) {
        self.init(systemImage: systemImage, title: title, subtitle: subtitle,
                  subtitleIsMono: subtitleIsMono, tint: tint, trailing: { EmptyView() })
    }
}

/// The small trailing status word a row can carry (a server's `running`, a plugin's `Disabled`).
struct LibraryRowBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Typography.tiny())
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                Capsule().fill(Theme.selectionPill)
            )
    }
}
