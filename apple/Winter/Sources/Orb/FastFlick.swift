import Foundation

/// PURE: v1's fast-flick collapse trigger (GlassFieldWindow.swift:1584-1597) — a raw cursor
/// sample whose dt-normalized speed OR raw displacement clears either threshold means the user
/// flicked the cursor away fast enough that the field should start collapsing immediately,
/// rather than waiting for the tracking spring to lazily catch up (which would leave a "ghost
/// circle" hanging where the field used to be).
func shouldCollapseFastFlick(speed: CGFloat, displacement: CGFloat) -> Bool {
    speed > 900 || displacement > 200
}
