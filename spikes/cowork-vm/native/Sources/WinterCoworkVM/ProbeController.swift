import Foundation
import Containerization
import ContainerizationOCI
import ContainerizationExtras
import Virtualization

final class CaptureWriter: Writer, @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var truncated = false
    private let limit = 128 * 1024
    func write(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        let available = max(0, limit - bytes.count)
        bytes.append(data.prefix(available))
        if data.count > available { truncated = true }
    }
    func close() throws {}
    func snapshot() -> (String, Bool) {
        lock.lock(); defer { lock.unlock() }
        return (String(decoding: bytes, as: UTF8.self), truncated)
    }
}

struct BalloonExtension: VZInstanceExtension {
    let shares: [HostSharePolicy]
    func configureVZ(_ config: inout VZVirtualMachineConfiguration,
                     allocator: any AddressAllocator<Character>, storageDeviceCount: Int,
                     mountsByID: [String: [Containerization.Mount]]) throws {
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        guard config.networkDevices.isEmpty else {
            throw ProbeFailure(code: "network_refused", message: "networkless probe cannot attach a network device")
        }
        try SharePolicy.assertBuilt(config, expected: shares, mountsByID: mountsByID)
    }
}

final class ProbeManager: VirtualMachineManager, @unchecked Sendable {
    private let kernel: Kernel
    private let initfs: Containerization.Mount
    private let shares: [HostSharePolicy]
    private let lock = NSLock()
    private var instance: VZVirtualMachineInstance?
    init(kernel: Kernel, initfs: Containerization.Mount, shares: [HostSharePolicy]) {
        self.kernel = kernel; self.initfs = initfs; self.shares = shares
    }
    private func capture(_ vm: VZVirtualMachineInstance) { lock.lock(); instance = vm; lock.unlock() }
    func current() -> VZVirtualMachineInstance? { lock.lock(); defer { lock.unlock() }; return instance }
    func create(config: some VMCreationConfig) async throws -> any VirtualMachineInstance {
        let input = config.configuration
        guard input.interfaces.isEmpty, !input.nestedVirtualization else {
            throw ProbeFailure(code: "network_refused", message: "probe accepts no networking or nested virtualization")
        }
        let vm = try VZVirtualMachineInstance { settings in
            settings.cpus = input.cpus
            settings.memoryInBytes = input.memoryInBytes
            settings.kernel = kernel
            settings.initialFilesystem = initfs
            settings.interfaces = []
            settings.mountsByID = input.mountsByID
            settings.bootLog = input.bootLog
            settings.extensions = [BalloonExtension(shares: shares)]
        }
        capture(vm)
        return vm
    }
}

private struct Guest: Sendable {
    let container: LinuxContainer
    let manager: ProbeManager
    let lease: DiskLease
    let memoryBytes: UInt64
    let rootfsPath: String
    let deviceOperations: DeviceOperationGate
}

actor ProbeController {
    private var guests: [String: Guest] = [:]
    private var lifecycleBusy: Set<String> = []
    private var activeExecs: [String: Int] = [:]
    private var execHealth: [String: ExecHealth] = [:]
    private var preparing: Set<String> = []

    func perform(_ request: Request) async throws -> String {
        let value: [String: Any]
        switch request.method {
        case "capabilities":
            value = ["abi": 1, "containerizationRevision": "bc994b88df46207fad7775b0eabc51947e315881",
                     "backend": "Containerization/VZ", "binding": "C ABI/Bun FFI", "network": "none",
                     "balloon": "traditional-request-only", "pid": ProcessInfo.processInfo.processIdentifier,
                     "requiresVMOptIn": true, "fixtureMarker": FixturePaths.markerContents,
                     "limitations": ["not Node-API", "no host network endpoint", "no proven host memory reclaim", "no crash recovery or runtime/store confinement"]]
        case "prepareRootfs": value = try await prepareRootfs(request)
        case "unpackArchive": value = try await unpackArchive(request)
        case "create": value = try await create(request)
        case "exec": value = try await exec(request)
        case "balloon": value = try await balloon(request)
        case "stats": value = try await stats(request)
        case "stop": value = try await stop(request)
        default: throw ProbeFailure(code: "unsupported_method", message: "unsupported probe method")
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    private func optIn() throws {
        guard ProcessInfo.processInfo.environment["WINTER_COWORK_VM_TESTS"] == "1" else {
            throw ProbeFailure(code: "vm_opt_in_required", message: "set WINTER_COWORK_VM_TESTS=1 for disposable real-VM operations")
        }
    }

    private func identifier(_ request: Request) throws -> String {
        guard let id = request.id, !id.isEmpty, id.count <= 48,
              id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 }) else {
            throw ProbeFailure(code: "invalid_id", message: "id must contain 1-48 ASCII letters, digits or hyphens")
        }
        return id
    }

    private func guest(_ id: String) throws -> Guest {
        guard !lifecycleBusy.contains(id), let guest = guests[id] else {
            throw ProbeFailure(code: "guest_unavailable", message: "guest is missing or has a lifecycle operation in flight")
        }
        return guest
    }

    private func create(_ request: Request) async throws -> [String: Any] {
        try optIn()
        let id = try identifier(request)
        guard guests[id] == nil, !lifecycleBusy.contains(id) else { throw ProbeFailure(code: "guest_exists", message: "guest id already exists") }
        guard guests.count < 2 else { throw ProbeFailure(code: "probe_capacity", message: "isolated controller permits at most two retained guest records") }
        let root = try FixturePaths.root(request.fixtureRoot)
        let kernel = try FixturePaths.existing(request.kernelPath, within: root)
        let initfs = try FixturePaths.existing(request.initfsPath, within: root)
        let rootfs = try FixturePaths.existing(request.rootfsPath, within: root)
        let source = try FixturePaths.existing(request.sourcePath, within: root, directory: true)
        let payload = try FixturePaths.existing(request.payloadPath, within: root, directory: true)
        let sharedRO = try FixturePaths.existing(request.sharedReadOnlyPath, within: root, directory: true)
        let sharedRW = try FixturePaths.existing(request.sharedReadWritePath, within: root, directory: true)
        let shares = [HostSharePolicy(sourcePath: source.path, guestPath: "/workspace/source", readOnly: false),
                      HostSharePolicy(sourcePath: payload.path, guestPath: "/opt/cowork-fixture", readOnly: true),
                      HostSharePolicy(sourcePath: sharedRO.path, guestPath: "/workspace/host-ro", readOnly: true),
                      HostSharePolicy(sourcePath: sharedRW.path, guestPath: "/workspace/host-rw", readOnly: false)]
        try FixturePaths.validateBackingFiles([kernel, initfs, rootfs])
        try FixturePaths.validateShares(source: source, payload: payload, backing: [kernel, initfs, rootfs])
        try FixturePaths.validateShares(source: source, payload: sharedRO, backing: [kernel, initfs, rootfs])
        try SharePolicy.validate(shares, backing: [kernel, initfs, rootfs])
        let memory = request.memoryBytes ?? 1024 * 1024 * 1024
        guard memory >= 512 * 1024 * 1024, memory <= 2 * 1024 * 1024 * 1024,
              memory % (1024 * 1024) == 0 else { throw ProbeFailure(code: "invalid_memory", message: "test ceiling must be MiB-aligned and between 512 MiB and 2 GiB") }
        let lease = try DiskLease(path: rootfs.path, fixtureRoot: root)
        let manager = ProbeManager(kernel: Kernel(path: kernel, platform: .linuxArm),
                                   initfs: .block(format: "ext4", source: initfs.path, destination: "/", options: ["ro"]), shares: shares)
        var settings = LinuxContainer.Configuration()
        settings.cpus = 2
        settings.memoryInBytes = memory - 128 * 1024 * 1024
        settings.interfaces = []
        settings.mounts.append(contentsOf: shares.map(\.mount))
        let bootLog = try FixturePaths.output(root.appendingPathComponent("boot-\(id)-\(UUID().uuidString).log").path, within: root)
        settings.bootLog = .file(path: bootLog)
        settings.process.arguments = ["/bin/sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"]
        // This ABI is a trusted fixture supervisor door, never a Cowork tool
        // door. The fixture launcher needs mount/namespace/setuid capabilities
        // before installing its own tool boundary and dropping privileges.
        settings.process.capabilities = .allCapabilities
        let container = try LinuxContainer(id, rootfs: .block(format: "ext4", source: rootfs.path, destination: "/"),
                                           vmm: manager, vm: VMResources(cpus: 2, memoryInBytes: memory), configuration: settings)
        let entry = Guest(container: container, manager: manager, lease: lease, memoryBytes: memory, rootfsPath: rootfs.path, deviceOperations: DeviceOperationGate())
        // Hold even failed/uncertain guests until stop can establish VZ stopped.
        guests[id] = entry
        lifecycleBusy.insert(id)
        defer { lifecycleBusy.remove(id) }
        try await container.create()
        try await container.start()
        return ["id": id, "network": "none", "memoryCeilingBytes": memory, "sourceGuestPath": "/workspace/source", "payloadGuestPath": "/opt/cowork-fixture", "payloadReadOnly": true, "rootfsRetained": true,
                "builtSharePolicyVerified": true,
                "shares": shares.map { ["sourcePath": $0.sourcePath, "guestPath": $0.guestPath, "readOnly": $0.readOnly] }]
    }

    private func exec(_ request: Request) async throws -> [String: Any] {
        let id = try identifier(request)
        let entry = try guest(id)
        try execHealth[id, default: ExecHealth()].requireClean()
        guard let args = request.args, !args.isEmpty, args.count <= 256,
              args.allSatisfy({ !$0.contains("\0") }), args.reduce(0, { $0 + $1.utf8.count }) <= 32 * 1024 else {
            throw ProbeFailure(code: "invalid_args", message: "nonempty bounded arguments array required")
        }
        let timeout = request.timeoutSeconds ?? 30
        guard timeout >= 1, timeout <= 300 else { throw ProbeFailure(code: "invalid_timeout", message: "exec timeout must be 1-300 seconds") }
        let cwd = request.cwd ?? "/"
        guard cwd.hasPrefix("/"), !cwd.contains("\0") else { throw ProbeFailure(code: "invalid_cwd", message: "guest cwd must be absolute") }
        activeExecs[id, default: 0] += 1
        defer { activeExecs[id, default: 1] -= 1 }
        let stdout = CaptureWriter(), stderr = CaptureWriter()
        let processID = UUID().uuidString
        let process = try await entry.container.exec(processID) { config in
            config.arguments = args
            config.workingDirectory = cwd
            config.stdout = stdout
            config.stderr = stderr
            config.capabilities = .allCapabilities
        }
        let exit: ExitStatus
        do { exit = try await ProcessLifecycle.run(process, timeout: timeout) }
        catch let failure as ProcessRunFailure {
            execHealth[id, default: ExecHealth()].record(processID: processID, failure: failure)
            throw ProbeFailure(code: failure.cleanupUncertain ? "exec_cleanup_uncertain" : "exec_failed", message: failure.localizedDescription)
        }
        let out = stdout.snapshot(), err = stderr.snapshot()
        return ["id": id, "exitCode": exit.exitCode, "stdout": out.0, "stderr": err.0, "stdoutTruncated": out.1, "stderrTruncated": err.1]
    }

    private func vmSnapshot(_ entry: Guest, target: UInt64? = nil) async throws -> Data {
        guard let vm = entry.manager.current() else { throw ProbeFailure(code: "guest_unavailable", message: "VZ instance not created") }
        try entry.deviceOperations.begin()
        defer { entry.deviceOperations.finish() }
        return try await withCheckedThrowingContinuation { continuation in
            vm.vmQueue.async {
                guard let balloon = vm.vzVirtualMachine.memoryBalloonDevices.first as? VZVirtioTraditionalMemoryBalloonDevice else {
                    continuation.resume(throwing: ProbeFailure(code: "balloon_unavailable", message: "traditional balloon device missing")); return
                }
                if let target { balloon.targetVirtualMachineMemorySize = target }
                do {
                    let state = vm.vzVirtualMachine.state
                    let result: [String: Any] = ["vzState": state.rawValue, "memoryCeilingBytes": entry.memoryBytes,
                                                "balloonTargetBytes": balloon.targetVirtualMachineMemorySize,
                                                "networkDeviceCount": vm.vzVirtualMachine.networkDevices.count,
                                                "reclaimVerified": false]
                    continuation.resume(returning: try JSONSerialization.data(withJSONObject: result))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func balloon(_ request: Request) async throws -> [String: Any] {
        let id = try identifier(request), entry = try guest(id)
        guard let target = request.targetBytes, target >= 256 * 1024 * 1024, target <= entry.memoryBytes,
              target % (1024 * 1024) == 0 else { throw ProbeFailure(code: "invalid_target", message: "balloon target must be MiB-aligned, >=256 MiB and within ceiling") }
        return try JSONSerialization.jsonObject(with: await vmSnapshot(entry, target: target)) as! [String: Any]
    }

    private func stats(_ request: Request) async throws -> [String: Any] {
        let id = try identifier(request), entry = try guest(id)
        var result = try JSONSerialization.jsonObject(with: await vmSnapshot(entry)) as! [String: Any]
        result["id"] = id
        result["activeExecs"] = activeExecs[id, default: 0]
        result["controllerPid"] = ProcessInfo.processInfo.processIdentifier
        result["uncertainExecs"] = execHealth[id, default: ExecHealth()].uncertain
        result["pendingDeviceOperations"] = entry.deviceOperations.snapshot().active
        return result
    }

    private func stop(_ request: Request) async throws -> [String: Any] {
        let id = try identifier(request), entry = try guest(id)
        guard activeExecs[id, default: 0] == 0 else { throw ProbeFailure(code: "guest_busy", message: "wait for exec operations before stopping") }
        lifecycleBusy.insert(id)
        defer { lifecycleBusy.remove(id) }
        await entry.deviceOperations.closeAndDrain()
        var cleanupError: String?
        // First invite cooperative container-init termination, then rely on
        // Containerization's kill/unmount/sync/VM-stop cleanup. Never call this
        // a successful flush when the library reports a cleanup error.
        try? await entry.container.kill(Signal(rawValue: 15))
        _ = try? await entry.container.wait(timeoutInSeconds: 5)
        do { try await entry.container.stop() } catch { cleanupError = error.localizedDescription }
        guard let vm = entry.manager.current() else {
            guests.removeValue(forKey: id)
            execHealth.removeValue(forKey: id)
            return ["id": id, "stopped": true, "vmWasCreated": false, "rootfsRetained": true]
        }
        if vm.state != .stopped { try? await vm.stop() }
        guard vm.state == .stopped else {
            throw ProbeFailure(code: "termination_uncertain", message: "VZ did not establish stopped state; disk lease retained")
        }
        guests.removeValue(forKey: id)
        execHealth.removeValue(forKey: id)
        var result: [String: Any] = ["id": id, "stopped": true, "rootfsRetained": true, "vzStoppedObserved": true, "flushSucceeded": cleanupError == nil]
        if let cleanupError { result["cleanupError"] = cleanupError }
        return result
    }

    private func beginPreparation(_ root: URL) throws {
        guard !preparing.contains(root.path) else { throw ProbeFailure(code: "fixture_busy", message: "fixture preparation already in progress") }
        preparing.insert(root.path)
    }

    private func prepareRootfs(_ request: Request) async throws -> [String: Any] {
        let root = try FixturePaths.root(request.fixtureRoot)
        guard let reference = request.imageReference,
              reference.range(of: "^([a-z0-9]+[a-z0-9./:_-]*)@sha256:[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw ProbeFailure(code: "image_digest_required", message: "public OCI imageReference must contain an exact sha256 digest")
        }
        let output = try FixturePaths.output(request.outputPath, within: root)
        try beginPreparation(root)
        defer { preparing.remove(root.path) }
        let storePath = root.appendingPathComponent("image-store")
        if FileManager.default.fileExists(atPath: storePath.path) {
            _ = try FixturePaths.existing(storePath.path, within: root, directory: true)
        } else {
            try FileManager.default.createDirectory(at: storePath, withIntermediateDirectories: false)
        }
        let store = try ImageStore(path: storePath)
        let image = try await store.pull(reference: reference, platform: .init(arch: "arm64", os: "linux"))
        let unpacker = EXT4Unpacker(capacityInBytes: 1024 * 1024 * 1024)
        let mount = try await unpacker.unpack(image, for: .init(arch: "arm64", os: "linux"), at: output)
        return ["rootfsPath": mount.source, "imageReference": reference, "platform": "linux/arm64", "guestNetwork": "none", "provisioningNetwork": "host registry fetch"]
    }

    private func unpackArchive(_ request: Request) async throws -> [String: Any] {
        let root = try FixturePaths.root(request.fixtureRoot)
        let archive = try FixturePaths.existing(request.archivePath, within: root)
        let output = try FixturePaths.output(request.outputPath, within: root)
        try beginPreparation(root)
        defer { preparing.remove(root.path) }
        let unpacker = EXT4Unpacker(capacityInBytes: 1024 * 1024 * 1024)
        try await unpacker.unpack(archive: archive, compression: .gzip, at: output)
        return ["rootfsPath": output.path, "archivePath": archive.path, "format": "ext4"]
    }
}
