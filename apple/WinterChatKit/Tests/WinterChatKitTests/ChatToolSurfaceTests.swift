import Foundation
import XCTest
import WinterProtocol
@testable import WinterChatKit

/// THE TOOL SURFACE AND THE PROMPT MOVE TOGETHER — the phone's half of the daemon's "exactly one
/// search tool" rule, and the tripwire against the failure it exists to prevent: a prompt that names a
/// tool the session was never given, which is how a model ends up apologising for a tool that
/// "failed" when it was never there.
final class ChatToolSurfaceTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private func toolNames(exaKeyPresent: Bool) -> [String] {
        ChatEngine.toolSpecs(exaKeyPresent: exaKeyPresent).map(\.name)
    }

    // MARK: - the complement

    func testWithAnExaKeyTheSessionGetsSearchAndWebFetch() {
        XCTAssertEqual(toolNames(exaKeyPresent: true), ["Search", "WebFetch", "AskQuestion"])
    }

    func testWithoutAnExaKeyTheSessionGetsWebFetchOnly() {
        // `/answer` has no anonymous tier, so `Search` cannot be offered. The daemon's keyless
        // replacement (`WebSearch`, backed by Exa's hosted MCP) is NOT carried by this engine yet, so
        // the keyless session has exactly one web tool and the prompt says so.
        XCTAssertEqual(toolNames(exaKeyPresent: false), ["WebFetch", "AskQuestion"])
    }

    /// NEVER BOTH — the invariant, whichever way the key falls. (When `WebSearch` lands here, the
    /// "never neither" half becomes assertable too; until then a keyless session deliberately has no
    /// search tool at all, which is what `lookingThingsUp` tells the model.)
    func testSearchAndWebSearchAreNeverBothAdvertised() {
        for present in [true, false] {
            let names = Set(toolNames(exaKeyPresent: present))
            XCTAssertFalse(names.contains("Search") && names.contains("WebSearch"),
                           "exactly one search tool, never two")
            XCTAssertTrue(names.contains("WebFetch"), "WebFetch is unconditional")
        }
    }

    func testTheRetiredToolsAreGoneFromTheSurface() {
        for present in [true, false] {
            let names = Set(toolNames(exaKeyPresent: present))
            XCTAssertFalse(names.contains("ReadPage"))
            XCTAssertFalse(names.contains("FetchPage"))
        }
    }

    func testSearchesSchemaHasNoMaxResultsDial() {
        let search = ChatEngine.toolSpecs(exaKeyPresent: true).first { $0.name == "Search" }
        XCTAssertNotNil(search)
        XCTAssertFalse(search!.parametersJSON.contains("max_results"),
                       "`/answer` returns an answer, not a page of rows")
        XCTAssertTrue(search!.parametersJSON.contains("\"query\""))
    }

    func testWebFetchAdvertisesTheTwoFieldPortableSchema() {
        let fetch = ChatEngine.toolSpecs(exaKeyPresent: false).first { $0.name == "WebFetch" }
        XCTAssertNotNil(fetch)
        XCTAssertTrue(fetch!.parametersJSON.contains("\"required\":[\"url\",\"prompt\"]"))
        // The portable rendering: the three keywords that are claude's own first-party wire bytes are
        // deliberately absent, because several function-calling dialects refuse what they do not know.
        XCTAssertFalse(fetch!.parametersJSON.contains("$schema"))
        XCTAssertFalse(fetch!.parametersJSON.contains("additionalProperties"))
        XCTAssertFalse(fetch!.parametersJSON.contains("\"format\""))
    }

    // MARK: - the prompt never names a tool the session lacks

    func testTheKeyedPromptNamesSearchAndWebFetch() {
        let prompt = ChatEngine.defaultSystemPrompt(exaKeyPresent: true)
        XCTAssertTrue(prompt.contains("You can Search the web."))
        XCTAssertTrue(prompt.contains("WebFetch"))
        XCTAssertFalse(prompt.contains("ReadPage"))
        XCTAssertFalse(prompt.contains("WebSearch"), "not carried by this engine yet")
    }

    func testTheKeylessPromptNeverTellsTheModelToSearch() {
        let prompt = ChatEngine.defaultSystemPrompt(exaKeyPresent: false)
        XCTAssertFalse(prompt.contains("You can Search the web."))
        XCTAssertFalse(prompt.contains("WebSearch"))
        XCTAssertFalse(prompt.contains("ReadPage"))
        XCTAssertTrue(prompt.contains("You can open any page with WebFetch"))
        XCTAssertTrue(prompt.contains("has not stored an Exa API key"),
                      "and it says WHY there is no search, plus how to turn it on")
        XCTAssertTrue(prompt.contains("winter login --exa-key"))
    }

    /// The two doors read ONE value, so they cannot disagree: whatever the prompt claims about a search
    /// tool, the advertised list agrees.
    func testThePromptAndTheToolListAgreeOnBothSidesOfTheGate() {
        for present in [true, false] {
            let prompt = ChatEngine.defaultSystemPrompt(exaKeyPresent: present)
            let advertised = Set(ChatEngine.toolSpecs(exaKeyPresent: present).map(\.name))
            XCTAssertEqual(prompt.contains("You can Search the web."), advertised.contains("Search"),
                           "exaKeyPresent = \(present)")
        }
    }

    func testTheToolsetDerivesItsDefaultPromptFromTheKeyItWasGiven() {
        let keyed = ChatToolset(http: ScriptedChatHTTP(), cache: WebFetchCache(), exaKey: "k")
        XCTAssertTrue(keyed.exaKeyPresent)
        XCTAssertEqual(keyed.systemPrompt, ChatEngine.defaultSystemPrompt(exaKeyPresent: true))

        for empty in [nil, ""] as [String?] {
            let keyless = ChatToolset(http: ScriptedChatHTTP(), cache: WebFetchCache(), exaKey: empty)
            XCTAssertFalse(keyless.exaKeyPresent)
            XCTAssertEqual(keyless.systemPrompt, ChatEngine.defaultSystemPrompt(exaKeyPresent: false))
        }
    }

    // MARK: - what actually reaches the provider

    func testTheTurnAdvertisesTheSessionsOwnToolListAndPrompt() async {
        let provider = ScriptedChatProvider([[.textDelta("hi"), .done(.endTurn)]])
        let clock = t0
        let engine = ChatEngine(provider: provider, now: { clock })
        let tools = ChatToolset(http: ScriptedChatHTTP(), cache: WebFetchCache(), exaKey: nil)
        await engine.runTurn(session: ScriptedLocalSession(), userText: "hi", model: "openai/gpt-5.6-luna",
                             tools: tools, emit: { _ in })

        XCTAssertEqual(provider.request(0).tools.map(\.name), ["WebFetch", "AskQuestion"])
        XCTAssertEqual(provider.request(0).instructions, ChatEngine.defaultSystemPrompt(exaKeyPresent: false))
        XCTAssertEqual(provider.request(0).model, "gpt-5.6-luna", "the tag is split before the wire")
    }

    // MARK: - WebFetch through the engine, and where its tokens land

    func testWebFetchRoundTripsThroughTheEngineAndOnlyTheAnswerIsPersisted() async {
        let http = ScriptedChatHTTP([.html("<h1>Title</h1><p>page body</p>")])
        let digest = ScriptedChatProvider([[.textDelta("It is a title page."), .done(.endTurn)]])
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "WebFetch",
                       argumentsJSON: #"{"url":"https://a.test/x","prompt":"what is it?"}"#), .done(.toolCalls)],
            [.textDelta("It is a title page."), .done(.endTurn)],
        ])
        let clock = t0
        let engine = ChatEngine(provider: provider, now: { clock })
        let tools = ChatToolset(http: http, cache: WebFetchCache(), digestProvider: digest)
        let collector = EventCollector()
        await engine.runTurn(session: ScriptedLocalSession(), userText: "read it", model: "openai/gpt-5.6-luna",
                             tools: tools, emit: collector.callback)

        guard case .toolResult(let result) = collector.events[3] else { return XCTFail() }
        XCTAssertEqual(result.callId, "c1")
        XCTAssertFalse(result.isError)
        XCTAssertEqual(result.output, "It is a title page.")
        XCTAssertFalse(result.output.contains("page body"), "no raw page text is persisted into the log")
        // The digest model got the page and the session's own model id.
        XCTAssertTrue(digest.request(0).messageText.contains("page body"))
        XCTAssertEqual(digest.request(0).model, "gpt-5.6-luna")
    }

    /// The digest pass is an EXTRA provider call. It is real spend, so it joins the BILLING totals — and
    /// it must NOT join `contextTokens`, which is the max over the MAIN rounds' inputs and means how full
    /// the conversation itself got. A digest prompt is a separate throwaway context; counting it there
    /// would make the Mac's auto-compaction trigger fire on a number that is not the conversation.
    func testTheDigestPassesTokensJoinBillingButNeverContextTokens() async {
        let http = ScriptedChatHTTP([.plainText("PAGE")])
        let digest = ScriptedChatProvider([[.textDelta("A."), .usage(inputTokens: 5_000, outputTokens: 20), .done(.endTurn)]])
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "WebFetch",
                       argumentsJSON: #"{"url":"https://a.test/x","prompt":"p"}"#),
             .usage(inputTokens: 100, outputTokens: 10), .done(.toolCalls)],
            [.textDelta("done"), .usage(inputTokens: 120, outputTokens: 5), .done(.endTurn)],
        ])
        let clock = t0
        let engine = ChatEngine(provider: provider, now: { clock })
        let tools = ChatToolset(http: http, cache: WebFetchCache(), digestProvider: digest)
        let collector = EventCollector()
        await engine.runTurn(session: ScriptedLocalSession(), userText: "read it", model: "m",
                             tools: tools, emit: collector.callback)

        guard let completed = collector.first({ if case .turnCompleted(let v) = $0 { return v } else { return nil } }) else {
            return XCTFail()
        }
        XCTAssertEqual(completed.inputTokens, 5_220, "100 + 120 main + 5,000 digest")
        XCTAssertEqual(completed.outputTokens, 35, "10 + 5 main + 20 digest")
        XCTAssertEqual(completed.contextTokens, 120, "the MAX over the main rounds' inputs — the digest is not the conversation")
    }

    func testAModelThatCallsSearchWithNoKeyGetsTheActionableSentenceNotUnknownTool() async {
        let provider = ScriptedChatProvider([
            [.toolCall(callId: "c1", name: "Search", argumentsJSON: #"{"query":"q"}"#), .done(.toolCalls)],
            [.textDelta("ok"), .done(.endTurn)],
        ])
        let clock = t0
        let engine = ChatEngine(provider: provider, now: { clock })
        let collector = EventCollector()
        await engine.runTurn(session: ScriptedLocalSession(), userText: "look it up", model: "m",
                             tools: ChatToolset(http: ScriptedChatHTTP(), cache: WebFetchCache(), exaKey: nil),
                             emit: collector.callback)
        guard case .toolResult(let result) = collector.events[3] else { return XCTFail() }
        XCTAssertTrue(result.isError)
        XCTAssertEqual(result.output, SearchTool.noKeyMessage)
    }
}
