import CoreGraphics
import Foundation

/// "No walk within 150 ms of the user's own input" (spec §3.5): a synchronous AX walk makes a
/// Chromium/Electron app answer on its main thread, which shows up as input lag while the user types.
/// Reads the HID system state, so events the helper posts to a pid never count as the user's.
enum CUUserInputGuard {
    static let quietMs: Double = 150
    /// Never hold a walk back longer than this in total.
    static let maxDeferMs: Double = 1000

    private static let watched: [CGEventType] = [
        .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved,
        .leftMouseDragged, .rightMouseDragged, .scrollWheel,
    ]

    /// Milliseconds since the user's last hardware input.
    static func msSinceUserInput() -> Double {
        watched.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min().map { $0 * 1000 }
            ?? .infinity
    }

    /// How long to wait before walking, given the time since the user's last input (pure).
    static func deferral(msSinceInput: Double, alreadyWaitedMs: Double) -> Double {
        guard msSinceInput < quietMs, alreadyWaitedMs < maxDeferMs else { return 0 }
        return min(quietMs - msSinceInput, maxDeferMs - alreadyWaitedMs)
    }

    /// Blocks the calling (pid-queue) thread until the user has been idle for 150 ms, at most 1 s.
    static func waitForQuiet() {
        var waited: Double = 0
        while true {
            let d = deferral(msSinceInput: msSinceUserInput(), alreadyWaitedMs: waited)
            if d <= 0 { return }
            usleep(useconds_t(d * 1000))
            waited += d
        }
    }
}
