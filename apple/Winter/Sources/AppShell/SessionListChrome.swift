import SwiftUI

// -----------------------------------------------------------------------------------------------
// The session list pages' chrome (2026-09-18) — the Chats and Code destinations, restyled to the
// app's own vocabulary instead of an AppKit `List` under a segmented `Picker`:
//
//     Code                                            ( + New )   ← settingsPageTitle + the Next pill
//     ( All )  Background   Archived                              ← the composer's mode switch
//     ─────────────────────────────────────────────
//     Fix the flaky socket test            ● Running   2 hours ago ← hover rows, the sidebar's style
//     Refactor settings                                yesterday
//
// A centred reading column, the same measure the settings pages and the transcript use, so the
// three kinds of page line up when you move between them. First pass — the user will tune it.
// -----------------------------------------------------------------------------------------------

/// The column's cap and insets — the settings page's, so the two surfaces share one measure.
let sessionListContentMaxWidth: CGFloat = SettingsChrome.contentMaxWidth
let sessionListRowHeight: CGFloat = 44

/// One page: title, an optional action on the title line, optional tabs, then the rows.
struct SessionListPage<Tabs: View, Content: View>: View {
    let title: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    @ViewBuilder var tabs: () -> Tabs
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title)
                        .font(Typography.settingsPageTitle)
                        .foregroundStyle(Theme.textPrimary)
                    Spacer(minLength: 12)
                    if let actionTitle, let action {
                        SessionListNewButton(title: actionTitle, action: action)
                    }
                }
                tabs()
                VStack(alignment: .leading, spacing: 1) {
                    content()
                }
            }
            .frame(maxWidth: sessionListContentMaxWidth, alignment: .leading)
            .padding(.horizontal, SettingsChrome.pageMargin)
            .padding(.top, SettingsChrome.pageTopInset)
            .padding(.bottom, SettingsChrome.pageMargin)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        // The content side is opaque, so rows take the opaque hover greys, not the sidebar's washes.
        .environment(\.shellRowFillIsVibrant, false)
    }
}

extension SessionListPage where Tabs == EmptyView {
    init(title: String, actionTitle: String? = nil, action: (() -> Void)? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, actionTitle: actionTitle, action: action,
                  tabs: { EmptyView() }, content: content)
    }
}

/// "+ New" as a PILL — the question card's Next button (`PendingCards.wideButton`): the same
/// inverted-canvas capsule at the same height, sized to its label instead of the card's width.
struct SessionListNewButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "plus")
                    .font(Typography.control(.semibold))
                Text(title)
                    .font(Typography.control(.semibold))
            }
            .foregroundStyle(Theme.canvas)
            .padding(.horizontal, 18)
            .frame(height: pendingQuestionActionHeight)
            .background(Capsule().fill(Theme.inverseCanvas))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// The tab switch — the composer's own Chat/Cowork control, so a "which list" choice looks like
/// the "which mode" choice the user already knows.
struct SessionListTabs<Tab: Hashable & Identifiable>: View {
    let tabs: [Tab]
    @Binding var selection: Tab
    let title: (Tab) -> String

    var body: some View {
        HStack(spacing: 2) {
            ForEach(tabs) { tab in
                let isSelected = tab == selection
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { selection = tab }
                } label: {
                    Text(title(tab))
                        .font(Typography.body(isSelected ? .medium : .regular))
                        .foregroundStyle(isSelected ? AnyShapeStyle(Theme.textPrimary)
                                                    : AnyShapeStyle(Theme.textMuted))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(isSelected ? AnyShapeStyle(Theme.composerSurface)
                                         : AnyShapeStyle(Color.clear))
                )
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.controlSurface)
        )
    }
}

/// One session: its title, then whatever the page puts on the trailing edge, then when it started.
/// The sidebar's own row style, so hover reads the same everywhere.
struct SessionListRow<Trailing: View, Below: View>: View {
    let title: String
    let date: Date
    let action: () -> Void
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var below: () -> Below

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: action) {
                HStack(spacing: 10) {
                    Text(title)
                        .font(Typography.body())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 12)
                    trailing()
                    Text(date, format: .relative(presentation: .named))
                        .font(Typography.control())
                        .foregroundStyle(Theme.textMuted)
                        .lineLimit(1)
                }
                .padding(.horizontal, 12)
                .frame(height: sessionListRowHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(ShellSidebarRowStyle(isSelected: false))
            below()
                .padding(.horizontal, 12)
        }
    }
}

extension SessionListRow where Trailing == EmptyView, Below == EmptyView {
    init(title: String, date: Date, action: @escaping () -> Void) {
        self.init(title: title, date: date, action: action, trailing: { EmptyView() }, below: { EmptyView() })
    }
}

/// The quiet empty line under the tabs — a sentence, not a landing screen.
struct SessionListEmpty: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(Typography.body())
                .foregroundStyle(Theme.textSecondary)
            Text(detail)
                .font(Typography.control())
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }
}

/// A session's start time as a `Date` (the wire carries epoch milliseconds).
func sessionListDate(_ createdAt: Int) -> Date {
    Date(timeIntervalSince1970: TimeInterval(createdAt) / 1000)
}
