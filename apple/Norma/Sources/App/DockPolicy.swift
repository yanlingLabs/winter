import AppKit

/// Dock seam: the ONE production door to the real Dock.
///
/// Every activation-policy write in the app — `AppDelegate.showDockIcon()`/`hideDockIcon()` (the
/// `syncDockPresence` promotion machinery) AND `applicationDidFinishLaunching`'s launch-time
/// `.accessory` (routed too, deliberately: one vocabulary for every policy write, so the grep
/// convention below stays absolute) — goes through `apply`, never through a raw
/// `NSApp.setActivationPolicy`.
///
/// Why a seam and not the after-each-case restore alone: `NormaAppTests` is HOSTED IN the real
/// Norma.app, and xcodebuild's parallel testing runs many host clones. Any clone killed or
/// cancelled mid-case — or promoted by late async work after its final case — used to EXIT while
/// promoted, leaving a dead process's stale Dock tile behind (dozens per suite iteration; they
/// vanish on a tap because the process is gone). `HarnessTeardownObserver`'s after-each-case
/// restore structurally cannot cover those windows. This seam can: the observer swaps `apply` for
/// a recorder at bundle load, BEFORE any test runs, so a test host can never REALLY touch the
/// Dock no matter when or how it dies. Tests assert the recorded SEQUENCE of applied policies —
/// every transition, which is stronger than the end-state reads they replaced.
///
/// KNOWN LIMIT, deliberate: the production default below is one line whose realness is unprovable
/// from this suite — asserting it really promotes would require really promoting the host, which
/// is the exact Dock pollution the seam exists to end. It is guarded instead by (a) the tripwire
/// in `HarnessTeardownObserver.testCaseDidFinish` — after every case the REAL
/// `NSApp.activationPolicy()` must still equal the captured launch policy, so any future raw
/// `setActivationPolicy` that bypasses the seam fails the offending case by name — and (b) the
/// grep convention that `NSApp.setActivationPolicy` appears nowhere in `Sources` outside this
/// default.
@MainActor
enum DockPolicy {
    /// The production applier. Reassigned in exactly one place: `HarnessTeardownObserver.init`
    /// (Tests target, bundle load) swaps in its recorder.
    static var apply: @MainActor (NSApplication.ActivationPolicy) -> Void = {
        NSApp.setActivationPolicy($0)
    }
}
