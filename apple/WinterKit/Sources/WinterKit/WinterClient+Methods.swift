import Foundation
import WinterProtocol

// MARK: - Plugin lifecycle types (WS-21, spec §5.2: `winter plugin` = `claude plugin`, Contract B)
//
// The pre-WS-21 5 lifecycle RPCs (`plugins.install`/`plugin.enable{name,consent?}`/
// `plugin.disable{name}`/`plugin.remove{name}`) are RETIRED. `plugin.enable`/`plugin.disable` keep
// their METHOD NAMES but take a new, incompatible params shape (`{spec, scope, cwd?}`); `plugin.list`
// replaces `plugins.list`, `plugin.install` (a scoped `{spec, scope, cwd?}`, never a bare folder path
// — see `directoryMarketplacePluginNames`/`PluginManagerModel.installFromFolder` for the
// marketplace.add-then-install two-step a folder needs) replaces `plugins.install`, and
// `plugin.uninstall` replaces `plugin.remove`.
//
// None of `plugin.install`/`plugin.uninstall`/`plugin.enable`/`plugin.disable`/`plugin.update` wire
// results are typed unions any more (methods.ts: `PluginInstallResult`/`PluginUninstallResult`/
// `PluginSetEnabledResult`/`PluginUpdateResult` are bare `{ok:true, ...}` objects) — an expected
// refusal (unknown plugin/marketplace, an unwritable settings file, …) is now a thrown
// `RpcFailure(INVALID_PARAMS, message)` (`throwPluginManagerFailure`, ipc/server.ts), which surfaces
// here as an ordinary thrown `RpcError`; callers catch it exactly like any other RPC failure rather
// than switching on a decoded outcome case. `plugin.setConsent`/`shortcut.invoke`/`tile.action` are
// the survivors of the old typed-union discipline — see `PluginSetConsentOutcome`/`PluginPushOutcome`
// below. `plugin.setConsent`'s own wire shape is NOT frozen, though: fix round 3 added a third
// outcome (`.staleDisclosure`) and a required `fingerprint` param, both part of a TOCTOU fix.

/// claude's plugin scopes (methods.ts `PluginScopeSchema`): which settings tier carries
/// `enabledPlugins` — `user` = `sdk/settings.json`, `project` = `<root>/.winter/settings.json`,
/// `local` = `<root>/.winter/settings.local.json`. `project`/`local` need a `cwd` the daemon can
/// resolve a project root from; every call below refuses typed (INVALID_PARAMS) without one.
public enum PluginScope: String, Equatable, Sendable {
    case user, project, local
}

/// Contract B `InstalledPlugin` (methods.ts `InstalledPluginSchema`) — the result of
/// `plugin.install`/`plugin.update`. `installPath` is absolute and stable; NOT a
/// `<home>/plugins/<name>` convention (a plugin can install anywhere a directory marketplace names).
public struct InstalledPlugin: Equatable, Sendable {
    public let id: String
    public let version: String?
    public let installPath: String
    public let scope: PluginScope

    public init(id: String, version: String?, installPath: String, scope: PluginScope) {
        self.id = id
        self.version = version
        self.installPath = installPath
        self.scope = scope
    }
}

/// Contract B `MarketplaceInfo` (methods.ts `MarketplaceInfoSchema`). A `directory` marketplace is
/// read IN PLACE (F15) — `path` IS the source, so removing/moving it breaks every plugin installed
/// from it.
public struct MarketplaceInfo: Equatable, Sendable {
    public let name: String
    public let source: String
    public let kind: String
    public let path: String

    public init(name: String, source: String, kind: String, path: String) {
        self.name = name
        self.source = source
        self.kind = kind
        self.path = path
    }
}

/// `winter-plugin.json`'s `entry` (spec §5.1: "tier, permissions, contributes.{...} and entry") —
/// what the daemon's `PluginSupervisor` spawns for a Tier-2 (`platform`) plugin.
public struct PluginEntryInfo: Equatable, Sendable {
    public let command: String
    public let args: [String]

    public init(command: String, args: [String]) {
        self.command = command
        self.args = args
    }
}

/// The Winter-only extras a `winter-plugin.json` declares (spec §5.1/§5.4), carried on
/// `plugin.list`'s per-row `extras` — absent entirely for a plugin with no `winter-plugin.json` (an
/// ordinary claude plugin, spec F15: "a manifest is optional"). `requiredConsents`/`consented` are
/// coarse classes (`"exec"`/`"tcc"`/`"hardware"`, `agent/plugins.ts`'s own `CONSENT_CLASSES`) — NOT
/// one entry per individual tcc/hardware permission; `tccPermissions`/`hardwarePermissions` below
/// carry the individual names for disclosure text.
public struct PluginExtras: Equatable, Sendable {
    public let tier: String // "capability" | "platform"
    public let execPermission: Bool
    public let tccPermissions: [String]
    public let hardwarePermissions: [String]
    public let requiredConsents: [String]
    public let consented: [String]
    public let entry: PluginEntryInfo?
    /// Fix round 3 (TOCTOU fix, contract update from L4): a fingerprint of the plugin's install
    /// path + entry, as of THIS `plugin.list` row. `pluginSetConsent(spec:classes:fingerprint:)`
    /// must be called with the SAME value the consent sheet was built from — the daemon refuses
    /// (`.staleDisclosure`) when it no longer matches the plugin's current install, closing the
    /// window where a plugin could change (a reinstall, an entry edit) between the sheet being
    /// shown and the user confirming it.
    public let fingerprint: String

    public init(tier: String, execPermission: Bool, tccPermissions: [String], hardwarePermissions: [String],
               requiredConsents: [String], consented: [String], entry: PluginEntryInfo?, fingerprint: String) {
        self.tier = tier
        self.execPermission = execPermission
        self.tccPermissions = tccPermissions
        self.hardwarePermissions = hardwarePermissions
        self.requiredConsents = requiredConsents
        self.consented = consented
        self.entry = entry
        self.fingerprint = fingerprint
    }

    /// Required classes not yet granted — what a consent sheet asks for and what
    /// `pluginSetConsent(classes:)` should be called with on confirm. Empty when nothing is
    /// outstanding (no extras, no required classes, or everything already consented).
    public var pendingConsents: [String] { requiredConsents.filter { !consented.contains($0) } }
    public var needsConsent: Bool { !pendingConsents.isEmpty }
}

/// One entry of `plugin.list`'s per-row `hooks` (fix round 1) — a plugin's `hooks/hooks.json` plus
/// its manifest, filled by the daemon. `command` is capped at 500 characters server-side, and each
/// plugin reports at most 100 entries. `nil`/`""` fields decode as `nil`, never an empty string, so
/// a view can tell "not declared" from "declared empty" the same way the rest of this file does.
///
/// Fix round 3: `event`/`type` are `String?` now, not `String` — a malformed entry (either field
/// missing) is no longer DROPPED at decode time (a client that silently drops a declaration it
/// can't fully parse under-reports what actually runs, the exact class of bug the retired
/// `manifestHooks`' own history warned against). It decodes as an entry with `nil` there instead,
/// and the view renders it as "(unnamed)" rather than hiding it.
public struct PluginHookEntry: Equatable, Sendable {
    public let event: String?
    public let matcher: String?
    public let type: String?
    public let command: String?

    public init(event: String?, matcher: String?, type: String?, command: String?) {
        self.event = event
        self.matcher = matcher
        self.type = type
        self.command = command
    }
}

/// One `plugin.list` row — Contract B's `PluginListing` (`id`/`installPath`/`scope`/`enabled`/
/// `marketplace`/`version`) plus the optional `extras` object the daemon merges on from
/// `winter-plugin.json` (WS-21), plus the optional per-plugin `hooks` array (fix round 1). `spec`
/// is the qualified `"<id>@<marketplace>"` claude/Contract B use to name an install everywhere else
/// (`plugin.install`/`.uninstall`/`.enable`/`.disable`'s own `spec` param) — `id` ALONE is not
/// unique (two plugins can share a bare name across marketplaces).
///
/// **`hooks == nil` and `hooks == []` are different answers.** `nil` means the daemon could not
/// read/build this plugin's hook list (e.g. a malformed `hooks.json`); `[]` means it read the
/// plugin and found none declared. A view must render two different sentences for those, never
/// collapse them — same discipline the retired `manifestHooks` field used, now scoped to one row
/// instead of the whole list.
public struct PluginListing: Equatable, Sendable {
    public let id: String
    public let installPath: String
    public let scope: PluginScope
    public let enabled: Bool
    public let marketplace: String
    public let version: String?
    public let extras: PluginExtras?
    public let hooks: [PluginHookEntry]?

    public init(id: String, installPath: String, scope: PluginScope, enabled: Bool, marketplace: String,
               version: String?, extras: PluginExtras?, hooks: [PluginHookEntry]? = nil) {
        self.id = id
        self.installPath = installPath
        self.scope = scope
        self.enabled = enabled
        self.marketplace = marketplace
        self.version = version
        self.extras = extras
        self.hooks = hooks
    }

    public var spec: String { "\(id)@\(marketplace)" }
}

/// `plugin.setConsent`'s result (fix round 3 — `PluginSetConsentResult` gained a third case as
/// part of the TOCTOU fix, contract update from L4): `{ok:true}` | `{code:"unknown_plugin"}` |
/// `{code:"stale_disclosure"}`. The daemon returns `.staleDisclosure` when the `fingerprint` a
/// call named no longer matches the plugin's current install — the caller must refresh, rebuild
/// its disclosure from the new `plugin.list` row, and ask again; it must NOT enable on this
/// outcome (`PluginManagerModel.confirmConsent()`'s own handling).
public enum PluginSetConsentOutcome: Equatable, Sendable {
    case ok
    case unknownPlugin
    case staleDisclosure
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

// WS-21: `PluginManifestHook`/`manifestHooks` retired here — a plugin's hooks are claude-native
// `hooks/hooks.json` content now (spec §5.1/§5.3), loaded by both runtimes directly. The narrowed
// `WinterPluginManifest` (`agent/plugin-manifest.ts`) no longer carries `contributes.hooks` at all,
// so no daemon build will ever send this field again — see `LibraryHooksTab.swift`'s own header for
// what the Library's Hooks tab shows in its place.

// MARK: - working-directories T8: a session's ordered working-directory set

/// One entry of a session's working-directory set — mirrors the protocol's `SessionDirEntry`
/// (`packages/protocol/src/methods.ts`) field-for-field. Shared by BOTH halves of the wire, exactly
/// as it is on the daemon side: `session.list`'s per-row `dirs` (read) and `session.setDirs`'s
/// result (write).
///
/// **`dirs[0]` is the PRIMARY by POSITION, not by a flag** — there is no `primary` field to read,
/// and a set is never "secondaries without a primary" (the daemon refuses `remove` of index 0
/// outright). `locked` is the first-write lock: once Winter has successfully written inside a
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

    /// Also not in the core set, which stops at `intValue` (a number that rounds to itself). Prices
    /// are the first wire numbers here that are genuinely fractional — `$0.075 per 1M tokens` reads
    /// as `0` through `intValue` — so they need the undamaged double.
    var doubleValue: Double? { if case .number(let n) = self { return n }; return nil }
}

extension WinterClient {
    private func obj(_ pairs: [String: JSONValue?]) -> JSONValue {
        .object(pairs.compactMapValues { $0 })
    }

    /// `{code:"unknown_plugin"|"stale_disclosure"}` | `{ok:true}` decode for `plugin.setConsent`
    /// (fix round 3: gained the `stale_disclosure` case — see `PluginSetConsentOutcome`'s own doc).
    private func decodeSetConsentOutcome(_ r: JSONValue, method: String) throws -> PluginSetConsentOutcome {
        if let code = r["code"]?.stringValue {
            switch code {
            case "unknown_plugin": return .unknownPlugin
            case "stale_disclosure": return .staleDisclosure
            default: throw RpcError(code: -3, message: "unknown code from server for \(method): \(code)")
            }
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

    /// Fix round 1 (M2): a missing or unrecognized `scope` decodes to `nil`, never a silent `.user`
    /// default — a client guessing the scope wrong could act on (enable/disable/uninstall) the
    /// WRONG settings tier's record. Callers drop the row (`decodePluginListing`) or throw
    /// (`decodeInstalledPlugin`) rather than substitute a guess.
    private func decodePluginScope(_ raw: String?) -> PluginScope? {
        raw.flatMap(PluginScope.init(rawValue:))
    }

    private func decodeInstalledPlugin(_ p: JSONValue?, method: String) throws -> InstalledPlugin {
        guard let p, let id = p["id"]?.stringValue, let installPath = p["installPath"]?.stringValue,
              let scope = decodePluginScope(p["scope"]?.stringValue) else {
            throw RpcError(code: -3, message: "invalid result from server for \(method)")
        }
        return InstalledPlugin(id: id, version: p["version"]?.stringValue, installPath: installPath, scope: scope)
    }

    private func decodeMarketplaceInfo(_ m: JSONValue?, method: String) throws -> MarketplaceInfo {
        guard let m, let name = m["name"]?.stringValue, let source = m["source"]?.stringValue,
              let kind = m["kind"]?.stringValue, let path = m["path"]?.stringValue else {
            throw RpcError(code: -3, message: "invalid result from server for \(method)")
        }
        return MarketplaceInfo(name: name, source: source, kind: kind, path: path)
    }

    private func decodePluginExtras(_ e: JSONValue?) -> PluginExtras? {
        // Fix round 3: `fingerprint` is required, same posture as `tier` — an `extras` object
        // without one can't back a consent sheet at all (there'd be nothing to call
        // `pluginSetConsent(fingerprint:)` with), so it's treated as no extras rather than a
        // partially-usable one.
        guard let e, let tier = e["tier"]?.stringValue, let fingerprint = e["fingerprint"]?.stringValue else { return nil }
        let permissions = e["permissions"]
        var entry: PluginEntryInfo?
        if let entryObj = e["entry"], let command = entryObj["command"]?.stringValue {
            entry = PluginEntryInfo(command: command, args: (entryObj["args"]?.arrayValue ?? []).compactMap { $0.stringValue })
        }
        return PluginExtras(
            tier: tier,
            execPermission: permissions?["exec"]?.boolValue ?? false,
            tccPermissions: (permissions?["tcc"]?.arrayValue ?? []).compactMap { $0.stringValue },
            hardwarePermissions: (permissions?["hardware"]?.arrayValue ?? []).compactMap { $0.stringValue },
            requiredConsents: (e["requiredConsents"]?.arrayValue ?? []).compactMap { $0.stringValue },
            consented: (e["consented"]?.arrayValue ?? []).compactMap { $0.stringValue },
            entry: entry,
            fingerprint: fingerprint
        )
    }

    /// Fix round 1: a plugin's `hooks` array, when the key is present at all — see
    /// `PluginListing.hooks`'s own doc for why `nil` (key absent) and `[]` (present, empty) must
    /// stay distinct — the daemon-L4 ruling this round: `[]` means none declared, a missing key
    /// means unreadable. Fix round 3: a malformed ENTRY (no `event`/`type`) is no longer dropped —
    /// every entry the array carries decodes to a row (`PluginHookEntry.event`/`.type` are
    /// optional now), so a plugin's own count of "how many hooks run" is never silently
    /// under-reported; the view renders a missing name as "(unnamed)" instead of hiding the row.
    private func decodePluginHooks(_ h: JSONValue?) -> [PluginHookEntry]? {
        guard let arr = h?.arrayValue else { return nil }
        return arr.map { entry in
            PluginHookEntry(event: entry["event"]?.stringValue, matcher: entry["matcher"]?.stringValue,
                            type: entry["type"]?.stringValue, command: entry["command"]?.stringValue)
        }
    }

    private func decodePluginListing(_ p: JSONValue) -> PluginListing? {
        guard let id = p["id"]?.stringValue, let installPath = p["installPath"]?.stringValue,
              let enabled = p["enabled"]?.boolValue, let marketplace = p["marketplace"]?.stringValue,
              let scope = decodePluginScope(p["scope"]?.stringValue) else { return nil }
        return PluginListing(
            id: id, installPath: installPath, scope: scope,
            enabled: enabled, marketplace: marketplace, version: p["version"]?.stringValue,
            extras: decodePluginExtras(p["extras"]), hooks: decodePluginHooks(p["hooks"])
        )
    }

    /// `plugin.list {cwd?}` (WS-21) — every plugin `installed_plugins.json` records, `enabled`
    /// resolved per its OWN scope (`user` always; `project`/`local` only when `cwd` is given and
    /// resolves to a project root), with the daemon's `winter-plugin.json` read merged onto
    /// `extras` when one exists. Replaces the retired `plugins.list`.
    public func pluginList(cwd: String? = nil) async throws -> [PluginListing] {
        let r = try await request("plugin.list", params: obj(["cwd": cwd.map { .string($0) }]))
        return (r["plugins"]?.arrayValue ?? []).compactMap { decodePluginListing($0) }
    }

    /// `plugin.install {spec, scope, cwd?}` (WS-21) — `spec` is `"<plugin>[@<marketplace>]"`
    /// (claude's default marketplace resolution when `@marketplace` is omitted and there is only
    /// one candidate) and `scope` defaults to claude's own default, `user`. A bare LOCAL FOLDER is
    /// NOT a valid `spec` — the daemon has no "read this marketplace before it's registered" RPC;
    /// `installFromFolder`/`directoryMarketplacePluginNames` (`PluginManagerView.swift`) do
    /// `pluginMarketplaceAdd` then this, exactly as `winter plugin install <folder>` does locally.
    /// Throws (never a typed refusal) for an unknown/ambiguous spec — see this section's header.
    public func pluginInstall(spec: String, scope: PluginScope = .user, cwd: String? = nil) async throws -> InstalledPlugin {
        let r = try await request("plugin.install", params: obj([
            "spec": .string(spec), "scope": .string(scope.rawValue), "cwd": cwd.map { .string($0) },
        ]))
        return try decodeInstalledPlugin(r["plugin"], method: "plugin.install")
    }

    /// `plugin.uninstall {spec, scope, cwd?}` (WS-21, Contract B's own name — replaces
    /// `plugin.remove`) — unregisters the install record + `enabledPlugins` entry ONLY; a directory
    /// marketplace is read in place (F15/spec §5.2), so this never deletes anything on disk.
    public func pluginUninstall(spec: String, scope: PluginScope = .user, cwd: String? = nil) async throws -> (spec: String, scope: PluginScope) {
        let r = try await request("plugin.uninstall", params: obj([
            "spec": .string(spec), "scope": .string(scope.rawValue), "cwd": cwd.map { .string($0) },
        ]))
        guard let spec = r["spec"]?.stringValue, let scope = r["scope"]?.stringValue.flatMap(PluginScope.init(rawValue:)) else {
            throw RpcError(code: -3, message: "invalid result from server for plugin.uninstall")
        }
        return (spec, scope)
    }

    private func decodeSetEnabledResult(_ r: JSONValue, method: String) throws -> (spec: String, scope: PluginScope, enabled: Bool) {
        guard let spec = r["spec"]?.stringValue, let scope = r["scope"]?.stringValue.flatMap(PluginScope.init(rawValue:)),
              let enabled = r["enabled"]?.boolValue else {
            throw RpcError(code: -3, message: "invalid result from server for \(method)")
        }
        return (spec, scope, enabled)
    }

    /// `plugin.enable {spec, scope, cwd?}` (WS-21) — install+enable IS the consent for a plugin's
    /// claude-native content (skills/`.mcp.json`/`hooks/hooks.json`, spec §5.4): there is no more
    /// two-step `consent:true` retry. A Winter-only Tier-2 extra still needs `pluginSetConsent`
    /// called BEFORE this — the daemon's hot-spawn (`hotApplyStart`) runs INSIDE this call's own
    /// handler and reads consent synchronously, so calling `pluginSetConsent` after an `enable`
    /// that already ran leaves the process unspawned until another `enable`/`plugin.restart`.
    public func pluginEnable(spec: String, scope: PluginScope = .user, cwd: String? = nil) async throws -> (spec: String, scope: PluginScope, enabled: Bool) {
        let r = try await request("plugin.enable", params: obj([
            "spec": .string(spec), "scope": .string(scope.rawValue), "cwd": cwd.map { .string($0) },
        ]))
        return try decodeSetEnabledResult(r, method: "plugin.enable")
    }

    /// `plugin.disable {spec, scope, cwd?}` (WS-21) — hot-stops any running Tier-2 process; consent
    /// is orthogonal now (spec §5.4) and is NOT stripped by disabling.
    public func pluginDisable(spec: String, scope: PluginScope = .user, cwd: String? = nil) async throws -> (spec: String, scope: PluginScope, enabled: Bool) {
        let r = try await request("plugin.disable", params: obj([
            "spec": .string(spec), "scope": .string(scope.rawValue), "cwd": cwd.map { .string($0) },
        ]))
        return try decodeSetEnabledResult(r, method: "plugin.disable")
    }

    /// `plugin.update {spec}` (WS-21) — no scope: an install is updated in place, wherever it is.
    public func pluginUpdate(spec: String) async throws -> InstalledPlugin {
        let r = try await request("plugin.update", params: obj(["spec": .string(spec)]))
        return try decodeInstalledPlugin(r["plugin"], method: "plugin.update")
    }

    /// `plugin.marketplace.add {source}` (WS-21) — `source` is a local directory path in this
    /// build (no network; git/github/url sources throw `PluginManagerError`, surfaced as a thrown
    /// `RpcError` here).
    public func pluginMarketplaceAdd(source: String) async throws -> MarketplaceInfo {
        let r = try await request("plugin.marketplace.add", params: obj(["source": .string(source)]))
        return try decodeMarketplaceInfo(r["marketplace"], method: "plugin.marketplace.add")
    }

    public func pluginMarketplaceRemove(name: String) async throws {
        _ = try await request("plugin.marketplace.remove", params: obj(["name": .string(name)]))
    }

    public func pluginMarketplaceList() async throws -> [MarketplaceInfo] {
        let r = try await request("plugin.marketplace.list", params: .object([:]))
        return (r["marketplaces"]?.arrayValue ?? []).compactMap { try? decodeMarketplaceInfo($0, method: "plugin.marketplace.list") }
    }

    /// `plugin.marketplace.update {name?}` — every known marketplace when `name` is omitted.
    public func pluginMarketplaceUpdate(name: String? = nil) async throws {
        _ = try await request("plugin.marketplace.update", params: obj(["name": name.map { .string($0) }]))
    }

    /// `plugin.setConsent {spec, classes, fingerprint}` (fix round 1: `spec` replaces the original
    /// `name` param, since a bare id is ambiguous the moment two marketplaces install the same
    /// plugin. Fix round 3: `fingerprint` added, closing a TOCTOU window — it must be the SAME
    /// value the caller's `plugin.list` row (`PluginExtras.fingerprint`) had when it built the
    /// consent disclosure being confirmed; the daemon refuses `.staleDisclosure` when the plugin's
    /// current install no longer matches it, e.g. a reinstall or an entry edit landed in between).
    /// Records consent WITHOUT enabling — call `pluginEnable` AFTER this for a Tier-2 plugin so its
    /// hot-spawn sees consent already granted (see `pluginEnable`'s own doc).
    public func pluginSetConsent(spec: String, classes: [String], fingerprint: String) async throws -> PluginSetConsentOutcome {
        let r = try await request("plugin.setConsent", params: obj([
            "spec": .string(spec), "classes": .array(classes.map { .string($0) }), "fingerprint": .string(fingerprint),
        ]))
        return try decodeSetConsentOutcome(r, method: "plugin.setConsent")
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
    /// existing call site (the sidebar's "+ New session", `winter-probe`) is unaffected. The Mac
    /// app's "New Chat"/"Chat" menu entries are the first callers to pass `mode: "chat"`.
    ///
    /// mac-chat-parity T7 (spec §5): `model`/`effort` are additive in exactly the same way, and for
    /// a reason the protocol itself documents — a client that must choose them for a session it is
    /// about to create should **stamp them at create** rather than create-then-set, which "leave[s]
    /// a window in which a turn fired immediately after create resolves at the GLOBAL effort,
    /// silently". The Mac's new-chat page fires a turn the instant its session exists, so it is
    /// exactly that client (`ShellSessionHost.sendFirstChatMessage`).
    ///
    /// The daemon validates both with the SAME rules the corresponding setters apply
    /// (`resolveModelSelection` / `assertEffortSelectable`, `packages/core/src/ipc/server.ts`) — a
    /// create can never accept what a set would refuse — and refuses outright rather than dropping,
    /// so a caller is told. Absence is "no override"; `null` is a value the schema refuses, which is
    /// why these ride `obj`'s nil-dropping like `cwd`/`mode` and never `?? .null` (the deliberate
    /// opposite of `setModel`/`setEffort`, where a literal null IS the clear).
    public func createSession(scope: String, cwd: String? = nil, approvalPolicy: String? = nil, mode: String? = nil,
                              model: String? = nil, effort: String? = nil) async throws -> (sessionId: String, trusted: Bool) {
        let r = try await request("session.create", params: obj([
            "scope": .string(scope),
            "cwd": cwd.map { .string($0) },
            "approvalPolicy": approvalPolicy.map { .string($0) },
            "mode": mode.map { .string($0) },
            "model": model.map { .string($0) },
            "effort": effort.map { .string($0) },
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
    /// `pluginList()`'s own `version` field above — every existing labeled call site
    /// (`.sessionId`, `.mode`, etc.) is unaffected. `nil` for every session created/left without an
    /// explicit override, or created before this field existed. T1 itself deferred this threading
    /// ("no consumer yet") — the Mac model picker (`WindowContentView`'s model menu) is that
    /// consumer: it reads a session row's current override straight off this tuple.
    ///
    /// provider-correctness T6: `effort` appended after `model`, same purely-additive precedent
    /// (`SessionListResult`'s own row carries it since T4). The Mac's effort picker is its consumer,
    /// and it must be read with `SessionSummary.effort`'s rule in mind: the value may be a
    /// Winter-level TIER (`sync.config.clientEfforts`, e.g. `"ultra"`) reported verbatim rather than
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
    ///
    /// mac-chat-parity T4: `approvalPolicy` appended LAST, same purely-additive precedent as every
    /// field above it. The READ half of `setPolicy(sessionId:policy:)` — before it, the Mac app's
    /// only source for "what policy is this session on" was its OWN last successful write
    /// (`FieldStateAdapter.sessionPolicy`, seeded `"auto"`), so a session left at `bypass` by the
    /// CLI or another window read "Auto" indefinitely.
    ///
    /// A plain `String`, and NOT narrowed to the six settable modes: a chat session's policy is the
    /// internal `"chat"` that `session.setPolicy` refuses as an input (core's `gate.ts`), and it is
    /// exactly the row whose policy explains why its picker is hidden. `nil` means the daemon did
    /// not say — an older daemon, since every daemon at or past this version stamps EVERY row (it
    /// rides no participation gate, unlike `activity`/`dirs`). **Never coerce that `nil` to
    /// `"auto"`**: that asserts a policy nobody stated, which is the standing lie this field exists
    /// to end. See `FieldStateAdapter.sessionPolicyKnown` (apple/Winter) for the consumer shape.
    /// Winter Phase 8d (Task 4.2): `runtimeKind`/`providerId` appended LAST, same purely-additive
    /// precedent as every field above them (`archived`/`signals`/`approvalPolicy`'s own doc
    /// comments). `runtimeKind` mirrors `SessionListResult.runtimeKind` (methods.ts) —
    /// `"winter-agent"`/`"claude-agent"`/`nil` (never a fourth string; a newer daemon's future enum
    /// case would still decode here since this reads a bare `String`, unlike a Swift enum that
    /// would need every case named up front). `providerId` (P8d-7) is a FINER fact than
    /// `runtimeKind` — read from the runtime-state record, absent independently of it (an older
    /// daemon, a record-less session, or a daemon with no runtime-state door wired at all). Neither
    /// field is ever fabricated from the other.
    public func listSessions() async throws -> [(sessionId: String, scope: String, createdAt: Int, lastSeq: Int, title: String?, cwd: String?, mode: String?, parentSessionId: String?, model: String?, effort: String?, dirs: [SessionDirEntry]?, activity: String?, archived: Bool?, signals: SessionSignals?, approvalPolicy: String?, runtimeKind: String?, providerId: String?)] {
        let r = try await request("session.list", params: nil)
        return (r["sessions"]?.arrayValue ?? []).compactMap { s in
            guard let id = s["sessionId"]?.stringValue, let scope = s["scope"]?.stringValue,
                  let created = s["createdAt"]?.intValue, let last = s["lastSeq"]?.intValue else { return nil }
            return (id, scope, created, last, s["title"]?.stringValue, s["cwd"]?.stringValue, s["mode"]?.stringValue, s["parentSessionId"]?.stringValue, s["model"]?.stringValue, s["effort"]?.stringValue, decodeSessionDirs(s["dirs"]), s["activity"]?.stringValue, s["archived"]?.boolValue, decodeSessionSignals(s["signals"]), s["approvalPolicy"]?.stringValue, s["runtimeKind"]?.stringValue, s["providerId"]?.stringValue)
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
    /// `confirmLossy` (Winter Phase 8d, Interfaces block): the handoff barrier's one-shot
    /// confirmation for a cross-runtime switch (`SessionSetModelParams.confirmLossy`, methods.ts) —
    /// defaulted `false` so every pre-8d call site keeps compiling unchanged. `obj(...)`'s
    /// `compactMapValues` would normally omit a `false` the same as a `nil`, but this method sends
    /// it EXPLICITLY (`.bool(confirmLossy)`, never `confirmLossy ? .bool(true) : nil`) because the
    /// field means something different from absence on the wire only in the caller's own retry path
    /// — always sending the same key either way costs nothing and removes a "did I forget the flag"
    /// class of bug from the confirm-sheet's resend call.
    public func setModel(sessionId: String, model: String?, confirmLossy: Bool = false) async throws {
        _ = try await request("session.setModel", params: obj([
            "sessionId": .string(sessionId),
            "model": model.map { JSONValue.string($0) } ?? JSONValue.null,
            "confirmLossy": .bool(confirmLossy),
        ]))
    }

    /// WS-20 (cross-lane, Lane 4 / Mac app): `settings.setAdvisorModel {model}` — the D30 advisor
    /// override, moved off a direct `settings.json` write (`AppModel.writeAdvisorModelToSettings`,
    /// now retired) so the tag is validated against the pinned catalog BEFORE it lands on disk, the
    /// same transform `winter model --advisor <slug|auto>` already goes through daemon-side.
    /// LOCAL-ROLE ONLY (never reachable from a phone — it has no Winter-leg advisor to configure).
    /// `model: nil` clears the override (falls back to the D30 per-family default) and is sent as a
    /// literal JSON `null`, same "always send the key" convention as `setModel`'s `confirmLossy`.
    /// Returns the RPC's own echoed `model` — what was ACTUALLY stored, never merely what was
    /// requested — `nil` when cleared. A refusal (an invalid/non-catalog tag) throws `RpcError`.
    public func setAdvisorModel(_ model: String?) async throws -> String? {
        let r = try await request("settings.setAdvisorModel", params: obj([
            "model": model.map { JSONValue.string($0) } ?? JSONValue.null,
        ]))
        return r["model"]?.stringValue
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

    // WS-21: the old `plugins.list()` wrapper (Contract A `PluginInfoSchema`'s
    // name/skills/hasMcp/mcpEnabled/disabled/tier/requiredConsents/consented/legacy/status/version/
    // manifestHooks tuple) is retired along with the `plugins.list` RPC itself — see `pluginList(
    // cwd:)`/`PluginListing` above, which replaces it over the new `plugin.list` RPC.

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
    /// `peripheralRespond`'s shape exactly. Only the active provider connection (Winter.app) may
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
    /// codex-oauth stays CLI-only via `winter login`, out of scope here). The server writes the API
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

extension WinterClient {
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
    /// Set for a self-authored skill (`SkillStore.writeSelf` always stamps `author: winter`);
    /// `nil` for every other source. The Dashboard pane's "author: winter" row marker.
    public let author: String?
    /// 2026-09-22: can a SESSION's runtime child load this skill? `false` for every tier the agent
    /// runtime has no door for yet (today only plugin skills reach a child); `nil` from an older daemon
    /// that never said — which is NOT "loads". `sessionNote` is the daemon's own sentence saying why not.
    public let loadsInSessions: Bool?
    public let sessionNote: String?

    /// Explicit memberwise init: a `public` struct's SYNTHESIZED memberwise init is only
    /// `internal` — the Dashboard-side pure helper tests (`DashboardTests.swift`, cross-module)
    /// construct `SkillMeta` values directly (no `WinterClient` round-trip needed for pure display
    /// helpers), so this needs to be public explicitly. The two session fields default to `nil`, so
    /// every existing call site is unchanged.
    public init(name: String, description: String, source: String, path: String, claudeFormat: Bool?, author: String?, loadsInSessions: Bool? = nil, sessionNote: String? = nil) {
        self.name = name
        self.description = description
        self.source = source
        self.path = path
        self.claudeFormat = claudeFormat
        self.author = author
        self.loadsInSessions = loadsInSessions
        self.sessionNote = sessionNote
    }

    /// The line a UI shows under a skill no session can load — `nil` when it loads (or when an older
    /// daemon did not say). One spelling for every surface.
    public var notInSessionsNote: String? {
        guard loadsInSessions == false else { return nil }
        return sessionNote ?? "A session can't load this skill."
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

extension WinterClient {
    /// Shared metadata decode for `skills.list`'s per-entry shape and `skills.read`'s `skill`
    /// object (which is `SkillMetaSchema.extend({body})` — same fields plus `body`).
    private func decodeSkillMeta(_ s: JSONValue) -> SkillMeta? {
        guard let n = s["name"]?.stringValue, let d = s["description"]?.stringValue,
              let src = s["source"]?.stringValue, let p = s["path"]?.stringValue else { return nil }
        return SkillMeta(name: n, description: d, source: src, path: p, claudeFormat: s["claudeFormat"]?.boolValue, author: s["author"]?.stringValue,
                         loadsInSessions: s["loadsInSessions"]?.boolValue, sessionNote: s["sessionNote"]?.stringValue)
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

// MARK: - Workflows (CC-parity phase 3, Track D Task D2: WinterKit workflow.* client surface)
//
// The Swift half of C2's workflow.list/run/stop/get RPCs (protocol/src/methods.ts) — D1 already
// mirrored the 4 `workflow_*` SessionEvent variants (live progress broadcast) in WinterProtocol's
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
/// "stopped"`), same convention as `threadList`/`bgList`/`pluginList`'s own status fields above,
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
/// `workflow.list`'s `saved` array (`WorkflowStore`, C1's trust-gated `.winter/workflows/*.js`
/// scripts).
public struct WorkflowSaved: Equatable, Sendable {
    public let name: String
    public let description: String
    public let source: String
}

extension WinterClient {
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
    /// WS-20: `id`'s own `providerId` half, served pre-split (`splitTag(id).providerId` on the
    /// daemon) so no client ever splits a tag to derive UI structure — the picker groups by THIS,
    /// never by parsing `id`.
    public let providerId: String
    /// WS-20: the catalog row's human-facing name (e.g. "GPT-5.6 Sol") for the picker label.
    public let displayName: String
    /// WS-20: the family SLOT name (e.g. "sol", "terra") when this row fills one, else `nil` — the
    /// per-family facing vocabulary (Terra/Luna/Sol/Astra, Fable/Opus/Sonnet/Haiku, …).
    public let facingName: String?
    public let efforts: [String]

    public init(id: String, providerId: String, displayName: String, facingName: String?, efforts: [String]) {
        self.id = id
        self.providerId = providerId
        self.displayName = displayName
        self.facingName = facingName
        self.efforts = efforts
    }
}

/// What `sync.config` tells a client about models and effort — the catalogue, the daemon's live
/// defaults, and the Winter-level tiers.
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
    /// WHICH PROVIDER everything below describes — WS-20 review fix (Nit 3): the default tag's own
    /// provider id (`splitTag(defaultTag).providerId`, daemon-side), or `"none"` when it runs none,
    /// `""` only when the daemon predates the field.
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
    /// `winter model` edit lands with no restart. `""` when no provider is configured.
    public let defaultModel: String
    /// The active provider's whole catalogue. EMPTY means "no catalogue was reported" — wait, never
    /// derive one.
    public let models: [SyncConfigModelInfo]
    /// The daemon's live reasoning effort. `""` means UNSET (see the type's own note).
    public let defaultEffort: String
    /// WINTER-LEVEL effort tiers — selectable in Winter, **never sent upstream**, and offered on CODE
    /// sessions only. `["ultra"]` on a current daemon.
    ///
    /// A SEPARATE list from `models[].efforts`, and the two must never be concatenated into one
    /// picker section: `models[].efforts` is exactly what the endpoint accepts, a tier is exactly
    /// what it does not (the daemon translates it before a request exists). Scoping a tier to code
    /// sessions is the CLIENT's obligation — the daemon advertises this unconditionally because it
    /// cannot know which session a picker is for.
    public let clientEfforts: [String]

    // No default arguments, same reason `WinterChatKit.SyncConfig`'s init has none: this type is a
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

extension WinterClient {
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
    /// subscription — a caller that wants to track a `winter model --effort` edit re-calls it.
    ///
    /// Decodes LENIENTLY on absence and STRICTLY on shape, the same split `WinterChatKit.SyncConfig`
    /// makes for the same reason: a missing field means an older daemon (degrade to the absent
    /// value), while a present-but-malformed row would put an empty slug into a picker, and an empty
    /// slug reaches a request body verbatim and comes back an opaque 400. A malformed row is
    /// therefore DROPPED from the catalogue rather than admitted — this kit ships in the same
    /// bundle as the daemon it talks to, so a bad row here is a bug on this machine, not a version
    /// skew to tolerate.
    public func syncConfig() async throws -> SyncConfigSnapshot {
        let r = try await request("sync.config", params: .object([:]))
        let models: [SyncConfigModelInfo] = (r["models"]?.arrayValue ?? []).compactMap { m in
            // Mirrors `z.string().min(1)` on `id`/`providerId`/`displayName`/each `efforts` entry —
            // Swift's synthesized decoding enforces none of them, and an empty slug or an empty
            // level is exactly the value that survives all the way to a request body. `facingName`
            // is `.optional()` on the wire, so absence there is a real value, not a drop condition.
            guard let id = m["id"]?.stringValue, !id.isEmpty,
                  let providerId = m["providerId"]?.stringValue, !providerId.isEmpty,
                  let displayName = m["displayName"]?.stringValue, !displayName.isEmpty
            else { return nil }
            let facingName = m["facingName"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            let efforts = (m["efforts"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { !$0.isEmpty }
            return SyncConfigModelInfo(id: id, providerId: providerId, displayName: displayName, facingName: facingName, efforts: efforts)
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

    /// `panel.openTab {sessionId, kind, url?, title?, diffId?}` (methods.ts `PanelOpenTabParams`).
    /// The daemon MINTS `tabId` (`PanelOpenTabResult.tabId`, returned here) — there is no way to
    /// pass one in, on purpose: that is what makes an agent-opened tab and a user-opened tab
    /// indistinguishable downstream (methods.ts's own doc comment on this RPC).
    ///
    /// diff-tabs Task 8: `diffId` is set only when `kind == "diff"` — the daemon's own
    /// `PanelOpenTabParams` refinement enforces that pairing server-side, so this wrapper does no
    /// kind-conditional gating of its own, same relationship `url`'s scheme policy has with
    /// `PanelURLPolicy` (app side is a courtesy, the daemon is the actual gate). Encoded ONLY when
    /// non-nil — `obj(_:)`'s usual contract, never a literal `null` key, matching `url`/`title`.
    public func openPanelTab(sessionId: String, kind: String, url: String? = nil, title: String? = nil, diffId: String? = nil) async throws -> String {
        let r = try await request("panel.openTab", params: obj([
            "sessionId": .string(sessionId), "kind": .string(kind),
            "url": url.map { .string($0) }, "title": title.map { .string($0) },
            "diffId": diffId.map { .string($0) },
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
            return PanelTabInfo(tabId: tabId, kind: kind, url: t["url"]?.stringValue, title: t["title"]?.stringValue, diffId: t["diffId"]?.stringValue)
        }
        return (tabs, r["activeTabId"]?.stringValue)
    }

    /// diff-tabs Task 8: `panel.readDiff {sessionId, diffId}` (methods.ts `PanelReadDiffParams`/
    /// `PanelReadDiffResult`) — the seventh panel method (methods.ts's own count), reading back the
    /// full patch a `tool_result.fileDiff` (events.ts) only summarizes. Harness/admin-only like
    /// every other `panel.*` method: absent from `REMOTE_ALLOWED_METHODS`, so a remote connection
    /// never reaches this.
    ///
    /// **No special-case error handling here, on purpose.** The daemon throws two DIFFERENT typed
    /// refusals and this wrapper surfaces both verbatim, exactly as `request()` already does for
    /// every other method:
    ///  - a shape-invalid `diffId` is INVALID_PARAMS, thrown by `parseParams` before the handler
    ///    body ever runs (never touches disk);
    ///  - a well-shaped `diffId` with nothing stored (deleted, never captured, minted for a
    ///    different session) is NOT_FOUND — `case METHODS.skillsRead`'s "not found" convention
    ///    (ipc/server.ts), reused here rather than re-invented.
    /// Task 10's renderer is expected to catch either as "Diff unavailable"; this layer's job ends
    /// at "don't swallow it".
    public func readPanelDiff(sessionId: String, diffId: String) async throws -> PanelDiffPayload {
        let r = try await request("panel.readDiff", params: obj(["sessionId": .string(sessionId), "diffId": .string(diffId)]))
        guard let path = r["path"]?.stringValue, let added = r["added"]?.intValue, let removed = r["removed"]?.intValue,
              let patch = r["patch"]?.stringValue, let truncated = r["truncated"]?.boolValue else {
            throw RpcError(code: -3, message: "invalid result from server for panel.readDiff")
        }
        return PanelDiffPayload(path: path, added: added, removed: removed, patch: patch, truncated: truncated)
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
    /// diff-tabs Task 8: set only when `kind == "diff"`, same pairing `openPanelTab(diffId:)`
    /// encodes going the other way. **This is the app's ONLY source of a diff tab's identity after
    /// a reattach or a session hop** — `applyFetchedSnapshot` (app side) seeds its panel store from
    /// this call on every attach, never from the transient `panel_tab_opened` event a second time,
    /// so a decode that dropped this field would silently strip diff-tab identity from every tab
    /// that survives past the moment it was opened. `nil` for every other kind, and for an older
    /// daemon that predates this field.
    public let diffId: String?

    public init(tabId: String, kind: String, url: String?, title: String?, diffId: String? = nil) {
        self.tabId = tabId
        self.kind = kind
        self.url = url
        self.title = title
        self.diffId = diffId
    }
}

/// Mirrors `PanelReadDiffResult` (methods.ts) field-for-field — `readPanelDiff`'s return shape.
/// `Codable` (unlike this file's other hand-decoded panel structs): a pure data carrier for a
/// consumer that may want to persist or re-serialize it, not just render it once. `added`/
/// `removed` mirror the store's own counts verbatim (never re-derived here); `truncated` echoes
/// the store's own truncation flag — this RPC never re-truncates on top of it.
public struct PanelDiffPayload: Codable, Equatable, Sendable {
    public let path: String
    public let added: Int
    public let removed: Int
    public let patch: String
    public let truncated: Bool

    public init(path: String, added: Int, removed: Int, patch: String, truncated: Bool) {
        self.path = path
        self.added = added
        self.removed = removed
        self.patch = patch
        self.truncated = truncated
    }
}

// MARK: - Settings-surface reads (2026-09-18): capabilities.list / versions.get / settings.modelRoles
//
// THE ONE THING EVERY CALLER OF THESE FOUR MUST KNOW: they are NOT on every daemon. They landed
// after the app learned to call them, so a daemon from before that answers `-32601` — and that is
// an ordinary, expected reply, not a fault. Each wrapper therefore throws exactly what the daemon
// sent (this file's universal posture; nothing is swallowed here), and every surface branches on
// `RpcError.isMethodNotFound` to render its own "waiting on the daemon" state rather than an error.
// Returning an optional instead would have hidden a REAL failure (a closed socket, a timeout) in
// the same `nil` as a missing method.

/// One tool inside a Winter capability server (`capabilities.list`).
///
/// `modes`/`deferred`/`exposure` say three different things and none implies another:
/// - `modes` — the session modes the tool is REGISTERED for;
/// - `deferred` — the modes where it exists but is not eagerly in the prompt (the model has to
///   search for it), which is a real availability difference a user reading this needs;
/// - `exposure` — the resolved per-mode answer AFTER the mode's `disallowedTools` filter, i.e.
///   what the child actually sees.
///
/// `exposure` is decoded as a raw `[String: Bool]` rather than three named fields, deliberately:
/// the mode set is the daemon's (`SessionMode`), it has grown before, and a struct with
/// `code`/`dispatch`/`chat` properties would silently drop a fourth mode instead of showing it.
public struct WinterCapabilityTool: Equatable, Sendable {
    public let name: String
    public let modes: [String]
    public let deferred: [String]
    public let exposure: [String: Bool]

    public init(name: String, modes: [String], deferred: [String], exposure: [String: Bool]) {
        self.name = name
        self.modes = modes
        self.deferred = deferred
        self.exposure = exposure
    }
}

/// One capability server the daemon runs in-process and hands the runtime child as
/// `winter__<key>` (the child sees `mcp__winter__<key>__<tool>`).
///
/// `enabled` is a LIVE GATE on only two keys (`computer`, `lsp`); every other key always reports
/// `true`, so a UI must not render "enabled" as if it were a per-key switch the user set.
///
/// An EMPTY `tools` array is normal — `external` is the plugin-contributed server and has no tools
/// until a plugin contributes some. It is never an error and must not render as one.
public struct WinterCapability: Equatable, Sendable {
    public let key: String
    public let enabled: Bool
    public let tools: [WinterCapabilityTool]

    public init(key: String, enabled: Bool, tools: [WinterCapabilityTool]) {
        self.key = key
        self.enabled = enabled
        self.tools = tools
    }
}

/// A resolved runtime binary (`versions.get`'s `installed.winterExecutable`/`.claudeExecutable`).
///
/// **There is no version here, by nature, not by omission**: the `winter` binary has no version
/// flag, so the only true facts about it are WHERE it is and WHICH resolver rung answered
/// (`settings` / env / bundle / home / package…). Both fields are independently optional.
public struct VersionsExecutable: Equatable, Sendable {
    public let path: String?
    public let source: String?

    public init(path: String?, source: String?) {
        self.path = path
        self.source = source
    }
}

/// `versions.get`'s answer.
///
/// `pins` is what THIS BUILD of the daemon was compiled against; `installed` is what actually
/// resolved. A disagreement is an ordinary consequence of the resolver's rungs (an explicit
/// setting, a dev checkout, a home-local binary) and is a thing to SHOW, never an error to raise.
///
/// Every field is independently optional: `pins`/`installed` are decoded as plain string maps so a
/// fourth pin a later daemon adds arrives intact instead of being dropped by a fixed struct, and
/// `official` is `nil` when no Release bundle is staged — a normal state on every dev machine.
public struct VersionsSnapshot: Equatable, Sendable {
    /// The daemon's own version (`VERSION`).
    public let core: String?
    /// Compile-time pins, keyed as the wire keys them (`winterAgentSdk`, `winterRuntimeSdk`,
    /// `claudeAgentSdk`).
    public let pins: [String: String]
    /// Actually-resolved SDK versions, same keys. Only the STRING-valued entries land here; the
    /// two executable objects are split out below because they carry no version at all.
    public let installed: [String: String]
    public let winterExecutable: VersionsExecutable?
    public let claudeExecutable: VersionsExecutable?
    /// The staged Release bundle's own block, kept OPAQUE: its shape is the daemon's and no
    /// surface reads it yet, so decoding it into named fields would be inventing a contract.
    /// `nil` when nothing is staged.
    public let official: [String: JSONValue]?

    public init(core: String?, pins: [String: String], installed: [String: String],
                winterExecutable: VersionsExecutable?, claudeExecutable: VersionsExecutable?,
                official: [String: JSONValue]?) {
        self.core = core
        self.pins = pins
        self.installed = installed
        self.winterExecutable = winterExecutable
        self.claudeExecutable = claudeExecutable
        self.official = official
    }
}

/// One provider a role may use, with the models it may use from it (`settings.modelRoles`'
/// per-role `permitted`). Provider-grouped on the wire because that is how a picker must group it;
/// `models` are already fully-qualified tags (`openai/gpt-5.4`), never bare ids.
public struct ModelRolePermittedProvider: Equatable, Sendable {
    public let providerId: String
    public let displayName: String
    public let models: [String]

    public init(providerId: String, displayName: String, models: [String]) {
        self.providerId = providerId
        self.displayName = displayName
        self.models = models
    }
}

/// What the daemon reports for one model role.
///
/// `model` is OPTIONAL because eight of the nine roles accept `null` (cleared → the role falls
/// back to its derived default); `provider.model` alone always carries one. A `nil` model is a
/// real, renderable state and is not the same as "the daemon told us nothing about this role",
/// which is the role's key being absent from the map entirely.
///
/// `explicit == false` means the value is DERIVED — it moves on its own when `provider.model`
/// changes — which is the single most important thing this pane exists to show.
///
/// `constraint` is the raw wire string (`any` | `internal-provider` | `same-as-session`), not an
/// enum: a constraint the daemon adds later must reach the screen, not be dropped by this decode.
public struct ModelRoleValue: Equatable, Sendable {
    public let model: String?
    public let explicit: Bool
    public let constraint: String
    public let permitted: [ModelRolePermittedProvider]
    /// The reasoning effort STORED for this role, or nil when none is (the model's own default
    /// applies). Stored and validated daemon-side — see `setModelRole`'s doc for what spends it.
    public let effort: String?
    /// True when `effort` was set on purpose rather than falling out of a default.
    public let effortExplicit: Bool
    /// The effort vocabulary of this role's CURRENT model, in the catalog's own order (never
    /// sorted — the order genuinely varies by provider). **Three states, not two:** `nil` = the
    /// model has no reasoning block at all; `[]` = a reasoning block with an EMPTY vocabulary;
    /// non-empty = the efforts the daemon will accept (plus `"none"`, which it accepts but never
    /// lists). Same meaning as `CatalogModel.efforts`.
    public let efforts: [String]?
    /// The role's CURRENT problem — its last failure, classified daemon-side — or nil when it has
    /// none (or the daemon predates the field). Cleared daemon-side by the role's next successful
    /// call and whenever its effective model changes, so a client renders exactly what is reported
    /// and never ages anything out itself.
    public let problem: ModelRoleProblem?

    public init(model: String?, explicit: Bool, constraint: String,
                permitted: [ModelRolePermittedProvider],
                effort: String? = nil, effortExplicit: Bool = false, efforts: [String]? = nil,
                problem: ModelRoleProblem? = nil) {
        self.model = model
        self.explicit = explicit
        self.constraint = constraint
        self.permitted = permitted
        self.effort = effort
        self.effortExplicit = effortExplicit
        self.efforts = efforts
        self.problem = problem
    }
}

/// `settings.modelRoles`' per-role `problem`: `null | { reason, detail, model, at, retryAt? }`.
///
/// Every field is carried RAW. `reason` is the daemon's classification (`rate-limited`,
/// `usage-limit`, `out-of-credits`, `credential-rejected`, `no-credential`, `model-unavailable`,
/// `provider-unavailable`, `other`, …) kept as a STRING — a reason a later daemon adds must reach
/// the screen, not be dropped by a closed enum. `at`/`retryAt` stay ISO-8601 strings; parsing them
/// is the consumer's job, so an unparseable timestamp costs a time, never the whole note.
public struct ModelRoleProblem: Equatable, Sendable {
    public let reason: String
    /// One short line, sanitized and capped daemon-side. Consumers still clip it.
    public let detail: String?
    /// The EFFECTIVE tag that failed at the time — which may differ from the role's model now.
    public let model: String?
    public let at: String?
    /// Present ONLY when the provider said when it comes back (retry-after, a plan window's reset).
    public let retryAt: String?

    public init(reason: String, detail: String? = nil, model: String? = nil,
                at: String? = nil, retryAt: String? = nil) {
        self.reason = reason
        self.detail = detail
        self.model = model
        self.at = at
        self.retryAt = retryAt
    }
}

/// What `settings.setModelRole` is told about a role's MODEL — the same three states as
/// `ModelRoleEffortWrite`:
///
/// - `.leave` — the key is OMITTED: the stored model (pinned or defaulted) is left untouched.
///   **Only meaningful once the daemon makes `model` optional** (it is required-nullable today, so
///   a daemon without that change refuses the request); a call omitting BOTH fields is refused.
/// - `.clear` — a literal `"model": null`: unpin, back to the derived default.
/// - `.set(tag)` — `"model": "<tag>"`, always provider-qualified.
public enum ModelRoleModelWrite: Equatable, Sendable {
    case leave
    case clear
    case set(String)

    /// The two-state spelling every older caller used: a tag sets it, nil clears it.
    public init(_ tag: String?) {
        self = tag.map { .set($0) } ?? .clear
    }
}

/// What `settings.setModelRole` is told about a role's effort. **Three cases, because the wire has
/// three**, and a `String?` can only spell two of them:
///
/// - `.leave` — the key is OMITTED: the stored effort is left exactly as it is.
/// - `.clear` — a literal `"effort": null`: clear it back to the model's default.
/// - `.set(e)` — `"effort": "<e>"`. Refused (`INVALID_PARAMS`) when `e` is outside the model's
///   vocabulary, and for ANY value on a model with no vocabulary.
public enum ModelRoleEffortWrite: Equatable, Sendable {
    case leave
    case clear
    case set(String)
}

/// PRIVATE decode of an effort vocabulary. `null`/absent → nil (no reasoning block), an array →
/// its strings IN WIRE ORDER (never sorted), so `[]` survives as `[]`.
fileprivate func effortVocabulary(_ v: JSONValue?) -> [String]? {
    v?.arrayValue.map { $0.compactMap { $0.stringValue } }
}

extension WinterClient {
    /// `capabilities.list` — READ-ONLY; the daemon's own in-process capability servers, which are
    /// not in `mcp.list`'s answer at all (that RPC lists EXTERNAL servers).
    ///
    /// Takes no params and starts nothing — unlike `mcp.list`, where passing a `cwd` spawns that
    /// project's servers as a side effect of "listing". A panel can safely call this on appear.
    ///
    /// Throws `-32601` on a daemon that predates the method; see this section's header.
    public func capabilitiesList() async throws -> [WinterCapability] {
        let r = try await request("capabilities.list", params: .object([:]))
        return (r["capabilities"]?.arrayValue ?? []).compactMap { c in
            guard let key = c["key"]?.stringValue else { return nil }
            let tools: [WinterCapabilityTool] = (c["tools"]?.arrayValue ?? []).compactMap { t in
                guard let name = t["name"]?.stringValue else { return nil }
                var exposure: [String: Bool] = [:]
                for (mode, value) in t["exposure"]?.objectValue ?? [:] {
                    if let flag = value.boolValue { exposure[mode] = flag }
                }
                return WinterCapabilityTool(
                    name: name,
                    modes: (t["modes"]?.arrayValue ?? []).compactMap { $0.stringValue },
                    deferred: (t["deferred"]?.arrayValue ?? []).compactMap { $0.stringValue },
                    exposure: exposure
                )
            }
            // `enabled` defaults to TRUE when absent: only `computer`/`lsp` carry a live gate and
            // every other key reports true, so an older/partial shape reading as "off" would
            // libel six working servers.
            return WinterCapability(key: key, enabled: c["enabled"]?.boolValue ?? true, tools: tools)
        }
    }

    /// `versions.get` — READ-ONLY; what this daemon was pinned to and what actually resolved.
    ///
    /// Throws `-32601` on a daemon that predates the method; see this section's header.
    public func versionsGet() async throws -> VersionsSnapshot {
        let r = try await request("versions.get", params: .object([:]))
        func strings(_ v: JSONValue?) -> [String: String] {
            (v?.objectValue ?? [:]).compactMapValues { $0.stringValue }
        }
        func executable(_ v: JSONValue?) -> VersionsExecutable? {
            guard let o = v?.objectValue else { return nil }
            return VersionsExecutable(path: o["path"]?.stringValue, source: o["source"]?.stringValue)
        }
        let installed = r["installed"]
        return VersionsSnapshot(
            core: r["core"]?.stringValue,
            pins: strings(r["pins"]),
            // `compactMapValues { $0.stringValue }` also does the splitting: the two executable
            // entries are OBJECTS, so they simply don't land in the string map.
            installed: strings(installed),
            winterExecutable: executable(installed?["winterExecutable"]),
            claudeExecutable: executable(installed?["claudeExecutable"]),
            // An explicit `null` decodes to `.null`, whose `objectValue` is nil — the same answer
            // as an absent key, which is what "no Release bundle staged" means either way.
            official: r["official"]?.objectValue
        )
    }

    /// PRIVATE: `settings.modelRoles` and `settings.setModelRole` return the SAME map, which is why
    /// one write refreshes a whole pane. Decoded in one place so the two can never drift.
    ///
    /// The map is looked for under `roles` first and then read off the result object itself, minus
    /// the envelope's own `ok` — permissive on purpose, since a key that is not a known role is
    /// dropped rather than fought over.
    private func decodeModelRoles(_ r: JSONValue) -> [String: ModelRoleValue] {
        let raw = r["roles"]?.objectValue
            ?? (r.objectValue ?? [:]).filter { $0.key != "ok" }
        var out: [String: ModelRoleValue] = [:]
        for (role, value) in raw {
            guard let o = value.objectValue else { continue }
            let permitted: [ModelRolePermittedProvider] = (o["permitted"]?.arrayValue ?? []).compactMap { p in
                guard let id = p["providerId"]?.stringValue else { return nil }
                return ModelRolePermittedProvider(
                    providerId: id,
                    // A provider with no facing name falls back to its id rather than rendering
                    // blank — the id is always a true, if plainer, name for it.
                    displayName: p["displayName"]?.stringValue ?? id,
                    models: (p["models"]?.arrayValue ?? []).compactMap { $0.stringValue }
                )
            }
            out[role] = ModelRoleValue(
                // A wire `null` decodes to nil here, exactly as a cleared role should.
                model: o["model"]?.stringValue,
                explicit: o["explicit"]?.boolValue ?? false,
                // Absent constraint reads as the most permissive one the wire defines — a role
                // whose constraint we were not told about must not look narrower than it is.
                constraint: o["constraint"]?.stringValue ?? "any",
                permitted: permitted,
                effort: o["effort"]?.stringValue,
                effortExplicit: o["effortExplicit"]?.boolValue ?? false,
                // `null` and an absent key both decode to nil ("no reasoning block"), while `[]`
                // stays `[]` — the distinction the whole effort control turns on.
                efforts: effortVocabulary(o["efforts"]),
                // `null`/absent = no current problem. A problem with no `reason` has nothing to say
                // and is dropped; every other field is optional so a thinner shape still renders.
                problem: o["problem"]?.objectValue.flatMap { p in
                    p["reason"]?.stringValue.map { reason in
                        ModelRoleProblem(reason: reason,
                                         detail: p["detail"]?.stringValue,
                                         model: p["model"]?.stringValue,
                                         at: p["at"]?.stringValue,
                                         retryAt: p["retryAt"]?.stringValue)
                    }
                }
            )
        }
        return out
    }

    /// `settings.modelRoles` — READ-ONLY; the effective model for each of the nine roles, whether
    /// it was chosen or derived, and which models the daemon would accept for it.
    ///
    /// Keyed by the SETTINGS PATH the role lives at (`pins.dispatch`, `provider.model`,
    /// `titles.model`, `reviewer.model`, `runtimes.advisorModel`, …) — the same string
    /// `setModelRole` sends back.
    ///
    /// Throws `-32601` on a daemon that predates the method; see this section's header.
    public func settingsModelRoles() async throws -> [String: ModelRoleValue] {
        decodeModelRoles(try await request("settings.modelRoles", params: .object([:])))
    }

    /// `settings.setModelRole {role, model|null}` — the write half, returning the WHOLE effective
    /// map so one call refreshes every row (clearing one role moves every other role that was
    /// following it).
    ///
    /// **`model: nil` sends a literal `null`, never an omitted key.** They are different requests:
    /// `null` means "clear this role, fall back to the derived default", while an absent key is a
    /// params shape the daemon's schema would refuse. This is why the params are built by hand
    /// instead of through `obj(...)`, which compacts nils away (and which is correct for every
    /// other wrapper, where absence is the "leave it alone" signal).
    ///
    /// Two refusals the caller must expect and must NOT retry blind: `provider.model` refuses
    /// `null` outright (there is always a default session model), and a BARE model id is refused
    /// everywhere — only provider-qualified tags (`openai/gpt-5.6-terra`) are ever sent.
    ///
    /// **`effort` is the THIRD state, and it is spelled out rather than optional-ed.** `.leave` omits
    /// the key (leave the stored effort untouched), `.clear` sends a literal `"effort": null` (back to
    /// the model's default), `.set` sends the string. The default is `.leave`, so every existing
    /// caller sends exactly the bytes it always did.
    ///
    /// **`model` is three-state too** (`ModelRoleModelWrite`), for the daemon change that makes it
    /// optional (absent = leave the model untouched). Until that lands `model` is required-nullable
    /// daemon-side, so callers send `.set`/`.clear`; `.leave` OMITS the key, exactly as the effort's
    /// `.leave` does. The `String?` overload below keeps every older call site's bytes identical.
    @discardableResult
    public func setModelRole(role: String, model: ModelRoleModelWrite,
                             effort: ModelRoleEffortWrite = .leave) async throws -> [String: ModelRoleValue] {
        var params: [String: JSONValue] = ["role": .string(role)]
        switch model {
        case .leave: break
        case .clear: params["model"] = .null
        case let .set(tag): params["model"] = .string(tag)
        }
        switch effort {
        case .leave: break
        case .clear: params["effort"] = .null
        case let .set(value): params["effort"] = .string(value)
        }
        let r = try await request("settings.setModelRole", params: .object(params))
        return decodeModelRoles(r)
    }

    /// The two-state spelling: a tag sets the model, `nil` sends a literal `"model": null`.
    @discardableResult
    public func setModelRole(role: String, model: String?,
                             effort: ModelRoleEffortWrite = .leave) async throws -> [String: ModelRoleValue] {
        try await setModelRole(role: role, model: ModelRoleModelWrite(model), effort: effort)
    }
}

// MARK: - models.catalog (2026-09-18): the pinned provider catalog, as this daemon resolved it
//
// LOCAL-ONLY, params-less, read-only. Same degradation contract as the four above: a daemon that
// predates it answers `-32601`, and that is an expected reply, not a fault.
//
// THE SCALE MATTERS TO EVERY CONSUMER, so it is stated once here: ~15 families, ~102 providers,
// ~618 models, ~134 KB of JSON — and **18 of the 618 rows carry a price at all**. An unpriced row is
// therefore the ORDINARY case and a priced one the exception; a UI built the other way round will
// be a wall of "unknown" for everything a user actually looks at.
//
// THREE DECODE POSTURES, all deliberate:
//
//  1. **Identity is required, everything else is defaulted.** A family/provider row with no `id`,
//     and a model row with no `tag`, is dropped — there is nothing to key it by. Every other field
//     falls back (a display name to its id, a cost basis to `"unknown"`) or stays nil ("not told").
//  2. **Vocabulary fields stay RAW STRINGS** — `status`, `pricingBasis`, `credentialDoor`,
//     `costBasis`, a price's `source`/`confidence`. Same rule `CredentialRow` states at length: the
//     catalog is the agent SDK's and grows on an SDK bump with NO app release, so a closed Swift
//     enum would turn "a value I don't know" into "a row I drop".
//  3. **A price with no `source`/`confidence` decodes to NIL, not to a price.** Both are REQUIRED on
//     the wire, and they are the only things that say what the numbers are worth; a figure with
//     neither is an unattributed number, and an unattributed number rendered as a price is exactly
//     the failure the whole `costBasis` apparatus exists to prevent. `nil` lands every consumer on
//     its "not published" rendering, which is the safe one.

/// One provider+model pair's published prices, USD per million tokens (`models.catalog`'s
/// `ModelDescriptor.pricing`). `nil` on the model when the catalog carries none — which is 600 of
/// the 618 rows.
///
/// **This type is EVIDENCE, not a verdict.** Whether a number may be SHOWN is answered by the
/// model's `costBasis` (computed daemon-side) and by the provider's `pricingBasis`, never by the
/// presence of digits here: an INFERRED price carries real, plausible numbers under
/// `costBasis: "unknown"`, and a subscription provider's rows carry its API twin's list prices,
/// which describe a different credential entirely.
public struct CatalogPricing: Equatable, Sendable {
    public let inputPerMTokUsd: Double
    public let outputPerMTokUsd: Double
    /// Independently optional — a provider that publishes no cache rate is the common case, and a
    /// missing rate is NOT zero.
    public let cacheReadPerMTokUsd: Double?
    public let cacheWritePerMTokUsd: Double?
    /// Where the figure came from, in the catalog's own vocabulary. Required on the wire.
    public let source: String
    /// How much the catalog trusts it. **Required on the wire** and required here: see posture 3.
    public let confidence: String
    /// ISO instant the figure was observed, when the catalog states one.
    public let observedAt: String?
    /// PROSE PROVENANCE — up to ~1178 characters. The evidence behind the figure, including the
    /// catalog's own disclosures (cache-WRITE rates are under-reported; batch, fast-lane and
    /// geographic modifiers are not folded into these numbers).
    ///
    /// **It is not a tooltip string and must never be truncated into one.** It is a paragraph a
    /// user asks for; a UI that inlines it will either clip the disclosure that makes the number
    /// honest or push every other row off the screen.
    public let sourceRef: String?

    public init(inputPerMTokUsd: Double, outputPerMTokUsd: Double,
                cacheReadPerMTokUsd: Double? = nil, cacheWritePerMTokUsd: Double? = nil,
                source: String, confidence: String,
                observedAt: String? = nil, sourceRef: String? = nil) {
        self.inputPerMTokUsd = inputPerMTokUsd
        self.outputPerMTokUsd = outputPerMTokUsd
        self.cacheReadPerMTokUsd = cacheReadPerMTokUsd
        self.cacheWritePerMTokUsd = cacheWritePerMTokUsd
        self.source = source
        self.confidence = confidence
        self.observedAt = observedAt
        self.sourceRef = sourceRef
    }
}

/// One model family (`models.catalog`'s `families`).
///
/// The array is ALREADY FILTERED daemon-side to the families actually in use, and it includes a
/// REAL `"other"` family that ~149 model rows resolve to. `other` is DATA — a curated bucket the
/// catalog states — not a client-side fallback for "we were told nothing", and the two must not
/// render as one thing.
///
/// **There is no canonical ORDER here.** The catalog sorts families by id, and an id is not a label
/// ("gpt" sorts nowhere near "GPT-5"), so any order a UI shows is that UI's own policy.
public struct CatalogFamily: Equatable, Sendable {
    public let id: String
    /// Falls back to `id` when the catalog names none — plainer, never wrong.
    public let displayName: String
    public let vendor: String?
    /// Raw (`stable` | `preview` | … ) — the catalog's vocabulary, not a Swift enum.
    public let status: String?

    public init(id: String, displayName: String, vendor: String? = nil, status: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.vendor = vendor
        self.status = status
    }
}

/// One provider (`models.catalog`'s `providers`), ~102 of them.
///
/// **`credentialDoor` is the field that decides what a UI may say about readiness**, and it has
/// exactly three values today, each meaning something a `providerId` join cannot express:
///
/// - `"keychain"` (~96 providers) — `credentialSlotId` names a Keychain slot; the fix is a key in
///   Settings → Providers.
/// - `"console-profile"` (1, the `console` provider) — `credentialSlotId` is **null and that is
///   CORRECT**: the Anthropic Console arm has no Keychain slot at all. Its readiness is an on-disk
///   `ant` profile (which `credentialPresent` reports); the fix is `winter login --anthropic-console`.
/// - `"none"` (5: bedrock, ollama-local, uncloseai, vertex, xai-oauth) — this daemon stores no
///   credential for them. These are precisely the rows a naive join would mark "no credential"
///   forever, with nothing the user could do about it.
///
/// Behaviour is derived from this field, NEVER from a hardcoded provider id.
///
/// **READINESS IS NOT THIS FIELD'S JOB ANY MORE** (2026-09-18): `credentialPresent` answers it,
/// daemon-side. `credentialDoor` now answers only "which flow would I offer to fix it".
public struct CatalogProvider: Equatable, Sendable {
    public let id: String
    public let displayName: String
    /// `token` | `subscription` | `free`, raw. A statement about the CREDENTIAL, which is why it
    /// overrides any per-token figure on that provider's model rows.
    public let pricingBasis: String?
    public let authKinds: [String]
    /// The Keychain slot id (`openai:default`). **Null is meaningful, not missing** — see the
    /// `console-profile` and `none` doors above.
    public let credentialSlotId: String?
    /// `keychain` | `console-profile` | `none`, raw. Nil means the daemon did not say, which is
    /// "not told" and must render as no credential state at all.
    public let credentialDoor: String?
    /// **THE readiness answer**, computed daemon-side by the rule that backs the composer's model
    /// list: the on-disk `ant` profile for the `console-profile` door, stored material otherwise. A
    /// daemon with no secret store reports every provider `false`. Nil = not told (a daemon that
    /// predates the field), which must render as no readiness claim at all — never as "missing".
    public let credentialPresent: Bool?

    public init(id: String, displayName: String, pricingBasis: String? = nil,
                authKinds: [String] = [], credentialSlotId: String? = nil,
                credentialDoor: String? = nil, credentialPresent: Bool? = nil) {
        self.id = id
        self.displayName = displayName
        self.pricingBasis = pricingBasis
        self.authKinds = authKinds
        self.credentialSlotId = credentialSlotId
        self.credentialDoor = credentialDoor
        self.credentialPresent = credentialPresent
    }
}

/// One catalog row (`models.catalog`'s `models`), ~618 of them — **one per provider+model PAIR**,
/// which is why `tag` is the key and `canonicalModelId` is the thing that makes
/// `deepseek/deepseek-v4-pro` and `openrouter/deepseek-v4-pro` one model served twice.
public struct CatalogModel: Equatable, Sendable {
    /// The fully-qualified, provider-qualified tag (`codex-oauth/gpt-5.6-terra`). The ONLY string
    /// any caller may put on the wire for this row; never recompose one from the parts below.
    public let tag: String
    public let canonicalModelId: String?
    public let providerId: String?
    /// The family id, resolving to the real `"other"` family for ~149 rows.
    public let familyId: String?
    public let status: String?
    public let pricing: CatalogPricing?
    /// `"list"` | `"unknown"`, **computed daemon-side** — `"list"` is asserted only when the figure
    /// came from an official published document. Absent reads as `"unknown"`: not told is not
    /// quotable. All 18 priced rows report `"list"`.
    public let costBasis: String
    /// The reasoning-effort vocabulary, IN THE CATALOG'S ORDER — never sort it (`openai/o4-mini` is
    /// low/medium/high, `xai-oauth/grok-4.5` is high/medium/low). `nil` = no reasoning block at all
    /// (most rows); `[]` = a reasoning block with an EMPTY vocabulary; only a few dozen rows carry a
    /// real one.
    public let efforts: [String]?
    /// The effort the model runs at when none is stored. Can be nil even when `efforts` is not.
    public let defaultEffort: String?

    public init(tag: String, canonicalModelId: String? = nil, providerId: String? = nil,
                familyId: String? = nil, status: String? = nil,
                pricing: CatalogPricing? = nil, costBasis: String = "unknown",
                efforts: [String]? = nil, defaultEffort: String? = nil) {
        self.tag = tag
        self.canonicalModelId = canonicalModelId
        self.providerId = providerId
        self.familyId = familyId
        self.status = status
        self.pricing = pricing
        self.costBasis = costBasis
        self.efforts = efforts
        self.defaultEffort = defaultEffort
    }
}

/// `models.catalog`'s whole answer.
///
/// `schemaVersion`/`catalogVersion` are CARRIED, not gated on: a client that refused an unfamiliar
/// schema version would go blind on the very bump it was meant to survive, and every field above
/// already degrades on its own. They are here so a surface can show which catalog it is looking at.
public struct ModelsCatalog: Equatable, Sendable {
    public let schemaVersion: Int?
    public let catalogVersion: String?
    public let families: [CatalogFamily]
    public let providers: [CatalogProvider]
    public let models: [CatalogModel]

    public init(schemaVersion: Int? = nil, catalogVersion: String? = nil,
                families: [CatalogFamily] = [], providers: [CatalogProvider] = [],
                models: [CatalogModel] = []) {
        self.schemaVersion = schemaVersion
        self.catalogVersion = catalogVersion
        self.families = families
        self.providers = providers
        self.models = models
    }
}

extension WinterClient {
    /// `models.catalog` — READ-ONLY, params-less, LOCAL-only; the pinned provider catalog as this
    /// daemon resolved it: the families in use, every provider with its credential door, and one
    /// row per provider+model pair with whatever pricing evidence the catalog carries.
    ///
    /// ~134 KB of JSON and entirely static for a daemon's lifetime (it is compiled-in catalog data,
    /// not state), so a caller should read it ONCE per session and cache — never per keystroke.
    ///
    /// Throws `-32601` on a daemon that predates the method; see the section header above.
    public func modelsCatalog() async throws -> ModelsCatalog {
        let r = try await request("models.catalog", params: .object([:]))

        func pricing(_ v: JSONValue?) -> CatalogPricing? {
            // Posture 3: the two numbers AND both attributions, or nothing. A figure with no
            // source/confidence is an unattributed number, and this decode refuses to mint one.
            guard let o = v?.objectValue,
                  let input = o["inputPerMTokUsd"]?.doubleValue,
                  let output = o["outputPerMTokUsd"]?.doubleValue,
                  let source = o["source"]?.stringValue,
                  let confidence = o["confidence"]?.stringValue
            else { return nil }
            return CatalogPricing(
                inputPerMTokUsd: input,
                outputPerMTokUsd: output,
                cacheReadPerMTokUsd: o["cacheReadPerMTokUsd"]?.doubleValue,
                cacheWritePerMTokUsd: o["cacheWritePerMTokUsd"]?.doubleValue,
                source: source,
                confidence: confidence,
                observedAt: o["observedAt"]?.stringValue,
                sourceRef: o["sourceRef"]?.stringValue
            )
        }

        let families: [CatalogFamily] = (r["families"]?.arrayValue ?? []).compactMap { f in
            guard let id = f["id"]?.stringValue else { return nil }
            return CatalogFamily(id: id,
                                 displayName: f["displayName"]?.stringValue ?? id,
                                 vendor: f["vendor"]?.stringValue,
                                 status: f["status"]?.stringValue)
        }
        let providers: [CatalogProvider] = (r["providers"]?.arrayValue ?? []).compactMap { p in
            guard let id = p["id"]?.stringValue else { return nil }
            return CatalogProvider(
                id: id,
                displayName: p["displayName"]?.stringValue ?? id,
                pricingBasis: p["pricingBasis"]?.stringValue,
                authKinds: (p["authKinds"]?.arrayValue ?? []).compactMap { $0.stringValue },
                // An explicit `null` and an absent key decode the same here, and for the console
                // door they MEAN the same: there is no Keychain slot to name.
                credentialSlotId: p["credentialSlotId"]?.stringValue,
                credentialDoor: p["credentialDoor"]?.stringValue,
                credentialPresent: p["credentialPresent"]?.boolValue
            )
        }
        let models: [CatalogModel] = (r["models"]?.arrayValue ?? []).compactMap { m in
            guard let tag = m["tag"]?.stringValue else { return nil }
            return CatalogModel(
                tag: tag,
                canonicalModelId: m["canonicalModelId"]?.stringValue,
                providerId: m["providerId"]?.stringValue,
                familyId: m["familyId"]?.stringValue,
                status: m["status"]?.stringValue,
                pricing: pricing(m["pricing"]),
                // Not told ⇒ not quotable. `"unknown"` is the catalog's own word for that.
                costBasis: m["costBasis"]?.stringValue ?? "unknown",
                efforts: effortVocabulary(m["efforts"]),
                defaultEffort: m["defaultEffort"]?.stringValue
            )
        }
        return ModelsCatalog(schemaVersion: r["schemaVersion"]?.intValue,
                             catalogVersion: r["catalogVersion"]?.stringValue,
                             families: families,
                             providers: providers,
                             models: models)
    }
}
