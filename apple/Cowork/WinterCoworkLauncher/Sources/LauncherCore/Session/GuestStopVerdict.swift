import Foundation

/*
 * The guest's part of a stop: a port of `coworkNativeGuestStopVerdict` (packages/core/src/cowork/native/protocol.ts, contract round 3), the
 * ONE place that says when it is orderly. `GoldenVectorTests` runs every case of `guest-stop.json` through `GuestStop.verdict` unchanged.
 *
 * What the launcher can SEE is narrower than the function's input: it sees the worker's L2 statuses in arrival order, but not the libkrun
 * exit reason or the final-sync flags. The worker reports `guest_halted` ONLY when the exit hook's reason is `off` and both disks show a
 * completed final sync (section 5), so `GuestStop.observed` feeds the function `off` and complete counters exactly when `guest_halted`
 * arrived, and `nil` (no reason) when it did not. The launcher therefore reaches the same orderly / not-booted / uncertain class as the vectors
 * for every case, and may name `flush-uncertain` where the vectors name `guest-fault` for a non-`off` reason (it cannot tell those
 * exits apart). The distinction is a reason code only; neither is ever a Class A.
 */
public enum LibkrunExitReason: String, CaseIterable, Sendable {
    case none, off, reset, vcpuError = "vcpu-error", terminalFault = "terminal-fault"
}

public struct FlushDevice: Equatable, Sendable {
    public var requested: UInt64, completed: UInt64, finalSyncAttempted: UInt64, finalSyncCompleted: UInt64
    public init(requested: UInt64, completed: UInt64, finalSyncAttempted: UInt64, finalSyncCompleted: UInt64) {
        self.requested = requested; self.completed = completed; self.finalSyncAttempted = finalSyncAttempted; self.finalSyncCompleted = finalSyncCompleted
    }
}

public enum GuestStopVerdict: Equatable, Sendable {
    case orderly
    case notBooted
    case uncertain(UncertainReason)
}

public enum GuestStop {
    /// Every guest flush completed (`completed == requested`: none lost, none invented) and the final sync was attempted and completed on both disks.
    public static func flushesComplete(_ counters: [FlushDevice]?) -> Bool {
        guard let counters, counters.count == 2 else { return false }
        return counters.allSatisfy { $0.completed == $0.requested && $0.finalSyncAttempted == 1 && $0.finalSyncCompleted == 1 }
    }

    public static func verdict(states: [WorkerStatus], exitReason: LibkrunExitReason?, counters: [FlushDevice]?) -> GuestStopVerdict {
        func at(_ state: WorkerStatus) -> Int? { states.firstIndex(of: state) }
        guard at(.vmRunning) != nil else { return .notBooted }
        if at(.guestFault) != nil { return .uncertain(.guestFault) }
        // The guest can only drain a VM that runs: `vm_running` precedes `draining`, which precedes `drain_acked`.
        guard let running = at(.vmRunning), let draining = at(.draining), let acked = at(.drainAcked), acked >= draining, draining >= running else {
            return at(.guestHalted) != nil ? .uncertain(.guestFault) : .uncertain(.drainTimeout)
        }
        guard let halting = at(.halting), halting >= acked else { return .uncertain(.guestFault) }
        guard let halted = at(.guestHalted), halted >= halting else { return .uncertain(.flushUncertain) }
        guard flushesComplete(counters) else { return .uncertain(.flushUncertain) }
        if exitReason != .off { return .uncertain(exitReason == .terminalFault || exitReason == nil ? .flushUncertain : .guestFault) }
        return .orderly
    }

    /// The launcher's own view (see the header): `guest_halted` stands for "reason off and both final syncs completed".
    public static func observed(states: [WorkerStatus], counters: CounterPair?) -> GuestStopVerdict {
        let devices = counters.map { pair in [pair.data, pair.environment].map { FlushDevice(requested: UInt64($0.requested), completed: UInt64($0.completed), finalSyncAttempted: 1, finalSyncCompleted: 1) } }
        // `guest_halted` implies reason `off` and completed final syncs; without it the verdict stops at the missing power-off report before it reads the reason.
        return verdict(states: states, exitReason: .off, counters: devices)
    }
}
