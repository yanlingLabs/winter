import ApplicationServices
import Foundation

/// Whether an act changed the bound window's PAGE — a link navigated, a tab was switched — so the refs read before
/// it are gone (live: `state({ within })` on a ref from the previous page answered StaleRef twice). Read cheaply:
/// the window's first web area (found by a bounded walk) and its URL, and the window's title.
extension CUCore {
    struct PageSignature: Equatable {
        var url: String?
        var title: String?
        /// The window's own tabs (its tab bar, outside any page), by name; nil when it has none.
        var tabs: [String]? = nil
    }

    /// The bound window's page: nil when it shows no web page (or has no accessibility here). Cheap: the web area
    /// found last is reused while it lives and the window's title is unchanged (a tab switch changes the title);
    /// a window found to hold none is not walked again for 10 s.
    func pageSignature(_ t: CUTarget) -> PageSignature? {
        guard t.accessible, let win = try? windowElement(t) else { return nil }
        let now = clock.nowMs()
        if let until = t.noWebAreaUntil, now < until { return nil }
        let title = ax.string(win, kAXTitleAttribute)
        var area = t.webArea.flatMap { ax.isAlive($0) ? $0 : nil }
        if area == nil || title != t.webAreaWindowTitle {
            area = firstWebArea(win)
            t.webArea = area
            t.webAreaWindowTitle = title
        }
        guard let area else {
            t.noWebAreaUntil = now + 10_000
            return nil
        }
        t.noWebAreaUntil = nil
        let raw = ax.attribute(area, "AXURL")
        let url: String? = raw.flatMap { v in
            if CFGetTypeID(v) == CFURLGetTypeID() { return (v as! URL).absoluteString }
            return v as? String
        }
        return PageSignature(url: url, title: title ?? ax.string(area, kAXTitleAttribute), tabs: tabNames(win))
    }

    /// The names of the window's own tabs: the tab buttons of its tab bars — tab groups outside any web area
    /// (a page's own tab widgets are not the window's tabs). Bounded in nodes and time; nil when there are none.
    func tabNames(_ win: AXUIElement, maxNodes: Int = 400, maxMs: Double = 40) -> [String]? {
        let deadline = clock.nowMs() + maxMs
        var queue = [win]
        var seen = 0
        var names: [String]?
        while !queue.isEmpty, seen < maxNodes, clock.nowMs() < deadline {
            let n = queue.removeFirst()
            seen += 1
            let role = ax.string(n, kAXRoleAttribute)
            if role == "AXWebArea" { continue }
            if role == kAXTabGroupRole {
                let tabs = ax.elements(n, kAXChildrenAttribute).filter {
                    ax.string($0, kAXSubroleAttribute) == "AXTabButton" || ax.string($0, kAXRoleAttribute) == kAXRadioButtonRole
                }
                if !tabs.isEmpty {
                    names = (names ?? []) + tabs.map { ax.string($0, kAXTitleAttribute) ?? ax.string($0, kAXDescriptionAttribute) ?? "" }
                    continue
                }
            }
            queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
        }
        return names
    }

    /// `u` without its #fragment.
    static func withoutFragment(_ u: String?) -> String? {
        guard let u, let i = u.firstIndex(of: "#") else { return u }
        return String(u[..<i])
    }

    /// Two URLs are the same page when they differ at most in an in-page #fragment (an anchor jump) — not one
    /// that routes (`#/…`, `#!…`: a page that navigates by its fragment).
    static func samePage(_ a: String?, _ b: String?) -> Bool {
        if a == b { return true }
        guard withoutFragment(a) == withoutFragment(b) else { return false }
        let routes: (String?) -> Bool = { u in
            guard let u, let i = u.firstIndex(of: "#") else { return false }
            let f = u[u.index(after: i)...]
            return f.hasPrefix("/") || f.hasPrefix("!")
        }
        return !routes(a) && !routes(b)
    }

    /// The window's first web area, breadth first, bounded in nodes and time.
    func firstWebArea(_ win: AXUIElement, maxNodes: Int = 600, maxMs: Double = 80) -> AXUIElement? {
        let deadline = clock.nowMs() + maxMs
        var queue = [win]
        var seen = 0
        while !queue.isEmpty, seen < maxNodes, clock.nowMs() < deadline {
            let n = queue.removeFirst()
            seen += 1
            if ax.string(n, kAXRoleAttribute) == "AXWebArea" { return n }
            queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
        }
        return nil
    }

    /// The page before an act: the one read after the last act when that is recent, else a fresh read.
    func pageBeforeAct(_ t: CUTarget) -> PageSignature? {
        if let last = t.pageAfterLastAct, clock.nowMs() - last.atMs < 5_000 { return last.page }
        return pageSignature(t)
    }

    /// The same page: the same URL up to an in-page #fragment (or, with no URL, the same title); tabs aside.
    static func isSamePage(_ a: PageSignature, _ b: PageSignature) -> Bool {
        a.url != nil || b.url != nil ? samePage(a.url, b.url) : a.title == b.title
    }

    /// After an act: a different URL (or, with no URL, a different title) means the page changed — an in-page
    /// #fragment jump does not. The focus line read before that is dropped (it named the old page). A tab that
    /// opened is said, whether or not it is showing.
    func notePageChange(from before: PageSignature?, _ t: CUTarget, _ o: ActOutcome) -> ActOutcome {
        let after = pageSignature(t)
        t.pageAfterLastAct = (clock.nowMs(), after)
        guard let before, let after else { return o }
        var o = o
        let changed = !Self.isSamePage(before, after)
        if changed {
            o.pageNow = after.title.flatMap { $0.isEmpty ? nil : $0 } ?? after.url ?? "untitled"
            o.focusNow = nil
            o.focusLost = false
            CULog.act.notice("act in \(t.appName, privacy: .public): the page changed")
        }
        if let note = Self.newTabNote(before.tabs, after.tabs, showing: changed, app: t.appName) {
            CULog.act.notice("act in \(t.appName, privacy: .public): a tab opened")
            o = o.noting(note)
        }
        return o
    }

    /// "a new tab opened in Safari: “Title” …" when the window has more tabs than before. Pure.
    static func newTabNote(_ before: [String]?, _ after: [String]?, showing: Bool, app: String) -> String? {
        guard let before, let after, after.count > before.count else { return nil }
        var left = before
        var added: [String] = []
        for n in after {
            if let i = left.firstIndex(of: n) { left.remove(at: i) } else { added.append(n) }
        }
        if added.isEmpty { added = Array(after.suffix(after.count - before.count)) }
        let names = added.prefix(3).map { $0.isEmpty ? "untitled" : "\u{201C}\($0.prefix(80))\u{201D}" }.joined(separator: ", ")
        let count = after.count - before.count
        let what = count == 1 ? "a new tab opened in \(app)" : "\(count) new tabs opened in \(app)"
        return showing
            ? "\(what) (\(names)), and it is the one showing now"
            : "\(what) (\(names)) — the window still shows the tab it showed; click the new tab to work in it"
    }
}
