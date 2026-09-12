import Foundation

/// Owns the CHTE charge-manager loop's mutable state (target percent, running timer, and all use
/// of the underlying `SMCController`/its IOKit connection) and serializes EVERY access on one
/// dedicated `DispatchQueue`. This matters because the helper's XPC methods
/// (`setChargeLimit`/`getChargeLimit`) can arrive concurrently on arbitrary XPC dispatch queues,
/// and the monitoring timer fires on its own queue — without serialization these would race on
/// `targetPercent`/`inhibitingNow` and could interleave two SMC calls on the same connection.
///
/// Glue class — deliberately thin and NOT unit-tested (no real hardware/timers in the test
/// target). The decision logic it drives (`chargeLimitPlan`, `chargeControlDecision`, both in
/// SMCController.swift) IS exhaustively unit-tested; this class only ever *executes* those pure
/// decisions against IOKit, a timer, and a JSON file. Verified by the human live-gate.
final class ChargeManager {

    enum ChargeManagerError: Error {
        case invalidRange
    }

    /// Hysteresis band (percent) `chargeControlDecision` uses to avoid flapping CHTE in-band.
    static let hysteresisPercent = 3
    /// Monitoring-loop cadence. Only runs while a target is set.
    static let pollInterval: TimeInterval = 30

    private static let persistenceDirectory = URL(fileURLWithPath: "/Library/Application Support/Winter")
    private static let persistenceURL = persistenceDirectory.appendingPathComponent("charge-limit.json")

    private let smc: SMCController
    private let queue = DispatchQueue(label: "com.winter.helper.chargeManager")
    private var timer: DispatchSourceTimer?
    private var _targetPercent: Int?
    private var _inhibitingNow = false
    private var _lastSoc: Int?

    init(smc: SMCController = SMCController()) {
        self.smc = smc
    }

    // MARK: - Public API (each entry point does exactly one `queue.sync` — never call a public
    // method from inside another, that would recursively `sync` the same serial queue and deadlock).

    /// "CHTE" on Apple Silicon, "BCLM" on Intel — for resultJson's `mechanism` field.
    var mechanism: String {
        queue.sync { smc.isAppleSilicon() ? "CHTE" : "BCLM" }
    }

    /// Load a persisted target (if any) and, when present, start enforcing it immediately. Call
    /// once at helper launch so a launchd restart re-applies the user's limit.
    ///
    /// The CHTE loop only runs on Apple Silicon with a sub-100 target (mirrors `setTarget`'s
    /// `.writeBCLM` branch, which never starts a timer either): `CHTE` is volatile and resets to
    /// `0` on reboot, so restoring it needs an active loop, but a persisted Intel `BCLM` value is
    /// still held by firmware across a helper-process restart — restoring it into memory here is
    /// only so `getChargeLimit` can answer without a live re-read, not because it needs re-applying.
    func loadPersistedTargetAndStart() {
        queue.sync {
            guard let percent = Self.loadPersistedTarget() else { return }
            self._targetPercent = percent
            guard self.smc.isAppleSilicon(), percent != 100 else { return }
            self.startTimerLocked()
            self.applyLocked()
        }
    }

    /// Applies `chargeLimitPlan(percent:appleSilicon:)` and executes the resulting plan. Throws
    /// `.invalidRange` (HelperService maps this to the `invalid_range` errorJson) or an
    /// `SMCController.SMCError` (mapped to `smc_error`).
    ///
    /// Returns the resolved `(percent, enforcing, mechanism)` computed atomically inside this same
    /// lock, so a caller building a reply (`HelperService.setChargeLimit`) never needs a follow-up
    /// `getTarget()`/`mechanism` read that could interleave with a concurrent `setTarget` and report
    /// a different request's result (TOCTOU).
    @discardableResult
    func setTarget(_ percent: Int) throws -> (percent: Int, enforcing: Bool, mechanism: String) {
        try queue.sync {
            let appleSilicon = smc.isAppleSilicon()
            let mechanism = appleSilicon ? "CHTE" : "BCLM"
            let plan = chargeLimitPlan(percent: percent, appleSilicon: appleSilicon)
            switch plan {
            case .invalidRange:
                throw ChargeManagerError.invalidRange

            case .appleSiliconLimit(let target):
                self._targetPercent = target
                Self.persist(targetPercent: target)
                self.startTimerLocked()
                try self.applyLockedThrowing()
                return (percent: target, enforcing: true, mechanism: mechanism)

            case .appleSiliconDisable:
                // Write the SMC key FIRST: if `writeCHTE(false)` throws, state/timer/persistence
                // are left untouched so the disable can be retried, instead of committing
                // "disabled" while charging is still physically inhibited with no recovery path.
                try self.smc.writeCHTE(false)
                self._targetPercent = nil
                Self.persist(targetPercent: nil)
                self.stopTimerLocked()
                self._inhibitingNow = false
                return (percent: 100, enforcing: false, mechanism: mechanism)

            case .writeBCLM(let value):
                try self.smc.writeBCLM(value)
                self._targetPercent = Int(value)
                Self.persist(targetPercent: Int(value))
                self.stopTimerLocked()
                return (percent: Int(value), enforcing: Int(value) != 100, mechanism: mechanism)
            }
        }
    }

    /// `percent` is `100` when no limit is set (mirrors the "100 == disabled" convention used
    /// throughout `chargeLimitPlan`).
    func getTarget() -> (percent: Int, inhibitingNow: Bool, soc: Int?) {
        queue.sync {
            (percent: self._targetPercent ?? 100, inhibitingNow: self._inhibitingNow, soc: self._lastSoc)
        }
    }

    // MARK: - Loop core (private — assumes it is ALREADY running on `queue`; never calls `queue.sync`)

    private func startTimerLocked() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + Self.pollInterval, repeating: Self.pollInterval)
        source.setEventHandler { [weak self] in self?.applyLocked() }
        source.resume()
        timer = source
    }

    private func stopTimerLocked() {
        timer?.cancel()
        timer = nil
    }

    /// Timer-driven entry point — no XPC reply to propagate a failure to, so SMC errors are
    /// swallowed here (the loop just retries on the next tick).
    private func applyLocked() {
        _ = try? applyLockedThrowing()
    }

    /// `setTarget`-driven entry point — lets SMC errors surface to the caller as `smc_error`.
    @discardableResult
    private func applyLockedThrowing() throws -> Bool {
        guard let target = _targetPercent else {
            try smc.writeCHTE(false)
            _inhibitingNow = false
            return false
        }
        guard let soc = smc.readStateOfChargePercent() else {
            // Telemetry unavailable this tick — leave state unchanged rather than thrash CHTE.
            return _inhibitingNow
        }
        _lastSoc = soc
        let currentlyInhibited = (try? smc.readCHTE()) ?? _inhibitingNow
        let inhibit = chargeControlDecision(
            soc: soc,
            target: target,
            currentlyInhibited: currentlyInhibited,
            hysteresis: Self.hysteresisPercent
        )
        try smc.writeCHTE(inhibit)
        _inhibitingNow = inhibit
        return inhibit
    }

    // MARK: - Persistence

    /// `{ "targetPercent": <Int|null> }` at `/Library/Application Support/Winter/charge-limit.json`
    /// — root-owned (the daemon runs as root); the directory is created if absent.
    private struct PersistedState: Codable {
        let targetPercent: Int?
    }

    private static func loadPersistedTarget() -> Int? {
        guard let data = try? Data(contentsOf: persistenceURL),
              let state = try? JSONDecoder().decode(PersistedState.self, from: data) else { return nil }
        return state.targetPercent
    }

    private static func persist(targetPercent: Int?) {
        try? FileManager.default.createDirectory(at: persistenceDirectory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(PersistedState(targetPercent: targetPercent)) else { return }
        try? data.write(to: persistenceURL, options: .atomic)
    }
}
