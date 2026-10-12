import ApplicationServices
import Foundation

/// Floor F (the Phase 4 spine §2.4, RULED): Winter never turns on or approves a browser's remote debugging. In a Chromium
/// browser (by bundle id) every act on an element inside an internal inspect page (`chrome://inspect/…` and its
/// siblings — matched by the web area's `AXURL`, so it holds in every UI language) and on the "Allow remote debugging?"
/// dialog is refused, under every policy, before anything is sent. Reading stays allowed.
extension CUCore {
    static let remoteDebuggingSentence = "Winter never turns on or approves remote debugging in a browser — it would give any app on this Mac full control of the browser and its sign-ins. Ask the user to do it if they really want it."

    /// An internal inspect page: host `inspect` under any scheme that is not the web's (`chrome`, `edge`, `brave`,
    /// `vivaldi`, `opera`, `arc`, `comet`, … — review of round 11, MEDIUM #8: a fixed list missed Edge Canary's, Opera
    /// GX's and newer browsers' own schemes). Pure.
    static func isInspectPage(_ url: String?) -> Bool {
        guard let s = url, let u = URL(string: s), let scheme = u.scheme?.lowercased(), !["http", "https"].contains(scheme) else { return false }
        return u.host?.lowercased() == "inspect"
    }

    /// The inspect page's own title as a window shows it ("Inspect with Chrome Developer Tools", Edge's, …), for a
    /// window with no accessibility. Pure.
    static func isInspectPageTitle(_ s: String?) -> Bool {
        guard let s = s?.lowercased() else { return false }
        // Anchored (review of round 12, LOW: "How to Inspect with Chrome Developer Tools" matched, and so did an
        // `https://inspect.example.com` title).
        // (A browser may add its profile to a window's title — "… - Work": an optional " - …" tail, review of round 13, LOW.)
        if s.range(of: #"^inspect with [^\n]{1,40} developer tools(?: [-–—] [^\n]{1,60})?$"#, options: .regularExpression) != nil { return true }
        guard let m = s.range(of: #"^[a-z][a-z0-9+.-]*://inspect(?:[/#?]|$)"#, options: .regularExpression) else { return false }
        return !s[m].hasPrefix("http://") && !s[m].hasPrefix("https://")
    }

    /// The dialog's English wording (its title or its text). Pure. (A localized dialog: its structural signature is to
    /// be measured and pinned — round 12.)
    static func isRemoteDebuggingDialogText(_ s: String?) -> Bool {
        guard let s = s?.lowercased() else { return false }
        return s.contains("allow remote debugging")
    }

    func floorCheckRemoteDebugging(_ p: TargetActParams, _ t: CUTarget) throws {
        // Every Chromium-based BROWSER (review of round 11, MEDIUM #8: Edge Canary, Brave Beta/Nightly, Opera GX, the
        // Vivaldi snapshot, Comet — a bundle list misses them) — never an Electron or CEF app, which has no remote-debugging
        // page to protect and would pay the scan on every act, its own `<scheme>://inspect` route refused (review of
        // round 12, MEDIUM #5).
        guard t.bundleId.map(CUChromium.bundleIds.contains) == true || (t.isChromium && isWebBrowser(t)) else { return }
        let refusal = CUError.refused(.remoteDebugging, Self.remoteDebuggingSentence)
        // A capture-only bind (no accessibility) still sends point clicks: judged by the window server's titles.
        guard t.accessible else {
            let titles = sys.windows(pid: t.pid).map(\.title)
            if Self.isInspectPageTitle(sys.window(id: t.windowID)?.title) || titles.contains(where: Self.isRemoteDebuggingDialogText) {
                CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): an inspect page or the remote-debugging dialog (capture-only) — refused")
                throw refusal
            }
            return
        }
        // The dialog: browser-modal, so while it is up nothing in the app is acted on.
        if remoteDebuggingDialogShown(t) {
            CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): the remote-debugging dialog is up — refused")
            throw refusal
        }
        // The inspect page: an act on an element inside it; with no element named (keys, typing, a point, a menu
        // command), whenever the bound window shows it. An element of the browser's own UI (the toolbar, the tab strip)
        // stays allowed — leaving the page.
        let inspect: Bool
        if let ref = Self.primaryRef(p.action), let e = try? element(ref, in: t) {
            inspect = Self.isInspectPage(webAreaURL(around: e))
        } else {
            inspect = Self.isInspectPage(pageSignature(t)?.url)
        }
        if inspect {
            CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): an inspect page — refused")
            throw refusal
        }
    }

    /// The URL of the web area `e` is in (nil when it is in none: the browser's own UI).
    func webAreaURL(around e: AXUIElement) -> String? {
        var cur: AXUIElement? = e
        for _ in 0..<60 {
            guard let c = cur else { return nil }
            if ax.string(c, kAXRoleAttribute) == "AXWebArea" {
                guard let raw = ax.attribute(c, "AXURL") else { return nil }
                if CFGetTypeID(raw) == CFURLGetTypeID() { return (raw as! URL).absoluteString }
                return raw as? String
            }
            cur = ax.element(c, kAXParentAttribute)
        }
        return nil
    }

    /// A dialog or sheet of the app (or a sheet on the bound window) worded "Allow remote debugging": its title, or a
    /// text within its first nodes. Never a standard window — a page's title may say anything.
    func remoteDebuggingDialogShown(_ t: CUTarget) -> Bool {
        // Scanned again only when the app's windows changed (a dialog or a sheet is a window of its own): an act on a
        // browser with many windows pays one window-server read, not a walk of every window.
        // (The normal level and the dialog levels — a dialog may sit above the normal one, review of round 11, MEDIUM #8 —
        // never menus or tooltips, which come and go on every hover: review of round 12, MEDIUM #5.)
        let windows = Set(sys.windowStack().filter { $0.pid == t.pid && $0.alpha > 0 && $0.layer < 100 }.map(\.id))
            .union(sys.windows(pid: t.pid).filter { $0.layer == 0 }.map(\.id))
        if let last = t.remoteDebuggingScan, last.windows == windows { return last.shown }
        let scan = scanForRemoteDebuggingDialog(t)
        // A scan that could not tell (a walk ran out of time) is never cached: the next act scans again (review of round
        // 13, MEDIUM #8 — a slow walk's "no" was cached and the floor stayed open).
        if scan.shown || scan.complete { t.remoteDebuggingScan = (windows, scan.shown) } else { t.remoteDebuggingScan = nil }
        return scan.shown
    }

    /// What a bounded walk of a window found: a web area; none, the walk complete; more nodes than a dialog has (a page,
    /// not a dialog); or nothing it can tell (out of time).
    enum WebAreaWalk { case present, absent, large, unknown }

    func webAreaWalk(_ w: AXUIElement, maxNodes: Int = 200, maxMs: Double = 30) -> WebAreaWalk {
        let deadline = clock.nowMs() + maxMs
        var queue = [w]
        var next = 0
        while next < queue.count {
            if next >= maxNodes { return .large }
            if clock.nowMs() >= deadline { return .unknown }
            if ax.string(queue[next], kAXRoleAttribute) == "AXWebArea" { return .present }
            queue.append(contentsOf: ax.elements(queue[next], kAXChildrenAttribute))
            next += 1
        }
        return .absent
    }

    private func scanForRemoteDebuggingDialog(_ t: CUTarget) -> (shown: Bool, complete: Bool) {
        var candidates: [AXUIElement] = []
        var complete = true
        for w in ax.elements(ax.application(t.pid), kAXWindowsAttribute) {
            let role = ax.string(w, kAXRoleAttribute), sub = ax.string(w, kAXSubroleAttribute)
            if role == kAXSheetRole || (sub != nil && sub != kAXStandardWindowSubrole) { candidates.append(w) }
            // A standard window with no web page in it may be the dialog too (never a browser window: its page title may
            // say anything) — review of round 11, MEDIUM #8.
            // (Only when the walk COMPLETED and found none — a slow or deep page's window that timed out is no candidate,
            // or a tab titled "how to allow remote debugging" would refuse every act: review of round 12, MEDIUM #5.)
            // (A walk out of time can't tell: the window stays a candidate, its text checked — and the answer is not
            // cached. More nodes than a dialog has: a page, no candidate — review of round 13, MEDIUM #8.)
            else {
                switch webAreaWalk(w) {
                case .absent: candidates.append(w)
                case .unknown: candidates.append(w); complete = false
                case .present, .large: break
                }
            }
            candidates.append(contentsOf: ax.elements(w, kAXChildrenAttribute).filter { ax.string($0, kAXRoleAttribute) == kAXSheetRole })
        }
        for d in candidates {
            if Self.isRemoteDebuggingDialogText(ax.string(d, kAXTitleAttribute)) { return (true, true) }
            var queue = [d]
            var seen = 0
            while !queue.isEmpty, seen < 60 {
                let n = queue.removeFirst()
                seen += 1
                for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] where Self.isRemoteDebuggingDialogText(ax.string(n, name)) {
                    return (true, true)
                }
                queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
            }
        }
        return (false, complete)
    }
}
