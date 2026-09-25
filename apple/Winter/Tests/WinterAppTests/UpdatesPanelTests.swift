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

    /// Plain-text notes bypass the parser entirely; HTML notes go through it and keep their
    /// structure. (The pass this replaces FLATTENED the HTML to a single string — right while a
    /// `<description>` was one line, wrong now that it carries headings, lists and fences.)
    func testHtmlNotesKeepTheirStructureAndPlainTextPassesThrough() {
        let html = ReleaseNotes(isHTML: true, body: "<h2>0.115.0</h2><p>Faster <b>everything</b>.</p>")
        XCTAssertEqual(releaseNotesBlocks(html), [
            .heading(level: 2, runs: [ReleaseNotesRun("0.115.0")]),
            .paragraph([ReleaseNotesRun("Faster "),
                        ReleaseNotesRun("everything", strong: true),
                        ReleaseNotesRun(".")]),
        ])

        let plain = ReleaseNotes(isHTML: false, body: "  just words\n")
        XCTAssertEqual(releaseNotesBlocks(plain), [.paragraph([ReleaseNotesRun("just words")])])
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

    // MARK: - versions.get → the SDK rows (2026-09-18; WS-23 dropped the Claude agent SDK row)

    /// The mapper's names must match `pendingSdkComponents`' EXACTLY — `installedComponents` swaps
    /// by name, so a near-miss appends nothing and silently leaves the row pending.
    func testSdkRowsCarryBothNumbersAndKeepTheirExactNames() {
        let rows = sdkInstalledComponents(VersionsSnapshot(
            core: "0.114.4",
            // An older daemon's `claudeAgentSdk` pin is simply not a row any more (WS-23).
            pins: ["winterAgentSdk": "0.0.16", "winterRuntimeSdk": "0.0.8", "claudeAgentSdk": "0.3.250"],
            installed: ["winterAgentSdk": "0.0.15", "claudeAgentSdk": "0.3.249"],
            winterExecutable: nil, bundle: nil))

        XCTAssertEqual(rows.map(\.name), pendingSdkComponents.map(\.name),
                       "these names ARE the swap key in installedComponents")
        XCTAssertFalse(rows.contains { $0.name.contains("Claude") })
        // A pin/installed disagreement shows BOTH numbers, quietly — it is a normal consequence of
        // the resolver's rungs, never an error state.
        XCTAssertEqual(installedComponentValue(rows[0]), "0.0.15 (pinned 0.0.16)")
        XCTAssertTrue(installedComponentIsOffPin(rows[0]))
        // Not reported ⇒ the pin alone, never the pin echoed back as if it were measured.
        XCTAssertNil(rows[1].installed)
        XCTAssertEqual(installedComponentValue(rows[1]), "pinned 0.0.8")

        let table = installedComponents(winter: "0.114.4", chromium: nil, sdk: rows)
        XCTAssertEqual(table.count, 4)
        XCTAssertEqual(installedComponentValue(table[2]), "0.0.15 (pinned 0.0.16)",
                       "the daemon's rows replace the pending ones in place")
    }

    /// An answer that names neither number says so rather than going blank — and the executables,
    /// which carry a path and a resolver rung but NO version, are not rows in this table at all.
    func testSdkRowsWithNothingReportedSayThatAndIgnoreTheExecutables() {
        let rows = sdkInstalledComponents(VersionsSnapshot(
            core: nil, pins: [:], installed: [:],
            winterExecutable: VersionsExecutable(path: "/tmp/dist/winter", source: "env"),
            bundle: nil))
        XCTAssertEqual(rows.count, 2)
        XCTAssertTrue(rows.allSatisfy(installedComponentIsPending))
        XCTAssertEqual(installedComponentValue(rows[0]), "the daemon didn't report this one")
        XCTAssertFalse(rows.contains { $0.name.lowercased().contains("executable") })
    }

    // MARK: - Release notes: HTML -> blocks (2026-09-18)
    //
    // `parseReleaseNotesHTML` is pure, so every case below is a table test: a string in, an array
    // of blocks out. The fixtures at the bottom are the EXACT bytes `release.ts` puts in the feed
    // (`scripts/release-lib.ts`'s `appcastDescription`), embedded rather than read from disk: the
    // samples live in a git-ignored records directory that a committed file may not point at
    // (CLAUDE.md). Regenerating them means re-running `appcastDescription` over the notes files.

    /// The compatibility line, and the one that matters MOST today: every item live in the feed
    /// (0.111.0 - 0.114.4) carries a single TAGLESS description, and Sparkle's default format is
    /// HTML — so the tagless body reaches the parser flagged as HTML and must come out as one
    /// ordinary paragraph. NOT the subtitle: a lone line is the notes, not metadata about them.
    func testATaglessOneLinerIsOneOrdinaryParagraph() {
        let line = "Winter agent SDK 0.0.16 \u{00B7} Claude Agent SDK 0.3.250"
        XCTAssertEqual(releaseNotesBlocks(ReleaseNotes(isHTML: true, body: line)),
                       [.paragraph([ReleaseNotesRun(line)])])
    }

    /// The subtitle promotion is conservative on both sides: it needs a REAL `<p>` (so the tagless
    /// line above stays body copy) and it needs something to be a subtitle to (so a description
    /// that is nothing but one paragraph reads as notes).
    func testTheSubtitlePromotionNeedsARealParagraphAndSomethingAfterIt() {
        XCTAssertEqual(parseReleaseNotesHTML("<p>Only this</p>"),
                       [.paragraph([ReleaseNotesRun("Only this")])])
        XCTAssertEqual(parseReleaseNotesHTML("<p>SDK line</p><p>Notes</p>"),
                       [.subtitle([ReleaseNotesRun("SDK line")]),
                        .paragraph([ReleaseNotesRun("Notes")])])
    }

    func testHeadingsCarryTheirLevel() {
        XCTAssertEqual(parseReleaseNotesHTML("<h2>Two</h2><h3>Three</h3><h1>One</h1>"), [
            .heading(level: 2, runs: [ReleaseNotesRun("Two")]),
            .heading(level: 3, runs: [ReleaseNotesRun("Three")]),
            .heading(level: 1, runs: [ReleaseNotesRun("One")]),
        ])
    }

    /// Tight lists and LOOSE ones (`<li><p>…</p></li>`, what markdown emits for blank-line
    /// separated items) must both come out as one bullet per item. Treating that inner `<p>` as a
    /// paragraph boundary would shred every list into unbulleted prose.
    func testTightAndLooseListItemsBothBecomeOneBulletEach() {
        XCTAssertEqual(parseReleaseNotesHTML("<ul>\n  <li>first</li>\n  <li>second</li>\n</ul>"),
                       [.bullet([ReleaseNotesRun("first")]), .bullet([ReleaseNotesRun("second")])])
        XCTAssertEqual(parseReleaseNotesHTML("<ul><li><p>first</p></li><li><p>second</p></li></ul>"),
                       [.bullet([ReleaseNotesRun("first")]), .bullet([ReleaseNotesRun("second")])])
    }

    /// A fence keeps its real newlines (never collapsed like prose whitespace), drops the `<code>`
    /// the generator always nests inside it, and decodes its escaped text.
    func testACodeFenceKeepsItsNewlinesAndDecodesItsText() {
        XCTAssertEqual(
            parseReleaseNotesHTML("<pre><code>a &amp;&amp; b\nc &lt;d&gt;</code></pre>"),
            [.code("a && b\nc <d>")])
    }

    /// Inline runs: the marks compose, and the SPACES between runs survive. Trimming each run
    /// instead of the block's outer edges would weld "Faster" onto "everything".
    func testInlineCodeAndStrongBecomeRunsWithTheirSpacingIntact() {
        XCTAssertEqual(
            parseReleaseNotesHTML("<p>Run <code>winter doctor</code> when <strong>stuck</strong>.</p>"),
            [.paragraph([ReleaseNotesRun("Run "),
                         ReleaseNotesRun("winter doctor", code: true),
                         ReleaseNotesRun(" when "),
                         ReleaseNotesRun("stuck", strong: true),
                         ReleaseNotesRun(".")])])
        XCTAssertEqual(parseReleaseNotesHTML("<p><strong><code>x</code></strong></p>"),
                       [.paragraph([ReleaseNotesRun("x", strong: true, code: true)])])
    }

    /// Adjacent runs with the same marks merge, so block equality tracks rendered MEANING rather
    /// than tokenizer internals — an ignored `<a>` or a decoded entity must not split a phrase.
    func testAdjacentRunsWithTheSameMarksMerge() {
        XCTAssertEqual(parseReleaseNotesHTML("<p>one <a>two</a> three &amp; four</p>"),
                       [.paragraph([ReleaseNotesRun("one two three & four")])])
    }

    /// Entities, decoded exactly ONCE. `&amp;lt;` is the TEXT `&lt;` — a second pass over the
    /// output would turn an escaped example into live markup. An unrecognised entity stays
    /// literal, and `&nbsp;` survives the whitespace collapse (U+00A0 is in
    /// `CharacterSet.whitespaces`, which is why the collapse is ASCII-only).
    func testEveryEntityDecodesExactlyOnce() {
        XCTAssertEqual(decodeReleaseNotesEntities("&amp;"), "&")
        XCTAssertEqual(decodeReleaseNotesEntities("&lt;p&gt;"), "<p>")
        XCTAssertEqual(decodeReleaseNotesEntities("&quot;q&quot;"), "\"q\"")
        XCTAssertEqual(decodeReleaseNotesEntities("&#39;a&apos;b"), "'a'b")
        XCTAssertEqual(decodeReleaseNotesEntities("&#x2014;"), "\u{2014}")
        XCTAssertEqual(decodeReleaseNotesEntities("a&nbsp;b"), "a\u{00A0}b")
        XCTAssertEqual(decodeReleaseNotesEntities("&amp;lt;"), "&lt;")
        XCTAssertEqual(decodeReleaseNotesEntities("&notareal;"), "&notareal;")
        XCTAssertEqual(decodeReleaseNotesEntities("a & b"), "a & b")
        // Through the whole parser, not just the decoder: no `&` may ever reach the screen raw.
        XCTAssertEqual(parseReleaseNotesHTML("<p>Tom &amp; Jerry &lt;tag&gt; &quot;x&quot;</p>"),
                       [.paragraph([ReleaseNotesRun("Tom & Jerry <tag> \"x\"")])])
        XCTAssertEqual(parseReleaseNotesHTML("<p>a&nbsp;b</p>"),
                       [.paragraph([ReleaseNotesRun("a\u{00A0}b")])])
    }

    /// Malformed input must lose neither the notes nor its own composure. Every case here is a
    /// degradation to TEXT — raw markup reaching the screen is the one outcome that is a bug.
    func testMalformedMarkupDegradesToTextAndNeverToMarkup() {
        // Unclosed block tags: each new block boundary flushes the one before it.
        XCTAssertEqual(parseReleaseNotesHTML("<p>one<p>two<h2>three"), [
            .subtitle([ReleaseNotesRun("one")]),
            .paragraph([ReleaseNotesRun("two")]),
            .heading(level: 2, runs: [ReleaseNotesRun("three")]),
        ])
        // An unclosed inline mark dies at its block rather than bleeding into the next.
        XCTAssertEqual(parseReleaseNotesHTML("<p><strong>bold</p><p>plain</p>"), [
            .subtitle([ReleaseNotesRun("bold", strong: true)]),
            .paragraph([ReleaseNotesRun("plain")]),
        ])
        // A `<` that begins no tag is prose, and must not eat the rest of the notes.
        XCTAssertEqual(parseReleaseNotesHTML("<p>a < b and 3 <4</p>"),
                       [.paragraph([ReleaseNotesRun("a < b and 3 <4")])])
        // An unterminated tag at the end of the buffer.
        XCTAssertEqual(parseReleaseNotesHTML("<p>text</p><p"),
                       [.paragraph([ReleaseNotesRun("text")])])
        // Close tags with nothing open, and an unknown element, are transparent.
        XCTAssertEqual(parseReleaseNotesHTML("</p></ul></strong>loose <span>text</span>"),
                       [.paragraph([ReleaseNotesRun("loose text")])])
        // A comment is not content.
        XCTAssertEqual(parseReleaseNotesHTML("<p>before<!-- hidden -->after</p>"),
                       [.paragraph([ReleaseNotesRun("beforeafter")])])
        // Empty and whitespace-only bodies make no blocks at all — never an empty box.
        XCTAssertEqual(parseReleaseNotesHTML(""), [])
        XCTAssertEqual(parseReleaseNotesHTML("<p></p><ul><li>  </li></ul>\n  \n"), [])
    }

    /// Attributes cannot occur in this feed (the generator emits none, not even a language class),
    /// but the tokenizer skips them rather than printing them — the degradation a widened
    /// generator would need.
    func testAttributesAreSkippedRatherThanPrinted() {
        XCTAssertEqual(
            parseReleaseNotesHTML("<pre><code class=\"language-sh\">winter doctor</code></pre>"),
            [.code("winter doctor")])
        XCTAssertEqual(parseReleaseNotesHTML("<p>see <a href=\"https://x/a>b\">here</a></p>"),
                       [.paragraph([ReleaseNotesRun("see here")])])
    }

    // MARK: - The real feed payloads

    /// The primary fixture: 0.112.0 is the most structurally complete `<description>` the release
    /// pipeline has ever produced — subtitle, three `h2` sections, a `<pre><code>` fence, six
    /// bullets, `strong` and inline `code` in one payload. Exercised end to end.
    func testTheRealPayloadParsesEndToEnd() {
        let blocks = parseReleaseNotesHTML(Self.appcastDescription_0_112_0)

        // 3 h2 + 6 li + 3 p (one of which is promoted to the subtitle) + 1 pre.
        XCTAssertEqual(blocks.count, 13)
        XCTAssertEqual(blocks.first,
                       .subtitle([ReleaseNotesRun("Winter agent SDK 0.0.16 \u{00B7} Claude Agent SDK 0.3.250")]))

        var headings: [String] = []
        var bullets = 0
        var fences: [String] = []
        for block in blocks {
            switch block {
            case .heading(let level, let runs):
                XCTAssertEqual(level, 2)
                headings.append(releaseNotesPlainText(runs))
            case .bullet: bullets += 1
            case .code(let text): fences.append(text)
            case .paragraph, .subtitle: break
            }
        }
        XCTAssertEqual(headings, ["Sign in to the Anthropic Console",
                                  "Claude subscriptions stay off",
                                  "Fixes"])
        XCTAssertEqual(bullets, 6)
        XCTAssertEqual(fences, ["winter login --anthropic-console\nwinter logout --anthropic-console"])

        // The lead paragraph's marks, in order — the shape the renderer draws.
        guard case .paragraph(let lead)? = blocks.dropFirst(2).first else {
            return XCTFail("the first section's paragraph is missing")
        }
        XCTAssertEqual(lead.filter(\.isStrong).map(\.text),
                       ["API key", "Console login", "Claude subscription"])
        XCTAssertEqual(lead.filter(\.isCode).map(\.text), ["ant"])
        XCTAssertTrue(releaseNotesPlainText(lead).hasSuffix("From the terminal:"))

        assertNoMarkupSurvives(blocks)
    }

    /// The longest payload shipped (3777 characters). Structure pinned by count, and the whole
    /// thing swept for markup residue — 28 inline `code` spans and 7 `strong` runs is where a
    /// tokenizer bug would show first.
    func testTheLongestRealPayloadParses() {
        let blocks = parseReleaseNotesHTML(Self.appcastDescription_0_114_0)

        // 3 h2 + 10 li + 3 p (one promoted to the subtitle).
        XCTAssertEqual(blocks.count, 16)
        XCTAssertEqual(blocks.first,
                       .subtitle([ReleaseNotesRun("Winter agent SDK 0.0.16 \u{00B7} Claude Agent SDK 0.3.250")]))
        XCTAssertEqual(blocks.filter { if case .heading = $0 { return true } else { return false } }.count, 3)
        XCTAssertEqual(blocks.filter { if case .bullet = $0 { return true } else { return false } }.count, 10)
        XCTAssertEqual(blocks.filter { if case .code = $0 { return true } else { return false } }.count, 0)

        let codeRuns = releaseNotesAllRuns(blocks).filter(\.isCode)
        XCTAssertEqual(codeRuns.count, 28)
        XCTAssertTrue(codeRuns.contains { $0.text == "codex-oauth/gpt-5.6-terra" })
        XCTAssertEqual(releaseNotesAllRuns(blocks).filter(\.isStrong).count, 7)

        assertNoMarkupSurvives(blocks)
    }

    // MARK: Helpers

    /// Nothing the parser emits may contain a tag or an undecoded entity. Checked on every block of
    /// both real payloads — the one failure mode that is unambiguously a bug on screen.
    private func assertNoMarkupSurvives(_ blocks: [ReleaseNotesBlock],
                                        file: StaticString = #filePath, line: UInt = #line) {
        for block in blocks {
            let text: String
            switch block {
            case .subtitle(let runs), .paragraph(let runs), .bullet(let runs):
                text = releaseNotesPlainText(runs)
            case .heading(_, let runs):
                text = releaseNotesPlainText(runs)
            case .code(let body):
                text = body
            }
            XCTAssertFalse(text.isEmpty, "an empty block reached the renderer", file: file, line: line)
            for tag in ["<p>", "</p>", "<li>", "<h2>", "<code>", "<strong>", "<pre>", "<ul>"] {
                XCTAssertFalse(text.contains(tag), "raw markup on screen: \(tag) in \(text)",
                               file: file, line: line)
            }
            for entity in ["&amp;", "&lt;", "&gt;", "&quot;", "&#39;", "&nbsp;"] {
                XCTAssertFalse(text.contains(entity), "undecoded entity on screen: \(entity)",
                               file: file, line: line)
            }
        }
    }

    private func releaseNotesPlainText(_ runs: [ReleaseNotesRun]) -> String {
        runs.map(\.text).joined()
    }

    private func releaseNotesAllRuns(_ blocks: [ReleaseNotesBlock]) -> [ReleaseNotesRun] {
        blocks.flatMap { block -> [ReleaseNotesRun] in
            switch block {
            case .subtitle(let runs), .paragraph(let runs), .bullet(let runs): return runs
            case .heading(_, let runs): return runs
            case .code: return []
            }
        }
    }

    // MARK: The fixtures - verbatim feed bytes

    /// `<description>` for 0.112.0, exactly as `appcastDescription` renders it.
    private static let appcastDescription_0_112_0 = """
<p>Winter agent SDK 0.0.16 · Claude Agent SDK 0.3.250</p>
<h2>Sign in to the Anthropic Console</h2>
<p>Claude models no longer need an API key copied into Winter. The Anthropic section of the Providers pane now offers three ways in: <strong>API key</strong>, <strong>Console login</strong>, and <strong>Claude subscription</strong> (shown, but not available yet). Console login signs you in through Anthropic's own Platform CLI, <code>ant</code>, which ships inside Winter.app. Usage is billed to your Console organization at API rates, exactly like a key. From the terminal:</p>
<pre><code>winter login --anthropic-console
winter logout --anthropic-console</code></pre>
<ul>
  <li>Both of Winter's runtimes use it. Code sessions on Claude models run on the Console profile, and sessions that run on Winter's own runtime use the Console token.</li>
  <li><code>runtimes.official.auth</code> picks the method: <code>auto</code> (the default: Console when you're signed in, otherwise your API key), <code>api-key</code>, or <code>console</code>. Changes apply without a restart.</li>
  <li>Your API key and your Console login are stored separately in the Keychain. Signing in to or out of the Console never touches a stored API key.</li>
  <li>A running Claude session keeps the credential it started with. A new choice applies to the next session, or the next time a session moves between runtimes.</li>
  <li>Signing out checks that the profile is really gone, and says so if it isn't.</li>
</ul>
<h2>Claude subscriptions stay off</h2>
<p>Signing in with a claude.ai subscription still isn't supported. The hidden <code>runtimes.official.subscriptionAuth</code> setting no longer loosens any check on its own; it stays inert until that door is approved.</p>
<h2>Fixes</h2>
<ul>
  <li>Moving a session from the Claude runtime back to Winter's runtime no longer reports success when the destination fails to start. The move is refused and the session stays where it was.</li>
</ul>
"""

    /// `<description>` for 0.114.0 - the longest one shipped.
    private static let appcastDescription_0_114_0 = """
<p>Winter agent SDK 0.0.16 · Claude Agent SDK 0.3.250</p>
<h2>A model is now "provider/model", never just "model"</h2>
<p>The same model reached through two providers was one name with a hidden coin-flip behind it. <code>gpt-5.6-terra</code> could mean your Codex subscription or your OpenAI API key, and Winter picked one for you. It is now two distinct models: <code>codex-oauth/gpt-5.6-terra</code> and <code>openai/gpt-5.6-terra</code>. The same holds everywhere: <code>anthropic/claude-sonnet-5</code> versus <code>console/claude-sonnet-5</code>, <code>deepseek/deepseek-reasoner</code> versus <code>openrouter/deepseek-reasoner</code>.</p>
<ul>
  <li><strong>The picker is grouped by provider.</strong> Under each provider you see that provider's models by their usual names (Terra, Sol, Fable…). Pick the provider you mean; Winter never chooses one.</li>
  <li><strong>Badges and status lines show the model name.</strong> The provider is shown as a secondary label or tooltip, not glued into every title.</li>
  <li><strong>Your existing settings and sessions migrate once, on first launch.</strong> A stored bare model becomes the tag for the provider you had configured (<code>codex-oauth</code> stays Codex, an <code>openai-compatible</code> endpoint becomes <code>openai/…</code> with its base URL kept under <code>providers.openai.baseUrl</code>). Claude models follow your Console login when one exists. A backup is written to <code>settings.json.bak-pre-ws20</code>.</li>
  <li><strong>The assistant conversation and background jobs</strong> (dreaming, cleaning, research) run on provider-qualified pins that default to your configured provider. They can be changed under <code>pins</code> in settings; they are never hard-coded to a provider.</li>
  <li><strong>Anthropic Console is its own provider.</strong> The <code>runtimes.official.auth</code> setting is gone: an <code>anthropic/…</code> model uses your API key, a <code>console/…</code> model uses the Console profile from <code>winter login --anthropic-console</code>.</li>
  <li><strong>The CLI:</strong> <code>winter model</code> lists models grouped by provider and accepts the full tag; <code>winter model codex-oauth/gpt-5.6-terra</code>.</li>
</ul>
<h2>Reasoning effort on OpenAI models</h2>
<p>The catalog now carries the measured effort vocabulary for <code>gpt-5.6</code>, <code>gpt-5.6-sol</code>, <code>gpt-5.6-terra</code> and <code>gpt-5.6-luna</code> on both the OpenAI API and Codex: low, medium, high, xhigh and max. The "declares no reasoning effort vocabulary" refusal that 0.113.1 worked around is gone.</p>
<h2>Under the hood</h2>
<ul>
  <li>Agent SDK 0.0.13 (catalog: <code>console</code> provider, Console twins of every Claude row, the effort vocabularies) and router 0.0.8 (a request always names its provider; a bare model id and a provider that disagrees with the tag are both refused with a typed reason).</li>
  <li>The Mac app writes the advisor model through the daemon (<code>settings.setAdvisorModel</code>) instead of editing <code>settings.json</code> directly.</li>
  <li><strong>iPhone users: update the iOS app before relying on on-device chat.</strong> This release changes the protocol's model fields to tags. An iOS build on the previous kit stores the daemon's default model verbatim and sends it to the Codex API, which rejects it. The fix ships in the next iOS build (kit <code>v-tags-kit1</code>); Mac-mediated sessions are unaffected.</li>
  <li>A default model outside Codex and OpenAI (for example <code>anthropic/claude-sonnet-5</code>) is accepted, but the daemon's own background features that run on its internal provider (titles, review, dreaming, cleaning, research) stay off until the default names Codex or OpenAI. One log line says so.</li>
</ul>
"""
}
