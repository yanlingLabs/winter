import Foundation

/// A small JSON value, so `CUError.data` can carry arbitrary typed detail (`ref`, `reason`, `seen`, …)
/// straight into the JSON-RPC error's `data` object.
public enum CUJSON: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CUJSON])
    case object([String: CUJSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([CUJSON].self) { self = .array(a); return }
        if let o = try? c.decode([String: CUJSON].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            // Integral values encode as integers so `ref: 12` never reads `12.0` on the wire.
            if n.rounded() == n, abs(n) < 9.0e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public static func int(_ v: Int) -> CUJSON { .number(Double(v)) }
}

/// Every failure `CUCore` throws. `code` is one of the spine's `error.data.code` strings (§2.3); the shell
/// copies it, plus `data`, into the JSON-RPC error's `data` object.
public struct CUError: Error, Codable, Sendable, Equatable, CustomStringConvertible {
    public var code: String
    public var message: String
    public var data: [String: CUJSON]?

    public init(code: String, message: String, data: [String: CUJSON]? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    public var description: String { "\(code): \(message)" }

    // MARK: - The §2.3 codes

    public static func permissionMissing(_ permission: CUPermissionKind) -> CUError {
        let pane = permission == .accessibility ? "Accessibility" : "Screen Recording"
        return CUError(code: "permission_missing",
                       message: "Winter Computer Use needs \(pane) — ask the user to grant it in Settings → Computer Use",
                       data: ["permission": .string(permission.rawValue)])
    }

    public static func targetLost(_ detail: String) -> CUError {
        CUError(code: "target_lost", message: detail)
    }

    /// The app runs but has no window at all, even after its one background reopen. Winter never asks for a new
    /// window (no ⌘N, no New Window): the way to get one is to open a document, which opens in the background.
    public static func noWindow(_ app: String) -> CUError {
        CUError(code: "no_window", message: "\(app) has no open window — open a document in it with apps.open(path or URL, { app: \"\(app)\" }); it opens in the background and binds that window")
    }

    /// The window exists but is on another Space or in full screen, and could not be reached there.
    public static func windowElsewhere(_ app: String) -> CUError {
        CUError(code: "window_elsewhere",
                message: "\(app)'s window is on another Space or in full screen and could not be reached there — ask the user to bring it to this desktop")
    }

    /// Pointer input (`what`: the click, the drag) that has no AX equivalent, to a window on another desktop,
    /// with no way to address events to a window that is off screen (the private event path is off).
    public static func windowElsewhere(_ app: String, sending what: String, subject: String? = nil) -> CUError {
        CUError(code: "window_elsewhere",
                message: "\(subject ?? "\(app)'s window is on another desktop"), and \(what) can't be sent there with the private event path off — click elements by ref, scroll, type and use keys, or ask the user to bring the window here")
    }


    /// A window screenshot failed with the window on another Space or in full screen, and it could not be
    /// moved here.
    public static func screenshotElsewhere(_ app: String) -> CUError {
        CUError(code: "window_elsewhere",
                message: "can't take a screenshot of \(app)'s window while it is on another desktop (another Space or full screen): macOS gave no image of it there — state() and find() still work there; ask the user to bring it to this desktop")
    }

    public static func staleRef(_ ref: Int) -> CUError {
        CUError(code: "stale_ref", message: "[\(ref)] is gone — call state()", data: ["ref": .int(ref)])
    }

    public static func needsForeground(_ app: String) -> CUError {
        CUError(code: "needs_foreground",
                message: "\(app) only accepts this input in the foreground — Winter must bring it to the front and use the mouse")
    }

    public static func notAllowed(_ reason: String, _ message: String) -> CUError {
        CUError(code: "not_allowed", message: message, data: ["reason": .string(reason)])
    }

    public static func refused(_ reason: CUFloorReason, _ message: String) -> CUError {
        CUError(code: "refused", message: message, data: ["reason": .string(reason.rawValue)])
    }

    public static func waitTimeout(seen: String, waitedMs: Int) -> CUError {
        CUError(code: "wait_timeout", message: "the condition was not met after \(waitedMs) ms — saw: \(seen)",
                data: ["seen": .string(seen), "waitedMs": .int(waitedMs)])
    }

    public static let cancelled = CUError(code: "cancelled", message: "cancelled")

    public static func invalidParams(_ message: String) -> CUError {
        CUError(code: "invalid_params", message: message)
    }

    public static func unsupported(_ message: String) -> CUError {
        CUError(code: "unsupported", message: message)
    }

    public static func busy(_ message: String = "the helper is busy with this app — retry") -> CUError {
        CUError(code: "busy", message: message, data: ["retryable": .bool(true)])
    }

    /// The action was SENT but the app did not confirm it: it may have happened. Code `busy` (the app did not
    /// answer as it should), marked `uncertain` so nothing retries it — the daemon reports it as `Uncertain`.
    public static func uncertain(_ message: String, axError: Int? = nil) -> CUError {
        var data: [String: CUJSON] = ["uncertain": .bool(true), "retryable": .bool(false)]
        if let axError { data["axError"] = .int(axError) }
        return CUError(code: "busy", message: message, data: data)
    }
}

/// The `reason` values of a `refused` floor (§2.4).
public enum CUFloorReason: String, Codable, Sendable {
    case secureField = "secure_field"
    case authDialog = "auth_dialog"
    case privacyPane = "privacy_pane"
    case winterItself = "winter_itself"
    case savePath = "save_path"
    /// Typing with the focus unreadable while the window holds a password or payment field.
    case focusUnknown = "focus_unknown"
    /// The named field could not be given the keyboard focus, so nothing was typed (keys would have gone to
    /// whatever had it).
    case focusNotPlaced = "focus_not_placed"
}
