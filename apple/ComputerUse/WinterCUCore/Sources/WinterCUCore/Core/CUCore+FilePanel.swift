import ApplicationServices
import Foundation

// File panels (the open panel, 2026-10-14, and its review's MED-2): what a native Open or Save panel may be made to
// choose. A path naming a protected location — the save floor's list (shell startup files, agent settings, ~/.ssh,
// LaunchAgents), and for a panel also anything in a hidden folder of the home (.aws, .gnupg, .config …) or a keychain —
// is refused three ways, each closing a way around the others:
//   1. text going into a sheet or panel (`type`, `paste`, `setValue`) that names one, before it is sent;
//   2. the field's VALUE after the write — a path assembled over several calls is judged whole — cleared and refused;
//   3. the press that CHOOSES (the panel's default button, Return in it, a double-click or Open on an item): what the
//      panel would choose (the selected items' URLs or names, its fields' values, the folder its pop-up shows) is read
//      first, and a protected one refuses the press.

extension CUFloors {
    /// A path a file panel must not be pointed at: the save floor's list, or — under the home — a folder or file whose
    /// name starts with "." or `Library/Keychains` / `Library/Cookies`. Pure.
    public static func isProtectedPanelPath(_ path: String, home: String = NSHomeDirectory()) -> Bool {
        if isProtectedSavePath(path, home: home) { return true }
        var p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return false }
        if p == "~" { p = home } else if p.hasPrefix("~/") { p = home + String(p.dropFirst(1)) }
        let std = (p as NSString).standardizingPath
        let h = (home as NSString).standardizingPath
        guard std.hasPrefix(h + "/") else { return false }
        let rel = String(std.dropFirst(h.count + 1)).split(separator: "/").map(String.init)
        if rel.contains(where: { $0.hasPrefix(".") }) { return true }
        return rel.count >= 2 && rel[0] == "Library" && (rel[1] == "Keychains" || rel[1] == "Cookies")
    }

    /// Text typed or set into a panel that names such a path (the whole text, or any path-like token of it). Pure.
    public static func typedPanelPathIsProtected(_ text: String, home: String = NSHomeDirectory()) -> Bool {
        pathsMentioned(in: text).contains { isProtectedPanelPath($0, home: home) }
    }

    /// One thing a panel would choose — a file URL, a path, or an item's bare name — is protected. Pure.
    public static func panelChoiceIsProtected(_ raw: String, home: String = NSHomeDirectory()) -> Bool {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return false }
        if let u = URL(string: s), u.isFileURL { s = u.path }
        if s.hasPrefix("/") || s.hasPrefix("~") { return isProtectedPanelPath(s, home: home) }
        // A bare name (an item's title, a pop-up's folder): "id_ed25519, 411 bytes" names "id_ed25519".
        let name = s.components(separatedBy: ", ").first ?? s
        return name.hasPrefix(".") || isShellStartupName(name) || protectedConfigNames.contains(name)
            || protectedFolderNames.contains(name) || name == "Keychains"
    }
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

    /// 1. Text about to go into a sheet or panel: refused when it names a protected location.
    func refuseProtectedPanelText(_ text: String, into e: AXUIElement?, _ t: CUTarget) throws {
        guard t.accessible, CUFloors.typedPanelPathIsProtected(text) else { return }
        let target = e ?? reportedFocus(t)
        guard let target, inSheetOrPanel(target, t) else { return }
        CULog.act.notice("type in \(t.appName, privacy: .public): a protected path into a sheet or panel — refused before sending")
        throw CUError.refused(.savePath, "the text names \(Self.panelPathWords) and would go into \(t.appName)'s panel — nothing was sent; ask the user to choose it")
    }

    /// 2. After text went into a sheet or panel: the VALUE each field now holds (the one named and the focus) judged
    /// whole; a protected one is cleared (when the field takes a value) and refused.
    func refuseProtectedPanelValue(_ named: AXUIElement?, _ t: CUTarget) throws {
        guard t.accessible else { return }
        var seen: [AXUIElement] = []
        for e in [named, reportedFocus(t)].compactMap({ $0 }) where !seen.contains(where: { CFEqual($0, e) }) {
            seen.append(e)
            guard inSheetOrPanel(e, t), let v = ax.string(e, kAXValueAttribute), CUFloors.typedPanelPathIsProtected(v) else { continue }
            var cleared = false
            if ax.isSettable(e, kAXValueAttribute), (try? ax.set(e, kAXValueAttribute, "" as CFString)) != nil {
                cleared = ax.string(e, kAXValueAttribute)?.isEmpty ?? false
            }
            CULog.act.notice("type in \(t.appName, privacy: .public): a panel field now names a protected path — \(cleared ? "cleared" : "not cleared", privacy: .public), refused")
            throw CUError.refused(.savePath, "\(t.appName)'s panel field now names \(Self.panelPathWords)\(cleared ? " — it was cleared" : " — clear it before going on")); nothing in the panel may choose it — ask the user to choose it")
        }
    }

    /// Whether `a` is an act that makes a sheet or panel CHOOSE: a press of its default button (or of any of its buttons
    /// but Cancel when it names no default), Return or Enter into it, a double-click or Open on an item in it. The
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
            guard let chord = try? CUKeyChord.parse(k.combo), chord.modifiers.isEmpty || chord.modifiers == [.command],
                  [.named(.returnKey), .named(.keypadEnter)].contains(chord.key) || (chord.modifiers == [.command] && chord.key == .character("o")) else { return nil }
            let e = k.into.flatMap { try? element($0, in: t) } ?? reportedFocus(t)
            guard let e, let root = panelRoot(e, t) else { return nil }
            return (e, root)
        default:
            return nil
        }
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

    /// What the panel would choose, as read: the URLs, file names and titles of its selected items (and of `item`, a
    /// double-clicked one), its text fields' values (a file name, the Go to folder field), its pop-ups' values (the
    /// folder shown). Bounded.
    func panelChoices(_ root: AXUIElement, item: AXUIElement?) -> [String] {
        var out: [String] = []
        func describe(_ e: AXUIElement, depth: Int) {
            var queue: [(AXUIElement, Int)] = [(e, 0)]
            var n = 0
            while !queue.isEmpty, n < 40 {
                let (c, d) = queue.removeFirst()
                n += 1
                if let u = ax.attribute(c, kAXURLAttribute) {
                    if CFGetTypeID(u) == CFURLGetTypeID() { out.append((u as! URL).absoluteString) } else if let s = u as? String { out.append(s) }
                }
                for name in ["AXFilename", kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                    if let s = ax.string(c, name), !s.isEmpty { out.append(s) }
                }
                if d < depth { queue += ax.elements(c, kAXChildrenAttribute).map { ($0, d + 1) } }
            }
        }
        if let item { describe(item, depth: 3) }
        var queue: [AXUIElement] = [root]
        var seen = 0
        while !queue.isEmpty, seen < 600 {
            let c = queue.removeFirst()
            seen += 1
            let role = ax.string(c, kAXRoleAttribute) ?? ""
            if [kAXTextFieldRole, kAXComboBoxRole, kAXPopUpButtonRole].contains(role), ax.string(c, kAXSubroleAttribute) != "AXSearchField",
               let v = ax.string(c, kAXValueAttribute), !v.isEmpty {
                out.append(v)
            }
            for name in [kAXSelectedRowsAttribute, kAXSelectedChildrenAttribute] {
                for sel in ax.elements(c, name).prefix(20) { describe(sel, depth: 3) }
            }
            queue += ax.elements(c, kAXChildrenAttribute)
        }
        return out
    }

    /// 3. Before a press that makes a sheet or panel choose: refused when anything it would choose is protected.
    func refuseProtectedChoice(_ a: CUAction, _ t: CUTarget) throws {
        guard let (item, root) = choosingAct(a, t) else { return }
        let isItem: Bool = { if case .click(let c) = a { return (c.count ?? 1) >= 2 }; if case .action = a { return true }; return false }()
        let hit = panelChoices(root, item: isItem ? item : nil).first { CUFloors.panelChoiceIsProtected($0) }
        guard let hit else { return }
        CULog.act.notice("act in \(t.appName, privacy: .public): the panel would choose a protected item — refused before the press")
        throw CUError.refused(.savePath, "\(t.appName)'s panel would choose \(Self.panelPathWords) (\u{201C}\(hit.prefix(80))\u{201D}) — nothing was pressed; ask the user to choose it")
    }
}
