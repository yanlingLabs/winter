import XCTest
import WinterProtocol
@testable import Winter

/// ComputerV2 tool rows: the label a call wears (`title`, else what its script reveals, else "Using the
/// computer"), how the reducer carries the label and the script, and what the transcript sentence, the
/// pill and the expanded row are given. The script is model-authored text, so the derivation is also
/// held to malformed and hostile input.
///
/// **What this file does NOT cover: the drawn row.** `TranscriptToolGroupRow` and `PillToolRunHeader` are
/// SwiftUI views; nothing here proves the monospace block is visible or the pill shimmers. What is proven
/// is that they are GIVEN the right words and the right script.
final class ComputerV2ToolRowTests: XCTestCase {
    private let notesScript = """
    const notes = await apps.open("Notes");
    await notes.click(12);
    await notes.paste("milk, eggs");
    await notes.state();
    """

    // MARK: - The label: title

    func testATitleIsTheLabel() {
        XCTAssertEqual(computerV2Label(title: "Add milk to the list", code: notesScript), "Add milk to the list")
    }

    func testATitleIsOneCleanLineNoLongerThanTheSchemaAllows() {
        XCTAssertEqual(computerV2Label(title: "  Add\nmilk \t to   the list  ", code: nil), "Add milk to the list")
        XCTAssertEqual(computerV2CleanTitle(String(repeating: "x", count: 200))?.count, computerV2TitleMaxCharacters)
    }

    /// A blank title is no title: the script speaks instead.
    func testABlankTitleFallsThroughToTheScript() {
        XCTAssertEqual(computerV2Label(title: "   \n ", code: notesScript), "Notes · click, paste, state")
        XCTAssertNil(computerV2CleanTitle(""))
        XCTAssertNil(computerV2CleanTitle(nil))
    }

    // MARK: - The label: derived from the script

    func testTheSpinesExample() {
        XCTAssertEqual(computerV2Label(title: nil, code: notesScript), "Notes · click, paste, state")
    }

    func testABrowserTabNamesItsSite() {
        XCTAssertEqual(computerV2Label(title: nil, code: #"const tab = await browsers.open("https://example.com/cart"); await tab.click(3); await tab.state()"#),
                       "example.com · click, state")
        XCTAssertEqual(computerV2AppNames(in: #"await browsers.open('http://localhost:3000/', { browser: "chrome" })"#), ["localhost:3000"])
        XCTAssertEqual(computerV2Verbs(in: "await tab.goto(u); await tab.text(); await tab.upload(4, 'a.pdf')"), ["goto", "text", "upload"])
        XCTAssertEqual(computerV2AppNames(in: "await browsers.open(`https://${host}/`)"), [])
    }

    func testAppNameFormsAreShownAsNames() {
        XCTAssertEqual(computerV2AppNames(in: #"await apps.open("com.apple.Notes")"#), ["Notes"])
        XCTAssertEqual(computerV2AppNames(in: #"await apps.open('/Applications/Final Cut Pro.app')"#), ["Final Cut Pro"])
        XCTAssertEqual(computerV2AppNames(in: "await apps.open(`Notes`)"), ["Notes"])
        XCTAssertEqual(computerV2AppNames(in: #"await apps.open("Final Cut Pro")"#), ["Final Cut Pro"])
        XCTAssertEqual(computerV2AppNames(in: #"await apps . open ( "Notes" , { window: 2 } )"#), ["Notes"])
    }

    func testAppsKeepFirstSeenOrderAndAreCountedPastTwo() {
        let two = #"await apps.open("Notes"); await apps.open("Mail"); await apps.open("notes")"#
        XCTAssertEqual(computerV2AppNames(in: two), ["Notes", "Mail"], "a repeat is the same app")
        XCTAssertEqual(computerV2DerivedLabel(code: two), "Notes, Mail")

        let three = #"await apps.open("Notes"); await apps.open("Mail"); await apps.open("Safari"); await apps.open("Pages")"#
        XCTAssertEqual(computerV2DerivedLabel(code: three), "Notes, Mail +2")
    }

    func testVerbsAreDedupedInFirstSeenOrderAndCapped() {
        let code = #"""
        const a = await apps.open("Notes");
        await a.find("x"); await a.click(1); await a.click(2); await a.type("hi"); await a.key("return");
        await a.scroll(3, "down"); await a.state();
        """#
        XCTAssertEqual(computerV2Verbs(in: code), ["find", "click", "type", "key", "scroll", "state"])
        XCTAssertEqual(computerV2DerivedLabel(code: code), "Notes · find, click, type, key, …")
    }

    func testWaitForIdleIsNotWaitFor() {
        XCTAssertEqual(computerV2Verbs(in: "await n.waitForIdle(); await n.waitFor({ text: 'x' })"), ["waitForIdle", "waitFor"])
    }

    func testAnAppOnlyScriptNamesTheApp() {
        XCTAssertEqual(computerV2DerivedLabel(code: #"await apps.open("Notes")"#), "Notes")
    }

    /// The runtime persists variables, so a later script can act on an app an earlier call opened: no app
    /// to name, but the verbs still say something.
    func testVerbsOnAnEarlierBoundAppKeepTheFallbackWords() {
        XCTAssertEqual(computerV2DerivedLabel(code: "await notes.click(4); await notes.state()"),
                       "Using the computer · click, state")
    }

    func testTheWholeScreenIsAnApp() {
        XCTAssertEqual(computerV2DerivedLabel(code: "show(await screen.screenshot())"), "Screen · screenshot")
        XCTAssertEqual(computerV2DerivedLabel(code: "print(await screen.windows())"), "Screen · windows")
    }

    // MARK: - The label: nothing to say

    func testNothingRecognisableIsTheFallback() {
        XCTAssertEqual(computerV2Label(title: nil, code: nil), "Using the computer")
        XCTAssertEqual(computerV2Label(title: nil, code: ""), "Using the computer")
        XCTAssertEqual(computerV2Label(title: nil, code: "print(1 + 1); await sleep(500)"), "Using the computer")
        XCTAssertNil(computerV2SpecificLabel(title: nil, code: "print(1 + 1)"), "the reducer stores no detail for it")
        XCTAssertNil(computerV2SpecificLabel(title: nil, code: nil))
    }

    func testFallbackTenseFollowsWhetherTheCallIsStillRunning() {
        XCTAssertEqual(computerV2CallLabel(detail: nil, running: true), "Using the computer")
        XCTAssertEqual(computerV2CallLabel(detail: nil, running: false), "Used the computer")
        XCTAssertEqual(computerV2CallLabel(detail: "", running: false), "Used the computer")
        XCTAssertEqual(computerV2CallLabel(detail: "Notes · click", running: true), "Notes · click")
        XCTAssertEqual(computerV2CallLabel(detail: "Notes · click", running: false), "Notes · click")
    }

    // MARK: - The label: hostile and malformed scripts

    func testMalformedScriptsNameNothingAndDoNotCrash() {
        for code in [#"apps.open("Notes"#, #"apps.open(""#, #"apps.open('')"#, "apps.open(", "apps.open(name)",
                     #"apps.open("${name}")"#, "apps.open(`${name}`)", "\u{0}\u{1}\u{2}", "}}}{{{", "apps.open(\"a\nb\")",
                     "👩‍💻.click(", ".click", #"apps.open("\"#] {
            XCTAssertNil(computerV2AppNames(in: code).first, code)
            _ = computerV2Label(title: nil, code: code)
        }
        XCTAssertEqual(computerV2AppNames(in: #"apps.open("Notes"#), [])
    }

    /// A name longer than the pattern's bound is not an app name; nothing backtracks over it.
    func testAnOverlongNameIsNotAnApp() {
        let long = String(repeating: "a", count: 500)
        XCTAssertEqual(computerV2AppNames(in: "apps.open(\"\(long)\")"), [])
    }

    func testAHugeScriptIsScannedQuicklyAndOnlyInPart() {
        // Half a megabyte of near-misses, then a real call far past the scan window.
        let noise = String(repeating: #"apps.open("Notes "#, count: 25_000)
        let code = noise + String(repeating: " ", count: 10) + #"apps.open("Hidden"); x.click(1)"#
        let started = Date()
        let label = computerV2Label(title: nil, code: code)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "no pathological backtracking")
        XCTAssertFalse(label.contains("Hidden"), "past the scan window nothing is read")
    }

    func testLabelsStayOneShortLine() {
        let code = (0..<50).map { #"await apps.open("Application number \#($0) with a long name");"# }.joined(separator: "\n")
        let label = computerV2Label(title: nil, code: code)
        XCTAssertFalse(label.contains("\n"))
        XCTAssertLessThanOrEqual(label.count, 100)
    }

    // MARK: - The reducer: the label and the script

    private func event(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }

    /// A `tool_call` whose `argsJson` is `args` serialised — built from a dictionary, so the double
    /// encoding of a multi-line script cannot be got wrong by hand.
    private func toolCall(_ name: String, args: [String: Any], seq: Int = 3) -> SessionEvent {
        let argsJson = String(data: try! JSONSerialization.data(withJSONObject: args), encoding: .utf8)!
        return toolCall(name, rawArgs: argsJson, seq: seq)
    }

    private func toolCall(_ name: String, rawArgs: String, seq: Int = 3) -> SessionEvent {
        let wrapper: [String: Any] = ["type": "tool_call", "seq": seq, "sessionId": "s", "ts": 0, "threadId": "main",
                                      "callId": "c\(seq)", "name": name, "argsJson": rawArgs]
        return event(String(data: try! JSONSerialization.data(withJSONObject: wrapper), encoding: .utf8)!)
    }

    private func openTurn() -> OrbSessionState {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, event(#"{"type":"user_message","seq":1,"sessionId":"s","ts":0,"threadId":"main","text":"hi","clientName":"cli"}"#))
        return SessionReducer.reduce(s, event(#"{"type":"turn_started","seq":2,"sessionId":"s","ts":0,"threadId":"main"}"#))
    }

    private func lastTool(_ s: OrbSessionState) -> (detail: String?, item: ActivityItem)? {
        guard let item = s.exchanges.last?.activity.last, case .tool(_, let detail, _, _, _, _, _) = item.kind else { return nil }
        return (detail, item)
    }

    func testTheReducerStoresTheTitleAsTheDetailAndTheScriptBesideIt() throws {
        let s = SessionReducer.reduce(openTurn(), toolCall("computer_v2", args: ["code": notesScript, "title": "Add milk"]))
        let tool = try XCTUnwrap(lastTool(s))
        XCTAssertEqual(tool.detail, "Add milk")
        XCTAssertEqual(tool.item.scriptCode, notesScript)
        XCTAssertEqual(tool.item.toolCallId, "c3")
    }

    func testTheReducerDerivesTheDetailWhenThereIsNoTitle() throws {
        let s = SessionReducer.reduce(openTurn(), toolCall("computer_v2", args: ["code": notesScript]))
        XCTAssertEqual(try XCTUnwrap(lastTool(s)).detail, "Notes · click, paste, state")
    }

    func testAScriptWithNothingToSayStoresNoDetailButStillKeepsTheScript() throws {
        let s = SessionReducer.reduce(openTurn(), toolCall("computer_v2", args: ["code": "print(1)"]))
        let tool = try XCTUnwrap(lastTool(s))
        XCTAssertNil(tool.detail)
        XCTAssertEqual(tool.item.scriptCode, "print(1)")
    }

    func testThePlainNameWorksToo() throws {
        let s = SessionReducer.reduce(openTurn(), toolCall("ComputerV2", args: ["code": notesScript]))
        let tool = try XCTUnwrap(lastTool(s))
        XCTAssertEqual(tool.detail, "Notes · click, paste, state")
        XCTAssertEqual(tool.item.scriptCode, notesScript)
    }

    func testUnparseableArgumentsStoreNothing() throws {
        for raw in ["", "not json", "[1,2]", #"{"code":42}"#, #"{"code":""}"#, #"{"title":7}"#, "{"] {
            let s = SessionReducer.reduce(openTurn(), toolCall("computer_v2", rawArgs: raw))
            let tool = try XCTUnwrap(lastTool(s), raw)
            XCTAssertNil(tool.detail, raw)
            XCTAssertNil(tool.item.scriptCode, raw)
        }
    }

    func testAHugeScriptIsCappedWithAMarker() throws {
        let huge = String(repeating: "await n.state();\n", count: 10_000)
        let s = SessionReducer.reduce(openTurn(), toolCall("computer_v2", args: ["code": huge]))
        let code = try XCTUnwrap(lastTool(s)?.item.scriptCode)
        XCTAssertTrue(code.hasPrefix("await n.state();"))
        XCTAssertTrue(code.hasSuffix("[… truncated at \(computerV2CodeMaxCharacters) characters]"))
        XCTAssertLessThan(code.count, computerV2CodeMaxCharacters + 100)
        XCTAssertEqual(computerV2CappedCode("short"), "short")
    }

    func testOtherToolsCarryNoScript() throws {
        let s = SessionReducer.reduce(openTurn(), toolCall("bash", args: ["command": "ls", "code": "x"]))
        XCTAssertNil(try XCTUnwrap(lastTool(s)).item.scriptCode)
    }

    // MARK: - The rows

    private func call(_ detail: String?, output: String? = nil, isError: Bool = false, code: String? = nil,
                      callId: String? = nil) -> ToolCallRecord {
        ToolCallRecord(callId: callId, detail: detail, output: output, isError: isError, scriptCode: code)
    }

    private func entry(_ calls: [ToolCallRecord], name: String = "computer_v2") -> ToolRunEntry {
        ToolRunEntry(name: name, calls: calls)
    }

    func testGroupingCarriesTheScriptToTheRecord() {
        var item = ActivityItem(kind: .tool(name: "computer_v2", detail: "Add milk", callId: "c1"))
        item.scriptCode = "await n.state()"
        let groups = groupActivity([item])
        guard case .toolRun(let entries) = groups[0] else { return XCTFail("expected a tool run") }
        XCTAssertEqual(entries[0].calls[0].scriptCode, "await n.state()")
        XCTAssertEqual(entries[0].calls[0].detail, "Add milk")
    }

    func testALoneCallSaysWhatItDidAndSeveralCount() {
        XCTAssertEqual(toolRunSentence([entry([call("Notes · click, paste, state")])]), "Notes · click, paste, state")
        XCTAssertEqual(toolRunSentence([entry([call("add milk")])]), "Add milk", "the sentence capitalises its first word")
        XCTAssertEqual(toolRunSentence([entry([call(nil)])]), "Used the computer")
        XCTAssertEqual(toolRunSentence([entry([call("a"), call("b")])]), "Used the computer 2 times")
        XCTAssertEqual(toolRunSentence([entry([call("a"), call("b"), call("c")])]), "Used the computer 3 times")
    }

    func testARunMixingToolsKeepsTheCallsLabel() {
        let run = [ToolRunEntry(name: "read", calls: [call("a.ts")]), entry([call("Notes · click")])]
        XCTAssertEqual(toolRunSentence(run), "Read a file, Notes · click")
    }

    /// The old `Computer` tool has no title and no script: it keeps its counted sentence.
    func testTheOldComputerToolIsUnchanged() {
        XCTAssertEqual(toolRunSentence([entry([call("screenshot")], name: "computer")]), "Used the computer")
        XCTAssertEqual(toolGroupFragment(name: "computer", count: 2), toolGroupFragment(name: "computer_v2", count: 2))
        XCTAssertEqual(toolGroupFragment(name: "ComputerV2", count: 1), "used the computer")
    }

    func testTheExpandedRowGetsTheScriptAndTheResult() {
        let entries = [entry([call("Notes · click", output: "settled 80 ms", code: "await n.click(1)"),
                              call(nil, output: nil, code: "await n.state()")])]
        let lines = toolRunExpansion(entries, turnIsLive: true).lines
        XCTAssertEqual(lines.map(\.scriptCode), ["await n.click(1)", "await n.state()"])
        XCTAssertEqual(lines[0].output?.text, "settled 80 ms")
        XCTAssertEqual(lines[0].status, .succeeded)
        XCTAssertEqual(lines[1].status, .running)
        // A line built the old way (no script) still has none.
        XCTAssertNil(ToolRunCallLine(name: "bash", detail: nil, status: .succeeded, output: nil, fileDiff: nil).scriptCode)
    }

    func testTheExpandedLineStandsAloneForComputerV2AndNamesEveryOtherTool() {
        XCTAssertEqual(toolCallLineText(name: "computer_v2", detail: "Notes · click"), "Notes · click")
        XCTAssertEqual(toolCallLineText(name: "ComputerV2", detail: nil), "Using the computer")
        XCTAssertEqual(toolCallLineText(name: "bash", detail: "ls -la"), "bash ls -la")
        XCTAssertEqual(toolCallLineText(name: "bash", detail: nil), "bash")
    }

    // MARK: - The pill

    func testThePillKnowsBothNamesAndNotTheOldTool() {
        XCTAssertEqual(PillToolKind(toolName: "computer_v2"), .computer)
        XCTAssertEqual(PillToolKind(toolName: "ComputerV2"), .computer)
        XCTAssertEqual(PillToolKind(toolName: "computer"), .other("computer"))
    }

    func testARunningPillSaysWhatIsHappening() {
        let withLabel = pillToolLabel(entry([call("Notes · click")]), turnIsLive: true)
        XCTAssertEqual(withLabel, PillToolLabel(lead: "Notes · click"))
        let without = pillToolLabel(entry([call(nil)]), turnIsLive: true)
        XCTAssertEqual(without, PillToolLabel(lead: "Using the computer"))
    }

    func testAFinishedPillKeepsTheLabelOrPutsTheFallbackInThePast() {
        XCTAssertEqual(pillToolLabel(entry([call("Notes · click", output: "ok")]), turnIsLive: false),
                       PillToolLabel(lead: "Notes · click"))
        XCTAssertEqual(pillToolLabel(entry([call(nil, output: "ok")]), turnIsLive: false),
                       PillToolLabel(lead: "Used the computer"))
    }

    func testAFailedPill() {
        XCTAssertEqual(pillToolLabel(entry([call("Notes · click", output: "boom", isError: true)]), turnIsLive: false),
                       PillToolLabel(lead: "Notes · click — failed"))
        XCTAssertEqual(pillToolLabel(entry([call(nil, output: "boom", isError: true), call(nil, output: "boom", isError: true)]),
                                     turnIsLive: false),
                       PillToolLabel(lead: "2 computer actions failed"))
    }

    func testSeveralCallsCountWhenDoneAndTakeTurnsWhileRunning() {
        let done = pillToolLabel(entry([call("a", output: "ok"), call("b", output: "ok")]), turnIsLive: false)
        XCTAssertEqual(done, PillToolLabel(lead: "Used the computer 2 times"))

        let partlyFailed = pillToolLabel(entry([call("a", output: "ok"), call("b", output: "boom", isError: true)]), turnIsLive: false)
        XCTAssertEqual(partlyFailed.lead, "Used the computer 2 times")
        XCTAssertEqual(partlyFailed.tail, " · 1 failed")

        let running = pillToolLabel(entry([call("Notes · click"), call("Mail · type")]), turnIsLive: true)
        XCTAssertEqual(running.lead, "")
        XCTAssertEqual(running.rotation.map(\.text), ["Notes · click", "Mail · type"])
    }

    func testTheRunningRotationIsOnlyTheCallsStillOut() {
        let running = pillToolLabel(entry([call("Notes · click", output: "ok"), call("Mail · type"), call("Pages · key")]), turnIsLive: true)
        XCTAssertEqual(running.rotation.map(\.text), ["Mail · type", "Pages · key"])
    }

    func testComputerV2WearsTheComputersGlyph() {
        XCTAssertEqual(workingToolSymbol(for: "computer_v2"), "cursorarrow.rays")
        XCTAssertEqual(workingToolSymbol(for: "ComputerV2"), "cursorarrow.rays")
        XCTAssertEqual(workingToolSymbol(for: "mcp__winter__computer_v2__script"), "cursorarrow.rays")
        XCTAssertEqual(workingToolSymbol(for: "computer"), "cursorarrow.rays")
    }
}
