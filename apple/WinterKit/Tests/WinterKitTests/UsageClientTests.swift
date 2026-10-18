import XCTest
@testable import WinterKit

/// Usage and cost tracking's client half (`docs/claude/usage.md`): the `usage.*` answers decoded exactly.
final class UsageClientTests: XCTestCase {
    private func json(_ s: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

    func testTheSummaryDecodesTotalsSourcesModelsSparkAndBothPlans() throws {
        let s = WinterClient.decodeUsageSummary(try json(#"""
        {"range":"24h","from":1,"to":2,"bucketMs":3600000,
         "totals":{"costUsd":1.5,"input":10,"output":20,"cacheRead":300,"cacheWrite":4,"reasoning":5,"unpricedTokens":6,"cacheSavingsUsd":0.25,"records":7},
         "bySource":[{"source":"codex","costUsd":1,"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"reasoning":0,"unpricedTokens":0,"cacheSavingsUsd":0,"records":1},
                     {"source":"bogus","costUsd":9}],
         "topModels":[{"source":"claude-code","provider":"anthropic","model":"claude-sonnet-4-5","costBasis":"estimate","costUsd":0.5,"input":1,"output":2,"cacheRead":3,"cacheWrite":4,"reasoning":0,"unpricedTokens":0,"cacheSavingsUsd":0,"records":1}],
         "spark":[0,0.5,1],"sparkTokens":[0,10,20],
         "plans":{"codex":{"provider":"codex","source":"codex-app-server","at":1000,"planType":"pro",
                           "windows":[{"id":"primary","kind":"five_hour","windowMinutes":300,"usedPercent":12,"resetsAt":5000,"stale":false},
                                      {"id":"secondary","kind":"weekly","windowMinutes":10080,"usedPercent":40,"stale":true,"staleReason":"reset_passed"}]},
                  "claudeCode":{"provider":"claude-code","source":"none","windows":[]}},
         "tracking":{"codex":true,"claudeCode":false},"ingest":{"running":false}}
        """#))
        XCTAssertEqual(s.totals, UsageTotals(costUsd: 1.5, input: 10, output: 20, cacheRead: 300, cacheWrite: 4, reasoning: 5,
                                             unpricedTokens: 6, cacheSavingsUsd: 0.25, records: 7))
        XCTAssertEqual(s.totals.tokens, 334)
        XCTAssertEqual(Array(s.bySource.keys), [.codex], "an unknown source is dropped, never guessed")
        XCTAssertEqual(s.topModels.first?.source, .claudeCode)
        XCTAssertEqual(s.topModels.first?.totals.cacheRead, 3)
        XCTAssertEqual(s.spark, [0, 0.5, 1])
        XCTAssertEqual(s.codexPlan?.source, "codex-app-server")
        XCTAssertEqual(s.codexPlan?.planType, "pro")
        XCTAssertEqual(s.codexPlan?.windows.map(\.usedPercent), [12, 40])
        XCTAssertEqual(s.codexPlan?.windows.last?.staleReason, "reset_passed")
        XCTAssertEqual(s.claudeCodePlan?.source, "none")
        XCTAssertTrue(s.trackCodex)
        XCTAssertFalse(s.trackClaudeCode)
    }

    func testTheAntigravityPlanOpenCodeAndTheirSwitchesDecode() throws {
        let s = WinterClient.decodeUsageSummary(try json(#"""
        {"range":"24h","totals":{},
         "bySource":[{"source":"opencode","costUsd":0.37,"records":2}],
         "topModels":[{"source":"opencode","provider":"nvidia","model":"nvidia/deepseek-ai/deepseek-v4-pro","costBasis":"reported","costUsd":0.37,"records":1}],
         "plans":{"antigravity":{"provider":"antigravity","source":"agy-cli","at":1000,
                                 "windows":[{"id":"gemini-5h","kind":"five_hour","windowMinutes":300,"usedPercent":27,"resetsAt":5000,"scope":"Gemini","stale":false}]}},
         "tracking":{"codex":true,"claudeCode":true,"antigravity":false,"opencode":false},"installed":{"opencode":false}}
        """#))
        XCTAssertEqual(s.antigravityPlan?.source, "agy-cli")
        XCTAssertEqual(s.antigravityPlan?.windows.first?.scope, "Gemini")
        XCTAssertEqual(s.antigravityPlan?.windows.first?.usedPercent, 27)
        XCTAssertFalse(s.trackAntigravity)
        XCTAssertFalse(s.trackOpencode)
        XCTAssertEqual(s.opencodeInstalled, false)
        XCTAssertEqual(s.bySource[.opencode]?.costUsd, 0.37)
        XCTAssertEqual(s.topModels.first?.source, .opencode)
        XCTAssertEqual(s.topModels.first?.costBasis, "reported")
        // An older daemon sends none of them: on, no plan, and no OpenCode source at all (nil, not "installed").
        let old = WinterClient.decodeUsageSummary(try json(#"{"range":"24h","tracking":{"codex":true,"claudeCode":true}}"#))
        XCTAssertNil(old.antigravityPlan)
        XCTAssertTrue(old.trackAntigravity && old.trackOpencode)
        XCTAssertNil(old.opencodeInstalled)
    }

    func testClaudeCodeStatsHistoryDecodes() throws {
        let s = WinterClient.decodeUsageSummary(try json(#"""
        {"range":"all","totals":{"records":3,"syntheticRecords":2},"history":{"claudeCodeStats":{"from":100,"before":200}},
         "topModels":[{"source":"claude-code","provider":"anthropic","model":"m","costBasis":"estimate","records":3,"syntheticRecords":2}]}
        """#))
        XCTAssertEqual(s.claudeCodeStatsBefore, 200)
        XCTAssertEqual(s.totals.syntheticRecords, 2)
        XCTAssertEqual(s.topModels.first?.totals.syntheticRecords, 2)
        // An older daemon sends neither: nothing imported.
        let old = WinterClient.decodeUsageSummary(try json(#"{"range":"all","totals":{"records":3}}"#))
        XCTAssertNil(old.claudeCodeStatsBefore)
        XCTAssertEqual(old.totals.syntheticRecords, 0)
    }

    func testTheSeriesAndTheSubscriptionsDecode() throws {
        let series = WinterClient.decodeUsageSeries(try json(#"""
        {"range":"7d","from":0,"to":10,"bucketMs":5,"buckets":[{"start":0,"costUsd":1,"tokens":10,"bySource":{},"models":[{"source":"winter","model":"m","costUsd":1,"tokens":10}]},{"start":5,"costUsd":0,"tokens":0,"models":[]}],
         "models":[],"totals":{"costUsd":1},"bySource":[]}
        """#))
        XCTAssertEqual(series.buckets.count, 2)
        XCTAssertEqual(series.buckets[0].models, [.init(source: .winter, model: "m", costUsd: 1, tokens: 10)])
        let subs = WinterClient.decodeUsageSubscriptions(try json(#"""
        [{"id":"a","name":"ChatGPT Pro","provider":"openai","price":200,"currency":"USD","cadence":"monthly","renewalDay":3,"covers":["codex","winter:codex-oauth"],
          "nextRenewal":100,"cycleStart":50,"monthlyCost":200,"usageThisCycleUsd":412.5,"createdAt":1,"updatedAt":2}]
        """#))
        XCTAssertEqual(subs, [UsageSubscription(id: "a", name: "ChatGPT Pro", provider: "openai", price: 200, currency: "USD", cadence: "monthly",
                                                renewalDay: 3, covers: ["codex", "winter:codex-oauth"], nextRenewal: 100, cycleStart: 50,
                                                monthlyCost: 200, usageThisCycleUsd: 412.5)])
    }
}
