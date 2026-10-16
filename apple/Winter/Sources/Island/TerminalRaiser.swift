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
    /// The tab group's tab titles (empty: no tab group).
    let tabTitles: [String?]
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

    /// PURE: which window (and tab) holds the tty: the first window or tab the matcher judges `.front` when it is
    /// assumed to be the focused one. Nil when none can be proven.
    static func pick(tty: String, appPid: Int32, bundleId: String?, processes: [TerminalProcess],
                     windows: [TerminalWindowCandidate]) -> (window: Int, tab: Int?)? {
        for (i, w) in windows.enumerated() {
            if w.tabTitles.isEmpty {
                let snap = FrontTerminalSnapshot(frontPid: appPid, frontBundleId: bundleId, processes: processes,
                                                 windowTitle: w.title, tabTitle: nil, hasFocusedWindow: true)
                if TerminalWindowMatcher.frontness(of: tty, in: snap) == .front { return (i, nil) }
                continue
            }
            for (j, tab) in w.tabTitles.enumerated() {
                // A tab's own title is the evidence; the window's title follows only the selected tab, so it is not used.
                let snap = FrontTerminalSnapshot(frontPid: appPid, frontBundleId: bundleId, processes: processes,
                                                 windowTitle: nil, tabTitle: tab, hasFocusedWindow: true)
                if TerminalWindowMatcher.frontness(of: tty, in: snap) == .front { return (i, j) }
            }
        }
        return nil
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
            let candidates = windows.map { TerminalWindowCandidate(title: $0.title, tabTitles: $0.tabs.map(\.title)) }
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
        let tabs: [(element: AXUIElement, title: String?)]
    }

    /// The app's windows, each with its tab group's tabs (read-only, bounded).
    private static func windows(_ app: AXUIElement) -> [AXWindow] {
        guard let list = children(app, kAXWindowsAttribute) else { return [] }
        return list.prefix(32).map { w in
            var tabs: [(AXUIElement, String?)] = []
            if let group = firstDescendant(of: w, role: kAXTabGroupRole as String, depth: 2), let kids = children(group, kAXChildrenAttribute) {
                tabs = kids.prefix(64).map { ($0, string($0, kAXTitleAttribute)) }
            }
            return AXWindow(element: w, title: string(w, kAXTitleAttribute), tabs: tabs.map { (element: $0.0, title: $0.1) })
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
