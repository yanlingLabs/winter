import ApplicationServices
import Foundation

/// Floor F (the Phase 4 spine §2.4, RULED): Winter never turns on or approves a browser's remote debugging. In a Chromium
/// browser (by bundle id) every act on an element inside an internal inspect page (`chrome://inspect/…` and its
/// siblings — matched by the web area's `AXURL`, so it holds in every UI language) and on the "Allow remote debugging?"
/// dialog is refused, under every policy, before anything is sent. Reading stays allowed.
extension CUCore {
    static let remoteDebuggingSentence = "Winter never turns on or approves remote debugging in a browser — it would give any app on this Mac full control of the browser and its sign-ins. Ask the user to do it if they really want it."

    /// The schemes of the Chromium family's internal pages.
    static let inspectSchemes: Set<String> = ["chrome", "edge", "brave", "vivaldi", "opera", "arc"]

    /// An internal inspect page: scheme one of `inspectSchemes`, host `inspect`. Pure.
    static func isInspectPage(_ url: String?) -> Bool {
        guard let s = url, let u = URL(string: s), let scheme = u.scheme?.lowercased(), inspectSchemes.contains(scheme) else { return false }
        return u.host?.lowercased() == "inspect"
    }

    /// The dialog's English wording (its title or its text). Pure. (A localized dialog: its structural signature is to
    /// be measured and pinned — round 12.)
    static func isRemoteDebuggingDialogText(_ s: String?) -> Bool {
        guard let s = s?.lowercased() else { return false }
        return s.contains("allow remote debugging")
    }

    func floorCheckRemoteDebugging(_ p: TargetActParams, _ t: CUTarget) throws {
        guard t.accessible, let b = t.bundleId, CUChromium.bundleIds.contains(b) else { return }
        let refusal = CUError.refused(.remoteDebugging, Self.remoteDebuggingSentence)
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
        let windows = Set(sys.windows(pid: t.pid).map(\.id))
        if let last = t.remoteDebuggingScan, last.windows == windows { return last.shown }
        let shown = scanForRemoteDebuggingDialog(t)
        t.remoteDebuggingScan = (windows, shown)
        return shown
    }

    private func scanForRemoteDebuggingDialog(_ t: CUTarget) -> Bool {
        var candidates: [AXUIElement] = []
        for w in ax.elements(ax.application(t.pid), kAXWindowsAttribute) {
            let role = ax.string(w, kAXRoleAttribute), sub = ax.string(w, kAXSubroleAttribute)
            if role == kAXSheetRole || (sub != nil && sub != kAXStandardWindowSubrole) { candidates.append(w) }
            candidates.append(contentsOf: ax.elements(w, kAXChildrenAttribute).filter { ax.string($0, kAXRoleAttribute) == kAXSheetRole })
        }
        for d in candidates {
            if Self.isRemoteDebuggingDialogText(ax.string(d, kAXTitleAttribute)) { return true }
            var queue = [d]
            var seen = 0
            while !queue.isEmpty, seen < 60 {
                let n = queue.removeFirst()
                seen += 1
                for name in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] where Self.isRemoteDebuggingDialogText(ax.string(n, name)) {
                    return true
                }
                queue.append(contentsOf: ax.elements(n, kAXChildrenAttribute))
            }
        }
        return false
    }
}
