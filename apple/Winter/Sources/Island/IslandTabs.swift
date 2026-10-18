import AppKit

// The Winter island's tabs (`docs/claude/island.md`). The open island shows one tab at a time; a TWO-FINGER horizontal
// swipe while the pointer is over it moves between them (`TrackpadHorizontalSwipeRecognizer`, the Dispatch pill's), with
// small dots for where you are. Needs you is always first; phase 2 adds Sessions, Shelf, Usage and Devices (and
// Watches, from its own lane), then Servers — a tab is added by naming it here and giving the island view a body for
// its id.

struct IslandTab: Identifiable, Equatable {
    let id: String
    let title: String
    /// SF Symbol for its dot's tooltip and the strip's icon.
    let symbol: String
}

enum IslandTabRegistry {
    static let needsYou = IslandTab(id: "needs-you", title: "Needs you", symbol: "hand.raised.fill")
    static let sessions = IslandTab(id: "sessions", title: "Sessions", symbol: "rectangle.stack")
    static let shelf = IslandTab(id: "shelf", title: "Shelf", symbol: "tray.full")
    static let usage = IslandTab(id: "usage", title: "Usage and limits", symbol: "gauge.with.dots.needle.50percent")
    static let devices = IslandTab(id: "devices", title: "Devices", symbol: "laptopcomputer.and.iphone")
    /// Every armed computer-use watch (`wakeWhen`), with Stop.
    static let watches = IslandTab(id: "watches", title: "Watches", symbol: "eye")
    /// The user's own processes listening on a TCP port — servers they started — with Stop.
    static let servers = IslandTab(id: "servers", title: "Servers", symbol: "server.rack")

    /// The tabs this build shows, in swipe order: Needs you first, then Sessions, Shelf, Usage and limits, Devices,
    /// Watches, Servers.
    static let tabs: [IslandTab] = [needsYou, sessions, shelf, usage, devices, watches, servers]
}

/// Which tab is showing. Pure.
struct IslandTabState: Equatable {
    let tabs: [IslandTab]
    private(set) var selectedIndex = 0

    init(tabs: [IslandTab] = IslandTabRegistry.tabs, selectedIndex: Int = 0) {
        self.tabs = tabs
        self.selectedIndex = tabs.isEmpty ? 0 : min(max(selectedIndex, 0), tabs.count - 1)
    }

    var selected: IslandTab? { tabs.indices.contains(selectedIndex) ? tabs[selectedIndex] : nil }
    /// Dots only when there is somewhere to swipe to.
    var showsDots: Bool { tabs.count > 1 }

    /// A swipe: fingers to the LEFT shows the next tab (the content moves with them), to the RIGHT the previous one.
    /// No wrap. True when the tab changed.
    @discardableResult
    mutating func swipe(_ direction: TrackpadHorizontalSwipeDirection) -> Bool {
        let next = direction == .left ? selectedIndex + 1 : selectedIndex - 1
        guard tabs.indices.contains(next) else { return false }
        selectedIndex = next
        return true
    }

    /// A click on a dot.
    @discardableResult
    mutating func select(_ id: String) -> Bool {
        guard let i = tabs.firstIndex(where: { $0.id == id }), i != selectedIndex else { return false }
        selectedIndex = i
        return true
    }
}

/// Two fingers over the open island do ONE thing per gesture (user 2026-10-17: scrolling a tab's list and swiping tabs
/// must not fight). The gesture's DOMINANT axis decides — once it has travelled `decideAfter` and one axis leads the
/// other by `dominance` (a diagonal start stays undecided) — and holds until the next gesture
/// begins — through its momentum too: vertical → the event goes on to the tab's scroll view (and the swipe recognizer
/// forgets what it saw); horizontal → the swipe recognizer takes it (`TrackpadHorizontalSwipeRecognizer`, which swallows
/// it), and its momentum is swallowed. Undecided, the recognizer sees it (it passes a vertical sample through and holds a
/// horizontal one). A mouse wheel (no gesture phases) always scrolls. Pure — `IslandTabsTests`.
struct IslandScrollAxisLock: Equatable {
    enum Axis: Equatable { case undecided, vertical, horizontal }
    enum Route: Equatable {
        /// To the tab's scroll view.
        case scroll
        /// To the scroll view, the gesture having just been judged vertical: the swipe recognizer resets.
        case scrollAndForgetSwipe
        /// To the swipe recognizer.
        case swipe
        /// Nowhere: a horizontal gesture's momentum (the tab already changed; the list must not move).
        case swallow
    }

    private(set) var axis: Axis = .undecided
    private var travelX: CGFloat = 0
    private var travelY: CGFloat = 0

    /// The travel (points, both axes summed separately) after which the gesture's axis may be decided.
    static let decideAfter: CGFloat = 12
    /// How far one axis must lead the other to decide it: a diagonal stays undecided.
    static let dominance: CGFloat = 1.5

    mutating func route(_ event: NSEvent) -> Route {
        route(deltaX: event.scrollingDeltaX, deltaY: event.scrollingDeltaY, phase: TrackpadScrollEventPhase(event.phase),
              momentumPhase: TrackpadScrollEventPhase(event.momentumPhase))
    }

    mutating func route(deltaX: CGFloat, deltaY: CGFloat, phase: TrackpadScrollEventPhase,
                        momentumPhase: TrackpadScrollEventPhase) -> Route {
        // A plain mouse wheel: no gesture, the list.
        if phase == .none && momentumPhase == .none { return .scroll }
        // The fingers' momentum after they lift: the gesture's own axis; its end closes the gesture.
        if momentumPhase != .none {
            let route: Route = axis == .horizontal ? .swallow : .scroll
            if momentumPhase.isTerminal { reset() }
            return route
        }
        if phase == .mayBegin || phase == .began { reset() }
        if axis == .undecided, !phase.isTerminal {
            travelX += abs(deltaX)
            travelY += abs(deltaY)
            if max(travelX, travelY) >= Self.decideAfter {
                if travelX >= travelY * Self.dominance {
                    axis = .horizontal
                } else if travelY >= travelX * Self.dominance {
                    axis = .vertical
                    return .scrollAndForgetSwipe
                }
            }
        }
        switch axis {
        case .vertical: return .scroll
        case .horizontal, .undecided: return .swipe
        }
    }

    /// Whether an event routed to the swipe recognizer goes on to the list: never once the gesture is HORIZONTAL (an
    /// event the recognizer ignores — a vertical turn mid-swipe — is swallowed, so the list never moves under a tab
    /// swipe); otherwise as the recognizer says.
    func passesOn(_ result: TrackpadHorizontalSwipeResult) -> Bool {
        axis == .horizontal ? false : !result.consumesScroll
    }

    private mutating func reset() {
        axis = .undecided
        travelX = 0
        travelY = 0
    }
}
