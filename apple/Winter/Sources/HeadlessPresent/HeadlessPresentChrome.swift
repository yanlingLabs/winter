import Foundation
import WinterKit

/// ComputerV2 Phase 4 (lane H3) — **what the headless presentation's chrome bar says and offers**, pure: one function
/// from the presentation's facts to the bar's state line and buttons, so every combination is a unit test and the
/// SwiftUI bar only draws what this returns.
///
/// - "Connecting…" until the producer's welcome;
/// - purpose `handoff` (a `waitForUser`: the agent waits, the person has control): "Winter is waiting for you —
///   finish here, then press Done" with Done and Stop waiting;
/// - purpose `watch`: "Watching Winter's headless tab" with Take over — and while the person holds control, "You
///   have control — Winter waits" with Hand back;
/// - purpose `popup` (a window the page opened while the person held its opener — a sign-in window): "A window the
///   page opened — it closes when you are done", nothing but the close button;
/// - a clear line once the presentation ended, and no actions;
/// - always a close button while it is up.
struct HeadlessPresentChromeState: Equatable {
    enum Phase: Equatable {
        case connecting
        case live
        case ended(String)
    }

    struct Button: Equatable {
        let action: BrowserLinkHeadlessAction
        let title: String
        /// The one the person most likely wants (drawn filled).
        let prominent: Bool
    }

    /// The bar's second line.
    let stateLine: String
    /// The state line is a problem the person should read (an action failed, the view ended).
    let stateIsNotice: Bool
    let buttons: [Button]
    /// Buttons are drawn but not pressable (an action is on its way).
    let buttonsEnabled: Bool
    /// The page takes the person's input now.
    let acceptsInput: Bool

    static let connectingLine = "Connecting…"
    static let handoffLine = "Winter is waiting for you — finish here, then press Done"
    static let watchingLine = "Watching Winter's headless tab"
    static let controlLine = "You have control — Winter waits"
    static let popupLine = "A window the page opened — it closes when you are done"

    static func make(phase: Phase, purpose: BrowserLinkHeadlessPurpose, control: Bool,
                     pending: BrowserLinkHeadlessAction? = nil, notice: String? = nil) -> HeadlessPresentChromeState {
        switch phase {
        case .connecting:
            return HeadlessPresentChromeState(stateLine: notice ?? connectingLine, stateIsNotice: notice != nil,
                                              buttons: [], buttonsEnabled: false, acceptsInput: false)
        case .ended(let reason):
            return HeadlessPresentChromeState(stateLine: endedLine(reason), stateIsNotice: true,
                                              buttons: [], buttonsEnabled: false, acceptsInput: false)
        case .live:
            let line: String
            let buttons: [Button]
            switch purpose {
            case .handoff:
                line = handoffLine
                buttons = [Button(action: .done, title: "Done", prominent: true),
                           Button(action: .stopWaiting, title: "Stop waiting", prominent: false)]
            case .watch where control:
                line = controlLine
                buttons = [Button(action: .handBack, title: "Hand back", prominent: true)]
            case .watch:
                line = watchingLine
                buttons = [Button(action: .takeOver, title: "Take over", prominent: false)]
            case .popup:
                line = popupLine
                buttons = []
            }
            return HeadlessPresentChromeState(stateLine: notice ?? line, stateIsNotice: notice != nil,
                                              buttons: buttons, buttonsEnabled: pending == nil,
                                              acceptsInput: control)
        }
    }

    /// The line once it ended: the consumer's own reason, as a sentence.
    static func endedLine(_ reason: String) -> String {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "The live view ended" }
        return "The live view ended — \(trimmed)"
    }

    /// The bar's first line: the page's title, else its host, else its URL, else a generic name.
    static func titleLine(title: String, url: String) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        if let host = host(of: url) { return host }
        return url.isEmpty ? "Headless tab" : url
    }

    /// The page's host for the bar (nil for an about: page or an unreadable URL).
    static func host(of url: String) -> String? {
        guard let host = URL(string: url)?.host, !host.isEmpty else { return nil }
        return host
    }

    /// One row of the panel's list of a session's headless tabs.
    static func tabLabel(_ tab: BrowserLinkHeadlessTab) -> String {
        let title = titleLine(title: tab.title, url: tab.url)
        if let host = host(of: tab.url), host != title { return "\(title) — \(host)" }
        return title
    }

    /// The tabs the panel offers to watch: those not already shown here.
    static func offeredTabs(_ tabs: [BrowserLinkHeadlessTab], shownTabIds: Set<String>) -> [BrowserLinkHeadlessTab] {
        tabs.filter { !shownTabIds.contains($0.tabId) }
    }

    /// The view's accessibility label (one element; the page's own content is not exposed).
    static func accessibilityLabel(title: String, url: String) -> String {
        var label = "Live page from Winter's headless browser: \(titleLine(title: title, url: url))"
        if let host = host(of: url), host != titleLine(title: title, url: url) { label += ", \(host)" }
        return label
    }

    /// The view's accessibility value: whether the person can use the page.
    static func accessibilityValue(control: Bool) -> String {
        control ? "You have control" : "Watching — Winter has control"
    }
}
