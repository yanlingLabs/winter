import Foundation

public struct SessionConfig: Sendable {
    public var launcherInstanceId: String
    public var hostBootId: String
    /// From the spawn to the worker's `sandboxed` status (READY). The daemon waits 15 s for `begun`, so this is shorter.
    public var readyTimeoutMs = 10_000
    /// From the VOLUMES envelope to the worker's `volumes_accepted` status. The daemon waits 15 s.
    public var volumesTimeoutMs = 10_000
    /// The owner-loss drain budget (docs: "the documented budget is 30000").
    public var ownerLossBudgetMs = WireLimits.drainBudgetMs
    /// A worker that declared a fault gets this long to exit by itself before it is killed.
    public var faultGraceMs = 5_000
    /// When the kernel says the worker exited but the child is not yet waitable: probe again every `exitProbeIntervalMs`, at most
    /// `exitProbeAttempts` times; the backstop probe (every `backstopMs` while a worker exists) covers anything beyond that.
    public var exitProbeIntervalMs = 10
    public var exitProbeAttempts = 200
    public var backstopMs = 1_000
    public init(launcherInstanceId: String, hostBootId: String) { self.launcherInstanceId = launcherInstanceId; self.hostBootId = hostBootId }
}

/// Confined to the launcher's one serial queue (the store and the power sink are classes); never shared across threads.
public struct SessionDependencies: @unchecked Sendable {
    public var store: DurableReceiptStore
    public var artifacts: GuestArtifactVerifying
    public var random: Randomness
    public var clock: WallClock
    public var monotonicMs: () -> Int64
    public var power: PowerReporting
    public init(store: DurableReceiptStore, artifacts: GuestArtifactVerifying, random: Randomness = SystemRandomness(), clock: WallClock = SystemClock(), monotonicMs: @escaping () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) }, power: PowerReporting) {
        self.store = store; self.artifacts = artifacts; self.random = random; self.clock = clock; self.monotonicMs = monotonicMs; self.power = power
    }
}

/*
 * The launcher's whole decision logic for ONE worker, as a synchronous state machine driven by events and answering through
 * `SessionPorts`. It owns no file descriptor except the two it is handed with a `volumes` line (and drops those the moment they have
 * been forwarded or refused), and it signals nothing except through `WorkerProcess.kill()`.
 *
 *   awaitingBegin -> starting -> begun -> attaching -> attached -> draining -> finished
 *
 * Rules that run through every transition (each has a test and a mutation check):
 *  - a parse is never an authentication: a malformed line, an unexpected rights count or a sequence gap ends the channel;
 *  - Class A exists only if the launcher reaped an exit(0) worker AND the flush chain is complete; it is written durably BEFORE it is sent;
 *  - owner loss never releases anything by itself: it starts a bounded drain, then kills the OWNED handle, then leaves a durable receipt;
 *  - the launcher serves exactly one `begin`.
 */
public final class LauncherSession {
    public enum Phase: Equatable, Sendable { case awaitingBegin, starting, begun, attaching, attached, draining, finished }

    public private(set) var phase: Phase = .awaitingBegin
    public private(set) var evidence = WorkerEvidence()
    public private(set) var verdict: StopReceipt?
    public private(set) var daemonGone = false
    public private(set) var channelFaulted = false
    public var relayedDown = 0, relayedUp = 0

    private let config: SessionConfig
    private let ports: SessionPorts
    private let deps: SessionDependencies
    private let reservation = WorkerReservation()
    private let relayGate = RelayGate()
    private var scope: Scope?
    private var scopeDigest: String?
    private var beginId: String?
    private var homeId: String?
    private var exitProbeAttempts = 0
    private var beginAnswered = false
    private var process: WorkerProcess?
    private var volumesRequestId: String?
    private var pendingVolumes: [VolumeIdentity] = []
    private var awaitingVolumesAck = false
    private var drainRequestId: String?
    private var drainDeadlineMs: Int64 = 0
    private var faultGraceArmed = false
    private var terminating = false
    private var l2OutSeq: UInt32 = 0
    private var l2InSeq: UInt32 = 1
    private var muxDown = MuxSequencer()
    private var muxUp = MuxSequencer()

    public init(config: SessionConfig, ports: SessionPorts, dependencies: SessionDependencies) {
        self.config = config; self.ports = ports; self.deps = dependencies
    }

    public var isFinished: Bool { phase == .finished }

    /// Called once, after the parent has been authenticated. Nothing is sent before it.
    public func start() {
        ports.sendToDaemon(.hello(launcherInstanceId: config.launcherInstanceId, hostBootId: config.hostBootId))
    }

    // =============================================================================================== L1: the daemon

    public func receiveLine(_ line: FramedLine) {
        // A faulted or lost channel reads nothing more; `line.rights` are dropped (closed) on return.
        guard !daemonGone, !channelFaulted else { return }
        let message: LineToLauncher
        do { message = try LauncherLineCodec.parseToLauncher(line.bytes, rights: line.rights.count) } catch { channelViolation(); return }
        switch message {
        case .begin(let id, let homeId, let scope): handleBegin(id: id, homeId: homeId, scope: scope)
        case .volumes(let id, let digest, let volumes): handleVolumes(id: id, scopeDigest: digest, volumes: volumes, descriptors: line.rights)
        case .muxDown(let frame): handleMuxDown(frame)
        case .stop(let id, let nonce, _, let budget): handleStop(id: id, nonce: nonce, budgetMs: budget)
        case .receiptRetire(let confirmationId): handleRetire(confirmationId)
        case .ping(let id): ports.sendToDaemon(.pong(id: id))
        }
    }

    /// The bytes of L1 stopped making sense (or its descriptors did): tell the daemon once, then treat the daemon as lost.
    public func channelViolation() {
        guard !channelFaulted, !daemonGone else { return }
        channelFaulted = true
        ports.sendToDaemon(.fault(.protocol_violation))
        ports.closeDaemonChannel()
        daemonChannelClosed()
    }

    /// EOF, a read or write error, or a fault we caused: the daemon is gone. THIS DOES NOT RELEASE ANYTHING. It starts a bounded
    /// drain and leaves a durable receipt for the next daemon to judge.
    public func daemonChannelClosed() {
        guard !daemonGone else { return }
        daemonGone = true
        daemonChannelClosedLocally()
    }

    /// The shared body of owner loss: a bounded drain (or an immediate kill if the worker never reported READY), never a release.
    private func daemonChannelClosedLocally() {
        switch phase {
        case .awaitingBegin: ports.finish()
        case .starting: killAndCommit(reason: .daemonLost, refusal: nil)
        case .begun, .attaching, .attached:
            startDrain(origin: .ownerLoss, nonce: hex(deps.random.bytes(16)), budgetMs: config.ownerLossBudgetMs, requestId: nil)
        case .draining:
            // An explicit stop is already draining, possibly with a longer budget. Owner loss caps what is left of it.
            let remaining = drainDeadlineMs - deps.monotonicMs()
            if remaining > Int64(config.ownerLossBudgetMs) {
                drainDeadlineMs = deps.monotonicMs() + Int64(config.ownerLossBudgetMs)
                ports.arm(.drain, afterMs: config.ownerLossBudgetMs)
            }
        case .finished: ports.finish()
        }
    }

    /// SIGTERM, SIGHUP or SIGINT reached the launcher itself (a shutdown, a logout, an operator). The worker must not be left behind
    /// running on two raw images: this is owner loss with the daemon possibly still listening. The same bounded drain, the same
    /// durable receipt, and then the process ends whether or not anyone retires it.
    public func terminationRequested() {
        guard !terminating else { return }
        terminating = true
        if phase == .finished || phase == .awaitingBegin { ports.finish(); return }
        daemonChannelClosedLocally()
    }

    private func refuse(_ id: String, _ code: RefusalCode) { ports.sendToDaemon(.refused(id: id, code: code)) }

    // ---------------------------------------------------------------------------------------------- begin

    private func handleBegin(id: String, homeId: String, scope: Scope) {
        guard phase == .awaitingBegin else { refuse(id, .busy); return }
        // NEW SECURITY LOGIC: the launcher recomputes `runtimeImageDigest` from the guest boot artifacts next to the worker and refuses a
        // scope that names another image, BEFORE it reserves, spawns or sends anything. (See GuestArtifacts.swift for what this does not close.)
        do { try deps.artifacts.verify(runtimeImageDigest: scope.runtimeImageDigest) } catch { refuse(id, .code_identity_mismatch); return }
        do { try reservation.acquire() } catch { refuse(id, .busy); return }
        guard let digest = try? EnvelopeFormat.scopeDigest(scope) else { try? reservation.abort(didConstruct: false); refuse(id, .bad_request); return }
        let worker: WorkerProcess
        do { worker = try ports.spawnWorker() } catch {
            try? reservation.abort(didConstruct: false)
            if case SpawnFailure.imageChanged = error { refuse(id, .code_identity_mismatch) } else { refuse(id, .worker_spawn_failed) }
            return
        }
        reservation.markConstructed()
        self.process = worker; self.scope = scope; self.scopeDigest = digest; self.beginId = id; self.homeId = homeId
        phase = .starting
        // 1. The executed image, while it is still SUSPENDED: nothing of it has run and nothing has been sent to it.
        do { try worker.validateExecutedImage() } catch { killAndCommit(reason: .workerKilled, refusal: .code_identity_mismatch); return }
        do { try worker.resume() } catch { killAndCommit(reason: .workerKilled, refusal: .worker_spawn_failed); return }
        // 2. Only now does the worker get its scope.
        guard sendEnvelope({ .scope(seq: $0, scope: scope) }) else { killAndCommit(reason: .launcherFault, refusal: .internal); return }
        ports.arm(.ready, afterMs: config.readyTimeoutMs)
        ports.arm(.backstop, afterMs: config.backstopMs)
    }

    /// The worker's READY (status `sandboxed`): validate the running image AGAIN, then tell the daemon.
    private func workerReady() {
        ports.disarm(.ready)
        guard let worker = process, let scope, let beginId else { return }
        do { try worker.validateExecutedImage() } catch { killAndCommit(reason: .workerKilled, refusal: .code_identity_mismatch); return }
        phase = .begun
        beginAnswered = true
        ports.sendToDaemon(.begun(id: beginId, workerInstanceId: scope.workerInstanceId, workerPid: Int(worker.pid), workerStartToken: worker.startToken))
        ports.sendToDaemon(.workerState(.sandboxed))
    }

    // ---------------------------------------------------------------------------------------------- volumes

    private func handleVolumes(id: String, scopeDigest digest: String, volumes: [VolumeIdentity], descriptors: [OwnedFD]) {
        switch phase {
        case .awaitingBegin, .starting: refuse(id, .not_begun); return
        case .begun: break
        default: refuse(id, .busy); return
        }
        guard digest == scopeDigest, descriptors.count == WireLimits.volumeRights else { refuse(id, .volumes_rejected); return }
        for (descriptor, identity) in zip(descriptors, volumes) {
            do { try VolumeDescriptorCheck.verify(descriptor, against: identity) } catch { refuse(id, .volumes_rejected); return }
        }
        evidence.volumesSent = true
        // The launcher's copies are closed the moment the datagram has been handed to the kernel (or refused): they are never kept.
        guard sendEnvelope({ .volumes(seq: $0, scopeDigest: digest, volumes: volumes) }, descriptors: descriptors) else {
            // The worker may or may not have received them: the conservative bookkeeping stays (`volumesSent`).
            refuse(id, .internal); killAndCommit(reason: .launcherFault, refusal: nil); return
        }
        volumesRequestId = id; pendingVolumes = volumes; awaitingVolumesAck = true
        phase = .attaching
        ports.arm(.volumes, afterMs: config.volumesTimeoutMs)
    }

    private func volumesAccepted() {
        ports.disarm(.volumes)
        awaitingVolumesAck = false
        evidence.attachedVolumes = pendingVolumes
        if phase == .attaching { phase = .attached }
        if let id = volumesRequestId {
            ports.sendToDaemon(.volumesAccepted(id: id))
            ports.sendToDaemon(.workerState(.volumes_accepted))
        }
    }

    // ---------------------------------------------------------------------------------------------- relay

    private func handleMuxDown(_ frame: [UInt8]) {
        // The guest does not exist before the worker has accepted the disks, and nothing flows after the verdict.
        guard phase == .attached || phase == .draining, evidence.attachedVolumes != nil, let header = try? MuxFormat.parseRelayable(frame) else {
            if phase == .finished { return }
            channelViolation(); return
        }
        do { try muxDown.accept(header) } catch { channelViolation(); return }
        do { try relayGate.begin() } catch { return }
        defer { relayGate.finish() }
        if ports.relayToWorker(frame) { relayedDown += 1 }
        else {
            // The worker is not draining L3: the bounded backlog is full. The channel to the worker is lost.
            workerProtocolViolation("L3 backlog full")
        }
    }

    /// One whole frame from L3. The header was validated by the stream reader; the launcher never looks inside the payload.
    public func receiveWorkerFrame(_ header: MuxHeader, bytes: [UInt8]) {
        guard process != nil, phase != .finished else { return }
        // Control frames terminate at the worker and never cross L3. (The provider class was refused at the header.)
        guard header.muxClass == .bootstrap || header.muxClass == .runtime else { workerProtocolViolation("control class on L3"); return }
        guard phase == .attached || phase == .draining, evidence.attachedVolumes != nil else { workerProtocolViolation("frame before the disks were accepted"); return }
        do { try muxUp.accept(header) } catch { workerProtocolViolation("L3 sequence"); return }
        do { try relayGate.begin() } catch { return }
        defer { relayGate.finish() }
        relayedUp += 1
        ports.sendToDaemon(.muxUp(frame: bytes))
    }

    /// The runtime paused L1 for the worker's sake and the worker has accepted not one byte of L3 for the whole stall window.
    public func workerNotDraining() {
        guard process != nil, phase != .finished else { return }
        workerProtocolViolation("the worker is not draining L3")
    }

    /// L3 stopped being a sequence of valid frames (a bad header, a refused class, an oversize payload).
    public func workerStreamFailed(_ failure: WireFailure) {
        guard process != nil, phase != .finished else { return }
        workerProtocolViolation("L3 stream: \(failure.rawValue)")
    }

    // =============================================================================================== L2: the worker

    public func receiveWorkerDatagram(_ bytes: [UInt8], descriptors: [OwnedFD]) {
        guard process != nil, phase != .finished else { return } // descriptors are closed on return
        guard descriptors.isEmpty else { workerProtocolViolation("descriptors from the worker"); return }
        let envelope: Envelope
        do { envelope = try EnvelopeFormat.parse(bytes, rights: 0, direction: .toLauncher) } catch { workerProtocolViolation("malformed envelope"); return }
        guard envelope.seq == l2InSeq else { workerProtocolViolation("envelope sequence"); return }
        l2InSeq += 1
        switch envelope {
        case .status(_, let state, let data, let environment): handleStatus(state, data: data, environment: environment)
        case .fault(_, let code): handleWorkerFault(code)
        default: workerProtocolViolation("envelope kind from the worker")
        }
    }

    private func handleStatus(_ state: WorkerStatus, data: FlushCounters, environment: FlushCounters) {
        // Counters: completed never exceeds requested, and neither ever decreases.
        let previous = evidence.latestCounters
        guard data.completed <= data.requested, environment.completed <= environment.requested, data.requested >= previous.data.requested, data.completed >= previous.data.completed,
              environment.requested >= previous.environment.requested, environment.completed >= previous.environment.completed else { workerProtocolViolation("flush counters"); return }
        evidence.latestCounters = CounterPair(data: data, environment: environment)
        let attached = evidence.attachedVolumes != nil
        switch state {
        case .sandboxed:
            guard phase == .starting, !evidence.statuses.contains(.sandboxed) else { workerProtocolViolation("sandboxed out of order"); return }
            evidence.statuses.insert(state); evidence.lastStatus = state
            workerReady(); return
        case .volumesAccepted:
            guard awaitingVolumesAck else { workerProtocolViolation("volumes_accepted out of order"); return }
            evidence.statuses.insert(state); evidence.lastStatus = state
            volumesAccepted(); return
        case .vmRunning:
            guard attached, phase == .attached || phase == .draining else { workerProtocolViolation("vm_running before the disks"); return }
            ports.sendToDaemon(.workerState(.vm_running))
        case .guestHello:
            guard evidence.statuses.contains(.vmRunning) else { workerProtocolViolation("guest_hello before vm_running"); return }
            ports.sendToDaemon(.workerState(.guest_hello))
        case .draining:
            guard phase == .draining else { workerProtocolViolation("draining that nobody asked for"); return }
            ports.sendToDaemon(.workerState(.draining))
        case .drainAcked:
            guard phase == .draining, evidence.booted else { workerProtocolViolation("drain_acked out of order"); return }
            ports.sendToDaemon(.workerState(.drain_acked))
        case .guestHalted:
            guard evidence.statuses.contains(.vmRunning) else { workerProtocolViolation("guest_halted without a VM"); return }
            evidence.finalCounters = evidence.latestCounters
        case .exiting:
            evidence.finalCounters = evidence.latestCounters
        }
        evidence.statuses.insert(state); evidence.lastStatus = state
    }

    private func handleWorkerFault(_ code: WorkerFault) {
        evidence.fault = code
        switch phase {
        case .starting:
            let refusal: RefusalCode = code == .badScope ? .bad_request : code == .sandboxFailed ? .sandbox_failed : .internal
            killAndCommit(reason: .workerKilled, refusal: refusal)
        case .attaching:
            if awaitingVolumesAck, let id = volumesRequestId { refuse(id, .volumes_rejected) }
            awaitingVolumesAck = false; ports.disarm(.volumes)
            armFaultGrace()
        default: armFaultGrace()
        }
    }

    private func armFaultGrace() {
        guard !faultGraceArmed else { return }
        faultGraceArmed = true
        ports.arm(.faultGrace, afterMs: config.faultGraceMs)
    }

    /// The worker broke the contract. It is untrustworthy from here on, so it is killed through the owned handle (no drain: it would
    /// only be asked to cooperate with something it is not doing), and the verdict can only be Class B.
    private func workerProtocolViolation(_ why: String) {
        guard phase != .finished else { return }
        evidence.violations.append(why)
        if phase != .starting { ports.sendToDaemon(.fault(.worker_channel_lost)) }
        killAndCommit(reason: .workerKilled, refusal: phase == .starting ? .internal : nil)
    }

    // =============================================================================================== stop and drain

    private func handleStop(id: String, nonce: String, budgetMs: Int) {
        switch phase {
        case .awaitingBegin: refuse(id, .not_begun)
        case .starting:
            // The daemon gave up waiting for `begun`. The worker never reported READY, so it never had a chance to touch a disk.
            killAndCommit(reason: .workerKilled, refusal: .worker_spawn_failed, stopId: id)
        case .begun, .attaching, .attached:
            startDrain(origin: .hostStop, nonce: nonce, budgetMs: min(budgetMs, WireLimits.drainBudgetCeilingMs), requestId: id)
        case .draining:
            if drainRequestId == id, evidence.drain?.nonce == nonce { return } // the same request, repeated
            refuse(id, .busy)
        case .finished:
            switch verdict {
            case .orderly(let receipt)? where receipt.stopNonce == nonce && receipt.origin == .hostStop: ports.sendToDaemon(.stopped(id: id, receipt: receipt))
            case .uncertain(let receipt)?: ports.sendToDaemon(.uncertain(receipt: receipt))
            default: refuse(id, .busy)
            }
        }
    }

    private func startDrain(origin: DrainOrigin, nonce: String, budgetMs: Int, requestId: String?) {
        phase = .draining
        drainRequestId = requestId
        // A drain replaces the start-up deadlines: an unacknowledged transfer is judged by the drain budget, not by its own timer.
        ports.disarm(.ready); ports.disarm(.volumes)
        // Only a DRAIN the worker was actually handed is evidence that a drain was requested.
        guard sendEnvelope({ .drain(seq: $0, stopNonce: nonce, budgetMs: budgetMs, origin: origin) }) else { killAndCommit(reason: .launcherFault, refusal: nil); return }
        evidence.drain = DrainRecord(nonce: nonce, origin: origin == .hostStop ? .hostStop : .ownerLossDrain)
        drainDeadlineMs = deps.monotonicMs() + Int64(budgetMs)
        ports.arm(.drain, afterMs: budgetMs)
    }

    public func timerFired(_ timer: SessionTimer) {
        guard phase != .finished else { return }
        switch timer {
        case .ready:
            guard phase == .starting else { return }
            killAndCommit(reason: .workerKilled, refusal: .sandbox_failed)
        case .volumes:
            guard awaitingVolumesAck else { return }
            // The worker holds (or may hold) two raw images and says nothing. Refuse, then take it down through the owned handle.
            if let id = volumesRequestId { refuse(id, .volumes_rejected) }
            awaitingVolumesAck = false
            evidence.violations.append("volumes not acknowledged")
            killAndCommit(reason: .workerKilled, refusal: nil)
        case .drain:
            guard phase == .draining else { return }
            killAndCommit(reason: .drainTimeout, refusal: nil)
        case .faultGrace:
            killAndCommit(reason: .guestFault, refusal: nil)
        case .exitProbe:
            judgeExit(eventDriven: true)
        case .backstop:
            ports.arm(.backstop, afterMs: config.backstopMs)
            judgeExit(eventDriven: false)
        }
    }

    // =============================================================================================== the worker's end

    /// The worker process ended (the I/O layer has already delivered everything still queued on L2 and L3).
    public func workerProcessEnded() { judgeExit(eventDriven: true) }

    /// `eventDriven`: the kernel said the process exited. If the child is not waitable yet (measured: a single WNOHANG at the event
    /// returned "running" for 0.3 to 0.65 % of exits) the exit would go unjudged until some other event, so it is probed again on a
    /// short bounded timer. The coarse backstop (`eventDriven: false`) catches an exit whose event was lost altogether.
    private func judgeExit(eventDriven: Bool) {
        guard let worker = process, phase != .finished else { return }
        let exit = worker.probe()
        guard exit != .running else {
            if eventDriven {
                exitProbeAttempts += 1
                if exitProbeAttempts <= config.exitProbeAttempts { ports.arm(.exitProbe, afterMs: config.exitProbeIntervalMs) }
            }
            return
        }
        exitProbeAttempts = 0
        ports.disarm(.exitProbe)
        // Whatever the worker said before it ended is still queued: read it all before judging the exit. (What it says can end the
        // session right here, hence the second look at the phase.)
        ports.drainWorkerInputs()   // what it says can end the session right here; `commit` refuses a finished one
        let refusal: RefusalCode? = phase == .starting ? .sandbox_failed : nil
        commit(exit: exit, killSent: false, killReason: nil, refusal: refusal, stopId: drainRequestId)
    }

    /// Takes the worker down through the owned handle, then records how it ended. This is the ONLY place a process is signalled.
    private func killAndCommit(reason: UncertainReason, refusal: RefusalCode?, stopId: String? = nil) {
        guard let worker = process, phase != .finished else { return }
        let outcome = worker.kill()
        commit(exit: outcome.exit, killSent: outcome.killSent, killReason: reason, refusal: refusal, stopId: stopId ?? drainRequestId)
    }

    private func commit(exit: WorkerExit, killSent: Bool, killReason: UncertainReason?, refusal: RefusalCode?, stopId: String?) {
        guard phase != .finished, let worker = process, let scope else { return }
        [SessionTimer.ready, .volumes, .drain, .faultGrace, .exitProbe, .backstop].forEach(ports.disarm)
        relayGate.close()
        let context = StopContext(scope: scope, homeId: homeId ?? "", launcherInstanceId: config.launcherInstanceId, hostBootId: config.hostBootId, workerPid: worker.pid, workerStartToken: worker.startToken)
        let key = ReceiptScope(scope)
        func decide(demote: UncertainReason?) -> StopReceipt {
            OrderlyStopAuthority.decide(context: context, exit: exit, evidence: evidence, killSent: killSent, killReason: killReason, issuedAtMs: deps.clock.nowMs,
                                        confirmationId: "confirm-" + hex(deps.random.bytes(12)), demoteTo: demote)
        }
        var receipt = decide(demote: nil)
        // DURABLE BEFORE SENT. If it cannot be made durable it is not orderly: Class B releases nothing, so it needs no durability to be safe.
        do { try deps.store.persist(receipt, scope: key) } catch {
            if case .orderly = receipt { receipt = decide(demote: .launcherFault) }
            try? deps.store.persist(receipt, scope: key)
        }
        verdict = receipt
        phase = .finished
        if let refusal, !beginAnswered, let beginId { beginAnswered = true; refuse(beginId, refusal) }
        ports.sendToDaemon(.workerState(.exited))
        switch receipt {
        case .orderly(let r): ports.sendToDaemon(.stopped(id: stopId, receipt: r))
        case .uncertain(let r): ports.sendToDaemon(.uncertain(receipt: r))
        }
        // Nobody is waiting for it: the receipt is durable, and the next daemon decides what it means.
        if daemonGone || terminating { ports.finish() }
    }

    private func handleRetire(_ confirmationId: String) {
        guard case .orderly(let receipt)? = verdict, receipt.confirmationId == confirmationId, let scope else { return }
        try? deps.store.retire(ReceiptScope(scope))
        ports.finish()
    }

    // =============================================================================================== power

    public func powerEvent(_ event: PowerEvent) { deps.power.report(event) }

    // =============================================================================================== helpers

    private func sendEnvelope(_ build: (UInt32) -> Envelope, descriptors: [OwnedFD] = []) -> Bool {
        l2OutSeq += 1
        guard let bytes = try? EnvelopeFormat.serialize(build(l2OutSeq)) else { return false }
        return ports.sendToWorker(bytes, descriptors: descriptors)
    }
    private func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
}

/// Does a descriptor name the file the daemon said it does? (fstat only: the launcher never reads a byte of an image.)
public enum VolumeDescriptorCheck {
    public struct Mismatch: Error, Equatable { public let why: String }
    public static func verify(_ descriptor: OwnedFD, against identity: VolumeIdentity) throws {
        var info = stat()
        guard fstat(descriptor.raw, &info) == 0 else { throw Mismatch(why: "fstat") }
        guard info.st_mode & S_IFMT == S_IFREG else { throw Mismatch(why: "not a regular file") }
        guard String(UInt64(UInt32(bitPattern: info.st_dev))) == identity.device, String(info.st_ino) == identity.inode else { throw Mismatch(why: "identity") }
        guard info.st_size >= 0, UInt64(info.st_size) == identity.capacityBytes else { throw Mismatch(why: "size") }
        guard info.st_uid == identity.uid, UInt32(info.st_mode & 0o7777) == identity.mode else { throw Mismatch(why: "owner or mode") }
        let flags = fcntl(descriptor.raw, F_GETFL)
        guard flags >= 0, flags & O_ACCMODE == O_RDWR else { throw Mismatch(why: "not open read-write") }
    }
}
