import Foundation

/// The wire envelope wrapping JSON-RPC bytes between the Mac gateway and the iOS companion.
/// The daemon never sees this — the gateway (Remote Gateway sub-project, Task 4) unwraps it
/// before/after talking JSON-RPC to the daemon over the existing local transport.
public struct WireEnvelope: Codable, Equatable, Sendable {
    public let v: Int
    public let pairingEpoch: Int
    public let hostID: String
    public let sessionID: String?
    public let streamID: String?
    public let seq: Int?
    public let kind: WireKind
    public let timestamp: Int
    /// Raw JSON-RPC bytes. Foundation's default `Data` `Codable` conformance encodes this as a
    /// base64 string — relied on rather than reimplemented.
    public let payload: Data

    public init(
        v: Int,
        pairingEpoch: Int,
        hostID: String,
        sessionID: String?,
        streamID: String?,
        seq: Int?,
        kind: WireKind,
        timestamp: Int,
        payload: Data
    ) {
        self.v = v
        self.pairingEpoch = pairingEpoch
        self.hostID = hostID
        self.sessionID = sessionID
        self.streamID = streamID
        self.seq = seq
        self.kind = kind
        self.timestamp = timestamp
        self.payload = payload
    }
}

public enum WireKind: String, Codable, Sendable {
    case rpcRequest, rpcResponse, event, hello, helloAck, error
    /// Transport keepalive (spec 2026-07-24): phone-initiated liveness solicitation. The gateway
    /// echoes `.pong`; an OLD gateway answers with its invalid-envelope error frame instead —
    /// EITHER inbound frame proves the path (liveness = any inbound frame, so no capability
    /// negotiation is needed). The daemon never sees these.
    case ping, pong
}

public enum WireError: Error, Equatable {
    case oversize
    case invalidUTF8
    case tooDeep
    case duplicateKey
    case unknownVersion
    case unknownKind
    case staleEpoch
    case malformed
}

/// Length-prefix framing is applied by the transport layer (Task 5) — `encode`/`decode` here
/// operate on ONE frame's bytes (the envelope's JSON); `LengthPrefix` below is the separate
/// u32-BE byte-stream framer.
public enum WireFrame {
    /// The only wire-protocol version this build understands. Anything else is rejected as
    /// `.unknownVersion` — checked structurally, before the full `WireEnvelope` decode.
    private static let supportedVersion = 1

    public static func encode(_ e: WireEnvelope) throws -> Data {
        try JSONEncoder().encode(e)
    }

    public static func decode(
        _ frame: Data,
        maxBytes: Int = 1 << 20,
        maxDepth: Int = 32,
        expectedEpoch: Int
    ) throws -> WireEnvelope {
        let envelope = try decodeStructural(frame, maxBytes: maxBytes, maxDepth: maxDepth)

        // Structural decode succeeded — NOW distinguish "wrong epoch" from "malformed" per the
        // brief's contract (callers need to tell these apart).
        guard envelope.pairingEpoch == expectedEpoch else {
            throw WireError.staleEpoch
        }

        return envelope
    }

    /// Every validation `decode` performs EXCEPT the `expectedEpoch` guard — the strict `decode`
    /// above layers that guard on top. Split out (rather than inlined) so the epoch-lenient
    /// `decodeLenient` below can reuse the identical shape/version/kind/structural checks without
    /// duplicating them, and WITHOUT any caller being able to weaken strict `decode`'s epoch check.
    private static func decodeStructural(
        _ frame: Data,
        maxBytes: Int,
        maxDepth: Int
    ) throws -> WireEnvelope {
        guard frame.count <= maxBytes else { throw WireError.oversize }
        guard String(data: frame, encoding: .utf8) != nil else { throw WireError.invalidUTF8 }

        // Foundation's JSONDecoder/JSONSerialization neither bound nesting depth nor reject
        // duplicate object keys by default — catch both with a byte scan before decoding. This is
        // a SECURITY check, not a classification aid: it must run on every frame, including the
        // fast path below. A `{"v":1,"v":1,…}` frame decodes perfectly well as a `WireEnvelope` —
        // Foundation silently resolves a duplicate key to the FIRST occurrence (verified for both
        // `JSONDecoder` and `JSONSerialization`) rather than rejecting the document — so this scan
        // is the ONLY thing that rejects it, whichever parser runs afterwards.
        try validateJSONShape(frame, maxDepth: maxDepth)

        // FAST PATH — a well-formed, current-version frame is parsed ONCE. This function used to
        // run `JSONSerialization.jsonObject` over the whole frame purely to read `v` and `kind` for
        // precise error classification, and then parse the SAME bytes again with `JSONDecoder`. On
        // the live remote stream that ran per event, i.e. per assistant_delta. `WireEnvelope`'s own
        // decode already rejects an unknown `kind` (`WireKind` is a `Codable` enum), so the only
        // thing left to check on success is the version. Every rejection is classified exactly as
        // before by falling through to the slow path — which is the original code, unchanged.
        if let envelope = try? JSONDecoder().decode(WireEnvelope.self, from: frame),
           envelope.v == supportedVersion {
            return envelope
        }

        // SLOW PATH — the frame is bad, or is a version we don't speak. Re-read it with
        // JSONSerialization to say precisely WHICH, in the same precedence order as before:
        // malformed < unknownVersion < unknownKind. This costs one MORE parse than the old shape
        // did (the failed fast-path attempt, then these two), which is the right trade: it is a
        // rejection path — reached once, for a frame that is about to be refused — whereas the fast
        // path above is what runs per event, forever.
        guard let obj = try? JSONSerialization.jsonObject(with: frame) as? [String: Any] else {
            throw WireError.malformed
        }
        guard let v = obj["v"] as? Int, v == supportedVersion else {
            throw WireError.unknownVersion
        }
        guard let kindRaw = obj["kind"] as? String, WireKind(rawValue: kindRaw) != nil else {
            throw WireError.unknownKind
        }

        do {
            return try JSONDecoder().decode(WireEnvelope.self, from: frame)
        } catch {
            throw WireError.malformed
        }
    }

    /// Decodes a frame with EVERY structural check strict `decode` applies (size, UTF-8, nesting
    /// depth, duplicate keys, version, kind) but WITHOUT validating `pairingEpoch` against an
    /// expected value — so a frame stamped with a DIFFERENT epoch still decodes instead of throwing
    /// `.staleEpoch`.
    ///
    /// **Deliberately narrow.** This exists for exactly two epoch-blind call sites: (1) the pairing
    /// router peeking a first frame's `kind` to tell a session dialer (a `.hello` `WireEnvelope`)
    /// from a pairing dialer (raw-JSON `PairRequest`), and (2) `NormaSessionClient` recognizing an
    /// `.error`-kind HANDSHAKE-REJECTION frame — whose whole point (`stale_epoch`) is that the
    /// client's own epoch is the wrong one to validate against. Every other path — live/replay/rpc
    /// frames — MUST keep using strict `decode(_:expectedEpoch:)`; do not reach for this to sidestep
    /// an epoch mismatch anywhere else.
    public static func decodeLenient(
        _ frame: Data,
        maxBytes: Int = 1 << 20,
        maxDepth: Int = 32
    ) throws -> WireEnvelope {
        try decodeStructural(frame, maxBytes: maxBytes, maxDepth: maxDepth)
    }

    /// Validates that a STANDALONE JSON document `bytes` (e.g. the inner JSON-RPC payload the
    /// gateway is about to relay to the daemon) nests no deeper than `maxDepth`. `decode` above
    /// already bounds the OUTER envelope frame's depth, but the base64 `payload` rides there as a
    /// single JSON string — so the inner document's own nesting is unchecked until this call
    /// (SP2a gate G4b: a phone must not tunnel a nesting-bomb payload through the gateway to the
    /// daemon). Depth-only (no duplicate-key bookkeeping): the daemon re-validates shape itself;
    /// this is the gateway's cheap pre-forward tripwire. Throws `WireError.tooDeep`.
    public static func validateJSONDepth(_ bytes: Data, maxDepth: Int = 32) throws {
        // `withUnsafeBytes` purely for speed: iterating `Data` as a `Sequence` goes through
        // Foundation's generic element accessor per byte, which dominates this scan on a small
        // frame. Same algorithm, same bytes, same throws — only the buffer access changes.
        try bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var depth = 0
            var inString = false
            var escapeNext = false
            for byte in raw {
                if inString {
                    if escapeNext {
                        escapeNext = false
                    } else if byte == UInt8(ascii: "\\") {
                        escapeNext = true
                    } else if byte == UInt8(ascii: "\"") {
                        inString = false
                    }
                    continue
                }
                switch byte {
                case UInt8(ascii: "\""):
                    inString = true
                case UInt8(ascii: "{"), UInt8(ascii: "["):
                    depth += 1
                    if depth > maxDepth { throw WireError.tooDeep }
                case UInt8(ascii: "}"), UInt8(ascii: "]"):
                    depth -= 1
                default:
                    break
                }
            }
        }
    }

    /// One focused helper: a single left-to-right byte scan that (a) counts bracket depth
    /// (`{`/`[` both count, `}`/`]` both uncount) for `maxDepth`, and (b) tracks, per currently
    /// open OBJECT, the set of keys seen so far — a string immediately followed by `:` is a key;
    /// arrays don't have keys, so `[`/`]` only affect depth, never the key stack.
    private static func validateJSONShape(_ bytes: Data, maxDepth: Int) throws {
        // `withUnsafeBytes` purely for speed — see `validateJSONDepth`. The `stringBuffer`
        // accumulation is kept byte-for-byte (rather than slicing the underlying buffer, which
        // would be faster still) because it defines what a "key" IS for the duplicate check: it
        // drops the backslash of an escape and keeps the escaped byte raw. Slicing would compare
        // keys with their escape sequences intact — a different equivalence relation on a security
        // check, for a few hundred nanoseconds. Not worth changing here.
        try bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var depth = 0
            var inString = false
            var escapeNext = false
            var stringBuffer: [UInt8] = []
            var lastCompletedString: String?
            var keyStack: [Set<String>] = []

            for byte in raw {
                if inString {
                    if escapeNext {
                        escapeNext = false
                        stringBuffer.append(byte)
                    } else if byte == UInt8(ascii: "\\") {
                        escapeNext = true
                    } else if byte == UInt8(ascii: "\"") {
                        inString = false
                        lastCompletedString = String(decoding: stringBuffer, as: UTF8.self)
                        stringBuffer.removeAll(keepingCapacity: true)
                    } else {
                        stringBuffer.append(byte)
                    }
                    continue
                }

                switch byte {
                case UInt8(ascii: "\""):
                    inString = true
                    stringBuffer.removeAll(keepingCapacity: true)
                case UInt8(ascii: "{"):
                    depth += 1
                    if depth > maxDepth { throw WireError.tooDeep }
                    keyStack.append(Set<String>())
                    lastCompletedString = nil
                case UInt8(ascii: "["):
                    depth += 1
                    if depth > maxDepth { throw WireError.tooDeep }
                    lastCompletedString = nil
                case UInt8(ascii: "}"):
                    depth -= 1
                    if !keyStack.isEmpty { keyStack.removeLast() }
                    lastCompletedString = nil
                case UInt8(ascii: "]"):
                    depth -= 1
                    lastCompletedString = nil
                case UInt8(ascii: ":"):
                    if let key = lastCompletedString, !keyStack.isEmpty {
                        if keyStack[keyStack.count - 1].contains(key) {
                            throw WireError.duplicateKey
                        }
                        keyStack[keyStack.count - 1].insert(key)
                    }
                    lastCompletedString = nil
                case UInt8(ascii: ","):
                    lastCompletedString = nil
                default:
                    break
                }
            }
        }
    }
}

/// u32 BIG-ENDIAN length prefix + bytes, over a byte stream (e.g. accumulated socket reads).
public enum LengthPrefix {
    public static func wrap(_ payload: Data) -> Data {
        let length = UInt32(payload.count)
        var result = Data([
            UInt8((length >> 24) & 0xFF),
            UInt8((length >> 16) & 0xFF),
            UInt8((length >> 8) & 0xFF),
            UInt8(length & 0xFF),
        ])
        result.append(payload)
        return result
    }

    /// Returns `nil` when a full frame isn't buffered yet (caller should read more and retry).
    /// Throws `.oversize` when the header claims more than `maxBytes`, regardless of how much of
    /// the stream is actually buffered.
    public static func unwrap(_ stream: inout Data, maxBytes: Int) throws -> Data? {
        guard stream.count >= 4 else { return nil }

        let header = Array(stream.prefix(4))
        let length =
            (UInt32(header[0]) << 24) | (UInt32(header[1]) << 16) |
            (UInt32(header[2]) << 8) | UInt32(header[3])
        guard Int(length) <= maxBytes else { throw WireError.oversize }

        let total = 4 + Int(length)
        guard stream.count >= total else { return nil }

        let start = stream.startIndex
        let payloadStart = stream.index(start, offsetBy: 4)
        let payloadEnd = stream.index(start, offsetBy: total)
        let frame = stream.subdata(in: payloadStart..<payloadEnd)
        stream.removeSubrange(start..<payloadEnd)
        return frame
    }
}
