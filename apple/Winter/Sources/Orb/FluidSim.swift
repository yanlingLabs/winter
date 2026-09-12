import Foundation
import CoreGraphics

/// PURE: liquid physics simulation for the orb bubble — models a contained fluid with tilt
/// (surface rotation from lateral acceleration), excited waves (from motion), and fill level.
/// Semantics: tilt is a damped spring toward the negative of clamped lateral acceleration;
/// waves are excited by motion magnitude and decay exponentially; level chases a target fill.
struct FluidSim: Equatable {
    /// Coefficient for lateral acceleration to tilt target (acceleration.dx * kAccelTilt).
    /// Tuned for ~20-60pt bubble; suggested starting point 0.0006.
    private static let kAccelTilt: Double = 0.0006
    /// Maximum tilt magnitude (radians). Suggested starting point 0.5.
    private static let kMaxTilt: Double = 0.5
    /// Coefficient for acceleration magnitude to wave amplitude excitation.
    /// Suggested starting point 0.0012.
    private static let kAccelWave: Double = 0.0012
    /// Wave amplitude decay rate (exponential). Semantics: amplitude *= exp(-dt * kWaveDecay).
    private static let kWaveDecay: Double = 2.2
    /// Base wave phase advance rate (radians/second).
    private static let kWavePhaseBase: Double = 4.0
    /// Wave phase advance amplitude multiplier. Semantics: phase += dt * (4.0 + amplitude * 6.0).
    private static let kWavePhaseAmp: Double = 6.0
    /// Level lerp rate (0…1 per second, clamped). Semantics: level += (target - level) * min(1, dt * 2.5).
    private static let kLevelLerpRate: Double = 2.5
    /// Surface offset sine-wave coefficient 1 (amplitude scale).
    private static let kSurfaceAmp1: Double = 0.12
    /// Surface offset sine-wave coefficient 1 (frequency in x).
    private static let kSurfaceFreq1X: Double = 3.1
    /// Surface offset sine-wave coefficient 2 (amplitude scale).
    private static let kSurfaceAmp2: Double = 0.05
    /// Surface offset sine-wave coefficient 2 (phase frequency).
    private static let kSurfaceFreq2Phase: Double = 1.7
    /// Surface offset sine-wave coefficient 2 (frequency in x).
    private static let kSurfaceFreq2X: Double = 5.3
    /// Maximum surface offset magnitude (clamped).
    private static let kSurfaceMaxOffset: Double = 0.45
    /// Minimum dt (1/240 Hz).
    private static let kDtMin: TimeInterval = 1.0 / 240.0
    /// Maximum dt (1/20 Hz).
    private static let kDtMax: TimeInterval = 1.0 / 20.0
    /// Tilt spring stiffness.
    private static let kTiltStiffness: Double = 60.0
    /// Tilt spring damping.
    private static let kTiltDamping: Double = 10.0

    /// Current fill level (0…1).
    var level: Double
    /// Surface rotation (radians; + = right side up). The liquid lags opposite the acceleration.
    var tilt: Double
    /// Tilt angular velocity (radians/second).
    var tiltVelocity: Double
    /// Wave phase (radians), advances with time and amplitude.
    var wavePhase: Double
    /// Wave amplitude (0…1), excited by acceleration magnitude, decays exponentially.
    var waveAmplitude: Double

    /// Rest state: all zero.
    static let rest = FluidSim(level: 0, tilt: 0, tiltVelocity: 0, wavePhase: 0, waveAmplitude: 0)

    /// Advance the simulation by one time step.
    /// - Parameters:
    ///   - dt: Time delta (seconds); clamped to [1/240, 1/20].
    ///   - acceleration: Acceleration vector (points/second²); primarily lateral (dx) drives tilt.
    ///   - targetLevel: Target fill level (0…1); level lerps toward this.
    /// - Returns: New FluidSim state.
    func step(dt rawDt: TimeInterval, acceleration: CGVector, targetLevel: Double) -> FluidSim {
        var next = self
        let dt = max(Self.kDtMin, min(rawDt, Self.kDtMax))

        // Tilt spring toward -clamp(acceleration.dx * kAccelTilt, ±kMaxTilt).
        let tiltTarget = -Self.clamp(acceleration.dx * Self.kAccelTilt, min: -Self.kMaxTilt, max: Self.kMaxTilt)
        let tiltError = tiltTarget - next.tilt
        let tiltAccel = Self.kTiltStiffness * tiltError - Self.kTiltDamping * next.tiltVelocity
        next.tiltVelocity += tiltAccel * dt
        next.tilt += next.tiltVelocity * dt
        // hard bound — the underdamped spring overshoots the clamped target; tan(tilt) in surfaceOffset must stay well off its asymptote regardless of tuning.
        next.tilt = min(max(next.tilt, -Self.kMaxTilt), Self.kMaxTilt)

        // Wave amplitude: excited by acceleration magnitude, decays exponentially.
        let accelMagnitude = sqrt(acceleration.dx * acceleration.dx + acceleration.dy * acceleration.dy)
        next.waveAmplitude += accelMagnitude * Self.kAccelWave * dt
        next.waveAmplitude *= exp(-Self.kWaveDecay * dt)
        next.waveAmplitude = max(0, min(next.waveAmplitude, 1.0))

        // Wave phase: advances at 4.0 + amplitude * 6.0 (rad/sec).
        next.wavePhase += dt * (Self.kWavePhaseBase + next.waveAmplitude * Self.kWavePhaseAmp)

        // Level: lerp toward targetLevel at rate min(1, dt * 2.5).
        let levelLerpFactor = min(1.0, dt * Self.kLevelLerpRate)
        next.level += (targetLevel - next.level) * levelLerpFactor

        return next
    }

    /// Compute the surface Y offset (in bubble-radius units, range ≈ -1…1) at a horizontal
    /// position x (range -1…1).
    /// Combines two sine waves (excited by waveAmplitude) plus a linear tilt term, clamped to ±0.45.
    func surfaceOffset(atX x: Double) -> Double {
        let wave1 = sin(wavePhase + x * Self.kSurfaceFreq1X) * waveAmplitude * Self.kSurfaceAmp1
        let wave2 = sin(wavePhase * Self.kSurfaceFreq2Phase + x * Self.kSurfaceFreq2X) * waveAmplitude * Self.kSurfaceAmp2
        let tiltTerm = x * tan(tilt)
        let offset = wave1 + wave2 + tiltTerm
        return Self.clamp(offset, min: -Self.kSurfaceMaxOffset, max: Self.kSurfaceMaxOffset)
    }

    /// Helper: clamp a value between min and max.
    private static func clamp(_ value: Double, min minVal: Double, max maxVal: Double) -> Double {
        return max(minVal, min(value, maxVal))
    }

    /// Final-review Important-2 (D9 settled-tick freeze): true once the sim has visually stopped
    /// moving toward `targetLevel` — no wave excitation, no tilt (or tilt spring motion), and the
    /// level has converged close enough that continuing to redraw would be indistinguishable from
    /// holding still. PURE — a plain read of this struct's own fields, no wall-clock/view state.
    ///
    /// Tolerances are tuned against `kLevelLerpRate`'s own asymptote: `level` only ever lerps a
    /// fraction of the remaining distance toward `targetLevel` each step (`step(dt:)`'s last line),
    /// so it geometrically approaches but never exactly equals the target — `0.002` is generous
    /// enough that real convergence still trips this (see `FluidSimTests` settle timing) while
    /// staying tight enough that a genuine in-flight drain/fill (which starts at 0.5-1.0 magnitude
    /// away from target) reads as NOT settled for the vast majority of its travel, not just its
    /// final few percent. `waveAmplitude`/`tilt`/`tiltVelocity` thresholds are similarly generous
    /// versus their own decay/spring dynamics (`kWaveDecay`, `kTiltStiffness`/`kTiltDamping`) —
    /// see `FluidSimTests.testSettlesFromMotion`/`testNeverSettlesWhileExcited` for the numbers
    /// this was tuned against.
    func isSettled(targetLevel: Double) -> Bool {
        waveAmplitude < 0.001
            && abs(tilt) < 0.005
            && abs(tiltVelocity) < 0.01
            && abs(level - targetLevel) < 0.002
    }
}
