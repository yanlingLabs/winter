import ApplicationServices
import Foundation

/// Whether an act changed the bound window's PAGE — a link navigated, a tab was switched — so the refs read before
/// it are gone (live: `state({ within })` on a ref from the previous page answered StaleRef twice). Read cheaply:
/// the window's first web area (found by a bounded walk) and its URL, and the window's title.
extension CUCore {
    struct PageSignature: Equatable {
        var url: String?
        var title: String?
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
        return PageSignature(url: url, title: title ?? ax.string(area, kAXTitleAttribute))
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

    /// After an act: a different URL (or, with no URL, a different title) means the page changed.
    func notePageChange(from before: PageSignature?, _ t: CUTarget, _ o: ActOutcome) -> ActOutcome {
        let after = pageSignature(t)
        t.pageAfterLastAct = (clock.nowMs(), after)
        guard let before, let after else { return o }
        let changed = before.url != nil || after.url != nil ? before.url != after.url : before.title != after.title
        guard changed else { return o }
        var o = o
        o.pageNow = after.title.flatMap { $0.isEmpty ? nil : $0 } ?? after.url ?? "untitled"
        CULog.act.notice("act in \(t.appName, privacy: .public): the page changed")
        return o
    }
}
