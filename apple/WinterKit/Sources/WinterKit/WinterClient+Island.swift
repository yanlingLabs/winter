import Foundation
import WinterProtocol

// The Winter island (`docs/claude/island.md`): Winter.app's surface at the camera housing lists every card still
// pending in ANY session. The daemon mirror of `IslandPendingParams`/`IslandPendingResult` and
// `CLIENT_CAPABILITY_ISLAND`/`ISLAND_CHANGED_NOTIFICATION` (`packages/protocol/src/methods.ts`).

/// Who is attached to a session right now: the connection's hello `clientName`, its role, and its terminal (`tty`,
/// for a terminal client — the island's "is that exact terminal window in front?" question).
public struct IslandHost: Sendable, Equatable {
    public let clientName: String
    public let role: String?
    public let tty: String?

    public init(clientName: String, role: String? = nil, tty: String? = nil) {
        self.clientName = clientName
        self.role = role
        self.tty = tty
    }
}

/// The answer session's facts, for routing a card: its mode (nil = code), origin, coordinator and generated title.
public struct IslandSessionFacts: Sendable, Equatable {
    public let mode: String?
    public let origin: String?
    public let parentSessionId: String?
    public let title: String?

    public init(mode: String? = nil, origin: String? = nil, parentSessionId: String? = nil, title: String? = nil) {
        self.mode = mode
        self.origin = origin
        self.parentSessionId = parentSessionId
        self.title = title
    }
}

/// One card still pending somewhere (`island.pending`).
public struct IslandPendingItem: Sendable, Equatable {
    public enum Kind: String, Sendable { case approval, question, elicitation }

    /// The session whose log holds `event` (a Dispatch child's own, for a child's card).
    public let sessionId: String
    /// Where an answer goes (`approval.respond` / `ask_user.respond` / `elicitation.respond`).
    public let answerSessionId: String
    public let kind: Kind
    /// The `approval_requested` / `question_asked` / `elicitation_requested` event.
    public let event: SessionEvent
    public let session: IslandSessionFacts
    public let hosts: [IslandHost]

    public init(sessionId: String, answerSessionId: String, kind: Kind, event: SessionEvent, session: IslandSessionFacts,
                hosts: [IslandHost]) {
        self.sessionId = sessionId
        self.answerSessionId = answerSessionId
        self.kind = kind
        self.event = event
        self.session = session
        self.hosts = hosts
    }
}

extension WinterClient {
    /// `hello.capabilities`' name for "this client shows the Winter island" (`CLIENT_CAPABILITY_ISLAND`). While a client
    /// that advertised it is connected, the daemon does not ask the Winter Computer Use helper to show its own
    /// desktop-switch panel: the island shows the session's card instead.
    public static let capabilityIsland = "island"

    /// The daemon's notification (no payload) that the pending set, or a pending session's hosts, may have changed —
    /// take it with `notifications(method:)` and ask `islandPending()` again.
    public static let islandChangedNotification = "island.changed"

    /// Every card still pending in any session, oldest first. Items whose event this client cannot decode (a newer
    /// daemon) are skipped.
    public func islandPending() async throws -> [IslandPendingItem] {
        let r = try await request("island.pending", params: nil)
        return (r["items"]?.arrayValue ?? []).compactMap(Self.decodeIslandItem)
    }

    /// `island.shown`: this client shows these cards (their `callId`s / `elicitationId`s). The desktop-switch prompt waits
    /// ~2 s for it before asking the Computer Use helper as well, so a connected but hung app never leaves it unseen.
    public func islandShown(ids: [String]) async throws {
        _ = try await request("island.shown", params: .object(["ids": .array(ids.map { .string($0) })]))
    }

    /// PURE: one `island.pending` item, nil when it is malformed or its event unknown.
    public static func decodeIslandItem(_ v: JSONValue) -> IslandPendingItem? {
        guard let sessionId = v["sessionId"]?.stringValue, let answer = v["answerSessionId"]?.stringValue,
              let kind = v["kind"]?.stringValue.flatMap(IslandPendingItem.Kind.init(rawValue:)),
              let eventValue = v["event"],
              let data = try? JSONEncoder().encode(eventValue),
              let event = try? JSONDecoder().decode(SessionEvent.self, from: data) else { return nil }
        let s = v["session"]
        let facts = IslandSessionFacts(mode: s?["mode"]?.stringValue, origin: s?["origin"]?.stringValue,
                                       parentSessionId: s?["parentSessionId"]?.stringValue, title: s?["title"]?.stringValue)
        let hosts = (v["hosts"]?.arrayValue ?? []).compactMap { h -> IslandHost? in
            guard let name = h["clientName"]?.stringValue else { return nil }
            return IslandHost(clientName: name, role: h["role"]?.stringValue, tty: h["tty"]?.stringValue)
        }
        return IslandPendingItem(sessionId: sessionId, answerSessionId: answer, kind: kind, event: event, session: facts,
                                 hosts: hosts)
    }
}
