import AppKit
import ApplicationServices
import Foundation

// The Sessions tab's "show me that terminal" (`docs/claude/island.md`): a click on a CLI session's row raises its EXACT
// terminal window (and tab) through the same tty evidence the routing uses (`TerminalWindowMatcher`).
//
//   1. The terminal app: the nearest ancestor of a process on that tty that is a regular app (process table, read).
//   2. With Accessibility trust: each of that app's windows — its title, and each tab's title in its tab group — is
//      judged by `TerminalWindowMatcher.frontness` as if it were the one in front; the window (and tab) judged `.front`
//      is the tty's. It is raised with the AX RAISE action, a tab with the AX PRESS action (actions only — no AX
//      attribute is ever set), and the app is activated.
//   3. No trust, or no window proven: the app is just activated (the user's view lands in the right app).
// Nothing found (the terminal is gone, tmux/ssh, a server-owned pty): `false` — the caller opens a detached window.

/// One window of the terminal app, as read.
struct TerminalWindowCandidate: Equatable {
    let title: String?
    /// The tab group's tab-button titles (empty: no tab group).
    let tabTitles: [String?]
    /// A standard document window (AX subrole `AXStandardWindow`) — never a Preferences, utility or dialog window.
    var isStandard = true
}

enum TerminalRaiser {
    enum Outcome: Equatable {
        /// The window (and the tab, when there is a tab group) was raised and the app activated.
        case raised
        /// The app was activated; which window holds the tty could not be proven.
        case appOnly
        /// No app hosts that tty.
        case notFound
    }

    /// PURE: the pids from the tty's processes up through their ancestors, nearest first — the candidates for the
    /// terminal app.
    static func ancestors(ofTTY tty: String, processes: [TerminalProcess]) -> [Int32] {
        let device = TerminalWindowMatcher.deviceName(tty)
        let byPid = Dictionary(processes.map { ($0.pid, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [Int32] = []
        var seen = Set<Int32>()
        for start in processes where start.tty == device {
            var pid = start.ppid
            var depth = 0
            while pid > 1, depth < 32, let p = byPid[pid] {
                if seen.insert(pid).inserted { out.append(pid) }
                pid = p.ppid
                depth += 1
            }
        }
        return out
    }

    /// PURE: which window (and tab) holds the tty. Only standard windows are candidates (never Preferences or a
    /// utility window). With ONE standard window (and at most one tab) the matcher's own rules decide, its
    /// "one terminal in a terminal app" rule included; with several windows, or several tabs, a window or tab is picked
    /// only on TITLE evidence (`titleNames`). Nil when nothing is proven.
    static func pick(tty: String, appPid: Int32, bundleId: String?, processes: [TerminalProcess],
                     windows: [TerminalWindowCandidate]) -> (window: Int, tab: Int?)? {
        let standard = windows.indices.filter { windows[$0].isStandard }
        if standard.count == 1, let i = standard.first, windows[i].tabTitles.count <= 1 {
            let w = windows[i]
            let snap = FrontTerminalSnapshot(frontPid: appPid, frontBundleId: bundleId, processes: processes,
                                             windowTitle: w.title, tabTitle: w.tabTitles.first ?? nil, hasFocusedWindow: true)
            return TerminalWindowMatcher.frontness(of: tty, in: snap) == .front ? (i, nil) : nil
        }
        for i in standard {
            let w = windows[i]
            if w.tabTitles.count <= 1 {
                // A tab group with one tab: its title is the window's evidence too.
                let titles = [w.tabTitles.first ?? nil, w.title].compactMap { $0 }
                if titles.contains(where: { titleNames(tty, title: $0, appPid: appPid, bundleId: bundleId, processes: processes) }) {
                    return (i, nil)
                }
                continue
            }
            // A tab's own title is the evidence; the window's title follows only the selected tab, so it is not used.
            for (j, tab) in w.tabTitles.enumerated() {
                if let tab, titleNames(tty, title: tab, appPid: appPid, bundleId: bundleId, processes: processes) { return (i, j) }
            }
        }
        return nil
    }

    /// PURE: does `title` name the terminal on `tty` among the app's terminals — by naming its tty alone, or (in a
    /// dedicated terminal app) by its PROCESS segment naming a program that runs in that terminal only? The window
    /// matcher's title rules, without its "the app runs one terminal" rule (no title evidence).
    static func titleNames(_ tty: String, title: String, appPid: Int32, bundleId: String?, processes: [TerminalProcess]) -> Bool {
        let target = TerminalWindowMatcher.deviceName(tty)
        let ttys = TerminalWindowMatcher.ttysUnder(appPid, processes: processes)
        guard ttys[target] != nil, !title.isEmpty else { return false }
        let named = ttys.keys.filter { TerminalWindowMatcher.title(title, mentions: $0) }
        if named.count == 1 { return named[0] == target }
        if !named.isEmpty { return false }
        guard let bundleId, TerminalWindowMatcher.dedicatedTerminals.contains(bundleId),
              let segment = TerminalWindowMatcher.processSegment(of: title) else { return false }
        var matches = Set<String>()
        for (name, commands) in ttys {
            for command in commands where command.count >= 3 && !TerminalWindowMatcher.unnamedCommands.contains(command) {
                if TerminalWindowMatcher.title(segment, mentions: command) { matches.insert(name); break }
            }
        }
        return matches == [target]
    }

    /// Raises the terminal holding `tty`: the process table and the windows are read, and the raise/press actions
    /// sent, OFF the main thread (as the routing's reads are); only the app's activation happens on it.
    static func raise(tty: String) async -> Outcome {
        let found = await Task.detached(priority: .userInitiated) { () -> (pid: Int32, outcome: Outcome)? in
            let processes = TerminalSnapshotReader.processTable()
            let app = ancestors(ofTTY: tty, processes: processes).lazy
                .compactMap { NSRunningApplication(processIdentifier: $0) }
                .first { $0.activationPolicy == .regular }
            guard let app else { return nil }
            guard AXIsProcessTrusted() else { return (app.processIdentifier, .appOnly) }
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(axApp, 0.2)
            let windows = Self.windows(axApp)
            let candidates = windows.map { TerminalWindowCandidate(title: $0.title, tabTitles: $0.tabs.map(\.title),
                                                                   isStandard: $0.isStandard) }
            guard let (i, j) = pick(tty: tty, appPid: app.processIdentifier, bundleId: app.bundleIdentifier,
                                    processes: processes, windows: candidates) else { return (app.processIdentifier, .appOnly) }
            if let j { AXUIElementPerformAction(windows[i].tabs[j].element, kAXPressAction as CFString) }
            AXUIElementPerformAction(windows[i].element, kAXRaiseAction as CFString)
            return (app.processIdentifier, .raised)
        }.value
        guard let found else { return .notFound }
        await MainActor.run { _ = NSRunningApplication(processIdentifier: found.pid)?.activate() }
        return found.outcome
    }

    private struct AXWindow {
        let element: AXUIElement
        let title: String?
        let isStandard: Bool
        /// The tab group's TAB BUTTONS only (role `AXRadioButton` or subrole `AXTabButton`) — never another child.
        let tabs: [(element: AXUIElement, title: String?)]
    }

    /// The app's windows, each with its tab group's tabs (read-only, bounded).
    private static func windows(_ app: AXUIElement) -> [AXWindow] {
        guard let list = children(app, kAXWindowsAttribute) else { return [] }
        return list.prefix(32).map { w in
            var tabs: [(AXUIElement, String?)] = []
            if let group = firstDescendant(of: w, role: kAXTabGroupRole as String, depth: 2), let kids = children(group, kAXChildrenAttribute) {
                tabs = kids.prefix(64)
                    .filter { string($0, kAXRoleAttribute) == (kAXRadioButtonRole as String) || string($0, kAXSubroleAttribute) == "AXTabButton" }
                    .map { ($0, string($0, kAXTitleAttribute)) }
            }
            return AXWindow(element: w, title: string(w, kAXTitleAttribute),
                            isStandard: string(w, kAXSubroleAttribute) == (kAXStandardWindowSubrole as String),
                            tabs: tabs.map { (element: $0.0, title: $0.1) })
        }
    }

    private static func string(_ e: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private static func children(_ e: AXUIElement, _ attribute: String) -> [AXUIElement]? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, attribute as CFString, &value) == .success else { return nil }
        return value as? [AXUIElement]
    }

    private static func firstDescendant(of e: AXUIElement, role: String, depth: Int) -> AXUIElement? {
        guard depth > 0, let kids = children(e, kAXChildrenAttribute) else { return nil }
        for kid in kids.prefix(64) where string(kid, kAXRoleAttribute) == role { return kid }
        for kid in kids.prefix(64) {
            if let found = firstDescendant(of: kid, role: role, depth: depth - 1) { return found }
        }
        return nil
    }
}
