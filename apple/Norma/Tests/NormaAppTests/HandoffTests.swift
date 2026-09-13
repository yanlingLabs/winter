import XCTest
@testable import Norma

/// Records every deps closure invocation, IN ORDER, plus which of them (if any) should throw —
/// `HandoffTests`' one shared fake, standing in for `HandoffDeps.live`'s real
/// `/Applications`-writing, `SMAppService`-(un)registering, daemon-stopping,
/// `NSWorkspace`-launching, `NSApp`-terminating side effects, none of which may ever run from a
/// test process (this repo's hard rule: never launch any app, never touch a real login
/// item/helper registration, never touch the user's Applications folder).
@MainActor
private final class HandoffRecorder {
    private(set) var calls: [String] = []
    var copyBundleError: Error?
    var verifySignatureError: Error?
    var launchError: Error?

    func record(_ name: String) { calls.append(name) }
}

@MainActor
final class HandoffTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("HandoffTests-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        super.tearDown()
    }

    /// A fake "Winter.app"-shaped bundle directory: `Contents/Info.plist` carrying
    /// `CFBundleVersion`. Mirrors `HandoffDeps.live`'s own `Contents/Info.plist` read shape.
    private func makeFakeBundle(named name: String, version: String) -> URL {
        let bundle = tempDir.appendingPathComponent(name, isDirectory: true)
        let contents = bundle.appendingPathComponent("Contents", isDirectory: true)
        try! FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let plist: [String: Any] = ["CFBundleVersion": version, "CFBundleIdentifier": "com.winter.app"]
        let data = try! PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try! data.write(to: contents.appendingPathComponent("Info.plist"))
        return bundle
    }

    /// Reads `CFBundleVersion` from a real `Contents/Info.plist` — the same shape
    /// `HandoffDeps.live`'s own (private) `installedVersion` reads, reimplemented here so tests
    /// exercise a REAL filesystem read/parse rather than a hand-fed string, without needing
    /// `.live`'s private helpers exposed.
    private func realInstalledVersion(_ bundle: URL) -> String? {
        let plistURL = bundle.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return plist["CFBundleVersion"] as? String
    }

    /// P9c fix wave, m3: `cliLinkURL`/`normaAppBundlePath` default to paths INSIDE `tempDir` that
    /// don't exist by default (a symlink-less "absent" fixture) — never the real `/usr/local/bin`.
    /// `cliLinkTarget`/`removeCliLink` stay wired to the REAL `FileManager` calls (mirroring
    /// `installedVersion`'s own `realInstalledVersion` posture above): a test that wants the
    /// removal path to actually fire plants a real symlink/file at `cliLinkURL` and asserts on the
    /// real filesystem afterward, rather than faking the decision.
    private func makeDeps(
        recorder: HandoffRecorder,
        embeddedWinterURL: URL?,
        applicationsDir: URL,
        disabled: Bool = false,
        notificationsAuthorized: Bool = true,
        cliLinkURL: URL? = nil,
        normaAppBundlePath: String? = nil
    ) -> HandoffDeps {
        HandoffDeps(
            embeddedWinterURL: embeddedWinterURL,
            applicationsDir: applicationsDir,
            installedVersion: { [weak self] url in self?.realInstalledVersion(url) },
            copyBundle: { src, dest in
                recorder.record("copyBundle")
                if let e = recorder.copyBundleError { throw e }
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.copyItem(at: src, to: dest)
            },
            verifySignature: { _ in
                recorder.record("verifySignature")
                if let e = recorder.verifySignatureError { throw e }
            },
            unregisterLoginItem: { recorder.record("unregisterLoginItem") },
            unregisterHelper: { recorder.record("unregisterHelper") },
            stopDaemon: { recorder.record("stopDaemon") },
            notificationsAuthorized: { notificationsAuthorized },
            postNotificationNotice: { recorder.record("postNotificationNotice") },
            showNoticeAlert: { recorder.record("showNoticeAlert") },
            launch: { _ in
                recorder.record("launch")
                if let e = recorder.launchError { throw e }
            },
            armHandoffQuit: { recorder.record("armHandoffQuit") },
            terminateSelf: { recorder.record("terminateSelf") },
            cliLinkURL: cliLinkURL ?? tempDir.appendingPathComponent("usr-local-bin-norma"),
            cliLinkTarget: { url in try? FileManager.default.destinationOfSymbolicLink(atPath: url.path) },
            removeCliLink: { url in try FileManager.default.removeItem(at: url) },
            normaAppBundlePath: normaAppBundlePath ?? tempDir.appendingPathComponent("Applications/Norma.app").path,
            disabled: disabled
        )
    }

    // MARK: - noEmbeddedWinter

    func testNoEmbeddedWinterURLIsInertAndTouchesNothing() {
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: nil, applicationsDir: tempDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        XCTAssertEqual(outcome, .noEmbeddedWinter)
        XCTAssertEqual(recorder.calls, [])
    }

    func testDisabledIsInertEvenWithAnEmbeddedWinterURL() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: tempDir, disabled: true)

        let outcome = performHandoffIfNeeded(deps: deps)

        XCTAssertEqual(outcome, .noEmbeddedWinter)
        XCTAssertEqual(recorder.calls, [])
    }

    // MARK: - fresh install

    func testFreshInstallCopiesVerifiesThenTearsDownInOrderAndReportsInstalled() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        let dest = appsDir.appendingPathComponent("Winter.app", isDirectory: true)
        XCTAssertEqual(outcome, .installed(dest))
        XCTAssertEqual(recorder.calls, [
            "copyBundle", "verifySignature", "unregisterLoginItem", "unregisterHelper", "stopDaemon",
            "postNotificationNotice", "launch", "armHandoffQuit", "terminateSelf",
        ])
        XCTAssertEqual(realInstalledVersion(dest), "0.111.0", "the real copy must actually land the embedded bundle's content at dest")
    }

    // MARK: - P9c fix wave, Critical C1 (ruling P9c-18): the handoff's own true-quit axis

    /// **The claim the C1 fix exists to prove**: the true-quit axis is armed BEFORE the actual
    /// quit call, through the `HandoffDeps` seam alone — never touching `NSApp` or a real
    /// `AppDelegate.handoffQuitting` (that field is `private`; this test doesn't need it, because
    /// `armHandoffQuit` and `terminateSelf` are independent closures on the SAME deps struct
    /// `AppDelegate.boot()` wires in production). A closure that combined "set the flag" and
    /// "call NSApp.terminate" into one step would make this ordering untestable without a live
    /// AppDelegate/NSApp — exactly why `armHandoffQuit` is its own seam (see its own doc).
    func testArmHandoffQuitFiresBeforeTerminateSelf() throws {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        _ = performHandoffIfNeeded(deps: deps)

        let armedIndex = try XCTUnwrap(recorder.calls.firstIndex(of: "armHandoffQuit"))
        let terminatedIndex = try XCTUnwrap(recorder.calls.firstIndex(of: "terminateSelf"))
        XCTAssertLessThan(armedIndex, terminatedIndex, "the axis must be armed strictly before the quit call fires")
    }

    // MARK: - already current

    func testDestAlreadyAtOrAboveEmbeddedVersionSkipsCopyButStillTearsDownAndLaunches() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        _ = makeFakeBundle(named: "Applications/Winter.app", version: "0.111.0")
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        let dest = appsDir.appendingPathComponent("Winter.app", isDirectory: true)
        XCTAssertEqual(outcome, .alreadyCurrent(dest))
        XCTAssertEqual(recorder.calls, [
            "unregisterLoginItem", "unregisterHelper", "stopDaemon", "postNotificationNotice", "launch",
            "armHandoffQuit", "terminateSelf",
        ], "an already-current dest must still tear down, notify, launch, and quit — never re-copy")
    }

    func testDestStrictlyNewerThanEmbeddedIsAlsoAlreadyCurrent() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        _ = makeFakeBundle(named: "Applications/Winter.app", version: "0.112.0")
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        XCTAssertEqual(outcome, .alreadyCurrent(appsDir.appendingPathComponent("Winter.app", isDirectory: true)))
        XCTAssertFalse(recorder.calls.contains("copyBundle"))
    }

    func testDestOlderThanEmbeddedIsTreatedAsAFreshInstallNotAlreadyCurrent() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        _ = makeFakeBundle(named: "Applications/Winter.app", version: "0.110.0")
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        let dest = appsDir.appendingPathComponent("Winter.app", isDirectory: true)
        XCTAssertEqual(outcome, .installed(dest))
        XCTAssertEqual(recorder.calls.first, "copyBundle", "an older installed copy must be overwritten, not treated as already current")
        XCTAssertEqual(realInstalledVersion(dest), "0.111.0")
    }

    func testDestWithNoReadableVersionIsTreatedAsAFreshInstall() {
        // A dest directory exists but has no Info.plist at all (corrupt/partial leftover) —
        // installedVersion(dest) reads nil, which must never satisfy the "already current" branch.
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        let destStub = appsDir.appendingPathComponent("Winter.app", isDirectory: true)
        try! FileManager.default.createDirectory(at: destStub, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        XCTAssertEqual(outcome, .installed(appsDir.appendingPathComponent("Winter.app", isDirectory: true)))
        XCTAssertTrue(recorder.calls.contains("copyBundle"))
    }

    // MARK: - failures leave Norma running

    func testCopyBundleFailureReportsFailedAndNeverTearsDown() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        recorder.copyBundleError = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "disk full"])
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        guard case .failed(let message) = outcome else { return XCTFail("expected .failed, got \(outcome)") }
        XCTAssertTrue(message.contains("disk full"))
        XCTAssertEqual(recorder.calls, ["copyBundle"], "a copy failure must leave Norma fully running — no unregister/stop/launch")
    }

    func testVerifySignatureFailureReportsFailedAndNeverTearsDown() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        recorder.verifySignatureError = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "codesign failed"])
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        guard case .failed(let message) = outcome else { return XCTFail("expected .failed, got \(outcome)") }
        XCTAssertTrue(message.contains("codesign failed"))
        XCTAssertEqual(recorder.calls, ["copyBundle", "verifySignature"])
    }

    func testLaunchFailureReportsFailedButTeardownAlreadyRan() {
        // launch() runs AFTER unregister/stop in the sequence — a launch failure at that point
        // cannot un-ring those bells; this pins the ACTUAL ordering contract rather than assuming
        // a fully-atomic teardown.
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        recorder.launchError = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "could not launch"])
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)

        let outcome = performHandoffIfNeeded(deps: deps)

        guard case .failed(let message) = outcome else { return XCTFail("expected .failed, got \(outcome)") }
        XCTAssertTrue(message.contains("could not launch"))
        XCTAssertEqual(recorder.calls, [
            "copyBundle", "verifySignature", "unregisterLoginItem", "unregisterHelper", "stopDaemon", "postNotificationNotice", "launch",
        ])
        XCTAssertFalse(recorder.calls.contains("terminateSelf"), "must never quit Norma after a failed launch")
        XCTAssertFalse(recorder.calls.contains("armHandoffQuit"), "must never arm the true-quit axis after a failed launch either")
    }

    // MARK: - stale-staging cleanup sweeps every pid's leftover, not just this process's own (review r0, Minor m3)

    func testLiveCopyBundleRemovesEveryStaleStagingEntryNotJustCurrentPid() throws {
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        // Two planted leftovers under DIFFERENT (fake, definitely-not-our) pids — simulating two
        // earlier, crashed handoff attempts under earlier Norma processes.
        let staleOne = appsDir.appendingPathComponent(".Winter.app.staging-99999", isDirectory: true)
        let staleTwo = appsDir.appendingPathComponent(".Winter.app.staging-1", isDirectory: true)
        try FileManager.default.createDirectory(at: staleOne, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: staleTwo, withIntermediateDirectories: true)
        // A sibling that merely starts with the same prefix-looking text but isn't a staging dir
        // at all must be left alone — the sweep is a real Winter.app install, not a wildcard wipe
        // of the whole Applications dir.
        let unrelated = appsDir.appendingPathComponent("SomeOtherApp.app", isDirectory: true)
        try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)

        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let dest = appsDir.appendingPathComponent("Winter.app", isDirectory: true)

        try HandoffDeps.liveCopyBundle(embedded, dest)

        XCTAssertFalse(FileManager.default.fileExists(atPath: staleOne.path), "a stale staging dir under a DIFFERENT pid must be swept")
        XCTAssertFalse(FileManager.default.fileExists(atPath: staleTwo.path), "every stale staging dir must be swept, not just one")
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path), "an unrelated sibling must never be touched")
        XCTAssertEqual(realInstalledVersion(dest), "0.111.0", "the real copy must still land the embedded bundle's content at dest")
        // No leftover staging dir for THIS run either — swapped into dest and cleaned up.
        let remainingEntries = try FileManager.default.contentsOfDirectory(atPath: appsDir.path)
        XCTAssertFalse(remainingEntries.contains { $0.hasPrefix(".Winter.app.staging-") }, "this run's own staging dir must not survive either")
    }

    // MARK: - P9c fix wave, Minor m3: retire the legacy CLI symlink ONLY when it's ours

    func testCliLinkTargetIsInsideNormaAppPureDecision() {
        XCTAssertTrue(cliLinkTargetIsInsideNormaApp("/Applications/Norma.app/Contents/Resources/norma-core", bundlePath: "/Applications/Norma.app"))
        XCTAssertFalse(cliLinkTargetIsInsideNormaApp("/Users/x/mytools/norma", bundlePath: "/Applications/Norma.app"))
        XCTAssertFalse(cliLinkTargetIsInsideNormaApp("/Applications/Norma.app-evil/norma", bundlePath: "/Applications/Norma.app"), "a mere string-prefix match on the bundle name (no path separator) must not count as inside it")
    }

    /// A planted symlink into a fake Norma.app bundle must be removed — the ordinary case (the
    /// running Norma is exactly what installed it).
    func testRetireLegacyCliLinkRemovesASymlinkIntoTheNormaAppBundle() throws {
        let fakeBundle = tempDir.appendingPathComponent("Applications/Norma.app", isDirectory: true)
        let fakeCore = fakeBundle.appendingPathComponent("Contents/Resources/norma-core")
        try FileManager.default.createDirectory(at: fakeCore.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: fakeCore)
        let cliLink = tempDir.appendingPathComponent("usr-local-bin-norma")
        try FileManager.default.createSymbolicLink(at: cliLink, withDestinationURL: fakeCore)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cliLink.path), "setup: the symlink must resolve")

        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir,
                             cliLinkURL: cliLink, normaAppBundlePath: fakeBundle.path)

        _ = performHandoffIfNeeded(deps: deps)

        XCTAssertFalse(FileManager.default.fileExists(atPath: cliLink.path) || (try? FileManager.default.destinationOfSymbolicLink(atPath: cliLink.path)) != nil,
                       "a symlink pointing inside the Norma.app being replaced must be retired")
    }

    /// A regular file at the CLI-link path — never a symlink at all — must never be touched: we
    /// never created a plain file there, so it can only be user data.
    func testRetireLegacyCliLinkLeavesARegularFileUntouched() throws {
        let cliLink = tempDir.appendingPathComponent("usr-local-bin-norma")
        try Data("#!/bin/sh\necho not ours\n".utf8).write(to: cliLink)

        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir, cliLinkURL: cliLink)

        _ = performHandoffIfNeeded(deps: deps)

        XCTAssertTrue(FileManager.default.fileExists(atPath: cliLink.path), "a regular (non-symlink) file must never be removed")
    }

    /// A symlink that resolves OUTSIDE the Norma.app bundle (a user's own `norma -> ~/mytools/norma`)
    /// must be left alone — it is user data we did not create.
    func testRetireLegacyCliLinkLeavesAForeignSymlinkUntouched() throws {
        let foreignTarget = tempDir.appendingPathComponent("mytools/norma")
        try FileManager.default.createDirectory(at: foreignTarget.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: foreignTarget)
        let cliLink = tempDir.appendingPathComponent("usr-local-bin-norma")
        try FileManager.default.createSymbolicLink(at: cliLink, withDestinationURL: foreignTarget)

        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir,
                             cliLinkURL: cliLink, normaAppBundlePath: tempDir.appendingPathComponent("Applications/Norma.app").path)

        _ = performHandoffIfNeeded(deps: deps)

        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: cliLink.path), foreignTarget.path,
                       "a foreign symlink must survive untouched")
    }

    /// Nothing at all at the CLI-link path (the common case — most machines never installed the
    /// `norma` command) must be a silent no-op, never a crash.
    func testRetireLegacyCliLinkNoOpsWhenAbsent() throws {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir)
        // (default `cliLinkURL` from `makeDeps` — a temp path that was never created — is absent by construction)

        let outcome = performHandoffIfNeeded(deps: deps)

        guard case .installed = outcome else { return XCTFail("expected .installed, got \(outcome)") }
    }

    // MARK: - the notice must never silently vanish (review r0, Major M2)

    func testNotificationsAuthorizedPostsViaPosterNeverTheAlert() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir, notificationsAuthorized: true)

        _ = performHandoffIfNeeded(deps: deps)

        XCTAssertTrue(recorder.calls.contains("postNotificationNotice"))
        XCTAssertFalse(recorder.calls.contains("showNoticeAlert"), "authorized notifications must never fall back to the alert")
    }

    func testNotificationsNotAuthorizedShowsTheAlertNeverThePoster() {
        let embedded = makeFakeBundle(named: "embedded/Winter.app", version: "0.111.0")
        let appsDir = tempDir.appendingPathComponent("Applications", isDirectory: true)
        try! FileManager.default.createDirectory(at: appsDir, withIntermediateDirectories: true)
        let recorder = HandoffRecorder()
        let deps = makeDeps(recorder: recorder, embeddedWinterURL: embedded, applicationsDir: appsDir, notificationsAuthorized: false)

        _ = performHandoffIfNeeded(deps: deps)

        XCTAssertTrue(recorder.calls.contains("showNoticeAlert"), "the notice must never silently vanish when notifications aren't authorized")
        XCTAssertFalse(recorder.calls.contains("postNotificationNotice"))
    }

    // MARK: - versionAtLeast (pure)

    func testVersionAtLeastEqualVersions() {
        XCTAssertTrue(versionAtLeast("0.111.0", "0.111.0"))
    }

    func testVersionAtLeastGreater() {
        XCTAssertTrue(versionAtLeast("0.112.0", "0.111.0"))
    }

    func testVersionAtLeastLesser() {
        XCTAssertFalse(versionAtLeast("0.110.0", "0.111.0"))
    }

    func testVersionAtLeastDifferingComponentCounts() {
        XCTAssertTrue(versionAtLeast("1.0", "0.999.9"))
        XCTAssertFalse(versionAtLeast("0.999", "0.999.1"))
    }

    // MARK: - Step 3's notice text (through the deps seam — HandoffNotice, not a live UNUserNotificationCenter call)

    func testHandoffNoticeTextIsExactlyThePlannedCopy() {
        XCTAssertEqual(HandoffNotice.title, "Norma is now Winter")
        XCTAssertEqual(
            HandoffNotice.body,
            "Winter has been installed in Applications and opened; your sessions and settings move over on its first start. You can delete Norma. macOS may ask permission for Winter to read the credentials Norma saved — click Always Allow. If Winter's menu shows it is still finishing setup, quit and reopen Winter once."
        )
    }

    // MARK: - neverHandoff (AppDelegate.boot()'s unit-test posture)

    func testNeverHandoffIsAlwaysInert() {
        XCTAssertEqual(performHandoffIfNeeded(deps: .neverHandoff), .noEmbeddedWinter)
    }
}
