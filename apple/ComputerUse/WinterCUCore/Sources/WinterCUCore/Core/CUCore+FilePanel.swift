import ApplicationServices
import Foundation

// File panels (the open panel, 2026-10-14, and its reviews): what a native Open or Save panel may be made to choose. A
// path naming a protected location — the save floor's list (shell startup files, agent settings, ~/.ssh, LaunchAgents),
// and for a panel also anything in a hidden folder of the home (.aws, .gnupg, .config …) or a keychain — judged on its
// CANONICAL form (~ expanded, . and .. resolved, symlinks resolved on its longest existing prefix, /System/Volumes/Data
// stripped, compared without case) is refused four ways, each closing a way around the others:
//   1. text going into a sheet or panel (`type`, `paste`, `setValue`, a typing `key`) BEFORE it is sent — judged with the
//      field's current value and with everything typed into that panel since its last choice (a path assembled over
//      several calls, into a Go to folder field accessibility may not even show);
//   2. the field's VALUE after the write, cleared and refused;
//   3. the act that CHOOSES — the panel's default button, Return / Enter / ⌘O / ⌘↓ in it, a Return inside typed or pasted
//      text, a double-click or Open on an item: what the panel would choose (selected items' URLs or names, its fields'
//      values, what was typed into it) is read first; a protected one refuses it, and when nothing can be read after text
//      was sent into that panel it fails CLOSED;
//   4. a drag whose source is a file item (it has an `AXURL`): that file judged first.

extension CUFloors {
    /// `Library/<these>` under the home is protected. Mirrored by `SECRET_LIBRARY_FOLDERS` in
    /// `packages/core/src/computer-use/browser/upload-paths.ts` (a test keeps the two the same).
    public static let secretLibraryFolders: Set<String> = ["Keychains", "Cookies"]

    /// How a path is resolved (realpath); replaceable by tests, which also record what it is asked.
    nonisolated(unsafe) static var resolveProbe: (String) -> String? = { p in
        guard let r = realpath(p, nil) else { return nil }
        defer { free(r) }
        return String(cString: r)
    }

    /// Places the helper never stats or resolves — macOS asks the user before an app reads its Desktop, Documents,
    /// Downloads, iCloud Drive or a cloud provider's folder, a removable or network volume (the third security pass:
    /// the helper must never raise a privacy prompt). A path in one is judged LEXICALLY. Pure.
    static func noTouch(_ path: String, home: String) -> Bool {
        let lp = path.lowercased()
        let h = lexicalHome(home).lowercased()
        let roots = ["/volumes", "/network", "/net", "/home", "/system/volumes/data/volumes"]
            + ["desktop", "documents", "downloads", "library/mobile documents", "library/cloudstorage"].map { h + "/" + $0 }
        return roots.contains { lp == $0 || lp.hasPrefix($0 + "/") }
    }

    static func lexicalHome(_ home: String) -> String { (home as NSString).standardizingPath }

    /// A path's canonical form: ~ expanded, . and .. resolved, a `/System/Volumes/Data` firmlink prefix dropped, symlinks
    /// resolved on its longest existing prefix OUTSIDE the places in `noTouch` (realpath reads no file's content). Nil for
    /// a relative path with no `base`.
    static func canonicalPath(_ raw: String, home: String, base: String? = nil) -> String? {
        var p = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return nil }
        if p == "~" { p = home } else if p.hasPrefix("~/") { p = home + String(p.dropFirst(1)) }
        if !p.hasPrefix("/") {
            guard let base else { return nil }
            p = base + "/" + p
        }
        // . and .. first, lexically (as the panel's Go to folder does), and the Data volume's firmlink.
        var parts: [String] = []
        for c in p.split(separator: "/").map(String.init) {
            if c == "." || c.isEmpty { continue }
            if c == ".." { if !parts.isEmpty { parts.removeLast() }; continue }
            parts.append(c)
        }
        if parts.count >= 3, parts[0].lowercased() == "system", parts[1].lowercased() == "volumes", parts[2].lowercased() == "data" {
            parts.removeFirst(3)
        }
        // Then the links, on the longest prefix that exists and lies outside every no-touch place.
        var head = parts
        var tail: [String] = []
        var resolved: String? = nil
        while !head.isEmpty {
            let prefix = "/" + head.joined(separator: "/")
            if !noTouch(prefix, home: home), let r = resolveProbe(prefix) {
                resolved = r
                break
            }
            tail.insert(head.removeLast(), at: 0)
        }
        var out = ((resolved ?? "") + (tail.isEmpty ? "" : "/" + tail.joined(separator: "/")))
        if out.isEmpty { out = "/" }
        for prefix in ["/System/Volumes/Data/", "/private/var/", "/private/tmp/"] where out.lowercased().hasPrefix(prefix.lowercased()) {
            out = prefix == "/System/Volumes/Data/" ? "/" + out.dropFirst(prefix.count) : String(out.dropFirst("/private".count))
        }
        return out
    }

    /// A relative path judged by its names alone, conservatively: any hidden name or protected name in it. Pure.
    static func namesOnlyProtected(_ path: String) -> Bool {
        let names = path.split(separator: "/").map { String($0).lowercased() }.filter { $0 != "." && $0 != ".." }
        return names.contains { n in n.hasPrefix(".") || lowered(protectedFolderNames).contains(n) || lowered(secretLibraryFolders).contains(n) }
            || names.last.map { lowered(shellStartupNames).contains($0) || lowered(protectedConfigNames).contains($0) } == true
    }

    /// A path a file panel must not be pointed at (canonical form, any case): the save floor's names anywhere (a shell
    /// startup file, an agent config file, a folder of `protectedFolderNames`, fish's config), or — under the home — any
    /// folder or file whose name starts with "." or `Library/Keychains` / `Library/Cookies`. A relative path with no folder
    /// to resolve it against is judged by its names alone, conservatively (`../.aws` is protected). Pure but for realpath.
    public static func isProtectedPanelPath(_ path: String, home: String = NSHomeDirectory(), base: String? = nil) -> Bool {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        // A relative path: its names alone always count too, the panel's folder known or not.
        if !trimmed.hasPrefix("/") && !trimmed.hasPrefix("~"), namesOnlyProtected(trimmed) { return true }
        guard let canon = canonicalPath(trimmed, home: home, base: base) else { return false }
        let lp = canon.lowercased()
        let names = lp.split(separator: "/").map(String.init)
        if let last = names.last, lowered(shellStartupNames).contains(last) || lowered(protectedConfigNames).contains(last) { return true }
        if names.contains(where: lowered(protectedFolderNames).contains) { return true }
        if lp.contains("/.config/fish/") { return true }
        let h = (canonicalPath(home, home: home) ?? home).lowercased()
        guard lp.hasPrefix(h + "/") else { return false }
        let rel = lp.dropFirst(h.count + 1).split(separator: "/").map(String.init)
        if rel.contains(where: { $0.hasPrefix(".") }) { return true }
        return rel.count >= 2 && rel[0] == "library" && lowered(secretLibraryFolders).contains(rel[1])
    }

    static func lowered(_ s: Set<String>) -> Set<String> { Set(s.map { $0.lowercased() }) }

    /// Text typed or set into a panel that names such a path (the whole text, or any path-like token of it).
    public static func typedPanelPathIsProtected(_ text: String, home: String = NSHomeDirectory(), base: String? = nil) -> Bool {
        pathsMentioned(in: text).contains { isProtectedPanelPath($0, home: home, base: base) }
    }

    /// One thing a panel would choose — a file URL, a path, or an item's bare name — is protected.
    public static func panelChoiceIsProtected(_ raw: String, home: String = NSHomeDirectory()) -> Bool {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return false }
        if let u = URL(string: s), u.isFileURL { s = u.path }
        if s.hasPrefix("/") || s.hasPrefix("~") || s.contains("/") { return isProtectedPanelPath(s, home: home) }
        // A bare name (an item's title, a pop-up's folder): "id_ed25519, 411 bytes" names "id_ed25519".
        let name = (s.components(separatedBy: ", ").first ?? s).lowercased()
        return name.hasPrefix(".") || lowered(shellStartupNames).contains(name) || lowered(protectedConfigNames).contains(name)
            || lowered(protectedFolderNames).contains(name) || lowered(secretLibraryFolders).contains(name)
    }

    /// The parts of text a Return splits it into (\n, \r, \r\n).
    static func returnSegments(_ text: String) -> [String] {
        text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }
}

/// What was typed into one panel since its last choice (per target): judged with what comes next.
struct CUPanelTyped {
    var panel: AXIdentity
    var text: String
}

extension CUCore {
    static let panelPathWords = "a protected location (a shell startup file, ~/.ssh or another hidden folder of the home, LaunchAgents, a keychain, or Winter's or Claude's settings)"

    /// The sheet or panel `e` lies in: its `AXSheet`, or a window of another kind than a standard one (a dialog, a
    /// floating panel) or another than the bound one. Nil in the bound window's own content.
    func panelRoot(_ e: AXUIElement, _ t: CUTarget) -> AXUIElement? {
        var cur: AXUIElement? = e
        for _ in 0..<60 {
            guard let c = cur else { return nil }
            let role = ax.string(c, kAXRoleAttribute)
            if role == kAXSheetRole { return c }
            if role == kAXWindowRole { return inSheetOrPanel(c, t) ? c : nil }
            cur = ax.element(c, kAXParentAttribute)
        }
        return nil
    }

    /// The folder the panel shows, as a path, when it says (its `AXDocument` or `AXURL`); nil otherwise.
    func panelFolder(_ root: AXUIElement) -> String? {
        for name in [kAXDocumentAttribute, kAXURLAttribute] {
            if let v = ax.attribute(root, name) {
                if CFGetTypeID(v) == CFURLGetTypeID(), (v as! URL).isFileURL { return (v as! URL).path }
                if let s = v as? String, let u = URL(string: s), u.isFileURL { return u.path }
            }
        }
        return nil
    }

    /// What was typed into the panel `root` since its last choice (a new panel starts empty).
    func typedInto(_ root: AXUIElement, _ t: CUTarget) -> String? {
        guard let rec = panelTyped[t.id], rec.panel == AXIdentity(element: root) else { return nil }
        return rec.text
    }

    func noteTyped(_ text: String, into root: AXUIElement, _ t: CUTarget) {
        let id = AXIdentity(element: root)
        let was = panelTyped[t.id].flatMap { $0.panel == id ? $0.text : nil } ?? ""
        // After a Return the panel chose (or tried): only what follows it is still pending.
        let segs = CUFloors.returnSegments(text)
        panelTyped[t.id] = CUPanelTyped(panel: id, text: segs.count > 1 ? segs.last! : was + text)
    }

    /// 1. Text about to go into a sheet or panel (typed, pasted, set, or one typing key): refused before it is sent when
    /// it names a protected location — alone, after the field's current value, or after what was typed into this panel
    /// since its last choice. Text holding a Return chooses: the choice is judged too, with the field's value-to-be.
    /// `replacing`: the text becomes the field's whole value (`setValue`) — judged alone, never after what it replaces.
    func refuseProtectedPanelText(_ text: String, into e: AXUIElement?, _ t: CUTarget, replacing: Bool = false) throws {
        guard t.accessible, let target = e ?? reportedFocus(t), let root = panelRoot(target, t) else { return }
        let base = panelFolder(root)
        let current = replacing ? "" : (ax.string(target, kAXValueAttribute) ?? "")
        let typed = replacing ? "" : (typedInto(root, t) ?? "")
        let segs = CUFloors.returnSegments(text)
        var candidates = segs
        candidates.append(current + segs[0])
        candidates.append(typed + segs[0])
        if let hit = candidates.first(where: { CUFloors.typedPanelPathIsProtected($0, base: base) }) {
            CULog.act.notice("type in \(t.appName, privacy: .public): a protected path into a sheet or panel — refused before sending")
            _ = hit
            throw CUError.refused(.savePath, "the text names \(Self.panelPathWords) and would go into \(t.appName)'s panel — nothing was sent; ask the user to choose it")
        }
        if segs.count > 1 {
            // A Return in it CHOOSES: what the panel would choose, with the field holding what comes before the Return.
            try refuseProtectedChoiceIn(root, item: nil, t, extra: [current + segs[0], typed + segs[0]], sending: true)
        }
        if replacing { panelTyped[t.id] = CUPanelTyped(panel: AXIdentity(element: root), text: text) } else { noteTyped(text, into: root, t) }
    }

    /// ⌘V into a sheet or panel: what the clipboard holds (put there by anything — a shell's pbcopy) is judged like typed
    /// text before the key is sent, and recorded; file URLs on it are judged each (the third security pass).
    func refuseProtectedClipboard(into e: AXUIElement?, _ t: CUTarget) throws {
        guard t.accessible, let target = e ?? reportedFocus(t), let root = panelRoot(target, t) else { return }
        let pb = pasteboard()
        if let hit = pb.readFileURLs().first(where: { CUFloors.panelChoiceIsProtected($0) }) {
            CULog.act.notice("key in \(t.appName, privacy: .public): the clipboard holds a protected file — cmd+V refused")
            throw CUError.refused(.savePath, "the clipboard holds \(Self.panelPathWords) (\u{201C}\(hit.prefix(80))\u{201D}) and ⌘V would put it into \(t.appName)'s panel — nothing was sent; ask the user to choose it")
        }
        try refuseProtectedPanelText(pb.readString() ?? "", into: target, t)
        _ = root
    }

    /// 2. After text went into a sheet or panel: the VALUE each field now holds (the one named and the focus) judged
    /// whole; a protected one is cleared (when the field takes a value) and refused.
    func refuseProtectedPanelValue(_ named: AXUIElement?, _ t: CUTarget) throws {
        guard t.accessible else { return }
        var seen: [AXUIElement] = []
        for e in [named, reportedFocus(t)].compactMap({ $0 }) where !seen.contains(where: { CFEqual($0, e) }) {
            seen.append(e)
            guard let root = panelRoot(e, t), let v = ax.string(e, kAXValueAttribute),
                  CUFloors.typedPanelPathIsProtected(v, base: panelFolder(root)) else { continue }
            var cleared = false
            if ax.isSettable(e, kAXValueAttribute), (try? ax.set(e, kAXValueAttribute, "" as CFString)) != nil {
                cleared = ax.string(e, kAXValueAttribute)?.isEmpty ?? false
            }
            CULog.act.notice("type in \(t.appName, privacy: .public): a panel field now names a protected path — \(cleared ? "cleared" : "not cleared", privacy: .public), refused")
            throw CUError.refused(.savePath, "\(t.appName)'s panel field now names \(Self.panelPathWords)\(cleared ? " — it was cleared" : " — clear it before going on"); nothing in the panel may choose it — ask the user to choose it")
        }
    }

    /// Whether `a` is an act that makes a sheet or panel CHOOSE: a press of its default button (or of any of its buttons
    /// but Cancel when it names none), Return, Enter, ⌘O or ⌘↓ into it, a double-click or Open on an item in it. The
    /// element it acts on (nil: the focus), and the panel.
    func choosingAct(_ a: CUAction, _ t: CUTarget) -> (element: AXUIElement?, panel: AXUIElement)? {
        guard t.accessible else { return nil }
        switch a {
        case .click(let c):
            let e: AXUIElement? = c.ref.flatMap { try? element($0, in: t) } ?? attemptPoint(a, t).flatMap { elementAt($0, in: t) }
            guard let e, let root = panelRoot(e, t) else { return nil }
            if (c.count ?? 1) >= 2 { return (e, root) }
            return pressesDefault(e, root) ? (e, root) : nil
        case .action(let x):
            guard let e = try? element(x.ref, in: t), let root = panelRoot(e, t) else { return nil }
            let name = x.name.lowercased()
            if ["open", "axopen", "confirm", "axconfirm"].contains(name) { return (e, root) }
            if ["press", "axpress"].contains(name) { return pressesDefault(e, root) ? (e, root) : nil }
            return nil
        case .key(let k):
            guard let chord = try? CUKeyChord.parse(k.combo), Self.choosingChord(chord) else { return nil }
            let e = k.into.flatMap { try? element($0, in: t) } ?? reportedFocus(t)
            guard let e, let root = panelRoot(e, t) else { return nil }
            return (e, root)
        default:
            return nil
        }
    }

    /// An act that would choose if it lands in a panel, its target not resolved there.
    func possibleChoice(_ a: CUAction, _ t: CUTarget) -> Bool {
        switch a {
        case .click(let c):
            guard (c.count ?? 1) >= 2 else { return false }
            let e: AXUIElement? = c.ref.flatMap { try? element($0, in: t) } ?? attemptPoint(a, t).flatMap { elementAt($0, in: t) }
            return e == nil
        case .key(let k):
            return (try? CUKeyChord.parse(k.combo)).map(Self.choosingChord) ?? false
        default:
            return false
        }
    }

    /// Return, Enter, ⌘O, ⌘↓ (open the selection) — with nothing else held. Pure.
    static func choosingChord(_ c: CUKeyChord) -> Bool {
        if c.modifiers.isEmpty { return [.named(.returnKey), .named(.keypadEnter)].contains(c.key) }
        if c.modifiers == [.command] {
            if case .character(let ch) = c.key { return Character(String(ch).lowercased()) == "o" }
            return c.key == .named(.down)
        }
        return false
    }

    /// `e` is (or lies in) the panel's default button — or, with none named, any of its buttons but its Cancel button.
    func pressesDefault(_ e: AXUIElement, _ root: AXUIElement) -> Bool {
        var button: AXUIElement? = e
        for _ in 0..<3 {
            guard let b = button else { return false }
            if ax.string(b, kAXRoleAttribute) == kAXButtonRole { break }
            button = ax.element(b, kAXParentAttribute)
        }
        guard let b = button, ax.string(b, kAXRoleAttribute) == kAXButtonRole else { return false }
        if let cancel = ax.element(root, kAXCancelButtonAttribute), CFEqual(cancel, b) { return false }
        if let def = ax.element(root, kAXDefaultButtonAttribute) { return CFEqual(def, b) }
        return true
    }

    static let panelReadCap = 600

    /// A row's or item's name: its own title, description or value, else its first named descendant's (two levels).
    func panelItemName(_ e: AXUIElement) -> String? {
        var queue: [(AXUIElement, Int)] = [(e, 0)]
        while !queue.isEmpty {
            let (c, d) = queue.removeFirst()
            for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                if let v = ax.string(c, name)?.trimmingCharacters(in: .whitespaces), !v.isEmpty { return v.components(separatedBy: ", ").first }
            }
            if d < 2 { queue += ax.elements(c, kAXChildrenAttribute).map { ($0, d + 1) } }
        }
        return nil
    }

    /// The agent acted in a panel (any act: a click, a key, the sidebar, ⌘⇧., a disclosure triangle): from then on a
    /// choice there that can't be read fails closed (the third security pass — only the user's own navigation passes).
    func panelOfAct(_ a: CUAction, _ t: CUTarget) -> AXIdentity? {
        guard t.accessible else { return nil }
        var e: AXUIElement? = nil
        switch a {
        case .click(let c): e = c.ref.flatMap { try? element($0, in: t) } ?? attemptPoint(a, t).flatMap { elementAt($0, in: t) }
        case .key(let k): e = k.into.flatMap { try? element($0, in: t) } ?? reportedFocus(t)
        default: e = Self.primaryRef(a).flatMap { try? element($0, in: t) } ?? reportedFocus(t)
        }
        return e.flatMap { panelRoot($0, t) }.map { AXIdentity(element: $0) }
    }

    func notePanelAct(_ id: AXIdentity?, _ t: CUTarget) {
        guard let id else { return }
        if panelTyped[t.id]?.panel != id { panelTyped[t.id] = CUPanelTyped(panel: id, text: "") }
    }

    /// A sheet open on the bound window (its first `AXSheet` child), when there is one.
    func openSheet(_ t: CUTarget) -> AXUIElement? {
        guard let w = try? windowElement(t) else { return nil }
        return ax.elements(w, kAXChildrenAttribute).first { ax.string($0, kAXRoleAttribute) == kAXSheetRole }
    }

    /// What the panel would choose, as read: the URLs, file names and titles of its selected items (and of `item`, a
    /// double-clicked one), its text fields' values (a file name, the Go to folder field), its pop-ups' values (the folder
    /// shown). `determined`: the whole panel was read and something besides its pop-ups was there to judge.
    func panelChoices(_ root: AXUIElement, item: AXUIElement?) -> (values: [String], determined: Bool) {
        var out: [String] = []
        var substantive = false
        func describe(_ e: AXUIElement, depth: Int) {
            var queue: [(AXUIElement, Int)] = [(e, 0)]
            var n = 0
            while !queue.isEmpty, n < 40 {
                let (c, d) = queue.removeFirst()
                n += 1
                if let u = ax.attribute(c, kAXURLAttribute) {
                    if CFGetTypeID(u) == CFURLGetTypeID() { out.append((u as! URL).absoluteString); substantive = true }
                    else if let s = u as? String { out.append(s); substantive = true }
                }
                for name in ["AXFilename", kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                    if let s = ax.string(c, name), !s.isEmpty { out.append(s); substantive = true }
                }
                if d < depth { queue += ax.elements(c, kAXChildrenAttribute).map { ($0, d + 1) } }
            }
        }
        // An item with no URL: its path from its own name and its disclosing rows' (an outline's or a column view's
        // parents) — judged by its names (`.ssh/id_ed25519`).
        func rowPath(_ e: AXUIElement) {
            var row: AXUIElement? = e
            for _ in 0..<3 {
                guard let r = row else { break }
                if ax.string(r, kAXRoleAttribute) == kAXRowRole { break }
                row = ax.element(r, kAXParentAttribute)
            }
            guard let r = row, ax.string(r, kAXRoleAttribute) == kAXRowRole else { return }
            var names: [String] = []
            var cur: AXUIElement? = r
            for _ in 0..<32 {
                guard let c = cur else { break }
                if let n = panelItemName(c) { names.insert(n, at: 0) }
                cur = ax.element(c, kAXDisclosedByRowAttribute)
            }
            if !names.isEmpty { out.append(names.joined(separator: "/")); substantive = true }
        }
        if let item { describe(item, depth: 3); rowPath(item) }
        var queue: [AXUIElement] = [root]
        var seen = 0
        while !queue.isEmpty, seen < Self.panelReadCap {
            let c = queue.removeFirst()
            seen += 1
            let role = ax.string(c, kAXRoleAttribute) ?? ""
            if [kAXTextFieldRole, kAXComboBoxRole, kAXPopUpButtonRole].contains(role), ax.string(c, kAXSubroleAttribute) != "AXSearchField",
               let v = ax.string(c, kAXValueAttribute), !v.isEmpty {
                out.append(v)
                if role != kAXPopUpButtonRole { substantive = true }
            }
            for name in [kAXSelectedRowsAttribute, kAXSelectedChildrenAttribute] {
                for sel in ax.elements(c, name).prefix(20) { describe(sel, depth: 3); rowPath(sel) }
            }
            queue += ax.elements(c, kAXChildrenAttribute)
        }
        return (out, substantive && queue.isEmpty)
    }

    /// The choice check on a panel: anything it would choose protected → refused; nothing readable after text was sent
    /// into it (this act — `sending` — or earlier, since its last choice) → refused, failing closed. A successful check
    /// starts the panel's typed text afresh.
    func refuseProtectedChoiceIn(_ root: AXUIElement, item: AXUIElement?, _ t: CUTarget, extra: [String] = [], sending: Bool = false,
                                 unresolved: Bool = false) throws {
        let (values, determined) = panelChoices(root, item: item)
        let typed = typedInto(root, t)
        let base = panelFolder(root)
        let candidates = values + extra + (typed.map { [$0] } ?? [])
        if let hit = candidates.first(where: { CUFloors.panelChoiceIsProtected($0) || CUFloors.typedPanelPathIsProtected($0, base: base) }) {
            CULog.act.notice("act in \(t.appName, privacy: .public): the panel would choose a protected item — refused before the press")
            throw CUError.refused(.savePath, "\(t.appName)'s panel would choose \(Self.panelPathWords) (\u{201C}\(hit.prefix(80))\u{201D}) — nothing was pressed; ask the user to choose it")
        }
        // Failing closed: text went into this panel and what it would choose can't be read — nothing to judge at all, or
        // the pending text is relative to a folder (or a field's hidden start) that can't be seen.
        let sent = sending || typed != nil || unresolved
        let pending = (extra + [typed ?? ""]).filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let unjudgeable = pending.isEmpty || pending.contains { p in
            let s = p.trimmingCharacters(in: .whitespacesAndNewlines)
            return !(s.hasPrefix("/") || s.hasPrefix("~"))
        }
        if !determined && sent && unjudgeable && base == nil {
            CULog.act.notice("act in \(t.appName, privacy: .public): what the panel would choose can't be read after text went into it — refused")
            throw CUError.refused(.savePath, "what \(t.appName)'s panel would choose can't be read after Winter typed or clicked in it — nothing was pressed (Winter can't check it isn't \(Self.panelPathWords)); the user can pick the file themselves")
        }
        if let rec = panelTyped[t.id], rec.panel == AXIdentity(element: root) { panelTyped[t.id]?.text = "" }
    }

    /// 3. Before an act that makes a sheet or panel choose.
    func refuseProtectedChoice(_ a: CUAction, _ t: CUTarget) throws {
        guard let (item, root) = choosingAct(a, t) else {
            // An act that may choose but whose target can't be placed (a double-click at a point nothing answers for, a
            // choosing key with the focus not shown in the panel) while a panel sheet is open: judged as a choice in it.
            guard t.accessible, let sheet = openSheet(t), possibleChoice(a, t) else { return }
            try refuseProtectedChoiceIn(sheet, item: nil, t, unresolved: true)
            return
        }
        let isItem: Bool = { if case .click(let c) = a { return (c.count ?? 1) >= 2 }; if case .action = a { return true }; return false }()
        try refuseProtectedChoiceIn(root, item: isItem ? item : nil, t)
    }

    /// 4. A drag whose source is a file item (an `AXURL` on it, its parents or its children, a few levels): that file
    /// judged before anything moves.
    func refuseProtectedDrag(_ a: CUDragAction, _ t: CUTarget) throws {
        guard t.accessible else { return }
        let source: AXUIElement? = a.from.ref.flatMap { try? element($0, in: t) }
            ?? (try? cuPoint(a.from.point, "drag from")).flatMap { $0 }.flatMap { try? screenPoint(for: t, shotId: a.shotId, pixel: $0) }.flatMap { elementAt($0, in: t) }
        guard let source else { return }
        var urls: [String] = []
        func url(_ e: AXUIElement) {
            if let u = ax.attribute(e, kAXURLAttribute) {
                if CFGetTypeID(u) == CFURLGetTypeID() { urls.append((u as! URL).absoluteString) } else if let s = u as? String { urls.append(s) }
            }
        }
        var cur: AXUIElement? = source
        for _ in 0..<3 { guard let c = cur else { break }; url(c); cur = ax.element(c, kAXParentAttribute) }
        var queue: [(AXUIElement, Int)] = ax.elements(source, kAXChildrenAttribute).map { ($0, 1) }
        while !queue.isEmpty, urls.count < 40 {
            let (c, d) = queue.removeFirst()
            url(c)
            if d < 2 { queue += ax.elements(c, kAXChildrenAttribute).map { ($0, d + 1) } }
        }
        // Its name too (a protected name needs no path), and a file-like source — an item in Finder or a panel — whose
        // path can't be read fails closed.
        let name = panelItemName(source)
        let hit = urls.first(where: { u in URL(string: u)?.isFileURL == true && CUFloors.panelChoiceIsProtected(u) })
            ?? name.flatMap { CUFloors.panelChoiceIsProtected($0) ? $0 : nil }
        if let hit {
            CULog.act.notice("drag in \(t.appName, privacy: .public): its source is a protected file — refused")
            throw CUError.refused(.savePath, "the drag's source is \(Self.panelPathWords) (\u{201C}\(hit.prefix(80))\u{201D}) — nothing was dragged; ask the user to move it themselves")
        }
        let fileLike = (panelRoot(source, t) != nil || t.bundleId == "com.apple.finder")
            && [kAXRowRole, kAXCellRole, kAXImageRole, kAXStaticTextRole, kAXGroupRole].contains(ax.string(source, kAXRoleAttribute) ?? "")
        if fileLike, !urls.contains(where: { URL(string: $0)?.isFileURL == true }) {
            CULog.act.notice("drag in \(t.appName, privacy: .public): a file item whose path can't be read — refused")
            throw CUError.refused(.savePath, "the drag's source is a file whose path can't be read, so Winter can't check it isn't \(Self.panelPathWords) — nothing was dragged; the user can move it themselves")
        }
    }
}
