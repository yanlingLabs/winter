import AppKit
import Foundation

/// panel-cef Task 6a: who starts CEF, when, and who is allowed to stop it from starting.
///
/// **CEF starts LAZILY — on the first web tab that asks for a browser — not at launch.** That is a
/// deliberate, named deviation from the shape Task 1 measured (`CefInitialize` inside
/// `applicationWillFinishLaunching`), taken for three reasons:
///
///   1. **The unit-test host is `Norma.app` itself.** `NormaAppTests` sets
///      `TEST_HOST=…/Norma.app/Contents/MacOS/Norma`, so eager initialisation would stand
///      Chromium's whole process tree up inside a 1274-test, lifecycle-sensitive suite with
///      harness-wide teardown machinery — for every run. `isRunningUnitTests` below is the
///      structural guard; laziness alone would leave it to luck that no test ever hosts a web tab.
///   2. **Norma is a menu-bar app** (`LSUIElement`). Most launches never open a panel at all, and
///      `CefInitialize` alone brings up the GPU and network-service processes.
///   3. **It argues AGAINST Task 1's one un-root-caused failure**, rather than into it. That report
///      saw a first navigation never commit (~1 in 23 runs, every structural cause excluded by
///      control) and its surviving hypothesis was startup STARVATION: `CefInitialize` ran before
///      the host run loop was spinning, so the `performSelector:onThread:` posts that
///      `OnScheduleMessagePumpWork` depends on could not be serviced during precisely the interval
///      in which CEF was standing up its first browser. Its own `LATE_INIT` experiment was
///      inconclusive because the deferral did not actually push past the run-loop start. Here the
///      run loop is unambiguously running: a panel tab exists, so SwiftUI has been drawing for a
///      while. If the empty-first-load hazard is real, this is the shape that avoids it.
///
/// The cost of the deviation is honest: initialising CEF from inside a live run loop is itself
/// untested by Task 1. It is measured by this task instead.
enum NormaCEFRuntime {
    enum State: Equatable {
        case notStarted
        case ready
        /// Why the panel is showing a message instead of a page.
        case failed(String)
    }

    private(set) static var state: State = .notStarted

    /// panel-cef Task 6b: is it worth offering the panel's **Try again** button?
    ///
    /// `.failed` was STICKY for the whole process lifetime — `ensureInitialized` returns early on
    /// it and nothing ever cleared it — so a single transient startup failure disabled the browser
    /// until the app was relaunched. The failures that actually occur are exactly the transient
    /// kind: Chromium takes an exclusive lock on `root_cache_path`, so `CefInitialize` fails with
    /// **exit code 24** whenever a second copy of the app is running, and a `kill -9` leaves a stale
    /// `SingletonLock` behind. Both are cured by closing the other copy and trying again.
    ///
    /// Two failures are NOT retryable and must not offer a button that can only fail again:
    ///  - **after `CefShutdown`** — terminal for the process by CEF's own design, and
    ///    `NormaCEFInitialize` refuses outright;
    ///  - **under XCTest** — the structural guard that keeps Chromium out of the suite; a retry door
    ///    that could re-enter it would defeat the guard's whole purpose.
    /// A missing helper bundle is retryable in principle but never in practice (it is a property of
    /// the build); it is left retryable rather than special-cased, since one extra failed attempt
    /// costs nothing and the alternative is a list of strings to keep in step.
    @MainActor
    static var isRetryable: Bool {
        guard case .failed = state else { return false }
        return !didShutdown && !AppDelegate.isRunningUnitTests
    }

    /// Clear a `.failed` state so the next `ensureInitialized()` genuinely tries again. A no-op in
    /// every other state — in particular it can never un-ready a running CEF or resurrect one that
    /// has been shut down (`isRetryable` gates the caller, and `NormaCEFInitialize` refuses after
    /// shutdown regardless, so this cannot be misused into a crash inside CEF).
    @MainActor
    static func clearFailure() {
        guard isRetryable else { return }
        state = .notStarted
    }

    /// Bring CEF up if it is not up already. Main thread only. Returns `true` when a browser may
    /// be created. NEVER traps and never exits — every failure lands in `.failed` and the panel
    /// renders that string.
    @MainActor
    @discardableResult
    static func ensureInitialized() -> Bool {
        switch state {
        case .ready: return true
        case .failed: return false
        case .notStarted: break
        }

        // The structural half of the test-host guard (see this type's doc comment). Same mechanism
        // `AppDelegate` already uses to keep `CliInstaller`'s first-launch modal out of the suite.
        if AppDelegate.isRunningUnitTests {
            state = .failed("CEF is not started under XCTest")
            return false
        }

        guard let subprocessPath = helperExecutablePath() else {
            state = .failed("the CEF helper bundle is missing from this build")
            return false
        }

        let cachePath = rootCachePath()
        try? FileManager.default.createDirectory(
            at: URL(fileURLWithPath: cachePath), withIntermediateDirectories: true)

        // Real `argv`, so every Chromium command-line switch works exactly as it does for any
        // other Chromium app — `--remote-debugging-port`, `--disable-gpu`,
        // `--use-angle=swiftshader`, `--enable-logging=stderr --v=1`. That is deliberately the
        // whole harness: no Norma-side env-var switch plumbing to ship, gate, or get wrong.
        let ok = NormaCEFInitialize(
            CommandLine.argc, CommandLine.unsafeArgv, cachePath, subprocessPath)

        if ok {
            state = .ready
        } else {
            state = .failed(String(cString: NormaCEFLastError()))
        }
        return ok
    }

    /// Whether `CefInitialize` has succeeded in this process.
    ///
    /// A thin mirror of the bridge's C entry point, and the reason it exists is structural, not
    /// stylistic: a BRIDGING HEADER IS NOT A MODULE INTERFACE. `Support/NormaBridge.h` exposes
    /// `NormaCEF.h` to the app target's own Swift, but `@testable import Norma` does not re-export
    /// it, so the test bundle cannot name `NormaCEFIsInitialized` at all (`NormaApplicationTests`
    /// hit the same wall for the `NormaApplication` type and resolved it by class name). These
    /// three members are that door, and they are ordinary API rather than test-only hooks.
    static var isInitialized: Bool { NormaCEFIsInitialized() }

    /// Whether `CefShutdown` has actually run. Terminal: CEF cannot be initialised again
    /// afterwards. Never true for the never-initialised no-op below — see `NormaCEF.h`.
    static var didShutdown: Bool { NormaCEFDidShutdown() }

    /// The answer `CefLifeSpanHandler::DoClose` gives — see `NormaCEF.h` for why it must be `true`
    /// and what happens to the user's window when it is not. Exposed here for the same reason as
    /// the two above: a bridging header is not a module interface, so the test bundle cannot name
    /// the C function directly.
    static var doCloseIsHandledByHost: Bool { NormaCEFDoCloseIsHandledByHost() }

    /// The answer `CefLifeSpanHandler::OnBeforePopup` gives — `true` is "cancel", and it must stay
    /// `true` even though popups now open as panel tabs: the tab is the popup's DESTINATION, the
    /// cancel is what stops CEF creating a top-level window of its own that nothing could close
    /// (`DoClose` tells CEF the host completes every close). Exposed here for the same reason as the
    /// three above: a bridging header is not a module interface, so the test bundle cannot name the
    /// C function directly.
    static var popupsAreCancelled: Bool { NormaCEFPopupsAreCancelledSoCEFNeverCreatesAWindow() }

    /// Whether the browser client actually INSTALLS its `CefRequestHandler` (⌘-click, middle-click)
    /// and `CefContextMenuHandler` (the link/image menu). Unlike the four above this is not a
    /// constant: it constructs a client and calls the real getters through `CefClient`, because the
    /// question is whether two one-line overrides still EXIST — and deleting them leaves every log
    /// literal and every menu label in the binary, so no built-product string scan can tell.
    /// Measured: it left all 18 CEF pins green. See `NormaCEF.h`.
    static var installsClickAndMenuHandlers: Bool { NormaCEFClientInstallsTheClickAndMenuHandlers() }

    /// The tab a browser-client callback wrote to when there was **no view in existence** — the
    /// produced answer to "does a callback find its tab through the reference the client was built
    /// with, or by messaging the view behind CEF's window handle?". The second is the live-gate
    /// zombie crash; see `NormaCEF.h` for what the returned object must carry and why no string
    /// scan can ask this. Exposed here for the same reason as the five above: a bridging header is
    /// not a module interface, so the test bundle cannot name the C function directly.
    static var tabAfterOneClientCallbackWithNoViewAnywhere: NSObject? {
        NormaCEFTabAfterOneClientCallbackWithNoViewAnywhere()
    }

    /// The open-browser record left behind after a close ran against it — the produced answer to
    /// "does closing a browser RELEASE CEF's host view, or only detach it?". Releasing it is what
    /// runs `-[CefBrowserHostView dealloc]`, which is the only route to `OnBeforeClose` once
    /// `DoClose` has answered `true`; a record still holding the view is a browser that never
    /// closes and a renderer that never exits. See `NormaCEF.h` for what the returned object must
    /// carry and why no string scan can ask this. Exposed here for the same reason as the others: a
    /// bridging header is not a module interface, so the test bundle cannot name the C function.
    static func recordAfterACloseHandsTheHostViewBack(_ hostView: NSView) -> NSObject? {
        NormaCEFRecordAfterACloseHandsTheHostViewBack(hostView)
    }

    /// B2 Task 3 — **the CDP door, in Swift terms.** Run one DevTools protocol method against the
    /// browser hosted by `container` and answer through `completion`.
    ///
    /// A wrapper for the same reason as everything above it (a bridging header is not a module
    /// interface, so the test bundle cannot name `NormaCEFExecuteCDP`) and for one more: it is the
    /// SINGLE door, used by `BrowserRuntime.CEFDriver.production` as well as by the test that pins
    /// the always-answers contract. Two doors onto the same C function would let that test pass while
    /// the production forward was deleted.
    ///
    /// `payloadJSON` is normalised to a non-optional here — the C block declares `NSString *` without
    /// nullability, which Swift imports as implicitly-unwrapped, and every caller wants a string it
    /// can hand to `JSONSerialization`.
    ///
    /// **The completion always fires** (`NormaCEF.h` carries the whole contract): synchronously with
    /// `ok == false` for every refusal, including CEF never having started — which is every call made
    /// from the unit-test host.
    static func executeCDP(in container: NSView, method: String, paramsJSON: String?,
                           completion: @escaping (Bool, String) -> Void) {
        NormaCEFExecuteCDP(container, method, paramsJSON) { ok, payload in
            completion(ok, payload ?? "{}")
        }
    }

    /// The transcript of what the pending-CDP registry actually fired, produced with no browser and
    /// no CEF — the answer to "does a reply settle exactly one call, and is a stranded call FAILED
    /// rather than dropped?". See `NormaCEF.h` for why no needle can ask this and what the transcript
    /// means. Exposed here for the same reason as the rest: a bridging header is not a module
    /// interface.
    static var pendingCDPTranscriptWithNoCEFAnywhere: String {
        NormaCEFPendingCDPTranscriptForOneBrowserWithNoCEFAnywhere()
    }

    /// `CefShutdown`, at the point of no return. Safe no-op if CEF was never initialised — and a
    /// no-op that leaves `didShutdown` false, so running it in the unit-test host does not latch
    /// every later test into "CEF is finished" (whole-branch F10). That is what lets
    /// `NormaCEFInitialize`'s own `NSApplicationWillTerminateNotification` subscription be
    /// unconditional, and what lets the unit-test host run the termination path at all.
    static func shutdown() { NormaCEFShutdown() }

    /// `Contents/Frameworks/Norma Helper.app/Contents/MacOS/Norma Helper` — the BASE helper.
    /// Chromium appends its own per-role suffix (" (Renderer)", " (GPU)", …) to this path, so this
    /// one setting reaches all five bundles. `CEFHelperBundlesTests` pins that they are all there.
    private static func helperExecutablePath() -> String? {
        let url = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Frameworks/Norma Helper.app/Contents/MacOS", isDirectory: true)
            .appendingPathComponent("Norma Helper", isDirectory: false)
        return FileManager.default.isExecutableFile(atPath: url.path) ? url.path : nil
    }

    /// Chromium's profile directory. Bundle-id-scoped, so the dev app (`com.norma.app.dev`) and
    /// the distribution app never share one — the same dev/dist split `AppProfile` enforces for
    /// `NORMA_HOME` and the keychain service, and it matters here for a second reason: Chromium
    /// takes an exclusive lock on its profile, so two apps sharing one directory would collide.
    ///
    /// Deliberately NOT under `~/.norma` / `~/.norma-dev`: that tree is the DAEMON's, and browser
    /// cache is app-side state. This is the ordinary macOS location for it.
    ///
    /// **The Debug-only override exists because that exclusive lock is exactly what an unattended
    /// harness run collides with** (editor-plumbing Task 5). `NORMA_EDITOR_HARNESS=1` starts a
    /// SECOND copy of the same Debug bundle while the developer's dev app is very likely already
    /// running and holding this directory — and the collision surfaces as `CefInitialize` failing
    /// with exit code 24, which the harness would report as "CEF did not start" for a reason that
    /// has nothing to do with the editor. The alternative was killing the user's running app, whose
    /// own quit gate refuses a scripted `quit` by design and would leave the stale `SingletonLock`
    /// that is the *other* documented cause of the same exit code.
    ///
    /// It is the same escape hatch, and the same rule, as `NORMA_HOME` on the daemon side: a test
    /// process points at a directory of its own and never touches the user's. `#if DEBUG` and
    /// unset-by-default, so no shipped build has this door at all.
    private static func rootCachePath() -> String {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["NORMA_CEF_CACHE_PATH"],
           !override.isEmpty {
            return override
        }
        #endif
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        let bundleId = Bundle.main.bundleIdentifier ?? "com.norma.app"
        return base.appendingPathComponent(bundleId, isDirectory: true)
            .appendingPathComponent("CEF", isDirectory: true).path
    }
}
