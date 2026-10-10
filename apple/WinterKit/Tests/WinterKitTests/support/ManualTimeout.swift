import Foundation

/// A request-timeout clock a test releases by hand, for `WinterClient(…, sleep:)` and
/// `LiveComputerUseHelperClient(…, sleep:)`.
///
/// A short real timeout (80 ms) applies to every request on the client, the handshake included, so on a loaded
/// machine the `hello` could time out before the test had even answered it — a test of "a request nobody answers
/// times out" was really a test of how fast the machine is. With this, a timeout passes only when the test says
/// so (`elapse()`), after it has seen the request on the wire: no request times out early, and none waits for real
/// time to pass.
///
/// `elapse()` is a latch: a `sleep` that begins after it returns at once, so releasing it can never miss a watchdog
/// that was still on its way to sleeping. A sleeping task that is cancelled (the request was answered) throws
/// `CancellationError`, as `Task.sleep` does.
final class ManualTimeout: @unchecked Sendable {
    private let lock = NSLock()
    private var elapsed = false
    private var nextId = 0
    private var waiters: [Int: CheckedContinuation<Void, Error>] = [:]

    /// The value for the `sleep:` parameter.
    var sleeper: @Sendable (Duration) async throws -> Void {
        { [self] _ in try await sleep() }
    }

    private func sleep() async throws {
        lock.lock(); nextId += 1; let id = nextId; lock.unlock()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if elapsed {
                    lock.unlock(); continuation.resume()
                } else if Task.isCancelled {
                    lock.unlock(); continuation.resume(throwing: CancellationError())
                } else {
                    waiters[id] = continuation; lock.unlock()
                }
            }
        } onCancel: {
            lock.lock(); let continuation = waiters.removeValue(forKey: id); lock.unlock()
            continuation?.resume(throwing: CancellationError())
        }
    }

    /// Lets every timeout pass, now and from here on.
    func elapse() {
        lock.lock(); elapsed = true; let all = waiters; waiters = [:]; lock.unlock()
        for continuation in all.values { continuation.resume() }
    }

    /// How many timeouts are waiting to pass (tests).
    var sleeping: Int { lock.lock(); defer { lock.unlock() }; return waiters.count }
}
