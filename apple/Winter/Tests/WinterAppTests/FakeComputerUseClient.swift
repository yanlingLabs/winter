import Foundation
import WinterKit

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
                       privateEventPath: Bool = true,
                       helper: ComputerUseHelperStatus = FakeComputerUseClient.idleHelper) -> ComputerUseStatus {
        ComputerUseStatus(enabled: enabled, legacyComputer: legacyComputer, mirror: mirror,
                          privateEventPath: privateEventPath, helper: helper)
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
    private(set) var setAppCalls: [(bundleId: String, name: String?, access: ComputerUseAppAccess?, grant: ComputerUseGrantWrite)] = []

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

    func setApp(bundleId: String, name: String?, access: ComputerUseAppAccess?, grant: ComputerUseGrantWrite) async throws {
        setAppCalls.append((bundleId, name, access, grant))
        try setAppResult.get()
    }

    func setSettings(_ patch: ComputerUseSettingsPatch) async throws {
        setSettingsCalls.append(patch)
        try setSettingsResult.get()
    }
}
