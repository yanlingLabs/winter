import AppKit
import WinterKit
import SwiftUI
import UniformTypeIdentifiers

// -----------------------------------------------------------------------------------------------
// Pure pane-order-independent pieces (WS-21 rewrite over `plugin.list`/`plugin.install`/
// `plugin.uninstall`/`plugin.enable`/`plugin.disable`/`plugin.update`/`plugin.marketplace.*`,
// spec §5.2 — replaces the pre-WS-21 `plugins.list`/`plugins.install`/unscoped `plugin.enable`/
// `plugin.disable`/`plugin.remove` surface this pane used to drive). Table-tested directly in
// `PluginManagerModelTests`, no `WinterClient`/SwiftUI involved — same "pure helper next to its
// View" posture as `formatDaemonStatus`/`formatQuotaState`/`sortedTrustPaths` in this same
// directory's other panes.
//
// IDENTITY: a row's `id`/`spec` is the QUALIFIED `"<plugin>@<marketplace>"` Contract B and claude
// both use to name an install (`PluginListing.spec`) — NOT the bare plugin id, which is not unique
// across marketplaces. `plugin.restart{pluginId}` is the one call that still takes the bare id
// (`PluginRowDisplay.pluginId`); `plugin.setConsent` takes the qualified `spec` (fix round 1) plus
// a `fingerprint` (fix round 3) — see `hasAmbiguousBareId`'s own doc for what's left that still
// cares about a bare-id collision.
//
// STATUS: WS-21 retired the daemon's own supervisor-status merge into `plugin.list` — there is no
// live "starting"/"backoff"/"circuit-open" signal on the wire any more, only `enabled`. The
// running/starting/stopped/backoff/circuit-open dot and the settle-poll loop this pane used to run
// after every action are gone with it; a row shows enabled/disabled only.
// -----------------------------------------------------------------------------------------------

/// One action button a plugin row can offer — pure data (no closures); the view maps this to a
/// title/style and the `PluginManagerModel` method to call.
enum PluginAction: String, Equatable, Hashable, CaseIterable {
    case enable, disable, uninstall, restart, grantConsent

    var title: String {
        switch self {
        case .enable: return "Enable"
        case .disable: return "Disable"
        case .uninstall: return "Uninstall"
        case .restart: return "Restart"
        case .grantConsent: return "Grant consent"
        }
    }
}

/// One `plugin.list` entry mapped to what its row renders — see `pluginRowDisplay(_:)` below for
/// the (pure, table-tested) mapping.
struct PluginRowDisplay: Equatable, Identifiable {
    var id: String { spec }
    /// The qualified `"<plugin>@<marketplace>"` — every lifecycle action (`enable`/`disable`/
    /// `uninstall`/`plugin.setConsent`) is called with this (fix round 1: `plugin.setConsent` now
    /// takes `spec` too, not the bare id — see `WinterClient.pluginSetConsent`'s own doc).
    let spec: String
    /// The bare plugin id — for `plugin.restart{pluginId}` and display only now.
    let pluginId: String
    let scope: PluginScope
    let tierBadge: String
    let version: String
    let consentText: String
    let enabled: Bool
    /// Fix round 1 (M6): whether ANY required consent class is still outstanding — drives the
    /// status dot (`.needsConsent` suppresses the "enabled" green dot even though `enabled` is
    /// separately `true`, which it always is for a fresh install regardless of consent).
    let needsConsent: Bool
    let actions: [PluginAction]
    /// Fix round 1 (I3): the plugin's own declared hooks, straight off `PluginListing.hooks` —
    /// `nil` (daemon couldn't read them) and `[]` (read: none declared) are different answers, and
    /// the Hooks tab / this plugin's own detail page must render two different sentences for them.
    let hooks: [PluginHookEntry]?
}

/// PURE: `plugin.list` entry → row display + the action-availability rule.
///
/// Action rule — consent is checked FIRST, ahead of `enabled`:
///   - `extras.needsConsent` (any tier, any `enabled` state) → `[.grantConsent, ...]`, `.disable`
///     only when currently enabled, always `.uninstall`. `.grantConsent` routes to the SAME
///     `PluginManagerModel.enable(_:)` an `.enable` button would — it opens the consent sheet
///     without calling `plugin.enable` (see that method's own doc). This is load-bearing, not
///     cosmetic: `installPlugin` (Contract B) writes `enabled: true` on every fresh install,
///     Tier-2 or not (`agent-sdk-wt-ws21-plugins/packages/sdk/src/plugins/manage.ts`), so a
///     freshly-installed-but-not-yet-consented Tier-2 plugin is `enabled == true` with
///     `needsConsent == true` at the same time — without this branch first, the OLD rule below
///     would read that row as "enabled Tier-2" and offer `[.restart, .disable, .uninstall]`, a
///     dead end: `.restart` throws NOT_FOUND (the supervisor never tracked a process that was
///     never spawned, since `plugin.enable` is the only handler that calls `hotApplyStart`, and
///     it was never called), and there is no `.enable` button to reach the sheet from. Reachable
///     from BOTH a Mac-app install (this pane's own `installFromFolder` opens the sheet
///     immediately, but a cancel leaves the row in exactly this state) and a `winter plugin
///     install`/`enable` done from the CLI, which never opens a sheet at all.
///   - `!enabled` (consent already satisfied) → `[.enable, .uninstall]`.
///   - enabled AND extras declare a Tier-2 (`platform`) entry → `[.restart, .disable, .uninstall]`
///     — `.restart` is offered for every enabled, consented Tier-2 row (there is no live status
///     to further gate it on any more; `plugin.restart` itself still refuses typed for an id the
///     supervisor has never tracked).
///   - everything else enabled (no extras, `capability` tier) → `[.disable, .uninstall]`.
func pluginRowDisplay(_ p: PluginListing) -> PluginRowDisplay {
    let tierBadge: String
    switch p.extras?.tier {
    case "platform": tierBadge = "Tier 2"
    case "capability": tierBadge = "Tier 1"
    case .some: tierBadge = "Unknown"
    case nil: tierBadge = "Plugin"
    }

    let needsConsent = p.extras?.needsConsent ?? false
    let consentText: String
    if let extras = p.extras, !extras.requiredConsents.isEmpty {
        consentText = needsConsent
            ? "Needs consent: \(extras.pendingConsents.joined(separator: ", "))"
            : "Consented: \(extras.requiredConsents.joined(separator: ", "))"
    } else {
        consentText = "No consent required"
    }

    let actions: [PluginAction]
    if needsConsent {
        actions = p.enabled ? [.grantConsent, .disable, .uninstall] : [.grantConsent, .uninstall]
    } else if !p.enabled {
        actions = [.enable, .uninstall]
    } else if p.extras?.tier == "platform" {
        actions = [.restart, .disable, .uninstall]
    } else {
        actions = [.disable, .uninstall]
    }

    return PluginRowDisplay(
        spec: p.spec, pluginId: p.id, scope: p.scope, tierBadge: tierBadge,
        version: p.version ?? "—", consentText: consentText, enabled: p.enabled,
        needsConsent: needsConsent, actions: actions, hooks: p.hooks
    )
}

// -----------------------------------------------------------------------------------------------
// Install-from-folder pure helpers (WS-21: "install means addMarketplace + installPlugin", spec
// §5.2 — replaces Task 3's zip/`winter-plugin.json`-sniffing `locatePluginRoot`/`extractPluginZip`,
// which read a DIFFERENT thing — a single plugin's own manifest — than what claude's plugin layout
// now requires here: a MARKETPLACE manifest at the picked folder's own root). Touches the real
// filesystem rather than `WinterClient`, directly testable against a real temp directory.
//
// ZIP SUPPORT DROPPED (claude parity — `claude plugin install` has no zip path either): a directory
// marketplace is read IN PLACE (F15) — `plugin.marketplace.add`'s `path` result IS the picked
// folder, forever, so an extracted-to-a-temp-dir-then-deleted zip would silently break the very
// plugin it just installed the moment the temp dir is cleaned up. Picking a folder is the only
// supported source now.
// -----------------------------------------------------------------------------------------------

/// `readDirectoryMarketplaceManifest`/`directoryMarketplacePluginNames` failed to find or parse
/// `<dir>/.claude-plugin/marketplace.json`.
struct PluginFolderReadError: Error, Equatable {
    let message: String
}

/// A directory marketplace's own manifest, read locally — its registered NAME (what
/// `plugin.marketplace.add` will register it as; the daemon derives this the same way,
/// `readDirectoryMarketplaceManifest` in `plugins/sdk-plugin-api.ts`) and the plugin names it
/// lists.
struct DirectoryMarketplaceManifest: Equatable {
    let name: String
    let pluginNames: [String]
}

/// Mirrors the daemon's own `readDirectoryMarketplaceManifest`/`addMarketplace`
/// (`packages/core/src/plugins/sdk-plugin-api.ts`) — reads a directory marketplace's manifest
/// straight off the Mac's OWN filesystem, the same machine the picked folder lives on (same
/// reasoning `plugin-cli.ts`'s `readMarketplacePluginNames` gives: the daemon has no "read this
/// marketplace before it's registered" RPC and does not need one). Reading the NAME here, before
/// ever calling `plugin.marketplace.add`, is what lets `installFromFolder` check for a name
/// collision (fix round 1, C1) BEFORE registering anything.
func readDirectoryMarketplaceManifest(at dir: URL, fileManager: FileManager = .default) throws -> DirectoryMarketplaceManifest {
    let manifestURL = dir.appendingPathComponent(".claude-plugin/marketplace.json")
    guard let data = fileManager.contents(atPath: manifestURL.path) else {
        throw PluginFolderReadError(message: "\(manifestURL.path): no marketplace manifest there (expected .claude-plugin/marketplace.json under \(dir.path))")
    }
    struct Entry: Decodable { let name: String? }
    struct Manifest: Decodable { let name: String?; let plugins: [Entry]? }
    let parsed: Manifest
    do {
        parsed = try JSONDecoder().decode(Manifest.self, from: data)
    } catch {
        throw PluginFolderReadError(message: "\(manifestURL.path): not a valid marketplace manifest")
    }
    guard let name = parsed.name, !name.isEmpty else {
        throw PluginFolderReadError(message: "\(manifestURL.path): marketplace manifest has no name")
    }
    let pluginNames = (parsed.plugins ?? []).compactMap { $0.name }.filter { !$0.isEmpty }
    return DirectoryMarketplaceManifest(name: name, pluginNames: pluginNames)
}

/// The plugin names half of `readDirectoryMarketplaceManifest` — kept as its own entry point
/// because it is what the existing test suite (`DirectoryMarketplacePluginNamesTests`) exercises,
/// and because a caller that only needs the names (none, today) shouldn't have to unpack the
/// whole manifest.
func directoryMarketplacePluginNames(at dir: URL, fileManager: FileManager = .default) throws -> [String] {
    try readDirectoryMarketplaceManifest(at: dir, fileManager: fileManager).pluginNames
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — the pane's live view-model (`@MainActor`/`ObservableObject`, same posture
// as `PeripheralProvider`): owns the plugin list + drives the lifecycle actions, each followed by
// a `refresh()` so the row list always reflects the daemon's just-applied state.
// -----------------------------------------------------------------------------------------------

@MainActor
final class PluginManagerModel: ObservableObject {
    private let client: WinterClient

    @Published private(set) var rows: [PluginRowDisplay] = []
    @Published var errorText: String?
    /// Fix round 1 (I2): a non-error, informational line — today only "installed but turned off"
    /// after a cancelled install-triggered consent sheet. Kept separate from `errorText` (which
    /// renders in red) because declining consent is an expected, correct outcome, not a failure.
    @Published var noticeText: String?
    /// The live consent sheet, seeded from EITHER trigger — an `enable(_:)` whose row's extras
    /// still have a pending class, or a successful `installFromFolder(_:)`. `PluginManagerView`
    /// presents this via `.sheet(item:onDismiss:)`; setting it to `nil` (a click on the sheet's own
    /// Cancel button, Esc, or a swipe-down) closes it and — via `onDismiss`, wired once at the
    /// `.sheet` call site — runs `consentSheetDismissed()` (fix round 2, I2) for every dismissal
    /// except a successful confirm, which clears `lastConsentSheet` itself first (see that
    /// property's own doc — fix round 3, N1).
    @Published var consentSheet: ConsentSheetState? {
        didSet {
            // Fix round 2 (I2): keeps `lastConsentSheet` in sync with every non-nil assignment —
            // by the time SwiftUI calls `onDismiss` for ANY dismissal route, this property has
            // ALREADY gone back to `nil` (Apple's own documented ordering; reading `consentSheet`
            // itself inside `onDismiss` is unsafe by design), so `consentSheetDismissed()` needs
            // this shadow copy to know which sheet just closed and what to do about it.
            if let consentSheet { lastConsentSheet = consentSheet }
        }
    }
    /// Fix round 3 (N1): the shadow copy `consentSheetDismissed()` reads once `consentSheet` itself
    /// has already gone back to `nil` (see that property's `didSet`). A successful `confirmConsent()`
    /// clears THIS to `nil` itself, immediately before it nils `consentSheet` — not via a separate
    /// "already handled" flag, which is what the round 2 design used and which is exactly what broke:
    /// a flag consumed by the FIRST `consentSheetDismissed()` call left this shadow copy stale for
    /// any SECOND call (this model is shared by two mounted `.sheet` hosts — the Dashboard pane and
    /// the Library panel, `DashboardSurface.swift`/`ShellOverlays.swift` — each with its OWN
    /// `onDismiss`, so a successful confirm fired `onDismiss` TWICE; the second call read the flag
    /// already reset by the first and used the stale, just-confirmed sheet to disable the very
    /// plugin the user just enabled). Clearing this proactively means `consentSheetDismissed()`'s
    /// own `guard let` is the ONLY gate needed — idempotent by construction, safe for any number of
    /// hosts or calls, and correct even if a confirm's own network calls land after the sheet
    /// closed some other way (Esc while busy) — see `ConsentSheet`'s `.interactiveDismissDisabled`
    /// for why that race is prevented at the UI layer too, not just tolerated here.
    private var lastConsentSheet: ConsentSheetState?
    /// The plugin spec an in-flight action is currently running against — lets the view disable
    /// that row's buttons mid-action, same `revokingPath`-style single-flight posture as
    /// `TrustPane`.
    @Published private(set) var busySpec: String?
    /// True while `installFromFolder(_:)` is in flight — lets the view disable the "Install
    /// Plugin…" button so a second pick can't race the first.
    @Published private(set) var installing = false
    /// Consent double-submit guard: makes a second `confirmConsent()` call landing before the
    /// first's RPCs resolve a no-op, on top of `busySpec`-driven `.disabled(...)` on the sheet's
    /// own buttons.
    private var isConfirmingConsent = false
    /// The full `plugin.list` row behind each displayed spec — actions need the scope/bare id/
    /// extras a `PluginRowDisplay` doesn't carry.
    private var listingsBySpec: [String: PluginListing] = [:]
    /// Fix round 1 (M8): marketplace names THIS pane's own `installFromFolder(_:)` registered —
    /// `uninstall(_:)` offers to clean one up only when it's in this set (never a marketplace that
    /// predates this pane, e.g. one the CLI registered or that shipped with the daemon) and
    /// nothing else installed at `.user` scope still uses it.
    private var marketplacesAddedThisSession: Set<String> = []
    /// Fires at the end of EVERY `refresh()` (the manual "Refresh" click and each action's own
    /// follow-up refresh) so the pane can keep sibling models (the shortcut editor, primarily) in
    /// sync with the plugin list's latest state without a second, independently-timed poll of
    /// their own. `PluginManagerView` wires this to `shortcutsModel.refresh()`.
    var onRefreshed: (() -> Void)?

    init(client: WinterClient) {
        self.client = client
    }

    /// Fix round 1 (M1): the daemon's own refusal text, when there is one — an `RpcError` (the
    /// ordinary shape every plugin-lifecycle RPC throws for an expected refusal now, see
    /// `WinterClient+Methods.swift`'s own header) carries the daemon's exact wording; anything
    /// else falls back to its Swift description rather than a generic "try again" that discards
    /// what the daemon actually said.
    private func daemonMessage(_ error: Error) -> String {
        (error as? RpcError)?.message ?? "\(error)"
    }

    /// Fix round 1 (C2 defence in depth), doc corrected round 3: true when more than one LISTED
    /// (`.user`-scope) plugin shares `id` — e.g. the same plugin installed from two different
    /// marketplaces. `plugin.setConsent` is no longer ambiguous by itself (it takes the qualified
    /// `spec` — since round 1 — plus a `fingerprint` the daemon checks against the exact install,
    /// since round 3), so this guard's remaining reason to exist is `plugin.restart{pluginId}`,
    /// which IS still keyed by the bare id/first-match daemon-side (`PluginSupervisor`,
    /// `agent/plugins.ts`'s own doc on the collision this implies) — acting on a `restart` when two
    /// installs share a bare id is genuinely ambiguous, refused rather than guessed at, mirroring
    /// the existing "this folder lists N plugins" refusal `installFromFolder` already gives.
    /// `enable(_:)` keeps this guard too even though ITS own downstream calls are all spec-keyed
    /// now — a plugin it enables may later need `restart`, and refusing the ambiguity up front, at
    /// the one place a user is most likely to first encounter it, reads better than only surfacing
    /// it later from a Restart button that mysteriously does nothing.
    private func hasAmbiguousBareId(_ id: String) -> Bool {
        listingsBySpec.values.filter { $0.id == id }.count > 1
    }

    func refresh() async {
        do {
            // `.user`-scope only: this pane never has a `cwd` (`pluginList()` is called with none),
            // so `plugin.list` cannot resolve a project/local-scope record's `enabled` state
            // (`readEnabledFromSettings`'s no-cwd fallback reports it `false` regardless of the
            // real value — TEMP hardening noted in the L4 lane report). Worse, `listPlugins` emits
            // ONE ROW PER SCOPE RECORD (`plugins/sdk-plugin-api.ts`'s `listPlugins`) — the SAME
            // plugin installed at both `user` and a project/local scope would otherwise produce two
            // rows sharing the identical `spec`, colliding on `PluginRowDisplay`'s `Identifiable`
            // id in `ForEach` (silently dropping one, SwiftUI's usual behavior for a duplicate id).
            // Filtering to `.user` here is the honest scope for a global, no-project-context pane;
            // managing a project/local-scope install is CLI-only for now (`winter plugin
            // list/enable/disable --scope project|local`, inside that project). See M10's note in
            // the view header for the user-facing spelling of this same limitation.
            let listings = try await client.pluginList().filter { $0.scope == .user }
            listingsBySpec = Dictionary(listings.map { ($0.spec, $0) }, uniquingKeysWith: { _, last in last })
            rows = listings.map(pluginRowDisplay)
            errorText = nil
        } catch {
            errorText = "couldn't load plugins: \(daemonMessage(error))"
        }
        onRefreshed?()
    }

    // MARK: Enable / disable / uninstall / restart

    /// Opens the consent sheet FIRST when the row's extras still have a pending class (spec §5.4:
    /// the Winter-only Tier-2 extra keeps its own consent, orthogonal to install+enable — which is
    /// the consent for a plugin's claude-native content) — `confirmConsent()` is what actually
    /// calls `pluginSetConsent` then `pluginEnable`. Calls `pluginEnable` directly otherwise (no
    /// extras, or every required class is already consented — re-enabling after a disable, say).
    func enable(_ spec: String) async {
        noticeText = nil
        // Fix round 1 (M5): refresh FIRST so the needsConsent decision — and, if a sheet opens,
        // its disclosure — reflect the daemon's CURRENT state, not a possibly-stale snapshot from
        // whenever this pane last refreshed (another client, or this plugin's own consent
        // fingerprint, could have changed since).
        await refresh()
        // Minor (round 3): a FAILED refresh must not fall through to acting on stale `listingsBySpec`
        // data — `refresh()` already set `errorText` itself; this just stops here rather than
        // silently proceeding as if nothing went wrong.
        guard errorText == nil else { return }
        guard let listing = listingsBySpec[spec] else { return }
        guard !hasAmbiguousBareId(listing.id) else {
            errorText = "\(listing.id) is installed from more than one marketplace — this pane can't tell them apart for its background process yet"
            return
        }
        if let extras = listing.extras, extras.needsConsent {
            consentSheet = ConsentSheetState(pluginId: listing.id, spec: spec, scope: listing.scope,
                                             extras: extras, openedByInstall: false)
            return
        }
        await performEnable(spec: spec, scope: listing.scope)
    }

    private func performEnable(spec: String, scope: PluginScope) async {
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            _ = try await client.pluginEnable(spec: spec, scope: scope)
        } catch {
            actionError = "couldn't enable \(spec): \(daemonMessage(error))"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    func disable(_ spec: String) async {
        noticeText = nil
        guard let listing = listingsBySpec[spec] else { return }
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            _ = try await client.pluginDisable(spec: spec, scope: listing.scope)
        } catch {
            actionError = "couldn't disable \(spec): \(daemonMessage(error))"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// Contract B's own name (replaces the pre-WS-21 `.remove`) — unregisters the install record +
    /// `enabledPlugins` entry ONLY; a directory marketplace is read in place (F15), so this never
    /// deletes anything on disk. Fix round 1 (M8): when this pane's OWN `installFromFolder(_:)`
    /// registered `spec`'s marketplace and nothing else still uses it, also removes the marketplace
    /// registration — best-effort, never turns an otherwise-successful uninstall into a reported
    /// failure.
    func uninstall(_ spec: String) async {
        noticeText = nil
        guard let listing = listingsBySpec[spec] else { return }
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            _ = try await client.pluginUninstall(spec: spec, scope: listing.scope)
            if marketplacesAddedThisSession.contains(listing.marketplace) {
                // N2 (round 3): checked across EVERY scope via a fresh, UNFILTERED `plugin.list` —
                // this pane's own cached `listingsBySpec` only ever holds `.user`-scope rows
                // (`refresh()`'s own filter, see that method's doc), so a project/local-scope
                // plugin installed from the SAME marketplace would otherwise be invisible to this
                // check, and the marketplace could be pulled out from under it.
                do {
                    let everyListing = try await client.pluginList()
                    let stillUsed = everyListing.contains { $0.spec != spec && $0.marketplace == listing.marketplace }
                    if !stillUsed {
                        try? await client.pluginMarketplaceRemove(name: listing.marketplace)
                        marketplacesAddedThisSession.remove(listing.marketplace)
                    }
                } catch {
                    // Best-effort, and fails SAFE: a failed "is it still used" check must leave the
                    // marketplace registered, never remove one a check couldn't actually confirm
                    // was unused.
                }
            }
        } catch {
            actionError = "couldn't uninstall \(spec): \(daemonMessage(error))"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// `plugin.restart` takes the BARE id, not the qualified spec (`PluginSupervisor` tracks
    /// Tier-2 processes by bare name — `agent/plugins.ts`'s own doc on the collision this implies
    /// for two same-named plugins from different marketplaces). Fix round 1 (C2): refused up front
    /// when that collision is real, rather than silently restarting whichever one the supervisor's
    /// own lookup happens to find.
    func restart(_ spec: String) async {
        noticeText = nil
        guard let listing = listingsBySpec[spec] else { return }
        guard !hasAmbiguousBareId(listing.id) else {
            errorText = "\(listing.id) is installed from more than one marketplace — this pane can't tell them apart for restart yet"
            return
        }
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            try await client.pluginRestart(name: listing.id)
        } catch {
            actionError = "couldn't restart \(spec): \(daemonMessage(error))"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    // MARK: Install from a folder

    /// "Install Plugin…": `plugin.marketplace.add` + `plugin.install` (spec §5.2: "install means
    /// addMarketplace + installPlugin"), mirroring `winter plugin install <folder>`'s own daemon
    /// path (`plugin-cli.ts`'s `runPluginInstallRoute`) exactly. `dir` must itself hold a
    /// `.claude-plugin/marketplace.json` listing EXACTLY ONE plugin — a multi-plugin folder is
    /// refused with the same shape of message the CLI gives (this pane has no picker for choosing
    /// one of several plugins a marketplace lists). Always scope `.user` — this pane has no
    /// project `cwd` to scope by.
    ///
    /// A fresh install lands ENABLED in settings already (Contract B's own `installPlugin`), but
    /// NOT yet hot-spawned for a Tier-2 plugin (only `plugin.enable`'s handler calls
    /// `hotApplyStart`) — so this always follows up with either the consent flow or a direct
    /// `performEnable`, exactly as re-enabling an existing row would.
    func installFromFolder(_ dir: URL) async {
        installing = true
        defer { installing = false }
        noticeText = nil
        let manifest: DirectoryMarketplaceManifest
        do {
            manifest = try readDirectoryMarketplaceManifest(at: dir)
        } catch {
            errorText = (error as? PluginFolderReadError)?.message ?? "couldn't read \(dir.lastPathComponent): \(daemonMessage(error))"
            return
        }
        guard manifest.pluginNames.count == 1 else {
            errorText = "\(dir.lastPathComponent): this folder lists \(manifest.pluginNames.count) plugin(s) — installing one of several isn't supported from this picker yet"
            return
        }
        let pluginName = manifest.pluginNames[0]

        // Ordering (round 3 minor): the bare-id ambiguity check now runs BEFORE
        // `plugin.marketplace.add` — using the manifest's OWN plugin name, read locally, since
        // nothing is installed yet to look a listing up by — rather than after the plugin is
        // already live. Refusing before anything is registered means there is nothing left over to
        // clean up on the common path. This can't close the race completely by itself (another
        // client could install a colliding plugin in the window between this check and the actual
        // install below), so the POST-install check further down stays too, as defense in depth —
        // its own refusal branch now disables the plugin it just found ambiguous, rather than
        // leaving an enabled-but-unmanageable install behind.
        do {
            let existing = try await client.pluginList()
            if existing.contains(where: { $0.id == pluginName && $0.scope == .user && $0.marketplace != manifest.name }) {
                errorText = "\(pluginName) is already installed from another marketplace — this pane can't tell them apart yet"
                return
            }
        } catch {
            errorText = "couldn't check existing plugins: \(daemonMessage(error))"
            return
        }

        // C1: refuse a marketplace NAME collision with a DIFFERENT path before registering
        // anything — `plugin.marketplace.add` would otherwise silently repoint every plugin
        // already installed from the old path (a directory marketplace is read in place, F15).
        let marketplaceAlreadyKnown: Bool
        do {
            let known = try await client.pluginMarketplaceList()
            if let existing = known.first(where: { $0.name == manifest.name }), existing.path != dir.path {
                errorText = "a marketplace named \"\(manifest.name)\" already points at \(existing.path) — rename this folder's marketplace.json, or remove the old marketplace first"
                return
            }
            // N2 (round 3): only a marketplace THIS call actually CREATES is tracked as
            // "app-added" — one that already existed under this name (even at the identical path,
            // an idempotent re-add) predates this session's own action, so a later `uninstall(_:)`
            // must never auto-remove it — this pane didn't create it and has no way to know who
            // else might depend on it staying registered.
            marketplaceAlreadyKnown = known.contains { $0.name == manifest.name }
        } catch {
            errorText = "couldn't check existing marketplaces: \(daemonMessage(error))"
            return
        }

        do {
            let marketplace = try await client.pluginMarketplaceAdd(source: dir.path)
            if !marketplaceAlreadyKnown {
                marketplacesAddedThisSession.insert(marketplace.name)
            }
            let spec = "\(pluginName)@\(marketplace.name)"
            _ = try await client.pluginInstall(spec: spec, scope: .user)
            await refresh()
            // M3: a failed post-install refresh must not fall through to opening a sheet or
            // enabling off a stale/absent listing — the error `refresh()` already set stands.
            guard errorText == nil else { return }
            guard let listing = listingsBySpec[spec] else {
                // Minor (round 3): a SUCCESSFUL refresh that simply doesn't contain the spec just
                // installed must not return silently — something is wrong (another client removed
                // it already, say), and the user just watched this pane say nothing about it.
                errorText = "installed \(spec) but couldn't find it in the list afterward — try Refresh"
                return
            }
            guard !hasAmbiguousBareId(listing.id) else {
                // Ordering minor: reachable only via the race the pre-install check above can't
                // close by itself. The plugin IS live and enabled at this point, so refuse AND
                // disable it — leaving it silently enabled-but-unmanageable would be worse than
                // the error alone.
                errorText = "\(listing.id) is already installed from another marketplace — this pane can't tell them apart yet"
                _ = try? await client.pluginDisable(spec: spec, scope: .user)
                await refresh()
                return
            }
            // C1: a plugin with ANY required consent class ALWAYS shows the sheet on a fresh
            // install, whatever `consented` says — the daemon fingerprints consent by install path
            // + entry, so a reinstall to the identical path/entry can read `consented: true`
            // immediately, but a fresh install still needs a deliberate, current confirmation.
            // `performEnable` is never called directly for such a plugin.
            if let extras = listing.extras, !extras.requiredConsents.isEmpty {
                consentSheet = ConsentSheetState(pluginId: listing.id, spec: spec, scope: .user,
                                                 extras: extras, openedByInstall: true)
                return
            }
            await performEnable(spec: spec, scope: .user)
        } catch {
            errorText = "couldn't install \(dir.lastPathComponent): \(daemonMessage(error))"
        }
    }

    // MARK: Consent sheet

    /// The consent sheet's "Grant consent & enable". Consent is set BEFORE `pluginEnable` is
    /// called: the daemon's `plugin.enable` handler hot-spawns a Tier-2 process synchronously and
    /// reads consent to decide spawn eligibility right then — granting consent AFTER an `enable`
    /// that already ran leaves the process unspawned until another `enable`/`plugin.restart`
    /// (`WinterClient.pluginEnable`'s own doc comment). Fix round 1 (C1): grants every class in
    /// `extras.requiredConsents`, not just the ones `pendingConsents` says are still missing — a
    /// fresh confirmation re-affirms the whole disclosure, not a stale delta.
    func confirmConsent() async {
        guard !isConfirmingConsent else { return }
        guard var sheet = consentSheet else { return }
        isConfirmingConsent = true
        defer { isConfirmingConsent = false }
        sheet.confirm()
        consentSheet = sheet
        let spec = sheet.spec
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            // I1: the result used to be discarded — an `.unknownPlugin` refusal (the plugin was
            // uninstalled, or its spec no longer resolves, between the sheet opening and this
            // click) must not silently fall through to `pluginEnable`. The sheet stays open
            // (never nil'd on this branch) and the enable call is skipped entirely.
            //
            // Contract update (fix round 3, TOCTOU fix): `fingerprint` names the exact install
            // this disclosure was built from — `.staleDisclosure` means the plugin changed (a
            // reinstall, an entry edit) between the sheet opening and now. Refresh, rebuild the
            // sheet from the plugin's CURRENT `plugin.list` row, keep it open, and never enable.
            let consentResult = try await client.pluginSetConsent(spec: spec, classes: sheet.extras.requiredConsents,
                                                                   fingerprint: sheet.extras.fingerprint)
            switch consentResult {
            case .unknownPlugin:
                actionError = "\(sheet.pluginId) is no longer installed — couldn't record consent"
            case .staleDisclosure:
                await refresh()
                if let listing = listingsBySpec[spec], let extras = listing.extras {
                    consentSheet = ConsentSheetState(pluginId: listing.id, spec: spec, scope: listing.scope,
                                                     extras: extras, openedByInstall: sheet.openedByInstall)
                } else {
                    lastConsentSheet = nil
                    consentSheet = nil
                }
                errorText = "This plugin changed while you were reviewing it — please review again."
                return
            case .ok:
                _ = try await client.pluginEnable(spec: spec, scope: sheet.scope)
                // Fix round 3 (N1): cleared BEFORE `consentSheet` itself, not via a separate
                // "already handled" flag (round 2's design, which broke with two `.sheet` hosts
                // mounted on the same model — see `lastConsentSheet`'s own doc for the full story).
                // `consentSheetDismissed()`'s `guard let` then makes every subsequent call — from
                // either host's `onDismiss`, or a confirm whose network calls outlive the sheet
                // some other way — a safe no-op on its own, with no flag to go stale.
                lastConsentSheet = nil
                consentSheet = nil
            }
        } catch {
            actionError = "couldn't enable \(spec): \(daemonMessage(error))"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// The SINGLE exit point for every sheet dismissal EXCEPT a successful confirm — wired to
    /// `.sheet(item:onDismiss:)`'s `onDismiss`, which SwiftUI calls whenever `consentSheet` goes
    /// back to `nil`, however that happened: a click on the sheet's own Cancel button, Esc, or a
    /// swipe-down all converge here identically, because all three are, to SwiftUI, the same "the
    /// item became nil" transition — there is no way (and no need) to tell them apart.
    /// `confirmConsent()`'s own success path clears `lastConsentSheet` itself before it nils
    /// `consentSheet`, so THIS method's own `guard let` is the only gate it needs — see
    /// `lastConsentSheet`'s doc for why that beat a shared "already handled" flag.
    ///
    /// When the sheet was raised by an INSTALL (`installFromFolder`'s own trigger,
    /// `openedByInstall`), the plugin landed ENABLED already (Contract B's `installPlugin`) — its
    /// skills, hooks and MCP servers would otherwise keep loading even though the user just
    /// declined the Tier-2 process's consent, by whichever route. Disables it and leaves one
    /// explanatory line. A sheet raised by an ordinary `enable(_:)` on an already-installed,
    /// already-disabled row needs no such follow-up — dismissing it just leaves that row exactly
    /// as it was.
    func consentSheetDismissed() async {
        guard let sheet = lastConsentSheet else { return }
        lastConsentSheet = nil
        guard sheet.openedByInstall else { return }
        busySpec = sheet.spec
        defer { busySpec = nil }
        do {
            _ = try await client.pluginDisable(spec: sheet.spec, scope: sheet.scope)
            noticeText = "Installed but turned off — enable it to review its permissions again."
        } catch {
            errorText = "installed \(sheet.spec) but couldn't turn it off: \(daemonMessage(error))"
        }
        await refresh()
    }
}

// -----------------------------------------------------------------------------------------------
// PluginManagerView — modeled on `PeripheralPane`/`TrustPane`'s structure/idiom: opaque window, so
// adaptive system colors only (never the glass-shell field blend).
// -----------------------------------------------------------------------------------------------

struct PluginManagerView: View {
    @ObservedObject var model: PluginManagerModel
    /// The live tiles strip's own view-model — same "constructed once, injected here" posture as
    /// `model` above.
    @ObservedObject var tilesModel: TilesStripModel
    /// The shortcut binding editor's own view-model — same posture as `tilesModel`.
    @ObservedObject var shortcutsModel: ShortcutBindingEditorModel
    /// The bottom helper-approval row reads this directly — same `@ObservedObject` posture
    /// `PeripheralPane` already uses for the SAME instance (`DashboardWiring.helperClient`).
    @ObservedObject var helperClient: HelperClient

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let errorText = model.errorText {
                Text(errorText).foregroundStyle(.red).font(Typography.label()).padding(.horizontal)
            }
            if let noticeText = model.noticeText {
                Text(noticeText).foregroundStyle(.secondary).font(Typography.label()).padding(.horizontal)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TilesStripView(model: tilesModel)
                        .padding(.horizontal)
                    Divider()
                    pluginListSection
                    Divider()
                    ShortcutBindingEditor(model: shortcutsModel)
                        .padding(.horizontal)
                    Divider()
                    HelperApprovalRow(helperClient: helperClient)
                        .padding(.horizontal)
                }
                .padding(.top, 8)
                .padding(.bottom, 8)
            }
        }
        .task {
            // Wired BEFORE the first `refresh()` call below so every refresh from here on — this
            // initial one, the manual "Refresh" button, and every action's own trailing refresh —
            // also re-syncs the shortcut editor. `[weak shortcutsModel]` matches this file's
            // existing weak-capture idiom for cross-model closures.
            model.onRefreshed = { [weak shortcutsModel] in
                guard let shortcutsModel else { return }
                Task { @MainActor in await shortcutsModel.refresh() }
            }
            await model.refresh()
        }
        // The GUI consent sheet — presented from BOTH triggers `model.consentSheet` can be set
        // from (`enable(_:)`'s pending-consent path, or a successful `installFromFolder(_:)`).
        // Fix round 2 (I2): `onDismiss` is the ONE follow-up path now — SwiftUI calls it for EVERY
        // dismissal (the sheet's own Cancel button, Esc, or a swipe-down all nil `consentSheet`
        // the same way, whether `onCancel` below does it explicitly or SwiftUI does it directly),
        // so `onCancel` itself does nothing beyond clearing the binding; the actual "was this an
        // install, does it need disabling" logic lives ONCE, in `consentSheetDismissed()` — see
        // that method's own doc for how it tells a successful confirm's own dismissal apart from
        // every other route.
        .sheet(item: $model.consentSheet, onDismiss: { Task { await model.consentSheetDismissed() } }) { sheet in
            ConsentSheet(
                state: sheet,
                busy: model.busySpec == sheet.spec,
                onConfirm: { Task { await model.confirmConsent() } },
                onCancel: { model.consentSheet = nil }
            )
        }
    }

    /// The plugin-list rendering — shares the pane-wide `ScrollView` above, alongside the tiles
    /// strip / shortcut editor / helper row.
    private var pluginListSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Installed Plugins").font(Typography.label(.semibold)).foregroundStyle(.secondary).padding(.horizontal)
            // M10: this pane only ever lists `.user`-scope installs (see `refresh()`'s own doc for
            // why) — said here so that absence reads as "not shown here", not "not installed".
            Text("Project- and local-scope plugins aren't shown here — manage those with winter plugin, inside the project.")
                .font(Typography.caption())
                .foregroundStyle(.secondary)
                .padding(.horizontal)
            if model.rows.isEmpty {
                Text("No plugins installed")
                    .font(Typography.label())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
            }
            ForEach(model.rows) { row in
                pluginRow(row)
                Divider()
            }
        }
    }

    private var header: some View {
        HStack {
            Text("Plugins").font(Typography.paneTitle)
            Spacer()
            Button("Install Plugin…") { presentInstallPanel() }
                .disabled(model.installing)
            Button("Refresh") { Task { await model.refresh() } }
        }
        .padding([.top, .horizontal])
        .padding(.bottom, 4)
    }

    /// "Install Plugin…": a folder only (WS-21 dropped zip support — see this file's own header).
    /// The folder must itself hold `.claude-plugin/marketplace.json`; a bare plugin folder with no
    /// marketplace manifest is refused the same way `winter plugin install <folder>` refuses it.
    private func presentInstallPanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        // M4: the folder is read IN PLACE, forever (F15) — a directory marketplace's `path` IS the
        // source, so moving or deleting it later breaks the plugin. A zip is not a valid pick at
        // all any more (see this file's header); the message says so rather than letting the pick
        // fail silently against a temporary Downloads extraction.
        panel.message = "Choose a plugin marketplace folder (containing .claude-plugin/marketplace.json). "
            + "It's used in place — moving or deleting it later breaks the plugin. A .zip must be "
            + "unzipped to a permanent folder first."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await model.installFromFolder(url) }
    }

    private func pluginRow(_ row: PluginRowDisplay) -> some View {
        let busy = model.busySpec == row.spec
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(row.pluginId).font(Typography.control(.medium))
                tierBadge(row.tierBadge)
                Text(row.version)
                    .font(Typography.captionMono())
                    .foregroundStyle(.secondary)
                Spacer()
                statusIndicator(row)
            }
            Text(row.consentText)
                .font(Typography.caption())
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                ForEach(row.actions, id: \.self) { action in
                    Button(action.title) { Task { await perform(action, on: row.spec) } }
                        .font(Typography.label())
                        .foregroundStyle(action == .uninstall ? .red : .primary)
                        .disabled(busy)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
    }

    private func perform(_ action: PluginAction, on spec: String) async {
        switch action {
        case .enable, .grantConsent: await model.enable(spec)
        case .disable: await model.disable(spec)
        case .uninstall: await model.uninstall(spec)
        case .restart: await model.restart(spec)
        }
    }

    private func tierBadge(_ text: String) -> some View {
        Text(text)
            .font(Typography.tiny(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(.quaternary))
            .foregroundStyle(.secondary)
    }

    /// No live runtime status on the wire any more (see this file's header) — a row shows only
    /// whether it is enabled, with a dot only for "enabled". Fix round 1 (M6): `needsConsent`
    /// suppresses the dot even though `enabled` is separately `true` — a fresh install lands
    /// enabled in settings regardless of consent (Contract B's own `installPlugin`), and a green
    /// dot there would read as "fully working" when a Tier-2 plugin's process was never spawned.
    private func statusIndicator(_ row: PluginRowDisplay) -> some View {
        HStack(spacing: 4) {
            if row.enabled && !row.needsConsent {
                Circle().fill(Color.green).frame(width: 6, height: 6)
            }
            Text(row.enabled ? "Enabled" : "Disabled").font(Typography.caption()).foregroundStyle(.secondary)
        }
    }
}
