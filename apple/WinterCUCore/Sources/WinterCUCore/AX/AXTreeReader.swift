import ApplicationServices
import CoreGraphics
import Foundation

/// Walks an AX subtree into `CUNode`s, assigning refs through the target's identity cache.
///
/// - One batched `AXUIElementCopyMultipleAttributeValues` round trip per element.
/// - Values are fetched separately and only for value-bearing roles, so a secure field's value is never
///   requested at all (spine §2.4).
/// - Bounded by node count, depth and wall time; children past the budget are counted, not read, and
///   render as a collapsed marker the model can open with `state({within})`.
/// - Unnamed single-child wrapper groups are folded into their child to keep the state short.
struct AXTreeReader {
    static let defaultMaxNodes = 2500
    var maxNodes = AXTreeReader.defaultMaxNodes
    var maxDepth = 40
    var timeBudgetMs: Double = 2500

    static let batch: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
        kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXExpandedAttribute, "AXDisclosing",
        kAXChildrenAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXIdentifierAttribute,
        kAXPlaceholderValueAttribute, "AXDOMIdentifier",
    ]

    /// Roles whose `AXValue` the state shows (or turns into checked/unchecked).
    static let valueRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXStaticText", "AXComboBox", "AXSlider", "AXCheckBox", "AXRadioButton",
        "AXPopUpButton", "AXProgressIndicator", "AXValueIndicator", "AXIncrementor", "AXDateField", "AXTimeField",
        "AXLevelIndicator", "AXDisclosureTriangle", "AXColorWell", "AXSearchField", "AXCell", "AXHeading",
        "AXMenuButton", "AXSwitch", "AXToggle",
    ]
    static let checkRoles: Set<String> = ["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle"]
    static let collectionRoles: Set<String> = ["AXList", "AXTable", "AXOutline", "AXBrowser", "AXGrid"]
    static let wrapperRoles: Set<String> = ["AXGroup", "AXSplitGroup", "AXLayoutArea", "AXUnknown", "AXScrollArea"]
    /// Roles whose action names are worth a round trip (custom actions, `show menu`, increment…). Others skip
    /// it: one extra IPC per element adds up on large trees, and their actions are almost always the defaults.
    static let actionRoles: Set<String> = [
        "AXButton", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXRow", "AXCell", "AXLink",
        "AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXMenuItem",
        "AXMenuBarItem", "AXImage", "AXColorWell", "AXDateField", "AXSearchField", "AXDockItem",
    ]

    struct Result {
        var roots: [CUNode]
        var nodeCount: Int
        var truncated: Bool
    }

    /// Reads `roots` (the window, plus any open app-level menus). `cache` must be in a fresh generation.
    func read(roots: [AXUIElement], cache: CURefCache<AXIdentity>, now: () -> Double) -> Result {
        let deadline = now() + timeBudgetMs
        var budget = maxNodes
        var truncated = false

        func node(_ e: AXUIElement, depth: Int) -> CUNode? {
            guard budget > 0, now() < deadline else { truncated = true; return nil }
            budget -= 1
            guard let attrs = AX.copyMultiple(e, Self.batch) else { return nil }
            let role = attrs[kAXRoleAttribute].flatMap(AX.stringValue) ?? "AXUnknown"
            let subrole = attrs[kAXSubroleAttribute].flatMap(AX.stringValue)
            let payment = CUFloors.isPaymentField(role: role, texts: [
                attrs[kAXTitleAttribute].flatMap(AX.stringValue), attrs[kAXDescriptionAttribute].flatMap(AX.stringValue),
                attrs[kAXPlaceholderValueAttribute].flatMap(AX.stringValue), attrs[kAXIdentifierAttribute].flatMap(AX.stringValue),
                attrs["AXDOMIdentifier"].flatMap(AX.stringValue),
            ])
            let secure = payment || CUFloors.isSecureField(role: role, subrole: subrole)
            var name = nonEmpty(attrs[kAXTitleAttribute].flatMap(AX.stringValue))
                ?? nonEmpty(attrs[kAXDescriptionAttribute].flatMap(AX.stringValue))
            var value: String?
            var states: CUStates = []
            if !secure, Self.valueRoles.contains(role) || subrole.map(Self.valueRoles.contains) == true {
                value = AX.attribute(e, kAXValueAttribute).flatMap(AX.stringValue)
            }
            if Self.checkRoles.contains(role) || subrole.map(Self.checkRoles.contains) == true {
                if let v = value { states.insert(v == "0" ? .unchecked : .checked) }
                value = nil
            } else if role == "AXDisclosureTriangle" {
                if let v = value { states.insert(v == "0" ? .collapsed : .expanded) }
                value = nil
            } else if role == "AXStaticText" || role == "AXHeading" {
                if name == nil { name = nonEmpty(value) }
                if value == name { value = nil }
            }
            if name == nil, !secure, let ph = nonEmpty(attrs[kAXPlaceholderValueAttribute].flatMap(AX.stringValue)) {
                name = ph
            }
            if attrs[kAXEnabledAttribute].flatMap(AX.boolValue) == false { states.insert(.disabled) }
            if attrs[kAXFocusedAttribute].flatMap(AX.boolValue) == true { states.insert(.focused) }
            if attrs[kAXSelectedAttribute].flatMap(AX.boolValue) == true { states.insert(.selected) }
            if let d = attrs["AXDisclosing"].flatMap(AX.boolValue) {
                states.insert(d ? .expanded : .collapsed)
            } else if attrs[kAXExpandedAttribute].flatMap(AX.boolValue) == true {
                states.insert(.expanded)
            }
            var frame: CGRect?
            if let p = attrs[kAXPositionAttribute].flatMap(AX.pointValue), let s = attrs[kAXSizeAttribute].flatMap(AX.sizeValue) {
                frame = CGRect(origin: p, size: s)
            }
            let childElements: [AXUIElement] = {
                guard let v = attrs[kAXChildrenAttribute], CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
                return (v as! [AnyObject]).compactMap {
                    CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil
                }
            }()
            let ref = cache.ref(for: AXIdentity(element: e))
            var n = CUNode(ref: ref, role: role, subrole: subrole, name: name, value: value, states: states,
                           actions: Self.actionRoles.contains(role) ? AX.actions(e) : [], frame: frame,
                           identifier: nonEmpty(attrs[kAXIdentifierAttribute].flatMap(AX.stringValue)), payment: payment)
            if Self.collectionRoles.contains(role) {
                n.itemCount = AX.count(e, kAXRowsAttribute) ?? childElements.count
            }
            if depth >= maxDepth {
                n.unreadChildren = childElements.count
                if !childElements.isEmpty { truncated = true }
                return n
            }
            for (i, c) in childElements.enumerated() {
                if let child = node(c, depth: depth + 1) {
                    n.children.append(child)
                } else if budget <= 0 || now() >= deadline {
                    n.unreadChildren += childElements.count - i
                    break
                }
            }
            return fold(n)
        }

        var out: [CUNode] = []
        for r in roots { if let n = node(r, depth: 0) { out.append(n) } }
        return Result(roots: out, nodeCount: maxNodes - budget, truncated: truncated)
    }

    /// An unnamed wrapper with one child and nothing of its own to say is replaced by that child.
    func fold(_ n: CUNode) -> CUNode {
        guard Self.wrapperRoles.contains(n.role), n.children.count == 1, n.unreadChildren == 0,
              n.name == nil, n.value == nil, n.states.subtracting([.disabled]).isEmpty,
              CURoleWords.extraActions(n.actions).isEmpty, !n.actions.contains("AXPress")
        else { return n }
        return n.children[0]
    }

    private func nonEmpty(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }
}
