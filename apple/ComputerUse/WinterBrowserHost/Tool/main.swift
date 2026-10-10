import Darwin
import Foundation
import WinterBrowserHostCore

// winter-browser-host: Chrome's native-messaging host for Winter for Chrome (PROTOCOL.md beside this package). Built two
// ways from this one file: the xcodegen `WinterBrowserHost` tool target (embedded in the Winter Computer Use bundle's
// Contents/MacOS) and the package's own executable (tests and the opt-in e2e).

#if WINTER_CU_TEST_BUILD
// Compiled only into a test build (the compilation condition is passed on that build's command line, never set in
// project.yml): another home, and a fake daemon identity. A dev or release binary contains neither name.
let environment = ProcessInfo.processInfo.environment
let testHooks: HostTestHooks? = HostTestHooks(
    home: environment["WINTER_BROWSER_HOST_HOME"],
    daemonRequirement: environment["WINTER_CU_TEST_DAEMON_REQUIREMENT"]
)
#else
let testHooks: HostTestHooks? = nil
#endif

exit(HostMain.run(arguments: CommandLine.arguments, testHooks: testHooks))
