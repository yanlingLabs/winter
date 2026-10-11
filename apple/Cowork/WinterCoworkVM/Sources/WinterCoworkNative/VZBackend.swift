import Foundation
import CryptoKit
import Darwin
import Containerization
import ContainerizationOCI
import ContainerizationExtras
import Virtualization
import WinterCoworkPrimitives

private struct PolicyExtension: VZInstanceExtension {
    let policies: [HostSharePolicy]
    let didConstruct: @Sendable () -> Void
    func didCreate(_ instance: VZVirtualMachineInstance) throws { didConstruct() }
    func configureVZ(_ config: inout VZVirtualMachineConfiguration, allocator: any AddressAllocator<Character>,
                     storageDeviceCount: Int, mountsByID: [String: [Containerization.Mount]]) throws {
        guard config.networkDevices.isEmpty else { throw NativeFailure("network_not_admitted", "No NIC may bypass the future host-owned endpoint") }
        try SharePolicy.assertBuilt(config, expected: policies, mountsByID: mountsByID)
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
    }
}
/// VZ's delegate is weak. The manager retains this queue-bound forwarding
/// observer and preserves every callback of any existing delegate.
private final class WorkspaceVZObserver: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
    let previous: (any VZVirtualMachineDelegate)?
    let observed: @Sendable (BackendLifecycleEvent) -> Void
    init(previous: (any VZVirtualMachineDelegate)?, observed: @escaping @Sendable (BackendLifecycleEvent) -> Void) {
        self.previous = previous; self.observed = observed
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        observed(.guestStopped); previous?.guestDidStop?(virtualMachine)
    }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: any Error) {
        observed(.stoppedWithError); previous?.virtualMachine?(virtualMachine, didStopWithError: error)
    }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, networkDevice: VZNetworkDevice, attachmentWasDisconnectedWithError error: any Error) {
        observed(.networkDisconnected)
        previous?.virtualMachine?(virtualMachine, networkDevice: networkDevice, attachmentWasDisconnectedWithError: error)
    }
}
private final class WorkspaceVZManager: VirtualMachineManager, @unchecked Sendable {
    let descriptor: HostLaunchDescriptor
    let policies: [HostSharePolicy]
    private let lock = NSLock()
    private var vm: VZVirtualMachineInstance?
    private var attempted = false
    private var expectedStop = false
    private var unexpectedStop = false
    private var observer: WorkspaceVZObserver?
    private let lifecycle: @Sendable (BackendLifecycleEvent) -> Void
    func markExpectedStop() { lock.lock(); expectedStop = true; lock.unlock() }
    func stoppedUnexpectedly() -> Bool { lock.lock(); defer { lock.unlock() }; return unexpectedStop }
    private func observe(_ event: BackendLifecycleEvent) {
        lock.lock()
        let unexpected = event != .guestStopped || !expectedStop
        if unexpected { unexpectedStop = true }
        lock.unlock()
        if unexpected { lifecycle(event) }
    }
    func creationAttempted() -> Bool { lock.lock(); defer { lock.unlock() }; return attempted }
    private func markAttempted() { lock.lock(); attempted = true; lock.unlock() }
    init(_ descriptor: HostLaunchDescriptor, policies: [HostSharePolicy], lifecycle: @escaping @Sendable (BackendLifecycleEvent) -> Void) { self.descriptor = descriptor; self.policies = policies; self.lifecycle = lifecycle }
    func instance() -> VZVirtualMachineInstance? { lock.lock(); defer { lock.unlock() }; return vm }
    private func remember(_ vm: VZVirtualMachineInstance) { lock.lock(); self.vm = vm; lock.unlock() }
    func create(config: some VMCreationConfig) async throws -> any VirtualMachineInstance {
        let input = config.configuration
        guard input.interfaces.isEmpty, !input.nestedVirtualization else { throw NativeFailure("network_not_admitted", "Unsupported network/nested VM configuration") }
        let vm = try VZVirtualMachineInstance { settings in
            settings.cpus = input.cpus; settings.memoryInBytes = input.memoryInBytes
            settings.kernel = Kernel(path: URL(fileURLWithPath: descriptor.kernel.path), platform: .linuxArm)
            settings.initialFilesystem = .block(format: "ext4", source: descriptor.initfs.path, destination: "/", options: ["ro"])
            settings.mountsByID = input.mountsByID; settings.interfaces = []
            settings.extensions = [PolicyExtension(policies: policies, didConstruct: { [weak self] in self?.markAttempted() })]
        }
        remember(vm)
        await withCheckedContinuation { continuation in
            vm.vmQueue.async {
                let observer = WorkspaceVZObserver(previous: vm.vzVirtualMachine.delegate) { [weak self] event in self?.observe(event) }
                self.lock.lock(); self.observer = observer; self.lock.unlock()
                vm.vzVirtualMachine.delegate = observer
                continuation.resume()
            }
        }
        return vm
    }
}

/// Real in-process VZ implementation behind an injected host authority/admission
/// owner. Default admission refuses before any artifact or folder is accessed.
/// Production Node-API currently uses BlockedWorkspaceBackend; wiring a passed
/// host gate/authority service is a separate, explicit composition step.
public actor VZWorkspaceBackend: NativeWorkspaceBackend {
    private let descriptor: HostLaunchDescriptor
    private let admission: any HostLaunchAdmission
    private var container: LinuxContainer?
    private var manager: WorkspaceVZManager?
    private var processes: [String: VZGuestProcess] = [:]
    private var launchAttempted = false
    private var launchInFlight = false
    private let reservation: UnstartedReservation
    private var forceRequested = false
    private var confirmedStop: BackendStopResult?
    private var cleanConfirmation: Task<BackendStopResult, Never>?
    private var lifecycleObserver: (@Sendable (BackendLifecycleEvent) async -> Void)?
    public func observeLifecycle(_ observer: @escaping @Sendable (BackendLifecycleEvent) async -> Void) async { lifecycleObserver = observer }
    private func observedLifecycle(_ event: BackendLifecycleEvent) async {
        guard confirmedStop == nil else { return }
        // Observation proves neither flush nor host effects. Close controller
        // admission immediately, then ask the host to retain durable ownership.
        await lifecycleObserver?(event)
        guard confirmedStop == nil, cleanConfirmation == nil else { return }
        await admission.retainUncertainOwnership(descriptor, reason: "VZ lifecycle stopped unexpectedly: " + event.rawValue)
    }
    public init(descriptor: HostLaunchDescriptor, admission: any HostLaunchAdmission = FeatureBlockedAdmission()) {
        self.descriptor = descriptor; self.admission = admission
        self.reservation = UnstartedReservation(descriptor: descriptor, admission: admission)
    }
    private func identity(_ path: String, expected: HostFileIdentity, directory: Bool) throws {
        let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        var st = stat()
        guard path.hasPrefix("/"), canonical == path, lstat(path, &st) == 0,
              UInt64(bitPattern: Int64(st.st_dev)) == expected.device, st.st_ino == expected.inode,
              st.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFREG), directory || st.st_nlink == 1 else {
            throw NativeFailure("host_identity_mismatch", "Host artifact/source identity no longer matches authenticated descriptor")
        }
    }
    private func artifact(_ file: HostArtifact) throws {
        try identity(file.path, expected: file.identity, directory: false)
        guard file.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw NativeFailure("artifact_digest_required", "Pinned host artifact SHA256 required") }
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: file.path)); defer { try? handle.close() }
        var hash = SHA256()
        while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty { hash.update(data: bytes) }
        guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == file.sha256 else { throw NativeFailure("artifact_digest_mismatch", "Pinned artifact digest differs") }
    }
    public func start() async throws {
        guard !launchAttempted else { throw NativeFailure("incarnation_used", "Real backend launch may not be replayed") }
        launchAttempted = true; launchInFlight = true
        defer { launchInFlight = false }
        // This callback must use canonical host authority and shared ownership;
        // it is never fulfilled by a guest JSON field or mutable manifest.
        do {
            try await reservation.acquire()
            guard !forceRequested else { throw NativeFailure("start_interrupted", "Host stop deadline closed launch before VM construction") }
            guard NativeCompiledGraph.identity.patchSha256 != nil else { throw NativeFailure("cowork_output_gate_blocked", "Real production launch requires the verified output-completion build profile") }
            guard descriptor.compiledGraph == NativeCompiledGraph.identity else { throw NativeFailure("native_graph_mismatch", "Host descriptor does not match the compiled source/patch graph") }
            guard descriptor.scope.protocolVersion == 1, descriptor.virtualCPUs >= 1,
                  descriptor.scope.incarnationId.range(of: "^[A-Za-z0-9_-]{1,40}$", options: .regularExpression) != nil,
                  descriptor.virtualCPUs <= ProcessInfo.processInfo.activeProcessorCount,
                  descriptor.memoryCeilingBytes >= VZVirtualMachineConfiguration.minimumAllowedMemorySize,
                  descriptor.memoryCeilingBytes <= VZVirtualMachineConfiguration.maximumAllowedMemorySize,
                  descriptor.memoryCeilingBytes % (1024 * 1024) == 0,
                  !descriptor.supervisorArguments.isEmpty, descriptor.supervisorArguments.count <= 256,
                  descriptor.supervisorArguments.allSatisfy({ !$0.contains("\0") }),
                  descriptor.supervisorArguments.reduce(0, { $0 + $1.utf8.count }) <= 32 * 1024 else { throw NativeFailure("invalid_launch_descriptor", "Validated resources and immutable supervisor arguments required") }
            let root = URL(fileURLWithPath: descriptor.ownedStorageRoot).resolvingSymlinksInPath().standardizedFileURL.path
            guard root == descriptor.ownedStorageRoot, descriptor.rootfs.path.hasPrefix(root + "/") else { throw NativeFailure("storage_scope_mismatch", "Writable rootfs must belong to authenticated owned storage") }
            guard descriptor.currentHostHome.homeId == descriptor.homeId, !descriptor.protectedHomes.isEmpty else { throw NativeFailure("home_identity_required", "Current and protected Winter homes require authenticated identity") }
            for home in [descriptor.currentHostHome] + descriptor.protectedHomes { try identity(home.path, expected: home.identity, directory: true) }
            let backingIdentities = [descriptor.kernel, descriptor.initfs, descriptor.rootfs].map { "\($0.identity.device):\($0.identity.inode)" }
            guard Set(backingIdentities).count == 3 else { throw NativeFailure("backing_alias_refused", "Kernel, initfs and writable rootfs require distinct identities") }
            try artifact(descriptor.kernel); try artifact(descriptor.initfs)
            try identity(descriptor.rootfs.path, expected: descriptor.rootfs.identity, directory: false)
            let policies = descriptor.shares.map { HostSharePolicy(sourcePath: $0.path, guestPath: $0.guestPath, readOnly: $0.readOnly, managedRole: $0.managedRole) }
            for share in descriptor.shares {
                try identity(share.path, expected: share.identity, directory: true)
                if let role = share.managedRole {
                    guard descriptor.managedSharedDirectories.filter({ $0.sourceId == share.sourceId && $0.path == share.path && $0.identity == share.identity && $0.role == role }).count == 1 else { throw NativeFailure("managed_share_not_authorized", "Managed share must match a separate exact host authority record") }
                }
            }
            let managedShares = descriptor.managedSharedDirectories.map { HostManagedShareRecord(path: $0.path, role: $0.role, device: $0.identity.device, inode: $0.identity.inode) }
            let protectedRecords = ([descriptor.currentHostHome] + descriptor.protectedHomes).map { HostProtectedRootRecord(path: $0.path, device: $0.identity.device, inode: $0.identity.inode) }
            try SharePolicy.validate(policies, backing: [descriptor.kernel, descriptor.initfs, descriptor.rootfs].map { URL(fileURLWithPath: $0.path) }, protectedHostRoots: ([descriptor.currentHostHome] + descriptor.protectedHomes).map(\.path), managedShares: managedShares, protectedRootRecords: protectedRecords)
            let manager = WorkspaceVZManager(descriptor, policies: policies) { [weak self] event in Task { await self?.observedLifecycle(event) } }
            var config = LinuxContainer.Configuration()
            config.cpus = descriptor.virtualCPUs; config.memoryInBytes = descriptor.memoryCeilingBytes
            config.mounts.append(contentsOf: policies.map(\.mount)); config.interfaces = []
            config.process.arguments = descriptor.supervisorArguments
            // This is the trusted immutable supervisor, never an ordinary tool.
            config.process.capabilities = .allCapabilities
            let container = try LinuxContainer("ws-" + String(descriptor.scope.incarnationId.prefix(40)),
                rootfs: .block(format: "ext4", source: descriptor.rootfs.path, destination: "/"), vmm: manager,
                vm: VMResources(cpus: descriptor.virtualCPUs, memoryInBytes: descriptor.memoryCeilingBytes), configuration: config)
            self.manager = manager; self.container = container
            try await container.create()
            guard !forceRequested else { throw NativeFailure("start_interrupted", "Host force-stop interrupted guest construction") }
            try await container.start()
            guard !forceRequested else { throw NativeFailure("start_interrupted", "Host force-stop interrupted guest start") }
        } catch {
            if manager?.creationAttempted() == true {
                await admission.retainUncertainOwnership(descriptor, reason: "Native launch failed after VZ construction attempt")
                throw error
            }
            do { try await abortReservationIfNeeded() }
            catch {
                await admission.retainUncertainOwnership(descriptor, reason: "Unstarted host reservation abort could not be confirmed")
                throw NativeFailure("reservation_abort_uncertain", "VM was never constructed but host reservation release remains unproved")
            }
            if let failure = error as? NativeFailure { throw NativeFailure(failure.code, failure.message, launchNeverCreated: true) }
            if let failure = error as? ProbeFailure { throw NativeFailure(failure.code, failure.message, launchNeverCreated: true) }
            throw NativeFailure("launch_validation_failed", "Launch validation failed before any VZ construction attempt", launchNeverCreated: true)
        }
    }
    public func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess {
        guard manager?.stoppedUnexpectedly() != true else { throw NativeFailure("guest_stopped_unexpectedly", "VZ lifecycle closed trusted process admission") }
        try await admission.authorizeProcess(descriptor, taskId: taskId, arguments: arguments)
        guard manager?.stoppedUnexpectedly() != true else { throw NativeFailure("guest_stopped_unexpectedly", "VZ lifecycle closed trusted process admission during host authorization") }
        guard let container else { throw NativeFailure("guest_unavailable", "No admitted guest") }
        let id = UUID().uuidString
        let process = VZGuestProcess(container: container, processId: id, arguments: arguments) { confirmed in await self.processFinished(id, confirmed: confirmed) }
        processes[id] = process
        return process
    }
    private func processFinished(_ id: String, confirmed: Bool) async {
        if confirmed { processes.removeValue(forKey: id) }
        else if manager != nil { await admission.retainUncertainOwnership(descriptor, reason: "Native guest process cleanup is uncertain") }
    }
    public func stats() async throws -> [String: String] { try await deviceSnapshot(target: nil) }
    public func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] {
        guard bytes >= VZVirtualMachineConfiguration.minimumAllowedMemorySize, bytes <= descriptor.memoryCeilingBytes,
              bytes % (1024 * 1024) == 0 else { throw NativeFailure("invalid_memory_allowance", "Memory allowance must be MiB-aligned within the VZ range") }
        return try await deviceSnapshot(target: bytes)
    }
    private func deviceSnapshot(target: UInt64?) async throws -> [String: String] {
        guard let vm = manager?.instance() else { throw NativeFailure("guest_unavailable", "VZ object unavailable") }
        return try await withCheckedThrowingContinuation { continuation in
            vm.vmQueue.async {
                guard let balloon = vm.vzVirtualMachine.memoryBalloonDevices.first as? VZVirtioTraditionalMemoryBalloonDevice else { continuation.resume(throwing: NativeFailure("balloon_unavailable", "Traditional balloon missing")); return }
                if let target { balloon.targetVirtualMachineMemorySize = target }
                continuation.resume(returning: ["vzState": String(vm.vzVirtualMachine.state.rawValue), "requestedGuestAllowanceBytes": String(balloon.targetVirtualMachineMemorySize), "hostReclaimVerified": "false"])
            }
        }
    }
    private func abortReservationIfNeeded() async throws {
        try await reservation.abort(didConstruct: manager?.creationAttempted() == true)
    }
    public func stop() async throws -> BackendStopResult {
        if let confirmedStop { return confirmedStop }
        if let cleanConfirmation { return await cleanConfirmation.value }
        if forceRequested || launchInFlight { return try await forceStop() }
        manager?.markExpectedStop()
        let live = Array(processes.values)
        await withTaskGroup(of: Void.self) { group in for process in live { group.addTask { try? await process.cancel() } } }
        if manager?.creationAttempted() != true {
            try await abortReservationIfNeeded()
            let result = BackendStopResult(terminationConfirmed: true, flushConfirmed: true)
            confirmedStop = result; return result
        }
        var flush = true
        if let container { do { try await container.stop() } catch { flush = false } }
        guard let vm = manager?.instance(), vm.state == .stopped else {
            await admission.retainUncertainOwnership(descriptor, reason: "Native VZ termination not observed")
            return BackendStopResult(terminationConfirmed: false, flushConfirmed: false)
        }
        // A successful host framework stop still cannot release a dirty disk.
        let result: BackendStopResult
        if flush && !forceRequested && manager?.stoppedUnexpectedly() != true {
            let descriptor = self.descriptor, admission = self.admission
            let proof = Task { await CleanStopAuthority.confirm(descriptor, admission: admission, terminationConfirmed: true, flushConfirmed: true) }
            cleanConfirmation = proof
            result = await proof.value
            // Keep this proof owned through actor reentrancy; an escalation
            // observing already-clean stopped hardware must await it rather
            // than re-retaining a reservation that this callback released.
            cleanConfirmation = nil
        } else {
            result = await CleanStopAuthority.confirm(descriptor, admission: admission, terminationConfirmed: true, flushConfirmed: false)
        }
        if result.terminationConfirmed && result.flushConfirmed {
            processes.removeAll(); self.container = nil; self.manager = nil
            confirmedStop = result
        }
        return result
    }
    public func forceStop() async throws -> BackendStopResult {
        if let confirmedStop { return confirmedStop }
        if let cleanConfirmation { return await cleanConfirmation.value }
        forceRequested = true
        manager?.markExpectedStop()
        do { return try await forceHardwareAndDrainLaunch() }
        catch {
            await admission.retainUncertainOwnership(descriptor, reason: "Host force-stop or unstarted reservation cleanup could not be confirmed")
            throw error
        }
    }
    private func forceHardwareAndDrainLaunch() async throws -> BackendStopResult {
        // Independently watch startup too: an initially stopped VZ object is
        // not proof while LinuxContainer.create may still enqueue vm.start.
        while true {
            if let vm = manager?.instance() {
                let stopped = try await stopHardware(vm)
                if stopped && !launchInFlight {
                    await admission.retainUncertainOwnership(descriptor, reason: "Host forced VZ off; flush/recovery and backing effects remain unproved")
                    return BackendStopResult(terminationConfirmed: true, flushConfirmed: false)
                }
            } else if !launchInFlight {
                try await abortReservationIfNeeded()
                return BackendStopResult(terminationConfirmed: true, flushConfirmed: true)
            }
            try await Task.sleep(for: .milliseconds(100))
        }
    }
    private func stopHardware(_ instance: VZVirtualMachineInstance) async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            instance.vmQueue.async {
                let vm = instance.vzVirtualMachine
                if vm.state == .stopped { continuation.resume(returning: true); return }
                guard vm.canStop else {
                    if vm.state == .starting || vm.state == .stopping { continuation.resume(returning: false) }
                    else { continuation.resume(throwing: NativeFailure("force_stop_unavailable", "VZ did not admit host force-stop in its current state")) }
                    return
                }
                // This is the public VZ immediate stop API, deliberately not
                // LinuxContainer.stop or VZInstance.stop's guest/NIO waits.
                vm.stop { error in
                    if error != nil { continuation.resume(throwing: NativeFailure("force_stop_uncertain", "VZ host force-stop completion failed")) }
                    else { continuation.resume(returning: vm.state == .stopped) }
                }
            }
        }
    }
}

final class BoundedInput: ReaderStream, @unchecked Sendable {
    private let streamValue: AsyncStream<Data>
    private let continuation: AsyncStream<Data>.Continuation
    init() { let pair = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingOldest(4)); streamValue = pair.stream; continuation = pair.continuation }
    func stream() -> AsyncStream<Data> { streamValue }
    func write(_ bytes: Data) throws {
        guard bytes.count <= 16 * 1024 else { throw NativeFailure("invalid_input", "Input chunk exceeds 16 KiB") }
        switch continuation.yield(bytes) {
        case .enqueued: return
        case .dropped: throw NativeFailure("input_backpressure", "Guest stdin queue is full")
        case .terminated: throw NativeFailure("input_closed", "Guest stdin is closed")
        @unknown default: throw NativeFailure("input_closed", "Unknown guest stdin state")
        }
    }
    func close() { continuation.finish() }
}
final class OutputFailure: @unchecked Sendable {
    private let lock = NSLock()
    private var value: (any Error)?
    func record(_ error: any Error) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard value == nil else { return false }
        value = error; return true
    }
    func current() -> (any Error)? { lock.lock(); defer { lock.unlock() }; return value }
}
struct OutputWriter: Writer {
    let kind: NativeEventKind
    let output: @Sendable (NativeEventKind, Data) throws -> Void
    let failure: OutputFailure
    let cancel: @Sendable () -> Void
    func write(_ data: Data) throws {
        if let error = failure.current() { throw error }
        do { try output(kind, data) }
        catch { if failure.record(error) { cancel() }; throw error }
    }
    func close() throws {}
}
private actor VZGuestProcess: NativeGuestProcess {
    private let container: LinuxContainer
    private let processId: String
    private let arguments: [String]
    private let input = BoundedInput()
    private var process: LinuxProcess?
    private var cancelled = false
    private var opening = false
    private var runActive = false
    private var completionWaiters: [CheckedContinuation<Void, Never>] = []
    private var escalation: Task<Void, Never>?
    private let finished: @Sendable (Bool) async -> Void
    init(container: LinuxContainer, processId: String, arguments: [String], finished: @escaping @Sendable (Bool) async -> Void) {
        self.container = container; self.processId = processId; self.arguments = arguments; self.finished = finished
    }
    func run(output: @escaping @Sendable (NativeEventKind, Data) throws -> Void) async throws -> Int32 {
        guard !cancelled else { await finished(true); throw CancellationError() }
        runActive = true
        defer { runActive = false; escalation?.cancel(); escalation = nil; let waiters = completionWaiters; completionWaiters.removeAll(); waiters.forEach { $0.resume() } }
        let failure = OutputFailure()
        let cancel: @Sendable () -> Void = { Task { try? await self.cancel() } }
        opening = true
        let process: LinuxProcess
        do {
            process = try await container.exec(processId) { config in
                config.arguments = self.arguments; config.stdin = self.input
                config.stdout = OutputWriter(kind: .stdout, output: output, failure: failure, cancel: cancel)
                config.stderr = OutputWriter(kind: .stderr, output: output, failure: failure, cancel: cancel)
                config.capabilities = .allCapabilities // Trusted supervisor/runtime only; not model tools.
            }
        } catch {
            opening = false; await finished(false)
            throw NativeFailure("process_creation_uncertain", "Trusted guest process construction failed; host ownership retained")
        }
        opening = false
        self.process = process
        if cancelled {
            do { try await process.delete(); await finished(true) }
            catch { await finished(false); throw NativeFailure("process_cleanup_uncertain", "Cancelled process cleanup could not be confirmed") }
            throw CancellationError()
        }
        do {
            #if WINTER_COWORK_VERIFIED_EOF
            let exit = try await ProcessLifecycle.run(process, timeout: 86_400, afterWait: { do { try await process.waitForOutputCompletion(timeoutInSeconds: 30) } catch { throw ProbeFailure(code: "output_completion_unproven", message: "Guest stdout/stderr EOF or successful output writes were not confirmed") } })
            #else
            let exit = try await ProcessLifecycle.run(process, timeout: 86_400)
            #endif
            input.close(); self.process = nil; await finished(true)
            if let error = failure.current() { throw error }
            return exit.exitCode
        } catch {
            input.close()
            let uncertain = (error as? ProcessRunFailure)?.cleanupUncertain == true
            await finished(!uncertain)
            if uncertain { throw error }
            if let outputError = failure.current() { throw outputError }
            throw error
        }
    }
    func completionMetadata() async -> [String: String] {
        #if WINTER_COWORK_VERIFIED_EOF
        ["outputCompletion": "verified-eof", "outputPatchSha256": NativeCompiledGraph.identity.patchSha256 ?? ""]
        #else
        ["outputCompletion": "unproven", "outputLimitation": "Pinned LinuxProcess.wait suppresses a three-second stdio completion timeout"]
        #endif
    }
    func writeInput(_ data: Data) async throws { try input.write(data) }
    // LinuxProcess's input relay drains this stream before closing guest stdin.
    // closeStdin() here would cancel that relay and discard acknowledged chunks.
    func closeInput() async throws { input.close() }
    func cancel() async throws {
        cancelled = true; input.close()
        if let process { try? await process.kill(.term) }
        if runActive {
            if escalation == nil {
                escalation = Task {
                    do { try await Task.sleep(for: .seconds(2)); if let process = self.process, self.runActive { try? await process.kill(.kill) } } catch {}
                }
            }
            // The owner run performs wait+delete. A second LinuxProcess.wait
            // would race its single stdio tracker. ACK only after that cleanup.
            await withCheckedContinuation { completionWaiters.append($0) }
        } else if !opening { await finished(true) }
    }
}
