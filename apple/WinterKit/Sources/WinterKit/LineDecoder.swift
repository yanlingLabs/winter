import Foundation

public enum LineDecoderError: Error, Equatable {
    case lineTooLong(max: Int)
}

/// Byte-accurate NDJSON line splitter — Swift mirror of @winter/protocol's LineDecoder.
/// Safe across UTF-8 chunk boundaries (splits on raw 0x0a bytes, decodes only whole lines).
/// Blank lines are skipped. If the buffered partial line exceeds `maxLine`, the buffer is
/// reset and `.lineTooLong` is thrown (matching the TS decoder's hostile-peer guard).
public final class LineDecoder {
    private var buf = Data()
    private let maxLine: Int

    public init(maxLine: Int = 8 * 1024 * 1024) {
        self.maxLine = maxLine
    }

    public func push(_ chunk: Data) throws -> [String] {
        buf.append(chunk)
        var lines: [String] = []
        while let nl = buf.firstIndex(of: 0x0a) {
            let lineData = buf[buf.startIndex..<nl]
            if !lineData.isEmpty { lines.append(String(decoding: lineData, as: UTF8.self)) }
            buf = Data(buf[buf.index(after: nl)...]) // re-base: Data slices keep parent indices
        }
        if buf.count > maxLine {
            buf = Data()
            throw LineDecoderError.lineTooLong(max: maxLine)
        }
        return lines
    }
}
