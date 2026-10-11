import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 Phase 4 — Winter Headless's PIPE: the daemon ↔ the helper, NDJSON over the two descriptors the
// daemon spawned it with (fd 3: the daemon's commands, read here; fd 4: everything this side says).
//
// No socket, no token, no handshake to refuse: the daemon made the pipe, so whoever is on the far end IS the
// daemon. The vocabulary is the browser link's (`BrowserLinkProtocol`): the daemon sends
// `browserLink.command {linkId, cmdId, op, params}` notifications; this side answers each with ONE
// `browserLink.result` notification and sends `browserLink.events` / `browserLink.tabGone` of its own. Three
// differences from Winter.app's link:
//   * this side speaks first: `headless.hello {protocol, linkId, pid, version}` once CEF is up — the linkId is this
//     process's, and every command must carry it;
//   * one more op, `context.dispose {sessionId}` → `{closed}`, read here before `BrowserLinkCommand.parse`
//     (Winter.app's op set, and its protocol number, do not change);
//   * `tab.ensure` WITH a `url` creates a missing tab; without one it never does (`HeadlessHost`).
// The helper exits when fd 3 reaches EOF — which is also how a daemon that died takes the helper with it.
// The daemon's half is `packages/core/src/computer-use/browser/headless/winter-engine.ts`.
// -----------------------------------------------------------------------------------------------

enum HeadlessWire {
    /// Bumped on any observable change to this pipe. The daemon's `HEADLESS_PIPE_PROTOCOL` must equal it.
    static let protocolVersion = 1

    enum Method {
        static let hello = "headless.hello"
        static let command = BrowserLinkProtocol.Method.command
        static let result = BrowserLinkProtocol.Method.result
        static let events = BrowserLinkProtocol.Method.events
        static let tabGone = BrowserLinkProtocol.Method.tabGone
        static let notice = "headless.notice"
    }

    enum Op {
        static let contextDispose = "context.dispose"
    }

    /// The longest command line read (the daemon's own cap on a command is 1 MiB).
    static let commandLineMax = 2 * 1024 * 1024

    /// One line read from fd 3.
    enum Inbound: Equatable {
        case command(BrowserLinkCommand)
        case contextDispose(linkId: String, cmdId: String, sessionId: String)
        /// A command that named itself (`cmdId`) but could not be read: still owed a failure.
        case unreadable(linkId: String?, cmdId: String?, reason: String)
        /// Not a command at all — logged and dropped.
        case ignored(reason: String)
    }

    static func parse(_ line: Data) -> Inbound {
        guard let message = try? JSONDecoder().decode(JSONValue.self, from: line), case .object = message else {
            return .ignored(reason: "a line that is not a JSON object")
        }
        guard message["method"]?.stringValue == Method.command, let params = message["params"] else {
            return .ignored(reason: "a message that is not \(Method.command)")
        }
        if params["op"]?.stringValue == Op.contextDispose {
            let linkId = params["linkId"]?.stringValue
            let cmdId = params["cmdId"]?.stringValue
            guard let linkId, let cmdId else {
                return .unreadable(linkId: linkId, cmdId: cmdId, reason: "a command without linkId/cmdId")
            }
            guard let sessionId = params["params"]?["sessionId"]?.stringValue, !sessionId.isEmpty else {
                return .unreadable(linkId: linkId, cmdId: cmdId, reason: "context.dispose needs sessionId")
            }
            return .contextDispose(linkId: linkId, cmdId: cmdId, sessionId: sessionId)
        }
        switch BrowserLinkCommand.parse(params) {
        case .success(let command):
            return .command(command)
        case .failure(let unreadable):
            return .unreadable(linkId: unreadable.linkId, cmdId: unreadable.cmdId, reason: unreadable.reason)
        }
    }
}

/// The cut that keeps one event's strings bounded — the same rule, marker and limits as Winter.app's link
/// (`BrowserLinkEventLimits`, which lives beside Winter.app's socket client and is not compiled here).
enum HeadlessEventLimits {
    static func marker(originalBytes: Int) -> String { "…[cut by Winter: \(originalBytes) bytes]" }

    static func truncatingLongStrings(_ value: JSONValue, maxBytes: Int) -> JSONValue {
        switch value {
        case .string(let text):
            return .string(truncated(text, maxBytes: maxBytes))
        case .array(let items):
            return .array(items.map { truncatingLongStrings($0, maxBytes: maxBytes) })
        case .object(let fields):
            return .object(fields.mapValues { truncatingLongStrings($0, maxBytes: maxBytes) })
        default:
            return value
        }
    }

    static func truncated(_ text: String, maxBytes: Int) -> String {
        let total = text.utf8.count
        guard total > maxBytes else { return text }
        var kept = String.UnicodeScalarView()
        var bytes = 0
        for scalar in text.unicodeScalars {
            let size = String(scalar).utf8.count
            if bytes + size > maxBytes { break }
            kept.append(scalar)
            bytes += size
        }
        return String(kept) + marker(originalBytes: total)
    }
}

/// What leaves on fd 4, in the order it was produced, as complete lines. Not thread-safe: `HeadlessLink` drives it
/// on its one output queue (tests drive it directly).
///
/// Events wait in a batch — at most `batchMax` of them, `batchMaxBytes` in all, and `flushWindow` from the first —
/// and anything else (a result, a gone tab) first sends the batch ahead of it, so the daemon reads things in the
/// order they happened. Every event is bounded before it leaves: strings cut, an event still too large dropped
/// (logged by method only), a batch split before a line could grow past the cap.
final class HeadlessOutbox {
    struct Limits {
        var batchMax = BrowserLinkProtocol.eventBatchMax
        var stringMaxBytes = BrowserLinkProtocol.eventStringMaxBytes
        var eventMaxBytes = BrowserLinkProtocol.eventMaxBytes
        var batchMaxBytes = BrowserLinkProtocol.eventBatchMaxBytes
    }

    struct PendingEvent {
        let tabId: String
        let method: String
        let params: Data
        let cdpSessionId: String?
        let strip: Bool
    }

    let linkId: String
    private let limits: Limits
    private let log: (String) -> Void
    private var pending: [PendingEvent] = []
    private var pendingBytes = 0

    init(linkId: String, limits: Limits = Limits(), log: @escaping (String) -> Void = { _ in }) {
        self.linkId = linkId
        self.limits = limits
        self.log = log
    }

    var hasPendingEvents: Bool { !pending.isEmpty }

    /// Queue one event; the lines to write now when the batch is full.
    func event(_ event: PendingEvent) -> [Data] {
        pending.append(event)
        pendingBytes += event.params.count
        if pending.count >= limits.batchMax || pendingBytes >= limits.batchMaxBytes {
            return flush()
        }
        return []
    }

    /// The batch, as one or more `browserLink.events` lines (empty when nothing waits).
    func flush() -> [Data] {
        guard !pending.isEmpty else { return [] }
        let batch = pending
        pending = []
        pendingBytes = 0
        let encoder = JSONEncoder()
        var chunks: [[JSONValue]] = [[]]
        var chunkBytes = 0
        for event in batch {
            var params = (try? JSONDecoder().decode(JSONValue.self, from: event.params)) ?? .object([:])
            if case .object = params {} else { params = .object([:]) }
            if event.strip { params = CDPTabGate.reducedParams(method: event.method, params: params) }
            params = HeadlessEventLimits.truncatingLongStrings(params, maxBytes: limits.stringMaxBytes)
            var entry: [String: JSONValue] = ["tabId": .string(event.tabId), "method": .string(event.method), "params": params]
            if let session = event.cdpSessionId { entry["cdpSessionId"] = .string(session) }
            let value = JSONValue.object(entry)
            let size = (try? encoder.encode(value).count) ?? Int.max
            guard size <= limits.eventMaxBytes else {
                log("headless: dropped one \(event.method) event over \(limits.eventMaxBytes) bytes")
                continue
            }
            if chunkBytes + size > limits.batchMaxBytes, !(chunks.last?.isEmpty ?? true) {
                chunks.append([])
                chunkBytes = 0
            }
            chunks[chunks.count - 1].append(value)
            chunkBytes += size + 1
        }
        return chunks.filter { !$0.isEmpty }.map { events in
            Self.line(method: HeadlessWire.Method.events, params: ["linkId": .string(linkId), "events": .array(events)])
        }
    }

    /// The pending events, then the result.
    func result(cmdId: String, reply: BrowserLinkReply) -> [Data] {
        var lines = flush()
        lines.append(resultLine(cmdId: cmdId, reply: reply))
        return lines
    }

    func tabGone(tabId: String, reason: BrowserLinkProtocol.TabGoneReason) -> [Data] {
        var lines = flush()
        lines.append(Self.line(method: HeadlessWire.Method.tabGone,
                               params: ["linkId": .string(linkId), "tabId": .string(tabId), "reason": .string(reason.rawValue)]))
        return lines
    }

    /// A page tried something the browser refused — after the events already pending, so it follows them.
    func notice(tabId: String, kind: String) -> [Data] {
        var lines = flush()
        lines.append(Self.line(method: HeadlessWire.Method.notice,
                               params: ["linkId": .string(linkId), "tabId": .string(tabId), "kind": .string(kind)]))
        return lines
    }

    func hello(pid: Int32, version: String?) -> Data {
        var params: [String: JSONValue] = ["protocol": .number(Double(HeadlessWire.protocolVersion)), "linkId": .string(linkId),
                                           "pid": .number(Double(pid))]
        if let version { params["version"] = .string(version) }
        return Self.line(method: HeadlessWire.Method.hello, params: params)
    }

    // MARK: - Lines

    private func resultLine(cmdId: String, reply: BrowserLinkReply) -> Data {
        switch reply {
        case .ok(let value):
            return Self.line(method: HeadlessWire.Method.result,
                             params: ["linkId": .string(linkId), "cmdId": .string(cmdId), "ok": .bool(true), "result": value])
        case .okRaw(let key, let json):
            // A CDP result the browser already wrote as JSON (a screenshot's is megabytes): checked, then placed in
            // the line as it is, never rebuilt as a tree.
            let bytes = json.utf8.count
            guard BrowserLinkProtocol.resultFits(bytes: bytes) else {
                return resultLine(cmdId: cmdId, reply: BrowserLinkProtocol.resultTooLarge(bytes: bytes))
            }
            guard let raw = json.data(using: .utf8),
                  (try? JSONSerialization.jsonObject(with: raw, options: [])) is [String: Any] else {
                return resultLine(cmdId: cmdId, reply: .failure(
                    code: .cdpError, message: "the browser's answer was not JSON",
                    data: .object(["cdpCode": .number(-32603), "cdpMessage": .string("unreadable result")])))
            }
            var line = Data(#"{"jsonrpc":"2.0","method":"#.utf8)
            line.append(Self.jsonString(HeadlessWire.Method.result))
            line.append(Data(#","params":{"linkId":"#.utf8))
            line.append(Self.jsonString(linkId))
            line.append(Data(#","cmdId":"#.utf8))
            line.append(Self.jsonString(cmdId))
            line.append(Data(#","ok":true,"result":{"#.utf8))
            line.append(Self.jsonString(key))
            line.append(Data(":".utf8))
            line.append(raw)
            line.append(Data("}}}\n".utf8))
            return line
        case .failure(let code, let message, let data):
            var error: [String: JSONValue] = [
                "code": .string(code.rawValue),
                "message": .string(HeadlessEventLimits.truncated(message, maxBytes: BrowserLinkProtocol.failureMessageMaxBytes)),
            ]
            if let data { error["data"] = data }
            return Self.line(method: HeadlessWire.Method.result,
                             params: ["linkId": .string(linkId), "cmdId": .string(cmdId), "ok": .bool(false), "error": .object(error)])
        }
    }

    static func line(method: String, params: [String: JSONValue]) -> Data {
        let message = JSONValue.object(["jsonrpc": .string("2.0"), "method": .string(method), "params": .object(params)])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        var data = (try? encoder.encode(message)) ?? Data("{}".utf8)
        data.append(0x0a)
        return data
    }

    private static func jsonString(_ text: String) -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return (try? encoder.encode(text)) ?? Data("\"\"".utf8)
    }
}
