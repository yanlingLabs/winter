import Foundation

// NormaOfficeHelper entry point. Office Stage A Task 2 — a supervised, NOT-launchd process: the
// app spawns this directly (see `OfficeHelperSupervisor`) and hands it the socket path, a scratch
// state directory, and a per-launch capability token as CLI args, matching `OfficeHelperSupervisor`'s
// documented interface exactly. No AppKit, no dock presence — a plain Foundation run loop, same
// shape as `NormaHelper`'s own `main.swift` (`RunLoop.current.run()` after standing up its
// listener).
//
// LibreOfficeKit is NOT loaded here — that is Task 3's job. This process only proves the
// supervision contract: the listener comes up, `hello`/`ping`/`open`/`close` all answer correctly
// over the socket, and it exits itself after `--idle-exit-seconds` with zero open documents and
// zero connected clients.

let args = OfficeWireArgs.parse(Array(CommandLine.arguments.dropFirst()))

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("[NormaOfficeHelper] error: " + message + "\n").utf8))
    exit(1)
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
// two-minute wait (`OfficeHelperSupervisorSmokeTests` — real-helper integration test — passes a
// small value). Production callers (`OfficeHelperSupervisor`) never pass this flag.
var idleExitSeconds = 120.0
if let raw = args["idle-exit-seconds"], let parsed = Double(raw), parsed > 0 {
    idleExitSeconds = parsed
}

let server = OfficeHelperServer(
    socketPath: socketPath, statePath: statePath, expectedToken: token,
    idleExitSeconds: idleExitSeconds)

do {
    try server.start()
} catch {
    fail("\(error)")
}

RunLoop.current.run()
