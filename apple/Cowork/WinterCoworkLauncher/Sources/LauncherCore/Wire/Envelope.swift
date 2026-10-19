import Foundation
import CryptoKit

/*
 * L2: launcher and worker. Fixed-layout little-endian ENVELOPES, one datagram each (docs/cowork-native-worker.md, section 5).
 * 16 byte header: "WEV1", u8 version = 1, u8 kind, u16 flags = 0, u32 seq (from 1, +1 per direction), u32 payload length.
 *
 *   kind 1 SCOPE   launcher to worker   512 bytes   no descriptors
 *   kind 2 VOLUMES launcher to worker   104 bytes   EXACTLY two descriptors (data, environment)
 *   kind 3 DRAIN   launcher to worker    28 bytes   no descriptors
 *   kind 4 STATUS  worker to launcher    40 bytes   no descriptors
 *   kind 5 FAULT   worker to launcher     8 bytes   no descriptors
 *
 * Every reserved byte is zero. A datagram with any other length, magic, version, flag, rights count or non-zero reserved byte
 * is refused. Parsing re-serializes and compares, as every other format here.
 */

public struct FlushCounters: Equatable, Sendable {
    public var requested: UInt64
    public var completed: UInt64
    public init(requested: UInt64 = 0, completed: UInt64 = 0) { self.requested = requested; self.completed = completed }
}

public enum EnvelopeDirection: Sendable { case toWorker, toLauncher }

public enum Envelope: Equatable, Sendable {
    case scope(seq: UInt32, scope: Scope)
    case volumes(seq: UInt32, scopeDigest: String, volumes: [VolumeIdentity])
    case drain(seq: UInt32, stopNonce: String, budgetMs: Int, origin: DrainOrigin)
    case status(seq: UInt32, state: WorkerStatus, data: FlushCounters, environment: FlushCounters)
    case fault(seq: UInt32, code: WorkerFault)

    public var seq: UInt32 {
        switch self {
        case .scope(let s, _), .volumes(let s, _, _), .drain(let s, _, _, _), .status(let s, _, _, _), .fault(let s, _): return s
        }
    }
    public var kindNumber: UInt8 {
        switch self { case .scope: 1; case .volumes: 2; case .drain: 3; case .status: 4; case .fault: 5 }
    }
    public var direction: EnvelopeDirection {
        switch self { case .scope, .volumes, .drain: .toWorker; case .status, .fault: .toLauncher }
    }
    /// SCM_RIGHTS descriptors that must travel with this kind.
    public var wantedRights: Int { if case .volumes = self { WireLimits.volumeRights } else { 0 } }
}

public enum EnvelopeFormat {
    public static let magic: [UInt8] = Array("WEV1".utf8)
    public static let payloadBytes: [Int] = [0, 512, 104, 28, 40, 8] // by kind number

    // ---- little-endian primitives
    static func put32(_ v: UInt32, _ out: inout [UInt8], _ at: Int) { for i in 0..<4 { out[at + i] = UInt8(truncatingIfNeeded: v >> (8 * UInt32(i))) } }
    static func put64(_ v: UInt64, _ out: inout [UInt8], _ at: Int) { for i in 0..<8 { out[at + i] = UInt8(truncatingIfNeeded: v >> (8 * UInt64(i))) } }
    static func get16(_ b: [UInt8], _ at: Int) -> UInt16 { UInt16(b[at]) | UInt16(b[at + 1]) << 8 }
    static func get32(_ b: [UInt8], _ at: Int) -> UInt32 { (0..<4).reduce(UInt32(0)) { $0 | UInt32(b[at + $1]) << (8 * UInt32($1)) } }
    static func get64(_ b: [UInt8], _ at: Int) -> UInt64 { (0..<8).reduce(UInt64(0)) { $0 | UInt64(b[at + $1]) << (8 * UInt64($1)) } }
    static func hexBytes(_ text: String) -> [UInt8] {
        let chars = Array(text.utf8)
        func nibble(_ c: UInt8) -> UInt8 { c <= 0x39 ? c - 0x30 : c - 0x61 + 10 }
        return stride(from: 0, to: chars.count, by: 2).map { nibble(chars[$0]) << 4 | nibble(chars[$0 + 1]) }
    }
    static func hexOf(_ bytes: ArraySlice<UInt8>) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

    // ---- SCOPE
    static let scopeTextFields = 5
    public static func encodeScopePayload(_ scope: Scope) throws -> [UInt8] {
        try scope.validate()
        var out = [UInt8](repeating: 0, count: 512)
        for (index, text) in [scope.workspaceId, scope.incarnationId, scope.controllerInstanceId, scope.workerInstanceId, scope.admissionId].enumerated() {
            let ascii = Array(text.utf8)
            guard ascii.count <= WireLimits.tokenChars else { throw WireFailure.bad_field }
            out.replaceSubrange(index * 64..<index * 64 + ascii.count, with: ascii)
        }
        out.replaceSubrange(320..<352, with: hexBytes(scope.runtimeImageDigest))
        put64(UInt64(scope.leaseEpoch), &out, 352); put32(UInt32(scope.vcpus), &out, 360); put32(UInt32(scope.memoryMiB), &out, 364)
        return out
    }
    /// SHA-256 of the 512 byte SCOPE payload: how a `volumes` line and a VOLUMES envelope name the scope they belong to.
    public static func scopeDigest(_ scope: Scope) throws -> String {
        hexOf(ArraySlice(SHA256.hash(data: Data(try encodeScopePayload(scope)))))
    }
    static func readText(_ b: [UInt8], _ offset: Int) throws -> String {
        let field = b[offset..<offset + 64]
        guard let end = field.firstIndex(of: 0), end > offset, field[end...].allSatisfy({ $0 == 0 }) else { throw WireFailure.bad_field }
        let text = String(decoding: b[offset..<end], as: UTF8.self)
        guard V.isToken(text) else { throw WireFailure.bad_field }
        return text
    }
    static func decodeScopePayload(_ b: [UInt8]) throws -> Scope {
        guard b[368...].allSatisfy({ $0 == 0 }), get64(b, 352) <= 0xffff_ffff else { throw WireFailure.bad_field }
        let scope = Scope(workspaceId: try readText(b, 0), incarnationId: try readText(b, 64), leaseEpoch: Int(get64(b, 352)), admissionId: try readText(b, 256),
                          controllerInstanceId: try readText(b, 128), workerInstanceId: try readText(b, 192), runtimeImageDigest: hexOf(b[320..<352]),
                          vcpus: Int(get32(b, 360)), memoryMiB: Int(get32(b, 364)))
        try scope.validate()
        return scope
    }

    // ---- VOLUMES
    static func writeVolume(_ v: VolumeIdentity, purpose: VolumePurpose, _ out: inout [UInt8], _ at: Int) throws {
        try v.validate(purpose: purpose)
        put64(UInt64(v.device)!, &out, at); put64(UInt64(v.inode)!, &out, at + 8); put64(v.capacityBytes, &out, at + 16); put32(v.uid, &out, at + 24); put32(v.mode, &out, at + 28)
    }
    static func readVolume(_ b: [UInt8], _ at: Int, purpose: VolumePurpose) throws -> VolumeIdentity {
        let v = VolumeIdentity(purpose: purpose, device: String(get64(b, at)), inode: String(get64(b, at + 8)), uid: get32(b, at + 24), mode: get32(b, at + 28), capacityBytes: get64(b, at + 16))
        guard v.capacityBytes <= UInt64(WireLimits.maxSafeInteger) else { throw WireFailure.bad_field }
        try v.validate(purpose: purpose)
        return v
    }

    // ---- serialize / parse
    public static func serialize(_ envelope: Envelope) throws -> [UInt8] {
        guard envelope.seq >= 1 else { throw WireFailure.bad_sequence }
        let kind = Int(envelope.kindNumber), length = payloadBytes[kind]
        var out = [UInt8](repeating: 0, count: WireLimits.headerBytes + length)
        out.replaceSubrange(0..<4, with: magic); out[4] = 1; out[5] = envelope.kindNumber
        put32(envelope.seq, &out, 8); put32(UInt32(length), &out, 12)
        let base = WireLimits.headerBytes
        switch envelope {
        case .scope(_, let scope): out.replaceSubrange(base..<base + 512, with: try encodeScopePayload(scope))
        case .volumes(_, let digest, let volumes):
            guard V.isLowerHex(digest, count: 64), volumes.count == 2 else { throw WireFailure.bad_field }
            try VolumeIdentity.requireDistinctFiles(volumes)
            put32(1, &out, base); out.replaceSubrange(base + 8..<base + 40, with: hexBytes(digest))
            try writeVolume(volumes[0], purpose: .data, &out, base + 40); try writeVolume(volumes[1], purpose: .environment, &out, base + 72)
        case .drain(_, let nonce, let budget, let origin):
            guard V.isLowerHex(nonce, count: 32), (0...WireLimits.drainBudgetCeilingMs).contains(budget) else { throw WireFailure.bad_field }
            out.replaceSubrange(base..<base + 16, with: hexBytes(nonce)); put32(UInt32(budget), &out, base + 16); put32(origin == .hostStop ? 1 : 2, &out, base + 20)
        case .status(_, let state, let data, let environment):
            put32(UInt32(state.rawValue), &out, base)
            put64(data.requested, &out, base + 8); put64(data.completed, &out, base + 16); put64(environment.requested, &out, base + 24); put64(environment.completed, &out, base + 32)
        case .fault(_, let code): put32(UInt32(code.rawValue), &out, base)
        }
        return out
    }

    /// `rights` is how many descriptors arrived WITH the datagram. VOLUMES needs exactly 2; everything else exactly 0; the
    /// caller must close any it was handed when this throws.
    public static func parse(_ bytes: [UInt8], rights: Int, direction: EnvelopeDirection) throws -> Envelope {
        guard bytes.count >= WireLimits.headerBytes, Array(bytes[0..<4]) == magic else { throw WireFailure.malformed }
        guard bytes[4] == 1 else { throw WireFailure.version }
        let kind = Int(bytes[5])
        guard (1...5).contains(kind), get16(bytes, 6) == 0 else { throw WireFailure.unknown_type }
        let toWorker = kind <= 3
        guard toWorker == (direction == .toWorker) else { throw WireFailure.bad_direction }
        let seq = get32(bytes, 8), length = Int(get32(bytes, 12))
        guard seq >= 1 else { throw WireFailure.bad_sequence }
        guard length == payloadBytes[kind], bytes.count == WireLimits.headerBytes + length else { throw WireFailure.malformed }
        guard rights == (kind == 2 ? WireLimits.volumeRights : 0) else { throw WireFailure.bad_rights }
        let p = Array(bytes[WireLimits.headerBytes...])
        let parsed: Envelope
        switch kind {
        case 1: parsed = .scope(seq: seq, scope: try decodeScopePayload(p))
        case 2:
            guard get32(p, 0) == 1, get32(p, 4) == 0 else { throw WireFailure.bad_field }
            let pair = [try readVolume(p, 40, purpose: .data), try readVolume(p, 72, purpose: .environment)]
            try VolumeIdentity.requireDistinctFiles(pair)
            parsed = .volumes(seq: seq, scopeDigest: hexOf(p[8..<40]), volumes: pair)
        case 3:
            let origin = get32(p, 20)
            guard p[24...].allSatisfy({ $0 == 0 }), origin == 1 || origin == 2, Int(get32(p, 16)) <= WireLimits.drainBudgetCeilingMs else { throw WireFailure.bad_field }
            parsed = .drain(seq: seq, stopNonce: hexOf(p[0..<16]), budgetMs: Int(get32(p, 16)), origin: origin == 1 ? .hostStop : .ownerLoss)
        case 4:
            guard let state = WorkerStatus(rawValue: Int(get32(p, 0))), get32(p, 4) == 0 else { throw WireFailure.bad_field }
            let counters = [8, 24].map { FlushCounters(requested: get64(p, $0), completed: get64(p, $0 + 8)) }
            guard counters.allSatisfy({ $0.requested <= UInt64(WireLimits.maxSafeInteger) && $0.completed <= UInt64(WireLimits.maxSafeInteger) }) else { throw WireFailure.bad_field }
            parsed = .status(seq: seq, state: state, data: counters[0], environment: counters[1])
        default:
            guard let code = WorkerFault(rawValue: Int(get32(p, 0))), get32(p, 4) == 0 else { throw WireFailure.bad_field }
            parsed = .fault(seq: seq, code: code)
        }
        // Exact re-serialization, as for every other format here.
        guard try serialize(parsed) == bytes else { throw WireFailure.malformed }
        return parsed
    }
}
