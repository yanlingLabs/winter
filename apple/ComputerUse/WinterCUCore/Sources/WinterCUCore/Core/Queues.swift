import Foundation

/// One serial queue per target pid (spec §3.5): AX calls are synchronous IPC to the target app, so they run
/// here, never on the main thread, and calls to one app stay ordered. A queue with too much pending work
/// refuses with `busy` (retryable) instead of building an unbounded backlog behind a hung app.
final class CUPidQueues: @unchecked Sendable {
    let maxPending: Int
    private let lock = NSLock()
    private var queues: [pid_t: DispatchQueue] = [:]
    private var pending: [pid_t: Int] = [:]

    init(maxPending: Int = 16) { self.maxPending = maxPending }

    private func queue(_ pid: pid_t) -> DispatchQueue {
        if let q = queues[pid] { return q }
        let q = DispatchQueue(label: "WinterCUCore.pid.\(pid)", qos: .userInitiated)
        queues[pid] = q
        return q
    }

    /// Runs `work` on `pid`'s queue and returns its result.
    func run<T>(_ pid: pid_t, _ work: @escaping () throws -> T) async throws -> T {
        let q: DispatchQueue? = lock.withLock {
            let count = pending[pid, default: 0]
            guard count < maxPending else { return nil }
            pending[pid] = count + 1
            return queue(pid)
        }
        guard let q else { throw CUError.busy() }
        defer {
            lock.withLock { pending[pid] = max(0, (pending[pid] ?? 1) - 1) }
        }
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, Error>) in
            q.async {
                do { c.resume(returning: try work()) } catch { c.resume(throwing: error) }
            }
        }
    }

    func pendingCount(_ pid: pid_t) -> Int {
        lock.lock(); defer { lock.unlock() }
        return pending[pid, default: 0]
    }

    /// Drops an idle queue for a pid that is gone.
    func forget(_ pid: pid_t) {
        lock.lock(); defer { lock.unlock() }
        if pending[pid, default: 0] == 0 {
            queues[pid] = nil
            pending[pid] = nil
        }
    }
}

/// `cancel {callId}` (spec §4): work registered under a call id checks its token between steps (keys,
/// polls, settle loops) and stops with `cancelled`. A cancel is sticky for 30 s: a cancelled script's run
/// is over, so any later request under the same call id (or one racing ahead of its own cancel) stops at once.
final class CUCancellation: @unchecked Sendable {
    final class Token: @unchecked Sendable {
        private let lock = NSLock()
        private var flag = false
        var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return flag }
        func cancel() { lock.lock(); flag = true; lock.unlock() }
        func check() throws { if isCancelled || Task.isCancelled { throw CUError.cancelled } }
    }

    private let lock = NSLock()
    private var tokens: [String: (token: Token, users: Int)] = [:]
    private var cancelledAt: [String: Date] = [:]
    static let stickySeconds: TimeInterval = 30

    /// The token for `callId` (nil → a token nobody can cancel but Swift task cancellation).
    func begin(_ callId: String?) -> Token {
        let t = Token()
        guard let callId else { return t }
        lock.lock(); defer { lock.unlock() }
        if let e = cancelledAt[callId], Date().timeIntervalSince(e) < Self.stickySeconds {
            t.cancel()
            return t
        }
        if let existing = tokens[callId] {
            tokens[callId] = (existing.token, existing.users + 1)
            return existing.token
        }
        tokens[callId] = (t, 1)
        return t
    }

    func end(_ callId: String?) {
        guard let callId else { return }
        lock.lock(); defer { lock.unlock() }
        guard let e = tokens[callId] else { return }
        if e.users <= 1 { tokens[callId] = nil } else { tokens[callId] = (e.token, e.users - 1) }
    }

    func cancel(_ callId: String) {
        lock.lock(); defer { lock.unlock() }
        tokens[callId]?.token.cancel()
        let now = Date()
        cancelledAt = cancelledAt.filter { now.timeIntervalSince($0.value) < Self.stickySeconds }
        cancelledAt[callId] = now
    }
}
