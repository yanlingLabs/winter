import Foundation

// NormaOfficeHelperFixture — test-only spawnable stand-in for NormaOfficeHelper, used by
// OfficeSupervisorTests. NOT part of the shipping app (it lives under Tests/, not Sources/, and
// is only added to the test-facing build list in project.yml — see the "Fixture" target).
//
// This is deliberately NOT a reimplementation of the wire protocol: it links OfficeHelperServer
// (Sources/OfficeHelper/OfficeHelperServer.swift, the SAME file NormaOfficeHelper's real
// main.swift drives) and only swaps in Hooks for the failure modes a supervisor test needs to
// provoke on purpose. A test that exercises this fixture is exercising the real protocol handler,
// not a second copy of it that could silently drift from the real one.
//
// --mode:
//   ok            (default) — behaves exactly like the real helper: hello/ping/open/close all
//                  answer normally. Drives both "handshake success" and "token mismatch ->
//                  refused" (the latter by a test connecting with a deliberately wrong token —
//                  this fixture's own expected token, set via --token, is what a mismatch is
//                  measured against).
//   silent        — accepts connections and decodes every frame (so bookkeeping stays real) but
//                  never WRITES a reply. Drives the supervisor's handshake-timeout -> 3 attempts
//                  -> .helperUnavailable path.
//   dieAfterHello — replies helloOk normally, then calls _exit(0) immediately after. Drives the
//                  supervisor's post-ready death-detection -> .helperDied path.
//   multicastInvalidate — behaves like "ok" for everything, PLUS: after every `tileRequestAccepted`
//                  reply, synthesizes a real invalidation (EMPTY, via
//                  FakeOfficeDocumentBridge.simulateInvalidation) for that request's docId. Task 4's
//                  own test seam for a scenario nothing else can provoke deterministically: whether
//                  real LOK ever fires a LIVE invalidate-tiles callback for a view-only document is
//                  an open, empirically-answered question (see task-4-report.md's debt-1 finding),
//                  so multicast fan-out (OfficeHelperServer's DocEntry.subscribers) is proven here
//                  against a bridge that invalidates on command instead — a `tileRequest` with an
//                  EMPTY keys array (already its own explicitly-tested, legal-if-pointless shape in
//                  OfficeWireCodecTests) is this mode's trigger, chosen over a timer/race or a new,
//                  test-only wire verb.

let args = OfficeWireArgs.parse(Array(CommandLine.arguments.dropFirst()))

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("[NormaOfficeHelperFixture] error: " + message + "\n").utf8))
    exit(1)
}

guard let socketPath = args["socket-path"], !socketPath.isEmpty else { fail("missing required --socket-path") }
guard let statePath = args["state-path"], !statePath.isEmpty else { fail("missing required --state-path") }
guard let token = args["token"], !token.isEmpty else { fail("missing required --token") }
var idleExitSeconds = 120.0
if let raw = args["idle-exit-seconds"], let parsed = Double(raw), parsed > 0 { idleExitSeconds = parsed }

// Task 3: OfficeHelperServer now requires a documentBridge. The fixture never links LOKBridge
// (no bridging header, no LOK C symbols — see project.yml's excludes on this target) — its whole
// point is exercising OfficeHelperServer's CONNECTION-level failure paths (handshake timeout,
// death-after-hello, token mismatch), none of which are document-shaped (OfficeSupervisorTests
// never calls open/close). FakeOfficeDocumentBridge is Task 2's own old bookkeeping-only behavior,
// now given a name. Named here (not inline) so the "multicastInvalidate" mode's hook can capture
// it directly (Task 4).
let bridge = FakeOfficeDocumentBridge()

let mode = args["mode"] ?? "ok"
var hooks = OfficeHelperServer.Hooks()
switch mode {
case "ok":
    break
case "silent":
    hooks.suppressReplies = true
case "dieAfterHello":
    hooks.afterHelloOkWritten = { _exit(0) }
case "multicastInvalidate":
    hooks.afterTileRequestAccepted = { docId in bridge.simulateInvalidation(docId: docId) }
default:
    fail("unknown --mode \(mode) (expected ok | silent | dieAfterHello | multicastInvalidate)")
}

let server = OfficeHelperServer(
    socketPath: socketPath, statePath: statePath, expectedToken: token,
    idleExitSeconds: idleExitSeconds, hooks: hooks, documentBridge: bridge)

do {
    try server.start()
} catch {
    fail("\(error)")
}

RunLoop.current.run()
