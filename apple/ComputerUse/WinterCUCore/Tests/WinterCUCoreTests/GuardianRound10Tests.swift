import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// Round 10: the user's rulings from the hands-on test and the reviewer's findings on round 9 — one directed test each.
final class GuardianRound10Tests: XCTestCase {
    /// The user WORKING in an app (a click, key or scroll in its window while it is in front) makes the agent hands-off it
    /// until it leaves the front; switching there to look does not; a click into a background window counts once its own
    /// activation lands (a drag out of one activates nothing).
    func testHandsOffWhileTheUserWorksInTheApp() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        XCTAssertFalse(g.userIsWorking(in: 500, front: 500, now: 1), "only switched there")
        g.userInteracted(500, front: 500, now: 1.1)
        XCTAssertTrue(g.userIsWorking(in: 500, front: 500, now: 1.2))
        XCTAssertFalse(g.userIsWorking(in: 77, front: 500, now: 1.2), "another app")
        XCTAssertFalse(g.userIsWorking(in: 500, front: 1, now: 2), "they left it")
        XCTAssertFalse(g.userIsWorking(in: 500, front: 500, now: 3), "back to look: not until they interact anew")
        // A click into its window while another app is in front: theirs once it comes forward within the click's window.
        g.userInteracted(500, front: 1, now: 4)
        XCTAssertFalse(g.userIsWorking(in: 500, front: 1, now: 4.05))
        XCTAssertTrue(g.userIsWorking(in: 500, front: 500, now: 4.1))
        // A drag out of a background window: it never came forward — no work in it, even if they switch there later.
        var h = CUFocusGuardianCore()
        h.begin(view: CUGuardedView(app: 1, space: 100))
        h.userInteracted(500, front: 1, now: 5)
        XCTAssertFalse(h.userIsWorking(in: 500, front: 500, now: 6.6), "switched there 1.6 s after a drag: only looking")
        // (Within the claim's window — 1.5 s, round 11 — a slow app's activation after their click still counts.)
        h.userInteracted(500, front: 1, now: 10)
        XCTAssertTrue(h.userIsWorking(in: 500, front: 500, now: 11.2))
    }

    /// The engine's wiring: a key the tap sees while the bound target is in front refuses the next act on it at once
    /// (typed `refused`, reason `user_working`); a ⌘-Tab's Tab is no work; once another app is in front, acts go again.
    func testAKeyInTheFrontTargetRefusesTheNextAct() async throws {
        let sys = FakeSystem()
        sys.running = [1, 500]; sys.front = 500; sys.space = 100
        sys.windows[77] = FakeSystem.window(77, pid: 500, CGRect(x: 500, y: 0, width: 400, height: 300))
        sys.stack = [sys.windows[77]!]
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: FakeAX(), sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let t = CUTarget(id: "t1", sessionId: "s", pid: 500, bundleId: "com.apple.finder", appName: "Finder",
                         isChromium: false, mirror: false, windowID: 77, windowTitle: "")
        core.registerForTesting(t, windowElement: nil)
        core.switchInputObservableOverride = true
        XCTAssertTrue(core.startGuardian(privatePath: true))
        defer { core.stopGuardian() }
        let now = core.clock.nowSeconds()
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, flags: .maskCommand, keycode: 48, now: now)  // ⌘-Tab's Tab
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, flags: .maskCommand, keycode: 49, now: now)  // ⌘-Space
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "a ⌘ chord (a switch, Spotlight) is no work in the app")
        core.noteTapEvent(type: .keyDown, sourcePid: 0, userData: 0, keycode: 0, now: now)
        do {
            _ = try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .key(CUKeyAction(combo: "a")),
                                                         access: .full, allowForeground: false, privatePath: true))
            XCTFail("refused while the user works in it")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused")
            XCTAssertEqual(e.data?["reason"], .string("user_working"))
            XCTAssertTrue(e.message.contains("the user is working in Finder right now"), e.message)
        }
        sys.front = 1
        XCTAssertNoThrow(try core.refuseWhileUserWorks(t), "they left it")
    }
    /// Review of round 9, MEDIUM #4: only a LINK is rerouted to a background open — never an image's src or a web area's
    /// own URL — and never a link to the same site as the page it is on (the app's own navigation).
    func testOnlyALinkToAnotherSiteIsRerouted() {
        let ax = FakeAX()
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: FakeSystem(),
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        let area = fakeElement(91_001), other = fakeElement(91_002), same = fakeElement(91_003), image = fakeElement(91_004)
        ax.add(area, role: "AXWebArea", extra: ["AXURL": URL(string: "https://mail.example.com/inbox")! as CFURL])
        for (e, role, url) in [(other, "AXLink", "https://news.example.org/a"), (same, "AXLink", "https://mail.example.com/inbox#msg"),
                               (image, "AXImage", "https://cdn.example.org/x.png")] {
            ax.add(e, role: role, extra: ["AXURL": URL(string: url)! as CFURL, kAXParentAttribute: area])
        }
        XCTAssertEqual(core.linkURL(other, ElementInfo(other, ax))?.host, "news.example.org")
        XCTAssertNil(core.linkURL(same, ElementInfo(same, ax)), "the same site: the app's own navigation")
        XCTAssertNil(core.linkURL(image, ElementInfo(image, ax)), "an image's src is no link")
    }
    /// Review of round 9, MEDIUM #3: a hold and another session's rung 4 on another app each have their OWN exemption —
    /// the rung 4's end neither ends the hold's nor drops the place the hold's end gives back.
    func testEachConsentedForegroundHasItsOwnExemption() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(600, raise: true, now: 10)
        g.exempt(600, until: 40, now: 10)                       // session A holds 600 in front
        XCTAssertEqual(g.judge(CUMoveQuery(app: 600, space: 100), now: 10.1), .consented)
        g.noteCause(700, raise: true, now: 11)
        g.exempt(700, until: 16, now: 11)                       // session B's rung 4 on 700
        XCTAssertEqual(g.judge(CUMoveQuery(app: 700, space: 100), now: 11.1), .consented)
        g.endExempt(700, now: 11.5)
        XCTAssertFalse(g.judge(CUMoveQuery(app: 600, space: 100), now: 12).undoes, "the hold's exemption stands")
        g.endExempt(600, now: 13)
        XCTAssertEqual(g.view.app, 1, "the hold's end gives the place from before it back")
    }
    /// Review of round 9, MEDIUM #5: an app started a moment ago, not by the agent, never seen in front — its first
    /// activation is the user's own launch even when the launch notice was never heard; the agent's own launch's is not.
    func testAFirstActivationOfAnAppStartedJustNowNotByTheAgentIsTheUsers() {
        var g = CUFocusGuardianCore()
        g.begin(view: CUGuardedView(app: 1, space: 100))
        g.noteCause(500, now: 20)
        g.noteOpenerCause(now: 20)
        XCTAssertTrue(g.judge(CUMoveQuery(app: 880, space: 100, appStartedAt: 15), now: 20.3).isUsers, "their own slow launch")
        let token = g.beginLaunch(now: 30)
        g.endLaunch(token, pid: 881, now: 30.5)
        g.noteCause(500, now: 34)
        g.noteOpenerCause(now: 34)
        XCTAssertFalse(g.judge(CUMoveQuery(app: 881, space: 100, appStartedAt: 30.2), now: 34.2).isUsers, "the agent's own launch")
    }
}
