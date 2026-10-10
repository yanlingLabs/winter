import Foundation

// The JSON unions of the helper RPC (spine §2.1): `string | number` selectors and the `kind`-discriminated
// `action`. Each decodes exactly the wire shape and encodes it back unchanged.

/// `window?: string | number` — a window title (substring match) or a CGWindowID.
public enum CUWindowSelector: Codable, Sendable, Equatable {
    case title(String)
    case id(UInt32)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(UInt32.self) { self = .id(n); return }
        if let s = try? c.decode(String.self) { self = .title(s); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "window must be a title or a window id")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .title(let s): try c.encode(s)
        case .id(let n): try c.encode(n)
        }
    }
}

/// `query: string | { role?, name?, text? }`.
public enum CUFindQuery: Codable, Sendable, Equatable {
    case text(String)
    case fields(role: String?, name: String?, text: String?)

    private enum Keys: String, CodingKey { case role, name, text }

    public init(from decoder: Decoder) throws {
        if let c = try? decoder.singleValueContainer(), let s = try? c.decode(String.self) {
            self = .text(s)
            return
        }
        let k = try decoder.container(keyedBy: Keys.self)
        self = .fields(role: try k.decodeIfPresent(String.self, forKey: .role),
                       name: try k.decodeIfPresent(String.self, forKey: .name),
                       text: try k.decodeIfPresent(String.self, forKey: .text))
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let s):
            var c = encoder.singleValueContainer()
            try c.encode(s)
        case .fields(let role, let name, let text):
            var k = encoder.container(keyedBy: Keys.self)
            try k.encodeIfPresent(role, forKey: .role)
            try k.encodeIfPresent(name, forKey: .name)
            try k.encodeIfPresent(text, forKey: .text)
        }
    }
}

/// `gone?: number | string` — a ref, or text that must disappear.
public enum CURefOrText: Codable, Sendable, Equatable {
    case ref(Int)
    case text(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) { self = .ref(n); return }
        if let s = try? c.decode(String.self) { self = .text(s); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "gone must be a ref or text")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .ref(let n): try c.encode(n)
        case .text(let s): try c.encode(s)
        }
    }
}

/// `display?: number | "all"` — an index into the active displays (0 = the main one), or all of them.
/// A specific CGDirectDisplayID goes in `displayId` instead.
public enum CUDisplaySelector: Codable, Sendable, Equatable {
    case index(Int)
    case all

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) { self = .index(n); return }
        if let s = try? c.decode(String.self), s == "all" { self = .all; return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "display must be an index or \"all\"")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .index(let n): try c.encode(n)
        case .all: try c.encode("all")
        }
    }
}

public enum CUMouseButton: String, Codable, Sendable { case left, right, middle }
public enum CUScrollDirection: String, Codable, Sendable { case up, down, left, right }
public enum CUPasteFormat: String, Codable, Sendable { case text, html, markdown }
public enum CUCaret: String, Codable, Sendable { case start, end }

// MARK: - action payloads

public struct CUClickAction: Codable, Sendable, Equatable {
    public var ref: Int?
    public var point: [Double]?
    public var shotId: String?
    public var button: CUMouseButton?
    public var count: Int?
    public var modifiers: [String]?
    public init(ref: Int? = nil, point: [Double]? = nil, shotId: String? = nil, button: CUMouseButton? = nil,
                count: Int? = nil, modifiers: [String]? = nil) {
        self.ref = ref; self.point = point; self.shotId = shotId
        self.button = button; self.count = count; self.modifiers = modifiers
    }
}
/// The pointer moved onto an element (or a point in the latest screenshot) and left there `ms` (default 600) —
/// window-targeted, never the user's cursor — so hover-only UI appears.
public struct CUHoverAction: Codable, Sendable, Equatable {
    public var ref: Int?
    public var point: [Double]?
    public var shotId: String?
    public var ms: Int?
    public init(ref: Int? = nil, point: [Double]? = nil, shotId: String? = nil, ms: Int? = nil) {
        self.ref = ref; self.point = point; self.shotId = shotId; self.ms = ms
    }
}
public struct CUSetValueAction: Codable, Sendable, Equatable {
    public var ref: Int
    public var value: String
    public init(ref: Int, value: String) { self.ref = ref; self.value = value }
}
public struct CUTypeAction: Codable, Sendable, Equatable {
    public var text: String
    public var into: Int?
    public init(text: String, into: Int? = nil) { self.text = text; self.into = into }
}
public struct CUPasteAction: Codable, Sendable, Equatable {
    public var text: String
    public var into: Int?
    public var format: CUPasteFormat?
    public init(text: String, into: Int? = nil, format: CUPasteFormat? = nil) {
        self.text = text; self.into = into; self.format = format
    }
}
public struct CUKeyAction: Codable, Sendable, Equatable {
    public var combo: String
    public var into: Int?
    public var `repeat`: Int?
    public init(combo: String, into: Int? = nil, repeat: Int? = nil) {
        self.combo = combo; self.into = into; self.repeat = `repeat`
    }
}
public struct CUScrollAction: Codable, Sendable, Equatable {
    public var ref: Int?
    public var point: [Double]?
    public var shotId: String?
    public var direction: CUScrollDirection
    public var pages: Double?
    public init(ref: Int? = nil, point: [Double]? = nil, shotId: String? = nil, direction: CUScrollDirection,
                pages: Double? = nil) {
        self.ref = ref; self.point = point; self.shotId = shotId; self.direction = direction; self.pages = pages
    }
}
public struct CUDragEnd: Codable, Sendable, Equatable {
    public var ref: Int?
    public var point: [Double]?
    public init(ref: Int? = nil, point: [Double]? = nil) { self.ref = ref; self.point = point }
}
public struct CUDragAction: Codable, Sendable, Equatable {
    public var from: CUDragEnd
    public var to: CUDragEnd
    public var shotId: String?
    public init(from: CUDragEnd, to: CUDragEnd, shotId: String? = nil) {
        self.from = from; self.to = to; self.shotId = shotId
    }
}
public struct CUSelectAction: Codable, Sendable, Equatable {
    public var ref: Int
    public var text: String
    public var before: String?
    public var after: String?
    public var caret: CUCaret?
    public init(ref: Int, text: String, before: String? = nil, after: String? = nil, caret: CUCaret? = nil) {
        self.ref = ref; self.text = text; self.before = before; self.after = after; self.caret = caret
    }
}
public struct CUAXAction: Codable, Sendable, Equatable {
    public var ref: Int
    public var name: String
    public init(ref: Int, name: String) { self.ref = ref; self.name = name }
}
public struct CUMenuAction: Codable, Sendable, Equatable {
    public var path: [String]
    public init(path: [String]) { self.path = path }
}

/// `action` — a `kind`-discriminated union. The payload's keys sit beside `kind` in one JSON object.
public enum CUAction: Codable, Sendable, Equatable {
    case click(CUClickAction)
    case setValue(CUSetValueAction)
    case type(CUTypeAction)
    case paste(CUPasteAction)
    case key(CUKeyAction)
    case scroll(CUScrollAction)
    case drag(CUDragAction)
    case select(CUSelectAction)
    case action(CUAXAction)
    case menu(CUMenuAction)
    case hover(CUHoverAction)

    private enum KindKey: String, CodingKey { case kind }

    public var kind: String {
        switch self {
        case .click: return "click"
        case .setValue: return "setValue"
        case .type: return "type"
        case .paste: return "paste"
        case .key: return "key"
        case .scroll: return "scroll"
        case .drag: return "drag"
        case .select: return "select"
        case .action: return "action"
        case .menu: return "menu"
        case .hover: return "hover"
        }
    }

    public init(from decoder: Decoder) throws {
        let k = try decoder.container(keyedBy: KindKey.self)
        let kind = try k.decode(String.self, forKey: .kind)
        switch kind {
        case "click": self = .click(try CUClickAction(from: decoder))
        case "setValue": self = .setValue(try CUSetValueAction(from: decoder))
        case "type": self = .type(try CUTypeAction(from: decoder))
        case "paste": self = .paste(try CUPasteAction(from: decoder))
        case "key": self = .key(try CUKeyAction(from: decoder))
        case "scroll": self = .scroll(try CUScrollAction(from: decoder))
        case "drag": self = .drag(try CUDragAction(from: decoder))
        case "select": self = .select(try CUSelectAction(from: decoder))
        case "action": self = .action(try CUAXAction(from: decoder))
        case "menu": self = .menu(try CUMenuAction(from: decoder))
        case "hover": self = .hover(try CUHoverAction(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: k, debugDescription: "unknown action kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var k = encoder.container(keyedBy: KindKey.self)
        try k.encode(kind, forKey: .kind)
        switch self {
        case .click(let a): try a.encode(to: encoder)
        case .setValue(let a): try a.encode(to: encoder)
        case .type(let a): try a.encode(to: encoder)
        case .paste(let a): try a.encode(to: encoder)
        case .key(let a): try a.encode(to: encoder)
        case .scroll(let a): try a.encode(to: encoder)
        case .drag(let a): try a.encode(to: encoder)
        case .select(let a): try a.encode(to: encoder)
        case .action(let a): try a.encode(to: encoder)
        case .menu(let a): try a.encode(to: encoder)
        case .hover(let a): try a.encode(to: encoder)
        }
    }
}
