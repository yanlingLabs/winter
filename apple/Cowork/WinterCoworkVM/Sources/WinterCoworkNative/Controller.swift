import Foundation
import WinterCoworkPrimitives

public enum NativePowerState: String, Sendable { case stopped, starting, running, stopping, uncertain, closed }

public final class NativeLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var safe = false
    func update(_ value: Bool) { lock.lock(); safe = value; lock.unlock() }
    public func canRelease() -> Bool { lock.lock(); defer { lock.unlock() }; return safe }
}

/// Serializes admission only, never the awaited lifetime of an exec.
private final class AdmissionQueue: @unchecked Sendable {
    struct Entry: Sendable { let id: UInt64; let request: Result<NativeRequest, any Error> }
    private let lock = NSLock()
    private var entries: [Entry] = []
    private var draining = false
    func enqueue(_ entry: Entry, consume: @escaping @Sendable (Entry) async -> Void) {
        lock.lock(); entries.append(entry); let start = !draining; draining = true; lock.unlock()
        if start { Task { while let next = self.next() { await consume(next) } } }
    }
    private func next() -> Entry? {
        lock.lock(); defer { lock.unlock() }
        if entries.isEmpty { draining = false; return nil }; return entries.removeFirst()
    }
}

/// A cancellation keeps this receipt even after the owner is removed from the
/// live process table. Signalling a process is not proof that its cleanup ended.
private actor ExecutionCompletion {
    private var status: NativeTerminalStatus?
    private var waiters: [CheckedContinuation<NativeTerminalStatus, Never>] = []
    func finish(_ result: NativeTerminalStatus) {
        guard status == nil else { return }; status = result
        let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume(returning: result) }
    }
    func wait() async -> NativeTerminalStatus {
        if let status { return status }
        return await withCheckedContinuation { waiters.append($0) }
    }
}

/// Host-created, one-incarnation controller. Actor reentrancy permits parallel
/// execs; admission changes happen before awaiting backend work. No guest frame
/// can register a descriptor or change the host scope/epoch.
public actor NativeController {
    public nonisolated let scope: NativeScope
    public nonisolated let events: NativeEventChannel
    public nonisolated let lifetime = NativeLifetime()
    private let backend: any NativeWorkspaceBackend
    private let deviceGate = DeviceOperationGate()
    private nonisolated let submissions = AdmissionQueue()
    private var power: NativePowerState = .stopped
    private var admissionClosed = false
    private var startedOnce = false
    private var processes: [UInt64: (String, any NativeGuestProcess)] = [:]
    private var cancelled: Set<UInt64> = []
    private var openingProcesses = 0
    private var executionWaiters: [CheckedContinuation<Void, Never>] = []
    private var executionCompletions: [UInt64: ExecutionCompletion] = [:]
    private var registrationWaiters: [UInt64: [CheckedContinuation<Void, Never>]] = [:]
    private var openingWaiters: [CheckedContinuation<Void, Never>] = []
    private var stopWaiters: Set<UInt64> = []
    private var stopStarted = false
    private var finishedStop: BackendStopResult?
    private var forceStopStarted = false
    private var forceStopInFlight = false
    private var forceStopTask: Task<Void, Never>?
    private var forceStopProof: BackendStopResult?
    private var stopDrainFinished = false
    private let cleanupBudgetMilliseconds: UInt32
    private var cleanupDeadline: Task<Void, Never>?
    private var openingOwners: [UInt64: String] = [:]
    private var backendFailure: BackendLifecycleEvent?
    private struct InputTicket: Sendable { let previous: ExecutionCompletion?; let completion: ExecutionCompletion }
    private var inputTails: [UInt64: ExecutionCompletion] = [:]
    private var inputTickets: [UInt64: InputTicket] = [:]
    private var inputDrainWaiters: [CheckedContinuation<Void, Never>] = []
    private var starting = false
    private var startOperationId: UInt64?
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var stopDeadlines: [UInt64: Task<Void, Never>] = [:]

    public init(scope: NativeScope, backend: any NativeWorkspaceBackend, cleanupBudgetMilliseconds: UInt32 = 30_000) throws {
        guard scope.protocolVersion == 1, !scope.workspaceId.isEmpty, !scope.incarnationId.isEmpty,
              scope.workspaceId.utf8.count <= 128, scope.incarnationId.utf8.count <= 128,
              scope.grantRevision <= 9_007_199_254_740_991, scope.leaseEpoch <= 9_007_199_254_740_991 else {
            throw NativeFailure("invalid_scope", "Versioned host workspace/incarnation scope is required")
        }
        self.cleanupBudgetMilliseconds = min(max(cleanupBudgetMilliseconds, 1), 30_000)
        self.scope = scope; self.backend = backend; events = try NativeEventChannel(scope: scope)
    }
    public nonisolated func submit(_ json: String) -> UInt64 {
        guard json.utf8.count <= 64 * 1024 else { return 0 }
        let decoded = Result { try JSONDecoder().decode(NativeRequest.self, from: Data(json.utf8)) }
        let kind = try? decoded.get().kind
        let reservation: NativeEventChannel.Reservation = [.stop, .shutdown].contains(kind) ? .shutdown : ([.cancel, .input, .closeInput].contains(kind) ? .control : .ordinary)
        guard let id = events.reserve(reservation) else { return 0 }
        submissions.enqueue(.init(id: id, request: decoded)) { await self.admit($0) }
        return id
    }
    private func admit(_ entry: AdmissionQueue.Entry) {
        do {
            let request = try entry.request.get()
            try validate(request)
            try events.emit(entry.id, kind: .accepted)
            switch request.kind {
            case .start:
                guard !startedOnce, power == .stopped else { throw NativeFailure("incarnation_used", "A host incarnation may start only once") }
                startedOnce = true; power = .starting; startOperationId = entry.id; starting = true
            case .exec:
                guard power == .running, let task = request.taskId, !task.isEmpty, task.utf8.count <= 128,
                      let args = request.arguments, !args.isEmpty, args.count <= 256,
                      args.allSatisfy({ !$0.contains("\0") }), args.reduce(0, { $0 + $1.utf8.count }) <= 32 * 1024 else {
                    throw NativeFailure("execution_refused", "Running guest, owning task and bounded arguments required")
                }
                openingProcesses += 1; openingOwners[entry.id] = task
                executionCompletions[entry.id] = ExecutionCompletion()
            case .input, .closeInput:
                guard let text = request.ownerOperationId, let owner = UInt64(text),
                      let task = openingOwners[owner] ?? processes[owner]?.0, task == request.taskId else {
                    throw NativeFailure("task_ownership_denied", "Input requires the live operation's authenticated task")
                }
                // Admission is ordered; Tasks/actors executing the writes are not.
                let receipt = ExecutionCompletion()
                inputTickets[entry.id] = InputTicket(previous: inputTails[owner], completion: receipt)
                inputTails[owner] = receipt
            case .stop, .shutdown: admissionClosed = true; if finishedStop == nil { power = .stopping }
            default: break
            }
            Task { do { try await self.perform(entry.id, request) } catch { self.failed(entry.id, error) } }
        } catch { failed(entry.id, error) }
    }
    /// Embedding cleanup must close admission even if every event receipt slot is occupied.
    /// It cannot release ownership or invent a completion without a reserved receipt.
    public nonisolated func requestCleanup() { Task { await self.ensureStop() } }
    private func ensureStop() {
        guard finishedStop == nil else { return }
        admissionClosed = true; power = .stopping
        guard !stopStarted else { return }
        stopStarted = true
        // A cleanup request may have no reserved receipt. Its deadline still
        // owns real escalation and cannot depend on stopWaiters capacity.
        cleanupDeadline = Task {
            do { try await Task.sleep(for: .milliseconds(Int(cleanupBudgetMilliseconds))); self.beginForceStop() }
            catch { /* Completed drain cancelled the independent deadline. */ }
        }
        Task { await self.runStop() }
    }
    private func terminal(_ id: UInt64, _ status: NativeTerminalStatus, code: String? = nil, message: String? = nil,
                          exitCode: Int32? = nil, result: [String: String]? = nil) {
        do { try events.emit(id, kind: .terminal, status: status, code: code, message: message, exitCode: exitCode, result: result) }
        catch { try? events.emit(id, kind: .terminal, status: status == .uncertain ? .uncertain : .failed, code: "native_result_invalid", message: "Backend result exceeded the bounded native event contract") }
        cancelled.remove(id)
        if let completion = executionCompletions.removeValue(forKey: id) {
            Task { await completion.finish(status) }
        }
    }
    private func failed(_ id: UInt64, _ error: any Error) {
        defer { updateLifetime() }
        let failure = nativeFailure(error)
        if (error as? ProcessRunFailure)?.cleanupUncertain == true || ["process_creation_uncertain", "process_cleanup_uncertain"].contains(failure?.code ?? "") {
            admissionClosed = true
            if finishedStop?.terminationConfirmed != true { power = .uncertain }
            terminal(id, .uncertain, code: "process_cleanup_uncertain", message: boundedMessage(error.localizedDescription))
        } else if (error is CancellationError || cancelled.contains(id)) && !["output_completion_unproven", "output_backpressure"].contains(failure?.code ?? "") {
            terminal(id, .cancelled, code: "cancelled", message: "Operation cancelled under its owning task")
        } else {
            if power == .starting && id == startOperationId {
                admissionClosed = true
                power = failure?.code == "cowork_gate_blocked" || failure?.launchNeverCreated == true ? .closed : .uncertain
            }
            terminal(id, .failed, code: failure?.code ?? "native_error", message: boundedMessage(error.localizedDescription))
        }
    }
    private func boundedMessage(_ text: String) -> String { String(decoding: Array(text.utf8.prefix(2045)), as: UTF8.self) }
    private func nativeFailure(_ error: any Error) -> NativeFailure? {
        if let failure = error as? NativeFailure { return failure }
        if let failure = error as? ProbeFailure { return NativeFailure(failure.code, failure.message) }
        if let failure = error as? ProcessRunFailure, let code = failure.originalCode { return NativeFailure(code, failure.original) }
        return nil
    }
    private func validate(_ request: NativeRequest) throws {
        guard request.scope.protocolVersion == scope.protocolVersion else { throw NativeFailure("protocol_mismatch", "Native protocol version differs") }
        guard request.scope == scope else { throw NativeFailure("stale_authority", "Workspace/incarnation/grant revision/lease epoch differs from registered host authority") }
        if admissionClosed && ![.capabilities, .stats, .stop, .shutdown, .cancel].contains(request.kind) {
            throw NativeFailure("controller_draining", "Native controller admission is closed")
        }
    }
    private func target(_ request: NativeRequest) async throws -> (UInt64, any NativeGuestProcess) {
        if let text = request.ownerOperationId, let id = UInt64(text), let task = openingOwners[id] {
            guard request.taskId == task else { throw NativeFailure("task_ownership_denied", "Pending process belongs to a different task") }
            await withCheckedContinuation { registrationWaiters[id, default: []].append($0) }
        }
        guard let text = request.ownerOperationId, let id = UInt64(text), let entry = processes[id],
              let task = request.taskId, task == entry.0 else {
            throw NativeFailure("task_ownership_denied", "Input/cancel requires the target operation's owning authenticated task")
        }
        return (id, entry.1)
    }
    private func perform(_ id: UInt64, _ request: NativeRequest) async throws {
        defer { updateLifetime() }
        switch request.kind {
        case .capabilities:
            terminal(id, .completed, result: ["protocolVersion": "1", "power": power.rawValue, "network": "disabled-until-host-endpoint", "controllerTopology": "in-process", "productionLaunch": "gated", "eventChannel": "bounded-native-FD", "containerizationRevision": NativeCompiledGraph.identity.containerizationRevision, "containerizationPatchSha256": NativeCompiledGraph.identity.patchSha256 ?? "none", "pid": String(ProcessInfo.processInfo.processIdentifier)])
        case .start:
            defer { starting = false; let waiters = startWaiters; startWaiters.removeAll(); waiters.forEach { $0.resume() } }
            await backend.observeLifecycle { [weak self] event in await self?.backendChanged(event) }
            try await backend.start()
            if admissionClosed { throw NativeFailure("start_interrupted", "Start completed after shutdown admission closed") }
            power = .running; terminal(id, .completed)
        case .exec:
            let task = request.taskId!, args = request.arguments!
            let process: any NativeGuestProcess
            do { process = try await backend.process(taskId: task, arguments: args) }
            catch { openingOwners.removeValue(forKey: id); processOpened(id); throw error }
            processes[id] = (task, process); openingOwners.removeValue(forKey: id); processOpened(id)
            defer { inputTails.removeValue(forKey: id); processes.removeValue(forKey: id); if processes.isEmpty { let waiters = executionWaiters; executionWaiters.removeAll(); waiters.forEach { $0.resume() } } }
            if admissionClosed || cancelled.contains(id) { try await process.cancel(); throw CancellationError() }
            try events.emit(id, kind: .processRegistered)
            let channel = events
            let exit = try await process.run { kind, data in
                for start in stride(from: data.startIndex, to: data.endIndex, by: 16 * 1024) {
                    try channel.emit(id, kind: kind, bytes: Array(data[start..<min(data.endIndex, start + 16 * 1024)]))
                }
            }
            terminal(id, cancelled.contains(id) ? .cancelled : .completed, exitCode: exit, result: await process.completionMetadata())
        case .cancel:
            guard let text = request.ownerOperationId, let owner = UInt64(text),
                  let completion = executionCompletions[owner] else {
                throw NativeFailure("task_ownership_denied", "Cancellation requires a live owning operation")
            }
            if let task = openingOwners[owner] {
                guard request.taskId == task else { throw NativeFailure("task_ownership_denied", "Pending process belongs to a different task") }
                cancelled.insert(owner)
                let status = await completion.wait()
                terminal(id, status == .uncertain ? .uncertain : .completed,
                         code: status == .uncertain ? "process_cleanup_uncertain" : nil,
                         result: ["cleanupConfirmed": String(status != .uncertain)])
                return
            }
            guard let (task, process) = processes[owner], request.taskId == task else {
                throw NativeFailure("task_ownership_denied", "Cancellation requires the process's authenticated task")
            }
            cancelled.insert(owner)
            do { try await process.cancel() }
            catch { throw NativeFailure("process_cleanup_uncertain", "Process cancellation could not confirm cleanup") }
            let status = await completion.wait()
            terminal(id, status == .uncertain ? .uncertain : .completed,
                     code: status == .uncertain ? "process_cleanup_uncertain" : nil,
                     result: ["cleanupConfirmed": String(status != .uncertain)])
        case .input:
            await awaitInputTurn(id)
            defer { finishInputTurn(id) }
            let (_, process) = try await target(request)
            guard let encoded = request.inputBase64, encoded.utf8.count <= 24 * 1024,
                  let data = Data(base64Encoded: encoded), data.count <= 16 * 1024 else {
                throw NativeFailure("invalid_input", "Input is a base64 chunk of at most 16 KiB")
            }
            try await process.writeInput(data); terminal(id, .completed, result: ["acceptedBytes": String(data.count)])
        case .closeInput:
            await awaitInputTurn(id)
            defer { finishInputTurn(id) }
            let (_, process) = try await target(request); try await process.closeInput(); terminal(id, .completed)
        case .stats:
            if power == .uncertain || power == .closed || power == .stopping {
                terminal(id, .completed, result: ["power": power.rawValue, "admissionClosed": String(admissionClosed), "backendFailure": backendFailure?.rawValue ?? "none"]); return
            }
            try deviceGate.begin(); defer { deviceGate.finish() }
            terminal(id, .completed, result: try await backend.stats())
        case .balloon:
            guard power == .running, let bytes = request.memoryAllowanceBytes else { throw NativeFailure("memory_refused", "Running guest and allowance required") }
            try deviceGate.begin(); defer { deviceGate.finish() }
            terminal(id, .completed, result: try await backend.setMemoryAllowance(bytes))
        case .stop, .shutdown:
            if let finishedStop {
                terminal(id, finishedStop.terminationConfirmed && finishedStop.flushConfirmed ? .completed : .uncertain,
                         result: ["terminationConfirmed": String(finishedStop.terminationConfirmed), "flushConfirmed": String(finishedStop.flushConfirmed)]); return
            }
            admissionClosed = true; power = .stopping; stopWaiters.insert(id)
            let budget = min(max(request.stopBudgetMilliseconds ?? 30_000, 1), 30_000)
            stopDeadlines[id] = Task {
                do { try await Task.sleep(for: .milliseconds(Int(budget))); self.stopTimedOut(id) }
                catch { /* Confirmed stop cancelled this budget watcher. */ }
            }
            ensureStop()
        }
    }
    private func awaitInputTurn(_ id: UInt64) async {
        if let previous = inputTickets[id]?.previous { _ = await previous.wait() }
    }
    private func finishInputTurn(_ id: UInt64) {
        if let ticket = inputTickets.removeValue(forKey: id) { Task { await ticket.completion.finish(.completed) } }
        if inputTickets.isEmpty { let waiters = inputDrainWaiters; inputDrainWaiters.removeAll(); waiters.forEach { $0.resume() } }
    }
    private func backendChanged(_ event: BackendLifecycleEvent) {
        guard !(finishedStop?.terminationConfirmed == true && finishedStop?.flushConfirmed == true) else { return }
        backendFailure = event; admissionClosed = true
        ensureStop()
        power = .uncertain // Stopped/crashed hardware cannot invent clean guest flush.
        updateLifetime()
    }
    private func processOpened(_ id: UInt64) {
        registrationWaiters.removeValue(forKey: id)?.forEach { $0.resume() }
        openingProcesses -= 1
        if openingProcesses == 0 { let waiters = openingWaiters; openingWaiters.removeAll(); waiters.forEach { $0.resume() } }
    }
    private func drainProcessOpening() async {
        if openingProcesses > 0 { await withCheckedContinuation { openingWaiters.append($0) } }
    }
    private func runStop() async {
        defer { stopDrainFinished = true; reconcileStopProof(); updateLifetime() }
        await deviceGate.closeAndDrain()
        if starting { await withCheckedContinuation { startWaiters.append($0) } }
        await drainProcessOpening()
        let live = processes.map { ($0.key, $0.value) }
        for (id, _) in live { cancelled.insert(id) }
        await withTaskGroup(of: Void.self) { group in
            for (_, entry) in live { group.addTask { try? await entry.1.cancel() } }
        }
        if !processes.isEmpty { await withCheckedContinuation { executionWaiters.append($0) } }
        if !inputTickets.isEmpty { await withCheckedContinuation { inputDrainWaiters.append($0) } }
        do {
            let result = try await backend.stop()
            finishedStop = result
            if !result.terminationConfirmed { beginForceStop() }
            power = result.terminationConfirmed && result.flushConfirmed ? .closed : .uncertain
            for id in stopWaiters {
                terminal(id, result.terminationConfirmed && result.flushConfirmed ? .completed : .uncertain,
                         code: result.terminationConfirmed ? nil : "termination_uncertain",
                         result: ["terminationConfirmed": String(result.terminationConfirmed), "flushConfirmed": String(result.flushConfirmed)])
            }
        } catch {
            finishedStop = BackendStopResult(terminationConfirmed: false, flushConfirmed: false)
            beginForceStop()
            power = .uncertain
            for id in stopWaiters { terminal(id, .uncertain, code: "termination_uncertain", message: boundedMessage(error.localizedDescription)) }
        }
        stopWaiters.removeAll()
        stopDeadlines.values.forEach { $0.cancel() }; stopDeadlines.removeAll()
        cleanupDeadline?.cancel(); cleanupDeadline = nil
    }
    private func stopTimedOut(_ id: UInt64) {
        defer { updateLifetime() }
        guard stopWaiters.remove(id) != nil else { return }
        stopDeadlines.removeValue(forKey: id)
        power = .uncertain
        beginForceStop()
        terminal(id, .uncertain, code: "stop_budget_exhausted", message: "Stop budget expired; native cleanup remains owned and no disk reattachment is authorized")
    }
    private func beginForceStop() {
        guard !forceStopStarted, !(stopDrainFinished && finishedStop?.terminationConfirmed == true && finishedStop?.flushConfirmed == true) else { return }
        forceStopStarted = true; forceStopInFlight = true; power = .uncertain
        updateLifetime()
        forceStopTask = Task { await self.runForceStop() }
    }
    private func runForceStop() async {
        defer { forceStopInFlight = false; forceStopTask = nil; reconcileStopProof(); updateLifetime() }
        do { forceStopProof = try await backend.forceStop() }
        catch { /* Escalation failed: graceful drain stays owned; no fabricated proof. */ }
    }
    private func reconcileStopProof() {
        // Hardware force-stop can finish before pending run/cancel/start/device
        // effects. Even full host proof cannot release while that drain is live.
        guard stopDrainFinished, let proof = forceStopProof,
              proof.terminationConfirmed && proof.flushConfirmed else { return }
        finishedStop = proof; power = .closed
    }
    public func state() -> NativePowerState { power }
    private func updateLifetime() { lifetime.update(power == .closed && inputTickets.isEmpty && processes.isEmpty && openingProcesses == 0 && !starting && !forceStopInFlight && (!stopStarted || stopDrainFinished)) }
}
