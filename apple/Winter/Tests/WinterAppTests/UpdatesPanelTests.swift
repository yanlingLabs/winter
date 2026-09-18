import XCTest
import WinterKit
import Sparkle
@testable import Winter

/// The Updates panel's pure layer (2026-09-18).
///
/// Sparkle itself cannot be exercised here — it is constructed `#if !DEBUG` and never under the
/// xctest host — so everything the panel DECIDES lives in free functions, and this is where those
/// decisions are pinned. What is NOT pinned here, and cannot be, is the live Sparkle callback
/// sequence; `UpdatePresenter`'s own reply contract is the documented substitute.
final class UpdatesPanelTests: XCTestCase {

    // MARK: - Byte formatting

    func testByteFormattingWalksTheDecimalLadder() {
        XCTAssertEqual(formatUpdateBytes(0), "0 bytes")
        XCTAssertEqual(formatUpdateBytes(999), "999 bytes")
        XCTAssertEqual(formatUpdateBytes(1_000), "1.0 KB")
        XCTAssertEqual(formatUpdateBytes(12_400_000), "12.4 MB")
        // Past 100 the tenth is noise, so it is dropped.
        XCTAssertEqual(formatUpdateBytes(370_000_000), "370 MB")
        XCTAssertEqual(formatUpdateBytes(2_500_000_000), "2.5 GB")
    }

    func testProgressTextDropsTheTotalWhenThereIsNone() {
        XCTAssertEqual(downloadProgressText(received: 12_400_000, expected: 48_100_000),
                       "12.4 MB of 48.1 MB")
        XCTAssertEqual(downloadProgressText(received: 12_400_000, expected: 0), "12.4 MB")
    }

    // MARK: - The progress fraction

    /// Sparkle's own header warns the expected content length may be absent or wrong. A fraction is
    /// only honest when there is a total AND we have not already overshot it — otherwise the bar
    /// must go indeterminate rather than sit pinned at 100% while bytes keep arriving.
    func testFractionIsNilWhenTheTotalIsUnknownOrOvershot() {
        XCTAssertNil(downloadFraction(received: 10, expected: 0))
        XCTAssertNil(downloadFraction(received: 11, expected: 10))
        XCTAssertEqual(downloadFraction(received: 5, expected: 10), 0.5)
        XCTAssertEqual(downloadFraction(received: 10, expected: 10), 1.0)
    }

    /// `showDownloadDidStartExtractingUpdate` lands as `extracting(progress: 0)` and Sparkle calls
    /// it BEFORE any progress — so zero means indeterminate, not "0% done".
    func testExtractionAtZeroIsIndeterminate() {
        XCTAssertNil(updateProgressFraction(.extracting(progress: 0)))
        XCTAssertEqual(updateProgressFraction(.extracting(progress: 0.25)), 0.25)
        XCTAssertEqual(updateProgressFraction(.extracting(progress: 9)), 1)
    }

    func testProgressIsShownOnlyWhileSomethingIsMoving() {
        XCTAssertTrue(updateShowsProgress(.checking))
        XCTAssertTrue(updateShowsProgress(.downloading(received: 1, expected: 2)))
        XCTAssertTrue(updateShowsProgress(.extracting(progress: 0.5)))
        XCTAssertTrue(updateShowsProgress(.installing))
        for idle: UpdateStatus in [.unavailable, .idle, .upToDate, .backgroundBusy,
                                   .found(version: "1"), .readyToInstall(version: "1", hold: .unknown),
                                   .failed(message: "x")] {
            XCTAssertFalse(updateShowsProgress(idle), "\(idle) should not draw a bar")
        }
    }

    // MARK: - State → copy

    func testEveryStateHasANonEmptyHeadline() {
        let states: [UpdateStatus] = [
            .unavailable, .idle, .checking, .backgroundBusy, .upToDate,
            .found(version: "0.115.0"), .downloading(received: 1, expected: 2),
            .extracting(progress: 0.5), .readyToInstall(version: "0.115.0", hold: .unknown),
            .readyToInstall(version: nil, hold: .busy), .installing, .failed(message: "boom"),
        ]
        for state in states {
            XCTAssertFalse(updateStatusHeadline(state).isEmpty, "\(state) has no headline")
        }
    }

    /// The Debug build is the state a developer sees every day, so it must explain ITSELF rather
    /// than read as a broken panel.
    func testUnavailableExplainsWhyAndOffersNoButton() {
        XCTAssertTrue(updateStatusHeadline(.unavailable).contains("disabled in this build"))
        XCTAssertNotNil(updateStatusDetail(.unavailable))
        XCTAssertNil(updatePrimaryAction(.unavailable))
    }

    /// The idle gate's hold is the one genuinely new fact this panel can tell a user, and the copy
    /// has to differ from the plain ready state or it says nothing.
    func testHoldReasonChangesTheDetailLine() {
        let unknown = updateStatusDetail(.readyToInstall(version: "0.115.0", hold: .unknown))
        let busy = updateStatusDetail(.readyToInstall(version: "0.115.0", hold: .busy))
        XCTAssertNotNil(unknown)
        XCTAssertNotNil(busy)
        XCTAssertNotEqual(unknown, busy)
        XCTAssertTrue(busy?.contains("Restart Now") == true)
    }

    func testVersionlessReadyStateStillReads() {
        XCTAssertEqual(updateStatusHeadline(.readyToInstall(version: nil, hold: .unknown)),
                       "An update is ready to install")
    }

    func testTheFailureDetailIsSparklesOwnMessage() {
        XCTAssertEqual(updateStatusDetail(.failed(message: "the archive is damaged")),
                       "the archive is damaged")
    }

    // MARK: - The primary button

    func testPrimaryActionPerState() {
        XCTAssertEqual(updatePrimaryAction(.idle)?.action, .check)
        XCTAssertEqual(updatePrimaryAction(.upToDate)?.action, .check)
        XCTAssertEqual(updatePrimaryAction(.failed(message: "x"))?.action, .check)
        XCTAssertEqual(updatePrimaryAction(.checking)?.action, .cancel)
        XCTAssertEqual(updatePrimaryAction(.found(version: "1"))?.action, .download)
        XCTAssertEqual(updatePrimaryAction(.downloading(received: 1, expected: 2))?.action, .cancel)
        XCTAssertEqual(updatePrimaryAction(.readyToInstall(version: "1", hold: .busy))?.action, .install)
        // No button where pressing one could not help: extraction cannot be cancelled, installing
        // is past the point of no return, and a background session is not ours to interrupt.
        XCTAssertNil(updatePrimaryAction(.extracting(progress: 0.5)))
        XCTAssertNil(updatePrimaryAction(.installing))
        XCTAssertNil(updatePrimaryAction(.unavailable))
    }

    /// `.backgroundBusy` must never be a dead end. A scheduled check holds Sparkle's session for a
    /// second or two; a user who opens the panel inside that window would otherwise be stuck on
    /// "Winter is checking on its own" with no button and no re-check, for the life of the process.
    func testBackgroundBusyOffersAWayOut() {
        XCTAssertEqual(updatePrimaryAction(.backgroundBusy)?.action, .check)
    }

    // MARK: - Release notes

    func testOnlyPlainTextIsTreatedAsPlainText() {
        XCTAssertTrue(ReleaseNotes.format(nil))           // Sparkle's own default is HTML
        XCTAssertTrue(ReleaseNotes.format("html"))
        XCTAssertFalse(ReleaseNotes.format("plain-text"))
        XCTAssertFalse(ReleaseNotes.format("PLAIN-TEXT"))
    }

    /// Today's appcast `<description>` is a bare version line and there is frequently nothing at
    /// all; a blank body must produce NO notes section rather than an empty box.
    func testBlankInlineNotesAreNoNotes() {
        XCTAssertNil(ReleaseNotes.inline(description: nil, format: nil))
        XCTAssertNil(ReleaseNotes.inline(description: "   \n\t ", format: nil))
        XCTAssertEqual(ReleaseNotes.inline(description: "<p>Fixed things</p>", format: nil),
                       ReleaseNotes(isHTML: true, body: "<p>Fixed things</p>"))
    }

    @MainActor
    func testHtmlNotesAreFlattenedAndPlainTextPassesThrough() {
        let html = ReleaseNotes(isHTML: true, body: "<h2>0.115.0</h2><p>Faster <b>everything</b>.</p>")
        let flattened = releaseNotesText(html)
        XCTAssertTrue(flattened.contains("0.115.0"))
        XCTAssertTrue(flattened.contains("Faster everything."))
        XCTAssertFalse(flattened.contains("<"))

        let plain = ReleaseNotes(isHTML: false, body: "  just words\n")
        XCTAssertEqual(releaseNotesText(plain), "just words")
    }

    // MARK: - The installed-versions table

    func testTheTableAlwaysCarriesFiveRowsInAFixedOrder() {
        let rows = installedComponents(winter: "0.114.4", chromium: "151.3.16.0", sdk: [])
        XCTAssertEqual(rows.map(\.name),
                       ["Winter", "Chromium", "Winter agent SDK", "Winter runtime SDK", "Claude agent SDK"])
    }

    /// The SDK rows are PENDING, not missing. Omitting them would make the panel quietly claim
    /// Winter is made of two components.
    func testUnansweredSdkRowsSayWhatTheyAreWaitingFor() {
        let rows = installedComponents(winter: "0.114.4", chromium: nil, sdk: [])
        let sdk = rows.first { $0.name == "Winter agent SDK" }
        XCTAssertNotNil(sdk)
        XCTAssertTrue(installedComponentIsPending(sdk!))
        XCTAssertEqual(installedComponentValue(sdk!), "waiting for the daemon")
    }

    func testAPartialDaemonAnswerFillsOnlyItsOwnRows() {
        let rows = installedComponents(
            winter: "0.114.4", chromium: "151.3.16.0",
            sdk: [InstalledComponent(name: "Winter runtime SDK", installed: "0.0.8", pinned: "0.0.8")])
        XCTAssertEqual(rows.map(\.name),
                       ["Winter", "Chromium", "Winter agent SDK", "Winter runtime SDK", "Claude agent SDK"])
        XCTAssertEqual(installedComponentValue(rows[3]), "0.0.8")
        XCTAssertTrue(installedComponentIsPending(rows[2]))
    }

    /// A pin/installed disagreement is a NORMAL state to display: the resolver has several rungs
    /// and which one answered is exactly what a version panel exists to show. Both numbers, no
    /// error tone.
    func testAnOffPinSdkShowsBothNumbers() {
        let row = InstalledComponent(name: "Winter agent SDK", installed: "0.0.17", pinned: "0.0.16")
        XCTAssertEqual(installedComponentValue(row), "0.0.17 (pinned 0.0.16)")
        XCTAssertTrue(installedComponentIsOffPin(row))
        XCTAssertFalse(installedComponentIsPending(row))

        let matched = InstalledComponent(name: "x", installed: "0.0.16", pinned: "0.0.16")
        XCTAssertEqual(installedComponentValue(matched), "0.0.16")
        XCTAssertFalse(installedComponentIsOffPin(matched))
    }

    /// A Debug app embeds no runtimes, so this is nil here — and the row has to say something.
    func testAMissingLocalComponentStillRendersAReason() {
        let rows = installedComponents(winter: nil, chromium: nil, sdk: [])
        XCTAssertEqual(installedComponentValue(rows[0]), "no version in this bundle")
        XCTAssertEqual(installedComponentValue(rows[1]), "not embedded in this build")
    }

    /// Both local readers, against the REAL app bundle (`Bundle.main` here is the xctest host,
    /// which is Winter.app itself).
    ///
    /// The CEF half is the one that matters: it reads the embedded framework's `Info.plist` through
    /// `Bundle(path:)` and must NEVER initialise CEF — `WinterCEF.mm`'s loader is a one-way door,
    /// and a version row is not allowed to be the thing that boots a browser engine. This test
    /// passing at all is the proof that a plain plist read answers (measured: `151.3.16.0`), with no
    /// `CefInitialize`, no helper processes and no window anywhere.
    func testTheLocalReadersAnswerWithoutInitialisingAnything() {
        let winter = winterInstalledVersion()
        XCTAssertNotNil(winter)
        XCTAssertFalse(winter?.isEmpty ?? true)

        let chromium = embeddedChromiumVersion()
        XCTAssertNotNil(chromium, "the embedded CEF framework's Info.plist should be readable")
        // Shape, not value — a CEF bump must not fail this.
        XCTAssertTrue(chromium?.allSatisfy { $0.isNumber || $0 == "." } ?? false,
                      "unexpected CEF version shape: \(chromium ?? "nil")")
    }

    /// An absent framework is a real case (any bundle without one), and `Bundle(path:)` answers nil
    /// rather than throwing or loading anything.
    func testAnAbsentChromiumFrameworkIsNilNotACrash() {
        XCTAssertNil(embeddedChromiumVersion(
            appBundleURL: URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("winter-updates-panel-tests-no-such-app", isDirectory: true)))
    }

    func testEveryComponentHasAGlyph() {
        for name in ["Winter", "Chromium", "Winter agent SDK", "Winter runtime SDK",
                     "Claude agent SDK", "something new the daemon added"] {
            XCTAssertFalse(updatesComponentGlyph(name).isEmpty)
        }
    }

    // MARK: - The presenter's guards

    /// No `SPUUpdater` (Debug, or this xctest host) must be a rendered state, never a dead button.
    @MainActor
    func testAnUnattachedPresenterStaysUnavailable() {
        let presenter = UpdatePresenter()
        XCTAssertFalse(presenter.isAvailable)
        XCTAssertEqual(presenter.status, .unavailable)
        presenter.check()
        XCTAssertEqual(presenter.status, .unavailable)
        presenter.checkOnOpen()
        XCTAssertEqual(presenter.status, .unavailable)
    }

    /// The background download never calls the user driver at all, so `onStagedChange` is the
    /// panel's ONLY way to learn an update is waiting. Without this fan-out the menu bar would say
    /// "Update ready" while the panel said "up to date".
    @MainActor
    func testTheCoordinatorsStagedSignalDrivesThePanelWithNoUpdaterAtAll() {
        let presenter = UpdatePresenter()
        presenter.staged(true, version: "0.115.0")
        XCTAssertEqual(presenter.status, .readyToInstall(version: "0.115.0", hold: .unknown))
        presenter.installHeld()
        XCTAssertEqual(presenter.status, .readyToInstall(version: "0.115.0", hold: .busy))
        // `onStagedChange(false, …)` fires from `installNow()`, immediately before the swap.
        presenter.staged(false, version: "0.115.0")
        XCTAssertEqual(presenter.status, .installing)
    }

    /// `checkOnOpen` must not stomp a flow already running — re-opening the panel mid-download
    /// shows the download rather than aborting it.
    @MainActor
    func testCheckOnOpenLeavesAnInFlightFlowAlone() {
        let presenter = UpdatePresenter()
        presenter.staged(true, version: "0.115.0")
        presenter.checkOnOpen()
        XCTAssertEqual(presenter.status, .readyToInstall(version: "0.115.0", hold: .unknown))
    }

    /// The reply contract: a `.found` state is Sparkle blocked on an answer, and closing the panel
    /// has to BE an answer. A dropped reply leaves `sessionInProgress` true and every later check
    /// silently returns early for the life of the process.
    @MainActor
    func testClosingThePanelDischargesAPendingFoundReply() {
        let presenter = UpdatePresenter()
        var choices: [SPUUserUpdateChoice] = []
        presenter.found(version: "0.115.0", notes: nil, notesURL: nil, reply: { choices.append($0) })
        XCTAssertEqual(presenter.status, .found(version: "0.115.0"))
        presenter.panelClosed()
        XCTAssertEqual(choices, [.dismiss])
        XCTAssertEqual(presenter.status, .idle)
        // Idempotent: a second close must not fire a second reply.
        presenter.panelClosed()
        XCTAssertEqual(choices, [.dismiss])
    }

    /// A find nobody asked for (a scheduled UI-driver re-show, or an information-only item) is
    /// answered by `WinterUserDriver` on the spot, so the presenter holds the STATE with no reply.
    /// Acting on it must re-check rather than do nothing — and, crucially, closing the panel must
    /// not try to answer a reply that was already given.
    @MainActor
    func testAReplylessFoundIsStillRenderedAndDoesNotDoubleAnswer() {
        let presenter = UpdatePresenter()
        presenter.found(version: "0.115.0", notes: nil, notesURL: nil, reply: nil)
        XCTAssertEqual(presenter.status, .found(version: "0.115.0"))
        presenter.panelClosed()
        XCTAssertEqual(presenter.status, .found(version: "0.115.0"))
        // `perform(.download)` falls through to `check()`, which with no updater attached lands on
        // `.unavailable` — the point being that it does SOMETHING rather than silently nothing.
        presenter.perform(.download)
        XCTAssertEqual(presenter.status, .unavailable)
    }

    @MainActor
    func testTheDownloadButtonRepliesInstallExactlyOnce() {
        let presenter = UpdatePresenter()
        var choices: [SPUUserUpdateChoice] = []
        presenter.found(version: "0.115.0", notes: nil, notesURL: nil, reply: { choices.append($0) })
        presenter.perform(.download)
        presenter.perform(.download)
        presenter.panelClosed()
        XCTAssertEqual(choices, [.install])
    }

    /// Byte accounting: Sparkle reports deltas, not totals, and may report the expected length
    /// late (or more than once).
    @MainActor
    func testDownloadBytesAccumulateAndALateTotalIsAdopted() {
        let presenter = UpdatePresenter()
        presenter.downloadStarted(cancellation: {})
        presenter.downloadReceived(100)
        presenter.downloadReceived(150)
        XCTAssertEqual(presenter.status, .downloading(received: 250, expected: 0))
        presenter.downloadExpectedLength(1_000)
        XCTAssertEqual(presenter.status, .downloading(received: 250, expected: 1_000))
        presenter.extractionStarted()
        XCTAssertEqual(presenter.status, .extracting(progress: 0))
    }

    /// An outcome is information. Sparkle's `dismissUpdateInstallation` tears its own UI down at
    /// the end of a session, and erasing "up to date" or the error at that moment would blank the
    /// panel the instant the user got their answer.
    @MainActor
    func testDismissKeepsAnOutcomeButClearsAnInterruptedFlow() {
        let presenter = UpdatePresenter()
        presenter.notFound()
        presenter.dismissed()
        XCTAssertEqual(presenter.status, .upToDate)

        let other = UpdatePresenter()
        other.failed("nope")
        other.dismissed()
        XCTAssertEqual(other.status, .failed(message: "nope"))

        let third = UpdatePresenter()
        third.checkStarted(cancellation: {})
        third.dismissed()
        XCTAssertEqual(third.status, .idle)
    }

    /// A staged update survives a dismissal — it genuinely is still staged.
    @MainActor
    func testDismissKeepsAStagedUpdateVisible() {
        let presenter = UpdatePresenter()
        presenter.staged(true, version: "0.115.0")
        presenter.installHeld()
        presenter.dismissed()
        XCTAssertEqual(presenter.status, .readyToInstall(version: "0.115.0", hold: .busy))
    }

    // MARK: - versions.get → the three SDK rows (2026-09-18)

    /// The mapper's names must match `pendingSdkComponents`' EXACTLY — `installedComponents` swaps
    /// by name, so a near-miss appends nothing and silently leaves the row pending.
    func testSdkRowsCarryBothNumbersAndKeepTheirExactNames() {
        let rows = sdkInstalledComponents(VersionsSnapshot(
            core: "0.114.4",
            pins: ["winterAgentSdk": "0.0.16", "winterRuntimeSdk": "0.0.8", "claudeAgentSdk": "0.3.250"],
            installed: ["winterAgentSdk": "0.0.16", "claudeAgentSdk": "0.3.249"],
            winterExecutable: nil, claudeExecutable: nil, official: nil))

        XCTAssertEqual(rows.map(\.name), pendingSdkComponents.map(\.name),
                       "these names ARE the swap key in installedComponents")
        XCTAssertEqual(installedComponentValue(rows[0]), "0.0.16")
        // A pin/installed disagreement shows BOTH numbers, quietly — it is a normal consequence of
        // the resolver's rungs, never an error state.
        XCTAssertEqual(installedComponentValue(rows[2]), "0.3.249 (pinned 0.3.250)")
        XCTAssertTrue(installedComponentIsOffPin(rows[2]))
        // Not reported ⇒ the pin alone, never the pin echoed back as if it were measured.
        XCTAssertNil(rows[1].installed)
        XCTAssertEqual(installedComponentValue(rows[1]), "pinned 0.0.8")

        let table = installedComponents(winter: "0.114.4", chromium: nil, sdk: rows)
        XCTAssertEqual(table.count, 5)
        XCTAssertEqual(installedComponentValue(table[4]), "0.3.249 (pinned 0.3.250)",
                       "the daemon's rows replace the pending ones in place")
    }

    /// An answer that names neither number says so rather than going blank — and the executables,
    /// which carry a path and a resolver rung but NO version, are not rows in this table at all.
    func testSdkRowsWithNothingReportedSayThatAndIgnoreTheExecutables() {
        let rows = sdkInstalledComponents(VersionsSnapshot(
            core: nil, pins: [:], installed: [:],
            winterExecutable: VersionsExecutable(path: "/tmp/dist/winter", source: "env"),
            claudeExecutable: nil, official: nil))
        XCTAssertEqual(rows.count, 3)
        XCTAssertTrue(rows.allSatisfy(installedComponentIsPending))
        XCTAssertEqual(installedComponentValue(rows[0]), "the daemon didn't report this one")
        XCTAssertFalse(rows.contains { $0.name.lowercased().contains("executable") })
    }
}
