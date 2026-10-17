import Foundation

/*
 * The seams of the session state machine. Every collaborator that touches the OS (the worker process, the sockets, the clock,
 * the disk, the power service) is behind one of these, so the whole decision logic runs deterministically under test and the
 * real implementations (`LauncherRuntime`, `NativeWorkerProcess`, `DirectoryReceiptStore`) are tested separately against real
 * sockets and a real child.
 */

/// What the owned handle knows about the worker process. `uncertain` and `lost` are ownership debt: termination was not confirmed.
public enum WorkerExit: Equatable, Sendable {
    case running
    case code(Int32)
    case signal(Int32)
    /// The wait failed or timed out after a kill: the process may still exist. No signal is ever repeated on this evidence.
    case uncertain(Int32)
    /// `ECHILD`: something else reaped it, or it was never ours. Not a confirmed exit either.
    case lost(Int32)
    public var isConfirmedExit: Bool { switch self { case .code, .signal: true; default: false } }
}

public struct KillOutcome: Equatable, Sendable {
    public let exit: WorkerExit
    /// True when SIGKILL really left through the owned handle.
    public let killSent: Bool
    public init(exit: WorkerExit, killSent: Bool) { self.exit = exit; self.killSent = killSent }
}

/// A worker this process spawned SUSPENDED and is the sole reaper of. There is no pid-taking operation anywhere: the only signal
/// that can leave is `kill()`, on this handle, and only while a fresh probe proves the process is still its unreaped child.
public protocol WorkerProcess: AnyObject {
    var pid: Int32 { get }
    var startToken: String { get }
    /// SecCode of the EXECUTED image against its requirement. Called before `resume()` and again after the worker's READY.
    func validateExecutedImage() throws
    func resume() throws
    /// A non-blocking wait: reaps and reports if the process has ended.
    func probe() -> WorkerExit
    func kill() -> KillOutcome
}

public enum SpawnFailure: Error, Equatable, Sendable {
    /// The pinned file changed between pinning and spawning.
    case imageChanged
    case failed(Int32)
}

public enum ReceiptStoreFailure: Error, Equatable, Sendable {
    case alreadyExists
    case ioFailed(Int32)
    case unsafeDirectory
}

public struct ReceiptScope: Hashable, Sendable {
    public let workspaceId: String
    public let incarnationId: String
    public let leaseEpoch: Int
    public init(workspaceId: String, incarnationId: String, leaseEpoch: Int) { self.workspaceId = workspaceId; self.incarnationId = incarnationId; self.leaseEpoch = leaseEpoch }
    public init(_ scope: Scope) { self.init(workspaceId: scope.workspaceId, incarnationId: scope.incarnationId, leaseEpoch: scope.leaseEpoch) }
}

/// The launcher's durable record of how a worker ended. WRITE-ONCE per scope, fsynced before `persist` returns, kept until
/// `retire`. Class A is persisted BEFORE it is sent; that ordering is the whole point of the store.
///
/// The production storage is a proposal (docs/research/2026-10-17-cowork-n2-launcher.md), not a decision; the daemon-side
/// `CoworkNativeDurableReceiptPort` that reads it back and ATTESTS it is another slice's.
public protocol DurableReceiptStore: AnyObject {
    /// Returns only once the bytes are on stable storage. A second persist of the SAME bytes is fine; different bytes are `alreadyExists`.
    func persist(_ receipt: StopReceipt, scope: ReceiptScope) throws
    func load(_ scope: ReceiptScope) throws -> StopReceipt?
    /// Forget the receipt of this scope (the daemon sent `receipt_retire`). Never throws for "nothing there".
    func retire(_ scope: ReceiptScope) throws
}

public protocol HostBootProviding: Sendable {
    /// The host boot id exactly as the daemon's `CoworkNativeHostBoot.bootId()` spells it (compared as text).
    func bootId() throws -> String
}
public protocol Randomness: Sendable {
    func bytes(_ count: Int) -> [UInt8]
}
public protocol WallClock: Sendable {
    var nowMs: UInt64 { get }
}

/// Quiesce and wake, as the system reports them. There is no sleep assertion anywhere: the launcher only OBSERVES.
public enum PowerEvent: String, Equatable, Sendable {
    case willSleep = "will_sleep"
    case didWake = "did_wake"
}
/// Where power events go upward. The contract defines no L1 line for them (section 10: "sleep and wake ... other slices"), so the
/// only implementation in this slice records them; nothing is put on the wire until the contract names a line.
public protocol PowerReporting: AnyObject {
    func report(_ event: PowerEvent)
}

public enum SessionTimer: Hashable, Sendable {
    /// The worker must report `sandboxed` (READY) by this deadline.
    case ready
    /// The worker must accept the two descriptors by this deadline.
    case volumes
    /// The drain budget: when it runs out the owned handle is killed.
    case drain
    /// A worker that reported a fault gets a short grace to exit by itself before it is killed.
    case faultGrace
}

/// Everything the session asks of its surroundings. The real one is `LauncherRuntime`.
public protocol SessionPorts: AnyObject {
    /// One line to the daemon. A line sent after the daemon is gone is dropped.
    func sendToDaemon(_ line: LineToDaemon)
    /// Tell the I/O layer to stop reading L1 and close it once what is queued has been written.
    func closeDaemonChannel()
    /// Make L2/L3, spawn the worker SUSPENDED (validating the pinned path first) and hook its pipes into the loop.
    func spawnWorker() throws -> WorkerProcess
    /// One datagram on L2, with descriptors attached (the VOLUMES envelope). The descriptors stay the caller's. False if it could not be sent.
    func sendToWorker(_ datagram: [UInt8], descriptors: [OwnedFD]) -> Bool
    /// One whole frame on L3, relayed from the daemon. False if the worker is not keeping up (the bounded backlog is full).
    func relayToWorker(_ frame: [UInt8]) -> Bool
    func arm(_ timer: SessionTimer, afterMs: Int)
    func disarm(_ timer: SessionTimer)
    /// The session reached a point where the process may end (the verdict is durable and no daemon is waiting on it).
    func finish()
}
