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

// MARK: - The island's tabs (phase 2): `island.hosts` and `island.usage`

/// One plan window the runtime reported (`island.usage`'s `windows`): its kind (`five_hour`, `seven_day`, …), status
/// (`allowed`, `allowed_warning`, `rejected`), the runtime's utilization number, its reset and when it was reported.
public struct IslandUsageWindow: Sendable, Equatable {
    public let rateLimitType: String?
    public let status: String
    public let utilization: Double?
    /// Epoch ms.
    public let resetsAt: Double?
    public let at: Double
    public let sessionId: String
    /// The provider the reporting session's model names (`codex-oauth`, …), when known.
    public let provider: String?

    public init(rateLimitType: String?, status: String, utilization: Double? = nil, resetsAt: Double? = nil, at: Double,
                sessionId: String, provider: String? = nil) {
        self.provider = provider
        self.rateLimitType = rateLimitType
        self.status = status
        self.utilization = utilization
        self.resetsAt = resetsAt
        self.at = at
        self.sessionId = sessionId
    }
}

/// `island.usage`: what the daemon already knows about usage and limits (`docs/claude/island.md`).
public struct IslandUsageSnapshot: Sendable, Equatable {
    public struct Subscription: Sendable, Equatable {
        public let status: String?
        public let rateLimitType: String?
        public let utilization: Double?
        public let resetsAt: Double?
        public let at: Double
        public init(status: String?, rateLimitType: String? = nil, utilization: Double? = nil, resetsAt: Double? = nil, at: Double) {
            self.status = status
            self.rateLimitType = rateLimitType
            self.utilization = utilization
            self.resetsAt = resetsAt
            self.at = at
        }
    }

    /// Winter's background jobs (titles, reviewer, dreamer, cleaner, research): `limited` until `resumeAt`, and the
    /// tokens they used since the daemon started.
    public struct Background: Sendable, Equatable {
        public let limited: Bool
        public let resumeAt: Double?
        public let inputTokens: Int
        public let outputTokens: Int
        public init(limited: Bool, resumeAt: Double? = nil, inputTokens: Int, outputTokens: Int) {
            self.limited = limited
            self.resumeAt = resumeAt
            self.inputTokens = inputTokens
            self.outputTokens = outputTokens
        }
    }

    /// One session's counts since the daemon started (summed `turn_completed`), its last measured context size and its
    /// model's context window when the catalog knows it.
    public struct Session: Sendable, Equatable {
        public let sessionId: String
        public let turns: Int
        public let inputTokens: Int
        public let outputTokens: Int
        public let contextTokens: Int?
        public let contextWindow: Int?
        public let model: String?
        public init(sessionId: String, turns: Int, inputTokens: Int, outputTokens: Int, contextTokens: Int? = nil,
                    contextWindow: Int? = nil, model: String? = nil) {
            self.sessionId = sessionId
            self.turns = turns
            self.inputTokens = inputTokens
            self.outputTokens = outputTokens
            self.contextTokens = contextTokens
            self.contextWindow = contextWindow
            self.model = model
        }
    }

    public let windows: [IslandUsageWindow]
    public let subscription: Subscription?
    public let background: Background
    public let session: Session?

    public init(windows: [IslandUsageWindow], subscription: Subscription? = nil, background: Background, session: Session? = nil) {
        self.windows = windows
        self.subscription = subscription
        self.background = background
        self.session = session
    }
}

extension WinterClient {
    /// `island.hosts`: who is attached to each session with at least one attachment (a terminal's tty included).
    public func islandHosts() async throws -> [String: [IslandHost]] {
        Self.decodeIslandHosts(try await request("island.hosts", params: nil))
    }

    /// `island.usage`: plan windows, the background jobs' quota and (with `sessionId`) that session's counts.
    public func islandUsage(sessionId: String?) async throws -> IslandUsageSnapshot {
        let params: JSONValue? = sessionId.map { .object(["sessionId": .string($0)]) }
        return Self.decodeIslandUsage(try await request("island.usage", params: params))
    }

    /// PURE.
    public static func decodeIslandHosts(_ r: JSONValue) -> [String: [IslandHost]] {
        var out: [String: [IslandHost]] = [:]
        for s in r["sessions"]?.arrayValue ?? [] {
            guard let sid = s["sessionId"]?.stringValue else { continue }
            out[sid] = (s["hosts"]?.arrayValue ?? []).compactMap { h in
                guard let name = h["clientName"]?.stringValue else { return nil }
                return IslandHost(clientName: name, role: h["role"]?.stringValue, tty: h["tty"]?.stringValue)
            }
        }
        return out
    }

    /// PURE.
    public static func decodeIslandUsage(_ r: JSONValue) -> IslandUsageSnapshot {
        func number(_ v: JSONValue?) -> Double? { if case .number(let n)? = v { return n }; return nil }
        let windows = (r["windows"]?.arrayValue ?? []).compactMap { w -> IslandUsageWindow? in
            guard let status = w["status"]?.stringValue else { return nil }
            return IslandUsageWindow(rateLimitType: w["rateLimitType"]?.stringValue, status: status,
                                     utilization: number(w["utilization"]), resetsAt: number(w["resetsAt"]),
                                     at: number(w["at"]) ?? 0, sessionId: w["sessionId"]?.stringValue ?? "",
                                     provider: w["provider"]?.stringValue)
        }
        let subscription = r["subscription"].flatMap { s -> IslandUsageSnapshot.Subscription? in
            guard case .object = s else { return nil }
            return .init(status: s["status"]?.stringValue, rateLimitType: s["rateLimitType"]?.stringValue,
                         utilization: number(s["utilization"]), resetsAt: number(s["resetsAt"]), at: number(s["at"]) ?? 0)
        }
        let b = r["background"]
        let background = IslandUsageSnapshot.Background(limited: b?["kind"]?.stringValue == "limited",
                                                        resumeAt: number(b?["resumeAt"]),
                                                        inputTokens: Int(number(b?["inputTokens"]) ?? 0),
                                                        outputTokens: Int(number(b?["outputTokens"]) ?? 0))
        let session = r["session"].flatMap { s -> IslandUsageSnapshot.Session? in
            guard let sid = s["sessionId"]?.stringValue else { return nil }
            return .init(sessionId: sid, turns: Int(number(s["turns"]) ?? 0), inputTokens: Int(number(s["inputTokens"]) ?? 0),
                         outputTokens: Int(number(s["outputTokens"]) ?? 0), contextTokens: number(s["contextTokens"]).map { Int($0) },
                         contextWindow: number(s["contextWindow"]).map { Int($0) }, model: s["model"]?.stringValue)
        }
        return IslandUsageSnapshot(windows: windows, subscription: subscription, background: background, session: session)
    }
}
