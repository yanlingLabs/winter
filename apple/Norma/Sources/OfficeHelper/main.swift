import Foundation

// Fix round 1, M1 — ignore SIGPIPE process-wide, unconditionally, as the very first thing this
// process does. A write() to a socket whose peer already closed its read side delivers SIGPIPE,
// and that signal's DEFAULT disposition TERMINATES the process before write() ever gets a chance
// to return -1/EPIPE to calling Swift code — a bare Swift process was confirmed to die this way. Up
// to this fix round, this process had ONLY ever survived that by accident: the vendored
// LibreOffice library installs its own SIG_IGN for SIGPIPE as a side effect of `lok_init_2`'s C++
// runtime init (below, inside `LOKBridge.init`) — never something this file arranged, and a future
// vendor version bump could silently remove it. This line makes it this process's OWN, deliberate
// guarantee instead of an accident of a dependency. See `OfficeHelperServer.writeAll`'s own comment
// for the full trace.
signal(SIGPIPE, SIG_IGN)

// NormaOfficeHelper entry point. Office Stage A Task 2 stood up a supervised, NOT-launchd process
// (the app spawns this directly — see `OfficeHelperSupervisor`) whose listeners came up with no
// LibreOfficeKit loaded. Task 3: LOK now boots for real, HERE, before the socket ever binds — see
// "Boot sequencing" below.
//
// No AppKit, no dock presence — a plain Foundation run loop, same shape as `NormaHelper`'s own
// `main.swift` (`RunLoop.current.run()` after standing up its listener).

let rawArguments = Array(CommandLine.arguments.dropFirst())
let args = OfficeWireArgs.parse(rawArguments)

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

// MARK: - Office Stage B Task 1: the seatbelt
//
// Applied HERE — after arg parsing, before ANYTHING else — because everything below this block
// (LOK's `dlopen`+`lok_init_2`, the socket bind) must run INSIDE the sandbox, never before it.
//
// **Mechanism: self-sandboxing (`sandbox_init_with_parameters`, called by this process on itself),
// not an external `sandbox-exec <target>`-style wrapper.** `OfficeHelperSupervisor.attemptOnce`
// spawns this binary directly via `Process()` — no shell, no exec chain in between — so putting the
// sandbox_init call HERE, first, makes "sandboxed" a property of the helper binary itself rather
// than of however it happens to be launched: every existing spawn site (production, every live
// test in `OfficeHelperLiveTests`) is sandboxed with ZERO changes of its own, and any FUTURE spawn
// site would have to go out of its way to bypass it (there is no un-sandboxed code path except the
// explicit DEBUG `--no-sandbox` flag below). Wrapping the spawn instead
// (`packages/core/src/workflows/sandbox.ts`'s own shape: the PARENT builds a profile string and
// execs `/usr/bin/sandbox-exec -p <profile> <target> <args>`) would mean every spawn site has to
// remember to do that — forgettable, and re-adds that profile's own documented #1 risk (a blanket
// `process-exec` deny makes sandbox-exec's OWN execvp of the target fail, so it needs a narrow
// self-exec carve-out this helper does not need at all, since it never execs anything, ever).
//
// realpath(3), never Foundation's `resolvingSymlinksInPath` — verified empirically (a standalone C
// harness, before any of this Swift code existed) that an un-canonicalized `/tmp/...` value makes
// every `(subpath (param "STATE_PATH"))` rule in office-helper.sb match NOTHING, because the kernel
// checks a sandboxed path in its resolved `/private/tmp/...` form and Foundation's own
// `resolvingSymlinksInPath` strips that `/private` prefix back OFF — the wrong direction for this.
// Falls back to the raw path on failure (mirrors `packages/core/src/agent/sandbox.ts`'s own
// `canon()`) — `--state-path` is always created by the caller before this process starts
// (`OfficeHelperSupervisor.attemptOnce` / `OfficeHelperLiveTests.spawnLiveHelper`), so realpath
// succeeding is the expected case, not a race this helper needs to handle specially.
func canonicalPath(_ path: String) -> String {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    guard realpath(path, &buffer) != nil else { return path }
    return String(cString: buffer)
}

/// The same two-dirs-up-from-the-executable computation `resolveInstallRoot()` uses below for
/// `Contents/Resources/LibreOffice`, for the identical reason: this must resolve correctly from
/// BOTH shapes this helper ever runs from — embedded at `<app>/Contents/MacOS/NormaOfficeHelper`
/// (production) and standalone at `BUILT_PRODUCTS_DIR/NormaOfficeHelper`
/// (`OfficeHelperLiveTests.spawnLiveHelper`'s own default `helperURL`, the fast-iteration path most
/// of that file's own tests use). `--sandbox-profile` (DEBUG only, mirrors `--lok-root` exactly)
/// points directly at the checked-in source file for iteration without a full app embed; the
/// "Embed NormaOfficeHelper" postCompileScript (project.yml) places the production copy at
/// `Contents/Resources/office-helper.sb`, alongside `Contents/Resources/LibreOffice`.
func resolveSandboxProfilePath() -> URL {
    #if DEBUG
    if let override = args["sandbox-profile"], !override.isEmpty {
        return URL(fileURLWithPath: override)
    }
    #endif
    let executableURL = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
    return executableURL.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Resources/office-helper.sb", isDirectory: false)
}

/// `true` only for an EXPLICIT `--no-sandbox` flag, and only in DEBUG builds — this branch does not
/// exist in a Release binary at all (the `#if DEBUG` guard strips it at compile time, not merely a
/// runtime check), matching the brief's own instruction verbatim: "a DEBUG-only --no-sandbox escape
/// hatch is allowed to exist but everything must default sandboxed, including all live tests." No
/// production code path, and no test that omits this flag, ever takes this branch — every test in
/// `OfficeHelperLiveTests`/`OfficeSandboxTests` that does not pass `--no-sandbox` runs fully
/// sandboxed, which is the point: "default sandboxed everywhere" is true by construction, not by
/// each call site remembering to opt in.
var sandboxDisabledForDebugHarness = false
#if DEBUG
// `--no-sandbox` is a BARE boolean flag — no value follows it — so `OfficeWireArgs.parse`
// deliberately never adds it to `args` at all (that parser's own doc comment: a bare flag "maps to
// nothing," precisely so it can never silently swallow the NEXT flag's name as its own value).
// Checking `args["no-sandbox"] != nil` would therefore always be false regardless of whether the
// flag was actually passed — caught empirically, by this exact test failing first (the two-sided
// `--no-sandbox` pin reported "denied" even WITH the flag passed): the raw pre-parse token list is
// the only correct way to detect a bare flag's presence.
if rawArguments.contains("--no-sandbox") { sandboxDisabledForDebugHarness = true }
#endif

if !sandboxDisabledForDebugHarness {
    let profileURL = resolveSandboxProfilePath()
    guard let profileText = try? String(contentsOf: profileURL, encoding: .utf8) else {
        fail("sandbox profile not found or unreadable at \(profileURL.path) — refusing to boot "
                + "unsandboxed (the only escape hatch is an explicit DEBUG --no-sandbox)")
    }
    let canonicalStatePath = canonicalPath(statePath)
    var initError: UnsafeMutablePointer<CChar>?
    // NULL-terminated, alternating key/value C-string array — `sandbox_init_with_parameters`'s own
    // contract (OfficeHelperBridge.h's own header). Both strings are bridged from Swift `String`s
    // to `UnsafePointer<CChar>` inside nested `withCString` closures — that bridge is only valid
    // for the duration of the closure it was created in, so the whole array construction AND the
    // init call itself must happen together, inside both closures, not stored and reused after.
    let initRC: Int32 = "STATE_PATH".withCString { keyPtr in
        canonicalStatePath.withCString { valuePtr in
            var params: [UnsafePointer<CChar>?] = [keyPtr, valuePtr, nil]
            return params.withUnsafeMutableBufferPointer { paramsBuf in
                sandbox_init_with_parameters(profileText, 0, paramsBuf.baseAddress, &initError)
            }
        }
    }
    if let initError {
        let message = String(cString: initError)
        sandbox_free_error(initError)
        fail("sandbox_init_with_parameters failed against profile \(profileURL.path): \(message)")
    }
    guard initRC == 0 else {
        fail("sandbox_init_with_parameters returned \(initRC) with no error string "
                + "(profile \(profileURL.path))")
    }
}

// Self-assert: refuse to serve unless genuinely sandboxed — runs in EVERY build config, not only
// Release, because the brief's own bar is "default sandboxed everywhere, including all live tests,"
// and the escape hatch above already short-circuits this check by construction (a harness that
// explicitly asked to be unsandboxed is not held to it). `sandbox_check(getpid(), nil, 0)` —
// `operation` NULL, `type` 0 — is the "is this process sandboxed AT ALL" idiom, verified empirically
// BEFORE being trusted here (a standalone C harness: 0 unsandboxed, 1 under a real `sandbox-exec`
// child) — not assumed from memory, per this whole task's own methodology.
let isSandboxed = sandbox_check(getpid(), nil, 0) != 0
if !sandboxDisabledForDebugHarness && !isSandboxed {
    fail("sandbox_init_with_parameters reported success but sandbox_check still says this process "
            + "is unsandboxed — refusing to serve documents unsandboxed")
}

#if DEBUG
// MARK: - DEBUG-only sandbox probe mode (OfficeSandboxTests)
//
// Applies the sandbox exactly like the real boot above, attempts ONE specific operation the
// profile should allow or deny, prints a single machine-readable RESULT line, and exits — never
// reaching LOK or the socket. Exists because neither the out-of-fence-write nor the
// outbound-connect probe the brief's own step list asks for ("helper attempts an out-of-fence
// write → fails; an outbound connect → fails") has any WIRE verb that could drive them from the
// app side — there is no request that makes the helper write to an arbitrary path or dial out, by
// design. `#if DEBUG` only, the same posture as `--no-sandbox`/`--lok-root` above/below — never
// compiled into a Release binary.
if let probeKind = args["sandbox-probe"] {
    switch probeKind {
    case "write-inside-fence", "write-outside-fence":
        let targetDir: String
        if probeKind == "write-outside-fence" {
            guard let outsideDir = args["probe-outside-dir"], !outsideDir.isEmpty else {
                fail("--sandbox-probe write-outside-fence requires --probe-outside-dir")
            }
            targetDir = outsideDir
        } else {
            targetDir = statePath
        }
        let path = (targetDir as NSString).appendingPathComponent("sandbox-probe-\(probeKind).txt")
        let fd = open(path, O_WRONLY | O_CREAT, 0o644)
        let capturedErrno = errno // read IMMEDIATELY — nothing else runs between open() and this
        if fd >= 0 { close(fd) }
        print("PROBE_RESULT: \(probeKind) \(fd >= 0 ? "ok" : "denied") errno=\(capturedErrno)")
        _exit(0)
    case "connect-outbound":
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            fail("socket() itself failed unexpectedly (not a sandbox denial — AF_INET socket() "
                    + "creation is never fenced, only connect()): \(String(cString: strerror(errno)))")
        }
        var dst = sockaddr_in()
        dst.sin_family = sa_family_t(AF_INET)
        dst.sin_port = in_port_t(80).bigEndian
        dst.sin_addr.s_addr = inet_addr("1.1.1.1") // a well-known public address; this probe must
                                                     // never actually reach it — the whole point is
                                                     // that connect() itself is denied before any
                                                     // packet leaves the machine.
        let rc = withUnsafePointer(to: &dst) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        let capturedErrno = errno // read IMMEDIATELY — before close()
        close(fd)
        print("PROBE_RESULT: connect-outbound \(rc == 0 ? "ok" : "denied") errno=\(capturedErrno)")
        _exit(0)
    default:
        fail("unknown --sandbox-probe kind: \(probeKind)")
    }
}
#endif

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
