import AppKit
import Foundation
import os

/// What Winter knows about itself when its main thread stalls. Gathered ON the main thread every time it answers a
/// ping (a stalled main thread cannot be asked), so a report carries the last picture from before the stall.
struct HangContext: Equatable, Sendable {
    /// Distinct sessions a feed is attached to.
    var attachedSessions = 0
    /// Any feed's reducer says a turn is running (what drives the shimmers and the working animation).
    var anyTurnLive = false
    /// Events waiting to be folded, summed over feeds.
    var reducerBacklog = 0
    /// How long the oldest event on any client's stream had waited, in seconds.
    var oldestEventAge: TimeInterval = 0
    /// Which kind of window is frontmost: shell, detached, pill, or other.
    var frontmostWindow = "none"

    @MainActor
    static func gather(frontmostWindow: () -> String) -> HangContext {
        let feeds = FeedRegistry.shared.snapshot
        return HangContext(attachedSessions: Set(feeds.compactMap(\.sessionId)).count,
                           anyTurnLive: feeds.contains(where: \.turnLive),
                           reducerBacklog: feeds.reduce(0) { $0 + $1.backlog },
                           oldestEventAge: feeds.map(\.oldestEventAge).max() ?? 0,
                           frontmostWindow: frontmostWindow())
    }
}

/// A background watchdog for a stalled main thread (Debug and Release alike). Every second (with leeway, so the timer
/// coalesces with others) it asks the main queue to answer a ping; when one has gone unanswered for 2 s it writes ONE
/// `.fault` line under `com.winter.app` — the stall's length and `HangContext` — and one line when the main thread
/// answers again. Next time a hang needs no sampling to be explained.
///
/// Nothing here runs on the main thread except the answering block, which reads the context and takes a lock.
final class HangWatchdog: @unchecked Sendable {
    static let pingInterval: TimeInterval = 1
    static let stallThreshold: TimeInterval = 2
    /// A main thread that is not blocked but livelocked — cycling through work so that every ping is answered a
    /// beat late — never trips the stall line. An answer slower than this is "late"…
    static let lateThreshold: TimeInterval = 0.15
    /// …and this many late answers in a row (about three seconds of it) is one sluggishness notice.
    static let sluggishAfter = 3

    private let lock = NSLock()
    private let now: @Sendable () -> TimeInterval
    private let gather: @MainActor () -> HangContext
    private let report: @Sendable (String, Bool) -> Void // (line, isFault)
    private let ping: @Sendable (@escaping @Sendable () -> Void) -> Void

    private var pingOutstanding = false
    private var pingSentAt: TimeInterval = 0
    private var context = HangContext()
    private var reported = false
    private var lateAnswers = 0
    private var sluggishReported = false
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "com.winter.app.hang-watchdog", qos: .utility)
    private static let logger = Logger(subsystem: "com.winter.app", category: "hang")

    /// - Parameters:
    ///   - ping: how the watchdog gets the main thread to answer; the main queue, unless a test says otherwise.
    ///   - report: where a line goes; the unified log, unless a test says otherwise.
    init(now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         gather: @escaping @MainActor () -> HangContext,
         ping: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void = { block in DispatchQueue.main.async(execute: block) },
         report: @escaping @Sendable (String, Bool) -> Void = { line, isFault in
             if isFault { HangWatchdog.logger.fault("\(line, privacy: .public)") }
             else { HangWatchdog.logger.notice("\(line, privacy: .public)") }
         }) {
        self.now = now
        self.gather = gather
        self.ping = ping
        self.report = report
    }

    func start() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + Self.pingInterval, repeating: Self.pingInterval, leeway: .milliseconds(250))
        source.setEventHandler { [weak self] in self?.tick() }
        timer = source
        source.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    /// One beat, on the watchdog's own thread: send a ping if none is out; if one has been out too long, report.
    func tick() {
        let t = now()
        var line: String?
        lock.lock()
        if !pingOutstanding {
            pingOutstanding = true
            pingSentAt = t
            lock.unlock()
            ping { [weak self] in
                // Runs on the main thread — this is the proof of life.
                MainActor.assumeIsolated { self?.answered() }
            }
            return
        }
        let stalled = t - pingSentAt
        if stalled >= Self.stallThreshold, !reported {
            reported = true
            line = Self.describe(stalled: stalled, context: context)
        }
        lock.unlock()
        if let line { report(line, true) }
    }

    /// The main thread answered (called on it).
    @MainActor
    func answered() {
        let fresh = gather()
        let t = now()
        lock.lock()
        let wasReported = reported
        let latency = t - pingSentAt
        pingOutstanding = false
        reported = false
        context = fresh
        var sluggish: String?
        if latency > Self.lateThreshold {
            lateAnswers += 1
            if lateAnswers >= Self.sluggishAfter, !sluggishReported {
                sluggishReported = true
                sluggish = "main thread sluggish: the last \(lateAnswers) answers were late (latest \(Self.seconds(latency)) s); "
                    + Self.describe(context: fresh)
            }
        } else {
            lateAnswers = 0
            sluggishReported = false
        }
        lock.unlock()
        if wasReported {
            report("main thread answering again after \(Self.seconds(latency)) s; " + Self.describe(context: fresh), false)
        }
        if let sluggish { report(sluggish, false) }
    }

    /// The last context the main thread gave (tests).
    var lastContext: HangContext { lock.lock(); defer { lock.unlock() }; return context }

    static func describe(stalled: TimeInterval, context: HangContext) -> String {
        "main thread stalled \(seconds(stalled)) s; " + describe(context: context)
    }

    private static func describe(context c: HangContext) -> String {
        "attachedSessions=\(c.attachedSessions) anyTurnLive=\(c.anyTurnLive) reducerBacklog=\(c.reducerBacklog) "
            + "oldestEventAge=\(seconds(c.oldestEventAge)) s frontmostWindow=\(c.frontmostWindow)"
    }

    private static func seconds(_ value: TimeInterval) -> String { String(format: "%.1f", value) }
}
