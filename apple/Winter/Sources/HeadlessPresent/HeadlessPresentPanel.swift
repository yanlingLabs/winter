import SwiftUI
import WinterKit

/// ComputerV2 Phase 4 (lane H3) — **the panel's chrome row for a shown headless tab**: the page's title and host on
/// the first line, the state line below (`HeadlessPresentChromeState`), the actions and a close button on the
/// trailing edge. It sits in the panel's URL row (`panelUrlRowHeight`), in that row's own vocabulary: chrome
/// buttons at the tab row's 28pt rhythm, the panel's group gaps, named colours only.
struct HeadlessPresentChromeBar: View {
    @ObservedObject var presentation: HeadlessPresentation
    let store: HeadlessPresentStore

    private var state: HeadlessPresentChromeState {
        HeadlessPresentChromeState.make(phase: presentation.phase, purpose: presentation.purpose,
                                        control: presentation.control, pending: presentation.pending,
                                        notice: presentation.notice)
    }

    var body: some View {
        let state = self.state
        HStack(spacing: panelChromeButtonSpacing) {
            Image(systemName: glyph)
                .font(Typography.label(.medium))
                .foregroundStyle(Theme.textMuted)
                .frame(width: panelChromeButtonSize, height: panelChromeButtonSize)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                let text = HeadlessPresentChromeState.barText(title: presentation.title, url: presentation.url,
                                                              purpose: presentation.purpose, control: presentation.control)
                HStack(spacing: 6) {
                    // The first line keeps its room (the real origin while the person types, or a sign-in window):
                    // the second gives way to it, never the other way round.
                    Text(text.first)
                        .font(Typography.label(.medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                    if let second = text.second {
                        Text(second)
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(-1)
                    }
                }
                Text(state.stateLine)
                    .font(Typography.caption())
                    .foregroundStyle(state.stateIsNotice ? Theme.textPrimary : Theme.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)

            ForEach(state.buttons, id: \.title) { button in
                Button(button.title) { store.act(button.action, on: presentation) }
                    .buttonStyle(HeadlessPresentActionStyle(prominent: button.prominent))
                    .disabled(!state.buttonsEnabled)
            }
            ShellTitlebarButton(systemImage: "xmark", label: "Stop showing this tab",
                                size: panelChromeButtonSize) {
                store.act(.close, on: presentation)
            }
        }
        .padding(.leading, panelTabPillInset)
        .padding(.trailing, panelExpandButtonInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var glyph: String {
        switch presentation.phase {
        case .connecting: return "antenna.radiowaves.left.and.right"
        case .ended: return "eye.slash"
        case .live: return presentation.control ? "hand.point.up.left" : "eye"
        }
    }
}

/// A small text action in the chrome row: the prominent one filled with the primary-action tint, the others on the
/// chrome's own hover fill.
struct HeadlessPresentActionStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        ActionBody(configuration: configuration, prominent: prominent, isEnabled: isEnabled)
    }

    private struct ActionBody: View {
        let configuration: Configuration
        let prominent: Bool
        let isEnabled: Bool
        @State private var hovered = false

        var body: some View {
            configuration.label
                .font(Typography.label(.medium))
                .foregroundStyle(prominent ? Theme.canvas : Theme.textPrimary)
                .padding(.horizontal, 10)
                .frame(height: 24)
                .background(
                    RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                        .fill(prominent ? Theme.inverseCanvas : shellChromeFill(isSelected: true, isHovered: hovered || configuration.isPressed))
                )
                .opacity(isEnabled ? (configuration.isPressed && prominent ? 0.85 : 1) : 0.5)
                .onHover { hovered = $0 }
        }
    }
}

/// The panel's content while a headless tab is shown: the live page, and over it a quiet line while it connects or
/// once it ended.
struct HeadlessPresentContent: View {
    @ObservedObject var presentation: HeadlessPresentation

    var body: some View {
        ZStack {
            HeadlessPresentSurface(presentation: presentation)
            switch presentation.phase {
            case .connecting:
                overlayLine(HeadlessPresentChromeState.connectingLine, spinner: true)
            case .ended(let reason):
                overlayLine(HeadlessPresentChromeState.endedLine(reason), spinner: false)
            case .live:
                EmptyView()
            }
        }
        .background(Theme.cardSurface)
    }

    private func overlayLine(_ text: String, spinner: Bool) -> some View {
        HStack(spacing: 8) {
            if spinner { ProgressView().controlSize(.small) }
            Text(text)
                .font(Typography.label())
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                .fill(Theme.elevatedSurface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: shellSidebarRowCornerRadius, style: .continuous)
                .strokeBorder(Theme.hairlineElevated, lineWidth: 1)
        )
        .allowsHitTesting(false)
    }
}

/// When the session has headless tabs and none is shown: the panel's list of them, a row per tab ("title — host"),
/// choosing one asks the daemon to show it (watch-only). It is a row of the panel's own layout, between the chrome band
/// and the content — never drawn over the content, which may be a live browser view that would cover it (Drill A,
/// 2026-10-13: the list was an overlay on the panel's web tab and the person never saw it). Nothing while there is none.
struct HeadlessTabsList: View {
    @ObservedObject var store: HeadlessPresentStore
    let sessionId: String

    var body: some View {
        let tabs = store.offeredTabs(for: sessionId)
        let notice = store.listNotice[sessionId]
        if !tabs.isEmpty || notice != nil {
            VStack(alignment: .leading, spacing: 2) {
                Text(HeadlessPresentChromeState.listHeading(count: tabs.count))
                    .font(Typography.caption())
                    .foregroundStyle(Theme.textMuted)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 2)
                ForEach(tabs) { tab in
                    Button {
                        store.watch(sessionId: sessionId, tabId: tab.tabId)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: tab.control ? "hand.point.up.left" : "eye")
                                .font(Typography.label())
                                .foregroundStyle(Theme.textMuted)
                                .accessibilityHidden(true)
                            Text(HeadlessPresentChromeState.tabLabel(tab))
                                .font(Typography.label(.medium))
                                .foregroundStyle(Theme.textPrimary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(HeadlessPresentChromeState.tabRowAction(tab, pending: store.watchPending.contains(tab.tabId)))
                                .font(Typography.caption())
                                .foregroundStyle(Theme.textMuted)
                        }
                        .padding(.horizontal, 8)
                        .frame(height: panelTabPillSize.height)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(ShellChromeButtonStyle())
                    .disabled(store.watchPending.contains(tab.tabId))
                    .help("Show this tab of Winter's headless browser here")
                }
                if let notice {
                    Text(notice)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                        .padding(.horizontal, 8)
                }
            }
            .padding(.horizontal, panelTabPillInset)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.hairline).frame(height: panelDividerWidth)
            }
        }
    }
}
