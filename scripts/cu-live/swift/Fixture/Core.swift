import AppKit
import Foundation

// The fixture's PURE logic: everything here is testable by `--self-test` without a window, a run loop or an
// NSApplication. (AppKit is imported only for value types — NSEvent.ModifierFlags, NSEvent.EventType — never
// instantiated.) The window code in App.swift/Windows.swift is a thin shell over these types.

// MARK: - JSON values for the log

/// A JSON value with ORDERED object keys. Foundation's JSONSerialization sorts or scrambles keys; the log's
/// lines are easier to read (and to diff) when `t`, `role`, `ev` always lead.
enum JV {
    case null
    case bool(Bool)
    case int(Int)
    case num(Double)
    case str(String)
    case arr([JV])
    case obj([(String, JV)])
}

enum JSONText {
    static func encode(_ value: JV) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    private static func write(_ value: JV, into out: inout String) {
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .num(let d): out += number(d)
        case .str(let s): out += quote(s)
        case .arr(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                write(item, into: &out)
            }
            out += "]"
        case .obj(let fields):
            out += "{"
            for (index, field) in fields.enumerated() {
                if index > 0 { out += "," }
                out += quote(field.0)
                out += ":"
                write(field.1, into: &out)
            }
            out += "}"
        }
    }

    /// JSON has no NaN/Infinity: they become null. Whole numbers print without a fraction so `x: 12` and not
    /// `x: 12.0` (the runner compares numbers, but humans read these lines too).
    static func number(_ d: Double) -> String {
        guard d.isFinite else { return "null" }
        if d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
        return "\(d)"
    }

    /// Escapes what JSON requires (quote, backslash, controls) plus U+2028/2029, which are legal JSON but break
    /// line-oriented readers and old JS parsers. Non-ASCII passes through as UTF-8.
    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}

extension JV {
    /// Converts what JSONSerialization / a notification's userInfo hands over. Objects get SORTED keys so a
    /// `state` line is deterministic.
    static func from(any value: Any?) -> JV {
        guard let value, !(value is NSNull) else { return .null }
        if let s = value as? String { return .str(s) }
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            let d = n.doubleValue
            if d == d.rounded(), abs(d) < 1e15 { return .int(Int(d)) }
            return .num(d)
        }
        if let a = value as? [Any] { return .arr(a.map { JV.from(any: $0) }) }
        if let o = value as? [String: Any] { return .obj(o.keys.sorted().map { ($0, JV.from(any: o[$0])) }) }
        return .str("\(value)")
    }
}

/// One log line: `{"t": <epoch ms>, "role": ..., "ev": ..., ...fields}`, no trailing newline.
enum LogLine {
    static func make(tMs: Int, role: String, ev: String, fields: [(String, JV)]) -> String {
        JSONText.encode(.obj([("t", .int(tMs)), ("role", .str(role)), ("ev", .str(ev))] + fields))
    }
}

/// Coordinates are logged "rounded to 0.5".
enum Rounding {
    static func half(_ v: Double) -> Double { (v * 2).rounded() / 2 }
}

// MARK: - The log file

/// Append-only JSONL. `O_APPEND` + ONE `write(2)` per line: the two fixture processes (main and user) share one
/// file, and an append-mode write of a small buffer lands atomically, so lines never interleave. No buffering,
/// so nothing is lost if the process is killed.
final class FixtureLog {
    let role: String
    private let fd: Int32

    init?(path: String, role: String) {
        let fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { return nil }
        self.fd = fd
        self.role = role
    }

    deinit { close(fd) }

    static func nowMs() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }

    func event(_ ev: String, _ fields: [(String, JV)] = []) {
        let line = LogLine.make(tMs: Self.nowMs(), role: role, ev: ev, fields: fields) + "\n"
        var bytes = Array(line.utf8)
        var offset = 0
        // A partial write is possible in principle (disk full, signal); finish the line rather than tear it.
        while offset < bytes.count {
            let n = bytes.withUnsafeMutableBufferPointer { write(fd, $0.baseAddress! + offset, $0.count - offset) }
            if n < 0 {
                if errno == EINTR { continue }
                return
            }
            offset += n
        }
    }
}

// MARK: - Commands

/// A decoded command, ready to run.
struct FixtureCommand {
    let name: String
    let args: [String: Any]
    /// Echoed verbatim in `cmd.ack` — a String stays a string, a number stays a number.
    let seq: JV
}

/// A command argument that is missing or malformed; `message` goes into `cmd.error`.
struct ArgError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

enum CommandDecision {
    /// Not for this process (another run id or another role): no ack, no error, no trace.
    case ignore
    case run(FixtureCommand)
    /// For this process but unusable: answered with `cmd.error`.
    case reject(cmd: String, seq: JV, message: String)
}

enum CommandDecoder {
    static let notificationName = "com.winter.cu-fixture.command"

    /// The commands each role implements. `dump`/`reset`/`ping`/`quit` exist on both so a runner can always
    /// probe and clean up either process.
    static func supported(role: String) -> Set<String> {
        switch role {
        case "main": return ["ping", "steal", "reset", "dump", "fullscreen", "exitFullscreen", "openSample", "quit", "animate"]
        case "user": return ["ping", "activate", "reset", "dump", "quit"]
        default: return []
        }
    }

    /// `object` is the run id the notification was posted with; `userInfo` carries role/cmd/args/seq.
    static func decode(object: Any?, userInfo: [AnyHashable: Any]?, role: String, run: String) -> CommandDecision {
        // The run id is compared here rather than by the notification center's object matching: a nil/absent
        // object on our side would otherwise mean "any run".
        let postedRun = (object as? String) ?? ""
        guard postedRun == run else { return .ignore }
        guard let info = userInfo, let postedRole = info["role"] as? String, postedRole == role else { return .ignore }

        let seq = JV.from(any: info["seq"])
        guard let cmd = info["cmd"] as? String, !cmd.isEmpty else {
            return .reject(cmd: "", seq: seq, message: "the command has no cmd")
        }
        guard supported(role: role).contains(cmd) else {
            return .reject(cmd: cmd, seq: seq, message: "unknown command \(cmd) for role \(role)")
        }
        let args: [String: Any]
        switch info["args"] {
        case nil, is NSNull:
            args = [:]
        case let text as String:
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                args = [:]
            } else if let data = text.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data, options: []) {
                guard let object = parsed as? [String: Any] else {
                    return .reject(cmd: cmd, seq: seq, message: "args must be a JSON object")
                }
                args = object
            } else {
                return .reject(cmd: cmd, seq: seq, message: "args is not valid JSON")
            }
        case let dict as [String: Any]:
            args = dict
        default:
            return .reject(cmd: cmd, seq: seq, message: "args must be a JSON object text")
        }
        return .run(FixtureCommand(name: cmd, args: args, seq: seq))
    }

    /// `steal {mode}`.
    static func stealMode(_ args: [String: Any]) -> Result<StealMode, ArgError> {
        guard let raw = args["mode"] as? String, let mode = StealMode(rawValue: raw) else {
            return .failure(ArgError("steal needs mode: off | focus | mousedown | delayed"))
        }
        return .success(mode)
    }

    /// `animate {on}`. A real JSON boolean only: `1` and `"true"` are mistakes worth reporting.
    static func animateOn(_ args: [String: Any]) -> Result<Bool, ArgError> {
        guard let n = args["on"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else {
            return .failure(ArgError("animate needs on: true | false"))
        }
        return .success(n.boolValue)
    }
}

// MARK: - Steal mode (the fixture misbehaving on purpose)

enum StealMode: String {
    case off, focus, mousedown, delayed
}

enum StealTrigger {
    /// A native field/text view or a web field gained focus.
    case fieldFocus
    /// A mouseDown in the canvas, or a click in the web page.
    case mouseDown
    /// A document was opened.
    case documentOpen
}

enum StealAction: Equatable {
    case none
    case now(String)
    case after(Double, String)
}

enum StealPolicy {
    static let delay = 1.0

    static func action(mode: StealMode, trigger: StealTrigger) -> StealAction {
        // Opening a document steals in every mode but off, immediately — the delay belongs to the field/mouse
        // triggers (it models an app that grabs focus a moment after the click that caused it).
        if trigger == .documentOpen { return mode == .off ? .none : .now("doc-open") }
        switch (mode, trigger) {
        case (.focus, .fieldFocus): return .now("steal-focus")
        case (.mousedown, .mouseDown): return .now("steal-mousedown")
        case (.delayed, .fieldFocus), (.delayed, .mouseDown): return .after(delay, "steal-delayed")
        default: return .none
        }
    }
}

// MARK: - Menu rules

enum MenuRules {
    static let stamp = "[stamp]"

    /// "Uppercase Selection" is enabled ONLY while the notes view has a non-empty selection.
    static func uppercaseEnabled(selectionLength: Int) -> Bool { selectionLength > 0 }

    /// The replacement for a selection and the selection to restore afterwards. Uppercasing can change the
    /// length (ß → SS), so the new selection is measured, not assumed. Nil for an empty or out-of-range selection.
    static func uppercase(text: String, range: NSRange) -> (replacement: String, selection: NSRange)? {
        let ns = text as NSString
        guard range.length > 0, range.location >= 0, NSMaxRange(range) <= ns.length else { return nil }
        let replacement = ns.substring(with: range).uppercased()
        return (replacement, NSRange(location: range.location, length: (replacement as NSString).length))
    }
}

// MARK: - Event vocabularies

enum Mods {
    /// The `mods` array of `canvas.key`, in this fixed order. Arrow keys also carry `function` and `numericPad`.
    static let vocabulary: [(String, NSEvent.ModifierFlags)] = [
        ("shift", .shift), ("control", .control), ("option", .option), ("command", .command),
        ("capsLock", .capsLock), ("function", .function), ("numericPad", .numericPad),
    ]

    static func names(_ flags: NSEvent.ModifierFlags) -> [String] {
        vocabulary.filter { flags.contains($0.1) }.map { $0.0 }
    }
}

enum MouseButton {
    static func name(for type: NSEvent.EventType) -> String {
        switch type {
        case .leftMouseDown, .leftMouseUp, .leftMouseDragged: return "left"
        case .rightMouseDown, .rightMouseUp, .rightMouseDragged: return "right"
        default: return "other"
        }
    }
}

enum DocTitle {
    static func make(path: String) -> String { "Document: " + (path as NSString).lastPathComponent }
}

// MARK: - Window placement

/// A deterministic 2x2 grid on the main screen's visible frame (AppKit coordinates, origin bottom-left), then
/// a cascade for anything beyond four windows. Content size is chosen so two rows fit a 900 pt-high display.
enum WindowGrid {
    static let contentSize = CGSize(width: 640, height: 390)
    static let marginX: CGFloat = 12
    static let marginTop: CGFloat = 8
    static let columnStep: CGFloat = 656
    static let rowStep: CGFloat = 430
    static let cascadeStep: CGFloat = 30

    /// The window's TOP-LEFT corner (for `setFrameTopLeftPoint`).
    static func topLeft(slot: Int, visible: CGRect) -> CGPoint {
        let capped = min(max(slot, 0), 3)
        let column = CGFloat(capped % 2)
        let row = CGFloat(capped / 2)
        let extra = CGFloat(max(slot - 3, 0)) * cascadeStep
        return CGPoint(x: visible.minX + marginX + column * columnStep + extra,
                       y: visible.maxY - marginTop - row * rowStep - extra)
    }
}

// MARK: - Scroll throttle

/// `web.scroll` is "throttled <= 4/s". Leading + trailing edge: the first scroll goes out at once and the LAST
/// position of a burst always goes out too (otherwise the final scrollY would never be logged).
struct ScrollThrottle {
    let minInterval: Double
    private(set) var lastEmit: Double = -.infinity
    private(set) var pending: Double?

    enum Decision: Equatable {
        case emit(Double)
        /// Hold this value and call `flush` at (or after) this time.
        case flushAt(Double)
        /// Replaces the held value; a flush is already scheduled.
        case absorbed
    }

    init(minInterval: Double = 0.25) { self.minInterval = minInterval }

    mutating func offer(_ y: Double, now: Double) -> Decision {
        if pending == nil, now - lastEmit >= minInterval {
            lastEmit = now
            return .emit(y)
        }
        let alreadyScheduled = pending != nil
        pending = y
        return alreadyScheduled ? .absorbed : .flushAt(lastEmit + minInterval)
    }

    mutating func flush(now: Double) -> Double? {
        guard let y = pending else { return nil }
        pending = nil
        lastEmit = now
        return y
    }
}

// MARK: - Canvas animation

/// `animate {on:true}`: a square sweeps across the canvas so a window capture stream keeps seeing change.
enum Animation {
    static let framesPerSecond = 30.0
    static let squareSize = 40.0
    /// Points per second.
    static let speed = 180.0

    /// Left edge of the square `elapsed` seconds after the animation started: a triangle wave between 0 and
    /// `width - squareSize`, so it bounces rather than wrapping (a wrap would jump, and a jump is a hard edge a
    /// capture's change-detector might read as a window redraw rather than motion).
    static func squareX(elapsed: Double, width: Double) -> Double {
        let travel = max(width - squareSize, 1)
        let period = 2 * travel
        let phase = (elapsed * speed).truncatingRemainder(dividingBy: period)
        let wrapped = phase < 0 ? phase + period : phase
        return wrapped <= travel ? wrapped : period - wrapped
    }
}
