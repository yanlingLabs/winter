import AppKit
import Combine
import XCTest
import NormaKit
import NormaProtocol
@testable import Norma

/// browser-runtime T5: **the integration, driven end to end** — a fold arrives on a real
/// `SessionFeed` over a scripted transport, and a CEF transcript comes out the other side.
///
/// Everything between those two points is production code: `NormaClient`'s routing,
/// `ShellSessionHost`'s attachment policy, `PanelStore`'s fold, `BrowserSignalsCoordinator`'s
/// assembly, `BrowserLifecycleEngine.plan`, `BrowserRuntime.apply`. Nothing here calls `plan`
/// directly and nothing asserts on an action array: `BrowserLifecycleTests` owns the decision
/// table and `BrowserRuntimeTests` owns the executor, so what is left for this file — and the only
/// thing it can honestly claim — is that the app's real state reaches the engine as the signals it
/// believes it is getting.
///
/// **What no test here covers**, stated per spec §9's discipline: CEF itself. The driver is
/// `BrowserRuntimeTests.CEFRecorder`, because no CEF client override is callable under XCTest,
/// ever. "A browser was created" here means `NormaCEFCreateBrowser` would have been called with
/// that URL — that it then renders, plays audio and survives a reparent is Task 1's spike,
/// measured in the running app.
@MainActor
final class BrowserSignalsTests: XCTestCase {

    // MARK: - The world

    /// A mutable session-list, so a test can make the daemon's answer change between polls — which
    /// is the whole mechanism obligation #4 rests on.
    final class Rows: @unchecked Sendable {
        private let lock = NSLock()
        private var _rows: [SessionSummary] = []
        var rows: [SessionSummary] {
            get { lock.lock(); defer { lock.unlock() }; return _rows }
            set { lock.lock(); _rows = newValue; lock.unlock() }
        }
    }

    /// One tick of `SessionDirectory`'s poll, under the test's thumb: the loop waits here until a
    /// test releases it, so a "the poll ran" assertion is an observation rather than a sleep.
    final class Tick: @unchecked Sendable {
        private let lock = NSLock()
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private(set) var count = 0

        func wait() async {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                lock.lock()
                count += 1
                waiters.append(c)
                lock.unlock()
            }
        }

        /// Release every loop currently parked in `wait()`.
        func release() {
            lock.lock()
            let parked = waiters
            waiters = []
            lock.unlock()
            for c in parked { c.resume() }
        }

        var parkedCount: Int { lock.lock(); defer { lock.unlock() }; return waiters.count }
    }

    struct World {
        let host: ShellSessionHost
        let factory: ShellTransportFactory
        let directory: SessionDirectory
        let rows: Rows
        let tick: Tick
        let runtime: BrowserRuntime
        let cef: BrowserRuntimeTests.CEFRecorder
        let clock: BrowserRuntimeTests.FakeScheduler
        let coordinator: BrowserSignalsCoordinator
    }

    private var worlds: [World] = []

    override func setUp() {
        super.setUp()
        PanelWebTabModels.removeAllForTesting()
    }

    override func tearDown() {
        worlds = []
        PanelWebTabModels.removeAllForTesting()
        super.tearDown()
    }

    /// Never `BrowserRuntime.shared`: it is process-global and would carry containers, timers and a
    /// window into every test that ran afterwards (`BrowserRuntimeTests`' own rule).
    private func makeWorld() -> World {
        let rows = Rows()
        let tick = Tick()
        let directory = SessionDirectory(lister: { rows.rows },
                                         sleepTick: { await tick.wait() })
        let factory = ShellTransportFactory()
        let host = ShellSessionHost(directory: directory, makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { factory.make() }, token: "tok", clientName: "orb",
                                   mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        })
        let cef = BrowserRuntimeTests.CEFRecorder()
        let clock = BrowserRuntimeTests.FakeScheduler()
        let runtime = BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
        let coordinator = BrowserSignalsCoordinator(host: host, runtime: runtime,
                                                    now: { clock.current })
        let world = World(host: host, factory: factory, directory: directory, rows: rows, tick: tick,
                          runtime: runtime, cef: cef, clock: clock, coordinator: coordinator)
        worlds.append(world)   // the coordinator's subscriptions die with it; keep it alive
        return world
    }

    // MARK: - Wire helpers

    private func row(_ sessionId: String, activity: String?, mode: String = "code") -> SessionSummary {
        SessionSummary(sessionId: sessionId, title: nil, createdAt: 1, scope: "global", cwd: nil,
                       mode: mode, activity: activity)
    }

    private func waitUntil(_ what: String, _ condition: () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "timed out waiting for \(what)", file: file, line: line)
    }

    private func waitUntilMade(_ f: ShellTransportFactory, _ n: Int,
                               file: StaticString = #filePath, line: UInt = #line) async {
        await waitUntil("\(n) connection(s)", { f.made.count >= n }, file: file, line: line)
    }

    @discardableResult
    private func answerHandshake(_ t: ShellScriptedTransport, sessionId: String,
                                 file: StaticString = #filePath, line: UInt = #line) async -> Bool {
        await waitUntil("the hello", { t.sent.count >= 1 }, file: file, line: line)
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntil("the attach", { t.sent.count >= 2 }, file: file, line: line)
        let attach = feedLineJSON(t.sent[1])
        XCTAssertEqual(attach["method"] as? String, "session.attach", file: file, line: line)
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        return true
    }

    /// A hop moves the attachment on the SAME socket (`ShellSessionHost.hop` — "one `session.attach`
    /// on the same connection"), so there is no second transport to answer; this answers the Nth
    /// attach on the one there is. `attachIndex` counts from 1.
    private func answerReattach(_ t: ShellScriptedTransport, attachIndex: Int,
                                file: StaticString = #filePath, line: UInt = #line) async {
        await waitUntil("re-attach #\(attachIndex)",
                        { t.methods.filter { $0 == "session.attach" }.count >= attachIndex },
                        file: file, line: line)
        let line0 = t.sent.last { feedLineJSON($0)["method"] as? String == "session.attach" }!
        let attach = feedLineJSON(line0)
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
    }

    /// Publish a session list, the only way `SessionDirectory.rows` is ever populated — a full
    /// `session.list` answer. Every `activity` signal in this file arrives this way.
    private func publishRows(_ w: World, _ rows: [SessionSummary]) async {
        w.rows.rows = rows
        await w.directory.refresh()
    }

    /// Wraps one `SessionEvent` payload in the JSON-RPC notification the daemon actually sends —
    /// `{"method":"event","params":{…}}` (`AppModelTests`' own shape). A bare event object is not a
    /// frame `NormaClient` routes, so nothing would ever reach the fold.
    private func frame(_ payload: String) -> String {
        #"{"jsonrpc":"2.0","method":"event","params":\#(payload)}"#
    }

    private func opened(_ sessionId: String, _ tabId: String, seq: Int, kind: String = "web",
                        url: String? = nil, title: String? = nil) -> String {
        let u = url.map { "\"\($0)\"" } ?? "null"
        let t = title.map { "\"\($0)\"" } ?? "null"
        return frame(#"{"type":"panel_tab_opened","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"tabId":"\#(tabId)","kind":"\#(kind)","url":\#(u),"title":\#(t)}"#)
    }

    private func activated(_ sessionId: String, _ tabId: String, seq: Int) -> String {
        frame(#"{"type":"panel_tab_activated","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"tabId":"\#(tabId)"}"#)
    }

    private func closed(_ sessionId: String, _ tabId: String, seq: Int) -> String {
        frame(#"{"type":"panel_tab_closed","seq":\#(seq),"sessionId":"\#(sessionId)","ts":0,"tabId":"\#(tabId)"}"#)
    }

    /// The ordinary opening move: a visible shell, attached to `sessionId`, with one active web tab
    /// whose browser is live. Returns the transport so the caller can keep feeding it.
    @discardableResult
    private func openOneWebTab(_ w: World, sessionId: String = "s1", tabId: String = "t1",
                               url: String = "https://example.com", title: String? = nil,
                               seq: Int = 1) async -> ShellScriptedTransport {
        w.host.setShellVisible(true)
        w.host.select(sessionId)
        await waitUntilMade(w.factory, 1)
        let t = w.factory.made[0]
        await answerHandshake(t, sessionId: sessionId)
        t.feed(opened(sessionId, tabId, seq: seq, url: url, title: title))
        t.feed(activated(sessionId, tabId, seq: seq + 1))
        await waitUntil("the browser for \(tabId)", { w.runtime.isLive(tabId: tabId) })
        return t
    }

    // MARK: - The fold creates (the path the deleted bridge used to take)

    /// **The baseline the whole task rests on**, and the replacement for the view-layer bridge T4
    /// carried: a `panel_tab_opened` reaching `PanelStore` is now what makes a browser exist. No
    /// view is involved anywhere in this test — there is no `PanelViewport`, no host `NSView`, and
    /// no window — which is exactly the point of spec §2's inversion.
    func testAFoldThatOpensAWebTabIsWhatCreatesItsBrowser() async {
        let w = makeWorld()
        XCTAssertEqual(w.cef.log, [], "the premise: nothing has been created yet")

        await openOneWebTab(w, url: "https://example.com", title: "Example")

        XCTAssertTrue(w.cef.log.contains("c1 create url=https://example.com"),
                      "the fold did not reach the engine: \(w.cef.log)")
    }

    /// **Obligation #5: the title travels fold → `BrowserTabState.title` → the seed.**
    ///
    /// `NormaCEFSeedTabState` primes the navigation channel's dedupe memory with the (url, title)
    /// PAIR. Seeded with an empty title, the browser's first committed navigation looks new and is
    /// re-reported as a `panel_tab_navigated` the session log already holds — a permanent extra
    /// line per restore, in a log that is never deleted. The engine never reads this field (no rule
    /// mentions it, and none may), so nothing but this row can catch it going missing.
    func testTheTabsTitleFromTheFoldReachesTheSeed() async {
        let w = makeWorld()
        await openOneWebTab(w, url: "https://example.com", title: "Example Domain")

        XCTAssertTrue(w.cef.log.contains("c1 seed url=https://example.com title=Example Domain"),
                      "the seed lost the fold's title: \(w.cef.log)")
    }

    /// **Obligation #1: only `.web` tabs enter the engine.** The engine has no concept of
    /// `PanelTabKind` — a `.document` tab handed to it gets a browser created for it, silently, and
    /// the panel would then be running Chromium behind a placeholder view.
    func testADocumentTabNeverGetsABrowser() async {
        let w = makeWorld()
        let t = await openOneWebTab(w)
        let transcript = w.cef.log

        t.feed(opened("s1", "doc1", seq: 3, kind: "document", url: "file:///tmp/a.odt"))
        t.feed(activated("s1", "doc1", seq: 4))
        await waitUntil("the document tab to land", { w.host.panelStore.tabs.count == 2 })

        XCTAssertEqual(w.cef.log.filter { $0.contains("create url=") }.count, 1,
                       "a document tab reached CEF: \(w.cef.log)")
        // The shown tab is the document now, so the WEB tab is nobody's shown tab — its browser
        // stays live and parked (a hold never stops), and the viewport is given back.
        XCTAssertTrue(w.runtime.isLive(tabId: "t1"), "log was \(w.cef.log)")
        XCTAssertFalse(w.cef.log.dropFirst(transcript.count).contains { $0.hasSuffix(" close") },
                       "showing a document must not stop the web tab's browser: \(w.cef.log)")
    }

    /// **Obligation #2: `isShown` is the SESSION's shown tab, not "on screen".**
    ///
    /// `s2` is not the displayed session and never has been — nothing of it is on screen — but its
    /// row says `background`, so spec §4 holds its browsers live, and spec §6's lazy restore
    /// creates its shown tab and only its shown tab. Reading `isShown` as visibility would create
    /// nothing here; reading it as "every tab of a woken session" would create both.
    func testANonDisplayedSessionsOwnShownTabIsTheOneThatWakes() async {
        let w = makeWorld()
        await publishRows(w, [row("s1", activity: "idle"), row("s2", activity: "idle")])

        // s2's tabs enter this shell the way a hop leaves them behind: displayed, folded, departed.
        let t = await openOneWebTab(w, sessionId: "s2", tabId: "a1", url: "https://a.example")
        t.feed(opened("s2", "a2", seq: 3, url: "https://b.example"))
        t.feed(activated("s2", "a2", seq: 4))
        await waitUntil("a2 to become s2's shown tab",
                        { w.host.panelStore.activeTabId == "a2" })
        XCTAssertTrue(w.runtime.isLive(tabId: "a1") && w.runtime.isLive(tabId: "a2"))

        // Now go and look at something else entirely, and let both of s2's browsers stop.
        w.host.select("s1")
        await answerReattach(t, attachIndex: 2)
        w.clock.current += BrowserLifecycleEngine.stopLinger + 1
        w.coordinator.replan()
        await waitUntil("s2's browsers to stop",
                        { !w.runtime.isLive(tabId: "a1") && !w.runtime.isLive(tabId: "a2") })

        let transcript = w.cef.log
        // s2 wakes: still nothing of it on screen, still not displayed.
        await publishRows(w, [row("s1", activity: "idle"), row("s2", activity: "background")])

        XCTAssertTrue(w.runtime.isLive(tabId: "a2"),
                      "the woken session's own shown tab must come back: \(w.cef.log)")
        XCTAssertFalse(w.runtime.isLive(tabId: "a1"),
                       "siblings restore on first show, not on wake (spec §6): \(w.cef.log)")
        XCTAssertEqual(w.cef.log.dropFirst(transcript.count).filter { $0.contains("create url=") },
                       ["c3 create url=https://b.example"],
                       "exactly one create, and it is the shown tab's: \(w.cef.log)")
    }

    // MARK: - The belt (spec §8)

    /// **The T4 acceptance row, and the structural kill for the audio-after-close bug.**
    ///
    /// Between T4 and Task 5 closing a tab left a live parked renderer behind for every tab closed:
    /// the view no longer stopped anything and nothing else did either. `panel_tab_closed` in a
    /// fold must stop that tab's browser on the SAME pass — not on a linger, not on a later poll —
    /// because a browser whose tab is gone is definitionally a leak (spec §8) and the user hears it.
    func testClosingATabStopsItsBrowserOnTheSamePass() async {
        let w = makeWorld()
        let t = await openOneWebTab(w)
        XCTAssertTrue(w.runtime.isLive(tabId: "t1"))

        t.feed(closed("s1", "t1", seq: 3))
        await waitUntil("the tab to leave the fold", { w.host.panelStore.tabs.isEmpty })

        XCTAssertFalse(w.runtime.isLive(tabId: "t1"),
                       "closing a tab left a live parked renderer: \(w.cef.log)")
        XCTAssertTrue(w.cef.log.contains("c1 close"), "log was \(w.cef.log)")
        XCTAssertNil(w.runtime.viewportTabId, "and the stopped tab must not still hold the viewport")
    }

    /// The belt is stated about the LIST, not about the close event — "any live browser whose tabId
    /// is no longer in the session's tab list is stopped", whatever removed it. This drives the
    /// other producer: a `panel.list` snapshot (`ShellSessionHost.refreshPanelTabs`, fired on every
    /// attach and hop) that no longer names a tab this shell still has a browser for — which is what
    /// an agent-side close in B2, or a close that happened while this shell was elsewhere, looks
    /// like when the shell comes back.
    func testASnapshotThatNoLongerNamesATabStopsItsBrowserToo() async {
        let w = makeWorld()
        await publishRows(w, [row("s1", activity: "idle"), row("s2", activity: "idle")])
        let t = await openOneWebTab(w, sessionId: "s2", tabId: "b1", url: "https://b.example")
        XCTAssertTrue(w.runtime.isLive(tabId: "b1"))

        // The shell hops away — which is also what clears s2's working event buffer, and so what
        // makes a later snapshot for it AUTHORITATIVE rather than dropped as racing behind replay
        // (`PanelStore.applyFetchedSnapshot`'s own guard).
        w.host.select("s1")
        await answerReattach(t, attachIndex: 2)
        XCTAssertTrue(w.runtime.isLive(tabId: "b1"), "a hop is not a stop — the linger has not run")

        // …and the next `panel.list` for s2 no longer names that tab.
        w.host.panelStore.applyFetchedSnapshot(sessionId: "s2", tabs: [], activeTabId: nil)

        XCTAssertFalse(w.runtime.isLive(tabId: "b1"),
                       "a browser with no tab in any list survived the belt: \(w.cef.log)")
        XCTAssertTrue(w.cef.log.contains("c1 close"), "log was \(w.cef.log)")
    }

    // MARK: - Window close (spec §4, §10.4)

    /// **Spec §10 gate 4, as a test: closing the window silences the page NOW, not in five
    /// minutes.** The linger exists so a session hop never reloads; a closed window is not a hop,
    /// and "keep playing invisibly for five minutes" is the audio surprise this plan opened with.
    func testClosingTheWindowStopsTheViewedSessionsBrowsersImmediately() async {
        let w = makeWorld()
        // "active" because THIS shell is attached — the case that makes the reflection matter (see
        // `BrowserSignalsCoordinator.ownAttachmentStillCountedIn`): read naively, the row would say
        // another harness is here and the engine would hold the browsers live, exactly the audio
        // surprise this plan opened with.
        await publishRows(w, [row("s1", activity: "active")])
        await openOneWebTab(w)

        w.host.setShellVisible(false)

        XCTAssertFalse(w.runtime.isLive(tabId: "t1"),
                       "the window closed and the page kept running: \(w.cef.log)")
        XCTAssertTrue(w.cef.log.contains("c1 close"), "log was \(w.cef.log)")
        XCTAssertTrue(w.clock.liveTimers.isEmpty,
                      "a linger was armed for a session the window close was supposed to skip it for")
    }

    // MARK: - The linger (spec §4)

    /// **Spec §10 gate 5's first half.** A hop away and back inside the linger must produce no
    /// stop and no create: the browser the user comes back to is the same object, with its scroll
    /// position, its video and its JS heap — none of which any test in this process can see, all of
    /// which die with a create.
    ///
    /// This row is also what pins `PanelStore.switchSession`'s seeding (Task 5): the hop back
    /// re-folds the returning session from the seed, and folding it from EMPTY instead — the
    /// pre-Task-5 behaviour — collapses its tab list for one pass, which is all the belt needs to
    /// stop every one of its browsers.
    func testASessionHopInsideTheLingerNeitherStopsNorRecreates() async {
        let w = makeWorld()
        await publishRows(w, [row("s1", activity: "idle"), row("s2", activity: "idle")])
        let t = await openOneWebTab(w, sessionId: "s1", tabId: "a1", url: "https://a.example")
        t.feed(opened("s1", "a2", seq: 3, url: "https://b.example"))
        t.feed(activated("s1", "a2", seq: 4))
        await waitUntil("s1's second tab", { w.runtime.isLive(tabId: "a2") })
        let containerA1 = w.runtime.container(forTabId: "a1")
        let containerA2 = w.runtime.container(forTabId: "a2")
        let transcript = w.cef.log

        // Hop to s2 …
        w.host.select("s2")
        await answerReattach(t, attachIndex: 2)
        // … then straight back, well inside the 300s linger.
        w.clock.current += 30
        w.host.select("s1")
        await answerReattach(t, attachIndex: 3)
        // The re-attach replays s1's COMPLETE history, one event at a time — the exact window in
        // which a fold-from-empty would have reported s1 as having one tab, then two.
        t.feed(opened("s1", "a1", seq: 1, url: "https://a.example"))
        t.feed(activated("s1", "a1", seq: 2))
        t.feed(opened("s1", "a2", seq: 3, url: "https://b.example"))
        t.feed(activated("s1", "a2", seq: 4))
        await waitUntil("s1's replay to land", { w.host.panelStore.tabs.count == 2 })

        XCTAssertEqual(w.cef.log, transcript,
                       "a hop inside the linger must reach CEF not at all: \(w.cef.log)")
        XCTAssertTrue(w.runtime.container(forTabId: "a1") === containerA1,
                      "the user came back to a different browser")
        XCTAssertTrue(w.runtime.container(forTabId: "a2") === containerA2)
    }

    /// The other side of the same rule: past the linger, the abandoned session's renderers go. The
    /// stop is the ENGINE's, taken on a plan whose `now` is past the deadline — the timer only asks
    /// the question again.
    func testASessionAbandonedPastTheLingerStops() async {
        let w = makeWorld()
        await publishRows(w, [row("s1", activity: "idle"), row("s2", activity: "idle")])
        let t = await openOneWebTab(w, sessionId: "s1", tabId: "a1", url: "https://a.example")

        w.host.select("s2")
        await answerReattach(t, attachIndex: 2)
        XCTAssertTrue(w.runtime.isLive(tabId: "a1"), "a hop is not a stop")
        let armed = try? XCTUnwrap(w.clock.liveTimers.first)
        XCTAssertNotNil(armed, "no linger was armed for the departed session")

        w.clock.current += BrowserLifecycleEngine.stopLinger + 1
        w.clock.fire(armed!.id)

        XCTAssertFalse(w.runtime.isLive(tabId: "a1"),
                       "the linger expired and nothing stopped: \(w.cef.log)")
    }

    // MARK: - The hidden window (ledger obligation #4)

    /// **The freeze this obligation exists to kill, driven end to end.**
    ///
    /// The window closes mid-turn. `hold` beats `stopImmediately` — spec §4's "never stop mid-work"
    /// — so that pass emits nothing at all for the session, and the stop can only come from a LATER
    /// plan that sees the turn end. But the shell detached when the window hid, so no event will
    /// ever arrive again for that session, and the `session.list` poll used to stop with the window:
    /// signals frozen at `working = true`, browsers and their audio alive until the user reopens.
    ///
    /// What makes it stop instead: the poll keeps running while any browser is live, its refresh
    /// republishes `rows`, and that is a re-plan. **The window is never reopened in this test** —
    /// `setShellVisible(true)` is never called after the close, which is the whole claim.
    func testAWindowClosedMidTurnStopsItsTabsWhenTheTurnEndsWithoutEverReopening() async {
        let w = makeWorld()
        // Mid-turn, and the daemon knows it: an app-kind harness detaching mid-turn auto-backgrounds
        // the session, which is what `session.list` reports for the whole of a turn nobody watches.
        await publishRows(w, [row("s1", activity: "background")])
        await openOneWebTab(w)
        w.coordinator.setRenderingActive(true)
        await waitUntil("the poll to start", { w.directory.isPollingForTesting })

        w.host.setShellVisible(false)
        w.coordinator.setRenderingActive(false)

        XCTAssertTrue(w.runtime.isLive(tabId: "t1"),
                      "closing the window must not pull an agent's pages out from under a running "
                          + "turn (spec §4): \(w.cef.log)")
        XCTAssertTrue(w.directory.isPollingForTesting,
                      "the poll stopped with the window — nothing can ever tell this shell the turn "
                          + "ended, so the browsers live until it reopens")

        // The turn ends. Nothing announces it: the only way this shell can learn is the next poll.
        w.rows.rows = [row("s1", activity: "idle")]   // NOT published — the poll has to fetch it
        await waitUntil("the poll to be waiting", { w.tick.parkedCount > 0 })
        w.tick.release()

        await waitUntil("the browsers to stop", { !w.runtime.isLive(tabId: "t1") })
        XCTAssertTrue(w.cef.log.contains("c1 close"), "log was \(w.cef.log)")
        XCTAssertFalse(w.host.shellVisible, "the window must never have reopened")
    }

    /// The gate's other direction, so the row above cannot pass by simply never closing it: with no
    /// live browser, a hidden window polls exactly as little as it did before Task 5.
    func testAHiddenWindowWithNoLiveBrowserDoesNotPoll() async {
        let w = makeWorld()
        await publishRows(w, [row("s1", activity: "idle")])
        await openOneWebTab(w)
        w.coordinator.setRenderingActive(true)
        XCTAssertTrue(w.directory.isPollingForTesting)

        // Idle and unviewed: the window close stops its browsers outright, so nothing holds the
        // gate open any more.
        w.host.setShellVisible(false)
        w.coordinator.setRenderingActive(false)

        XCTAssertFalse(w.runtime.isLive(tabId: "t1"), "log was \(w.cef.log)")
        XCTAssertFalse(w.directory.isPollingForTesting,
                       "a hidden shell with nothing live must not keep polling the daemon")
    }

    /// **Obligation #3, isolated: the flag stays SET while the window stays closed.** Latching it
    /// only at the moment of the close — the obvious implementation — passes the row above by luck
    /// of ordering and fails this one: here the session is still working when the FIRST post-close
    /// plan runs, so the stop must be decided by a plan several passes later, which can only happen
    /// if the flag is still there to see.
    func testStopImmediatelyOutlivesTheCloseItselfForAsLongAsTheWindowIsShut() async {
        let w = makeWorld()
        await publishRows(w, [row("s1", activity: "background")])
        await openOneWebTab(w)

        w.host.setShellVisible(false)
        XCTAssertTrue(w.runtime.isLive(tabId: "t1"), "held mid-work, as spec §4 requires")

        // Several re-plans later, still hidden, still working.
        for _ in 0..<3 { w.coordinator.replan() }
        XCTAssertTrue(w.runtime.isLive(tabId: "t1"))

        // The work ends. No linger may be waited out first — that is what `stopImmediately` means.
        await publishRows(w, [row("s1", activity: "idle")])

        XCTAssertFalse(w.runtime.isLive(tabId: "t1"),
                       "the window-close flag did not survive to the plan that could act on it: "
                           + "\(w.cef.log)")
        XCTAssertTrue(w.clock.liveTimers.isEmpty, "and it must skip the linger, not arm one")
    }

    // MARK: - Wiring (ledger obligation #6) and the new-chat page

    /// **Obligation #6: `host` is set before anything can be created, not merely by the end of
    /// `init`.**
    ///
    /// Not tidiness. `BrowserRuntime.wire` binds `host` onto the tab's model AT CREATE TIME, and a
    /// model with no host records no navigations at all — for a parked browser nobody renders,
    /// nothing will ever rebind one. So the claim is about ORDERING, and the only way to observe
    /// ordering is to read `runtime.host` from INSIDE the create: `CEFRecorder.onCreate` runs within
    /// `createBrowser`, which is the last step of `BrowserRuntime.create`. Assigning `host` after
    /// the first `replan()` instead of before it leaves this reading nil while every "is it set
    /// now" assertion still passes.
    ///
    /// `onLingerDeadline`'s half is pinned behaviourally rather than here:
    /// `testASessionAbandonedPastTheLingerStops` fires an armed timer and expects a stop, which can
    /// only happen if the runtime had a re-plan hook to call.
    func testTheShellHostIsWiredBeforeTheFirstCreateRuns() {
        let cef = BrowserRuntimeTests.CEFRecorder()
        let clock = BrowserRuntimeTests.FakeScheduler()
        let runtime = BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
        XCTAssertNil(runtime.host, "the premise")
        XCTAssertNil(runtime.onLingerDeadline)

        var hostAtCreate: ShellSessionHost??
        cef.onCreate = { _, _ in hostAtCreate = .some(runtime.host) }

        let directory = SessionDirectory(lister: { [] })
        let host = ShellSessionHost(directory: directory, makeFeed: { _ in nil })
        host.setShellVisible(true)   // a closed window would make the first plan a STOP, not a create
        // A displayed session with a web tab, folded BEFORE the coordinator exists — so the
        // coordinator's own first plan is what creates this browser.
        host.panelStore.switchSession(to: "s1")
        host.panelStore.applyFetchedSnapshot(
            sessionId: "s1",
            tabs: [PanelTab(tabId: "t1", kind: .web, url: "https://example.com", title: "Example")],
            activeTabId: "t1")
        XCTAssertEqual(cef.log, [], "nothing may exist before there is a coordinator")

        let coordinator = BrowserSignalsCoordinator(host: host, runtime: runtime,
                                                    now: { clock.current })
        withExtendedLifetime(coordinator) {
            XCTAssertTrue(cef.log.contains("c1 create url=https://example.com"),
                          "the first plan must actually have created something, or this row proves "
                              + "nothing about ordering: \(cef.log)")
            XCTAssertTrue((hostAtCreate ?? nil) === host,
                          "the browser was created before the runtime had a shell host — its "
                              + "navigations would go nowhere, permanently")
            XCTAssertNotNil(runtime.onLingerDeadline,
                            "an armed linger would expire into a runtime with nothing to ask")
        }
    }

    /// **The new-chat page's bound session displays tabs with nothing attached** — it binds rather
    /// than navigating, precisely so the page's draft survives (`ShellSessionHost
    /// .openPanelTabForNewChatPage`). Keying `attachedHere` on `attachedSessionId` would leave that
    /// session quiet, so the "+" would open a tab the panel then rendered as an empty rectangle;
    /// `PanelStore.currentSessionId` — the session whose tabs the panel is DISPLAYING, which is the
    /// engine's own words for this signal — is what makes it a shown session like any other.
    func testTheNewChatPagesBoundSessionStillGetsItsBrowser() {
        let w = makeWorld()
        w.host.setShellVisible(true)
        XCTAssertNil(w.host.attachedSessionId, "the premise: the new-chat page attaches nothing")

        // Exactly what `autoCreateForNewChatPage` does once its create and openTab come back.
        w.host.panelStore.switchSession(to: "fresh")
        w.host.panelStore.applyFetchedSnapshot(
            sessionId: "fresh",
            tabs: [PanelTab(tabId: "n1", kind: .web, url: nil, title: nil)],
            activeTabId: "n1")

        XCTAssertTrue(w.runtime.isLive(tabId: "n1"),
                      "the panel would paint an empty rectangle: \(w.cef.log)")
        XCTAssertTrue(w.cef.log.contains("c1 create url=\(panelWebTabStartPageURL)"),
                      "a tab with no destination still opens on the start page: \(w.cef.log)")
    }

    /// **Enforcement point 3, through the path a user actually takes since Task 5.**
    ///
    /// `PanelURLPolicy.restorableURL` is the last mile of the whole URL policy: every other door can
    /// be bypassed by data that predates it, but this one is on the path of EVERY load. A stored
    /// `javascript:` URL would otherwise be re-executed against the page on every restore, for as
    /// long as the session exists — which is forever, since sessions are user-delete-only.
    ///
    /// `BrowserRuntimeTests.testTheRestoreDoorRefusesEveryDisallowedSchemeAndSeedsNothingForOne`
    /// pins the door itself. This pins that the route a hostile URL actually travels — a daemon
    /// fold, through the engine, into a create — goes through it rather than around it. It replaces
    /// `PanelViewportTests.testAStoredHostileURLNeverReachesCEFThroughTheViewport`, which pinned the
    /// same claim about the view path that Task 5 deleted.
    func testAStoredHostileURLNeverReachesCEFThroughTheFoldThatRestoresIt() async {
        for hostile in ["javascript:alert(document.cookie)",
                        "file:///Users/someone/.ssh/id_rsa",
                        "data:text/html,<script>fetch('//evil')</script>"] {
            let w = makeWorld()
            await openOneWebTab(w, url: hostile, title: "stored")

            XCTAssertTrue(w.cef.log.contains("c1 create url=\(panelWebTabStartPageURL)"),
                          "\(hostile) reached a real Chromium browser: \(w.cef.log)")
            XCTAssertTrue(w.cef.log.contains("c1 seed url= title=stored"),
                          "and the address bar must show nothing rather than the refused value: "
                              + "\(w.cef.log)")
        }

        // Without this the assertions above cannot tell "filtered" from "always the start page".
        let control = makeWorld()
        await openOneWebTab(control, url: "https://example.com", title: "Example")
        XCTAssertTrue(control.cef.log.contains("c1 create url=https://example.com"),
                      "log was \(control.cef.log)")
    }
}
