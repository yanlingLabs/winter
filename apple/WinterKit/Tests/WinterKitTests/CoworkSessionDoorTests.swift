import XCTest
@testable import WinterKit
import WinterProtocol

/// The Mac side of the Cowork session door: the gate, the refusal copy, the session window's notes, the
/// `session.list` decode, and the composer's create-then-send sequence against a scripted daemon.
@MainActor final class CoworkSessionDoorTests: XCTestCase {
    // MARK: Fixtures

    private func capabilities(execution: Bool = true, provisioning: Bool = true) throws -> CoworkCapabilities {
        try JSONDecoder().decode(CoworkCapabilities.self, from: JSONSerialization.data(withJSONObject: [
            "folderPreparation": true, "repositoryPreparation": false, "provisioning": provisioning, "execution": execution,
        ]))
    }
    private func prepared(_ id: String = "sel_one", label: String = "Notes") throws -> CoworkPreparedFolder {
        try JSONDecoder().decode(CoworkPreparedFolder.self, from: JSONSerialization.data(withJSONObject: [
            "selectionId": id, "kind": "folder", "label": label, "access": "read-write", "state": "prepared", "expiresAt": "2099-01-01T00:00:00Z",
        ]))
    }
    private func source(label: String = "Notes", state: String = "preparing", reason: String? = "share_unavailable", desired: String = "present") throws -> CoworkSource {
        try JSONDecoder().decode(CoworkSource.self, from: JSONSerialization.data(withJSONObject: [
            "sourceId": "src_\(label)", "workspaceId": "w_one", "locationId": "loc", "kind": "folder", "label": label, "access": "read-write",
            "desired": desired, "state": state, "revision": 1, "ackRevision": NSNull(), "reason": (reason as Any?) ?? NSNull(), "restartRequired": false,
            "trust": "untrusted", "createdAt": "t", "updatedAt": "t",
        ]))
    }
    private func coded(_ code: String?) -> RpcError {
        RpcError(code: -32602, message: "daemon prose that must never be shown",
                 data: code.map { .object(["code": .string($0)]) })
    }

    /// A scripted daemon: records every call and every `session.create` binding.
    private final class Daemon {
        var calls: [String] = []
        var params: [String: [[String: Any]]] = [:]
        var bindings: [CoworkSessionBinding] = []
        var capsExecution = true, capsProvisioning = true
        var existingPolicy = "ask"
        var configRevision = 4
        var failSessionCreate: [Error] = []
        var failWorkspaceCreate: [Error] = []
        var createdWorkspaces = 0
        var sessionsCreated = 0

        func policy() -> [String: Any] {
            ["policyId": "p", "workspaceId": "w_one", "defaultPolicy": existingPolicy, "publication": "manual",
             "ceiling": ["toolClasses": [], "hostServices": [], "connectors": [], "network": "none"] as [String: Any],
             "revision": 2, "defaultRevision": 1, "publicationRevision": 1]
        }
        func workspace(ownership: String = "standalone") -> [String: Any] {
            ["workspaceId": "w_one", "ownership": ownership, "ownerId": "owner", "title": "Notes", "state": "retained",
             "configRevision": configRevision, "grantRevision": 1, "instructionRevision": 1, "leaseEpoch": 0, "power": "stopped",
             "createdAt": "t", "updatedAt": "t", "automaticPublication": false, "detailState": "complete", "policy": policy(), "sources": []]
        }
        func call(_ method: String, _ value: SessionEvent.JSONValue) throws -> SessionEvent.JSONValue {
            calls.append(method)
            let object = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(value))) as? [String: Any] ?? [:]
            params[method, default: []].append(object)
            func j(_ any: Any) throws -> SessionEvent.JSONValue {
                try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONSerialization.data(withJSONObject: any))
            }
            switch method {
            case "workspace.capabilities.get":
                return try j(["folderPreparation": true, "repositoryPreparation": false, "provisioning": capsProvisioning, "execution": capsExecution])
            case "project.list":
                return try j(["projects": [["projectId": "proj_one", "workspace": workspace(ownership: "project")]], "nextCursor": NSNull()])
            case "workspace.create":
                if !failWorkspaceCreate.isEmpty { throw failWorkspaceCreate.removeFirst() }
                createdWorkspaces += 1
                return try j(["operationId": "op_w", "workspaceId": "w_one", "revision": configRevision, "value": workspace()])
            case "workspace.get":
                return try j(workspace())
            case "workspace.setDefaultPolicy":
                var value = policy(); value["detailState"] = "complete"
                return try j(["operationId": "op_p", "workspaceId": "w_one", "revision": configRevision + 1, "value": value])
            case "workspace.selection.revoke":
                return try j(["revoked": true])
            default:
                throw RpcError(code: -32601, message: "Method not found")
            }
        }
        func createSession(_ binding: CoworkSessionBinding) async throws -> String {
            calls.append("session.create"); bindings.append(binding)
            if !failSessionCreate.isEmpty { throw failSessionCreate.removeFirst() }
            sessionsCreated += 1
            return "s_cowork_\(sessionsCreated)"
        }
    }

    private func model(_ daemon: Daemon, available: Bool = true) -> CoworkComposerModel {
        CoworkComposerModel(modeAvailable: { available }, call: { try daemon.call($0, $1) }, createSession: { try await daemon.createSession($0) })
    }

    // MARK: The gate

    func testTheGateOpensOnlyWhenTheConstantAndTheDaemonBothSayYes() throws {
        let yes = try capabilities()
        XCTAssertTrue(CoworkGate(modeAvailable: true, capabilities: yes).isOpen)
        XCTAssertNil(CoworkGate(modeAvailable: true, capabilities: yes).closedReason)
        // The constant alone, with a daemon claiming everything, opens nothing.
        let off = CoworkGate(modeAvailable: false, capabilities: yes)
        XCTAssertFalse(off.isOpen)
        XCTAssertEqual(off.closedReason, "Cowork isn't available in this Winter yet.")
        XCTAssertFalse(CoworkGate(modeAvailable: true, capabilities: try capabilities(execution: false)).isOpen)
        XCTAssertEqual(CoworkGate(modeAvailable: true, capabilities: try capabilities(execution: false)).closedReason,
                       "This Winter can't run Cowork conversations yet.")
        XCTAssertFalse(CoworkGate(modeAvailable: true, capabilities: try capabilities(provisioning: false)).isOpen)
        XCTAssertEqual(CoworkGate(modeAvailable: true, capabilities: try capabilities(provisioning: false)).closedReason,
                       "Cowork workspace storage isn't ready yet.")
        // A daemon that answers nothing (the default value) is closed.
        XCTAssertFalse(CoworkGate(modeAvailable: true, capabilities: CoworkCapabilities()).isOpen)
    }

    // MARK: Refusal copy

    func testEveryDoorCodeHasItsOwnFixedSentenceAndNeverShowsDaemonProse() {
        let codes = ["unsupported_topology", "provider_unavailable", "conversation_limit", "cold_resume_unavailable",
                     "authority_denied", "not_found", "revision_conflict", "invalid_request", "recovery_required"]
        let texts = codes.map { coworkSessionErrorText(coded($0)) }
        XCTAssertEqual(Set(texts).count, codes.count, "each code reads differently")
        for text in texts {
            XCTAssertFalse(text.contains("daemon prose"))
            XCTAssertFalse(text.isEmpty)
        }
        XCTAssertTrue(coworkSessionErrorText(coded("provider_unavailable")).contains("no model route"))
        XCTAssertTrue(coworkSessionErrorText(coded("conversation_limit")).contains("one at a time"))
        XCTAssertTrue(coworkSessionErrorText(coded("cold_resume_unavailable")).contains("can't resume"))
    }

    func testAnUnknownOrMissingCodeDegradesToTheGenericSentenceWithTheNumericCode() {
        for error in [coded("a_code_from_a_newer_daemon"), coded(nil)] {
            let text = coworkSessionErrorText(error)
            XCTAssertEqual(text, "The Winter daemon could not start this Cowork conversation (error -32602).")
        }
        XCTAssertNil(coded("a_code_from_a_newer_daemon").coworkCode)
        XCTAssertEqual(coded("conversation_limit").coworkCode, .conversationLimit)
        XCTAssertEqual(coded("provider_unavailable").coworkCode, .providerUnavailable)
        XCTAssertEqual(coded("cold_resume_unavailable").coworkCode, .coldResumeUnavailable)
    }

    func testOtherErrorsKeepTheirOwnDescriptionAndAnOlderDaemonIsNamed() {
        struct Offline: LocalizedError { var errorDescription: String? { "The Winter daemon isn't running." } }
        XCTAssertEqual(coworkSessionErrorText(Offline()), "The Winter daemon isn't running.")
        XCTAssertEqual(coworkSessionErrorText(RpcError(code: -32601, message: "Method not found")),
                       "This Winter daemon doesn't support Cowork conversations yet.")
    }

    func testTheNewCodesDoNotClaimToHaveRefusedWithoutEffect() {
        for code in [CoworkRpcCode.providerUnavailable, .conversationLimit, .coldResumeUnavailable] {
            XCTAssertFalse(code.refusedWithoutEffect)
        }
        // And the schedule copy never speaks of a session code as if it knew it.
        XCTAssertEqual(coworkScheduleErrorText(coded("conversation_limit")),
                       "The Winter daemon could not complete this schedule request (error -32602).")
    }

    // MARK: The session list row

    func testRowFactsDecodeFallbackSafe() throws {
        func row(_ cowork: Any?) throws -> JSONValue {
            var base: [String: Any] = ["sessionId": "s_1", "mode": "cowork"]
            if let cowork { base["cowork"] = cowork }
            return try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: base))
        }
        XCTAssertEqual(CoworkRowFacts.decode(row: try row(["workspaceId": "w_one", "projectId": "proj_one"])),
                       CoworkRowFacts(workspaceId: "w_one", projectId: "proj_one"))
        XCTAssertEqual(CoworkRowFacts.decode(row: try row(["workspaceId": "w_one", "projectId": NSNull()])),
                       CoworkRowFacts(workspaceId: "w_one", projectId: nil))
        XCTAssertEqual(CoworkRowFacts.decode(row: try row(["workspaceId": "w_one"])),
                       CoworkRowFacts(workspaceId: "w_one", projectId: nil))
        XCTAssertNil(CoworkRowFacts.decode(row: try row(nil)), "no field: not a Cowork binding")
        XCTAssertNil(CoworkRowFacts.decode(row: try row("w_one")), "a string is not an object")
        XCTAssertNil(CoworkRowFacts.decode(row: try row(["workspaceId": 7])))
        XCTAssertNil(CoworkRowFacts.decode(row: try row(["workspaceId": ""])))
        XCTAssertNil(CoworkRowFacts.decode(row: try row(["projectId": "proj_one"])))
    }

    // MARK: The session window's notes

    func testAClosedGateShowsTheUnavailableStateAndNothingElse() throws {
        let closed = CoworkGate(modeAvailable: false, capabilities: try capabilities())
        let notes = coworkSessionNotes(gate: closed, power: "running", location: "outputs", sources: [try source()])
        XCTAssertEqual(notes.map(\.kind), [.unavailable])
        XCTAssertEqual(notes.first?.text, "Cowork isn't available in this Winter yet.")
    }

    func testAnOpenGateStatesTheOutputsGapAndTheGuidanceGapInEveryWindow() throws {
        let open = CoworkGate(modeAvailable: true, capabilities: try capabilities())
        let notes = coworkSessionNotes(gate: open, power: "running", location: "source", sources: [])
        XCTAssertEqual(notes.map(\.kind), [.outputsNotVisible, .guidanceNotLoaded])
        let g11 = notes.first { $0.kind == .outputsNotVisible }?.text ?? ""
        XCTAssertTrue(g11.contains("VM disk"))
        XCTAssertTrue(g11.contains("can't see them yet"))
        XCTAssertTrue((notes.first { $0.kind == .guidanceNotLoaded }?.text ?? "").contains("isn't loaded in this version"))
    }

    func testThePowerLocationAndSourceNotesAreHonest() throws {
        let open = CoworkGate(modeAvailable: true, capabilities: try capabilities())
        let sources = [try source(label: "Notes", state: "preparing", reason: "share_unavailable"),
                       try source(label: "Other", state: "preparing", reason: nil),
                       try source(label: "Broken", state: "unavailable", reason: nil),
                       try source(label: "Gone", state: "preparing", reason: nil, desired: "removed"),
                       try source(label: "Fine", state: "ready", reason: nil)]
        let notes = coworkSessionNotes(gate: open, power: "starting", location: "outputs", sources: sources)
        XCTAssertEqual(notes.map(\.kind), [.starting, .outputsLocation, .sourcePreparing, .sourcePreparing, .sourceUnavailable,
                                           .outputsNotVisible, .guidanceNotLoaded])
        XCTAssertEqual(Set(notes.map(\.id)).count, notes.count, "ids are unique, so a list can key on them")
        XCTAssertTrue(notes[0].text.contains("two and a half minutes"))
        XCTAssertTrue(notes[1].text.contains("its own outputs folder, not in your Mac folder"))
        XCTAssertTrue(notes[2].text.contains("“Notes” is preparing") && notes[2].text.contains("can't share Mac folders"))
        XCTAssertEqual(notes[3].text, "“Other” is still preparing.")
        XCTAssertFalse(notes.contains { $0.text.contains("Gone") || $0.text.contains("Fine") })
        // `stopped` says nothing: it cannot tell a first start from a stop that cold resume cannot reverse.
        XCTAssertFalse(coworkSessionNotes(gate: open, power: "stopped", location: nil, sources: []).contains { $0.kind == .starting })
        XCTAssertEqual(coworkSessionNotes(gate: open, power: "draining", location: nil, sources: []).first?.kind, .draining)
        XCTAssertEqual(coworkSessionNotes(gate: open, power: "uncertain", location: nil, sources: []).first?.kind, .uncertain)
    }

    // MARK: The composer: unreachable while the gate is closed

    func testWhileTheConstantIsOffNoRequestOfAnyKindIsSent() async throws {
        let daemon = Daemon(); let composer = model(daemon, available: false)
        composer.chooseFolder(try prepared())
        await composer.refresh()
        let started = await composer.start(draft: "plan my week")
        XCTAssertNil(started)
        XCTAssertEqual(daemon.calls, [], "not even a read: workspace.create and session.create are unreachable")
        XCTAssertEqual(composer.phase, .failed("Cowork isn't available in this Winter yet."))
        XCTAssertFalse(composer.isOpen)
        XCTAssertEqual(composer.blockedReason(draft: "plan my week"), "Cowork isn't available in this Winter yet.")
        XCTAssertTrue(composer.projects.isEmpty)
        // Even with the daemon claiming everything, the constant wins.
        XCTAssertEqual(daemon.sessionsCreated, 0)
        XCTAssertEqual(daemon.createdWorkspaces, 0)
    }

    func testAConstantOnButADaemonThatCannotRunConversationsCreatesNothing() async throws {
        let daemon = Daemon(); daemon.capsExecution = false
        let composer = model(daemon)
        composer.chooseFolder(try prepared())
        let started = await composer.start(draft: "hello")
        XCTAssertNil(started)
        XCTAssertEqual(daemon.calls, ["workspace.capabilities.get"])
        XCTAssertEqual(composer.phase, .failed("This Winter can't run Cowork conversations yet."))
        daemon.capsExecution = true; daemon.capsProvisioning = false
        _ = await composer.start(draft: "hello")
        XCTAssertFalse(daemon.calls.contains("workspace.create") || daemon.calls.contains("session.create"))
        XCTAssertEqual(composer.phase, .failed("Cowork workspace storage isn't ready yet."))
    }

    func testPickingAFolderIsRefusedWhileClosed() async throws {
        let daemon = Daemon(); let composer = model(daemon, available: false)
        var prepareCalls = 0
        await composer.pickFolder { prepareCalls += 1; return try self.prepared() }
        XCTAssertEqual(prepareCalls, 0, "the host is never asked to prepare a folder for a closed Cowork")
        XCTAssertNil(composer.folder)
        XCTAssertEqual(composer.folderError, "Cowork isn't available in this Winter yet.")
    }

    // MARK: The composer: the sequence

    func testANewFolderCreatesAStandaloneWorkspaceThenAnOutputsSession() async throws {
        let daemon = Daemon(); let composer = model(daemon)
        composer.chooseFolder(try prepared("sel_one", label: "Notes"))
        let started = await composer.start(draft: "summarize the notes")
        XCTAssertEqual(started, CoworkComposerModel.Started(sessionId: "s_cowork_1", workspaceId: "w_one"))
        XCTAssertEqual(daemon.calls, ["workspace.capabilities.get", "workspace.create", "session.create"])
        let create = try XCTUnwrap(daemon.params["workspace.create"]?.first)
        XCTAssertEqual(create["ownership"] as? String, "standalone")
        XCTAssertEqual(create["title"] as? String, "Notes")
        let selections = create["selections"] as? [[String: String]]
        XCTAssertEqual(selections, [["selectionId": "sel_one", "kind": "folder"]])
        let binding = try XCTUnwrap(daemon.bindings.first)
        XCTAssertEqual(binding.workspaceId, "w_one")
        XCTAssertEqual(binding.location, .outputs, "the first session works in its own outputs folder")
        XCTAssertNil(composer.folder, "a started conversation retires the choice")
        XCTAssertEqual(composer.phase, .idle)
    }

    func testAChosenApprovalModeIsWrittenAsTheWorkspaceDefaultAtItsOwnRevision() async throws {
        let daemon = Daemon(); daemon.existingPolicy = "ask"; daemon.configRevision = 7
        let composer = model(daemon)
        composer.chooseFolder(try prepared()); composer.setApproval(.auto)
        _ = await composer.start(draft: "go")
        XCTAssertEqual(daemon.calls, ["workspace.capabilities.get", "workspace.create", "workspace.get", "workspace.setDefaultPolicy", "session.create"])
        let write = try XCTUnwrap(daemon.params["workspace.setDefaultPolicy"]?.first)
        XCTAssertEqual(write["defaultPolicy"] as? String, "auto")
        XCTAssertEqual(write["expectedRevision"] as? Int, 7)
        XCTAssertEqual(write["workspaceId"] as? String, "w_one")
    }

    func testAnApprovalModeEqualToTheWorkspaceDefaultWritesNothing() async throws {
        let daemon = Daemon(); daemon.existingPolicy = "auto"
        let composer = model(daemon)
        composer.chooseFolder(try prepared()); composer.setApproval(.auto)
        _ = await composer.start(draft: "go")
        XCTAssertFalse(daemon.calls.contains("workspace.setDefaultPolicy"))
        XCTAssertTrue(daemon.calls.contains("session.create"))
    }

    func testAnExistingProjectCreatesNoWorkspace() async throws {
        let daemon = Daemon(); let composer = model(daemon)
        await composer.refresh()
        XCTAssertEqual(composer.projects.count, 1)
        composer.chooseProject(try XCTUnwrap(composer.projects.first))
        let started = await composer.start(draft: "go")
        XCTAssertNotNil(started)
        XCTAssertFalse(daemon.calls.contains("workspace.create"))
        XCTAssertEqual(daemon.bindings.first?.workspaceId, "w_one")
    }

    func testALostSessionCreateRetriesIntoTheSameWorkspaceWithTheSameRequestIds() async throws {
        let daemon = Daemon()
        daemon.failSessionCreate = [coded("provider_unavailable")]
        let composer = model(daemon)
        composer.chooseFolder(try prepared())
        let first = await composer.start(draft: "go")
        XCTAssertNil(first)
        XCTAssertEqual(composer.phase, .failed(coworkSessionErrorText(coded("provider_unavailable"))))
        XCTAssertEqual(daemon.createdWorkspaces, 1)
        let second = await composer.start(draft: "go")
        XCTAssertNotNil(second)
        XCTAssertEqual(daemon.createdWorkspaces, 1, "the acknowledged workspace is reused, never created twice")
        XCTAssertEqual(daemon.params["workspace.create"]?.count, 1)
        XCTAssertEqual(daemon.bindings.count, 2)
        XCTAssertEqual(daemon.bindings[0].requestId, daemon.bindings[1].requestId, "the replay carries the same idempotency key")
    }

    func testALostWorkspaceCreateReplaysWithTheSameRequestId() async throws {
        let daemon = Daemon()
        daemon.failWorkspaceCreate = [NSError(domain: "lost-response", code: 1)]
        let composer = model(daemon)
        composer.chooseFolder(try prepared())
        _ = await composer.start(draft: "go")
        _ = await composer.start(draft: "go")
        let ids = (daemon.params["workspace.create"] ?? []).compactMap { $0["requestId"] as? String }
        XCTAssertEqual(ids.count, 2)
        XCTAssertEqual(Set(ids).count, 1)
        XCTAssertEqual(daemon.sessionsCreated, 1)
    }

    func testChangingTheIntentRetiresTheOldIds() async throws {
        let daemon = Daemon()
        daemon.failSessionCreate = [coded("conversation_limit"), coded("conversation_limit")]
        let composer = model(daemon)
        composer.chooseFolder(try prepared("sel_one"))
        _ = await composer.start(draft: "go")
        composer.chooseFolder(try prepared("sel_two"))
        _ = await composer.start(draft: "go")
        let ids = (daemon.params["workspace.create"] ?? []).compactMap { $0["requestId"] as? String }
        XCTAssertEqual(Set(ids).count, 2, "a different folder is a different intent")
        XCTAssertEqual(Set(daemon.bindings.map(\.requestId)).count, 2)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(daemon.params["workspace.selection.revoke"], "sel_one became a source; releasing it would be wrong")
    }

    func testAReplacedUnusedSelectionIsReleased() async throws {
        let daemon = Daemon(); let composer = model(daemon)
        composer.chooseFolder(try prepared("sel_one"))
        composer.chooseFolder(try prepared("sel_two"))
        composer.clearFolder()
        try await Task.sleep(nanoseconds: 50_000_000)
        let revoked = (daemon.params["workspace.selection.revoke"] ?? []).compactMap { $0["selectionId"] as? String }
        XCTAssertEqual(revoked, ["sel_one", "sel_two"])
    }

    func testEachRefusalReachesThePhaseAsItsOwnFixedSentence() async throws {
        for code in ["provider_unavailable", "conversation_limit", "cold_resume_unavailable", "unsupported_topology"] {
            let daemon = Daemon(); daemon.failSessionCreate = [coded(code)]
            let composer = model(daemon)
            composer.chooseFolder(try prepared())
            _ = await composer.start(draft: "go")
            XCTAssertEqual(composer.phase, .failed(coworkSessionErrorText(coded(code))), code)
            composer.dismissFailure()
            XCTAssertEqual(composer.phase, .idle)
        }
    }

    func testSendNeedsAFolderAndADraftAndSaysWhy() async throws {
        let daemon = Daemon(); let composer = model(daemon)
        await composer.refresh()
        XCTAssertTrue(composer.isOpen)
        XCTAssertEqual(composer.blockedReason(draft: "   "), "")
        XCTAssertEqual(composer.blockedReason(draft: "hello"), "Choose a folder first")
        composer.chooseFolder(try prepared())
        XCTAssertNil(composer.blockedReason(draft: "hello"))
        let started = await composer.start(draft: "hello")
        XCTAssertNotNil(started)
        daemon.calls.removeAll()
        // No folder left, no empty send.
        let empty = await composer.start(draft: "")
        XCTAssertNil(empty)
        XCTAssertEqual(daemon.calls, [])
    }

    func testTheWorkspaceTitleIsAlwaysValid() {
        XCTAssertEqual(CoworkComposerModel.workspaceTitle(folder: "Notes", draft: "x"), "Notes")
        XCTAssertEqual(CoworkComposerModel.workspaceTitle(folder: "  ", draft: "plan\nmy week"), "plan my week")
        XCTAssertEqual(CoworkComposerModel.workspaceTitle(folder: "", draft: ""), "Cowork workspace")
        let long = String(repeating: "a", count: 500)
        XCTAssertTrue(CoworkWorkspaceModel.validTitle(CoworkComposerModel.workspaceTitle(folder: long, draft: "")))
    }
}

@MainActor final class CoworkComposerCopyTests: XCTestCase {
    private func prepared(_ label: String) throws -> CoworkPreparedFolder {
        try JSONDecoder().decode(CoworkPreparedFolder.self, from: JSONSerialization.data(withJSONObject: [
            "selectionId": "sel_one", "kind": "folder", "label": label, "access": "read-write", "state": "prepared", "expiresAt": "2099-01-01T00:00:00Z",
        ]))
    }

    func testTheFolderChipNeverPromisesAMount() throws {
        XCTAssertEqual(coworkFolderChipCopy(nil).title, "Choose folder")
        let chosen = coworkFolderChipCopy(.newWorkspace(try prepared("Notes")))
        XCTAssertEqual(chosen.title, "Notes")
        XCTAssertTrue(chosen.help.contains("stays preparing"))
        XCTAssertTrue(chosen.help.contains("its own outputs folder"))
        XCTAssertFalse(chosen.help.lowercased().contains("mounted in"), "no claim the folder is mounted")
        let project = coworkFolderChipCopy(.existingProject(workspaceId: "w_one", title: "Atlas"))
        XCTAssertEqual(project.title, "Atlas")
        XCTAssertTrue(project.help.contains("shares the Project's folders and approval mode"))
        XCTAssertTrue(coworkFolderPickerNote.contains("can't share Mac folders"))
    }

    func testTheApprovalChipSaysItIsTheWorkspacesDefault() {
        XCTAssertEqual(coworkApprovalChipCopy(nil).title, "Approval mode")
        let auto = coworkApprovalChipCopy(.auto)
        XCTAssertEqual(auto.title, "Auto")
        XCTAssertTrue(auto.help.contains("every conversation in it"))
        XCTAssertTrue(coworkApprovalPickerNote.contains("every conversation"))
        XCTAssertEqual(coworkApprovalChipCopy(.dontAsk).title, "Don't Ask")
        XCTAssertEqual(coworkApprovalChipCopy(.acceptEdits).title, "Accept Edits")
    }
}

@MainActor final class CoworkSessionWindowModelTests: XCTestCase {
    private final class Daemon {
        var calls: [String] = []
        var power = "starting"
        var executionOn = true
        var fail = false
        func call(_ method: String, _ value: SessionEvent.JSONValue) throws -> SessionEvent.JSONValue {
            calls.append(method)
            func j(_ any: Any) throws -> SessionEvent.JSONValue {
                try JSONDecoder().decode(SessionEvent.JSONValue.self, from: JSONSerialization.data(withJSONObject: any))
            }
            switch method {
            case "workspace.capabilities.get":
                return try j(["folderPreparation": true, "repositoryPreparation": false, "provisioning": true, "execution": executionOn])
            case "workspace.get":
                if fail { throw NSError(domain: "down", code: 1) }
                return try j(["workspaceId": "w_one", "ownership": "standalone", "ownerId": "o", "title": "Notes", "state": "retained",
                              "configRevision": 3, "grantRevision": 1, "instructionRevision": 1, "leaseEpoch": 0, "power": power,
                              "createdAt": "t", "updatedAt": "t", "automaticPublication": false, "detailState": "complete",
                              "policy": ["policyId": "p", "workspaceId": "w_one", "defaultPolicy": "ask", "publication": "manual",
                                         "ceiling": ["toolClasses": [], "hostServices": [], "connectors": [], "network": "none"] as [String: Any],
                                         "revision": 1, "defaultRevision": 1, "publicationRevision": 1] as [String: Any],
                              "sources": []])
            case "workspace.source.list":
                return try j(["sources": [["sourceId": "src_one", "workspaceId": "w_one", "locationId": "loc", "kind": "folder", "label": "Notes",
                                           "access": "read-write", "desired": "present", "state": "preparing", "revision": 1, "ackRevision": NSNull(),
                                           "reason": "share_unavailable", "restartRequired": false, "trust": "untrusted", "createdAt": "t", "updatedAt": "t"]],
                              "nextCursor": NSNull()])
            default: throw RpcError(code: -32601, message: "Method not found")
            }
        }
    }

    func testAClosedGateReadsNothing() async {
        let daemon = Daemon()
        let model = CoworkSessionWindowModel(modeAvailable: { false }, call: { try daemon.call($0, $1) })
        model.bind(workspaceId: "w_one")
        await model.refresh()
        XCTAssertEqual(daemon.calls, [])
        XCTAssertEqual(model.notes(location: "outputs").map(\.kind), [.unavailable])
    }

    func testAnOpenWindowShowsPowerSourcesAndTheTwoGapsAndPollsFastWhileStarting() async {
        let daemon = Daemon()
        let model = CoworkSessionWindowModel(modeAvailable: { true }, call: { try daemon.call($0, $1) })
        model.bind(workspaceId: "w_one")
        await model.refresh()
        XCTAssertEqual(model.power, "starting")
        XCTAssertEqual(model.pollSeconds, 3)
        XCTAssertEqual(model.notes(location: "outputs").map(\.kind),
                       [.starting, .outputsLocation, .sourcePreparing, .outputsNotVisible, .guidanceNotLoaded])
        daemon.power = "running"
        await model.refresh()
        XCTAssertEqual(model.pollSeconds, 15)
        XCTAssertFalse(model.notes(location: "outputs").contains { $0.kind == .starting })
    }

    func testADaemonThatCannotRunConversationsClosesTheWindowEvenWithTheConstantOn() async {
        let daemon = Daemon(); daemon.executionOn = false
        let model = CoworkSessionWindowModel(modeAvailable: { true }, call: { try daemon.call($0, $1) })
        model.bind(workspaceId: "w_one")
        await model.refresh()
        XCTAssertEqual(daemon.calls, ["workspace.capabilities.get"])
        XCTAssertEqual(model.notes(location: nil).map(\.kind), [.unavailable])
    }

    func testAFailedReadKeepsWhatWasShownAndABindingChangeDropsIt() async {
        let daemon = Daemon()
        let model = CoworkSessionWindowModel(modeAvailable: { true }, call: { try daemon.call($0, $1) })
        model.bind(workspaceId: "w_one")
        await model.refresh()
        daemon.fail = true
        await model.refresh()
        XCTAssertEqual(model.power, "starting", "an outage does not blank a window that was telling the truth")
        model.bind(workspaceId: "w_two")
        XCTAssertNil(model.power)
        XCTAssertTrue(model.sources.isEmpty)
        model.bind(workspaceId: nil)
        await model.refresh()
        XCTAssertEqual(daemon.calls.filter { $0 == "workspace.get" }.count, 2, "no workspace, no read")
    }
}
