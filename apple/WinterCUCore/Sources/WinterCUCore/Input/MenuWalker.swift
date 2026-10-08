import ApplicationServices
import Foundation

/// One node of an app's menu bar as `menu(path)` walks it: a menu-bar item, a menu item, or a submenu holder.
protocol CUMenuNode {
    var menuTitle: String { get }
    var menuEnabled: Bool { get }
    /// The items one level down (through an intermediate `AXMenu`, for AX).
    var menuChildren: [Self] { get }
}

/// Resolves `["File", "Export…"]` against a menu tree. Matching ignores case, surrounding space and the
/// `...` / `…` spelling; an exact match wins over a prefix match ("Export" finds "Export…").
enum CUMenuWalker {
    static func normalize(_ s: String) -> String {
        s.replacingOccurrences(of: "...", with: "…")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }

    static func resolve<N: CUMenuNode>(_ path: [String], in roots: [N]) throws -> N {
        guard !path.isEmpty else { throw CUError.invalidParams("menu path is empty") }
        var level = roots
        var found: N?
        for (depth, raw) in path.enumerated() {
            let want = normalize(raw)
            let titled = level.filter { !$0.menuTitle.isEmpty }
            let match = titled.first { normalize($0.menuTitle) == want }
                ?? titled.first { normalize($0.menuTitle).trimmingCharacters(in: CharacterSet(charactersIn: "…")) == want }
                ?? titled.first { normalize($0.menuTitle).hasPrefix(want) }
            guard let m = match else {
                let have = titled.map(\.menuTitle).prefix(30).joined(separator: ", ")
                let where_ = depth == 0 ? "the menu bar" : "“\(path[depth - 1])”"
                throw CUError.invalidParams("no “\(raw)” in \(where_) — it has: \(have)")
            }
            if !m.menuEnabled {
                throw CUError.unsupported("“\(m.menuTitle)” is disabled right now — apps enable menu commands for their active window and what is selected in it; while the app is in the background a command may not apply to the bound window")
            }
            found = m
            if depth < path.count - 1 {
                level = m.menuChildren
                if level.isEmpty { throw CUError.invalidParams("“\(m.menuTitle)” has no submenu") }
            }
        }
        return found!
    }
}

/// The live menu bar over AX: `AXMenuBar` → `AXMenuBarItem` → `AXMenu` → `AXMenuItem` → (`AXMenu` → …).
struct CUAXMenuNode: CUMenuNode {
    let element: AXUIElement
    let ax: CUAXBackend

    var menuTitle: String { ax.string(element, kAXTitleAttribute) ?? "" }
    var menuEnabled: Bool { ax.bool(element, kAXEnabledAttribute) ?? true }
    var menuChildren: [CUAXMenuNode] {
        // An item's children are its submenu (one AXMenu); the submenu's children are the items.
        ax.elements(element, kAXChildrenAttribute).flatMap { child -> [CUAXMenuNode] in
            if ax.string(child, kAXRoleAttribute) == kAXMenuRole {
                return ax.elements(child, kAXChildrenAttribute).map { CUAXMenuNode(element: $0, ax: ax) }
            }
            return [CUAXMenuNode(element: child, ax: ax)]
        }
    }

    static func menuBar(pid: pid_t, ax: CUAXBackend) throws -> [CUAXMenuNode] {
        guard let bar = ax.element(ax.application(pid), kAXMenuBarAttribute) else {
            throw CUError.unsupported("this app exposes no menu bar")
        }
        return ax.elements(bar, kAXChildrenAttribute).map { CUAXMenuNode(element: $0, ax: ax) }
    }
}

/// Paste, however it is reached: a menu item titled Paste… or carrying the cmd+V key equivalent.
enum CUPasteMenu {
    static func isPasteTitle(_ title: String) -> Bool {
        let t = CUMenuWalker.normalize(title)
        return t == "paste" || t.hasPrefix("paste ") || t.hasPrefix("paste…") || t.hasPrefix("paste and")
    }

    /// `cmdChar` / `cmdModifiers` are the item's AXMenuItemCmdChar / AXMenuItemCmdModifiers (0 = cmd only).
    static func isPasteItem(title: String?, cmdChar: String?, cmdModifiers: Int?) -> Bool {
        if let title, isPasteTitle(title) { return true }
        if let c = cmdChar, c.uppercased() == "V", (cmdModifiers ?? 0) & 8 == 0 { return true }  // 8 = no command key
        return false
    }
}
