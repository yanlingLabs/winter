import Foundation
import NormaKit
import Sparkle

/// Injectable seam for everything the updater touches outside its own logic
/// (DaemonSupervisorDeps precedent — see DaemonSupervisor.swift).
struct UpdaterCoordinatorDeps {
    /// Current number of executing agent turns; nil when the daemon is unreachable
    /// (treated as idle — nothing to interrupt).
    var activeTurns: () async -> Int?
    /// True while any editor runtime has a dirty (unsaved) buffer. **Consulted on the POLL path
    /// only** (`startPolling()`'s idle check) — task-10 fix round 1, closing the concrete gap a
    /// review walked: idle machine, no active daemon turns, user walks away, poll fires, Sparkle
    /// terminates the host, `applicationShouldTerminate` answers `.terminateNow` without ever
    /// entering the menu-bar `quit:` closure (so `EditorQuitGate` never runs) — buffer gone on
    /// relaunch, no user action anywhere in the chain. Deliberately NOT consulted by `installNow()`
    /// itself, so the "Restart Now" menu click (`AppDelegate`'s `onInstallUpdate`) keeps today's
    /// behavior unchanged — that alert-less install is existing updater UX, and gating a click the
    /// user just made is a different product question this fix does not decide.
    /// **Consequence accepted, not fixed:** a forever-dirty editor defers auto-install
    /// indefinitely — same shape as a never-idle agent turn already deferred it before this fix,
    /// self-heals on the next launch, and the quit gate (`EditorQuitGate`) now warns on the way out
    /// regardless. Fail-open default `{ false }` (`.live` below); `AppDelegate.boot()` replaces it
    /// with the live walk over every session's `EditorRuntime` (`quitDirtyFilePaths`, the same pure
    /// function `EditorQuitGate` uses) whenever no test override is installed.
    var dirtyEditors: () -> Bool
    /// updates.channel from ~/.norma/settings.json; nil/absent → stable.
    var readChannel: () -> String?
    /// NORMA_UPDATE_FEED env override for local test feeds; nil → Info.plist SUFeedURL.
    var feedOverride: () -> String?
    var now: () -> Date
    var pollIntervalSeconds: TimeInterval
    var badgeAfterSeconds: TimeInterval
}

extension UpdaterCoordinatorDeps {
    /// Production wiring. activeTurns here is only the fail-open default (nil = idle):
    /// `AppDelegate.boot()` replaces it with the live daemon bridge
    /// (`AppModel.engineActivity()`, the T2 engine.activity RPC) whenever no test override is
    /// installed (T4). dirtyEditors is likewise only the fail-open default (false = clean):
    /// `AppDelegate.boot()` replaces it with the live editor walk the same way, right alongside
    /// activeTurns (task-10 fix round 1). readChannel reads live from settings.json (T5). All
    /// three fail open: nil activity = idle, false dirty = clean, nil channel = stable.
    @MainActor static var live: UpdaterCoordinatorDeps {
        .init(
            activeTurns: { nil },
            dirtyEditors: { false },
            readChannel: { UpdaterCoordinator.readChannelFromSettings() },
            feedOverride: { ProcessInfo.processInfo.environment["NORMA_UPDATE_FEED"] },
            now: { Date() },
            pollIntervalSeconds: 30,
            badgeAfterSeconds: 24 * 60 * 60
        )
    }
}

/// Sparkle delegate: silent background updates; Norma-specific gating lives here.
@MainActor
final class UpdaterCoordinator: NSObject {
    let deps: UpdaterCoordinatorDeps

    // Staged-update state
    private(set) var stagedVersion: String?
    private var stagedAt: Date?
    private var pendingInstall: (() -> Void)?
    private var pollTask: Task<Void, Never>?
    /// Menu-bar hooks (installed by AppDelegate).
    var onStagedChange: ((_ staged: Bool, _ version: String?) -> Void)?
    var onBadgeChange: ((_ badged: Bool) -> Void)?
    /// Whole-branch review (Critical): fired exactly once, immediately before the install handler
    /// runs. Sparkle terminates the host via a CANCELLABLE Apple quit event (no forceTerminate,
    /// no kAEQuitReason), which routes through `applicationShouldTerminate` — without arming,
    /// Norma's lifecycle gate answers it `.terminateCancel` (like a ⌘Q) and the install dies
    /// silently. AppDelegate wires this to set its `updaterQuitting` true-quit axis.
    var onWillInstall: (() -> Void)?

    init(deps: UpdaterCoordinatorDeps) {
        self.deps = deps
    }

    /// Testable core of feedURLString(for:).
    func resolvedFeedOverride() -> String? {
        deps.feedOverride()
    }

    /// The idle gate. Sparkle asks permission to relaunch after staging an update; we always
    /// postpone and let the poll (first tick immediate) or the user's Restart-now decide.
    /// Returns true = postpone (Sparkle holds until `installHandler` is invoked).
    func handleRelaunchRequest(version: String, untilInvoking installHandler: @escaping () -> Void) -> Bool {
        stagedVersion = version
        stagedAt = deps.now()
        pendingInstall = installHandler
        onStagedChange?(true, version)
        startPolling()
        return true
    }

    /// Poll: first check immediately (idle-at-stage installs with no 30s lag), then every
    /// pollIntervalSeconds. nil activeTurns (daemon unreachable) counts as idle. task-10 fix
    /// round 1: idle alone is no longer sufficient — a dirty editor buffer holds the poll back
    /// too (`dirtyEditors`'s own doc for the full why/consequences). `installNow()` itself stays
    /// unguarded: this is the ONLY caller this predicate applies to — "Restart Now" calls
    /// `installNow()` directly and must keep firing regardless.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                if (await self.deps.activeTurns() ?? 0) == 0, !self.deps.dirtyEditors() {
                    self.installNow()
                    return
                }
                self.refreshBadge()
                try? await Task.sleep(for: .seconds(self.deps.pollIntervalSeconds))
            }
        }
    }

    /// The poll's idle trigger AND the user's "Restart Now" override. Idempotent. Takes no dirty-
    /// editor opinion itself — `startPolling()`'s predicate is what withholds the poll's own call;
    /// reached via `onInstallUpdate`, this always proceeds (task-10 fix round 1's deliberate line).
    func installNow() {
        guard let install = pendingInstall else { return }
        pendingInstall = nil
        pollTask?.cancel()
        onStagedChange?(false, stagedVersion)
        onWillInstall?() // arm the updater-quit axis BEFORE Sparkle's cancellable terminate round-trip
        install() // Sparkle proceeds: quit → swap bundle → relaunch (supervisor spawns the new daemon)
    }

    private func refreshBadge() {
        guard let at = stagedAt else { return }
        onBadgeChange?(deps.now().timeIntervalSince(at) >= deps.badgeAfterSeconds)
    }

    /// stable/nil/unknown → default channel only (empty set); beta → +"beta".
    func allowedChannelSet(for channelSetting: String?) -> Set<String> {
        channelSetting == "beta" ? ["beta"] : []
    }

    /// Live read of updates.channel from ~/.norma/settings.json (nil on absent/malformed).
    nonisolated static func readChannelFromSettings() -> String? {
        let url = URL(fileURLWithPath: NormaPaths.settingsPath())
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let updates = obj["updates"] as? [String: Any]
        else { return nil }
        return updates["channel"] as? String
    }
}

extension UpdaterCoordinator: SPUUpdaterDelegate {
    /// Dev/test override: NORMA_UPDATE_FEED wins; nil → Sparkle falls back to Info.plist.
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        MainActor.assumeIsolated { resolvedFeedOverride() }
    }

    nonisolated func updater(
        _ updater: SPUUpdater,
        shouldPostponeRelaunchForUpdate item: SUAppcastItem,
        untilInvokingBlock installHandler: @escaping () -> Void
    ) -> Bool {
        MainActor.assumeIsolated {
            handleRelaunchRequest(version: item.displayVersionString, untilInvoking: installHandler)
        }
    }

    /// Live-gate finding: the SILENT automatic flow never reaches the postpone hook above —
    /// Sparkle stages for install-on-quit and waits; the postpone hook only fires on an
    /// already-relaunching (user-initiated) install. THIS is the seam that drives auto-install:
    /// returning true takes control (stalling future update cycles — correct, the idle poll or
    /// Restart Now WILL invoke the handler), and Sparkle still installs on a natural app quit
    /// regardless. Recovery note: Sparkle 2.3+ allows invoking `immediateInstallHandler` multiple
    /// times if the app cancels the termination request — our single-shot `installNow()` never
    /// needs that today (the `updaterQuitting` arming makes a cancelled termination a non-path),
    /// but re-invocation is the documented avenue if a future terminate-blocker ever appears.
    nonisolated func updater(
        _ updater: SPUUpdater,
        willInstallUpdateOnQuit item: SUAppcastItem,
        immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
    ) -> Bool {
        MainActor.assumeIsolated {
            _ = handleRelaunchRequest(version: item.displayVersionString, untilInvoking: immediateInstallHandler)
            return true   // we take control: the idle poll (or Restart Now) invokes the handler
        }
    }

    /// Beta/stable channel gate — Sparkle re-asks this per check, so a settings.json edit
    /// takes effect at the very next check with no daemon/app restart needed.
    nonisolated func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        MainActor.assumeIsolated { allowedChannelSet(for: deps.readChannel()) }
    }
}
