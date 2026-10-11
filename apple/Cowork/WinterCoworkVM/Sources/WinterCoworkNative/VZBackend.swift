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
    func configureVZ(_ config: inout VZVirtualMachineConfiguration, allocator: any AddressAllocator<Character>,
                     storageDeviceCount: Int, mountsByID: [String: [Containerization.Mount]]) throws {
        guard config.networkDevices.isEmpty else { throw NativeFailure("network_not_admitted", "No NIC may bypass the future host-owned endpoint") }
        try SharePolicy.assertBuilt(config, expected: policies, mountsByID: mountsByID)
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
    }
}
private final class WorkspaceVZManager: VirtualMachineManager, @unchecked Sendable {
    let descriptor: HostLaunchDescriptor
    let policies: [HostSharePolicy]
    private let lock = NSLock()
    private var vm: VZVirtualMachineInstance?
    init(_ descriptor: HostLaunchDescriptor, policies: [HostSharePolicy]) { self.descriptor = descriptor; self.policies = policies }
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
            settings.extensions = [PolicyExtension(policies: policies)]
        }
        remember(vm); return vm
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
    public init(descriptor: HostLaunchDescriptor, admission: any HostLaunchAdmission = FeatureBlockedAdmission()) {
        self.descriptor = descriptor; self.admission = admission
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
        launchAttempted = true
        // This callback must use canonical host authority and shared ownership;
        // it is never fulfilled by a guest JSON field or mutable manifest.
        try await admission.authorize(descriptor)
        do {
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
            try artifact(descriptor.kernel); try artifact(descriptor.initfs)
            try identity(descriptor.rootfs.path, expected: descriptor.rootfs.identity, directory: false)
            let policies = descriptor.shares.map { HostSharePolicy(sourcePath: $0.path, guestPath: $0.guestPath, readOnly: $0.readOnly) }
            for share in descriptor.shares { try identity(share.path, expected: share.identity, directory: true) }
            try SharePolicy.validate(policies, backing: [descriptor.kernel, descriptor.initfs, descriptor.rootfs].map { URL(fileURLWithPath: $0.path) })
            let manager = WorkspaceVZManager(descriptor, policies: policies)
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
            try await container.create(); try await container.start()
        } catch {
            await admission.retainUncertainOwnership(descriptor, reason: "Native launch failed after host admission")
            throw error
        }
    }
    public func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess {
        try await admission.authorizeProcess(descriptor, taskId: taskId, arguments: arguments)
        guard let container else { throw NativeFailure("guest_unavailable", "No admitted guest") }
        let id = UUID().uuidString
        let process = VZGuestProcess(container: container, processId: id, arguments: arguments) { confirmed in await self.processFinished(id, confirmed: confirmed) }
        processes[id] = process
        return process
    }
    private func processFinished(_ id: String, confirmed: Bool) async {
        if confirmed { processes.removeValue(forKey: id) }
        else { await admission.retainUncertainOwnership(descriptor, reason: "Native guest process cleanup is uncertain") }
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
    public func stop() async throws -> BackendStopResult {
        let live = Array(processes.values)
        for process in live { try? await process.cancel() }
        var flush = true
        if let container { do { try await container.stop() } catch { flush = false } }
        guard let vm = manager?.instance(), vm.state == .stopped else {
            await admission.retainUncertainOwnership(descriptor, reason: "Native VZ termination not observed")
            return BackendStopResult(terminationConfirmed: false, flushConfirmed: false)
        }
        // A VZ stopped object alone never releases the durable disk owner.
        do { try await admission.confirmStopped(descriptor) }
        catch {
            await admission.retainUncertainOwnership(descriptor, reason: "Host backing termination/ownership proof incomplete")
            return BackendStopResult(terminationConfirmed: false, flushConfirmed: flush)
        }
        processes.removeAll(); self.container = nil; self.manager = nil
        return BackendStopResult(terminationConfirmed: true, flushConfirmed: flush)
    }
}

private final class BoundedInput: ReaderStream, @unchecked Sendable {
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
    private let finished: @Sendable (Bool) async -> Void
    init(container: LinuxContainer, processId: String, arguments: [String], finished: @escaping @Sendable (Bool) async -> Void) {
        self.container = container; self.processId = processId; self.arguments = arguments; self.finished = finished
    }
    func run(output: @escaping @Sendable (NativeEventKind, Data) throws -> Void) async throws -> Int32 {
        guard !cancelled else { await finished(true); throw CancellationError() }
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
            let exit = try await ProcessLifecycle.run(process, timeout: 86_400)
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
    func writeInput(_ data: Data) async throws { try input.write(data) }
    func closeInput() async throws { input.close(); if let process { try await process.closeStdin() } }
    func cancel() async throws {
        cancelled = true; input.close()
        if let process { try? await process.kill(.term); _ = try? await process.wait(timeoutInSeconds: 2); try? await process.kill(.kill) }
        else if !opening { await finished(true) }
    }
}
