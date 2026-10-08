import Foundation

// -----------------------------------------------------------------------------------------------
// ComputerV2 — the Mac's door onto the computer-use RPCs: `computerUse.status`,
// `computerUse.requestPermission`, `computerUse.apps.list` and `computerUse.apps.set` (the daemon owns
// the settings, the grants and the helper app; this client only reads and writes through it). All four
// are LOCAL-role methods — the phone never changes what the agent may touch on the Mac.
//
// Same seam posture as `McpPermissionsClient` beside this file: a protocol so Settings → Computer Use's
// model is unit-testable against a hand-written fake, and a thin live implementation over
// `WinterClient.request`. The result types are `Codable` with stored property names equal to the wire
// keys, decoded by a JSON round trip (`JSONValue` is itself `Codable`), so a row can be dropped on its
// own when it carries a word this build does not know — the same "never guess" rule `McpToolsServer`
// keeps.
//
// **`computerUse.setSettings` is PROPOSED, not pinned.** The three booleans the page toggles
// (`enabled`, `mirror`, `privateEventPath`) have no write door on the wire today: the app writes no
// `settings.json` key directly (the advisor model's direct write was retired for racing the daemon's
// watcher), and every other settings write is a purpose-specific RPC. `setSettings` is that RPC for this
// page — a partial patch, absent keys untouched — and `LiveComputerUseClient` sends it by that name. A
// daemon that does not answer it fails the write with a typed `RpcError` the page shows; nothing is
// written some other way.
// -----------------------------------------------------------------------------------------------

/// What the user lets the agent do in one app (`computerUse.apps.<bundleId>.access`). "Full" is the
/// default; each step down removes capability and none of them is a policy exception — restrictions
/// apply under every approval policy, `bypass` included.
public enum ComputerUseAppAccess: String, Codable, CaseIterable, Equatable, Sendable {
    /// Everything the script API can do.
    case full
    /// Clicks, scrolls and observation; no typing, keys, paste, `setValue` or drag.
    case click
    /// Observation only.
    case view
    /// Never bound, and blacked out of whole-screen shots.
    case deny
}

/// The two macOS permissions the helper app needs, named as `computerUse.requestPermission` takes them.
public enum ComputerUsePermissionKind: String, Codable, CaseIterable, Equatable, Sendable {
    case accessibility
    case screenRecording
}

/// What an app's saved answer to the per-app card persisted: `"always"` or nothing.
public enum ComputerUseGrant: String, Codable, Equatable, Sendable {
    case always
}

public struct ComputerUsePermissions: Codable, Equatable, Sendable {
    public let accessibility: Bool
    public let screenRecording: Bool

    public init(accessibility: Bool, screenRecording: Bool) {
        self.accessibility = accessibility
        self.screenRecording = screenRecording
    }
}

/// `computerUse.status`' `helper` block. `permissions` is absent while the helper is not running (the
/// daemon cannot ask a helper that is not there), which is different from both being denied.
public struct ComputerUseHelperStatus: Codable, Equatable, Sendable {
    public let installed: Bool
    public let running: Bool
    public let version: String?
    public let permissions: ComputerUsePermissions?

    public init(installed: Bool, running: Bool, version: String? = nil, permissions: ComputerUsePermissions? = nil) {
        self.installed = installed
        self.running = running
        self.version = version
        self.permissions = permissions
    }
}

public struct ComputerUseStatus: Codable, Equatable, Sendable {
    public let enabled: Bool
    public let legacyComputer: Bool
    public let mirror: Bool
    public let privateEventPath: Bool
    public let helper: ComputerUseHelperStatus

    public init(enabled: Bool, legacyComputer: Bool, mirror: Bool, privateEventPath: Bool, helper: ComputerUseHelperStatus) {
        self.enabled = enabled
        self.legacyComputer = legacyComputer
        self.mirror = mirror
        self.privateEventPath = privateEventPath
        self.helper = helper
    }

    /// PURE: this status with `patch`'s keys replaced — what the page shows while a write is in flight.
    public func applying(_ patch: ComputerUseSettingsPatch) -> ComputerUseStatus {
        ComputerUseStatus(enabled: patch.enabled ?? enabled, legacyComputer: legacyComputer,
                          mirror: patch.mirror ?? mirror, privateEventPath: patch.privateEventPath ?? privateEventPath,
                          helper: helper)
    }
}

/// One row of `computerUse.apps.list`: every app that has a setting, plus the apps ComputerV2 used
/// recently (the daemon remembers their name and `lastUsedAt`).
public struct ComputerUseApp: Codable, Equatable, Identifiable, Sendable {
    public var id: String { bundleId }
    public let bundleId: String
    public let name: String
    public let access: ComputerUseAppAccess
    /// `"always"` when the user chose "Always allow" on the per-app card; `null` on the wire otherwise.
    public let grant: ComputerUseGrant?
    /// Epoch time of the app's last use. The unit is not pinned (the protocol's other timestamps are
    /// epoch milliseconds); `lastUsedDate` reads either.
    public let lastUsedAt: Double?

    public init(bundleId: String, name: String, access: ComputerUseAppAccess, grant: ComputerUseGrant? = nil, lastUsedAt: Double? = nil) {
        self.bundleId = bundleId
        self.name = name
        self.access = access
        self.grant = grant
        self.lastUsedAt = lastUsedAt
    }

    /// PURE: `lastUsedAt` as a date. A value below 1e11 cannot be epoch milliseconds (that is 1973) and
    /// is read as seconds, so the page is right whichever unit the daemon settles on.
    public var lastUsedDate: Date? {
        guard let value = lastUsedAt, value > 0 else { return nil }
        return Date(timeIntervalSince1970: value < 100_000_000_000 ? value : value / 1000)
    }
}

/// What `computerUse.apps.set` is told about an app's `grant`. Three states because the wire has three:
/// the key absent (leave it), `"always"`, and `null` (clear it — "Remove always-allow").
public enum ComputerUseGrantWrite: Equatable, Sendable {
    case leave
    case always
    case clear
}

/// A partial write of the three booleans Settings → Computer Use toggles. Absent keys are untouched.
/// PROPOSED wire shape — see the header.
public struct ComputerUseSettingsPatch: Codable, Equatable, Sendable {
    public var enabled: Bool?
    public var mirror: Bool?
    public var privateEventPath: Bool?

    public init(enabled: Bool? = nil, mirror: Bool? = nil, privateEventPath: Bool? = nil) {
        self.enabled = enabled
        self.mirror = mirror
        self.privateEventPath = privateEventPath
    }

    public var isEmpty: Bool { enabled == nil && mirror == nil && privateEventPath == nil }
}

/// The app's seam onto the computer-use RPCs.
public protocol ComputerUseClient: Sendable {
    func status() async throws -> ComputerUseStatus
    /// Launches the helper if needed and raises the system prompt (or opens the matching Privacy pane).
    func requestPermission(_ kind: ComputerUsePermissionKind) async throws
    func listApps() async throws -> [ComputerUseApp]
    /// Writes one app's setting. `name` is stored so a not-yet-seen app still has a label in the list.
    func setApp(bundleId: String, name: String?, access: ComputerUseAppAccess?, grant: ComputerUseGrantWrite) async throws
    /// PROPOSED (`computerUse.setSettings`) — see the header.
    func setSettings(_ patch: ComputerUseSettingsPatch) async throws
}

/// The production implementation, over `WinterClient.request`.
public final class LiveComputerUseClient: ComputerUseClient, Sendable {
    private let client: WinterClient

    public init(client: WinterClient) {
        self.client = client
    }

    public func status() async throws -> ComputerUseStatus {
        let r = try await client.request("computerUse.status", params: .object([:]))
        guard let status = Self.decode(ComputerUseStatus.self, from: r) else {
            throw RpcError(code: -3, message: "invalid result from server for computerUse.status")
        }
        return status
    }

    public func requestPermission(_ kind: ComputerUsePermissionKind) async throws {
        let r = try await client.request("computerUse.requestPermission", params: .object(["kind": .string(kind.rawValue)]))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "computerUse.requestPermission returned ok:false")
        }
    }

    public func listApps() async throws -> [ComputerUseApp] {
        let r = try await client.request("computerUse.apps.list", params: .object([:]))
        guard let rows = r["apps"]?.arrayValue else {
            throw RpcError(code: -3, message: "invalid result from server for computerUse.apps.list")
        }
        // A row naming an access word this build does not know is dropped rather than guessed at.
        return rows.compactMap { Self.decode(ComputerUseApp.self, from: $0) }
    }

    public func setApp(bundleId: String, name: String?, access: ComputerUseAppAccess?, grant: ComputerUseGrantWrite) async throws {
        var params: [String: JSONValue] = ["bundleId": .string(bundleId)]
        if let name { params["name"] = .string(name) }
        if let access { params["access"] = .string(access.rawValue) }
        switch grant {
        case .leave: break
        case .always: params["grant"] = .string(ComputerUseGrant.always.rawValue)
        case .clear: params["grant"] = .null
        }
        let r = try await client.request("computerUse.apps.set", params: .object(params))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "computerUse.apps.set returned ok:false")
        }
    }

    public func setSettings(_ patch: ComputerUseSettingsPatch) async throws {
        var params: [String: JSONValue] = [:]
        if let enabled = patch.enabled { params["enabled"] = .bool(enabled) }
        if let mirror = patch.mirror { params["mirror"] = .bool(mirror) }
        if let privateEventPath = patch.privateEventPath { params["privateEventPath"] = .bool(privateEventPath) }
        let r = try await client.request("computerUse.setSettings", params: .object(params))
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "computerUse.setSettings returned ok:false")
        }
    }

    /// PURE: one wire value as `T`, or `nil` when it does not have `T`'s shape. A JSON round trip because
    /// `JSONValue` is `Codable` and the result types are declared against the wire's own keys.
    static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
