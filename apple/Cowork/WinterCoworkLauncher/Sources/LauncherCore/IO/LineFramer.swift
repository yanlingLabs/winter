import Foundation

/// One NDJSON line (its trailing newline included) and the descriptors that arrived WITH it.
public struct FramedLine {
    public let bytes: [UInt8]
    public let rights: [OwnedFD]
}

/// Why the framer gave up. After any of these the channel is no longer trustworthy.
public enum FramingFailure: Error, Equatable {
    /// Descriptors arrived anywhere but at the first byte of a line (or with no bytes at all).
    case rightsOffBoundary
    case lineTooLong
}

/*
 * Cuts the L1 byte stream into lines and attributes SCM_RIGHTS to the line it belongs to (docs/cowork-native-worker.md, 4.3).
 *
 * On a stream socket the descriptors of a sendmsg ride with the FIRST byte of that sendmsg's data. So descriptors that arrive
 * in a chunk belong to the line that STARTS at the first byte of that chunk, and a chunk that carries descriptors but does not
 * start a line (a partial line is pending) is a protocol violation. The line that owns them may complete in this chunk or a
 * later one. Whether those descriptors are the RIGHT ones for that line (exactly two, on `volumes`, nowhere else) is the line
 * parser's refusal (`bad_rights`), which closes them by dropping them.
 *
 * Any throw leaves every descriptor handed to this framer closed (they are `OwnedFD`s that are simply dropped).
 */
public struct LineFramer {
    private var pending: [UInt8] = []
    private var pendingRights: [OwnedFD] = []
    private let maxLine: Int
    public init(maxLine: Int = WireLimits.muxLineBytes) { self.maxLine = maxLine }
    public var bufferedBytes: Int { pending.count }

    public mutating func feed(_ chunk: [UInt8], rights: [OwnedFD]) throws -> [FramedLine] {
        if !rights.isEmpty {
            // Rights only at a line boundary, only with bytes, and only once per line.
            guard pending.isEmpty, !chunk.isEmpty, pendingRights.isEmpty else { throw FramingFailure.rightsOffBoundary }
            pendingRights = rights
        }
        var lines: [FramedLine] = []
        var start = 0
        // `firstIndex(of:)` rather than a byte loop: a relayed frame is a megabyte-sized line cut into 64 KiB chunks.
        while let newline = chunk[start...].firstIndex(of: 0x0a) {
            var line = pending
            line.append(contentsOf: chunk[start...newline])
            guard line.count <= maxLine else { throw FramingFailure.lineTooLong }
            pending.removeAll(keepingCapacity: true)
            // The first line completed since the descriptors arrived owns them.
            lines.append(FramedLine(bytes: line, rights: pendingRights))
            pendingRights = []
            start = newline + 1
        }
        pending.append(contentsOf: chunk[start...])
        guard pending.count <= maxLine else { throw FramingFailure.lineTooLong }
        return lines
    }
}
