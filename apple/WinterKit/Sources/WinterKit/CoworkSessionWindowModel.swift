import Foundation
import Combine
import WinterProtocol

/// What a Cowork session window knows about its workspace: the VM's power and the sources' honest states,
/// read from `workspace.get` and `workspace.source.list` (metadata only; nothing here claims a mount or that
/// the guest saw a source). The Mac has no `workspace.watch` client yet, so a window that is waiting on the VM
/// polls: quickly while the power is changing, slowly otherwise.
///
/// Reads nothing while the gate is closed, and a failed read keeps the last good values rather than blanking a
/// window that was telling the truth a moment ago.
@MainActor public final class CoworkSessionWindowModel: ObservableObject {
    public typealias Call = CoworkWorkspaceModel.Call
    @Published public private(set) var workspaceId: String?
    @Published public private(set) var workspace: CoworkWorkspace?
    @Published public private(set) var sources: [CoworkSource] = []
    @Published public private(set) var capabilities = CoworkCapabilities()

    private let modeAvailable: () -> Bool
    private let call: Call
    public init(modeAvailable: @escaping () -> Bool, call: @escaping Call) {
        self.modeAvailable = modeAvailable
        self.call = call
    }
    public convenience init(modeAvailable: @escaping () -> Bool, client: WinterClient) {
        self.init(modeAvailable: modeAvailable, call: CoworkWorkspaceModel.callThrough(client))
    }

    public var gate: CoworkGate { CoworkGate(modeAvailable: modeAvailable(), capabilities: capabilities) }
    public var power: String? { workspace?.power }

    /// Points the window at a workspace (`nil` for a session that is not a Cowork conversation). A different
    /// workspace drops the old one's values at once so they are never shown under the wrong conversation.
    public func bind(workspaceId id: String?) {
        guard id != workspaceId else { return }
        workspaceId = id; workspace = nil; sources = []
    }

    /// The notes for this window; with `location` from `session_created.cowork` when known.
    public func notes(location: String?) -> [CoworkSessionNote] {
        coworkSessionNotes(gate: gate, power: power, location: location, sources: sources)
    }

    /// Seconds until the next read: quick while the VM is changing state, slow when it is settled.
    public var pollSeconds: Double {
        switch power {
        case "starting", "draining", "uncertain": return 3
        default: return 15
        }
    }

    public func refresh() async {
        guard modeAvailable(), let id = workspaceId else { return }
        func send<T>(_ request: CoworkRequest<T>) async throws -> T {
            try request.decode(await call(request.method, request.params))
        }
        capabilities = (try? await send(CoworkRequest<CoworkCapabilities>.capabilities())) ?? CoworkCapabilities()
        guard gate.isOpen else { return }
        do {
            let value = try await send(CoworkRequest<CoworkWorkspace>.get(workspaceId: id))
            let page = try await send(CoworkRequest<CoworkSourceList>.listSources(workspaceId: id, expectedRevision: value.configRevision))
            // The binding may have moved while the reads were out; a late answer for the old workspace is dropped.
            guard workspaceId == id, value.workspaceId == id, page.sources.allSatisfy({ $0.workspaceId == id }) else { return }
            workspace = value; sources = page.sources
        } catch {
            // Keep what the window already shows.
        }
    }
}
