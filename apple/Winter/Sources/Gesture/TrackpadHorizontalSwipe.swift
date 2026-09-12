import AppKit
import QuartzCore

/// Ported from v1 Winter/Gesture/TrackpadHorizontalSwipe.swift:1-317 — the HORIZONTAL swipe
/// recognizer core only. The vertical recognizer (`TrackpadVerticalSwipeRecognizer`) and every
/// DynamicIsland-specific caller (`ScrollRedirector`, `DynamicIslandController`'s own copy,
/// `DynamicIslandPlugin.onHorizontalSwipe`) are NOT ported — 2c wave 2 task 4 has exactly one
/// consumer, `OrbWindowController`'s field-surface scroll monitor, driving exchange-history
/// navigation. `TrackpadSwipeHaptics` (`Gesture/TrackpadHaptics.swift`) was already ported
/// separately (v1 lines 318-524) — `performAcceptedFeedback` below calls it, does not duplicate it.

/// Direction of an accepted 2-finger trackpad horizontal swipe.
enum TrackpadHorizontalSwipeDirection: Equatable {
    case left
    case right
}

/// v1 parity (`TrackpadScrollEventPhase`, lines 44-64): normalizes `NSEvent.Phase`'s option-set
/// encoding into the four states the recognizer's phase machine actually branches on. The
/// CGEvent-field initializer (v1 lines 543-557, used by a raw CGEventTap elsewhere in v1) is
/// dropped — the only producer here is `NSEvent.phase`/`momentumPhase` from a local monitor.
enum TrackpadScrollEventPhase: Equatable {
    case none
    case began
    case changed
    case ended
    case cancelled
    case mayBegin

    var isTerminal: Bool {
        self == .ended || self == .cancelled
    }

    var isActiveMomentum: Bool {
        switch self {
        case .began, .changed, .mayBegin:
            return true
        case .none, .ended, .cancelled:
            return false
        }
    }
}

extension TrackpadScrollEventPhase {
    init(_ phase: NSEvent.Phase) {
        if phase.contains(.ended) {
            self = .ended
        } else if phase.contains(.cancelled) {
            self = .cancelled
        } else if phase.contains(.began) {
            self = .began
        } else if phase.contains(.changed) {
            self = .changed
        } else if phase.contains(.mayBegin) {
            self = .mayBegin
        } else {
            self = .none
        }
    }
}

/// Recognizer output for one scroll-wheel event handed to `TrackpadHorizontalSwipeRecognizer`.
///
/// v1's struct (`consumesScroll: Bool`, `direction: TrackpadHorizontalSwipeDirection?`) is
/// reshaped into this 3-case `Result` — `.ignored` / `.tracking` / `.swiped(direction)` — one
/// case per distinct meaning v1 encoded across those two fields:
/// - `.ignored` — NOT a horizontal-swipe sample (not a scroll event, imprecise deltas, or
///   vertical-dominant, e.g. the inline response's own `ScrollView`) — callers MUST let the
///   event fall through untouched (v1's `consumesScroll == false`).
/// - `.tracking` — a horizontal drag is in progress but hasn't crossed the trigger threshold
///   yet — still consume it (v1's `consumesScroll == true, direction == nil`) so an in-flight
///   horizontal gesture never leaks a stray sample to whatever sits underneath.
/// - `.swiped(direction)` — fires exactly once per gesture, the instant
///   `Configuration.threshold` is crossed (v1's `consumesScroll == true, direction != nil`).
enum TrackpadHorizontalSwipeResult: Equatable {
    case ignored
    case tracking
    case swiped(TrackpadHorizontalSwipeDirection)

    /// Whether the caller should swallow this scroll-wheel event (return `nil` from a local
    /// monitor) rather than letting it propagate to whatever view sits under the cursor —
    /// v1's `consumesScroll`, recovered from the case rather than stored alongside it.
    var consumesScroll: Bool {
        if case .ignored = self { return false }
        return true
    }

    /// v1 parity (`performAcceptedFeedback(if:)`): runs `handler` only for `.swiped`, and fires
    /// the accepted-swipe haptic (`TrackpadSwipeHaptics.performAcceptedSwipe()`) only when
    /// `handler` itself reports the swipe actually did something — here, that navigation moved
    /// the exchange index. A threshold crossing that doesn't move anything (e.g. already at the
    /// oldest/newest exchange) stays silent, matching D6's "accepted swipe" haptic contract.
    @discardableResult
    func performAcceptedFeedback(if handler: (TrackpadHorizontalSwipeDirection) -> Bool) -> Bool {
        guard case .swiped(let direction) = self, handler(direction) else { return false }
        TrackpadSwipeHaptics.performAcceptedSwipe()
        return true
    }
}

/// Ported from v1 Winter/Gesture/TrackpadHorizontalSwipe.swift:66-190
/// (`TrackpadHorizontalSwipeRecognizer`) — thresholds, phase discipline, and accumulation logic
/// UNCHANGED. Only the return type changed shape (see `TrackpadHorizontalSwipeResult` above);
/// every branch below maps 1:1 onto its v1 counterpart's `(consumesScroll, direction)` pair.
final class TrackpadHorizontalSwipeRecognizer {
    struct Configuration {
        var threshold: CGFloat = 72
        var minimumDelta: CGFloat = 1.5
        var horizontalDominanceRatio: CGFloat = 1.32
        var idleResetInterval: CFTimeInterval = 0.38
        var triggerCooldown: CFTimeInterval = 0.16
        var requiresPreciseDeltas = true
        var compensatesForSystemScrollDirection = true

        static let `default` = Configuration()
    }

    private let configuration: Configuration
    private var accumulatedX: CGFloat = 0
    private var accumulatedY: CGFloat = 0
    private var isTrackingHorizontal = false
    private var didTriggerForCurrentGesture = false
    private var lastEventTime: CFTimeInterval = 0
    private var lastTriggerTime: CFTimeInterval = -Double.greatestFiniteMagnitude

    init(configuration: Configuration = .default) {
        self.configuration = configuration
    }

    func reset() {
        accumulatedX = 0
        accumulatedY = 0
        isTrackingHorizontal = false
        didTriggerForCurrentGesture = false
        lastEventTime = 0
    }

    func handle(_ event: NSEvent) -> TrackpadHorizontalSwipeResult {
        guard event.type == .scrollWheel else { return .ignored }

        var deltaX = event.scrollingDeltaX
        var deltaY = event.scrollingDeltaY
        if configuration.compensatesForSystemScrollDirection,
           event.isDirectionInvertedFromDevice {
            deltaX *= -1
            deltaY *= -1
        }

        return handle(
            deltaX: deltaX,
            deltaY: deltaY,
            phase: TrackpadScrollEventPhase(event.phase),
            momentumPhase: TrackpadScrollEventPhase(event.momentumPhase),
            isPrecise: event.hasPreciseScrollingDeltas,
            timestamp: event.timestamp
        )
    }

    func handle(
        deltaX: CGFloat,
        deltaY: CGFloat,
        phase: TrackpadScrollEventPhase,
        momentumPhase: TrackpadScrollEventPhase,
        isPrecise: Bool = true,
        timestamp: CFTimeInterval = CACurrentMediaTime()
    ) -> TrackpadHorizontalSwipeResult {
        let wasTracking = isTrackingHorizontal || didTriggerForCurrentGesture

        if phase.isTerminal || momentumPhase.isTerminal {
            reset()
            return wasTracking ? .tracking : .ignored
        }

        if momentumPhase.isActiveMomentum {
            return wasTracking ? .tracking : .ignored
        }

        if phase == .began {
            reset()
        } else if lastEventTime > 0,
                  timestamp - lastEventTime > configuration.idleResetInterval {
            reset()
        }
        lastEventTime = timestamp

        guard !configuration.requiresPreciseDeltas || isPrecise else {
            return .ignored
        }

        let absX = abs(deltaX)
        let absY = abs(deltaY)
        guard absX >= configuration.minimumDelta || absY >= configuration.minimumDelta else {
            return wasTracking ? .tracking : .ignored
        }

        let isHorizontalSample = absX >= configuration.minimumDelta &&
            absX > absY * configuration.horizontalDominanceRatio

        if isHorizontalSample {
            isTrackingHorizontal = true
        } else if !didTriggerForCurrentGesture,
                  absY >= configuration.minimumDelta,
                  absY > absX * configuration.horizontalDominanceRatio {
            // Wave-8 gate fix (item 2 root cause): `isTrackingHorizontal` used to be sticky —
            // once ANY single sample tipped past the dominance ratio, every later sample of the
            // SAME physical gesture was accumulated/consumed (`.tracking`, `consumesScroll ==
            // true`) even if the gesture then settled into an obviously vertical drag, because
            // nothing ever set it back to `false` short of `.began`/idle-timeout/a terminal
            // phase. Real two-finger gesture onset is noisy — the first sample or two of a
            // perfectly ordinary VERTICAL scroll can easily tip `absX > absY *
            // horizontalDominanceRatio` for one event before the user's hand settles — so a
            // single noisy onset sample silently swallowed the user's entire vertical scroll
            // attempt, starving the inline reply's ScrollView of every subsequent scroll-wheel
            // event even though neither the overall gesture nor most of its samples were
            // horizontal. Un-latching on a clearly VERTICAL-dominant sample (same ratio, mirrored)
            // lets that settle correct itself — but only before this gesture has actually
            // COMMITTED to a horizontal swipe (`didTriggerForCurrentGesture`); once `.swiped` has
            // fired, later samples (e.g. trailing momentum) must keep being consumed exactly as
            // before, unaffected by this un-latch. `accumulatedX`/`accumulatedY` are cleared too
            // so a later, genuinely horizontal run within the SAME physical gesture starts
            // counting fresh distance/dominance instead of inheriting the aborted lock's partial
            // accumulation.
            isTrackingHorizontal = false
            accumulatedX = 0
            accumulatedY = 0
        }

        guard isTrackingHorizontal else {
            return .ignored
        }

        accumulatedX += deltaX
        accumulatedY += deltaY

        guard !didTriggerForCurrentGesture else {
            return .tracking
        }

        guard abs(accumulatedX) >= configuration.threshold,
              abs(accumulatedX) > abs(accumulatedY) * configuration.horizontalDominanceRatio else {
            return .tracking
        }

        guard timestamp - lastTriggerTime >= configuration.triggerCooldown else {
            didTriggerForCurrentGesture = true
            return .tracking
        }

        didTriggerForCurrentGesture = true
        lastTriggerTime = timestamp
        let direction: TrackpadHorizontalSwipeDirection = accumulatedX < 0 ? .left : .right
        return .swiped(direction)
    }
}
