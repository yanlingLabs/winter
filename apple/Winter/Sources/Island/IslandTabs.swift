import Foundation

// The Winter island's tabs (`docs/claude/island.md`). The open island shows one tab at a time; a TWO-FINGER horizontal
// swipe while the pointer is over it moves between them (`TrackpadHorizontalSwipeRecognizer`, the Dispatch pill's), with
// small dots for where you are. Phase 1 registers ONE tab, Needs you; the registry is open for the rest (phase 2:
// Sessions, Usage and limits, Devices, Shelf, Watches) — a tab is added by naming it here and giving the island view
// a body for its id.

struct IslandTab: Identifiable, Equatable {
    let id: String
    let title: String
    /// SF Symbol for its dot's tooltip and the strip's icon.
    let symbol: String
}

enum IslandTabRegistry {
    static let needsYou = IslandTab(id: "needs-you", title: "Needs you", symbol: "hand.raised.fill")
    /// Phase 2: every armed computer-use watch (`wakeWhen`), with Stop.
    static let watches = IslandTab(id: "watches", title: "Watches", symbol: "eye")

    /// The tabs this build shows, in swipe order. Phase 2 adds `sessions`, `usage`, `devices`, `shelf`, `watches`.
    static let tabs: [IslandTab] = [needsYou, watches]
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
