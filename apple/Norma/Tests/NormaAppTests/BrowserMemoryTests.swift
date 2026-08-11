import XCTest
@testable import Norma

/// browser-runtime live-gate fix G: the two decisions `BrowserMemory.swift` actually makes — what
/// counts as renderer memory, and how a total becomes a per-tab map.
///
/// The engine's use of those numbers is `BrowserLifecycleTests`'; that a plan reaches the sampler at
/// all is `BrowserSignalsTests`' (which injects a total rather than a process, deliberately). What
/// is left for this file is the parsing and the arithmetic, which is where the mistakes would be.
final class BrowserMemoryTests: XCTestCase {

    /// Real `ps -ax -o ppid=,rss=,command=` shape: leading spaces, right-aligned columns, and a
    /// command line long enough to contain the substrings that decide inclusion.
    private let psFixture = """
          1   12345 /Applications/Something.app/Contents/MacOS/Something
        900  524288 /Applications/Norma.app/Contents/Frameworks/Norma Helper.app/Contents/MacOS/Norma Helper --type=renderer --lang=en-US
        900  262144 /Applications/Norma.app/Contents/Frameworks/Norma Helper.app/Contents/MacOS/Norma Helper --type=renderer --lang=en-US
        900   65536 /Applications/Norma.app/Contents/Frameworks/Norma Helper (GPU).app/Contents/MacOS/Norma Helper (GPU) --type=gpu-process
        900   32768 /Applications/Norma.app/Contents/Frameworks/Norma Helper.app/Contents/MacOS/Norma Helper --type=utility
        901  999999 /Applications/Norma.app/Contents/Frameworks/Norma Helper.app/Contents/MacOS/Norma Helper --type=renderer
        900    4096 /usr/bin/some-other-child
        """

    /// **Renderers, ours, and nothing else.** Two renderers at 512 MiB + 256 MiB; the GPU helper,
    /// the utility helper, another process's renderer and an unrelated child are all excluded.
    ///
    /// GPU/network/utility are left out on purpose: they exist whether there is one tab or twenty,
    /// so charging them to tabs would price the first tab at the cost of the whole browser.
    func testOnlyOurOwnRendererHelpersAreCounted() {
        let total = BrowserRendererMemory.rendererBytes(psOutput: psFixture, parentPid: 900)
        XCTAssertEqual(total, (524_288 + 262_144) * 1024,
                       "ps reports rss in KiB; the total is the two renderers of THIS process")
    }

    /// The other direction, so the row above cannot pass as "sums everything it sees": a different
    /// parent's tree contributes nothing at all, even though it contains a matching renderer line.
    func testAnotherProcessesHelpersAreNotOurs() {
        XCTAssertEqual(BrowserRendererMemory.rendererBytes(psOutput: psFixture, parentPid: 901),
                       999_999 * 1024)
        XCTAssertEqual(BrowserRendererMemory.rendererBytes(psOutput: psFixture, parentPid: 42), 0)
    }

    /// Garbage in, zero out — never a crash and never a guess. Zero is the engine's documented "no
    /// measurement" input, which degrades to the count backstop; a guessed number would degrade to
    /// stopping the wrong browsers.
    func testUnparseableOutputIsNoMeasurementRatherThanAWrongOne() {
        XCTAssertEqual(BrowserRendererMemory.rendererBytes(psOutput: "", parentPid: 900), 0)
        XCTAssertEqual(BrowserRendererMemory.rendererBytes(psOutput: "900 notanumber Norma Helper --type=renderer",
                                                           parentPid: 900), 0)
        XCTAssertEqual(BrowserRendererMemory.rendererBytes(psOutput: "900 1024", parentPid: 900), 0,
                       "a line with no command at all is skipped, not counted as a nameless renderer")
    }

    /// The equal share: one total divided by the live tabs, which is the honest attribution when
    /// site isolation means there is no per-tab number to read (see `BrowserRendererMemory`'s doc).
    func testTheTotalIsSplitEquallyAcrossTheLiveTabs() {
        let map = BrowserMemorySampler.equalShare(totalBytes: 900, liveTabIds: ["a", "b", "c"])
        XCTAssertEqual(map, ["a": 300, "b": 300, "c": 300])
    }

    /// No live tabs is an EMPTY map, not a division by zero — and empty is exactly the engine's
    /// "no measurement" input, so the two edge cases answer the same way by construction.
    func testNoLiveTabsYieldsAnEmptyMapRatherThanTrapping() {
        XCTAssertEqual(BrowserMemorySampler.equalShare(totalBytes: 900, liveTabIds: []), [:])
        XCTAssertEqual(BrowserMemorySampler.equalShare(totalBytes: 0, liveTabIds: ["a"]), ["a": 0],
                       "a zero total is a map of zeroes: it sums to zero and its maximum is zero, "
                           + "which the engine reads as nothing measurable either way")
    }

    /// **The throttle, and the reason its timestamp is stamped on REQUEST rather than on answer.**
    ///
    /// A plan runs on every fold, every turn-state change and every `session.list` publication —
    /// far more often than a `ps` sweep is worth. So the first read kicks a sweep and every read
    /// inside the interval reuses it. Stamping on answer instead would leave the timestamp stale
    /// for as long as the sweep took and spawn a fresh process on every plan in between, which is
    /// what the second assertion here catches: the two reads happen while the first sweep is still
    /// in flight.
    @MainActor
    func testTheSweepIsThrottledAndNotRepeatedWhileOneIsInFlight() async {
        let calls = Counter()
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let sampler = BrowserMemorySampler(probe: { calls.bump(); return 4096 }, now: { clock })

        XCTAssertEqual(sampler.totalBytesRefreshingIfStale(), 0,
                       "the first read answers from the cache — it never waits on a process")
        XCTAssertEqual(sampler.totalBytesRefreshingIfStale(), 0)

        await waitUntil("the first sweep to land") { sampler.totalRendererBytes == 4096 }
        XCTAssertEqual(calls.value, 1, "one sweep, not one per read")

        // Still inside the interval: the cache answers and nothing is spawned.
        clock += BrowserMemorySampler.interval - 1
        XCTAssertEqual(sampler.totalBytesRefreshingIfStale(), 4096)
        XCTAssertEqual(calls.value, 1)

        // Past it: a fresh sweep is kicked, and this read still answers from the cache.
        clock += 2
        XCTAssertEqual(sampler.totalBytesRefreshingIfStale(), 4096)
        await waitUntil("the second sweep") { calls.value == 2 }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func bump() { lock.lock(); count += 1; lock.unlock() }
        var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    }

    private func waitUntil(_ what: String, _ condition: @escaping () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "timed out waiting for \(what)", file: file, line: line)
    }
}
