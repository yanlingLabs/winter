import Foundation
import Combine
import WinterProtocol

/// Local canonical schedule metadata only; never invokes a runtime or infers execution admission.
@MainActor public final class CoworkSchedulesModel: ObservableObject {
    public typealias Call = CoworkWorkspaceModel.Call
    @Published public private(set) var workspaceId: String?
    @Published public private(set) var schedules: [CoworkScheduleView] = []
    @Published public private(set) var status: CoworkScheduleStatus?
    @Published public private(set) var lastCancellation: CoworkScheduleView?
    @Published public private(set) var busy = false
    @Published public private(set) var error: String?
    @Published public private(set) var nextCursor: String?
    @Published public private(set) var canGoBack = false
    private struct Scope: Equatable { let workspaceId: String, generation: UUID }
    private struct Intent: Hashable { let workspaceId: String, scheduleId: String }
    private var generation = UUID(), activeRequest: UUID?
    private var currentCursor: String?, previousCursors: [String?] = [], visited = Set<String>()
    private var cancelRevisions: [Intent: Int] = [:]
    private let call: Call
    public init(call: @escaping Call) { self.call = call }
    private var scope: Scope? { workspaceId.map { Scope(workspaceId: $0, generation: generation) } }
    /// Navigation/refresh generations invalidate late UI results, including returning to the same ID.
    @discardableResult public func bind(workspaceId: String?) -> UUID {
        generation = UUID(); activeRequest = nil; self.workspaceId = workspaceId
        schedules = []; status = nil; lastCancellation = nil; error = nil; busy = false
        nextCursor = nil; currentCursor = nil; previousCursors = []; visited = []; canGoBack = false
        // An unconfirmed cancellation retains its exact revision when the user returns later.
        return generation
    }
    public func release(_ token: UUID) { if generation == token { bind(workspaceId: nil) } }
    public func open(workspaceId: String) async { bind(workspaceId: workspaceId); await refresh() }
    private func begin() -> (Scope, UUID)? {
        guard !busy, let scope else { return nil }
        let token = UUID(); activeRequest = token; busy = true; error = nil; return (scope, token)
    }
    private func current(_ captured: Scope, _ token: UUID) -> Bool { scope == captured && activeRequest == token }
    private func end(_ captured: Scope, _ token: UUID) { if current(captured, token) { activeRequest = nil; busy = false } }
    private func send<T>(_ request: CoworkRequest<T>) async throws -> T {
        let value = try await call(request.method, request.params)
        let bytes = try JSONEncoder().encode(value)
        // Core bounds list payloads at 128 KiB; allow Foundation slash-escaping overhead.
        guard bytes.count <= 256 * 1024 else { throw ModelError.invalidResponse }
        return try request.decode(value)
    }
    private func page(_ captured: Scope, cursor: String?) async throws -> CoworkSchedulePage {
        let result = try await send(CoworkRequest<CoworkSchedulePage>.schedules(workspaceId: captured.workspaceId, cursor: cursor))
        guard result.schedules.allSatisfy({ $0.workspaceId == captured.workspaceId }), Set(result.schedules.map(\.scheduleId)).count == result.schedules.count,
              result.nextCursor == nil || (!result.schedules.isEmpty && result.nextCursor != cursor) else { throw ModelError.invalidResponse }
        return result
    }
    private func publish(_ page: CoworkSchedulePage, cursor: String?) {
        for row in page.schedules where row.isCancelled {
            let intent = Intent(workspaceId: row.workspaceId, scheduleId: row.scheduleId)
            if let revision = cancelRevisions[intent], row.revision == revision + 1 { cancelRevisions.removeValue(forKey: intent) }
        }
        schedules = page.schedules; nextCursor = page.nextCursor; currentCursor = cursor
        if let cursor { visited.insert(cursor) }; canGoBack = !previousCursors.isEmpty
    }
    public func refresh() async {
        guard let (captured, token) = begin() else { return }; defer { end(captured, token) }
        do {
            let result = try await page(captured, cursor: nil)
            guard current(captured, token) else { return }
            previousCursors = []; visited = []; status = nil; publish(result, cursor: nil)
        } catch { if current(captured, token) { self.error = error.localizedDescription } }
    }
    /// Replace one bounded page; terminal history never accumulates without a memory bound.
    public func nextPage() async {
        guard let cursor = nextCursor, let (captured, token) = begin() else { return }; defer { end(captured, token) }
        do {
            guard !visited.contains(cursor), previousCursors.count < 100 else { throw ModelError.invalidPagination }
            let result = try await page(captured, cursor: cursor)
            guard current(captured, token) else { return }
            guard result.nextCursor == nil || !visited.contains(result.nextCursor!) else { throw ModelError.invalidPagination }
            previousCursors.append(currentCursor); status = nil; publish(result, cursor: cursor)
        } catch { if current(captured, token) { self.error = error.localizedDescription } }
    }
    public func previousPage() async {
        guard !previousCursors.isEmpty, let (captured, token) = begin() else { return }; defer { end(captured, token) }
        do {
            let cursor = previousCursors.last!, result = try await page(captured, cursor: cursor)
            guard current(captured, token) else { return }
            previousCursors.removeLast(); visited = Set(previousCursors.compactMap { $0 }); status = nil; publish(result, cursor: cursor)
        } catch { if current(captured, token) { self.error = error.localizedDescription } }
    }
    private func readStatus(_ captured: Scope, scheduleId: String) async throws -> CoworkScheduleStatus {
        let result = try await send(CoworkRequest<CoworkScheduleStatus>.scheduleStatus(workspaceId: captured.workspaceId, scheduleId: scheduleId))
        guard result.schedule.workspaceId == captured.workspaceId, result.schedule.scheduleId == scheduleId,
              result.occurrences.allSatisfy({ $0.scheduleId == scheduleId }), Set(result.occurrences.map(\.occurrenceId)).count == result.occurrences.count else { throw ModelError.invalidResponse }
        return result
    }
    public func inspect(scheduleId: String) async {
        guard let row = schedules.first(where: { $0.scheduleId == scheduleId }), let (captured, token) = begin() else { return }; defer { end(captured, token) }
        status = nil
        do {
            let result = try await readStatus(captured, scheduleId: scheduleId)
            guard result.schedule.revision >= row.revision else { throw ModelError.invalidResponse }
            guard current(captured, token) else { return }
            status = result
            if let index = schedules.firstIndex(where: { $0.scheduleId == scheduleId }) { schedules[index] = result.schedule }
        }
        catch { if current(captured, token) { self.error = error.localizedDescription } }
    }
    public func cancel(scheduleId: String, expectedRevision: Int, binding: UUID) async {
        guard generation == binding else { return }
        let known = status?.schedule.scheduleId == scheduleId ? status?.schedule : schedules.first(where: { $0.scheduleId == scheduleId })
        guard let row = known, row.canCancel, row.revision == expectedRevision,
              let (captured, token) = begin() else { return }; defer { end(captured, token) }
        let intent = Intent(workspaceId: captured.workspaceId, scheduleId: scheduleId)
        var confirmed = false
        do {
            guard cancelRevisions[intent] != nil || cancelRevisions.count < 128 else { throw ModelError.unconfirmedLimit }
            let revision = cancelRevisions[intent] ?? row.revision; cancelRevisions[intent] = revision
            // The existing cancel RPC has revision replay, no requestId parameter. Never invent one.
            let receipt = try await send(CoworkRequest<CoworkScheduleView>.cancelSchedule(workspaceId: captured.workspaceId, scheduleId: scheduleId, expectedRevision: revision))
            guard receipt.workspaceId == captured.workspaceId, receipt.scheduleId == scheduleId, receipt.isCancelled, receipt.revision == revision + 1 else { throw ModelError.invalidResponse }
            confirmed = true; cancelRevisions.removeValue(forKey: intent)
            guard current(captured, token) else { return }
            lastCancellation = receipt
            if let index = schedules.firstIndex(where: { $0.scheduleId == scheduleId }) { schedules[index] = receipt }
            status = nil // Do not retain an old occurrence list behind a newly cancelled row.
            let result = try await readStatus(captured, scheduleId: scheduleId)
            guard result.schedule.isCancelled, result.schedule.revision == receipt.revision else { throw ModelError.invalidResponse }
            guard current(captured, token) else { return }
            status = result
        } catch { if current(captured, token) { self.error = (confirmed ? "Cancellation recorded; status refresh failed: " : "Cancellation not confirmed: ") + error.localizedDescription } }
    }
    private enum ModelError: LocalizedError {
        case invalidResponse, invalidPagination, unconfirmedLimit
        var errorDescription: String? {
            switch self {
            case .invalidResponse: "Schedule details changed or the response was invalid. Refresh to try again."
            case .invalidPagination: "Schedule pages changed. Refresh the list to try again."
            case .unconfirmedLimit: "Earlier cancellations need confirmation. Revisit those schedules before cancelling more."
            }
        }
    }
}
