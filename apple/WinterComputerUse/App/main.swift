import AppKit
import WinterComputerUseShell

// Winter Computer Use: an LSUIElement agent app (no Dock icon, no menu) launched only through LaunchServices,
// so TCC attributes its Accessibility and Screen Recording to it and not to whoever asked for it.

#if WINTER_CU_TEST_BUILD
// Compiled only into the test helper that `bun run verify:computer-helper` builds (the compilation condition
// is passed on that one xcodebuild command line, never set in project.yml): the fake daemon identity it
// accepts, and a short idle quit. A dev or release binary contains neither name (release.ts checks).
let environment = ProcessInfo.processInfo.environment
let testHooks: HelperTestHooks? = HelperTestHooks(
    daemonRequirement: environment["WINTER_CU_TEST_DAEMON_REQUIREMENT"],
    idleSeconds: environment["WINTER_CU_TEST_IDLE_SECONDS"].flatMap(Double.init)
)
#else
let testHooks: HelperTestHooks? = nil
#endif

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = HelperAppDelegate(testHooks: testHooks)
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
