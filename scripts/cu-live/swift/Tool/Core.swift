import Foundation

// cu-live-tool's pure parts: argument parsing and JSON line encoding. No AppKit, no window server.

// MARK: - JSON output

enum JSONOut {
    /// Escapes what JSON requires plus U+2028/2029 (legal JSON, but they break line-oriented readers).
    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
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
        return out + "\""
    }

    static func optional(_ s: String?) -> String { s.map(quote) ?? "null" }
    static func optional(_ n: Int?) -> String { n.map(String.init) ?? "null" }
}

/// One reading of "what is in front of the user".
struct Sample: Equatable {
    var t: Int
    var front: String?
    var frontPid: Int?
    var space: Int?
    var hidIdleMs: Int?

    /// `{"t","front","frontPid","space","hidIdleMs"}` — the key order the rig's parser and a human both expect.
    var json: String {
        "{\"t\":\(t),\"front\":\(JSONOut.optional(front)),\"frontPid\":\(JSONOut.optional(frontPid)),"
            + "\"space\":\(JSONOut.optional(space)),\"hidIdleMs\":\(JSONOut.optional(hidIdleMs))}"
    }
}

// MARK: - Arguments

enum ToolCommand: Equatable {
    case monitor(intervalMs: Int)
    case front
    case post(run: String, role: String, cmd: String, args: String?, seq: String?)
    case selfTest
    case help
}

struct UsageError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

enum ArgParser {
    static let usage = """
    usage:
      cu-live-tool monitor [--interval-ms 20]    one JSON line per interval (and per app activation) until stdin EOF / SIGTERM
      cu-live-tool front                         one JSON line, then exit
      cu-live-tool post --run <id> --role <main|user> --cmd <name> [--args <json object>] [--seq <n>]
      cu-live-tool self-test
    """

    static let minIntervalMs = 5
    static let maxIntervalMs = 60_000
    static let roles: Set<String> = ["main", "user"]

    static func parse(_ argv: [String]) -> Result<ToolCommand, UsageError> {
        guard let verb = argv.first else { return .failure(UsageError("no command given")) }
        let rest = Array(argv.dropFirst())
        switch verb {
        case "help", "--help", "-h":
            return .success(.help)
        case "self-test", "--self-test":
            return rest.isEmpty ? .success(.selfTest) : .failure(UsageError("self-test takes no arguments"))
        case "front":
            return rest.isEmpty ? .success(.front) : .failure(UsageError("front takes no arguments"))
        case "monitor":
            return parseMonitor(rest)
        case "post":
            return parsePost(rest)
        default:
            return .failure(UsageError("unknown command \(verb)"))
        }
    }

    /// `--name value` or `--name=value`. Returns the options, or the first problem.
    private static func options(_ args: [String], allowed: Set<String>) -> Result<[String: String], UsageError> {
        var found: [String: String] = [:]
        var index = 0
        while index < args.count {
            let arg = args[index]
            guard arg.hasPrefix("--") else { return .failure(UsageError("unexpected argument \(arg)")) }
            var name = String(arg.dropFirst(2))
            var value: String
            if let equals = name.firstIndex(of: "=") {
                value = String(name[name.index(after: equals)...])
                name = String(name[..<equals])
            } else {
                index += 1
                guard index < args.count else { return .failure(UsageError("--\(name) needs a value")) }
                value = args[index]
            }
            guard allowed.contains(name) else { return .failure(UsageError("unknown option --\(name)")) }
            guard found[name] == nil else { return .failure(UsageError("--\(name) given twice")) }
            found[name] = value
            index += 1
        }
        return .success(found)
    }

    private static func parseMonitor(_ args: [String]) -> Result<ToolCommand, UsageError> {
        switch options(args, allowed: ["interval-ms"]) {
        case .failure(let error): return .failure(error)
        case .success(let found):
            guard let raw = found["interval-ms"] else { return .success(.monitor(intervalMs: 20)) }
            guard let ms = Int(raw), ms >= minIntervalMs, ms <= maxIntervalMs else {
                return .failure(UsageError("--interval-ms must be a whole number from \(minIntervalMs) to \(maxIntervalMs)"))
            }
            return .success(.monitor(intervalMs: ms))
        }
    }

    private static func parsePost(_ args: [String]) -> Result<ToolCommand, UsageError> {
        switch options(args, allowed: ["run", "role", "cmd", "args", "seq"]) {
        case .failure(let error): return .failure(error)
        case .success(let found):
            guard let run = found["run"], !run.isEmpty else { return .failure(UsageError("--run is required")) }
            guard let role = found["role"], roles.contains(role) else { return .failure(UsageError("--role must be main or user")) }
            guard let cmd = found["cmd"], !cmd.isEmpty else { return .failure(UsageError("--cmd is required")) }
            if let text = found["args"] {
                // Fail here, not silently in the fixture: a mistyped args string would otherwise surface as a
                // cmd.error far from the caller.
                guard let data = text.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data, options: []),
                      parsed is [String: Any] else {
                    return .failure(UsageError("--args must be a JSON object"))
                }
            }
            return .success(.post(run: run, role: role, cmd: cmd, args: found["args"], seq: found["seq"]))
        }
    }
}
