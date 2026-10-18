import Foundation

// Usage and cost tracking (`docs/claude/usage.md`): `usage.summary`, `usage.series`, `usage.subscriptions.*`,
// `usage.setTracking` — local harness clients only. Costs are USD; a cost's basis says whether it is the runtime's own
// list price, Winter's list-price estimate (a subscription's tokens, another app's usage) or unknown.

public enum UsageRange: String, Sendable, CaseIterable {
    case hour = "1h", day = "24h", week = "7d", month = "30d", all = "all"
}

public enum UsageSource: String, Sendable, CaseIterable, Hashable {
    case winter, codex, claudeCode = "claude-code", opencode
}

/// One plan window (0…100 % used) from a source ladder's answer.
public struct UsagePlanWindow: Sendable, Equatable, Identifiable {
    public let id: String
    /// `five_hour`, `weekly`, `weekly_scoped`, `other`.
    public let kind: String
    public let windowMinutes: Double?
    public let usedPercent: Double
    /// Epoch ms.
    public let resetsAt: Double?
    /// A per-model window's model.
    public let scope: String?
    public let severity: String?
    public let stale: Bool
    /// `older_than_window` or `reset_passed`.
    public let staleReason: String?

    public init(id: String, kind: String, windowMinutes: Double? = nil, usedPercent: Double, resetsAt: Double? = nil,
                scope: String? = nil, severity: String? = nil, stale: Bool = false, staleReason: String? = nil) {
        self.id = id; self.kind = kind; self.windowMinutes = windowMinutes; self.usedPercent = usedPercent
        self.resetsAt = resetsAt; self.scope = scope; self.severity = severity; self.stale = stale; self.staleReason = staleReason
    }
}

/// A status-only window (Winter's own codex-oauth report: no percentage).
public struct UsagePlanStatusWindow: Sendable, Equatable {
    public let rateLimitType: String?
    public let status: String
    public let resetsAt: Double?
    public let at: Double
    public init(rateLimitType: String?, status: String, resetsAt: Double? = nil, at: Double) {
        self.rateLimitType = rateLimitType; self.status = status; self.resetsAt = resetsAt; self.at = at
    }
}

/// A plan reading: which rung of the ladder answered (`codex-app-server`, `codex-rollout`, `winter-codex-oauth`,
/// `claude-cli`, `claude-cache`, `agy-cli`, `none`, `disabled`, `not-installed`), when it was measured, and its windows.
public struct UsagePlanReading: Sendable, Equatable {
    public let provider: String
    public let source: String
    /// Epoch ms.
    public let at: Double?
    public let windows: [UsagePlanWindow]
    public let statusOnly: [UsagePlanStatusWindow]
    public let planType: String?
    public let limitReached: String?

    public init(provider: String, source: String, at: Double? = nil, windows: [UsagePlanWindow] = [],
                statusOnly: [UsagePlanStatusWindow] = [], planType: String? = nil, limitReached: String? = nil) {
        self.provider = provider; self.source = source; self.at = at; self.windows = windows; self.statusOnly = statusOnly
        self.planType = planType; self.limitReached = limitReached
    }
}

/// Summed numbers. Cache reads and writes are their own fields (never inside `input`).
public struct UsageTotals: Sendable, Equatable {
    public let costUsd: Double
    public let input: Double
    public let output: Double
    public let cacheRead: Double
    public let cacheWrite: Double
    public let reasoning: Double
    public let unpricedTokens: Double
    public let cacheSavingsUsd: Double
    public let records: Double
    /// Of `records`, how many are Claude Code `/stats` estimates (days with no transcript left).
    public let syntheticRecords: Double

    public init(costUsd: Double = 0, input: Double = 0, output: Double = 0, cacheRead: Double = 0, cacheWrite: Double = 0,
                reasoning: Double = 0, unpricedTokens: Double = 0, cacheSavingsUsd: Double = 0, records: Double = 0, syntheticRecords: Double = 0) {
        self.costUsd = costUsd; self.input = input; self.output = output; self.cacheRead = cacheRead; self.cacheWrite = cacheWrite
        self.reasoning = reasoning; self.unpricedTokens = unpricedTokens; self.cacheSavingsUsd = cacheSavingsUsd; self.records = records
        self.syntheticRecords = syntheticRecords
    }

    public var tokens: Double { input + output + cacheRead + cacheWrite }
}

public struct UsageModelRow: Sendable, Equatable, Identifiable {
    public var id: String { "\(source.rawValue)|\(provider)|\(model)" }
    public let source: UsageSource
    public let provider: String
    public let model: String
    /// `list`, `estimate`, `reported` (the other app's own figure — OpenCode), `mixed`, `unknown`.
    public let costBasis: String
    public let totals: UsageTotals

    public init(source: UsageSource, provider: String, model: String, costBasis: String, totals: UsageTotals) {
        self.source = source; self.provider = provider; self.model = model; self.costBasis = costBasis; self.totals = totals
    }
}

public struct UsageBucket: Sendable, Equatable {
    public struct Model: Sendable, Equatable {
        public let source: UsageSource
        public let model: String
        public let costUsd: Double
        public let tokens: Double
        public init(source: UsageSource, model: String, costUsd: Double, tokens: Double) {
            self.source = source; self.model = model; self.costUsd = costUsd; self.tokens = tokens
        }
    }
    /// Epoch ms.
    public let start: Double
    public let costUsd: Double
    public let tokens: Double
    public let models: [Model]
    public init(start: Double, costUsd: Double, tokens: Double, models: [Model] = []) {
        self.start = start; self.costUsd = costUsd; self.tokens = tokens; self.models = models
    }
}

public struct UsageSummary: Sendable, Equatable {
    public let range: String
    public let from: Double
    public let to: Double
    public let bucketMs: Double
    public let totals: UsageTotals
    public let bySource: [UsageSource: UsageTotals]
    public let topModels: [UsageModelRow]
    public let spark: [Double]
    public let sparkTokens: [Double]
    public let codexPlan: UsagePlanReading?
    public let claudeCodePlan: UsagePlanReading?
    public let antigravityPlan: UsagePlanReading?
    public let trackCodex: Bool
    public let trackClaudeCode: Bool
    public let trackAntigravity: Bool?
    public let trackOpencode: Bool?
    /// OpenCode is on this Mac (it has no plan slot to say so): its source toggle shows only then. Nil = a daemon that
    /// knows no OpenCode source at all — never send it `opencode` in `sources` (it would refuse the whole request).
    public let opencodeInstalled: Bool?
    /// Epoch ms (noon UTC of that day): Claude Code days before it come from its own `/stats` cache. Nil = none imported.
    public let claudeCodeStatsBefore: Double?

    public init(range: String, from: Double = 0, to: Double = 0, bucketMs: Double = 0, totals: UsageTotals = .init(),
                bySource: [UsageSource: UsageTotals] = [:], topModels: [UsageModelRow] = [], spark: [Double] = [],
                sparkTokens: [Double] = [], codexPlan: UsagePlanReading? = nil, claudeCodePlan: UsagePlanReading? = nil,
                antigravityPlan: UsagePlanReading? = nil, trackCodex: Bool = true, trackClaudeCode: Bool = true,
                trackAntigravity: Bool? = nil, trackOpencode: Bool? = nil, opencodeInstalled: Bool? = nil,
                claudeCodeStatsBefore: Double? = nil) {
        self.range = range; self.from = from; self.to = to; self.bucketMs = bucketMs; self.totals = totals; self.bySource = bySource
        self.topModels = topModels; self.spark = spark; self.sparkTokens = sparkTokens; self.codexPlan = codexPlan
        self.claudeCodePlan = claudeCodePlan; self.antigravityPlan = antigravityPlan; self.trackCodex = trackCodex
        self.trackClaudeCode = trackClaudeCode; self.trackAntigravity = trackAntigravity; self.trackOpencode = trackOpencode
        self.opencodeInstalled = opencodeInstalled; self.claudeCodeStatsBefore = claudeCodeStatsBefore
    }
}

public struct UsageSeries: Sendable, Equatable {
    public let range: String
    public let from: Double
    public let to: Double
    public let bucketMs: Double
    public let buckets: [UsageBucket]
    public let models: [UsageModelRow]
    public let totals: UsageTotals
    public let bySource: [UsageSource: UsageTotals]

    public init(range: String, from: Double = 0, to: Double = 0, bucketMs: Double = 0, buckets: [UsageBucket] = [],
                models: [UsageModelRow] = [], totals: UsageTotals = .init(), bySource: [UsageSource: UsageTotals] = [:]) {
        self.range = range; self.from = from; self.to = to; self.bucketMs = bucketMs; self.buckets = buckets; self.models = models
        self.totals = totals; self.bySource = bySource
    }
}

/// A plan the user entered, with the daemon's cycle math and the cycle's usage at list price.
public struct UsageSubscription: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var provider: String
    public var price: Double
    public var currency: String
    /// `monthly` or `yearly`.
    public var cadence: String
    public var renewalDay: Int
    public var renewalMonth: Int?
    /// `codex`, `claude-code`, `opencode`, `winter`, `winter:<provider>`.
    public var covers: [String]
    /// Epoch ms (daemon-computed; nil on a draft).
    public var nextRenewal: Double?
    public var cycleStart: Double?
    public var monthlyCost: Double?
    public var usageThisCycleUsd: Double?

    public init(id: String = "", name: String, provider: String, price: Double, currency: String = "USD", cadence: String = "monthly",
                renewalDay: Int = 1, renewalMonth: Int? = nil, covers: [String] = [], nextRenewal: Double? = nil,
                cycleStart: Double? = nil, monthlyCost: Double? = nil, usageThisCycleUsd: Double? = nil) {
        self.id = id; self.name = name; self.provider = provider; self.price = price; self.currency = currency; self.cadence = cadence
        self.renewalDay = renewalDay; self.renewalMonth = renewalMonth; self.covers = covers; self.nextRenewal = nextRenewal
        self.cycleStart = cycleStart; self.monthlyCost = monthlyCost; self.usageThisCycleUsd = usageThisCycleUsd
    }
}

extension WinterClient {
    public func usageSummary(range: UsageRange, sources: Set<UsageSource>? = nil, plans: Bool = true) async throws -> UsageSummary {
        var p: [String: JSONValue] = ["range": .string(range.rawValue), "plans": .bool(plans)]
        if let sources { p["sources"] = .array(sources.map { .string($0.rawValue) }.sorted { ($0.stringValue ?? "") < ($1.stringValue ?? "") }) }
        return Self.decodeUsageSummary(try await request("usage.summary", params: .object(p)))
    }

    public func usageSeries(range: UsageRange, sources: Set<UsageSource>? = nil) async throws -> UsageSeries {
        var p: [String: JSONValue] = ["range": .string(range.rawValue)]
        if let sources { p["sources"] = .array(sources.map { .string($0.rawValue) }.sorted { ($0.stringValue ?? "") < ($1.stringValue ?? "") }) }
        return Self.decodeUsageSeries(try await request("usage.series", params: .object(p)))
    }

    public func usageSubscriptions() async throws -> [UsageSubscription] {
        Self.decodeUsageSubscriptions(try await request("usage.subscriptions.list", params: .object([:]))["subscriptions"])
    }

    /// Creates (empty `id`) or updates a plan; answers the whole list.
    public func usageSetSubscription(_ s: UsageSubscription) async throws -> [UsageSubscription] {
        var o: [String: JSONValue] = [
            "name": .string(s.name), "provider": .string(s.provider), "price": .number(s.price), "currency": .string(s.currency),
            "cadence": .string(s.cadence), "renewalDay": .number(Double(s.renewalDay)), "covers": .array(s.covers.map { .string($0) }),
        ]
        if !s.id.isEmpty { o["id"] = .string(s.id) }
        if let m = s.renewalMonth, s.cadence == "yearly" { o["renewalMonth"] = .number(Double(m)) }
        let r = try await request("usage.subscriptions.set", params: .object(["subscription": .object(o)]))
        return Self.decodeUsageSubscriptions(r["subscriptions"])
    }

    public func usageRemoveSubscription(id: String) async throws -> [UsageSubscription] {
        Self.decodeUsageSubscriptions(try await request("usage.subscriptions.remove", params: .object(["id": .string(id)]))["subscriptions"])
    }

    /// Writes `settings.usage` (live — no restart).
    public func usageSetTracking(codex: Bool? = nil, claudeCode: Bool? = nil, antigravity: Bool? = nil, opencode: Bool? = nil) async throws {
        var p: [String: JSONValue] = [:]
        if let codex { p["codex"] = .bool(codex) }
        if let claudeCode { p["claudeCode"] = .bool(claudeCode) }
        if let antigravity { p["antigravity"] = .bool(antigravity) }
        if let opencode { p["opencode"] = .bool(opencode) }
        _ = try await request("usage.setTracking", params: .object(p))
    }

    // MARK: - PURE decoders

    private static func num(_ v: JSONValue?) -> Double? { if case .number(let n)? = v { return n }; return nil }

    public static func decodeUsageTotals(_ v: JSONValue?) -> UsageTotals {
        UsageTotals(costUsd: num(v?["costUsd"]) ?? 0, input: num(v?["input"]) ?? 0, output: num(v?["output"]) ?? 0,
                    cacheRead: num(v?["cacheRead"]) ?? 0, cacheWrite: num(v?["cacheWrite"]) ?? 0, reasoning: num(v?["reasoning"]) ?? 0,
                    unpricedTokens: num(v?["unpricedTokens"]) ?? 0, cacheSavingsUsd: num(v?["cacheSavingsUsd"]) ?? 0,
                    records: num(v?["records"]) ?? 0, syntheticRecords: num(v?["syntheticRecords"]) ?? 0)
    }

    static func decodeModelRows(_ v: JSONValue?) -> [UsageModelRow] {
        (v?.arrayValue ?? []).compactMap { r in
            guard let source = r["source"]?.stringValue.flatMap(UsageSource.init(rawValue:)), let model = r["model"]?.stringValue else { return nil }
            return UsageModelRow(source: source, provider: r["provider"]?.stringValue ?? "", model: model,
                                 costBasis: r["costBasis"]?.stringValue ?? "unknown", totals: decodeUsageTotals(r))
        }
    }

    static func decodeBySource(_ v: JSONValue?) -> [UsageSource: UsageTotals] {
        var out: [UsageSource: UsageTotals] = [:]
        for r in v?.arrayValue ?? [] {
            guard let s = r["source"]?.stringValue.flatMap(UsageSource.init(rawValue:)) else { continue }
            out[s] = decodeUsageTotals(r)
        }
        return out
    }

    public static func decodePlan(_ v: JSONValue?) -> UsagePlanReading? {
        guard let v, let provider = v["provider"]?.stringValue, let source = v["source"]?.stringValue else { return nil }
        let windows = (v["windows"]?.arrayValue ?? []).compactMap { w -> UsagePlanWindow? in
            guard let id = w["id"]?.stringValue, let pct = num(w["usedPercent"]) else { return nil }
            return UsagePlanWindow(id: id, kind: w["kind"]?.stringValue ?? "other", windowMinutes: num(w["windowMinutes"]), usedPercent: pct,
                                   resetsAt: num(w["resetsAt"]), scope: w["scope"]?.stringValue, severity: w["severity"]?.stringValue,
                                   stale: w["stale"]?.boolValue ?? false, staleReason: w["staleReason"]?.stringValue)
        }
        let status = (v["statusOnly"]?.arrayValue ?? []).compactMap { w -> UsagePlanStatusWindow? in
            guard let s = w["status"]?.stringValue else { return nil }
            return UsagePlanStatusWindow(rateLimitType: w["rateLimitType"]?.stringValue, status: s, resetsAt: num(w["resetsAt"]), at: num(w["at"]) ?? 0)
        }
        return UsagePlanReading(provider: provider, source: source, at: num(v["at"]), windows: windows, statusOnly: status,
                                planType: v["planType"]?.stringValue, limitReached: v["limitReached"]?.stringValue)
    }

    public static func decodeUsageSummary(_ r: JSONValue) -> UsageSummary {
        UsageSummary(range: r["range"]?.stringValue ?? "", from: num(r["from"]) ?? 0, to: num(r["to"]) ?? 0, bucketMs: num(r["bucketMs"]) ?? 0,
                     totals: decodeUsageTotals(r["totals"]), bySource: decodeBySource(r["bySource"]), topModels: decodeModelRows(r["topModels"]),
                     spark: (r["spark"]?.arrayValue ?? []).map { num($0) ?? 0 }, sparkTokens: (r["sparkTokens"]?.arrayValue ?? []).map { num($0) ?? 0 },
                     codexPlan: decodePlan(r["plans"]?["codex"]), claudeCodePlan: decodePlan(r["plans"]?["claudeCode"]),
                     antigravityPlan: decodePlan(r["plans"]?["antigravity"]),
                     trackCodex: r["tracking"]?["codex"]?.boolValue ?? true, trackClaudeCode: r["tracking"]?["claudeCode"]?.boolValue ?? true,
                     trackAntigravity: r["tracking"]?["antigravity"]?.boolValue,
                     trackOpencode: r["tracking"]?["opencode"]?.boolValue,
                     opencodeInstalled: r["installed"]?["opencode"]?.boolValue,
                     claudeCodeStatsBefore: num(r["history"]?["claudeCodeStats"]?["before"]))
    }

    public static func decodeUsageSeries(_ r: JSONValue) -> UsageSeries {
        let buckets = (r["buckets"]?.arrayValue ?? []).map { b in
            UsageBucket(start: num(b["start"]) ?? 0, costUsd: num(b["costUsd"]) ?? 0, tokens: num(b["tokens"]) ?? 0,
                        models: (b["models"]?.arrayValue ?? []).compactMap { m in
                            guard let s = m["source"]?.stringValue.flatMap(UsageSource.init(rawValue:)), let model = m["model"]?.stringValue else { return nil }
                            return .init(source: s, model: model, costUsd: num(m["costUsd"]) ?? 0, tokens: num(m["tokens"]) ?? 0)
                        })
        }
        return UsageSeries(range: r["range"]?.stringValue ?? "", from: num(r["from"]) ?? 0, to: num(r["to"]) ?? 0, bucketMs: num(r["bucketMs"]) ?? 0,
                           buckets: buckets, models: decodeModelRows(r["models"]), totals: decodeUsageTotals(r["totals"]),
                           bySource: decodeBySource(r["bySource"]))
    }

    public static func decodeUsageSubscriptions(_ v: JSONValue?) -> [UsageSubscription] {
        (v?.arrayValue ?? []).compactMap { s in
            guard let id = s["id"]?.stringValue, let name = s["name"]?.stringValue else { return nil }
            return UsageSubscription(id: id, name: name, provider: s["provider"]?.stringValue ?? "", price: num(s["price"]) ?? 0,
                                     currency: s["currency"]?.stringValue ?? "USD", cadence: s["cadence"]?.stringValue ?? "monthly",
                                     renewalDay: Int(num(s["renewalDay"]) ?? 1), renewalMonth: num(s["renewalMonth"]).map { Int($0) },
                                     covers: (s["covers"]?.arrayValue ?? []).compactMap(\.stringValue), nextRenewal: num(s["nextRenewal"]),
                                     cycleStart: num(s["cycleStart"]), monthlyCost: num(s["monthlyCost"]), usageThisCycleUsd: num(s["usageThisCycleUsd"]))
        }
    }
}
