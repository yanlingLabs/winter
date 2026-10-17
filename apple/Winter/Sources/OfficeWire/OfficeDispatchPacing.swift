import Foundation

/// How the office helper waits for, and targets, LibreOffice's ASYNCHRONOUS `.uno:` dispatches.
///
/// Pure and LOK-free on purpose: it lives in `OfficeWire/` (compiled into both the helper and the
/// app) so the app's unit tests can drive it with a fake clock, a fake sleep and a fake attempt —
/// `LOKBridge` itself needs a real LibreOffice to run at all.
///
/// **Why a wait has to be measured in time.** `doc_postUnoCommand` appends `SynchronMode=false`
/// (`desktop/source/lib/init.cxx` at the pin), so a posted `.uno:SelectAll`/`.uno:GoToCell`/
/// `.uno:GoToEndOfDoc` is executed later by LibreOffice's OWN main-loop thread, once that thread is
/// scheduled and wins the SolarMutex from the helper's dedicated thread. Retrying N times back to back
/// on the helper's thread measures nothing about that other thread: under CPU load (the 2026-10-13
/// full app-suite run) five immediate retries were over before LibreOffice's thread ran at all.
/// `poll` gives it real time instead — the helper's thread sleeps, holding no SolarMutex, between
/// attempts.
enum OfficeDispatchPacing {
    struct Outcome: Equatable {
        /// `attempt` answered `true` before the budget ran out.
        let satisfied: Bool
        /// How many times `attempt` ran (always at least 1).
        let attempts: Int
        /// Wall-clock time from the first attempt to the last one's answer.
        let elapsedNanos: UInt64
    }

    /// Runs `attempt` once immediately; while it answers `false`, sleeps (starting at
    /// `firstPauseMicros`, doubling up to `maxPauseMicros`, never past the budget) and runs it again,
    /// until it answers `true` or `budgetNanos` has passed since the first call. There is always one
    /// attempt AFTER the last sleep, so the time slept is never wasted.
    static func poll(budgetNanos: UInt64,
                     firstPauseMicros: UInt32 = 1_000,
                     maxPauseMicros: UInt32 = 50_000,
                     now: () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
                     sleep: (UInt32) -> Void = { usleep($0) },
                     attempt: () -> Bool) -> Outcome {
        let started = now()
        var attempts = 0
        var pause = max(firstPauseMicros, 1)
        while true {
            attempts += 1
            if attempt() {
                return Outcome(satisfied: true, attempts: attempts, elapsedNanos: now() &- started)
            }
            let elapsed = now() &- started
            if elapsed >= budgetNanos {
                return Outcome(satisfied: false, attempts: attempts, elapsedNanos: elapsed)
            }
            let remainingMicros = max((budgetNanos - elapsed) / 1_000, 1)
            sleep(UInt32(min(UInt64(pause), remainingMicros)))
            pause = pause > maxPauseMicros / 2 ? maxPauseMicros : pause * 2
        }
    }

    /// The `setView` calls that make `target` the view a following `postUnoCommand` reaches.
    ///
    /// `doc_postUnoCommand` does not dispatch to "the current view": it goes through
    /// `comphelper::dispatchCommand`, which queries `Desktop::getActiveFrame()`
    /// (`comphelper/source/misc/dispatchcommand.cxx`), and the request is bound to that frame's
    /// dispatcher at post time (`SfxDispatchController_Impl::dispatch`, `unoctitm.cxx`). The only
    /// thing in LOK that sets the desktop's active frame is a REAL view switch:
    /// `SfxLokHelper::setView` (`sfx2/source/view/lokhelper.cxx:196-235`) returns early when the
    /// view is already `SfxViewShell::Current()` and only otherwise reaches
    /// `xDesktop->setActiveFrame(xFrame)` ("Make comphelper::dispatchCommand() find the correct
    /// frame"). So while the agent view is already current, `setView(agent)` is a no-op and the
    /// active frame is whatever LibreOffice's main loop last made it — after a document load or a
    /// human's input, the PRIMARY (the person's) view. That is how an agent's `.uno:SelectAll`
    /// selected the person's whole document under load.
    ///
    /// Going through a different view first makes the final `setView(target)` a real switch, which
    /// always sets the active frame. Returns `[target]` alone when there is no other view to go
    /// through (the target IS the primary view).
    static func viewSwitchesToTarget(_ target: Int32, primary: Int32) -> [Int32] {
        target == primary ? [target] : [primary, target]
    }
}
