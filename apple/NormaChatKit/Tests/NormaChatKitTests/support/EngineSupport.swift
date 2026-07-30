import Foundation
import NormaProtocol
@testable import NormaChatKit

/// A minimal `LocalSession` for engine tests — Task 9's real store conforms the same protocol. Holds
/// a fixed prior-input and records reasoning appends (proving the opaque sink is used and never
/// surfaced through `emit`).
final class ScriptedLocalSession: LocalSession, @unchecked Sendable {
    let sessionId: String
    let lastSeq: Int
    private let prior: [ProviderInputItem]
    private let lock = NSLock()
    private(set) var reasoningAppends: [(itemJSON: String, seq: Int)] = []

    init(sessionId: String = "ses_test", lastSeq: Int = 0, prior: [ProviderInputItem] = []) {
        self.sessionId = sessionId
        self.lastSeq = lastSeq
        self.prior = prior
    }

    func priorInput() -> [ProviderInputItem] { prior }

    func appendReasoning(itemJSON: String, seq: Int, ts: Int) {
        lock.withLock { reasoningAppends.append((itemJSON, seq)) }
    }
}

/// A DAEMON-FAITHFUL `LocalSession`: its `emit` sink persists user/assistant/tool events into the
/// very log `priorInput()` folds (exactly what Task 11's wiring does), so `priorInput()` is DYNAMIC,
/// not static. This is the double that makes the turn-start-snapshot bug bite: if the engine read
/// `priorInput()` after emitting `user_message`, the current user message would appear twice in the
/// next round's provider input. Wire `runTurn(emit:)` to `record` to exercise the real sink shape.
final class PersistingLocalSession: LocalSession, @unchecked Sendable {
    let sessionId: String
    private let lock = NSLock()
    private var log: [ProviderInputItem] = []
    private var head = 0

    init(sessionId: String = "ses_persist") { self.sessionId = sessionId }

    var lastSeq: Int { lock.withLock { head } }
    func priorInput() -> [ProviderInputItem] { lock.withLock { log } }

    func appendReasoning(itemJSON: String, seq: Int, ts: Int) {
        lock.withLock { log.append(.reasoning(itemJSON: itemJSON)); head = max(head, seq) }
    }

    /// The persist-on-emit sink — fold each renderable, PERSISTED event into the provider-input log
    /// exactly as `engine.ts`'s `eventToInput` does. Transient `assistant_delta` is ignored (never
    /// persisted); its seq rides the head, so it can't advance it past a real event.
    func record(_ event: SessionEvent) {
        lock.withLock {
            switch event {
            case .userMessage(let v): log.append(.message(role: .user, content: v.text)); head = max(head, v.seq)
            case .assistantMessage(let v): log.append(.message(role: .assistant, content: v.text)); head = max(head, v.seq)
            case .toolCall(let v): log.append(.functionCall(callId: v.callId, name: v.name, argumentsJSON: v.argsJson)); head = max(head, v.seq)
            case .toolResult(let v): log.append(.toolResult(callId: v.callId, output: v.output, isError: v.isError)); head = max(head, v.seq)
            case .turnStarted(let v): head = max(head, v.seq)
            case .turnCompleted(let v): head = max(head, v.seq)
            case .questionAsked(let v): head = max(head, v.seq)
            case .questionResolved(let v): head = max(head, v.seq)
            case .agentError(let v): head = max(head, v.seq)
            case .assistantDelta: break // transient — never persisted
            default: break
            }
        }
    }
    var callback: @Sendable (SessionEvent) -> Void { { self.record($0) } }
}

/// Thread-safe ordered sink for the events a turn emits.
final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var events: [SessionEvent] = []
    func emit(_ event: SessionEvent) { lock.withLock { events.append(event) } }
    var callback: @Sendable (SessionEvent) -> Void { { self.emit($0) } }

    var types: [String] { lock.withLock { events.map { $0.typeName } } }
    func first<T>(_ transform: (SessionEvent) -> T?) -> T? { lock.withLock { events.lazy.compactMap(transform).first } }
    func all<T>(_ transform: (SessionEvent) -> T?) -> [T] { lock.withLock { events.compactMap(transform) } }
}

/// A provider that yields a scripted prefix, then holds the stream open until the CONSUMING task is
/// cancelled (bare finish). Drives the ChatEngine interrupt test — an interrupt mid-stream must close
/// the turn with `turn_completed(aborted)`.
final class HangingProvider: ChatProvider, @unchecked Sendable {
    private let prefix: [ProviderEvent]
    let streaming = TestGate()
    init(prefix: [ProviderEvent]) { self.prefix = prefix }
    func streamTurn(_ request: ProviderTurnRequest) -> AsyncStream<ProviderEvent> {
        let prefix = self.prefix
        let gate = streaming
        return AsyncStream { continuation in
            let task = Task {
                for event in prefix { continuation.yield(event) }
                gate.open()
                do { try await Task.sleep(for: .seconds(3600)) } catch {}
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - SessionEvent conveniences for assertions

extension SessionEvent {
    var typeName: String {
        switch self {
        case .userMessage: return "user_message"
        case .turnStarted: return "turn_started"
        case .assistantDelta: return "assistant_delta"
        case .assistantMessage: return "assistant_message"
        case .toolCall: return "tool_call"
        case .toolResult: return "tool_result"
        case .questionAsked: return "question_asked"
        case .questionResolved: return "question_resolved"
        case .agentError: return "agent_error"
        case .turnCompleted: return "turn_completed"
        default: return "other"
        }
    }
}

// MARK: - engine-event fixture locator

/// Locates the TS-generated `SessionEvent` fixtures the same way `ParityFixtures` finds the parity
/// vectors — a source-relative path off `#filePath` (SwiftPM resource bundling can only carry files
/// inside the target). The two non-event parity files are excluded so this set is exactly the event
/// dialect both engines share.
enum EventFixtures {
    static let excluded: Set<String> = ["cleaner-vectors.json", "dangerous-domains.json"]

    static func urls() -> [URL] {
        let dir = ParityFixtures.directory
        let all = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return all.filter { $0.pathExtension == "json" && !excluded.contains($0.lastPathComponent) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
}
