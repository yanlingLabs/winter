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

/// One page of `session.history`: a paged, allowlisted, byte-budgeted read of
/// past events, decoded OPAQUELY (`SessionEnvelope.json`), never through the strict `SessionEvent`
/// enum — so an unknown/future event type in a page never throws. `oldestSeq` is `nil` iff
/// `envelopes` is empty; page older by re-requesting with `beforeSeq: oldestSeq` (EXCLUSIVE).
public struct HistoryPage: Sendable, Equatable {
    public let envelopes: [SessionEnvelope]
    public let hasMore: Bool
    public let oldestSeq: Int?

    public init(envelopes: [SessionEnvelope], hasMore: Bool, oldestSeq: Int?) {
        self.envelopes = envelopes
        self.hasMore = hasMore
        self.oldestSeq = oldestSeq
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

/// A phone → host approval answer, in the daemon's REAL `approval.respond` shape (SP3 T4b): the
/// wire params are `{sessionId, callId, approved}` and the reply is `{ok, alreadyResolved}`.
///
/// `callID` is the approval identity AND the compare-and-set token — an approval's callId never
/// mutates or is reused, so the daemon's `ApprovalBroker.resolve()` returning `alreadyResolved:true`
/// for an already-settled callId IS the report's "second answer → AlreadyResolved" semantics. There
/// is deliberately NO numeric `expectedVersion` field: callId + `alreadyResolved` subsumes it.
///
/// `commandID` is the idempotency key (stable across retries); the wire carries it as the top-level
/// `commandId` the daemon dedups on. `expiresAt` (epoch ms, from the `approval_requested` event or
/// an `approval.list` entry) lets the client derive `.expired` from its own clock BEFORE sending —
/// past the deadline, the host has already failed the approval closed (`by:"timeout"`). Optional:
/// `nil` means "never treat as locally expired" (always send and let the host answer).
///
/// `optionId` (SP-approvals T4): which `ApprovalOption` (`NormaProtocol.SessionEvent.
/// ApprovalOption`, carried on the triggering `approval_requested`/`approval.list` entry) the
/// caller chose, by `id` — e.g. "allow_project" to persist a rule alongside this answer. `nil`
/// (the default) means a plain approve/deny with no rule offered/chosen, identical to the wire
/// shape before this field existed.
public struct ApprovalAnswer: Sendable, Equatable {
    public let sessionID: String
    public let callID: String
    public let approved: Bool
    public let commandID: String
    public let expiresAt: Int?
    public let optionId: String?

    public init(sessionID: String, callID: String, approved: Bool, commandID: String, expiresAt: Int? = nil, optionId: String? = nil) {
        self.sessionID = sessionID
        self.callID = callID
        self.approved = approved
        self.commandID = commandID
        self.expiresAt = expiresAt
        self.optionId = optionId
    }
}

/// Surfaced on `NormaSessionClient.gaps` when a stream's held-live buffer overflows — a replay
/// batch that can no longer complete, i.e. the client is genuinely too far behind to catch up
/// in-stream. The consumer (T8's iOS Code-mode model) reacts by re-handshaking with a snapshot
/// resume for `(sessionID, streamID)`; the client stops applying that stream's events until then.
/// NOT fired for benign forward seq jumps (T5 conformance fix): the gateway filters harness
/// bookkeeping events that still consume daemon seqs, so holes between received content seqs are
/// normal on the reliable, ordered transport — see `NormaSessionClient.applyEvent`'s contract
/// comment. Real loss/staleness is handled at the handshake via the `.snapshotRequired` verdict.
public struct GapSignal: Sendable, Equatable {
    public let sessionID: String
    public let streamID: String
    /// The seq the client next expected (`cursor + 1`) at the overflow point — diagnostics.
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
    /// The Mac REFUSED the handshake with a structured `HandshakeRejection` (SP3.1 T1) — the host
    /// is reachable and answered, it just won't admit this connection. `code` is a
    /// `HandshakeRejectionCode` raw value: `not_paired`/`revoked`/`stale_epoch` mean "re-pair
    /// required" (the app's honest `.revoked` state), `daemon_unavailable`/`protocol` are transient.
    /// Distinct from `connectionClosed`/`handshakeTimeout`, which the app collapses to
    /// `.macUnavailable` — a real revoke was previously unreachable as anything but those.
    case handshakeRejected(code: String, message: String)
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
