import XCTest
import Foundation
import Security
import CryptoKit
@testable import LauncherCore
import LauncherNative

// MARK: - fixtures

enum Fixture {
    static let scope = Scope(workspaceId: "workspace_11111111-1111-4111-8111-111111111111", incarnationId: "inc-22222222-2222-4222-8222-222222222222", leaseEpoch: 3,
                             admissionId: "adm-33333333-3333-4333-8333-333333333333", controllerInstanceId: "ctl-0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b-a1b2c3d4",
                             workerInstanceId: "wrk-fake-ok", runtimeImageDigest: String(repeating: "ab", count: 32), memoryMiB: 768)
    static func scope(mode: String) -> Scope { var s = scope; s.workerInstanceId = "wrk-fake-\(mode)"; return s }
    static let nonce = String(repeating: "0f", count: 16)
    static let homeId = "home_99999999-9999-4999-8999-999999999999"
    static let launcherInstanceId = "launcher-88888888"
    static let bootId = "0B0B0B0B-0B0B-4B0B-8B0B-0B0B0B0B0B0B"

    static func config() -> SessionConfig { SessionConfig(launcherInstanceId: launcherInstanceId, hostBootId: bootId) }
}

/// Two real sparse image files in a private temp directory, opened read-write, with the identities the daemon would state for them.
final class DiskPair {
    let directory: URL
    let urls: [URL]
    let descriptors: [OwnedFD]
    let identities: [VolumeIdentity]
    static let capacity: UInt64 = 16 * 1024 * 1024

    init(capacity: UInt64 = DiskPair.capacity, mode: mode_t = 0o600) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("launcher-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        urls = [directory.appendingPathComponent("data.raw"), directory.appendingPathComponent("environment.raw")]
        var fds: [OwnedFD] = [], ids: [VolumeIdentity] = []
        for (index, url) in urls.enumerated() {
            let fd = open(url.path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, mode)
            precondition(fd >= 0 && ftruncate(fd, off_t(capacity)) == 0)
            fchmod(fd, mode)
            var info = stat(); precondition(fstat(fd, &info) == 0)
            ids.append(VolumeIdentity(purpose: index == 0 ? .data : .environment, device: String(UInt64(UInt32(bitPattern: info.st_dev))), inode: String(info.st_ino), uid: info.st_uid, capacityBytes: capacity))
            fds.append(OwnedFD(fd))
        }
        descriptors = fds; identities = ids
    }
    /// Fresh descriptors on the same two files (the first pair is consumed by a send).
    func reopen() -> [OwnedFD] { urls.map { OwnedFD(open($0.path, O_RDWR | O_CLOEXEC)) } }
    var dataMarker: String {
        let handle = open(urls[0].path, O_RDONLY); defer { close(handle) }
        var buffer = [UInt8](repeating: 0, count: 18)
        _ = pread(handle, &buffer, buffer.count, 0)
        return String(decoding: buffer, as: UTF8.self)
    }
    deinit { try? FileManager.default.removeItem(at: directory) }
}

func makeTemporaryDirectory(_ label: String = "launcher") -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(label)-\(UUID().uuidString)", isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return url
}

/// A requirement that pins one exact code directory hash. Tests only: the launcher's own copy exists only under -DWINTER_COWORK_TEST_BUILD.
func cdhashRequirementText(_ hex: String) -> String { "cdhash H\"\(hex)\"" }

func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
func bytes(fromHex text: String) -> [UInt8] {
    let chars = Array(text.utf8)
    func nibble(_ c: UInt8) -> UInt8 { c <= 0x39 ? c - 0x30 : c - 0x61 + 10 }
    return stride(from: 0, to: chars.count, by: 2).map { nibble(chars[$0]) << 4 | nibble(chars[$0 + 1]) }
}

// MARK: - doubles

/// Everything that happened, in order, across the ports, the store and the process: the order IS what several tests assert.
final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func add(_ entry: String) { lock.lock(); entries.append(entry); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return entries }
    func index(of prefix: String) -> Int? { all.firstIndex { $0.hasPrefix(prefix) } }
}

final class InMemoryReceiptStore: DurableReceiptStore {
    var records: [ReceiptScope: [UInt8]] = [:]
    var failPersist = false
    var retired: [ReceiptScope] = []
    let log: EventLog
    init(log: EventLog = EventLog()) { self.log = log }
    func persist(_ receipt: StopReceipt, scope: ReceiptScope) throws {
        let bytes = try receipt.serialize()
        if failPersist { log.add("persist-failed"); throw ReceiptStoreFailure.ioFailed(EIO) }
        if let existing = records[scope], existing != bytes { throw ReceiptStoreFailure.alreadyExists }
        records[scope] = bytes
        switch receipt { case .orderly: log.add("persist:A"); case .uncertain: log.add("persist:B") }
    }
    func load(_ scope: ReceiptScope) throws -> StopReceipt? { try records[scope].map(StopReceipt.parse) }
    func retire(_ scope: ReceiptScope) throws { records[scope] = nil; retired.append(scope); log.add("retire") }
}

final class FakeProcess: WorkerProcess {
    let pid: Int32 = 4242
    let startToken = "1760000000.000001"
    var validateOK = true
    var validateCalls = 0
    var resumeCalls = 0
    var resumeFails = false
    var probeResult: WorkerExit = .running
    /// When non-empty, each probe consumes the next answer first (a probe that says "running" at the exit event, then the real exit).
    var probeSequence: [WorkerExit] = []
    var probeCalls = 0
    var killResult = KillOutcome(exit: .signal(9), killSent: true)
    var killCalls = 0
    let log: EventLog
    init(log: EventLog) { self.log = log }
    func validateExecutedImage() throws { validateCalls += 1; log.add("validate#\(validateCalls)"); if !validateOK { throw IdentityFailure("image") } }
    func resume() throws { resumeCalls += 1; log.add("resume"); if resumeFails { throw SpawnFailure.failed(EPERM) } }
    func probe() -> WorkerExit { probeCalls += 1; return probeSequence.isEmpty ? probeResult : probeSequence.removeFirst() }
    func kill() -> KillOutcome { killCalls += 1; log.add("kill"); return killResult }
}

final class FakePorts: SessionPorts {
    let log: EventLog
    var lines: [LineToDaemon] = []
    var datagrams: [Envelope] = []
    var datagramDescriptorCounts: [Int] = []
    var relayed: [[UInt8]] = []
    var armed: [SessionTimer: Int] = [:]
    var disarmed: [SessionTimer] = []
    var finished = false
    var daemonChannelClosed = false
    var process: FakeProcess
    var spawnError: Error?
    var spawnCalls = 0
    var workerSendOK = true
    var relayOK = true
    init(log: EventLog) { self.log = log; process = FakeProcess(log: log) }

    func sendToDaemon(_ line: LineToDaemon) {
        lines.append(line)
        switch line {
        case .stopped: log.add("send:stopped")
        case .uncertain: log.add("send:uncertain")
        case .refused(_, let code): log.add("send:refused:\(code.rawValue)")
        case .fault(let code): log.add("send:fault:\(code.rawValue)")
        case .begun: log.add("send:begun")
        default: break
        }
    }
    func closeDaemonChannel() { daemonChannelClosed = true; log.add("close-daemon") }
    func spawnWorker() throws -> WorkerProcess {
        spawnCalls += 1
        if let spawnError { throw spawnError }
        log.add("spawn")
        return process
    }
    func sendToWorker(_ datagram: [UInt8], descriptors: [OwnedFD]) -> Bool {
        guard workerSendOK else { return false }
        let direction = EnvelopeDirection.toWorker
        let envelope = try! EnvelopeFormat.parse(datagram, rights: descriptors.count, direction: direction)
        datagrams.append(envelope); datagramDescriptorCounts.append(descriptors.count)
        switch envelope {
        case .scope: log.add("env:scope")
        case .volumes: log.add("env:volumes")
        case .drain(_, _, _, let origin): log.add("env:drain:\(origin.rawValue)")
        default: break
        }
        return true
    }
    var drainCalls = 0
    var onDrain: (() -> Void)?
    func drainWorkerInputs() { drainCalls += 1; log.add("drain-inputs"); onDrain?() }
    func relayToWorker(_ frame: [UInt8]) -> Bool { relayed.append(frame); return relayOK }
    func arm(_ timer: SessionTimer, afterMs: Int) { armed[timer] = afterMs; log.add("arm:\(timer)") }
    func disarm(_ timer: SessionTimer) { armed[timer] = nil; disarmed.append(timer) }
    func finish() { finished = true; log.add("finish") }

    var refusals: [RefusalCode] { lines.compactMap { if case .refused(_, let code) = $0 { code } else { nil } } }
    var stopped: [OrderlyReceipt] { lines.compactMap { if case .stopped(_, let r) = $0 { r } else { nil } } }
    var uncertain: [UncertainReceipt] { lines.compactMap { if case .uncertain(let r) = $0 { r } else { nil } } }
}

/// The guest-artifact check as a double: accepts the scope's digest unless told otherwise, and remembers what it was asked.
final class FakeArtifacts: GuestArtifactVerifying, @unchecked Sendable {
    var accept = true
    private(set) var asked: [String] = []
    func verify(runtimeImageDigest stated: String) throws { asked.append(stated); if !accept { throw IdentityFailure("not the pinned runtime image") } }
}

final class FixedRandom: Randomness, @unchecked Sendable {
    private var counter: UInt8 = 0
    func bytes(_ count: Int) -> [UInt8] { counter &+= 1; return [UInt8](repeating: counter, count: count) }
}
struct FixedClock: WallClock { var nowMs: UInt64 { 1_760_000_000_000 } }
final class RecordingPower: PowerReporting { var events: [PowerEvent] = []; func report(_ event: PowerEvent) { events.append(event) } }

/// A session wired to the doubles, plus handles to look inside.
final class SessionHarness {
    let log = EventLog()
    let ports: FakePorts
    let store: InMemoryReceiptStore
    let power = RecordingPower()
    let session: LauncherSession
    let artifacts = FakeArtifacts()
    init(config: SessionConfig = Fixture.config()) {
        ports = FakePorts(log: log); store = InMemoryReceiptStore(log: log)
        let box = ClockBox()
        clockBox = box
        session = LauncherSession(config: config, ports: ports, dependencies: SessionDependencies(store: store, artifacts: artifacts, random: FixedRandom(), clock: FixedClock(), monotonicMs: { box.value }, power: power))
    }
    var clockBox: ClockBox!
    final class ClockBox { var value: Int64 = 1_000 }

    // ---- driving the daemon side
    func send(_ message: LineToLauncher, descriptors: [OwnedFD] = []) {
        let line = try! LauncherLineCodec.serialize(message)
        session.receiveLine(FramedLine(bytes: line, rights: descriptors))
    }
    func begin(id: String = "req-begin", homeId: String = Fixture.homeId, scope: Scope = Fixture.scope) { send(.begin(id: id, homeId: homeId, scope: scope)) }
    func sendRaw(_ text: String, descriptors: [OwnedFD] = []) { session.receiveLine(FramedLine(bytes: Array(text.utf8), rights: descriptors)) }

    /// A timer firing, as the runtime does it: a one-shot is gone from the armed set before its handler runs.
    func fire(_ timer: SessionTimer) { ports.armed[timer] = nil; session.timerFired(timer) }

    // ---- driving the worker side
    var workerSeq: UInt32 = 0
    func status(_ state: WorkerStatus, data: FlushCounters = FlushCounters(), environment: FlushCounters = FlushCounters(), seq: UInt32? = nil) {
        workerSeq += 1
        let bytes = try! EnvelopeFormat.serialize(.status(seq: seq ?? workerSeq, state: state, data: data, environment: environment))
        session.receiveWorkerDatagram(bytes, descriptors: [])
    }
    func workerFault(_ code: WorkerFault) {
        workerSeq += 1
        session.receiveWorkerDatagram(try! EnvelopeFormat.serialize(.fault(seq: workerSeq, code: code)), descriptors: [])
    }
    func frameUp(_ muxClass: MuxClass = .bootstrap, seq: UInt32 = 1, payload: [UInt8] = Array("{}".utf8)) {
        let frame = MuxFormat.frame(muxClass, seq: seq, payload: payload)
        session.receiveWorkerFrame(try! MuxFormat.parseFrame(frame), bytes: frame)
    }
    func workerExits(_ exit: WorkerExit) { ports.process.probeResult = exit; session.workerProcessEnded() }

    /// begin -> READY -> volumes -> accepted, with real descriptors; returns the disk pair.
    @discardableResult
    func bringUp(scope: Scope = Fixture.scope, vm: Bool = true) throws -> DiskPair {
        begin(scope: scope)
        status(.sandboxed)
        let disks = try DiskPair()
        let digest = try EnvelopeFormat.scopeDigest(scope)
        send(.volumes(id: "req-volumes", scopeDigest: digest, volumes: disks.identities), descriptors: disks.reopen())
        status(.volumesAccepted)
        if vm { status(.vmRunning); status(.guestHello) }
        return disks
    }
    func stop(id: String = "req-stop", nonce: String = Fixture.nonce, budget: Int = 30_000) { send(.stop(id: id, stopNonce: nonce, reason: .user, budgetMs: budget)) }
    /// A clean guest halt: draining, ack, halting, halted (flushes 1/1), exiting.
    func cleanHalt(flushed: FlushCounters = FlushCounters(requested: 1, completed: 1)) {
        status(.draining, data: flushed); status(.drainAcked, data: flushed); status(.halting, data: flushed); status(.guestHalted, data: flushed); status(.exiting, data: flushed)
    }
}

// MARK: - code signing helpers

enum CodeHash {
    /// The code directory hash of the file at `path`, as 40 lowercase hex digits.
    static func ofFile(_ path: String) throws -> String {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code else { throw IdentityFailure("no static code") }
        return try cdhash(of: code)
    }
    /// The code directory hash of THIS process (whatever hosts the tests).
    static func ofSelf() throws -> String {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { throw IdentityFailure("no self") }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(me, [], &staticCode) == errSecSuccess, let staticCode else { throw IdentityFailure("no static self") }
        return try cdhash(of: staticCode)
    }
    private static func cdhash(of code: SecStaticCode) throws -> String {
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let dictionary = information as? [String: Any], let unique = dictionary[kSecCodeInfoUnique as String] as? Data else { throw IdentityFailure("no cdhash") }
        return unique.map { String(format: "%02x", $0) }.joined()
    }
}

/// Where SwiftPM put the products built next to the test bundle.
enum BuiltProducts {
    static var directory: URL {
        for bundle in Bundle.allBundles where bundle.bundleURL.pathExtension == "xctest" { return bundle.bundleURL.deletingLastPathComponent() }
        return Bundle.main.bundleURL.deletingLastPathComponent()
    }
    static var fakeWorker: String { canonical(directory.appendingPathComponent("FakeWorker").path) }
    static var launcher: String { canonical(directory.appendingPathComponent("winter-cowork-launcher").path) }
    static func canonical(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
}

func vectorURL(_ name: String) -> URL { Bundle.module.resourceURL!.appendingPathComponent("Vectors").appendingPathComponent(name) }
func loadVector(_ name: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(contentsOf: vectorURL(name))) as! [String: Any]
}


/// A scratch directory shaped like the shipped worker's: the FakeWorker copied in, next to `cowork-guest/{kernel,initramfs.cpio}`.
final class GuestWorkerDirectory {
    let root: URL
    let workerPath: String
    let guestDirectory: String
    let kernelBytes: [UInt8]
    let initramfsBytes: [UInt8]
    init(kernel: [UInt8] = Array("kernel-bytes".utf8), initramfs: [UInt8] = Array("initramfs-bytes".utf8)) throws {
        root = makeTemporaryDirectory("worker-dir")
        let canonicalRoot = BuiltProducts.canonical(root.path)
        workerPath = canonicalRoot + "/winter-cowork-worker"
        try FileManager.default.copyItem(atPath: BuiltProducts.fakeWorker, toPath: workerPath)
        guestDirectory = canonicalRoot + "/cowork-guest"
        try FileManager.default.createDirectory(atPath: guestDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        kernelBytes = kernel; initramfsBytes = initramfs
        try Data(kernel).write(to: URL(fileURLWithPath: guestDirectory + "/kernel"))
        try Data(initramfs).write(to: URL(fileURLWithPath: guestDirectory + "/initramfs.cpio"))
        for name in ["kernel", "initramfs.cpio"] { chmod(guestDirectory + "/" + name, 0o644) }
    }
    deinit { try? FileManager.default.removeItem(at: root) }
    /// The digest the contract defines, computed here independently of the launcher's code.
    var expectedDigest: String {
        let k = SHA256.hash(data: Data(kernelBytes)), i = SHA256.hash(data: Data(initramfsBytes))
        return SHA256.hash(data: Data(Array(k) + Array(i))).map { String(format: "%02x", $0) }.joined()
    }
    func scope(mode: String) -> Scope { var s = Fixture.scope(mode: mode); s.runtimeImageDigest = expectedDigest; return s }
}
