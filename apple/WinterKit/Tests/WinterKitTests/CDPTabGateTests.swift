import XCTest
@testable import WinterKit

/// ComputerV2 Phase 2 — what the browser link lets through to a tab, and back out: the allowlist, the
/// world rules, the subscriptions and the Network strip (`CDPTabGate`).
final class CDPTabGateTests: XCTestCase {

    private func obj(_ pairs: [String: JSONValue]) -> JSONValue { .object(pairs) }

    /// A gate that has seen a `"winter"` world created as context 7 (unique id "u7") on the tab's own
    /// session, and a main-world context 1.
    private func gateWithWinterWorld() -> CDPTabGate {
        let gate = CDPTabGate()
        gate.noteEvent(method: "Runtime.executionContextCreated",
                       params: obj(["context": obj(["id": .number(7), "name": .string("winter"), "uniqueId": .string("u7")])]),
                       cdpSessionId: nil)
        gate.noteEvent(method: "Runtime.executionContextCreated",
                       params: obj(["context": obj(["id": .number(1), "name": .string(""), "uniqueId": .string("u1")])]),
                       cdpSessionId: nil)
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
        gate.noteEvent(method: "Runtime.executionContextCreated",
                       params: obj(["context": obj(["id": .number(3), "name": .string("winter")])]), cdpSessionId: "S1")
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
}
