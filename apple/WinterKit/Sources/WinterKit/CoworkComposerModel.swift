import Foundation
import Combine
import WinterProtocol

/// Where a new Cowork conversation's workspace comes from.
public enum CoworkFolderChoice: Equatable, Sendable {
    /// A folder the person picked, already prepared by the host (`workspace.selection.prepareFolder`). Sending
    /// creates a standalone workspace around it.
    case newWorkspace(CoworkPreparedFolder)
    /// A Project that already exists. A conversation joins it; its other conversations share the same grants.
    case existingProject(workspaceId: String, title: String)

    public var label: String {
        switch self {
        case let .newWorkspace(folder): return folder.label
        case let .existingProject(_, title): return title
        }
    }
}

/// What the composer's two chips and send button read and drive for a NEW Cowork conversation: the folder,
/// the workspace's default approval mode, and the create-then-send sequence.
///
/// The sequence (design 7.9): `workspace.create` (when the choice is a new folder), the workspace's default
/// approval policy when the person set one, then `session.create {mode:"cowork", cowork:{workspaceId,
/// location:"outputs", requestId}}`. The first session works in its OWN outputs folder (owner decision O1):
/// no source can honestly be mounted in the VM yet, so the folder is added to the workspace as a source that
/// stays `preparing`, and nothing here claims otherwise. The caller attaches to the returned session and
/// sends the first message; this model does not send text.
///
/// **Closed unless the gate is open.** `send` checks the app's own availability constant first and issues no
/// request of any kind while it is false; only then does it read `workspace.capabilities.get` and refuse
/// unless the daemon reports `execution` and `provisioning`. `workspace.create` and `session.create` are
/// unreachable otherwise.
///
/// **A retry replays, never duplicates.** Each request id is minted once per intent and kept across a failure,
/// and a workspace the daemon already acknowledged is remembered: after a lost `session.create` response the
/// next send reuses that workspace instead of creating a second one. The intent changes when the folder or
/// approval choice does, which retires the old ids.
@MainActor public final class CoworkComposerModel: ObservableObject {
    public typealias Call = CoworkWorkspaceModel.Call

    public enum Phase: Equatable, Sendable {
        case idle, starting
        /// One fixed sentence (`coworkSessionErrorText`), never daemon prose.
        case failed(String)
    }
    public struct Started: Equatable, Sendable {
        public let sessionId: String
        public let workspaceId: String
    }

    @Published public private(set) var folder: CoworkFolderChoice?
    /// `nil` leaves the workspace's own default alone. A value is written as the workspace's default approval
    /// policy, which applies to EVERY conversation in it, not only this one.
    @Published public private(set) var approval: CoworkApprovalPolicy?
    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var capabilities = CoworkCapabilities()
    @Published public private(set) var projects: [CoworkWorkspace] = []
    @Published public private(set) var folderError: String?

    private let modeAvailable: () -> Bool
    private let call: Call
    private let createSession: (CoworkSessionBinding) async throws -> String
    /// The ids and progress of the one intent being retried.
    private struct Attempt {
        let key: String
        let workspaceRequestId = UUID().uuidString
        let policyRequestId = UUID().uuidString
        let sessionRequestId = UUID().uuidString
        var workspaceId: String?
        var policyDone = false
    }
    private var attempt: Attempt?
    /// Selections a successful `workspace.create` already turned into a source. Releasing one would be wrong.
    private var consumedSelections: Set<String> = []

    /// - Parameters:
    ///   - modeAvailable: the app's own constant (`SessionMode.cowork.isAvailable`), read at each use.
    ///   - call: the Cowork JSON-RPC door (the same shape `CoworkWorkspaceModel` uses).
    ///   - createSession: `session.create` with the Cowork binding; returns the new session id.
    public init(modeAvailable: @escaping () -> Bool, call: @escaping Call,
                createSession: @escaping (CoworkSessionBinding) async throws -> String) {
        self.modeAvailable = modeAvailable
        self.call = call
        self.createSession = createSession
    }

    public convenience init(modeAvailable: @escaping () -> Bool, client: WinterClient) {
        self.init(modeAvailable: modeAvailable, call: CoworkWorkspaceModel.callThrough(client)) { binding in
            try await client.createSession(scope: "global", mode: "cowork", cowork: binding).sessionId
        }
    }

    private func send<T>(_ request: CoworkRequest<T>) async throws -> T {
        try request.decode(await call(request.method, request.params))
    }

    /// The gate as it stands now. Read-only; issues nothing.
    public var gate: CoworkGate { CoworkGate(modeAvailable: modeAvailable(), capabilities: capabilities) }

    /// Whether the composer's Cowork controls and send are offered at all.
    public var isOpen: Bool { gate.isOpen }

    // MARK: Choices

    public func chooseFolder(_ prepared: CoworkPreparedFolder) {
        let old = folder
        folder = .newWorkspace(prepared); folderError = nil
        revokeIfPrepared(old)
    }
    public func chooseProject(_ workspace: CoworkWorkspace) {
        let old = folder
        folder = .existingProject(workspaceId: workspace.workspaceId, title: workspace.title); folderError = nil
        revokeIfPrepared(old)
    }
    public func clearFolder() {
        let old = folder
        folder = nil
        revokeIfPrepared(old)
    }
    public func setApproval(_ policy: CoworkApprovalPolicy?) { approval = policy }
    public func reportFolderError(_ error: Error) { folderError = coworkSessionErrorText(error) }

    /// A prepared-but-unused selection is a host grant waiting to expire; release it when it is replaced.
    private func revokeIfPrepared(_ old: CoworkFolderChoice?) {
        guard case let .newWorkspace(prepared)? = old, old != folder, !consumedSelections.contains(prepared.selectionId) else { return }
        let id = prepared.selectionId, call = call
        Task { _ = try? await call("workspace.selection.revoke", CoworkRequest<CoworkSelectionRevocation>.revokeSelection(id).params) }
    }

    // MARK: Reading the daemon

    /// Reads `workspace.capabilities.get` (and the Projects a conversation could join). Skipped entirely while
    /// the app's constant is off, so a closed Cowork costs no request. Older daemons answer nothing useful:
    /// everything stays closed.
    public func refresh() async {
        guard modeAvailable() else { capabilities = CoworkCapabilities(); projects = []; return }
        capabilities = (try? await send(CoworkRequest<CoworkCapabilities>.capabilities())) ?? CoworkCapabilities()
        guard capabilities.provisioning else { projects = []; return }
        if let page = try? await send(CoworkRequest<CoworkProjectPage>.listProjects()) {
            projects = page.projects.map(\.workspace)
        }
    }

    /// Prepares a folder the native picker already returned. `prepare` is the app's closure around the host
    /// bookmark call, so no file URL or path is ever sent as authority.
    public func pickFolder(prepare: () async throws -> CoworkPreparedFolder) async {
        guard gate.isOpen else { folderError = gate.closedReason; return }
        do { chooseFolder(try await prepare()) } catch { reportFolderError(error) }
    }

    // MARK: Send

    /// Why send cannot proceed, or `nil`. Pure over the model's state.
    public func blockedReason(draft: String) -> String? {
        if let reason = gate.closedReason { return reason }
        if phase == .starting { return "" }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "" }
        if folder == nil { return "Choose a folder first" }
        return nil
    }

    /// Creates the workspace (when needed), applies a chosen default approval mode, and creates the Cowork
    /// session. Returns the new session, or `nil` with `phase == .failed(...)`.
    public func start(draft: String) async -> Started? {
        guard phase != .starting else { return nil }
        // The constant first, with no request of any kind behind it.
        guard modeAvailable() else { phase = .failed(CoworkGate(modeAvailable: false, capabilities: capabilities).closedReason ?? ""); return nil }
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        guard let choice = folder else { phase = .failed("Choose a folder first."); return nil }
        phase = .starting
        // Re-read the daemon at send time: the gate is what is true now, not what was true when the page opened.
        capabilities = (try? await send(CoworkRequest<CoworkCapabilities>.capabilities())) ?? CoworkCapabilities()
        if let reason = gate.closedReason { phase = .failed(reason); return nil }

        let key = Self.intentKey(choice: choice, approval: approval)
        var current = attempt?.key == key ? attempt! : Attempt(key: key)
        do {
            let workspaceId: String
            switch choice {
            case let .existingProject(id, _):
                workspaceId = id
            case let .newWorkspace(prepared):
                if let known = current.workspaceId { workspaceId = known } else {
                    let receipt = try await send(CoworkRequest<CoworkReceipt<CoworkWorkspace>>.create(
                        requestId: current.workspaceRequestId, ownership: .standalone,
                        title: Self.workspaceTitle(folder: prepared.label, draft: draft), selections: [prepared.selection]))
                    workspaceId = receipt.workspaceId
                    consumedSelections.insert(prepared.selectionId)
                    current.workspaceId = workspaceId; attempt = current // the workspace exists now: a retry reuses it
                }
            }
            if let approval, !current.policyDone {
                let workspace = try await send(CoworkRequest<CoworkWorkspace>.get(workspaceId: workspaceId))
                let existing = workspace.policy?.defaultPolicy ?? workspace.policySummary?.defaultPolicy
                if existing != approval {
                    _ = try await send(CoworkRequest<CoworkReceipt<CoworkPolicyValue>>.setDefaultPolicy(
                        workspaceId: workspaceId, requestId: current.policyRequestId,
                        expectedRevision: workspace.configRevision, policy: approval))
                }
                current.policyDone = true; attempt = current
            }
            let sessionId = try await createSession(CoworkSessionBinding(
                workspaceId: workspaceId, location: .outputs, requestId: current.sessionRequestId))
            attempt = nil; folder = nil; phase = .idle
            return Started(sessionId: sessionId, workspaceId: workspaceId)
        } catch {
            attempt = current
            phase = .failed(coworkSessionErrorText(error))
            return nil
        }
    }

    public func dismissFailure() { if case .failed = phase { phase = .idle } }

    // MARK: Pure helpers

    static func intentKey(choice: CoworkFolderChoice, approval: CoworkApprovalPolicy?) -> String {
        switch choice {
        case let .newWorkspace(folder): return ["new", folder.selectionId, approval?.rawValue ?? "-"].joined(separator: "\u{1f}")
        case let .existingProject(id, _): return ["project", id, approval?.rawValue ?? "-"].joined(separator: "\u{1f}")
        }
    }

    /// A valid workspace title (`CoworkWorkspaceModel.validTitle`: 1 to 200 UTF-16 units, no control breaks):
    /// the folder's name, else the opening of the message.
    static func workspaceTitle(folder: String, draft: String) -> String {
        func clean(_ text: String) -> String {
            let single = text.components(separatedBy: .newlines).joined(separator: " ")
                .replacingOccurrences(of: "\0", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            return String(single.prefix(80))
        }
        let name = clean(folder)
        if CoworkWorkspaceModel.validTitle(name) { return name }
        let opening = clean(draft)
        return CoworkWorkspaceModel.validTitle(opening) ? opening : "Cowork workspace"
    }
}

extension CoworkWorkspaceModel {
    /// The `Call` shape over a connected client (the same bridge `init(client:)` builds).
    @MainActor static func callThrough(_ client: WinterClient) -> Call {
        { method, params in
            let local = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(params))
            return try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONEncoder().encode(await client.request(method, params: local)))
        }
    }
}
