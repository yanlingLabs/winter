import XCTest
@testable import Norma

/// Sparkle T3: `UpdaterCoordinator`'s injectable deps seam (`DaemonSupervisorDeps` precedent —
/// see `DaemonSupervisorTests.swift`). Only the feed-override resolution is exercised here; T4
/// fills the idle gate, T5 fills channels.
@MainActor
final class UpdaterCoordinatorTests: XCTestCase {
    static func deps(
        activeTurns: @escaping () async -> Int? = { 0 },
        dirtyEditors: @escaping () -> Bool = { false },
        readChannel: @escaping () -> String? = { nil },
        feedOverride: @escaping () -> String? = { nil },
        now: @escaping () -> Date = { Date() },
        pollInterval: TimeInterval = 0.01,
        badgeAfter: TimeInterval = 0.05
    ) -> UpdaterCoordinatorDeps {
        .init(activeTurns: activeTurns, dirtyEditors: dirtyEditors, readChannel: readChannel,
              feedOverride: feedOverride, now: now, pollIntervalSeconds: pollInterval,
              badgeAfterSeconds: badgeAfter)
    }

    func testFeedOverrideWinsWhenSet() {
        let c = UpdaterCoordinator(deps: Self.deps(feedOverride: { "http://localhost:9999/appcast.xml" }))
        XCTAssertEqual(c.resolvedFeedOverride(), "http://localhost:9999/appcast.xml")
    }

    func testNoOverrideFallsBackToInfoPlist() {
        let c = UpdaterCoordinator(deps: Self.deps(feedOverride: { nil }))
        XCTAssertNil(c.resolvedFeedOverride()) // nil → Sparkle uses Info.plist SUFeedURL
    }

    // MARK: - Sparkle T4: the idle gate

    func testBusyDaemonPostponesAndIdleInstalls() async {
        var turns = 1
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { turns }))
        var installed = 0
        let postponed = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        XCTAssertTrue(postponed)
        XCTAssertEqual(c.stagedVersion, "0.2.002")
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertEqual(installed, 0)              // still busy — never yanked
        turns = 0
        try? await Task.sleep(for: .seconds(0.1)) // next poll sees idle
        XCTAssertEqual(installed, 1)
    }

    func testFirstPollTickIsImmediate() async {
        // pollInterval far larger than the test window: only an immediate first check can install.
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 0 }, pollInterval: 1000))
        var installed = 0
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertEqual(installed, 1)   // fails if the impl waits pollIntervalSeconds before the first check
    }

    func testRestartNowOverridesWhileBusy() async {
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 5 }))
        var installed = 0
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        c.installNow()
        XCTAssertEqual(installed, 1)
        c.installNow()                            // idempotent — no double-install
        XCTAssertEqual(installed, 1)
    }

    /// Live-gate finding: in SILENT automatic mode Sparkle stages for install-on-quit and never
    /// proactively relaunches — `updater(_:willInstallUpdateOnQuit:immediateInstallationBlock:)`
    /// is the seam that hands us the install handler, implemented as a thin shim over
    /// `handleRelaunchRequest` (same tested-via-the-core posture as `feedURLString`/
    /// `allowedChannels`/`shouldPostponeRelaunchForUpdate`: the delegate method itself takes a
    /// live `SPUUpdater`, which a unit test can't construct without spinning real updater
    /// machinery). This test pins the full silent-flow contract that shim funnels into: staging
    /// a fresh handler with NO user action fires the staged callback, holds while the daemon is
    /// busy, then unstages + arms `onWillInstall` + installs exactly once on idle.
    func testSilentOnQuitStagingDrivesIdleInstallWithoutUserAction() async {
        var turns = 1
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { turns }))
        var events: [String] = []
        c.onStagedChange = { staged, _ in events.append(staged ? "staged" : "unstaged") }
        c.onWillInstall = { events.append("willInstall") }
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { events.append("install") })
        XCTAssertEqual(c.stagedVersion, "0.2.002")
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertEqual(events, ["staged"])        // busy: staged only — no install, no arming
        turns = 0
        try? await Task.sleep(for: .seconds(0.1)) // next poll sees idle
        XCTAssertEqual(events, ["staged", "unstaged", "willInstall", "install"])
    }

    /// Whole-branch review (Critical): Sparkle terminates the host via a CANCELLABLE quit event,
    /// which Norma's lifecycle terminate gate would intercept like a ⌘Q (`.terminateCancel`) and
    /// silently defeat the whole install+relaunch. `onWillInstall` is the arming hook — AppDelegate
    /// wires it to set its `updaterQuitting` axis — so it must fire exactly once, BEFORE the
    /// install handler runs (the terminate round-trip happens inside `install()`), and never again
    /// on the idempotent second `installNow()`.
    func testOnWillInstallFiresOnceBeforeInstallHandler() async {
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 5 }))
        var events: [String] = []
        c.onWillInstall = { events.append("willInstall") }
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { events.append("install") })
        c.installNow()
        XCTAssertEqual(events, ["willInstall", "install"])
        c.installNow()                            // idempotent second call — no re-arm, no re-install
        XCTAssertEqual(events, ["willInstall", "install"])
    }

    func testStagedAndBadgeCallbacksFire() async {
        var clock = Date()
        var stagedStates: [Bool] = []
        var badges: [Bool] = []
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 1 }, now: { clock }, badgeAfter: 0.01))
        c.onStagedChange = { staged, _ in stagedStates.append(staged) }
        c.onBadgeChange = { badges.append($0) }
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: {})
        XCTAssertEqual(stagedStates, [true])
        clock = clock.addingTimeInterval(1)       // "24h" later (scaled by badgeAfter)
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertTrue(badges.contains(true))
    }

    // MARK: - editor-product Task 10 fix round 1: dirty editors defer the poll's idle install

    /// The concrete gap the review walked: idle daemon (no active turns) used to be sufficient for
    /// the poll to install. It no longer is — a dirty editor buffer holds it back too. Same
    /// mutable-flag transition shape as `testBusyDaemonPostponesAndIdleInstalls` above, but on the
    /// new axis: `activeTurns` is idle throughout, only `dirty` moves.
    func testDirtyEditorPostponesTheIdlePollInstallEvenWhenTheDaemonIsIdle() async {
        var dirty = true
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 0 }, dirtyEditors: { dirty }))
        var installed = 0
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertEqual(installed, 0)               // idle daemon, but a dirty editor still blocks
        dirty = false
        try? await Task.sleep(for: .seconds(0.1))  // next poll sees idle AND clean
        XCTAssertEqual(installed, 1)
    }

    /// Control case, the pair's other static half: idle and clean installs exactly as it always
    /// did — this fix adds a term, it does not change the outcome when that term is false.
    func testIdleAndCleanStillInstallsOnThePoll() async {
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 0 }, dirtyEditors: { false }))
        var installed = 0
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        try? await Task.sleep(for: .seconds(0.05))
        XCTAssertEqual(installed, 1)
    }

    /// The controller's deliberate non-change: "Restart Now" (`AppDelegate.onInstallUpdate`) calls
    /// `installNow()` directly, never through the poll's predicate, and must keep firing even with
    /// a dirty editor open — same override shape `testRestartNowOverridesWhileBusy` already pins
    /// for a busy daemon. No `await` between `handleRelaunchRequest` and `installNow()` below, so
    /// the poll Task (scheduled, not yet run) cannot race this assertion — same ordering the
    /// pre-existing busy-override test already relies on.
    func testRestartNowOverridesEvenWithADirtyEditor() async {
        let c = UpdaterCoordinator(deps: Self.deps(activeTurns: { 0 }, dirtyEditors: { true }))
        var installed = 0
        _ = c.handleRelaunchRequest(version: "0.2.002", untilInvoking: { installed += 1 })
        c.installNow()
        XCTAssertEqual(installed, 1)
    }

    // MARK: - Sparkle T5: channels

    func testChannelMapping() {
        let c = UpdaterCoordinator(deps: Self.deps())
        XCTAssertEqual(c.allowedChannelSet(for: nil), [])          // stable = default channel only
        XCTAssertEqual(c.allowedChannelSet(for: "stable"), [])
        XCTAssertEqual(c.allowedChannelSet(for: "beta"), ["beta"])
        XCTAssertEqual(c.allowedChannelSet(for: "junk"), [])       // unknown → stable
    }

    func testReadChannelFromSettingsFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        setenv("NORMA_HOME", dir.path, 1)
        defer { unsetenv("NORMA_HOME") }
        try #"{"schemaVersion":2,"updates":{"channel":"beta"}}"#
            .write(to: dir.appendingPathComponent("settings.json"), atomically: true, encoding: .utf8)
        XCTAssertEqual(UpdaterCoordinator.readChannelFromSettings(), "beta")
        try "not json".write(to: dir.appendingPathComponent("settings.json"), atomically: true, encoding: .utf8)
        XCTAssertNil(UpdaterCoordinator.readChannelFromSettings()) // malformed → stable default
    }
}
