import Foundation
import LauncherNative

public protocol WorkerSpawning: Sendable {
    /// Spawn the worker SUSPENDED with `l2Child` as its fd 3 and `l3Child` as its fd 4. Both are numbered above 4.
    func spawn(l2Child: OwnedFD, l3Child: OwnedFD) throws -> WorkerProcess
}

public struct NativeWorkerSpawner: WorkerSpawning {
    public let verifier: WorkerImageVerifying
    public init(verifier: WorkerImageVerifying) { self.verifier = verifier }
    public func spawn(l2Child: OwnedFD, l3Child: OwnedFD) throws -> WorkerProcess {
        try NativeWorkerProcess(verifier: verifier, l2Child: l2Child, l3Child: l3Child)
    }
}

/*
 * The real I/O around one `LauncherSession`: L1 (the daemon, a stream socketpair end), L2 (the worker, a datagram socketpair), L3 (the
 * worker, a stream socketpair), the worker's exit, the timers and the power observer, all on ONE serial dispatch queue, so the
 * session is single-threaded without a lock. Every read of L1, L2 and L3 is `Sock.receive` (recvmsg, a control buffer, every
 * descriptor accounted for); no plain read(), no FileHandle, no DispatchIO ever touches these sockets.
 */
public final class LauncherRuntime: SessionPorts, @unchecked Sendable {
    public let queue: DispatchQueue
    public private(set) var session: LauncherSession!

    private let l1: OwnedFD
    private let spawner: WorkerSpawning
    private let onFinish: @Sendable () -> Void
    private var framer = LineFramer()
    /// The up direction (worker to daemon): L3 reads pause at the queue's soft limit, and the relay ceiling is a whole largest line (plus two reads) above it, so the pause
    /// is reachable and only a worker that outruns the HARD cap (never the soft one) makes the channel "lost".
    private var outbound = OutboundQueue(relayHeadroom: WireLimits.muxLineBytes + 2 * 64 * 1024)
    /// How many times L3 reads were paused for the daemon's sake (diagnostics and tests).
    public private(set) var upPauses = 0
    private var head: [UInt8]?
    private var headOffset = 0
    private var l1Gone = false
    private var l1Closing = false
    private var finishing = false
    private var finished = false
    private var l1Read: DispatchSourceRead?
    private var l1Write: DispatchSourceWrite?
    private var l1WriteArmed = false

    private var l2: OwnedFD?
    private var l3: OwnedFD?
    private var l2Read: DispatchSourceRead?
    private var l3Read: DispatchSourceRead?
    private var l3ReadSuspended = false
    private var l3Write: DispatchSourceWrite?
    private var l3WriteArmed = false
    private var l3Reader = MuxStreamReader()
    private var l3Backlog: [UInt8] = []
    /// Back-pressure: above `l3SoftLimit` the launcher STOPS READING L1 (the daemon's sends then wait in its own socket) and resumes below
    /// half of it. The kill is for a HARD cap only (a worker that is not draining L3 at all): either `l3HardLimit` bytes, or `relayStallMs`
    /// without a single byte accepted by the worker while paused.
    private var l3SoftLimit = 4 << 20
    private var l3HardLimit = 32 << 20
    private var relayStallMs = 30_000
    /// The most one CONTINUOUS pause of L1 may last, progress or not: a worker that accepts a trickle forever must not hold `stop` and the daemon's EOF
    /// behind the bulk indefinitely. 120 s moves a 2 MiB drain (soft limit down to its resume point) at 17 KB/s.
    private(set) var relayPauseCapMs = LauncherRuntime.defaultRelayPauseCapMs
    /// The shipped default of the total-pause cap (a constant so a test can pin it): 120 s.
    static let defaultRelayPauseCapMs = 120_000
    private var pauseStartedNs: UInt64 = 0
    private var l1ReadSuspended = false
    /// How many times L1 was paused for the relay's sake (diagnostics and tests).
    public private(set) var backpressurePauses = 0
    private var l3BytesWritten = 0
    private var stallTimer: DispatchSourceTimer?
    private var process: WorkerProcess?
    private var processSource: DispatchSourceProcess?
    private var timers: [SessionTimer: DispatchSourceTimer] = [:]
    private var timerGeneration: [SessionTimer: Int] = [:]
    private var power: PowerObserver?
    private var signalSources: [DispatchSourceSignal] = []

    /// `l1` must already be numbered above 4 (so the worker's descriptors 3 and 4 are free), non-blocking and FD_CLOEXEC.
    public init(l1: OwnedFD, spawner: WorkerSpawning, label: String = "winter.cowork.launcher", onFinish: @escaping @Sendable () -> Void) {
        self.l1 = l1; self.spawner = spawner; self.onFinish = onFinish
        self.queue = DispatchQueue(label: label)
    }

    /// Builds the session and starts reading L1. Call once; everything after runs on `queue`.
    /// `relayLimits` is for tests (small numbers); production uses the defaults.
    public func start(config: SessionConfig, dependencies: SessionDependencies, observePower: Bool, handleTerminationSignals: Bool = false,
                      relayLimits: (soft: Int, hard: Int, stallMs: Int)? = nil, relayPauseCapMs: Int? = nil) {
        queue.async { [self] in
            if let relayLimits { l3SoftLimit = relayLimits.soft; l3HardLimit = relayLimits.hard; relayStallMs = relayLimits.stallMs }
            if let relayPauseCapMs { self.relayPauseCapMs = relayPauseCapMs }
            session = LauncherSession(config: config, ports: self, dependencies: dependencies)
            let read = DispatchSource.makeReadSource(fileDescriptor: l1.raw, queue: queue)
            read.setEventHandler { [weak self] in self?.l1Readable() }
            l1Read = read
            read.resume()
            if observePower {
                let observer = PowerObserver(queue: queue) { [weak self] event in self?.session?.powerEvent(event) }
                if (try? observer.start()) != nil { power = observer }
            }
            if handleTerminationSignals {
                // A launcher that dies on SIGTERM would leave a worker running on two raw images with nobody to reap or receipt it.
                for number in [SIGTERM, SIGHUP, SIGINT] {
                    signal(number, SIG_IGN)
                    let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
                    source.setEventHandler { [weak self] in self?.session.terminationRequested() }
                    signalSources.append(source); source.resume()
                }
            }
            session.start()
            l1Readable() // anything the daemon wrote before we were listening
        }
    }

    // ============================================================================================ L1

    private func l1Readable() {
        guard !l1Gone, !l1Closing, !l1ReadSuspended else { return }
        for _ in 0..<64 {
            if l1ReadSuspended { return } // the relay backlog filled while this chunk was being worked
            switch Sock.receive(l1, capacity: 64 * 1024) {
            case .data(let bytes, let rights):
                do {
                    for line in try framer.feed(bytes, rights: rights) { session.receiveLine(line); if l1Gone || l1Closing { return } }
                } catch { session.channelViolation(); return }
            case .wouldBlock: return
            case .endOfStream: l1Ended(); return
            // MSG_CTRUNC and a malformed control message both leave descriptors nobody can see or account for: the channel is done.
            case .failed(.rightsTruncated), .failed(.badControl), .failed(.dataTruncated): session.channelViolation(); return
            case .failed: l1Ended(); return
            }
        }
    }

    /// A suspended dispatch source must be resumed before it is cancelled.
    private func cancelL1Read() {
        if l1ReadSuspended, let source = l1Read { l1ReadSuspended = false; source.resume() }
        l1Read?.cancel(); l1Read = nil
        stallTimer?.cancel(); stallTimer = nil
    }

    private func l1Ended() {
        guard !l1Gone else { return }
        l1Gone = true
        cancelL1Read()
        cancelL1Write()
        session.daemonChannelClosed()
    }

    public func sendToDaemon(_ line: LineToDaemon) {
        guard !l1Gone, !l1Closing, !finished else { return }
        guard let bytes = try? LauncherLineCodec.serialize(line) else { return }
        let kind: OutboundQueue.Kind
        switch line {
        case .muxUp: kind = .relay
        case .refused, .stopped, .uncertain, .fault: kind = .terminal
        default: kind = .control
        }
        guard outbound.enqueue(bytes, kind: kind) else { l1Ended(); return } // the daemon is not keeping up: treat the channel as lost
        flushL1()
        if outbound.isBackpressured { pauseL3Reads() }
    }

    private func flushL1() {
        while true {
            if head == nil { head = outbound.next(); headOffset = 0 }
            guard let line = head else { break }
            switch Sock.send(l1, line[headOffset...]) {
            case .success(let sent):
                headOffset += sent
                if headOffset < line.count { armL1Write(); return }
                head = nil
            case .failure(.errno(EAGAIN)): armL1Write(); return
            case .failure: head = nil; l1Ended(); return
            }
        }
        cancelL1Write()
        if !outbound.isBackpressured { resumeL3Reads() }
        if l1Closing, head == nil, outbound.isEmpty { l1.close() }
        if finishing { completeFinish() }
    }
    private func armL1Write() {
        guard !l1WriteArmed else { return }
        let source = DispatchSource.makeWriteSource(fileDescriptor: l1.raw, queue: queue)
        source.setEventHandler { [weak self] in self?.flushL1() }
        l1Write = source; l1WriteArmed = true; source.resume()
    }
    private func cancelL1Write() { l1Write?.cancel(); l1Write = nil; l1WriteArmed = false }

    public func closeDaemonChannel() {
        guard !l1Closing else { return }
        l1Closing = true
        cancelL1Read()
        flushL1() // delivers what is queued (the fault line), then closes
    }

    // ============================================================================================ the worker

    public func spawnWorker() throws -> WorkerProcess {
        let (l2p, l2c) = try Sock.pair(.datagram)
        let (l3p, l3c) = try Sock.pair(.stream)
        // Descriptors 3 and 4 belong to the worker's table; nothing of ours may sit on or below them.
        let parent2 = try Sock.relocate(l2p, above: 5), child2 = try Sock.relocate(l2c, above: 5)
        let parent3 = try Sock.relocate(l3p, above: 5), child3 = try Sock.relocate(l3c, above: 5)
        try Sock.setNonBlocking(parent2); try Sock.setNonBlocking(parent3)
        let worker = try spawner.spawn(l2Child: child2, l3Child: child3)
        child2.close(); child3.close() // the worker holds its own copies now
        l2 = parent2; l3 = parent3; process = worker
        let read2 = DispatchSource.makeReadSource(fileDescriptor: parent2.raw, queue: queue)
        read2.setEventHandler { [weak self] in self?.l2Readable() }
        let read3 = DispatchSource.makeReadSource(fileDescriptor: parent3.raw, queue: queue)
        read3.setEventHandler { [weak self] in self?.l3Readable() }
        let exit = DispatchSource.makeProcessSource(identifier: worker.pid, eventMask: .exit, queue: queue)
        exit.setEventHandler { [weak self] in self?.workerExited() }
        l2Read = read2; l3Read = read3; processSource = exit
        read2.resume(); read3.resume(); exit.resume()
        return worker
    }

    private func l2Readable() {
        guard let l2 else { return }
        for _ in 0..<64 {
            switch Sock.receive(l2, capacity: 4096) {
            case .data(let bytes, let rights): session.receiveWorkerDatagram(bytes, descriptors: rights)
            case .wouldBlock: return
            case .endOfStream: l2Read?.cancel(); l2Read = nil; return
            // A datagram socket whose peer has closed answers every read with ECONNRESET: that is the worker's end going away, which its
            // process-exit event judges; it is not a violation by itself.
            case .failed(.errno(ECONNRESET)): l2Read?.cancel(); l2Read = nil; return
            case .failed: session.workerStreamFailed(.malformed); l2Read?.cancel(); l2Read = nil; return
            }
        }
    }

    private func l3Readable() {
        guard let l3 else { return }
        for _ in 0..<64 {
            if l3ReadSuspended { return }
            switch Sock.receive(l3, capacity: 64 * 1024) {
            case .data(let bytes, let rights):
                // L3 never carries descriptors; any that arrived have been closed by the OwnedFD drop.
                if !rights.isEmpty { session.workerStreamFailed(.bad_rights); return }
                do { for (header, frame) in try l3Reader.feed(bytes) { session.receiveWorkerFrame(header, bytes: frame) } }
                catch { session.workerStreamFailed((error as? WireFailure) ?? .malformed); l3Read?.cancel(); l3Read = nil; return }
            case .wouldBlock: return
            case .endOfStream: l3Read?.cancel(); l3Read = nil; return
            case .failed(.errno(ECONNRESET)): l3Read?.cancel(); l3Read = nil; return
            case .failed: session.workerStreamFailed(.malformed); l3Read?.cancel(); l3Read = nil; return
            }
        }
    }
    private func pauseL3Reads() { if !l3ReadSuspended, let source = l3Read { source.suspend(); l3ReadSuspended = true; upPauses += 1 } }
    private func resumeL3Reads() { if l3ReadSuspended, let source = l3Read { l3ReadSuspended = false; source.resume() } }

    private func workerExited() {
        // The session reads what the worker said before it ended (`drainWorkerInputs`) before it judges the exit, and re-probes on a
        // short timer if the child is not waitable yet; the process source has said all it will say.
        session.workerProcessEnded()
        processSource?.cancel(); processSource = nil
    }

    public func drainWorkerInputs() { l2Readable(); l3Readable() }

    public func sendToWorker(_ datagram: [UInt8], descriptors: [OwnedFD]) -> Bool {
        guard let l2 else { return false }
        switch Sock.send(l2, datagram[...], rights: descriptors.map(\.raw)) {
        case .success(let sent): return sent == datagram.count
        case .failure: return false
        }
    }

    public func relayToWorker(_ frame: [UInt8]) -> Bool {
        guard l3 != nil, l3Backlog.count + frame.count <= l3HardLimit else { return false }
        l3Backlog.append(contentsOf: frame)
        flushL3()
        if l3Backlog.count >= l3SoftLimit { pauseL1ForBackpressure() }
        return true
    }

    private func pauseL1ForBackpressure() {
        guard !l1ReadSuspended, let source = l1Read, !l1Gone, !l1Closing else { return }
        source.suspend(); l1ReadSuspended = true; backpressurePauses += 1
        pauseStartedNs = DispatchTime.now().uptimeNanoseconds
        armStallTimer()
    }
    private func resumeL1AfterBackpressure() {
        guard l1ReadSuspended else { return }
        l1ReadSuspended = false
        stallTimer?.cancel(); stallTimer = nil
        l1Read?.resume()
    }
    /// While L1 is paused for the worker's sake, a worker that accepts NOT ONE BYTE for `relayStallMs` is not draining L3 at all. A
    /// stalled relay also starves `stop` and the notice of an EOF behind the bulk, so this is bounded in time.
    private func armStallTimer() {
        stallTimer?.cancel()
        let written = l3BytesWritten
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + .milliseconds(relayStallMs))   // the cap is judged at each window's end (so within one stall window of being exceeded)
        source.setEventHandler { [weak self] in
            guard let self, self.l1ReadSuspended else { return }
            let pausedMs = Int((DispatchTime.now().uptimeNanoseconds - self.pauseStartedNs) / 1_000_000)
            // Not one byte accepted in the stall window, or paused past the total cap whatever the progress: the worker is not draining L3.
            if self.l3BytesWritten == written || pausedMs >= self.relayPauseCapMs { self.stallTimer = nil; self.session.workerNotDraining() } else { self.armStallTimer() }
        }
        stallTimer = source; source.resume()
    }
    private func flushL3() {
        guard let l3 else { return }
        while !l3Backlog.isEmpty {
            switch Sock.send(l3, l3Backlog[...]) {
            case .success(let sent): l3Backlog.removeFirst(sent); l3BytesWritten += sent
            case .failure(.errno(EAGAIN)):
                if !l3WriteArmed {
                    let source = DispatchSource.makeWriteSource(fileDescriptor: l3.raw, queue: queue)
                    source.setEventHandler { [weak self] in self?.flushL3() }
                    l3Write = source; l3WriteArmed = true; source.resume()
                }
                return
            case .failure: l3Backlog.removeAll(); session.workerStreamFailed(.malformed); return
            }
        }
        l3Write?.cancel(); l3Write = nil; l3WriteArmed = false
        if l3Backlog.count < l3SoftLimit / 2 { resumeL1AfterBackpressure() }
    }

    // ============================================================================================ timers and the end

    public func arm(_ timer: SessionTimer, afterMs: Int) {
        disarm(timer)
        let generation = (timerGeneration[timer] ?? 0) + 1
        timerGeneration[timer] = generation
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + .milliseconds(max(0, afterMs)))
        source.setEventHandler { [weak self] in
            guard let self, self.timerGeneration[timer] == generation else { return }
            self.timers[timer]?.cancel(); self.timers[timer] = nil
            self.session.timerFired(timer)
        }
        timers[timer] = source
        source.resume()
    }
    public func disarm(_ timer: SessionTimer) {
        timerGeneration[timer] = (timerGeneration[timer] ?? 0) + 1
        timers[timer]?.cancel(); timers[timer] = nil
    }

    public func finish() {
        guard !finishing else { return }
        finishing = true
        flushL1() // completes the finish when the queue is empty
        // A daemon that stopped reading must not hold the process hostage.
        queue.asyncAfter(deadline: .now() + .seconds(2)) { [weak self] in self?.completeFinish() }
    }
    private func completeFinish() {
        guard !finished else { return }
        finished = true
        power?.stop(); power = nil
        signalSources.forEach { $0.cancel() }; signalSources.removeAll()
        timers.values.forEach { $0.cancel() }; timers.removeAll()
        cancelL1Read()
        resumeL3Reads()
        [l2Read, l3Read].forEach { $0?.cancel() }
        processSource?.cancel()
        onFinish()
    }
}
