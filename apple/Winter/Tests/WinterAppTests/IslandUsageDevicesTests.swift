import XCTest
import WinterKit
@testable import Winter

/// The island's Usage and limits and Devices tabs: what each shows, from exactly the data the daemon and the app hold.
@MainActor
final class IslandUsageTabTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func ms(_ offset: TimeInterval) -> Double { (now.timeIntervalSince1970 + offset) * 1000 }

    func testWindowsBecomeGaugesWithAFillAStatusAndARelativeReset() {
        let snapshot = IslandUsageSnapshot(
            windows: [IslandUsageWindow(rateLimitType: "seven_day", status: "allowed", utilization: 0.31,
                                        resetsAt: ms(3 * 86400 + 4 * 3600), at: ms(-120), sessionId: "s"),
                      IslandUsageWindow(rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.82,
                                        resetsAt: ms(2 * 3600 + 14 * 60), at: ms(-120), sessionId: "s"),
                      IslandUsageWindow(rateLimitType: "overage", status: "rejected", at: ms(-30), sessionId: "s")],
            background: .init(limited: false, inputTokens: 0, outputTokens: 0))
        let gauges = IslandUsagePresentation.gauges(snapshot, now: now)
        XCTAssertEqual(gauges.map(\.title), ["Extra usage", "5-hour window", "Weekly window"],
                       "a refused window first, then the fullest")
        XCTAssertEqual(gauges[1].fraction ?? -1, 0.82, accuracy: 0.0001)
        XCTAssertEqual(gauges[1].status, "Nearing the limit")
        XCTAssertEqual(gauges[1].resets, "resets in 2 h 14 min")
        XCTAssertEqual(gauges[2].resets, "resets in 3 d 4 h")
        XCTAssertNil(gauges[0].fraction, "no utilization reported: no ring is invented")
        XCTAssertTrue(gauges[0].refused)
        XCTAssertEqual(gauges[0].status, "Limit reached")
        XCTAssertEqual(gauges[0].reported, "reported just now")
    }

    func testUtilizationIsAFractionAndAnythingElseShowsNoFill() {
        // `SDKRateLimitInfo.utilization` is a fraction 0…1; the pinned runtime's own report carries none at all.
        XCTAssertEqual(IslandUsagePresentation.fraction(0.82), 0.82)
        XCTAssertEqual(IslandUsagePresentation.fraction(1), 1)
        XCTAssertEqual(IslandUsagePresentation.fraction(0), 0)
        XCTAssertNil(IslandUsagePresentation.fraction(82), "not the unit: no guessed ring")
        XCTAssertNil(IslandUsagePresentation.fraction(-0.1))
        XCTAssertNil(IslandUsagePresentation.fraction(nil))
        // Exactly the runtime's report: status + reset, no fill.
        let report = IslandUsageSnapshot(windows: [IslandUsageWindow(rateLimitType: nil, status: "rejected", resetsAt: ms(600),
                                                                     at: ms(0), sessionId: "s")],
                                         background: .init(limited: false, inputTokens: 0, outputTokens: 0))
        let g = IslandUsagePresentation.gauges(report, now: now)
        XCTAssertEqual(g.map(\.title), ["Plan window"])
        XCTAssertNil(g[0].fraction)
        XCTAssertEqual(g[0].resets, "resets in 10 min")
    }

    func testTheBackgroundJobsSubscriptionIsShownOnlyWhenNoRuntimeWindowOfItsKindIs() {
        let sub = IslandUsageSnapshot.Subscription(status: "allowed", rateLimitType: "five_hour", utilization: 0.4, at: ms(-60))
        let both = IslandUsageSnapshot(windows: [IslandUsageWindow(rateLimitType: "five_hour", status: "allowed", at: ms(0), sessionId: "s")],
                                       subscription: sub, background: .init(limited: false, inputTokens: 0, outputTokens: 0))
        XCTAssertEqual(IslandUsagePresentation.gauges(both, now: now).count, 1)
        let alone = IslandUsageSnapshot(windows: [], subscription: sub, background: .init(limited: false, inputTokens: 0, outputTokens: 0))
        XCTAssertEqual(IslandUsagePresentation.gauges(alone, now: now).map(\.title), ["5-hour window · background jobs"])
    }

    func testTheSessionShowsAContextRingOnlyWhenBothSidesAreKnown() {
        let full = IslandUsagePresentation.context(.init(sessionId: "s", turns: 4, inputTokens: 1_200, outputTokens: 300,
                                                         contextTokens: 64_000, contextWindow: 200_000, model: "m/x"), title: "Ship it")
        XCTAssertEqual(full?.fraction ?? -1, 0.32, accuracy: 0.0001)
        XCTAssertEqual(full?.contextLine, "64k of 200k context")
        XCTAssertEqual(full?.tokensLine, "1.2k in · 300 out · 4 turns since Winter started")
        XCTAssertEqual(full?.title, "Ship it")
        let noWindow = IslandUsagePresentation.context(.init(sessionId: "s", turns: 1, inputTokens: 5, outputTokens: 1,
                                                             contextTokens: 9_000), title: nil)
        XCTAssertNil(noWindow?.fraction)
        XCTAssertEqual(noWindow?.contextLine, "9.0k context")
        XCTAssertEqual(noWindow?.title, "This session")
        let nothing = IslandUsagePresentation.context(.init(sessionId: "s", turns: 0, inputTokens: 0, outputTokens: 0), title: nil)
        XCTAssertNil(nothing?.contextLine)
        XCTAssertEqual(nothing?.tokensLine, "No turns since Winter started")
        XCTAssertNil(IslandUsagePresentation.context(nil, title: nil))
    }

    func testTheBackgroundJobsLineAndTheRoleNotes() {
        let limited = IslandUsagePresentation.background(.init(limited: true, resumeAt: ms(300), inputTokens: 2_500_000, outputTokens: 10),
                                                         now: now)
        XCTAssertEqual(limited.line, "Backed off — resumes in 5 min")
        XCTAssertEqual(limited.tokensLine, "2.5M in · 10 out since Winter started")
        XCTAssertEqual(IslandUsagePresentation.background(.init(limited: false, inputTokens: 0, outputTokens: 0), now: now).line,
                       "Running normally")
        let roles = ["titles.model": ModelRoleValue(model: "p/m", explicit: false, constraint: "any", permitted: [],
                                                    problem: ModelRoleProblem(reason: "out-of-credits", model: "p/m")),
                     "pins.dream": ModelRoleValue(model: "p/n", explicit: false, constraint: "any", permitted: [])]
        let notes = IslandUsagePresentation.notes(roles, now: now)
        XCTAssertEqual(notes.count, 1, "a role with no problem says nothing")
        XCTAssertEqual(notes.first?.model, "p/m")
        XCTAssertEqual(notes.first?.role, settingsModelRoleTitle(.titles))
    }

    func testTheModelAsksForTheSessionInFrontAndKeepsTheLastSnapshotOnAFailure() async {
        let model = IslandUsageModel()
        var asked: [String?] = []
        model.currentSession = { ("s9", "Front session") }
        model.fetch = { sid in
            asked.append(sid)
            return IslandUsageSnapshot(windows: [], background: .init(limited: false, inputTokens: 1, outputTokens: 2))
        }
        await model.refresh()
        XCTAssertEqual(asked, ["s9"])
        XCTAssertEqual(model.sessionTitle, "Front session")
        XCTAssertEqual(model.snapshot?.background.inputTokens, 1)
        model.fetch = { _ in throw URLError(.timedOut) }
        await model.refresh()
        XCTAssertEqual(model.snapshot?.background.inputTokens, 1)
        XCTAssertFalse(model.failed)
    }

    func testRelativeTimesAndCounts() {
        XCTAssertEqual(islandRelativeFuture(now.addingTimeInterval(10), now: now), "now")
        XCTAssertEqual(islandRelativeFuture(now.addingTimeInterval(45 * 60), now: now), "in 45 min")
        XCTAssertEqual(islandRelativeFuture(now.addingTimeInterval(3600), now: now), "in 1 h")
        XCTAssertEqual(islandRelativePast(now.addingTimeInterval(-7200), now: now), "2 h ago")
        XCTAssertEqual(islandCompactCount(999), "999")
        XCTAssertEqual(islandCompactCount(64_000), "64k")
    }
}

@MainActor
final class IslandDevicesTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func record(_ id: String, _ label: String, daysAgo: Double) -> PairRecord {
        PairRecord(phoneEndpointID: id, label: label, createdAt: Int(now.timeIntervalSince1970 - daysAgo * 86400), caps: [],
                   pairingEpoch: 1, lastSeenAt: 0)
    }

    func testPhonesAreConnectedFirstSayWhenTheyWerePairedAndTheMirrorHasItsOwnRow() {
        let rows = IslandDevicesPresentation.phones([record("a", "Old phone", daysAgo: 30), record("b", "  ", daysAgo: 2)],
                                                   connected: ["a"], mirrored: ["s1"], titleFor: { _ in "Fix the build" }, now: now)
        XCTAssertEqual(rows.map(\.title), ["Old phone", "iPhone", "Phone mirror"])
        XCTAssertEqual(rows.map(\.status), ["Connected", "Not connected", "Watching"])
        XCTAssertEqual(rows[0].detail, "Paired 30 d ago")
        XCTAssertEqual(rows[0].tone, .ok)
        XCTAssertEqual(rows[1].detail, "Paired 2 d ago", "never a 'last seen' the store does not keep")
        XCTAssertEqual(rows[1].tone, .off)
        XCTAssertEqual(rows[2].detail, "Fix the build")
        XCTAssertEqual(IslandDevicesPresentation.accessibilityLabel(rows[0]), "Old phone, Connected, Paired 30 d ago")
        XCTAssertTrue(IslandDevicesPresentation.phones([], connected: [], mirrored: [], titleFor: { _ in nil }, now: now).isEmpty)
    }

    func testTheHelperRowCarriesItsPermissionsAndEachBrowserItsConnection() {
        let status = ComputerUseStatus(enabled: true, legacyComputer: false, mirror: false, privateEventPath: false,
                                       helper: ComputerUseHelperStatus(installed: true, running: true, version: "2.0",
                                                                       permissions: ComputerUsePermissions(accessibility: true, screenRecording: false)),
                                       browsers: [ComputerUseBrowserStatus(id: "winter", name: "Winter", connected: true),
                                                  ComputerUseBrowserStatus(id: "chrome", name: "Google Chrome", connected: false,
                                                                           reason: "Winter for Chrome is not installed in Google Chrome"),
                                                  ComputerUseBrowserStatus(id: "headless", name: "Winter (headless)", connected: false)])
        let rows = IslandDevicesPresentation.helpers(status)
        XCTAssertEqual(rows.map(\.title), ["Computer Use helper", "Winter", "Winter for Chrome · Google Chrome", "Winter (headless)"])
        XCTAssertEqual(rows[0].status, "Running · 2.0")
        XCTAssertEqual(rows[0].detail, "", "running: its status says it all")
        XCTAssertEqual(rows[0].tone, .warning, "a missing permission is worth a look")
        XCTAssertEqual(rows[0].chips, [IslandDeviceChip(label: "Accessibility", state: .granted),
                                       IslandDeviceChip(label: "Screen Recording", state: .denied)])
        XCTAssertEqual(rows.dropFirst().map(\.status), ["Connected", "Not connected", "Not connected"])
        XCTAssertEqual(rows[1].detail, "")
        XCTAssertEqual(rows[2].detail, "Winter for Chrome is not installed in Google Chrome", "the daemon's own reason")
        XCTAssertEqual(rows[3].detail, "")
    }

    func testAHelperNotRunningHasUnknownPermissionsAndComputerUseOffSaysSo() {
        let idle = ComputerUseStatus(enabled: true, legacyComputer: false, mirror: false, privateEventPath: false,
                                     helper: ComputerUseHelperStatus(installed: true, running: false))
        let row = IslandDevicesPresentation.helpers(idle)[0]
        XCTAssertEqual(row.chips.map(\.state), [.unknown, .unknown], "not running is not denied")
        XCTAssertEqual(row.tone, .off)
        XCTAssertEqual(row.status, "Not running")
        XCTAssertEqual(row.detail, "Installed — starts when a session needs it", "Settings' own words under the pointer")
        let off = ComputerUseStatus(enabled: false, legacyComputer: false, mirror: false, privateEventPath: false,
                                    helper: ComputerUseHelperStatus(installed: true, running: false))
        XCTAssertEqual(IslandDevicesPresentation.helpers(off)[0].status, "Off")
        XCTAssertEqual(IslandDevicesPresentation.helpers(off)[0].detail, "Computer use is off")
        let missing = ComputerUseStatus(enabled: true, legacyComputer: false, mirror: false, privateEventPath: false,
                                        helper: ComputerUseHelperStatus(installed: false, running: false))
        XCTAssertEqual(IslandDevicesPresentation.helpers(missing)[0].status, "Not installed")
        XCTAssertEqual(IslandDevicesPresentation.helpers(missing)[0].detail, "", "nothing the status does not say")
        let unread = IslandDevicesPresentation.helpers(nil)[0]
        XCTAssertEqual(unread.detail, "Couldn't read its status")
        XCTAssertTrue(IslandDevicesPresentation.showsDetail(unread, hovered: false), "a problem is shown at rest")
    }

    func testTheModelGathersPhonesConnectionsMirrorAndStatus() async {
        let model = IslandDevicesModel()
        model.now = { [now] in now }
        model.fetchPhones = { [self] in [record("a", "Phone", daysAgo: 1)] }
        model.connectedPhones = { ["a"] }
        model.mirrored = { [] }
        model.fetchStatus = { nil }
        await model.refresh()
        XCTAssertTrue(model.loaded)
        XCTAssertEqual(model.phones.map(\.status), ["Connected"])
        XCTAssertEqual(model.phones.map(\.detail), ["Paired 1 d ago"])
        XCTAssertEqual(model.helpers.map(\.detail), ["Couldn't read its status"])
    }

    func testTheStripShowsItsWingsWhileSomethingWaitsOrWorks() {
        XCTAssertFalse(IslandStripModel(waitingCount: 0, workingCount: 0).showsWings, "idle: the housing alone")
        let working = IslandStripModel(waitingCount: 0, workingCount: 2)
        XCTAssertTrue(working.showsWings)
        XCTAssertNil(working.countLabel)
        XCTAssertEqual(working.workingLabel, "2")
        XCTAssertEqual(working.accessibilityLabel, "Winter island. Nothing needs you. 2 sessions working.")
        XCTAssertEqual(IslandStripModel(waitingCount: 1).accessibilityLabel, "Winter island. 1 thing needs you.")
    }
}
