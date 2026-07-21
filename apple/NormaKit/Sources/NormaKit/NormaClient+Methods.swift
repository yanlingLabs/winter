import Foundation
import NormaProtocol

// MARK: - Plugin lifecycle result types (Phase 4d-ii Task 3)
//
// Wire results for the 5 lifecycle RPCs + shortcut.invoke/tile.action are typed unions that never
// throw for an EXPECTED outcome (methods.ts: PluginsInstallResult/PluginEnableResult/
// PluginDisableResult/PluginRemoveResult/PluginSetConsentResult/PluginPushResult — same discipline
// as HardwareRequestResult). Mapped here to Swift enums rather than thrown errors, so a caller can
// switch exhaustively on an expected business outcome instead of catching for it; `RpcError` is
// reserved for genuine protocol misuse (malformed/unrecognized result shape), mirroring how the
// rest of this file throws `RpcError(code: -3, ...)` only for "the server sent nonsense".

/// `plugins.install {source, name?}` result (methods.ts `PluginsInstallResult`).
public enum PluginsInstallOutcome: Equatable, Sendable {
    case ok(name: String, requiredConsents: [String], hasMcp: Bool, consentBlock: [String])
    case invalidSource
    case alreadyInstalled(name: String)
}

/// `plugin.enable {name, consent?}` result (methods.ts `PluginEnableResult`) — the two-step
/// consent flow: no/false `consent` with outstanding required classes returns `.needsConsent`
/// (no mutation); re-calling with `consent: true` grants + enables, returning `.ok(status:)`.
public enum PluginEnableOutcome: Equatable, Sendable {
    case ok(status: String)
    case needsConsent(requiredConsents: [String], consentBlock: [String])
    case unknownPlugin
}

/// Shared by `plugin.disable`/`plugin.remove`/`plugin.setConsent` — all three wire results are
/// `{ok:true}` | `{code:"unknown_plugin"}` (methods.ts).
public enum PluginLifecycleOutcome: Equatable, Sendable {
    case ok
    case unknownPlugin
}

/// Shared by `shortcut.invoke`/`tile.action` (methods.ts `PluginPushResult`) — the push either
/// reached the plugin's live connection or it didn't; there is no payload to round-trip.
public enum PluginPushOutcome: Equatable, Sendable {
    case ok
    case notConnected
    case unknownPlugin
}

/// One entry of `plugins.contrib`'s result (methods.ts `PluginContribEntrySchema`) — a plugin's
/// currently-registered shortcuts/tile/provider contribution, mirrored field-for-field.
public struct PluginShortcutInfo: Equatable, Sendable {
    public let id: String
    public let description: String?
    public let defaultKeybinding: String?
}

public struct PluginContribEntry: Equatable, Sendable {
    public let pluginId: String
    public let shortcuts: [PluginShortcutInfo]
    public let tile: [String: JSONValue]?
    public let provider: [String: JSONValue]?
}

extension JSONValue {
    /// Not in JSONValue.swift's core accessor set (stringValue/boolValue/intValue/arrayValue) —
    /// added here since `plugins.contrib`'s `tile`/`provider` fields are opaque JSON objects
    /// (`z.record(...)` on the wire) that need to come back as `[String: JSONValue]` rather than
    /// a further-decoded shape core doesn't validate either.
    var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
}

extension NormaClient {
    private func obj(_ pairs: [String: JSONValue?]) -> JSONValue {
        .object(pairs.compactMapValues { $0 })
    }

    /// `{code:"unknown_plugin"}` | `{ok:true}` decode shared by disable/remove/setConsent.
    private func decodeLifecycleOutcome(_ r: JSONValue, method: String) throws -> PluginLifecycleOutcome {
        if let code = r["code"]?.stringValue {
            if code == "unknown_plugin" { return .unknownPlugin }
            throw RpcError(code: -3, message: "unknown code from server for \(method): \(code)")
        }
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "invalid result from server for \(method)")
        }
        return .ok
    }

    /// `{code:"not_connected"|"unknown_plugin"}` | `{ok:true}` decode shared by shortcut.invoke/tile.action.
    private func decodePushOutcome(_ r: JSONValue, method: String) throws -> PluginPushOutcome {
        if let code = r["code"]?.stringValue {
            switch code {
            case "not_connected": return .notConnected
            case "unknown_plugin": return .unknownPlugin
            default: throw RpcError(code: -3, message: "unknown code from server for \(method): \(code)")
            }
        }
        guard r["ok"]?.boolValue == true else {
            throw RpcError(code: -3, message: "invalid result from server for \(method)")
        }
        return .ok
    }

    /// `plugins.install {source, name?}` (Phase 4d-ii Task 2) — copies a local directory into the
    /// daemon's plugins root, installed DISABLED + UNCONSENTED; the `.ok` case's
    /// `requiredConsents`/`consentBlock` drive a consent sheet before `pluginEnable(consent:true)`.
    public func pluginsInstall(source: String, name: String? = nil) async throws -> PluginsInstallOutcome {
        let r = try await request("plugins.install", params: obj([
            "source": .string(source), "name": name.map { .string($0) },
        ]))
        if let code = r["code"]?.stringValue {
            switch code {
            case "invalid_source": return .invalidSource
            case "already_installed":
                guard let n = r["name"]?.stringValue else {
                    throw RpcError(code: -3, message: "invalid result from server for plugins.install")
                }
                return .alreadyInstalled(name: n)
            default:
                throw RpcError(code: -3, message: "unknown code from server for plugins.install: \(code)")
            }
        }
        guard let n = r["name"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for plugins.install")
        }
        return .ok(
            name: n,
            requiredConsents: (r["requiredConsents"]?.arrayValue ?? []).compactMap { $0.stringValue },
            hasMcp: r["hasMcp"]?.boolValue ?? false,
            consentBlock: (r["consentBlock"]?.arrayValue ?? []).compactMap { $0.stringValue }
        )
    }

    /// `plugin.enable {name, consent?}` (Phase 4d-ii Task 2) — see `PluginEnableOutcome`.
    public func pluginEnable(name: String, consent: Bool? = nil) async throws -> PluginEnableOutcome {
        let r = try await request("plugin.enable", params: obj([
            "name": .string(name), "consent": consent.map { .bool($0) },
        ]))
        if let code = r["code"]?.stringValue {
            switch code {
            case "needs_consent":
                return .needsConsent(
                    requiredConsents: (r["requiredConsents"]?.arrayValue ?? []).compactMap { $0.stringValue },
                    consentBlock: (r["consentBlock"]?.arrayValue ?? []).compactMap { $0.stringValue }
                )
            case "unknown_plugin": return .unknownPlugin
            default: throw RpcError(code: -3, message: "unknown code from server for plugin.enable: \(code)")
            }
        }
        guard let status = r["status"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for plugin.enable")
        }
        return .ok(status: status)
    }

    /// `plugin.disable {name}` (Phase 4d-ii Task 2) — fresh-consent semantics: hot-stops any
    /// running process AND strips the recorded consent (re-enabling requires consenting again).
    public func pluginDisable(name: String) async throws -> PluginLifecycleOutcome {
        let r = try await request("plugin.disable", params: obj(["name": .string(name)]))
        return try decodeLifecycleOutcome(r, method: "plugin.disable")
    }

    /// `plugin.remove {name}` (Phase 4d-ii Task 2) — hot-stops, then strips settings/consent/dir.
    public func pluginRemove(name: String) async throws -> PluginLifecycleOutcome {
        let r = try await request("plugin.remove", params: obj(["name": .string(name)]))
        return try decodeLifecycleOutcome(r, method: "plugin.remove")
    }

    /// `plugin.setConsent {name, classes}` (Phase 4d-ii Task 2) — records consent WITHOUT
    /// enabling; the common path is `pluginEnable(consent:true)` instead.
    public func pluginSetConsent(name: String, classes: [String]) async throws -> PluginLifecycleOutcome {
        let r = try await request("plugin.setConsent", params: obj([
            "name": .string(name), "classes": .array(classes.map { .string($0) }),
        ]))
        return try decodeLifecycleOutcome(r, method: "plugin.setConsent")
    }

    /// `plugin.restart {pluginId}` (final-review Fix 1 / wired here for Phase 4d-iii Task 2's
    /// PluginManagerView "Restart" action) — the manual-restart rider (`PluginSupervisor.restart`)
    /// that recovers a Tier-2 plugin stuck in backoff/circuit-open without a daemon restart. Unlike
    /// the 5 lifecycle RPCs above, the server has no typed failure result for this one — an unknown
    /// plugin id throws a bare `RpcFailure(NOT_FOUND, ...)`, which `request(...)` already surfaces
    /// as a thrown `RpcError`, so there's no outcome enum to decode here.
    public func pluginRestart(name: String) async throws {
        _ = try await request("plugin.restart", params: obj(["pluginId": .string(name)]))
    }

    /// `shortcut.invoke {pluginId, shortcutId}` (Phase 4d-i Task 2) — pushes a `shortcut_invoke`
    /// event to that plugin's own live connection; fire-and-forget on the plugin side.
    public func shortcutInvoke(pluginId: String, shortcutId: String) async throws -> PluginPushOutcome {
        let r = try await request("shortcut.invoke", params: obj([
            "pluginId": .string(pluginId), "shortcutId": .string(shortcutId),
        ]))
        return try decodePushOutcome(r, method: "shortcut.invoke")
    }

    /// `tile.action {pluginId, actionId}` (Phase 4d-i Task 2) — pushes a `tile_action` event to
    /// that plugin's own live connection; fire-and-forget on the plugin side.
    public func tileAction(pluginId: String, actionId: String) async throws -> PluginPushOutcome {
        let r = try await request("tile.action", params: obj([
            "pluginId": .string(pluginId), "actionId": .string(actionId),
        ]))
        return try decodePushOutcome(r, method: "tile.action")
    }

    /// `plugins.contrib` (Phase 4d-i Task 1) — read surface for every plugin's currently-registered
    /// shortcuts/tile/provider contribution (harness/admin only, not plugin-role).
    public func pluginsContrib() async throws -> [PluginContribEntry] {
        let r = try await request("plugins.contrib", params: .object([:]))
        return (r["entries"]?.arrayValue ?? []).compactMap { e in
            guard let pluginId = e["pluginId"]?.stringValue else { return nil }
            let shortcuts = (e["shortcuts"]?.arrayValue ?? []).compactMap { s -> PluginShortcutInfo? in
                guard let id = s["id"]?.stringValue else { return nil }
                return PluginShortcutInfo(id: id, description: s["description"]?.stringValue, defaultKeybinding: s["default"]?.stringValue)
            }
            return PluginContribEntry(pluginId: pluginId, shortcuts: shortcuts, tile: e["tile"]?.objectValue, provider: e["provider"]?.objectValue)
        }
    }

    public func createSession(scope: String, cwd: String? = nil, approvalPolicy: String? = nil) async throws -> (sessionId: String, trusted: Bool) {
        let r = try await request("session.create", params: obj([
            "scope": .string(scope),
            "cwd": cwd.map { .string($0) },
            "approvalPolicy": approvalPolicy.map { .string($0) },
        ]))
        guard let id = r["sessionId"]?.stringValue, let trusted = r["trusted"]?.boolValue else {
            throw RpcError(code: -3, message: "invalid result from server for session.create")
        }
        return (id, trusted)
    }

    /// `session.dispatch {}` (Phase 7): get-or-create the ONE permanent dispatch session.
    public func dispatchSession() async throws -> (sessionId: String, created: Bool) {
        let r = try await request("session.dispatch", params: nil)
        guard let id = r["sessionId"]?.stringValue, let created = r["created"]?.boolValue else {
            throw RpcError(code: -3, message: "invalid result from server for session.dispatch")
        }
        return (id, created)
    }

    public func listSessions() async throws -> [(sessionId: String, scope: String, createdAt: Int, lastSeq: Int, title: String?, cwd: String?, mode: String?, parentSessionId: String?)] {
        let r = try await request("session.list", params: nil)
        return (r["sessions"]?.arrayValue ?? []).compactMap { s in
            guard let id = s["sessionId"]?.stringValue, let scope = s["scope"]?.stringValue,
                  let created = s["createdAt"]?.intValue, let last = s["lastSeq"]?.intValue else { return nil }
            return (id, scope, created, last, s["title"]?.stringValue, s["cwd"]?.stringValue, s["mode"]?.stringValue, s["parentSessionId"]?.stringValue)
        }
    }

    /// Attaches (server replays events with seq > fromSeq). Seeds the client-side dedupe
    /// watermark BEFORE the request so replayed events pass `seq > lastSeq`.
    ///
    /// AMENDMENT 5 (carried from Task 8 review): seeding before the await is deliberate (replay
    /// race safety), but that left attachedSessionId/lastSeq corrupted if the request threw.
    /// Snapshot the previous values and restore them on any failure before rethrowing.
    public func attach(sessionId: String, fromSeq: Int = 0) async throws -> Int {
        let previousSessionId = attachedSessionId
        let previousLastSeq = lastSeq
        attachedSessionId = sessionId
        lastSeq = fromSeq
        do {
            let r = try await request("session.attach", params: obj([
                "sessionId": .string(sessionId), "fromSeq": .number(Double(fromSeq)),
            ]))
            guard let last = r["lastSeq"]?.intValue else { throw RpcError(code: -3, message: "invalid result from server for session.attach") }
            return last
        } catch {
            attachedSessionId = previousSessionId
            lastSeq = previousLastSeq
            throw error
        }
    }

    public func send(sessionId: String, text: String) async throws -> Int {
        let r = try await request("session.send", params: obj(["sessionId": .string(sessionId), "text": .string(text)]))
        guard let seq = r["seq"]?.intValue else { throw RpcError(code: -3, message: "invalid result from server for session.send") }
        return seq
    }

    public func steer(sessionId: String, text: String) async throws -> Bool {
        try await request("session.steer", params: obj(["sessionId": .string(sessionId), "text": .string(text)]))["injected"]?.boolValue ?? false
    }

    public func interrupt(sessionId: String) async throws -> Bool {
        try await request("session.interrupt", params: obj(["sessionId": .string(sessionId)]))["wasRunning"]?.boolValue ?? false
    }

    public func compact(sessionId: String) async throws -> (compacted: Bool, uptoSeq: Int) {
        let r = try await request("session.compact", params: obj(["sessionId": .string(sessionId)]))
        return (r["compacted"]?.boolValue ?? false, r["uptoSeq"]?.intValue ?? 0)
    }

    /// `optionId` (SP-approvals T6): the allow-rule choice the caller picked, when the card carried
    /// `options` (`SessionEvent.ApprovalRequested.options` — Task 4/5's protocol+engine work).
    /// Optional/defaulted so every pre-existing call site keeps compiling unchanged; `obj(...)`'s
    /// `compactMapValues` (above) omits the `"optionId"` key entirely when `nil`, same convention as
    /// `planRespond`'s `feedback`/`askUserRespond`'s `notes` — an older daemon that doesn't know
    /// about rule options simply never sees the key and treats the respond as plain allow/deny.
    public func approvalRespond(sessionId: String, callId: String, approved: Bool, optionId: String? = nil) async throws -> Bool {
        try await request("approval.respond", params: obj([
            "sessionId": .string(sessionId), "callId": .string(callId), "approved": .bool(approved),
            "optionId": optionId.map { .string($0) },
        ]))["alreadyResolved"]?.boolValue ?? false
    }

    /// `notes` — CC AskUserQuestion parity, free-text notes keyed by question text like `answers`
    /// (`packages/protocol/src/methods.ts`'s `AskUserRespondParams.notes`). Optional/defaulted so
    /// existing no-notes call sites keep compiling unchanged; `obj(...)`'s `compactMapValues`
    /// (above) omits the `"notes"` key entirely when `nil`, matching `planRespond`'s own
    /// `feedback.map { .string($0) }` convention for an optional param.
    public func askUserRespond(sessionId: String, callId: String, answers: [String: String], notes: [String: String]? = nil) async throws -> Bool {
        try await request("ask_user.respond", params: obj([
            "sessionId": .string(sessionId), "callId": .string(callId),
            "answers": .object(answers.mapValues { .string($0) }),
            "notes": notes.map { .object($0.mapValues { .string($0) }) },
        ]))["alreadyResolved"]?.boolValue ?? false
    }

    public func planRespond(sessionId: String, callId: String, approved: Bool, autoAccept: Bool = false, feedback: String? = nil) async throws -> Bool {
        try await request("plan.respond", params: obj([
            "sessionId": .string(sessionId), "callId": .string(callId),
            "approved": .bool(approved), "autoAccept": .bool(autoAccept),
            "feedback": feedback.map { .string($0) },
        ]))["alreadyResolved"]?.boolValue ?? false
    }

    public func setPolicy(sessionId: String, policy: String) async throws {
        _ = try await request("session.setPolicy", params: obj(["sessionId": .string(sessionId), "policy": .string(policy)]))
    }

    public func taskList(sessionId: String) async throws -> [(id: String, subject: String, status: String, activeForm: String?)] {
        let r = try await request("task.list", params: obj(["sessionId": .string(sessionId)]))
        return (r["tasks"]?.arrayValue ?? []).compactMap { t in
            guard let id = t["id"]?.stringValue, let subject = t["subject"]?.stringValue, let status = t["status"]?.stringValue else { return nil }
            return (id, subject, status, t["activeForm"]?.stringValue)
        }
    }

    public func threadList(sessionId: String) async throws -> [(threadId: String, parentThreadId: String?, agentType: String?, status: String, stopReason: String?)] {
        let r = try await request("thread.list", params: obj(["sessionId": .string(sessionId)]))
        return (r["threads"]?.arrayValue ?? []).compactMap { t in
            guard let id = t["threadId"]?.stringValue, let status = t["status"]?.stringValue else { return nil }
            return (id, t["parentThreadId"]?.stringValue, t["agentType"]?.stringValue, status, t["stopReason"]?.stringValue)
        }
    }

    /// `thread.send {sessionId, agent, text}` (child-transcript-view T1) — message a background
    /// subagent directly, by agentId or its stable `name`. Mirrors `steer`'s shape (a plain wire
    /// result, never a typed outcome union — an unresolvable `agent` throws `RpcError`, same
    /// precedent as `pluginRestart`'s "unknown id" case). `delivered` is `"queued"` (the agent was
    /// running; `text` lands in its own steer queue at its next round) or `"resumed"` (the agent
    /// was finished and was just re-run in the background with `text` as its new prompt).
    /// `agentId` is the stable bg-agent-registry id, even when `agent` addressed it by name.
    public func sendToThread(sessionId: String, agent: String, text: String) async throws -> (delivered: String, agentId: String) {
        let r = try await request("thread.send", params: obj([
            "sessionId": .string(sessionId), "agent": .string(agent), "text": .string(text),
        ]))
        guard let delivered = r["delivered"]?.stringValue, let agentId = r["agentId"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for thread.send")
        }
        return (delivered, agentId)
    }

    /// `agent.stop {sessionId, agent}` (child-transcript-view T1) — stop a running background
    /// subagent, or (idempotently) report an already-finished one's status; never an error for a
    /// resolvable `agent` (task_stop tool parity). `status` is one of `BackgroundAgentRegistry
    /// .AgentStatus`'s wire strings ("running"/"completed"/"failed"/"stopped"/"timeout") — "running"
    /// never actually comes back here, since a running agent is always flipped to "stopped".
    public func agentStop(sessionId: String, agent: String) async throws -> String {
        guard let status = try await request("agent.stop", params: obj([
            "sessionId": .string(sessionId), "agent": .string(agent),
        ]))["status"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for agent.stop")
        }
        return status
    }

    public func addDir(sessionId: String, path: String, persist: Bool = false) async throws -> [String] {
        let r = try await request("session.addDir", params: obj([
            "sessionId": .string(sessionId), "path": .string(path), "persist": .bool(persist),
        ]))
        return (r["roots"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }

    public func setCwd(sessionId: String, cwd: String) async throws -> String {
        try await request("session.setCwd", params: obj(["sessionId": .string(sessionId), "cwd": .string(cwd)]))["cwd"]?.stringValue ?? cwd
    }

    public func trustDir(path: String) async throws -> Bool {
        try await request("daemon.trustDir", params: obj(["path": .string(path)]))["trusted"]?.boolValue ?? false
    }

    public func bgList(sessionId: String) async throws -> [(taskId: String, command: String, status: String, exitCode: Int?)] {
        let r = try await request("bg.list", params: obj(["sessionId": .string(sessionId)]))
        return (r["tasks"]?.arrayValue ?? []).compactMap { t in
            guard let id = t["taskId"]?.stringValue, let cmd = t["command"]?.stringValue, let st = t["status"]?.stringValue else { return nil }
            return (id, cmd, st, t["exitCode"]?.intValue)
        }
    }

    public func bgPeek(sessionId: String, taskId: String) async throws -> (chunk: String, status: String, exitCode: Int?) {
        let r = try await request("bg.peek", params: obj(["sessionId": .string(sessionId), "taskId": .string(taskId)]))
        return (r["chunk"]?.stringValue ?? "", r["status"]?.stringValue ?? "unknown", r["exitCode"]?.intValue)
    }

    public func bgKill(sessionId: String, taskId: String) async throws {
        _ = try await request("bg.kill", params: obj(["sessionId": .string(sessionId), "taskId": .string(taskId)]))
    }

    public func bgKillAll(sessionId: String) async throws -> Int {
        try await request("bg.killAll", params: obj(["sessionId": .string(sessionId)]))["killed"]?.intValue ?? 0
    }

    public func mcpList(cwd: String? = nil) async throws -> [(name: String, status: String, toolNames: [String], source: String)] {
        let r = try await request("mcp.list", params: obj(["cwd": cwd.map { .string($0) }]))
        return (r["servers"]?.arrayValue ?? []).compactMap { s in
            guard let n = s["name"]?.stringValue, let st = s["status"]?.stringValue, let src = s["source"]?.stringValue else { return nil }
            return (n, st, (s["toolNames"]?.arrayValue ?? []).compactMap { $0.stringValue }, src)
        }
    }

    /// `plugins.list` — extended (Phase 4d-ii Task 3) to decode `tier`/`requiredConsents`/
    /// `consented`/`legacy`/`status` (methods.ts `PluginInfoSchema`), fields the wire has carried
    /// since Phase 4a Task 3 / 4d-i Task 4 but this wrapper previously dropped on the floor. All
    /// optional on the wire (older-shaped fixtures/servers) — `tier`/`status` decode to `nil`,
    /// `requiredConsents`/`consented` decode to `[]`, `legacy` defaults to `false`, same
    /// permissive-decode precedent as the original 5 fields above.
    ///
    /// Phase 4d-iii Task 2: `version` (also `PluginInfoSchema`, always optional on the wire — a
    /// manifest need not declare one) added for the Dashboard's PluginManagerView row display.
    /// Appended at the END of the tuple (not interleaved) so this stays purely additive — every
    /// existing label-based access (`.name`, `.tier`, etc.) is unaffected by a tuple's field
    /// POSITION, only unlabeled positional destructuring would break, and none exists in this repo
    /// (grepped before adding).
    public func pluginsList() async throws -> [(
        name: String, skills: [String], hasMcp: Bool, mcpEnabled: Bool, disabled: Bool,
        tier: String?, requiredConsents: [String], consented: [String], legacy: Bool, status: String?,
        version: String?
    )] {
        let r = try await request("plugins.list", params: .object([:]))
        return (r["plugins"]?.arrayValue ?? []).compactMap { p in
            guard let n = p["name"]?.stringValue else { return nil }
            return (
                n,
                (p["skills"]?.arrayValue ?? []).compactMap { $0.stringValue },
                p["hasMcp"]?.boolValue ?? false,
                p["mcpEnabled"]?.boolValue ?? false,
                p["disabled"]?.boolValue ?? false,
                p["tier"]?.stringValue,
                (p["requiredConsents"]?.arrayValue ?? []).compactMap { $0.stringValue },
                (p["consented"]?.arrayValue ?? []).compactMap { $0.stringValue },
                p["legacy"]?.boolValue ?? false,
                p["status"]?.stringValue,
                p["version"]?.stringValue
            )
        }
    }

    // MARK: - Peripheral lease (provider side) + dashboard reads (Phase 2f)

    /// Provider-side: advertise which capability classes this connection can serve (with current
    /// TCC-grant state per class). Sent on attach and again whenever TCC state changes.
    public func peripheralAdvertise(classes: [(class: String, tccGranted: Bool)]) async throws {
        let arr: [JSONValue] = classes.map { .object(["class": .string($0.class), "tccGranted": .bool($0.tccGranted)]) }
        _ = try await request("peripheral.advertise", params: obj(["classes": .array(arr)]))
    }

    /// Provider-side: revoke a single lease (`leaseId`) or every active lease (`leaseId == nil`,
    /// wire `all: true`) — panic uses the latter. `reason` is one of the `lease_lost` reasons.
    public func peripheralRevoke(leaseId: String?, reason: String) async throws {
        var params: [String: JSONValue?] = ["reason": .string(reason)]
        if let leaseId { params["leaseId"] = .string(leaseId) } else { params["all"] = .bool(true) }
        _ = try await request("peripheral.revoke", params: obj(params))
    }

    /// Provider-side: answer a `peripheral_call_requested` event with either a JSON-encoded
    /// result or an error message (mutually exclusive; follows the approval-broker response shape).
    public func peripheralRespond(requestId: String, resultJson: String?, error: String?) async throws {
        _ = try await request("peripheral.respond", params: obj([
            "requestId": .string(requestId),
            "resultJson": resultJson.map { .string($0) },
            "error": error.map { .string($0) },
        ]))
    }

    /// Provider-side (Phase 4c Task 1, spec §5): answer a `hardware_requested` event with either
    /// a JSON-encoded result or an error message (mutually exclusive) — mirrors
    /// `peripheralRespond`'s shape exactly. Only the active provider connection (Norma.app) may
    /// call this; the core-side broker (Task 2) rejects it otherwise.
    public func hardwareRespond(requestId: String, resultJson: String?, error: String?) async throws {
        _ = try await request("hardware.respond", params: obj([
            "requestId": .string(requestId),
            "resultJson": resultJson.map { .string($0) },
            "error": error.map { .string($0) },
        ]))
    }

    /// Dashboard read: daemon identity/uptime + the current peripheral provider (if any).
    public func daemonStatus() async throws -> (version: String, uptimeMs: Int, socketPath: String, providerId: String?, providerModel: String?, sessionsCount: Int, pluginsCount: Int) {
        let r = try await request("daemon.status", params: nil)
        let provider = r["provider"]
        return (
            r["version"]?.stringValue ?? "",
            r["uptimeMs"]?.intValue ?? 0,
            r["socketPath"]?.stringValue ?? "",
            provider?["id"]?.stringValue,
            provider?["model"]?.stringValue,
            r["sessionsCount"]?.intValue ?? 0,
            r["pluginsCount"]?.intValue ?? 0
        )
    }

    /// engine.activity — number of agent turns executing right now (update idle gate).
    public func engineActivity() async throws -> Int {
        let r = try await request("engine.activity", params: nil)
        return r["activeTurns"]?.intValue ?? 0
    }

    /// Dashboard read: rate-limit state (`kind: "ok"|"limited"`, `resumeAt` when limited) + token usage.
    public func quotaState() async throws -> (kind: String, resumeAt: Int?, inputTokens: Int, outputTokens: Int) {
        let r = try await request("quota.state", params: nil)
        return (r["kind"]?.stringValue ?? "ok", r["resumeAt"]?.intValue, r["inputTokens"]?.intValue ?? 0, r["outputTokens"]?.intValue ?? 0)
    }

    /// Dashboard read: trusted working directories.
    public func trustList() async throws -> [String] {
        let r = try await request("trust.list", params: nil)
        return (r["dirs"]?.arrayValue ?? []).compactMap { $0.stringValue }
    }

    /// Dashboard write: revoke trust for a directory; returns whether it was actually removed.
    public func trustRemove(path: String) async throws -> Bool {
        try await request("trust.remove", params: obj(["path": .string(path)]))["removed"]?.boolValue ?? false
    }

    /// `provider.configure {type, baseUrl, apiKey, model?}` (BYOK T1, design doc
    /// `2026-07-16-byok-provider-setup-design.md` §1) — the in-app "bring your own OpenAI API key"
    /// path. Always sends `type: "openai-compatible"` (v1 is BYOK-only — switching back to
    /// codex-oauth stays CLI-only via `norma login`, out of scope here). The server writes the API
    /// key to its OWN SecretStore and replaces the `provider` block in settings.json; a plain
    /// `{ok:true}` on success (no typed outcome union — an invalid baseUrl/empty apiKey throws a
    /// server-side `RpcFailure`, surfaced here as a thrown `RpcError`, same discipline as
    /// `setPolicy`/`pluginRestart` above). Provider-TYPE changes need a fresh daemon to take
    /// effect — the CALLER (T2's Dashboard pane) is responsible for triggering
    /// `daemonSupervisor?.restart()` after this returns; this wrapper only persists the config.
    public func configureProvider(baseUrl: String, apiKey: String, model: String? = nil) async throws {
        _ = try await request("provider.configure", params: obj([
            "type": .string("openai-compatible"), "baseUrl": .string(baseUrl), "apiKey": .string(apiKey),
            "model": model.map { .string($0) },
        ]))
    }
}

// MARK: - Memory (Phase 5b Task 3 RPC / Task 5 Dashboard pane)
//
// Mirrors `MemoryFactMetaSchema`/`MemoryFactSchema`/`MemoryAuditLineSchema` (protocol/src/
// methods.ts) field-for-field, same precedent as `PluginContribEntry` above. `memory.write`/
// `memory.delete` have an EMPTY result on success (methods.ts's own doc comment) — an
// unknown-name/untrusted-cwd failure is a thrown `RpcError` (server `RpcFailure`), never a soft
// boolean, so these two wrappers return `Void`, not a decoded outcome.

/// Mirrors `MemoryFactMetaSchema` — one `memory.list` entry (no body).
public struct MemoryFactMeta: Equatable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let description: String
    public let type: String
}

/// Mirrors `MemoryFactSchema` — `MemoryFactMeta` plus the full body (`memory.read`'s result).
public struct MemoryFact: Equatable, Sendable {
    public let name: String
    public let description: String
    public let type: String
    public let body: String
}

/// Mirrors `MemoryAuditLineSchema` — one `memory.audit` entry. `memory.audit`'s wire contract is
/// newest-FIRST (the daemon reverses `MemoryStore.auditTail`'s own newest-LAST slice before
/// replying), so callers never need to reverse this array themselves.
public struct MemoryAuditLine: Equatable, Sendable {
    public let ts: Int
    public let sessionId: String?
    public let source: String
    public let scope: String
    public let action: String
    public let name: String
    public let description: String?
}

extension NormaClient {
    /// `memory.list {scope, cwd?}` — fact metadata only. The Dashboard pane is user-scope only (no
    /// cwd context to source a project scope from), so its own call site omits `cwd`.
    public func memoryList(scope: String, cwd: String? = nil) async throws -> [MemoryFactMeta] {
        let r = try await request("memory.list", params: obj(["scope": .string(scope), "cwd": cwd.map { .string($0) }]))
        return (r["facts"]?.arrayValue ?? []).compactMap { f in
            guard let n = f["name"]?.stringValue, let d = f["description"]?.stringValue, let t = f["type"]?.stringValue else { return nil }
            return MemoryFactMeta(name: n, description: d, type: t)
        }
    }

    /// `memory.read {scope, name, cwd?}` — full fact including body.
    public func memoryRead(scope: String, name: String, cwd: String? = nil) async throws -> MemoryFact {
        let r = try await request("memory.read", params: obj([
            "scope": .string(scope), "name": .string(name), "cwd": cwd.map { .string($0) },
        ]))
        guard let fact = r["fact"], let n = fact["name"]?.stringValue, let d = fact["description"]?.stringValue,
              let t = fact["type"]?.stringValue, let body = fact["body"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for memory.read")
        }
        return MemoryFact(name: n, description: d, type: t, body: body)
    }

    /// `memory.write {scope, name, description, type, body, cwd?}` — empty result on success (see
    /// this section's header comment).
    public func memoryWrite(scope: String, name: String, description: String, type: String, body: String, cwd: String? = nil) async throws {
        _ = try await request("memory.write", params: obj([
            "scope": .string(scope), "name": .string(name), "description": .string(description),
            "type": .string(type), "body": .string(body), "cwd": cwd.map { .string($0) },
        ]))
    }

    /// `memory.delete {scope, name, cwd?}` — empty result on success, same as `memoryWrite`.
    public func memoryDelete(scope: String, name: String, cwd: String? = nil) async throws {
        _ = try await request("memory.delete", params: obj(["scope": .string(scope), "name": .string(name), "cwd": cwd.map { .string($0) }]))
    }

    /// `memory.audit {limit?, cwd?}` — newest-first (see `MemoryAuditLine`'s own doc comment).
    /// `cwd` (task-23, T3) is additive/optional: omitted (every existing call site, e.g.
    /// `MemoryPaneModel`'s user-scope-only pane) targets the SAME central/global bucket as before;
    /// a caller with project context can pass it to read that project's own `.audit.jsonl`
    /// (memory-file-ops.ts's `deleteMemoryDir`, files-mode only — see methods.ts's
    /// `MemoryAuditParams` doc comment for the full resolution, ignored under the legacy backend).
    public func memoryAudit(limit: Int? = nil, cwd: String? = nil) async throws -> [MemoryAuditLine] {
        let r = try await request("memory.audit", params: obj(["limit": limit.map { .number(Double($0)) }, "cwd": cwd.map { .string($0) }]))
        return (r["lines"]?.arrayValue ?? []).compactMap { l in
            guard let ts = l["ts"]?.intValue, let source = l["source"]?.stringValue, let scope = l["scope"]?.stringValue,
                  let action = l["action"]?.stringValue, let n = l["name"]?.stringValue else { return nil }
            return MemoryAuditLine(ts: ts, sessionId: l["sessionId"]?.stringValue, source: source, scope: scope, action: action, name: n, description: l["description"]?.stringValue)
        }
    }
}

// MARK: - Skills (Phase 5c Task 4 Dashboard SkillsPane)
//
// Mirrors `SkillMetaSchema`/`SkillsReadResult`'s `{skill}` pattern (protocol/src/methods.ts), same
// precedent as the Memory section above. Replaces the earlier bare-tuple `skillsList` (which
// dropped `path`/`claudeFormat`/`author` on the floor) with a struct decode carrying every wire
// field — grepped first: nothing else in this module called the old wrapper, so this is a clean
// swap, not a second overload.
//
// `skills.write`/`skills.delete` are confined SERVER-SIDE to the self source (no `scope`/`cwd`
// param to abuse, unlike `memory.write` — methods.ts's own header comment above
// `SkillsReadParams`): a caller can never write/delete a project/user/plugin/builtin skill through
// these RPCs, only ever its own self-authored one. `skills.read`, by contrast, reads ANY source by
// the store's normal precedence (project > user > self > plugin > builtin). Like `memory.write`/
// `memory.delete`, `skills.write`/`skills.delete` have an EMPTY result on success — an
// invalid-name/non-self-delete failure is a thrown `RpcError` (server `RpcFailure`), never a soft
// boolean, so these two wrappers return `Void`.

/// Mirrors `SkillMetaSchema` — one `skills.list`/`skills.read` entry's metadata (no body).
public struct SkillMeta: Equatable, Sendable, Identifiable {
    public var id: String { name }
    public let name: String
    public let description: String
    public let source: String
    public let path: String
    /// Set only on claude-format plugin skills (methods.ts's own comment) — `nil` otherwise.
    public let claudeFormat: Bool?
    /// Set for a self-authored skill (`SkillStore.writeSelf` always stamps `author: norma`);
    /// `nil` for every other source. The Dashboard pane's "author: norma" row marker.
    public let author: String?

    /// Explicit memberwise init: a `public` struct's SYNTHESIZED memberwise init is only
    /// `internal` — the Dashboard-side pure helper tests (`DashboardTests.swift`, cross-module)
    /// construct `SkillMeta` values directly (no `NormaClient` round-trip needed for pure display
    /// helpers), so this needs to be public explicitly.
    public init(name: String, description: String, source: String, path: String, claudeFormat: Bool?, author: String?) {
        self.name = name
        self.description = description
        self.source = source
        self.path = path
        self.claudeFormat = claudeFormat
        self.author = author
    }
}

/// Mirrors `SkillsReadResult`'s `{skill}` shape — `SkillMeta` plus the full body.
public struct Skill: Equatable, Sendable {
    public let name: String
    public let description: String
    public let source: String
    public let path: String
    public let claudeFormat: Bool?
    public let author: String?
    public let body: String

    /// Explicit memberwise init — same reasoning as `SkillMeta.init` above.
    public init(name: String, description: String, source: String, path: String, claudeFormat: Bool?, author: String?, body: String) {
        self.name = name
        self.description = description
        self.source = source
        self.path = path
        self.claudeFormat = claudeFormat
        self.author = author
        self.body = body
    }
}

extension NormaClient {
    /// Shared metadata decode for `skills.list`'s per-entry shape and `skills.read`'s `skill`
    /// object (which is `SkillMetaSchema.extend({body})` — same fields plus `body`).
    private func decodeSkillMeta(_ s: JSONValue) -> SkillMeta? {
        guard let n = s["name"]?.stringValue, let d = s["description"]?.stringValue,
              let src = s["source"]?.stringValue, let p = s["path"]?.stringValue else { return nil }
        return SkillMeta(name: n, description: d, source: src, path: p, claudeFormat: s["claudeFormat"]?.boolValue, author: s["author"]?.stringValue)
    }

    /// `skills.list {cwd?}` — skill metadata only (no body).
    public func skillsList(cwd: String? = nil) async throws -> [SkillMeta] {
        let r = try await request("skills.list", params: obj(["cwd": cwd.map { .string($0) }]))
        return (r["skills"]?.arrayValue ?? []).compactMap { decodeSkillMeta($0) }
    }

    /// `skills.read {name, cwd?}` — full skill including body, resolved against ANY source by the
    /// store's normal precedence (see this section's header comment).
    public func skillsRead(name: String, cwd: String? = nil) async throws -> Skill {
        let r = try await request("skills.read", params: obj(["name": .string(name), "cwd": cwd.map { .string($0) }]))
        guard let skillObj = r["skill"], let meta = decodeSkillMeta(skillObj), let body = skillObj["body"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for skills.read")
        }
        return Skill(name: meta.name, description: meta.description, source: meta.source, path: meta.path, claudeFormat: meta.claudeFormat, author: meta.author, body: body)
    }

    /// `skills.write {name, description, body}` — empty result on success. ALWAYS writes the SELF
    /// source server-side, regardless of what source a same-named skill elsewhere resolves to — a
    /// caller must only ever offer this for a skill already known to be self-sourced (this
    /// section's header comment).
    public func skillsWrite(name: String, description: String, body: String) async throws {
        _ = try await request("skills.write", params: obj([
            "name": .string(name), "description": .string(description), "body": .string(body),
        ]))
    }

    /// `skills.delete {name}` — empty result on success; the server throws if `name` resolves to a
    /// non-self source (this section's header comment).
    public func skillsDelete(name: String) async throws {
        _ = try await request("skills.delete", params: obj(["name": .string(name)]))
    }
}
