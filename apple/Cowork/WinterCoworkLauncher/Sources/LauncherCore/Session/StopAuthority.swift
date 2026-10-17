import Foundation

public struct CounterPair: Equatable, Sendable {
    public var data = FlushCounters()
    public var environment = FlushCounters()
    public init(data: FlushCounters = FlushCounters(), environment: FlushCounters = FlushCounters()) { self.data = data; self.environment = environment }
}
public struct DrainRecord: Equatable, Sendable {
    public let nonce: String
    public let origin: StopOrigin
    public init(nonce: String, origin: StopOrigin) { self.nonce = nonce; self.origin = origin }
}

/// What the launcher itself OBSERVED about the worker (docs/cowork-native-worker.md, section 7: "it states facts the launcher itself
/// observed (it is the sole reaper)"). Nothing in here comes from the daemon after `begin`/`volumes`/`stop`, and nothing is a guess.
public struct WorkerEvidence: Equatable, Sendable {
    /// Every status the worker reported (envelope kind 4), in a set: the order is checked as it arrives.
    public var statuses: Set<WorkerStatus> = []
    public var lastStatus: WorkerStatus?
    /// The flush counters of the LAST `guest_halted` or `exiting` status.
    public var finalCounters: CounterPair?
    /// The latest counters of any status, for the monotonic check.
    public var latestCounters = CounterPair()
    /// A FAULT envelope the worker sent.
    public var fault: WorkerFault?
    /// Anything the worker did that the contract does not allow. Any entry rules out Class A.
    public var violations: [String] = []
    /// Set only once the worker said it accepted the two descriptors: the identities the daemon stated for them.
    public var attachedVolumes: [VolumeIdentity]?
    /// The VOLUMES envelope (with the two descriptors) was handed to the worker. From that moment the worker MAY hold the disks,
    /// whether or not it ever said so; it is what a Class B receipt reports as `attachedVolumes`.
    public var volumesSent = false
    /// The DRAIN the launcher actually sent (and so the nonce the worker was given).
    public var drain: DrainRecord?

    public init() {}
    public var booted: Bool { statuses.contains(.vmRunning) || statuses.contains(.guestHello) || statuses.contains(.drainAcked) || statuses.contains(.guestHalted) }
}

public struct StopContext: Sendable {
    public let scope: Scope
    public let homeId: String
    public let launcherInstanceId: String
    public let hostBootId: String
    public let workerPid: Int32
    public let workerStartToken: String
    public init(scope: Scope, homeId: String, launcherInstanceId: String, hostBootId: String, workerPid: Int32, workerStartToken: String) {
        self.scope = scope; self.homeId = homeId; self.launcherInstanceId = launcherInstanceId; self.hostBootId = hostBootId; self.workerPid = workerPid; self.workerStartToken = workerStartToken
    }
}

/*
 * The port of `CleanStopAuthority`: "a raw state is only one part of stop proof". A Class A receipt exists only when the worker
 * TERMINATED (the launcher's own waitpid reaped it, with exit code 0) AND its disks were FLUSHED (every requested flush completed,
 * a final flush followed power-off) AND the whole chain of statuses is consistent. Everything else is Class B, which carries no
 * confirmation id, no nonce and no volume list, so nothing in it can ever be turned into a release.
 *
 * Process exit alone is never evidence (the fixture's `_exit(79)` is not a release): exit 0 without a drain request, or without
 * the flush chain, is Class B.
 */
public enum OrderlyStopAuthority {
    public static func decide(context c: StopContext, exit: WorkerExit, evidence e: WorkerEvidence, killSent: Bool, killReason: UncertainReason?,
                              issuedAtMs: UInt64, confirmationId: @autoclosure () -> String, demoteTo forced: UncertainReason? = nil) -> StopReceipt {
        let attached = e.volumesSent
        func uncertain(_ reason: UncertainReason) -> StopReceipt {
            let facts: (UncertainExit, Int)
            switch exit {
            case .code(let code): facts = (.code, Int(code) & 255)
            case .signal(let signal): facts = (.signal, Int(signal) & 255)
            default: facts = (.unknown, 0)
            }
            return .uncertain(UncertainReceipt(launcherInstanceId: c.launcherInstanceId, admissionId: c.scope.admissionId, workspaceId: c.scope.workspaceId, incarnationId: c.scope.incarnationId,
                                               leaseEpoch: c.scope.leaseEpoch, workerInstanceId: c.scope.workerInstanceId, reason: reason, workerPid: Int(c.workerPid), workerStartToken: c.workerStartToken,
                                               workerExit: facts.0, workerStatus: facts.1, attachedVolumes: attached, issuedAtMs: issuedAtMs))
        }

        // 0. The caller could not make the verdict durable (or otherwise cannot stand behind it): never orderly.
        if let forced { return uncertain(forced) }
        // 1. Terminated: the launcher reaped the process it owns, and it left through exit(0).
        switch exit {
        case .code(0): break
        case .code: return uncertain(.workerCrashed)
        case .signal: return uncertain(killSent ? (killReason ?? .workerKilled) : .workerCrashed)
        case .running, .uncertain, .lost: return uncertain(.launcherFault)
        }
        // 2. Nothing the worker did was off-contract, and it never declared itself failed.
        if !e.violations.isEmpty || e.fault != nil { return uncertain(.guestFault) }
        // 3. A drain was actually requested: an exit nobody asked for is a crash that happened to return 0.
        guard let drain = e.drain else { return uncertain(.workerCrashed) }
        // 4. The disks were flushed.
        let booted = e.booted
        var volumes: [OrderlyVolume]
        if let identities = e.attachedVolumes {
            let purposes: [VolumePurpose] = [.data, .environment]
            if booted {
                // The guest halted through a drain ack and a power-off, and the exit hook then reported every requested flush completed.
                guard e.statuses.contains(.drainAcked), e.statuses.contains(.guestHalted), let final = e.finalCounters,
                      final.data.requested == final.data.completed, final.environment.requested == final.environment.completed else { return uncertain(.flushUncertain) }
                let counters = [final.data, final.environment]
                volumes = zip(identities, zip(purposes, counters)).map { identity, pair in
                    OrderlyVolume(purpose: pair.0, device: identity.device, inode: identity.inode, capacityBytes: identity.capacityBytes, attached: true,
                                  flushRequested: pair.1.requested, flushCompleted: pair.1.completed, finalFlush: .completed)
                }
            } else {
                // Attached, but the VM never ran: it wrote nothing, so there is nothing to flush. A worker that reports flushes without a
                // VM is not telling a consistent story.
                if let final = e.finalCounters, final.data != FlushCounters() || final.environment != FlushCounters() { return uncertain(.flushUncertain) }
                volumes = zip(identities, purposes).map { identity, purpose in
                    OrderlyVolume(purpose: purpose, device: identity.device, inode: identity.inode, capacityBytes: identity.capacityBytes, attached: true,
                                  flushRequested: 0, flushCompleted: 0, finalFlush: .completed)
                }
            }
        } else {
            // The worker was handed descriptors and never said it took them: it may have held (even written to) disks without a word.
            // That is not "no disks were held".
            if e.volumesSent { return uncertain(.flushUncertain) }
            // No disks were ever held by the worker; a VM without disks cannot have existed.
            if booted { return uncertain(.guestFault) }
            volumes = [.unattached(.data), .unattached(.environment)]
        }
        let receipt = OrderlyReceipt(
            confirmationId: confirmationId(), stopNonce: drain.nonce, origin: drain.origin, launcherInstanceId: c.launcherInstanceId, admissionId: c.scope.admissionId, homeId: c.homeId,
            workspaceId: c.scope.workspaceId, incarnationId: c.scope.incarnationId, leaseEpoch: c.scope.leaseEpoch, controllerInstanceId: c.scope.controllerInstanceId,
            workerInstanceId: c.scope.workerInstanceId, runtimeImageDigest: c.scope.runtimeImageDigest, hostBootId: c.hostBootId,
            guestDrain: booted ? .acked : .notBooted, guestPowerOff: booted ? .observed : .notBooted, workerPid: Int(c.workerPid), workerStartToken: c.workerStartToken,
            volumes: volumes, issuedAtMs: issuedAtMs)
        // Defence in depth: a receipt that does not satisfy the contract's own invariants is not orderly evidence, whatever built it.
        return receipt.invariantsHold ? .orderly(receipt) : uncertain(.flushUncertain)
    }
}
