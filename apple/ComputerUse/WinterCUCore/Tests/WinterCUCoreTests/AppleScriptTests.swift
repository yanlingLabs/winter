import ApplicationServices
import Carbon
import CoreGraphics
import XCTest
@testable import WinterCUCore

/// AppleScript as an extra door: the source check, the per-event verdicts, the scripting-dictionary summary,
/// and the menu commands done through AppleScript — on fakes (nothing here runs a script).
final class AppleScriptTests: XCTestCase {
    let finder = CUAppleScriptPolicy.BoundApp(name: "Finder", bundleId: "com.apple.finder", path: "/System/Library/CoreServices/Finder.app")

    private func refused(_ source: String, _ bound: CUAppleScriptPolicy.BoundApp? = nil, file: StaticString = #filePath, line: UInt = #line) -> String? {
        do {
            try CUAppleScriptPolicy.checkSource(source, bound: bound ?? finder)
            XCTFail("expected a refusal: \(source)", file: file, line: line)
            return nil
        } catch let e as CUError {
            return e.message
        } catch {
            XCTFail("\(error)", file: file, line: line)
            return nil
        }
    }

    // MARK: the source

    func testTheBoundAppMayBeNamedLiterallyAndNothingElse() throws {
        try CUAppleScriptPolicy.checkSource("tell application \"Finder\" to get name of every item of desktop", bound: finder)
        try CUAppleScriptPolicy.checkSource("tell app \"finder\"\n  count windows\nend tell", bound: finder)
        try CUAppleScriptPolicy.checkSource("tell application id \"com.apple.finder\" to get selection", bound: finder)
        try CUAppleScriptPolicy.checkSource("tell application \"/System/Library/CoreServices/Finder.app\" to get name", bound: finder)
        try CUAppleScriptPolicy.checkSource("tell application \"Finder\" to get every application file of folder \"Applications\" of startup disk", bound: finder)
        // Inside strings and comments, anything goes.
        try CUAppleScriptPolicy.checkSource("-- tell application \"System Events\"\n(* use framework \"Foundation\" *)\nreturn \"current application of app X\"", bound: finder)
        XCTAssertTrue(refused("tell application \"System Events\" to keystroke \"a\"")?.contains("it names “System Events”, but only the bound app, Finder, may be scripted") ?? false)
        XCTAssertTrue(refused("tell application id \"com.apple.Safari\" to get URL of document 1")?.contains("the app id “com.apple.Safari”") ?? false)
        XCTAssertTrue(refused("set a to \"Finder\"\ntell application a to get name")?.contains("name the app with a literal") ?? false)
        XCTAssertTrue(refused("tell application \"System Events\" to get every application process")?.contains("System Events") ?? false)
    }

    func testTheInProcessBridgesAreRefusedHoweverTheyAreSpelt() {
        XCTAssertTrue(refused("use framework \"Foundation\"\nreturn 1")?.contains("AppleScriptObjC") ?? false)
        XCTAssertTrue(refused("use ¬\n  framework \"Foundation\"")?.contains("AppleScriptObjC") ?? false, "a continuation")
        XCTAssertTrue(refused("USE   Framework \"AppKit\"")?.contains("AppleScriptObjC") ?? false)
        XCTAssertTrue(refused("use script \"MyLib\"")?.contains("script libraries") ?? false)
        XCTAssertTrue(refused("return current application's NSProcessInfo's processInfo()")?.contains("Winter's helper itself") ?? false)
        XCTAssertTrue(refused("return «class ocid» of x")?.contains("Objective-C") ?? false)
    }

    // MARK: each Apple Event

    private func verdict(_ cls: String, _ id: String, to pid: pid_t?) -> CUAppleScriptPolicy.Verdict {
        CUAppleScriptPolicy.verdict(eventClass: cls, eventID: id, targetPid: pid, ownPid: 100, boundPid: 608, boundName: "Finder")
    }

    func testEventsToTheBoundAppPassAndTheDoorsAreRefusedWhereverAddressed() {
        XCTAssertEqual(verdict("core", "getd", to: 608), .allow, "Finder's own get")
        XCTAssertEqual(verdict("core", "delo", to: 608), .allow, "Finder's own delete")
        XCTAssertEqual(verdict("ascr", "noop", to: 608), .allow, "launch: the app is already running")
        // Standard Additions run in the process they're addressed to: refused at the bound app too.
        if case .refuse(let why) = verdict("syso", "exec", to: 608) { XCTAssertTrue(why.contains("`do shell script` runs a shell")) } else { XCTFail() }
        if case .refuse(let why) = verdict("syso", "exec", to: 100) { XCTAssertTrue(why.contains("(syso/exec)")) } else { XCTFail() }
        if case .refuse(let why) = verdict("misc", "actv", to: 608) { XCTAssertTrue(why.contains("`activate` would bring the app in front")) } else { XCTFail() }
        XCTAssertNotEqual(verdict("aevt", "rapp", to: 608), .allow, "reopen")
        XCTAssertNotEqual(verdict("aevt", "oapp", to: 608), .allow, "run")
        XCTAssertNotEqual(verdict("sfri", "dojs", to: 608), .allow, "do JavaScript")
        XCTAssertNotEqual(verdict("GURL", "GURL", to: 608), .allow, "open location")
        XCTAssertNotEqual(verdict("rdwr", "read", to: 608), .allow, "file reads")
        XCTAssertNotEqual(verdict("Jons", "gClp", to: 100), .allow, "the clipboard")
        XCTAssertNotEqual(verdict("syso", "dlog", to: 100), .allow, "display dialog")
        XCTAssertNotEqual(verdict("fndr", "gstl", to: 100), .allow, "system attribute")
        XCTAssertNotEqual(verdict("ascr", "psbr", to: 100), .allow, "the ObjC bridge")
        XCTAssertNotEqual(verdict("syso", "dsct", to: 100), .allow, "run script")
    }

    func testOtherAppsAndUnknownTargetsAreRefusedAndTheLanguagesHelpersPass() {
        if case .refuse(let why) = verdict("core", "getd", to: 777) {
            XCTAssertTrue(why.contains("only the bound app, Finder, may be scripted"), why)
        } else { XCTFail() }
        XCTAssertNotEqual(verdict("prcs", "kprs", to: 777), .allow, "System Events keystrokes")
        XCTAssertNotEqual(verdict("core", "getd", to: nil), .allow, "an address that can't be told")
        for (cls, id) in [("misc", "curd"), ("syso", "rond"), ("syso", "rand"), ("syso", "offs"), ("syso", "ntoc"), ("syso", "GMT "),
                          ("ascr", "cmnt"), ("ears", "ffdr")] {
            XCTAssertEqual(verdict(cls, id, to: 100), .allow, "\(cls)/\(id) in the script's own process")
        }
        XCTAssertNotEqual(verdict("core", "getd", to: 100), .allow, "nothing else in the helper itself")
        XCTAssertNotEqual(verdict("ears", "lfdr", to: 100), .allow, "list folder")
    }

    // MARK: the scripting dictionary

    private let sdef = """
        <?xml version="1.0" encoding="UTF-8"?>
        <dictionary>
          <suite name="Test Suite" code="test">
            <command name="sweep" code="testswep" description="Sweep the floor.">
              <direct-parameter type="specifier" description="what to sweep"/>
              <parameter name="with" code="with" type="text" optional="yes"/>
              <result type="boolean"/>
            </command>
            <command name="secret" code="testsecr" hidden="yes"/>
            <class name="broom" code="brom" description="A broom.">
              <property name="bristles" code="bris" type="integer" access="r"/>
              <property name="colour" code="colr" type="text"/>
              <element type="handle"/>
            </class>
            <class-extension extends="application">
              <property name="dustiness" code="dust" type="real"/>
            </class-extension>
          </suite>
        </dictionary>
        """

    func testTheDictionaryIsSummarisedCompactlyAndSearchable() throws {
        let model = try CUScriptingDictionary.parse(Data(sdef.utf8))
        XCTAssertEqual(model.suites, ["Test Suite"])
        XCTAssertEqual(model.commands.map(\.name), ["sweep"], "hidden commands left out")
        let full = CUScriptingDictionary.render(model, app: "Cleaner", search: nil)
        XCTAssertFalse(full.truncated)
        XCTAssertTrue(full.text.contains("- sweep <specifier> [with <text>] → boolean — Sweep the floor."), full.text)
        XCTAssertTrue(full.text.contains("- broom — A broom.; properties: bristles (integer, read-only), colour (text); elements: handle"), full.text)
        XCTAssertTrue(full.text.contains("- application (more); properties: dustiness (real)"), full.text)
        let found = CUScriptingDictionary.render(model, app: "Cleaner", search: "colour")
        XCTAssertTrue(found.text.contains("colour (text)"))
        XCTAssertFalse(found.text.contains("sweep"), "filtered")
        XCTAssertFalse(found.text.contains("bristles"), "only the matching properties of a class matched by one")
        let none = CUScriptingDictionary.render(model, app: "Cleaner", search: "zzz")
        XCTAssertTrue(none.text.contains("nothing matches"))
    }

    func testABigDictionaryIsCappedWithAWayToNarrowIt() {
        let commands = (0..<400).map {
            CUScriptingDictionary.Command(name: "command\($0)", description: String(repeating: "x", count: 40), direct: nil, parameters: [], result: nil)
        }
        let model = CUScriptingDictionary.Model(suites: ["Big"], commands: commands, classes: [])
        let r = CUScriptingDictionary.render(model, app: "Big", search: nil)
        XCTAssertTrue(r.truncated)
        XCTAssertLessThanOrEqual(r.text.utf8.count, 6_300)
        XCTAssertTrue(r.text.hasSuffix("narrow it with scriptingDictionary({ search: \"…\" }) (a command, class or property name)"), r.text)
    }

    // MARK: the door on a bound target

    let pid: pid_t = 6161
    let window = fakeElement(96_001)
    var ax: FakeAX!
    var sys: FakeSystem!
    var core: CUCore!
    var target: CUTarget!
    var ran: [String] = []

    private func bound(bundleId: String = "com.apple.finder", app: String = "Finder", permission: OSStatus = OSStatus(noErr)) {
        ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Downloads", frame: CGRect(x: 0, y: 0, width: 800, height: 500))
        ax.windowIDs[AXIdentity(element: window)] = 77
        sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = bundleId
        sys.windows[77] = FakeSystem.window(77, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 500), owner: app)
        sys.front = 1
        core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                      pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        ran = []
        core.appleScriptOverride = { [unowned self] source, _ in ran.append(source); return "Downloads" }
        core.automationPermissionOverride = { _ in permission }
        target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: bundleId, appName: app,
                          isChromium: false, mirror: false, windowID: 77, windowTitle: "Downloads")
        core.registerForTesting(target, windowElement: window)
        target.refs.beginGeneration()
    }

    private func expectRefused(_ p: TargetAppleScriptParams, _ text: String, file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await core.targetAppleScript(p)
            XCTFail("expected a refusal", file: file, line: line)
        } catch let e as CUError {
            XCTAssertEqual(e.code, "refused", e.message, file: file, line: line)
            XCTAssertTrue(e.message.contains(text), e.message, file: file, line: line)
        } catch {
            XCTFail("\(error)", file: file, line: line)
        }
    }

    func testAScriptForTheBoundAppRunsAndItsResultComesBack() async throws {
        bound()
        let r = try await core.targetAppleScript(TargetAppleScriptParams(targetId: "t1", source: "tell application \"Finder\" to get name of front window"))
        XCTAssertEqual(r.result, "Downloads")
        XCTAssertNil(r.detail)
        XCTAssertEqual(ran.count, 1)
    }

    func testJavaScriptAnotherAppAndADeniedGrantAreRefusedBeforeAnythingRuns() async {
        bound()
        await expectRefused(TargetAppleScriptParams(targetId: "t1", source: "Application('Finder').name()", language: "javascript"),
                            "its Objective-C bridge runs Cocoa inside Winter's helper")
        await expectRefused(TargetAppleScriptParams(targetId: "t1", source: "tell application \"Terminal\" to do script \"ls\""),
                            "only the bound app, Finder, may be scripted")
        bound(permission: OSStatus(errAEEventNotPermitted))
        await expectRefused(TargetAppleScriptParams(targetId: "t1", source: "tell application \"Finder\" to get name"),
                            "the user has not allowed Winter Computer Use to control Finder")
        XCTAssertTrue(ran.isEmpty)
    }

    func testTheFirstScriptSaysMacOSAskedTheUser() async throws {
        bound(permission: OSStatus(errAEEventWouldRequireUserConsent))
        let r = try await core.targetAppleScript(TargetAppleScriptParams(targetId: "t1", source: "tell application \"Finder\" to get name"))
        XCTAssertEqual(r.detail, "macOS asked the user to let Winter Computer Use control Finder")
    }

    func testAScriptThatBringsTheAppForwardIsPutBack() async throws {
        bound()
        core.appleScriptOverride = { [unowned self] _, _ in sys.front = pid; return nil }  // e.g. Finder's open activating
        let r = try await core.targetAppleScript(TargetAppleScriptParams(targetId: "t1", source: "tell application \"Finder\" to get name"))
        XCTAssertEqual(sys.activated, [1])
        XCTAssertEqual(r.detail, "Finder activated itself — the user's app was put back")
    }

    func testTheDictionaryOfANonScriptableAppSaysSo() async throws {
        bound()
        core.scriptingDictionaryOverride = { _ in nil }
        let none = try await core.targetScriptingDictionary(TargetScriptingDictionaryParams(targetId: "t1"))
        XCTAssertEqual(none, TargetScriptingDictionaryResult(scriptable: false))
        let model = try CUScriptingDictionary.parse(Data(sdef.utf8))
        core.scriptingDictionaryOverride = { _ in model }
        let some = try await core.targetScriptingDictionary(TargetScriptingDictionaryParams(targetId: "t1", search: "broom"))
        XCTAssertTrue(some.scriptable)
        XCTAssertTrue(some.text?.contains("- broom") ?? false)
    }

    // MARK: menu commands through AppleScript

    private func finderWindow(selected: [String], folder: String? = "file:///Users/u/Downloads/") {
        var children: [AXUIElement] = []
        for (i, name) in selected.enumerated() {
            let item = fakeElement(96_100 + Int32(i))
            ax.add(item, role: kAXImageRole, title: name, extra: [kAXSelectedAttribute: true])
            children.append(item)
        }
        let other = fakeElement(96_200)
        ax.add(other, role: kAXImageRole, title: "notes.txt", extra: [kAXSelectedAttribute: false])
        ax.put(window, [kAXChildrenAttribute: children + [other]])
        if let folder { ax.put(window, ["AXDocument": folder]) }
        let bar = fakeElement(96_300), file = fakeElement(96_301), menu = fakeElement(96_302), trash = fakeElement(96_303)
        ax.put(ax.application(pid), [kAXMenuBarAttribute: bar])
        ax.put(bar, [kAXChildrenAttribute: [file]])
        ax.add(file, role: "AXMenuBarItem", title: "File", extra: [kAXChildrenAttribute: [menu]])
        ax.add(menu, role: kAXMenuRole, extra: [kAXChildrenAttribute: [trash]])
        ax.add(trash, role: kAXMenuItemRole, title: "Move to Trash", extra: [kAXEnabledAttribute: false])
        ax.setActions(trash, [kAXPressAction])
    }

    private func moveToTrash() async throws -> TargetActResult {
        try await core.targetAct(TargetActParams(targetId: "t1", sessionId: "s", callId: "c", action: .menu(CUMenuAction(path: ["File", "Move to Trash"])),
                                                 access: .full, allowForeground: false, privatePath: true))
    }

    func testADisabledMoveToTrashIsDoneThroughAppleScriptOnTheBoundWindowsOwnSelection() async throws {
        bound()
        finderWindow(selected: ["report \"final\".pdf", "a.txt"])
        let r = try await moveToTrash()
        XCTAssertEqual(ran, [#"tell application "Finder" to delete (every item of folder (POSIX file "/Users/u/Downloads" as alias) whose name is in {"report \"final\".pdf", "a.txt"})"#])
        XCTAssertEqual(r.rung, 1)
        XCTAssertEqual(r.detail, "“Move to Trash” is disabled while Finder is in the background, so it was done through AppleScript (Finder's delete of 2 selected items)")
    }

    func testWithoutAGrantOrASelectionTheUIRoutesAnswerAndNothingRuns() async throws {
        bound(permission: OSStatus(errAEEventWouldRequireUserConsent))
        finderWindow(selected: ["a.txt"])
        do { _ = try await moveToTrash(); XCTFail() } catch let e as CUError {
            XCTAssertEqual(e.code, "unsupported")
            XCTAssertTrue(e.message.contains("or app.applescript() (macOS asks the user once to let Winter control Finder)"), e.message)
        }
        XCTAssertTrue(ran.isEmpty, "routing never raises macOS's question on its own")
        bound()
        finderWindow(selected: [])
        do { _ = try await moveToTrash(); XCTFail() } catch let e as CUError { XCTAssertEqual(e.code, "unsupported") }
        XCTAssertTrue(ran.isEmpty, "no selection read: no script")
        bound()
        finderWindow(selected: ["a.txt"], folder: nil)
        do { _ = try await moveToTrash(); XCTFail() } catch let e as CUError { XCTAssertEqual(e.code, "unsupported") }
        XCTAssertTrue(ran.isEmpty, "no folder read: no script")
    }

    func testSafarisKnownScriptsNameTheBoundWindow() {
        bound(bundleId: "com.apple.Safari", app: "Safari")
        XCTAssertEqual(core.knownMenuScript(["File", "New Tab"], target)?.source,
                       "tell application \"Safari\" to tell window id 77 to set current tab to (make new tab)")
        XCTAssertEqual(core.knownMenuScript(["View", "Reload Page"], target)?.source,
                       "tell application \"Safari\" to tell window id 77 to set URL of current tab to (URL of current tab)")
        XCTAssertNil(core.knownMenuScript(["File", "Print…"], target))
        // Every known script passes the same source check as the model's.
        for path in [["File", "New Tab"], ["View", "Reload Page"]] {
            XCTAssertNoThrow(try CUAppleScriptPolicy.checkSource(core.knownMenuScript(path, target)!.source, bound: core.boundApp(target)))
        }
    }
}
