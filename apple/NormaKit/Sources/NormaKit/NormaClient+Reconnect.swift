import Foundation

extension NormaClient {
    func startReconnect() {
        // Task 9 review fix 1: `reconnecting` prevents a second concurrent loop from spawning when
        // a transport drop lands while one is already in flight (e.g. the replacement transport
        // itself drops mid-handshake, which re-delivers .closed through the SAME onDisconnected()
        // hook). Without this guard that re-entry would start a duplicate loop → duplicate
        // hello/attach traffic and an orphaned, never-closed transport.
        guard everConnected, !deliberatelyClosed, !reconnecting else { return }
        reconnecting = true
        Task { await self.reconnectLoop() }
    }

    private func reconnectLoop() async {
        // Cleared on EVERY exit path (normal return, deliberate-close abort, or the while loop
        // simply falling through) so a later, genuinely-new disconnect can reconnect again.
        defer { reconnecting = false }
        var attempt = 1
        while !deliberatelyClosed {
            eventsCont.yield(.connection(.reconnecting(attempt: attempt)))
            let backoff = min(0.5 * pow(2.0, Double(attempt - 1)), 10.0)
            try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            // Task 9 review fix 2: a close() landing during the backoff sleep must abort the
            // attempt outright — otherwise we'd go on to establish a live transport after a
            // deliberate close that nothing ever closes.
            if deliberatelyClosed { return }
            do {
                try await connect(role: currentRole) // fresh transport from the factory + hello, SAME role as before
                if let sid = attachedSessionId {
                    do {
                        _ = try await attach(sessionId: sid, fromSeq: lastSeq) // resync: replay > lastSeq
                    } catch let e as RpcError where e.code <= -32000 {
                        // SERVER answered: the connection is healthy but the session is gone
                        // (e.g. daemon state wiped). Stay connected, detached — the app layer
                        // decides what to attach next. attach() already restored the previous
                        // attachedSessionId on throw; clear it: that session is not coming back.
                        attachedSessionId = nil
                    }
                    // transport-layer RpcError (-1/-2/-4/-5) or any other error falls to the
                    // outer catch below and is retried — after closing the fresh transport.
                }
                // Re-check once more: close() may have landed during connect()/attach() (both
                // await network round-trips). If so, don't surface .connected — close the
                // transport connect() just installed instead of leaving it live and orphaned.
                if deliberatelyClosed {
                    transport?.close()
                    return
                }
                // AMENDMENT 1: connect() itself no longer yields .connected (removed in Task 7 —
                // AsyncStream pre-iterator buffering made it the first value every iterator saw).
                // This loop is the sole source of the .connected transition on (re)connect success.
                eventsCont.yield(.connection(.connected))
                return
            } catch {
                // M1: the attempt's fresh transport must not leak while we retry on another.
                transport?.close()
                transport = nil
                attempt += 1
            }
        }
    }
}
