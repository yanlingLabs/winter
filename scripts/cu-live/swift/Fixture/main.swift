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

// `--banner <json>`: the run's countdown / running notice (Banner.swift). No log, no role.
if let index = CommandLine.arguments.firstIndex(of: "--banner") {
    guard index + 1 < CommandLine.arguments.count, let model = BannerModel.parse(CommandLine.arguments[index + 1]) else {
        fail("--banner takes one JSON object {kind: countdown|running, seconds, watchPid}", code: 64)
    }
    MainActor.assumeIsolated { runBanner(model) }
}

// `--done <json>`: not a fixture at all — the runner's end-of-run completion window (Done.swift). No log, no role.
if let index = CommandLine.arguments.firstIndex(of: "--done") {
    guard index + 1 < CommandLine.arguments.count, let model = DoneModel.parse(CommandLine.arguments[index + 1]) else {
        fail("--done takes one JSON object {status, passed, failed, skipped, durationMs, finishedAt, path}", code: 64)
    }
    MainActor.assumeIsolated { runDoneWindow(model) }
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
// No text substitution: the scenarios check that typed text arrives EXACTLY, and the user's own smart quotes,
// dashes or replacements (honoured by the web view's fields) would rewrite it. The argument domain outranks the
// user's global setting and is never written to disk.
var arguments = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
for key in ["NSAutomaticQuoteSubstitutionEnabled", "NSAutomaticDashSubstitutionEnabled", "NSAutomaticTextReplacementEnabled",
            "NSAutomaticSpellingCorrectionEnabled", "NSAutomaticCapitalizationEnabled", "NSAutomaticPeriodSubstitutionEnabled",
            "WebAutomaticQuoteSubstitutionEnabled", "WebAutomaticDashSubstitutionEnabled", "WebAutomaticTextReplacementEnabled",
            "WebAutomaticSpellingCorrectionEnabled", "WebContinuousSpellCheckingEnabled"] {
    arguments[key] = false
}
UserDefaults.standard.setVolatileDomain(arguments, forName: UserDefaults.argumentDomain)

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
