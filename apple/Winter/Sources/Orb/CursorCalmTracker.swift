import Foundation
import CoreGraphics

/// PURE: tracks whether the cursor has been "calm" (no fast movement) recently — gates the
/// answer-arrival auto-expand (wave-3 gate item 2b): a reply must not visually snap the field
/// open out from under a cursor that's mid-flick. Sibling to `FastFlick.swift`'s
/// `shouldCollapseFastFlick` (same per-sample speed math, `OrbFollower` computes both from the
/// same `displacement`/`dt` sample), but a DIFFERENT threshold/purpose: fast-flick collapses
/// immediately on a single fast sample; this instead remembers the LAST fast sample and requires
/// a sustained quiet window afterward before calling the cursor "calm" again.
struct CursorCalmTracker {
    /// Speed (points/second) at or below which a sample does NOT count as "fast."
    static let speedThreshold: CGFloat = 300
    /// How long the cursor must have stayed under `speedThreshold` before it's "calm" again.
    static let calmDuration: TimeInterval = 0.4

    /// The last time a sample cleared `speedThreshold`. `nil` until the first fast sample ever
    /// recorded — a cursor that has NEVER moved fast is calm from the very start.
    private(set) var lastFastCursorAt: TimeInterval?

    /// Call on every raw cursor sample (mirrors `OrbFollower`'s existing per-sample speed
    /// computation). Only fast samples move the tracked timestamp — a slow/still sample never
    /// resets it early.
    mutating func record(speed: CGFloat, at time: TimeInterval) {
        if speed > Self.speedThreshold {
            lastFastCursorAt = time
        }
    }

    /// True when either the cursor has never been fast, or enough quiet time
    /// (`calmDuration`) has elapsed since the last fast sample.
    func isCalm(at time: TimeInterval) -> Bool {
        guard let lastFastCursorAt else { return true }
        return time - lastFastCursorAt > Self.calmDuration
    }
}
