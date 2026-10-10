import Foundation

/// Chrome native messaging, incoming: each message is a 4-byte native-endian (little-endian on every Mac) length, then
/// that many bytes of UTF-8 JSON. Incremental — feed it whatever `read` returned. A message over the cap is skipped
/// (its bytes consumed and dropped, the stream kept in step) and reported once.
public struct NativeMessageDecoder {
    public enum Item: Equatable {
        case message(Data)
        case oversized(Int)
    }

    private var buffer = Data()
    private var skipping = 0
    public let maxMessage: Int

    public init(maxMessage: Int = HostProtocol.maxExtensionMessage) {
        self.maxMessage = maxMessage
    }

    public mutating func push(_ chunk: Data) -> [Item] {
        var items: [Item] = []
        var input = chunk
        if skipping > 0 {
            let drop = min(skipping, input.count)
            skipping -= drop
            input = input.dropFirst(drop)
            if input.isEmpty { return items }
        }
        buffer.append(input)
        while buffer.count >= 4 {
            let b = [UInt8](buffer.prefix(4))
            let length = Int(UInt32(b[0]) | UInt32(b[1]) << 8 | UInt32(b[2]) << 16 | UInt32(b[3]) << 24)
            if length > maxMessage {
                items.append(.oversized(length))
                let available = buffer.count - 4
                if available >= length {
                    buffer = Data(buffer.dropFirst(4 + length))
                } else {
                    skipping = length - available
                    buffer = Data()
                }
                continue
            }
            guard buffer.count >= 4 + length else { break }
            items.append(.message(Data(buffer[buffer.startIndex + 4 ..< buffer.startIndex + 4 + length])))
            buffer = Data(buffer.dropFirst(4 + length))
        }
        return items
    }
}

public enum NativeMessageEncoder {
    /// The framed bytes for one message to Chrome, or nil when it is over Chrome's 1 MiB limit.
    public static func frame(_ payload: Data, maxMessage: Int = HostProtocol.maxHostMessage) -> Data? {
        guard payload.count <= maxMessage else { return nil }
        var length = UInt32(payload.count).littleEndian
        var out = Data(bytes: &length, count: 4)
        out.append(payload)
        return out
    }
}

/// NDJSON from the daemon: complete lines (without the newline), blank lines skipped. A partial line growing past the cap
/// is a protocol violation: `push` throws and the caller drops the connection.
public struct LineDecoder {
    public struct TooLong: Error, Equatable {}

    private var buffer = Data()
    public let maxLine: Int

    public init(maxLine: Int = HostProtocol.maxDaemonLine) {
        self.maxLine = maxLine
    }

    public mutating func push(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex ..< nl]
            if line.count > maxLine { throw TooLong() }
            if !line.isEmpty { lines.append(Data(line)) }
            buffer = Data(buffer[(nl + 1)...])
        }
        if buffer.count > maxLine { throw TooLong() }
        return lines
    }
}

public enum LineEncoder {
    /// One JSON message as one NDJSON line. Raw CR/LF bytes can only be insignificant whitespace in valid JSON (a string
    /// may not contain them unescaped), so they become spaces; nothing else changes.
    public static func line(_ json: Data) -> Data {
        var out = Data(json.map { $0 == 0x0A || $0 == 0x0D ? 0x20 : $0 })
        out.append(0x0A)
        return out
    }
}

/// The one thing the relay reads in a message: that it is a JSON-RPC 2.0 object, and its kind.
public enum Envelope: Equatable {
    case request(id: String, method: String)
    case notification(method: String)
    case response(id: String)

    public static func parse(_ data: Data) -> Envelope? {
        guard let object = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any],
              object["jsonrpc"] as? String == "2.0" else { return nil }
        let id: String? = (object["id"] as? String) ?? (object["id"] as? NSNumber).map { $0.stringValue }
        if let method = object["method"] as? String {
            if let id { return .request(id: id, method: method) }
            return object["id"] == nil ? .notification(method: method) : nil
        }
        if let id, object["result"] != nil || object["error"] != nil { return .response(id: id) }
        return nil
    }
}
