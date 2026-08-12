import XCTest
@testable import Norma

/// LIVE-GATE G3 / r1b: pure grouping/label/sentence logic for the transcript's grouped tool
/// lines. Drives `groupActivity`/`toolGroupFragment`/`toolGroupLabel`/`toolRunSentence` directly
/// (no view involved) — mirrors `ActivityRowTests`' convention of testing the pure mapper, not
/// the SwiftUI body. r1b (CC parity): an unbroken run of tool calls, even across DIFFERENT tool
/// names, collapses to ONE comma-joined sentence row — `groupActivity` now emits `.toolRun`
/// groups of `ToolRunEntry` directly instead of r1's single-name `.tools` case.
final class ActivityGroupingTests: XCTestCase {
    private func tool(
        _ name: String,
        _ detail: String? = nil,
        callId: String? = nil,
        output: String? = nil,
        isError: Bool = false
    ) -> ActivityItem {
        ActivityItem(kind: .tool(name: name, detail: detail, callId: callId, output: output, isError: isError))
    }

    /// One call with only a detail — the shape most of these grouping cases care about.
    private func call(_ detail: String? = nil) -> ToolCallRecord {
        ToolCallRecord(callId: nil, detail: detail, output: nil, isError: false)
    }

    // MARK: groupActivity

    func testConsecutiveSameNameToolsMergeIntoOneEntry() {
        let items = [tool("bash", "ls"), tool("bash", "pwd"), tool("bash", nil)]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "bash", calls: [call("ls"), call("pwd"), call(nil)])]),
        ])
    }

    func testDifferentToolNamesStayInOneRunAsSeparateEntries() {
        // r1b: an unbroken run spans different tool names — one `.toolRun` group, two entries,
        // NOT two separate groups (that was r1's behavior).
        let items = [tool("bash", "ls"), tool("read", "/tmp/x")]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([
                ToolRunEntry(name: "bash", calls: [call("ls")]),
                ToolRunEntry(name: "read", calls: [call("/tmp/x")]),
            ]),
        ])
    }

    func testNonConsecutiveSameNameWithinARunStaysAsSeparateEntries() {
        // bash, read, bash — all one unbroken run, but the two bash calls aren't adjacent so they
        // don't merge into a single entry (matches r1's "consecutive only" merge rule).
        let items = [tool("bash", "ls"), tool("read", "/a"), tool("bash", "pwd")]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([
                ToolRunEntry(name: "bash", calls: [call("ls")]),
                ToolRunEntry(name: "read", calls: [call("/a")]),
                ToolRunEntry(name: "bash", calls: [call("pwd")]),
            ]),
        ])
    }

    func testNonToolItemBreaksARunEvenIfToolsResumeAfter() {
        let items: [ActivityItem] = [
            tool("bash", "ls"),
            ActivityItem(kind: .interaction("needs approval")),
            tool("bash", "pwd"),
        ]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "bash", calls: [call("ls")])]),
            .single(ActivityItem(kind: .interaction("needs approval"))),
            .toolRun([ToolRunEntry(name: "bash", calls: [call("pwd")])]),
        ])
    }

    func testTaskItemsAreSkippedEntirely() {
        let items: [ActivityItem] = [
            tool("bash", "ls"),
            ActivityItem(kind: .task(subject: "Do X", status: "in_progress")),
            tool("bash", "pwd"),
        ]
        // The task item vanishes from grouping — AND, since it's skipped rather than treated as a
        // run-breaker, the two bash calls on either side of it still merge into one entry.
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "bash", calls: [call("ls"), call("pwd")])]),
        ])
    }

    func testOtherKindsPassThroughAsSingle() {
        let items: [ActivityItem] = [
            ActivityItem(kind: .subagent(agentType: "general")),
            ActivityItem(kind: .subagentDone),
            ActivityItem(kind: .worktree(entered: true, detail: "fix-x")),
        ]
        XCTAssertEqual(groupActivity(items), items.map { .single($0) })
    }

    /// mac-chat-parity Task 2: a call with no extractable detail is KEPT, in place. Pre-Task-2 the
    /// entry held a flat `details: [String]` that skipped them, so a run of five `browser` calls
    /// (no `extractToolDetail` case) had `count == 5` and `details == []` and expanded to a
    /// literally empty area — research §2.3's worked example. Does NOT cover what the expanded row
    /// draws for those calls (view; `ToolRowTests` covers the expansion model).
    func testEveryCallIsKeptEvenWhenItHasNoDetail() {
        let items = [tool("read", nil), tool("read", "/a"), tool("read", nil), tool("read", "/b")]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "read", calls: [call(nil), call("/a"), call(nil), call("/b")])]),
        ])
    }

    /// `count` counts CALLS, always — it can no longer disagree with what the run can show, which
    /// is what made positional zipping of results to details impossible before Task 2.
    func testCountIsAlwaysTheNumberOfCallsEvenWithNoDetailsAtAll() {
        let items = [tool("browser"), tool("browser"), tool("browser"), tool("browser"), tool("browser")]
        guard case .toolRun(let entries)? = groupActivity(items).first, let entry = entries.first else {
            return XCTFail("expected one .toolRun group with one entry")
        }
        XCTAssertEqual(entry.count, 5)
        XCTAssertEqual(entry.count, entry.calls.count)
        XCTAssertEqual(entry.calls.compactMap(\.detail), [])
    }

    /// mac-chat-parity Task 2: the result the reducer now keeps (Task 1) survives the fold into a
    /// display entry. Before Task 2 `groupActivity` bound those associated values to `_` and threw
    /// them away again, so the data was stored but unreachable from any view. Does NOT cover the
    /// reducer's own fold (`SessionModel` tests) or the rendered row.
    func testGroupingCarriesEachCallsResultAndIdentity() {
        let items = [
            tool("bash", "pnpm test", callId: "c1", output: "1146 pass", isError: false),
            tool("bash", "nope", callId: "c2", output: "command not found", isError: true),
        ]
        XCTAssertEqual(groupActivity(items), [
            .toolRun([ToolRunEntry(name: "bash", calls: [
                ToolCallRecord(callId: "c1", detail: "pnpm test", output: "1146 pass", isError: false),
                ToolCallRecord(callId: "c2", detail: "nope", output: "command not found", isError: true),
            ])]),
        ])
    }

    func testEmptyInputYieldsEmptyOutput() {
        XCTAssertEqual(groupActivity([]), [])
    }

    // MARK: toolGroupFragment (lowercase, sentence-building unit)

    func testToolGroupFragmentSingularPlural() {
        XCTAssertEqual(toolGroupFragment(name: "bash", count: 1), "ran a shell command")
        XCTAssertEqual(toolGroupFragment(name: "bash", count: 3), "ran 3 shell commands")
        XCTAssertEqual(toolGroupFragment(name: "task_create", count: 1), "created a task")
        XCTAssertEqual(toolGroupFragment(name: "task_create", count: 4), "created 4 tasks")
        XCTAssertEqual(toolGroupFragment(name: "task_update", count: 1), "updated a task")
        XCTAssertEqual(toolGroupFragment(name: "task_update", count: 2), "updated 2 tasks")
        XCTAssertEqual(toolGroupFragment(name: "task_list", count: 1), "checked tasks")
        XCTAssertEqual(toolGroupFragment(name: "task_list", count: 5), "checked tasks")
        XCTAssertEqual(toolGroupFragment(name: "read", count: 1), "read a file")
        XCTAssertEqual(toolGroupFragment(name: "read", count: 2), "read 2 files")
        XCTAssertEqual(toolGroupFragment(name: "write", count: 1), "wrote a file")
        XCTAssertEqual(toolGroupFragment(name: "write", count: 2), "wrote 2 files")
        XCTAssertEqual(toolGroupFragment(name: "edit", count: 1), "made an edit")
        XCTAssertEqual(toolGroupFragment(name: "edit", count: 2), "made 2 edits")
        XCTAssertEqual(toolGroupFragment(name: "ToolSearch", count: 1), "loaded a tool")
        XCTAssertEqual(toolGroupFragment(name: "ToolSearch", count: 2), "loaded 2 tools")
        XCTAssertEqual(toolGroupFragment(name: "Skill", count: 1), "loaded a skill")
        XCTAssertEqual(toolGroupFragment(name: "Skill", count: 2), "loaded 2 skills")
        XCTAssertEqual(toolGroupFragment(name: "ask_user", count: 1), "asked a question")
        XCTAssertEqual(toolGroupFragment(name: "ask_user", count: 2), "asked 2 questions")
        XCTAssertEqual(toolGroupFragment(name: "exit_plan_mode", count: 1), "presented a plan")
        XCTAssertEqual(toolGroupFragment(name: "exit_plan_mode", count: 2), "presented 2 plans")
        XCTAssertEqual(toolGroupFragment(name: "request_directory", count: 1), "requested a directory")
        XCTAssertEqual(toolGroupFragment(name: "request_directory", count: 2), "requested 2 directories")
    }

    func testToolGroupFragmentLsGetsListedGlobRevertsToSearchedGrepStaysSearched() {
        // Post-r1b: now that Norma has a native `ls` tool, `ls` gets "listed a/N directories" —
        // the label r1b had temporarily borrowed for `glob` as a stand-in. `glob` REVERTS to its
        // pre-r1b "searched"/"searched N times" (same fragment as `grep` — both are pattern
        // searches, not directory listings).
        XCTAssertEqual(toolGroupFragment(name: "ls", count: 1), "listed a directory")
        XCTAssertEqual(toolGroupFragment(name: "ls", count: 2), "listed 2 directories")
        XCTAssertEqual(toolGroupFragment(name: "glob", count: 1), "searched")
        XCTAssertEqual(toolGroupFragment(name: "glob", count: 2), "searched 2 times")
        XCTAssertEqual(toolGroupFragment(name: "grep", count: 1), "searched")
        XCTAssertEqual(toolGroupFragment(name: "grep", count: 3), "searched 3 times")
    }

    func testToolGroupFragmentUnrecognizedNameFallsBack() {
        XCTAssertEqual(toolGroupFragment(name: "mcp__foo__bar", count: 1), "used a tool")
        XCTAssertEqual(toolGroupFragment(name: "mcp__foo__bar", count: 3), "used 3 tools")
        XCTAssertEqual(toolGroupFragment(name: "some_future_tool", count: 1), "used a tool")
    }

    /// mac-chat-parity Task 2 (research §2.3 enumerates exactly these thirteen as falling through
    /// to "used a tool"; §2.5 item 4 asks for them). Every name here is a real registered daemon
    /// tool — verified against `name: "…"` across `packages/core/src/agent/tools/`. This is the
    /// MAC's vocabulary being extended, NOT iOS's `ToolPhrase` being ported (spec §7 forbids that:
    /// it matches capitalized Claude-Code names Norma's daemon never emits).
    func testToolGroupFragmentCoversTheToolsThatUsedToFallThrough() {
        XCTAssertEqual(toolGroupFragment(name: "browser", count: 1), "used the browser")
        XCTAssertEqual(toolGroupFragment(name: "browser", count: 5), "used the browser 5 times")
        XCTAssertEqual(toolGroupFragment(name: "web_fetch", count: 1), "fetched a page")
        XCTAssertEqual(toolGroupFragment(name: "web_fetch", count: 2), "fetched 2 pages")
        XCTAssertEqual(toolGroupFragment(name: "ReadPage", count: 1), "fetched a page")
        XCTAssertEqual(toolGroupFragment(name: "ReadPage", count: 3), "fetched 3 pages")
        XCTAssertEqual(toolGroupFragment(name: "web_search", count: 1), "searched the web")
        XCTAssertEqual(toolGroupFragment(name: "web_search", count: 2), "searched the web 2 times")
        XCTAssertEqual(toolGroupFragment(name: "Search", count: 1), "searched the web")
        XCTAssertEqual(toolGroupFragment(name: "Search", count: 4), "searched the web 4 times")
        XCTAssertEqual(toolGroupFragment(name: "computer", count: 1), "used the computer")
        XCTAssertEqual(toolGroupFragment(name: "computer", count: 2), "used the computer 2 times")
        XCTAssertEqual(toolGroupFragment(name: "lsp", count: 1), "checked the code")
        XCTAssertEqual(toolGroupFragment(name: "lsp", count: 2), "checked the code 2 times")
        XCTAssertEqual(toolGroupFragment(name: "notebook_edit", count: 1), "made a notebook edit")
        XCTAssertEqual(toolGroupFragment(name: "notebook_edit", count: 2), "made 2 notebook edits")
        XCTAssertEqual(toolGroupFragment(name: "AskQuestion", count: 1), "asked a question")
        XCTAssertEqual(toolGroupFragment(name: "AskQuestion", count: 2), "asked 2 questions")
        XCTAssertEqual(toolGroupFragment(name: "Workflow", count: 1), "ran a workflow")
        XCTAssertEqual(toolGroupFragment(name: "Workflow", count: 2), "ran 2 workflows")
        XCTAssertEqual(toolGroupFragment(name: "spawn_agent", count: 1), "started a subagent")
        XCTAssertEqual(toolGroupFragment(name: "spawn_agent", count: 3), "started 3 subagents")
        XCTAssertEqual(toolGroupFragment(name: "session_spawn", count: 1), "dispatched a session")
        XCTAssertEqual(toolGroupFragment(name: "session_spawn", count: 2), "dispatched 2 sessions")
        XCTAssertEqual(toolGroupFragment(name: "enter_worktree", count: 1), "entered a worktree")
        XCTAssertEqual(toolGroupFragment(name: "enter_worktree", count: 2), "entered 2 worktrees")
    }

    /// The browser session from research §2.3, end to end at the model level: five `browser` calls
    /// used to read "Used 5 tools" and expand to nothing. Does NOT cover the drawn row.
    func testTheBrowserWorkedExampleNowReadsAsTheBrowser() {
        let items = (0..<5).map { _ in tool("browser") }
        guard case .toolRun(let entries)? = groupActivity(items).first else {
            return XCTFail("expected one .toolRun group")
        }
        XCTAssertEqual(toolRunSentence(entries), "Used the browser 5 times")
    }

    // MARK: toolGroupLabel (capitalized single-fragment — r1 continuity)

    func testToolGroupLabelCapitalizesTheFragment() {
        XCTAssertEqual(toolGroupLabel(name: "bash", count: 1), "Ran a shell command")
        XCTAssertEqual(toolGroupLabel(name: "bash", count: 3), "Ran 3 shell commands")
        XCTAssertEqual(toolGroupLabel(name: "ls", count: 1), "Listed a directory")
        XCTAssertEqual(toolGroupLabel(name: "ls", count: 3), "Listed 3 directories")
        XCTAssertEqual(toolGroupLabel(name: "glob", count: 1), "Searched")
        XCTAssertEqual(toolGroupLabel(name: "grep", count: 1), "Searched")
        XCTAssertEqual(toolGroupLabel(name: "mcp__foo__bar", count: 1), "Used a tool")
    }

    // MARK: toolRunSentence

    /// N calls of one tool, no details — what the sentence tests care about.
    private func entry(_ name: String, count: Int) -> ToolRunEntry {
        ToolRunEntry(name: name, calls: (0..<count).map { _ in call(nil) })
    }

    func testSentenceForSingleEntryRunMatchesOldSimpleLabel() {
        let entries = [ToolRunEntry(name: "bash", calls: [call("ls"), call("pwd"), call("echo")])]
        XCTAssertEqual(toolRunSentence(entries), toolGroupLabel(name: "bash", count: 3))
        XCTAssertEqual(toolRunSentence(entries), "Ran 3 shell commands")
    }

    func testSentenceCombinesMultipleEntriesCommaJoinedFirstCapitalizedRestLowercase() {
        // CC screenshot said "Read 4 files, listed 1 directory, ran 8 shell commands" — but Norma's
        // own singular convention (matching every other verb: "a file" not "1 file") renders a
        // count of exactly 1 as "a directory", so the count-1 fragment here is "listed a directory".
        // Uses `ls` (not `glob`, which reverted to "searched" once `ls` shipped as its own tool).
        let entries = [entry("read", count: 4), entry("ls", count: 1), entry("bash", count: 8)]
        XCTAssertEqual(toolRunSentence(entries), "Read 4 files, listed a directory, ran 8 shell commands")
    }

    func testSentenceWithMultipleDirectoriesUsesTheCountedForm() {
        let entries = [entry("read", count: 4), entry("ls", count: 2), entry("bash", count: 8)]
        XCTAssertEqual(toolRunSentence(entries), "Read 4 files, listed 2 directories, ran 8 shell commands")
    }

    func testSentenceForEmptyRunIsEmptyString() {
        XCTAssertEqual(toolRunSentence([]), "")
    }

    // MARK: detail concatenation order (TranscriptToolGroupRow's expansion is view-level, but the
    // ordering it renders comes straight from each entry's call order — verify the model here, not
    // the view.)

    func testEntryDetailsAndEntryOrderTogetherGiveFullRunDetailOrder() {
        let items = [
            tool("read", "/a"), tool("read", "/b"),
            tool("glob", "*.swift"),
            tool("bash", "ls"), tool("bash", nil), tool("bash", "pwd"),
        ]
        guard case .toolRun(let entries)? = groupActivity(items).first else {
            return XCTFail("expected a single .toolRun group")
        }
        let detailLines = entries.flatMap { entry in
            entry.calls.compactMap { $0.detail.map { "\(entry.name) \($0)" } }
        }
        XCTAssertEqual(detailLines, [
            "read /a", "read /b",
            "glob *.swift",
            "bash ls", "bash pwd",
        ])
    }
}
