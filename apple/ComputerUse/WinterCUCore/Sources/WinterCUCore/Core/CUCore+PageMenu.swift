import ApplicationServices
import Foundation

/// `menu(path)` for a menu bar INSIDE the page — a web app's own File/Edit/Tools menus, which the app's real menu
/// bar does not have and which open on a real mouse press only (an accessibility press does nothing there). Used
/// when the app's menu bar has no `path[0]` and the bound window's page has a menu bar that does. Each level is
/// opened with a window-targeted click on its item and verified by the menu it shows; the last item is clicked the
/// same way and verified by its menu closing. Generic: any page's `menubar`, any app.
extension CUCore {
    /// How long a page menu is given to open or close after a click.
    static let pageMenuWaitMs: Double = 800

    /// The page-menu route, or nil when it does not apply (the app's menu bar has `path[0]`, or the page has no
    /// menu bar naming it).
    func pageMenuIfNotInMenuBar(_ a: CUMenuAction, _ t: CUTarget, _ token: CUCancellation.Token) throws -> ActOutcome? {
        guard t.accessible, let first = a.path.first else { return nil }
        if let roots = try? CUAXMenuNode.menuBar(pid: t.pid, ax: ax),
           (try? CUMenuWalker.resolve([first], in: roots, requireEnabled: false)) != nil { return nil }
        guard let win = try? windowElement(t), let area = firstWebArea(win), let bar = pageMenuBar(in: area),
              let top = Self.matchItem(first, pageMenuItems(bar), labelOf: pageItemLabel) else { return nil }
        return try pageMenu(a, top: top, area: area, t, token)
    }

    private func pageMenu(_ a: CUMenuAction, top: AXUIElement, area: AXUIElement, _ t: CUTarget,
                          _ token: CUCancellation.Token) throws -> ActOutcome {
        CULog.act.notice("menu in \(t.appName, privacy: .public): the page's own menu bar (\(a.path.count, privacy: .public) levels)")
        var item = top
        var openMenu: AXUIElement?
        for depth in 0..<a.path.count {
            try token.check()
            let label = pageItemLabel(item) ?? a.path[depth]
            if ax.bool(item, kAXEnabledAttribute) == false {
                closePageMenu(t)
                throw CUError(code: "unsupported", message: "“\(label)” in the page's menu is disabled right now",
                              data: ["disabled": .string(label)])
            }
            let last = depth == a.path.count - 1
            let menusBefore = Set(pageMenus(in: area).map { AXIdentity(element: $0) })
            guard let point = ElementInfo(item, ax).center, try windowClick(at: point, t) else {
                closePageMenu(t)
                throw CUError.unsupported("the page's “\(label)” menu item can't be clicked here (it is outside the window, or the window can't be reached) — scroll it into view, or call app.requestForeground(reason)")
            }
            if last {
                // Chosen: its menu closes (or the item goes away).
                // A closed menu may stay alive to accessibility with its old frame (WebKit keeps a `hidden` menu's
                // element): it is closed once the page lists it among its menus no more.
                let closed = waitFor(Self.pageMenuWaitMs) {
                    guard let m = openMenu else { return !self.ax.isAlive(item) }
                    if !self.ax.isAlive(m) || (self.ax.frame(m).map { $0.width <= 0 || $0.height <= 0 } ?? true) { return true }
                    let id = AXIdentity(element: m)
                    return !self.pageMenus(in: area).contains { AXIdentity(element: $0) == id }
                }
                let path = a.path.joined(separator: " › ")
                CULog.act.notice("menu in \(t.appName, privacy: .public): the page's menu item clicked — menu \(closed ? "closed" : "still open", privacy: .public)")
                return ActOutcome(rung: .processEvents, detail: closed
                    ? "chose \(path) from the page's own menu bar, with real clicks (its menu closed)"
                    : "clicked \(path) in the page's own menu bar, but its menu is still open and nothing else changed that accessibility can see — check state() or a screenshot")
            }
            // Opened: a menu that was not there before, under the page.
            var opened: AXUIElement?
            _ = waitFor(Self.pageMenuWaitMs) {
                opened = self.pageMenus(in: area).first { !menusBefore.contains(AXIdentity(element: $0)) }
                    ?? (self.ax.bool(item, kAXExpandedAttribute) == true ? self.pageMenus(in: area).last : nil)
                return opened != nil
            }
            guard let menu = opened else {
                CULog.act.notice("menu in \(t.appName, privacy: .public): the page's “\(label, privacy: .public)” menu did not open")
                throw CUError.unsupported("clicked the page's “\(label)” menu, and no menu opened that accessibility can see — check with a screenshot; the page may need \(t.appName) in front (app.requestForeground(reason))")
            }
            openMenu = menu
            let items = pageMenuItems(menu)
            guard let next = Self.matchItem(a.path[depth + 1], items, labelOf: pageItemLabel) else {
                let have = items.compactMap(pageItemLabel).prefix(30).joined(separator: ", ")
                closePageMenu(t)
                throw CUError.invalidParams("no “\(a.path[depth + 1])” in the page's “\(label)” menu — it has: \(have)")
            }
            item = next
        }
        return ActOutcome(rung: .processEvents)
    }

    /// Escape closes a page menu left open by a refused step (nothing chosen).
    private func closePageMenu(_ t: CUTarget) {
        var s = synth
        s.sleep = { _ in }
        s.key(pid: t.pid, code: CUKeyCodes.code(for: .escape), flags: [], route: .publicPid)
    }

    private func waitFor(_ ms: Double, _ done: () -> Bool) -> Bool {
        let deadline = clock.nowMs() + ms
        repeat {
            if done() { return true }
            if clock.nowMs() >= deadline { return false }
            usleep(30_000)
        } while true
    }

    /// The page's menu bar: the first `AXMenuBar` under the web area, breadth first, bounded.
    func pageMenuBar(in area: AXUIElement) -> AXUIElement? {
        firstDescendants(of: area, maxNodes: 1500) { self.ax.string($0, kAXRoleAttribute) == kAXMenuBarRole }.first
    }

    /// The menus open in the page.
    func pageMenus(in area: AXUIElement) -> [AXUIElement] {
        firstDescendants(of: area, maxNodes: 3000, all: true) { self.ax.string($0, kAXRoleAttribute) == kAXMenuRole }
    }

    /// A menu bar's or menu's items: its menu items (through groups, a few levels down).
    func pageMenuItems(_ container: AXUIElement) -> [AXUIElement] {
        let itemRoles: Set<String> = ["AXMenuBarItem", kAXMenuItemRole, kAXButtonRole, "AXMenuButton"]
        var out: [AXUIElement] = []
        var level = ax.elements(container, kAXChildrenAttribute)
        for _ in 0..<3 where !level.isEmpty {
            var next: [AXUIElement] = []
            for e in level {
                let role = ax.string(e, kAXRoleAttribute) ?? ""
                if itemRoles.contains(role) { out.append(e) } else if role != kAXMenuRole { next.append(contentsOf: ax.elements(e, kAXChildrenAttribute)) }
            }
            level = next
        }
        return out
    }

    func pageItemLabel(_ e: AXUIElement) -> String? {
        if let l = ElementInfo(e, ax).labels.compactMap({ $0 }).first(where: { !$0.isEmpty }) { return l }
        return ax.elements(e, kAXChildrenAttribute).lazy.compactMap { self.ax.string($0, kAXValueAttribute) ?? self.ax.string($0, kAXTitleAttribute) }
            .first { !$0.isEmpty }
    }

    /// Exact (normalised), then without a trailing ellipsis, then a prefix — as the app menu bar matches.
    static func matchItem(_ raw: String, _ items: [AXUIElement], labelOf: (AXUIElement) -> String?) -> AXUIElement? {
        let want = CUMenuWalker.normalize(raw)
        let named = items.compactMap { e in labelOf(e).map { (e, CUMenuWalker.normalize($0)) } }
        return named.first { $0.1 == want }?.0
            ?? named.first { $0.1.trimmingCharacters(in: CharacterSet(charactersIn: "…")) == want }?.0
            ?? named.first { $0.1.hasPrefix(want) }?.0
    }

    /// Breadth-first descendants of `root` matching `match`: the first one, or all (`all`), bounded in nodes.
    private func firstDescendants(of root: AXUIElement, maxNodes: Int, all: Bool = false,
                                  _ match: (AXUIElement) -> Bool) -> [AXUIElement] {
        var queue = ax.elements(root, kAXChildrenAttribute)
        var seen = 0
        var out: [AXUIElement] = []
        while !queue.isEmpty, seen < maxNodes {
            let n = queue.removeFirst()
            seen += 1
            if match(n) {
                out.append(n)
                if !all { return out }
                continue
            }
            queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
        }
        return out
    }
}
