import XCTest
@testable import WinterKit

/// The Winter island's activity (phase 2): `island.activity`'s decoding — computer use, turn results, watches — with a
/// malformed row skipped rather than failing the whole answer.
final class IslandActivityClientTests: XCTestCase {
    func testTheActivityDecodesEveryKindAndSkipsMalformedRows() throws {
        let json = #"""
        {"computerUse":[{"sessionId":"s1","startedAt":10,"lastAt":20,"running":true,"title":"Filing","apps":["Notes"],
                         "session":{"mode":"code","title":"Ship it"},"hosts":[{"clientName":"tui","role":"harness","tty":"/dev/ttys004"}]},
                        {"startedAt":1}],
         "results":[{"id":"s1:9","sessionId":"s1","summary":"Done.","at":30,"session":{},"hosts":[]},{"id":"x"}],
         "watches":[{"sessionId":"s2","wakeId":"wk_1","condition":"clicked","targetLabel":"Chrome — Dashboard",
                     "elementLabel":"“Submit”","armedAt":5,"expiresAt":99,"session":{"mode":"dispatch"}}]}
        """#
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        let snapshot = WinterClient.decodeIslandActivity(value)
        XCTAssertEqual(snapshot.computerUse, [IslandComputerUseItem(
            sessionId: "s1", startedAt: 10, lastAt: 20, running: true, title: "Filing", apps: ["Notes"],
            session: IslandSessionFacts(mode: "code", title: "Ship it"),
            hosts: [IslandHost(clientName: "tui", role: "harness", tty: "/dev/ttys004")])])
        XCTAssertEqual(snapshot.results, [IslandResultItem(id: "s1:9", sessionId: "s1", summary: "Done.", at: 30)])
        XCTAssertEqual(snapshot.watches, [IslandWatchItem(sessionId: "s2", wakeId: "wk_1", condition: "clicked",
                                                          targetLabel: "Chrome — Dashboard", elementLabel: "“Submit”",
                                                          armedAt: 5, expiresAt: 99, session: IslandSessionFacts(mode: "dispatch"))])
        XCTAssertEqual(snapshot.usageAlarms, [], "an older daemon sends no alarms")
        XCTAssertEqual(WinterClient.decodeIslandActivity(.object([:])), .empty, "an older daemon's empty answer")
    }

    func testAFiredPlanAlarmDecodesAndAMalformedOneIsSkipped() throws {
        let json = #"""
        {"computerUse":[],"results":[],"watches":[],
         "usageAlarms":[{"id":"al-1","provider":"claude-code","windowKey":"weekly","kind":"weekly","windowMinutes":10080,
                         "thresholdPercent":80,"usedPercent":81.5,"resetsAt":1760900000000,"at":1760800000000},
                        {"id":"al-2","provider":"antigravity","windowKey":"weekly:claude & gpt","kind":"weekly","scope":"Claude & GPT",
                         "thresholdPercent":50,"usedPercent":50,"at":5},
                        {"id":"al-3","provider":"codex","kind":"five_hour","thresholdPercent":50,"usedPercent":51,"at":5}]}
        """#
        let snapshot = WinterClient.decodeIslandActivity(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))
        XCTAssertEqual(snapshot.usageAlarms, [
            IslandUsageAlarmItem(id: "al-1", provider: "claude-code", windowKey: "weekly", kind: "weekly", windowMinutes: 10080,
                                 thresholdPercent: 80, usedPercent: 81.5, resetsAt: 1_760_900_000_000, at: 1_760_800_000_000),
            IslandUsageAlarmItem(id: "al-2", provider: "antigravity", windowKey: "weekly:claude & gpt", kind: "weekly", scope: "Claude & GPT",
                                 thresholdPercent: 50, usedPercent: 50, at: 5),
        ], "the one with no window key is skipped")
        XCTAssertEqual(WinterClient.islandActivityChangedNotification, "island.activityChanged")
    }
}
