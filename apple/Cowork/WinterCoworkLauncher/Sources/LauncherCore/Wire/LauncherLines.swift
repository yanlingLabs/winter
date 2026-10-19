import Foundation

/*
 * L1: daemon and launcher (docs/cowork-native-worker.md, section 4). NDJSON, one canonical JSON object per line. `id` is a request
 * correlation token chosen by the sender. Directions are enforced: a type received on the wrong side is `bad_direction`.
 */

public enum LineToDaemon: Equatable, Sendable {
    /// `parentVerified` is the literal `true`: the launcher states that it verified its parent; the daemon treats it as a gate, never as proof.
    case hello(launcherInstanceId: String, hostBootId: String)
    case begun(id: String, workerInstanceId: String, workerPid: Int, workerStartToken: String)
    case volumesAccepted(id: String)
    case refused(id: String, code: RefusalCode)
    case workerState(WorkerStateName)
    /// One bootstrap or runtime mux frame, whole.
    case muxUp(frame: [UInt8])
    /// `id` is the `stop` request it answers, nil for an owner-loss drain.
    case stopped(id: String?, receipt: OrderlyReceipt)
    case uncertain(receipt: UncertainReceipt)
    case pong(id: String)
    case fault(ChannelFault)
}

public enum LineToLauncher: Equatable, Sendable {
    /// `homeId` is the ONE source of the home identity: the launcher stamps it into every receipt. It does not travel on L2.
    case begin(id: String, homeId: String, scope: Scope)
    /// Arrives with exactly two descriptors (data, environment); the descriptors travel beside this value, never inside it.
    case volumes(id: String, scopeDigest: String, volumes: [VolumeIdentity])
    case muxDown(frame: [UInt8])
    case stop(id: String, stopNonce: String, reason: StopReason, budgetMs: Int)
    case receiptRetire(confirmationId: String)
    case ping(id: String)
}

public enum LauncherLineCodec {
    private static let toDaemonKeys: [String: [String]] = [
        "hello": ["launcherInstanceId", "hostBootId", "parentVerified"],
        "begun": ["id", "workerInstanceId", "workerPid", "workerStartToken"],
        "volumes_accepted": ["id"],
        "refused": ["id", "code"],
        "worker_state": ["state"],
        "mux_up": ["frame"],
        "stopped": ["id", "receipt"],
        "uncertain": ["receipt"],
        "pong": ["id"],
        "fault": ["code"],
    ]
    private static let toLauncherKeys: [String: [String]] = [
        "begin": ["id", "homeId"] + Scope.keys,
        "volumes": ["id", "scopeDigest", "volumes"],
        "mux_down": ["frame"],
        "stop": ["id", "stopNonce", "reason", "budgetMs"],
        "receipt_retire": ["confirmationId"],
        "ping": ["id"],
    ]
    private static let carriers: Set<String> = ["mux_up", "mux_down"]

    // ------------------------------------------------------------------------------------------ parse

    /// Strict parse of ONE line the daemon sent. `rights` is the number of descriptors that arrived with the line: `volumes` needs
    /// exactly two, nothing else may carry any.
    public static func parseToLauncher(_ raw: [UInt8], rights: Int = 0) throws -> LineToLauncher {
        let (type, members) = try envelope(raw, rights: rights, own: toLauncherKeys, other: toDaemonKeys)
        let f = try Fields(members, keys: ["v", "t"] + toLauncherKeys[type]!)
        let typed: LineToLauncher
        switch type {
        case "begin": typed = .begin(id: try V.token(f["id"]), homeId: try V.token(f["homeId"]), scope: try Scope.decode(f))
        case "volumes": typed = .volumes(id: try V.token(f["id"]), scopeDigest: try V.digest(f["scopeDigest"]), volumes: try VolumeIdentity.readPair(f["volumes"]))
        case "mux_down": typed = .muxDown(frame: try muxField(f["frame"]))
        case "stop":
            typed = .stop(id: try V.token(f["id"]), stopNonce: try V.nonce(f["stopNonce"]), reason: StopReason(rawValue: try V.oneOf(f["reason"], StopReason.allCases.map(\.rawValue)))!,
                          budgetMs: Int(try V.uint(f["budgetMs"], 0, Int64(WireLimits.drainBudgetCeilingMs))))
        case "receipt_retire": typed = .receiptRetire(confirmationId: try V.token(f["confirmationId"]))
        default: typed = .ping(id: try V.token(f["id"]))
        }
        guard try serialize(typed) == raw else { throw WireFailure.malformed }
        return typed
    }

    /// Strict parse of ONE line the launcher sent (the daemon's view; here it is the test harness's and the golden vectors').
    public static func parseToDaemon(_ raw: [UInt8], rights: Int = 0) throws -> LineToDaemon {
        let (type, members) = try envelope(raw, rights: rights, own: toDaemonKeys, other: toLauncherKeys)
        let f = try Fields(members, keys: ["v", "t"] + toDaemonKeys[type]!)
        let typed: LineToDaemon
        switch type {
        case "hello":
            try V.literal(f["parentVerified"], true)
            typed = .hello(launcherInstanceId: try V.label(f["launcherInstanceId"]), hostBootId: try V.label(f["hostBootId"]))
        case "begun":
            typed = .begun(id: try V.token(f["id"]), workerInstanceId: try V.token(f["workerInstanceId"]), workerPid: Int(try V.uint(f["workerPid"], 1, 0x7fff_ffff)), workerStartToken: try V.label(f["workerStartToken"]))
        case "volumes_accepted": typed = .volumesAccepted(id: try V.token(f["id"]))
        case "refused": typed = .refused(id: try V.token(f["id"]), code: RefusalCode(rawValue: try V.oneOf(f["code"], RefusalCode.allCases.map(\.rawValue)))!)
        case "worker_state": typed = .workerState(WorkerStateName(rawValue: try V.oneOf(f["state"], WorkerStateName.allCases.map(\.rawValue)))!)
        case "mux_up": typed = .muxUp(frame: try muxField(f["frame"]))
        case "stopped":
            let id: String?
            if case .null = f["id"] { id = nil } else { id = try V.token(f["id"]) }
            typed = .stopped(id: id, receipt: try OrderlyReceipt.decode(f["receipt"]))
        case "uncertain": typed = .uncertain(receipt: try UncertainReceipt.decode(f["receipt"]))
        case "pong": typed = .pong(id: try V.token(f["id"]))
        default: typed = .fault(ChannelFault(rawValue: try V.oneOf(f["code"], ChannelFault.allCases.map(\.rawValue)))!)
        }
        guard try serialize(typed) == raw else { throw WireFailure.malformed }
        return typed
    }

    /// The order of refusals is protocol.ts's: the generic canonical line, the type, direction, size, descriptors, version.
    private static func envelope(_ raw: [UInt8], rights: Int, own: [String: [String]], other: [String: [String]]) throws -> (type: String, members: [JSONMember]) {
        let (_, members) = try strictLine(raw, maxBytes: WireLimits.muxLineBytes, depth: WireLimits.launcherDepth)
        guard case .string(let type)? = members.first(where: { $0.key == "t" })?.value else { throw WireFailure.malformed }
        guard own[type] != nil else { throw other[type] != nil ? WireFailure.bad_direction : WireFailure.unknown_type }
        guard raw.count <= (carriers.contains(type) ? WireLimits.muxLineBytes : WireLimits.controlLineBytes) else { throw WireFailure.oversize }
        guard rights == (type == "volumes" ? WireLimits.volumeRights : 0) else { throw WireFailure.bad_rights }
        guard case .integer(1)? = members.first(where: { $0.key == "v" })?.value else { throw WireFailure.version }
        return (type, members)
    }

    /// A mux carrier: canonical base64 of one whole bootstrap or runtime frame. The launcher relays blind, so it looks at the
    /// header and nothing inside the payload; control frames terminate at the worker and never cross L1.
    private static func muxField(_ value: JSONValue) throws -> [UInt8] {
        guard case .string(let text) = value, !text.isEmpty, text.utf8.count % 4 == 0,
              text.utf8.allSatisfy({ ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2b || $0 == 0x2f || $0 == 0x3d }),
              let data = Data(base64Encoded: text) else { throw WireFailure.bad_field }
        guard data.base64EncodedString() == text else { throw WireFailure.bad_field }
        let bytes = [UInt8](data)
        let header = try MuxFormat.parseFrame(bytes)
        guard header.muxClass == .bootstrap || header.muxClass == .runtime else { throw WireFailure.bad_field }
        return bytes
    }

    // ------------------------------------------------------------------------------------------ serialize

    private static func require(_ condition: Bool) throws { guard condition else { throw WireFailure.bad_field } }

    public static func serialize(_ message: LineToDaemon) throws -> [UInt8] {
        var w = JSONWriter()
        w.beginObject(); w.key("v"); w.integer(1); w.key("t")
        switch message {
        case .hello(let instance, let boot):
            try require(V.isLabel(instance) && V.isLabel(boot))
            w.string("hello"); w.key("launcherInstanceId"); w.string(instance); w.key("hostBootId"); w.string(boot); w.key("parentVerified"); w.bool(true)
        case .begun(let id, let worker, let pid, let token):
            try require(V.isToken(id) && V.isToken(worker) && (1...0x7fff_ffff).contains(pid) && V.isLabel(token))
            w.string("begun"); w.key("id"); w.string(id); w.key("workerInstanceId"); w.string(worker); w.key("workerPid"); w.integer(pid); w.key("workerStartToken"); w.string(token)
        case .volumesAccepted(let id): try require(V.isToken(id)); w.string("volumes_accepted"); w.key("id"); w.string(id)
        case .refused(let id, let code): try require(V.isToken(id)); w.string("refused"); w.key("id"); w.string(id); w.key("code"); w.string(code.rawValue)
        case .workerState(let state): w.string("worker_state"); w.key("state"); w.string(state.rawValue)
        case .muxUp(let frame): try requireRelayable(frame); w.string("mux_up"); w.key("frame"); w.string(Data(frame).base64EncodedString())
        case .stopped(let id, let receipt):
            if let id { try require(V.isToken(id)) }
            w.string("stopped"); w.key("id"); if let id { w.string(id) } else { w.null() }; w.key("receipt"); receipt.write(&w)
        case .uncertain(let receipt): w.string("uncertain"); w.key("receipt"); receipt.write(&w)
        case .pong(let id): try require(V.isToken(id)); w.string("pong"); w.key("id"); w.string(id)
        case .fault(let code): w.string("fault"); w.key("code"); w.string(code.rawValue)
        }
        w.endObject()
        return finish(w, message: message)
    }

    public static func serialize(_ message: LineToLauncher) throws -> [UInt8] {
        var w = JSONWriter()
        w.beginObject(); w.key("v"); w.integer(1); w.key("t")
        switch message {
        case .begin(let id, let homeId, let scope):
            try require(V.isToken(id) && V.isToken(homeId)); try scope.validate()
            w.string("begin"); w.key("id"); w.string(id); w.key("homeId"); w.string(homeId); scope.write(&w)
        case .volumes(let id, let digest, let volumes):
            try require(V.isToken(id) && V.isLowerHex(digest, count: 64) && volumes.count == 2)
            try VolumeIdentity.requireDistinctFiles(volumes)
            try volumes[0].validate(purpose: .data); try volumes[1].validate(purpose: .environment)
            w.string("volumes"); w.key("id"); w.string(id); w.key("scopeDigest"); w.string(digest); w.key("volumes"); w.beginArray(); volumes.forEach { $0.write(&w) }; w.endArray()
        case .muxDown(let frame): try requireRelayable(frame); w.string("mux_down"); w.key("frame"); w.string(Data(frame).base64EncodedString())
        case .stop(let id, let nonce, let reason, let budget):
            try require(V.isToken(id) && V.isLowerHex(nonce, count: 32) && (0...WireLimits.drainBudgetCeilingMs).contains(budget))
            w.string("stop"); w.key("id"); w.string(id); w.key("stopNonce"); w.string(nonce); w.key("reason"); w.string(reason.rawValue); w.key("budgetMs"); w.integer(budget)
        case .receiptRetire(let confirmation): try require(V.isToken(confirmation)); w.string("receipt_retire"); w.key("confirmationId"); w.string(confirmation)
        case .ping(let id): try require(V.isToken(id)); w.string("ping"); w.key("id"); w.string(id)
        }
        w.endObject()
        return finish(w, message: message)
    }

    private static func requireRelayable(_ frame: [UInt8]) throws {
        _ = try MuxFormat.parseRelayable(frame)
    }
    private static func finish<T>(_ w: JSONWriter, message: T) -> [UInt8] { w.bytes + [0x0a] }
}
