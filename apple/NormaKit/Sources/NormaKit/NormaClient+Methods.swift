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

// MARK: - working-directories T8: a session's ordered working-directory set

/// One entry of a session's working-directory set — mirrors the protocol's `SessionDirEntry`
/// (`packages/protocol/src/methods.ts`) field-for-field. Shared by BOTH halves of the wire, exactly
/// as it is on the daemon side: `session.list`'s per-row `dirs` (read) and `session.setDirs`'s
/// result (write).
///
/// **`dirs[0]` is the PRIMARY by POSITION, not by a flag** — there is no `primary` field to read,
/// and a set is never "secondaries without a primary" (the daemon refuses `remove` of index 0
/// outright). `locked` is the first-write lock: once Norma has successfully written inside a
/// directory, that entry can never be replaced or removed for the session's lifetime.
///
/// An EMPTY array is a real, meaningful state (a workdir-less session — writable only in
/// `$OUTDIR`/`$TMPDIR`/`$MEMDIR`) and must never be conflated with `dirs == nil`; see
/// `listSessions()`'s own doc comment for what the absent case means.
public struct SessionDirEntry: Equatable, Hashable, Sendable {
    public let path: String
    public let locked: Bool

    public init(path: String, locked: Bool) {
        self.path = path
        self.locked = locked
    }
}

// MARK: - b2-agent-browser T1: a session's live signals

/// The two live signals `session.list` reports per row — mirrors the protocol's `signals` object
/// (`SessionListResult`, `packages/protocol/src/methods.ts`) field-for-field.
///
/// **These exist for EVERY MODE**, which is the entire reason the surface was built: the derived
/// `activity` label is withheld from chat/dispatch by `participatesInActivity`
/// (`packages/core/src/sessions/activity.ts`), and the Mac app's browser lifecycle runs on chat
/// sessions. Reading the label to answer "is anyone else attached / is the agent working" is
/// therefore right only for code sessions; reading these is right for all of them.
///
/// A STRUCT rather than a tuple deliberately: a tuple has no `Equatable` conformance, so a tuple
/// property on `SessionSummary` would silently cost that type its synthesized `==`.
public struct SessionSignals: Equatable, Hashable, Sendable {
    /// At least one harness OTHER THAN this connection holds the session open. The daemon does the
    /// subtracting (`SessionHub.attachedSession` for the asking connection) precisely because a
    /// client cannot tell its own reflection from a second harness in a bare count.
    ///
    /// **"This connection" is the one that made the `session.list` call** — which, in an app that
    /// dials the daemon more than once, is not the same as "this app". See
    /// `BrowserSignalsCoordinator.assemble` for what that costs the Mac shell and why it is benign.
    public let attachedElsewhere: Bool
    /// `turnRunning || bgWork` — the agent may be driving this session's pages right now.
    public let working: Bool

    public init(attachedElsewhere: Bool, working: Bool) {
        self.attachedElsewhere = attachedElsewhere
        self.working = working
    }
}

/// The three mutations `session.setDirs` supports (`SessionSetDirsParams.op`'s zod enum, mirrored
/// by `DirsOp` in `packages/core/src/sessions/set-dirs.ts`). A closed, three-value wire enum with
/// no growth pressure, so this is a Swift enum rather than the bare `String` `setPolicy`/`setModel`
/// take — those mirror wire enums that HAVE widened (three approval policies became six), where a
/// Swift enum would have to be re-edited to pass a value the daemon already accepts. `rawValue` is
/// the verbatim wire string; nothing else is ever sent.
///
/// There is deliberately no "clear"/"remove all": emptying a set back to `[]` is not a supported
/// transition (set-dirs.ts's own doc) — a session that has ever had a primary keeps one.
public enum SessionDirsOp: String, Equatable, Sendable {
    /// Replace `dirs[0]` (or ESTABLISH it on an empty set, exiting workdir-less mode).
    ///
    /// For a FRESH path (not already in the set), replaces index 0 and keeps 1…n untouched. For a
    /// path the set ALREADY holds at index 0, it's an idempotent no-op — even when that entry is
    /// locked (`setPrimary` of the current primary asks for nothing new). For a path already held
    /// at index k>0, it PROMOTES that entry to index 0, carrying its lock state verbatim and
    /// dropping the old primary (replace semantics, not insert) — `set-dirs.ts`'s dedupe-promote
    /// branch, whole-branch review I-1. Never produces a duplicate entry.
    case setPrimary
    /// Append a directory (idempotent for one already in the set; establishes the primary when the
    /// set is empty, since appending to `[]` produces `dirs[0]`).
    case add
    /// Drop a directory. Idempotent for one that isn't in the set; refused for index 0 (the primary
    /// is a position — `setPrimary` is the way to replace it) and for a locked entry.
    case remove
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

    /// Chat Mode Slice A (CM-T3): `mode` is additive and defaults to `nil` (the daemon reads
    /// absence as "code", `packages/protocol/src/methods.ts`'s `SessionCreateParams.mode`) — every
    /// existing call site (the sidebar's "+ New session", `norma-probe`) is unaffected. The Mac
    /// app's "New Chat"/"Chat" menu entries are the first callers to pass `mode: "chat"`.
    public func createSession(scope: String, cwd: String? = nil, approvalPolicy: String? = nil, mode: String? = nil) async throws -> (sessionId: String, trusted: Bool) {
        let r = try await request("session.create", params: obj([
            "scope": .string(scope),
            "cwd": cwd.map { .string($0) },
            "approvalPolicy": approvalPolicy.map { .string($0) },
            "mode": mode.map { .string($0) },
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

    /// working-directories T8: the ONE decoder for a wire `dirs` array, shared by `listSessions()`'s
    /// per-row read and `setDirs`'s post-write result — one function, so the two surfaces can never
    /// describe an entry differently (the same reason the protocol gives them one zod schema).
    ///
    /// Returns `nil` for an ABSENT key (see `listSessions()`'s doc for why that is distinct from an
    /// empty set) and for a value that isn't an array at all. Both fields are REQUIRED per entry
    /// (`SessionDirEntry`'s zod schema has no optionals): an entry missing either is dropped rather
    /// than defaulted, because both directions of a guessed `locked` are wrong — `false` invites a
    /// remove the daemon will refuse, `true` hides an affordance that legitimately exists.
    private func decodeSessionDirs(_ value: JSONValue?) -> [SessionDirEntry]? {
        guard let entries = value?.arrayValue else { return nil }
        return entries.compactMap { e in
            guard let path = e["path"]?.stringValue, let locked = e["locked"]?.boolValue else { return nil }
            return SessionDirEntry(path: path, locked: locked)
        }
    }

    /// b2-agent-browser T1: the wire `signals` object, decoded whole or not at all.
    ///
    /// **`nil` is a real answer and the ONLY honest one for an absent key**: it means "this daemon
    /// predates the signals surface", never `false/false`. Both members are REQUIRED in the zod
    /// schema, so a half-present object is a daemon that does not agree with this build about the
    /// shape — dropped rather than defaulted, on `decodeSessionDirs`' own reasoning (a guessed
    /// `false` here would tell the browser lifecycle that a working session is quiet, which stops
    /// browsers mid-work; a guessed `true` would keep every session's browsers alive forever).
    private func decodeSessionSignals(_ value: JSONValue?) -> SessionSignals? {
        guard let attachedElsewhere = value?["attachedElsewhere"]?.boolValue,
              let working = value?["working"]?.boolValue else { return nil }
        return SessionSignals(attachedElsewhere: attachedElsewhere, working: working)
    }

    /// Chat Slice D Task 10: `model` (T1's per-session override, round-tripped by
    /// `session.list`'s own row — see `SessionListResult` in methods.ts) appended at the END of
    /// the tuple, same "purely additive, positional destructuring never used" precedent as
    /// `pluginsList()`'s own `version` field above — every existing labeled call site
    /// (`.sessionId`, `.mode`, etc.) is unaffected. `nil` for every session created/left without an
    /// explicit override, or created before this field existed. T1 itself deferred this threading
    /// ("no consumer yet") — the Mac model picker (`WindowContentView`'s model menu) is that
    /// consumer: it reads a session row's current override straight off this tuple.
    ///
    /// provider-correctness T6: `effort` appended after `model`, same purely-additive precedent
    /// (`SessionListResult`'s own row carries it since T4). The Mac's effort picker is its consumer,
    /// and it must be read with `SessionSummary.effort`'s rule in mind: the value may be a
    /// Norma-level TIER (`sync.config.clientEfforts`, e.g. `"ultra"`) reported verbatim rather than
    /// rewritten to its wire translation, so a picker matching it against the model's `efforts`
    /// array alone will miss. Match against BOTH lists.
    ///
    /// working-directories T8: `dirs` appended LAST, same purely-additive precedent as `model`/
    /// `effort` above (no call site destructures positionally). Decoded off the raw JSON row beside
    /// `cwd` — the precedent this very line already sets — rather than through a `Codable` row type
    /// this wrapper doesn't have.
    ///
    /// **`nil` and `[]` are DIFFERENT answers and the difference is load-bearing.** The daemon
    /// populates `dirs` only for rows that PARTICIPATE in working directories (code + cowork +
    /// absent-means-code — `session.list`'s own `participatesInActivity` gate, ipc/server.ts), so:
    ///   * `nil` — this session has no working-directory concept at all (chat/dispatch), or the
    ///     daemon predates the field. A picker must be ABSENT, not empty.
    ///   * `[]` — a real, participating, WORKDIR-LESS session: writable only in `$OUTDIR`/`$TMPDIR`/
    ///     `$MEMDIR` until something adopts a directory. A picker belongs here, offering exactly the
    ///     adopt door.
    /// Collapsing the two (`?? []`) is how a chat window grows a folder menu whose every tap comes
    /// back `DIRS_MODE_REFUSAL`.
    ///
    /// `cwd` is the ALIAS of `dirs[0]?.path` for a participating row — the daemon overwrites it at
    /// `session.list` time from the dirs set, because `session.setDirs` deliberately never touches
    /// the stored `cwd` column. Read whichever suits, but never treat them as independent facts.
    ///
    /// app-shell Task 2: `activity` appended LAST, same purely-additive precedent as `dirs` above —
    /// raw-JSON-decoded beside `cwd`/`dirs` rather than through a `Codable` row type this wrapper
    /// doesn't have. Mirrors `SessionListResult.activity` (methods.ts) field-for-field: one of
    /// `"active"|"background"|"idle"|"archived"` for a participating (code/cowork) row, `nil` for
    /// every chat/dispatch row AND for a daemon predating the field — the SAME absent-is-a-real-value
    /// discipline `dirs` documents above, decoded the identical way (`s["activity"]?.stringValue`:
    /// `nil` for a missing key or a non-string value, never a guessed default). Kept a plain `String`
    /// rather than a Swift enum for the same reason `SessionEvent.SessionActivity.activity` is one
    /// (that struct's own doc comment): a newer daemon's fifth value must decode here, not throw.
    /// b2-agent-browser T1: `archived` and `signals` appended LAST, same purely-additive precedent
    /// as `dirs`/`activity` above.
    ///
    /// `archived` is the session's stored flag for EVERY mode — not new to the wire (`store.list()`
    /// has selected it since session-activity-hygiene T3), only newly declared and newly read here.
    /// It is the same fact `activity == "archived"` carries for a code/cowork row and the ONLY way
    /// to learn it for a chat/dispatch one, where the label does not exist. Absent means NOT
    /// archived — the daemon writes NULL, never 0 — so absence is a real answer for every daemon.
    ///
    /// `signals` is the pair `SessionSignals` documents: `nil` means "daemon predating the surface",
    /// never `false/false`.
    public func listSessions() async throws -> [(sessionId: String, scope: String, createdAt: Int, lastSeq: Int, title: String?, cwd: String?, mode: String?, parentSessionId: String?, model: String?, effort: String?, dirs: [SessionDirEntry]?, activity: String?, archived: Bool?, signals: SessionSignals?)] {
        let r = try await request("session.list", params: nil)
        return (r["sessions"]?.arrayValue ?? []).compactMap { s in
            guard let id = s["sessionId"]?.stringValue, let scope = s["scope"]?.stringValue,
                  let created = s["createdAt"]?.intValue, let last = s["lastSeq"]?.intValue else { return nil }
            return (id, scope, created, last, s["title"]?.stringValue, s["cwd"]?.stringValue, s["mode"]?.stringValue, s["parentSessionId"]?.stringValue, s["model"]?.stringValue, s["effort"]?.stringValue, decodeSessionDirs(s["dirs"]), s["activity"]?.stringValue, s["archived"]?.boolValue, decodeSessionSignals(s["signals"]))
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

    /// `session.setModel {sessionId, model}` (Chat Slice D task 1) — per-session model override,
    /// mode-agnostic (unlike `setPolicy` above, this has no chat/dispatch special case: there is no
    /// "fixed model" concept for any mode). `model: nil` CLEARS the override on the wire (the param
    /// is required-but-nullable there, `SessionSetModelParams.model: z.string().min(1).nullable()`
    /// — NOT optional), so this always sends the `"model"` key: `.string(...)` when set, `.null`
    /// when clearing. Result is a bare `{}` (skills.write's idiom) — nothing to report beyond
    /// success; an unresolvable sessionId throws `RpcError` via the daemon's own NOT_FOUND, same
    /// precedent as `setPolicy`.
    public func setModel(sessionId: String, model: String?) async throws {
        _ = try await request("session.setModel", params: obj([
            "sessionId": .string(sessionId),
            "model": model.map { JSONValue.string($0) } ?? JSONValue.null,
        ]))
    }

    /// `session.setEffort {sessionId, effort}` (provider-correctness T4) — the per-session
    /// reasoning-effort override, the other half of `setModel` above and a SEPARATE method by
    /// design ("effort and model are two different things, just like the CLI"). Identical wire
    /// contract: `effort: nil` CLEARS the override and is sent as a LITERAL JSON null, never an
    /// omitted key (`SessionSetEffortParams.effort` is `.min(1).nullable()` — required-but-nullable,
    /// NOT optional), the result is a bare `{}`, and an unresolvable sessionId throws `RpcError` via
    /// the daemon's NOT_FOUND.
    ///
    /// The VALUE is not validated here, and deliberately so: the endpoint validates effort
    /// per-model, so only the daemon — which knows the session's own model — can decide. An effort
    /// the session's model does not accept comes back as an `RpcError` (INVALID_PARAMS) naming the
    /// supported set, which a picker should surface rather than swallow.
    public func setEffort(sessionId: String, effort: String?) async throws {
        _ = try await request("session.setEffort", params: obj([
            "sessionId": .string(sessionId),
            "effort": effort.map { JSONValue.string($0) } ?? JSONValue.null,
        ]))
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

    /// `session.setDirs {sessionId, op, path}` (working-directories T3) — THE one write door onto a
    /// session's working-directory set, for every client surface. Returns the POST-WRITE set (not an
    /// echo of what was sent), so a caller renders the daemon's answer rather than its own guess:
    /// an idempotent `add` of a directory already in the set, for instance, comes back unchanged.
    ///
    /// **Every refusal is a thrown `RpcError` carrying the daemon's own wording, and that wording is
    /// meant to be SHOWN.** `set-dirs.ts` owns the refusal matrix and names each rule in its own
    /// sentence — "working directories apply to code and cowork sessions only" (chat/dispatch),
    /// "that directory is locked for this session" (the first-write lock), "that directory can never
    /// be a working directory" (the dirGrant denylist), and the remove-primary refusal that names
    /// `setPrimary` as the way out. Surfacing them VERBATIM is what makes a refusal teachable; a
    /// client-side "couldn't set folder" erases the one sentence that says why. There is deliberately
    /// no outcome enum here (unlike the plugin-lifecycle wrappers): the refusals are open-ended
    /// prose, not a closed set a caller could switch on, and re-deriving the matrix on this side is
    /// exactly the two-implementations-of-one-state-machine drift the setter exists to prevent.
    ///
    /// An unknown session throws too (NOT_FOUND) — same precedent as `setPolicy`/`setModel`.
    public func setDirs(sessionId: String, op: SessionDirsOp, path: String) async throws -> [SessionDirEntry] {
        let r = try await request("session.setDirs", params: obj([
            "sessionId": .string(sessionId), "op": .string(op.rawValue), "path": .string(path),
        ]))
        guard let dirs = decodeSessionDirs(r["dirs"]) else {
            throw RpcError(code: -3, message: "invalid result from server for session.setDirs")
        }
        return dirs
    }

    /// `session.setActivity {sessionId, activity}` (session-activity-hygiene T3) — the WRITE half of
    /// a session's activity lifecycle, for every Mac surface that offers the `/background` verb.
    ///
    /// **Four values and a null, and the null is not "clear everything".** `"background"` and
    /// `"archived"` SET their own flag, `"unbackground"` clears the background one, and a literal
    /// `null` is RESUME, which clears the archive flag ONLY (`sessions/set-activity.ts`'s "one verb,
    /// one flag" ruling — a background worker that gets archived and resumed comes back a background
    /// worker). `"active"`/`"idle"` are deliberately NOT settable: they are DERIVED facts about
    /// attachments and work, not assertions a caller may make.
    ///
    /// The param is required-but-nullable on the wire (`SessionSetActivityParams.activity` is
    /// `z.enum([...]).nullable()`, not optional), so this always sends the key — `.null` for resume,
    /// never an omitted key, the same discipline `setModel`/`setEffort` document.
    ///
    /// Returns the POST-WRITE DERIVED state (the daemon re-reads and re-derives rather than echoing
    /// what was asked for — clearing a session whose detached bash task is still writing reads back
    /// `"background"`, not `"idle"`), or `nil` for a row that does not participate at all. Same
    /// absent-is-a-real-value discipline as `listSessions`' own `activity`, and kept a plain `String`
    /// for the same reason: a newer daemon's fifth value must decode here, not throw.
    ///
    /// **Every refusal is a thrown `RpcError` carrying the daemon's own sentence, and that sentence
    /// is meant to be SHOWN** — the `setDirs` precedent, and the same reasoning: `set-activity.ts`
    /// writes one per rule and each names the rule it enforced ("activity states apply to code and
    /// cowork sessions only", "session is archived — resume it first", "stop or background it
    /// first"). A client-side "couldn't change that" erases exactly the sentence that teaches the
    /// rule. An unknown session throws NOT_FOUND, same precedent as `setPolicy`/`setModel`.
    public func setActivity(sessionId: String, activity: String?) async throws -> String? {
        let r = try await request("session.setActivity", params: obj([
            "sessionId": .string(sessionId),
            "activity": activity.map { JSONValue.string($0) } ?? JSONValue.null,
        ]))
        return r["activity"]?.stringValue
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

// MARK: - Workflows (CC-parity phase 3, Track D Task D2: NormaKit workflow.* client surface)
//
// The Swift half of C2's workflow.list/run/stop/get RPCs (protocol/src/methods.ts) — D1 already
// mirrored the 4 `workflow_*` SessionEvent variants (live progress broadcast) in NormaProtocol's
// SessionEvent.swift; these four are the separate request/response management verbs (list runs +
// saved scripts, launch, stop, poll one run by id) that back a future Dashboard/session workflows
// view (D3). LOCAL-ONLY IN V1 (methods.ts's own header comment): none of the four are in
// PLUGIN_ALLOWED_METHODS or REMOTE_ALLOWED_METHODS (ipc/server.ts) — a plugin or remote (iPhone
// gateway) connection is role-rejected before dispatch ever reaches a handler for any of them, so
// there is nothing to allowlist on the Swift side either.

/// Mirrors `WorkflowRunViewSchema.counts` (methods.ts) — the in-flight step tally for a run.
public struct WorkflowRunCounts: Equatable, Sendable {
    public let running: Int
    public let completed: Int
    public let total: Int
}

/// Mirrors `WorkflowRunViewSchema` (methods.ts) field-for-field — a live or terminal workflow
/// run's current view, returned by `workflow.list`'s `running` array, `workflow.run`, and
/// `workflow.get`. `status` is kept as a plain wire string (`"running"|"completed"|"failed"|
/// "stopped"`), same convention as `threadList`/`bgList`/`pluginsList`'s own status fields above,
/// rather than a Swift enum a future server-added status would fail to decode.
public struct WorkflowRunView: Equatable, Sendable {
    public let runId: String
    public let sessionId: String
    public let name: String?
    public let status: String
    public let counts: WorkflowRunCounts
    public let phase: String?
    public let result: String?
    public let error: String?
    public let startedAt: Int
}

/// Mirrors `WorkflowSavedSchema` (methods.ts) — a saved (not-yet-running) workflow's identity, from
/// `workflow.list`'s `saved` array (`WorkflowStore`, C1's trust-gated `.norma/workflows/*.js`
/// scripts).
public struct WorkflowSaved: Equatable, Sendable {
    public let name: String
    public let description: String
    public let source: String
}

extension NormaClient {
    /// Shared decode for `WorkflowRunViewSchema`'s wire shape — used by `workflowList`'s `running`
    /// array and `workflowGet`'s `run` object.
    private func decodeWorkflowRunView(_ v: JSONValue) -> WorkflowRunView? {
        guard let runId = v["runId"]?.stringValue,
              let sessionId = v["sessionId"]?.stringValue,
              let status = v["status"]?.stringValue,
              let counts = v["counts"],
              let running = counts["running"]?.intValue,
              let completed = counts["completed"]?.intValue,
              let total = counts["total"]?.intValue,
              let startedAt = v["startedAt"]?.intValue
        else { return nil }
        return WorkflowRunView(
            runId: runId, sessionId: sessionId, name: v["name"]?.stringValue, status: status,
            counts: WorkflowRunCounts(running: running, completed: completed, total: total),
            phase: v["phase"]?.stringValue, result: v["result"]?.stringValue, error: v["error"]?.stringValue,
            startedAt: startedAt
        )
    }

    /// `workflow.list {sessionId, cwd?}` — live runs (`WorkflowRuntime`) plus saved scripts
    /// (`WorkflowStore`, resolved against `cwd` if supplied, else the session's own cwd
    /// server-side).
    public func workflowList(sessionId: String, cwd: String? = nil) async throws -> (running: [WorkflowRunView], saved: [WorkflowSaved]) {
        let r = try await request("workflow.list", params: obj(["sessionId": .string(sessionId), "cwd": cwd.map { .string($0) }]))
        let running = (r["running"]?.arrayValue ?? []).compactMap { decodeWorkflowRunView($0) }
        let saved = (r["saved"]?.arrayValue ?? []).compactMap { s -> WorkflowSaved? in
            guard let n = s["name"]?.stringValue, let d = s["description"]?.stringValue, let src = s["source"]?.stringValue else { return nil }
            return WorkflowSaved(name: n, description: d, source: src)
        }
        return (running, saved)
    }

    /// `workflow.run {sessionId, name?, script?, args?}` — exactly one of `name` (launch a saved
    /// workflow by name) / `script` (launch an inline body verbatim) is expected; enforced
    /// server-side (methods.ts's own doc comment), not here. Returns just the new run's `runId` —
    /// the wire's `status` is always the literal `"running"` (`WorkflowRunResult`'s own doc
    /// comment), nothing else worth surfacing.
    public func workflowRun(sessionId: String, name: String? = nil, script: String? = nil, args: JSONValue? = nil) async throws -> String {
        let r = try await request("workflow.run", params: obj([
            "sessionId": .string(sessionId), "name": name.map { .string($0) }, "script": script.map { .string($0) }, "args": args,
        ]))
        guard let runId = r["runId"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for workflow.run")
        }
        return runId
    }

    /// `workflow.stop {runId}` — a soft boolean, never a thrown error for an unknown or
    /// already-terminal `runId` (methods.ts's own doc comment, same idiom as `routines.delete`'s
    /// `{ok, removed}`); the constant `ok:true` wrapper is dropped, same precedent as `trustDir`.
    public func workflowStop(runId: String) async throws -> Bool {
        try await request("workflow.stop", params: obj(["runId": .string(runId)]))["stopped"]?.boolValue ?? false
    }

    /// `workflow.get {runId}` — an unresolvable `runId` is a thrown `RpcFailure` server-side
    /// (NOT_FOUND), surfaced here as a thrown `RpcError`, same discipline as `pluginRestart`.
    public func workflowGet(runId: String) async throws -> WorkflowRunView {
        let r = try await request("workflow.get", params: obj(["runId": .string(runId)]))
        guard let run = r["run"], let view = decodeWorkflowRunView(run) else {
            throw RpcError(code: -3, message: "invalid result from server for workflow.get")
        }
        return view
    }
}

// MARK: - provider-correctness T6: the model/effort catalogue (`sync.config`)

/// One row of the daemon's model catalogue — the Swift mirror of `SyncConfigModel`
/// (packages/protocol/src/methods.ts).
///
/// `efforts` rides PER MODEL even though every slug the daemon offers today accepts the identical
/// six. The backend validates effort in two layers that disagree with each other — `ultra` is
/// refused by a global enum, `minimal` is refused per model, naming the slug — so a future
/// divergence is the observed behaviour of a layer that already exists, not a hypothetical. Carried
/// per model, that divergence becomes a daemon-side data change instead of a new app release.
public struct SyncConfigModelInfo: Equatable, Sendable {
    public let id: String
    public let efforts: [String]

    public init(id: String, efforts: [String]) {
        self.id = id
        self.efforts = efforts
    }
}

/// What `sync.config` tells a client about models and effort — the catalogue, the daemon's live
/// defaults, and the Norma-level tiers.
///
/// **A PROJECTION, not the whole result, and deliberately so.** `SyncConfigResult` also carries
/// `exaKey` (a Keychain secret) and `dangerousDomains`. Both exist for the PHONE, which runs its own
/// chat engine and needs them to make its own network calls; the Mac app runs no engine of its own
/// and has no use for either. Surfacing a Keychain secret through a kit accessor no caller needs is
/// a new exposure with no counterweight, so this type stops at the model/effort fields — the ones a
/// picker reads (`defaultModel`, `models`, `clientEfforts`) plus the two that say what they mean
/// (`provider`, `defaultEffort`). Widen it the day a Mac-side caller genuinely needs more — never
/// pre-emptively.
///
/// **Absence is a REAL ANSWER and never a licence to guess.** `models: []` means the active provider
/// cannot enumerate its models (an arbitrary openai-compatible endpoint), or none is configured. A
/// caller that receives `[]` has NOT been told a catalogue and must show none — deriving a lineup
/// from `defaultModel` is exactly the bug this field was added to kill. `defaultEffort: ""` means
/// UNSET, which is NOT `"none"`: unset makes a turn omit the `reasoning` block entirely, while
/// `"none"` is an explicit level the backend honours.
public struct SyncConfigSnapshot: Equatable, Sendable {
    /// WHICH PROVIDER everything below describes — `"codex-oauth"` / `"openai-compatible"` (the
    /// daemon's `ProviderSettings.type` vocabulary), `"none"` when it runs none, `""` only when the
    /// daemon predates the field.
    ///
    /// **On the wire this is the one field with NO empty sentinel** (`z.string().min(1)`) — a daemon
    /// always knows which provider it is running. Its purpose is a rule THIS client does not need
    /// and the phone does: a consumer running its own engine on its own credentials must treat a
    /// non-empty foreign `provider` as never-synced and discard `defaultModel` (see
    /// `SyncConfigResult.provider`, packages/protocol/src/methods.ts, for the live 400 that closes).
    /// It is mirrored here anyway because this projection is one of the two hand-written mirrors of
    /// that result, and a mirror that silently omits a field is how the field went missing for a
    /// whole task in the first place — a Mac-side caller that ever needs to say "this catalogue is
    /// not yours" has it, rather than having to widen the type under pressure.
    public let provider: String
    /// The daemon's live default model — re-resolved by the daemon on every call, so a
    /// `norma model` edit lands with no restart. `""` when no provider is configured.
    public let defaultModel: String
    /// The active provider's whole catalogue. EMPTY means "no catalogue was reported" — wait, never
    /// derive one.
    public let models: [SyncConfigModelInfo]
    /// The daemon's live reasoning effort. `""` means UNSET (see the type's own note).
    public let defaultEffort: String
    /// NORMA-LEVEL effort tiers — selectable in Norma, **never sent upstream**, and offered on CODE
    /// sessions only. `["ultra"]` on a current daemon.
    ///
    /// A SEPARATE list from `models[].efforts`, and the two must never be concatenated into one
    /// picker section: `models[].efforts` is exactly what the endpoint accepts, a tier is exactly
    /// what it does not (the daemon translates it before a request exists). Scoping a tier to code
    /// sessions is the CLIENT's obligation — the daemon advertises this unconditionally because it
    /// cannot know which session a picker is for.
    public let clientEfforts: [String]

    // No default arguments, same reason `NormaChatKit.SyncConfig`'s init has none: this type is a
    // HAND-written mirror of a schema no compiler connects it to, so the memberwise widening is the
    // only sweep pressure that exists.
    public init(provider: String, defaultModel: String, models: [SyncConfigModelInfo], defaultEffort: String, clientEfforts: [String]) {
        self.provider = provider
        self.defaultModel = defaultModel
        self.models = models
        self.defaultEffort = defaultEffort
        self.clientEfforts = clientEfforts
    }

    /// What a client holds before it has ever been told a catalogue — every field at its ABSENT
    /// value, none of them a fallback. A picker built on this offers no model rows and no effort
    /// rows, which is the honest rendering of "I have not been told". `provider` is `""` here for
    /// the same reason and NOT `"none"`: `"none"` is a daemon SAYING it runs no provider, while this
    /// value is nobody having said anything yet.
    public static let empty = SyncConfigSnapshot(provider: "", defaultModel: "", models: [], defaultEffort: "", clientEfforts: [])
}

extension NormaClient {
    /// `sync.config {}` (Chat Slice D task 3; the catalogue fields are provider-correctness T3/T5).
    ///
    /// **ROLE-AGNOSTIC, which is why a Mac harness client may call it at all.** The method is on
    /// `REMOTE_ALLOWED_METHODS` because the phone is the only client that had ever needed it, but
    /// that list is a permission for the REMOTE role, not a restriction to it: the handler
    /// (`ipc/server.ts`) applies no role check and takes no `sessionId`, so a harness connection
    /// gets the identical result. T3's review recorded the absence of this wrapper as a known gap;
    /// the Mac's model/effort pickers are the caller that closes it.
    ///
    /// Every field is read by the daemon AT CALL TIME, so this is a snapshot and never a
    /// subscription — a caller that wants to track a `norma model --effort` edit re-calls it.
    ///
    /// Decodes LENIENTLY on absence and STRICTLY on shape, the same split `NormaChatKit.SyncConfig`
    /// makes for the same reason: a missing field means an older daemon (degrade to the absent
    /// value), while a present-but-malformed row would put an empty slug into a picker, and an empty
    /// slug reaches a request body verbatim and comes back an opaque 400. A malformed row is
    /// therefore DROPPED from the catalogue rather than admitted — this kit ships in the same
    /// bundle as the daemon it talks to, so a bad row here is a bug on this machine, not a version
    /// skew to tolerate.
    public func syncConfig() async throws -> SyncConfigSnapshot {
        let r = try await request("sync.config", params: .object([:]))
        let models: [SyncConfigModelInfo] = (r["models"]?.arrayValue ?? []).compactMap { m in
            // Mirrors `z.string().min(1)` on BOTH fields — Swift's synthesized decoding enforces
            // neither, and an empty slug or an empty level is exactly the value that survives all
            // the way to a request body.
            guard let id = m["id"]?.stringValue, !id.isEmpty else { return nil }
            let efforts = (m["efforts"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { !$0.isEmpty }
            return SyncConfigModelInfo(id: id, efforts: efforts)
        }
        return SyncConfigSnapshot(
            // Absent → `""`: an older daemon, decoded as "nobody has said" rather than as a claim.
            // Never defaulted to a provider name — a guessed identity is worse than none, because
            // the whole point of the field is being able to tell a foreign catalogue from your own.
            provider: r["provider"]?.stringValue ?? "",
            defaultModel: r["defaultModel"]?.stringValue ?? "",
            models: models,
            defaultEffort: r["defaultEffort"]?.stringValue ?? "",
            clientEfforts: (r["clientEfforts"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { !$0.isEmpty }
        )
    }

    // MARK: - panel-shell T6/T8: the panel tab-strip mutation RPCs
    //
    // Bare, sessionId-targeted — like `interrupt`/`setActivity` above, never requiring the calling
    // connection to be ATTACHED to `sessionId` (`ipc/server.ts`'s handlers append straight to that
    // session's hub). `kind` is a plain `String`, not `SessionEvent.PanelTabKind`: this package has
    // no reason to depend on the App target's own UI-side `PanelTabKind`, and the wire values are
    // already plain strings (`methods.ts`'s `PanelTabKind` zod enum).

    /// `panel.openTab {sessionId, kind, url?, title?}` (methods.ts `PanelOpenTabParams`). The
    /// daemon MINTS `tabId` (`PanelOpenTabResult.tabId`, returned here) — there is no way to pass
    /// one in, on purpose: that is what makes an agent-opened tab and a user-opened tab
    /// indistinguishable downstream (methods.ts's own doc comment on this RPC).
    public func openPanelTab(sessionId: String, kind: String, url: String? = nil, title: String? = nil) async throws -> String {
        let r = try await request("panel.openTab", params: obj([
            "sessionId": .string(sessionId), "kind": .string(kind),
            "url": url.map { .string($0) }, "title": title.map { .string($0) },
        ]))
        guard let tabId = r["tabId"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for panel.openTab")
        }
        return tabId
    }

    /// `panel.closeTab {sessionId, tabId}` (methods.ts `PanelCloseTabParams`).
    public func closePanelTab(sessionId: String, tabId: String) async throws {
        _ = try await request("panel.closeTab", params: obj(["sessionId": .string(sessionId), "tabId": .string(tabId)]))
    }

    /// `panel.activateTab {sessionId, tabId}` (methods.ts `PanelActivateTabParams`).
    public func activatePanelTab(sessionId: String, tabId: String) async throws {
        _ = try await request("panel.activateTab", params: obj(["sessionId": .string(sessionId), "tabId": .string(tabId)]))
    }

    /// panel-cef Task 6b: `panel.reportNavigation {sessionId, tabId, url, title}` (methods.ts
    /// `PanelReportNavigationParams`). The RPC has existed since Plan A with no producer; the panel's
    /// CEF browser is the first, and the only possible, one — a committed top-level navigation is a
    /// FACT only the app witnesses, never a request, which is why there is no `panel.navigate`
    /// counterpart (that verb travels the other way, as a transient `panel_command`).
    ///
    /// **The daemon refuses a `url` that is not `http`/`https`, or either field over its cap.** The
    /// caller is expected to have filtered already (`PanelURLPolicy`, app side) — this is defence in
    /// depth, not the primary gate — and because every call site wraps this in `try?`, a rejection
    /// is SILENT. Anything that changes the policy on one side must change it on the other.
    public func reportPanelNavigation(sessionId: String, tabId: String, url: String, title: String) async throws {
        _ = try await request("panel.reportNavigation", params: obj([
            "sessionId": .string(sessionId), "tabId": .string(tabId),
            "url": .string(url), "title": .string(title),
        ]))
    }

    /// B2 Task 2: `panel.commandResult {sessionId, commandId, ok, result?, imageBase64?}` (methods.ts
    /// `PanelCommandResultParams`) — the ANSWER to a `panel_command` transient. The daemon holds a
    /// pending entry keyed by `commandId` until this arrives or its `deadlineMs` expires.
    ///
    /// **`ok` is the verdict on the VERB, not a transport ack.** `ok: false` with `result` carrying
    /// the reason is how "no element matched that selector" or "the sensitive-field floor refused
    /// this type" travels. A verb that could not be attempted at all is still a `false` result — the
    /// daemon-side TIMEOUT is a different outcome entirely and is never produced by this call.
    ///
    /// **Call it at most once per `commandId`, and don't fear calling it late.** First result wins;
    /// a duplicate — or one that crossed the deadline in flight — is dropped daemon-side with a log
    /// line and still answered `{ok:true}`, because the loser of that race has no way to have known.
    /// The one case that DOES throw is a `commandId` the daemon has no record of (NOT_FOUND).
    ///
    /// **"At most", because B2 Task 3's consumer deliberately calls it ZERO times for two shapes** —
    /// a command that arrives during the app's quit beat, and a verb still running when the app's own
    /// copy of the deadline fires. Both leave the command to expire daemon-side, which is the honest
    /// outcome in each (see `PanelCommandResultParams`'s own doc, methods.ts, for the reasoning).
    ///
    /// **`result` is capped at 64 KiB and `imageBase64` at 3 MiB (`PANEL_COMMAND_RESULT_MAX_LENGTH`/
    /// `PANEL_COMMAND_IMAGE_B64_MAX_LENGTH`), and an over-cap value is REFUSED, not truncated** —
    /// the command then expires on its deadline and the agent is told "timed out" rather than handed
    /// a shortened page or a corrupt half-image. Cap app-side first: this is defence in depth, the
    /// same relationship `reportPanelNavigation`'s URL policy has with `PanelURLPolicy`.
    /// `imageBase64` is raw base64 — no `data:` prefix.
    public func sendPanelCommandResult(
        sessionId: String, commandId: String, ok: Bool, result: String? = nil, imageBase64: String? = nil
    ) async throws {
        _ = try await request("panel.commandResult", params: obj([
            "sessionId": .string(sessionId), "commandId": .string(commandId), "ok": .bool(ok),
            "result": result.map { .string($0) },
            "imageBase64": imageBase64.map { .string($0) },
        ]))
    }

    /// panel-shell T9: `panel.list {sessionId}` (methods.ts `PanelListParams`/`PanelListResult`) —
    /// the CURRENT fold, re-read fresh by the daemon on every call (Task 6's reviewer signed off on
    /// that cost — bounded by tab count, never the phone transport). The app's instant-display seed
    /// on a session switch, ahead of whatever the slower full replay eventually redelivers.
    public func listPanelTabs(sessionId: String) async throws -> (tabs: [PanelTabInfo], activeTabId: String?) {
        let r = try await request("panel.list", params: obj(["sessionId": .string(sessionId)]))
        let tabs: [PanelTabInfo] = (r["tabs"]?.arrayValue ?? []).compactMap { t in
            guard let tabId = t["tabId"]?.stringValue, let kind = t["kind"]?.stringValue else { return nil }
            return PanelTabInfo(tabId: tabId, kind: kind, url: t["url"]?.stringValue, title: t["title"]?.stringValue)
        }
        return (tabs, r["activeTabId"]?.stringValue)
    }
}

/// `panel.list`'s per-tab wire shape (`PanelTabSchema`, methods.ts). `kind` stays a plain `String`
/// here, not the App target's UI-side `PanelTabKind` — this package has no reason to depend on it,
/// same reasoning as `openPanelTab(kind:)`'s own doc comment just above.
public struct PanelTabInfo: Equatable, Sendable {
    public let tabId: String
    public let kind: String
    public let url: String?
    public let title: String?

    public init(tabId: String, kind: String, url: String?, title: String?) {
        self.tabId = tabId
        self.kind = kind
        self.url = url
        self.title = title
    }
}
