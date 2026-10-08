import Foundation
import WinterKit
@testable import Winter

/// Hand-written `ComputerUseClient` test double — ComputerV2. Scripts every call by hand (no socket or
/// transport): `ComputerUseSettingsModel` is built around the `ComputerUseClient` PROTOCOL so its tests
/// never need `WinterClient`'s scripted transport (`ComputerUseClientTests` in WinterKit owns the wire).
/// Same `@unchecked Sendable` posture as `FakeMcpAuthClient` beside it: every mutation happens on the
/// main actor, under `await`.
///
/// The answers of `status()` and `listApps()` are QUEUES whose last value repeats once they run dry, so
/// a test that does not care about sequencing sets one value, and one that does (the daemon's read-back
/// after a write) scripts a second.
final class FakeComputerUseClient: ComputerUseClient, @unchecked Sendable {
    struct SimpleError: Error, Equatable, LocalizedError {
        var errorDescription: String? { "boom" }
    }

    static let idleHelper = ComputerUseHelperStatus(installed: true, running: false)

    static func status(enabled: Bool = true, legacyComputer: Bool = false, mirror: Bool = true,
                       privateEventPath: Bool = true, allowAllApps: Bool = true,
                       helper: ComputerUseHelperStatus = FakeComputerUseClient.idleHelper) -> ComputerUseStatus {
        ComputerUseStatus(enabled: enabled, legacyComputer: legacyComputer, mirror: mirror,
                          privateEventPath: privateEventPath, allowAllApps: allowAllApps, helper: helper)
    }

    static func running(accessibility: Bool, screenRecording: Bool) -> ComputerUseHelperStatus {
        ComputerUseHelperStatus(installed: true, running: true, version: "0.1.0",
                                permissions: ComputerUsePermissions(accessibility: accessibility,
                                                                    screenRecording: screenRecording))
    }

    // status()
    var statusResults: [Result<ComputerUseStatus, Error>] = [.success(FakeComputerUseClient.status())]
    private(set) var statusCallCount = 0

    // requestPermission(_:)
    var requestPermissionResult: Result<Void, Error> = .success(())
    private(set) var requestPermissionCalls: [ComputerUsePermissionKind] = []

    // listApps()
    var listAppsResults: [Result<[ComputerUseApp], Error>] = [.success([])]
    private(set) var listAppsCallCount = 0

    // setApp(bundleId:name:access:grant:)
    var setAppResult: Result<Void, Error> = .success(())
    private(set) var setAppCalls: [(bundleId: String, name: String?, access: ComputerUseAccessWrite, grant: ComputerUseGrantWrite)] = []

    // setSettings(_:)
    var setSettingsResult: Result<Void, Error> = .success(())
    private(set) var setSettingsCalls: [ComputerUseSettingsPatch] = []

    func status() async throws -> ComputerUseStatus {
        statusCallCount += 1
        let result = statusResults.count > 1 ? statusResults.removeFirst() : (statusResults.first ?? .success(Self.status()))
        return try result.get()
    }

    func requestPermission(_ kind: ComputerUsePermissionKind) async throws {
        requestPermissionCalls.append(kind)
        try requestPermissionResult.get()
    }

    func listApps() async throws -> [ComputerUseApp] {
        listAppsCallCount += 1
        let result = listAppsResults.count > 1 ? listAppsResults.removeFirst() : (listAppsResults.first ?? .success([]))
        return try result.get()
    }

    func setApp(bundleId: String, name: String?, access: ComputerUseAccessWrite, grant: ComputerUseGrantWrite) async throws {
        setAppCalls.append((bundleId, name, access, grant))
        try setAppResult.get()
    }

    func setSettings(_ patch: ComputerUseSettingsPatch) async throws {
        setSettingsCalls.append(patch)
        try setSettingsResult.get()
    }
}

/// Hand-written `InstalledAppEnumerating` test double — nothing scans the disk or asks LaunchServices. It
/// records how often it was asked and whether any ask came on the main thread, because the model's
/// promise is that both calls run off it.
final class FakeInstalledAppEnumerator: InstalledAppEnumerating, @unchecked Sendable {
    private let apps: [InstalledApp]
    private let paths: [String: String]
    private let lock = NSLock()
    private var _scanCount = 0
    private var _pathLookups: [String] = []
    private var _sawMainThread = false

    /// - Parameters:
    ///   - apps: what the add sheet's scan finds.
    ///   - paths: the bundle ids that resolve to an app on disk (every other id is "not installed").
    init(apps: [InstalledApp], paths: [String: String] = [:]) {
        self.apps = apps
        self.paths = paths
    }

    var scanCount: Int { lock.withLock { _scanCount } }
    var pathLookups: [String] { lock.withLock { _pathLookups } }
    var anyCallWasOnTheMainThread: Bool { lock.withLock { _sawMainThread } }

    func installedApps() -> [InstalledApp] {
        lock.withLock {
            _scanCount += 1
            if Thread.isMainThread { _sawMainThread = true }
        }
        return apps
    }

    func appPath(forBundleId bundleId: String) -> String? {
        lock.withLock {
            _pathLookups.append(bundleId)
            if Thread.isMainThread { _sawMainThread = true }
        }
        return paths[bundleId]
    }
}
