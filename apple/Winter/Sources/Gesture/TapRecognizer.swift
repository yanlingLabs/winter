import Foundation
import simd

struct TapConfig {
    var minDuration = 0.025
    var maxDuration = 0.18
    var maxFingerTravel: Float = 0.018
    var maxCentroidTravel: Float = 0.012
    // v1-tuned: >= 2 four-finger frames required so a single-callback-tick
    // blip (palm brush set-down/lift within one reporting interval) can
    // never fire as a tap.
    var minFourFingerSamples = 2
    static let v1 = TapConfig()
}

struct TouchSample: Equatable {
    let id: Int
    let pos: SIMD2<Float>
}

/// Pure 4-finger-tap recognizer — v1 MultitouchTrigger's callback logic (lines 199-287)
/// extracted so D5 (Spaces-swipe discrimination) is unit-testable and gate-tunable.
struct TapRecognizer {
    private let config: TapConfig
    private var touchingSince = 0.0
    private var armed = false
    private var invalidated = false
    private var sampleCount = 0
    private var maxFingerTravel: Float = 0
    private var maxCentroidTravel: Float = 0
    private var anchorCentroid = SIMD2<Float>(repeating: 0)
    private var anchors: [Int: SIMD2<Float>] = [:]

    init(config: TapConfig = .v1) { self.config = config }

    /// Feed one frame of currently-touching contacts. Returns true exactly when the tap fires.
    mutating func ingest(active: [TouchSample], at time: Double) -> Bool {
        if active.isEmpty {
            var fired = false
            if armed, !invalidated {
                let duration = time - touchingSince
                let isTapDuration = duration >= config.minDuration && duration < config.maxDuration
                let stayedStill = maxFingerTravel <= config.maxFingerTravel && maxCentroidTravel <= config.maxCentroidTravel
                fired = isTapDuration && stayedStill && sampleCount >= config.minFourFingerSamples
            }
            reset() // v1's latch fix: ALWAYS reset on all-lift
            return fired
        }

        if active.count > 4 { invalidated = true }

        if !armed {
            guard active.count == 4 else { return false } // first touching frame must be exactly 4
            armed = true
            touchingSince = time
            sampleCount = 1
            anchors = Dictionary(uniqueKeysWithValues: active.map { ($0.id, $0.pos) })
            guard anchors.count == 4 else { invalidated = true; return false }
            anchorCentroid = centroid(active.map(\.pos))
            return false
        }

        guard active.count == 4 else { return false }
        let current = Dictionary(uniqueKeysWithValues: active.map { ($0.id, $0.pos) })
        guard current.count == 4, Set(current.keys) == Set(anchors.keys) else {
            invalidated = true
            return false
        }
        sampleCount += 1
        maxCentroidTravel = max(maxCentroidTravel, simd_distance(anchorCentroid, centroid(active.map(\.pos))))
        for (id, pos) in current {
            guard let anchor = anchors[id] else { invalidated = true; return false }
            maxFingerTravel = max(maxFingerTravel, simd_distance(anchor, pos))
        }
        if maxFingerTravel > config.maxFingerTravel || maxCentroidTravel > config.maxCentroidTravel {
            invalidated = true
        }
        return false
    }

    private mutating func reset() {
        armed = false
        invalidated = false
        sampleCount = 0
        maxFingerTravel = 0
        maxCentroidTravel = 0
        anchors.removeAll()
        anchorCentroid = SIMD2<Float>(repeating: 0)
    }

    private func centroid(_ positions: [SIMD2<Float>]) -> SIMD2<Float> {
        guard !positions.isEmpty else { return SIMD2<Float>(repeating: 0) }
        return positions.reduce(SIMD2<Float>(repeating: 0), +) / Float(positions.count)
    }
}
