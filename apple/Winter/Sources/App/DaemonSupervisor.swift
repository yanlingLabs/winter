import Darwin
import Foundation
import WinterKit

/// Injected seam (mirrors `PeripheralProvider`'s live-vs-fake dependency pattern) so
/// `DaemonSupervisor`'s tests never launch a real process, stat the real filesystem, or read a
/// real environment variable. Production wiring (Task 6) supplies the live closures:
/// `bundledDaemonPath` resolves `Bundle.main`'s embedded `winter-core` (Release only — see
/// `project.yml`'s "Embed winter-core" script), `socketExists` stats `~/.winter/run/core.sock`,
/// `isDevEnv` checks `WINTER_DEV`, `spawn` launches `winter-core daemon run`.
struct DaemonSupervisorDeps {
    var bundledDaemonPath: () -> String?
    var socketExists: () -> Bool
    var isDevEnv: () -> Bool
    var spawn: (_ path: String) -> DaemonProcess
    var now: () -> Date
}

/// The running daemon child, narrowed to exactly what `DaemonSupervisor` needs — mockable so tests
/// exercise crash/respawn/stop logic without a real `Process`. `onExit`'s `intentional` flag is the
/// entire crash-vs-graceful-stop distinction: `true` means the exit followed OUR OWN
/// `terminateGracefully()`/`forceStop()` call (from `stop()`/`restart()`); `false` means the
/// daemon went away on its own (crash) — respawn-vs-not hinges entirely on this flag, never on
/// exit codes or signals, since the fake test double has neither.
protocol DaemonProcess: AnyObject {
    var isRunning: Bool { get }
    /// SIGTERM-ish; the concrete implementation is responsible for reporting the ensuing exit to
    /// `onExit` with `intentional: true`.
    func terminateGracefully()
    /// Escalation if `terminateGracefully()` doesn't land in time — not called anywhere in this
    /// task (no timeout/scheduler seam yet); reserved for a future graceful-timeout upgrade.
    func forceStop()
    var onExit: ((_ intentional: Bool) -> Void)? { get set }
}

/// Owns the bundled `winter-core` daemon's lifecycle for a SHIPPED app: spawns it once, quietly
/// respawns it on crash (capped, so a boot-looping daemon doesn't spin forever), and kills it
/// intentionally when the app quits — the app itself is NEVER restarted because the daemon
/// crashed. In DEV (`WINTER_DEV` set), when unbundled, or when a socket is already live (a
/// hand-run daemon holds it), `start()` spawns NOTHING: `.connectOnly` is what keeps a developer's
/// manually-launched daemon completely untouched.
@MainActor
final class DaemonSupervisor {
    enum Mode: Equatable { case supervising, connectOnly }
    enum State: Equatable { case idle, running, respawning(attempt: Int), stopped, failed }

    static let maxRapidRespawns = 5
    static let rapidWindowSeconds = 10.0

    /// Decided once, by `start()`; `.connectOnly` until then.
    private(set) var mode: Mode = .connectOnly
    private(set) var state: State = .idle {
        didSet { onStateChange?(state) }
    }

    /// Lifecycle T6: fired on every state transition — the menu bar observes this to flip the
    /// `stateItem` to "engine stopped — Restart" on `.failed` (and back on recovery). `nil` by
    /// default (T2's own tests never wire it, and don't need to).
    var onStateChange: ((State) -> Void)?

    private let deps: DaemonSupervisorDeps
    private var daemonPath: String?
    private var process: DaemonProcess?

    /// What the NEXT exit of `process` means, set right before calling `terminateGracefully()` so
    /// `handleExit` can tell "we asked for this" apart from a same-shaped crash exit racing it.
    private enum PendingAction { case stopping, restarting }
    private var pendingAction: PendingAction?

    /// Timestamps of unintentional exits still inside the rolling `rapidWindowSeconds` window —
    /// pruned on every crash, so a daemon that crashes once, runs fine for an hour, then crashes
    /// again doesn't inherit the earlier crash toward the cap.
    private var recentCrashes: [Date] = []

    init(deps: DaemonSupervisorDeps) {
        self.deps = deps
    }

    /// Dev-decoupling contract (binding, verbatim): a pre-existing live socket ALWAYS wins — even
    /// a bundled binary in a non-dev build must never spawn a second daemon onto an
    /// already-occupied socket. Meant to be called once per launch.
    func start() {
        let bundled = deps.bundledDaemonPath()
        mode = (bundled != nil && !deps.socketExists() && !deps.isDevEnv()) ? .supervising : .connectOnly
        guard mode == .supervising, let path = bundled else {
            return // connectOnly: spawn nothing; state stays .idle (nothing under our management).
        }
        daemonPath = path
        spawnFresh()
    }

    /// Intentional full teardown (app quit). Safe to call with nothing running (already
    /// `.connectOnly`, already stopped, or already `.failed`).
    func stop() {
        guard let process, process.isRunning else {
            // Leave a tripped .failed diagnosis visible rather than clobbering it on quit.
            if state != .failed { state = .stopped }
            return
        }
        pendingAction = .stopping
        process.terminateGracefully()
    }

    /// Intentional restart (v1 caller: manual menu action; later, post-Sparkle-update). Bypasses
    /// the rapid-respawn cap entirely — including recovering from `.failed` — since a deliberate
    /// restart shouldn't inherit crash history from before the intervention. No-op in
    /// `.connectOnly` (there is no daemon this supervisor spawned to restart).
    func restart() {
        guard mode == .supervising else { return }
        guard let process, process.isRunning else {
            spawnFresh()
            return
        }
        pendingAction = .restarting
        process.terminateGracefully()
    }

    private func handleExit(intentional: Bool) {
        guard intentional else {
            respawnAfterCrash()
            return
        }
        switch pendingAction {
        case .restarting:
            pendingAction = nil
            spawnFresh()
        case .stopping, .none:
            pendingAction = nil
            process = nil
            state = .stopped
        }
    }

    /// A crash-triggered respawn — counted against the rapid-respawn cap.
    private func respawnAfterCrash() {
        let t = deps.now()
        recentCrashes.append(t)
        recentCrashes.removeAll { t.timeIntervalSince($0) > Self.rapidWindowSeconds }
        guard recentCrashes.count <= Self.maxRapidRespawns else {
            process = nil
            state = .failed
            return
        }
        performSpawn()
        state = .respawning(attempt: recentCrashes.count)
    }

    /// A fresh, deliberate launch — the very first spawn from `start()`, or a manual `restart()`
    /// (including recovery from `.failed`). Resets the rapid-crash tracker.
    private func spawnFresh() {
        recentCrashes.removeAll()
        performSpawn()
        state = .running
    }

    private func performSpawn() {
        guard let daemonPath else { return }
        let p = deps.spawn(daemonPath)
        process = p
        p.onExit = { [weak self] intentional in
            self?.handleExit(intentional: intentional)
        }
    }
}

// -----------------------------------------------------------------------------------------------
// Production wiring (Task 6) — the real `Process`-backed `DaemonProcess` + the live
// `DaemonSupervisorDeps` that composes it with the real bundle/filesystem/environment reads.
// -----------------------------------------------------------------------------------------------

/// The real `Process`-backed `DaemonProcess`: launches the bundled `winter-core` binary as
/// `winter-core daemon run` (same argv the old launchd plist used — see `LaunchdMigration.swift`).
///
/// CONSTRAINT (T2 review, binding): `Process.terminationHandler` fires on an arbitrary background
/// queue Foundation manages — NOT the main actor. `DaemonSupervisor` is `@MainActor` and its
/// `onExit` closure mutates main-actor state (`handleExit`), so every `onExit` invocation below
/// hops to the main actor first (`Task { @MainActor in ... }`); calling it directly from the
/// termination handler's background thread would be a data race on `DaemonSupervisor`'s state.
///
/// Intentional-vs-crash classification: `terminateGracefully()`/`forceStop()` set `stoppedByUs`
/// BEFORE signaling the process, so whichever exit races in reads back the right flag — a SIGTERM
/// from an external `kill` would otherwise be indistinguishable from our own.
final class RealDaemonProcess: DaemonProcess {
    /// Bound the SIGTERM->SIGKILL escalation (T6 review FIX 2; raised under Winter Phase 8d P8d-6,
    /// PAIRED with `AppDelegate.applicationShouldTerminate` moving the call to `stop()` behind
    /// `.terminateLater` instead of leaving it inside `applicationWillTerminate`). The original 2s
    /// figure was sized to fit entirely INSIDE `applicationWillTerminate`'s own tighter window —
    /// macOS gives that callback ~5s before it force-quits the app. `.terminateLater` escapes that
    /// window (Apple's own sanctioned mechanism for a quit that needs to do real asynchronous work
    /// before finishing), so this can now use the full 5s of grace before escalating to SIGKILL,
    /// giving a daemon mid-flush of a session JSONL a real chance to exit cleanly instead of being
    /// killed at 2s. NEVER raise this alone — see that method's own doc for why the pairing matters.
    static let gracefulExitTimeout: TimeInterval = 5.0
    private static let pollInterval: TimeInterval = 0.05

    private let process: Process
    /// Written ONLY on the main actor (`terminateGracefully`/`forceStop`, both called from the
    /// `@MainActor` supervisor), read ONLY on the main actor (inside the `terminationHandler`'s
    /// `Task { @MainActor }` hop below) — T6 review FIX 1. Same actor read+write, no cross-thread race.
    private var stoppedByUs = false
    var onExit: ((_ intentional: Bool) -> Void)?

    var isRunning: Bool { process.isRunning }

    init(path: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["daemon", "run"]
        process = p
        p.terminationHandler = { [weak self] _ in
            guard let self else { return }
            // T6 review FIX 1: read `stoppedByUs` INSIDE the main-actor hop, not on Foundation's
            // background termination thread — the flag is written on the main actor, so reading it
            // anywhere else is an unsynchronized cross-thread read (ThreadSanitizer would flag it).
            Task { @MainActor in self.onExit?(self.stoppedByUs) }
        }
        do {
            try p.run()
        } catch {
            NSLog("[RealDaemonProcess] failed to launch \(path): \(error)")
            // Never actually started, so the termination handler above will never fire on its own.
            // Report it as an unintentional exit (a "crash") so DaemonSupervisor's respawn/backoff
            // logic still engages instead of believing a dead daemon is `.running` forever. Deferred
            // via Task so `deps.spawn(...)`'s caller (`performSpawn()`) has already assigned `onExit`
            // by the time this runs (both are on the main actor; the Task body only runs after the
            // current synchronous call frame yields).
            Task { @MainActor in self.onExit?(false) }
        }
    }

    /// SIGTERM, then a BOUNDED wait, then SIGKILL if the child is still alive (T6 review FIX 2).
    /// CONTRACT: after this returns, the child is guaranteed dead — it either exited on SIGTERM
    /// (the daemon's normal path) or was SIGKILLed. This closes the "app quit -> daemon quit"
    /// invariant gap: a wedged/hung winter-core that ignores SIGTERM would otherwise survive app
    /// quit. Blocks the calling thread for up to `gracefulExitTimeout` — deliberate, since the sole
    /// caller (`DaemonSupervisor.stop()` from `applicationWillTerminate`) needs the kill to COMPLETE
    /// before the process exits; a healthy daemon exits on SIGTERM in well under the deadline, so
    /// the full wait only ever elapses for an actually-wedged one.
    func terminateGracefully() {
        stoppedByUs = true // set BEFORE signalling so the ensuing exit classifies as intentional
        Self.escalateTermination(
            isRunning: { [process] in process.isRunning },
            sigterm: { [process] in process.terminate() },
            sigkill: { [weak self] in self?.forceStop() },
            timeout: Self.gracefulExitTimeout
        )
    }

    /// SIGKILL. Reachable now — the escalation path above calls it when SIGTERM doesn't land in
    /// time. `stoppedByUs` is (re)set so a SIGKILL-triggered exit still classifies as intentional.
    func forceStop() {
        stoppedByUs = true
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
    }

    /// The bounded SIGTERM->wait->SIGKILL DECISION, factored out with pure seams so it's
    /// unit-testable without a real `Process` (the real signal calls / `Process.isRunning` are the
    /// only un-fakeable parts, exercised live-gate-only). Sends `sigterm`, polls `isRunning` until
    /// it clears or `timeout` elapses (via the `now`/`pause` clock seams), then escalates to
    /// `sigkill` iff still running. No-op (never even SIGTERMs) if the child is already gone.
    static func escalateTermination(
        isRunning: () -> Bool,
        sigterm: () -> Void,
        sigkill: () -> Void,
        timeout: TimeInterval,
        now: () -> Date = { Date() },
        pause: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) {
        guard isRunning() else { return }
        sigterm()
        let deadline = now().addingTimeInterval(timeout)
        while isRunning() && now() < deadline {
            pause(pollInterval)
        }
        if isRunning() { sigkill() }
    }
}

/// Unix-domain-socket LIVENESS probe (whole-branch review). A mere file-presence check
/// (`FileManager.fileExists`) is NOT enough: a daemon that dies leaves a STALE socket FILE on disk
/// (the daemon only unlinks it on a graceful stop, never on crash/SIGKILL/hard-shutdown), and
/// treating that dead file as "reachable" sends `DaemonSupervisor.start()` into `.connectOnly` — so
/// the app never spawns its bundled daemon, connects to a dead socket, and the engine is
/// permanently down with no self-heal (the only stale-socket cleanup, `acquireLock`, runs ONLY when
/// the supervisor actually spawns). A real `connect()` distinguishes live from stale: a listener
/// accepts; a stale file gives ECONNREFUSED (immediately — the dead case, the important one, is
/// fast); a missing file gives ENOENT. Only a successful connect reads as live. Non-blocking +
/// `poll` so a wedged listener can't hang the synchronous `start()`; a brief blocking wait would be
/// fine too (same posture as the 2s SIGKILL wait), but the bounded `poll` is strictly safer.
func unixSocketIsLive(path: String, timeoutMs: Int32 = 500) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }

    // Non-blocking: a stale file returns ECONNREFUSED synchronously; a live listener either
    // connects synchronously or returns EINPROGRESS, which the `poll` below bounds.
    let flags = fcntl(fd, F_GETFL, 0)
    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(path.utf8)
    // `sun_path` is a fixed C array — refuse an over-long path rather than truncate into a
    // different (possibly live) socket. Reserve one byte for the NUL terminator.
    guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: pathBytes) // trailing bytes stay zero → NUL-terminated
    }
    let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)

    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, addrLen) }
    }
    if rc == 0 { return true }                // connected synchronously → live
    if errno != EINPROGRESS { return false }  // ECONNREFUSED / ENOENT / ENOTSOCK → not live (fast)

    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    guard poll(&pfd, 1, timeoutMs) > 0 else { return false } // timeout or poll error → not live
    var soErr: Int32 = 0
    var soLen = socklen_t(MemoryLayout<Int32>.size)
    guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &soErr, &soLen) == 0 else { return false }
    return soErr == 0
}

extension DaemonSupervisorDeps {
    /// Production wiring: the real `Bundle.main`-embedded `winter-core` (Release builds only — the
    /// "Embed winter-core" build script skips Debug/Test, see `project.yml`), the real
    /// `~/.winter/run/core.sock` LIVENESS probe (whole-branch review — a stale socket FILE must read
    /// as not-reachable so the supervisor spawns and `acquireLock` unlinks it), the real `WINTER_DEV`
    /// env read, and a real `RealDaemonProcess` spawn. `AppDelegate.boot()`'s sole production caller.
    static let live = DaemonSupervisorDeps(
        bundledDaemonPath: { Bundle.main.path(forResource: "winter-core", ofType: nil) },
        socketExists: { unixSocketIsLive(path: WinterPaths.socketPath()) },
        isDevEnv: { ProcessInfo.processInfo.environment["WINTER_DEV"] != nil },
        spawn: { path in RealDaemonProcess(path: path) },
        now: { Date() }
    )

    /// Defense in depth for unit tests that call `AppDelegate.boot()` WITHOUT overriding
    /// `daemonSupervisorDeps` (the vast majority — `ScaffoldTests`, `DashboardTests`, etc.):
    /// `bundledDaemonPath` always resolves `nil`, so `DaemonSupervisor.start()` always lands in
    /// `.connectOnly` and spawns nothing, regardless of what the test host's `Bundle.main` happens
    /// to contain — e.g. a Release-configuration test run that DID embed winter-core. Belt-and-
    /// suspenders on top of `AppDelegate.boot()`'s own `Self.isRunningUnitTests` branch below.
    static let neverSupervise = DaemonSupervisorDeps(
        bundledDaemonPath: { nil },
        socketExists: { false },
        isDevEnv: { true },
        spawn: { _ in fatalError("neverSupervise.spawn is unreachable — bundledDaemonPath is always nil") },
        now: { Date() }
    )
}
