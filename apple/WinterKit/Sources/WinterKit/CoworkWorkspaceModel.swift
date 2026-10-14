import Foundation
import Combine
import WinterProtocol

/// Workspace metadata only. Execution readiness is never inferred from a source or power state.
@MainActor public final class CoworkWorkspaceModel: ObservableObject {
    public typealias Call = @MainActor (String, SessionEvent.JSONValue) async throws -> SessionEvent.JSONValue
    @Published public private(set) var capabilities = CoworkCapabilities()
    @Published public private(set) var workspaces: [CoworkWorkspace] = []
    @Published public private(set) var selected: CoworkWorkspace? {
        // Invalidate before any asynchronous navigation/refresh read can return.
        didSet { schedules.bind(workspaceId: nil) }
    }
    @Published public private(set) var sources: [CoworkSource] = []
    @Published public private(set) var policy: CoworkPolicySummary?
    @Published public private(set) var busy = false
    @Published public private(set) var error: String?
    @Published public private(set) var operation: CoworkOperation?
    @Published public private(set) var lastMutationRecorded = false
    private var selectedId: String?
    /// Separate bounded metadata consumer; workspace policy/source discovery remains independent.
    public private(set) lazy var schedules = CoworkSchedulesModel(call: call)
    private let call: Call
    private var requestIds: [String: String] = [:]
    public init(call: @escaping Call) { self.call = call }
    public convenience init(client: WinterClient) {
        self.init { method, params in
            let local = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(params))
            return try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONEncoder().encode(await client.request(method, params: local)))
        }
    }
    private func send<T>(_ request: CoworkRequest<T>) async throws -> T {
        try request.decode(await call(request.method, request.params))
    }
    public static func validTitle(_ title: String) -> Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.utf16.count <= 200 && !title.contains(where: { $0 == "\0" || $0 == "\r" || $0 == "\n" })
    }
    private func next(_ cursor: String?, seen: inout Set<String>) throws -> String? {
        if let cursor, (!seen.insert(cursor).inserted || seen.count > 100) { throw ModelError.invalidPagination }
        return cursor
    }
    private func list() async throws {
        var values: [CoworkWorkspace] = [], cursor: String?, seen = Set<String>()
        repeat {
            let page = try await send(CoworkRequest<CoworkWorkspacePage>.list(cursor: cursor))
            values += page.workspaces; cursor = try next(page.nextCursor, seen: &seen)
        } while cursor != nil
        guard Set(values.map(\.workspaceId)).count == values.count else { throw ModelError.invalidPagination }
        workspaces = values
    }
    private func detail(_ id: String) async throws {
        let value = try await send(CoworkRequest<CoworkWorkspace>.get(workspaceId: id))
        var items: [CoworkSource] = [], cursor: String?, seen = Set<String>()
        repeat {
            let page = try await send(CoworkRequest<CoworkSourceList>.listSources(workspaceId: id, cursor: cursor, expectedRevision: value.configRevision))
            items += page.sources; cursor = try next(page.nextCursor, seen: &seen)
        } while cursor != nil
        guard items.allSatisfy({ $0.workspaceId == id }), Set(items.map(\.sourceId)).count == items.count else { throw ModelError.invalidPagination }
        let policyPage = try await send(CoworkRequest<CoworkPolicyPage>.policy(workspaceId: id, expectedRevision: value.policy?.revision ?? value.policySummary?.revision))
        guard value.workspaceId == id, policyPage.policy.workspaceId == id else { throw ModelError.invalidPagination }
        // Publish only a complete source generation. A summary is never an empty source grant.
        selected = value; sources = items; policy = policyPage.policy
    }
    public func refresh() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            // Older daemons retain metadata support but never implicitly gain preparation authority.
            capabilities = (try? await send(CoworkRequest<CoworkCapabilities>.capabilities())) ?? CoworkCapabilities()
            try await list()
            if let id = selectedId {
                selected = nil; sources = []; policy = nil
                try await detail(id)
                if let operation, operation.workspaceId == id {
                    self.operation = try await send(CoworkRequest<CoworkOperation>.operation(workspaceId: id, operationId: operation.operationId))
                }
            }
        } catch { self.error = error.localizedDescription }
    }
    public func select(_ id: String) async {
        guard !busy else { return }; busy = true; error = nil; selectedId = id; selected = nil; sources = []; policy = nil; operation = nil
        defer { busy = false }
        do { try await detail(id) } catch { self.error = error.localizedDescription }
    }
    /// Retain the same request ID after a lost response. Changing the intent/revision changes it.
    private func intent(_ fields: [String]) -> String {
        String(decoding: try! JSONEncoder().encode(fields), as: UTF8.self)
    }
    private func requestId(_ key: String) -> String {
        if let id = requestIds[key] { return id }
        let id = UUID().uuidString; requestIds[key] = id; return id
    }
    private func mutate(_ key: String, effect: (String) async throws -> (String, String, Int)) async {
        guard !busy else { return }; busy = true; error = nil; lastMutationRecorded = false; defer { busy = false }
        var committed = false
        do {
            let (id, workspace, revision) = try await effect(requestId(key))
            committed = true; lastMutationRecorded = true
            // Keep its idempotency key even if the follow-up read fails. Retrying creation
            // must replay the receipt, never create a second workspace.
            operation = CoworkOperation(operationId: id, workspaceId: workspace, revision: revision, status: "recorded", terminal: false)
            // A committed receipt is desired state, not a guest ACK. Keep it visible on refresh failure.
            selectedId = workspace; selected = nil; sources = []; policy = nil
            try await detail(workspace); try await list()
            operation = try await send(CoworkRequest<CoworkOperation>.operation(workspaceId: workspace, operationId: id))
        } catch { self.error = (committed ? "Change recorded; refresh failed: " : "Change not confirmed: ") + error.localizedDescription }
    }
    public func rename(_ title: String) async {
        guard let value = selected, Self.validTitle(title) else { return }
        let key = intent(["rename", value.workspaceId, String(value.configRevision), title])
        await mutate(key) { id in
            let r = try await self.send(CoworkRequest<CoworkReceipt<CoworkWorkspaceRecord>>.update(workspaceId: value.workspaceId, requestId: id, expectedRevision: value.configRevision, title: title))
            return (r.operationId, r.workspaceId, r.revision)
        }
    }
    public func remove(_ source: CoworkSource, revoke: Bool) async {
        guard let value = selected, source.workspaceId == value.workspaceId, sources.contains(where: { $0.sourceId == source.sourceId }) else { return }
        await mutate(intent(["remove", value.workspaceId, source.sourceId, String(value.configRevision), String(revoke)])) { id in
            let r = try await self.send(CoworkRequest<CoworkReceipt<CoworkSource>>.removeSource(workspaceId: value.workspaceId, sourceId: source.sourceId, requestId: id, expectedRevision: value.configRevision, revoke: revoke))
            return (r.operationId, r.workspaceId, r.revision)
        }
    }
    /// Only an authenticated host issuer may supply these selections; file URLs are not grants.
    public func create(title: String, ownership: CoworkOwnership, selections: [CoworkSelection]) async {
        guard Self.validTitle(title), !selections.isEmpty, selections.count <= 100 else { return }
        let fields = selections.flatMap { [$0.kind.rawValue, $0.selectionId] }
        await mutate(intent(["create", ownership.rawValue, title] + fields)) { id in
            let request = ownership == .project
                ? CoworkRequest<CoworkReceipt<CoworkWorkspace>>.createProject(requestId: id, title: title, selections: selections)
                : CoworkRequest<CoworkReceipt<CoworkWorkspace>>.create(requestId: id, ownership: ownership, title: title, selections: selections)
            let r = try await self.send(request); return (r.operationId, r.workspaceId, r.revision)
        }
    }
    public func add(_ selection: CoworkSelection) async {
        guard let value = selected else { return }
        await add(selection, workspaceId: value.workspaceId, expectedRevision: value.configRevision)
    }
    public func add(_ selection: CoworkSelection, workspaceId: String, expectedRevision: Int) async {
        guard let value = selected, value.workspaceId == workspaceId, value.configRevision == expectedRevision else { return }
        await mutate(intent(["add", value.workspaceId, String(value.configRevision), selection.kind.rawValue, selection.selectionId])) { id in
            let r = try await self.send(CoworkRequest<CoworkReceipt<CoworkSource>>.addSource(workspaceId: value.workspaceId, requestId: id, expectedRevision: value.configRevision, selectionId: selection.selectionId, kind: selection.kind))
            return (r.operationId, r.workspaceId, r.revision)
        }
    }
    private enum ModelError: LocalizedError {
        case invalidPagination
        var errorDescription: String? { "Workspace details changed or returned invalid pages. Refresh to try again." }
    }
}

#if os(macOS)
extension CoworkWorkspaceModel {
    /// Called only after the native user picker. A URL string is never sent as authority.
    public func prepareFolder(_ url: URL, access: String = "read-write") async throws -> CoworkPreparedFolder {
        guard capabilities.folderPreparation, url.isFileURL else { throw NSError(domain: "Cowork folder selection unavailable", code: 1) }
        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }
        // An implicit picker bookmark can cross processes; do not create an app-scoped explicit
        // security bookmark and pretend it delegates this app's scope to the daemon.
        let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        return try await send(CoworkRequest<CoworkPreparedFolder>.prepareFolder(bookmark: bookmark, label: url.lastPathComponent, access: access))
    }
    public func revokePreparation(_ selectionId: String) async {
        _ = try? await send(CoworkRequest<CoworkSelectionRevocation>.revokeSelection(selectionId))
    }
}
#endif

/// Binds an awaited local picker/preparation to its initiating surface. Dismissal, a new sheet,
/// navigation or revision changes invalidate it; the caller must release a late preparation.
public struct CoworkPreparationContext: Equatable, Sendable {
    public let generation: UUID, workspaceId: String?, revision: Int?, creating: Bool
    public init(generation: UUID, workspaceId: String?, revision: Int?, creating: Bool) {
        self.generation = generation; self.workspaceId = workspaceId; self.revision = revision; self.creating = creating
    }
    public func canApply(generation: UUID, workspaceId: String?, revision: Int?, creationPresented: Bool) -> Bool {
        guard self.generation == generation else { return false }
        if creating { return creationPresented }
        return self.workspaceId != nil && self.workspaceId == workspaceId && self.revision == revision
    }
}
