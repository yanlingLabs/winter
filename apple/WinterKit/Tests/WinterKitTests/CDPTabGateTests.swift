import XCTest
@testable import WinterKit

/// ComputerV2 Phase 2 — what the browser link lets through to a tab, and back out: the allowlist, the
/// world rules, the subscriptions and the Network strip (`CDPTabGate`).
final class CDPTabGateTests: XCTestCase {

    private func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

    /// A context the browser reports, as `Runtime.executionContextCreated` carries it.
    private func created(_ id: Int, name: String, unique: String? = nil, frame: String? = "F",
                         session: String? = nil, into gate: CDPTabGate) {
        var context: [String: JSONValue] = ["id": .number(Double(id)), "name": .string(name)]
        if let unique { context["uniqueId"] = .string(unique) }
        if let frame { context["auxData"] = obj(["frameId": .string(frame), "isDefault": .bool(name.isEmpty)]) }
        gate.noteEvent(method: "Runtime.executionContextCreated", params: obj(["context": .object(context)]),
                       cdpSessionId: session)
    }

    /// This link's own `Page.createIsolatedWorld` in `frame`, answered with context `id`.
    private func made(_ id: Int, frame: String = "F", session: String? = nil, into gate: CDPTabGate) {
        gate.noteResult(method: "Page.createIsolatedWorld",
                        params: obj(["frameId": .string(frame), "worldName": .string("winter")]), cdpSessionId: session,
                        result: obj(["executionContextId": .number(Double(id))]))
    }

    /// A gate whose link made a `"winter"` world as context 7 (unique id "u7") in frame F on the tab's
    /// own session — announced, as the browser does, before the call that made it answered — beside the
    /// page's main-world context 1.
    private func gateWithWinterWorld() -> CDPTabGate {
        let gate = CDPTabGate()
        created(1, name: "", unique: "u1", into: gate)
        created(7, name: "winter", unique: "u7", into: gate)
        made(7, into: gate)
        return gate
    }

    // MARK: - The allowlist

    func testAMethodOffTheAllowlistIsRefused() {
        let gate = CDPTabGate()
        for method in ["Network.getCookies", "Storage.getCookies", "Network.getResponseBody", "Runtime.compileScript",
                       "Page.addScriptToEvaluateOnNewDocument", "Browser.close", "Target.createTarget"] {
            XCTAssertNotNil(gate.check(method: method, params: obj([:]), cdpSessionId: nil), method)
        }
    }

    func testEveryAllowlistedMethodWithoutAWorldRulePasses() {
        let gate = CDPTabGate()
        let worldRuled: Set<String> = ["Runtime.evaluate", "Runtime.callFunctionOn", "DOM.resolveNode",
                                       "Page.createIsolatedWorld", "Page.navigate"]
        for method in CDPAllowlist.methods where !worldRuled.contains(method) {
            XCTAssertNil(gate.check(method: method, params: obj([:]), cdpSessionId: nil), method)
        }
    }

    // MARK: - The world rules

    func testEvaluateRunsOnlyInAWinterWorld() {
        let gate = gateWithWinterWorld()
        XCTAssertNil(gate.check(method: "Runtime.evaluate",
                                params: obj(["expression": .string("1"), "contextId": .number(7)]), cdpSessionId: nil))
        XCTAssertNil(gate.check(method: "Runtime.evaluate",
                                params: obj(["expression": .string("1"), "uniqueContextId": .string("u7")]), cdpSessionId: nil))
        // The page's own world, no context at all, an unknown one, and a winter id on another session.
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate",
                                   params: obj(["expression": .string("1"), "contextId": .number(1)]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["expression": .string("1")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate",
                                   params: obj(["expression": .string("1"), "contextId": .number(99)]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate",
                                   params: obj(["expression": .string("1"), "uniqueContextId": .string("u1")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate",
                                   params: obj(["expression": .string("1"), "contextId": .number(7)]), cdpSessionId: "child"))
    }

    func testAContextGoneIsNoLongerUsable() {
        let gate = gateWithWinterWorld()
        gate.noteEvent(method: "Runtime.executionContextDestroyed",
                       params: obj(["executionContextId": .number(7)]), cdpSessionId: nil)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(7)]), cdpSessionId: nil))

        let cleared = gateWithWinterWorld()
        cleared.noteEvent(method: "Runtime.executionContextsCleared", params: obj([:]), cdpSessionId: nil)
        XCTAssertEqual(cleared.knownContexts(), [])
    }

    func testCallFunctionOnNeedsAWinterContextOrAnObjectMintedInOne() {
        let gate = gateWithWinterWorld()
        // An object minted by an evaluate in the winter world.
        gate.noteResult(method: "Runtime.evaluate", params: obj(["contextId": .number(7), "objectGroup": .string("g")]),
                        cdpSessionId: nil,
                        result: obj(["result": obj(["type": .string("object"), "objectId": .string("obj-1")])]))
        XCTAssertNil(gate.check(method: "Runtime.callFunctionOn",
                                params: obj(["functionDeclaration": .string("function(){}"), "objectId": .string("obj-1")]),
                                cdpSessionId: nil))
        XCTAssertNil(gate.check(method: "Runtime.callFunctionOn",
                                params: obj(["functionDeclaration": .string("function(){}"), "executionContextId": .number(7)]),
                                cdpSessionId: nil))
        // An object never seen (the page's world), an unanchored call, a main-world context.
        XCTAssertNotNil(gate.check(method: "Runtime.callFunctionOn",
                                   params: obj(["functionDeclaration": .string("f"), "objectId": .string("page-obj")]),
                                   cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.callFunctionOn", params: obj(["functionDeclaration": .string("f")]),
                                   cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.callFunctionOn",
                                   params: obj(["functionDeclaration": .string("f"), "executionContextId": .number(1)]),
                                   cdpSessionId: nil))
        // An argument naming a foreign object.
        XCTAssertNotNil(gate.check(method: "Runtime.callFunctionOn",
                                   params: obj(["functionDeclaration": .string("f"), "objectId": .string("obj-1"),
                                                "arguments": .array([obj(["objectId": .string("page-obj")])])]),
                                   cdpSessionId: nil))
        // Released → gone.
        gate.noteResult(method: "Runtime.releaseObjectGroup", params: obj(["objectGroup": .string("g")]),
                        cdpSessionId: nil, result: obj([:]))
        XCTAssertNotNil(gate.check(method: "Runtime.callFunctionOn",
                                   params: obj(["functionDeclaration": .string("f"), "objectId": .string("obj-1")]),
                                   cdpSessionId: nil))
    }

    func testObjectsDieWithTheirContext() {
        let gate = gateWithWinterWorld()
        gate.noteResult(method: "DOM.resolveNode", params: obj(["executionContextId": .number(7)]), cdpSessionId: nil,
                        result: obj(["object": obj(["objectId": .string("node-1")])]))
        XCTAssertEqual(gate.knownObjectCount(), 1)
        gate.noteEvent(method: "Runtime.executionContextDestroyed", params: obj(["executionContextId": .number(7)]),
                       cdpSessionId: nil)
        XCTAssertEqual(gate.knownObjectCount(), 0)
    }

    func testResolveNodeOnlyIntoAWinterWorld() {
        let gate = gateWithWinterWorld()
        XCTAssertNil(gate.check(method: "DOM.resolveNode",
                                params: obj(["backendNodeId": .number(4), "executionContextId": .number(7)]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "DOM.resolveNode", params: obj(["backendNodeId": .number(4)]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "DOM.resolveNode",
                                   params: obj(["backendNodeId": .number(4), "executionContextId": .number(1)]), cdpSessionId: nil))
    }

    func testIsolatedWorldsAreWinterOnlyAndNeverUniversal() {
        let gate = CDPTabGate()
        XCTAssertNil(gate.check(method: "Page.createIsolatedWorld",
                                params: obj(["frameId": .string("F"), "worldName": .string("winter")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Page.createIsolatedWorld",
                                   params: obj(["frameId": .string("F"), "worldName": .string("other")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Page.createIsolatedWorld", params: obj(["frameId": .string("F")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Page.createIsolatedWorld",
                                   params: obj(["frameId": .string("F"), "worldName": .string("winter"),
                                                "grantUniveralAccess": .bool(true)]), cdpSessionId: nil))
        // The context it answers is a winter one, even before (or without) the created event.
        gate.noteResult(method: "Page.createIsolatedWorld", params: obj(["worldName": .string("winter")]), cdpSessionId: nil,
                        result: obj(["executionContextId": .number(12)]))
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(12)]), cdpSessionId: nil))
    }

    func testNavigationNeverRunsCodeInThePagesWorld() {
        let gate = CDPTabGate()
        for url in ["https://example.com/", "http://localhost:3000", "about:blank", "HTTPS://EXAMPLE.COM"] {
            XCTAssertNil(gate.check(method: "Page.navigate", params: obj(["url": .string(url)]), cdpSessionId: nil), url)
        }
        for url in ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "chrome://settings",
                    "about:srcdoc", "view-source:https://example.com"] {
            XCTAssertNotNil(gate.check(method: "Page.navigate", params: obj(["url": .string(url)]), cdpSessionId: nil), url)
        }
        XCTAssertNotNil(gate.check(method: "Page.navigate", params: obj([:]), cdpSessionId: nil))
    }

    func testAChildSessionHasItsOwnWorlds() {
        let gate = CDPTabGate()
        made(3, frame: "OOPIF", session: "S1", into: gate)
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(3)]), cdpSessionId: "S1"))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(3)]), cdpSessionId: nil))
        // The child detaching takes its worlds with it.
        gate.noteEvent(method: "Target.detachedFromTarget", params: obj(["sessionId": .string("S1")]), cdpSessionId: nil)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(3)]), cdpSessionId: "S1"))
    }

    // MARK: - Events

    func testOnlySubscribedAllowlistedEventsLeave() {
        let gate = CDPTabGate()
        XCTAssertEqual(gate.disposition(forEvent: "Page.frameNavigated"), .drop, "nothing is subscribed yet")
        XCTAssertNil(gate.subscribe(["Page.frameNavigated", "Network.requestWillBeSent"]))
        XCTAssertEqual(gate.disposition(forEvent: "Page.frameNavigated"), .forward)
        XCTAssertEqual(gate.disposition(forEvent: "Network.requestWillBeSent"), .forwardStripped)
        XCTAssertEqual(gate.disposition(forEvent: "Page.loadEventFired"), .drop, "allowlisted, not subscribed")
        XCTAssertEqual(gate.disposition(forEvent: "Network.responseReceived"), .drop, "not allowlisted")
    }

    func testASubscribeOutsideTheAllowlistIsRefusedWhole() {
        let gate = CDPTabGate()
        XCTAssertNil(gate.subscribe(["Page.frameNavigated"]))
        let refusal = gate.subscribe(["Page.loadEventFired", "Network.responseReceived"])
        XCTAssertNotNil(refusal)
        XCTAssertTrue(refusal?.message.contains("Network.responseReceived") == true)
        XCTAssertEqual(gate.subscribed, ["Page.frameNavigated"], "a refused subscribe changes nothing")
        XCTAssertNil(gate.subscribe([]))
        XCTAssertEqual(gate.subscribed, [])
    }

    func testNetworkParamsAreCutToThree() {
        let full = obj(["requestId": .string("r1"), "timestamp": .number(12.5), "type": .string("Document"),
                        "request": obj(["url": .string("https://x/?token=secret"), "headers": obj(["Cookie": .string("c")])]),
                        "documentURL": .string("https://x/")])
        XCTAssertEqual(CDPTabGate.strippedNetworkParams(full),
                       obj(["requestId": .string("r1"), "timestamp": .number(12.5), "type": .string("Document")]))
        XCTAssertEqual(CDPTabGate.strippedNetworkParams(.string("x")), obj([:]))
    }

    // MARK: - The amended world rules (cdp-allowlist.ts, f0853b5a)

    func testAReloadCarryingAScriptIsRefused() {
        let gate = CDPTabGate()
        XCTAssertNil(gate.check(method: "Page.reload", params: obj([:]), cdpSessionId: nil))
        XCTAssertNil(gate.check(method: "Page.reload", params: obj(["ignoreCache": .bool(true)]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Page.reload",
                                   params: obj(["scriptToEvaluateOnLoad": .string("document.cookie")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Page.reload", params: obj(["scriptToEvaluateOnLoad": .string("")]),
                                   cdpSessionId: nil), "carrying the key at all")
    }

    /// A cross-process navigation hands a process-local id out again: the winter world was 7, and now
    /// the page's own world is 7. No "destroyed" event reached the gate in between — the unique ids are
    /// what tell the two apart.
    func testAReusedContextIdIsWinterOnlyWhileItsLatestContextIs() {
        let gate = CDPTabGate()
        created(7, name: "winter", unique: "A", into: gate)
        made(7, into: gate)
        gate.noteResult(method: "Runtime.evaluate", params: obj(["contextId": .number(7)]), cdpSessionId: nil,
                        result: obj(["result": obj(["objectId": .string("o1")])]))
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(7)]), cdpSessionId: nil))
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["uniqueContextId": .string("A")]), cdpSessionId: nil))

        created(7, name: "", unique: "B", into: gate)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(7)]), cdpSessionId: nil),
                        "7 is the page's own world now")
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["uniqueContextId": .string("A")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.callFunctionOn",
                                   params: obj(["functionDeclaration": .string("f"), "objectId": .string("o1")]), cdpSessionId: nil),
                        "objects of the old world go with it")
        XCTAssertNotNil(gate.check(method: "DOM.resolveNode", params: obj(["executionContextId": .number(7)]), cdpSessionId: nil))
    }

    /// The other order: a NEW winter world (this link's, in a frame it made one in) takes the id, and
    /// only then does the OLD context's "destroyed" arrive. Matched by unique id, it takes nothing.
    func testALateDestroyOfAnOlderContextLeavesTheNewWinterWorld() {
        let gate = CDPTabGate()
        created(7, name: "winter", unique: "A", into: gate)
        made(7, into: gate)
        created(7, name: "winter", unique: "C", into: gate)
        gate.noteEvent(method: "Runtime.executionContextDestroyed",
                       params: obj(["executionContextId": .number(7), "executionContextUniqueId": .string("A")]),
                       cdpSessionId: nil)
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(7)]), cdpSessionId: nil))
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["uniqueContextId": .string("C")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["uniqueContextId": .string("A")]), cdpSessionId: nil))

        gate.noteEvent(method: "Runtime.executionContextDestroyed",
                       params: obj(["executionContextId": .number(7), "executionContextUniqueId": .string("C")]),
                       cdpSessionId: nil)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(7)]), cdpSessionId: nil))
    }

    // MARK: - A winter world is one this link made (cdp-allowlist.ts, f64d0a77)

    /// Another extension's — or a page's — world can carry the same name. The name alone never counts.
    func testANameAloneNeverMakesAWinterWorld() {
        let gate = CDPTabGate()
        created(5, name: "winter", unique: "X", frame: "G", into: gate)
        created(6, name: "winter", unique: "Y", frame: nil, into: gate)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(5)]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["uniqueContextId": .string("X")]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(6)]), cdpSessionId: nil))
        XCTAssertNotNil(gate.check(method: "DOM.resolveNode", params: obj(["executionContextId": .number(5)]), cdpSessionId: nil))
        // …and a world this link made in frame F does not lend its standing to frame G.
        made(9, frame: "F", into: gate)
        created(10, name: "winter", unique: "Z", frame: "G", into: gate)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(10)]), cdpSessionId: nil))
    }

    /// The browser announces a world's context before it answers the call that made it: the
    /// announcement waits as a candidate, and the answer confirms it — unique id included.
    func testAWorldAnnouncedBeforeItsAnswerIsConfirmedByIt() {
        let gate = CDPTabGate()
        created(8, name: "winter", unique: "U8", frame: "F", into: gate)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(8)]), cdpSessionId: nil),
                        "not this link's until its own call answers")
        made(8, frame: "F", into: gate)
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(8)]), cdpSessionId: nil))
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["uniqueContextId": .string("U8")]), cdpSessionId: nil))
    }

    /// A new document in a frame this link made a world in: the browser's winter-named context there
    /// is that world again; the frame going away ends that.
    func testAWinterContextInAFrameTheLinkMadeOneInCounts() {
        let gate = gateWithWinterWorld()
        gate.noteEvent(method: "Runtime.executionContextsCleared", params: obj([:]), cdpSessionId: nil)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(7)]), cdpSessionId: nil))
        created(12, name: "winter", unique: "u12", frame: "F", into: gate)
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(12)]), cdpSessionId: nil))

        gate.noteEvent(method: "Page.frameDetached", params: obj(["frameId": .string("F")]), cdpSessionId: nil)
        created(13, name: "winter", unique: "u13", frame: "F", into: gate)
        XCTAssertNotNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(13)]), cdpSessionId: nil))
    }

    /// An isolated world made by `Page.createIsolatedWorld` is winter at once, whatever unique id the
    /// browser last reported under its number for some other context.
    func testACreatedWorldIsWinterEvenOverAStaleUniqueId() {
        let gate = CDPTabGate()
        gate.noteEvent(method: "Runtime.executionContextCreated",
                       params: obj(["context": obj(["id": .number(9), "name": .string(""), "uniqueId": .string("P")])]),
                       cdpSessionId: nil)
        gate.noteResult(method: "Page.createIsolatedWorld", params: obj(["worldName": .string("winter")]), cdpSessionId: nil,
                        result: obj(["executionContextId": .number(9)]))
        XCTAssertNil(gate.check(method: "Runtime.evaluate", params: obj(["contextId": .number(9)]), cdpSessionId: nil))
    }
}
