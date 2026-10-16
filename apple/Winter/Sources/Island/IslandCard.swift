import Foundation
import WinterKit
import WinterProtocol

// The Winter island (`docs/claude/island.md`): what it shows. One `IslandCard` per approval, question, URL elicitation
// or view request still pending in any session, built from the daemon's `island.pending` (`WinterClient.islandPending`).
// Pure — the routing, the queue and the views read these and nothing else.

/// What a card asks, as the island draws it.
enum IslandCardPayload: Equatable {
    /// A tool approval: the ✕ denies, the ✓ allows once; the card's rule options (`options`) are offered in the
    /// Needs-you list's full card.
    case approval(toolName: String, summary: String, reviewerReason: String?, options: [SessionEvent.ApprovalOption])
    /// AskQuestion / AskUserQuestion: one to four questions.
    case question([SessionEvent.Question])
    /// An MCP server asks the user to open a link.
    case elicitation(serverName: String, message: String, host: String, origin: String)
    /// A VIEW REQUEST: ComputerV2's desktop-switch prompt — "Winter needs your view for a sec on Safari". The card
    /// default-allows at `expiresAt`; ✕ refuses, ✓ switches now (`approval.respond` with the `switch` option).
    case viewRequest(app: String, bundleId: String, reason: String)
}

struct IslandCard: Identifiable, Equatable {
    enum Kind: Equatable {
        case approval, question, elicitation, viewRequest

        /// Approvals and questions compact themselves after `IslandQueue.selfCompactAfter`; a view request keeps its
        /// own countdown (its deadline is the answer), and an elicitation behaves like an approval.
        var selfCompacts: Bool { self != .viewRequest }
    }

    /// Stable across refreshes: the kind, the session an answer goes to, and the card's own id.
    let id: String
    /// `callId` (approval/question) or `elicitationId`.
    let callId: String
    /// The session whose log holds the card (a Dispatch child's own).
    let sessionId: String
    /// Where an answer goes.
    let answerSessionId: String
    let kind: Kind
    let payload: IslandCardPayload
    let facts: IslandSessionFacts
    let hosts: [IslandHost]
    /// Epoch ms; nil when unknown.
    let issuedAt: Int?
    let expiresAt: Int?

    init(callId: String, sessionId: String, answerSessionId: String, kind: Kind, payload: IslandCardPayload,
         facts: IslandSessionFacts = IslandSessionFacts(), hosts: [IslandHost] = [], issuedAt: Int? = nil,
         expiresAt: Int? = nil) {
        self.id = Self.cardId(kind: kind, answerSessionId: answerSessionId, callId: callId)
        self.callId = callId
        self.sessionId = sessionId
        self.answerSessionId = answerSessionId
        self.kind = kind
        self.payload = payload
        self.facts = facts
        self.hosts = hosts
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
    }

    static func cardId(kind: Kind, answerSessionId: String, callId: String) -> String {
        "\(kind)|\(answerSessionId)|\(callId)"
    }

    /// The card's one-line title in a list or a rectangle: the session's title, else what kind of session it is.
    var sessionLabel: String {
        if let title = facts.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        switch facts.mode {
        case "dispatch": return "Dispatch"
        case "chat": return "Chat"
        default: return facts.origin == "dispatch-child" ? "Dispatch task" : "Session"
        }
    }

    /// PURE: the card for one `island.pending` item; nil for an event this island does not show.
    static func from(_ item: IslandPendingItem) -> IslandCard? {
        switch item.event {
        case .approvalRequested(let a):
            if let visit = DesktopVisitCardWords.parse(toolName: a.toolName, summary: a.summary, onTimeout: a.onTimeout,
                                                       optionIds: (a.options ?? []).map(\.id)) {
                return IslandCard(callId: a.callId, sessionId: item.sessionId, answerSessionId: item.answerSessionId,
                                  kind: .viewRequest, payload: .viewRequest(app: visit.app, bundleId: visit.bundleId, reason: visit.reason),
                                  facts: item.session, hosts: item.hosts, issuedAt: a.issuedAt, expiresAt: a.expiresAt)
            }
            return IslandCard(callId: a.callId, sessionId: item.sessionId, answerSessionId: item.answerSessionId,
                              kind: .approval,
                              payload: .approval(toolName: a.toolName, summary: a.summary, reviewerReason: a.reviewerReason,
                                                 options: a.options ?? []),
                              facts: item.session, hosts: item.hosts, issuedAt: a.issuedAt, expiresAt: a.expiresAt)
        case .questionAsked(let q):
            return IslandCard(callId: q.callId, sessionId: item.sessionId, answerSessionId: item.answerSessionId,
                              kind: .question, payload: .question(q.questions), facts: item.session, hosts: item.hosts,
                              issuedAt: q.ts)
        case .elicitationRequested(let e):
            return IslandCard(callId: e.elicitationId, sessionId: item.sessionId, answerSessionId: item.answerSessionId,
                              kind: .elicitation,
                              payload: .elicitation(serverName: e.serverName, message: e.message, host: e.host, origin: e.origin),
                              facts: item.session, hosts: item.hosts, issuedAt: e.issuedAt, expiresAt: e.expiresAt)
        default:
            return nil
        }
    }
}

/// The desktop-switch card's words, read back out of the daemon's own sentence (`desktopVisitCardSummary`,
/// `packages/core/src/computer-use/policy.ts`): "Switch to Safari's desktop for a moment? Safari (com.apple.Safari) —
/// to click in Safari…. Winter brings you back right after; …". The card is told apart by its shape — the ComputerV2
/// tool, a default-allow deadline and the `switch` option — never by its words; the words only fill the pill's line,
/// and anything that does not parse falls back to "the app".
enum DesktopVisitCardWords {
    static let toolName = "ComputerV2"
    static let switchOptionId = "switch"

    struct Words: Equatable {
        let app: String
        let bundleId: String
        let reason: String
    }

    static func isViewRequest(toolName: String, onTimeout: String?, optionIds: [String]) -> Bool {
        toolName == Self.toolName && onTimeout == "allow" && optionIds.contains(switchOptionId)
    }

    /// PURE: nil when the card is not a desktop switch.
    static func parse(toolName: String, summary: String, onTimeout: String?, optionIds: [String]) -> Words? {
        guard isViewRequest(toolName: toolName, onTimeout: onTimeout, optionIds: optionIds) else { return nil }
        let prefix = "Switch to "
        let marker = "'s desktop for a moment? "
        guard summary.hasPrefix(prefix), let markerRange = summary.range(of: marker) else {
            return Words(app: "the app", bundleId: "", reason: "")
        }
        let app = String(summary[summary.index(summary.startIndex, offsetBy: prefix.count)..<markerRange.lowerBound])
        let rest = summary[markerRange.upperBound...]
        // "<app> (<bundle id>) — <reason>. Winter brings you back …"
        var bundleId = ""
        var reason = ""
        let lead = "\(app) ("
        if rest.hasPrefix(lead), let close = rest.range(of: ") — ") {
            bundleId = String(rest[rest.index(rest.startIndex, offsetBy: lead.count)..<close.lowerBound])
            let after = rest[close.upperBound...]
            if let end = after.range(of: ". Winter brings you back", options: .backwards) {
                reason = String(after[..<end.lowerBound])
            } else {
                reason = String(after)
            }
        }
        return Words(app: app.isEmpty ? "the app" : app, bundleId: bundleId, reason: reason)
    }
}
