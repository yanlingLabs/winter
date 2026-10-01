import Foundation

/// v1 port (Gesture/DraftCache.swift), simplified to text-only: no pasted images, no
/// screenshot-dismissed flag, no selected-text context — 2c's field is text-only (D7).
/// Expiry widened from v1's 5s "still mid-gesture" window to 900s (15 min): here the
/// cache exists to survive an orb collapse/expand round trip, not a live drag gesture.
///
/// Not `@MainActor`-isolated on purpose: it's pure enough to unit-test directly from a
/// plain (non-actor, non-async) XCTestCase, and its two real callers (`GlassRootView`, the
/// dispatch pill's controller) already run on the main actor.
///
/// The expiry is per instance: the orb keeps the fixed 15 minutes (`expiry`), while the dispatch
/// pill passes `nil` — its controller owns the countdown (`DispatchPillDraftExpiry`), which starts
/// only when the pill is put away, so a stash made while the pill sits compact on screen must
/// never age out underneath it.
final class DraftCache {
    static let expiry: TimeInterval = 900

    /// Injectable clock for the base case; `nowOverride`, when set, wins (lets tests
    /// swap in a later "now" mid-test without rebuilding the cache, per the expiry test).
    private let now: () -> Date
    var nowOverride: (() -> Date)?
    /// How old a stash may be before `restore()` drops it; `nil` = never by age (the caller
    /// clears it explicitly instead).
    private let maxAge: TimeInterval?

    private var cachedText = ""
    private var timestamp: Date?

    init(now: @escaping () -> Date = Date.init, expiry: TimeInterval? = DraftCache.expiry) {
        self.now = now
        self.maxAge = expiry
    }

    private var currentDate: Date {
        nowOverride?() ?? now()
    }

    /// Ignores blank (whitespace/newline-only) text — nothing worth restoring later.
    func stash(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            clear()
            return
        }
        cachedText = text
        timestamp = currentDate
    }

    /// nil when nothing was stashed, or the stash is older than this cache's expiry.
    func restore() -> String? {
        guard let timestamp else {
            clear()
            return nil
        }
        if let maxAge, currentDate.timeIntervalSince(timestamp) > maxAge {
            clear()
            return nil
        }
        return cachedText
    }

    func clear() {
        cachedText = ""
        timestamp = nil
    }
}
