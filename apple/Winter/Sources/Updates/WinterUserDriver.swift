import Foundation
import Sparkle

// MARK: - Winter's own Sparkle user driver (2026-09-18)

/// The UI half of Sparkle, replaced.
///
/// **What this does NOT touch.** Sparkle's engine is entirely unchanged: `SPUUpdater` still fetches
/// and parses the appcast, still applies `allowedChannels` (our `UpdaterCoordinator`'s), still
/// verifies the EdDSA signature against `SUPublicEDKey`, still stages, still swaps the bundle and
/// relaunches. `SPUUserDriver` is a pure presentation protocol — Sparkle's own
/// `SPUStandardUpdaterController` is nothing more than a convenience that news up an `SPUUpdater`
/// and an `SPUStandardUserDriver` together. Constructing the updater ourselves and handing it this
/// driver instead swaps the windows and nothing else.
///
/// **Every method here is one line of translation plus a reply.** The state machine lives in
/// `UpdatePresenter` and the reply contract is documented there — read it before editing anything
/// in this file, because a dropped reply block wedges the updater permanently and silently.
///
/// The protocol is declared `NS_SWIFT_UI_ACTOR`, so this class is `@MainActor` by requirement, not
/// by preference; Sparkle's own header also promises every call arrives on the main thread.
@MainActor
final class WinterUserDriver: NSObject, SPUUserDriver {
    private let presenter: UpdatePresenter

    init(presenter: UpdatePresenter) {
        self.presenter = presenter
    }

    // MARK: Permission

    /// UNREACHABLE in Winter, and implemented anyway because the protocol requires it.
    ///
    /// `SPUUpdater.startUpdateCycle` only prompts when `SUEnableAutomaticChecks` is absent from both
    /// user defaults and the Info.plist; Winter's Info.plist sets it to `true`
    /// (`apple/Winter/project.yml`), so `shouldPrompt` is always NO. If it ever does fire — because
    /// someone removed that key — answering "yes to automatic checks, no to the system profile"
    /// reproduces exactly the configuration the Info.plist declares today, rather than silently
    /// turning updates off. It logs, because a prompt appearing here would mean the Info.plist
    /// changed under us.
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        OrbDebug.log("updates: Sparkle asked for update permission — answering from the Info.plist defaults")
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }

    // MARK: Checking

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        presenter.checkStarted(cancellation: cancellation)
    }

    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
                         reply: @escaping (SPUUserUpdateChoice) -> Void) {
        // TWO finds must be answered on the spot rather than held for a click, because in both
        // cases there may be no panel open to click in — and a held reply keeps
        // `SPUUpdater.sessionInProgress` true, which silently kills every later check for the life
        // of the process (see `UpdatePresenter`'s reply contract):
        //
        // 1. an INFORMATION-ONLY item has no file to download at all; Sparkle rewrites `.install`
        //    to `.dismiss` for one, so a Download button could never work;
        // 2. a find nobody asked for (`state.userInitiated == false`) — the automatic driver defers
        //    major upgrades, information-only items and appcast-signing failures
        //    (`SPUUpdateRequiresUserAttentionBeforeDownloading`) and Sparkle re-shows them through
        //    a scheduled UI driver. Today's `appcastItem` emits none of those, so this is a guard
        //    against a shape the release script could grow, not a live path.
        //
        // The state is still published — knowing an update exists is the point of the panel — and
        // `perform(.download)` on a reply-less `.found` re-checks, which re-finds it user-initiated
        // with a live reply attached.
        if appcastItem.isInformationOnlyUpdate || !state.userInitiated {
            OrbDebug.log("updates: \(appcastItem.displayVersionString) found without a user asking "
                         + "(infoOnly=\(appcastItem.isInformationOnlyUpdate)) — answering Sparkle now")
            presenter.found(version: appcastItem.displayVersionString,
                            notes: ReleaseNotes.inline(description: appcastItem.itemDescription,
                                                       format: appcastItem.itemDescriptionFormat),
                            notesURL: appcastItem.releaseNotesURL ?? appcastItem.infoURL,
                            reply: nil)
            reply(.dismiss)
            return
        }
        presenter.found(version: appcastItem.displayVersionString,
                        notes: ReleaseNotes.inline(description: appcastItem.itemDescription,
                                                   format: appcastItem.itemDescriptionFormat),
                        notesURL: appcastItem.releaseNotesURL,
                        reply: reply)
    }

    /// The `<sparkle:releaseNotesLink>` body, fetched and signature-checked by Sparkle's own
    /// release-notes driver. It lands AFTER `showUpdateFound`, so this upgrades the inline notes in
    /// place rather than racing them.
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
        guard let notes = releaseNotes(from: downloadData) else { return }
        presenter.releaseNotesArrived(notes)
    }

    /// A failed notes download is NOT an update failure — the update itself is fine. The panel keeps
    /// whatever inline notes it has and still offers the link.
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {
        OrbDebug.log("updates: release notes failed to download — \(error.localizedDescription)")
    }

    func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        acknowledgement()
        presenter.notFound()
    }

    func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        acknowledgement()
        presenter.failed(error.localizedDescription)
    }

    // MARK: Downloading and unpacking

    func showDownloadInitiated(cancellation: @escaping () -> Void) {
        presenter.downloadStarted(cancellation: cancellation)
    }

    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        presenter.downloadExpectedLength(expectedContentLength)
    }

    func showDownloadDidReceiveData(ofLength length: UInt64) {
        presenter.downloadReceived(length)
    }

    func showDownloadDidStartExtractingUpdate() {
        presenter.extractionStarted()
    }

    func showExtractionReceivedProgress(_ progress: Double) {
        presenter.extractionProgress(progress)
    }

    // MARK: Installing

    /// Replied `.install` immediately. See `UpdatePresenter`'s reply contract: the panel's single
    /// "Download and Install" is the user's commitment, and the relaunch this triggers runs
    /// straight into `UpdaterCoordinator.updater(_:shouldPostponeRelaunchForUpdate:…)` — Winter's
    /// idle gate — which is the unchanged policy that decides when the swap actually happens.
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        presenter.readyToInstall()
        reply(.install)
    }

    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool,
                              retryTerminatingApplication: @escaping () -> Void) {
        presenter.installing()
    }

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
        acknowledgement()
        presenter.installFinished()
    }

    func dismissUpdateInstallation() {
        presenter.dismissed()
    }

    /// Optional, and worth implementing: without it, a second `checkForUpdates()` while an update is
    /// already being shown logs an error and does nothing at all. With it, Sparkle routes the click
    /// here — and since the panel IS the surface, there is nothing to raise; re-asserting the
    /// current state is the whole job.
    func showUpdateInFocus() {}

    // MARK: - Private

    /// Decode a downloaded notes body. HTML unless the server said `text/plain`; the declared text
    /// encoding when there is one, UTF-8 otherwise (Sparkle's own fallback).
    private func releaseNotes(from data: SPUDownloadData) -> ReleaseNotes? {
        var encoding = String.Encoding.utf8
        if let name = data.textEncodingName {
            let cf = CFStringConvertIANACharSetNameToEncoding(name as CFString)
            if cf != kCFStringEncodingInvalidId {
                encoding = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cf))
            }
        }
        guard let body = String(data: data.data, encoding: encoding) ?? String(data: data.data, encoding: .utf8),
              !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        let isHTML = (data.mimeType?.lowercased().contains("text/plain") ?? false) == false
        return ReleaseNotes(isHTML: isHTML, body: body)
    }
}
