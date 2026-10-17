import Foundation

/// Every refusal the parsers raise. The raw values are the contract's own spellings (`protocol.ts`,
/// `COWORK_NATIVE_PROTOCOL_FAILURES`), because the golden vectors name the expected failure by that string.
public enum WireFailure: String, Error, Sendable, CaseIterable {
    case malformed, oversize, version
    case unknown_type, bad_field, bad_direction, bad_rights, reserved_class, bad_sequence
}

/// The numbers of the contract that the launcher shares with the daemon and the worker (docs/cowork-native-worker.md,
/// section 3 and `COWORK_NATIVE_LIMITS`). Copied, not imported: the vectors are the drift test.
public enum WireLimits {
    /// Every L1 line except the two mux carriers.
    public static let controlLineBytes = 16 * 1024
    /// A mux carrier: base64 of the largest frame (16 header bytes + 1 MiB) plus the envelope text.
    public static let muxLineBytes = 1_572_864
    /// Brace/bracket nesting bound per text kind.
    public static let launcherDepth = 4
    public static let receiptDepth = 3
    /// Both binary formats share the 16 byte header.
    public static let headerBytes = 16
    public static let muxControlPayload = 4096
    public static let muxBootstrapPayload = 262_144
    public static let muxRuntimePayload = 1_048_576
    /// A stop receipt as a single text (the durable store keeps exactly this line).
    public static let receiptBytes = 8192
    /// Identifier fields in the fixed-layout envelope are NUL padded to 64 bytes, so a token is at most 63 characters.
    public static let tokenChars = 63
    /// Guest sizing (D8): 2 vCPU and at most 1024 MiB inside the reviewed device gate.
    public static let vcpus = 2
    public static let minMemoryMiB = 256
    public static let maxMemoryMiB = 1024
    /// The documented graceful budget, and the most an explicit stop may ask for.
    public static let drainBudgetMs = 30_000
    public static let drainBudgetCeilingMs = 120_000
    public static let volumeRights = 2
    public static let maxSafeInteger: Int64 = 9_007_199_254_740_991
}
