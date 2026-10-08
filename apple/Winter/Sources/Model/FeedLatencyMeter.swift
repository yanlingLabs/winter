import Foundation
import WinterProtocol
import os

/// How far behind its daemon a window's feed is, measured where it can be seen: for every event, the daemon's own
/// stamp (`ts`) against the moments it was taken off the client's stream, folded into the reducer, and drawn.
///
///     daemon ts ──wire+decode──▶ yielded ──queue──▶ consumed ──fold──▶ folded ──render──▶ committed
///
/// While events flow it writes ONE `.notice` per feed every 10 s (`com.winter.app`, category `feed-latency`): events
/// seen and per second, the p50 / p95 / max of the whole way (daemon → committed), the p95 of each leg, and the backlog.
/// A lag with no stall in the hang watchdog is either each event costing more main-thread time than arrives
/// (the render leg and the queue leg grow together) or a slow serial hop (the wire or queue leg alone).
@MainActor
final class FeedLatencyMeter {
    /// One reporting window's numbers, in milliseconds.
    struct Report: Equatable {
        var events = 0
        var perSecond = 0.0
        var endToEnd = Spread()
        var wire = Spread()
        var queue = Spread()
        var fold = Spread()
        var render = Spread()
        var backlog = 0
    }

    struct Spread: Equatable {
        var p50 = 0.0, p95 = 0.0, max = 0.0
        init() {}
        init(_ values: [Double]) {
            guard !values.isEmpty else { return }
            let sorted = values.sorted()
            p50 = sorted[(sorted.count - 1) / 2]
            p95 = sorted[Int(Double(sorted.count - 1) * 0.95)]
            max = sorted[sorted.count - 1]
        }
    }

    static let interval: TimeInterval = 10
    private static let logger = Logger(subsystem: "com.winter.app", category: "feed-latency")

    private let label: () -> String
    private let backlog: () -> Int
    private let wall: () -> Double
    private let sink: (String) -> Void
    private let interval: TimeInterval
    /// How the next commit is awaited: Core Animation's post-commit phase, or a test's own.
    private let afterCommit: (@escaping () -> Void) -> Void

    private var wire: [Double] = []
    private var queue: [Double] = []
    private var fold: [Double] = []
    private var render: [Double] = []
    private var endToEnd: [Double] = []
    private var windowStart: Double?
    private var armed = false

    init(label: @escaping () -> String, backlog: @escaping () -> Int,
         interval: TimeInterval = FeedLatencyMeter.interval,
         wall: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 },
         afterCommit: @escaping (@escaping () -> Void) -> Void = FeedLatencyMeter.nextCommit,
         sink: @escaping (String) -> Void = { FeedLatencyMeter.logger.notice("\($0, privacy: .public)") }) {
        self.label = label
        self.backlog = backlog
        self.interval = interval
        self.wall = wall
        self.afterCommit = afterCommit
        self.sink = sink
    }

    /// Runs `block` once the run loop turn that is under way has been drawn: SwiftUI updates the windows before the run
    /// loop sleeps and Core Animation commits at order 2,000,000, so an observer after that sees the finished frame.
    static func nextCommit(_ block: @escaping () -> Void) {
        CommitClock.shared.after(block)
    }

    /// An event was taken off the client's stream after waiting `queueWait` seconds there.
    func noteConsumed(_ event: SessionEvent, queueWait: TimeInterval) {
        guard let ts = event.stampMs, ts > 0 else { return }
        let now = wall()
        let waited = queueWait * 1000
        queue.append(waited)
        wire.append(max(now - waited - ts, 0))
        start(now)
    }

    /// `events` were folded into the session just now. Their whole way is complete at the next commit.
    func noteFolded(_ events: [SessionEvent]) {
        let stamps = events.compactMap(\.stampMs).filter { $0 > 0 }
        guard !stamps.isEmpty else { return }
        let folded = wall()
        for ts in stamps { fold.append(max(folded - ts, 0)) }
        start(folded)
        afterCommit { [weak self] in
            guard let self else { return }
            let committed = self.wall()
            self.render.append(max(committed - folded, 0))
            for ts in stamps { self.endToEnd.append(max(committed - ts, 0)) }
        }
    }

    /// The numbers since the last report (or the start), cleared.
    func takeReport() -> Report {
        let now = wall()
        let seconds = max((now - (windowStart ?? now)) / 1000, 0.001)
        let report = Report(events: endToEnd.count, perSecond: Double(endToEnd.count) / seconds,
                            endToEnd: Spread(endToEnd), wire: Spread(wire), queue: Spread(queue), fold: Spread(fold),
                            render: Spread(render), backlog: backlog())
        wire = []; queue = []; fold = []; render = []; endToEnd = []
        windowStart = nil
        return report
    }

    static func describe(_ r: Report, label: String) -> String {
        func spread(_ s: Spread) -> String { String(format: "p50 %.0f p95 %.0f max %.0f", s.p50, s.p95, s.max) }
        return String(format: "%@: %d events, %.1f/s; lag ms (daemon→drawn) %@; wire p95 %.0f, queue p95 %.0f, fold p95 %.0f, render p95 %.0f; backlog %d",
                      label, r.events, r.perSecond, spread(r.endToEnd), r.wire.p95, r.queue.p95, r.fold.p95, r.render.p95, r.backlog)
    }

    private func start(_ now: Double) {
        if windowStart == nil { windowStart = now }
        guard !armed else { return }
        armed = true
        DispatchQueue.main.asyncAfter(deadline: .now() + interval) { [weak self] in
            MainActor.assumeIsolated { self?.fire() }
        }
    }

    private func fire() {
        armed = false
        guard !endToEnd.isEmpty || !wire.isEmpty else { return }
        let report = takeReport()
        sink(Self.describe(report, label: label()))
    }
}

extension SessionEvent {
    /// The daemon's stamp on this event (ms since the epoch), read off whichever payload it is. By reflection on
    /// purpose: this is a diagnostic, and a hand-written accessor would be one more exhaustive switch every new
    /// variant has to be added to.
    var stampMs: Double? {
        guard let payload = Mirror(reflecting: self).children.first?.value else { return nil }
        for child in Mirror(reflecting: payload).children where child.label == "ts" {
            if let value = child.value as? Int { return Double(value) }
            if let value = child.value as? Double { return value }
        }
        return nil
    }
}

/// Runs blocks once the current run loop turn has been committed to the screen — an observer on the main run loop's
/// "about to sleep" that comes after SwiftUI's update and Core Animation's commit.
@MainActor
final class CommitClock {
    static let shared = CommitClock()

    private var blocks: [() -> Void] = []
    private var observer: CFRunLoopObserver?

    func after(_ block: @escaping () -> Void) {
        blocks.append(block)
        guard observer == nil else { return }
        let new = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue, true, 2_100_000) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.fire() }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), new, .commonModes)
        observer = new
    }

    private func fire() {
        let run = blocks
        blocks.removeAll(keepingCapacity: true)
        run.forEach { $0() }
        if blocks.isEmpty, let observer {
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes)
            self.observer = nil
        }
    }
}
