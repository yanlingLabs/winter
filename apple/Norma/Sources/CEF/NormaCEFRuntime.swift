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

    /// Whether `CefShutdown` has run. Terminal: CEF cannot be initialised again afterwards.
    static var didShutdown: Bool { NormaCEFDidShutdown() }

    /// The answer `CefLifeSpanHandler::DoClose` gives — see `NormaCEF.h` for why it must be `true`
    /// and what happens to the user's window when it is not. Exposed here for the same reason as
    /// the two above: a bridging header is not a module interface, so the test bundle cannot name
    /// the C function directly.
    static var doCloseIsHandledByHost: Bool { NormaCEFDoCloseIsHandledByHost() }

    /// `CefShutdown`, at the point of no return. Safe no-op if CEF was never initialised — which is
    /// what lets `NormaCEFInitialize`'s own `NSApplicationWillTerminateNotification` subscription be
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
    private static func rootCachePath() -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        let bundleId = Bundle.main.bundleIdentifier ?? "com.norma.app"
        return base.appendingPathComponent(bundleId, isDirectory: true)
            .appendingPathComponent("CEF", isDirectory: true).path
    }
}
