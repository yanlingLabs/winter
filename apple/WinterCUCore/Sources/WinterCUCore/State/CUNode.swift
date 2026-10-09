import CoreGraphics
import Foundation

/// One element of an observed tree, already reduced to what the state format shows (spine §4). The live
/// AX reader builds these; the formatter, the differ and `find` only ever see this pure model, which is
/// what makes them testable without a real app.
public struct CUNode: Sendable, Equatable {
    public var ref: Int
    /// The raw AX role (`AXButton`) and subrole (`AXSecureTextField`), kept for floors and matching.
    public var role: String
    public var subrole: String?
    public var name: String?
    /// The raw value (never shown for secure fields; see `isSecure`).
    public var value: String?
    public var states: CUStates
    /// Item count for collections (`list "Notes" (12 items)`).
    public var itemCount: Int?
    /// Raw AX action names (`AXPress`, `AXShowMenu`, custom `Name:Reply…`).
    public var actions: [String]
    /// Screen points, top-left origin; nil when the element reports no geometry.
    public var frame: CGRect?
    public var identifier: String?
    /// A payment input (card number, security code): treated like a password field.
    public var payment: Bool
    /// Children the reader saw but did not read (walk budget); rendered as a collapsed marker.
    public var unreadChildren: Int
    public var children: [CUNode]

    public init(ref: Int, role: String, subrole: String? = nil, name: String? = nil, value: String? = nil,
                states: CUStates = [], itemCount: Int? = nil, actions: [String] = [], frame: CGRect? = nil,
                identifier: String? = nil, payment: Bool = false, unreadChildren: Int = 0, children: [CUNode] = []) {
        self.ref = ref
        self.role = role
        self.subrole = subrole
        self.name = name
        self.value = value
        self.states = states
        self.itemCount = itemCount
        self.actions = actions
        self.frame = frame
        self.identifier = identifier
        self.payment = payment
        self.unreadChildren = unreadChildren
        self.children = children
    }

    public var isSecure: Bool { payment || CUFloors.isSecureField(role: role, subrole: subrole) }

    /// The lowercase role words the model reads (`text area`, `pop up button`).
    public var roleWords: String { CURoleWords.words(role: role, subrole: subrole) }

    /// Depth-first, self first.
    public func flattened() -> [CUNode] {
        var out: [CUNode] = []
        func walk(_ n: CUNode) {
            out.append(n)
            for c in n.children { walk(c) }
        }
        walk(self)
        return out
    }

    /// Number of descendants, including unread ones.
    public var descendantCount: Int {
        children.reduce(unreadChildren) { $0 + 1 + $1.descendantCount }
    }

    public func find(ref: Int) -> CUNode? {
        if self.ref == ref { return self }
        for c in children { if let f = c.find(ref: ref) { return f } }
        return nil
    }
}

/// The parenthesised states of a line, in their fixed print order.
public struct CUStates: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let disabled = CUStates(rawValue: 1 << 0)
    public static let focused = CUStates(rawValue: 1 << 1)
    public static let selected = CUStates(rawValue: 1 << 2)
    public static let expanded = CUStates(rawValue: 1 << 3)
    public static let collapsed = CUStates(rawValue: 1 << 4)
    public static let checked = CUStates(rawValue: 1 << 5)
    public static let unchecked = CUStates(rawValue: 1 << 6)

    static let ordered: [(CUStates, String)] = [
        (.disabled, "disabled"), (.focused, "focused"), (.selected, "selected"), (.expanded, "expanded"),
        (.collapsed, "collapsed"), (.checked, "checked"), (.unchecked, "unchecked"),
    ]

    public var words: [String] { CUStates.ordered.filter { contains($0.0) }.map(\.1) }
}

/// AX role and action names → the lowercase words of the state format.
public enum CURoleWords {
    /// Subroles that say more than their role (`close button`, `search field`) win over it.
    static let telling: Set<String> = [
        "AXSecureTextField", "AXSearchField", "AXCloseButton", "AXMinimizeButton", "AXZoomButton",
        "AXFullScreenButton", "AXToolbarButton", "AXSwitch", "AXToggle", "AXTabButton", "AXSortButton",
        "AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXOutlineRow", "AXTableRow", "AXTextAttachment",
        "AXIncrementArrow", "AXDecrementArrow", "AXDescriptionList", "AXContentList",
    ]

    public static func words(role: String, subrole: String?) -> String {
        if let s = subrole, telling.contains(s) { return split(s) }
        return split(role)
    }

    /// `AXPopUpButton` → `pop up button`; `AXShowMenu` → `show menu`; a custom action keeps its own name.
    public static func split(_ raw: String) -> String {
        var name = raw
        if name.hasPrefix("AX") { name.removeFirst(2) }
        guard !name.isEmpty else { return raw.lowercased() }
        var words: [String] = []
        var current = ""
        let chars = Array(name)
        for (i, ch) in chars.enumerated() {
            let isUpper = ch.isUppercase
            let prevLower = i > 0 && chars[i - 1].isLowercase
            let nextLower = i + 1 < chars.count && chars[i + 1].isLowercase
            let prevUpper = i > 0 && chars[i - 1].isUppercase
            if isUpper, !current.isEmpty, prevLower || (prevUpper && nextLower) {
                words.append(current)
                current = ""
            }
            current.append(ch)
        }
        if !current.isEmpty { words.append(current) }
        return words.map { $0.lowercased() }.joined(separator: " ")
    }

    /// The actions every element of its kind has; anything else is listed as `actions: …`.
    static let defaultActions: Set<String> = [
        "AXPress", "AXScrollToVisible", "AXRaise", "AXShowDefaultUI", "AXShowAlternateUI",
    ]

    /// A custom AX action is `Name:Reply\nTarget:0x…\nSelector:…`; the model only needs `Reply`.
    public static func actionWords(_ raw: String) -> String {
        if raw.hasPrefix("Name:") {
            let rest = raw.dropFirst(5)
            return String(rest.split(separator: "\n", maxSplits: 1).first ?? rest)
        }
        return split(raw)
    }

    public static func extraActions(_ raw: [String]) -> [String] {
        raw.filter { !defaultActions.contains($0) }.map(actionWords)
    }

    /// Resolves the model's action name (`show menu`, `AXShowMenu`, `Reply`) against an element's actions.
    public static func resolveAction(_ requested: String, among raw: [String]) -> String? {
        let want = requested.trimmingCharacters(in: .whitespaces).lowercased()
        if let exact = raw.first(where: { $0.lowercased() == want }) { return exact }
        if let byWords = raw.first(where: { actionWords($0).lowercased() == want }) { return byWords }
        let compact = want.replacingOccurrences(of: " ", with: "")
        return raw.first { actionWords($0).lowercased().replacingOccurrences(of: " ", with: "") == compact }
    }
}
