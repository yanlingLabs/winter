import Foundation
import WinterCoworkPrimitives

public enum NativePowerState: String, Sendable { case stopped, starting, running, stopping, uncertain, closed }

public final class NativeLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var safe = false
    func update(_ value: Bool) { lock.lock(); safe = value; lock.unlock() }
    public func canRelease() -> Bool { lock.lock(); defer { lock.unlock() }; return safe }
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
    private var power: NativePowerState = .stopped
    private var admissionClosed = false
    private var startedOnce = false
    private var processes: [UInt64: (String, any NativeGuestProcess)] = [:]
    private var cancelled: Set<UInt64> = []
    private var openingProcesses = 0
    private var openingWaiters: [CheckedContinuation<Void, Never>] = []
    private var stopWaiters: Set<UInt64> = []
    private var stopStarted = false
    private var finishedStop: BackendStopResult?
    private var openingOwners: [UInt64: String] = [:]
    private var starting = false
    private var startOperationId: UInt64?
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var stopDeadlines: [UInt64: Task<Void, Never>] = [:]

    public init(scope: NativeScope, backend: any NativeWorkspaceBackend) throws {
        guard scope.protocolVersion == 1, !scope.workspaceId.isEmpty, !scope.incarnationId.isEmpty,
              scope.workspaceId.utf8.count <= 128, scope.incarnationId.utf8.count <= 128,
              scope.grantRevision <= 9_007_199_254_740_991, scope.leaseEpoch <= 9_007_199_254_740_991 else {
            throw NativeFailure("invalid_scope", "Versioned host workspace/incarnation scope is required")
        }
        self.scope = scope; self.backend = backend; events = try NativeEventChannel(scope: scope)
    }
    public nonisolated func submit(_ json: String) -> UInt64 {
        guard json.utf8.count <= 64 * 1024 else { return 0 }
        let decoded = Result { try JSONDecoder().decode(NativeRequest.self, from: Data(json.utf8)) }
        let kind = try? decoded.get().kind
        let reservation: NativeEventChannel.Reservation = [.stop, .shutdown].contains(kind) ? .shutdown : ([.cancel, .input, .closeInput].contains(kind) ? .control : .ordinary)
        guard let id = events.reserve(reservation) else { return 0 }
        Task {
            do {
                let request = try decoded.get()
                try await self.perform(id, request)
            } catch { await self.failed(id, error) }
        }
        return id
    }
    /// Embedding cleanup must close admission even if every event receipt slot is occupied.
    /// It cannot release ownership or invent a completion without a reserved receipt.
    public nonisolated func requestCleanup() { Task { await self.ensureStop() } }
    private func ensureStop() {
        guard finishedStop == nil else { return }
        admissionClosed = true; power = .stopping
        guard !stopStarted else { return }
        stopStarted = true
        Task { await self.runStop() }
    }
    private func terminal(_ id: UInt64, _ status: NativeTerminalStatus, code: String? = nil, message: String? = nil,
                          exitCode: Int32? = nil, result: [String: String]? = nil) {
        do { try events.emit(id, kind: .terminal, status: status, code: code, message: message, exitCode: exitCode, result: result) }
        catch { try? events.emit(id, kind: .terminal, status: status == .uncertain ? .uncertain : .failed, code: "native_result_invalid", message: "Backend result exceeded the bounded native event contract") }
        cancelled.remove(id)
    }
    private func failed(_ id: UInt64, _ error: any Error) {
        defer { updateLifetime() }
        let failure = error as? NativeFailure
        if (error as? ProcessRunFailure)?.cleanupUncertain == true || ["process_creation_uncertain", "process_cleanup_uncertain"].contains(failure?.code ?? "") {
            admissionClosed = true; power = .uncertain
            terminal(id, .uncertain, code: "process_cleanup_uncertain", message: String(error.localizedDescription.prefix(2048)))
        } else if error is CancellationError || cancelled.contains(id) {
            terminal(id, .cancelled, code: "cancelled", message: "Operation cancelled under its owning task")
        } else {
            if power == .starting && id == startOperationId {
                admissionClosed = true
                power = failure?.code == "cowork_gate_blocked" ? .closed : .uncertain
            }
            terminal(id, .failed, code: failure?.code ?? "native_error", message: String(error.localizedDescription.prefix(2048)))
        }
    }
    private func validate(_ request: NativeRequest) throws {
        guard request.scope.protocolVersion == scope.protocolVersion else { throw NativeFailure("protocol_mismatch", "Native protocol version differs") }
        guard request.scope == scope else { throw NativeFailure("stale_authority", "Workspace/incarnation/grant revision/lease epoch differs from registered host authority") }
        if admissionClosed && ![.capabilities, .stats, .stop, .shutdown, .cancel].contains(request.kind) {
            throw NativeFailure("controller_draining", "Native controller admission is closed")
        }
    }
    private func target(_ request: NativeRequest) throws -> (UInt64, any NativeGuestProcess) {
        guard let text = request.ownerOperationId, let id = UInt64(text), let entry = processes[id],
              let task = request.taskId, task == entry.0 else {
            throw NativeFailure("task_ownership_denied", "Input/cancel requires the target operation's owning authenticated task")
        }
        return (id, entry.1)
    }
    private func perform(_ id: UInt64, _ request: NativeRequest) async throws {
        defer { updateLifetime() }
        try validate(request)
        try events.emit(id, kind: .accepted)
        switch request.kind {
        case .capabilities:
            terminal(id, .completed, result: ["protocolVersion": "1", "power": power.rawValue, "network": "disabled-until-host-endpoint", "controllerTopology": "in-process", "productionLaunch": "gated", "eventChannel": "bounded-native-FD", "pid": String(ProcessInfo.processInfo.processIdentifier)])
        case .start:
            guard !startedOnce, power == .stopped else { throw NativeFailure("incarnation_used", "A host incarnation may start only once") }
            startedOnce = true; power = .starting; startOperationId = id
            starting = true
            defer { starting = false; let waiters = startWaiters; startWaiters.removeAll(); waiters.forEach { $0.resume() } }
            try await backend.start()
            if admissionClosed { throw NativeFailure("start_interrupted", "Start completed after shutdown admission closed") }
            power = .running; terminal(id, .completed)
        case .exec:
            guard power == .running, let task = request.taskId, !task.isEmpty, task.utf8.count <= 128,
                  let args = request.arguments, !args.isEmpty, args.count <= 256,
                  args.allSatisfy({ !$0.contains("\0") }), args.reduce(0, { $0 + $1.utf8.count }) <= 32 * 1024 else {
                throw NativeFailure("execution_refused", "Running guest, owning task and bounded arguments required")
            }
            openingProcesses += 1
            openingOwners[id] = task
            let process: any NativeGuestProcess
            do { process = try await backend.process(taskId: task, arguments: args) }
            catch { openingOwners.removeValue(forKey: id); processOpened(); throw error }
            processes[id] = (task, process); openingOwners.removeValue(forKey: id); processOpened()
            defer { processes.removeValue(forKey: id) }
            if admissionClosed || cancelled.contains(id) { try await process.cancel(); throw CancellationError() }
            try events.emit(id, kind: .processRegistered)
            let channel = events
            let exit = try await process.run { kind, data in
                for start in stride(from: 0, to: data.count, by: 16 * 1024) {
                    try channel.emit(id, kind: kind, bytes: Array(data[start..<min(data.count, start + 16 * 1024)]))
                }
            }
            terminal(id, cancelled.contains(id) ? .cancelled : .completed, exitCode: exit)
        case .cancel:
            if let text = request.ownerOperationId, let owner = UInt64(text), let task = openingOwners[owner] {
                guard request.taskId == task else { throw NativeFailure("task_ownership_denied", "Pending process belongs to a different task") }
                cancelled.insert(owner); terminal(id, .completed); return
            }
            let (owner, process) = try target(request)
            cancelled.insert(owner); try await process.cancel(); terminal(id, .completed)
        case .input:
            let (_, process) = try target(request)
            guard let encoded = request.inputBase64, encoded.utf8.count <= 24 * 1024,
                  let data = Data(base64Encoded: encoded), data.count <= 16 * 1024 else {
                throw NativeFailure("invalid_input", "Input is a base64 chunk of at most 16 KiB")
            }
            try await process.writeInput(data); terminal(id, .completed, result: ["acceptedBytes": String(data.count)])
        case .closeInput:
            let (_, process) = try target(request); try await process.closeInput(); terminal(id, .completed)
        case .stats:
            if power == .uncertain || power == .closed || power == .stopping {
                terminal(id, .completed, result: ["power": power.rawValue, "admissionClosed": String(admissionClosed)]); return
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
    private func processOpened() {
        openingProcesses -= 1
        if openingProcesses == 0 { let waiters = openingWaiters; openingWaiters.removeAll(); waiters.forEach { $0.resume() } }
    }
    private func drainProcessOpening() async {
        if openingProcesses > 0 { await withCheckedContinuation { openingWaiters.append($0) } }
    }
    private func runStop() async {
        defer { updateLifetime() }
        await deviceGate.closeAndDrain()
        if starting { await withCheckedContinuation { startWaiters.append($0) } }
        await drainProcessOpening()
        let live = processes.map { ($0.key, $0.value) }
        for (id, entry) in live { cancelled.insert(id); try? await entry.1.cancel() }
        do {
            let result = try await backend.stop()
            finishedStop = result
            power = result.terminationConfirmed ? .closed : .uncertain
            for id in stopWaiters {
                terminal(id, result.terminationConfirmed && result.flushConfirmed ? .completed : .uncertain,
                         code: result.terminationConfirmed ? nil : "termination_uncertain",
                         result: ["terminationConfirmed": String(result.terminationConfirmed), "flushConfirmed": String(result.flushConfirmed)])
            }
        } catch {
            finishedStop = BackendStopResult(terminationConfirmed: false, flushConfirmed: false)
            power = .uncertain
            for id in stopWaiters { terminal(id, .uncertain, code: "termination_uncertain", message: String(error.localizedDescription.prefix(2048))) }
        }
        stopWaiters.removeAll()
        stopDeadlines.values.forEach { $0.cancel() }; stopDeadlines.removeAll()
    }
    private func stopTimedOut(_ id: UInt64) {
        defer { updateLifetime() }
        guard stopWaiters.remove(id) != nil else { return }
        stopDeadlines.removeValue(forKey: id)
        power = .uncertain
        terminal(id, .uncertain, code: "stop_budget_exhausted", message: "Stop budget expired; native cleanup remains owned and no disk reattachment is authorized")
    }
    public func state() -> NativePowerState { power }
    private func updateLifetime() { lifetime.update(power == .closed && processes.isEmpty && openingProcesses == 0 && !starting) }
}
