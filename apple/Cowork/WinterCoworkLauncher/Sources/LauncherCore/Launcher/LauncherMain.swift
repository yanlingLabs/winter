import Foundation
import LauncherNative

/// The launcher's entry point, as a library function so `launcher-main/main.swift` is three lines and the assembly is reviewable here.
///
/// Order is the point: (1) the arguments; (2) L1 is the unnamed stream socketpair the daemon handed down as descriptor 3;
/// (3) the PARENT is authenticated (audit token, then SecCode against the designated requirement) BEFORE a byte is read or `hello`
/// is sent; (4) the worker image is pinned; (5) only then does the session start.
public enum LauncherMain {
    public enum ExitCode {
        public static let usage: Int32 = 64
        public static let badChannel: Int32 = 65
        public static let identity: Int32 = 66
        public static let parentRefused: Int32 = 67
        public static let workerPin: Int32 = 68
        public static let store: Int32 = 69
    }

    public static func run(arguments: [String]) -> Int32 {
        let parsed: LauncherArguments
        do { parsed = try LauncherArguments.parse(arguments) } catch { fputs("winter-cowork-launcher: \(error)\n", stderr); return ExitCode.usage }
        signal(SIGPIPE, SIG_IGN)

        // L1: descriptor 3, an unnamed stream socketpair. Anything else is not what the daemon would have handed us.
        guard lc_is_unnamed_unix_socket(3, SOCK_STREAM) == 1 else { return ExitCode.badChannel }
        let l1: OwnedFD
        do {
            let inherited = OwnedFD(3)
            _ = lc_set_cloexec(inherited.raw)
            // Descriptors 3 and 4 are the worker's; move L1 out of the way (the copy is FD_CLOEXEC, the original is closed).
            l1 = try Sock.relocate(inherited, above: 5)
            try Sock.setNonBlocking(l1)
            var on: Int32 = 1
            _ = setsockopt(l1.raw, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        } catch { return ExitCode.badChannel }

        var parentText = parsed.profile.parentRequirementText
        var workerText = parsed.profile.workerRequirementText
        #if WINTER_COWORK_TEST_BUILD
        if let hash = parsed.testParentCDHash { parentText = WinterCodeIdentity.cdhashRequirement(hash) }
        if let hash = parsed.testWorkerCDHash { workerText = WinterCodeIdentity.cdhashRequirement(hash) }
        #endif
        let parentRequirement: CodeRequirement, workerRequirement: CodeRequirement
        do { parentRequirement = try CodeRequirement(parentText); workerRequirement = try CodeRequirement(workerText) } catch { return ExitCode.identity }

        // 3. The parent. A refusal is said once, in the contract's own words, and then the process ends having read nothing.
        switch CodeSigningParent.authenticator(requirement: parentRequirement).authenticate(socket: l1.raw) {
        case .accept: break
        case .reject:
            if let line = try? LauncherLineCodec.serialize(LineToDaemon.fault(.parent_unverified)) { _ = Sock.send(l1, line[...]) }
            return ExitCode.parentRefused
        }

        // 4. The worker image is pinned now, at the earliest, and checked again right before every spawn.
        let image: WorkerImage
        do { image = try WorkerImage(path: parsed.workerPath, requirement: workerRequirement) } catch { return ExitCode.workerPin }
        let store: DirectoryReceiptStore
        do { store = try DirectoryReceiptStore(directory: parsed.receiptDirectory) } catch { return ExitCode.store }
        var boot = [CChar](repeating: 0, count: 128)
        guard lc_boot_session_uuid(&boot, boot.count) > 0 else { return ExitCode.identity }
        let bootId = String(decoding: boot.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        guard V.isLabel(bootId) else { return ExitCode.identity }

        let random = SystemRandomness()
        let config = SessionConfig(homeId: parsed.homeId, launcherInstanceId: "launcher-" + random.bytes(8).map { String(format: "%02x", $0) }.joined(), hostBootId: bootId)
        let ledger = PowerLedger()
        let runtime = LauncherRuntime(l1: l1, spawner: NativeWorkerSpawner(path: parsed.workerPath, verifier: image), onFinish: { exit(0) })
        runtime.start(config: config, dependencies: SessionDependencies(store: store, power: ledger), observePower: true, handleTerminationSignals: true)
        dispatchMain()
    }
}
