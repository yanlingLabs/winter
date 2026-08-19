import Foundation

// NormaOfficeHelper entry point. Office Stage A Task 2 stood up a supervised, NOT-launchd process
// (the app spawns this directly — see `OfficeHelperSupervisor`) whose listeners came up with no
// LibreOfficeKit loaded. Task 3: LOK now boots for real, HERE, before the socket ever binds — see
// "Boot sequencing" below.
//
// No AppKit, no dock presence — a plain Foundation run loop, same shape as `NormaHelper`'s own
// `main.swift` (`RunLoop.current.run()` after standing up its listener).

let args = OfficeWireArgs.parse(Array(CommandLine.arguments.dropFirst()))

/// Reports a fatal startup error and terminates. **Always `_exit`, never `exit`/`return`** — not
/// only after a LOK call succeeds: the moment this process attempts `lok_init_2` (below, inside
/// `LOKBridge.init`), `libmergedlo.dylib` has been `dlopen`'d and its C++ statics have run,
/// regardless of whether `lok_init_2` itself went on to succeed or fail — the plan's own global
/// constraint ("helper teardown is `_exit(0)`, never running LibreOffice static destructors")
/// applies from that point forward on every exit path, including a failure one. Using `_exit`
/// UNCONDITIONALLY here (even for the arg-parsing checks below, which run BEFORE any LOK call) is
/// strictly safe either way — `_exit` is a strict subset of `exit`'s behavior minus the cleanup
/// this process never needs — so one rule for the whole file is simpler than two.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("[NormaOfficeHelper] error: " + message + "\n").utf8))
    _exit(1)
}

guard let socketPath = args["socket-path"], !socketPath.isEmpty else {
    fail("missing required --socket-path")
}
guard let statePath = args["state-path"], !statePath.isEmpty else {
    fail("missing required --state-path")
}
guard let token = args["token"], !token.isEmpty else {
    fail("missing required --token")
}
// Default 120s per the brief; overridable so an integration test can observe idle-exit without a
// two-minute wait. Production callers (`OfficeHelperSupervisor`) never pass this flag.
var idleExitSeconds = 120.0
if let raw = args["idle-exit-seconds"], let parsed = Double(raw), parsed > 0 {
    idleExitSeconds = parsed
}

let statePathURL = URL(fileURLWithPath: statePath, isDirectory: true)

// MARK: - Resolve the LibreOffice install root (carry: dlopen path resolves RELATIVE to this
// process's own bundle position — no absolute paths hardcoded here).
//
// Production: this binary is embedded at `<app>/Contents/MacOS/NormaOfficeHelper`
// (`OfficeHelperSupervisor.Configuration.production()`'s own doc comment), so
// `Contents/Resources/LibreOffice` — the T2-adjudicated embed root (NOT Frameworks/LibreOffice) —
// is two directories up from the running executable's own real location, computed at runtime, not
// hardcoded.
//
// `--lok-root` (DEBUG only): points directly at a root containing `Frameworks/`+`Resources/` as
// siblings — the vendor tree's `product-set/` shares this EXACT shape, so live tests can iterate
// against it without a full app build. Never compiled into a Release binary.
func resolveInstallRoot() -> URL {
    #if DEBUG
    if let override = args["lok-root"], !override.isEmpty {
        return URL(fileURLWithPath: override, isDirectory: true)
    }
    #endif
    let executableURL = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    // Contents/MacOS/NormaOfficeHelper -> Contents/Resources/LibreOffice
    return executableURL.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Resources/LibreOffice", isDirectory: true)
}

// MARK: - Boot sequencing
//
// LOK boots BEFORE the socket binds: "the socket file appearing" is what `OfficeHelperSupervisor`
// polls for, so folding boot time into that wait absorbs it inside the existing handshake budget
// automatically, with no protocol change — `helloOk.lokVersion` can only ever report the real
// BuildId (carry T3-c) if LOK is already loaded by the time the FIRST `hello` answers, and a
// helper that bound its socket before LOK finished booting could accept a connection and then
// stall mid-handshake instead of failing fast.
let installRoot = resolveInstallRoot()
let documentBridge: OfficeDocumentBridge
do {
    documentBridge = try LOKBridge(installRoot: installRoot, statePath: statePathURL)
} catch {
    fail("LOK boot failed against installRoot \(installRoot.path): \(error)")
}

let server = OfficeHelperServer(
    socketPath: socketPath, statePath: statePath, expectedToken: token,
    idleExitSeconds: idleExitSeconds, documentBridge: documentBridge)

do {
    try server.start()
} catch {
    fail("\(error)")
}

RunLoop.current.run()
