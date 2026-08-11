import Foundation

/// browser-runtime live-gate fix G: **where the lifecycle engine's memory budget gets its numbers.**
///
/// The user replaced the count cap with a budget — *"instead of a tab cap we could do like a memory
/// cap so for example 16 tabs that barely eat any memory can still stay alive"* — which puts the
/// policy in `BrowserLifecycleEngine` (`memoryBudgetBytes`, and the rules that spend it) and leaves
/// this file with the measurement alone. Nothing here decides anything.
///
/// ## The attribution caveat is real, and it is why the per-tab map is a division rather than a read
///
/// **There is no per-tab renderer memory to read.** Chromium's site isolation puts same-site tabs in
/// ONE renderer process, so two tabs on the same origin share a single RSS figure and a third on
/// another origin has its own — and CEF's stable API exposes no browser→renderer-pid mapping to
/// attribute it with even if the processes were one-to-one. So the honest measurement is the
/// **total**, and the honest attribution is an **equal share** of it: `total ÷ live tabs`.
///
/// That is exactly what shipped, and the engine is built to survive it: `capEvictions` consumes the
/// map as a total and a maximum and never as a ranking (its own doc says so), because under an
/// equal share "evict the heaviest" would be a coin toss wearing a policy's clothes. Eviction order
/// is LRU, which is a real signal. The map is per-tab anyway so that a better attribution — the day
/// CEF grows one — is a change to this file and to nothing else.
///
/// **What was considered and rejected as not materially better:** counting the GPU/network/utility
/// helpers into the total (they are fixed overhead, not per-tab cost, and charging them to tabs
/// would make the first tab look enormous); and weighting the share by anything the app knows about
/// a tab (URL, age, whether it is shown) — every such weight is a guess, and a guess presented as a
/// measurement is worse than an honest average.
enum BrowserRendererMemory {

    /// **PURE: parse `ps -ax -o ppid=,rss=,command=` and total the renderer helpers' RSS.**
    ///
    /// Split out from the sweep so the parsing — the only part with anything to get wrong — is
    /// testable without spawning a process. `SpikeCloseLeak.helperCensus` is the prior art for the
    /// shape (same command, same `ppid == me` + `Norma Helper` filter); this adds `rss=` and the
    /// `--type=renderer` restriction.
    ///
    /// `rss` is reported in **KiB** by `ps` on macOS, hence the `* 1024`.
    ///
    /// Renderers ONLY. The GPU, network and utility helpers are fixed overhead that exists whether
    /// there is one tab or twenty, so charging it to tabs would price the first tab at the cost of
    /// the whole browser.
    ///
    /// A line this cannot parse is skipped rather than guessed at: an under-count degrades to
    /// "fewer evictions than ideal", which is the same direction as no measurement at all.
    static func rendererBytes(psOutput: String, parentPid: Int32) -> UInt64 {
        let me = String(parentPid)
        var total: UInt64 = 0
        for line in psOutput.split(separator: "\n") {
            var fields = line.split(separator: " ", omittingEmptySubsequences: true)
            guard fields.count >= 3 else { continue }
            let ppid = String(fields.removeFirst())
            guard ppid == me else { continue }
            guard let rssKiB = UInt64(fields.removeFirst()) else { continue }
            let command = fields.joined(separator: " ")
            guard command.contains("Norma Helper"), command.contains("--type=renderer") else { continue }
            total += rssKiB * 1024
        }
        return total
    }

    /// The sweep itself. Blocking (`waitUntilExit`), which is why `BrowserMemorySampler` only ever
    /// calls it off the main actor — `SpikeCloseLeak` learned that lesson the loud way: its census
    /// spun the run loop and completed the very creations it was trying to catch in flight.
    ///
    /// Zero on any failure, which the engine reads as "no measurement" and degrades to the count
    /// backstop for.
    static func sampleRendererBytes() -> UInt64 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-o", "ppid=,rss=,command="]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { return 0 }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        return rendererBytes(psOutput: String(decoding: data, as: UTF8.self),
                             parentPid: ProcessInfo.processInfo.processIdentifier)
    }
}

/// The cached, throttled total — **read synchronously by every plan, refreshed asynchronously at
/// the poll's own cadence.**
///
/// `BrowserSignalsCoordinator.replan()` runs on folds, on turn-state changes and on every
/// `session.list` publication, which is far more often than a `ps` sweep is worth. So a plan reads
/// whatever was last measured and, if that is stale, *kicks* a refresh it does not wait for. The
/// consequence is stated rather than hidden: **the budget acts on a number up to
/// `interval` seconds old**, which for a bound whose whole job is to stop idle accumulation is not
/// a cost worth paying latency for.
@MainActor
final class BrowserMemorySampler {

    /// Mirrors `SessionDirectory`'s poll (5 s) deliberately: the plan that consumes a fresh sample
    /// is usually the one that poll's publication triggers, so a second, faster cadence here would
    /// spawn processes whose answers nothing reads.
    static let interval: TimeInterval = 5

    /// `@Sendable` because it runs off the main actor. Injected so tests never spawn `ps` — the
    /// parsing they DO want to pin is `BrowserRendererMemory.rendererBytes`, which is pure.
    private let probe: @Sendable () -> UInt64
    private let now: () -> Date

    private var lastSampledAt: Date?
    private var inFlight = false

    /// The last completed sweep, in bytes. Zero until the first one lands — which the engine reads
    /// as "no measurement" and answers with the count backstop alone, exactly as intended for a
    /// process that has just launched and has nothing accumulated to bound.
    private(set) var totalRendererBytes: UInt64 = 0

    init(probe: @escaping @Sendable () -> UInt64 = BrowserRendererMemory.sampleRendererBytes,
         now: @escaping () -> Date = Date.init) {
        self.probe = probe
        self.now = now
    }

    /// **The engine's input.** The last total, with a refresh kicked if it has gone stale. Never
    /// blocks and never waits.
    func totalBytesRefreshingIfStale() -> UInt64 {
        if let last = lastSampledAt, now().timeIntervalSince(last) < Self.interval {
            return totalRendererBytes
        }
        refresh()
        return totalRendererBytes
    }

    /// `lastSampledAt` is stamped when the sweep is REQUESTED, not when it answers — otherwise a
    /// slow or failing `ps` would leave the timestamp stale and this would spawn a fresh process on
    /// every single plan. `inFlight` is the second half of that guard, for the same reason.
    private func refresh() {
        guard !inFlight else { return }
        inFlight = true
        lastSampledAt = now()
        let probe = self.probe
        Task.detached(priority: .utility) {
            let total = probe()
            await MainActor.run { [weak self] in
                self?.totalRendererBytes = total
                self?.inFlight = false
            }
        }
    }

    /// **PURE: the equal-share attribution** — see `BrowserRendererMemory`'s doc for why it is a
    /// division and not a read. An empty live set yields an empty map, which is the engine's
    /// documented "no measurement" input rather than a special case.
    ///
    /// A total of zero yields a map of zeroes rather than an empty one, and the difference does not
    /// matter to the engine: it sums to zero and its maximum is zero either way, so both read as
    /// "nothing measurable" and leave `maxLiveBackstop` as the only bound.
    nonisolated static func equalShare(totalBytes: UInt64,
                                       liveTabIds: Set<String>) -> [String: UInt64] {
        guard !liveTabIds.isEmpty else { return [:] }
        let share = totalBytes / UInt64(liveTabIds.count)
        return Dictionary(uniqueKeysWithValues: liveTabIds.map { ($0, share) })
    }
}
