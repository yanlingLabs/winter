import ApplicationServices
import Carbon
import XCTest
@testable import WinterCUCore

/// `target.scriptingCommands` (helper 1.8.0) on fixture sdefs: the structured command list the daemon's typed
/// wrappers are made from — codes, suites, descriptions, enumerations, hidden things and the refused doors left out,
/// the search and the cap — and the JavaScript doors refused: Chromium's `execute` by its code everywhere, and any
/// app's own by its dictionary.
final class ScriptingCommandsTests: XCTestCase {
    /// A browser-like dictionary: an enumeration, a hidden suite, a JavaScript door by another name, a refused door.
    let sdef = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE dictionary SYSTEM "file://localhost/System/Library/DTDs/sdef.dtd">
        <dictionary title="Fixture Terminology">
          <suite name="Standard Suite" code="core">
            <command name="close" code="coreclos" description="Close a window.">
              <direct-parameter type="specifier" description="the window to close"/>
              <parameter name="saving" code="savo" type="save options" optional="yes" description="Should changes be saved before closing?"/>
              <parameter name="saving in" code="kfil" type="file" optional="yes"/>
            </command>
            <command name="activate" code="miscactv" description="Bring it forward."/>
            <command name="open location" code="GURLGURL"><direct-parameter type="text"/></command>
            <enumeration name="save options" code="savo">
              <enumerator name="yes" code="yes "/>
              <enumerator name="no" code="no  "/>
              <enumerator name="ask" code="ask "/>
              <enumerator name="secret" code="secr" hidden="yes"/>
            </enumeration>
          </suite>
          <suite name="Browser Suite" code="Brws">
            <command name="reload" code="BrwsRlod" description="Reload a tab.">
              <direct-parameter type="specifier"/>
            </command>
            <command name="run snippet" code="BrwsSnip" description="Run code in a page.">
              <direct-parameter type="specifier"/>
              <parameter name="javascript" code="JvSc" type="text"/>
            </command>
            <command name="execute" code="CrSuExJa" description="Execute a piece of javascript.">
              <direct-parameter type="specifier"/>
              <parameter name="javascript" code="JvSc" type="text"/>
            </command>
            <command name="tag" code="BrwsTags">
              <parameter name="with" code="with" type="list of text" optional="yes"/>
              <parameter name="mode" code="mode" type="save options | text" optional="yes"/>
              <result type="boolean"/>
            </command>
            <command name="internal" code="BrwsIntl" hidden="yes"/>
          </suite>
          <suite name="Private Suite" code="Priv" hidden="yes">
            <command name="debug dump" code="PrivDump"/>
          </suite>
        </dictionary>
        """

    func testTheCommandsComeStructuredWithCodesSuitesDescriptionsAndEnumerators() throws {
        let model = try CUScriptingDictionary.parse(Data(sdef.utf8))
        let (commands, truncated) = CUScriptingDictionary.commands(model, search: nil)
        XCTAssertFalse(truncated)
        XCTAssertEqual(commands.map(\.name), ["close", "reload", "tag"],
                       "activate, open location, the JavaScript doors (by name and by code), hidden commands and hidden suites are left out")
        let close = try XCTUnwrap(commands.first)
        XCTAssertEqual(close.suite, "Standard Suite")
        XCTAssertEqual(close.eventCode, "coreclos")
        XCTAssertEqual(close.description, "Close a window.")
        XCTAssertEqual(close.direct, ScriptingCommandDirect(type: "specifier", optional: false, description: "the window to close"))
        XCTAssertEqual(close.params, [
            ScriptingCommandParam(name: "saving", type: "save options", optional: true, description: "Should changes be saved before closing?",
                                  enumerators: ["yes", "no", "ask"]),
            ScriptingCommandParam(name: "saving in", type: "file", optional: true),
        ])
        let tag = try XCTUnwrap(commands.last)
        XCTAssertNil(tag.direct)
        XCTAssertEqual(tag.params.first?.type, "list of text")
        XCTAssertEqual(tag.params.last?.enumerators, ["yes", "no", "ask"], "an alternative naming an enumeration carries its enumerators")
        XCTAssertEqual(tag.result, ScriptingCommandResultType(type: "boolean"))
    }

    func testTheWireShapeOmitsWhatIsAbsent() throws {
        let model = try CUScriptingDictionary.parse(Data(sdef.utf8))
        let (commands, _) = CUScriptingDictionary.commands(model, search: "reload")
        let json = String(decoding: try JSONEncoder().encode(TargetScriptingCommandsResult(scriptable: true, bundleVersion: "7", commands: commands)), as: UTF8.self)
        XCTAssertTrue(json.contains(#""eventCode":"BrwsRlod""#), json)
        XCTAssertTrue(json.contains(#""params":[]"#), json)
        XCTAssertFalse(json.contains("truncated"), json)
        XCTAssertFalse(json.contains(#""optional":true,"description""#), json)
        let decoded = try JSONDecoder().decode(TargetScriptingCommandsResult.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.commands.map(\.name), ["reload"])
    }

    func testTheSearchAndTheCap() throws {
        let model = try CUScriptingDictionary.parse(Data(sdef.utf8))
        XCTAssertEqual(CUScriptingDictionary.commands(model, search: "SAVING").commands.map(\.name), ["close"], "a parameter's name matches")
        XCTAssertEqual(CUScriptingDictionary.commands(model, search: "a tab").commands.map(\.name), ["reload"], "a description matches")
        XCTAssertEqual(CUScriptingDictionary.commands(model, search: "zzz").commands, [])
        let many = (0..<350).map {
            CUScriptingDictionary.Command(name: "cmd\($0)", description: String(repeating: "d", count: 400), direct: nil, parameters: [],
                                          result: nil, suite: "Big", code: String(format: "Bigs%04d", $0))
        }
        let big = CUScriptingDictionary.commands(CUScriptingDictionary.Model(suites: ["Big"], commands: many, classes: []), search: nil)
        XCTAssertEqual(big.commands.count, CUScriptingDictionary.maxCommands)
        XCTAssertTrue(big.truncated)
        XCTAssertEqual(big.commands.first?.description?.count, 200, "descriptions are cut at 200 characters")
    }

    func testABadEventCodeIsLeftOut() {
        let model = CUScriptingDictionary.Model(suites: ["X"], commands: [
            CUScriptingDictionary.Command(name: "short", description: "", direct: nil, parameters: [], result: nil, suite: "X", code: "abc"),
            CUScriptingDictionary.Command(name: "fine", description: "", direct: nil, parameters: [], result: nil, suite: "X", code: "abcdefgh"),
        ], classes: [])
        XCTAssertEqual(CUScriptingDictionary.commands(model, search: nil).commands.map(\.name), ["fine"])
        XCTAssertEqual(CUScriptingDictionary.eventKey("CrSuExJa"), "CrSu/ExJa")
        XCTAssertNil(CUScriptingDictionary.eventKey("short"))
    }

    // MARK: the JavaScript doors

    private func verdict(_ cls: String, _ id: String, alsoRefused: [String: String] = [:]) -> CUAppleScriptPolicy.Verdict {
        CUAppleScriptPolicy.verdict(eventClass: cls, eventID: id, targetPid: 608, ownPid: 100, boundPid: 608, boundName: "Google Chrome",
                                    alsoRefused: alsoRefused)
    }

    func testChromiumsExecuteJavaScriptIsRefusedEverywhere() {
        if case .refuse(let why) = verdict("CrSu", "ExJa") {
            XCTAssertTrue(why.contains("execute … javascript"), why)
            XCTAssertTrue(why.contains("(CrSu/ExJa)"), why)
        } else { XCTFail("Chromium's execute must be refused") }
        XCTAssertTrue(CUAppleScriptPolicy.refusesEverywhere("CrSu/ExJa"))
        XCTAssertTrue(CUAppleScriptPolicy.refusesEverywhere("sfri/dojs"))
        XCTAssertTrue(CUAppleScriptPolicy.refusesEverywhere("syso/anything"), "a refused class")
        XCTAssertFalse(CUAppleScriptPolicy.refusesEverywhere("core/getd"))
        XCTAssertEqual(verdict("CrSu", "Rlod"), .allow, "the browser's other commands are the bound app's own")
    }

    func testAnAppsOwnJavaScriptDoorIsRefusedByItsDictionary() throws {
        let model = try CUScriptingDictionary.parse(Data(sdef.utf8))
        let doors = CUScriptingDictionary.javaScriptDoorRefusals(model)
        XCTAssertEqual(Set(doors.keys), ["Brws/Snip", "CrSu/ExJa"])
        if case .refuse(let why) = verdict("Brws", "Snip", alsoRefused: doors) {
            XCTAssertTrue(why.contains("`run snippet` runs JavaScript"), why)
        } else { XCTFail("a JavaScript door by another name must be refused for this app") }
        XCTAssertEqual(verdict("Brws", "Snip"), .allow, "without the app's dictionary it is just the bound app's event")
    }

    // MARK: the door on a bound target

    let pid: pid_t = 6262
    let window = fakeElement(97_001)

    private func bound(model: CUScriptingDictionary.Model?) -> CUCore {
        let ax = FakeAX()
        ax.put(ax.application(pid), [kAXWindowsAttribute: [window]])
        ax.add(window, role: kAXWindowRole, title: "Fixture", frame: CGRect(x: 0, y: 0, width: 800, height: 500))
        ax.windowIDs[AXIdentity(element: window)] = 78
        let sys = FakeSystem()
        sys.running = [pid, 1]
        sys.bundles[pid] = "dev.example.browser"
        sys.windows[78] = FakeSystem.window(78, pid: pid, CGRect(x: 0, y: 0, width: 800, height: 500), owner: "Browser")
        sys.front = 1
        let core = CUCore(events: nil, clock: CUSystemClock(), skyLight: .none, poster: RecordingPoster(), ax: ax, sys: sys,
                          pasteboard: { PasteAndQueueTests.FakePasteboard([]) }, startMonitors: false)
        core.scriptingDictionaryOverride = { _ in model }
        core.appleScriptOverride = { _, _ in XCTFail("scriptingCommands never runs a script"); return nil }
        let target = CUTarget(id: "t1", sessionId: "s", pid: pid, bundleId: "dev.example.browser", appName: "Browser",
                              isChromium: true, mirror: false, windowID: 78, windowTitle: "Fixture")
        core.registerForTesting(target, windowElement: window)
        return core
    }

    func testTargetScriptingCommandsReadsTheDictionaryAndNeverTheApp() async throws {
        let model = try CUScriptingDictionary.parse(Data(sdef.utf8))
        let core = bound(model: model)
        let r = try await core.targetScriptingCommands(TargetScriptingCommandsParams(targetId: "t1", search: "close"))
        XCTAssertTrue(r.scriptable)
        XCTAssertEqual(r.commands.map(\.name), ["close"])
        XCTAssertEqual(core.javaScriptDoorRefusals(try core.target("t1")).keys.sorted(), ["Brws/Snip", "CrSu/ExJa"])
        let none = bound(model: nil)
        let n = try await none.targetScriptingCommands(TargetScriptingCommandsParams(targetId: "t1"))
        XCTAssertFalse(n.scriptable)
        XCTAssertEqual(n.commands, [])
        do {
            _ = try await none.targetScriptingCommands(TargetScriptingCommandsParams(targetId: "t9"))
            XCTFail("an unknown target")
        } catch let e as CUError { XCTAssertEqual(e.code, "target_lost") }
    }

    func testABoundAppsFactsComeFromItsBundle() {
        XCTAssertTrue(CUCore.bundleFacts(nil) == (nil, nil))
        let me = NSRunningApplication.current
        let facts = CUCore.bundleFacts(me)
        XCTAssertEqual(facts.path, me.bundleURL?.path)
    }

    func testABoundAppGainsPathAndVersionOnTheWire() throws {
        let json = String(decoding: try JSONEncoder().encode(CUBoundApp(name: "Notes", bundleId: "com.apple.Notes", pid: 5, path: "/System/Applications/Notes.app", version: "4.11")), as: UTF8.self)
        XCTAssertTrue(json.contains(#""path":"\/System\/Applications\/Notes.app""#) || json.contains(#""path":"/System/Applications/Notes.app""#), json)
        XCTAssertTrue(json.contains(#""version":"4.11""#), json)
        let bare = String(decoding: try JSONEncoder().encode(CUBoundApp(name: "Notes", bundleId: "com.apple.Notes", pid: 5)), as: UTF8.self)
        XCTAssertFalse(bare.contains("path"), "absent fields are left out (protocol 1, additive)")
    }
}
