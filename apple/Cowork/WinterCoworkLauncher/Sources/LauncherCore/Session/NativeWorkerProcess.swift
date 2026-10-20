import Foundation
import LauncherNative

private func workerExit(from result: lc_wait_result) -> WorkerExit {
    switch Int(result.state) {
    case LC_OWNED_RUNNING: return .running
    case LC_CONFIRMED_EXIT: return Int(result.exit_kind) == LC_EXIT_SIGNAL ? .signal(result.status) : .code(result.status)
    case LC_LOST_OWNERSHIP: return .lost(result.error)
    default: return .uncertain(result.error)
    }
}

/// The real `WorkerProcess`: a worker spawned SUSPENDED by `lc_spawn_owned`, with this process as its sole reaper.
///
/// There is deliberately no initializer or method that takes a pid. The handle comes only from the spawn; the executed image
/// is validated by the pinned `WorkerImageVerifying` against the SecCode of the SPAWNED pid (unreaped, so the pid cannot have been
/// recycled); the only signal is inside `kill()` and goes through the C ownership proof. `deinit` releases memory only: it never signals or waits.
public final class NativeWorkerProcess: WorkerProcess, @unchecked Sendable {
    public let pid: Int32
    public let startToken: String
    private let handle: OpaquePointer
    private let verifier: WorkerImageVerifying

    /// Validates the pinned path, spawns suspended with `l2Child` as fd 3 and `l3Child` as fd 4, and (the child ends having been
    /// inherited) lets the caller close its copies. Both child ends must be numbered above 4 and differ (`Sock.relocate`).
    public init(verifier: WorkerImageVerifying, l2Child: OwnedFD, l3Child: OwnedFD) throws {
        do { try verifier.validatePath() } catch { throw SpawnFailure.imageChanged }
        var child: OpaquePointer?
        // The path comes from the verifier that pinned it: there is no way to spawn one file under another file's pin.
        let rc = lc_spawn_owned(verifier.path, l2Child.raw, l3Child.raw, &child)
        guard rc == 0, let child else { throw SpawnFailure.failed(rc) }
        handle = child; self.verifier = verifier
        pid = lc_owned_pid(child)
        var token = [CChar](repeating: 0, count: 64)
        startToken = lc_process_start_token(pid, &token, token.count) == 0 ? String(decoding: token.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self) : "unknown-\(pid)"
    }
    deinit { lc_owned_destroy(handle) } // memory only: never a signal or a wait

    public func validateExecutedImage() throws { try verifier.validateExecuted(pid: pid) }
    public func resume() throws {
        let result = lc_resume_owned(handle)
        guard Int(result.state) == LC_OWNED_RUNNING else { throw SpawnFailure.failed(result.error) }
    }
    public func probe() -> WorkerExit { workerExit(from: lc_probe_owned(handle)) }
    public func kill() -> KillOutcome {
        let result = lc_kill_owned(handle, 250)
        return KillOutcome(exit: workerExit(from: result), killSent: result.kill_sent != 0)
    }
}
