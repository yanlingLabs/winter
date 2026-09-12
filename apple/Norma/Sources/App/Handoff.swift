import AppKit
import Foundation
import UserNotifications

// -----------------------------------------------------------------------------------------------
// Handoff — Winter Phase 9c, Lane H. The final Norma release (0.2.015) carries a released,
// notarized, stapled Winter.app inside its own bundle (`Contents/Resources/Winter.app`, embedded
// by `scripts/release.ts`'s `--embed-winter` step, never by an xcodegen build phase — a Debug
// build embeds nothing and this whole mechanism is inert by construction). On launch, BEFORE
// touching the daemon, Sparkle, AX permissions, or the socket, this installs Winter into
// `/Applications`, tears down Norma's own OS registrations (login item, helper daemon), stops
// Norma's own daemon, launches Winter, and quits Norma outright.
//
// This file's job ends at "Winter is running and Norma is gone." Winter's own first boot
// migrates the user's `~/.norma` home into `~/.winter` (Migration B — a DIFFERENT lane, on the
// renamed `main` branch, not this frozen pre-rename tree) — never duplicated or anticipated here.
//
// Every real side effect is a closure on `HandoffDeps`, so `performHandoffIfNeeded` — the entire
// decision tree — is unit-testable with fakes that record call ORDER (`HandoffTests.swift`),
// never a live `/Applications` write, a live `SMAppService` (un)registration, a live daemon
// stop, or a live app launch/quit.
// -----------------------------------------------------------------------------------------------

/// The handoff's entire outside world, as closures — see the file header for why. Every field
/// mirrors one concrete real-world action `.live` performs; `HandoffTests` drives the same struct
/// with recording fakes instead.
struct HandoffDeps {
    /// `Bundle.main.resourceURL?.appendingPathComponent("Winter.app")` when that path exists on
    /// disk — `nil` in every build that doesn't embed one (Debug, always; a Release build cut
    /// before the embed step landed, or a plain xctest host). `nil` alone is enough to make the
    /// whole handoff inert — see `performHandoffIfNeeded`'s first guard.
    var embeddedWinterURL: URL?
    /// `/Applications` when writable, else `~/Applications` (created if missing) — `.live`'s own
    /// resolution; a test passes a temp directory instead.
    var applicationsDir: URL
    /// Reads a bundle's `CFBundleVersion` from `Contents/Info.plist` — called on BOTH the
    /// embedded candidate and an existing `applicationsDir/Winter.app`, so the "already current"
    /// comparison and any log line share one code path. `nil` when the bundle or its Info.plist
    /// is missing/unreadable/missing the key.
    var installedVersion: (URL) -> String?
    /// Copies `src` (the embedded candidate) to `dest` (`applicationsDir/Winter.app`). `.live`
    /// copies to a `.Winter.app.staging-<pid>` sibling first, then swaps it over `dest`
    /// atomically (removing a stale staging leftover first) — `performHandoffIfNeeded` calls this
    /// exactly once with the real `(src, dest)` pair and knows nothing about that staging detail.
    var copyBundle: (_ src: URL, _ dest: URL) throws -> Void
    /// `codesign --verify --deep --strict` against the INSTALLED copy at `dest`. Throwing means
    /// "installed but untrustworthy" — `performHandoffIfNeeded` reports `.failed` and leaves
    /// Norma running rather than launching an app that failed its own signature check.
    var verifySignature: (_ dest: URL) throws -> Void
    /// Unregisters Norma's own "launch at login" `SMAppService.mainApp` registration.
    var unregisterLoginItem: () throws -> Void
    /// Unregisters the privileged `com.norma.helper` `SMAppService.daemon` registration.
    var unregisterHelper: () throws -> Void
    /// Gracefully stops Norma's own daemon, if one happens to be running under this process's
    /// supervision. See `AppDelegate.boot()`'s wiring comment for why this is very often a
    /// correct no-op (there is usually nothing left to stop by the time the handoff runs).
    var stopDaemon: () -> Void
    /// Launches the installed Winter.app. `.live` posts the one-time handoff notice (Step 3) and
    /// blocks (bounded) until `NSWorkspace`'s own launch-completion handler fires, so by the time
    /// `performHandoffIfNeeded` calls `terminateSelf` right after, Winter's launch has already
    /// been confirmed (or the bound elapsed) — see `.live`'s own doc for why `terminateSelf`
    /// itself stays a single, unconditional call with no async choreography of its own.
    var launch: (_ dest: URL) throws -> Void
    /// Quits Norma. Called last, after everything above has succeeded.
    var terminateSelf: () -> Void
    /// `NORMA_HANDOFF_DISABLED=1` — an unconditional escape hatch independent of
    /// `embeddedWinterURL`, for any harness that boots the real app end-to-end without wanting
    /// this file's real side effects even when a Winter.app happens to be present.
    var disabled: Bool
}

/// The result of one `performHandoffIfNeeded` call.
enum HandoffOutcome: Equatable {
    /// No embedded Winter.app (Debug build, a pre-embed Release build, or `disabled`) — boot()
    /// continues as plain Norma.
    case noEmbeddedWinter
    /// Winter was freshly copied in, verified, and launched; Norma is terminating.
    case installed(URL)
    /// `applicationsDir/Winter.app` already carries a version at least as new as the embedded
    /// one — Norma still tears down and launches it (a user who re-launched Norma after the
    /// handoff already ran once must land back in Winter, not a stale Norma), but never
    /// re-copies over a possibly-newer installed copy.
    case alreadyCurrent(URL)
    /// The copy or the signature check failed — Norma is left running, untouched.
    case failed(String)
}

/// The whole handoff decision tree. Pure orchestration over `deps` — see each `HandoffDeps` field
/// for what it actually does in production vs. under test.
@MainActor
@discardableResult
func performHandoffIfNeeded(deps: HandoffDeps) -> HandoffOutcome {
    guard !deps.disabled, let src = deps.embeddedWinterURL else {
        return .noEmbeddedWinter
    }
    // `isDirectory: true` pinned explicitly: Winter.app is always a directory bundle, and without
    // this hint `URL`'s trailing-slash representation can differ depending on whether the path
    // happens to exist on disk yet at the moment something reads `.absoluteString` — which would
    // make `HandoffOutcome`'s `Equatable` conformance flicker depending on filesystem timing.
    let dest = deps.applicationsDir.appendingPathComponent("Winter.app", isDirectory: true)

    // Teardown + launch + quit — identical in both the fresh-install and already-current paths;
    // only the final outcome value differs, decided by the caller below.
    func teardownLaunchAndQuit() -> String? {
        do {
            try deps.unregisterLoginItem()
            try deps.unregisterHelper()
            deps.stopDaemon()
            try deps.launch(dest)
        } catch {
            return "\(error)"
        }
        deps.terminateSelf()
        return nil
    }

    if let embeddedVersion = deps.installedVersion(src),
       let installedVersion = deps.installedVersion(dest),
       versionAtLeast(installedVersion, embeddedVersion) {
        if let failure = teardownLaunchAndQuit() { return .failed(failure) }
        return .alreadyCurrent(dest)
    }

    do {
        try deps.copyBundle(src, dest)
        try deps.verifySignature(dest)
    } catch {
        return .failed("\(error)")
    }

    if let failure = teardownLaunchAndQuit() { return .failed(failure) }
    return .installed(dest)
}

/// Component-wise numeric comparison of dotted version strings (e.g. "0.111.0", a plain
/// `CFBundleVersion`). Non-numeric/missing components read as 0; a mismatched depth pads the
/// shorter side with zeros. Never asked to compare across differently-shaped version schemes —
/// both sides here are always Winter's own `CFBundleVersion`.
func versionAtLeast(_ a: String, _ b: String) -> Bool {
    let av = a.split(separator: ".").map { Int($0) ?? 0 }
    let bv = b.split(separator: ".").map { Int($0) ?? 0 }
    for i in 0..<max(av.count, bv.count) {
        let x = i < av.count ? av[i] : 0
        let y = i < bv.count ? bv[i] : 0
        if x != y { return x > y }
    }
    return true
}

/// Step 3's one-time notice, verbatim — kept as named constants (rather than inlined into
/// `.live.launch`'s body) specifically so `HandoffTests` can assert on the exact copy through
/// this same seam without standing up a real `UNUserNotificationCenter`.
enum HandoffNotice {
    static let title = "Norma is now Winter"
    static let body =
        "Winter has been installed in Applications and opened; your sessions and settings move " +
        "over on its first start. You can delete Norma."
}

// -----------------------------------------------------------------------------------------------
// Production wiring.
// -----------------------------------------------------------------------------------------------

extension HandoffDeps {
    /// Belt-and-suspenders companion to `.live` (same posture as `DaemonSupervisorDeps
    /// .neverSupervise`): `embeddedWinterURL: nil` alone already makes `performHandoffIfNeeded`
    /// return `.noEmbeddedWinter` before touching any other field, so every closure below is
    /// provably unreachable — `fatalError` documents that rather than silently no-op-ing a bug.
    /// `AppDelegate.boot()` selects this under `Self.isRunningUnitTests` regardless of what the
    /// test host's `Bundle.main` happens to contain (e.g. a Release-configuration test run that
    /// DID embed a Winter.app).
    static let neverHandoff = HandoffDeps(
        embeddedWinterURL: nil,
        applicationsDir: URL(fileURLWithPath: "/dev/null"),
        installedVersion: { _ in nil },
        copyBundle: { _, _ in fatalError("neverHandoff.copyBundle is unreachable — embeddedWinterURL is always nil") },
        verifySignature: { _ in fatalError("neverHandoff.verifySignature is unreachable — embeddedWinterURL is always nil") },
        unregisterLoginItem: { fatalError("neverHandoff.unregisterLoginItem is unreachable — embeddedWinterURL is always nil") },
        unregisterHelper: { fatalError("neverHandoff.unregisterHelper is unreachable — embeddedWinterURL is always nil") },
        stopDaemon: { fatalError("neverHandoff.stopDaemon is unreachable — embeddedWinterURL is always nil") },
        launch: { _ in fatalError("neverHandoff.launch is unreachable — embeddedWinterURL is always nil") },
        terminateSelf: { fatalError("neverHandoff.terminateSelf is unreachable — embeddedWinterURL is always nil") },
        disabled: true
    )

    /// Real wiring. `stopDaemon` is deliberately left a no-op HERE — `AppDelegate.boot()` is the
    /// one place with an actual `DaemonSupervisor` instance to hand it, and overwrites this one
    /// field right after reading `.live` (same "start from a base, layer in what only the caller
    /// can supply" idiom `boot()` already uses for `UpdaterCoordinatorDeps.live` +
    /// `activeTurns`/`dirtyEditors`).
    @MainActor
    static var live: HandoffDeps {
        HandoffDeps(
            embeddedWinterURL: liveEmbeddedWinterURL(),
            applicationsDir: liveApplicationsDir(),
            installedVersion: liveInstalledVersion,
            copyBundle: liveCopyBundle,
            verifySignature: liveVerifySignature,
            unregisterLoginItem: { try SMLoginItem().disable() },
            unregisterHelper: { HelperClient().unregister() },
            stopDaemon: {},
            launch: liveLaunch,
            terminateSelf: { NSApp.terminate(nil) },
            disabled: ProcessInfo.processInfo.environment["NORMA_HANDOFF_DISABLED"] == "1"
        )
    }

    private static func liveEmbeddedWinterURL() -> URL? {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("Winter.app"),
              FileManager.default.fileExists(atPath: url.path)
        else { return nil }
        return url
    }

    /// `/Applications` when writable (the normal case — Norma itself only ever runs as an
    /// admin-installed app), else `~/Applications` (created if missing) — a machine where
    /// `/Applications` isn't writable by this user gets a per-user install instead of a hard
    /// failure.
    private static func liveApplicationsDir() -> URL {
        let fm = FileManager.default
        let system = URL(fileURLWithPath: "/Applications")
        if fm.isWritableFile(atPath: system.path) { return system }
        let perUser = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
        try? fm.createDirectory(at: perUser, withIntermediateDirectories: true)
        return perUser
    }

    private static func liveInstalledVersion(_ bundle: URL) -> String? {
        let plistURL = bundle.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return plist["CFBundleVersion"] as? String
    }

    /// Copy to a staging sibling, then atomically swap it over `dest` — a crash or kill mid-copy
    /// never leaves a half-written `Winter.app` at the real destination. A stale staging leftover
    /// from a previous, interrupted attempt is removed first.
    private static func liveCopyBundle(_ src: URL, _ dest: URL) throws {
        let fm = FileManager.default
        let staging = dest.deletingLastPathComponent()
            .appendingPathComponent(".Winter.app.staging-\(ProcessInfo.processInfo.processIdentifier)")
        try? fm.removeItem(at: staging)
        try fm.copyItem(at: src, to: staging)
        defer { try? fm.removeItem(at: staging) }
        if fm.fileExists(atPath: dest.path) {
            _ = try fm.replaceItemAt(dest, withItemAt: staging)
        } else {
            try fm.moveItem(at: staging, to: dest)
        }
    }

    private static func liveVerifySignature(_ dest: URL) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        p.arguments = ["--verify", "--deep", "--strict", dest.path]
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw NSError(
                domain: "Handoff", code: Int(p.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: "codesign --verify --deep --strict failed on \(dest.path)"]
            )
        }
    }

    /// Posts the one-time handoff notice (Step 3) THEN triggers the real launch — reusing
    /// `SystemNotificationPoster` (`Sources/Model/NotificationPoster.swift`), the existing
    /// `UNUserNotificationCenter` seam the push-notification track already ships and already
    /// exercises the entitlement/authorization path this needs, rather than standing up a second
    /// one. Posted here (not inside `terminateSelf`) so the async `add(_:)` call has the launch's
    /// own completion wait (bounded, up to 10s) to actually reach the notification center before
    /// `terminateSelf` ends the process right after this returns.
    private static func liveLaunch(_ dest: URL) throws {
        SystemNotificationPoster().post(title: HandoffNotice.title, body: HandoffNotice.body)

        let semaphore = DispatchSemaphore(value: 0)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: dest, configuration: configuration) { _, _ in
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 10)
    }
}
