import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Drives the PURE reducer directly (same pattern as SessionModelTests). Helper builders
/// mirror that file's event construction — wire-shaped JSON decoded through the real
/// `SessionEvent` decoder, so tests stay honest to the protocol.
final class ActivityCaptureTests: XCTestCase {
    // MARK: Event factory helpers (mirrors SessionModelTests idioms; extended locally for the
    // thread/worktree/question events this file needs — never in production code)

    /// Decodes one wire fixture. **A bad fixture must be a RED, not a runner abort** (whole-branch
    /// review, M-9): this is the shared door for all 91 tests in this class, and the `try!` it
    /// replaced took the whole runner down with no summary — the mode that made an earlier task's
    /// mutation count unreadable.
    ///
    /// Fail-and-substitute rather than `XCTUnwrap` in a `throws` helper: the throwing form cascades
    /// `throws` to every test method in this class and `try` to every call site (measured: 135
    /// methods across the three files this review named). The substitute reaches the same place —
    /// `XCTFail` has already failed the test by the time the placeholder is returned, so a bad
    /// fixture can never read as green; it reads as a named red, at the CALL SITE, with the
    /// offending JSON, and the other 90 tests still report.
    func ev(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> SessionEvent {
        do {
            return try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
        } catch {
            XCTFail("undecodable SessionEvent fixture: \(error)\n\(json)", file: file, line: line)
            return .turnStarted(.init(seq: 0, sessionId: "s", ts: 0, threadId: "main"))
        }
    }
    func userMessage(_ text: String, seq: Int = 1, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"user_message","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","text":"\#(text)","clientName":"cli"}"#)
    }
    func turnStarted(seq: Int = 2, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"turn_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)"}"#)
    }
    func turnCompleted(seq: Int = 9, stopReason: String = "end_turn") -> SessionEvent {
        ev(#"{"type":"turn_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","stopReason":"\#(stopReason)","inputTokens":1,"outputTokens":1}"#)
    }
    func toolCall(_ name: String, seq: Int = 3, thread: String = "main", argsJson: String = "{}") -> SessionEvent {
        // argsJson is embedded as a JSON STRING VALUE (the wire protocol carries the tool's args
        // as a serialized string, not nested JSON) — escape backslashes FIRST, then quotes, so a
        // caller-supplied JSON escape (e.g. "\n" inside a bash command) round-trips through this
        // double-encoding intact rather than being consumed by the outer parse alone.
        let escaped = argsJson
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return ev(#"{"type":"tool_call","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"c\#(seq)","name":"\#(name)","argsJson":"\#(escaped)"}"#)
    }
    func taskUpdated(id: String, subject: String, status: String, seq: Int = 6, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"task_updated","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","task":{"id":"\#(id)","subject":"\#(subject)","status":"\#(status)"}}"#)
    }
    func threadStarted(agentType: String, seq: Int = 4, thread: String = "th_1") -> SessionEvent {
        ev(#"{"type":"thread_started","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","parentThreadId":"main","agentType":"\#(agentType)","prompt":"go"}"#)
    }
    func threadCompleted(seq: Int = 5, thread: String = "th_1") -> SessionEvent {
        ev(#"{"type":"thread_completed","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","stopReason":"end_turn"}"#)
    }
    func worktreeEntered(branch: String, seq: Int = 6, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"worktree_entered","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","name":"wt","path":"/tmp/wt","branch":"\#(branch)"}"#)
    }
    func worktreeExited(name: String, seq: Int = 7, thread: String = "main") -> SessionEvent {
        ev(#"{"type":"worktree_exited","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","name":"\#(name)","action":"merged","removed":true}"#)
    }
    func approvalRequested(summary: String, callId: String = "a1", seq: Int = 8) -> SessionEvent {
        ev(#"{"type":"approval_requested","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","toolName":"bash","summary":"\#(summary)"}"#)
    }
    func questionAsked(_ question: String, callId: String = "q1", seq: Int = 9) -> SessionEvent {
        ev(#"{"type":"question_asked","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","questions":[{"question":"\#(question)","header":"h","options":[],"multiSelect":false}]}"#)
    }
    func planPresented(callId: String = "p1", seq: Int = 10) -> SessionEvent {
        ev(#"{"type":"plan_presented","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"main","callId":"\#(callId)","plan":"the plan"}"#)
    }

    /// Build a state with one open exchange (userMessage + turnStarted), main thread.
    private func openTurnState() -> OrbSessionState {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1))
        s = SessionReducer.reduce(s, turnStarted(seq: 2))
        return s
    }

    private func lastActivity(_ s: OrbSessionState) -> [ActivityItem] {
        s.exchanges.last?.activity ?? []
    }

    // MARK: Tool capture

    func testToolCallAppendsActivity() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3"))])
        // Existing side effect preserved: .toolCall(main) still drives status.
        XCTAssertEqual(s.status, .toolRunning(name: "bash"))
    }

    // LIVE-GATE G3: adjacent-dupe collapse is REMOVED for `.tool` — each call is its own item now
    // (the VIEW's `groupActivity` merges consecutive same-name runs for display; the reducer must
    // not lose the per-call count/detail by collapsing them here).
    func testConsecutiveDuplicateToolsNoLongerCollapse() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        s = SessionReducer.reduce(s, toolCall("read", seq: 5))
        XCTAssertEqual(lastActivity(s), [
            ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3")),
            ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c4")),
            ActivityItem(kind: .tool(name: "read", detail: nil, callId: "c5")),
        ])
    }

    // MARK: Detail extraction (LIVE-GATE G3)

    func testBashDetailExtractsFirstLineOfCommand() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: #"{"command":"ls -la\ngrep foo"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: "ls -la", callId: "c3"))])
    }

    func testBashDetailClipsLongCommandTo100Chars() {
        var s = openTurnState()
        let longCommand = String(repeating: "x", count: 150)
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: #"{"command":"\#(longCommand)"}"#))
        XCTAssertEqual(lastActivity(s).first?.kind, .tool(name: "bash", detail: String(longCommand.prefix(100)), callId: "c3"))
    }

    func testTaskCreateDetailExtractsSubject() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("task_create", seq: 3, argsJson: #"{"subject":"Write tests"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "task_create", detail: "Write tests", callId: "c3"))])
    }

    // `taskId`, not `id` — `packages/core/src/agent/tools/tasks.ts:9-13`. (This payload said `id`
    // until Task 10; the assertion passed anyway because the field it actually reads is `subject`,
    // which is the same class of "green on a shape the daemon never emits" the `read` pair below
    // records.)
    func testTaskUpdateDetailExtractsSubject() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("task_update", seq: 3, argsJson: #"{"taskId":"1","subject":"Write tests","status":"completed"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "task_update", detail: "Write tests", callId: "c3"))])
    }

    // The REAL `read` payload: the daemon's arg is `path` (`fs-read.ts:311-316`), and so it is for
    // `ls`/`write`/`edit` too. Until Task 10 this file drove `read` with `file_path` ONLY (see the
    // belt test below), so the `path` branch — the one every genuine call takes — was never once
    // exercised: it could have been deleted and the suite would have stayed green.
    func testReadDetailExtractsPath() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3, argsJson: #"{"path":"/tmp/x.swift"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "read", detail: "/tmp/x.swift", callId: "c3"))])
    }

    // The belt, kept deliberately: `file_path` is CC's name for this argument (and Norma's own
    // `lsp` tool's), so a model trained on that shape sometimes emits it here. Such a call fails
    // the daemon's zod parse — but `tool_call` is emitted BEFORE execution, so the row still
    // renders and may as well say which file was meant.
    func testReadDetailAcceptsFilePathAsBelt() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3, argsJson: #"{"file_path":"/tmp/x.swift"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "read", detail: "/tmp/x.swift", callId: "c3"))])
    }

    func testGrepDetailExtractsPattern() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("grep", seq: 3, argsJson: #"{"pattern":"TODO"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "grep", detail: "TODO", callId: "c3"))])
    }

    func testMalformedArgsJsonYieldsNilDetail() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: "not json at all"))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3"))])
    }

    func testUnrecognizedFieldsYieldNilDetail() {
        var s = openTurnState()
        // Well-formed JSON, but no field this tool cares about.
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3, argsJson: #"{"unrelated":"x"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3"))])
    }

    func testUnknownToolNameYieldsNilDetail() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("mcp__foo__bar", seq: 3, argsJson: #"{"command":"ls"}"#))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .tool(name: "mcp__foo__bar", detail: nil, callId: "c3"))])
    }

    // MARK: Detail extraction — the other 30 tools (mac-chat-parity Task 10)
    //
    // Every payload below is built from the DAEMON's own zod schema, cited per test. A hint keyed
    // off a field the daemon never sends is worse than no hint, because it looks handled — and the
    // failure is invisible (a wrong key yields `nil`, which renders exactly like today). So every
    // assertion here checks the extracted VALUE; none of them merely assert non-nil.

    /// The one-liner all of these share, so a payload built for the wrong field can't accidentally
    /// pass by matching some other tool's value.
    private func detail(_ tool: String, _ argsJson: String, file: StaticString = #filePath, line: UInt = #line) -> String? {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall(tool, seq: 3, argsJson: argsJson))
        // Fail loudly rather than returning nil if no `.tool` item was captured at all — otherwise
        // a reducer that stopped appending would make every `XCTAssertNil` below pass for the
        // wrong reason.
        guard let kind = lastActivity(s).first?.kind, case .tool(_, let d, _, _, _) = kind else {
            XCTFail("no .tool activity captured for \(tool)", file: file, line: line)
            return nil
        }
        return d
    }

    // MARK: browser — the multi-verb one, and the tool the user actually watches
    // Schema: `browser.ts:274-280` (verb + SHARED url/tabId/title at :168-172 + INTERACT_OPERANDS
    // selector/text/direction/amount/until/timeoutMs at :263-270). Verbs: `:94` + `:99`.
    // Payload shapes copied from the daemon's own `packages/core/test/agent/tools/browser.test.ts`.

    func testBrowserNavigateDetailIsVerbAndUrl() {
        // browser.test.ts:304
        XCTAssertEqual(detail("browser", #"{"verb":"navigate","tabId":"t1","url":"https://a.example"}"#),
                       "navigate https://a.example")
    }

    func testBrowserOpenDetailIsVerbAndUrl() {
        // browser.test.ts:251 — `title` is present and deliberately NOT the hint: the url is what a
        // human recognises, and a model-chosen title is not what the tab actually went to.
        XCTAssertEqual(detail("browser", #"{"verb":"open","url":"https://example.org","title":"Ex"}"#),
                       "open https://example.org")
    }

    func testBrowserClickDetailIsVerbAndSelector() {
        // browser.test.ts:201
        XCTAssertEqual(detail("browser", #"{"verb":"click","tabId":"t1","selector":"a"}"#), "click a")
    }

    /// `type`'s hint is its SELECTOR, never its `text`. The agent is driving the user's own
    /// logged-in browser; whatever it typed does not belong in a transcript row that anyone can
    /// screenshot. (The daemon refuses password/payment fields outright — `browser.ts:729` — but
    /// an email address or a search term is neither, and still isn't ours to publish.)
    func testBrowserTypeDetailIsSelectorNeverTheTypedText() {
        // browser.test.ts:376
        let d = detail("browser", ##"{"verb":"type","tabId":"t1","selector":"#pw","text":"hunter2"}"##)
        XCTAssertEqual(d, "type #pw")
        XCTAssertFalse(d?.contains("hunter2") ?? false)
    }

    func testBrowserScrollDetailIsVerbAndDirection() {
        // browser.test.ts:111. `scroll` is EITHER direction OR selector, never both — the daemon
        // refuses a call naming the two (browser.ts:337-341) — so the precedence never arbitrates.
        XCTAssertEqual(detail("browser", #"{"verb":"scroll","direction":"down"}"#), "scroll down")
    }

    func testBrowserScrollBySelectorDetailIsVerbAndSelector() {
        XCTAssertEqual(detail("browser", ##"{"verb":"scroll","selector":"#footer"}"##), "scroll #footer")
    }

    func testBrowserSubmitDetailIsVerbAndSelector() {
        // browser.test.ts:112
        XCTAssertEqual(detail("browser", #"{"verb":"submit","selector":"form"}"#), "submit form")
    }

    func testBrowserWaitDetailIsVerbAndPredicate() {
        // browser.test.ts:113 — `until` distinguishes wait-for-load from a bare timer, which is the
        // only thing about a wait worth a row.
        XCTAssertEqual(detail("browser", #"{"verb":"wait","until":"load","timeoutMs":5000}"#), "wait load")
    }

    /// The steer's "nothing meaningful for `tabs`" is about the OBJECT, not the detail: `browser`
    /// alone says nothing, `browser tabs` says what happened. So the verb rides even when it has no
    /// operand — which is what makes EVERY well-formed browser call produce a row that reads.
    func testBrowserObjectlessVerbsStillGetTheirVerb() {
        XCTAssertEqual(detail("browser", #"{"verb":"tabs"}"#), "tabs")                       // browser.test.ts:234
        XCTAssertEqual(detail("browser", #"{"verb":"read","tabId":"t1"}"#), "read")          // browser.test.ts:328
        XCTAssertEqual(detail("browser", #"{"verb":"screenshot","tabId":"t1"}"#), "screenshot") // :348
        XCTAssertEqual(detail("browser", #"{"verb":"back","tabId":"t1"}"#), "back")
    }

    func testBrowserWithoutAVerbYieldsNilDetail() {
        XCTAssertNil(detail("browser", #"{"tabId":"t1","url":"https://a.example"}"#))
    }

    func testBrowserWrongTypedVerbYieldsNilDetail() {
        XCTAssertNil(detail("browser", #"{"verb":7,"url":"https://a.example"}"#))
    }

    // MARK: web / search / page reading

    func testWebFetchDetailIsUrl() {
        // web.ts:1004
        XCTAssertEqual(detail("web_fetch", #"{"url":"https://example.com/a"}"#), "https://example.com/a")
    }

    func testWebSearchDetailIsQuery() {
        // web.ts:1084-1089
        XCTAssertEqual(detail("web_search", #"{"query":"swift concurrency","max_results":5}"#), "swift concurrency")
    }

    func testSearchDetailIsQuery() {
        // search.ts:80-83
        XCTAssertEqual(detail("Search", #"{"query":"norma daemon"}"#), "norma daemon")
    }

    func testReadPageDetailIsTheFirstPageUrl() {
        // read-page.ts:33-45 — args are `{pages:[{url,query?,lineStart?,lineEnd?,max_pages?}]}`,
        // NOT a bare `url`.
        XCTAssertEqual(detail("ReadPage", #"{"pages":[{"url":"https://a.example/doc"}]}"#), "https://a.example/doc")
    }

    /// A batch shows its first url AND says how many it isn't showing — a bare first url would be a
    /// partial truth wearing the same clothes as a complete one.
    func testReadPageBatchCountsTheEntriesItIsNotShowing() {
        let args = #"{"pages":[{"url":"https://a.example"},{"url":"https://b.example"},{"url":"https://c.example","query":"who?"}]}"#
        XCTAssertEqual(detail("ReadPage", args), "https://a.example (+2 more)")
    }

    func testReadPageWithMalformedPagesYieldsNilDetail() {
        XCTAssertNil(detail("ReadPage", #"{"pages":"https://a.example"}"#))
        XCTAssertNil(detail("ReadPage", #"{"pages":[]}"#))
    }

    // MARK: lsp / computer — action-led, like browser

    func testLspDetailIsActionAndFilePath() {
        // lsp.ts:237-243 — and `file_path` here is REAL (it is the only tool in the daemon that
        // declares that name; every fs tool declares `path`).
        XCTAssertEqual(detail("lsp", #"{"action":"diagnostics","file_path":"src/a.ts"}"#), "diagnostics src/a.ts")
    }

    func testLspWorkspaceSymbolsDetailIsActionAndSymbol() {
        // lsp.ts:186-194 — workspace_symbols has no file_path at all; `symbol` is its operand.
        XCTAssertEqual(detail("lsp", #"{"action":"workspace_symbols","symbol":"SessionReducer"}"#),
                       "workspace_symbols SessionReducer")
    }

    func testComputerDetailIsTheAction() {
        // computer.ts:34-54
        XCTAssertEqual(detail("computer", #"{"action":"ax_snapshot"}"#), "ax_snapshot")
        XCTAssertEqual(detail("computer", #"{"action":"click","element_id":12}"#), "click")
    }

    func testComputerKeyDetailIncludesTheKeystroke() {
        XCTAssertEqual(detail("computer", #"{"action":"key","keys":"cmd+s"}"#), "key cmd+s")
    }

    /// Same rule as `browser type`: the keystroke is a shortcut, the typed text is content.
    func testComputerTypeDetailOmitsTheTypedText() {
        let d = detail("computer", #"{"action":"type","text":"my passphrase"}"#)
        XCTAssertEqual(d, "type")
        XCTAssertFalse(d?.contains("passphrase") ?? false)
    }

    // MARK: agents & sessions

    func testSpawnAgentDetailIsTheDescription() {
        // spawn.ts:54-58 — `description` is the required 3-5 word summary; `prompt` is the whole
        // brief and would fill the row with noise.
        let args = #"{"prompt":"Read the reducer and report","description":"Audit the reducer","agentType":"general-purpose"}"#
        XCTAssertEqual(detail("spawn_agent", args), "Audit the reducer")
    }

    func testSpawnAgentFallsBackToAgentType() {
        XCTAssertEqual(detail("spawn_agent", #"{"prompt":"go","agentType":"Explore"}"#), "Explore")
    }

    func testSessionSpawnDetailPrefersTitle() {
        // session-spawn.ts:43-49
        XCTAssertEqual(detail("session_spawn", #"{"dir":"/x","prompt":"go","title":"Fix the parser"}"#),
                       "Fix the parser")
    }

    func testSessionSpawnFallsBackToDir() {
        XCTAssertEqual(detail("session_spawn", #"{"dir":"/Users/k/proj","prompt":"go"}"#), "/Users/k/proj")
    }

    func testSendMessageDetailIsTheRecipient() {
        // send-message.ts:36-39 — `to` is an agentId, a name, or a session id.
        XCTAssertEqual(detail("send_message", #"{"to":"agent-7","message":"status?"}"#), "agent-7")
    }

    func testAgentOutputDetailIsTheAgent() {
        // agent-query.ts:60
        XCTAssertEqual(detail("agent_output", #"{"agent":"researcher"}"#), "researcher")
    }

    func testManageSessionDetailIsTheAction() {
        // list-sessions.ts:146-149 (name constant at :35) — the sessionId is opaque; the verb is
        // the thing a human reads.
        XCTAssertEqual(detail("manage_session", #"{"sessionId":"s_1","action":"archive"}"#), "archive")
    }

    // MARK: skills, workflows, tool search, notebooks

    func testSkillDetailIsName() {
        // skill.ts:19
        XCTAssertEqual(detail("Skill", #"{"name":"brainstorming"}"#), "brainstorming")
    }

    func testSkillWriteDetailIsName() {
        // skill-write.ts:33
        XCTAssertEqual(detail("skill_write", #"{"name":"deploy","description":"d","body":"b"}"#), "deploy")
    }

    func testToolSearchDetailIsQuery() {
        // toolsearch.ts:11-14
        XCTAssertEqual(detail("ToolSearch", #"{"query":"select:Read,Edit","maxResults":5}"#), "select:Read,Edit")
    }

    func testWorkflowNamedRunDetailIsItsName() {
        // workflow.ts:4-9
        XCTAssertEqual(detail("Workflow", #"{"script":"export const meta={};return 1","name":"triage"}"#), "triage")
    }

    func testNotebookEditDetailIsNotebookPath() {
        // notebook.ts:7-13 — `notebook_path`, not `path`.
        XCTAssertEqual(detail("notebook_edit", #"{"notebook_path":"/w/a.ipynb","new_source":"print(1)","cell_id":"c1"}"#),
                       "/w/a.ipynb")
    }

    // MARK: tasks, background, schedule, mcp, notifications

    func testTaskStopDetailIsTaskId() {
        // task-stop.ts:58 — `task_id` (snake), unlike task_get's `taskId`.
        XCTAssertEqual(detail("task_stop", #"{"task_id":"t_1"}"#), "t_1")
    }

    func testTaskGetDetailIsTaskId() {
        // tasks.ts:30 — `taskId` (camel). The two really do differ; this pair is the pin.
        XCTAssertEqual(detail("task_get", #"{"taskId":"t_1"}"#), "t_1")
    }

    func testBashOutputDetailIsTaskId() {
        // background.ts:11-14
        XCTAssertEqual(detail("bash_output", #"{"taskId":"bg_1","filter":"error"}"#), "bg_1")
    }

    func testScheduleCreateDetailIsOpAndSpec() {
        // schedule.ts:14-26 — a discriminated union on `op`.
        XCTAssertEqual(detail("schedule", #"{"op":"create","spec":"every 30m","prompt":"check the deploy"}"#),
                       "create every 30m")
    }

    func testScheduleDeleteDetailIsOpAndId() {
        XCTAssertEqual(detail("schedule", #"{"op":"delete","id":"r_1"}"#), "delete r_1")
    }

    func testScheduleListDetailIsTheBareOp() {
        XCTAssertEqual(detail("schedule", #"{"op":"list"}"#), "list")
    }

    func testReadMcpResourceDetailIsUri() {
        // mcp-resources.ts:61
        XCTAssertEqual(detail("read_mcp_resource", #"{"server":"fs","uri":"file:///x/y.txt"}"#), "file:///x/y.txt")
    }

    func testListMcpResourcesDetailIsServer() {
        // mcp-resources.ts:35 — `server` is optional; absent is the nil case below.
        XCTAssertEqual(detail("list_mcp_resources", #"{"server":"fs"}"#), "fs")
        XCTAssertNil(detail("list_mcp_resources", "{}"))
    }

    func testPushNotificationDetailPrefersTitle() {
        // push-notification.ts:6-11
        XCTAssertEqual(detail("push_notification", #"{"title":"Build done","message":"all green"}"#), "Build done")
    }

    func testPushNotificationFallsBackToMessage() {
        XCTAssertEqual(detail("push_notification", #"{"message":"Build finished"}"#), "Build finished")
    }

    // MARK: questions & worktrees

    func testAskQuestionDetailIsTheQuestion() {
        // ask-question.ts:16-19
        let args = #"{"question":"Ship it or wait?","options":[{"label":"Ship"},{"label":"Wait"}]}"#
        XCTAssertEqual(detail("AskQuestion", args), "Ship it or wait?")
    }

    func testAskUserDetailIsTheFirstQuestion() {
        // ask-user.ts:7-21 — args are `{questions:[{question,header,options,multiSelect}]}`, so the
        // question is one level down; a top-level `question` key does not exist here.
        let args = #"{"questions":[{"question":"Which provider?","header":"Provider","options":[{"label":"A","description":"a"},{"label":"B","description":"b"}],"multiSelect":false}]}"#
        XCTAssertEqual(detail("ask_user", args), "Which provider?")
    }

    func testEnterWorktreeDetailIsName() {
        // worktree.ts:6 — `name` is optional (the manager mints one when omitted).
        XCTAssertEqual(detail("enter_worktree", #"{"name":"fix-x"}"#), "fix-x")
        XCTAssertNil(detail("enter_worktree", "{}"))
    }

    func testExitWorktreeDetailIsAction() {
        // worktree.ts:7 — keep vs remove is the whole content of the call.
        XCTAssertEqual(detail("exit_worktree", #"{"action":"remove","discard_changes":false}"#), "remove")
    }

    // MARK: the deliberate nils — tools with no honest one-line summary
    //
    // These are the `default:` pin. `nil` is a correct answer, and a row cluttered with JSON noise
    // is the failure this avoids.

    func testExitPlanModeYieldsNilDetail() {
        // plan.ts:12-14 — `plan` is a whole document. Its first 100 characters are a heading, which
        // would read as a summary while being an arbitrary prefix.
        XCTAssertNil(detail("exit_plan_mode", ##"{"plan":"# Plan\n\n1. Rework the reducer\n2. Test it"}"##))
    }

    func testWorkflowWithoutANameYieldsNilDetail() {
        // workflow.ts:4-9 — `name` is optional and `script` is a JS program; unnamed runs get no
        // hint rather than a slice of source.
        XCTAssertNil(detail("Workflow", #"{"script":"export const meta = { name: 'x' };\nreturn 1;","run_in_background":true}"#))
    }

    func testListSessionsYieldsNilDetail() {
        // list-sessions.ts:139-144 — every field is optional and normally absent; a lone filter
        // word is not what the call did.
        XCTAssertNil(detail("list_sessions", #"{"type":"active"}"#))
    }

    func testArglessToolsYieldNilDetail() {
        // agent-query.ts:38 (agent_list), tasks.ts:29 (task_list), plan.ts:15 (enter_plan_mode)
        XCTAssertNil(detail("agent_list", "{}"))
        XCTAssertNil(detail("task_list", "{}"))
        XCTAssertNil(detail("enter_plan_mode", "{}"))
    }

    // MARK: clipping — urls, selectors and questions are all long or unbounded on the wire

    func testLongDetailValuesAreClippedTo100Characters() {
        let longQuestion = String(repeating: "q", count: 150)
        XCTAssertEqual(detail("AskQuestion", #"{"question":"\#(longQuestion)","options":[{"label":"A"},{"label":"B"}]}"#),
                       String(longQuestion.prefix(100)))
        let longUrl = "https://a.example/" + String(repeating: "p", count: 150)
        XCTAssertEqual(detail("web_fetch", #"{"url":"\#(longUrl)"}"#), String(longUrl.prefix(100)))
    }

    /// The whole assembled line is bounded, not just its operand — `verb` is a zod enum in the
    /// daemon, but `argsJson` is the model's RAW output, emitted before any parse (engine.ts:3927),
    /// so a malformed call can put anything in it.
    func testBrowserDetailIsClippedIncludingItsVerb() {
        let longVerb = String(repeating: "v", count: 150)
        XCTAssertEqual(detail("browser", #"{"verb":"\#(longVerb)","url":"https://a.example"}"#),
                       String(longVerb.prefix(100)))
    }

    func testMultilineDetailValuesKeepOnlyTheFirstLine() {
        XCTAssertEqual(detail("push_notification", #"{"message":"Build finished\nwith 2 warnings"}"#), "Build finished")
    }

    func testEmptyStringFieldsFallThroughToNil() {
        XCTAssertNil(detail("web_fetch", #"{"url":""}"#))
        XCTAssertNil(detail("Skill", #"{"name":""}"#))
        XCTAssertNil(detail("browser", #"{"verb":""}"#))
    }

    // MARK: Task transitions

    func testTaskTransitionAppendsOnlyOnStatusChange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 3))
        XCTAssertEqual(lastActivity(s), [ActivityItem(kind: .task(subject: "Do X", status: "in_progress"))])

        // Same id + same status again → the upsert changed nothing → NO new item.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 4))
        XCTAssertEqual(lastActivity(s).count, 1)

        // Status actually transitions → append.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "Do X", status: "completed", seq: 5))
        XCTAssertEqual(lastActivity(s), [
            ActivityItem(kind: .task(subject: "Do X", status: "in_progress")),
            ActivityItem(kind: .task(subject: "Do X", status: "completed")),
        ])
        // Existing side effect preserved: the upsert still landed in tasks. Task 2 (2e-i):
        // startedTs was stamped (event.ts, always 0 in this file's helper) the moment the task
        // entered in_progress above, then PRESERVED across the completed transition — non-
        // in_progress transitions leave startedTs as-is, they don't clear it.
        XCTAssertEqual(s.tasks, [TaskItem(id: "1", subject: "Do X", status: "completed", startedTs: 0)])
    }

    // MARK: Subagents, worktree, interactions

    func testSubagentAndWorktreeAndInteractionCapture() {
        var s = openTurnState()
        // thread_started/completed arrive with CHILD threadIds by nature — captured anyway
        // (guarded on turnRunning, not threadId).
        s = SessionReducer.reduce(s, threadStarted(agentType: "general", seq: 3))
        s = SessionReducer.reduce(s, threadCompleted(seq: 4))
        s = SessionReducer.reduce(s, worktreeEntered(branch: "fix-x", seq: 5))
        s = SessionReducer.reduce(s, worktreeExited(name: "wt", seq: 6))
        s = SessionReducer.reduce(s, approvalRequested(summary: "rm -rf x", callId: "a1", seq: 7))
        s = SessionReducer.reduce(s, questionAsked("Which port?", callId: "q1", seq: 8))
        s = SessionReducer.reduce(s, planPresented(callId: "p1", seq: 9))
        // mac-chat-parity Task 3: the three interaction items now carry the whole ask, not a bare
        // summary string — the transcript draws the card itself from these. The summaries this test
        // used to assert on are still what `InteractionRecord.summary` derives (pinned in
        // `InteractionRecordTests.testSummaryIsDerivedFromTheAsk`).
        XCTAssertEqual(lastActivity(s).count, 7)
        XCTAssertEqual(Array(lastActivity(s).prefix(4)), [
            ActivityItem(kind: .subagent(agentType: "general")),
            ActivityItem(kind: .subagentDone),
            ActivityItem(kind: .worktree(entered: true, detail: "fix-x")),
            ActivityItem(kind: .worktree(entered: false, detail: "wt")),
        ])
        XCTAssertEqual(lastActivity(s).compactMap(\.interactionRecord).map(\.summary),
                       ["rm -rf x", "Which port?", "plan presented"])
        // Existing side effects preserved: approval/question/plan still manage pendingInteractions.
        XCTAssertEqual(s.pendingInteractions.map(\.callId), ["a1", "q1", "p1"])
        XCTAssertEqual(s.status, .approvalNeeded(count: 3))
    }

    func testSubagentEventsOutsideRunningTurnIgnored() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, userMessage("hi", seq: 1))
        // No turn_started → turnRunning false → thread events must not append.
        s = SessionReducer.reduce(s, threadStarted(agentType: "general", seq: 2))
        s = SessionReducer.reduce(s, threadCompleted(seq: 3))
        XCTAssertEqual(lastActivity(s), [])
    }

    // MARK: Aborted flag

    func testAbortedTurnFlagsExchange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, turnCompleted(seq: 3, stopReason: "aborted"))
        XCTAssertTrue(s.exchanges.last!.aborted)

        var t = openTurnState()
        t = SessionReducer.reduce(t, turnCompleted(seq: 3, stopReason: "end_turn"))
        XCTAssertFalse(t.exchanges.last!.aborted)
    }

    // MARK: Cap (drop-oldest at 200)

    func testActivityCapAt200DropsOldest() {
        var s = openTurnState()
        for i in 1...205 {
            s = SessionReducer.reduce(s, toolCall("t\(i)", seq: i + 2))
        }
        XCTAssertEqual(lastActivity(s).count, 200)
        XCTAssertEqual(lastActivity(s).first, ActivityItem(kind: .tool(name: "t6", detail: nil, callId: "c8")))
        XCTAssertEqual(lastActivity(s).last, ActivityItem(kind: .tool(name: "t205", detail: nil, callId: "c207")))
    }

    // MARK: the cap's interaction exemption (whole-branch review, M-2)
    //
    // Task 3 deleted the pinned band — `PendingCardsView` has no references repo-wide — and that
    // band was fed by the UNCAPPED `pendingInteractions`. The inline card is now the only inline
    // door to answering an ask, so an evicted card is a question that scrolled itself out of
    // existence.
    //
    // Unreachable for a NATIVE ask: the engine blocks the turn, so nothing further appends.
    // REACHABLE for a dispatch-mirrored CHILD ask: the parent's turn keeps running and can append
    // 200+ items after the card, and `c1370fd7` removed the main thread's tool-iteration limit
    // deliberately to support exactly those long turns. The orb/detached `y`/`n` door survives but
    // answers only `pendingInteractions.first` — the OLDEST — and that list clears at the parent's
    // turn end, leaving the child waiting forever.

    func testInteractionSurvivesTheActivityCap() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(summary: "rm -rf x", callId: "a1", seq: 3))
        for i in 1...250 { s = SessionReducer.reduce(s, toolCall("t\(i)", seq: i + 3)) }
        // Still there, and still identifiable by the callId the answer is routed on.
        XCTAssertEqual(lastActivity(s).compactMap(\.interactionRecord).map(\.callId), ["a1"])
    }

    /// The other direction, so the exemption cannot be over-applied into "nothing evicts": ordinary
    /// activity still drops oldest-first around the surviving card, and the exchange stays bounded.
    func testOrdinaryActivityStillEvictsAroundASurvivingInteraction() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, approvalRequested(summary: "rm -rf x", callId: "a1", seq: 3))
        for i in 1...250 { s = SessionReducer.reduce(s, toolCall("t\(i)", seq: i + 3)) }
        XCTAssertEqual(lastActivity(s).count, 200)
        XCTAssertNotNil(lastActivity(s).first?.interactionRecord)  // the card, still at the head
        // 251 appended, 51 over — so t1…t51 evicted and the card skipped, not counted against them.
        XCTAssertEqual(lastActivity(s).dropFirst().first?.kind, .tool(name: "t52", detail: nil, callId: "c55"))
        XCTAssertEqual(lastActivity(s).last?.kind, .tool(name: "t250", detail: nil, callId: "c253"))
    }

    // MARK: Main-thread-only + defensive guards

    func testChildThreadEventsIgnored() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3, thread: "th_child"))
        XCTAssertEqual(lastActivity(s), [])

        // A child-thread taskUpdated still upserts (tasks are session-wide) but adds no activity.
        s = SessionReducer.reduce(s, taskUpdated(id: "1", subject: "a", status: "in_progress", seq: 4, thread: "th_child"))
        XCTAssertEqual(s.tasks.count, 1)
        XCTAssertEqual(lastActivity(s), [])

        // Child-thread worktree events don't append either.
        s = SessionReducer.reduce(s, worktreeEntered(branch: "b", seq: 5, thread: "th_child"))
        XCTAssertEqual(lastActivity(s), [])
    }

    func testNoOpenExchangeIsDefensiveNoop() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 1))
        XCTAssertTrue(s.exchanges.isEmpty) // no crash, nothing appended anywhere

        // turn_completed(aborted) with no exchanges must not crash either.
        s = SessionReducer.reduce(s, turnCompleted(seq: 2, stopReason: "aborted"))
        XCTAssertTrue(s.exchanges.isEmpty)
    }

    // MARK: Steer keeps one exchange

    func testSteerKeepsAccumulatingOnSameExchange() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, userMessage("also do Y", seq: 4)) // mid-turn steer
        s = SessionReducer.reduce(s, toolCall("read", seq: 5))
        XCTAssertEqual(s.exchanges.count, 1)
        XCTAssertEqual(s.exchanges[0].activity, [
            ActivityItem(kind: .tool(name: "bash", detail: nil, callId: "c3")),
            ActivityItem(kind: .tool(name: "read", detail: nil, callId: "c5")),
        ])
        // The steer fold itself is untouched (existing behavior byte-preserved).
        XCTAssertEqual(s.exchanges[0].prompt, "hi\n↳ also do Y")
    }

    // MARK: Purity / replay

    func testReplayRebuildsActivity() {
        let events: [SessionEvent] = [
            userMessage("go", seq: 1),
            turnStarted(seq: 2),
            toolCall("bash", seq: 3),
            taskUpdated(id: "1", subject: "Do X", status: "in_progress", seq: 4),
            threadStarted(agentType: "general", seq: 5),
            threadCompleted(seq: 6),
            worktreeEntered(branch: "fix-x", seq: 7),
            approvalRequested(summary: "rm x", callId: "a1", seq: 8),
            turnCompleted(seq: 9, stopReason: "aborted"),
        ]
        let a = events.reduce(OrbSessionState()) { SessionReducer.reduce($0, $1) }
        let b = events.reduce(OrbSessionState()) { SessionReducer.reduce($0, $1) }
        XCTAssertEqual(a.exchanges, b.exchanges) // pure/deterministic
        XCTAssertEqual(a.exchanges.count, 1)
        XCTAssertFalse(a.exchanges[0].activity.isEmpty) // the comparison covered real capture
        XCTAssertTrue(a.exchanges[0].aborted)
    }

    // MARK: tool_result fold (mac-chat-parity Task 1)
    //
    // Before this, `tool_result` folded to a status flip and NOTHING else — `output` and `isError`
    // were discarded in the reducer, so no view could ever show what a tool did or that it failed.

    /// `output` is embedded as a JSON STRING VALUE, so backslashes/quotes/newlines have to be
    /// escaped in that order (backslash first, or the escapes we add would be re-escaped).
    func toolResult(callId: String, output: String = "ok", isError: Bool = false, seq: Int = 4, thread: String = "main") -> SessionEvent {
        let escaped = output
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        return ev(#"{"type":"tool_result","seq":\#(seq),"sessionId":"s","ts":0,"threadId":"\#(thread)","callId":"\#(callId)","output":"\#(escaped)","isError":\#(isError)}"#)
    }

    private func resultFields(_ item: ActivityItem?) -> (output: String?, isError: Bool)? {
        guard let kind = item?.kind, case .tool(_, _, _, let output, let isError) = kind else { return nil }
        return (output, isError)
    }

    func testToolResultCarriesOutputAndIsErrorOntoTheFoldedItem() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        // Before the result lands, "still running" is a nil output — not an empty string.
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, nil)
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "ENOENT: no such file", isError: true, seq: 4))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, "ENOENT: no such file")
        XCTAssertEqual(resultFields(lastActivity(s).first)?.isError, true)
        // The name/detail the item was opened with survive the fold untouched.
        XCTAssertEqual(lastActivity(s).first?.kind, .tool(name: "bash", detail: nil, callId: "c3", output: "ENOENT: no such file", isError: true))
    }

    /// The existing side effect the fold must NOT disturb: a main-thread `tool_result` with no
    /// pending interaction still returns the orb to `.thinking`.
    func testToolResultStillFlipsStatusBackToThinking() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        XCTAssertEqual(s.status, .toolRunning(name: "bash"))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", seq: 4))
        XCTAssertEqual(s.status, .thinking)
    }

    /// The join is by `callId`, not by position: results are matched to the call that opened them
    /// even when they arrive in a different order than the calls did.
    func testToolResultJoinsByCallIdNotByPosition() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("read", seq: 3))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        s = SessionReducer.reduce(s, toolResult(callId: "c4", output: "from bash", seq: 5))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "from read", seq: 6))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, "from read")
        XCTAssertEqual(resultFields(lastActivity(s).last)?.output, "from bash")
    }

    /// A main-thread steer's `user_message` is persisted at SEND time (`AgentEngine.steer`,
    /// packages/core/src/agent/engine.ts), so it can land BETWEEN a tool_call and its tool_result —
    /// and once the exchange already holds a reply, the reducer's `userMessage` branch opens a NEW
    /// exchange for it. The result then belongs to an item one exchange back. This is the only test
    /// that discriminates the reverse scan from "look in the last exchange only".
    func testToolResultFoldsIntoAnEarlierExchangeWhenASteerOpenedANewOne() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, ev(#"{"type":"assistant_message","seq":3,"sessionId":"s","ts":0,"threadId":"main","text":"round one"}"#))
        s = SessionReducer.reduce(s, toolCall("bash", seq: 4))
        // Steer with a non-empty reply on the open exchange → the reducer opens exchange #2.
        s = SessionReducer.reduce(s, userMessage("also do Y", seq: 5))
        XCTAssertEqual(s.exchanges.count, 2, "precondition: the steer must have opened a second exchange")
        s = SessionReducer.reduce(s, toolResult(callId: "c4", output: "landed", seq: 6))
        XCTAssertEqual(resultFields(s.exchanges[0].activity.first)?.output, "landed")
    }

    func testToolResultForAnUnknownCallIdIsANoop() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        let before = s
        s = SessionReducer.reduce(s, toolResult(callId: "nope", output: "orphan", seq: 4))
        XCTAssertEqual(s.exchanges, before.exchanges) // nothing folded anywhere, no crash
    }

    /// A `tool_result` with no exchange at all (its `tool_call` was dropped by `appendActivity`'s
    /// no-open-exchange guard) must not crash the reducer either.
    func testToolResultWithNoExchangesIsANoop() {
        var s = OrbSessionState()
        s = SessionReducer.reduce(s, toolResult(callId: "c3", seq: 1))
        XCTAssertTrue(s.exchanges.isEmpty)
    }

    /// Child-thread tool events never reach the main transcript — the fold inherits the existing
    /// `threadId == mainThread` guard on the case itself.
    func testChildThreadToolResultDoesNotFold() {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "child output", seq: 4, thread: "th_child"))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, nil)
    }

    // MARK: Output retention cap

    func testToolOutputIsTruncatedAtTheRetentionCap() {
        let cap = SessionReducer.maxToolOutputCharacters
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: String(repeating: "x", count: cap + 1), seq: 4))
        XCTAssertEqual(
            resultFields(lastActivity(s).first)?.output,
            String(repeating: "x", count: cap) + "\n[… truncated at \(cap) characters]"
        )
    }

    /// Exactly at the cap is NOT truncated — no marker on an output that fits.
    func testToolOutputExactlyAtTheCapIsKeptWhole() {
        let cap = SessionReducer.maxToolOutputCharacters
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: String(repeating: "x", count: cap), seq: 4))
        XCTAssertEqual(resultFields(lastActivity(s).first)?.output, String(repeating: "x", count: cap))
    }

    /// The bound itself, pinned: it must EQUAL the daemon's own `MAX_OUTPUT`
    /// (64 KiB, packages/core/src/agent/tools/registry.ts). Anything lower would discard output the
    /// daemon deliberately sent — 8-64 KiB is the normal band for `read`, not a pathological tail —
    /// which is the exact complaint this task exists to fix.
    func testRetentionCapMatchesTheDaemonsMaxOutput() {
        XCTAssertEqual(SessionReducer.maxToolOutputCharacters, 64 * 1024)
    }

    // MARK: Fold search depth (Fix round 1, Minor-2)

    /// Builds `count` completed exchanges after the one holding an unresolved `bash` call, so the
    /// call's item sits exactly `count` exchanges back when the result finally arrives.
    private func stateWithUnresolvedCall(followedByCompletedTurns count: Int) -> OrbSessionState {
        var s = openTurnState()
        s = SessionReducer.reduce(s, toolCall("bash", seq: 3))       // callId "c3", never resolved
        s = SessionReducer.reduce(s, turnCompleted(seq: 4))
        for i in 0..<count {
            let base = 5 + i * 3
            s = SessionReducer.reduce(s, userMessage("turn \(i)", seq: base))
            s = SessionReducer.reduce(s, turnStarted(seq: base + 1))
            s = SessionReducer.reduce(s, turnCompleted(seq: base + 2))
        }
        return s
    }

    /// At the edge of the bound the result still lands: 3 newer exchanges means the item's own
    /// exchange is the 4th one scanned.
    func testToolResultStillFoldsAtTheSearchDepthLimit() {
        var s = stateWithUnresolvedCall(followedByCompletedTurns: 3)
        XCTAssertEqual(s.exchanges.count, 4, "precondition: the item's exchange is the 4th scanned")
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "landed", seq: 99))
        XCTAssertEqual(resultFields(s.exchanges[0].activity.first)?.output, "landed")
    }

    /// One exchange past the bound the result is deliberately dropped rather than walking the whole
    /// transcript — the documented trade in `toolResultFoldSearchDepth`. This is only reachable at
    /// all when a call's result never arrived within a few turns, which the engine does not do.
    func testToolResultBeyondTheSearchDepthIsNotFolded() {
        var s = stateWithUnresolvedCall(followedByCompletedTurns: 4)
        XCTAssertEqual(s.exchanges.count, 5, "precondition: the item's exchange is one past the bound")
        s = SessionReducer.reduce(s, toolResult(callId: "c3", output: "too far back", seq: 99))
        XCTAssertEqual(resultFields(s.exchanges[0].activity.first)?.output, nil)
    }
}
