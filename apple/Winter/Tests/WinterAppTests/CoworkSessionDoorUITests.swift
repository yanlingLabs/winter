import XCTest
import SwiftUI
import WinterKit
import WinterProtocol
@testable import Winter

/// The Mac's Cowork session surfaces (design 7.9) and the proof that none of them is reachable while
/// `SessionMode.cowork.isAvailable` is false. The behavior that matters most (the gate, the create sequence,
/// the refusal copy, the notes) is pinned in WinterKit, where `swift test` runs it; these tests pin the wiring.
@MainActor
final class CoworkSessionDoorUITests: XCTestCase {
    /// A Cowork composer model whose own constant says "available", so the AppShell-level gate (the real
    /// constant) is the only thing standing between it and a request.
    private func openModel(calls: CallLog = CallLog()) -> CoworkComposerModel {
        CoworkComposerModel(modeAvailable: { true }, call: { method, _ in
            calls.methods.append(method)
            throw RpcError(code: -32601, message: "Method not found")
        }, createSession: { _ in
            calls.methods.append("session.create")
            throw RpcError(code: -32601, message: "Method not found")
        })
    }
    private final class CallLog { var methods: [String] = [] }

    // MARK: Staying off

    func testCoworkStaysUnavailableUntilTheFlip() {
        XCTAssertFalse(SessionMode.cowork.isAvailable)
        for mode in SessionMode.allCases where mode != .cowork { XCTAssertTrue(mode.isAvailable, "\(mode)") }
    }

    func testTheNewChatSendReasonNeverConsultsTheCoworkModelWhileTheModeIsOff() {
        let log = CallLog()
        let model = openModel(calls: log)
        XCTAssertEqual(newChatSendBlockedReason(draft: "hello", mode: .cowork, cowork: model), "Cowork isn't built yet")
        XCTAssertEqual(newChatSendBlockedReason(draft: "", mode: .cowork, cowork: model), "Cowork isn't built yet")
        XCTAssertEqual(newChatSendBlockedReason(draft: "hello", mode: .cowork), "Cowork isn't built yet")
        XCTAssertEqual(log.methods, [])
        // Chat is untouched by a Cowork model.
        XCTAssertNil(newChatSendBlockedReason(draft: "hello", mode: .chat, cowork: model))
        XCTAssertEqual(newChatSendBlockedReason(draft: " ", mode: .chat, cowork: model), "")
    }

    func testTheAppsOwnComposerModelIsClosedBecauseItReadsTheRealConstant() async {
        // The shape the host builds: `modeAvailable: { SessionMode.cowork.isAvailable }`.
        let log = CallLog()
        let model = CoworkComposerModel(modeAvailable: { SessionMode.cowork.isAvailable }, call: { method, _ in
            log.methods.append(method); throw RpcError(code: -32601, message: "Method not found")
        }, createSession: { _ in log.methods.append("session.create"); return "s_x" })
        await model.refresh()
        let started = await model.start(draft: "hello")
        XCTAssertNil(started)
        XCTAssertEqual(log.methods, [], "no read, no workspace.create, no session.create")
        XCTAssertFalse(model.isOpen)
        XCTAssertEqual(coworkStripFace(isOpen: model.isOpen), .placeholders)
    }

    func testTheHostBuildsItsCoworkModelsOnlyAroundAManagementConnection() throws {
        let src = try appSource("AppShell/ShellSessionHost.swift")
        XCTAssertTrue(src.contains("CoworkComposerModel(modeAvailable: { SessionMode.cowork.isAvailable }"))
        XCTAssertTrue(src.contains("CoworkSessionWindowModel(modeAvailable: { SessionMode.cowork.isAvailable }"))
    }

    // MARK: The composer

    private func context(cowork: CoworkComposerWiring?) -> ComposerContext {
        ComposerContext(mode: .constant(.cowork), modeIsSelectable: true, policy: nil, announcement: "", cowork: cowork)
    }

    func testWithoutWiringTheCoworkChromeIsExactlyTheOldPlaceholderStrip() {
        let chrome = CoworkComposerChrome(context: context(cowork: nil))
        XCTAssertEqual(chrome.makeStrip()?.kind, .coworkPlaceholders)
        XCTAssertEqual(chrome.makeStrip()?.height, newChatComposerStripHeight)
        XCTAssertTrue(chrome.showsModelControl)
    }

    func testWithWiringAClosedCoworkStillDrawsThePlaceholdersAndKeepsTheModelChip() {
        let model = openModel()
        let wiring = CoworkComposerWiring(model: model, pickFolder: {})
        XCTAssertFalse(model.isOpen, "the model's own constant is on, but nothing has read the daemon: the gate is closed")
        let chrome = CoworkComposerChrome(context: context(cowork: wiring))
        XCTAssertEqual(chrome.makeStrip()?.kind, .coworkChips)
        XCTAssertEqual(coworkStripFace(isOpen: model.isOpen), .placeholders)
        XCTAssertTrue(chrome.showsModelControl)
    }

    func testTheFaceIsLiveOnlyWhenOpen() {
        XCTAssertEqual(coworkStripFace(isOpen: false), .placeholders)
        XCTAssertEqual(coworkStripFace(isOpen: true), .live)
    }

    func testTheApprovalPickerOffersTheSixSessionModesWithTheSameWords() {
        XCTAssertEqual(coworkApprovalOffers.map(\.rawValue), sessionPolicyModes)
        for policy in coworkApprovalOffers {
            XCTAssertEqual(policy.displayName, policyDisplayLabel(policy.rawValue), policy.rawValue)
        }
    }

    func testOnlyTheCoworkChromeReadsTheCoworkWiring() throws {
        let composerCard = try appSource("AppShell/WinterComposerCard.swift")
        XCTAssertFalse(composerCard.contains("coworkStripFace"), "the shared card holds no Cowork branching")
        XCTAssertFalse(composerCard.contains("CoworkComposerModel"))
    }

    // MARK: Nothing else mints a Cowork session

    func testNoAppSourceOutsideTheSessionDoorBuildsACoworkCreate() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        var scanned = 0
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        while let url = walker?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let code = try String(contentsOf: url, encoding: .utf8)
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.drop(while: { $0 == " " }).hasPrefix("//") ? "" : String($0) }
                .joined(separator: "\n")
            XCTAssertFalse(code.contains("mode: \"cowork\""), "\(url.lastPathComponent) names a Cowork create")
            XCTAssertFalse(code.contains("CoworkSessionBinding("), "\(url.lastPathComponent) builds a Cowork binding")
            if url.lastPathComponent != "ShellSessionHost.swift" {
                XCTAssertFalse(code.contains(".start(draft:"), "\(url.lastPathComponent) starts a Cowork conversation")
            }
            scanned += 1
        }
        XCTAssertGreaterThan(scanned, 100)
    }

    // MARK: The session window

    private func row(mode: String?) -> SessionSummary {
        SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global", cwd: nil, mode: mode)
    }

    func testTheBannerAppliesToCoworkRowsOnly() {
        XCTAssertFalse(coworkBannerApplies(to: nil))
        for mode in [nil, "code", "chat", "dispatch", "something-new"] {
            XCTAssertFalse(coworkBannerApplies(to: row(mode: mode)), "\(mode ?? "nil")")
        }
        XCTAssertTrue(coworkBannerApplies(to: row(mode: "cowork")))
    }

    func testNoteSymbolsSeparateWarningsFromStates() {
        XCTAssertEqual(coworkNoteSymbol(.unavailable), "exclamationmark.triangle")
        XCTAssertEqual(coworkNoteSymbol(.starting), "clock")
        XCTAssertEqual(coworkNoteSymbol(.outputsNotVisible), "info.circle")
        XCTAssertEqual(coworkNoteSymbol(.guidanceNotLoaded), "info.circle")
    }

    func testTheDirectoryMergesBindingsOntoCoworkRowsOnly() {
        let code = row(mode: nil)
        let cowork = SessionSummary(sessionId: "s_c", title: nil, createdAt: 2, scope: "global", cwd: nil, mode: "cowork")
        let created = SessionEvent.CoworkSessionCreatedFacts.fixture(workspaceId: "w_event", location: "outputs")
        let merged = SessionDirectory.mergingCowork(
            into: [code, cowork],
            listed: ["s_c": CoworkRowFacts(workspaceId: "w_list", projectId: "proj"), "s_1": CoworkRowFacts(workspaceId: "w_stray")],
            created: ["s_c": created])
        XCTAssertNil(merged[0].cowork, "a stray cowork key on a code row is not a binding")
        XCTAssertEqual(merged[1].cowork, CoworkRowFacts(workspaceId: "w_list", projectId: "proj"), "the list's answer wins")
        XCTAssertEqual(merged[1].coworkLocation, "outputs", "the location comes from the created event")
        let eventOnly = SessionDirectory.mergingCowork(into: [cowork], listed: [:], created: ["s_c": created])
        XCTAssertEqual(eventOnly[0].cowork, CoworkRowFacts(workspaceId: "w_event", projectId: nil))
        XCTAssertNil(SessionDirectory.mergingCowork(into: [cowork], listed: [:], created: [:])[0].cowork)
    }

    func testTheCoworkReferenceListIsNeverReadWhileTheConstantIsOff() async {
        XCTAssertFalse(SessionMode.cowork.isAvailable)
        var asked = 0
        let plain = SessionDirectory(lister: { [self] in [row(mode: nil), row(mode: "chat")] },
                                     coworkLister: { asked += 1; return [:] })
        await plain.refresh()
        let withCowork = SessionDirectory(lister: { [self] in [row(mode: "cowork")] },
                                          coworkLister: { asked += 1; return ["s_1": CoworkRowFacts(workspaceId: "w_one")] })
        await withCowork.refresh()
        XCTAssertEqual(asked, 0, "a cowork row in the list sends no extra session.list while Cowork is off")
        XCTAssertEqual(withCowork.rows.count, 1)
        XCTAssertNil(withCowork.rows.first?.cowork)
    }

    // MARK: /spawn

    func testSpawnIsUnassignedWhileClosedAndOpensTheComposerWhenOn() {
        var opened = 0
        XCTAssertNil(dispatchPillCoworkSpawn(modeAvailable: SessionMode.cowork.isAvailable) { opened += 1 })
        XCTAssertNil(dispatchPillCoworkSpawn(modeAvailable: false) { opened += 1 })
        let on = dispatchPillCoworkSpawn(modeAvailable: true) { opened += 1 }
        XCTAssertNotNil(on)
        on?()
        XCTAssertEqual(opened, 1)
    }

    // MARK: Library labels

    private func tool(_ exposure: [String: Bool]) -> WinterCapabilityTool {
        WinterCapabilityTool(name: "mcp__winter__x__t", modes: Array(exposure.keys), deferred: [], exposure: exposure)
    }

    func testTheLibraryNamesCoworkOnlyWhenTheDaemonSendsTheKey() {
        // Today's daemon: three keys, no cowork. Nothing about Cowork is said.
        XCTAssertNil(winterCapabilityExposureText(tool(["code": true, "dispatch": true, "chat": true])))
        XCTAssertEqual(winterCapabilityExposureText(tool(["code": true, "dispatch": true, "chat": false])), "withheld in chat")
        // After the flip: `cowork: false` reads, last, as withheld.
        XCTAssertEqual(winterCapabilityExposureText(tool(["code": true, "dispatch": true, "chat": true, "cowork": false])), "withheld in cowork")
        XCTAssertEqual(winterCapabilityExposureText(tool(["cowork": false, "chat": false, "code": true])), "withheld in chat, cowork")
        XCTAssertEqual(winterCapabilityModesSorted(["cowork", "chat", "code", "dispatch"]), ["code", "dispatch", "chat", "cowork"])
        // A true is not a claim of withholding.
        XCTAssertNil(winterCapabilityExposureText(tool(["code": true, "cowork": true])))
    }

    // MARK: Helpers

    private func appSource(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources").appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }
}

private extension SessionEvent.CoworkSessionCreatedFacts {
    static func fixture(workspaceId: String, location: String) -> SessionEvent.CoworkSessionCreatedFacts {
        let json = #"{"workspaceId":"\#(workspaceId)","projectId":null,"location":"\#(location)","sourceId":null,"policyRevision":1}"#
        return try! JSONDecoder().decode(SessionEvent.CoworkSessionCreatedFacts.self, from: Data(json.utf8))
    }
}
