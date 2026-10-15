import Foundation
import Combine
import WinterProtocol

/// The `error.data.code` of a refused Cowork request. Core's `CoworkError` reaches the wire through
/// `ipc/server.ts` as `RpcError.data["code"]`; `message` is always the same generic daemon prose and
/// must never be shown. Mirrors `CredentialRpcCode`'s posture (`CredentialsClient.swift`): the enum is
/// closed, and `RpcError.coworkCode` answers `nil` for a code this build has never heard of, so a
/// newer daemon degrades to the generic copy rather than to a crash or a drop.
enum CoworkRpcCode: String, Equatable, Sendable {
    case revisionConflict = "revision_conflict"
    case notFound = "not_found"
    case authorityDenied = "authority_denied"
    case unsupportedTopology = "unsupported_topology"
    case invalidRequest = "invalid_request"
    case recoveryRequired = "recovery_required"
    case scheduleBudgetExhausted = "schedule_budget_exhausted"

    /// The daemon refused BEFORE changing anything, so the exact revision a request carried can never
    /// have been applied. `recovery_required` is deliberately absent: Core also answers it for an
    /// internal failure, which may follow a commit.
    var refusedWithoutEffect: Bool {
        switch self {
        case .revisionConflict, .notFound, .authorityDenied, .invalidRequest: return true
        case .unsupportedTopology, .recoveryRequired, .scheduleBudgetExhausted: return false
        }
    }
}

extension RpcError {
    /// `nil` for a plain error, or one without a `data.code`, or one this build does not know.
    var coworkCode: CoworkRpcCode? {
        guard let raw = data?["code"]?.stringValue else { return nil }
        return CoworkRpcCode(rawValue: raw)
    }
}

/// PURE: one fixed sentence per refusal. `RpcError` is not a `LocalizedError`, so its
/// `localizedDescription` is Foundation's "The operation couldn't be completed" and its `message` is
/// daemon prose; neither reaches the screen. Every `RpcError` branch returns a literal (plus, for a
/// code no case covers, the numeric JSON-RPC code). Anything that is not an `RpcError` (this model's
/// own `LocalizedError`s, a transport failure) keeps its own description.
func coworkScheduleErrorText(_ error: Error) -> String {
    guard let rpc = error as? RpcError else { return error.localizedDescription }
    if rpc.isMethodNotFound { return "Schedules are not available from this Winter daemon yet." }
    guard let code = rpc.coworkCode else { return "The Winter daemon could not complete this schedule request (error \(rpc.code))." }
    switch code {
    case .revisionConflict: return "This schedule changed before the request completed."
    case .notFound: return "That workspace or schedule is no longer available."
    case .authorityDenied: return "This schedule request is not permitted for this workspace."
    case .unsupportedTopology: return "Schedules are not available in this Winter setup."
    case .invalidRequest: return "Winter sent a schedule request the daemon could not accept. Refresh and try again."
    case .recoveryRequired: return "Winter could not complete this request and may need to recover its schedule records. Try again later."
    case .scheduleBudgetExhausted: return "Planning this schedule's next time exceeded its limit. Simplify the schedule or try again later."
    }
}

/// Local canonical schedule metadata only; never invokes a runtime or infers execution admission.
@MainActor public final class CoworkSchedulesModel: ObservableObject {
    public typealias Call = CoworkWorkspaceModel.Call
    @Published public private(set) var workspaceId: String?
    @Published public private(set) var schedules: [CoworkScheduleView] = []
    @Published public private(set) var status: CoworkScheduleStatus?
    @Published public private(set) var lastCancellation: CoworkScheduleView?
    @Published public private(set) var busy = false
    @Published public private(set) var error: String?
    /// An older daemon that does not answer the schedule methods (JSON-RPC -32601). A first-class,
    /// expected state, never a failure: the view renders its neutral "not available yet" copy instead of
    /// a red error, and an empty list is never shown as "the daemon says there are none".
    @Published public private(set) var isUnsupported = false
    @Published public private(set) var nextCursor: String?
    @Published public private(set) var canGoBack = false
    private struct Scope: Equatable { let workspaceId: String, generation: UUID }
    private struct Intent: Hashable { let workspaceId: String, scheduleId: String }
    private var generation = UUID(), activeRequest: UUID?
    private var currentCursor: String?, previousCursors: [String?] = [], visited = Set<String>()
    private var cancelRevisions: [Intent: Int] = [:]
    /// Cancellations whose outcome is still unknown; each is pinned to the revision it was sent at.
    var unconfirmedCancellationCount: Int { cancelRevisions.count }
    private let call: Call
    public init(call: @escaping Call) { self.call = call }
    private var scope: Scope? { workspaceId.map { Scope(workspaceId: $0, generation: generation) } }
    /// Navigation/refresh generations invalidate late UI results, including returning to the same ID.
    @discardableResult public func bind(workspaceId: String?) -> UUID {
        generation = UUID(); activeRequest = nil; self.workspaceId = workspaceId
        resetListing(); lastCancellation = nil; error = nil; busy = false; isUnsupported = false
        // An unconfirmed cancellation retains its exact revision when the user returns later.
        return generation
    }
    public func release(_ token: UUID) { if generation == token { bind(workspaceId: nil) } }
    public func open(workspaceId: String) async { bind(workspaceId: workspaceId); await refresh() }
    private func resetListing() {
        schedules = []; status = nil; nextCursor = nil; currentCursor = nil; previousCursors = []; visited = []; canGoBack = false
    }
    private func begin() -> (Scope, UUID)? {
        guard !busy, let scope else { return nil }
        let token = UUID(); activeRequest = token; busy = true; error = nil; return (scope, token)
    }
    private func current(_ captured: Scope, _ token: UUID) -> Bool { scope == captured && activeRequest == token }
    private func end(_ captured: Scope, _ token: UUID) { if current(captured, token) { activeRequest = nil; busy = false } }
    /// Publishes a failure for the request that still owns the model. An older daemon without the
    /// schedule methods is the neutral unsupported state, not an error.
    private func fail(_ failure: Error, prefix: String = "") {
        if isMethodNotFoundError(failure) {
            resetListing(); isUnsupported = true; error = nil
        } else {
            error = prefix + coworkScheduleErrorText(failure)
        }
    }
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
        // A pin matters only while its row still sits at the pinned revision. A cancelled row at pin+1 is
        // the lost reply's confirmation; any other revision means that attempt never applied.
        for row in page.schedules {
            let intent = Intent(workspaceId: row.workspaceId, scheduleId: row.scheduleId)
            if let revision = cancelRevisions[intent], row.revision != revision { cancelRevisions.removeValue(forKey: intent) }
        }
        schedules = page.schedules; nextCursor = page.nextCursor; currentCursor = cursor
        // A newer listing supersedes the last receipt banner and proves the daemon answers the schedule methods.
        lastCancellation = nil; isUnsupported = false
        if let cursor { visited.insert(cursor) }; canGoBack = !previousCursors.isEmpty
    }
    public func refresh() async {
        guard let (captured, token) = begin() else { return }; defer { end(captured, token) }
        do {
            let result = try await page(captured, cursor: nil)
            guard current(captured, token) else { return }
            previousCursors = []; visited = []; status = nil; publish(result, cursor: nil)
        } catch { if current(captured, token) { fail(error) } }
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
        } catch { if current(captured, token) { fail(error) } }
    }
    public func previousPage() async {
        guard !previousCursors.isEmpty, let (captured, token) = begin() else { return }; defer { end(captured, token) }
        do {
            let cursor = previousCursors.last!, result = try await page(captured, cursor: cursor)
            guard current(captured, token) else { return }
            previousCursors.removeLast(); visited = Set(previousCursors.compactMap { $0 }); status = nil; publish(result, cursor: cursor)
        } catch { if current(captured, token) { fail(error) } }
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
        catch { if current(captured, token) { fail(error) } }
    }
    public func cancel(scheduleId: String, expectedRevision: Int, binding: UUID) async {
        guard generation == binding else { return }
        let known = status?.schedule.scheduleId == scheduleId ? status?.schedule : schedules.first(where: { $0.scheduleId == scheduleId })
        guard let row = known, row.canCancel, row.revision == expectedRevision,
              let (captured, token) = begin() else { return }; defer { end(captured, token) }
        let intent = Intent(workspaceId: captured.workspaceId, scheduleId: scheduleId)
        // A pin is the lost-reply replay token. It may be sent again only while the row still sits at
        // that exact revision; at any other revision the earlier attempt cannot have applied, so the pin
        // is stale, and it must not count against the unconfirmed limit either.
        if let pinned = cancelRevisions[intent], pinned != row.revision { cancelRevisions.removeValue(forKey: intent) }
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
        } catch {
            // A definitive refusal proves nothing was applied at the pinned revision: release the pin, even
            // for a request that is no longer current. An ambiguous failure keeps it for the exact replay.
            if !confirmed, refusedWithoutEffect(error) { cancelRevisions.removeValue(forKey: intent) }
            guard current(captured, token) else { return }
            if confirmed {
                self.error = "Cancellation recorded; status refresh failed: " + coworkScheduleErrorText(error)
            } else if (error as? RpcError)?.coworkCode == .revisionConflict {
                await reloadAfterConflict(captured, token, conflict: error)
            } else {
                fail(error, prefix: "Cancellation not confirmed: ")
            }
        }
    }
    private func refusedWithoutEffect(_ failure: Error) -> Bool {
        // A daemon that has no such method (-32601) cannot have applied the cancellation either.
        isMethodNotFoundError(failure) || ((failure as? RpcError)?.coworkCode?.refusedWithoutEffect ?? false)
    }
    /// A revision conflict proves the row on screen is stale. Re-read the page being viewed inside the
    /// request that still owns `busy` (`refresh()` would be refused by `begin()`), so the next attempt
    /// carries the current revision; the reader keeps their page.
    private func reloadAfterConflict(_ captured: Scope, _ token: UUID, conflict: Error) async {
        let message = "Cancellation not confirmed: " + coworkScheduleErrorText(conflict)
        do {
            let result = try await page(captured, cursor: currentCursor)
            guard current(captured, token) else { return }
            status = nil; publish(result, cursor: currentCursor)
            self.error = message + " The list was refreshed; review it before trying again."
        } catch {
            guard current(captured, token) else { return }
            self.error = message + " Refresh the list to try again."
        }
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
