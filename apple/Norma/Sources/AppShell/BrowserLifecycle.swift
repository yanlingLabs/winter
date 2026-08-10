import Foundation

struct BrowserSignals: Equatable {
    var attachedHere: Bool
    var attachedElsewhere: Bool
    var working: Bool
    var archived: Bool
    var stopImmediately: Bool = false
}

struct BrowserTabState: Equatable {
    var tabId: String
    var url: String?
    var isShown: Bool
}

enum BrowserAction: Equatable {
    case create(tabId: String, url: String?)
    case stop(tabId: String)
    case attachViewport(tabId: String)
    case detachViewport(tabId: String)
    case scheduleStop(sessionId: String, at: Date)
    case cancelScheduledStop(sessionId: String)
}

struct BrowserLifecycleEngine {
    static let stopLinger: TimeInterval = 300
    static let maxLive = 8

    // TDD stub — Task 2 Step 1. Replaced by the real decision in Step 2.
    static func plan(sessions: [String: BrowserSignals],
                     tabs: [String: [BrowserTabState]],
                     live: Set<String>,
                     viewport: String?,
                     pendingStops: [String: Date],
                     lruOrder: [String],
                     now: Date) -> [BrowserAction] {
        []
    }
}
