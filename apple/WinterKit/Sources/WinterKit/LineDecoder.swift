import Foundation

public enum LineDecoderError: Error, Equatable {
    case lineTooLong(max: Int)
}

/// Byte-accurate NDJSON line splitter — Swift mirror of @yanlinglabs/winter-protocol's LineDecoder.
/// Safe across UTF-8 chunk boundaries (splits on raw 0x0a bytes, decodes only whole lines).
/// Blank lines are skipped. If the buffered partial line exceeds `maxLine`, the buffer is
/// reset and `.lineTooLong` is thrown (matching the TS decoder's hostile-peer guard).
///
/// **Linear in the bytes pushed.** A partial line is scanned for its newline exactly once — `scanned`
/// remembers how far — and the buffer is compacted once per push, not once per line. The first version
/// searched the whole buffer from its start on every push and re-copied the remainder after every line,
/// which is quadratic in a long line that arrives in small chunks (the helper's mirror frames are
/// ~100-300 KB lines on a socket that delivers 16-64 KB at a time) and in a backlog of many lines in
/// one chunk: a Debug Winter Dev spent 2,146 of 2,241 samples inside `push` while idle.
public final class LineDecoder {
    private var buf = Data()
    /// How many bytes at the front of `buf` are known to hold no newline.
    private var scanned = 0
    private let maxLine: Int

    public init(maxLine: Int = 8 * 1024 * 1024) {
        self.maxLine = maxLine
    }

    public func push(_ chunk: Data) throws -> [String] {
        try pushData(chunk).map { String(decoding: $0, as: UTF8.self) }
    }

    /// The same split, returning each whole line as the bytes it arrived in — for a caller that parses
    /// JSON from bytes and would otherwise encode a `String` straight back into `Data`.
    public func pushData(_ chunk: Data) throws -> [Data] {
        buf.append(chunk)
        var lines: [Data] = []
        var consumed = 0
        buf.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            let total = raw.count
            var from = scanned
            while from < total, let hit = memchr(base + from, 0x0a, total - from) {
                let newline = UnsafeRawPointer(hit) - base
                if newline > consumed { lines.append(Data(bytes: base + consumed, count: newline - consumed)) }
                consumed = newline + 1
                from = consumed
            }
        }
        if consumed > 0 { buf.removeSubrange(buf.startIndex..<buf.startIndex + consumed) }
        // What is left holds no newline, so the next push starts looking after it.
        scanned = buf.count
        if buf.count > maxLine {
            buf = Data()
            scanned = 0
            throw LineDecoderError.lineTooLong(max: maxLine)
        }
        return lines
    }
}
