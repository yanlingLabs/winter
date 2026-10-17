import Foundation

/*
 * Mux frames (docs/cowork-native-worker.md, section 6): a 16 byte little-endian header ("WMX1", u8 version = 1, u8 class,
 * u16 flags = 0, u32 seq, u32 payload length) and a payload. The launcher RELAYS BLIND: it reads the header and nothing inside
 * the payload. What it checks is exactly what a relay needs:
 *   - magic, version, flags, class, the per-class payload ceiling and the exact total length;
 *   - the provider class (3) is RESERVED and refused at the header, in both directions;
 *   - the control class (0) terminates at the worker and never crosses L3 or L1;
 *   - `seq` starts at 1 and rises by exactly 1 per (class, direction); a gap, a repeat or a rewind ends the stream.
 * Everything else about a bootstrap or runtime payload is the endpoints' business (the daemon and the guest).
 */

public enum MuxClass: UInt8, Sendable, CaseIterable {
    case control = 0, bootstrap = 1, runtime = 2, provider = 3
    public var payloadCeiling: Int {
        switch self {
        case .control: WireLimits.muxControlPayload
        case .bootstrap: WireLimits.muxBootstrapPayload
        case .runtime: WireLimits.muxRuntimePayload
        case .provider: 0
        }
    }
}
public enum MuxDirection: String, Sendable { case up, down }

public struct MuxHeader: Equatable, Sendable {
    public let muxClass: MuxClass
    public let seq: UInt32
    public let payloadLength: Int
    public var frameLength: Int { WireLimits.headerBytes + payloadLength }
}

public enum MuxFormat {
    public static let magic: [UInt8] = Array("WMX1".utf8)

    /// Validates the 16 header bytes alone (the stream reader calls this before it buffers a payload).
    public static func parseHeader(_ bytes: ArraySlice<UInt8>) throws -> MuxHeader {
        let b = Array(bytes.prefix(WireLimits.headerBytes))
        guard b.count == WireLimits.headerBytes, Array(b[0..<4]) == magic else { throw WireFailure.malformed }
        guard b[4] == 1 else { throw WireFailure.version }
        guard let cls = MuxClass(rawValue: b[5]), EnvelopeFormat.get16(b, 6) == 0 else { throw WireFailure.malformed }
        if cls == .provider { throw WireFailure.reserved_class }
        let seq = EnvelopeFormat.get32(b, 8), length = Int(EnvelopeFormat.get32(b, 12))
        guard seq >= 1 else { throw WireFailure.bad_sequence }
        guard length <= cls.payloadCeiling else { throw WireFailure.oversize }
        return MuxHeader(muxClass: cls, seq: seq, payloadLength: length)
    }
    /// One whole frame, header and payload, with nothing after it.
    public static func parseFrame(_ bytes: [UInt8]) throws -> MuxHeader {
        guard bytes.count >= WireLimits.headerBytes else { throw WireFailure.malformed }
        let header = try parseHeader(bytes[0..<WireLimits.headerBytes])
        guard bytes.count == header.frameLength else { throw WireFailure.malformed }
        return header
    }
    /// A frame that may travel on L1 or L3: bootstrap or runtime only. Control frames terminate at the worker.
    public static func parseRelayable(_ bytes: [UInt8]) throws -> MuxHeader {
        let header = try parseFrame(bytes)
        guard header.muxClass == .bootstrap || header.muxClass == .runtime else { throw WireFailure.bad_field }
        return header
    }
    /// Build a frame (the FakeWorker and the tests; the launcher itself never invents one).
    public static func frame(_ muxClass: MuxClass, seq: UInt32, payload: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: WireLimits.headerBytes) + payload
        out.replaceSubrange(0..<4, with: magic); out[4] = 1; out[5] = muxClass.rawValue
        EnvelopeFormat.put32(seq, &out, 8); EnvelopeFormat.put32(UInt32(payload.count), &out, 12)
        return out
    }
}

/// Per (class, direction) sequence check, one instance per link end. A gap, a repeat or a rewind is `bad_sequence`.
public struct MuxSequencer: Sendable {
    private var next: [UInt8: UInt32] = [:]
    public init() {}
    /// Checks and records. A refused frame does not advance the counter.
    public mutating func accept(_ header: MuxHeader) throws {
        let expected = next[header.muxClass.rawValue] ?? 1
        guard header.seq == expected else { throw WireFailure.bad_sequence }
        next[header.muxClass.rawValue] = expected + 1
    }
}

/// L3 is a byte stream: this cuts it into whole frames. The header is validated as soon as it is complete, so a payload larger
/// than its class allows is refused before it is buffered. After any throw the stream is desynchronised and the reader is dead.
public struct MuxStreamReader: Sendable {
    private var buffer: [UInt8] = []
    private var failed = false
    public init() {}
    public var bufferedBytes: Int { buffer.count }

    public mutating func feed(_ chunk: [UInt8]) throws -> [(header: MuxHeader, bytes: [UInt8])] {
        guard !failed else { throw WireFailure.malformed }
        buffer.append(contentsOf: chunk)
        var frames: [(MuxHeader, [UInt8])] = []
        do {
            while buffer.count >= WireLimits.headerBytes {
                let header = try MuxFormat.parseHeader(buffer[0..<WireLimits.headerBytes])
                guard buffer.count >= header.frameLength else { break }
                frames.append((header, Array(buffer[0..<header.frameLength])))
                buffer.removeFirst(header.frameLength)
            }
        } catch { failed = true; throw error }
        return frames
    }
}
