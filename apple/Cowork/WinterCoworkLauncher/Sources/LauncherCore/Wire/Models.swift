import Foundation

// The closed vocabularies and records of the contract (docs/cowork-native-worker.md, sections 4 to 7).

public enum RefusalCode: String, CaseIterable, Sendable {
    case bad_request, busy, not_begun, worker_spawn_failed, code_identity_mismatch, sandbox_failed, volumes_rejected, `internal`
}
public enum ChannelFault: String, CaseIterable, Sendable {
    case parent_unverified, protocol_violation, worker_channel_lost, `internal`
}
/// Informational only. Never evidence.
public enum WorkerStateName: String, CaseIterable, Sendable {
    case sandboxed, volumes_accepted, vm_running, guest_hello, draining, drain_acked, exited
}
public enum StopReason: String, CaseIterable, Sendable {
    case user, shutdown, restart, update
    case failedStart = "failed-start"
}
public enum StopOrigin: String, CaseIterable, Sendable {
    case hostStop = "host-stop"
    case ownerLossDrain = "owner-loss-drain"
}
/// The origin carried by a DRAIN envelope and by the guest `drain` control frame.
public enum DrainOrigin: String, CaseIterable, Sendable {
    case hostStop = "host-stop"
    case ownerLoss = "owner-loss"
}
/// Class B reasons. None of them can ever release anything.
public enum UncertainReason: String, CaseIterable, Sendable {
    case daemonLost = "daemon-lost"
    case drainTimeout = "drain-timeout"
    case workerKilled = "worker-killed"
    case workerCrashed = "worker-crashed"
    case guestFault = "guest-fault"
    case flushUncertain = "flush-uncertain"
    case channelEOF = "channel-eof"
    case launcherFault = "launcher-fault"
}
public enum VolumePurpose: String, CaseIterable, Sendable { case data, environment }

/// The numbering is the wire's (`u32 state`, minus nothing: 1 is `sandboxed`).
public enum WorkerStatus: Int, CaseIterable, Sendable {
    case sandboxed = 1, volumesAccepted, vmRunning, guestHello, draining, drainAcked, guestHalted, exiting
}
public enum WorkerFault: Int, CaseIterable, Sendable {
    case badScope = 1, badVolumes, sandboxFailed, vmFailed, muxViolation, truncatedRights, `internal`, secondDrain
}

/// What the daemon tells the launcher to start (`begin`), what the launcher gives the worker (the SCOPE envelope) and what every
/// receipt echoes. The five owner fields are `CoworkVolumeOwner` verbatim.
public struct Scope: Equatable, Sendable {
    public var workspaceId: String
    public var incarnationId: String
    public var leaseEpoch: Int
    public var admissionId: String
    public var controllerInstanceId: String
    public var workerInstanceId: String
    public var runtimeImageDigest: String
    public var vcpus: Int
    public var memoryMiB: Int
    public init(workspaceId: String, incarnationId: String, leaseEpoch: Int, admissionId: String, controllerInstanceId: String, workerInstanceId: String,
                runtimeImageDigest: String, vcpus: Int = WireLimits.vcpus, memoryMiB: Int) {
        self.workspaceId = workspaceId; self.incarnationId = incarnationId; self.leaseEpoch = leaseEpoch; self.admissionId = admissionId
        self.controllerInstanceId = controllerInstanceId; self.workerInstanceId = workerInstanceId; self.runtimeImageDigest = runtimeImageDigest
        self.vcpus = vcpus; self.memoryMiB = memoryMiB
    }

    static let keys = ["workspaceId", "incarnationId", "leaseEpoch", "admissionId", "controllerInstanceId", "workerInstanceId", "runtimeImageDigest", "vcpus", "memoryMiB"]

    /// Reads the nine scope members out of `fields` (which may hold more members: `begin` also carries `id`).
    static func decode(_ fields: Fields) throws -> Scope {
        try V.literal(fields["vcpus"], Int64(WireLimits.vcpus))
        return Scope(workspaceId: try V.token(fields["workspaceId"]), incarnationId: try V.token(fields["incarnationId"]), leaseEpoch: try V.epoch(fields["leaseEpoch"]),
                     admissionId: try V.token(fields["admissionId"]), controllerInstanceId: try V.token(fields["controllerInstanceId"]),
                     workerInstanceId: try V.token(fields["workerInstanceId"]), runtimeImageDigest: try V.digest(fields["runtimeImageDigest"]), vcpus: WireLimits.vcpus,
                     memoryMiB: Int(try V.uint(fields["memoryMiB"], Int64(WireLimits.minMemoryMiB), Int64(WireLimits.maxMemoryMiB))))
    }
    /// The nine members in the contract's order, into an object the caller has opened.
    func write(_ w: inout JSONWriter) {
        w.key("workspaceId"); w.string(workspaceId); w.key("incarnationId"); w.string(incarnationId); w.key("leaseEpoch"); w.integer(leaseEpoch)
        w.key("admissionId"); w.string(admissionId); w.key("controllerInstanceId"); w.string(controllerInstanceId); w.key("workerInstanceId"); w.string(workerInstanceId)
        w.key("runtimeImageDigest"); w.string(runtimeImageDigest); w.key("vcpus"); w.integer(vcpus); w.key("memoryMiB"); w.integer(memoryMiB)
    }
    /// Refuses a scope that does not satisfy the closed schema (a hand-built value never reaches an encoder unchecked).
    func validate() throws {
        guard [workspaceId, incarnationId, admissionId, controllerInstanceId, workerInstanceId].allSatisfy(V.isToken), V.isLowerHex(runtimeImageDigest, count: 64),
              (1...0xffff_ffff).contains(leaseEpoch), vcpus == WireLimits.vcpus, (WireLimits.minMemoryMiB...WireLimits.maxMemoryMiB).contains(memoryMiB) else { throw WireFailure.bad_field }
    }
}

/// The identity of one image file as the daemon states it: where the descriptor must point.
public struct VolumeIdentity: Equatable, Sendable {
    public var purpose: VolumePurpose
    public var device: String
    public var inode: String
    public var uid: UInt32
    public var mode: UInt32
    public var capacityBytes: UInt64
    public static let requiredMode: UInt32 = 0o600
    public init(purpose: VolumePurpose, device: String, inode: String, uid: UInt32, mode: UInt32 = VolumeIdentity.requiredMode, capacityBytes: UInt64) {
        self.purpose = purpose; self.device = device; self.inode = inode; self.uid = uid; self.mode = mode; self.capacityBytes = capacityBytes
    }
    static let keys = ["purpose", "device", "inode", "uid", "mode", "capacityBytes"]

    static func decode(_ value: JSONValue, purpose: VolumePurpose) throws -> VolumeIdentity {
        let f = try Fields(try V.object(value), keys: keys)
        try V.literal(f["purpose"], purpose.rawValue); try V.literal(f["mode"], Int64(requiredMode))
        return VolumeIdentity(purpose: purpose, device: try V.decimal64(f["device"]), inode: try V.decimal64(f["inode"]), uid: UInt32(try V.uint(f["uid"], 0, 0xffff_ffff)),
                              capacityBytes: try V.capacity(f["capacityBytes"]))
    }
    func write(_ w: inout JSONWriter) {
        w.beginObject(); w.key("purpose"); w.string(purpose.rawValue); w.key("device"); w.string(device); w.key("inode"); w.string(inode)
        w.key("uid"); w.integer(Int64(uid)); w.key("mode"); w.integer(Int64(mode)); w.key("capacityBytes"); w.integer(capacityBytes); w.endObject()
    }
    func validate(purpose expected: VolumePurpose) throws {
        guard purpose == expected, V.isDecimal64(device), V.isDecimal64(inode), mode == VolumeIdentity.requiredMode, capacityBytes >= 16 * 1024 * 1024,
              capacityBytes <= 256 * 1024 * 1024 * 1024, capacityBytes % 4096 == 0 else { throw WireFailure.bad_field }
    }

    /// Exactly two volumes, data first, environment second. Position IS the purpose. One file may never back both disks
    /// (the same-pair alias refusal of the fixture handoff).
    static func readPair(_ value: JSONValue) throws -> [VolumeIdentity] {
        let items = try V.array(value)
        guard items.count == 2 else { throw WireFailure.bad_field }
        let pair = [try decode(items[0], purpose: .data), try decode(items[1], purpose: .environment)]
        try requireDistinctFiles(pair)
        return pair
    }
    static func requireDistinctFiles(_ pair: [VolumeIdentity]) throws {
        guard pair.count == 2, !(pair[0].device == pair[1].device && pair[0].inode == pair[1].inode) else { throw WireFailure.bad_field }
    }
}
