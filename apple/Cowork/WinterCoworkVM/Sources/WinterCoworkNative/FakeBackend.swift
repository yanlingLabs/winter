import Foundation

/// Explicit no-VM backend for adapter/lifecycle tests. Never accesses a path,
/// launches a process, reads credentials or supplies production authority.
public actor FakeWorkspaceBackend: NativeWorkspaceBackend {
    private var running = false
    private let stopUncertain: Bool
    private let delayMilliseconds: UInt32
    public init(stopUncertain: Bool = false, delayMilliseconds: UInt32 = 5) {
        self.stopUncertain = stopUncertain; self.delayMilliseconds = delayMilliseconds
    }
    public func start() async throws { running = true }
    public func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess {
        guard running else { throw NativeFailure("guest_unavailable", "Fake guest is not running") }
        return FakeGuestProcess(arguments: arguments, delayMilliseconds: delayMilliseconds)
    }
    public func stats() async throws -> [String: String] { ["backend": "fake", "running": String(running), "reclaimVerified": "false"] }
    public func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { ["requestedAllowanceBytes": String(bytes), "reclaimVerified": "false"] }
    public func stop() async throws -> BackendStopResult {
        if !stopUncertain { running = false }
        return BackendStopResult(terminationConfirmed: !stopUncertain, flushConfirmed: !stopUncertain)
    }
}

private actor FakeGuestProcess: NativeGuestProcess {
    private let arguments: [String]
    private let delayMilliseconds: UInt32
    private var cancelled = false
    private var input: [UInt8] = []
    private var inputClosed = false
    init(arguments: [String], delayMilliseconds: UInt32) { self.arguments = arguments; self.delayMilliseconds = delayMilliseconds }
    func run(output: @escaping @Sendable (NativeEventKind, Data) throws -> Void) async throws -> Int32 {
        if arguments.first == "wait-input" {
            while !inputClosed && !cancelled { try await Task.sleep(for: .milliseconds(1)) }
            if cancelled { throw CancellationError() }
            try output(.stdout, Data(input)); return 0
        }
        let count = arguments.first == "long" ? 1000 : 1
        for _ in 0..<count {
            try await Task.sleep(for: .milliseconds(Int(delayMilliseconds)))
            if cancelled { throw CancellationError() }
            try output(.stdout, Data((arguments.last ?? "fake").utf8))
        }
        return 0
    }
    func completionMetadata() async -> [String: String] { ["outputCompletion": "verified-fake"] }
    func writeInput(_ data: Data) async throws {
        guard !inputClosed, !cancelled, input.count + data.count <= 64 * 1024 else { throw NativeFailure("input_backpressure", "Fake stdin is closed or full") }
        input.append(contentsOf: data)
    }
    func closeInput() async throws { inputClosed = true }
    func cancel() async throws { cancelled = true; inputClosed = true }
}

public struct BlockedWorkspaceBackend: NativeWorkspaceBackend {
    public init() {}
    public func start() async throws { throw NativeFailure("cowork_gate_blocked", "Production native VM creation is feature-blocked until reviewed gates pass") }
    public func process(taskId: String, arguments: [String]) async throws -> any NativeGuestProcess { throw NativeFailure("cowork_gate_blocked", "Production guest execution is not admitted") }
    public func stats() async throws -> [String: String] { ["backend": "production-blocked", "vmCreated": "false"] }
    public func setMemoryAllowance(_ bytes: UInt64) async throws -> [String: String] { throw NativeFailure("guest_unavailable", "No admitted production guest") }
    public func stop() async throws -> BackendStopResult { BackendStopResult(terminationConfirmed: true, flushConfirmed: true) }
}
