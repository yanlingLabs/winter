import AppKit
import ApplicationServices
import Foundation

/// Floor F (the Phase 4 spine §2.4, RULED): Winter never turns on or approves a browser's remote debugging. In a Chromium
/// browser (by bundle id) every act on an element inside an internal inspect page (`chrome://inspect/…` and its
/// siblings — matched by the web area's `AXURL`, so it holds in every UI language) and on the "Allow remote debugging?"
/// dialog is refused, under every policy, before anything is sent. Reading stays allowed. The dialog is known by its
/// words in the browser's OWN language: the browser's locale packs name it in every language it ships
/// (`CURemoteDebuggingLexicon`), beside the English rule; when they can't be read and the browser does not show
/// English, any dialog of it Winter can't tell apart is refused (fail closed).
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

    /// The refusal while a dialog of the browser is up that Winter can't tell from the remote-debugging one: its
    /// words could not be read in the browser's language.
    static func remoteDebuggingUnreadableSentence(_ app: String) -> String {
        "\(app) shows a dialog Winter can't tell apart from its \"Allow remote debugging?\" prompt (Winter could not read \(app)'s own words for that prompt in the language it shows) — ask the user to answer or close the dialog."
    }

    /// The dialog's English wording (its title or its text). Pure. One input of `isRemoteDebuggingDialogText(_:_:)`.
    static func isRemoteDebuggingDialogText(_ s: String?) -> Bool {
        guard let s = s?.lowercased() else { return false }
        return s.contains("allow remote debugging")
    }

    /// The dialog's wording in any language: the English rule, or one of the browser's own phrases for it. Pure.
    static func isRemoteDebuggingDialogText(_ s: String?, _ words: CURemoteDebuggingWords) -> Bool {
        if isRemoteDebuggingDialogText(s) { return true }
        if case .lexicon(let l) = words { return l.matches(s) }
        return false
    }

    /// What the browser's dialogs can be read with: its own locale packs (every language it ships), else — by the
    /// language it shows — the English rule alone or nothing (fail closed). The lexicon is read once per installed
    /// version (`CURemoteDebuggingLexiconStore`).
    func remoteDebuggingWords(_ t: CUTarget) -> CURemoteDebuggingWords {
        if let o = remoteDebuggingWordsOverride { return o(t) }
        let lexicon = NSRunningApplication(processIdentifier: t.pid)?.bundleURL.flatMap(CURemoteDebuggingLexiconStore.lexicon(appBundle:))
        return CURemoteDebuggingLexiconStore.words(lexicon: lexicon, shownLanguage: CURemoteDebuggingLexiconStore.shownLanguage(bundleId: t.bundleId))
    }

    /// Reads the browser's words ahead, off the act's path (the first read of an installed version maps every locale
    /// pack: about half a second), so a dialog that comes up later finds them ready. Once per bundle.
    func warmRemoteDebuggingWords(_ t: CUTarget) {
        remoteDebuggingWarmed?(t)
        guard remoteDebuggingWordsOverride == nil, let url = NSRunningApplication(processIdentifier: t.pid)?.bundleURL else { return }
        CURemoteDebuggingLexiconStore.warm(appBundle: url)
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
            let titles = sys.windows(pid: t.pid).map(\.title).filter { !$0.isEmpty }
            // A dialog-like window of the app, by the window server alone: above the normal level (and below menus
            // and tooltips), or a normal window with no title, never the bound one.
            let dialogLike = sys.windowStack().contains { $0.pid == t.pid && $0.id != t.windowID && $0.alpha > 0 && $0.layer > 0 && $0.layer < 100 }
                || sys.windows(pid: t.pid).contains { $0.id != t.windowID && $0.layer == 0 && $0.onScreen && $0.title.isEmpty }
            let words = titles.isEmpty && !dialogLike ? CURemoteDebuggingWords.englishOnly : remoteDebuggingWords(t)
            if Self.isInspectPageTitle(sys.window(id: t.windowID)?.title)
                || titles.contains(where: { Self.isRemoteDebuggingDialogText($0, words) }) {
                CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): an inspect page or the remote-debugging dialog (capture-only) — refused")
                throw refusal
            }
            // Fail closed here too: no words for the language it shows, and a dialog-like window is up.
            if words == .unreadable, dialogLike {
                CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): a dialog-like window in words Winter can't read (capture-only, fail closed) — refused")
                throw CUError.refused(.remoteDebugging, Self.remoteDebuggingUnreadableSentence(t.appName))
            }
            return
        }
        // The dialog: browser-modal, so while it is up nothing in the app is acted on.
        let dialog = remoteDebuggingDialogShown(t)
        if dialog.shown {
            CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): \(dialog.unreadable ? "a dialog in words Winter can't read (fail closed)" : "the remote-debugging dialog is up", privacy: .public) — refused")
            throw dialog.unreadable ? CUError.refused(.remoteDebugging, Self.remoteDebuggingUnreadableSentence(t.appName)) : refusal
        }
        // The inspect page: an act on an element inside it; with no element named (keys, typing, a point, a menu
        // command), whenever the bound window shows it. An element of the browser's own UI (the toolbar, the tab strip)
        // stays allowed — leaving the page.
        let inspect: Bool
        if let ref = Self.primaryRef(p.action), let e = try? element(ref, in: t) {
            inspect = Self.isInspectPage(webAreaURL(around: e))
        } else if let url = pageSignature(t)?.url {
            inspect = Self.isInspectPage(url)
        } else {
            // No page URL to read (its tree not built, or not readable — the leftover probes, 2026-10-13: a key went
            // through with chrome://inspect shown, the browser's page absent from the tree): the window's title, else
            // its SELECTED tab's, naming the inspect page counts (fail closed on what the window shows).
            inspect = inspectShownByTitles(t)
        }
        if inspect {
            CULog.act.notice("\(Self.actionName(p.action), privacy: .public) in \(t.appName, privacy: .public): an inspect page — refused")
            throw refusal
        }
    }

    /// The bound window's title, or the title of a tab selected in its own tab bar, is the inspect page's.
    func inspectShownByTitles(_ t: CUTarget) -> Bool {
        if Self.isInspectPageTitle(sys.window(id: t.windowID)?.title) { return true }
        guard let win = try? windowElement(t) else { return false }
        if Self.isInspectPageTitle(ax.string(win, kAXTitleAttribute)) { return true }
        return selectedTabTitles(win).contains { Self.isInspectPageTitle($0) }
    }

    /// The titles of the tabs selected in the window's own tab bars (tab groups outside any web area). Bounded.
    func selectedTabTitles(_ win: AXUIElement, maxNodes: Int = 400) -> [String] {
        var queue = [win]
        var seen = 0
        var out: [String] = []
        while !queue.isEmpty, seen < maxNodes {
            let n = queue.removeFirst()
            seen += 1
            let role = ax.string(n, kAXRoleAttribute)
            if role == "AXWebArea" { continue }
            if role == kAXTabGroupRole {
                for tab in ax.elements(n, kAXChildrenAttribute) where ax.string(tab, kAXSubroleAttribute) == "AXTabButton" || ax.string(tab, kAXRoleAttribute) == kAXRadioButtonRole {
                    let selected = ax.bool(tab, kAXSelectedAttribute) == true || ax.attribute(tab, kAXValueAttribute).flatMap(AX.boolValue) == true
                    if selected, let title = ax.string(tab, kAXTitleAttribute) ?? ax.string(tab, kAXDescriptionAttribute) { out.append(title) }
                }
                continue
            }
            queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
        }
        return out
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

    /// A dialog or sheet of the app (or a sheet on the bound window) worded "Allow remote debugging" in any language the
    /// browser ships: its title, or a text within its first nodes. Never a standard window — a page's title may say
    /// anything. `unreadable`: a dialog was up that could not be read (the browser's words unknown, and it does not show
    /// English) — refused as the remote-debugging dialog (fail closed).
    func remoteDebuggingDialogShown(_ t: CUTarget) -> (shown: Bool, unreadable: Bool) {
        // Scanned again only when the app's windows changed (a dialog or a sheet is a window of its own): an act on a
        // browser with many windows pays one window-server read, not a walk of every window.
        // (The normal level and the dialog levels — a dialog may sit above the normal one, review of round 11, MEDIUM #8 —
        // never menus or tooltips, which come and go on every hover: review of round 12, MEDIUM #5.)
        let windows = Set(sys.windowStack().filter { $0.pid == t.pid && $0.alpha > 0 && $0.layer < 100 }.map(\.id))
            .union(sys.windows(pid: t.pid).filter { $0.layer == 0 }.map(\.id))
        if let last = t.remoteDebuggingScan, last.windows == windows { return (last.shown, last.unreadable) }
        let scan = scanForRemoteDebuggingDialog(t)
        // A scan that could not tell (a walk ran out of time) is never cached: the next act scans again (review of round
        // 13, MEDIUM #8 — a slow walk's "no" was cached and the floor stayed open).
        if scan.shown || scan.complete { t.remoteDebuggingScan = (windows, scan.shown, scan.unreadable) } else { t.remoteDebuggingScan = nil }
        return (scan.shown, scan.unreadable)
    }

    /// What a bounded walk of a window found: a web area; none, the walk complete; more nodes than a dialog has (a page,
    /// not a dialog); or nothing it can tell (out of time).
    enum WebAreaWalk { case present, absent, large, unknown }

    /// How soon a window whose walk ran out of time is walked again.
    static let slowWalkAgainMs: Double = 5_000

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

    private func scanForRemoteDebuggingDialog(_ t: CUTarget) -> (shown: Bool, complete: Bool, unreadable: Bool) {
        var candidates: [AXUIElement] = []
        // The candidates known to be dialogs — every one but a standard window whose walk ran out of time (a slow page's
        // window is no dialog for the fail-closed rule; its text is still checked).
        var settled: [AXUIElement] = []
        var complete = true
        for w in ax.elements(ax.application(t.pid), kAXWindowsAttribute) {
            let role = ax.string(w, kAXRoleAttribute), sub = ax.string(w, kAXSubroleAttribute)
            if role == kAXSheetRole || (sub != nil && sub != kAXStandardWindowSubrole) { candidates.append(w); settled.append(w) }
            // A standard window with no web page in it may be the dialog too (never a browser window: its page title may
            // say anything) — review of round 11, MEDIUM #8.
            // (Only when the walk COMPLETED and found none — a slow or deep page's window that timed out is no candidate,
            // or a tab titled "how to allow remote debugging" would refuse every act: review of round 12, MEDIUM #5.)
            // (A walk out of time can't tell: the window stays a candidate, its text checked — and the answer is not
            // cached. More nodes than a dialog has: a page, no candidate — review of round 13, MEDIUM #8.)
            else {
                // (A window whose walk ran out of time is walked again at most every 5 s — meanwhile it stays a candidate,
                // its text checked: review of round 14, LOW #9.)
                let id = ax.windowID(w)
                let now = clock.nowMs()
                if let id, let at = t.remoteDebuggingSlowWalks[id], now - at < Self.slowWalkAgainMs {
                    candidates.append(w); complete = false
                } else {
                    switch webAreaWalk(w) {
                    case .absent: candidates.append(w); settled.append(w)
                    case .unknown:
                        candidates.append(w); complete = false
                        if let id {
                            // (Pruned as it grows: entries past their 5 s are of no use — review of round 15, LOW.)
                            t.remoteDebuggingSlowWalks = t.remoteDebuggingSlowWalks.filter { now - $0.value < Self.slowWalkAgainMs }
                            t.remoteDebuggingSlowWalks[id] = now
                        }
                    case .present, .large: break
                    }
                }
            }
            let sheets = ax.elements(w, kAXChildrenAttribute).filter { ax.string($0, kAXRoleAttribute) == kAXSheetRole }
            candidates.append(contentsOf: sheets)
            settled.append(contentsOf: sheets)
        }
        // The browser's words are read only when there is a dialog to read (once per installed version) — and read
        // ahead, in the background, the first time there is none.
        guard !candidates.isEmpty else {
            warmRemoteDebuggingWords(t)
            return (false, complete, false)
        }
        let words = remoteDebuggingWords(t)
        for d in candidates {
            if Self.isRemoteDebuggingDialogText(ax.string(d, kAXTitleAttribute), words) { return (true, true, false) }
            var queue = [d]
            var seen = 0
            while !queue.isEmpty, seen < 60 {
                let n = queue.removeFirst()
                seen += 1
                for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] where Self.isRemoteDebuggingDialogText(ax.string(n, name), words) {
                    return (true, true, false)
                }
                queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
            }
        }
        // Fail closed: the browser shows a language Winter has no words for, so a dialog of it can't be told from the
        // remote-debugging one — refused as it.
        if words == .unreadable, !settled.isEmpty { return (true, true, true) }
        return (false, complete, false)
    }
}
