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

    // MARK: - Pin 3c: popups — routed into panel tabs, and still never a window of CEF's own

    /// `OnBeforePopup` must still ANSWER "cancel". Popups now open as PANEL TABS, and that changed
    /// nothing about this: the tab is where the popup goes, the cancel is what keeps CEF from making
    /// a window instead.
    ///
    /// The failure this guards is the natural "improvement" the feature invites — letting CEF host
    /// the popup now that popups are wanted. `false` for a native-hosted Alloy parent "creates a
    /// native popup window" of CEF's own (`include/cef_life_span_handler.h`): a top-level Chromium
    /// window outside the panel and outside Norma's window management, which — because `DoClose`
    /// answers `true`, i.e. the HOST completes every close — nothing can ever close. One
    /// `target="_blank"` would strand a window and its renderer process for the life of the app.
    ///
    /// Reads the VALUE, through the exported single source of truth the override returns, for the
    /// same reason `testDoCloseAnswersThatTheHostHandlesTheClose…` does: a binary string scan
    /// structurally cannot see a return value, and no test in this host can call a C++ virtual
    /// method it cannot construct a `CefBrowser` for.
    func testPopupsAreStillCANCELLEDSoCEFNeverCreatesAWindowOfItsOwn() {
        XCTAssertTrue(
            NormaCEFRuntime.popupsAreCancelled,
            "OnBeforePopup now answers false. That does not route popups anywhere better — it hands "
                + "CEF a top-level native window Norma holds no handle on, and since DoClose says "
                + "the host completes every close, nothing will ever close it or its renderer "
                + "process. Popups reach the user as panel tabs (NormaCEFSetPopupObserver); the "
                + "cancel is independent of that and must stay YES. See NormaCEF.h.")
    }

    /// The client must still ROUTE a popup into a panel tab rather than merely blocking it.
    ///
    /// The regression this catches is a revert: `OnBeforePopup` returning `true` with nothing else
    /// in the body compiles, links, and leaves the whole suite green — including the value pin
    /// directly above, which asserts the cancel and is *satisfied* by a blanket block — while every
    /// `target="_blank"` on every page silently does nothing again. That is the shape this branch
    /// has now produced nine times: a thing that is deleted without a single test noticing.
    ///
    /// Asserted on the BUILT PRODUCT via a `__cstring` literal, the same technique and the same
    /// reason as the `CEF_USE_SANDBOX`, `DoClose` and termination-observer pins above: the client
    /// class is in an anonymous namespace and Release strips debugging symbols, so a symbol-based
    /// pin would be fragile in the configuration that ships.
    ///
    /// **Known limits, stated rather than implied.** The needle is a log literal that sits BESIDE
    /// the `popupObserver` call, not the call itself, so this catches the routing block being
    /// deleted or replaced wholesale (a revert to `Log("popup-blocked"); return true;`) and NOT a
    /// surgical edit that keeps the log and drops the call — exactly the limit the `DoClose` pin
    /// discloses about its own half. It also proves nothing about the observer ever FIRING: CEF
    /// never starts under XCTest, so no test in this host reaches `OnBeforePopup` at all. The Swift
    /// half of the route — model → policy → `panel.openTab`, in the browser's own session — is
    /// pinned behaviourally by `ShellSessionHostTests
    /// .testAPopupOpensAPanelTabInTheSessionItsOwnBrowserBelongsTo`.
    ///
    /// If you change that log message, change this needle with it — the coupling is deliberate and
    /// is written at the call site too.
    func testTheBrowserClientROUTESPopupsIntoPanelTabsRatherThanBlockingThem() throws {
        let needle = Data("popup-routed-to-panel-tab".utf8)
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
            "OnBeforePopup no longer hands popups to the container's popupObserver. Popups are "
                + "cancelled either way — so nothing crashes and nothing leaks — but every "
                + "target=\"_blank\" link and every window.open in the panel silently does nothing "
                + "again, which is the state this feature was built to end. See NormaCEF.mm.")
    }

    // MARK: - Pin 3d: ⌘-click / middle-click, and the context menu

    /// The built-product `__cstring` scan the four pins around here share.
    ///
    /// Same technique and same reason as `testTheBrowserClientOverridesDoClose…`: the client class
    /// is in an anonymous namespace and Release strips debugging symbols, so a symbol-based pin
    /// would be fragile in the configuration that ships, while a string literal survives stripping.
    /// **Debug puts the real code in `Norma.debug.dylib`** and leaves a stub at `MacOS/Norma`;
    /// Release has no such dylib. Both are searched and finding the needle in either passes.
    private func appBinaryContains(_ needle: String) throws -> Bool {
        let macOS = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let candidates = [
            macOS.appendingPathComponent("Norma.debug.dylib"),  // Debug puts the real code here
            macOS.appendingPathComponent("Norma"),              // Release
        ].filter { FileManager.default.fileExists(atPath: $0.path) }
        XCTAssertFalse(candidates.isEmpty, "no app binary found to scan")
        let bytes = Data(needle.utf8)
        return candidates.contains { url in
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return false }
            return data.range(of: bytes) != nil
        }
    }

    /// **The client must actually INSTALL both new handlers** — the half every string scan is blind
    /// to, and the reason this pin exists at all.
    ///
    /// Found by mutating, not by reasoning: deleting the two one-line getters
    /// (`GetRequestHandler` / `GetContextMenuHandler`) while leaving every override, every log
    /// literal and every menu label in place compiles, links, and left **all 18 CEF pins green** —
    /// while making ⌘-click and the entire context menu completely dead, because a `CefClient` that
    /// hands CEF no handler gets CEF's silent defaults for every method on it. That is exactly the
    /// "green with the thing it protects deleted" shape this file exists to stop, and it is the
    /// hole the three built-product scans below CANNOT close: their needles all survive the
    /// deletion.
    ///
    /// **What this covers:** that `CefClient::GetRequestHandler()` and
    /// `CefClient::GetContextMenuHandler()` both answer non-null on a real, freshly constructed
    /// `NormaClient` — read through the `CefClient` interface, i.e. the same two calls CEF makes.
    ///
    /// **What it does NOT cover:** anything about what those handlers then DO. That is the three
    /// scans below. The two halves are complements, exactly like the `DoClose` pair above: this one
    /// is satisfied by handlers whose bodies were gutted, those are satisfied by bodies CEF is
    /// never handed.
    func testTheClientACTUALLYINSTALLSTheRequestAndContextMenuHandlers() {
        XCTAssertTrue(
            NormaCEFRuntime.installsClickAndMenuHandlers,
            "NormaClient no longer returns its CefRequestHandler and/or CefContextMenuHandler. "
                + "Both features are then dead at runtime — CEF never calls a handler it was not "
                + "given — while every log literal and every menu label stays in the binary, so "
                + "every built-product scan in this file stays green. ⌘-click goes back to being a "
                + "plain click and the context menu goes back to CEF's stock model. See NormaCEF.mm.")
    }

    /// **⌘-click and middle-click must OPEN A NEW PANEL TAB**, not perform an ordinary click.
    ///
    /// The regression this catches is the state the feature was built out of, and it is a *deletion*
    /// rather than a breakage: with `GetRequestHandler`/`OnOpenURLFromTab` gone, everything still
    /// compiles, links and passes — CEF's documented default for those clicks is "allow the
    /// navigation to proceed in the source browser's top-level frame"
    /// (`include/cef_request_handler.h`), so ⌘-click silently becomes a plain click again and
    /// nothing anywhere says so. That is the third instance of the class `OnBeforePopup` was.
    ///
    /// **What this covers:** that the routing block is compiled into the shipped binary. The needle
    /// is a `Log` literal that sits INSIDE the branch guarded by `RouteURLToNewPanelTab`'s own
    /// return value, so — unlike the `popup-routed-to-panel-tab` needle, which is merely *beside*
    /// its call — the literal is not reachable without the routing call having happened and
    /// succeeded. Deleting the route deletes the literal.
    ///
    /// **What it does NOT cover, stated rather than implied:** which dispositions the branch tests,
    /// the `user_gesture` gate, or that the handler is INSTALLED — that last one is the test above,
    /// and it is not a theoretical gap: this needle survives deleting `GetRequestHandler`. CEF
    /// never starts under XCTest (`testTheRuntimeRefusesToStartCEFUnderXCTest`), so no test in this
    /// host reaches `OnOpenURLFromTab` at all. The Swift half of the route needs no new pin because
    /// there is no
    /// new Swift code: a routed click enters the SAME container observer a popup does
    /// (`NormaCEFSetPopupObserver` — one route, three producers), so
    /// `ShellSessionHostTests.testAPopupOpensAPanelTabInTheSessionItsOwnBrowserBelongsTo` is
    /// already the behavioural pin for model → policy → `panel.openTab`, in the browser's own
    /// session. A second copy of it here would pass whether or not this feature existed.
    ///
    /// If you change that log message, change this needle with it — the coupling is deliberate and
    /// is written at the call site too.
    func testCommandAndMiddleClicksOPENANEWPANELTABInsteadOfNavigatingInPlace() throws {
        XCTAssertTrue(
            try appBinaryContains("click-routed-to-panel-tab"),
            "NormaClient no longer routes CefRequestHandler::OnOpenURLFromTab into a panel tab. "
                + "Nothing fails when that handler is absent — CEF's default is to navigate in the "
                + "source browser's top-level frame — so ⌘-click, middle-click and shift-click "
                + "silently go back to performing an ordinary click, which is the exact bug this "
                + "was built to fix. See NormaCEF.mm.")
    }

    /// The context menu must OFFER Norma's own link and image items.
    ///
    /// Without a `CefContextMenuHandler` the user gets `CefMenuManager::CreateDefaultModel`'s stock
    /// menu, which adds **no link items at all** (verified in CEF's own source: for a page or frame
    /// it is exactly Back, Forward, separator, Print, View Page Source) — so a two-finger click on a
    /// link offers nothing about the link. Deleting the handler compiles, links and leaves the suite
    /// green while restoring precisely that.
    ///
    /// **The needles are the item LABELS**, i.e. the arguments of the `InsertItemAt` calls
    /// themselves rather than a log line standing in for them — the tightest coupling available
    /// from a binary scan. Removing an item removes its label from the binary.
    ///
    /// **What it does NOT cover:** the POSITION of the items, the separator, the conditions that
    /// gate them (link vs. image), that the commands do anything when chosen, or that the handler is
    /// INSTALLED — none of the first four reachable with CEF down, which it always is here, and the
    /// last one covered by `testTheClientACTUALLYINSTALLSTheRequestAndContextMenuHandlers` above,
    /// which exists because this needle survives deleting `GetContextMenuHandler`.
    ///
    /// A behavioural pin — drive `OnBeforeContextMenu` with a fake model and assert the resulting
    /// items — was considered and rejected: `CefMenuModel` has ~40 pure virtuals and
    /// `CefContextMenuParams` ~20, so the fake would be ~200 lines of interface stubs that break on
    /// every CEF upgrade, and `CefMenuModel::CreateMenuModel` is a library call that needs the
    /// framework loaded, which never happens here.
    func testTheContextMenuOFFERSNormasOwnLinkAndImageItems() throws {
        for label in ["Open Link in New Tab", "Copy Link Address", "Copy Image Address"] {
            XCTAssertTrue(
                try appBinaryContains(label),
                "the context menu no longer offers \"\(label)\". With no CefContextMenuHandler CEF "
                    + "shows its stock model, which contains no link or image items whatsoever — a "
                    + "two-finger click on a link would again offer nothing about that link. See "
                    + "NormaCEF.mm's OnBeforeContextMenu.")
        }
    }

    /// **"View Page Source" must stay REMOVED from the menu, because on macOS it does nothing.**
    ///
    /// Not "nothing useful" — nothing at all, and this is CEF's own source rather than an
    /// inference. On branch `7922` (the exact Chromium branch of the vendored framework,
    /// `chromium-151.0.7922.109`): `CefMenuManager::ExecuteDefaultCommand` sends
    /// `MENU_ID_VIEW_SOURCE` to `GetFocusedFrame()->ViewSource()`, which is
    /// `SendCommandWithResponse("GetSource", ViewTextCallback)` → `CefBrowserHostBase::ViewText` →
    /// `platform_delegate_->ViewText`, and `CefBrowserPlatformDelegateNativeMac::ViewText`'s entire
    /// body is `// TODO(cef): Implement this functionality.` + `NOTIMPLEMENTED();`. The base class's
    /// is the same and the Alloy delegate does not override it, so there is no macOS implementation
    /// anywhere — and in a release build `NOTIMPLEMENTED()` compiles to nothing.
    ///
    /// The regression this catches is someone restoring the stock item on the reasonable-sounding
    /// grounds that removing a browser feature looks like a mistake. It is not: it is a dead verb.
    ///
    /// **What this covers:** that the `Remove` call is in the shipped binary AND is the thing that
    /// gates the log — the needle sits inside `if (model->Remove(MENU_ID_VIEW_SOURCE)) { … }`, so
    /// the literal cannot be reached without the removal having happened and having found the item
    /// to remove. That is a stronger coupling than the adjacent-log needles elsewhere in this file.
    ///
    /// **What it does NOT cover:** that CEF ever builds a menu here, or that nothing else re-adds
    /// the item afterwards.
    func testViewPageSourceIsREMOVEDFromTheMenuBecauseItDoesNothingOnMacOS() throws {
        XCTAssertTrue(
            try appBinaryContains("context-menu-view-source-removed"),
            "OnBeforeContextMenu no longer removes MENU_ID_VIEW_SOURCE. On macOS that item is a "
                + "no-op all the way down to CefBrowserPlatformDelegateNativeMac::ViewText, whose "
                + "body is NOTIMPLEMENTED() — clicking it does literally nothing, silently. A menu "
                + "verb that does nothing is worse than an absent one. See NormaCEF.mm.")
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

    // MARK: - Pin 4: the zombie parent view at asynchronous browser creation

    /// **`NormaCEFBrowserCreation.parent` must RETAIN the view** — the one word the crash fix is.
    ///
    /// `CefBrowserHost::CreateBrowser` does not block: it copies the parent `NSView *` as a RAW
    /// handle (`CAST_NSVIEW_TO_CEF_WINDOW_HANDLE` is a cast) into a deferred `CreateBrowserHelper`
    /// task, and when that task runs, `CefBrowserPlatformDelegateNativeMac::CreateHostWindow()`
    /// messages that view. CEF retains nothing. A panel tab dismantled inside that gap — a saved tab
    /// pointing at a domain that fails DNS, opened and torn down in quick succession — left CEF
    /// messaging a deallocated object: `ZombieObjectCrash`, `EXC_BAD_ACCESS` at `0x0` on
    /// `CrBrowserMain`, which kills the browser process and the whole app with it
    /// (`Norma-2026-08-10-130829.ips`). The record holding the view across the gap is what stops it.
    ///
    /// **What this covers:** that the record's `parent` property is a strong reference, and that
    /// clearing it releases. Change `strong` to `weak` in `NormaCEF.mm` — the exact regression — and
    /// this test reds (verified by doing it).
    ///
    /// **What it does NOT cover, stated rather than implied:** that `CreateBrowserNow` still creates
    /// a record, that `OnAfterCreated` still settles it, or that CEF behaves as described. None of
    /// that is reachable — CEF never starts under XCTest
    /// (`testTheRuntimeRefusesToStartCEFUnderXCTest`), so the whole creation path is unreachable
    /// from this host, and the record is the only piece of the fix that can be exercised directly.
    /// `testTheZombieFixesTwoCallSitesAreCompiledIntoTheProduct` below covers the call sites, by the
    /// weaker built-product technique the DoClose and CEF_USE_SANDBOX pins use.
    func testAnInFlightBrowserCreationRETAINSTheParentViewCEFOnlyHoldsRaw() throws {
        let recordType = try XCTUnwrap(
            NSClassFromString("NormaCEFBrowserCreation") as? NSObject.Type,
            "NormaCEFBrowserCreation is gone — nothing holds the parent view across CEF's "
                + "asynchronous browser creation, which is the zombie crash (NormaCEF.mm).")
        let record = recordType.init()

        // Control. Without it, the assertion below could pass because this harness kept the view
        // alive for its own reasons rather than because the record retained it.
        weak var unheld: NSView?
        autoreleasepool {
            let view = NSView(frame: .zero)
            unheld = view
        }
        XCTAssertNil(unheld,
                     "a view with no strong holder did not deallocate at scope exit — the retain "
                         + "assertion below cannot distinguish anything in this harness")

        weak var held: NSView?
        autoreleasepool {
            let view = NSView(frame: .zero)
            held = view
            record.setValue(view, forKey: "parent")
        }
        XCTAssertNotNil(
            held,
            "NormaCEFBrowserCreation.parent does not RETAIN the parent view. CEF holds that view "
                + "as a raw, unretained pointer from CreateBrowser until CreateHostWindow() "
                + "messages it — with nothing retaining it, a panel tab dismantled in between is "
                + "the ZombieObjectCrash that killed the app at the live gate.")

        record.setValue(nil, forKey: "parent")
        XCTAssertNil(held,
                     "settling a creation did not RELEASE the parent view: every browser ever "
                         + "created would strand its container view, and CEF's own host view under "
                         + "it, for the life of the process")
    }

    /// The two call sites of that fix must still be IN the built product.
    ///
    /// Asserted on the binary, for the reason the `DoClose` and `CEF_USE_SANDBOX` pins are: nothing
    /// in this host can reach `CreateBrowserNow` or the close path with CEF down, and both sites sit
    /// in an anonymous-namespace C++ class that Release strips the symbols of. `__cstring` literals
    /// survive stripping.
    ///
    /// **Known limit, the same one those pins carry:** each needle is a `Log(...)` literal beside
    /// the code it stands for, not the code itself. It catches the block being deleted or replaced,
    /// which is how this kind of thing actually regresses; it cannot catch a surgical edit that
    /// keeps the log line and removes only the retain or only the mark. If you change either
    /// message, change the needle with it — the coupling is deliberate and written at both ends.
    func testTheZombieFixesTwoCallSitesAreCompiledIntoTheProduct() throws {
        let macOS = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let binaries = [
            macOS.appendingPathComponent("Norma.debug.dylib"),  // Debug puts the real code here
            macOS.appendingPathComponent("Norma"),              // Release
        ]
        .filter { FileManager.default.fileExists(atPath: $0.path) }
        .compactMap { try? Data(contentsOf: $0, options: .mappedIfSafe) }
        XCTAssertFalse(binaries.isEmpty, "no app binary found to scan")

        func contains(_ needle: String) -> Bool {
            let bytes = Data(needle.utf8)
            return binaries.contains { $0.range(of: bytes) != nil }
        }

        XCTAssertTrue(
            contains("creation-retains-parent-view"),
            "CreateBrowserNow no longer retains the parent view across CefBrowserHost::"
                + "CreateBrowser. That call does not block and its parent handle is raw, so a panel "
                + "tab dismantled before CreateHostWindow() runs leaves CEF messaging a zombie — "
                + "EXC_BAD_ACCESS on CrBrowserMain, and the app dies with the browser process.")
        XCTAssertTrue(
            contains("creation-abandoned-in-CEFs-queue"),
            "NormaCEFCloseBrowser no longer marks an in-flight creation as abandoned. A tab torn "
                + "down while its creation sits in CEF's own queue has no browser to close yet, so "
                + "without the mark the browser arrives afterwards parented into a discarded view "
                + "and nothing ever closes it — a leaked renderer process per abandoned tab.")
    }

    /// **Closing a browser must RELEASE CEF's host view, not merely detach it.**
    ///
    /// The audio leak: a panel-tab close started and never finished. `DoClose` fired, `OnBeforeClose`
    /// never did, the live-browser count never came down, and the renderer kept playing sound until
    /// the app quit. The cause was a **circular wait** introduced by the record above.
    /// `-[CefBrowserHostView dealloc]` is what calls `AlloyBrowserHostImpl::WindowDestroyed()`, and
    /// once `DoClose` has answered `true` that is the only remaining route to `DestroyBrowser()` —
    /// `CloseContents` computes `close_browser = !handler->DoClose(this)`, so a `true` answer takes
    /// neither branch and resets the destruction state, which makes a second `CloseBrowser(true)` a
    /// no-op loop. So `OnBeforeClose` was waiting for CEF's view to deallocate while
    /// `NormaCEFOpenBrowser.hostView` held that view alive until `OnBeforeClose`.
    ///
    /// **Nothing else in this suite notices.** The close paths still run, still detach, still log,
    /// still return; every symbol and every literal is identical whether the record lets go or keeps
    /// holding. The only observable difference is an object's lifetime, which is what this asserts —
    /// with the seam holding no reference of its own, a `weak` reference that goes `nil` means the
    /// view genuinely deallocated, i.e. `WindowDestroyed()` genuinely ran.
    ///
    /// **What it does NOT cover, stated rather than implied.** The nil-before-release ORDERING
    /// inside `CompleteCloseByReleasingHostView` — which stops a re-entrant `OnBeforeClose` from
    /// releasing a view that is already inside its own `dealloc` — is not observable here, because
    /// nothing in this host can make `OnBeforeClose` fire. Nor are the three call sites or
    /// `RememberOpenBrowser`'s window-handle cast, which need a `CefBrowser` this host cannot
    /// construct; the call sites are covered by the weaker built-product needle in
    /// `testEveryCloseReleasesTheHostViewInTheBuiltProduct`.
    func testClosingABrowserRELEASESCEFsHostViewSoTheCloseCanCOMPLETE() throws {
        // Control. Without it, the assertion below could pass because this harness happened to drop
        // the view for its own reasons rather than because the close did.
        weak var unheld: NSView?
        autoreleasepool {
            let view = NSView(frame: .zero)
            unheld = view
        }
        XCTAssertNil(unheld,
                     "a view with no strong holder did not deallocate at scope exit — the release "
                         + "assertion below cannot distinguish anything in this harness")

        // The container CEF parents its view into, kept alive past the pool so the detach half is
        // readable after the close.
        let container = NSView(frame: .zero)
        weak var hostView: NSView?
        var record: NSObject?
        autoreleasepool {
            let cefView = NSView(frame: .zero)
            container.addSubview(cefView)
            hostView = cefView
            record = NormaCEFRuntime.recordAfterACloseHandsTheHostViewBack(cefView)
            XCTAssertTrue(
                container.subviews.isEmpty,
                "the close did not DETACH CEF's host view from the container. The header makes "
                    + "\"proceeding with window/view hierarchy tear-down\" the host's obligation once "
                    + "DoClose answers true.")
        }

        XCTAssertNotNil(record, "the close seam returned no record at all")
        XCTAssertNil(
            record?.value(forKey: "hostView"),
            "the open-browser record still holds CEF's host view after the close. That view's "
                + "-dealloc is what calls WindowDestroyed(), which is the ONLY route to "
                + "DestroyBrowser()/OnBeforeClose once DoClose has answered true — so holding it is "
                + "not a leak with a tidy-up cost, it is a browser that never closes. Measured: the "
                + "close stalls for as long as the app runs, the renderer never exits, and its audio "
                + "keeps playing after the user closed the tab.")
        XCTAssertNil(
            hostView,
            "CEF's host view is still alive after a close that holds no reference to it — something "
                + "else in NormaCEF.mm retains it, so its -dealloc never runs and OnBeforeClose can "
                + "never fire. This is the audio leak, exactly.")
    }

    /// The release must still be IN the built product, at the close paths.
    ///
    /// Asserted on the binary for the reason the `DoClose` and zombie pins are: nothing in this host
    /// can reach `NormaCEFCloseBrowser`, `NormaCEFCloseAllBrowsers` or `CloseAbandonedBrowser` with
    /// CEF down. The test above proves the release WORKS; this proves the close paths still call it.
    ///
    /// **Known limit, the same one those pins carry:** the needle is the `Log(...)` literal inside
    /// `CompleteCloseByReleasingHostView`, not the call sites themselves. It catches that function
    /// being deleted or gutted — how this actually regressed — and cannot catch one of the three
    /// call sites being removed while the other two keep it. If you change the message, change the
    /// needle with it; the coupling is deliberate and written at both ends.
    func testEveryCloseReleasesTheHostViewInTheBuiltProduct() throws {
        let macOS = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        let binaries = [
            macOS.appendingPathComponent("Norma.debug.dylib"),  // Debug puts the real code here
            macOS.appendingPathComponent("Norma"),              // Release
        ]
        .filter { FileManager.default.fileExists(atPath: $0.path) }
        .compactMap { try? Data(contentsOf: $0, options: .mappedIfSafe) }
        XCTAssertFalse(binaries.isEmpty, "no app binary found to scan")

        let needle = Data("close-releases-CEFs-host-view".utf8)
        XCTAssertTrue(
            binaries.contains { $0.range(of: needle) != nil },
            "the close paths no longer release CEF's host view. Detaching it is not enough: "
                + "-[CefBrowserHostView dealloc] is what calls WindowDestroyed(), the only route to "
                + "OnBeforeClose once DoClose has answered true. Without the release every closed "
                + "panel tab leaves a live browser and a live renderer process — with its audio — "
                + "until the app quits.")
    }

    /// **A browser-client callback must reach its tab WITHOUT touching a view.**
    ///
    /// The third live-gate crash, and the callback-side half of the two pins above. `NormaClient`'s
    /// display and load callbacks used to find the tab by casting
    /// `GetHost()->GetWindowHandle()` to an `NSView` and walking up its superviews looking for the
    /// associated bridge. CEF keeps answering that handle after the view is gone, and Chromium turns
    /// a deallocated ObjC object in the browser process into a `CrZombie` whose first message is a
    /// deliberate crash — so a title update arriving for a tab the user had just switched away from
    /// killed the whole app (`Norma-2026-08-10-152114.ips`, `CrBrowserMain`, `ZombieObjectCrash`
    /// under `NormaClient::OnTitleChange`). Rapid tab switching was the trigger in the pre-runtime
    /// era this crash predates: the panel was one browser per tab, every switch closed a browser
    /// mid-navigation and every switch back reloaded, so title/address/load updates were permanently
    /// in flight against closing browsers. Browser-runtime T4 deleted that churn — a switch is a
    /// container swap now, nothing closes. What the test still pins, present tense: a callback must
    /// reach its tab without touching a view whenever a browser DOES close — the lifecycle engine's
    /// `stop`, itself asynchronous — and that stays real regardless of what triggers the close.
    ///
    /// **What this covers:** that a client hands a real callback the tab it was CONSTRUCTED with. The
    /// tab here has no container view, no association and no browser — objects that could not have
    /// existed together before the fix, since the only route from a callback to a tab was through a
    /// view. Both reverts red it: restore the handle-cast walk in the callback body and there is no
    /// view to walk, so nothing is written; stop storing the reference and the callback finds `nil`,
    /// so nothing is written. `canGoBack` is asserted `false` as the control — a body that wrote
    /// constants rather than its arguments would fail on it instead of passing.
    ///
    /// **What it does NOT cover, stated rather than implied.** Only `OnLoadingStateChange`'s body is
    /// reachable, and only because that body needs no browser: `CEF_REQUIRE_UI_THREAD()` expands to
    /// `DCHECK(CefCurrentlyOn(TID_UI))`, which calls into libcef through a function-pointer table
    /// that stays all-zeroes until the framework is `dlopen`ed — so calling any override in this
    /// host is a null call, not a test, and the same goes for every callback that reads a
    /// `CefBrowser`, `CefFrame` or `CefString`. The other four callbacks (`OnTitleChange`,
    /// `OnAddressChange`, `OnLoadEnd`, `OnBeforePopup`) read the identical member and are pinned
    /// only by review. Also unreachable: `OnBeforeClose` clearing the reference, the open-browser
    /// record that replaced the remaining window-handle casts, and `BrowserForParent` matching a
    /// container to a browser by tab identity — all three need a `CefBrowser`, which nothing in this
    /// host can construct.
    func testAClientCallbackFindsItsTabWITHOUTMessagingAnyView() throws {
        let tab = try XCTUnwrap(
            NormaCEFRuntime.tabAfterOneClientCallbackWithNoViewAnywhere,
            "the client could not be given a tab with no view behind it — the callback-side zombie "
                + "fix (NormaClient::Tab) is gone from NormaCEF.mm")

        XCTAssertEqual(
            tab.value(forKey: "isLoading") as? Bool, true,
            "a NormaClient callback did not write to the tab its client was built with. Either it "
                + "is back to finding the tab by casting CEF's window handle to an NSView and "
                + "walking superviews — which messages a view CEF keeps naming after it is freed, "
                + "and is the ZombieObjectCrash that killed the app at the live gate — or the "
                + "client no longer holds the tab at all. Nothing else in this suite notices: the "
                + "callback, its log lines and every symbol around it are identical either way.")
        XCTAssertEqual(
            tab.value(forKey: "canGoForward") as? Bool, true,
            "the callback wrote isLoading but not canGoForward — the tab state is no longer coming "
                + "from the callback's own arguments")
        XCTAssertEqual(
            tab.value(forKey: "canGoBack") as? Bool, false,
            "canGoBack came back true when the callback was passed false — the body is writing "
                + "constants, so the assertions above prove nothing about what CEF reports")
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

    /// `.web` resolves to the CEF surface, `.diff` to the diff renderer, and the three kinds with no
    /// surface yet keep Plan A's blank placeholder.
    ///
    /// **diff-tabs Task 10 took `.diff` out of the placeholder list — the handoff Task 9 designed.**
    /// Task 9 minted diff tabs (the transcript chip → `ShellSessionHost.openDiffTab`) without
    /// rendering one, and listed `.diff` here TEMPORARILY so this replacement could not be a silent
    /// behaviour change: the loop below failed the moment `PanelDiffTab` landed, and the fix was to
    /// move the case up into its own assertion rather than to delete a pin.
    ///
    /// `.diff` must ALSO never render a browser, which the type check states directly (a `.diff` tab
    /// that resolved to `PanelWebTab` would stand Chromium up for a patch file).
    func testWebTabsResolveToTheCEFSurfaceAndOtherKindsDoNot() {
        let web = PanelTab(tabId: "t1", kind: .web, url: nil, title: nil)
        XCTAssertTrue(panelTabContent(for: web) is PanelWebTab)

        let diff = PanelTab(tabId: "t3", kind: .diff, url: nil, title: "engine.ts", diffId: "diff_1")
        let diffContent = panelTabContent(for: diff)
        XCTAssertTrue(diffContent is PanelDiffTab, "a diff tab renders the diff surface")
        XCTAssertFalse(diffContent is PanelWebTab, "…and never a browser")
        PanelDiffTabModels.removeAllForTesting()

        for kind in [PanelTabKind.document, .code, .note] {
            let tab = PanelTab(tabId: "t2", kind: kind, url: nil, title: nil)
            XCTAssertTrue(panelTabContent(for: tab) is PanelPlaceholderTab,
                          "\(kind) must not render a browser")
        }
    }

    /// Every kind resolves to a REAL SF Symbol, `.diff` included (diff-tabs Task 9's
    /// `plus.forwardslash.minus`) — a favicon name that resolves to nothing draws an empty pill, and
    /// nothing else in the suite would notice.
    func testEveryPanelTabKindHasARealFaviconGlyph() {
        for kind in [PanelTabKind.web, .document, .code, .note, .diff] {
            let name = panelTabFaviconSystemImage(kind)
            XCTAssertNotNil(NSImage(systemSymbolName: name, accessibilityDescription: nil),
                            "\(kind)'s favicon `\(name)` is not a real SF Symbol")
        }
        XCTAssertEqual(panelTabFaviconSystemImage(.diff), "plus.forwardslash.minus",
                       "the diff pill speaks the chip's own -N/+M vocabulary")
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

    // MARK: - B2 Task 3: the CDP door

    /// **The door's whole contract, exercised on the one path XCTest can actually reach.**
    ///
    /// The unit-test host never starts CEF (`testTheRuntimeRefusesToStartCEFUnderXCTest` above is
    /// the structural guard), so every call from here lands on `NormaCEFExecuteCDP`'s
    /// `!g_initialized` branch — which is exactly the branch worth pinning: it is the shape of every
    /// refusal, and "answers rather than hangs" is the property the daemon's always-settles registry
    /// depends on (`packages/core/src/panel/commands.ts`). A door that returned silently here would
    /// turn every verb into a `deadlineMs` timeout the agent cannot tell from a crashed app.
    ///
    /// Synchronously, deliberately: `XCTestExpectation` would pass just as well for a completion
    /// that fired one run-loop turn later, and the failure this guards is one that fires NEVER.
    func testTheCDPDoorAlwaysAnswersItsCompletionEvenWithCEFDown() {
        let container = PanelCEFContainerView()
        var answers: [(ok: Bool, payload: String)] = []
        NormaCEFRuntime.executeCDP(in: container, method: "Runtime.evaluate",
                                   paramsJSON: #"{"expression":"1+1"}"#) { ok, payload in
            answers.append((ok, payload))
        }
        XCTAssertEqual(answers.count, 1,
                       "the CDP door must answer exactly once, synchronously, when it refuses — a "
                           + "silent return is a panel_command that can only ever time out")
        XCTAssertEqual(answers.first?.ok, false)

        // The failure payload is a JSON OBJECT carrying `message`, which is what the header promises
        // both ways round and what `PanelCDPReply` parses. A bare reason string would decode as
        // nothing and the consumer would report "the browser gave no reason".
        let payload = answers.first?.payload ?? ""
        let object = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any]
        XCTAssertNotNil(object?["message"] as? String,
                        "a refusal's payload must be {\"message\": …} JSON, got \(payload)")

        // An empty method is refused before anything else is even looked at.
        var second: [Bool] = []
        NormaCEFRuntime.executeCDP(in: container, method: "", paramsJSON: nil) { ok, _ in
            second.append(ok)
        }
        XCTAssertEqual(second, [false])
    }

    /// **Exactly one completion per reply, and a stranded call is FAILED rather than dropped** — the
    /// correlation half of the door, produced rather than inferred.
    ///
    /// No needle can ask this (the correlation is a dictionary lookup and the fail-all is a loop,
    /// neither of which leaves a literal), and the real path cannot be reached from here: registering
    /// the observer needs a `CefBrowser` this host can never create. So the registry is driven
    /// directly and hands back a transcript — see `NormaCEF.h` for the fixture's shape.
    ///
    /// Three properties, one string: the reply settles the call that asked for it and nothing else
    /// (`A1` fires, `B1` does not); a second reply for the same id fires nothing (`A1` appears once);
    /// and a browser going away fires every call it stranded (`A2` and `B1` both come back `ok=0`
    /// with a reason). Drop the erase-before-call in `SettlePendingCDP` and `A1` doubles; drop
    /// `FailAllPendingCDP`'s call from `NormaCEFCloseBrowser`/`ForgetOpenBrowser` and the consumer
    /// waits out its whole deadline for a browser that is already gone.
    func testAPendingCDPCallSettlesEXACTLYOnceAndAStrandedOneIsFAILEDNotDropped() {
        let transcript = NormaCEFRuntime.pendingCDPTranscriptWithNoCEFAnywhere
        let fired = transcript.split(separator: ";").map(String.init)

        XCTAssertEqual(fired.count, 3, "expected A1, A2, B1 exactly once each — got \(transcript)")
        XCTAssertEqual(fired.first, #"A1 ok=1 {"value":1}"#,
                       "the reply must settle the call whose message id it names, with its payload "
                           + "verbatim — got \(transcript)")
        XCTAssertFalse(fired.dropFirst().contains { $0.hasPrefix("A1 ") },
                       "a second reply for a settled id must fire nothing — got \(transcript)")
        XCTAssertTrue(fired.contains { $0.hasPrefix("A2 ok=0 ") },
                      "a call stranded by its browser closing must be FAILED, never left silent — "
                          + "got \(transcript)")
        XCTAssertTrue(fired.contains { $0.hasPrefix("B1 ok=0 ") },
                      "the other browser's call must survive A's close and then fail on its own — "
                          + "got \(transcript)")
        XCTAssertTrue(transcript.contains("the tab's browser was closed"),
                      "the failure must carry a reason the agent can read — got \(transcript)")
    }

    /// **The observer is registered for every browser CEF creates**, which is what makes a reply
    /// reachable at all: `ExecuteDevToolsMethod` submits, and the answer arrives only through an
    /// observer added with `AddDevToolsMessageObserver` (`cef_browser.h`).
    ///
    /// **Known limit, the same one every needle in this file carries:** it is a `Log` literal sitting
    /// BESIDE the registration, so deleting only the `AddDevToolsMessageObserver` line would leave it
    /// in the binary. What it does close is the deletion that is actually plausible — the whole block
    /// going, or the registration moving out of `RememberOpenBrowser` and losing its lifetime
    /// symmetry with the browser record. The correlation itself is covered by the produced test
    /// above, and what CEF does with the registration is not observable from any test host.
    ///
    /// If you change that log message, change this needle with it — the coupling is deliberate and
    /// written at both ends.
    func testTheDevToolsObserverIsRegisteredForEveryBrowserInTheBuiltProduct() throws {
        XCTAssertTrue(try appBinaryContains("cdp-observer-registered"),
                      "NormaCEF.mm no longer registers a CefDevToolsMessageObserver when a browser "
                          + "is created. Every CDP call would then submit successfully and never be "
                          + "answered — the browser tool's verbs would all read as timeouts.")
    }

    /// **A browser going away fails the calls it stranded** — the built-product half of the produced
    /// test above, and the one that says the fail-all is wired into the close paths at all.
    ///
    /// The needle is the `Log` literal INSIDE `FailAllPendingCDP`, past its "nothing pending" early
    /// return — so unlike an adjacent-log needle it cannot survive that function being deleted. It
    /// can still survive the function keeping its three CALLERS' lines removed, which is what the
    /// produced test covers from the other side.
    ///
    /// If you change that log message, change this needle with it.
    func testAClosedBrowsersInFlightCDPCallsAreFailedInTheBuiltProduct() throws {
        XCTAssertTrue(try appBinaryContains("cdp-pending-failed"),
                      "NormaCEF.mm no longer fails in-flight CDP calls when a browser closes. Each "
                          + "one becomes silence, and the daemon's pending command runs out its "
                          + "whole deadlineMs before the agent hears anything.")
    }
}
