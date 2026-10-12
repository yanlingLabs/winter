import Foundation

public enum CoworkApprovalPolicy: String, Codable, Sendable { case plan, ask, auto, bypass; case dontAsk = "dont-ask", acceptEdits = "accept-edits" }
public enum CoworkOwnership: String, Codable, Sendable { case standalone, project }
public enum CoworkSourceKind: String, Codable, Sendable { case folder, githubRepository }
public enum CoworkPublicationPolicy: String, Codable, Sendable { case manual; case githubOnlyFeatureBranches = "github-only-feature-branches" }
public struct CoworkCapabilityCeiling: Codable, Equatable, Sendable {
    public let toolClasses: [String], hostServices: [String], connectors: [String]
    public let network: String
    public init(toolClasses: [String], hostServices: [String], connectors: [String], network: String) {
        self.toolClasses = toolClasses; self.hostServices = hostServices; self.connectors = connectors; self.network = network
    }
}
public struct CoworkWorkspacePolicy: Codable, Equatable, Sendable {
    public let policyId: String, workspaceId: String
    public let defaultPolicy: CoworkApprovalPolicy, publication: CoworkPublicationPolicy
    public let ceiling: CoworkCapabilityCeiling
    public let revision: Int, defaultRevision: Int, publicationRevision: Int
}
/// Safe host projection. Never contains roots, bookmarks, authority references or grant handles.
public struct CoworkSource: Codable, Equatable, Sendable {
    public let sourceId: String, workspaceId: String, locationId: String
    public let kind: CoworkSourceKind, label: String, access: String, desired: String, state: String
    public let revision: Int, ackRevision: Int?, reason: String?, restartRequired: Bool, trust: String
    public let createdAt: String, updatedAt: String
}
public struct CoworkWorkspaceRecord: Codable, Equatable, Sendable {
    public let workspaceId: String, ownership: CoworkOwnership, ownerId: String, title: String, state: String
    public let configRevision: Int, grantRevision: Int, instructionRevision: Int, leaseEpoch: Int
    public let power: String, createdAt: String, updatedAt: String
}
public enum CoworkDetailState: String, Codable, Sendable { case complete, summary }
public struct CoworkPolicySummary: Codable, Equatable, Sendable {
    public struct Counts: Codable, Equatable, Sendable { public let toolClasses: Int, hostServices: Int, connectors: Int }
    public let policyId: String, workspaceId: String
    public let defaultPolicy: CoworkApprovalPolicy, publication: CoworkPublicationPolicy
    public let revision: Int, defaultRevision: Int, publicationRevision: Int
    public let network: String, capabilityCounts: Counts
}
/// A mutation summary preserves its recorded policy revision, but contains no capability grant.
public enum CoworkPolicyValue: Codable, Equatable, Sendable {
    case complete(CoworkWorkspacePolicy), summary(CoworkPolicySummary)
    private enum CodingKeys: String, CodingKey { case detailState, detailReason, detailMethod, policySummary, policyId, workspaceId, defaultPolicy, publication, ceiling, revision, defaultRevision, publicationRevision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(CoworkDetailState.self, forKey: .detailState) {
        case .complete:
            guard !c.contains(.detailReason), !c.contains(.detailMethod), !c.contains(.policySummary) else { throw DecodingError.dataCorruptedError(forKey: .detailState, in: c, debugDescription: "Complete policy cannot contain summary details") }
            self = .complete(try CoworkWorkspacePolicy(from: decoder))
        case .summary:
            let policyKeys: [CodingKeys] = [.policyId, .workspaceId, .defaultPolicy, .publication, .ceiling, .revision, .defaultRevision, .publicationRevision]
            guard !policyKeys.contains(where: c.contains), try c.decode(String.self, forKey: .detailReason) == "response_limit", try c.decode(String.self, forKey: .detailMethod) == "workspace.policy.get" else { throw DecodingError.dataCorruptedError(forKey: .detailState, in: c, debugDescription: "Invalid policy summary recovery metadata") }
            self = .summary(try c.decode(CoworkPolicySummary.self, forKey: .policySummary))
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .complete(policy):
            try c.encode(CoworkDetailState.complete, forKey: .detailState); try policy.encode(to: encoder)
        case let .summary(policy):
            try c.encode(CoworkDetailState.summary, forKey: .detailState); try c.encode("response_limit", forKey: .detailReason)
            try c.encode("workspace.policy.get", forKey: .detailMethod); try c.encode(policy, forKey: .policySummary)
        }
    }
}
public struct CoworkDetailMethods: Codable, Equatable, Sendable { public let sources: String, policy: String }
public struct CoworkWorkspace: Codable, Equatable, Sendable {
    public let workspaceId: String, ownership: CoworkOwnership, ownerId: String, title: String, state: String
    public let configRevision: Int, grantRevision: Int, instructionRevision: Int, leaseEpoch: Int
    public let power: String, createdAt: String, updatedAt: String
    public let automaticPublication: Bool, detailState: CoworkDetailState
    public let policy: CoworkWorkspacePolicy?, sources: [CoworkSource]?
    /// Display/recovery metadata; absent capability details never imply an empty grant.
    public let detailReason: String?, policySummary: CoworkPolicySummary?, sourceCount: Int?, detailMethods: CoworkDetailMethods?
    private enum CodingKeys: String, CodingKey { case workspaceId, ownership, ownerId, title, state, configRevision, grantRevision, instructionRevision, leaseEpoch, power, createdAt, updatedAt, automaticPublication, detailState, policy, sources, detailReason, policySummary, sourceCount, detailMethods }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = try c.decode(String.self, forKey: .workspaceId); ownership = try c.decode(CoworkOwnership.self, forKey: .ownership)
        ownerId = try c.decode(String.self, forKey: .ownerId); title = try c.decode(String.self, forKey: .title); state = try c.decode(String.self, forKey: .state)
        configRevision = try c.decode(Int.self, forKey: .configRevision); grantRevision = try c.decode(Int.self, forKey: .grantRevision)
        instructionRevision = try c.decode(Int.self, forKey: .instructionRevision); leaseEpoch = try c.decode(Int.self, forKey: .leaseEpoch)
        power = try c.decode(String.self, forKey: .power); createdAt = try c.decode(String.self, forKey: .createdAt); updatedAt = try c.decode(String.self, forKey: .updatedAt)
        automaticPublication = try c.decode(Bool.self, forKey: .automaticPublication); detailState = try c.decode(CoworkDetailState.self, forKey: .detailState)
        switch detailState {
        case .complete:
            guard !c.contains(.detailReason), !c.contains(.policySummary), !c.contains(.sourceCount), !c.contains(.detailMethods) else { throw DecodingError.dataCorruptedError(forKey: .detailState, in: c, debugDescription: "Complete workspace cannot contain summary details") }
            policy = try c.decode(CoworkWorkspacePolicy.self, forKey: .policy); sources = try c.decode([CoworkSource].self, forKey: .sources)
            detailReason = nil; policySummary = nil; sourceCount = nil; detailMethods = nil
        case .summary:
            guard !c.contains(.policy), !c.contains(.sources) else { throw DecodingError.dataCorruptedError(forKey: .detailState, in: c, debugDescription: "Summary cannot contain effective capability details") }
            policy = nil; sources = nil
            let reason = try c.decode(String.self, forKey: .detailReason), count = try c.decode(Int.self, forKey: .sourceCount), methods = try c.decode(CoworkDetailMethods.self, forKey: .detailMethods)
            guard reason == "response_limit", count >= 0, methods.sources == "workspace.source.list", methods.policy == "workspace.policy.get" else { throw DecodingError.dataCorruptedError(forKey: .detailState, in: c, debugDescription: "Invalid summary recovery metadata") }
            detailReason = reason; sourceCount = count; detailMethods = methods; policySummary = try c.decode(CoworkPolicySummary.self, forKey: .policySummary)
        }
    }
}
public struct CoworkPolicyPage: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable { public let kind: String, name: String }
    public let policy: CoworkPolicySummary, entries: [Entry], nextCursor: String?
}
public struct CoworkProject: Codable, Equatable, Sendable { public let projectId: String, workspace: CoworkWorkspace }
public struct CoworkWorkspacePage: Codable, Equatable, Sendable { public let workspaces: [CoworkWorkspace], nextCursor: String? }
public struct CoworkProjectPage: Codable, Equatable, Sendable { public let projects: [CoworkProject], nextCursor: String? }
public struct CoworkSourceList: Codable, Equatable, Sendable { public let sources: [CoworkSource], nextCursor: String? }
public struct CoworkReceipt<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let operationId: String, workspaceId: String, revision: Int, value: Value
}
public struct CoworkOperation: Codable, Equatable, Sendable {
    public let operationId: String, workspaceId: String, revision: Int, status: String, terminal: Bool
    public init(operationId: String, workspaceId: String, revision: Int, status: String, terminal: Bool) {
        self.operationId = operationId; self.workspaceId = workspaceId; self.revision = revision; self.status = status; self.terminal = terminal
    }
}
public struct CoworkSelection: Codable, Equatable, Sendable {
    public let selectionId: String, kind: CoworkSourceKind
    public init(selectionId: String, kind: CoworkSourceKind) { self.selectionId = selectionId; self.kind = kind }
}
/// Typed request inventory shared by Mac and paired clients. Availability still depends on current
/// host authority and feasibility gates. The paired transport token alone grants no workspace.
public struct CoworkRequest<Result: Decodable & Sendable>: Sendable {
    public let method: String, params: SessionEvent.JSONValue
    fileprivate init(_ method: String, _ values: [String: SessionEvent.JSONValue]) { self.method = method; self.params = .object(values) }
    public func decode(_ value: SessionEvent.JSONValue) throws -> Result { try JSONDecoder().decode(Result.self, from: JSONEncoder().encode(value)) }
}
private func mutation(_ workspaceId: String, _ requestId: String, _ revision: Int) -> [String: SessionEvent.JSONValue] {
    ["workspaceId": .string(workspaceId), "requestId": .string(requestId), "expectedRevision": .number(Double(revision))]
}
extension CoworkRequest where Result == CoworkWorkspacePage {
    public static func list(cursor: String? = nil, limit: Int = 100) -> Self {
        var p: [String: SessionEvent.JSONValue] = ["limit": .number(Double(limit))]; if let cursor { p["cursor"] = .string(cursor) }; return Self("workspace.list", p)
    }
}
extension CoworkRequest where Result == CoworkProjectPage {
    public static func listProjects(cursor: String? = nil, limit: Int = 100) -> Self {
        var p: [String: SessionEvent.JSONValue] = ["limit": .number(Double(limit))]; if let cursor { p["cursor"] = .string(cursor) }; return Self("project.list", p)
    }
}
extension CoworkRequest where Result == CoworkWorkspace {
    public static func get(workspaceId: String) -> Self { Self("workspace.get", ["workspaceId": .string(workspaceId)]) }
}
extension CoworkRequest where Result == CoworkPolicyPage {
    public static func policy(workspaceId: String, cursor: String? = nil, limit: Int = 100, expectedRevision: Int? = nil) -> Self {
        var p: [String: SessionEvent.JSONValue] = ["workspaceId": .string(workspaceId), "limit": .number(Double(limit))]
        if let cursor { p["cursor"] = .string(cursor) }; if let expectedRevision { p["expectedRevision"] = .number(Double(expectedRevision)) }
        return Self("workspace.policy.get", p)
    }
}
extension CoworkRequest where Result == CoworkProject {
    public static func getProject(projectId: String) -> Self { Self("project.get", ["projectId": .string(projectId)]) }
}
extension CoworkRequest where Result == CoworkReceipt<CoworkWorkspace> {
    public static func create(requestId: String, ownership: CoworkOwnership, title: String, selections: [CoworkSelection]) -> Self {
        Self("workspace.create", ["requestId": .string(requestId), "ownership": .string(ownership.rawValue), "title": .string(title), "selections": .array(selections.map { .object(["selectionId": .string($0.selectionId), "kind": .string($0.kind.rawValue)]) })])
    }
    public static func createProject(requestId: String, title: String, selections: [CoworkSelection]) -> Self {
        Self("project.create", ["requestId": .string(requestId), "title": .string(title), "selections": .array(selections.map { .object(["selectionId": .string($0.selectionId), "kind": .string($0.kind.rawValue)]) })])
    }
}
extension CoworkRequest where Result == CoworkReceipt<CoworkWorkspaceRecord> {
    public static func update(workspaceId: String, requestId: String, expectedRevision: Int, title: String) -> Self {
        var p = mutation(workspaceId, requestId, expectedRevision); p["title"] = .string(title); return Self("workspace.update", p)
    }
    public static func updateProject(projectId: String, requestId: String, expectedRevision: Int, title: String) -> Self {
        Self("project.update", ["projectId": .string(projectId), "requestId": .string(requestId), "expectedRevision": .number(Double(expectedRevision)), "title": .string(title)])
    }
}
extension CoworkRequest where Result == CoworkSourceList {
    public static func listSources(workspaceId: String, cursor: String? = nil, limit: Int = 100, expectedRevision: Int? = nil) -> Self {
        var p: [String: SessionEvent.JSONValue] = ["workspaceId": .string(workspaceId), "limit": .number(Double(limit))]
        if let cursor { p["cursor"] = .string(cursor) }; if let expectedRevision { p["expectedRevision"] = .number(Double(expectedRevision)) }
        return Self("workspace.source.list", p)
    }
}
extension CoworkRequest where Result == CoworkSource {
    public static func getSource(workspaceId: String, sourceId: String) -> Self { Self("workspace.source.get", ["workspaceId": .string(workspaceId), "sourceId": .string(sourceId)]) }
}
extension CoworkRequest where Result == CoworkReceipt<CoworkSource> {
    public static func addSource(workspaceId: String, requestId: String, expectedRevision: Int, selectionId: String, kind: CoworkSourceKind) -> Self {
        var p = mutation(workspaceId, requestId, expectedRevision); p["selectionId"] = .string(selectionId)
        return Self(kind == .folder ? "workspace.source.addFolder" : "workspace.source.addRepository", p)
    }
    public static func removeSource(workspaceId: String, sourceId: String, requestId: String, expectedRevision: Int, revoke: Bool = false) -> Self {
        var p = mutation(workspaceId, requestId, expectedRevision); p["sourceId"] = .string(sourceId)
        return Self(revoke ? "workspace.source.revoke" : "workspace.source.remove", p)
    }
}
extension CoworkRequest where Result == CoworkReceipt<CoworkPolicyValue> {
    public static func setDefaultPolicy(workspaceId: String, requestId: String, expectedRevision: Int, policy: CoworkApprovalPolicy) -> Self {
        var p = mutation(workspaceId, requestId, expectedRevision); p["defaultPolicy"] = .string(policy.rawValue); return Self("workspace.setDefaultPolicy", p)
    }
    public static func setProjectDefaultPolicy(projectId: String, requestId: String, expectedRevision: Int, policy: CoworkApprovalPolicy) -> Self {
        Self("project.setDefaultPolicy", ["projectId": .string(projectId), "requestId": .string(requestId), "expectedRevision": .number(Double(expectedRevision)), "defaultPolicy": .string(policy.rawValue)])
    }
    public static func setPublicationPolicy(workspaceId: String, requestId: String, expectedRevision: Int, publication: CoworkPublicationPolicy) -> Self {
        var p = mutation(workspaceId, requestId, expectedRevision); p["publication"] = .string(publication.rawValue); return Self("workspace.setPublicationPolicy", p)
    }
    public static func setCapabilityCeiling(workspaceId: String, requestId: String, expectedRevision: Int, ceiling: CoworkCapabilityCeiling) throws -> Self {
        var p = mutation(workspaceId, requestId, expectedRevision); p["ceiling"] = try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONEncoder().encode(ceiling)); return Self("workspace.setCapabilityCeiling", p)
    }
}
extension CoworkRequest where Result == CoworkOperation {
    public static func operation(workspaceId: String, operationId: String) -> Self { Self("workspace.operation.get", ["workspaceId": .string(workspaceId), "operationId": .string(operationId)]) }
}
