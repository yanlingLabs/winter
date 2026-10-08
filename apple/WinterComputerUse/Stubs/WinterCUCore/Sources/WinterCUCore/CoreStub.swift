import ApplicationServices
import CoreGraphics
import Foundation

// STUB of the core API the helper shell calls (ComputerV2 phase-1 contract §3b), with the real package's
// names (typealiases to `CUEmpty`, the optional `callId` on waits, `status`/`permissionsRequest`). Every
// params/result struct's stored property names are the JSON keys of the helper RPC (§2.1), so the shell
// decodes a request's `params` straight into them and encodes the result straight back. `CUCore` answers
// `status` from the non-prompting checks, every automation call and `permissionsRequest` `unsupported`; the
// lifecycle calls succeed and do nothing. Deleted at merge.

// MARK: - JSON and errors

public enum CUJSON: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CUJSON])
    case object([String: CUJSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([CUJSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: CUJSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

/// `code` is one of the helper RPC's error codes (§2.3).
public struct CUError: Error, Codable, Sendable {
    public var code: String
    public var message: String
    public var data: [String: CUJSON]?

    public init(code: String, message: String, data: [String: CUJSON]? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

// MARK: - Events (core → shell)

@MainActor public protocol CUCoreEvents: AnyObject {
    func targetBound(sessionId: String, pid: pid_t, windowID: CGWindowID, appName: String, mirror: Bool)
    func targetReleased(sessionId: String, pid: pid_t, windowID: CGWindowID)
    func actionAt(sessionId: String, pid: pid_t, windowID: CGWindowID, point: CGPoint, kind: String, dragTo: CGPoint?)
    func targetLost(targetId: String, reason: String)
    func permissionsChanged(accessibility: Bool, screenRecording: Bool)
    func willSendEscape()
}

// MARK: - Shared shapes

/// `string | number`: a window title or a window id.
public enum CUWindowSelector: Codable, Sendable, Equatable {
    case title(String)
    case id(Int)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) { self = .id(n) } else { self = .title(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .title(let t): try c.encode(t)
        case .id(let n): try c.encode(n)
        }
    }
}

/// `number | "all"`.
public enum CUDisplaySelector: Codable, Sendable, Equatable {
    case index(Int)
    case all

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) { self = .index(n); return }
        let s = try c.decode(String.self)
        guard s == "all" else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "display is a number or \"all\"") }
        self = .all
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .index(let n): try c.encode(n)
        case .all: try c.encode("all")
        }
    }
}

/// `number | string`: a ref, or text that must be gone.
public enum CUGone: Codable, Sendable, Equatable {
    case ref(Int)
    case text(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Int.self) { self = .ref(n) } else { self = .text(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .ref(let n): try c.encode(n)
        case .text(let t): try c.encode(t)
        }
    }
}

public struct CUElementQuery: Codable, Sendable, Equatable {
    public var role: String?
    public var name: String?
    public var text: String?
}

/// `string | { role?, name?, text? }`.
public enum CUFindQuery: Codable, Sendable, Equatable {
    case text(String)
    case match(CUElementQuery)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .text(s) } else { self = .match(try c.decode(CUElementQuery.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s): try c.encode(s)
        case .match(let q): try c.encode(q)
        }
    }
}

public struct CUBudget: Codable, Sendable, Equatable {
    public var maxLongEdge: Int
    public var tile: Int?
    public var maxTiles: Int?
    public var quality: Double
}

public struct CUSettle: Codable, Sendable, Equatable {
    public var maxMs: Int
}

// MARK: - Status and permissions

public struct CUEmpty: Codable, Sendable, Equatable { public init() {} }

public enum CUPermissionKind: String, Codable, Sendable { case accessibility, screenRecording }

public struct CUPermissions: Codable, Sendable, Equatable {
    public var accessibility: Bool
    public var screenRecording: Bool
}

public typealias StatusParams = CUEmpty
public struct StatusResult: Codable, Sendable { public var helperVersion: String; public var permissions: CUPermissions }

public struct PermissionsRequestParams: Codable, Sendable { public var kind: CUPermissionKind }
public struct PermissionsRequestResult: Codable, Sendable { public var opened: Bool }

// MARK: - Discovery

public typealias AppsListParams = CUEmpty
public struct AppsListResult: Codable, Sendable {
    public struct App: Codable, Sendable { public var name: String; public var bundleId: String; public var running: Bool; public var pid: Int? }
    public var apps: [App]
}

public typealias ScreenWindowsParams = CUEmpty
public struct ScreenWindowsResult: Codable, Sendable {
    public struct Window: Codable, Sendable {
        public var app: String; public var bundleId: String; public var pid: Int; public var windowId: Int
        public var title: String; public var frame: [Double]; public var onScreen: Bool
    }
    public var windows: [Window]
}

// MARK: - Binding

public struct CUBoundWindow: Codable, Sendable { public var id: Int; public var title: String; public var frame: [Double] }

public struct TargetBindParams: Codable, Sendable {
    public var sessionId: String
    public var app: String
    public var window: CUWindowSelector?
    public var mirror: Bool
}
public struct TargetBindResult: Codable, Sendable {
    public struct App: Codable, Sendable { public var name: String; public var bundleId: String; public var pid: Int }
    public var targetId: String
    public var app: App
    public var window: CUBoundWindow
}

public struct TargetUseWindowParams: Codable, Sendable { public var targetId: String; public var window: CUWindowSelector }
public struct TargetUseWindowResult: Codable, Sendable { public var window: CUBoundWindow }

public struct TargetWindowsParams: Codable, Sendable { public var targetId: String }
public struct TargetWindowsResult: Codable, Sendable {
    public struct Window: Codable, Sendable { public var id: Int; public var title: String; public var focused: Bool }
    public var windows: [Window]
}

public struct TargetReleaseParams: Codable, Sendable { public var targetId: String }
public typealias TargetReleaseResult = CUEmpty

// MARK: - Observation

public struct TargetSnapshotParams: Codable, Sendable {
    public var targetId: String
    public var since: String?
    public var full: Bool?
    public var within: Int?
    public var settle: CUSettle?
    /// Optional, beyond the pinned §2.1 shape (the real engine's extension): lets `cancel {callId}` reach a wait.
    public var callId: String?
}
public struct TargetSnapshotResult: Codable, Sendable {
    public var snapshotId: String
    public var text: String
    public var isDiff: Bool
    public var changedRatio: Double
    public var settled: Bool
    public var waitedMs: Int
}

public struct TargetFindParams: Codable, Sendable { public var targetId: String; public var query: CUFindQuery }
public struct TargetFindResult: Codable, Sendable {
    public struct Element: Codable, Sendable { public var ref: Int; public var role: String; public var name: String?; public var value: String? }
    public var elements: [Element]
}

public struct TargetScreenshotParams: Codable, Sendable {
    public var targetId: String
    public var region: [Double]?
    public var budget: CUBudget
    public var settle: CUSettle?
    public var callId: String?
}
public struct TargetScreenshotResult: Codable, Sendable {
    public var imageBase64: String
    public var mime: String
    public var width: Int
    public var height: Int
    public var shotId: String
    public var settled: Bool
    public var waitedMs: Int
}

// MARK: - Actions

public struct CUPointOrRef: Codable, Sendable, Equatable { public var ref: Int?; public var point: [Double]? }

/// The `kind`-discriminated action union of `target.act`.
public enum CUAction: Codable, Sendable, Equatable {
    public struct Click: Codable, Sendable, Equatable {
        public var ref: Int?; public var point: [Double]?; public var shotId: String?
        public var button: String?; public var count: Int?; public var modifiers: [String]?
    }
    public struct SetValue: Codable, Sendable, Equatable { public var ref: Int; public var value: String }
    public struct TypeText: Codable, Sendable, Equatable { public var text: String; public var into: Int? }
    public struct Paste: Codable, Sendable, Equatable { public var text: String; public var into: Int?; public var format: String? }
    public struct Key: Codable, Sendable, Equatable { public var combo: String; public var into: Int?; public var `repeat`: Int? }
    public struct Scroll: Codable, Sendable, Equatable {
        public var ref: Int?; public var point: [Double]?; public var shotId: String?
        public var direction: String; public var pages: Double?
    }
    public struct Drag: Codable, Sendable, Equatable { public var from: CUPointOrRef; public var to: CUPointOrRef; public var shotId: String? }
    public struct Select: Codable, Sendable, Equatable {
        public var ref: Int; public var text: String; public var before: String?; public var after: String?; public var caret: String?
    }
    public struct NamedAction: Codable, Sendable, Equatable { public var ref: Int; public var name: String }
    public struct Menu: Codable, Sendable, Equatable { public var path: [String] }

    case click(Click)
    case setValue(SetValue)
    case type(TypeText)
    case paste(Paste)
    case key(Key)
    case scroll(Scroll)
    case drag(Drag)
    case select(Select)
    case action(NamedAction)
    case menu(Menu)

    private enum KindKey: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let kind = try decoder.container(keyedBy: KindKey.self).decode(String.self, forKey: .kind)
        switch kind {
        case "click": self = .click(try Click(from: decoder))
        case "setValue": self = .setValue(try SetValue(from: decoder))
        case "type": self = .type(try TypeText(from: decoder))
        case "paste": self = .paste(try Paste(from: decoder))
        case "key": self = .key(try Key(from: decoder))
        case "scroll": self = .scroll(try Scroll(from: decoder))
        case "drag": self = .drag(try Drag(from: decoder))
        case "select": self = .select(try Select(from: decoder))
        case "action": self = .action(try NamedAction(from: decoder))
        case "menu": self = .menu(try Menu(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: try decoder.container(keyedBy: KindKey.self),
                                                   debugDescription: "unknown action kind \"\(kind)\"")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: KindKey.self)
        switch self {
        case .click(let a): try c.encode("click", forKey: .kind); try a.encode(to: encoder)
        case .setValue(let a): try c.encode("setValue", forKey: .kind); try a.encode(to: encoder)
        case .type(let a): try c.encode("type", forKey: .kind); try a.encode(to: encoder)
        case .paste(let a): try c.encode("paste", forKey: .kind); try a.encode(to: encoder)
        case .key(let a): try c.encode("key", forKey: .kind); try a.encode(to: encoder)
        case .scroll(let a): try c.encode("scroll", forKey: .kind); try a.encode(to: encoder)
        case .drag(let a): try c.encode("drag", forKey: .kind); try a.encode(to: encoder)
        case .select(let a): try c.encode("select", forKey: .kind); try a.encode(to: encoder)
        case .action(let a): try c.encode("action", forKey: .kind); try a.encode(to: encoder)
        case .menu(let a): try c.encode("menu", forKey: .kind); try a.encode(to: encoder)
        }
    }
}

public struct TargetActParams: Codable, Sendable {
    public var targetId: String
    public var sessionId: String
    public var callId: String
    public var action: CUAction
    public var access: String
    public var allowForeground: Bool
    public var privatePath: Bool
}
public struct TargetActResult: Codable, Sendable { public var rung: Int; public var detail: String? }

// MARK: - Waits

public struct TargetWaitIdleParams: Codable, Sendable { public var targetId: String; public var quietMs: Int; public var timeoutMs: Int; public var callId: String? }
public struct TargetWaitIdleResult: Codable, Sendable { public var settled: Bool; public var waitedMs: Int }

public struct TargetWaitForParams: Codable, Sendable {
    public struct Condition: Codable, Sendable { public var text: String?; public var ref: Int?; public var gone: CUGone?; public var title: String? }
    public var targetId: String
    public var cond: Condition
    public var timeoutMs: Int
    public var callId: String?
}
public struct TargetWaitForResult: Codable, Sendable { public var met: Bool; public var waitedMs: Int }

// MARK: - Whole screen

public struct ScreenScreenshotParams: Codable, Sendable {
    public var display: CUDisplaySelector?
    public var excludeBundleIds: [String]
    public var budget: CUBudget
}
public struct ScreenScreenshotResult: Codable, Sendable {
    public var imageBase64: String
    public var mime: String
    public var width: Int
    public var height: Int
    public var shotId: String
}

public struct ScreenAppAtParams: Codable, Sendable { public var shotId: String; public var point: [Double] }
public struct ScreenAppAtResult: Codable, Sendable { public var app: String; public var bundleId: String; public var windowId: Int }

// MARK: - Lifecycle

public struct CancelParams: Codable, Sendable { public var callId: String }
public typealias CancelResult = CUEmpty

public struct TurnEndedParams: Codable, Sendable { public var sessionId: String }
public typealias TurnEndedResult = CUEmpty

public struct SessionEndedParams: Codable, Sendable { public var sessionId: String }
public typealias SessionEndedResult = CUEmpty

// MARK: - The engine

public final class CUCore {
    public weak var events: (any CUCoreEvents)?

    public init(events: (any CUCoreEvents)?) {
        self.events = events
    }

    /// Reads the grants without prompting, like the real engine.
    public func status(_ params: StatusParams = StatusParams()) async throws -> StatusResult {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0-dev"
        return StatusResult(helperVersion: version,
                            permissions: CUPermissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess()))
    }

    /// A stub never raises a system prompt or opens System Settings.
    public func permissionsRequest(_ params: PermissionsRequestParams) async throws -> PermissionsRequestResult { throw notYet("permissions.request") }

    private func notYet(_ method: String) -> CUError {
        CUError(code: "unsupported", message: "\(method) is not available in this build (the automation engine is a stub)")
    }

    public func appsList(_ params: AppsListParams) async throws -> AppsListResult { throw notYet("apps.list") }
    public func screenWindows(_ params: ScreenWindowsParams) async throws -> ScreenWindowsResult { throw notYet("screen.windows") }
    public func targetBind(_ params: TargetBindParams) async throws -> TargetBindResult { throw notYet("target.bind") }
    public func targetUseWindow(_ params: TargetUseWindowParams) async throws -> TargetUseWindowResult { throw notYet("target.useWindow") }
    public func targetWindows(_ params: TargetWindowsParams) async throws -> TargetWindowsResult { throw notYet("target.windows") }
    public func targetRelease(_ params: TargetReleaseParams) async throws -> TargetReleaseResult { throw notYet("target.release") }
    public func targetSnapshot(_ params: TargetSnapshotParams) async throws -> TargetSnapshotResult { throw notYet("target.snapshot") }
    public func targetFind(_ params: TargetFindParams) async throws -> TargetFindResult { throw notYet("target.find") }
    public func targetScreenshot(_ params: TargetScreenshotParams) async throws -> TargetScreenshotResult { throw notYet("target.screenshot") }
    public func targetAct(_ params: TargetActParams) async throws -> TargetActResult { throw notYet("target.act") }
    public func targetWaitIdle(_ params: TargetWaitIdleParams) async throws -> TargetWaitIdleResult { throw notYet("target.waitIdle") }
    public func targetWaitFor(_ params: TargetWaitForParams) async throws -> TargetWaitForResult { throw notYet("target.waitFor") }
    public func screenScreenshot(_ params: ScreenScreenshotParams) async throws -> ScreenScreenshotResult { throw notYet("screen.screenshot") }
    public func screenAppAt(_ params: ScreenAppAtParams) async throws -> ScreenAppAtResult { throw notYet("screen.appAt") }
    public func cancel(_ params: CancelParams) async throws -> CancelResult { CUEmpty() }
    public func turnEnded(_ params: TurnEndedParams) async throws -> TurnEndedResult { CUEmpty() }
    public func sessionEnded(_ params: SessionEndedParams) async throws -> SessionEndedResult { CUEmpty() }
}
