import Foundation
import WinterProtocol

// The Mac's side of the Cowork session door (docs/research/2026-10-18-cowork-session-door-design.md, 7.9).
//
// Everything here is pure or injected, so `swift test` runs it: the gate that keeps every Cowork surface
// unreachable, the fixed copy for the door's refusals, the notes a Cowork session window shows, and the
// `session.list` row decode. Nothing here makes Cowork available; the daemon still answers every
// `session.create {mode:"cowork"}` with `unsupported_topology` until the owner's flip.

// MARK: - The gate

/// The one answer to "may a Cowork surface exist right now?".
///
/// Two independent inputs, both required: the app's own availability constant for the mode
/// (`SessionMode.cowork.isAvailable`, which stays `false` until the flip slice) AND what the connected daemon
/// reports (`workspace.capabilities.get`: it must run conversations and provision workspaces). The constant is
/// an input rather than a read so a test can hold the gate open and exercise the whole path; production passes
/// the real constant, so a daemon that claims `execution: true` still opens nothing while the constant is off.
public struct CoworkGate: Equatable, Sendable {
    public let modeAvailable: Bool
    public let capabilities: CoworkCapabilities

    public init(modeAvailable: Bool, capabilities: CoworkCapabilities) {
        self.modeAvailable = modeAvailable
        self.capabilities = capabilities
    }

    /// Both halves, and the daemon's `execution` and `provisioning` (a conversation needs a workspace, and a
    /// workspace needs storage). Folder preparation is not part of it: it is a Mac-local capability.
    public var isOpen: Bool { modeAvailable && capabilities.execution && capabilities.provisioning }

    /// One fixed sentence for why nothing is offered, or `nil` when the gate is open. Ordered so the most
    /// fundamental reason wins: an app that does not offer the mode says so, whatever the daemon claims.
    public var closedReason: String? {
        if !modeAvailable { return "Cowork isn't available in this Winter yet." }
        if !capabilities.execution { return "This Winter can't run Cowork conversations yet." }
        if !capabilities.provisioning { return "Cowork workspace storage isn't ready yet." }
        return nil
    }
}

// MARK: - Refusal copy

/// PURE: one fixed sentence per refusal of a Cowork conversation request (`session.create`, `workspace.create`,
/// the policy write, `session.send`). `RpcError.message` is daemon prose and never reaches the screen;
/// `RpcError` is not a `LocalizedError`, so every branch returns a literal. A code this build has never heard
/// of (a newer daemon) and a plain error with no code fall to the generic sentence with the numeric code; a
/// non-RPC error (a transport failure, this kit's own `LocalizedError`s) keeps its own description.
public func coworkSessionErrorText(_ error: Error) -> String {
    guard let rpc = error as? RpcError else { return error.localizedDescription }
    if rpc.isMethodNotFound { return "This Winter daemon doesn't support Cowork conversations yet." }
    guard let code = rpc.coworkCode else {
        return "The Winter daemon could not start this Cowork conversation (error \(rpc.code))."
    }
    switch code {
    case .unsupportedTopology:
        return "Cowork conversations aren't available in this Winter setup yet. Nothing was created."
    case .providerUnavailable:
        return "Cowork can't reach a model yet: this Winter has no model route into the workspace's VM. Nothing was sent."
    case .conversationLimit:
        return "This workspace is already running a conversation, and its VM serves one at a time for now. Wait for it to finish, then send again."
    case .coldResumeUnavailable:
        return "This conversation's VM has stopped, and Winter can't resume it yet. Start a new Cowork conversation to continue."
    case .authorityDenied:
        return "Winter didn't permit that for this workspace."
    case .notFound:
        return "That workspace is no longer available."
    case .revisionConflict:
        return "The workspace changed before this could be applied. Try again."
    case .invalidRequest:
        return "Winter sent a request the daemon could not accept. Try again."
    case .recoveryRequired:
        return "Winter could not finish this and may need to recover the workspace. Try again later."
    case .scheduleBudgetExhausted:
        return "The Winter daemon could not complete this request (error \(rpc.code))."
    }
}

// MARK: - The session list row

/// `SessionRow.cowork` on `session.list`: which workspace (and Project, when it has one) a Cowork conversation
/// belongs to. Ids only.
public struct CoworkRowFacts: Equatable, Sendable {
    public let workspaceId: String
    public let projectId: String?
    public init(workspaceId: String, projectId: String? = nil) {
        self.workspaceId = workspaceId
        self.projectId = projectId
    }

    /// Fallback-safe: a row without the field, or with one that is not an object carrying a workspace id, is
    /// `nil`, never a crash and never a half-filled value. `projectId` may be absent or `null`.
    public static func decode(row: JSONValue) -> CoworkRowFacts? {
        guard let cowork = row["cowork"], let workspaceId = cowork["workspaceId"]?.stringValue, !workspaceId.isEmpty else { return nil }
        return CoworkRowFacts(workspaceId: workspaceId, projectId: cowork["projectId"]?.stringValue)
    }
}

extension WinterClient {
    /// The Cowork rows of `session.list`, keyed by session id. A separate read from `listSessions()` (whose
    /// tuple other lanes extend) so adding it touches neither; callers ask only when a row's mode is
    /// `"cowork"`, which no production daemon can produce yet.
    public func listCoworkRowFacts() async throws -> [String: CoworkRowFacts] {
        let r = try await request("session.list", params: nil)
        var facts: [String: CoworkRowFacts] = [:]
        for row in r["sessions"]?.arrayValue ?? [] {
            if let id = row["sessionId"]?.stringValue, let value = CoworkRowFacts.decode(row: row) { facts[id] = value }
        }
        return facts
    }
}

// MARK: - The session window's notes

/// One honest line a Cowork session window shows above its transcript.
public struct CoworkSessionNote: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable {
        case unavailable, starting, draining, uncertain, outputsLocation, sourcePreparing, sourceUnavailable
        case outputsNotVisible, guidanceNotLoaded
    }
    public let kind: Kind
    public let text: String
    /// The source a per-source note is about, so two sources never share an id.
    public let subject: String?
    public var id: String { subject.map { kind.rawValue + ":" + $0 } ?? kind.rawValue }
}

/// PURE: the notes a Cowork session window shows. Every line is a fact about what is true in this version:
///
/// - gate closed: ONE note and nothing else (a synthetic Cowork row that arrives while Cowork is off shows the
///   unavailable state, never the conversation chrome);
/// - the VM's power, only where the Mac actually knows something worth saying (`stopped` says nothing: it does
///   not tell a first start from a stop that cold resume could not reverse);
/// - where the conversation works (`outputs`: its own folder, not the Mac folder) and what each source honestly
///   is (preparing, with the reason the daemon gave);
/// - G11: outputs live on the VM disk and the Mac's readers cannot see them yet;
/// - guidance is not loaded into the model in this version.
public func coworkSessionNotes(gate: CoworkGate, power: String?, location: String?, sources: [CoworkSource]) -> [CoworkSessionNote] {
    guard gate.isOpen else {
        return [CoworkSessionNote(kind: .unavailable, text: gate.closedReason ?? "Cowork isn't available.", subject: nil)]
    }
    var notes: [CoworkSessionNote] = []
    switch power {
    case "starting":
        notes.append(CoworkSessionNote(kind: .starting, text: "The workspace's VM is starting. A first reply can take up to about two and a half minutes.", subject: nil))
    case "draining":
        notes.append(CoworkSessionNote(kind: .draining, text: "The workspace's VM is shutting down.", subject: nil))
    case "uncertain":
        notes.append(CoworkSessionNote(kind: .uncertain, text: "Winter can't tell whether the workspace's VM is running.", subject: nil))
    default: break
    }
    if location == "outputs" {
        notes.append(CoworkSessionNote(kind: .outputsLocation, text: "This conversation works in its own outputs folder, not in your Mac folder.", subject: nil))
    }
    for source in sources where source.desired == "present" {
        switch source.state {
        case "preparing":
            let text = source.reason == "share_unavailable"
                ? "“\(source.label)” is preparing. Winter can't share Mac folders with the VM yet, so the model can't see it."
                : "“\(source.label)” is still preparing."
            notes.append(CoworkSessionNote(kind: .sourcePreparing, text: text, subject: source.sourceId))
        case "unavailable":
            notes.append(CoworkSessionNote(kind: .sourceUnavailable, text: "“\(source.label)” is unavailable.", subject: source.sourceId))
        default: break
        }
    }
    notes.append(CoworkSessionNote(kind: .outputsNotVisible, text: "Files this conversation writes live on the workspace's VM disk. Your Mac and Winter's outputs list can't see them yet.", subject: nil))
    notes.append(CoworkSessionNote(kind: .guidanceNotLoaded, text: "Workspace guidance isn't loaded in this version, so the model hasn't read it.", subject: nil))
    return notes
}
