import Foundation

/*
 * Small primitives ported by reading (never by editing the sources) from apple/Cowork/WinterCoworkVM, the superseded
 * Virtualization.framework controller: `UnstartedReservation`, `DeviceOperationGate` and `EventQueue`. The shapes carry over; the
 * Containerization and async plumbing does not (the session here is synchronous on one serial queue). `CleanStopAuthority`
 * is `OrderlyStopAuthority` in StopAuthority.swift.
 */

/// From `UnstartedReservation`: the launcher's claim on "this launcher serves one worker". A reservation may be aborted only if
/// the worker was NEVER constructed; once the process exists, only termination proof (a reaped exit, a Class A or B receipt) ends it.
public final class WorkerReservation {
    public enum State: Equatable, Sendable { case idle, acquired, constructed }
    public enum Failure: Error, Equatable, Sendable {
        case busy
        /// "A constructed worker requires termination proof, never reservation abort."
        case abortDenied
    }
    public private(set) var state: State = .idle
    public init() {}

    public func acquire() throws {
        guard state == .idle else { throw Failure.busy }
        state = .acquired
    }
    public func markConstructed() { if state == .acquired { state = .constructed } }
    /// `didConstruct` is the caller's statement about the process; a lie is caught by the state: a constructed reservation cannot be aborted.
    public func abort(didConstruct: Bool) throws {
        guard !didConstruct, state != .constructed else { throw Failure.abortDenied }
        state = .idle
    }
}

/// From `DeviceOperationGate`: narrow lifecycle ordering only. Once the verdict is committed the gate closes and no further frame is
/// relayed in either direction; an operation already begun finishes. (The session is single-threaded, so `active` is only ever
/// non-zero inside one relay call, which is exactly the property the gate states.)
public final class RelayGate {
    public struct Closed: Error, Equatable, Sendable {}
    public private(set) var isClosing = false
    public private(set) var active = 0
    public init() {}
    public func begin() throws {
        guard !isClosing else { throw Closed() }
        active += 1
    }
    public func finish() { precondition(active > 0); active -= 1 }
    public func close() { isClosing = true }
}

/// From `EventQueue`: a bounded outbound queue whose reservations include the unconsumed terminal events, so a slow daemon can never
/// cause a completion, refusal or fault line to be lost: the headroom for terminal lines can never be used up by relay traffic.
public struct OutboundQueue {
    public enum Kind: Sendable { case terminal, control, relay }
    private var lines: [[UInt8]] = []
    public private(set) var bytes = 0
    public let softLimit: Int
    public let hardLimit: Int
    /// Relay traffic may use at most `hardLimit - terminalReserve`.
    public let terminalReserve: Int
    /// How far past `softLimit` relay traffic may still be queued before it is refused: the pause threshold must be REACHABLE, so the relay
    /// ceiling (`softLimit + relayHeadroom`) is at least one largest line plus one read above it. The reader is paused at `softLimit`; whatever
    /// it had already read still fits.
    public let relayHeadroom: Int

    public init(softLimit: Int = 4 << 20, terminalReserve: Int = 1 << 20, relayHeadroom: Int = 0) {
        self.softLimit = softLimit; self.terminalReserve = terminalReserve; self.relayHeadroom = relayHeadroom
        self.hardLimit = softLimit + relayHeadroom + terminalReserve
    }
    public var isEmpty: Bool { lines.isEmpty }
    /// Relay reads pause here; they resume once the daemon has drained below it.
    public var isBackpressured: Bool { bytes >= softLimit }

    /// False means the line does not fit: the channel is not keeping up and the caller must treat it as broken.
    public mutating func enqueue(_ line: [UInt8], kind: Kind) -> Bool {
        let ceiling = kind == .relay ? hardLimit - terminalReserve : hardLimit
        guard bytes + line.count <= ceiling else { return false }
        lines.append(line); bytes += line.count
        return true
    }
    public mutating func next() -> [UInt8]? {
        guard !lines.isEmpty else { return nil }
        let line = lines.removeFirst(); bytes -= line.count
        return line
    }
}
