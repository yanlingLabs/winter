import Foundation

/*
 * Stop receipts (docs/cowork-native-worker.md, section 7). Two classes kept apart by type:
 *
 *   Class A, orderly   the ONLY format that can ever become release evidence. The launcher fsyncs it to its durable store BEFORE
 *                      it sends it, and keeps it until the daemon sends `receipt_retire`.
 *   Class B, uncertain a crash, a daemon loss, a forced kill, a drain that ran out of budget, a closed channel. It has no key that
 *                      could name a confirmation, no nonce and no volume list: nothing in it can be turned into a release.
 */

public enum FinalFlush: String, Sendable { case completed, notAttached = "not-attached" }
public enum GuestDrain: String, Sendable { case acked, notBooted = "not-booted" }
public enum GuestPowerOff: String, Sendable { case observed, notBooted = "not-booted" }
public enum UncertainExit: String, Sendable { case code, signal, unknown }

public struct OrderlyVolume: Equatable, Sendable {
    public var purpose: VolumePurpose
    public var device: String
    public var inode: String
    public var capacityBytes: UInt64
    public var attached: Bool
    public var flushRequested: UInt64
    public var flushCompleted: UInt64
    public var finalFlush: FinalFlush
    public init(purpose: VolumePurpose, device: String, inode: String, capacityBytes: UInt64, attached: Bool, flushRequested: UInt64, flushCompleted: UInt64, finalFlush: FinalFlush) {
        self.purpose = purpose; self.device = device; self.inode = inode; self.capacityBytes = capacityBytes; self.attached = attached
        self.flushRequested = flushRequested; self.flushCompleted = flushCompleted; self.finalFlush = finalFlush
    }
    static let keys = ["purpose", "device", "inode", "capacityBytes", "attached", "flushRequested", "flushCompleted", "finalFlush"]
    /// A volume the worker never received cannot be named by the launcher, so an unattached entry carries zeros.
    static func unattached(_ purpose: VolumePurpose) -> OrderlyVolume {
        OrderlyVolume(purpose: purpose, device: "0", inode: "0", capacityBytes: 0, attached: false, flushRequested: 0, flushCompleted: 0, finalFlush: .notAttached)
    }
    static func decode(_ value: JSONValue, purpose: VolumePurpose) throws -> OrderlyVolume {
        let f = try Fields(try V.object(value), keys: keys)
        try V.literal(f["purpose"], purpose.rawValue)
        let size: UInt64
        if case .integer(0) = f["capacityBytes"] { size = 0 } else { size = try V.capacity(f["capacityBytes"]) }
        return OrderlyVolume(purpose: purpose, device: try V.decimal64(f["device"]), inode: try V.decimal64(f["inode"]), capacityBytes: size, attached: try V.bool(f["attached"]),
                             flushRequested: UInt64(try V.uint(f["flushRequested"])), flushCompleted: UInt64(try V.uint(f["flushCompleted"])),
                             finalFlush: FinalFlush(rawValue: try V.oneOf(f["finalFlush"], ["completed", "not-attached"]))!)
    }
    func write(_ w: inout JSONWriter) {
        w.beginObject(); w.key("purpose"); w.string(purpose.rawValue); w.key("device"); w.string(device); w.key("inode"); w.string(inode)
        w.key("capacityBytes"); w.integer(capacityBytes); w.key("attached"); w.bool(attached); w.key("flushRequested"); w.integer(flushRequested)
        w.key("flushCompleted"); w.integer(flushCompleted); w.key("finalFlush"); w.string(finalFlush.rawValue); w.endObject()
    }
}

public struct OrderlyReceipt: Equatable, Sendable {
    public var confirmationId: String
    public var stopNonce: String
    public var origin: StopOrigin
    public var launcherInstanceId: String
    public var admissionId: String
    public var homeId: String
    public var workspaceId: String
    public var incarnationId: String
    public var leaseEpoch: Int
    public var controllerInstanceId: String
    public var workerInstanceId: String
    public var runtimeImageDigest: String
    public var hostBootId: String
    public var guestDrain: GuestDrain
    public var guestPowerOff: GuestPowerOff
    public var workerPid: Int
    public var workerStartToken: String
    public var volumes: [OrderlyVolume]
    public var issuedAtMs: UInt64
    public init(confirmationId: String, stopNonce: String, origin: StopOrigin, launcherInstanceId: String, admissionId: String, homeId: String, workspaceId: String,
                incarnationId: String, leaseEpoch: Int, controllerInstanceId: String, workerInstanceId: String, runtimeImageDigest: String, hostBootId: String,
                guestDrain: GuestDrain, guestPowerOff: GuestPowerOff, workerPid: Int, workerStartToken: String, volumes: [OrderlyVolume], issuedAtMs: UInt64) {
        self.confirmationId = confirmationId; self.stopNonce = stopNonce; self.origin = origin; self.launcherInstanceId = launcherInstanceId; self.admissionId = admissionId
        self.homeId = homeId; self.workspaceId = workspaceId; self.incarnationId = incarnationId; self.leaseEpoch = leaseEpoch; self.controllerInstanceId = controllerInstanceId
        self.workerInstanceId = workerInstanceId; self.runtimeImageDigest = runtimeImageDigest; self.hostBootId = hostBootId; self.guestDrain = guestDrain
        self.guestPowerOff = guestPowerOff; self.workerPid = workerPid; self.workerStartToken = workerStartToken; self.volumes = volumes; self.issuedAtMs = issuedAtMs
    }
    static let keys = ["v", "class", "confirmationId", "stopNonce", "origin", "launcherInstanceId", "admissionId", "homeId", "workspaceId", "incarnationId", "leaseEpoch",
                       "controllerInstanceId", "workerInstanceId", "runtimeImageDigest", "hostBootId", "guest", "worker", "volumes", "issuedAtMs"]

    static func decode(_ value: JSONValue) throws -> OrderlyReceipt {
        let f = try Fields(try V.object(value), keys: keys)
        try V.literal(f["v"], 1); try V.literal(f["class"], "A")
        let guest = try Fields(try V.object(f["guest"]), keys: ["drain", "powerOff"])
        let worker = try Fields(try V.object(f["worker"]), keys: ["pid", "startToken", "exit", "status", "reaped"])
        try V.literal(worker["exit"], "code"); try V.literal(worker["status"], 0); try V.literal(worker["reaped"], true)
        let items = try V.array(f["volumes"])
        guard items.count == 2 else { throw WireFailure.bad_field }
        return OrderlyReceipt(
            confirmationId: try V.token(f["confirmationId"]), stopNonce: try V.nonce(f["stopNonce"]), origin: StopOrigin(rawValue: try V.oneOf(f["origin"], StopOrigin.allCases.map(\.rawValue)))!,
            launcherInstanceId: try V.label(f["launcherInstanceId"]), admissionId: try V.token(f["admissionId"]), homeId: try V.token(f["homeId"]), workspaceId: try V.token(f["workspaceId"]),
            incarnationId: try V.token(f["incarnationId"]), leaseEpoch: try V.epoch(f["leaseEpoch"]), controllerInstanceId: try V.token(f["controllerInstanceId"]),
            workerInstanceId: try V.token(f["workerInstanceId"]), runtimeImageDigest: try V.digest(f["runtimeImageDigest"]), hostBootId: try V.label(f["hostBootId"]),
            guestDrain: GuestDrain(rawValue: try V.oneOf(guest["drain"], ["acked", "not-booted"]))!, guestPowerOff: GuestPowerOff(rawValue: try V.oneOf(guest["powerOff"], ["observed", "not-booted"]))!,
            workerPid: Int(try V.uint(worker["pid"], 1, 0x7fff_ffff)), workerStartToken: try V.label(worker["startToken"]),
            volumes: [try OrderlyVolume.decode(items[0], purpose: .data), try OrderlyVolume.decode(items[1], purpose: .environment)], issuedAtMs: UInt64(try V.uint(f["issuedAtMs"])))
    }
    func write(_ w: inout JSONWriter) {
        w.beginObject(); w.key("v"); w.integer(1); w.key("class"); w.string("A"); w.key("confirmationId"); w.string(confirmationId); w.key("stopNonce"); w.string(stopNonce)
        w.key("origin"); w.string(origin.rawValue); w.key("launcherInstanceId"); w.string(launcherInstanceId); w.key("admissionId"); w.string(admissionId)
        w.key("homeId"); w.string(homeId); w.key("workspaceId"); w.string(workspaceId); w.key("incarnationId"); w.string(incarnationId); w.key("leaseEpoch"); w.integer(leaseEpoch)
        w.key("controllerInstanceId"); w.string(controllerInstanceId); w.key("workerInstanceId"); w.string(workerInstanceId); w.key("runtimeImageDigest"); w.string(runtimeImageDigest)
        w.key("hostBootId"); w.string(hostBootId)
        w.key("guest"); w.beginObject(); w.key("drain"); w.string(guestDrain.rawValue); w.key("powerOff"); w.string(guestPowerOff.rawValue); w.endObject()
        w.key("worker"); w.beginObject(); w.key("pid"); w.integer(workerPid); w.key("startToken"); w.string(workerStartToken); w.key("exit"); w.string("code")
        w.key("status"); w.integer(0); w.key("reaped"); w.bool(true); w.endObject()
        w.key("volumes"); w.beginArray(); volumes.forEach { $0.write(&w) }; w.endArray()
        w.key("issuedAtMs"); w.integer(issuedAtMs); w.endObject()
    }

    /// The internal consistency a Class A receipt must have to mean what it says (`classAInvariantsHold` in protocol.ts). A
    /// launcher that cannot state all of these emits Class B instead.
    public var invariantsHold: Bool {
        let booted = guestDrain == .acked
        if booted != (guestPowerOff == .observed) { return false }
        guard volumes.count == 2, volumes[0].attached == volumes[1].attached else { return false }
        return volumes.allSatisfy { v in
            v.attached
                // Held by the worker: every requested flush completed and a final flush followed. A guest that never booted wrote nothing.
                ? v.finalFlush == .completed && v.flushRequested == v.flushCompleted && v.capacityBytes > 0 && (booted || v.flushRequested == 0)
                : v.finalFlush == .notAttached && v.flushRequested == 0 && v.flushCompleted == 0 && v.device == "0" && v.inode == "0" && v.capacityBytes == 0
        }
    }
}

public struct UncertainReceipt: Equatable, Sendable {
    public var launcherInstanceId: String
    public var admissionId: String
    public var workspaceId: String
    public var incarnationId: String
    public var leaseEpoch: Int
    public var workerInstanceId: String
    public var reason: UncertainReason
    public var workerPid: Int
    public var workerStartToken: String
    public var workerExit: UncertainExit
    public var workerStatus: Int
    public var attachedVolumes: Bool
    public var issuedAtMs: UInt64
    public init(launcherInstanceId: String, admissionId: String, workspaceId: String, incarnationId: String, leaseEpoch: Int, workerInstanceId: String, reason: UncertainReason,
                workerPid: Int, workerStartToken: String, workerExit: UncertainExit, workerStatus: Int, attachedVolumes: Bool, issuedAtMs: UInt64) {
        self.launcherInstanceId = launcherInstanceId; self.admissionId = admissionId; self.workspaceId = workspaceId; self.incarnationId = incarnationId; self.leaseEpoch = leaseEpoch
        self.workerInstanceId = workerInstanceId; self.reason = reason; self.workerPid = workerPid; self.workerStartToken = workerStartToken; self.workerExit = workerExit
        self.workerStatus = workerStatus; self.attachedVolumes = attachedVolumes; self.issuedAtMs = issuedAtMs
    }
    static let keys = ["v", "class", "launcherInstanceId", "admissionId", "workspaceId", "incarnationId", "leaseEpoch", "workerInstanceId", "reason", "worker", "attachedVolumes", "issuedAtMs"]

    static func decode(_ value: JSONValue) throws -> UncertainReceipt {
        let f = try Fields(try V.object(value), keys: keys)
        try V.literal(f["v"], 1); try V.literal(f["class"], "B")
        let worker = try Fields(try V.object(f["worker"]), keys: ["pid", "startToken", "exit", "status"])
        return UncertainReceipt(
            launcherInstanceId: try V.label(f["launcherInstanceId"]), admissionId: try V.token(f["admissionId"]), workspaceId: try V.token(f["workspaceId"]), incarnationId: try V.token(f["incarnationId"]),
            leaseEpoch: try V.epoch(f["leaseEpoch"]), workerInstanceId: try V.token(f["workerInstanceId"]), reason: UncertainReason(rawValue: try V.oneOf(f["reason"], UncertainReason.allCases.map(\.rawValue)))!,
            workerPid: Int(try V.uint(worker["pid"], 1, 0x7fff_ffff)), workerStartToken: try V.label(worker["startToken"]),
            workerExit: UncertainExit(rawValue: try V.oneOf(worker["exit"], ["code", "signal", "unknown"]))!, workerStatus: Int(try V.uint(worker["status"], 0, 255)),
            attachedVolumes: try V.bool(f["attachedVolumes"]), issuedAtMs: UInt64(try V.uint(f["issuedAtMs"])))
    }
    func write(_ w: inout JSONWriter) {
        w.beginObject(); w.key("v"); w.integer(1); w.key("class"); w.string("B"); w.key("launcherInstanceId"); w.string(launcherInstanceId); w.key("admissionId"); w.string(admissionId)
        w.key("workspaceId"); w.string(workspaceId); w.key("incarnationId"); w.string(incarnationId); w.key("leaseEpoch"); w.integer(leaseEpoch)
        w.key("workerInstanceId"); w.string(workerInstanceId); w.key("reason"); w.string(reason.rawValue)
        w.key("worker"); w.beginObject(); w.key("pid"); w.integer(workerPid); w.key("startToken"); w.string(workerStartToken); w.key("exit"); w.string(workerExit.rawValue)
        w.key("status"); w.integer(workerStatus); w.endObject()
        w.key("attachedVolumes"); w.bool(attachedVolumes); w.key("issuedAtMs"); w.integer(issuedAtMs); w.endObject()
    }
}

public enum StopReceipt: Equatable, Sendable {
    case orderly(OrderlyReceipt)
    case uncertain(UncertainReceipt)

    /// The exact single line the durable store keeps and the `stopped` / `uncertain` lines embed.
    public func serialize() throws -> [UInt8] {
        var w = JSONWriter()
        switch self {
        case .orderly(let r): r.write(&w)
        case .uncertain(let r): r.write(&w)
        }
        let line = w.bytes + [0x0a]
        guard line.count <= WireLimits.receiptBytes else { throw WireFailure.oversize }
        return line
    }
    /// Parse the text of ONE receipt (the durable store's file content). Exact re-serialization or it is `malformed`.
    public static func parse(_ raw: [UInt8]) throws -> StopReceipt {
        let (_, members) = try strictLine(raw, maxBytes: WireLimits.receiptBytes, depth: WireLimits.receiptDepth)
        let typed: StopReceipt
        switch members.first(where: { $0.key == "class" })?.value {
        case .string("A")?: typed = .orderly(try OrderlyReceipt.decode(.object(members)))
        case .string("B")?: typed = .uncertain(try UncertainReceipt.decode(.object(members)))
        default: throw WireFailure.unknown_type
        }
        guard try typed.serialize() == raw else { throw WireFailure.malformed }
        return typed
    }
}
