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

    // MARK: - Pin 3: the termination path

    /// `NormaApplication` must override `-terminate:`.
    ///
    /// Cocoa's default `terminate:` calls `exit()` and skips the rest of the run loop, so an
    /// embedder that needs an orderly teardown has to intervene there — every CEF sample does.
    /// Nothing fails to compile if the override is deleted.
    ///
    /// Compared by class NAME rather than `type(of: NSApp)` deliberately: the dynamic class of
    /// `NSApp` can be a KVO isa-swizzled subclass, which would make an identity comparison
    /// false-red for a reason unrelated to what this asserts (Task 3's carried minor).
    func testNormaApplicationOverridesTerminateForCEFsOrderlyShutdown() throws {
        let normaApplication = try XCTUnwrap(NSClassFromString("NormaApplication"))
        let selector = #selector(NSApplication.terminate(_:))
        XCTAssertNotEqual(
            class_getMethodImplementation(normaApplication, selector),
            class_getMethodImplementation(NSApplication.self, selector),
            "NormaApplication no longer overrides -terminate:; Cocoa's default exit() would bypass "
                + "CEF's teardown entirely (see NormaApplication.mm for why the override closes "
                + "browsers rather than calling CefShutdown — a terminate here can be CANCELLED).")
    }

    /// `NormaCEFShutdown` must be a safe no-op before initialisation.
    ///
    /// This is the property that lets the shutdown be wired into the termination path
    /// unconditionally — `NSApplicationWillTerminateNotification`, subscribed by
    /// `NormaCEFInitialize` — and the reason the unit-test host, which never starts CEF, can run
    /// that path without touching a framework it never `dlopen`ed. `CefShutdown` on an unloaded
    /// library would dispatch through an unresolved dylib stub.
    func testShutdownIsASafeNoOpWhenCEFWasNeverInitialised() {
        XCTAssertFalse(NormaCEFRuntime.isInitialized, "CEF must not be initialised in the test host")
        NormaCEFRuntime.shutdown()  // must not trap
        XCTAssertTrue(NormaCEFRuntime.didShutdown)
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
    /// The fallback is load-bearing rather than defensive: `panel.openTab` never emits
    /// `panel_tab_activated`, so a freshly opened tab leaves `activeTabId` nil and the panel would
    /// otherwise render nothing at all in the ordinary case. See `panelShownTab`'s own doc.
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
