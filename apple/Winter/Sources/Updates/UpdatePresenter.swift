import Foundation
import WinterKit
import Sparkle

// MARK: - The observable the Updates panel reads (2026-09-18)

/// The one live piece of update state in the app.
///
/// It exists because Winter now draws its own update UI. Sparkle's engine is untouched — appcast
/// parsing, channel gating, EdDSA verification, staging and the install are all still Sparkle's —
/// but the UI half (`SPUStandardUserDriver`, which `SPUStandardUpdaterController` used to bundle in
/// for us) is replaced by `WinterUserDriver`, whose whole job is to turn Sparkle's callbacks into
/// the `UpdateStatus` this object publishes.
///
/// **Constructed unconditionally**, including in Debug and under the xctest host, where there is no
/// `SPUUpdater` to attach. That is deliberate: a nil presenter would give the panel a second code
/// path for "no updater", and the panel would have to guess what to say. With the presenter always
/// present, `updater == nil` is simply `UpdateStatus.unavailable`, which the panel renders as the
/// honest "updates are disabled in this build".
///
/// ## The reply contract (the thing that breaks silently if you get it wrong)
///
/// Every block Sparkle hands the user driver must be invoked exactly once, eventually. A dropped
/// reply leaves `SPUUpdater.sessionInProgress` true forever, and from then on every
/// `checkForUpdates()` returns early with nothing but a log line — the updater is wedged for the
/// rest of the process's life, and nothing on screen says so. So:
///
/// - `showUpdateFound` → the panel's Download button replies `.install`; closing the panel while
///   still in `.found` replies `.dismiss` (`panelClosed()`). Either way it fires.
/// - `showReady(toInstallAndRelaunch:)` → replied `.install` IMMEDIATELY, not held for a click.
///   The panel's one button already said "Download and Install", and Sparkle's own relaunch then
///   runs straight into `UpdaterCoordinator`'s `shouldPostponeRelaunchForUpdate` hook, which is
///   where Winter's idle gate lives. So the user's single commitment reaches exactly the policy it
///   reached before this change, and no reply is ever left dangling behind a closed panel.
/// - the three acknowledgement callbacks are invoked before anything else in their method.
/// - `dismissUpdateInstallation` clears every pending slot.
///
/// ## Two roads to "ready to install"
///
/// The user-initiated road is the one above. The OTHER road never touches this class's driver at
/// all: `SPUAutomaticUpdateDriver` downloads in the background and calls the user driver for
/// nothing (read its source — it holds the driver "only for a termination callback"). Its only
/// surface is `UpdaterCoordinator.onStagedChange`, which `AppDelegate` fans out to the menu bar AND
/// to `staged(version:)` here. Without that fan-out the panel would sit on `.idle` while the menu
/// bar said "Update ready", which is precisely the sort of two-truths bug this app has shipped
/// before.
@MainActor
final class UpdatePresenter: ObservableObject {
    @Published private(set) var status: UpdateStatus = .unavailable
    /// The release notes for whatever was last found. Starts as the appcast item's inline
    /// `<description>` and is REPLACED in place if Sparkle later downloads a
    /// `<sparkle:releaseNotesLink>` body — the link is the richer source when both exist.
    @Published private(set) var notes: ReleaseNotes?
    /// The `<sparkle:releaseNotesLink>` itself, kept so the panel can offer "open in your browser"
    /// even when the body failed to download.
    @Published private(set) var notesURL: URL?
    /// The SDK rows the daemon's versions RPC will fill. Empty until then; the panel renders the
    /// pending rows from `pendingSdkComponents` regardless, so this arriving late changes nothing
    /// structural.
    @Published private(set) var sdkComponents: [InstalledComponent] = []
    @Published private(set) var sdkError: String?

    /// Sparkle's engine. `nil` in Debug and under unit tests — see the type doc.
    private(set) weak var updater: SPUUpdater?
    /// The idle gate / install door. Only used for `installNow()`; every policy decision stays
    /// inside the coordinator.
    private weak var coordinator: UpdaterCoordinator?

    // Pending Sparkle callbacks. At most one of each is live at a time.
    private var foundReply: ((SPUUserUpdateChoice) -> Void)?
    private var cancelCheck: (() -> Void)?
    private var cancelDownload: (() -> Void)?
    /// Set once the coordinator has staged an update; `installNow()` is then the install door
    /// rather than a Sparkle reply.
    private var stagedByCoordinator = false

    /// Called by `AppDelegate` once the real updater exists (release builds only).
    func attach(updater: SPUUpdater, coordinator: UpdaterCoordinator) {
        self.updater = updater
        self.coordinator = coordinator
        status = .idle
    }

    var isAvailable: Bool { updater != nil }

    // MARK: - What the panel calls

    /// The panel checks on open — opening it IS the action. It must not stomp a flow already in
    /// progress, and it must not spin against a background session that will never call this
    /// driver back.
    func checkOnOpen() {
        switch status {
        case .unavailable, .idle, .upToDate, .failed, .backgroundBusy:
            // `.backgroundBusy` re-checks deliberately: it means Sparkle's own session was open the
            // LAST time we looked, which for a scheduled check is a matter of seconds. Treating it
            // as "in progress" here would strand the panel on a state with no way forward.
            check()
        case .checking, .found, .downloading, .extracting, .readyToInstall, .installing:
            // Something is already happening and the panel is about to render it. Re-asking would
            // either be a no-op with an error in the log or would abort what is running.
            break
        }
    }

    /// An explicit check: the panel's button, the menu bar's "Check for Updates…", and the
    /// Dashboard's updater pane all land here.
    func check() {
        guard let updater else {
            status = .unavailable
            return
        }
        if stagedByCoordinator {
            // Already downloaded and waiting on the idle gate. Checking again would be refused by
            // Sparkle anyway (the automatic driver still holds the session).
            return
        }
        if updater.sessionInProgress {
            status = .backgroundBusy
            return
        }
        notes = nil
        notesURL = nil
        status = .checking
        updater.checkForUpdates()
    }

    /// The panel's one primary button.
    func perform(_ action: UpdateAction) {
        switch action {
        case .check:
            check()
        case .download:
            guard let reply = foundReply else {
                // A `.found` with no reply is the already-discharged scheduled find (see
                // `found(version:…)`'s `reply` doc): Sparkle has been answered and its session
                // closed, so the way to act on it is to ask again — this time user-initiated, which
                // brings a live reply with it.
                check()
                return
            }
            foundReply = nil
            reply(.install)
        case .install:
            // Whichever road we arrived by. The coordinator's own `installNow()` is idempotent and
            // is the SAME door the menu bar's "Restart Now" uses, so the two cannot diverge.
            coordinator?.installNow()
        case .cancel:
            cancelDownload?()
            cancelCheck?()
            cancelDownload = nil
            cancelCheck = nil
            if case .checking = status { status = .idle }
            if case .downloading = status { status = .idle }
        case .none:
            break
        }
    }

    /// The panel is going away. The ONE thing that must happen here is discharging a `.found`
    /// reply — see the type doc's reply contract. A download in flight is deliberately left alone:
    /// it is a background transfer that will finish and stage itself, exactly as the silent path
    /// does.
    func panelClosed() {
        if case .found = status, let reply = foundReply {
            foundReply = nil
            reply(.dismiss)
            status = .idle
        }
    }

    /// Ask the daemon for the SDK rows (`versions.get`, through `DashboardWiring.sdkVersions`).
    /// A no-op — leaving the three pending rows in place — when there is no closure at all.
    ///
    /// **A daemon that predates `versions.get` is not an error.** This app ships ahead of the
    /// daemon routinely, and `-32601` is its way of saying so; the three rows already read
    /// "waiting for the daemon", which is the truth, so that case clears `sdkError` rather than
    /// printing a protocol code under the table. Every other failure IS shown, because a socket
    /// that died or a reply that made no sense is something the user can act on.
    ///
    /// `"\(error)"`, not `localizedDescription`: `RpcError` is a plain `Error`, so Foundation
    /// renders it as "The operation couldn't be completed. (WinterKit.RpcError error 1.)" — which
    /// says nothing at all.
    func loadSdkVersions(_ load: (() async throws -> [InstalledComponent])?) async {
        guard let load else { return }
        do {
            sdkComponents = try await load()
            sdkError = nil
        } catch {
            sdkComponents = []
            sdkError = isMethodNotFoundError(error) ? nil
                : shellPanelErrorText("Couldn't read the installed versions", detail: "\(error)")
        }
    }

    // MARK: - What the user driver calls (all on the main actor, by protocol contract)

    func checkStarted(cancellation: @escaping () -> Void) {
        cancelCheck = cancellation
        status = .checking
    }

    /// `reply` is `nil` when the caller has ALREADY answered Sparkle — which is what
    /// `WinterUserDriver` does for a find nobody asked for (a scheduled UI-driver check, or an
    /// information-only item). The state is still worth showing; the reply just is not ours to
    /// hold, and holding it behind a panel that may never open is exactly the wedge this class's
    /// header warns about. `perform(.download)` re-checks in that case.
    func found(version: String, notes: ReleaseNotes?, notesURL: URL?,
               reply: ((SPUUserUpdateChoice) -> Void)?) {
        cancelCheck = nil
        foundReply = reply
        self.notes = notes
        self.notesURL = notesURL
        status = .found(version: version)
    }

    /// The downloaded `<sparkle:releaseNotesLink>` body, which arrives after `found(...)`.
    func releaseNotesArrived(_ notes: ReleaseNotes) {
        self.notes = notes
    }

    func notFound() {
        cancelCheck = nil
        foundReply = nil
        status = .upToDate
    }

    func failed(_ message: String) {
        cancelCheck = nil
        cancelDownload = nil
        foundReply = nil
        status = .failed(message: message)
    }

    func downloadStarted(cancellation: @escaping () -> Void) {
        cancelCheck = nil
        foundReply = nil
        cancelDownload = cancellation
        status = .downloading(received: 0, expected: expectedLength)
    }

    /// Sparkle may report this more than once for one download, and may not report it at all.
    func downloadExpectedLength(_ length: UInt64) {
        expectedLength = length
        if case .downloading(let received, _) = status {
            status = .downloading(received: received, expected: length)
        }
    }

    func downloadReceived(_ length: UInt64) {
        guard case .downloading(let received, let expected) = status else { return }
        status = .downloading(received: received + length, expected: expected)
    }

    func extractionStarted() {
        cancelDownload = nil
        expectedLength = 0
        status = .extracting(progress: 0)
    }

    func extractionProgress(_ progress: Double) {
        status = .extracting(progress: progress)
    }

    /// Sparkle is ready to install and is waiting on a choice. Replied `.install` at the call site
    /// (`WinterUserDriver`); this only moves the state, so a panel open at that instant shows the
    /// hand-off rather than a frozen progress bar.
    func readyToInstall() {
        status = .readyToInstall(version: stagedVersion, hold: .unknown)
    }

    func installing() {
        status = .installing
    }

    func installFinished() {
        stagedByCoordinator = false
        stagedVersion = nil
        status = .idle
    }

    /// Everything Sparkle was showing is torn down. Keep a staged update visible — it genuinely is
    /// still staged — and otherwise fall back to idle.
    func dismissed() {
        cancelCheck = nil
        cancelDownload = nil
        foundReply = nil
        if stagedByCoordinator {
            status = .readyToInstall(version: stagedVersion, hold: holdReason)
        } else {
            switch status {
            case .failed, .upToDate, .unavailable, .installing:
                break   // the outcome is the information; do not erase it
            default:
                status = .idle
            }
        }
    }

    // MARK: - What `UpdaterCoordinator` calls (through `AppDelegate`'s fan-out)

    /// The silent road's only surface, and also where a user-initiated install lands once Sparkle's
    /// relaunch hits the coordinator's postpone hook.
    func staged(_ staged: Bool, version: String?) {
        stagedByCoordinator = staged
        if staged {
            stagedVersion = version
            status = .readyToInstall(version: version, hold: holdReason)
        } else {
            // `onStagedChange(false, …)` fires from `installNow()`, immediately before the install.
            holdReason = .unknown
            status = .installing
        }
    }

    /// The idle gate polled and decided to hold. This is the only way the panel can honestly say
    /// WHY a ready update is sitting there.
    func installHeld() {
        holdReason = .busy
        if case .readyToInstall(let version, _) = status {
            status = .readyToInstall(version: version, hold: .busy)
        }
    }

    // MARK: - Private

    private var expectedLength: UInt64 = 0
    private var stagedVersion: String?
    private var holdReason: UpdateHoldReason = .unknown
}
