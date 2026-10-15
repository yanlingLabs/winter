import Foundation
import Combine
import CryptoKit
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
        public fileprivate(set) var message: String? { didSet { messageIsAboutDraft = false } }
        public fileprivate(set) var receipt: CoworkReceipt<CoworkInstructionMetadata>?
        fileprivate var baseRevision: Int?, baseDigest: String?, baseContent: String?
        fileprivate var pending: InstructionSave?
        /// True while `message` answers the draft exactly as it was sent (a size refusal, a definitive
        /// host refusal). The next edit supersedes it. Any other assignment to `message` resets it.
        fileprivate var messageIsAboutDraft = false
        fileprivate mutating func note(_ text: String, aboutDraft: Bool) { message = text; messageIsAboutDraft = aboutDraft }
        public var hasUnconfirmedSave: Bool { pending != nil }
        public var pendingContent: String? { pending?.content }
        public var pendingRequestId: String? { pending?.requestId }
        public var hasUnsavedChanges: Bool { draft != nil && draft.map { Data($0.utf8) } != baseContent.map { Data($0.utf8) } }
        public var canSave: Bool { available && !conflict && pending == nil && hasUnsavedChanges }
        /// True when `reviewInstructionConflict(keepDraft: false)` would throw away text that exists nowhere
        /// else: the draft differs from the shared content that replaces it AND from the version it was
        /// written against. After an abandon there is no such version, so any differing draft counts.
        public var useCurrentDiscardsDraft: Bool {
            guard hasUnsavedChanges, let draft, let currentContent else { return false }
            return Data(draft.utf8) != Data(currentContent.utf8)
        }
    }
    fileprivate struct InstructionSave: Equatable, Sendable {
        let workspaceId: String, requestId: String, expectedDigest: String, content: String
        let expectedRevision: Int
    }
    // One draft per durable workspace, shared by its conversations, retained through navigation
    // and transport reconnects. This is UI state only, not a memory store or a capability grant.
    private var guidanceByWorkspace: [String: Guidance] = [:]
    /// A workspace selected while another guidance operation held `guidanceBusy`: its read could not
    /// start then, and `finishGuidanceOperation` runs it (the last selection wins).
    private var queuedGuidanceRead: String?
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
        let listed = Set(values.map(\.workspaceId))
        guard listed.count == values.count else { throw ModelError.invalidPagination }
        workspaces = values
        // A draft is kept only for a workspace the person can still open. The selected one is exempt: its
        // editor is on screen, and dropping its entry under it would silently discard edits typed next.
        guidanceByWorkspace = guidanceByWorkspace.filter { listed.contains($0.key) || $0.key == selectedId }
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
        // Another workspace's save or refresh may hold the guidance lane; its end reads this one.
        if guidanceBusy { queuedGuidanceRead = id } else { await readGuidance(id) }
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
        // One guarded statement per rule: a single long `&&` chain over mixed Int/String/Optional
        // operands is a type-checker timeout risk.
        guard workspaceId == expectedWorkspace else { return false }
        guard revision > 0 else { return false }
        guard revision <= 9_007_199_254_740_991 else { return false }
        guard bytes >= 0 else { return false }
        guard bytes <= instructionMaxBytes else { return false }
        guard digest.utf8.count == 64 else { return false }
        guard digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return false }
        let states: [String] = ["refresh-required", "unavailable"]
        return states.contains(refreshState)
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
    /// `keepingReceipt` is true only for the read that immediately follows a recorded save, so the
    /// "save recorded" banner survives the refresh it triggered; every other read retires it.
    private func readGuidance(_ id: String, keepingReceipt: Bool = false) async {
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
            // The host already holds exactly this unconfirmed save's bytes, one revision past the
            // revision it was written against: it was applied and only its response was lost. Settle it
            // as applied. No receipt is invented (its operation ID is unknown), and the draft keeps
            // whatever has been typed since, now measured against the saved content as its base.
            var resolved = false
            if let pending = state.pending, read.instructionRevision == pending.expectedRevision + 1,
               read.digest == Self.digest(Data(pending.content.utf8)) {
                state.pending = nil; state.conflict = false; resolved = true
                state.baseRevision = read.instructionRevision; state.baseDigest = read.digest; state.baseContent = content
            }
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
            if !keepingReceipt { state.receipt = nil }
            if resolved {
                state.message = "The earlier unconfirmed save was found applied by this refresh, at instruction revision \(read.instructionRevision)."
            } else if state.pending != nil {
                state.message = "The previous save is not confirmed. Retry it, or abandon it if retrying keeps failing."
            } else {
                state.message = nil
            }
            publishGuidance(state)
        } catch {
            var state = guidanceByWorkspace[id] ?? Guidance(workspaceId: id)
            state.available = false
            if !keepingReceipt { state.receipt = nil }
            state.message = "Shared instructions are unavailable. Refresh to try again; any draft and unconfirmed save are retained."
            publishGuidance(state)
        }
    }
    /// Ends the guidance operation that holds `guidanceBusy`. A workspace selected while it ran could
    /// not start its own read (`detail` queued it), so that read runs now instead of never.
    private func finishGuidanceOperation() async {
        guidanceBusy = false
        while let id = queuedGuidanceRead {
            queuedGuidanceRead = nil
            guard selected?.workspaceId == id else { continue }
            guidanceBusy = true
            await readGuidance(id)
            guidanceBusy = false
        }
    }
    public func refreshInstructions(workspaceId: String? = nil) async {
        guard !busy, !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id else { return }
        guidanceBusy = true
        await readGuidance(id)
        await finishGuidanceOperation()
    }
    public func editInstructions(_ content: String, workspaceId: String? = nil) {
        guard let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              var state = guidanceByWorkspace[id], state.draft != nil else { return }
        state.draft = content
        // A save receipt, and a refusal of the previous draft, describe text that has since changed.
        state.receipt = nil
        if state.messageIsAboutDraft { state.message = nil }
        publishGuidance(state)
    }
    /// Explicit conflict resolution after displaying the latest canonical content. Nothing is
    /// rebased automatically while a draft or unknown receipt could overwrite another user's edit.
    public func reviewInstructionConflict(keepDraft: Bool, workspaceId: String? = nil, expectedRevision: Int? = nil, expectedDigest: String? = nil) {
        guard !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              var state = guidanceByWorkspace[id], state.available, state.pending == nil,
              let read = state.current, let content = state.currentContent else { return }
        // The choice was made against a version that a refresh has since replaced (a confirmation can
        // stay open while one lands). Nothing changes; the person is told to look again.
        guard expectedRevision == nil || expectedRevision == read.instructionRevision,
              expectedDigest == nil || expectedDigest == read.digest else {
            state.note("The shared instructions changed while you were deciding. Review the current version and choose again.", aboutDraft: false)
            publishGuidance(state); return
        }
        if !keepDraft { state.draft = content }
        state.baseContent = content; state.baseRevision = read.instructionRevision; state.baseDigest = read.digest
        state.conflict = false; state.message = nil; publishGuidance(state)
    }
    public func saveInstructions(workspaceId: String? = nil, expectedDraft: String? = nil, expectedRevision: Int? = nil, expectedDigest: String? = nil) async {
        guard !busy, !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              var state = guidanceByWorkspace[id],
              state.canSave, let content = state.draft, let revision = state.baseRevision, let digest = state.baseDigest else { return }
        // The view that asked drew a different draft or base than the model holds now (a late tap after an
        // edit, a review or a refresh). Nothing is sent; the person is told, not left with a button that did nothing.
        if let expectedDraft, Data(expectedDraft.utf8) != Data(content.utf8) {
            state.note("The draft changed before it could be saved. Review it and save again.", aboutDraft: true)
            publishGuidance(state); return
        }
        guard expectedRevision == nil || expectedRevision == revision, expectedDigest == nil || expectedDigest == digest else {
            state.note("The shared instructions changed before this save. Review them and save again.", aboutDraft: false)
            publishGuidance(state); return
        }
        guard content.utf8.count <= Self.instructionMaxBytes, !content.contains("\0") else {
            state.note("Shared instructions must contain at most 65,536 UTF-8 bytes and no NUL characters.", aboutDraft: true)
            publishGuidance(state); return
        }
        // Capture every field before the first await. Later edits/refreshes cannot change a retry.
        let save = InstructionSave(workspaceId: id, requestId: UUID().uuidString, expectedDigest: digest, content: content, expectedRevision: revision)
        state.pending = save; state.receipt = nil; state.message = nil; publishGuidance(state)
        await performInstructionSave(save)
    }
    public func retryInstructionSave(workspaceId: String? = nil, requestId: String? = nil) async {
        guard !busy, !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              let save = guidanceByWorkspace[id]?.pending, requestId == nil || requestId == save.requestId else { return }
        await performInstructionSave(save)
    }
    /// Gives up on an unconfirmed save that cannot resolve, for example when the host answers
    /// `recovery_required` forever to a failed journaled operation's request ID. The draft is kept.
    /// The refresh comes first, so a save the host did apply is settled as applied rather than
    /// dropped. If that refresh cannot read the host's content, nothing is known about the save, and
    /// forgetting it would let the user review a stale version and overwrite a save that did land:
    /// the abandon is refused and the save stays pending. A save still unresolved after a successful
    /// read is forgotten and the draft's base is cleared: the user must review the host's current
    /// content (`reviewInstructionConflict`) before any new save, which then carries a fresh request ID.
    public func abandonInstructionSave(workspaceId: String? = nil, requestId: String? = nil) async {
        guard !busy, !guidanceBusy, let id = selected?.workspaceId, workspaceId == nil || workspaceId == id,
              let save = guidanceByWorkspace[id]?.pending, requestId == nil || requestId == save.requestId else { return }
        guidanceBusy = true
        await readGuidance(id)
        if var state = guidanceByWorkspace[id], state.pending?.requestId == save.requestId {
            if state.available {
                state.pending = nil; state.baseRevision = nil; state.baseDigest = nil; state.baseContent = nil
                state.conflict = true
                state.note("The unconfirmed save was abandoned. Compare the current shared content with your retained draft before saving.", aboutDraft: false)
            } else {
                // The read's own message ("unavailable, refresh") does not say what happened to the abandon.
                state.note("The unconfirmed save was not abandoned: the shared instructions could not be read to check whether the host already applied it. It is still pending. Refresh, then abandon it or retry it.", aboutDraft: false)
            }
            publishGuidance(state)
        }
        await finishGuidanceOperation()
    }
    private func performInstructionSave(_ save: InstructionSave) async {
        guidanceBusy = true
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
            await readGuidance(save.workspaceId, keepingReceipt: true)
        } catch {
            await settleFailedSave(error, save)
        }
        await finishGuidanceOperation()
    }
    /// What the host can say about a refused save, keyed by its `error.data.code`. All of these
    /// mean the request was refused before any write: nothing was applied, and replaying the same
    /// request ID can never succeed, so the pending save is dropped (the draft is kept).
    private static let definitiveSaveRefusals: [String: String] = [
        "authority_denied": "Changing shared instructions was not permitted. Nothing was saved; your draft is retained.",
        "invalid_request": "The host refused this content as an invalid request. Nothing was saved; your draft is retained. Check the size limit and remove NUL characters.",
        "not_found": "The host could not find this workspace's shared instructions. Nothing was saved; your draft is retained. Refresh to check their state.",
        "unsupported_topology": "This host cannot edit shared instructions for this workspace. Nothing was saved; your draft is retained.",
        "request_conflict": "The host refused this save because its request identity was already used for different content. Nothing was saved; your draft is retained. Save again to send it as a new request.",
    ]
    private func settleFailedSave(_ error: Error, _ save: InstructionSave) async {
        var state = guidanceByWorkspace[save.workspaceId]!
        let rpc = error as? RpcError
        let code = rpc?.data?["code"]?.stringValue
        if code == "revision_conflict" {
            // Definitive: the host changed first. Fetch the version that won so the review compares
            // against its current content, then hold the draft behind that explicit review.
            state.pending = nil; state.conflict = true
            publishGuidance(state)
            await readGuidance(save.workspaceId)
            var settled = guidanceByWorkspace[save.workspaceId] ?? state
            settled.pending = nil; settled.conflict = true
            if settled.available {
                settled.note("Shared instructions changed before this save. Review the current version below; your draft is retained.", aboutDraft: false)
            } else {
                settled.note("Shared instructions changed before this save. Refresh to review the current version; your draft is retained.", aboutDraft: false)
            }
            publishGuidance(settled)
        } else if let code, let text = Self.definitiveSaveRefusals[code] {
            state.pending = nil
            state.note(text, aboutDraft: true)
            publishGuidance(state)
        } else if isMethodNotFoundError(error) {
            // An older daemon without the method cannot have applied anything.
            state.pending = nil
            state.note("This version of the Winter service cannot edit shared instructions yet. Nothing was saved; your draft is retained.", aboutDraft: true)
            publishGuidance(state)
        } else if code == "recovery_required" {
            // Unknown whether it was applied, and it may never resolve: the host keeps this request
            // ID's failed operation forever. Keep the save and offer both ways forward.
            state.note("The host could not confirm this save and has not finished recovering it. Your draft is retained. Retry the same save, or abandon it if retrying keeps failing.", aboutDraft: false)
            publishGuidance(state)
        } else {
            // Transport loss or an invalid receipt: the write may have been applied.
            state.note("Save not confirmed. Your draft is retained. Retry the same save to resolve its receipt, or abandon it.", aboutDraft: false)
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
