import Foundation
import NormaKit
import NormaProtocol

func out(_ s: String, newline: Bool = true) {
    FileHandle.standardOutput.write(Data((s + (newline ? "\n" : "")).utf8))
}

func summarize(_ e: SessionEvent) -> String {
    switch e {
    case .assistantMessage(let v): return "[\(v.seq)] assistant_message: \(v.text.prefix(100))"
    case .userMessage(let v): return "[\(v.seq)] user_message(\(v.clientName)): \(v.text.prefix(100))"
    case .turnStarted(let v): return "[\(v.seq)] turn_started (\(v.threadId))"
    case .turnCompleted(let v): return "[\(v.seq)] turn_completed: \(v.stopReason) in=\(v.inputTokens) out=\(v.outputTokens)"
    case .toolCall(let v): return "[\(v.seq)] tool_call: \(v.name) \(v.argsJson.prefix(80))"
    case .toolResult(let v): return "[\(v.seq)] tool_result(\(v.isError ? "ERR" : "ok")): \(v.output.prefix(80))"
    case .approvalRequested(let v): return "[\(v.seq)] approval_requested: \(v.toolName) — \(v.summary.prefix(80))"
    case .approvalResolved(let v): return "[\(v.seq)] approval_resolved: \(v.approved ? "approved" : "denied") by \(v.by)"
    case .harnessAttached(let v): return "[\(v.seq)] harness_attached: \(v.clientName)"
    case .harnessDetached(let v): return "[\(v.seq)] harness_detached: \(v.clientName)"
    case .assistantDelta: return "" // handled inline by the caller
    default: return "[\(e.seq)] \(String(describing: e).prefix(110))"
    }
}

let args: ProbeArgs
switch ProbeArgs.parse(Array(CommandLine.arguments.dropFirst())) {
case .failure(let err): out(err.message); exit(2)
case .success(let a): args = a
}

let socketPath = args.socket ?? NormaPaths.socketPath()
let keychainService = args.dev ? "com.norma.core.dev" : "com.norma.core"
let token: String
if let t = args.token { token = t }
else {
    out("reading harness token from Keychain (\(keychainService)) — a permission prompt may appear; pass --token to skip")
    do { token = try KeychainToken.readHarnessToken(service: keychainService) }
    catch {
        out("cannot read harness token from Keychain (\(error)) — is the daemon installed? Or pass --token\(args.dev ? "" : "/--dev").")
        exit(2)
    }
}

let client = NormaClient(
    makeTransport: { UnixSocketTransport(path: socketPath) },
    token: token,
    clientName: "norma-probe"
)

let semaphore = DispatchSemaphore(value: 0)
Task {
    defer { semaphore.signal() }
    do {
        try await client.connect()
        switch args.command {
        case "list":
            for s in try await client.listSessions() {
                out("\(s.sessionId)  scope=\(s.scope)  lastSeq=\(s.lastSeq)")
            }
        case "create":
            let r = try await client.createSession(scope: args.positional[0], cwd: args.cwd)
            out(r.sessionId)
        case "send":
            let sid = args.positional[0]
            // session.send requires an attached connection (hub membership check). Attach from
            // the session's CURRENT lastSeq so the replay is empty — fire-and-forget send.
            guard let session = try await client.listSessions().first(where: { $0.sessionId == sid }) else {
                out("unknown session: \(sid)"); exit(1)
            }
            _ = try await client.attach(sessionId: sid, fromSeq: session.lastSeq)
            let text = args.positional.dropFirst().joined(separator: " ")
            let seq = try await client.send(sessionId: sid, text: text)
            out("sent seq=\(seq)")
        case "attach":
            let sid = args.positional[0]
            let last = try await client.attach(sessionId: sid, fromSeq: args.from ?? 0)
            out("attached to \(sid) (server lastSeq \(last)) — streaming, Ctrl-C to quit")
            var midStream = false
            for await ev in client.events {
                if case .session(.assistantDelta(let d)) = ev {
                    out(d.delta, newline: false) // token streaming, no newline
                    midStream = true
                    continue
                }
                if midStream { out(""); midStream = false } // terminate the streamed line first
                switch ev {
                case .session(let e):
                    let line = summarize(e)
                    if !line.isEmpty { out(line) }
                case .unknown(let raw):
                    out("[?] unknown event: \(raw.prefix(110))")
                case .connection(let s):
                    out("[conn] \(s)")
                }
            }
        default:
            out(ProbeArgs.usage)
        }
        if args.command != "attach" { await client.close() }
    } catch {
        out("error: \(error)")
        exit(1)
    }
}
semaphore.wait()
