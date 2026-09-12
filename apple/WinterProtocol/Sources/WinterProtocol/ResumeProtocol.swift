import Foundation

/// One stream's replay cursor, as the phone last saw it — the unit the client asks the host to
/// resume from in `ClientHello.resumes`.
public struct StreamResume: Codable, Equatable {
    public let sessionID: String
    public let streamID: String
    public let lastAppliedSeq: Int

    public init(sessionID: String, streamID: String, lastAppliedSeq: Int) {
        self.sessionID = sessionID
        self.streamID = streamID
        self.lastAppliedSeq = lastAppliedSeq
    }
}

/// Client → host, the first message on a new connection (the JSON-RPC payload wrapped in a
/// `WireEnvelope` of `kind: .hello`).
public struct ClientHello: Codable, Equatable {
    public let protocolVersions: [Int]
    public let appBuild: String
    public let clientInstanceID: String
    public let pairingEpoch: Int
    public let resumes: [StreamResume]

    public init(
        protocolVersions: [Int],
        appBuild: String,
        clientInstanceID: String,
        pairingEpoch: Int,
        resumes: [StreamResume]
    ) {
        self.protocolVersions = protocolVersions
        self.appBuild = appBuild
        self.clientInstanceID = clientInstanceID
        self.pairingEpoch = pairingEpoch
        self.resumes = resumes
    }
}

/// The host's per-stream verdict on a requested resume. Codable/Equatable are compiler-
/// synthesized (SE-0295: an enum with all-Codable/Equatable labeled associated values needs no
/// hand-written `init(from:)`/`encode(to:)`) — the wire shape is a single-key object keyed by
/// case name, e.g. `{"upToDate":{"sessionID":"s1","highWatermark":5}}`.
public enum ResumeVerdict: Codable, Equatable {
    /// The client is behind but within the host's retained log — replay `fromSeq` (inclusive)
    /// up to `highWatermark`.
    case replayBegin(sessionID: String, fromSeq: Int, highWatermark: Int)
    /// The client's `lastAppliedSeq` already matches the host's `highWatermark` — nothing to
    /// replay.
    case upToDate(sessionID: String, highWatermark: Int)
    /// The client is too far behind (or unknown to the host) — the requested range fell out of
    /// the retained log; the client must fetch a full snapshot instead of replaying.
    case snapshotRequired(sessionID: String, reason: String, oldestAvailableSeq: Int)
}

/// Host → client, in answer to `ClientHello` (the JSON-RPC payload wrapped in a `WireEnvelope`
/// of `kind: .helloAck`).
public struct ServerHello: Codable, Equatable {
    public let chosenVersion: Int
    public let hostID: String
    public let verdicts: [ResumeVerdict]

    public init(chosenVersion: Int, hostID: String, verdicts: [ResumeVerdict]) {
        self.chosenVersion = chosenVersion
        self.hostID = hostID
        self.verdicts = verdicts
    }
}
