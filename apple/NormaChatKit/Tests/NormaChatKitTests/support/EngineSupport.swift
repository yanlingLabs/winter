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
