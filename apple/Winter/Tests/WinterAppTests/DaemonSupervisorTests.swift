import XCTest
@testable import Winter

/// Lifecycle Task 2: `DaemonSupervisor` — the dev-decoupling contract (`.connectOnly` spawns
/// NOTHING; a pre-existing live socket always short-circuits) and crash-respawn-with-backoff.
/// `FakeDaemonProcess` below stands in for a real `Process` so these never launch anything real —
/// `simulateExit` is the only way an exit reaches the supervisor.
@MainActor
final class DaemonSupervisorTests: XCTestCase {
    // MARK: - Step 1: connectOnly (dev / socket-live / unbundled) — never a second daemon

    func testStartIsConnectOnlyWhenSocketAlreadyLive() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { "/x/winter-core" }, socketExists: { true }, isDevEnv: { false },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .connectOnly)
        XCTAssertEqual(spawned, 0) // never a second daemon
    }

    func testStartIsConnectOnlyInDevEnv() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { "/x" }, socketExists: { false }, isDevEnv: { true },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .connectOnly)
        XCTAssertEqual(spawned, 0)
    }

    func testStartIsConnectOnlyWhenUnbundled() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(
            bundledDaemonPath: { nil }, socketExists: { false }, isDevEnv: { false },
            spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .connectOnly)
        XCTAssertEqual(spawned, 0)
    }

    // MARK: - Step 2: supervising spawns exactly once

    func testSupervisingSpawnsOnce() {
        var spawned = 0
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/winter-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; return FakeDaemonProcess() }, now: { Date() }))
        s.start()
        XCTAssertEqual(s.mode, .supervising)
        XCTAssertEqual(spawned, 1)
        XCTAssertEqual(s.state, .running)
    }

    // MARK: - Step 3: crash respawns, intentional stop does not

    func testCrashRespawnsButIntentionalStopDoesNot() {
        var spawned = 0; var procs: [FakeDaemonProcess] = []
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/winter-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; let p = FakeDaemonProcess(); procs.append(p); return p }, now: { Date() }))
        s.start()
        procs.last!.simulateExit(intentional: false) // crash
        XCTAssertEqual(spawned, 2) // respawned
        XCTAssertEqual(s.state, .respawning(attempt: 1)) // pins the payload: 1st in-window crash
        s.stop() // intentional
        procs.last!.simulateExit(intentional: true)
        XCTAssertEqual(spawned, 2) // NOT respawned
        XCTAssertEqual(s.state, .stopped)
    }

    // MARK: - Step 4: respawn backoff cap trips .failed

    func testRapidRespawnCapTripsFailed() {
        // 6 crashes within the window → state .failed, spawn stops at the cap+1.
        var spawned = 0; var procs: [FakeDaemonProcess] = []
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/winter-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; let p = FakeDaemonProcess(); procs.append(p); return p }, now: { Date() }))
        s.start()
        for _ in 0..<6 {
            procs.last!.simulateExit(intentional: false)
        }
        XCTAssertEqual(spawned, DaemonSupervisor.maxRapidRespawns + 1)
        XCTAssertEqual(s.state, .failed)
    }

    // MARK: - T2-review regression guards (both green against the shipped logic — guards, not red→green)

    /// `restart()` is the ONLY way back from `.failed`, and it deliberately bypasses the cap AND
    /// clears crash history — a future "DRY" refactor that routed it through the crash-counting
    /// path would silently strand the daemon in `.failed` forever. The second crash burst proves
    /// `recentCrashes` was actually cleared (5 fresh crashes ≤ cap), not merely that one spawn
    /// happened.
    func testRestartRecoversFromFailedAndResetsCrashHistory() {
        var spawned = 0; var procs: [FakeDaemonProcess] = []
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/winter-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; let p = FakeDaemonProcess(); procs.append(p); return p }, now: { Date() }))
        s.start()
        for _ in 0..<6 { // trip the cap (mirrors testRapidRespawnCapTripsFailed)
            procs.last!.simulateExit(intentional: false)
        }
        XCTAssertEqual(s.state, .failed)
        s.restart()
        XCTAssertEqual(spawned, DaemonSupervisor.maxRapidRespawns + 2) // == 7: recovery spawn happened
        XCTAssertEqual(s.state, .running)
        for _ in 0..<5 { // a full cap's worth of NEW crashes must not trip .failed post-restart
            procs.last!.simulateExit(intentional: false)
        }
        XCTAssertNotEqual(s.state, .failed)
    }

    // MARK: - T6 review FIX 2: bounded SIGTERM->SIGKILL escalation (the "app quit -> daemon quit" gap)

    /// A wedged daemon that ignores SIGTERM (never stops running) MUST be SIGKILLed once the
    /// bounded grace deadline elapses — otherwise it survives app quit and the "app quit -> daemon
    /// quit" invariant breaks. The `now`/`pause` clock seams let this assert the escalation decision
    /// without sleeping the real 2s or touching a real `Process` (the real signal calls are
    /// live-gate-only — see the report). `pause` advances the fake clock instead of blocking.
    func testEscalateTerminationSIGKILLsAProcessThatIgnoresSIGTERM() {
        var sigterms = 0; var sigkills = 0
        var clock = Date()
        RealDaemonProcess.escalateTermination(
            isRunning: { true }, // never exits — models a hung/wedged daemon
            sigterm: { sigterms += 1 },
            sigkill: { sigkills += 1 },
            timeout: 2.0,
            now: { clock },
            pause: { clock = clock.addingTimeInterval($0) }
        )
        XCTAssertEqual(sigterms, 1, "SIGTERM must be sent exactly once, first")
        XCTAssertEqual(sigkills, 1, "a daemon still alive past the deadline must be SIGKILLed")
    }

    /// The common path: a daemon that DOES exit on SIGTERM (before the deadline) must NEVER be
    /// SIGKILLed — escalation is the wedged-daemon fallback, not the normal teardown.
    func testEscalateTerminationDoesNotSIGKILLAProcessThatExitsOnSIGTERM() {
        var sigterms = 0; var sigkills = 0
        var polls = 0
        var clock = Date()
        RealDaemonProcess.escalateTermination(
            isRunning: { polls += 1; return polls < 3 }, // exits on the 3rd poll, well before the deadline
            sigterm: { sigterms += 1 },
            sigkill: { sigkills += 1 },
            timeout: 2.0,
            now: { clock },
            pause: { clock = clock.addingTimeInterval($0) }
        )
        XCTAssertEqual(sigterms, 1)
        XCTAssertEqual(sigkills, 0, "a daemon that exits on SIGTERM must never be SIGKILLed")
    }

    /// An already-dead child (e.g. it crashed the instant before teardown) must not even be
    /// SIGTERMed, let alone SIGKILLed.
    func testEscalateTerminationIsANoOpWhenAlreadyDead() {
        var sigterms = 0; var sigkills = 0
        RealDaemonProcess.escalateTermination(
            isRunning: { false },
            sigterm: { sigterms += 1 },
            sigkill: { sigkills += 1 },
            timeout: 2.0
        )
        XCTAssertEqual(sigterms, 0)
        XCTAssertEqual(sigkills, 0)
    }

    /// Spec behavior: an occasional crash hours apart doesn't accumulate toward the cap — crashes
    /// older than `rapidWindowSeconds` are pruned before counting. `deps.now` exists precisely so
    /// this is testable; a mutable clock separates crash 1 from the burst by > the window, so the
    /// burst of 5 alone must stay under the cap (guards the prune predicate against a `>`→`>=` or
    /// wrong-reference regression that same-instant tests can't see).
    func testCrashOutsideRapidWindowDoesNotCountTowardCap() {
        var spawned = 0; var procs: [FakeDaemonProcess] = []
        var clock = Date()
        let s = DaemonSupervisor(deps: .init(bundledDaemonPath: { "/x/winter-core" }, socketExists: { false },
            isDevEnv: { false }, spawn: { _ in spawned += 1; let p = FakeDaemonProcess(); procs.append(p); return p }, now: { clock }))
        s.start()
        procs.last!.simulateExit(intentional: false) // crash 1, at t0
        clock = clock.addingTimeInterval(DaemonSupervisor.rapidWindowSeconds + 1) // t0+11s: crash 1 now outside the window
        for _ in 0..<5 { // exactly the cap — only trips .failed if the stale crash was wrongly counted
            procs.last!.simulateExit(intentional: false)
        }
        XCTAssertNotEqual(s.state, .failed)
        XCTAssertEqual(spawned, 7) // initial + all 6 crashes respawned
        XCTAssertEqual(s.state, .respawning(attempt: 5)) // the in-window count excludes crash 1
    }
}

/// `DaemonProcess` test double: a child process that never actually runs. `simulateExit` is the
/// ONLY way its `onExit` fires — nothing here spawns real work or races real time.
final class FakeDaemonProcess: DaemonProcess {
    private(set) var isRunning = true
    var onExit: ((_ intentional: Bool) -> Void)?
    private(set) var terminateGracefullyCallCount = 0
    private(set) var forceStopCallCount = 0

    func terminateGracefully() {
        terminateGracefullyCallCount += 1
    }

    func forceStop() {
        forceStopCallCount += 1
        isRunning = false
    }

    /// Test-only trigger standing in for the real process's actual exit — `intentional` mirrors
    /// exactly what a real termination-handler wrapper would report (true only when the exit
    /// followed OUR OWN `terminateGracefully()`/`forceStop()` call).
    func simulateExit(intentional: Bool) {
        isRunning = false
        onExit?(intentional)
    }
}
