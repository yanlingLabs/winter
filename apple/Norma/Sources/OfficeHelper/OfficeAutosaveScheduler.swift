import Foundation

// Office Stage B Task 7 — autosave sidecars + crash recovery: "a SIGKILL costs at most a minute."
// The helper's own teardown is `_Exit`/SIGKILL, by design, always — there is no flush-on-quit path
// to lean on, ever (see `main.swift`'s own `fail(_:)`/boot-sequencing comments for why this
// process's exit discipline is that strict). Autosave is the ONLY crash protection Stage B has.

/// **The per-document "autosave while dirty" timer, extracted as its own small, dependency-free
/// unit.** Owned by `OfficeHelperServer` (`routeDocumentEvent`'s own `.modifiedChanged` handling
/// arms/disarms it; a fire calls `OfficeDocumentBridge.saveAsSidecar` then pushes `.autosaved`) —
/// this type itself knows nothing about LOK, the wire protocol, or documents beyond their bare
/// `docId` string.
///
/// **Deliberately depends on nothing else in this repo — not even `Dispatch` in its own PUBLIC
/// surface (`Scheduling` is a plain closure struct).** This file is compiled into THREE separate
/// targets: `NormaOfficeHelper` and `NormaOfficeHelperFixture` (both already sweep all of
/// `Sources/OfficeHelper`), and `NormaAppTests` — via a direct `sources:` entry in project.yml
/// mirroring `HelperSources/SMCController.swift`'s own precedent (a single non-Sources/AppShell
/// file added straight to the test bundle) — so that CADENCE (arm/fire/re-fire/cancel) can be
/// proven with an INJECTED clock: no real LOK, no socket, no subprocess, no wall-clock sleep, the
/// house norm for a 60s timer. `OfficeDocumentBridge`/`OfficeDocumentEvent`/anything LOK-adjacent
/// all live behind the bridging header or in `NormaAppTests`-invisible modules — a dependency on
/// any of them here would make this file impossible to add to `NormaAppTests` at all, and cadence
/// would be provable only live (real LOK, real wall-clock waits) — precisely what this split
/// exists to avoid. See `OfficeHelperServer`'s own wiring for how the real docId/bridge/push
/// machinery is layered back on top of this.
///
/// **This type never deletes a sidecar, ever — arming and firing are its whole job.** The
/// ownership rule that keeps "a SIGKILL costs at most a minute" true even when a save fails to
/// place (`OfficeRuntime.saveAndAwaitOutcome`'s own header has the full account of that race): the
/// HELPER only ever writes sidecars (this type's `markDirty`/fire), the APP is the only thing that
/// ever deletes one, and only once it has PROOF the real path itself now carries the content
/// (`.saveSucceeded`, after `placeAtomically`) or the user explicitly discarded the recovery
/// candidate. `markClean`/`remove` below cancel the TIMER — they must never be mistaken for
/// "clear the file too."
final class OfficeAutosaveScheduler {
    /// How a repeating, cancellable timer actually gets scheduled. Real wall-clock by default; a
    /// test replaces this wholesale with a fake that fires on demand — the seam that makes cadence
    /// tests instant rather than real-60-seconds-long.
    struct Scheduling {
        /// Must call `fire` for the first time `interval` seconds from NOW (never immediately —
        /// the brief's own cadence is "60s while dirty," not "the instant a document goes dirty"),
        /// then every `interval` seconds after that for as long as it keeps running. Returns a
        /// closure that stops it; safe to call more than once.
        ///
        /// **Plain `() -> Void`, not a labeled `(cancel: () -> Void)` tuple** — Swift collapses a
        /// single-element labeled tuple TYPE back to its bare element (the label only survives at
        /// a VALUE site), so writing the label here would silently stop matching a `(cancel: ...)`
        /// literal at the construction site with a confusing "single-element tuple" compiler error;
        /// simpler to never introduce the mismatch than to route around it.
        var scheduleRepeating: (_ interval: TimeInterval, _ fire: @escaping () -> Void) -> () -> Void

        /// Real `DispatchSourceTimer` on a dedicated queue — never the caller's own queue/thread,
        /// so `OfficeHelperServer` (which owns this scheduler) never has to reason about which
        /// thread a fire lands on beyond "some background queue, always the same one."
        static func real(queue: DispatchQueue = DispatchQueue(label: "office-helper.autosave")) -> Scheduling {
            Scheduling(scheduleRepeating: { interval, fire in
                let timer = DispatchSource.makeTimerSource(queue: queue)
                timer.schedule(deadline: .now() + interval, repeating: interval)
                timer.setEventHandler(handler: fire)
                timer.resume()
                return { timer.cancel() }
            })
        }
    }

    private let interval: TimeInterval
    private let scheduling: Scheduling
    /// **`var`, not `let`, and defaulted to a no-op.** `OfficeHelperServer` (this type's one real
    /// owner) needs the fire callback to call an INSTANCE method on itself, which means the closure
    /// must capture `[weak self]` — legal in Swift only once every one of `OfficeHelperServer`'s own
    /// stored properties already has a value, `autosaveScheduler` (this instance) included. Passing
    /// the real closure through this initializer would need `self` to exist before it does; two
    /// steps (construct here with the default, assign the real closure as a separate statement
    /// right after) is the standard way around that, and is why this is mutable at all — every
    /// OTHER stored property on this type is a `let`.
    var onFire: (String) -> Void

    /// **`armed` is reached from two different threads and needs its own lock — this is NOT the
    /// same hazard `OfficeHelperServer`'s own doc comment discusses (that one is about lock
    /// ORDERING/deadlock across types; this one is about a plain `Dictionary` having no thread
    /// safety of its own).** `markDirty`/`markClean` are called synchronously from
    /// `OfficeHelperServer.routeDocumentEvent`, which a real `.modifiedChanged` reaches from
    /// LOK's OWN dedicated thread (`LOKDedicatedThread`/`handleCallback`'s documented calling
    /// convention) — while `remove` is called from an accepted connection's own thread, at both
    /// the `.close` frame handler and the connection-teardown loop, deliberately outside
    /// `stateQueue`. Two threads mutating one `Dictionary` concurrently is a real data race
    /// (corruption or a crash) in the exact process this whole feature exists to survive a crash
    /// of — so every access below holds `lock`. Same precedent, same stated reason, as
    /// `FakeOfficeDocumentBridge`'s own lock in this file.
    private let lock = NSLock()

    /// docId -> its live timer's own cancel closure. A docId's presence here IS "a timer is
    /// currently armed for it" — no separate boolean to drift from this. **Only ever touched
    /// while holding `lock`** — see `lock`'s own doc comment for why.
    private var armed: [String: () -> Void] = [:]

    /// `interval` — production always 60 (the brief's own number); tests use whatever their fake
    /// `scheduling` finds convenient, since the FAKE never actually waits `interval` seconds
    /// regardless of its value — see `OfficeAutosaveSchedulerTests`.
    init(interval: TimeInterval, scheduling: Scheduling = .real(), onFire: @escaping (String) -> Void = { _ in }) {
        self.interval = interval
        self.scheduling = scheduling
        self.onFire = onFire
    }

    /// A document just became dirty (`.modifiedChanged(true)`) — arm its own repeating timer.
    /// **Idempotent by construction**: a second `markDirty` for an already-armed docId is a no-op,
    /// never a second, orphaned timer silently doubling that document's own fire rate. LOK does not
    /// refire an unchanged boolean in practice, so the ordinary path never exercises this guard —
    /// kept anyway because nothing about this type's own contract should depend on that being true.
    /// **The whole check-then-insert runs under `lock`** — without that, two racing callers could
    /// both observe "not armed" and both schedule, doubling the fire rate for real (not just in
    /// theory) since `markDirty`/`markClean` land on LOK's own thread, never serialized by anything
    /// else upstream of this type.
    func markDirty(docId: String) {
        lock.lock()
        defer { lock.unlock() }
        guard armed[docId] == nil else { return }
        armed[docId] = scheduling.scheduleRepeating(interval) { [weak self] in self?.onFire(docId) }
    }

    /// Dirty just became false — a genuine `.modifiedChanged(false)` (a real save's own `.uno:Save`
    /// follow-up, or LOK's own back-to-saved-state undo tracking). Cancels the timer ONLY. Never
    /// touches any sidecar file already on disk — this type's own header states why: the helper
    /// writes, it never deletes. The cancel closure itself runs AFTER `unlock()` — never call
    /// arbitrary code while holding `lock`, even though today's cancel (`DispatchSourceTimer.cancel`
    /// or a test fake) is known not to call back into this type.
    func markClean(docId: String) {
        lock.lock()
        let cancel = armed.removeValue(forKey: docId)
        lock.unlock()
        cancel?()
    }

    /// The document closed, for any reason (a clean close, a reload, a supersession). Same cancel
    /// as `markClean` — a distinct name purely so a call site reads its own intent; there is no
    /// behavioral difference between the two today. Called from an accepted connection's own
    /// thread — never LOK's — which is exactly why `lock` exists at all.
    func remove(docId: String) {
        lock.lock()
        let cancel = armed.removeValue(forKey: docId)
        lock.unlock()
        cancel?()
    }

    /// Test-only observation door — never read by production code.
    func isArmedForTesting(docId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return armed[docId] != nil
    }
}
