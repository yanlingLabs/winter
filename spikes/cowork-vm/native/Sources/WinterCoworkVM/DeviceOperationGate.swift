import Foundation

/// Narrow lifecycle ordering only. This gate never covers an exec or whole
/// perform() call, so a long guest process cannot block stats/balloon/other execs.
final class DeviceOperationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var closing = false
    private var active = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func begin() throws {
        lock.lock(); defer { lock.unlock() }
        guard !closing else { throw ProbeFailure(code: "guest_stopping", message: "VM device-operation admission is closed") }
        active += 1
    }
    func finish() {
        lock.lock()
        precondition(active > 0)
        active -= 1
        let ready = active == 0 ? waiters : []
        if active == 0 { waiters.removeAll() }
        lock.unlock()
        ready.forEach { $0.resume() }
    }
    func closeAndDrain() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            closing = true
            if active == 0 { lock.unlock(); continuation.resume() }
            else { waiters.append(continuation); lock.unlock() }
        }
    }
    func snapshot() -> (closing: Bool, active: Int) {
        lock.lock(); defer { lock.unlock() }
        return (closing, active)
    }
}
