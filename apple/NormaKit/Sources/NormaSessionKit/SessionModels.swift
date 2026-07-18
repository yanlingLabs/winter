import Foundation
import NormaProtocol

/// A decoded live/replay frame the UI consumes — `NormaSessionClient.events` yields these in
/// applied order. `json` is the frame payload as an opaque JSON tree (an event frame's payload is a
/// `SessionEvent`; the client never re-types it, the UI does). `seq`/`streamID` are `nil` for
/// non-event frames, present for events.
///
/// The `json` type is `NormaProtocol`'s `SessionEvent.JSONValue` (the protocol-level JSON tree),
/// NOT `NormaKit.JSONValue`: `NormaSessionKit` links only `NormaProtocol`, and naming a top-level
/// `JSONValue` here would collide with `NormaKit.JSONValue` inside the `NormaKit` target that also
/// imports this module.
public struct SessionEnvelope: Sendable, Equatable {
    public let sessionID: String
    public let streamID: String?
    public let seq: Int?
    public let kind: WireKind
    public let json: SessionEvent.JSONValue

    public init(sessionID: String, streamID: String?, seq: Int?, kind: WireKind, json: SessionEvent.JSONValue) {
        self.sessionID = sessionID
        self.streamID = streamID
        self.seq = seq
        self.kind = kind
        self.json = json
    }
}

/// The lifecycle of one remote approval answer. `sent` is the pre-ack state (the request is on the
/// wire, the host has not answered yet); `answerApproval` NEVER returns it — it blocks until the
/// host acks and then returns one of the three terminal states.
public enum ApprovalState: Sendable, Equatable {
    case sent
    case hostAccepted
    case expired
    case resolvedElsewhere
}

/// A phone → host approval answer. `commandID` is the idempotency key (stable across retries); the
/// wire carries it as the top-level `commandId` the daemon dedups on. `expectedVersion` is the
/// optimistic-concurrency guard the host uses to detect a stale answer (SP3 remote-approval
/// contract; maps to `.expired` when the host rejects it).
public struct ApprovalAnswer: Sendable, Equatable {
    public let approvalID: String
    public let expectedVersion: Int
    public let decision: String
    public let commandID: String

    public init(approvalID: String, expectedVersion: Int, decision: String, commandID: String) {
        self.approvalID = approvalID
        self.expectedVersion = expectedVersion
        self.decision = decision
        self.commandID = commandID
    }
}

/// Surfaced on `NormaSessionClient.gaps` when a stream's incoming seq skips ahead of
/// `cursor + 1` — the retained-log replay window was overrun and contiguity is broken. The consumer
/// (T8's iOS Code-mode model) reacts by re-handshaking with a snapshot resume for `(sessionID,
/// streamID)`. The client stops applying that stream's events until a fresh handshake, so no
/// out-of-order event is ever yielded past a gap.
public struct GapSignal: Sendable, Equatable {
    public let sessionID: String
    public let streamID: String
    /// The seq the client next expected (`cursor + 1`).
    public let expectedSeq: Int
    /// The seq that actually arrived (`> expectedSeq`).
    public let receivedSeq: Int

    public init(sessionID: String, streamID: String, expectedSeq: Int, receivedSeq: Int) {
        self.sessionID = sessionID
        self.streamID = streamID
        self.expectedSeq = expectedSeq
        self.receivedSeq = receivedSeq
    }
}

/// Surfaced on `NormaSessionClient.persistErrors` when a `CursorStore.advance` throws AFTER its
/// event was yielded (T4 review minor 1). The failure direction is safe — the cursor stays behind,
/// so the event is re-delivered (and deduped) on the next resume, never skipped — but a PERSISTENT
/// write failure (disk full, bad perms) would silently defeat crash-durability forever, so it must
/// be observable. Deliberately NOT a `GapSignal` variant: a gap demands a snapshot resume; a
/// persist failure demands attention/diagnostics — re-handshaking would not fix the disk. T8
/// observes this channel and surfaces a health warning.
public struct CursorPersistFailure: Sendable, Equatable {
    public let sessionID: String
    public let streamID: String
    /// The seq that WAS yielded but whose cursor advance failed.
    public let seq: Int
    /// The thrown error's description (identifiers/errno only — never payload/transcript content).
    public let message: String

    public init(sessionID: String, streamID: String, seq: Int, message: String) {
        self.sessionID = sessionID
        self.streamID = streamID
        self.seq = seq
        self.message = message
    }
}

/// Errors `NormaSessionClient` throws.
public enum SessionClientError: Error, Equatable {
    /// `handshake` waited past its first-frame read deadline without a `helloAck` (a silent conn).
    case handshakeTimeout
    /// The first frame back was not a `helloAck`, or its `ServerHello` payload was undecodable.
    case handshakeFailed(String)
    /// The connection closed (inbound stream ended) with a request still awaiting its response.
    case connectionClosed
    /// The host answered a request with a JSON-RPC error.
    case rpcError(code: Int, message: String)
    /// A response arrived that could not be parsed as JSON-RPC.
    case malformedResponse
}

// MARK: - JSONValue accessors

/// `NormaProtocol`'s `SessionEvent.JSONValue` ships no ergonomic accessors (unlike
/// `NormaKit.JSONValue`); `NormaSessionKit` adds the few it needs to read RPC results/params
/// without a full typed decode.
extension SessionEvent.JSONValue {
    public subscript(key: String) -> SessionEvent.JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var intValue: Int? { if case .number(let n) = self, n == n.rounded() { return Int(n) }; return nil }
    public var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var arrayValue: [SessionEvent.JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: [String: SessionEvent.JSONValue]? { if case .object(let o) = self { return o }; return nil }
}
