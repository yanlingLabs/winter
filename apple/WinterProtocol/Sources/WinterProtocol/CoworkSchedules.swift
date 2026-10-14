import Foundation

public enum CoworkScheduleState: String, Codable, Sendable { case enabled, cancelled, handled }
public enum CoworkScheduleOccurrenceState: String, Codable, Sendable { case pending, claimed, dispatching, uncertain, handled, cancelled }
public enum CoworkScheduleReason: String, Codable, Sendable {
    case executionUnavailable = "execution_unavailable", shutdown, archived
    case sourceUnavailable = "source_unavailable", authorityDenied = "authority_denied"
    case branchMismatch = "branch_mismatch", branchStateUnavailable = "branch_state_unavailable"
    case recoveryRequired = "recovery_required", invalidSchedule = "invalid_schedule"
}
public enum CoworkScheduleOverlap: String, Codable, Sendable { case oneActiveOnePending = "one-active-one-pending" }
public enum CoworkScheduleExecution: String, Codable, Sendable { case unavailable }

private enum ScheduleWire {
    struct Key: CodingKey { var stringValue: String; var intValue: Int? { nil }; init?(intValue: Int) { return nil }; init?(stringValue: String) { self.stringValue = stringValue } }
    static func keys(_ decoder: Decoder, _ required: Set<String>, optional: Set<String> = []) throws {
        let actual = Set(try decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue))
        guard required.isSubset(of: actual), actual.isSubset(of: required.union(optional)) else { throw invalid(decoder, "Invalid schedule fields") }
    }
    static func invalid(_ decoder: Decoder, _ message: String) -> DecodingError { .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: message)) }
    static func id(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$", options: .regularExpression) == (value.startIndex..<value.endIndex) }
    static func revision(_ value: Int) -> Bool { value > 0 && value <= 9_007_199_254_740_991 }
    static let trimCharacters = CharacterSet(charactersIn: "\u{0009}\u{000B}\u{000C}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    static func label(_ value: String) -> Bool { !value.trimmingCharacters(in: trimCharacters).isEmpty && value.utf16.count <= 200 && !value.contains(where: { $0 == "\0" || $0 == "\r" || $0 == "\n" }) }
    static func ceiling(_ value: CoworkCapabilityCeiling) -> Bool {
        ["none", "internet"].contains(value.network) && [value.toolClasses, value.hostServices, value.connectors].allSatisfy { $0.count <= 256 && $0.allSatisfy(label) }
    }
    static func require(_ valid: Bool, _ decoder: Decoder) throws { if !valid { throw invalid(decoder, "Invalid schedule value") } }
}

public enum CoworkScheduleTarget: Codable, Equatable, Sendable {
    case conversation(sessionId: String), project(projectId: String)
    private enum Keys: String, CodingKey { case kind, sessionId, projectId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self), kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "conversation":
            try ScheduleWire.keys(decoder, ["kind", "sessionId"]); let id = try c.decode(String.self, forKey: .sessionId)
            try ScheduleWire.require(ScheduleWire.id(id), decoder); self = .conversation(sessionId: id)
        case "project":
            try ScheduleWire.keys(decoder, ["kind", "projectId"]); let id = try c.decode(String.self, forKey: .projectId)
            try ScheduleWire.require(ScheduleWire.id(id), decoder); self = .project(projectId: id)
        default: throw ScheduleWire.invalid(decoder, "Unknown schedule target")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self { case let .conversation(id): try c.encode("conversation", forKey: .kind); try c.encode(id, forKey: .sessionId)
        case let .project(id): try c.encode("project", forKey: .kind); try c.encode(id, forKey: .projectId) }
    }
}
public enum CoworkScheduleTiming: Codable, Equatable, Sendable {
    case once(at: Double), recurring(spec: String)
    private enum Keys: String, CodingKey { case kind, at, spec }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self), kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "once":
            try ScheduleWire.keys(decoder, ["kind", "at"]); let at = try c.decode(Double.self, forKey: .at)
            try ScheduleWire.require(at.isFinite && at >= 0 && at <= 8_640_000_000_000_000 && at.rounded() == at, decoder); self = .once(at: at)
        case "recurring":
            try ScheduleWire.keys(decoder, ["kind", "spec"]); let spec = try c.decode(String.self, forKey: .spec)
            try ScheduleWire.require(!spec.isEmpty && spec.utf16.count <= 200, decoder); self = .recurring(spec: spec)
        default: throw ScheduleWire.invalid(decoder, "Unknown schedule timing")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self { case let .once(at): try c.encode("once", forKey: .kind); try c.encode(at, forKey: .at)
        case let .recurring(spec): try c.encode("recurring", forKey: .kind); try c.encode(spec, forKey: .spec) }
    }
}
public struct CoworkScheduleDefinition: Codable, Equatable, Sendable {
    public let target: CoworkScheduleTarget, sourceId: String, prompt: String, timing: CoworkScheduleTiming, timezone: String
    public let savedCeiling: CoworkCapabilityCeiling, policy: CoworkApprovalPolicy, overlap: CoworkScheduleOverlap, branchPrecondition: String?
    private enum Keys: String, CodingKey { case target, sourceId, prompt, timing, timezone, savedCeiling, policy, overlap, branchPrecondition }
    public init(target: CoworkScheduleTarget, sourceId: String, prompt: String, timing: CoworkScheduleTiming, timezone: String, savedCeiling: CoworkCapabilityCeiling, policy: CoworkApprovalPolicy, overlap: CoworkScheduleOverlap = .oneActiveOnePending, branchPrecondition: String? = nil) throws {
        self.target = target; self.sourceId = sourceId; self.prompt = prompt; self.timing = timing; self.timezone = timezone
        self.savedCeiling = savedCeiling; self.policy = policy; self.overlap = overlap; self.branchPrecondition = branchPrecondition
        _ = try Self.validated(self)
    }
    public init(from decoder: Decoder) throws {
        try ScheduleWire.keys(decoder, ["target", "sourceId", "prompt", "timing", "timezone", "savedCeiling", "policy", "overlap"], optional: ["branchPrecondition"])
        let c = try decoder.container(keyedBy: Keys.self)
        target = try c.decode(CoworkScheduleTarget.self, forKey: .target); sourceId = try c.decode(String.self, forKey: .sourceId)
        prompt = try c.decode(String.self, forKey: .prompt); timing = try c.decode(CoworkScheduleTiming.self, forKey: .timing); timezone = try c.decode(String.self, forKey: .timezone)
        let ceilingDecoder = try c.superDecoder(forKey: .savedCeiling)
        try ScheduleWire.keys(ceilingDecoder, ["toolClasses", "hostServices", "connectors", "network"])
        savedCeiling = try CoworkCapabilityCeiling(from: ceilingDecoder); policy = try c.decode(CoworkApprovalPolicy.self, forKey: .policy); overlap = try c.decode(CoworkScheduleOverlap.self, forKey: .overlap)
        branchPrecondition = try c.decodeIfPresent(String.self, forKey: .branchPrecondition)
        if c.contains(.branchPrecondition), try c.decodeNil(forKey: .branchPrecondition) { throw ScheduleWire.invalid(decoder, "Branch precondition cannot be null") }
        try ScheduleWire.require(ScheduleWire.id(sourceId) && !prompt.isEmpty && prompt.utf16.count <= 8192 && !prompt.contains("\0") && !timezone.isEmpty && timezone.utf16.count <= 100 && ScheduleWire.ceiling(savedCeiling) && (branchPrecondition.map { !$0.isEmpty && $0.utf16.count <= 200 } ?? true), decoder)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(target, forKey: .target); try c.encode(sourceId, forKey: .sourceId); try c.encode(prompt, forKey: .prompt); try c.encode(timing, forKey: .timing); try c.encode(timezone, forKey: .timezone)
        try c.encode(savedCeiling, forKey: .savedCeiling); try c.encode(policy, forKey: .policy); try c.encode(overlap, forKey: .overlap); try c.encodeIfPresent(branchPrecondition, forKey: .branchPrecondition)
    }
    /// Same closed definition as Core; schema validity is separate from current host authority.
    static func validated(_ value: Self) throws -> Self { try JSONDecoder().decode(Self.self, from: JSONEncoder().encode(value)) }
}
public struct CoworkSchedule: Codable, Equatable, Sendable {
    public let scheduleId: String, workspaceId: String, definition: CoworkScheduleDefinition, state: CoworkScheduleState, revision: Int, nextDue: Double?, createdAt: Double
    private enum Keys: String, CodingKey { case scheduleId, workspaceId, definition, state, revision, nextDue, createdAt }
    public init(from decoder: Decoder) throws {
        try ScheduleWire.keys(decoder, ["scheduleId", "workspaceId", "definition", "state", "revision", "nextDue", "createdAt"])
        let c = try decoder.container(keyedBy: Keys.self)
        scheduleId = try c.decode(String.self, forKey: .scheduleId); workspaceId = try c.decode(String.self, forKey: .workspaceId); definition = try c.decode(CoworkScheduleDefinition.self, forKey: .definition)
        state = try c.decode(CoworkScheduleState.self, forKey: .state); revision = try c.decode(Int.self, forKey: .revision); nextDue = try c.decode(Double?.self, forKey: .nextDue); createdAt = try c.decode(Double.self, forKey: .createdAt)
        try ScheduleWire.require(ScheduleWire.id(scheduleId) && ScheduleWire.id(workspaceId) && ScheduleWire.revision(revision) && createdAt.isFinite && (nextDue?.isFinite ?? true), decoder)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(scheduleId, forKey: .scheduleId); try c.encode(workspaceId, forKey: .workspaceId); try c.encode(definition, forKey: .definition); try c.encode(state, forKey: .state)
        try c.encode(revision, forKey: .revision); try c.encode(nextDue, forKey: .nextDue); try c.encode(createdAt, forKey: .createdAt)
    }
}
public struct CoworkQuarantinedSchedule: Codable, Equatable, Sendable {
    public let scheduleId: String, workspaceId: String, revision: Int, createdAt: Double, cancelled: Bool
    public var reason: CoworkScheduleReason { .invalidSchedule }
    private enum Keys: String, CodingKey { case scheduleId, workspaceId, state, revision, createdAt, nextDue, reason, cancelled }
    public init(from decoder: Decoder) throws {
        try ScheduleWire.keys(decoder, ["scheduleId", "workspaceId", "state", "revision", "createdAt", "nextDue", "reason", "cancelled"])
        let c = try decoder.container(keyedBy: Keys.self)
        scheduleId = try c.decode(String.self, forKey: .scheduleId); workspaceId = try c.decode(String.self, forKey: .workspaceId); revision = try c.decode(Int.self, forKey: .revision)
        createdAt = try c.decode(Double.self, forKey: .createdAt); cancelled = try c.decode(Bool.self, forKey: .cancelled)
        let state = try c.decode(String.self, forKey: .state), noNextDue = try c.decodeNil(forKey: .nextDue), reason = try c.decode(CoworkScheduleReason.self, forKey: .reason)
        try ScheduleWire.require(state == "quarantined" && noNextDue && reason == .invalidSchedule && ScheduleWire.id(scheduleId) && ScheduleWire.id(workspaceId) && ScheduleWire.revision(revision) && createdAt.isFinite, decoder)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(scheduleId, forKey: .scheduleId); try c.encode(workspaceId, forKey: .workspaceId); try c.encode("quarantined", forKey: .state); try c.encode(revision, forKey: .revision)
        try c.encode(createdAt, forKey: .createdAt); try c.encodeNil(forKey: .nextDue); try c.encode(reason, forKey: .reason); try c.encode(cancelled, forKey: .cancelled)
    }
}
public enum CoworkScheduleView: Codable, Equatable, Sendable {
    case schedule(CoworkSchedule), quarantined(CoworkQuarantinedSchedule)
    public var scheduleId: String { switch self { case let .schedule(v): v.scheduleId; case let .quarantined(v): v.scheduleId } }
    public var workspaceId: String { switch self { case let .schedule(v): v.workspaceId; case let .quarantined(v): v.workspaceId } }
    public var revision: Int { switch self { case let .schedule(v): v.revision; case let .quarantined(v): v.revision } }
    public var isCancelled: Bool { switch self { case let .schedule(v): v.state == .cancelled; case let .quarantined(v): v.cancelled } }
    public var canCancel: Bool { switch self { case let .schedule(v): v.state != .cancelled; case let .quarantined(v): !v.cancelled } }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: ScheduleWire.Key.self)
        if try c.decode(String.self, forKey: ScheduleWire.Key(stringValue: "state")!) == "quarantined" { self = .quarantined(try CoworkQuarantinedSchedule(from: decoder)) }
        else { self = .schedule(try CoworkSchedule(from: decoder)) }
    }
    public func encode(to encoder: Encoder) throws { switch self { case let .schedule(v): try v.encode(to: encoder); case let .quarantined(v): try v.encode(to: encoder) } }
}
public struct CoworkScheduleOccurrence: Codable, Equatable, Sendable {
    public let occurrenceId: String, scheduleId: String, dueAt: Double, latestDueAt: Double, missedCount: Int, state: CoworkScheduleOccurrenceState, reason: CoworkScheduleReason?
    private enum Keys: String, CodingKey { case occurrenceId, scheduleId, dueAt, latestDueAt, missedCount, state, reason }
    public init(from decoder: Decoder) throws {
        try ScheduleWire.keys(decoder, ["occurrenceId", "scheduleId", "dueAt", "latestDueAt", "missedCount", "state", "reason"])
        let c = try decoder.container(keyedBy: Keys.self)
        occurrenceId = try c.decode(String.self, forKey: .occurrenceId); scheduleId = try c.decode(String.self, forKey: .scheduleId)
        dueAt = try c.decode(Double.self, forKey: .dueAt); latestDueAt = try c.decode(Double.self, forKey: .latestDueAt); missedCount = try c.decode(Int.self, forKey: .missedCount)
        state = try c.decode(CoworkScheduleOccurrenceState.self, forKey: .state); reason = try c.decode(CoworkScheduleReason?.self, forKey: .reason)
        try ScheduleWire.require(ScheduleWire.id(occurrenceId) && ScheduleWire.id(scheduleId) && dueAt.isFinite && latestDueAt.isFinite && missedCount >= 0 && missedCount <= 9_007_199_254_740_991, decoder)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(occurrenceId, forKey: .occurrenceId); try c.encode(scheduleId, forKey: .scheduleId); try c.encode(dueAt, forKey: .dueAt); try c.encode(latestDueAt, forKey: .latestDueAt)
        try c.encode(missedCount, forKey: .missedCount); try c.encode(state, forKey: .state); try c.encode(reason, forKey: .reason)
    }
}
public struct CoworkSchedulePage: Codable, Equatable, Sendable {
    public let schedules: [CoworkScheduleView], nextCursor: String?
    private enum Keys: String, CodingKey { case schedules, nextCursor }
    public init(from decoder: Decoder) throws {
        try ScheduleWire.keys(decoder, ["schedules", "nextCursor"]); let c = try decoder.container(keyedBy: Keys.self)
        schedules = try c.decode([CoworkScheduleView].self, forKey: .schedules); nextCursor = try c.decode(String?.self, forKey: .nextCursor)
        try ScheduleWire.require(schedules.count <= 100 && (nextCursor.map(ScheduleWire.id) ?? true), decoder)
    }
    public func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: Keys.self); try c.encode(schedules, forKey: .schedules); try c.encode(nextCursor, forKey: .nextCursor) }
}
public struct CoworkScheduleStatus: Codable, Equatable, Sendable {
    public let schedule: CoworkScheduleView, occurrences: [CoworkScheduleOccurrence], execution: CoworkScheduleExecution
    private enum Keys: String, CodingKey { case schedule, occurrences, execution }
    public init(from decoder: Decoder) throws {
        try ScheduleWire.keys(decoder, ["schedule", "occurrences", "execution"]); let c = try decoder.container(keyedBy: Keys.self)
        schedule = try c.decode(CoworkScheduleView.self, forKey: .schedule); occurrences = try c.decode([CoworkScheduleOccurrence].self, forKey: .occurrences); execution = try c.decode(CoworkScheduleExecution.self, forKey: .execution)
        try ScheduleWire.require(occurrences.count <= 100, decoder)
    }
    public func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: Keys.self); try c.encode(schedule, forKey: .schedule); try c.encode(occurrences, forKey: .occurrences); try c.encode(execution, forKey: .execution) }
}

public enum CoworkScheduleRequestError: Error, Sendable { case invalidParameters }

extension CoworkRequest where Result == CoworkSchedulePage {
    public static func schedules(workspaceId: String, cursor: String? = nil, limit: Int = 100) throws -> Self {
        guard ScheduleWire.id(workspaceId), (1...100).contains(limit), cursor.map(ScheduleWire.id) ?? true else { throw CoworkScheduleRequestError.invalidParameters }
        var p: [String: SessionEvent.JSONValue] = ["workspaceId": .string(workspaceId), "limit": .number(Double(limit))]
        if let cursor { p["cursor"] = .string(cursor) }; return Self("workspace.schedule.list", p)
    }
}
extension CoworkRequest where Result == CoworkScheduleStatus {
    public static func scheduleStatus(workspaceId: String, scheduleId: String) throws -> Self {
        guard ScheduleWire.id(workspaceId), ScheduleWire.id(scheduleId) else { throw CoworkScheduleRequestError.invalidParameters }; return Self("workspace.schedule.status", ["workspaceId": .string(workspaceId), "scheduleId": .string(scheduleId)]) }
}
extension CoworkRequest where Result == CoworkScheduleView {
    public static func cancelSchedule(workspaceId: String, scheduleId: String, expectedRevision: Int) throws -> Self {
        guard ScheduleWire.id(workspaceId), ScheduleWire.id(scheduleId), ScheduleWire.revision(expectedRevision) else { throw CoworkScheduleRequestError.invalidParameters }; return Self("workspace.schedule.cancel", ["workspaceId": .string(workspaceId), "scheduleId": .string(scheduleId), "expectedRevision": .number(Double(expectedRevision))]) }
}
extension CoworkRequest where Result == CoworkSchedule {
    /// Caller supplies a stable content-bound request identity and complete saved ceiling.
    /// Neither capability counts nor the current runtime's policy is a substitute.
    public static func createSchedule(workspaceId: String, requestId: String, definition: CoworkScheduleDefinition) throws -> Self {
        guard ScheduleWire.id(workspaceId), ScheduleWire.id(requestId) else { throw CoworkScheduleRequestError.invalidParameters }
        let valid = try CoworkScheduleDefinition.validated(definition)
        let payload = try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONEncoder().encode(valid))
        return Self("workspace.schedule.create", ["workspaceId": .string(workspaceId), "requestId": .string(requestId), "definition": payload])
    }
}
