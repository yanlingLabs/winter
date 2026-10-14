import Foundation
import Combine
import CryptoKit
import WinterProtocol

/// Workspace metadata only. Execution readiness is never inferred from a source or power state.
@MainActor public final class CoworkWorkspaceModel: ObservableObject {
    public typealias Call = @MainActor (String, SessionEvent.JSONValue) async throws -> SessionEvent.JSONValue
    @Published public private(set) var capabilities = CoworkCapabilities()
    @Published public private(set) var workspaces: [CoworkWorkspace] = []
    @Published public private(set) var selected: CoworkWorkspace?
    @Published public private(set) var sources: [CoworkSource] = []
    @Published public private(set) var policy: CoworkPolicySummary?
    @Published public private(set) var busy = false
    @Published public private(set) var error: String?
    @Published public private(set) var operation: CoworkOperation?
    @Published public private(set) var lastMutationRecorded = false
    @Published public private(set) var guidance: Guidance?
    @Published public private(set) var guidanceBusy = false
    /// Mirrors COWORK_INSTRUCTION_MAX_BYTES in packages/protocol/src/cowork.ts.
    public static let instructionMaxBytes = 65_536
    public struct Guidance: Equatable, Sendable {
        public let workspaceId: String
        public fileprivate(set) var current: CoworkInstructionRead?
        public fileprivate(set) var provenance: CoworkInstructionProvenance?
        public fileprivate(set) var currentContent: String?
        /// nil means no canonical content has been loaded; it is never a missing-file seed.
        public fileprivate(set) var draft: String?
        public fileprivate(set) var available = false
        public fileprivate(set) var conflict = false
        public fileprivate(set) var message: String?
        public fileprivate(set) var receipt: CoworkReceipt<CoworkInstructionMetadata>?
        fileprivate var baseRevision: Int?, baseDigest: String?, baseContent: String?
        fileprivate var pending: InstructionSave?
        public var hasUnconfirmedSave: Bool { pending != nil }
        public var pendingContent: String? { pending?.content }
        public var pendingRequestId: String? { pending?.requestId }
        public var hasUnsavedChanges: Bool { draft != nil && draft.map { Data($0.utf8) } != baseContent.map { Data($0.utf8) } }
        public var canSave: Bool { available && !conflict && pending == nil && hasUnsavedChanges }
    }
    fileprivate struct InstructionSave: Equatable, Sendable {
        let workspaceId: String, requestId: String, expectedDigest: String, content: String
        let expectedRevision: Int
    }
    // One draft per durable workspace, shared by its conversations, retained through navigation
    // and transport reconnects. This is UI state only, not a memory store or a capability grant.
    private var guidanceByWorkspace: [String: Guidance] = [:]
    private var selectedId: String?
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
        guidance = guidanceByWorkspace[id] ?? Guidance(workspaceId: id)
        if !guidanceBusy { await readGuidance(id) }
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
        guard !busy else { return }; busy = true; error = nil; selectedId = id; selected = nil; sources = []; policy = nil; operation = nil; guidance = nil
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
    private func publishGuidance(_ state: Guidance) {
        guidanceByWorkspace[state.workspaceId] = state
        if selectedId == state.workspaceId && selected?.workspaceId == state.workspaceId { guidance = state }
    }
    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private static func validMetadata(workspaceId: String, revision: Int, digest: String, bytes: Int, refreshState: String, expectedWorkspace: String) -> Bool {
        workspaceId == expectedWorkspace && revision > 0 && revision <= 9_007_199_254_740_991
            && bytes >= 0 && bytes <= instructionMaxBytes
            && digest.utf8.count == 64 && digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
            && ["refresh-required", "unavailable"].contains(refreshState)
    }
    private static func decodeInstructions(_ read: CoworkInstructionRead, workspaceId: String) throws -> String {
        guard validMetadata(workspaceId: read.workspaceId, revision: read.instructionRevision, digest: read.digest, bytes: read.bytes, refreshState: read.refreshState, expectedWorkspace: workspaceId),
              read.encoding == "utf-8", read.contentBase64.utf8.count <= 87_384,
              let bytes = Data(base64Encoded: read.contentBase64), bytes.count == read.bytes,
              bytes.count <= instructionMaxBytes, bytes.base64EncodedString() == read.contentBase64 else { throw ModelError.invalidInstructions }
        // The standard-library decoder preserves a leading U+FEFF. Its byte round trip makes
        // acceptance strict: repaired malformed UTF-8 cannot match the original input bytes.
        let text = String(decoding: bytes, as: UTF8.self)
        guard Data(text.utf8) == bytes, !text.contains("\0"), digest(bytes) == read.digest else { throw ModelError.invalidInstructions }
        return text
    }
    private func readGuidance(_ id: String) async {
        do {
            let read = try await send(CoworkRequest<CoworkInstructionRead>.instructions(workspaceId: id))
            let content = try Self.decodeInstructions(read, workspaceId: id)
            let provenance = try await send(CoworkRequest<CoworkInstructionProvenance>.instructionProvenance(workspaceId: id))
            guard provenance.workspaceId == id, provenance.instructionRevision == read.instructionRevision,
                  provenance.digest == read.digest, provenance.bytes == read.bytes, provenance.refreshState == read.refreshState,
                  provenance.sourceDiscovery == "unavailable", provenance.entries.count == 1,
                  provenance.entries.first?.kind == "workspace", provenance.entries.first?.guestPath == "/workspace/.winter/WINTER.md",
                  provenance.entries.first?.digest == read.digest else { throw ModelError.invalidInstructions }
            var state = guidanceByWorkspace[id] ?? Guidance(workspaceId: id)
            // Compare byte encodings: Swift String equality alone treats canonically equivalent
            // Unicode spellings as equal, but the host digest and optimistic write operate on bytes.
            let clean = state.draft.map { Data($0.utf8) } == state.baseContent.map { Data($0.utf8) }
            if state.pending == nil && (state.draft == nil || clean) {
                state.draft = content; state.baseContent = content
                state.baseRevision = read.instructionRevision; state.baseDigest = read.digest; state.conflict = false
            } else {
                state.conflict = state.baseRevision != read.instructionRevision || state.baseDigest != read.digest
            }
            state.current = read; state.currentContent = content; state.provenance = provenance
            state.available = read.refreshState == "refresh-required"
            state.message = state.pending != nil ? "The previous save is not confirmed. Retry that save before submitting another." : nil
            publishGuidance(state)
        } catch {
            var state = guidanceByWorkspace[id] ?? Guidance(workspaceId: id)
            state.available = false
            state.message = "Shared instructions are unavailable. Refresh to try again; any draft and unconfirmed save are retained."
            publishGuidance(state)
        }
    }
    public func refreshInstructions(workspaceId: String? = nil) async {
        guard !busy, !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id else { return }
        guidanceBusy = true; defer { guidanceBusy = false }
        await readGuidance(id)
    }
    public func editInstructions(_ content: String, workspaceId: String? = nil) {
        guard let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              var state = guidanceByWorkspace[id], state.draft != nil else { return }
        state.draft = content; publishGuidance(state)
    }
    /// Explicit conflict resolution after displaying the latest canonical content. Nothing is
    /// rebased automatically while a draft or unknown receipt could overwrite another user's edit.
    public func reviewInstructionConflict(keepDraft: Bool, workspaceId: String? = nil, expectedRevision: Int? = nil, expectedDigest: String? = nil) {
        guard !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              var state = guidanceByWorkspace[id], state.available, state.pending == nil,
              let read = state.current, let content = state.currentContent,
              expectedRevision == nil || expectedRevision == read.instructionRevision,
              expectedDigest == nil || expectedDigest == read.digest else { return }
        if !keepDraft { state.draft = content }
        state.baseContent = content; state.baseRevision = read.instructionRevision; state.baseDigest = read.digest
        state.conflict = false; state.message = nil; publishGuidance(state)
    }
    public func saveInstructions(workspaceId: String? = nil, expectedDraft: String? = nil, expectedRevision: Int? = nil, expectedDigest: String? = nil) async {
        guard !busy, !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              var state = guidanceByWorkspace[id],
              state.canSave, let content = state.draft, let revision = state.baseRevision, let digest = state.baseDigest else { return }
        if let expectedDraft, Data(expectedDraft.utf8) != Data(content.utf8) { return }
        guard expectedRevision == nil || expectedRevision == revision, expectedDigest == nil || expectedDigest == digest else { return }
        guard content.utf8.count <= Self.instructionMaxBytes, !content.contains("\0") else {
            state.message = "Shared instructions must contain at most 65,536 UTF-8 bytes and no NUL characters."
            publishGuidance(state); return
        }
        // Capture every field before the first await. Later edits/refreshes cannot change a retry.
        let save = InstructionSave(workspaceId: id, requestId: UUID().uuidString, expectedDigest: digest, content: content, expectedRevision: revision)
        state.pending = save; state.message = nil; publishGuidance(state)
        await performInstructionSave(save)
    }
    public func retryInstructionSave(workspaceId: String? = nil, requestId: String? = nil) async {
        guard !busy, !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              let save = guidanceByWorkspace[id]?.pending, requestId == nil || requestId == save.requestId else { return }
        await performInstructionSave(save)
    }
    private func performInstructionSave(_ save: InstructionSave) async {
        guidanceBusy = true; defer { guidanceBusy = false }
        do {
            let receipt = try await send(CoworkRequest<CoworkReceipt<CoworkInstructionMetadata>>.updateInstructions(workspaceId: save.workspaceId, requestId: save.requestId,
                expectedInstructionRevision: save.expectedRevision, expectedDigest: save.expectedDigest, content: save.content))
            let metadata = receipt.value
            guard receipt.workspaceId == save.workspaceId,
                  receipt.operationId.utf8.count <= 200, !receipt.operationId.contains("\n"),
                  receipt.operationId.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$", options: .regularExpression) != nil,
                  receipt.revision > 0, receipt.revision <= 9_007_199_254_740_991,
                  Self.validMetadata(workspaceId: metadata.workspaceId, revision: metadata.instructionRevision, digest: metadata.digest, bytes: metadata.bytes, refreshState: metadata.refreshState, expectedWorkspace: save.workspaceId),
                  metadata.instructionRevision == save.expectedRevision + 1, metadata.bytes == save.content.utf8.count,
                  metadata.digest == Self.digest(Data(save.content.utf8)) else { throw ModelError.invalidInstructions }
            var state = guidanceByWorkspace[save.workspaceId]!
            state.pending = nil; state.receipt = receipt; state.available = false; state.conflict = false
            state.baseRevision = metadata.instructionRevision; state.baseDigest = metadata.digest; state.baseContent = save.content
            // Keep the latest draft, including edits typed while this exact save was in flight.
            state.message = "Save recorded. Refreshing canonical content…"; publishGuidance(state)
            await readGuidance(save.workspaceId)
        } catch {
            var state = guidanceByWorkspace[save.workspaceId]!
            state.available = false
            if let rpc = error as? RpcError, rpc.data?["code"]?.stringValue == "revision_conflict" {
                state.pending = nil; state.conflict = true
                state.message = "Shared instructions changed before this save. Refresh and review the current version; your draft is retained."
            } else {
                state.message = "Save not confirmed. Your draft is retained. Retry the same save to resolve its receipt."
            }
            publishGuidance(state)
        }
    }
    private enum ModelError: LocalizedError {
        case invalidPagination, invalidInstructions
        var errorDescription: String? {
            switch self {
            case .invalidPagination: return "Workspace details changed or returned invalid pages. Refresh to try again."
            case .invalidInstructions: return "Shared instructions returned inconsistent or invalid content. Refresh to try again."
            }
        }
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
