import Foundation

/// What one feed reports to a hang report (`HangWatchdog`).
struct FeedDiagnostics: Equatable, Sendable {
    var sessionId: String?
    var turnLive: Bool
    /// Events waiting to be folded: on the client's stream, in the chunk queue, in a held replay, in the owner's queues.
    var backlog: Int
    /// How long the oldest event still on the client's stream has waited, in seconds.
    var oldestEventAge: TimeInterval
}

/// The live feeds, weakly: every `SessionFeed` registers itself, so a report can say how many sessions are attached,
/// whether any turn is live per the client, and how far behind the reducer is — without anything holding a feed.
@MainActor
final class FeedRegistry {
    static let shared = FeedRegistry()

    private struct Weak { weak var feed: SessionFeed? }
    private var feeds: [Weak] = []

    func register(_ feed: SessionFeed) {
        feeds.removeAll { $0.feed == nil }
        feeds.append(Weak(feed: feed))
    }

    var snapshot: [FeedDiagnostics] {
        feeds.removeAll { $0.feed == nil }
        return feeds.compactMap { $0.feed?.diagnostics }
    }
}
