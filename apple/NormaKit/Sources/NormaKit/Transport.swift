import Foundation
import WinterProtocol

public enum TransportEvent: Sendable {
    case data(Data)
    case closed(Error?)
}

/// Byte transport under WinterClient. Implementations: NWConnectionTransport (Task 9),
/// ScriptedTransport (tests). `incoming` must yield `.closed` exactly once at end of life.
public protocol WinterTransport: Sendable {
    func open() async throws
    func send(_ data: Data) async throws
    var incoming: AsyncStream<TransportEvent> { get }
    func close()
}

public enum ConnectionState: Equatable, Sendable {
    case connected
    case disconnected
    case reconnecting(attempt: Int)
}

public enum WinterEvent: Sendable {
    case session(SessionEvent)
    /// Wire-valid event of a type this build doesn't know (newer daemon) — raw NDJSON line.
    case unknown(raw: String)
    case connection(ConnectionState)
}
