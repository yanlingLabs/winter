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
                HStack(spacing: 6) {
                    Text(HeadlessPresentChromeState.titleLine(title: presentation.title, url: presentation.url))
                        .font(Typography.label(.medium))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let host = HeadlessPresentChromeState.host(of: presentation.url),
                       host != HeadlessPresentChromeState.titleLine(title: presentation.title, url: presentation.url) {
                        Text(host)
                            .font(Typography.caption())
                            .foregroundStyle(Theme.textMuted)
                            .lineLimit(1)
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

/// When the session has headless tabs and none is shown: a small control at the foot of the panel listing them;
/// choosing one asks the daemon to show it (watch-only).
struct HeadlessTabsOffer: View {
    @ObservedObject var store: HeadlessPresentStore
    let sessionId: String

    var body: some View {
        let tabs = store.offeredTabs(for: sessionId)
        if !tabs.isEmpty || store.listNotice[sessionId] != nil {
            VStack(spacing: 6) {
                if let notice = store.listNotice[sessionId] {
                    Text(notice)
                        .font(Typography.caption())
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                if !tabs.isEmpty {
                    Menu {
                        ForEach(tabs) { tab in
                            Button(HeadlessPresentChromeState.tabLabel(tab)) {
                                store.watch(sessionId: sessionId, tabId: tab.tabId)
                            }
                            .disabled(store.watchPending.contains(tab.tabId))
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "eye")
                                .font(Typography.label())
                            Text(tabs.count == 1 ? "Watch Winter's headless tab" : "Watch one of Winter's \(tabs.count) headless tabs")
                                .font(Typography.label(.medium))
                        }
                        .foregroundStyle(Theme.textPrimary)
                        .padding(.horizontal, 12)
                        .frame(height: panelTabPillSize.height)
                        .contentShape(Rectangle())
                    }
                    .menuStyle(.button)
                    .buttonStyle(ShellChromeButtonStyle(isSelected: true))
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("Show a tab Winter is using in its headless browser")
                }
            }
            .padding(10)
        }
    }
}
