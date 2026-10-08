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
                throw CUError.unsupported("“\(m.menuTitle)” is disabled right now")
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

    var menuTitle: String { AX.string(element, kAXTitleAttribute) ?? "" }
    var menuEnabled: Bool { AX.bool(element, kAXEnabledAttribute) ?? true }
    var menuChildren: [CUAXMenuNode] {
        // An item's children are its submenu (one AXMenu); the submenu's children are the items.
        AX.elements(element, kAXChildrenAttribute).flatMap { child -> [CUAXMenuNode] in
            if AX.string(child, kAXRoleAttribute) == kAXMenuRole {
                return AX.elements(child, kAXChildrenAttribute).map(CUAXMenuNode.init)
            }
            return [CUAXMenuNode(element: child)]
        }
    }

    static func menuBar(pid: pid_t) throws -> [CUAXMenuNode] {
        guard let bar = AX.element(AX.app(pid), kAXMenuBarAttribute) else {
            throw CUError.unsupported("this app exposes no menu bar")
        }
        return AX.elements(bar, kAXChildrenAttribute).map(CUAXMenuNode.init)
    }
}
