import XCTest
import WinterProtocol
@testable import WinterKit

/// ComputerV2: `LiveComputerUseClient` over a scripted transport — the exact params it sends for each
/// of the four pinned RPCs (and the one proposed write), and how it decodes their results.
final class ComputerUseClientTests: XCTestCase {
    func connected() async throws -> (WinterClient, ScriptedTransport) {
        let t = ScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "cu-test")
        async let c: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    func roundTrip<T>(_ t: ScriptedTransport, sentIndex: Int, result: String, _ call: @escaping () async throws -> T) async throws -> (request: [String: Any], value: T) {
        async let v = call()
        let sent = try await waitForSent(t, count: sentIndex + 1)
        let req = decodeLine(sent[sentIndex])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":\#(result)}"#)
        return (req, try await v)
    }

    // MARK: - computerUse.status

    func testStatusDecodesTheWholePinnedShape() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        let result = #"""
        {"enabled":true,"legacyComputer":false,"mirror":true,"privateEventPath":false,"allowAllApps":false,
         "helper":{"installed":true,"running":true,"version":"0.1.0","permissions":{"accessibility":true,"screenRecording":false}}}
        """#.replacingOccurrences(of: "\n", with: "")
        let (req, status) = try await roundTrip(t, sentIndex: 1, result: result) { try await live.status() }
        XCTAssertEqual(req["method"] as? String, "computerUse.status")
        XCTAssertEqual(status, ComputerUseStatus(
            enabled: true, legacyComputer: false, mirror: true, privateEventPath: false, allowAllApps: false,
            helper: ComputerUseHelperStatus(installed: true, running: true, version: "0.1.0",
                                            permissions: ComputerUsePermissions(accessibility: true, screenRecording: false))))
    }

    /// `version` and `permissions` are optional on the wire — a helper that is not running reports
    /// neither, and that must decode (and stay distinct from "both denied").
    func testStatusDecodesAHelperThatIsNotRunning() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        let result = #"{"enabled":false,"legacyComputer":true,"mirror":false,"privateEventPath":true,"helper":{"installed":false,"running":false}}"#
        let (_, status) = try await roundTrip(t, sentIndex: 1, result: result) { try await live.status() }
        XCTAssertFalse(status.enabled)
        XCTAssertTrue(status.legacyComputer)
        XCTAssertEqual(status.helper, ComputerUseHelperStatus(installed: false, running: false))
        XCTAssertNil(status.helper.permissions)
        XCTAssertTrue(status.allowAllApps, "a daemon that predates the master switch reads as on, the default")
    }

    func testStatusThrowsOnAMalformedResult() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        do {
            _ = try await roundTrip(t, sentIndex: 1, result: #"{"enabled":true}"#) { try await live.status() }
            XCTFail("a status without its helper block must throw")
        } catch let error as RpcError {
            XCTAssertEqual(error.code, -3)
        }
    }

    // MARK: - computerUse.requestPermission

    func testRequestPermissionSendsTheKindAndInsistsOnOk() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        let (r1, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) { try await live.requestPermission(.accessibility) }
        XCTAssertEqual(r1["method"] as? String, "computerUse.requestPermission")
        XCTAssertEqual(r1["params"] as? [String: String], ["kind": "accessibility"])
        let (r2, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) { try await live.requestPermission(.screenRecording) }
        XCTAssertEqual(r2["params"] as? [String: String], ["kind": "screenRecording"])

        do {
            _ = try await roundTrip(t, sentIndex: 3, result: #"{"ok":false}"#) { try await live.requestPermission(.accessibility) }
            XCTFail("ok:false must throw")
        } catch is RpcError {
            // expected
        }
    }

    // MARK: - computerUse.apps.list

    func testListAppsDecodesExceptionsDefaultsAndGrantOnlyRows() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        let result = #"""
        {"apps":[
          {"bundleId":"com.apple.Notes","name":"Notes","access":"click","grant":"always","isDefault":false,"lastUsedAt":1760000000000},
          {"bundleId":"com.1password.1password","name":"1Password","access":"deny","grant":null,"isDefault":true},
          {"bundleId":"com.apple.TextEdit","name":"TextEdit","access":null,"grant":"always","isDefault":false},
          {"bundleId":"com.example.Old","name":"Old","access":"view"},
          {"bundleId":"com.example.Weird","name":"Weird","access":"sometimes","grant":null,"isDefault":false},
          {"bundleId":"com.example.Grant","name":"Grant","access":"full","grant":"forever","isDefault":false}
        ]}
        """#.replacingOccurrences(of: "\n", with: "")
        let (req, apps) = try await roundTrip(t, sentIndex: 1, result: result) { try await live.listApps() }
        XCTAssertEqual(req["method"] as? String, "computerUse.apps.list")
        XCTAssertEqual(apps.map(\.bundleId), ["com.apple.Notes", "com.1password.1password", "com.apple.TextEdit", "com.example.Old"],
                       "a row with an access or grant word this build does not know is dropped")
        XCTAssertEqual(apps[0], ComputerUseApp(bundleId: "com.apple.Notes", name: "Notes", access: .click, grant: .always,
                                               isDefault: false, lastUsedAt: 1_760_000_000_000))
        XCTAssertTrue(apps[1].isDefault)
        XCTAssertEqual(apps[1].access, .deny)
        XCTAssertNil(apps[1].grant)
        XCTAssertNil(apps[2].access, "access:null is a row that exists only for its always-grant")
        XCTAssertEqual(apps[2].grant, .always)
        XCTAssertFalse(apps[3].isDefault, "a daemon that predates isDefault reads as not default")
        XCTAssertNil(apps[3].grant)
    }

    func testListAppsThrowsWhenThereIsNoAppsArray() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        do {
            _ = try await roundTrip(t, sentIndex: 1, result: #"{"nope":[]}"#) { try await live.listApps() }
            XCTFail("a result with no apps array must throw")
        } catch is RpcError {
            // expected
        }
    }

    func testLastUsedDateReadsEitherUnit() {
        let ms = ComputerUseApp(bundleId: "a", name: "A", access: .full, lastUsedAt: 1_760_000_000_000)
        let seconds = ComputerUseApp(bundleId: "a", name: "A", access: .full, lastUsedAt: 1_760_000_000)
        XCTAssertEqual(ms.lastUsedDate, Date(timeIntervalSince1970: 1_760_000_000))
        XCTAssertEqual(seconds.lastUsedDate, Date(timeIntervalSince1970: 1_760_000_000))
        XCTAssertNil(ComputerUseApp(bundleId: "a", name: "A", access: .full).lastUsedDate)
        XCTAssertNil(ComputerUseApp(bundleId: "a", name: "A", access: .full, lastUsedAt: 0).lastUsedDate)
    }

    // MARK: - computerUse.apps.set

    func testSetAppSendsOnlyWhatWasGivenAndARemovalIsNull() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)

        let (r1, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await live.setApp(bundleId: "com.apple.Notes", name: "Notes", access: .set(.click), grant: .leave)
        }
        XCTAssertEqual(r1["method"] as? String, "computerUse.apps.set")
        XCTAssertEqual(r1["params"] as? [String: String], ["bundleId": "com.apple.Notes", "name": "Notes", "access": "click"])

        // Allow is sent as the wire's `full`, like any other level.
        let (r2, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) {
            try await live.setApp(bundleId: "com.apple.Notes", name: nil, access: .set(.full), grant: .leave)
        }
        XCTAssertEqual(r2["params"] as? [String: String], ["bundleId": "com.apple.Notes", "access": "full"])

        // Removing the exception: `access: null`, nothing else.
        let (r3, _) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true}"#) {
            try await live.setApp(bundleId: "com.apple.Notes", name: nil, access: .remove, grant: .leave)
        }
        let p3 = try XCTUnwrap(r3["params"] as? [String: Any])
        XCTAssertEqual(Set(p3.keys), ["bundleId", "access"])
        XCTAssertTrue(p3["access"] is NSNull)

        // Removing a grant: `grant: null`, the exception untouched.
        let (r4, _) = try await roundTrip(t, sentIndex: 4, result: #"{"ok":true}"#) {
            try await live.setApp(bundleId: "com.apple.Notes", name: nil, access: .leave, grant: .clear)
        }
        let p4 = try XCTUnwrap(r4["params"] as? [String: Any])
        XCTAssertEqual(Set(p4.keys), ["bundleId", "grant"])
        XCTAssertTrue(p4["grant"] is NSNull)

        let (r5, _) = try await roundTrip(t, sentIndex: 5, result: #"{"ok":true}"#) {
            try await live.setApp(bundleId: "com.apple.Notes", name: nil, access: .leave, grant: .always)
        }
        XCTAssertEqual(r5["params"] as? [String: String], ["bundleId": "com.apple.Notes", "grant": "always"])
    }

    func testSetAppInsistsOnOk() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        do {
            _ = try await roundTrip(t, sentIndex: 1, result: #"{"ok":false}"#) {
                try await live.setApp(bundleId: "x", name: nil, access: .set(.deny), grant: .leave)
            }
            XCTFail("ok:false must throw")
        } catch is RpcError {
            // expected
        }
    }

    // MARK: - computerUse.setSettings (PROPOSED)

    func testSetSettingsIsAPartialPatch() async throws {
        let (client, t) = try await connected()
        let live = LiveComputerUseClient(client: client)
        let (r1, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await live.setSettings(ComputerUseSettingsPatch(mirror: false))
        }
        XCTAssertEqual(r1["method"] as? String, "computerUse.setSettings")
        let p1 = try XCTUnwrap(r1["params"] as? [String: Any])
        XCTAssertEqual(p1.count, 1)
        XCTAssertEqual(p1["mirror"] as? Bool, false)

        let (r2, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) {
            try await live.setSettings(ComputerUseSettingsPatch(enabled: true, privateEventPath: true))
        }
        let p2 = try XCTUnwrap(r2["params"] as? [String: Any])
        XCTAssertEqual(Set(p2.keys), ["enabled", "privateEventPath"])
        XCTAssertEqual(p2["enabled"] as? Bool, true)
        XCTAssertEqual(p2["privateEventPath"] as? Bool, true)

        let (r3, _) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true}"#) {
            try await live.setSettings(ComputerUseSettingsPatch(allowAllApps: false))
        }
        XCTAssertEqual(r3["params"] as? [String: Bool], ["allowAllApps": false])
    }

    func testApplyingAPatchReplacesOnlyItsKeys() {
        let status = ComputerUseStatus(enabled: true, legacyComputer: true, mirror: true, privateEventPath: true,
                                       helper: ComputerUseHelperStatus(installed: true, running: false))
        let patched = status.applying(ComputerUseSettingsPatch(mirror: false))
        XCTAssertEqual(patched, ComputerUseStatus(enabled: true, legacyComputer: true, mirror: false, privateEventPath: true,
                                                  helper: ComputerUseHelperStatus(installed: true, running: false)))
        XCTAssertFalse(status.applying(ComputerUseSettingsPatch(allowAllApps: false)).allowAllApps)
        XCTAssertTrue(status.allowAllApps, "the default is on")
        XCTAssertEqual(status.applying(ComputerUseSettingsPatch()), status)
    }

    func testAnEmptyPatchSaysSo() {
        XCTAssertTrue(ComputerUseSettingsPatch().isEmpty)
        XCTAssertFalse(ComputerUseSettingsPatch(enabled: false).isEmpty)
        XCTAssertFalse(ComputerUseSettingsPatch(allowAllApps: true).isEmpty)
    }
}
