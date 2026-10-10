import ApplicationServices
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// `menu(path)` for a menu bar inside the page: when the app's own menu bar has no such menu, the page's menu
/// bar is used, each level opened with a real (window-targeted) click and verified by the menu it shows.
final class PageMenuTests: XCTestCase {
    let pid: pid_t = 6161
    let window = fakeElement(95_001)
    let web = fakeElement(95_002)
    let pageBar = fakeElement(95_003)
    let fileItem = fakeElement(95_004)
    let toolsItem = fakeElement(95_005)
    let toolsMenu = fakeElement(95_006)
    let spelling = fakeElement(95_007)
    let wordCount = fakeElement(95_008)

    var ax: FakeAX!
    var sys: FakeSystem!
    var poster: RecordingPoster!
    var core: CUCore!
    var target: CUTarget!

    /// `closedMenuStaysAlive`: the chosen item closes the menu the way WebKit shows a `hidden` one — its element
    /// still alive, with its old frame, only no longer in the page. `skyLight`: the private focus SPIs, recorded.
    private func world(menuOpens: Bool = true, closedMenuStaysAlive: Bool = false, skyLight: CUSkyLight = .none) {
        ax = FakeAX()
        let app = ax.application(pid)
        ax.put(app, [kAXWindowsAttribute: [window], kAXFocusedWindowAttribute: window])
        // The app's own menu bar: no "Tools".
        let bar = fakeElement(95_050), appleItem = fakeElement(95_051), viewItem = fakeElement(95_052)
        ax.put(app, [kAXMenuBarAttribute: bar])
        ax.put(bar, [kAXChildrenAttribute: [appleItem, viewItem]])
        ax.add(appleItem, role: "AXMenuBarItem", title: "Apple")
        ax.add(viewItem, role: "AXMenuBarItem", title: "View")
        ax.add(window, role: kAXWindowRole, title: "Doc", frame: CGRect(x: 0, y: 0, width: 1000, height: 800),
               extra: [kAXChildrenAttribute: [web]])
        ax.windowIDs[AXIdentity(element: window)] = 77
        ax.add(web, role: "AXWebArea", title: "Doc", frame: CGRect(x: 0, y: 40, width: 1000, height: 760),
               extra: [kAXChildrenAttribute: [pageBar], kAXParentAttribute: window])
        ax.add(pageBar, role: kAXMenuBarRole, frame: CGRect(x: 0, y: 40, width: 1000, height: 30),
               extra: [kAXChildrenAttribute: [fileItem, toolsItem], kAXParentAttribute: web])
        ax.add(fileItem, role: kAXMenuItemRole, title: "File", frame: CGRect(x: 10, y: 45, width: 40, height: 20), extra: [kAXParentAttribute: pageBar])
        ax.add(toolsItem, role: kAXMenuItemRole, title: "Tools", frame: CGRect(x: 60, y: 45, width: 50, height: 20), extra: [kAXParentAttribute: pageBar])
        ax.add(toolsMenu, role: kAXMenuRole, frame: CGRect(x: 60, y: 70, width: 200, height: 60),
               extra: [kAXChildrenAttribute: [spelling, wordCount], kAXParentAttribute: web])
        ax.add(spelling, role: kAXMenuItemRole, title: "Spelling", frame: CGRect(x: 60, y: 72, width: 200, height: 24), extra: [kAXParentAttribute: toolsMenu])
        ax.add(wordCount, role: kAXMenuItemRole, title: "Word count", frame: CGRect(x: 60, y: 100, width: 200, height: 24), extra: [kAXParentAttribute: toolsMenu])

        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "com.example.browser"
        let w = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 1000, height: 800), owner: "Browser")
        sys.windows[77] = w
        sys.stack = [w]
        sys.front = 1
        poster = RecordingPoster()
        // The page reacts to real mouse-ups only: a click on Tools opens its menu, a click in the menu closes it.
        poster.onPost = { [unowned self] e in
            guard e.type == .leftMouseUp else { return }
            if CGRect(x: 60, y: 45, width: 50, height: 20).contains(e.location), menuOpens {
                ax.put(web, [kAXChildrenAttribute: [pageBar, toolsMenu]])
            } else if CGRect(x: 60, y: 70, width: 200, height: 60).contains(e.location) {
                ax.put(web, [kAXChildrenAttribute: [pageBar]])
                if !closedMenuStaysAlive { ax.dead.insert(AXIdentity(element: toolsMenu)) }
            }
        }
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: skyLight, poster: poster, ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "com.example.browser", appName: "Browser",
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Doc")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func menu(_ path: [String], privatePath: Bool = false) async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .menu(CUMenuAction(path: path)),
                                                 access: .full, allowForeground: false, privatePath: privatePath))
    }

    func testAClosedMenuThatAccessibilityStillHoldsCountsAsClosed() async throws {
        // Live (2026-10-10): the page closed its menu (`hidden`), WebKit kept the element alive with its frame, and
        // the answer said "its menu is still open".
        world(closedMenuStaysAlive: true)
        let r = try await menu(["Tools", "Word count"])
        XCTAssertEqual(r.detail, "chose Tools › Word count from the page's own menu bar, with real clicks (its menu closed)")
    }

    /// Live (2026-10-10): the first click on the page's "Tools" only made the background window key (AppKit's first
    /// click) and the menu never opened. The window is made its app's key window before the click: the synthetic
    /// activation, then the make-key records — posted to the app alone.
    func testTheFirstClickIsPrecededByTheWindowMadeKeyInItsApp() async throws {
        FocusSPI.reset()
        world(skyLight: focusSkyLight())
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        var atFirstDown: [String]?
        let page = poster.onPost
        poster.onPost = { e in
            if atFirstDown == nil, e.type == .leftMouseDown { atFirstDown = FocusSPI.order }
            page?(e)
        }
        let r = try await menu(["Tools", "Word count"], privatePath: true)
        XCTAssertEqual(r.detail, "chose Tools › Word count from the page's own menu bar, with real clicks (its menu closed)")
        XCTAssertEqual(Array((atFirstDown ?? []).prefix(3)), ["activate 77", "down pid \(pid) window 77", "up pid \(pid) window 77"],
                       "the app shows no focused element (no key window): activation and make-key records before the first click")
        XCTAssertEqual(enforcer.deactivated, 0, "no other window was key: nothing resigned")
        XCTAssertTrue(FocusSPI.calls.isEmpty, "no focus records: no blip for a click")
        XCTAssertTrue(sys.activated.isEmpty, "nothing activated")
    }

    func testAnotherKeyWindowOfTheAppResignsFirst() async throws {
        FocusSPI.reset()
        world(skyLight: focusSkyLight())
        let other = fakeElement(95_099)
        ax.add(other, role: kAXWindowRole, title: "Other")
        ax.windowIDs[AXIdentity(element: other)] = 78
        ax.focus(pid: pid, on: other)  // the app's focus — its key window — is the other window
        let enforcer = FakeFocusEnforcer()
        core.focusEnforcerFactory = { _ in enforcer }
        _ = try await menu(["Tools", "Word count"], privatePath: true)
        XCTAssertEqual(Array(FocusSPI.order.prefix(5)), ["activate 77", "deactivate", "activate 77", "down pid \(pid) window 77", "up pid \(pid) window 77"])
    }

    func testNoMakeKeyRecordsForAChromiumAppAnAppInFrontOrWithThePrivatePathOff() async throws {
        for variant in ["chromium", "front", "private path off"] {
            FocusSPI.reset()
            world(skyLight: focusSkyLight())
            if variant != "front" {
                // The private path is the target's own setting (bound with it), as for the rest of the window SPIs.
                target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: variant == "chromium" ? "com.google.Chrome" : "com.example.browser",
                                  appName: "Browser", isChromium: variant == "chromium", mirror: false, windowID: 77, windowTitle: "Doc",
                                  privatePath: variant == "chromium")
                core.registerForTesting(target, windowElement: window)
                target.refs.beginGeneration()
            }
            if variant == "front" { sys.front = pid }
            _ = try? await menu(["Tools", "Word count"], privatePath: variant != "private path off")
            XCTAssertTrue(FocusSPI.makeKey.isEmpty, "\(variant): \(FocusSPI.makeKey)")
        }
    }

    func testAMenuOnlyThePageHasIsChosenWithRealClicksAndVerified() async throws {
        world()
        let r = try await menu(["Tools", "Word count"])
        XCTAssertEqual(r.detail, "chose Tools › Word count from the page's own menu bar, with real clicks (its menu closed)")
        let ups = poster.entries.filter { $0.type == .leftMouseUp }.map(\.location)
        XCTAssertEqual(ups.count, 2, "one click to open, one to choose")
        XCTAssertTrue(CGRect(x: 60, y: 45, width: 50, height: 20).contains(ups[0]))
        XCTAssertTrue(CGRect(x: 60, y: 100, width: 200, height: 24).contains(ups[1]))
        XCTAssertTrue(ax.performed.isEmpty, "no accessibility press: such menus open on a real press only")
    }

    func testAPageMenuThatDoesNotOpenSaysSo() async throws {
        world(menuOpens: false)
        do {
            _ = try await menu(["Tools", "Word count"])
            XCTFail("no menu opened")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.hasPrefix("clicked the page's “Tools” menu, and no menu opened"), e.message)
        }
        XCTAssertEqual(poster.entries.filter { $0.type == .leftMouseUp }.count, 1, "nothing clicked blind after it")
    }

    func testAMissingItemNamesWhatThePagesMenuHas() async throws {
        world()
        do {
            _ = try await menu(["Tools", "Dictionary"])
            XCTFail("no such item")
        } catch let e as CUError {
            XCTAssertEqual(e.code, "invalid_params")
            XCTAssertTrue(e.message.contains("it has: Spelling, Word count"), e.message)
        }
    }

    func testAMenuTheAppsMenuBarHasNeverGoesToThePage() async throws {
        world()
        _ = try? await menu(["View"])
        XCTAssertTrue(poster.entries.filter { $0.type == .leftMouseUp }.isEmpty, "the app's own menu, no page click")
    }
}
