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
// across marketplaces. `plugin.restart{pluginId}` and `plugin.setConsent{name}` are the two calls
// that still take the bare id (`PluginRowDisplay.pluginId`).
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
    /// `uninstall`/`update`) is called with this.
    let spec: String
    /// The bare plugin id — for `plugin.restart{pluginId}`/`plugin.setConsent{name}` and display.
    let pluginId: String
    let scope: PluginScope
    let tierBadge: String
    let version: String
    let consentText: String
    let enabled: Bool
    let actions: [PluginAction]
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
        version: p.version ?? "—", consentText: consentText, enabled: p.enabled, actions: actions
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

/// `directoryMarketplacePluginNames` failed to find or parse `<dir>/.claude-plugin/marketplace.json`.
struct PluginFolderReadError: Error, Equatable {
    let message: String
}

/// Mirrors `directoryMarketplacePluginNames` (`packages/core/src/plugins/lifecycle.ts`) — reads a
/// directory marketplace's plugin names straight off the Mac's OWN filesystem, the same machine
/// the picked folder lives on (same reasoning `plugin-cli.ts`'s `readMarketplacePluginNames` gives:
/// the daemon has no "read this marketplace before it's registered" RPC and does not need one).
func directoryMarketplacePluginNames(at dir: URL, fileManager: FileManager = .default) throws -> [String] {
    let manifestURL = dir.appendingPathComponent(".claude-plugin/marketplace.json")
    guard let data = fileManager.contents(atPath: manifestURL.path) else {
        throw PluginFolderReadError(message: "\(manifestURL.path): no marketplace manifest there (expected .claude-plugin/marketplace.json under \(dir.path))")
    }
    struct Entry: Decodable { let name: String? }
    struct Manifest: Decodable { let plugins: [Entry]? }
    let parsed: Manifest
    do {
        parsed = try JSONDecoder().decode(Manifest.self, from: data)
    } catch {
        throw PluginFolderReadError(message: "\(manifestURL.path): not a valid marketplace manifest")
    }
    return (parsed.plugins ?? []).compactMap { $0.name }.filter { !$0.isEmpty }
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
    /// The live consent sheet, seeded from EITHER trigger — an `enable(_:)` whose row's extras
    /// still have a pending class, or a successful `installFromFolder(_:)`. `PluginManagerView`
    /// presents this via `.sheet(item:)`; setting it to `nil` (confirm/cancel, or a swipe-to-
    /// dismiss) closes the sheet.
    @Published var consentSheet: ConsentSheetState?
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
    /// Fires at the end of EVERY `refresh()` (the manual "Refresh" click and each action's own
    /// follow-up refresh) so the pane can keep sibling models (the shortcut editor, primarily) in
    /// sync with the plugin list's latest state without a second, independently-timed poll of
    /// their own. `PluginManagerView` wires this to `shortcutsModel.refresh()`.
    var onRefreshed: (() -> Void)?

    init(client: WinterClient) {
        self.client = client
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
            // list/enable/disable --scope project|local`, inside that project).
            let listings = try await client.pluginList().filter { $0.scope == .user }
            listingsBySpec = Dictionary(listings.map { ($0.spec, $0) }, uniquingKeysWith: { _, last in last })
            rows = listings.map(pluginRowDisplay)
            errorText = nil
        } catch {
            errorText = "couldn't load plugins — try Refresh"
        }
        onRefreshed?()
    }

    // MARK: Enable / disable / uninstall / restart / update

    /// Opens the consent sheet FIRST when the row's extras still have a pending class (spec §5.4:
    /// the Winter-only Tier-2 extra keeps its own consent, orthogonal to install+enable — which is
    /// the consent for a plugin's claude-native content) — `confirmConsent()` is what actually
    /// calls `pluginSetConsent` then `pluginEnable`. Calls `pluginEnable` directly otherwise (no
    /// extras, or every required class is already consented — re-enabling after a disable, say).
    func enable(_ spec: String) async {
        guard let listing = listingsBySpec[spec] else { return }
        if let extras = listing.extras, extras.needsConsent {
            consentSheet = ConsentSheetState(pluginId: listing.id, spec: spec, scope: listing.scope, extras: extras)
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
            actionError = "couldn't enable \(spec) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    func disable(_ spec: String) async {
        guard let listing = listingsBySpec[spec] else { return }
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            _ = try await client.pluginDisable(spec: spec, scope: listing.scope)
        } catch {
            actionError = "couldn't disable \(spec) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// Contract B's own name (replaces the pre-WS-21 `.remove`) — unregisters the install record +
    /// `enabledPlugins` entry ONLY; a directory marketplace is read in place (F15), so this never
    /// deletes anything on disk.
    func uninstall(_ spec: String) async {
        guard let listing = listingsBySpec[spec] else { return }
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            _ = try await client.pluginUninstall(spec: spec, scope: listing.scope)
        } catch {
            actionError = "couldn't uninstall \(spec) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    func update(_ spec: String) async {
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            _ = try await client.pluginUpdate(spec: spec)
        } catch {
            actionError = "couldn't update \(spec) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// `plugin.restart` takes the BARE id, not the qualified spec (`PluginSupervisor` tracks
    /// Tier-2 processes by bare name — `agent/plugins.ts`'s own doc on the collision this implies
    /// for two same-named plugins from different marketplaces, noted there, not fixed here).
    func restart(_ spec: String) async {
        guard let listing = listingsBySpec[spec] else { return }
        busySpec = spec
        defer { busySpec = nil }
        var actionError: String?
        do {
            try await client.pluginRestart(name: listing.id)
        } catch {
            actionError = "couldn't restart \(spec) — try again"
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
        let names: [String]
        do {
            names = try directoryMarketplacePluginNames(at: dir)
        } catch {
            errorText = (error as? PluginFolderReadError)?.message ?? "couldn't read \(dir.lastPathComponent) — try again"
            return
        }
        guard names.count == 1 else {
            errorText = "\(dir.lastPathComponent): this folder lists \(names.count) plugin(s) — installing one of several isn't supported from this picker yet"
            return
        }
        var actionError: String?
        do {
            let marketplace = try await client.pluginMarketplaceAdd(source: dir.path)
            let spec = "\(names[0])@\(marketplace.name)"
            _ = try await client.pluginInstall(spec: spec, scope: .user)
            await refresh()
            if let listing = listingsBySpec[spec], let extras = listing.extras, extras.needsConsent {
                consentSheet = ConsentSheetState(pluginId: listing.id, spec: spec, scope: .user, extras: extras)
                return
            }
            await performEnable(spec: spec, scope: .user)
            return
        } catch {
            actionError = "couldn't install \(dir.lastPathComponent) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    // MARK: Consent sheet

    /// The consent sheet's "Grant consent & enable". Consent is set BEFORE `pluginEnable` is
    /// called: the daemon's `plugin.enable` handler hot-spawns a Tier-2 process synchronously and
    /// reads consent to decide spawn eligibility right then — granting consent AFTER an `enable`
    /// that already ran leaves the process unspawned until another `enable`/`plugin.restart`
    /// (`WinterClient.pluginEnable`'s own doc comment).
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
            _ = try await client.pluginSetConsent(name: sheet.pluginId, classes: sheet.pendingConsents)
            _ = try await client.pluginEnable(spec: spec, scope: sheet.scope)
            consentSheet = nil
        } catch {
            actionError = "couldn't enable \(spec) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// Dismisses without ever calling `pluginSetConsent`/`pluginEnable` — the plugin stays exactly
    /// as it was.
    func cancelConsent() {
        consentSheet?.cancel()
        consentSheet = nil
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
        // Dismissing any other way (Esc/swipe) also nils the binding via SwiftUI's own `.sheet`
        // machinery — same end state as `cancelConsent()`, just without that method's explicit
        // `.cancel()` record on the (by-then-discarded) state value.
        .sheet(item: $model.consentSheet) { sheet in
            ConsentSheet(
                state: sheet,
                busy: model.busySpec == sheet.spec,
                onConfirm: { Task { await model.confirmConsent() } },
                onCancel: { model.cancelConsent() }
            )
        }
    }

    /// The plugin-list rendering — shares the pane-wide `ScrollView` above, alongside the tiles
    /// strip / shortcut editor / helper row.
    private var pluginListSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Installed Plugins").font(Typography.label(.semibold)).foregroundStyle(.secondary).padding(.horizontal)
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
        panel.message = "Choose a plugin marketplace folder (containing .claude-plugin/marketplace.json)"
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
    /// whether it is enabled, with a dot only for "enabled" (there is nothing to distinguish a
    /// disabled plugin from any other non-running state any more, so it gets none).
    private func statusIndicator(_ row: PluginRowDisplay) -> some View {
        HStack(spacing: 4) {
            if row.enabled {
                Circle().fill(Color.green).frame(width: 6, height: 6)
            }
            Text(row.enabled ? "Enabled" : "Disabled").font(Typography.caption()).foregroundStyle(.secondary)
        }
    }
}
