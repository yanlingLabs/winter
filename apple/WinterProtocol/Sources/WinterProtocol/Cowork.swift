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
public struct CoworkWorkspace: Codable, Equatable, Sendable {
    public let workspaceId: String, ownership: CoworkOwnership, ownerId: String, title: String, state: String
    public let configRevision: Int, grantRevision: Int, instructionRevision: Int, leaseEpoch: Int
    public let power: String, createdAt: String, updatedAt: String
    public let policy: CoworkWorkspacePolicy, sources: [CoworkSource], automaticPublication: Bool
}
public struct CoworkProject: Codable, Equatable, Sendable { public let projectId: String, workspace: CoworkWorkspace }
public struct CoworkWorkspacePage: Codable, Equatable, Sendable { public let workspaces: [CoworkWorkspace], nextCursor: String? }
public struct CoworkProjectPage: Codable, Equatable, Sendable { public let projects: [CoworkProject], nextCursor: String? }
public struct CoworkSourceList: Codable, Equatable, Sendable { public let sources: [CoworkSource] }
public struct CoworkReceipt<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let operationId: String, workspaceId: String, revision: Int, value: Value
}
public struct CoworkOperation: Codable, Equatable, Sendable {
    public let operationId: String, workspaceId: String, revision: Int, status: String, terminal: Bool
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
    public static func listSources(workspaceId: String) -> Self { Self("workspace.source.list", ["workspaceId": .string(workspaceId)]) }
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
extension CoworkRequest where Result == CoworkReceipt<CoworkWorkspacePolicy> {
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
