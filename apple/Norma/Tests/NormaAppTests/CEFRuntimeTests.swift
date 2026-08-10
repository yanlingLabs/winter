import AppKit
import XCTest
@testable import Norma

/// panel-cef Task 6a: the runtime pins for the CEF embed.
///
/// Every test in this file guards something that compiles, links, and leaves the whole suite green
/// while being silently broken — the class of defect this branch-pair has now produced five times.
/// None of them requires CEF to be running, and CEF deliberately does NOT run here: the unit-test
/// host IS `Norma.app`, and `NormaCEFRuntime` refuses to start Chromium under XCTest
/// (`testTheRuntimeRefusesToStartCEFUnderXCTest` pins exactly that).
@MainActor
final class CEFRuntimeTests: XCTestCase {

    // MARK: - Pin 1: the one executable line `CefAppProtocol` conformance adds

    /// `NormaApplication.sendEvent:` must wrap `[super sendEvent:]` in a `CefScopedSendingEvent`.
    ///
    /// Task 3's review found that DELETING `CefScopedSendingEvent sendingEventScoper;` leaves all
    /// three of `NormaApplicationTests`' checks green — the class still exists, still conforms to
    /// `CefAppProtocol`, still answers both selectors — while breaking CEF at runtime. Chromium
    /// reads `[NSApp isHandlingSendEvent]` to know whether it is inside AppKit's event dispatch;
    /// with the scoper gone it is always `NO` and Chromium's event handling misbehaves in ways
    /// nothing in this build would report.
    ///
    /// The technique: a local event monitor runs INSIDE `-[NSApplication sendEvent:]` dispatch, so
    /// reading the flag from one observes the scoper's effect at exactly the moment it is supposed
    /// to hold. Read through KVC because the getter comes from `CefAppProtocol` — a C++-adjacent
    /// header this Swift test bundle cannot import — and `-isHandlingSendEvent` is one of the
    /// selectors KVC's own search order tries for the key `handlingSendEvent`.
    func testSendEventIsWrappedInCefScopedSendingEvent() throws {
        let app = try XCTUnwrap(NSApp)
        func handlingSendEvent() -> Bool? { app.value(forKey: "handlingSendEvent") as? Bool }

        // Baseline: outside dispatch the flag must be false, or "true inside" proves nothing.
        XCTAssertEqual(handlingSendEvent(), false,
                       "isHandlingSendEvent is already true outside sendEvent: — the scoper's "
                           + "effect cannot be distinguished from a stuck flag")

        var observedInsideDispatch: Bool?
        let monitor = NSEvent.addLocalMonitorForEvents(matching: .applicationDefined) { event in
            observedInsideDispatch = handlingSendEvent()
            return event
        }
        defer { if let monitor { NSEvent.removeMonitor(monitor) } }

        let event = try XCTUnwrap(NSEvent.otherEvent(
            with: .applicationDefined, location: .zero, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
            subtype: 0, data1: 0, data2: 0))
        app.sendEvent(event)

        XCTAssertEqual(
            observedInsideDispatch, true,
            "NSApp.isHandlingSendEvent was not true inside sendEvent: dispatch — "
                + "`CefScopedSendingEvent sendingEventScoper;` is missing from "
                + "NormaApplication.mm's sendEvent:. CEF requires that wrap; nothing else in this "
                + "build fails without it.")

        // And it must be scoped, not latched — the destructor restores the previous value.
        XCTAssertEqual(handlingSendEvent(), false,
                       "isHandlingSendEvent stayed true after sendEvent: returned — the scoper is "
                           + "not restoring on scope exit")
    }

    // MARK: - Pin 2: CEF_USE_SANDBOX on all five helpers

    private static let helperSuffixes = ["", " (Alerts)", " (GPU)", " (Plugin)", " (Renderer)"]

    /// Every helper must actually contain `CefScopedSandboxContext`.
    ///
    /// Task 4's review found the FIFTH instance of this branch-pair's worst class here: deleting
    /// `CEF_USE_SANDBOX=1` from the helper targets compiles clean, links clean and leaves all 1274
    /// tests green — while silently producing UNSANDBOXED renderer processes, because
    /// `process_helper_mac.cc` gates `CefScopedSandboxContext sandbox_context;` on that define
    /// exactly as CEF's own upstream source does.
    ///
    /// Asserted on the BUILT PRODUCT rather than on a build setting, so it cannot be satisfied by a
    /// `project.yml` that declares the define for a target nothing links it into. The needle is the
    /// `dlopen` path constant from `libcef_dll/wrapper/cef_scoped_sandbox_context_mac.mm` — the one
    /// translation unit the define pulls out of the static library, and one that nothing else in
    /// the helper references. Drop the define and the linker leaves that object out entirely: no
    /// constant, no test.
    ///
    /// **Debug puts the real code in `<name>.debug.dylib`** and leaves a stub at `MacOS/<name>` —
    /// Task 3 recorded this for the app target; it applies to the helper targets too (measured).
    /// Release has no such dylib. Both are searched, and finding it in either passes.
    func testAllFiveHelpersCompileTheSandboxContextIn() throws {
        let needle = Data(
            "../../../Chromium Embedded Framework.framework/Libraries/libcef_sandbox.dylib".utf8)

        for suffix in Self.helperSuffixes {
            let name = "Norma Helper\(suffix)"
            let macOS = Bundle.main.bundleURL
                .appendingPathComponent("Contents/Frameworks/\(name).app/Contents/MacOS", isDirectory: true)
            let candidates = [
                macOS.appendingPathComponent("\(name).debug.dylib"),  // Debug
                macOS.appendingPathComponent(name),                   // Release (and the Debug stub)
            ].filter { FileManager.default.fileExists(atPath: $0.path) }

            XCTAssertFalse(candidates.isEmpty, "no binary found for \(name)")

            let found = candidates.contains { url in
                guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return false }
                return data.range(of: needle) != nil
            }
            XCTAssertTrue(
                found,
                "\(name) does not contain CefScopedSandboxContext — CEF_USE_SANDBOX is no longer "
                    + "defined for the CEFHelper target template (apple/Norma/project.yml). Its "
                    + "renderer processes would run UNSANDBOXED, and nothing else in this build "
                    + "would fail.")
        }
    }

    // MARK: - Pin 3b: DoClose, or CEF closes Norma's own window

    /// The browser client must override `CefLifeSpanHandler::DoClose` and answer `true`.
    ///
    /// Found at the user's live gate, and it is the worst shape a default can have: the base class
    /// supplies `return false`, which compiles, links, runs — and, per
    /// `include/cef_life_span_handler.h`, "will send the standard close notification to the
    /// browser's top-level parent window (... **performClose: on OS X** ...)". For a browser
    /// parented into `ShellPanel`, that window is Norma's own. Closing a panel tab, or clicking
    /// Cowork with a tab open, made the entire app window vanish while the process stayed alive.
    ///
    /// **This half pins only that the override still EXISTS**, through a string literal in its log
    /// line. A symbol-based pin would be fragile in the configuration that ships (the client class
    /// is in an anonymous namespace and Release strips debugging symbols); the literal is in
    /// `__cstring` and survives stripping — the same technique, and the same reason, as the
    /// `CEF_USE_SANDBOX` pin above: assert on the BUILT PRODUCT.
    ///
    /// **It deliberately does NOT pin the answer**, and must not be mistaken for doing so: the
    /// literal is emitted by a `Log(...)` statement with zero coupling to the `return`, so changing
    /// only the return would leave this green with the Critical restored. That half is
    /// `testDoCloseAnswersThatTheHostHandlesTheCloseSoCEFNeverTouchesNormasWindow` below, which
    /// reads the returned VALUE. Both are needed: this one catches the body being replaced (pasting
    /// `cefsimple`'s, which returns false and carries no such log line), that one catches the answer
    /// being flipped.
    ///
    /// If you change that log message, change this needle with it — that coupling is deliberate and
    /// is written at the call site too.
    func testTheBrowserClientOverridesDoCloseSoCEFCannotCloseNormasWindow() throws {
        let needle = Data("DoClose->true".utf8)
        let macOS = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let candidates = [
            macOS.appendingPathComponent("Norma.debug.dylib"),  // Debug puts the real code here
            macOS.appendingPathComponent("Norma"),              // Release
        ].filter { FileManager.default.fileExists(atPath: $0.path) }
        XCTAssertFalse(candidates.isEmpty, "no app binary found to scan")

        let found = candidates.contains { url in
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return false }
            return data.range(of: needle) != nil
        }
        XCTAssertTrue(
            found,
            "NormaClient no longer overrides DoClose. CefLifeSpanHandler's default returns false, "
                + "which makes CEF send performClose: to the browser's top-level parent window — "
                + "Norma's app window. Closing a panel tab would close the whole window.")
    }

    /// `DoClose` must ANSWER `true` — the half a binary string scan structurally cannot cover.
    ///
    /// The override returns `NormaCEFDoCloseIsHandledByHost()` rather than a bare literal precisely
    /// so this test can read the value it yields instead of inferring it from a log message. Flip
    /// that function to `NO` and this reds; flip it and the app silently goes back to closing its
    /// own window whenever a panel tab closes.
    ///
    /// Why the value matters, from `include/cef_life_span_handler.h`: `false` means "proceed with
    /// the default close behaviour", which "will send the standard close notification to the
    /// browser's top-level parent window (... **performClose: on OS X** ...)". Measured at the live
    /// gate — with `false`, closing a tab took `mainWindowVisible` true→false and the activation
    /// policy regular→accessory, so the window vanished and the Dock icon with it.
    func testDoCloseAnswersThatTheHostHandlesTheCloseSoCEFNeverTouchesNormasWindow() {
        XCTAssertTrue(
            NormaCEFRuntime.doCloseIsHandledByHost,
            "DoClose now answers false. CEF will send performClose: to the browser's top-level "
                + "parent window — Norma's own — so closing a panel tab, or leaving the session "
                + "with one open, will close the app's window and demote it out of the Dock. "
                + "cefsimple and cefclient return false because each OWNS a window per browser; "
                + "Norma does not. See NormaCEF.h.")
    }

    // MARK: - Pin 3: the termination path

    /// **`NormaApplication` must NOT override `-terminate:`** — the whole-branch review's F7, as a
    /// tripwire.
    ///
    /// Task 6a added `- (void)terminate: { NormaCEFCloseAllBrowsers(); [super terminate:sender]; }`
    /// on cefsimple's reasoning (Cocoa's default `terminate:` calls `exit()`, so an embedder needs
    /// a hook there). Norma does not: `NormaCEFInitialize` subscribes CEF's shutdown to
    /// `NSApplicationWillTerminateNotification`, which AppKit posts from inside `terminate:` once
    /// the delegate answers `.terminateNow` — so the real-quit path is covered without an override,
    /// and `NormaCEFShutdown` closes every browser itself before `CefShutdown`.
    ///
    /// What the override added was damage on the OTHER path. **A terminate here can be CANCELLED**
    /// — ⌘Q and a dock-tile quit both answer `.terminateCancel` (`terminateDecision`, Lifecycle
    /// T3) — and the cancel path does not tear the panel's SwiftUI tree down unless a session is
    /// attached (`closeMainWindows` ends in `orderOut(nil)`; the detach chain needs
    /// `shellAttachmentAction` to see something attached). So on the new-chat page with a bound
    /// panel tab, ⌘Q closed the live browser and nothing ever rebuilt the view: a permanently blank
    /// panel, no placeholder, no Try again, for the life of the process.
    ///
    /// Compared by class NAME rather than `type(of: NSApp)` deliberately: the dynamic class of
    /// `NSApp` can be a KVO isa-swizzled subclass, which would make an identity comparison
    /// false-red for a reason unrelated to what this asserts (Task 3's carried minor).
    func testTerminateIsNotOverriddenBecauseAQuitHereCanBeCANCELLED() throws {
        let normaApplication = try XCTUnwrap(NSClassFromString("NormaApplication"))
        let selector = #selector(NSApplication.terminate(_:))
        XCTAssertEqual(
            class_getMethodImplementation(normaApplication, selector),
            class_getMethodImplementation(NSApplication.self, selector),
            "NormaApplication overrides -terminate: again. A terminate here can be CANCELLED (⌘Q "
                + "and dock-quit both do), and anything this override destroys is NOT rebuilt on "
                + "the cancel path when nothing is attached — that is F7, a permanently blank "
                + "browser panel. CEF's orderly shutdown does not need this hook: it rides "
                + "NSApplicationWillTerminateNotification, subscribed by NormaCEFInitialize. See "
                + "NormaApplication.mm.")
    }

    /// The carrier of that guarantee must still exist: the observer class CEF's shutdown hangs off.
    ///
    /// Honest about its reach — it pins that `NormaCEFTerminationObserver` exists and answers
    /// `applicationWillTerminate:`, NOT that `NormaCEFInitialize` still subscribes it. The
    /// subscription is made inside `CefInitialize`'s success path, which never runs here by design
    /// (`testTheRuntimeRefusesToStartCEFUnderXCTest`), so no test in this host can reach it. The
    /// class is registered with the ObjC runtime at load time, which is why this half is reachable
    /// at all.
    func testTheShutdownObserverCEFsTerminationPathHangsOffStillExists() throws {
        let observer = try XCTUnwrap(
            NSClassFromString("NormaCEFTerminationObserver") as? NSObject.Type,
            "NormaCEFTerminationObserver is gone — CEF's shutdown has nothing to hang off. It is "
                + "the ONLY thing that calls NormaCEFShutdown in production (NormaCEF.mm).")
        XCTAssertTrue(observer.instancesRespond(to: Selector(("applicationWillTerminate:"))),
                      "the observer no longer answers applicationWillTerminate: — the selector "
                          + "NormaCEFInitialize registers against NSApplicationWillTerminateNotification")
    }

    /// **The other half: that something actually SUBSCRIBES the observer** — the half the test above
    /// is honest about not reaching, and which the whole-branch review's F7 fix made load-bearing.
    ///
    /// F7 deleted `NormaApplication`'s `-terminate:` override (it destroyed browsers on quit-CANCEL
    /// too, blanking the panel permanently). That was the right fix, and it left exactly ONE path
    /// from a real quit to `CefShutdown`: the `addObserver:` block in `NormaCEFInitialize`. Deleting
    /// those six lines compiles, links, and leaves the whole suite green — the test above included,
    /// because it pins only that the CLASS exists — while the app quits without shutting CEF down.
    ///
    /// The subscription itself cannot be observed from this host: it is made inside
    /// `CefInitialize`'s success path, which never runs here by design
    /// (`testTheRuntimeRefusesToStartCEFUnderXCTest`). So this asserts on the BUILT PRODUCT instead,
    /// via a `__cstring` literal that survives stripping — the same technique, and the same reason,
    /// as the `CEF_USE_SANDBOX` and `DoClose` pins above.
    ///
    /// **Known limits, stated rather than implied:** it catches the block being DELETED, not a
    /// subtle rewrite that keeps the log and drops the `addObserver:` — the literal has no coupling
    /// to the call, exactly as the `DoClose` pin's own doc says of its half. If you change that log
    /// message, change this needle with it; the coupling is deliberate and written at both ends.
    func testTheTerminationObserverIsACTUALLYSUBSCRIBED() throws {
        let needle = Data("willTerminate-observer-armed".utf8)
        let macOS = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let candidates = [
            macOS.appendingPathComponent("Norma.debug.dylib"),  // Debug puts the real code here
            macOS.appendingPathComponent("Norma"),              // Release
        ].filter { FileManager.default.fileExists(atPath: $0.path) }
        XCTAssertFalse(candidates.isEmpty, "no app binary found to scan")

        let found = candidates.contains { url in
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return false }
            return data.range(of: needle) != nil
        }
        XCTAssertTrue(
            found,
            "NormaCEFInitialize no longer subscribes NormaCEFTerminationObserver to "
                + "NSApplicationWillTerminateNotification. Since the whole-branch F7 fix removed "
                + "NormaApplication's -terminate: override, that subscription is the ONLY path from "
                + "a real quit to CefShutdown — without it the app terminates with Chromium still "
                + "up: helper processes and the GPU process are torn down by the OS rather than "
                + "shut down, and CefShutdown's own teardown never runs.")
    }

    /// `NormaCEFShutdown` must be a safe no-op before initialisation — and a no-op that changes
    /// NOTHING, which is the half that was missing.
    ///
    /// The no-op property is what lets the shutdown be wired into the termination path
    /// unconditionally — `NSApplicationWillTerminateNotification`, subscribed by
    /// `NormaCEFInitialize` — and the reason the unit-test host, which never starts CEF, can run
    /// that path without touching a framework it never `dlopen`ed. `CefShutdown` on an unloaded
    /// library would dispatch through an unresolved dylib stub.
    ///
    /// **The `didShutdown` assertion is inverted from what it was, and that is the fix**
    /// (whole-branch review F10). `NormaCEFShutdown` used to set `g_did_shutdown` even on this
    /// path — process-global state that nothing resets, so this one test left `didShutdown` true
    /// and `NormaCEFRuntime.isRetryable` false for every test that ran after it in the same host.
    /// Nothing asserted `isRetryable` yet, so it was latent rather than live; the next test that
    /// did would have been order-dependent. A no-op that latches the "CEF is finished forever"
    /// flag is not a no-op, and the header called it one.
    func testShutdownIsASafeNoOpWhenCEFWasNeverInitialised() {
        XCTAssertFalse(NormaCEFRuntime.isInitialized, "CEF must not be initialised in the test host")
        NormaCEFRuntime.shutdown()  // must not trap
        XCTAssertFalse(NormaCEFRuntime.didShutdown,
                       "a shutdown that did nothing must not record itself as having shut CEF "
                           + "down: didShutdown is process-global, nothing resets it, and it is "
                           + "what makes NormaCEFInitialize refuse and isRetryable answer false "
                           + "for every test that runs after this one")
        XCTAssertFalse(NormaCEFRuntime.isInitialized, "a no-op shutdown must not report CEF as up")
    }

    // MARK: - The test-host guard, and the panel wiring

    /// CEF must never start inside the suite. `NormaAppTests` runs with `Norma.app` itself as its
    /// test host, so without this guard a single test that hosted a web tab would stand Chromium's
    /// whole process tree up inside a lifecycle-sensitive, teardown-heavy 1274-test run.
    func testTheRuntimeRefusesToStartCEFUnderXCTest() {
        XCTAssertFalse(NormaCEFRuntime.ensureInitialized())
        XCTAssertFalse(NormaCEFRuntime.isInitialized)
        guard case .failed = NormaCEFRuntime.state else {
            return XCTFail("expected the runtime to record a refusal, got \(NormaCEFRuntime.state)")
        }
    }

    /// `.web` resolves to the CEF surface; every other kind keeps Plan A's blank placeholder.
    func testWebTabsResolveToTheCEFSurfaceAndOtherKindsDoNot() {
        let web = PanelTab(tabId: "t1", kind: .web, url: nil, title: nil)
        XCTAssertTrue(panelTabContent(for: web) is PanelWebTab)
        for kind in [PanelTabKind.document, .code, .note] {
            let tab = PanelTab(tabId: "t2", kind: kind, url: nil, title: nil)
            XCTAssertTrue(panelTabContent(for: tab) is PanelPlaceholderTab,
                          "\(kind) must not render a browser")
        }
    }

    /// The panel renders the active tab — and, when nothing is active, the first one.
    ///
    /// The fallback no longer covers the ORDINARY case: Task 6b made `panel.openTab` append
    /// `panel_tab_activated` as well (`packages/core/src/ipc/server.ts`), so a freshly opened tab
    /// arrives active. What it still covers is sessions written before that change — whose logs
    /// carry `panel_tab_opened` alone forever, since sessions are user-delete-only — and the beat
    /// after the active tab is closed, where the fold clears `activeTabId` by design. See
    /// `panelShownTab`'s own doc.
    func testTheShownTabFallsBackToTheFirstTabWhenNothingIsActive() {
        let a = PanelTab(tabId: "a", kind: .web, url: nil, title: nil)
        let b = PanelTab(tabId: "b", kind: .web, url: nil, title: nil)

        XCTAssertEqual(panelShownTab(tabs: [a, b], activeTabId: "b")?.tabId, "b")
        XCTAssertEqual(panelShownTab(tabs: [a, b], activeTabId: nil)?.tabId, "a",
                       "a just-opened tab is never active — without this fallback the panel is blank")
        XCTAssertEqual(panelShownTab(tabs: [a, b], activeTabId: "gone")?.tabId, "a",
                       "an activeTabId naming a tab that is no longer open must not blank the panel")
        XCTAssertNil(panelShownTab(tabs: [], activeTabId: nil))
    }
}
