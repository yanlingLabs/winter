import Foundation

/// 2c wave 2 task 4: which way a 2-finger accepted swipe moves through exchange history.
/// `.older` is v1's `.previousTrack`-shaped direction (MusicDynamicIslandPlugin/MediaDynamic
/// IslandPlugin's `.left → previousTrack()`); `.newer` is `.right → nextTrack()`'s shape.
enum ExchangeNavDirection {
    case older
    case newer
}

/// Wave-5 gate item 4 (user directive, addendum — SUPERSEDES the v1 music-player convention
/// `ExchangeNavDirection`'s own doc above describes): the physical→logical swipe mapping flips
/// from "previous/next track" to "page-flip / browser-back" — fingers moving RIGHT (a physical
/// `.right` swipe) means BACK/older, fingers moving LEFT (`.left`) means FORWARD/newer. Extracted
/// as its own pure mapping (rather than inlined at the `OrbWindowController.handleAcceptedSwipe`
/// call site) so the convention itself — independent of the composer-hop decision below — is
/// directly table-tested (`ExchangeNavigationTests`).
func exchangeNavDirection(for swipe: TrackpadHorizontalSwipeDirection) -> ExchangeNavDirection {
    swipe == .right ? .older : .newer
}

/// Pure index arithmetic for exchange-history navigation — no dependency on `SessionModel` or
/// `OrbWindowController`, table-tested in isolation (`ExchangeNavigationTests`).
///
/// `nil` index means "live/draft view" — the newest position past all history (mirrors
/// `FieldView`'s existing `exchanges.last` / live-streaming display: no historical exchange is
/// pinned). `.older` from `nil` jumps to the last historical index (`count - 1`); `.older` from
/// an index clamps at `0` (can't go past the oldest exchange). `.newer` from `nil` stays `nil`
/// (already at the newest position); `.newer` from an index either advances or, once past the
/// last historical index, lands back on `nil` (returns to live) rather than wrapping or clamping.
func navigateExchange(_ index: Int?, direction: ExchangeNavDirection, count: Int) -> Int? {
    guard count > 0 else { return nil }
    switch direction {
    case .older:
        switch index {
        case nil: return count - 1
        case let i?: return max(0, i - 1)
        }
    case .newer:
        switch index {
        case nil: return nil
        case let i?: return i + 1 >= count ? nil : i + 1
        }
    }
}

/// Wave-5 gate item 4: the field's shell has one more position beyond the live/newest response
/// view — the composer — reachable only by continuing to swipe "newer" past `nil` (a swipe that
/// used to be a silent no-op, `navigateExchange(nil, direction: .newer, ...) == nil`), and
/// leavable only by swiping "older" back, and only when there's a reply to return TO (otherwise
/// the composer already IS the home state — there's nothing behind it to reveal).
enum FieldSwipeTarget: Equatable {
    /// Pin (or stay pinned to) this exchange index — `nil` is the live/most-recent view, exactly
    /// `OrbWindowController.exchangeIndex`'s existing convention.
    case exchange(Int?)
    /// Reveal the composer (`FieldStateAdapter.showingDraft = true`).
    case composer
}

/// Pure decision for one accepted 2-finger swipe against the field's FULL position space —
/// history ⟷ live response ⟷ composer — table-tested in isolation (`ExchangeNavigationTests`).
/// `showingDraft`/`hasReply` mirror `FieldStateAdapter.showingDraft` / the shell's own
/// `hasReply` check; see `OrbWindowController.handleAcceptedSwipe` for how this is wired to the
/// real adapter/session. Returns `nil` when the swipe doesn't move anything (already at an edge
/// with nowhere further to go) — callers must not fire the accepted-swipe haptic for a `nil`.
func navigateFieldSwipe(
    exchangeIndex: Int?,
    showingDraft: Bool,
    hasReply: Bool,
    direction: ExchangeNavDirection,
    count: Int
) -> FieldSwipeTarget? {
    if showingDraft {
        // Currently past the live view, in the composer — the only way back is "older", and only
        // if there's actually a reply waiting to be revealed (else there's nothing to hop to).
        guard direction == .older, hasReply else { return nil }
        return .exchange(exchangeIndex)
    }
    let next = navigateExchange(exchangeIndex, direction: direction, count: count)
    if next != exchangeIndex {
        return .exchange(next)
    }
    // No movement within history — the swipe still accepts if it's "newer" from the live (nil)
    // position, continuing past the newest reply into the composer.
    if direction == .newer, exchangeIndex == nil {
        return .composer
    }
    return nil
}
