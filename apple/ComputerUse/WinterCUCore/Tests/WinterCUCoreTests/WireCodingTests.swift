import XCTest
@testable import WinterCUCore

/// The params/results decode straight from the spine's JSON (§2.1, §3b) and encode back unchanged.
final class WireCodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func json<T: Encodable>(_ v: T) throws -> [String: Any] {
        let d = try JSONEncoder().encode(v)
        return try JSONSerialization.jsonObject(with: d) as! [String: Any]
    }

    func testActParamsWithEveryActionKind() throws {
        let kinds: [(String, CUAction)] = [
            (#"{"kind":"click","ref":12,"button":"right","count":2,"modifiers":["cmd"]}"#,
             .click(CUClickAction(ref: 12, button: .right, count: 2, modifiers: ["cmd"]))),
            (#"{"kind":"click","point":[10,20],"shotId":"t1.i3"}"#, .click(CUClickAction(point: [10, 20], shotId: "t1.i3"))),
            (#"{"kind":"setValue","ref":3,"value":"hi"}"#, .setValue(CUSetValueAction(ref: 3, value: "hi"))),
            (#"{"kind":"type","text":"abc","into":4}"#, .type(CUTypeAction(text: "abc", into: 4))),
            (#"{"kind":"paste","text":"**b**","format":"markdown"}"#, .paste(CUPasteAction(text: "**b**", format: .markdown))),
            (#"{"kind":"key","combo":"cmd+s","repeat":3}"#, .key(CUKeyAction(combo: "cmd+s", repeat: 3))),
            (#"{"kind":"scroll","ref":9,"direction":"down","pages":2}"#, .scroll(CUScrollAction(ref: 9, direction: .down, pages: 2))),
            (#"{"kind":"drag","from":{"ref":1},"to":{"point":[5,6]},"shotId":"t1.i1"}"#,
             .drag(CUDragAction(from: CUDragEnd(ref: 1), to: CUDragEnd(point: [5, 6]), shotId: "t1.i1"))),
            (#"{"kind":"select","ref":2,"text":"eggs","before":"milk, ","caret":"end"}"#,
             .select(CUSelectAction(ref: 2, text: "eggs", before: "milk, ", caret: .end))),
            (#"{"kind":"action","ref":20,"name":"show menu"}"#, .action(CUAXAction(ref: 20, name: "show menu"))),
            (#"{"kind":"menu","path":["File","Export…"]}"#, .menu(CUMenuAction(path: ["File", "Export…"]))),
        ]
        for (actionJSON, expected) in kinds {
            let wire = #"{"targetId":"t1","sessionId":"s_1","callId":"c1","action":"# + actionJSON
                + #","access":"full","allowForeground":false,"privatePath":true}"#
            let p = try decode(TargetActParams.self, wire)
            XCTAssertEqual(p.action, expected, actionJSON)
            XCTAssertEqual(p.action.kind, try json(p)["action"].flatMap { ($0 as? [String: Any])?["kind"] as? String })
            // Round trip.
            let again = try JSONDecoder().decode(TargetActParams.self, from: JSONEncoder().encode(p))
            XCTAssertEqual(again, p)
        }
    }

    /// 1.7.0 (desktop visits): the new params decode, are absent when not sent, and the results carry `visit`
    /// only when one happened.
    func testDesktopVisitFields() throws {
        let act = try decode(TargetActParams.self, #"{"targetId":"t1","sessionId":"s","callId":"c","action":{"kind":"menu","path":["File"]},"access":"full","allowForeground":true,"privatePath":true,"desktopVisit":true}"#)
        XCTAssertEqual(act.desktopVisit, true)
        let old = try decode(TargetActParams.self, #"{"targetId":"t1","sessionId":"s","callId":"c","action":{"kind":"menu","path":["File"]},"access":"full","allowForeground":false,"privatePath":true}"#)
        XCTAssertNil(old.desktopVisit, "an older daemon never asks for a visit")
        XCTAssertNil(try json(old)["desktopVisit"])
        let shot = try decode(TargetScreenshotParams.self, #"{"targetId":"t1","budget":{"maxLongEdge":800,"quality":0.7},"live":true,"desktopVisit":false}"#)
        XCTAssertEqual(shot.live, true)
        XCTAssertEqual(shot.desktopVisit, false)
        let plain = try json(TargetActResult(rung: 2))
        XCTAssertNil(plain["visit"], "no visit, no key")
        let visited = try json(TargetActResult(rung: 4, visit: CUVisitReport(ms: 420, returned: true)))
        XCTAssertEqual(visited["visit"] as? [String: AnyHashable], ["ms": 420, "returned": true])
        let moved = try json(TargetScreenshotResult(imageBase64: "", mime: "image/jpeg", width: 1, height: 1, shotId: "t1.i1",
                                                    settled: true, waitedMs: 0,
                                                    visit: CUVisitReport(ms: 900, returned: false, userMoved: true, detail: "left there")))
        XCTAssertEqual(moved["visit"] as? [String: AnyHashable], ["ms": 900, "returned": false, "userMoved": true, "detail": "left there"])
        let e = CUError.needsDesktopVisit("Safari", why: .live)
        XCTAssertEqual(e.code, "needs_desktop_visit")
        XCTAssertEqual(e.data, ["why": .string("live")])
        XCTAssertFalse(e.message.contains("\""), "no screen text: only the app's name")
    }

    func testUnknownActionKindIsRejected() {
        XCTAssertThrowsError(try decode(CUAction.self, #"{"kind":"teleport"}"#))
    }

    func testUnions() throws {
        XCTAssertEqual(try decode(TargetBindParams.self, #"{"sessionId":"s","app":"Notes","window":"Groceries","mirror":true}"#).window,
                       .title("Groceries"))
        XCTAssertEqual(try decode(TargetBindParams.self, #"{"sessionId":"s","app":"Notes","window":4711,"mirror":false}"#).window,
                       .id(4711))
        XCTAssertNil(try decode(TargetBindParams.self, #"{"sessionId":"s","app":"Notes","mirror":false}"#).window)
        XCTAssertEqual(try decode(TargetFindParams.self, #"{"targetId":"t","query":"Save"}"#).query, .text("Save"))
        XCTAssertEqual(try decode(TargetFindParams.self, #"{"targetId":"t","query":{"role":"button","name":"Save"}}"#).query,
                       .fields(role: "button", name: "Save", text: nil))
        XCTAssertEqual(try decode(TargetWaitForParams.self, #"{"targetId":"t","cond":{"gone":12},"timeoutMs":100}"#).cond.gone, .ref(12))
        XCTAssertEqual(try decode(TargetWaitForParams.self, #"{"targetId":"t","cond":{"gone":"Loading"},"timeoutMs":100}"#).cond.gone,
                       .text("Loading"))
        XCTAssertEqual(try decode(ScreenScreenshotParams.self,
                                  #"{"display":"all","excludeBundleIds":[],"budget":{"maxLongEdge":1280,"quality":0.8}}"#).display, .all)
        XCTAssertEqual(try decode(ScreenScreenshotParams.self,
                                  #"{"display":1,"excludeBundleIds":["a"],"budget":{"maxLongEdge":1568,"tile":28,"maxTiles":1568,"quality":0.8}}"#).display,
                       .index(1))
        XCTAssertEqual(try json(["w": CUWindowSelector.id(5)])["w"] as? Int, 5)
        XCTAssertEqual(try json(["w": CUWindowSelector.title("A")])["w"] as? String, "A")
        XCTAssertEqual(try json(["d": CUDisplaySelector.all])["d"] as? String, "all")
    }

    func testResultsEncodeTheSpineKeys() throws {
        let r = TargetSnapshotResult(snapshotId: "t1.s1", text: "x", isDiff: true, changedRatio: 0.25, settled: false, waitedMs: 1500)
        let o = try json(r)
        XCTAssertEqual(Set(o.keys), ["snapshotId", "text", "isDiff", "changedRatio", "settled", "waitedMs"])
        let s = TargetScreenshotResult(imageBase64: "AA==", mime: "image/jpeg", width: 2, height: 1, shotId: "t1.i1",
                                       settled: true, waitedMs: 3)
        XCTAssertEqual(Set(try json(s).keys), ["imageBase64", "mime", "width", "height", "shotId", "settled", "waitedMs"])
        XCTAssertEqual(try json(CUEmpty()).count, 0)
        let bind = TargetBindResult(targetId: "t1", app: CUBoundApp(name: "Notes", bundleId: "com.apple.Notes", pid: 9),
                                    window: CUWindowInfo(id: 3, title: "G", frame: [0, 25, 800, 600]))
        let b = try json(bind)
        XCTAssertEqual((b["window"] as? [String: Any])?["frame"] as? [Double], [0, 25, 800, 600])
        XCTAssertEqual(try json(TargetActResult(rung: 3, detail: nil)).keys.sorted(), ["rung"])
    }

    func testParamsWithoutOptionalCallIdStillDecode() throws {
        let p = try decode(TargetSnapshotParams.self, #"{"targetId":"t1","since":"t1.s2","settle":{"maxMs":1500}}"#)
        XCTAssertNil(p.callId)
        XCTAssertEqual(p.settle, CUSettleOption(maxMs: 1500))
        XCTAssertEqual(try decode(TargetWaitIdleParams.self, #"{"targetId":"t","quietMs":150,"timeoutMs":3000}"#).quietMs, 150)
    }

    func testErrorShape() throws {
        let e = CUError.staleRef(12)
        let o = try json(e)
        XCTAssertEqual(o["code"] as? String, "stale_ref")
        XCTAssertEqual((o["data"] as? [String: Any])?["ref"] as? Int, 12, "integral numbers encode as integers")
        XCTAssertEqual(CUError.busy().data?["retryable"], .bool(true))
        XCTAssertEqual(CUError.permissionMissing(.screenRecording).data?["permission"], .string("screenRecording"))
        XCTAssertEqual(CUError.waitTimeout(seen: "x", waitedMs: 5).data?["seen"], .string("x"))
        let back = try JSONDecoder().decode(CUError.self, from: JSONEncoder().encode(e))
        XCTAssertEqual(back, e)
    }

    func testCUJSONRoundTrip() throws {
        let v: CUJSON = .object(["a": .array([.number(1), .number(1.5), .string("s"), .bool(true), .null])])
        let back = try JSONDecoder().decode(CUJSON.self, from: JSONEncoder().encode(v))
        XCTAssertEqual(back, v)
    }
}
