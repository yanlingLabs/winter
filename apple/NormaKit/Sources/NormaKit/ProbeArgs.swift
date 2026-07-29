import Foundation

/// Argument parsing error for norma-probe.
public struct ProbeArgsError: Error, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}

/// Hand-rolled argv parser for norma-probe (no external deps by global constraint).
public struct ProbeArgs: Equatable {
    public let command: String
    public let positional: [String]
    public let token: String?
    public let socket: String?
    public let from: Int?
    public let cwd: String?
    /// devfix: `--dev` selects the dev daemon's Keychain service (`com.norma.core.dev`) for the
    /// fallback `KeychainToken.readHarnessToken` read. Absent (the default) keeps every existing
    /// invocation reading the dist service, unchanged.
    public let dev: Bool

    public static let commands = ["list", "create", "attach", "send"]

    public static func parse(_ argv: [String]) -> Result<ProbeArgs, ProbeArgsError> {
        guard let command = argv.first else { return .failure(ProbeArgsError(usage)) }
        guard commands.contains(command) else { return .failure(ProbeArgsError("unknown command: \(command)\n" + usage)) }
        var positional: [String] = []
        var token: String?, socket: String?, cwd: String?
        var from: Int?
        var dev = false
        var i = 1
        while i < argv.count {
            let a = argv[i]
            func flagValue() -> String? {
                i += 1
                return i < argv.count ? argv[i] : nil
            }
            switch a {
            case "--token": guard let v = flagValue() else { return .failure(ProbeArgsError("--token needs a value")) }; token = v
            case "--socket": guard let v = flagValue() else { return .failure(ProbeArgsError("--socket needs a value")) }; socket = v
            case "--cwd": guard let v = flagValue() else { return .failure(ProbeArgsError("--cwd needs a value")) }; cwd = v
            case "--from":
                guard let v = flagValue(), let n = Int(v) else { return .failure(ProbeArgsError("--from needs an integer")) }
                from = n
            case "--dev": dev = true
            default: positional.append(a)
            }
            i += 1
        }
        switch command {
        case "create" where positional.count != 1: return .failure(ProbeArgsError("usage: norma-probe create <scope> [--cwd <path>]"))
        case "attach" where positional.count != 1: return .failure(ProbeArgsError("usage: norma-probe attach <sessionId> [--from <seq>]"))
        case "send" where positional.count < 2: return .failure(ProbeArgsError("usage: norma-probe send <sessionId> <text…>"))
        default: break
        }
        return .success(ProbeArgs(command: command, positional: positional, token: token, socket: socket, from: from, cwd: cwd, dev: dev))
    }

    public static let usage = """
    norma-probe — NormaKit debugging harness
      norma-probe list
      norma-probe create <scope> [--cwd <path>]
      norma-probe attach <sessionId> [--from <seq>]
      norma-probe send <sessionId> <text…>
    global flags: --token <t> (default: Keychain harness-token), --socket <path> (default: $NORMA_HOME/run/core.sock),
      --dev (read the dev daemon's Keychain service, com.norma.core.dev, instead of dist's com.norma.core)
    """
}
