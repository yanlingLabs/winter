import AppKit
import NormaKit
import SwiftUI
import UniformTypeIdentifiers

// -----------------------------------------------------------------------------------------------
// Pure pane-order-independent pieces (Task 2, Phase 4d-iii): `plugins.list` entry → row display +
// the action-availability rule. Table-tested directly in `PluginManagerModelTests`, no
// `NormaClient`/SwiftUI involved — same "pure helper next to its View" posture as
// `formatDaemonStatus`/`formatQuotaState`/`sortedTrustPaths` in this same directory's other panes.
// -----------------------------------------------------------------------------------------------

/// One action button a plugin row can offer — pure data (no closures); the view maps this to a
/// title/style and the `PluginManagerModel` method to call.
enum PluginAction: String, Equatable, Hashable, CaseIterable {
    case enable, disable, remove, restart

    var title: String {
        switch self {
        case .enable: return "Enable"
        case .disable: return "Disable"
        case .remove: return "Remove"
        case .restart: return "Restart"
        }
    }
}

/// Purely a rendering hint for the row's status dot/text. `na` (no runtime process at all —
/// Tier-1/legacy/unconsented) and `disabled` (hot-stopped, no process either) are their OWN cases
/// specifically so the view can render them WITHOUT a "running" indicator dot at all — distinct
/// from every Tier-2 runtime state (running/starting/stopped/backoff/circuit-open), which always
/// gets one. `na` is never conflated with `.stopped`.
enum PluginStatusColorKind: Equatable, Hashable {
    case running, starting, stopped, backoff, circuitOpen, na, disabled
}

/// One `plugins.list` entry mapped to what its row renders — see `pluginRowDisplay(...)` below for
/// the (pure, table-tested) mapping. `id` is the plugin name (`plugins.list` names are unique per
/// daemon).
struct PluginRowDisplay: Equatable, Identifiable {
    var id: String { name }
    let name: String
    let tierBadge: String
    let version: String
    let consentText: String
    let statusText: String
    let statusColorKind: PluginStatusColorKind
    let actions: [PluginAction]
}

/// Task 2 (4d-iii): `plugins.list` entry → row display. PURE — no `NormaClient`, no SwiftUI —
/// table-tested directly in `PluginManagerModelTests`.
///
/// Action rule (honors 4d-ii's carryovers — `plugin.enable`/`disable`/`remove` + this task's new
/// `plugin.restart`, NormaClient+Methods.swift):
///   - `disabled == true` (any tier/status) → `[.enable, .remove]`. Checked FIRST, ahead of
///     `status`: a disabled plugin has no live process regardless of what `status` last reported
///     (enabling is the only way back to running).
///   - enabled AND `status == "running"` → `[.restart, .disable, .remove]`. `.restart` is offered
///     ONLY here — never for an enabled-but-not-currently-running Tier-2 plugin
///     (starting/stopped/backoff/circuit-open) and never for na/Tier-1; recovering those goes
///     through disable→enable (which hot-restarts the process under the hood via
///     `PluginSupervisor.restart`), not a bare restart button. NEVER `.enable` for a running
///     plugin — enabling an already-running plugin bounces it.
///   - everything else enabled (na/Tier-1/legacy, or an enabled Tier-2 plugin that isn't currently
///     "running") → `[.disable, .remove]`.
///
/// Status/tier TEXT is derived independently of the action rule: `disabled` is still checked FIRST
/// — a disabled Tier-2 plugin's `status` reports "na" or "stopped" server-side (see
/// `pluginSpawnEligible`, packages/core/src/agent/plugins.ts — disabled fails spawn-eligibility),
/// but the row should read "Disabled", not "Stopped"/"N/A". `na` always gets its own
/// `PluginStatusColorKind`, never conflated with `.stopped` or any other Tier-2 runtime state.
func pluginRowDisplay(
    name: String,
    version: String?,
    tier: String?,
    requiredConsents: [String],
    consented: [String],
    legacy: Bool,
    status: String?,
    disabled: Bool
) -> PluginRowDisplay {
    let tierBadge: String
    if legacy {
        tierBadge = "Legacy"
    } else {
        switch tier {
        case "platform": tierBadge = "Tier 2"
        case "capability": tierBadge = "Tier 1"
        default: tierBadge = "Unknown"
        }
    }

    let consentText: String
    if requiredConsents.isEmpty {
        consentText = "No consent required"
    } else {
        let missing = requiredConsents.filter { !consented.contains($0) }
        consentText = missing.isEmpty
            ? "Consented: \(requiredConsents.joined(separator: ", "))"
            : "Needs consent: \(missing.joined(separator: ", "))"
    }

    let statusText: String
    let statusColorKind: PluginStatusColorKind
    if disabled {
        statusText = "Disabled"
        statusColorKind = .disabled
    } else {
        switch status {
        case "running": statusText = "Running"; statusColorKind = .running
        case "starting": statusText = "Starting"; statusColorKind = .starting
        case "stopped": statusText = "Stopped"; statusColorKind = .stopped
        case "backoff": statusText = "Backoff"; statusColorKind = .backoff
        case "circuit-open": statusText = "Circuit open"; statusColorKind = .circuitOpen
        default: statusText = "N/A"; statusColorKind = .na
        }
    }

    let actions: [PluginAction]
    if disabled {
        actions = [.enable, .remove]
    } else if status == "running" {
        actions = [.restart, .disable, .remove]
    } else {
        actions = [.disable, .remove]
    }

    return PluginRowDisplay(
        name: name,
        tierBadge: tierBadge,
        version: version ?? "—",
        consentText: consentText,
        statusText: statusText,
        statusColorKind: statusColorKind,
        actions: actions
    )
}

// -----------------------------------------------------------------------------------------------
// Install-from-UI pure helpers (Task 3, 4d-iii): a `.zip` picked via `NSOpenPanel` is extracted to
// a temp dir via `/usr/bin/unzip` (`Process`, matching `CliLauncher`'s existing Process-launch
// idiom elsewhere in this target — no zip-reading library dependency); a folder is used directly.
// `locatePluginRoot` — finding the actual plugin root within an extracted zip's temp dir — touches
// the real filesystem rather than a `NormaClient`, so it's directly testable against a real temp
// directory instead of mocked.
// -----------------------------------------------------------------------------------------------

enum PluginInstallError: Error, Equatable {
    /// `/usr/bin/unzip` exited non-zero.
    case unzipFailed
}

/// The plugin root within `directory`: `directory` itself if it directly holds a
/// `norma-plugin.json`/`plugin.json` manifest, else a single top-level subdirectory that does
/// (the common "zip wraps everything in one folder" shape) — checked in that order. `nil` if
/// neither matches (ambiguous or manifest-less zip contents).
///
/// `__MACOSX` and dot-prefixed entries (`.DS_Store`, `.git`, ...) are ignored when looking for
/// candidates: Finder's "Compress" — the most common way a Mac user zips a folder — produces a
/// zip containing both the real plugin folder AND a `__MACOSX` metadata folder, which would
/// otherwise look like two top-level subdirectories and wrongly fail the single-subdirectory
/// check below.
///
/// A manifest that is itself a SYMLINK is rejected (checked via `URLResourceValues.isSymbolicLink`,
/// which reports on the path itself rather than following it) — a zip/folder can otherwise smuggle
/// a symlinked `norma-plugin.json` pointing anywhere on disk, which `fileExists`/`Data(contentsOf:)`
/// would happily follow.
func locatePluginRoot(in directory: URL, fileManager: FileManager = .default) -> URL? {
    func isManifest(_ url: URL) -> Bool {
        guard fileManager.fileExists(atPath: url.path) else { return false }
        let isSymlink = (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]))?.isSymbolicLink ?? false
        return !isSymlink
    }
    func hasManifest(_ url: URL) -> Bool {
        isManifest(url.appendingPathComponent("norma-plugin.json"))
            || isManifest(url.appendingPathComponent("plugin.json"))
    }
    func isIgnoredCandidate(_ url: URL) -> Bool {
        let name = url.lastPathComponent
        return name == "__MACOSX" || name.hasPrefix(".")
    }
    if hasManifest(directory) { return directory }
    guard let entries = try? fileManager.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.isDirectoryKey]
    ) else { return nil }
    let candidates = entries.filter { !isIgnoredCandidate($0) }
    let subdirs = candidates.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }
    guard subdirs.count == 1, hasManifest(subdirs[0]) else { return nil }
    return subdirs[0]
}

/// Extracts a `.zip` at `zipURL` into a fresh temp directory via `/usr/bin/unzip -q ... -d ...`
/// and returns that directory — the CALLER resolves the actual plugin root inside it via
/// `locatePluginRoot` (the zip may or may not wrap its contents in one top-level folder).
///
/// `async` (Fix wave, Task 2 review): `installFrom` below calls this from `PluginManagerView`,
/// whose methods are MainActor-isolated (SwiftUI infers `@MainActor` across a `View`'s own
/// methods) — a plain `process.waitUntilExit()` synchronously blocks that thread for the whole
/// unzip, freezing the UI on a large archive. Setting `terminationHandler` BEFORE `run()` and
/// resuming a continuation from it (rather than blocking on `waitUntilExit()`) means no thread —
/// MainActor's or otherwise — sits blocked while `/usr/bin/unzip` runs; the caller just suspends.
///
/// On failure (either `run()` throwing, or a non-zero exit) `tempDir` is removed here before
/// rethrowing — the caller never gets a URL to it in that case, so it couldn't clean it up
/// itself. `installFrom`'s own `defer`-based cleanup only ever has to handle the URL this
/// function actually returns (extraction succeeded).
func extractPluginZip(at zipURL: URL, fileManager: FileManager = .default) async throws -> URL {
    let tempDir = fileManager.temporaryDirectory
        .appendingPathComponent("norma-plugin-install-\(UUID().uuidString)", isDirectory: true)
    try fileManager.createDirectory(at: tempDir, withIntermediateDirectories: true)
    do {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-q", zipURL.path, "-d", tempDir.path]
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            process.terminationHandler = { _ in continuation.resume() }
            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                continuation.resume(throwing: error)
            }
        }
        guard process.terminationStatus == 0 else { throw PluginInstallError.unzipFailed }
    } catch {
        try? fileManager.removeItem(at: tempDir)
        throw error
    }
    return tempDir
}

// -----------------------------------------------------------------------------------------------
// Settle-loop pure decision (4d gate-fix loop 1, live-gate refresh-timing UX fix #1): a lifecycle
// RPC (`plugin.enable`/`plugin.restart`/...) resolves BEFORE the daemon's `PluginSupervisor`
// finishes actually bringing the plugin's process up — so the row the action's own trailing
// `refresh()` renders can still read "starting" for roughly a second afterward, with nothing left
// to re-poll it. `PluginManagerModel.startSettling(_:)` re-`refresh()`s roughly once a second until
// this returns `false`; PURE and table-tested directly (`PluginManagerModelTests`) rather than
// buried in the loop itself.
// -----------------------------------------------------------------------------------------------

/// `true` while the settle loop should keep polling: the row is STILL `"starting"` and under the
/// 15s bound. `false` for every other status (`running`/`stopped`/`backoff`/`circuit-open`/`na`, or
/// `nil` — e.g. the row vanished after a `remove`) regardless of elapsed time, and for `"starting"`
/// itself once 15s have elapsed (a generous ceiling — if the plugin is still `"starting"` after
/// that, repeated polling won't fix it). `elapsedSeconds == 15` itself stops (strict `<`, not
/// `<=`) — the bound is inclusive of everything up to but not including the 15s mark.
func settleShouldContinue(status: String?, elapsedSeconds: Double) -> Bool {
    status == "starting" && elapsedSeconds < 15
}

// -----------------------------------------------------------------------------------------------
// PluginManagerModel — the pane's live view-model (`@MainActor`/`ObservableObject`, same posture
// as `PeripheralProvider`): owns the plugin list + drives the 4 lifecycle actions, each followed by
// a `refresh()` so the row list always reflects the daemon's just-applied state.
// -----------------------------------------------------------------------------------------------

@MainActor
final class PluginManagerModel: ObservableObject {
    private let client: NormaClient

    @Published private(set) var rows: [PluginRowDisplay] = []
    @Published var errorText: String?
    /// Task 3 (4d-iii): the live consent sheet, seeded from EITHER trigger — an `enable(_:)` that
    /// came back `.needsConsent`, or a successful `install(source:)`. `PluginManagerView` presents
    /// this via `.sheet(item:)`; setting it to `nil` (confirm/cancel, or a swipe-to-dismiss) closes
    /// the sheet.
    @Published var consentSheet: ConsentSheetState?
    /// The plugin name an in-flight action is currently running against — lets the view disable
    /// that row's buttons mid-action, same `revokingPath`-style single-flight posture as
    /// `TrustPane`.
    @Published private(set) var busyName: String?
    /// Task 3: true while `install(source:)` is in flight — lets the view disable the "Install
    /// Plugin…" button so a second pick can't race the first.
    @Published private(set) var installing = false
    /// Fix wave (Task 2 review, consent double-submit guard): true while `confirmConsent()` is
    /// running — makes re-entry (a second call landing before the first's RPC resolves) a no-op,
    /// on top of `busyName`-driven `.disabled(...)` on the sheet's own buttons (belt-and-suspenders
    /// against a click racing ahead of that state update).
    private var isConfirmingConsent = false
    /// 4d gate-fix loop 1: raw `plugins.list` status strings, keyed by name — kept alongside `rows`
    /// (which only stores the user-facing `statusText`/`statusColorKind`) so `startSettling`'s poll
    /// loop can compare against the wire's own vocabulary (`"starting"`, ...) via
    /// `settleShouldContinue` rather than reverse-engineering it from display text. Only updated on
    /// a SUCCESSFUL `refresh()` — same "stays stale on failure" posture as `rows` itself (below).
    private var statusByName: [String: String?] = [:]
    /// 4d gate-fix loop 1: the in-flight settle loop, if any — `startSettling(_:)` cancels/replaces
    /// it (only one row is ever `busyName` at a time, so an old loop's target is moot the moment a
    /// new action starts); `stopSettling()` is the pane's `.onDisappear` cancellation path.
    private var settleTask: Task<Void, Never>?
    /// 4d gate-fix loop 1 (UX fix #2): fires at the end of EVERY `refresh()` — the manual "Refresh"
    /// click, each action's own follow-up refresh, AND every settle-loop tick — so the pane can keep
    /// sibling models (the shortcut editor, primarily) in sync with the plugin list's latest state
    /// without a second, independently-timed poll of their own. `PluginManagerView` wires this to
    /// `shortcutsModel.refresh()`.
    var onRefreshed: (() -> Void)?

    init(client: NormaClient) {
        self.client = client
    }

    func refresh() async {
        do {
            let plugins = try await client.pluginsList()
            rows = plugins.map { p in
                pluginRowDisplay(
                    name: p.name, version: p.version, tier: p.tier,
                    requiredConsents: p.requiredConsents, consented: p.consented,
                    legacy: p.legacy, status: p.status, disabled: p.disabled
                )
            }
            statusByName = Dictionary(uniqueKeysWithValues: plugins.map { ($0.name, $0.status) })
            errorText = nil
        } catch {
            errorText = "couldn't load plugins — try Refresh"
        }
        onRefreshed?()
    }

    /// 4d gate-fix loop 1 (UX fix #1): starts (cancelling any prior) a bounded settle loop for
    /// `name` — re-`refresh()`s roughly once a second until `settleShouldContinue` says stop. Called
    /// unconditionally at the end of every lifecycle action below (enable/confirmConsent/restart —
    /// where a real "starting" transition is expected — and disable/remove too, for symmetric
    /// settling: their target status is never `"starting"`, so `settleShouldContinue` stops those
    /// loops on the very first check, before any extra `refresh()` fires). Checks the ALREADY-fresh
    /// `statusByName` (set by the caller's own preceding `refresh()`) before its first sleep, so an
    /// action whose row is already settled never schedules a redundant poll.
    private func startSettling(_ name: String) {
        settleTask?.cancel()
        let started = Date()
        settleTask = Task { @MainActor [weak self] in
            while true {
                guard let self else { return }
                if Task.isCancelled { return }
                let status = self.statusByName[name] ?? nil
                let elapsed = Date().timeIntervalSince(started)
                guard settleShouldContinue(status: status, elapsedSeconds: elapsed) else { return }
                try? await Task.sleep(for: .seconds(1))
                if Task.isCancelled { return }
                await self.refresh()
            }
        }
    }

    /// 4d gate-fix loop 1: cancels any in-flight settle loop without waiting for it — wired to the
    /// pane's `.onDisappear` (a disappearing pane has no row left to update anyway).
    func stopSettling() {
        settleTask?.cancel()
        settleTask = nil
    }

    // Fix wave 1 (Task 2 review, error-surfacing defect): `refresh()`'s success path
    // unconditionally clears `errorText` — and `pluginsList()` succeeding is INDEPENDENT of
    // whether the action itself failed, so a bare `errorText = ...; await refresh()` had the
    // refresh wipe the action's error the instant it ran. Each action method below now captures
    // its own failure into a local `actionError` instead of writing straight to `errorText`, calls
    // `refresh()` (which still does the normal list-reload + stale-error-clear), and only THEN — if
    // the action itself failed — sets `errorText` to the captured message, so it's the LAST write
    // and survives the refresh. On an action success, `actionError` stays nil and refresh's own
    // clear stands untouched. `.needsConsent` is deliberately NOT routed through `actionError` — it
    // is a pending state, not a failure (see `consentSheet`, below).
    func enable(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            switch try await client.pluginEnable(name: name) {
            case .ok:
                consentSheet = nil
            case .needsConsent(let requiredConsents, let consentBlock):
                // Task 3: replaces Task 2's dead orange-banner-only surfacing — clicking Enable on
                // a needs-consent plugin now opens the GUI consent sheet, seeded verbatim from the
                // server's disclosure.
                consentSheet = ConsentSheetState(pluginName: name, consentBlock: consentBlock, requiredConsents: requiredConsents)
            case .unknownPlugin:
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't enable \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
        startSettling(name)
    }

    func disable(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            if try await client.pluginDisable(name: name) == .unknownPlugin {
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't disable \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
        startSettling(name)
    }

    func remove(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            if try await client.pluginRemove(name: name) == .unknownPlugin {
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't remove \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
        startSettling(name)
    }

    func restart(_ name: String) async {
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            try await client.pluginRestart(name: name)
        } catch {
            actionError = "couldn't restart \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
        startSettling(name)
    }

    /// Task 3 (4d-iii): install a plugin from a local folder, or an already-extracted zip's
    /// resolved plugin root — `PluginManagerView` resolves a picked `.zip` down to a directory via
    /// `extractPluginZip`/`locatePluginRoot` BEFORE calling this (`plugins.install` is
    /// folder-source-only over the wire, per 4d-ii). On success opens the consent sheet seeded
    /// with the server's `consentBlock`/`requiredConsents` — installs always land DISABLED +
    /// UNCONSENTED server-side (`plugins.install`'s own contract), so there's always a sheet to
    /// show, even for a plugin that ends up needing zero consent classes (its `consentBlock` is
    /// then just the header line — `pluginEnable(consent:true)` on confirm is still what actually
    /// turns it on, since install itself never enables). `.invalidSource`/`.alreadyInstalled`
    /// surface via `errorText` instead, same as every other action's failure path.
    func install(source: String) async {
        installing = true
        defer { installing = false }
        var actionError: String?
        do {
            switch try await client.pluginsInstall(source: source) {
            case .ok(let name, let requiredConsents, _, let consentBlock):
                consentSheet = ConsentSheetState(pluginName: name, consentBlock: consentBlock, requiredConsents: requiredConsents)
            case .invalidSource:
                actionError = "not a valid plugin source — no norma-plugin.json/plugin.json found"
            case .alreadyInstalled(let name):
                actionError = "\(name) is already installed"
            }
        } catch {
            actionError = "couldn't install plugin — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
    }

    /// The consent sheet's "Grant consent & enable" — re-calls `pluginEnable(consent:true)` for
    /// whichever plugin `consentSheet` names (covers BOTH triggers: a needs-consent `enable`
    /// retry, or the first-ever enable right after an `install`). Dismisses the sheet on `.ok`;
    /// stays open (re-seeded) if the server somehow still reports `.needsConsent` — mirrors
    /// `enable(_:)`'s own handling of that outcome.
    ///
    /// Fix wave (Task 2 review, consent double-submit guard): `isConfirmingConsent` makes a second
    /// call a no-op while the first is still in flight — e.g. a click landing before the view's
    /// own `busy`-driven `.disabled(...)` has had a chance to take effect — so at most one
    /// `pluginEnable(consent:true)` RPC is ever sent per grant.
    func confirmConsent() async {
        guard !isConfirmingConsent else { return }
        guard var sheet = consentSheet else { return }
        isConfirmingConsent = true
        defer { isConfirmingConsent = false }
        sheet.confirm()
        consentSheet = sheet
        let name = sheet.pluginName
        busyName = name
        defer { busyName = nil }
        var actionError: String?
        do {
            switch try await client.pluginEnable(name: name, consent: true) {
            case .ok:
                consentSheet = nil
            case .needsConsent(let requiredConsents, let consentBlock):
                consentSheet = ConsentSheetState(pluginName: name, consentBlock: consentBlock, requiredConsents: requiredConsents)
            case .unknownPlugin:
                consentSheet = nil
                actionError = "unknown plugin: \(name)"
            }
        } catch {
            actionError = "couldn't enable \(name) — try again"
        }
        await refresh()
        if let actionError { errorText = actionError }
        startSettling(name)
    }

    /// The consent sheet's "Cancel" — dismisses without ever calling `pluginEnable`; the plugin
    /// stays exactly as it was (installed-disabled, or still-disabled after the failed enable that
    /// opened the sheet in the first place).
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
    /// Task 4 (4d-iii): the live tiles strip's own view-model — same "constructed once, injected
    /// here" posture as `model` above (App shell T7: `AppDelegate.makeDashboardWiring`, replacing
    /// `DashboardWindowController.init`'s old per-window-open construction).
    @ObservedObject var tilesModel: TilesStripModel
    /// Task 4 (4d-iii): the shortcut binding editor's own view-model — same posture as `tilesModel`.
    @ObservedObject var shortcutsModel: ShortcutBindingEditorModel
    /// Task 4 (4d-iii): the bottom helper-approval row reads this directly — same `@ObservedObject`
    /// posture `PeripheralPane` already uses for the SAME instance (`DashboardWiring.helperClient`).
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
            // 4d gate-fix loop 1 (UX fix #2): wired BEFORE the first `refresh()` call below so
            // every refresh from here on — this initial one, the manual "Refresh" button, every
            // action's own trailing refresh, and every settle-loop tick — also re-syncs the
            // shortcut editor. `[weak shortcutsModel]` matches this file's existing weak-capture
            // idiom for cross-model closures (see `DetachedWindowController`'s `Task { @MainActor
            // [weak self] in ... }` pattern elsewhere in the app); `model`/`shortcutsModel` are
            // siblings with the SAME lifetime (both owned by this window's `DashboardWiring`), so
            // this isn't defending against a real dangling case today, just future-proofing.
            model.onRefreshed = { [weak shortcutsModel] in
                guard let shortcutsModel else { return }
                Task { @MainActor in await shortcutsModel.refresh() }
            }
            await model.refresh()
        }
        // 4d gate-fix loop 1 (UX fix #1): tears down any in-flight settle loop when the pane
        // disappears (window closes) — a disappearing pane has no row left to update anyway.
        .onDisappear { model.stopSettling() }
        // Task 3 (4d-iii): the GUI consent sheet — presented from BOTH triggers `model.consentSheet`
        // can be set from (`enable(_:)`'s needsConsent path, or a successful `install(source:)`).
        // Dismissing any other way (Esc/swipe) also nils the binding via SwiftUI's own `.sheet`
        // machinery — same end state as `cancelConsent()`, just without that method's explicit
        // `.cancel()` record on the (by-then-discarded) state value.
        .sheet(item: $model.consentSheet) { sheet in
            // Fix wave (Task 2 review, consent double-submit guard): `busy` mirrors this same
            // `busyName == name` posture the row buttons already use (`pluginRow(_:)` below) —
            // `confirmConsent()` sets `busyName` to the sheet's plugin name for the RPC's duration.
            ConsentSheet(
                state: sheet,
                busy: model.busyName == sheet.pluginName,
                onConfirm: { Task { await model.confirmConsent() } },
                onCancel: { model.cancelConsent() }
            )
        }
    }

    /// Task 2's original plugin-list rendering, extracted verbatim into its own section (Task 4) —
    /// no longer wrapped in its OWN `ScrollView` (it now shares the pane-wide one above, alongside
    /// the tiles strip / shortcut editor / helper row).
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

    /// Task 3: "Install Plugin…" — `NSOpenPanel` lets the user pick a folder OR a `.zip`
    /// (`canChooseDirectories`/`canChooseFiles` both true; `allowedContentTypes` filters the FILE
    /// side to `.zip` only — per `NSOpenPanel` semantics, `allowedContentTypes` never filters out
    /// directories when `canChooseDirectories` is true, so any folder stays pickable).
    private func presentInstallPanel() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.zip]
        panel.message = "Choose a plugin folder or a .zip archive"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await installFrom(url: url) }
    }

    /// If `url` is a `.zip`, extract it to a temp dir first and resolve the actual plugin root
    /// within it (`extractPluginZip`/`locatePluginRoot`) before calling `pluginsInstall` — the RPC
    /// itself is folder-source-only. A folder is used directly.
    ///
    /// Fix wave (Task 2 review): the extraction temp dir was never removed. `zipTempDir`, cleaned
    /// in `defer`, tracks it ONLY when `url` was actually a zip we extracted — a picked FOLDER
    /// (`sourceDir = url` below) must never be deleted. The `defer` fires on every exit path
    /// (locatePluginRoot-nil, `model.install` failure, and success alike), but only AFTER
    /// `await model.install(source:)` resolves — the daemon needs the directory to still exist
    /// while it copies the plugin in.
    private func installFrom(url: URL) async {
        var zipTempDir: URL?
        defer {
            if let zipTempDir {
                try? FileManager.default.removeItem(at: zipTempDir)
            }
        }
        let sourceDir: URL
        if url.pathExtension.lowercased() == "zip" {
            do {
                let tempDir = try await extractPluginZip(at: url)
                zipTempDir = tempDir
                guard let root = locatePluginRoot(in: tempDir) else {
                    model.errorText = "zip has no norma-plugin.json/plugin.json — not a plugin"
                    return
                }
                sourceDir = root
            } catch {
                model.errorText = "couldn't extract the zip — try again"
                return
            }
        } else {
            sourceDir = url
        }
        await model.install(source: sourceDir.path)
    }

    private func pluginRow(_ row: PluginRowDisplay) -> some View {
        let busy = model.busyName == row.name
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(row.name).font(Typography.control(.medium))
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
                    Button(action.title) { Task { await perform(action, on: row.name) } }
                        .font(Typography.label())
                        .foregroundStyle(action == .remove ? .red : .primary)
                        .disabled(busy)
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
    }

    private func perform(_ action: PluginAction, on name: String) async {
        switch action {
        case .enable: await model.enable(name)
        case .disable: await model.disable(name)
        case .remove: await model.remove(name)
        case .restart: await model.restart(name)
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

    /// `na`/`disabled` render WITHOUT the colored dot at all (no runtime process to indicate) —
    /// every other status gets one, colored per `statusDotColor`.
    private func statusIndicator(_ row: PluginRowDisplay) -> some View {
        HStack(spacing: 4) {
            if let dot = statusDotColor(row.statusColorKind) {
                Circle().fill(dot).frame(width: 6, height: 6)
            }
            Text(row.statusText).font(Typography.caption()).foregroundStyle(.secondary)
        }
    }

    private func statusDotColor(_ kind: PluginStatusColorKind) -> Color? {
        switch kind {
        case .running: return .green
        case .starting: return .blue
        case .stopped: return .secondary
        case .backoff: return .orange
        case .circuitOpen: return .red
        case .na, .disabled: return nil
        }
    }
}
