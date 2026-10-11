import Foundation
import Containerization

protocol ProbeProcess: Sendable {
    func start() async throws
    func kill(_ signal: Signal) async throws
    func wait(timeoutInSeconds: Int64?) async throws -> ExitStatus
    func delete() async throws
}
extension LinuxProcess: ProbeProcess {}

struct ProcessRunFailure: Error, LocalizedError, Sendable {
    let original: String
    let cleanupFailures: [String]
    let cleanupUncertain: Bool
    var errorDescription: String? {
        original + (cleanupFailures.isEmpty ? "" : "; cleanup: " + cleanupFailures.joined(separator: "; "))
    }
}

enum ProcessLifecycle {
    /// Start failures can occur after guest creation or stdio setup. Include
    /// start, wait and delete in the same cleanup boundary. A kill failure
    /// alone does not imply uncertainty when wait+delete establish cleanup.
    static func run(_ process: some ProbeProcess, timeout: Int64) async throws -> ExitStatus {
        do {
            try await process.start()
            let exit = try await process.wait(timeoutInSeconds: timeout)
            try await process.delete()
            return exit
        } catch {
            let original = error.localizedDescription
            var errors: [String] = []
            var reaped = false, deleted = false
            do { try await process.kill(.kill) } catch { errors.append("kill: " + error.localizedDescription) }
            do { _ = try await process.wait(timeoutInSeconds: 5); reaped = true }
            catch { errors.append("wait: " + error.localizedDescription) }
            do { try await process.delete(); deleted = true }
            catch { errors.append("delete: " + error.localizedDescription) }
            throw ProcessRunFailure(original: original, cleanupFailures: errors, cleanupUncertain: !reaped || !deleted)
        }
    }
}

struct ExecHealth: Sendable {
    private(set) var uncertain: [String: String] = [:]
    mutating func record(processID: String, failure: ProcessRunFailure) {
        if failure.cleanupUncertain { uncertain[processID] = failure.localizedDescription }
    }
    func requireClean() throws {
        guard uncertain.isEmpty else {
            throw ProbeFailure(code: "exec_cleanup_uncertain", message: "guest has unreaped/uncertain processes; stop and recreate before another exec")
        }
    }
}
