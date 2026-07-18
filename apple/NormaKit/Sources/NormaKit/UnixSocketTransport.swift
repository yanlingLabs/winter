import Foundation
import Network

/// NWConnection over a unix domain socket (SOCK_STREAM). If NWEndpoint.unix proves unreliable
/// on some OS build, the fallback is a POSIX socket + DispatchSourceRead — note the outcome in
/// the phase-2 carryover doc (spec §4.2 explicitly allows the swap).
public final class UnixSocketTransport: NormaTransport, @unchecked Sendable {
    public let incoming: AsyncStream<TransportEvent>
    private let cont: AsyncStream<TransportEvent>.Continuation
    private let conn: NWConnection
    private let queue = DispatchQueue(label: "norma.unix-transport")
    private let closedOnce = OnceFlag()

    public init(path: String) {
        var c: AsyncStream<TransportEvent>.Continuation!
        incoming = AsyncStream { c = $0 }
        cont = c
        conn = NWConnection(to: NWEndpoint.unix(path: path), using: .tcp)
    }

    public func open() async throws {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            let resumed = OnceFlag()
            conn.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    // Defense-in-depth: only the caller that actually resumed the continuation
                    // may start the receive loop — a post-cancel spurious .ready must not.
                    if resumed.trip() {
                        k.resume()
                        self.receiveLoop()
                    }
                case .failed(let err):
                    if resumed.trip() { k.resume(throwing: err) }
                    self.yieldClosed(err)
                case .cancelled:
                    self.yieldClosed(nil)
                default: break
                }
            }
            conn.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self else { return }
                if resumed.trip() {
                    self.conn.cancel()
                    k.resume(throwing: RpcError(code: -4, message: "unix socket connect timed out"))
                }
            }
        }
    }

    private func receiveLoop() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty { self.cont.yield(.data(data)) }
            if isComplete || error != nil { self.yieldClosed(error); return }
            self.receiveLoop()
        }
    }

    public func send(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { err in
                if let err { k.resume(throwing: err) } else { k.resume() }
            })
        }
    }

    public func close() {
        conn.cancel() // stateUpdateHandler(.cancelled) → yieldClosed
    }

    private func yieldClosed(_ err: Error?) {
        if closedOnce.trip() {
            cont.yield(.closed(err))
            cont.finish()
        }
    }
}

/// Trips exactly once; returns true only for the tripping caller.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var tripped = false
    func trip() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if tripped { return false }
        tripped = true
        return true
    }
}

public enum NormaPaths {
    /// Mirror of core's resolveNormaHome(): `$NORMA_HOME` ?? `~/.norma`. The single source of
    /// truth every other path in this type (and, per SP2b T5, `RemoteAccessCoordinator`'s own
    /// `storeDir`) derives from — added so a caller needing some OTHER path under the Norma home
    /// (not socket/settings) can reuse this instead of re-deriving the same env-var-or-default
    /// logic a third time.
    public static func homeDirectory() -> String {
        ProcessInfo.processInfo.environment["NORMA_HOME"]
            ?? (NSHomeDirectory() + "/.norma")
    }

    /// Mirror of core's resolveNormaHome(): $NORMA_HOME ?? ~/.norma, + /run/core.sock.
    public static func socketPath() -> String {
        homeDirectory() + "/run/core.sock"
    }

    /// Mirror of core's resolveNormaHome(): $NORMA_HOME ?? ~/.norma, + /settings.json.
    public static func settingsPath() -> String {
        homeDirectory() + "/settings.json"
    }
}
