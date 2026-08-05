import XCTest
import AppKit
import NormaKit
@testable import Norma

/// App shell Task 7: the Dashboard re-hosted inside the shell (`AppShell/DashboardSurface.swift`).
/// Pure pane-catalogue/group coverage (migrated from `DashboardTests.swift`, whose subject file —
/// `Dashboard/DashboardView.swift` — was deleted this task, updated for the new 13-pane/5-group
/// shape) + the two new Mac-group panes' pure helpers (`CliInstallerPane`/`UpdaterPane`) + the
/// wiring-level pins the brief calls for: pane reachability and the hot-settings round-trip.
/// `LoginItemPane` has no pure helper of its own (a plain toggle over two injected closures — the
/// same "dumb view, nothing to unit-test independently of AppKit" posture `TrustPane`'s Revoke
/// button has). SwiftUI bodies (`DashboardSurface`/`*Pane`) are deliberately NOT exercised here,
/// per this codebase's convention. `PairingSheetPresentationModel` has NO tests here either — the
/// SP2b T5 constraint it inherits is explicit and documented at its own definition
/// (`PairingSheetModel.swift`, NormaKit): "the app-side coordinator/views get NO unit tests... ALL
/// testable logic goes in the NormaKit model," and `PairingSheetPresentationModel` is exactly that
/// app-side coordinator, just re-homed from an untested `NSPanel` controller to an untested
/// `ObservableObject`.
@MainActor
final class DashboardSurfaceTests: XCTestCase {
    // MARK: - dashboardPaneGroups / dashboardPaneOrder / defaultDashboardPane (PURE)

    /// One list (`dashboardPaneGroups`) is the single source of truth; `dashboardPaneOrder` is
    /// purely derived (`flatMap`) — this proves the derivation itself, not just the flattened
    /// result, so a future group edit can never silently desync the two.
    func testDashboardPaneOrderIsExactlyTheGroupsFlattened() {
        XCTAssertEqual(dashboardPaneGroups.flatMap(\.panes), dashboardPaneOrder)
    }

    /// Every pane in the spec §4 disposition table lands, exactly once, across the five groups —
    /// the mechanical proof that nothing was dropped or duplicated in translation from the old
    /// ten-pane flat list.
    func testDashboardPaneOrderContainsAllThirteenPanesInGroupOrder() {
        XCTAssertEqual(dashboardPaneOrder, [
            .daemonStatus, .peripheral, .trust, .cliInstaller, .updater, .loginItem,
            .provider, .quota,
            .memory, .skills,
            .workflows, .pluginManager,
            .pairedDevices,
        ])
        XCTAssertEqual(Set(dashboardPaneOrder), Set(DashboardPane.allCases), "every case must appear exactly once")
    }

    /// Spec §4: "DaemonStatus... anchors the Mac group" — its own first position within that group,
    /// not merely somewhere in it.
    func testMacGroupAnchorsOnDaemonStatus() {
        guard let macGroup = dashboardPaneGroups.first(where: { $0.id == "mac" }) else {
            return XCTFail("the Mac group must exist")
        }
        XCTAssertEqual(macGroup.panes.first, .daemonStatus)
    }

    /// Spec §4: "Remote windows (PairedDevices) → becomes a pane (Devices group)".
    func testDevicesGroupContainsExactlyPairedDevices() {
        guard let devicesGroup = dashboardPaneGroups.first(where: { $0.id == "devices" }) else {
            return XCTFail("the Devices group must exist")
        }
        XCTAssertEqual(devicesGroup.panes, [.pairedDevices])
    }

    /// The default landing pane is always computed from the group structure, never hardcoded —
    /// `.daemonStatus` now (the Mac group's own anchor), replacing the dead `.sessions`' old role.
    func testDefaultDashboardPaneIsFirstInOrder() {
        XCTAssertEqual(defaultDashboardPane, dashboardPaneOrder.first)
        XCTAssertEqual(defaultDashboardPane, .daemonStatus)
    }

    func testEveryPaneHasATitleAndSystemImage() {
        for pane in dashboardPaneOrder {
            XCTAssertFalse(dashboardPaneTitle(pane).isEmpty, "\(pane) needs a non-empty title")
            XCTAssertFalse(dashboardPaneSystemImage(pane).isEmpty, "\(pane) needs a non-empty SF Symbol name")
        }
    }

    // MARK: - DashboardSelectionModel (PURE — migrated from `DashboardTests.swift`, unchanged in
    // substance; its subject moved from `DashboardWindowController`-owned to `AppWindowController`-
    // owned, but the model's own contract — default/override/settable — is identical)

    func testDashboardSelectionModelDefaultsToDefaultDashboardPane() {
        let model = DashboardSelectionModel()
        XCTAssertEqual(model.selection, defaultDashboardPane)
    }

    func testDashboardSelectionModelInitialPaneOverridesTheDefault() {
        let model = DashboardSelectionModel(initialPane: .pluginManager)
        XCTAssertEqual(model.selection, .pluginManager)
    }

    func testDashboardSelectionModelSelectionIsSettable() {
        let model = DashboardSelectionModel()
        model.selection = .trust
        XCTAssertEqual(model.selection, .trust)
    }

    // MARK: - cliInstallStatusText / cliInstallButtonTitle / cliInstallActionable (PURE,
    // CliInstallerPane.swift — one of the Mac-group additions, spec §4)

    func testCliInstallStatusTextCoversEveryAction() {
        XCTAssertEqual(cliInstallStatusText(.install), "The `norma` command isn't installed yet.")
        XCTAssertTrue(cliInstallStatusText(.repair).localizedCaseInsensitiveContains("repair"))
        XCTAssertTrue(cliInstallStatusText(.alreadyInstalled).contains(CliInstaller.linkPath))
        XCTAssertTrue(cliInstallStatusText(.refuseForeign("/usr/local/bin/norma")).contains("/usr/local/bin/norma"))
    }

    func testCliInstallButtonTitleCoversEveryAction() {
        XCTAssertEqual(cliInstallButtonTitle(.install), "Install")
        XCTAssertEqual(cliInstallButtonTitle(.repair), "Repair")
        XCTAssertEqual(cliInstallButtonTitle(.alreadyInstalled), "Installed")
        XCTAssertEqual(cliInstallButtonTitle(.refuseForeign("/x")), "Can't Install")
    }

    /// Mirrors `MenuBarController.applyCliInstallState(_:)`'s own enabled/disabled split — the
    /// pane's button must never invite a click that can only re-report the same stuck state.
    func testCliInstallActionableOnlyForInstallAndRepair() {
        XCTAssertTrue(cliInstallActionable(.install))
        XCTAssertTrue(cliInstallActionable(.repair))
        XCTAssertFalse(cliInstallActionable(.alreadyInstalled))
        XCTAssertFalse(cliInstallActionable(.refuseForeign("/x")))
    }

    // MARK: - updateChannelDisplay (PURE, UpdaterPane.swift)

    func testUpdateChannelDisplayMapsBetaAndFailsTowardStable() {
        XCTAssertEqual(updateChannelDisplay("beta"), "Beta")
        XCTAssertEqual(updateChannelDisplay("stable"), "Stable")
        XCTAssertEqual(updateChannelDisplay(nil), "Stable")
        XCTAssertEqual(updateChannelDisplay("mystery"), "Stable", "an unrecognized channel fails toward stable, same posture as UpdaterCoordinator.allowedChannelSet(for:)")
    }

    // MARK: - Pane reachability (spec §4: "all ~12 current panes have a named destination")

    /// A normally-booted app must get a REAL `DashboardWiring` — never the host-less fallback
    /// `makeDashboardWiring` degrades to when `peripheralProvider`/`helperClient` are absent.
    func testSummonAppWindowBuildsRealDashboardWiringWhenBooted() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        delegate.summonAppWindow()
        XCTAssertNotNil(delegate.appWindow?.dashboardWiring, "a normally-booted app must have a real Dashboard surface")
        delegate.appWindow?.hide()
    }

    /// Every `DashboardPane` case is reachable via a targeted summon through the REAL
    /// `AppDelegate.summonAppWindow(navigatingTo:)` door — the mechanical proof of spec §4's "all
    /// current panes have a named destination," fired through the actual production entry point
    /// rather than asserted pane-by-pane against the catalogue alone.
    func testEveryDashboardPaneIsReachableViaATargetedSummon() {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())
        for pane in DashboardPane.allCases {
            delegate.summonAppWindow(navigatingTo: .dashboard(pane: pane))
            XCTAssertEqual(delegate.appWindow?.dashboardSelection.selection, pane, "\(pane) must be reachable via a targeted summon")
        }
        delegate.appWindow?.hide()
    }

    // MARK: - Hot settings (the no-restart rule, pinned end to end)

    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    func waitUntilMethod(_ t: AppScriptedTransport, _ method: String, occurrence: Int = 1, timeout: TimeInterval = 3) async -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let matches = t.sent.map(lineJSON).filter { $0["method"] as? String == method }
            if matches.count >= occurrence { return matches[occurrence - 1] }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("timed out waiting for occurrence \(occurrence) of method \(method): \(t.sent)")
        return [:]
    }

    /// THE pin the brief names explicitly: "a settings write round-trips live." Proves
    /// `AppDelegate.makeDashboardWiring`'s `providerModel.onConfigured` closure — built fresh at
    /// `summonAppWindow`'s construction, the direct descendant of `DashboardWindowController.init`'s
    /// old `onConfigured: { daemonSupervisor?.restart() }` wiring — still reaches a LIVE
    /// `DaemonSupervisor.restart()` through a REAL save flow (`provider.configure` over a scripted
    /// transport, exactly `ProviderPaneModelTests`' own model-level pattern, driven THROUGH
    /// `AppDelegate`'s wiring this time rather than a hand-built `ProviderPaneModel`) — never a
    /// daemon/app restart, only the supervised child process being asked to restart itself.
    /// `daemonSupervisorDeps` (a `.supervising`-mode fake, `AppLifecycleTests`' own pattern) makes
    /// `restart()`'s effect directly observable: `FakeDaemonProcess.terminateGracefullyCallCount`.
    func testProviderPaneOnConfiguredWiringReachesTheLiveDaemonSupervisorRestart() async throws {
        var procs: [FakeDaemonProcess] = []
        let delegate = AppDelegate()
        delegate.daemonSupervisorDeps = DaemonSupervisorDeps(
            bundledDaemonPath: { "/x/norma-core" },
            socketExists: { false },
            isDevEnv: { false },
            spawn: { _ in let p = FakeDaemonProcess(); procs.append(p); return p },
            now: { Date() }
        )
        XCTAssertTrue(delegate.boot())
        XCTAssertEqual(procs.count, 1, "boot() must have spawned exactly once (supervising mode)")
        XCTAssertEqual(procs[0].terminateGracefullyCallCount, 0)

        // Task 3's own precedent (`ShellSessionHost`'s tests) for swapping in a scripted `AppModel`
        // AFTER `boot()`: `peripheralProvider`/`helperClient` (built during `boot()`, against the
        // degraded model) are untouched by this swap — only `appModel.client`, which
        // `makeDashboardWiring` reads at `summonAppWindow` time, becomes this test's transport.
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]
        await waitUntilSent(t, 1)
        t.feed(#"{"jsonrpc":"2.0","id":\#(lineJSON(t.sent[0])["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":[]}}"#)

        delegate.setAppModelForTesting(model)
        delegate.summonAppWindow()
        defer { delegate.appWindow?.hide() }

        guard let providerModel = delegate.appWindow?.dashboardWiring?.providerModel else {
            return XCTFail("summonAppWindow() must build the Dashboard wiring when peripheralProvider/helperClient exist")
        }
        providerModel.apiKey = "sk-hot-settings-test"

        async let saveTask: Void = providerModel.save()
        let configureReq = await waitUntilMethod(t, "provider.configure")
        XCTAssertEqual(configureReq["method"] as? String, "provider.configure")
        t.feed(#"{"jsonrpc":"2.0","id":\#(configureReq["id"] as! Int),"result":{"ok":true}}"#)
        let statusReq = await waitUntilMethod(t, "daemon.status")
        t.feed(#"{"jsonrpc":"2.0","id":\#(statusReq["id"] as! Int),"result":{"version":"0.1.0","uptimeMs":0,"socketPath":"/tmp/x.sock","provider":{"id":"openai-compatible","model":"gpt-4o"},"sessionsCount":0,"pluginsCount":0}}"#)
        await saveTask

        XCTAssertTrue(providerModel.savedConfirmation, "the save itself must have succeeded for this pin to mean anything")
        XCTAssertEqual(procs[0].terminateGracefullyCallCount, 1, "a successful provider save must reach the live DaemonSupervisor.restart() — the no-restart-required hot-settings rule")
    }
}
