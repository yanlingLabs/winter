import AppKit
import Foundation

// Entry point. `--self-test` is checked BEFORE anything touches NSApplication: it must run headless, with no
// window server connection and nothing on screen.
if CommandLine.arguments.contains("--self-test") {
    exit(runFixtureSelfTest())
}

private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("WinterCUFixture: \(message)\n".utf8))
    exit(code)
}

let environment = ProcessInfo.processInfo.environment
guard let logPath = environment["WINTER_CU_FIXTURE_LOG"], !logPath.isEmpty else {
    fail("WINTER_CU_FIXTURE_LOG (an absolute path for the JSONL log) is required", code: 64)
}
guard let role = environment["WINTER_CU_FIXTURE_ROLE"], role == "main" || role == "user" else {
    fail("WINTER_CU_FIXTURE_ROLE must be main or user", code: 64)
}
let runId = environment["WINTER_CU_FIXTURE_RUN"] ?? ""
guard let log = FixtureLog(path: logPath, role: role) else {
    fail("cannot open the log file \(logPath) for appending", code: 73)
}

// No window-state restoration: every launch is a fresh fixture, never a resurrected one.
UserDefaults.standard.register(defaults: ["NSQuitAlwaysKeepsWindows": false])

MainActor.assumeIsolated {
    let fixture = Fixture(role: role, run: runId, log: log)
    Fixture.shared = fixture
    let application = NSApplication.shared
    let delegate = AppDelegate(fixture: fixture)
    application.delegate = delegate
    // A regular app (Dock icon, menu bar), even when run as a bare binary rather than from its bundle.
    application.setActivationPolicy(.regular)
    application.run()
}
