import Foundation

// The Winter island's ACTIVITY (phase 2, `docs/claude/island.md`): what the island shows besides the cards that wait for
// an answer — the sessions driving computer use now, the turns that just ended with their session idle, and the armed
// computer-use watches. The daemon mirror of `IslandActivityParams`/`IslandActivityResult` and
// `ISLAND_ACTIVITY_CHANGED_NOTIFICATION` (`packages/protocol/src/methods.ts`).

/// A session driving ComputerV2 now: from its turn's first call to the turn's end.
public struct IslandComputerUseItem: Sendable, Equatable {
    public let sessionId: String
    /// Epoch ms: the turn's first ComputerV2 call, and its latest event.
    public let startedAt: Int
    public let lastAt: Int
    /// A script runs right now (false between two scripts of the same turn).
    public let running: Bool
    /// The latest script's `title`, when it sent one.
    public let title: String?
    /// The apps and sites the latest script opens, as names.
    public let apps: [String]
    public let session: IslandSessionFacts
    public let hosts: [IslandHost]

    public init(sessionId: String, startedAt: Int, lastAt: Int, running: Bool, title: String? = nil, apps: [String] = [],
                session: IslandSessionFacts = IslandSessionFacts(), hosts: [IslandHost] = []) {
        self.sessionId = sessionId
        self.startedAt = startedAt
        self.lastAt = lastAt
        self.running = running
        self.title = title
        self.apps = apps
        self.session = session
        self.hosts = hosts
    }
}

/// A turn that ended with its session idle, waiting for the user: its last assistant text, cut short.
public struct IslandResultItem: Sendable, Equatable {
    /// Stable per turn end.
    public let id: String
    public let sessionId: String
    public let summary: String
    /// Epoch ms of the turn's end.
    public let at: Int
    public let session: IslandSessionFacts
    public let hosts: [IslandHost]

    public init(id: String, sessionId: String, summary: String, at: Int, session: IslandSessionFacts = IslandSessionFacts(),
                hosts: [IslandHost] = []) {
        self.id = id
        self.sessionId = sessionId
        self.summary = summary
        self.at = at
        self.session = session
        self.hosts = hosts
    }
}

/// An armed computer-use wake trigger (`wakeWhen`).
public struct IslandWatchItem: Sendable, Equatable {
    public let sessionId: String
    public let wakeId: String
    /// clicked, submitted, navigated, appeared, gone, changed, titled.
    public let condition: String
    public let targetLabel: String
    public let elementLabel: String?
    /// Epoch ms.
    public let armedAt: Int
    public let expiresAt: Int
    public let session: IslandSessionFacts

    public init(sessionId: String, wakeId: String, condition: String, targetLabel: String, elementLabel: String? = nil,
                armedAt: Int, expiresAt: Int, session: IslandSessionFacts = IslandSessionFacts()) {
        self.sessionId = sessionId
        self.wakeId = wakeId
        self.condition = condition
        self.targetLabel = targetLabel
        self.elementLabel = elementLabel
        self.armedAt = armedAt
        self.expiresAt = expiresAt
        self.session = session
    }
}

public struct IslandActivitySnapshot: Sendable, Equatable {
    public let computerUse: [IslandComputerUseItem]
    public let results: [IslandResultItem]
    public let watches: [IslandWatchItem]

    public init(computerUse: [IslandComputerUseItem] = [], results: [IslandResultItem] = [], watches: [IslandWatchItem] = []) {
        self.computerUse = computerUse
        self.results = results
        self.watches = watches
    }

    public static let empty = IslandActivitySnapshot()
}

extension WinterClient {
    /// The daemon's notification (no payload) that the island's activity may have changed — ask `islandActivity()` again.
    public static let islandActivityChangedNotification = "island.activityChanged"

    /// The island's activity across every session. Malformed rows are skipped.
    public func islandActivity() async throws -> IslandActivitySnapshot {
        Self.decodeIslandActivity(try await request("island.activity", params: nil))
    }

    /// PURE: an `island.activity` result.
    public static func decodeIslandActivity(_ v: JSONValue) -> IslandActivitySnapshot {
        func facts(_ s: JSONValue?) -> IslandSessionFacts {
            IslandSessionFacts(mode: s?["mode"]?.stringValue, origin: s?["origin"]?.stringValue,
                               parentSessionId: s?["parentSessionId"]?.stringValue, title: s?["title"]?.stringValue)
        }
        func hosts(_ h: JSONValue?) -> [IslandHost] {
            (h?.arrayValue ?? []).compactMap { h in
                guard let name = h["clientName"]?.stringValue else { return nil }
                return IslandHost(clientName: name, role: h["role"]?.stringValue, tty: h["tty"]?.stringValue)
            }
        }
        let cu = (v["computerUse"]?.arrayValue ?? []).compactMap { c -> IslandComputerUseItem? in
            guard let sid = c["sessionId"]?.stringValue, let started = c["startedAt"]?.intValue else { return nil }
            return IslandComputerUseItem(sessionId: sid, startedAt: started, lastAt: c["lastAt"]?.intValue ?? started,
                                         running: c["running"]?.boolValue ?? false, title: c["title"]?.stringValue,
                                         apps: (c["apps"]?.arrayValue ?? []).compactMap(\.stringValue),
                                         session: facts(c["session"]), hosts: hosts(c["hosts"]))
        }
        let results = (v["results"]?.arrayValue ?? []).compactMap { r -> IslandResultItem? in
            guard let id = r["id"]?.stringValue, let sid = r["sessionId"]?.stringValue, let summary = r["summary"]?.stringValue,
                  let at = r["at"]?.intValue else { return nil }
            return IslandResultItem(id: id, sessionId: sid, summary: summary, at: at, session: facts(r["session"]), hosts: hosts(r["hosts"]))
        }
        let watches = (v["watches"]?.arrayValue ?? []).compactMap { w -> IslandWatchItem? in
            guard let sid = w["sessionId"]?.stringValue, let id = w["wakeId"]?.stringValue,
                  let condition = w["condition"]?.stringValue, let target = w["targetLabel"]?.stringValue,
                  let armed = w["armedAt"]?.intValue, let expires = w["expiresAt"]?.intValue else { return nil }
            return IslandWatchItem(sessionId: sid, wakeId: id, condition: condition, targetLabel: target,
                                   elementLabel: w["elementLabel"]?.stringValue, armedAt: armed, expiresAt: expires,
                                   session: facts(w["session"]))
        }
        return IslandActivitySnapshot(computerUse: cu, results: results, watches: watches)
    }
}
