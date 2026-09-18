import SwiftUI

// -----------------------------------------------------------------------------------------------
// Settings chrome (2026-09-18) — THE vocabulary every settings section is written in.
//
// The shape is the ChatGPT macOS settings window, which the user supplied as the reference:
//
//     General                                     ← SettingsPage(title:subtitle:accessory:)
//     ────────────────────────────────────────
//     Appearance                                  ← SettingsGroup's label
//     ┌──────────────────────────────────────┐    ← SettingsCard
//     │ Theme                        [ System ▾] │ ← SettingsRow(title:description:control:)
//     │ ─────────────────────────────────────── │ ← the card's own hairline, drawn BETWEEN rows
//     │ Accent colour                    (•)( ) │
//     └──────────────────────────────────────┘
//
// Three rules this file exists to enforce, so no section has to restate them:
//
//  1. **A row is a sentence with a control on the end.** Title, an optional muted description that
//     wraps, and exactly one trailing affordance. Anything that is not that shape does not belong
//     in a card — see the three sections deliberately left un-carded (`SettingsSurface.swift`'s
//     `wired()` switch says which and why).
//  2. **The card draws the separators, not the rows.** `SettingsCard` reads its own subviews
//     (`Group(subviews:)`, macOS 15+ — public API, deliberately not the `_VariadicView` spelling)
//     and inserts a full-width rule between each adjacent pair. A row therefore never knows whether
//     it is first, last or alone, and a `ForEach` of rows (Trust's folders, Peripheral's leases)
//     separates correctly for free.
//  3. **Tokens only.** `Typography.*` for every font, `Theme.*` for every colour. `TypographyTests`
//     sweeps `Sources/` for raw font construction — including a `.font(` whose argument sits on the
//     next line — so every `.font(...)` here is single-line. The one exception in this whole
//     surface is `.red` on a failure line, which is the convention every sibling pane already uses
//     (`SettingsProvidersSection`, `SettingsRolesSection`, every Dashboard pane) and for which no
//     `Theme` token exists.
//
// Plane discipline (`docs/brand.md` § 3.1): the card's FACE is `Theme.elevatedSurface`, one step
// above the content side's `cardSurface`. Its RIM is drawn at the boundary between those two planes
// and so takes `Theme.hairline`; the rules INSIDE it are drawn on `elevatedSurface` and so take
// `Theme.hairlineElevated`, which is the token that exists precisely because `hairline` measures
// 1.04:1 there and all but vanishes in dark.
// -----------------------------------------------------------------------------------------------

/// The settings surface's metrics, in one place so a card, a row and a page can never disagree
/// about what "generous" means. Pure numbers — no view here.
enum SettingsChrome {
    /// Continuous corners, at the radius the reference's cards read at against a 720 pt column.
    static let cardCornerRadius: CGFloat = 14
    /// A row's own inset. The reference's rows are noticeably roomier than an AppKit list row;
    /// these two numbers are the whole reason the surface reads as "settings" and not "a table".
    static let rowHorizontalPadding: CGFloat = 18
    static let rowVerticalPadding: CGFloat = 14
    /// The minimum gap between a row's text block and its trailing control.
    static let rowControlGap: CGFloat = 16
    /// Label → its card. The reference sets its group labels well clear of the card they name.
    static let groupLabelGap: CGFloat = 14
    /// Group → group, and title → first group — the reference's roomy vertical rhythm.
    static let groupGap: CGFloat = 40
    /// The page's margins inside the detail card.
    static let pageMargin: CGFloat = 28
    static let pageTopInset: CGFloat = 8
    /// A trailing control's own corner and insets — the pill the reference draws its menus and
    /// its soft buttons in.
    static let controlCornerRadius: CGFloat = 8
    static let controlHorizontalPadding: CGFloat = 12
    static let controlVerticalPadding: CGFloat = 6
    /// The content column never runs the full width of a wide window — long descriptions become
    /// unreadable and a trailing toggle ends up a foot away from the label it belongs to.
    static let contentMaxWidth: CGFloat = 800
}

// MARK: - The page

/// A whole settings section: the large left-aligned title, an optional one-line subtitle, an
/// optional trailing accessory (the Refresh buttons live there), and a scrolling column of groups.
///
/// **Every settings section is one of these** (2026-09-18) — the page draws the heading, so the
/// outer `SettingsSectionView` never prints one.
struct SettingsPage<Accessory: View, Content: View>: View {
    let title: String
    let subtitle: String?
    private let accessory: Accessory
    private let content: Content

    init(title: String,
         subtitle: String? = nil,
         @ViewBuilder accessory: () -> Accessory,
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory()
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SettingsChrome.groupGap) {
                header
                content
            }
            .frame(maxWidth: SettingsChrome.contentMaxWidth, alignment: .leading)
            .padding(.horizontal, SettingsChrome.pageMargin)
            .padding(.top, SettingsChrome.pageTopInset)
            .padding(.bottom, SettingsChrome.pageMargin)
            // CENTRED in the card, like the transcript's own column (user call, 2026-09-18).
            // Left-aligned, the page hugged the sidebar and left a growing empty gutter on the
            // right as the window widened — the text column's measure is capped either way, so
            // the only question is where the leftover space goes, and split is the answer the
            // transcript already gives.
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    /// The title alone, large and regular-weight, as the reference draws it (user call,
    /// 2026-09-18: "make the settings tabs look like ChatGPT's"). `subtitle` is kept on the API —
    /// the sidebar search and callers still name one — but the page no longer prints it: the
    /// reference has no line under its title, and every page having one made them all read as
    /// forms with instructions rather than settings.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(Typography.settingsPageTitle)
                .foregroundStyle(Theme.textPrimary)
            Spacer(minLength: 12)
            accessory
        }
    }
}

extension SettingsPage where Accessory == EmptyView {
    /// A page with no trailing accessory — the common case.
    init(title: String, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, subtitle: subtitle, accessory: { EmptyView() }, content: content)
    }
}

// MARK: - The group

/// The label that names a card: primary ink, a step above the rows, medium weight, flush with the
/// card's edge — the reference's "Permissions" / "General" headings. Sentence case, never
/// uppercased: this shell rejected the `.uppercased()` treatment for its own section labels
/// (`ShellSidebar`'s "Recents") and the settings surface follows it.
struct SettingsGroupLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Typography.bodyLarge(.medium))
            .foregroundStyle(Theme.textPrimary)
    }
}

/// A label over a card. The unit a section is built out of — `SettingsGroup("Folders") { rows }`.
/// The label is optional: a section with exactly one card and a self-evident title does not need
/// the same word twice.
struct SettingsGroup<Content: View>: View {
    let title: String?
    private let content: Content

    init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SettingsChrome.groupLabelGap) {
            if let title {
                SettingsGroupLabel(title)
            }
            SettingsCard { content }
        }
    }
}

// MARK: - The card

/// The rounded container: `Theme.elevatedSurface` behind continuous corners, a `Theme.hairline`
/// rim, and a full-width `Theme.hairlineElevated` rule between every adjacent pair of rows.
///
/// The separators are inserted by reading the card's own subviews, so callers just stack rows —
/// including inside a `ForEach`, whose elements flatten into individual subviews here and are
/// therefore separated one by one, not as a single block.
struct SettingsCard<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) { self.content = content() }

    var body: some View {
        Group(subviews: content) { subviews in
            let rows = Array(subviews)
            VStack(spacing: 0) {
                ForEach(rows.indices, id: \.self) { index in
                    rows[index]
                    // INSET by the row padding, as the reference draws them: a rule that ran into
                    // the rim read as the card being cut into boxes rather than listing rows.
                    if index < rows.count - 1 {
                        Rectangle()
                            .fill(Theme.hairlineElevated)
                            .frame(height: 1)
                            .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.elevatedSurface)
        // `.clipShape` first so a row's own background can never square off the corner, then the
        // rim as an overlay so `strokeBorder` is not half-eaten by the clip it would otherwise
        // have been drawn under.
        .clipShape(RoundedRectangle(cornerRadius: SettingsChrome.cardCornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: SettingsChrome.cardCornerRadius, style: .continuous)
                .strokeBorder(Theme.hairline, lineWidth: 1)
        )
    }
}

// MARK: - The row

/// One line of a card: a title, an optional wrapping description under it, an optional slot for
/// extra muted lines (constraint notes, warnings), and exactly one trailing control.
///
/// `.center` alignment, not `.firstTextBaseline`: a switch or a button reads as belonging to the
/// whole two-line block, and baseline-aligning it to the title alone leaves it visibly high.
struct SettingsRow<Detail: View, Control: View>: View {
    let title: String
    let description: String?
    private let detail: Detail
    private let control: Control

    init(_ title: String,
         description: String? = nil,
         @ViewBuilder detail: () -> Detail,
         @ViewBuilder control: () -> Control) {
        self.title = title
        self.description = description
        self.detail = detail()
        self.control = control()
    }

    var body: some View {
        HStack(alignment: .center, spacing: SettingsChrome.rowControlGap) {
            VStack(alignment: .leading, spacing: 3) {
                // Regular weight at body size, never semibold: the reference's row titles are
                // plain text, and bold titles made every card read as a stack of headings.
                Text(title)
                    .font(Typography.body())
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let description {
                    Text(description)
                        .font(Typography.control())
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                detail
            }
            Spacer(minLength: SettingsChrome.rowControlGap)
            control
        }
        .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
        .padding(.vertical, SettingsChrome.rowVerticalPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension SettingsRow where Detail == EmptyView {
    /// A row with nothing under its description — the common case.
    init(_ title: String, description: String? = nil, @ViewBuilder control: () -> Control) {
        self.init(title, description: description, detail: { EmptyView() }, control: control)
    }
}

/// An extra muted line inside a row's `detail` slot. A separate view rather than string
/// concatenation onto the description, so the two facts stay two facts and can be styled apart
/// later without unpicking a sentence.
struct SettingsRowNote: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Typography.control())
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A read-only row: the value IS the control. Sans by default, like the reference's own values
/// ("/Users/…/Codex" aside, which it still sets in sans); pass `monospaced: true` for a hash or a
/// raw identifier that genuinely wants a fixed advance.
///
/// `middleTruncated` exists for a socket path or a folder: a long value must shrink rather than
/// push the row's title off the card, and the head and the tail are the informative halves.
struct SettingsValueRow: View {
    let title: String
    var description: String? = nil
    let value: String
    var monospaced: Bool = false
    var middleTruncated: Bool = false
    /// True when the value is an absence ("—", "None") rather than a fact — rendered in the muted
    /// tone so a missing value never reads as a real one.
    var isMuted: Bool = false

    var body: some View {
        SettingsRow(title, description: description) {
            Text(value)
                .font(monospaced ? Typography.controlMono() : Typography.body())
                .foregroundStyle(isMuted ? Theme.textMuted : Theme.textSecondary)
                .lineLimit(middleTruncated ? 1 : nil)
                .truncationMode(.middle)
                .textSelection(.enabled)
                // Only a truncated value earns a tooltip. An unconditional `.help` would pop a
                // bubble reading "3" over a row whose value already reads "3".
                .help(middleTruncated ? value : "")
        }
    }
}

/// A full-width line inside a card, with no control: an empty state, a "Loading…", or a failure.
/// A row of its own rather than a floating `Text`, so it separates from real rows with the same
/// hairline and never leaves a card looking empty.
struct SettingsNoteRow: View {
    let text: String
    var isError: Bool = false

    init(_ text: String, isError: Bool = false) {
        self.text = text
        self.isError = isError
    }

    var body: some View {
        // `.red` for a failure line, as every sibling settings and dashboard surface spells it —
        // there is no error token in `Theme` and inventing one here would be a twelfth palette
        // value nothing else uses.
        Text(text)
            .font(Typography.control())
            .foregroundStyle(isError ? AnyShapeStyle(Color.red) : AnyShapeStyle(Theme.textMuted))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SettingsChrome.rowHorizontalPadding)
            .padding(.vertical, SettingsChrome.rowVerticalPadding)
    }
}

// MARK: - The controls

/// The quiet capsule beside a value — Roles' "Pinned" / "Default". Muted by construction: a badge
/// that competed with its own row's title would be shouting a footnote.
struct SettingsBadge: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Typography.caption())
            .foregroundStyle(Theme.textMuted)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule(style: .continuous).fill(Theme.controlSurface))
    }
}

/// The switch on the trailing edge of a row. Label-less: the row's own title is the label, and a
/// `Toggle` that carried its own would print it twice.
struct SettingsToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        // Regular control size, not `.small`: the reference's switches are full size, and a small
        // one beside a 14 pt row inset reads under-scale.
        Toggle("", isOn: $isOn)
            .labelsHidden()
            .toggleStyle(.switch)
    }
}

/// The push button on the trailing edge of a row.
///
/// `isDestructive` uses the BUTTON ROLE rather than a red tint, so the danger reading comes from
/// AppKit's own destructive treatment instead of a raw colour this file would have to invent.
struct SettingsButton: View {
    let title: String
    var isDestructive: Bool = false
    var isEnabled: Bool = true
    let action: () -> Void

    init(_ title: String,
         isDestructive: Bool = false,
         isEnabled: Bool = true,
         action: @escaping () -> Void) {
        self.title = title
        self.isDestructive = isDestructive
        self.isEnabled = isEnabled
        self.action = action
    }

    var body: some View {
        Button(title, role: isDestructive ? .destructive : nil, action: action)
            .buttonStyle(SettingsSoftButtonStyle(isDestructive: isDestructive))
            .disabled(!isEnabled)
            .fixedSize()
    }
}

/// The reference's soft button ("Change"): a filled rounded rect with no bezel and no rim, a touch
/// lighter under the pointer and while pressed. Destructive buttons keep the same shape and take
/// their danger from the red label alone.
struct SettingsSoftButtonStyle: ButtonStyle {
    var isDestructive: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        SoftButtonBody(configuration: configuration, isDestructive: isDestructive)
    }

    private struct SoftButtonBody: View {
        let configuration: ButtonStyleConfiguration
        let isDestructive: Bool
        @Environment(\.isEnabled) private var isEnabled
        @State private var isHovered = false

        var body: some View {
            configuration.label
                .font(Typography.body())
                .foregroundStyle(isDestructive ? AnyShapeStyle(Color.red) : AnyShapeStyle(Theme.textPrimary))
                .padding(.horizontal, SettingsChrome.controlHorizontalPadding)
                .padding(.vertical, SettingsChrome.controlVerticalPadding)
                .background(
                    RoundedRectangle(cornerRadius: SettingsChrome.controlCornerRadius, style: .continuous)
                        .fill(isHovered || configuration.isPressed ? Theme.chromeHover : Theme.controlSurface)
                )
                .opacity(isEnabled ? 1 : 0.45)
                .contentShape(Rectangle())
                .onHover { isHovered = $0 }
        }
    }
}

/// The reference's menu pill ("Finder ⌄", "Auto detect ⌄"): the current value in sans with a small
/// chevron, inside a hairline-rimmed rounded rect. A LABEL, not a button — callers wrap it in their
/// own `Button` or `Menu`, so the pill never decides what a click does.
struct SettingsMenuPill<Leading: View>: View {
    let text: String
    var isMuted: Bool = false
    private let leading: Leading

    init(_ text: String, isMuted: Bool = false, @ViewBuilder leading: () -> Leading) {
        self.text = text
        self.isMuted = isMuted
        self.leading = leading()
    }

    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 6) {
            leading
            Text(text)
                .font(Typography.body())
                .foregroundStyle(isMuted ? Theme.textMuted : Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.down")
                .font(Typography.caption(.medium))
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, SettingsChrome.controlHorizontalPadding)
        .padding(.vertical, SettingsChrome.controlVerticalPadding)
        .background(
            RoundedRectangle(cornerRadius: SettingsChrome.controlCornerRadius, style: .continuous)
                .fill(isHovered ? Theme.chromeHover : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: SettingsChrome.controlCornerRadius, style: .continuous)
                .strokeBorder(Theme.hairlineElevated, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
    }
}

extension SettingsMenuPill where Leading == EmptyView {
    init(_ text: String, isMuted: Bool = false) {
        self.init(text, isMuted: isMuted, leading: { EmptyView() })
    }
}

// MARK: - The sidebar's search field

/// The field above the settings section list. Filters the list live; it is NOT the app's own
/// session search (that lives in the palette, `SidebarSearchPalette`), which is why it is spelled
/// here as part of the settings vocabulary rather than reused from the shell.
struct SettingsSearchField: View {
    @Binding var query: String
    var placeholder: String = "Search settings…"

    @State private var isHovered = false
    @FocusState private var isFocused: Bool

    /// The SAME three states the browser's address bar wears (user call, 2026-09-18) — bare at
    /// rest, washed under the pointer, washed and rimmed while typing — decided by the same pure
    /// function, so the two fields cannot drift apart. The CONTENTS never decide: a field holding a
    /// query still goes bare when you look away, exactly as the address bar does.
    ///
    /// The paint differs from the address bar's on purpose. That one wears `chromeHover`, an opaque
    /// fill, because it sits on the panel's opaque chrome; this one sits on the TRANSLUCENT sidebar,
    /// where an opaque fill reads as a chip pasted onto the blur — so it wears the same luminance
    /// washes the sidebar's rows do.
    private var state: PanelAddressFieldState {
        panelAddressFieldState(focused: isFocused, hovered: isHovered, text: query)
    }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(Typography.label())
                .foregroundStyle(Theme.textMuted)
            TextField(placeholder, text: $query)
                .textFieldStyle(.plain)
                .font(Typography.body())
                .foregroundStyle(Theme.textPrimary)
                .focused($isFocused)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(Typography.label())
                        .foregroundStyle(Theme.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 10)
        // The SAME height and corner as the rows beneath it (user call, 2026-09-18): at 28 pt with
        // an 8 pt corner it read as a smaller, rounder thing sitting above the list instead of the
        // first item in the same column. Both numbers now come from the row vocabulary, so they
        // cannot drift apart again.
        .frame(height: shellSidebarRowHeight)
        .background(searchFieldShape.fill(fill))
        .overlay(searchFieldShape.strokeBorder(rim, lineWidth: shellSidebarHairlineWidth * 2))
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        // Clicking anywhere in the field takes focus, not just the few points of text inside it.
        .onTapGesture { isFocused = true }
        // The address bar's own curve, for the same reason it has one: the instant snap between
        // bare and filled reads as a glitch rather than as a response.
        .animation(.smooth(duration: 0.22), value: state)
    }

    private var searchFieldShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
    }

    /// Bare at rest; the row-hover wash under the pointer; the stronger selected wash while typing,
    /// so focus is legible even where the rim is faint against the blur.
    private var fill: Color {
        switch state {
        case .rest: return .clear
        case .hovered: return Theme.rowHoverVibrant
        case .editing: return Theme.selectionPillVibrant
        }
    }

    /// The rim the address bar wears while editing — but drawn in INK tokens, not line tokens.
    ///
    /// Two attempts were invisible here before this one: `hairlineElevated` (what the address bar
    /// itself uses) and then `composerRim`. Both were measured against opaque chrome, and both sit
    /// within a few levels of the sidebar's own plane; over a luminance wash on a translucent pane
    /// there is nothing left of them. A rim nobody can see is not a rim. The text inks are the
    /// tokens that DO read at this contrast, because they were chosen to be legible on exactly this
    /// plane — so focus borrows `textMuted` and hover the quieter `textPlaceholder`.
    private var rim: Color {
        switch state {
        case .rest: return .clear
        case .hovered: return Theme.textPlaceholder
        case .editing: return Theme.textMuted
        }
    }
}
