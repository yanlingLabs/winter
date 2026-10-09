import CoreGraphics
import Foundation

/// The window-server queries the presentation layer needs, behind a seam so tests can count them. Each is scoped to a
/// few windows, never a listing of every window on the system.
protocol WindowServer: Sendable {
    /// Descriptions of exactly these windows (`CGWindowListCreateDescriptionFromArray`; a window that call leaves out is
    /// asked about on its own). Gone windows are missing from the result.
    func describe(_ ids: [CGWindowID]) -> [StackWindow]
    /// The on-screen windows ABOVE `id`, front to back (`.optionOnScreenAboveWindow`): what could cover it.
    func windowsAbove(_ id: CGWindowID) -> [StackWindow]
}

struct SystemWindowServer: WindowServer {
    func describe(_ ids: [CGWindowID]) -> [StackWindow] {
        Self.describe(ids, batch: Self.batchDescription, single: Self.singleDescription)
    }

    /// The batch description, then each window it left out asked about on its own (belt and braces: the batch call
    /// has been seen to describe every window asked, but a missing one would read as gone and hide its cursor).
    static func describe(_ ids: [CGWindowID], batch: ([CGWindowID]) -> [StackWindow],
                         single: (CGWindowID) -> StackWindow?) -> [StackWindow] {
        guard !ids.isEmpty else { return [] }
        var found = batch(ids)
        let missing = Set(ids).subtracting(found.map(\.id))
        for id in ids where missing.contains(id) {
            if let entry = single(id) { found.append(entry) }
        }
        return found
    }

    private static func batchDescription(_ ids: [CGWindowID]) -> [StackWindow] {
        // The array holds raw CGWindowID values, the way CGWindowListCreate returns them.
        var values: [UnsafeRawPointer?] = ids.map { UnsafeRawPointer(bitPattern: UInt($0)) }
        guard let array = CFArrayCreate(nil, &values, values.count, nil),
              let list = CGWindowListCreateDescriptionFromArray(array) as? [[String: Any]] else { return [] }
        return list.compactMap(entry)
    }

    private static func singleDescription(_ id: CGWindowID) -> StackWindow? {
        (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?
            .first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
            .flatMap(entry)
    }

    func windowsAbove(_ id: CGWindowID) -> [StackWindow] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], id) as? [[String: Any]] else { return [] }
        return list.compactMap(Self.entry)
    }

    static func entry(_ info: [String: Any]) -> StackWindow? {
        guard let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
        else { return nil }
        return StackWindow(id: id, pid: pid,
                           layer: (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                           bounds: bounds,
                           alpha: CGFloat((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1),
                           // Absent, not false, for a window that is off screen.
                           isOnScreen: (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
                           ownerName: info[kCGWindowOwnerName as String] as? String)
    }
}

/// Keeps the geometry of the windows the presentation follows, and what lies above them, fresh from a BACKGROUND
/// queue, so the main thread only ever reads a cache.
///
/// - Followed windows (any window asked about in the last `forgetAfter` seconds) are described together, in ONE
///   `describe` call per poll, every `pollInterval`: the cost grows with the windows Winter is working on, never with
///   the number of windows on the system.
/// - What lies above a target (for the cursor's covered check) is fetched only for targets asked about, at most every
///   `aboveTTL`, also off the main thread.
/// - The one main-thread query left is the FIRST sight of a window (a single-window description), so a new target can
///   be placed at once.
final class WindowTracker: @unchecked Sendable {
    /// The fastest poll and above-list refresh (the controller's full tracking rate).
    let basePollInterval: TimeInterval
    let baseAboveTTL: TimeInterval
    let forgetAfter: TimeInterval
    /// The poll interval now: never faster than the controller reads the cache (`setPollInterval`).
    var pollInterval: TimeInterval { lock.withLock { currentPoll } }
    var aboveTTL: TimeInterval { lock.withLock { currentAboveTTL } }

    private let server: WindowServer
    private let now: @Sendable () -> TimeInterval
    private let queue: DispatchQueue?
    private let lock = NSLock()
    private var snapshots: [CGWindowID: WindowSnapshot] = [:]
    private var asked: [CGWindowID: TimeInterval] = [:]
    private var above: [CGWindowID: (windows: [StackWindow], at: TimeInterval)] = [:]
    private var aboveAsked: [CGWindowID: TimeInterval] = [:]
    private var polling = false
    private var currentPoll: TimeInterval
    private var currentAboveTTL: TimeInterval

    /// - Parameter queue: where polls run; nil means "only when `pollNow()` is called" (tests).
    init(server: WindowServer = SystemWindowServer(), pollInterval: TimeInterval = 0.05, aboveTTL: TimeInterval = 0.15,
         forgetAfter: TimeInterval = 2, queue: DispatchQueue? = DispatchQueue(label: "com.winter.computeruse.windows",
                                                                                qos: .userInitiated),
         now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.server = server
        self.basePollInterval = pollInterval
        self.baseAboveTTL = aboveTTL
        self.currentPoll = pollInterval
        self.currentAboveTTL = aboveTTL
        self.forgetAfter = forgetAfter
        self.queue = queue
        self.now = now
    }

    /// The window's last known geometry (main thread: a cache read). The first time a window is asked about, it is
    /// described once on the spot.
    func snapshot(of id: CGWindowID) -> WindowSnapshot? {
        let t = now()
        lock.lock()
        asked[id] = t
        let cached = snapshots[id]
        let known = cached != nil
        lock.unlock()
        if known {
            startPolling()
            return cached
        }
        let first = server.describe([id]).first.map { WindowSnapshot(frame: $0.bounds, isOnScreen: $0.isOnScreen) }
        lock.lock()
        if let first { snapshots[id] = first }
        lock.unlock()
        startPolling()
        return first
    }

    /// The windows above `id` as last fetched, or nil before the first fetch. Asking keeps the fetch going.
    func windowsAbove(_ id: CGWindowID) -> [StackWindow]? {
        let t = now()
        lock.lock()
        aboveAsked[id] = t
        let cached = above[id]?.windows
        lock.unlock()
        startPolling()
        return cached
    }

    /// Polls no more often than `seconds` (and never faster than the base rate): the controller reads the cache at its
    /// idle rate while nothing moves, so polling at 20 Hz then would only wake the CPU. Back to a faster rate, one poll
    /// runs at once so the cache is fresh for the first read.
    func setPollInterval(_ seconds: TimeInterval) {
        let poll = max(basePollInterval, seconds)
        let faster: Bool = lock.withLock {
            let faster = poll < currentPoll
            currentPoll = poll
            currentAboveTTL = max(baseAboveTTL, poll)
            return faster && polling
        }
        if faster, let queue { queue.async { [weak self] in self?.pollNow() } }
    }

    /// One poll: everything followed in one `describe`, plus the above-lists that are due. Runs on the tracker's queue
    /// (or directly, in tests).
    func pollNow() {
        let t = now()
        lock.lock()
        let aboveTTL = currentAboveTTL
        asked = asked.filter { t - $0.value < forgetAfter }
        aboveAsked = aboveAsked.filter { t - $0.value < forgetAfter }
        for id in snapshots.keys where asked[id] == nil { snapshots[id] = nil }
        for id in above.keys where aboveAsked[id] == nil { above[id] = nil }
        let ids = Array(asked.keys).sorted()
        let dueAbove = aboveAsked.keys.filter { id in (above[id].map { t - $0.at >= aboveTTL }) ?? true }.sorted()
        lock.unlock()

        let described = server.describe(ids)
        var fetched: [CGWindowID: [StackWindow]] = [:]
        for id in dueAbove { fetched[id] = server.windowsAbove(id) }

        lock.lock()
        let byID = Dictionary(described.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for id in ids {
            // A followed window missing from the description is gone.
            snapshots[id] = byID[id].map { WindowSnapshot(frame: $0.bounds, isOnScreen: $0.isOnScreen) }
        }
        for (id, windows) in fetched { above[id] = (windows, t) }
        lock.unlock()
    }

    var isPolling: Bool {
        lock.lock()
        defer { lock.unlock() }
        return polling
    }

    private func startPolling() {
        guard let queue else { return }
        lock.lock()
        let start = !polling
        polling = true
        lock.unlock()
        if start { queue.async { [weak self] in self?.pollLoop() } }
    }

    private func pollLoop() {
        pollNow()
        lock.lock()
        let keepGoing = !asked.isEmpty || !aboveAsked.isEmpty
        if !keepGoing { polling = false }
        let interval = currentPoll
        lock.unlock()
        guard keepGoing, let queue else { return }
        queue.asyncAfter(deadline: .now() + interval) { [weak self] in self?.pollLoop() }
    }
}
