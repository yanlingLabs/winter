import AppKit
import NormaProtocol
import XCTest
@testable import Norma

/// b2-agent-browser Task 5 — **the interaction verbs, and the sensitive floor.**
///
/// Separate from `PanelCommandConsumerTests` (Task 3's, which pins the read set, the fifth door, the
/// latch and the caps) for one reason that matters: every verb here is a CHAIN of CDP round trips,
/// so the fixture is a *transcript* rather than a single call, and the assertions are about the SHAPE
/// of what crossed the bridge. Splitting keeps Task 3's rows readable and keeps the transcript
/// machinery in one place.
///
/// The two questions this file exists to answer, both of which are security questions:
///
///  1. **Does a model string ever become code?** `assertIsDataNotCode` walks the whole transcript and
///     asserts the selector (and the typed text) appear ONLY as the value of the parameter that is
///     data by construction — never inside an `expression`, a `functionDeclaration`, or a method
///     name. Mutation: resolve elements with `Runtime.evaluate` over a concatenated selector, and
///     every row that calls it reds.
///  2. **Does the floor fail CLOSED?** Break the inspector — make `DOM.describeNode` fail, or answer
///     something unreadable — and `type` must start REFUSING, never allowing. The rows are written
///     so the mutation reds the happy path (a safe field stops being typed into) and leaves the
///     refusal rows green, which is the direction that proves it.
///
/// What is deliberately not here: whether Chromium really clicks what `Input.dispatchMouseEvent`
/// aims at. No CEF exists under XCTest (spec §9), so what a method DOES is a live-gate question and
/// what is SENT is this file's.
@MainActor
final class PanelCommandInteractionTests: XCTestCase {

    // MARK: - The world

    struct Sent: Equatable {
        var ok: Bool
        var result: String?
    }

    private var cef = BrowserRuntimeTests.CEFRecorder()
    private var clock = BrowserRuntimeTests.FakeScheduler()
    private var sent: [Sent] = []
    private var consumer: PanelCommandConsumer!
    private var runtime: BrowserRuntime!

    override func setUp() {
        super.setUp()
        cef = BrowserRuntimeTests.CEFRecorder()
        clock = BrowserRuntimeTests.FakeScheduler()
        sent = []
        PanelWebTabModels.removeAllForTesting()

        runtime = BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
        runtime.apply([.create(tabId: "t1", url: "https://start")],
                      tabs: ["s1": [BrowserTabState(tabId: "t1", url: nil, isShown: false, title: nil)]],
                      sessionOf: { _ in "s1" })
        clock.runPendingWork()
        cef.forgetLog()
        consumer = PanelCommandConsumer(
            runtime: runtime,
            sendResult: { [unowned self] _, _, ok, result, _ in
                self.sent.append(Sent(ok: ok, result: result))
            },
            scheduler: clock.scheduler)
    }

    override func tearDown() {
        PanelWebTabModels.removeAllForTesting()
        super.tearDown()
    }

    /// Built as WIRE JSON and decoded, never with a memberwise initialiser — the same call
    /// `PanelCommandConsumerTests` makes, and for the same reason: `PanelCommand`'s init is internal
    /// to NormaProtocol, and going through the real decode keeps a fixture from describing an `args`
    /// payload the daemon could not emit.
    private func command(_ action: String, args: [String: Any]? = nil, tabId: String? = "t1",
                         deadlineMs: Int = 15_000) -> SessionEvent.PanelCommand {
        var fields: [String: Any] = [
            "type": "panel_command", "seq": 1, "sessionId": "s1", "ts": 0,
            "commandId": "pcmd_1", "action": action, "deadlineMs": deadlineMs,
        ]
        if let tabId { fields["tabId"] = tabId }
        if let args { fields["args"] = args }
        // swiftlint:disable:next force_try — a dictionary of literals; a throw here is a broken test.
        let data = try! JSONSerialization.data(withJSONObject: fields)
        guard case .panelCommand(let decoded)? = try? JSONDecoder().decode(SessionEvent.self, from: data)
        else {
            XCTFail("the fixture did not decode as a panel_command")
            fatalError("unreachable — XCTFail above")
        }
        return decoded
    }

    // MARK: - The transcript

    struct CDPCall {
        var method: String
        var params: [String: Any]
    }

    /// What actually crossed the bridge, parsed back out of the recorder's log line
    /// (`"c1 cdp <method> params=<json>"`).
    private func transcript() -> [CDPCall] {
        cef.log.compactMap { line in
            guard let marker = line.range(of: " cdp ") else { return nil }
            let rest = line[marker.upperBound...]
            guard let split = rest.range(of: " params=") else { return nil }
            let json = String(rest[split.upperBound...])
            let params = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
            return CDPCall(method: String(rest[..<split.lowerBound]), params: params ?? [:])
        }
    }

    private func methods() -> [String] { transcript().map(\.method) }

    /// Answer the outstanding CDP calls in order, one payload per hop. Each answer runs the
    /// consumer's completion synchronously, which dispatches the next hop — so a chain is driven by
    /// handing it its replies.
    private func answer(_ payloads: [String], ok: Bool = true) {
        for payload in payloads {
            XCTAssertTrue(cef.answerNextCDP(ok: ok, payload: payload),
                          "the chain stopped early — nothing was waiting for \(payload)")
        }
    }

    /// **The data-never-code assertion.** `value` may appear in the transcript ONLY as the value of
    /// `underKey`, and nowhere else — not in a method name, not in an `expression`, not in a
    /// `functionDeclaration`, not in any other parameter.
    ///
    /// **RECURSIVE since fix round 1 (review Minor-4).** It used to walk the params dictionary one
    /// level deep and inspect only `String` leaves, which was enough for the shapes that exist —
    /// and blind to the most likely shape a future arm would reach for: `Runtime.callFunctionOn`'s
    /// `arguments: [{value: text}]`, an array of objects. That is the CDP-sanctioned way to bind a
    /// model string as data, so the day someone uses it correctly this assertion must see the string
    /// rather than silently see nothing at all. Arrays and nested objects are now walked; the KEY
    /// PATH is reported so a violation says where it was found, and the key compared against
    /// `underKey` is the LEAF one (`arguments[0].value` is judged as `value`).
    ///
    /// **What it still cannot see:** a breakout smuggled inside a non-`String` leaf — a number, a
    /// bool, or a string re-encoded (base64, percent-escaped, UTF-16 escapes) so that a literal
    /// `contains` misses it. It compares text, so it catches text. The structural guarantee is
    /// upstream: `expression` and `functionDeclaration` are compared byte-for-byte against this
    /// app's own constants elsewhere in this file, which is what makes "no model string is in them"
    /// true independently of what this walk can spot.
    private func assertIsDataNotCode(_ value: String, underKey: String, expected: Int = 1,
                                     file: StaticString = #filePath, line: UInt = #line) {
        let scan = Self.scan(transcript(), for: value, underKey: underKey)
        XCTAssertEqual(scan.violations, [],
                       "a model string reached a place it may not travel in — the only parameter it "
                           + "may is `\(underKey)`",
                       file: file, line: line)
        XCTAssertEqual(scan.carried, expected,
                       "the model string did not travel as `\(underKey)` at all — if resolution "
                           + "moved into an evaluated expression, this is the row that says so",
                       file: file, line: line)
    }

    struct DataNotCodeScan: Equatable {
        /// `method params.key.path` for every place the string turned up that is not `underKey`.
        var violations: [String]
        /// How many times it travelled as `underKey`'s own value, whole.
        var carried: Int
    }

    /// The walk itself, PURE, so its discrimination can be measured on synthetic shapes the real
    /// consumer does not produce yet (see `testTheDataNotCodeWalkSeesNestedLeaves…`). Extracting it
    /// is what turns "we extended the helper" into evidence.
    static func scan(_ calls: [CDPCall], for value: String, underKey: String) -> DataNotCodeScan {
        var violations: [String] = []
        var carried = 0

        func walk(_ node: Any, path: String, method: String) {
            switch node {
            case let text as String:
                guard text.contains(value) else { return }
                let leaf = path.split(separator: ".").last.map(String.init) ?? path
                if leaf == underKey {
                    if text == value { carried += 1 }
                } else {
                    violations.append("\(method) \(path)")
                }
            case let list as [Any]:
                for (index, item) in list.enumerated() {
                    walk(item, path: "\(path)[\(index)]", method: method)
                }
            case let object as [String: Any]:
                for (key, item) in object { walk(item, path: "\(path).\(key)", method: method) }
            default:
                return
            }
        }

        for call in calls {
            if call.method.contains(value) { violations.append("METHOD NAME \(call.method)") }
            for (key, raw) in call.params { walk(raw, path: key, method: call.method) }
        }
        return DataNotCodeScan(violations: violations.sorted(), carried: carried)
    }

    // MARK: - Canned replies

    private static let document = #"{"root":{"nodeId":1}}"#
    private static let matched = #"{"nodeId":42}"#
    private static let noMatch = #"{"nodeId":0}"#
    private static let empty = "{}"
    /// A 100×40 box at (10,20) — centre (60,40).
    private static let box = #"{"model":{"content":[10,20,110,20,110,60,10,60],"width":100,"height":40}}"#
    private static let handle = #"{"object":{"type":"object","subtype":"node","objectId":"obj-1"}}"#
    private static let selected = #"{"result":{"type":"boolean","value":true}}"#
    private static let submitted = #"{"result":{"type":"string","value":"submitted"}}"#
    private static let viewport = #"{"cssLayoutViewport":{"clientWidth":800,"clientHeight":600}}"#

    private static func field(_ attributes: [String], tag: String = "INPUT") -> String {
        let json = try! JSONSerialization.data(
            withJSONObject: ["node": ["nodeName": tag, "attributes": attributes]])
        return String(data: json, encoding: .utf8)!
    }

    private static func probe(_ ready: String, resources: Int) -> String {
        let json = try! JSONSerialization.data(
            withJSONObject: ["result": ["type": "object",
                                        "value": ["ready": ready, "resources": resources]]])
        return String(data: json, encoding: .utf8)!
    }

    // MARK: - click

    /// The whole click, hop by hop: resolution over the DOM domain, then three real pointer events
    /// at the box's own centre. No `Runtime.evaluate` anywhere in it.
    func testClickResolvesOverTheDOMDomainAndDispatchesRealPointerEvents() throws {
        consumer.handle(command("click", args: ["selector": "button.buy"]))
        answer([Self.document, Self.matched, Self.empty, Self.box,
                Self.empty, Self.empty, Self.empty])

        XCTAssertEqual(methods(), [
            "DOM.getDocument", "DOM.querySelector", "DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel",
            "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
        ])
        let events = transcript().filter { $0.method == "Input.dispatchMouseEvent" }
        XCTAssertEqual(events.map { $0.params["type"] as? String },
                       ["mouseMoved", "mousePressed", "mouseReleased"])
        for event in events {
            XCTAssertEqual(event.params["x"] as? Double, 60, "the click must land on the box centre")
            XCTAssertEqual(event.params["y"] as? Double, 40)
        }
        XCTAssertEqual(events[1].params["button"] as? String, "left")
        XCTAssertEqual(events[1].params["buttons"] as? Int, 1)
        XCTAssertEqual(events[2].params["buttons"] as? Int, 0)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, true)
        XCTAssertTrue(sent.first?.result?.contains("(60, 40)") == true, "\(sent)")
    }

    /// **THE PARAMS-SHAPE PIN.** The selector is `DOM.querySelector`'s own parameter and appears
    /// nowhere else in the transcript. Mutation: resolve with
    /// `Runtime.evaluate("document.querySelector('" + selector + "')")` and this reds twice over —
    /// the string turns up under `expression`, and it never turns up under `selector`.
    func testTheSelectorTravelsAsAParameterAndNeverAsCode() {
        // A selector that WOULD break out if it were ever concatenated into JavaScript. It is a
        // perfectly ordinary (if useless) CSS selector, so nothing downstream should mind it.
        let hostile = "a[href='x'],b\")+location.assign(\"https://evil.example\")+(\""
        consumer.handle(command("click", args: ["selector": hostile]))
        answer([Self.document, Self.matched, Self.empty, Self.box,
                Self.empty, Self.empty, Self.empty])
        assertIsDataNotCode(hostile, underKey: "selector")
    }

    /// The same guarantee for the two verbs that DO run JavaScript — their functions are literals
    /// and take no arguments, so neither the selector nor the typed text can reach them.
    func testNeitherJavaScriptRunningVerbLetsAModelStringIntoItsFunction() {
        let hostile = "input\");window.location='https://evil.example';//"
        let secret = "\"); fetch('https://evil.example'); (\""

        consumer.handle(command("type", args: ["selector": hostile, "text": secret]))
        answer([Self.document, Self.matched, Self.field(["type", "text", "name", "q"]),
                Self.empty, Self.empty, Self.handle, Self.selected, Self.empty])
        assertIsDataNotCode(hostile, underKey: "selector")
        assertIsDataNotCode(secret, underKey: "text")
        // And the function really was this app's literal, unmodified.
        let call = transcript().first { $0.method == "Runtime.callFunctionOn" }
        XCTAssertEqual(call?.params["functionDeclaration"] as? String,
                       PanelCommandConsumer.selectExistingContentFunction)

        cef.forgetLog()
        sent = []
        consumer.handle(command("submit", args: ["selector": hostile]))
        answer([Self.document, Self.matched, Self.handle, Self.submitted])
        assertIsDataNotCode(hostile, underKey: "selector")
        XCTAssertEqual(transcript().last?.params["functionDeclaration"] as? String,
                       PanelCommandConsumer.submitFormFunction)
    }

    func testAnElementThatMatchesNothingIsSaidSoRatherThanClickedAnyway() {
        consumer.handle(command("click", args: ["selector": "#ghost"]))
        answer([Self.document, Self.noMatch])
        XCTAssertEqual(methods(), ["DOM.getDocument", "DOM.querySelector"],
                       "a miss must stop the chain, not fall through to a box model")
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("nothing on the page matches") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("iframes or shadow DOM") == true,
                      "the honest reason a selector misses more often than not")
    }

    func testAnUnparseableSelectorIsReportedAsASelectorProblem() {
        consumer.handle(command("click", args: ["selector": ":::"]))
        answer([Self.document])
        XCTAssertTrue(cef.answerNextCDP(ok: false, payload: #"{"code":-32000,"message":"Invalid selector"}"#))
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("not a CSS selector") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("Invalid selector") == true,
                      "the browser's own words are kept, in parentheses")
    }

    /// An element with no layout: `getBoxModel` succeeds with a zero-area box, or fails outright.
    /// Both must refuse rather than aim a pointer at (0, 0).
    func testAnElementWithNoVisibleBoxIsRefusedRatherThanClickedAtTheOrigin() {
        consumer.handle(command("click", args: ["selector": "#hidden"]))
        answer([Self.document, Self.matched, Self.empty,
                #"{"model":{"content":[0,0,0,0,0,0,0,0],"width":0,"height":0}}"#])
        XCTAssertFalse(methods().contains("Input.dispatchMouseEvent"),
                       "a zero-area element must not be clicked at all")
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("no visible box") == true, "\(sent)")
    }

    // MARK: - type: the happy path

    /// **The row the broken-inspector mutation reds.** A safe field is inspected, judged, focused,
    /// selected and typed into — and if the inspector stops producing a readable field, this is what
    /// goes red, by REFUSING. The floor rows below stay green under that mutation, which is the
    /// direction that proves fail-closed rather than merely asserting it.
    func testASafeFieldIsInspectedThenFocusedSelectedAndTypedInto() throws {
        consumer.handle(command("type", args: ["selector": "input[name=q]", "text": "norma"]))
        answer([Self.document, Self.matched, Self.field(["type", "search", "name", "q"]),
                Self.empty, Self.empty, Self.handle, Self.selected, Self.empty])

        XCTAssertEqual(methods(), [
            "DOM.getDocument", "DOM.querySelector", "DOM.describeNode", "DOM.scrollIntoViewIfNeeded",
            "DOM.focus", "DOM.resolveNode", "Runtime.callFunctionOn", "Input.insertText",
        ])
        // The floor's inspection comes BEFORE anything touches the field. Ordering is the policy.
        // `XCTUnwrap` rather than `!`: under the broken-inspector mutation these steps do not happen
        // at all, and a row that CRASHES instead of failing takes the rest of the suite with it —
        // which is how this file's first mutation run read as "18 executed" rather than as evidence.
        let order = methods()
        let inspected = try XCTUnwrap(order.firstIndex(of: "DOM.describeNode"))
        XCTAssertLessThan(inspected, try XCTUnwrap(order.firstIndex(of: "DOM.focus")))
        XCTAssertLessThan(inspected, try XCTUnwrap(order.firstIndex(of: "Input.insertText")))
        // Focus and inspection are the SAME node — no re-query, so no DOM swap in between.
        let nodeIds = transcript()
            .filter { ["DOM.describeNode", "DOM.focus", "DOM.resolveNode"].contains($0.method) }
            .map { $0.params["nodeId"] as? Int }
        XCTAssertEqual(nodeIds, [42, 42, 42])

        XCTAssertEqual(transcript().last?.params["text"] as? String, "norma")
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, true)
        XCTAssertTrue(sent.first?.result?.contains("typed 5 characters") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("name=\"q\"") == true, "\(sent)")
    }

    // MARK: - THE SENSITIVE FLOOR

    /// A password field, by the one signal that cannot be argued with.
    func testTheFloorRefusesAPasswordFieldByItsType() {
        consumer.handle(command("type", args: ["selector": "#pw", "text": "hunter2"]))
        answer([Self.document, Self.matched, Self.field(["type", "password", "name", "j_password"])])

        XCTAssertFalse(methods().contains("Input.insertText"), "the floor let a keystroke through")
        XCTAssertFalse(methods().contains("DOM.focus"), "a refused field must not even be focused")
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("password field") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("type=\"password\"") == true,
                      "the refusal names its evidence")
        XCTAssertFalse(sent.first?.result?.contains("hunter2") == true,
                       "the refusal must not echo what was going to be typed")
    }

    /// Payment fields, by the autofill contract and by what the site called them. One row per
    /// mechanism, because they are three different code paths in `judge`.
    func testTheFloorRefusesPaymentFieldsByAutocompleteAndByName() {
        let refused: [(attributes: [String], kind: String)] = [
            (["type", "text", "autocomplete", "cc-number"], "payment field"),
            (["type", "text", "autocomplete", "section-blue billing cc-csc"], "payment field"),
            (["type", "text", "autocomplete", "current-password"], "password field"),
            (["type", "text", "autocomplete", "one-time-code"], "one-time-code field"),
            (["type", "text", "name", "cardNumber"], "payment field"),
            (["type", "text", "name", "card_number"], "payment field"),
            (["type", "text", "id", "credit-card-cvv"], "payment field"),
            (["type", "text", "placeholder", "Card number"], "payment field"),
            (["type", "text", "aria-label", "Security code"], "payment field"),
            (["type", "text", "class", "StripeElement card-expiry"], "payment field"),
            (["type", "text", "name", "iban"], "bank-details field"),
            (["type", "text", "name", "social_security_number"], "identity field"),
        ]
        for (index, row) in refused.enumerated() {
            sent = []
            cef.forgetLog()
            consumer.handle(command("type", args: ["selector": "#f\(index)", "text": "4111"]))
            answer([Self.document, Self.matched, Self.field(row.attributes)])
            XCTAssertFalse(methods().contains("Input.insertText"),
                           "\(row.attributes) was typed into")
            XCTAssertEqual(sent.first?.ok, false, "\(row.attributes)")
            XCTAssertTrue(sent.first?.result?.contains(row.kind) == true,
                          "\(row.attributes) → \(sent.first?.result ?? "nothing")")
        }
    }

    /// **FAIL CLOSED, mechanism 1: the inspection FAILED.** Break `DOM.describeNode` and `type`
    /// refuses. Mutation: make the failure fall through to typing and this row reds.
    func testTheFloorRefusesWhenTheInspectionFails() {
        consumer.handle(command("type", args: ["selector": "#q", "text": "hello"]))
        answer([Self.document, Self.matched])
        XCTAssertTrue(cef.answerNextCDP(ok: false, payload: #"{"message":"No node with given id"}"#))

        XCTAssertEqual(methods(), ["DOM.getDocument", "DOM.querySelector", "DOM.describeNode"],
                       "nothing may run past a failed inspection")
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("could not inspect") == true, "\(sent)")
    }

    /// **FAIL CLOSED, mechanism 2: the inspection SUCCEEDED and said nothing usable.** The subtler
    /// half — a `{}` reply is a successful protocol call, so a reader that only handled `ok == false`
    /// would treat "I learned nothing" as "nothing was wrong".
    func testTheFloorRefusesWhenTheInspectionIsUnreadable() {
        for unreadable in ["{}", #"{"node":{}}"#, #"{"node":{"nodeName":""}}"#, "not json"] {
            sent = []
            cef.forgetLog()
            consumer.handle(command("type", args: ["selector": "#q", "text": "hello"]))
            answer([Self.document, Self.matched, unreadable])
            XCTAssertFalse(methods().contains("Input.insertText"), "\(unreadable) was treated as safe")
            XCTAssertEqual(sent.first?.ok, false, "\(unreadable)")
            XCTAssertTrue(sent.first?.result?.contains("could not inspect") == true, "\(unreadable)")
        }
    }

    /// A field with a NAME and no attributes at all is readable, not unreadable — the distinction the
    /// fail-closed branch rests on. A bare `<input>` is typed into; only an unreadable ANSWER refuses.
    func testAFieldWithNoAttributesIsReadableAndIsNotRefused() {
        consumer.handle(command("type", args: ["selector": "input", "text": "hello"]))
        answer([Self.document, Self.matched, #"{"node":{"nodeName":"INPUT"}}"#,
                Self.empty, Self.empty, Self.handle, Self.selected, Self.empty])
        XCTAssertEqual(sent.first?.ok, true, "\(sent)")
    }

    // MARK: - Fix round 1: the refusal must be DELIVERED, not merely produced

    /// **Review Important-1.** The floor's evidence quoted a page-supplied `autocomplete` token
    /// matched only by a `cc-` PREFIX — so `autocomplete="cc-<70 KB>"` built a 70 KB refusal, the
    /// daemon refused the whole RPC at its 64 KiB cap, `sendPanelCommandResult`'s `try?` swallowed
    /// the rejection, and the command expired: **the one message this task exists to deliver became
    /// "the Mac app did not answer".**
    ///
    /// Two independent fixes now stand between a hostile page and that silence — the floor quotes at
    /// `quotedEvidenceMaxLength`, and `answer` caps EVERY message — and this row asserts the
    /// property they exist for rather than either mechanism: a refusal comes back, it names the
    /// field kind, and it fits on the wire.
    func testAHostilePageCannotTurnTheFloorsRefusalIntoSilence() throws {
        let huge = "cc-" + String(repeating: "a", count: 70_000)
        consumer.handle(command("type", args: ["selector": "#pay", "text": "4111"]))
        answer([Self.document, Self.matched, Self.field(["type", "text", "autocomplete", huge])])

        XCTAssertEqual(sent.count, 1, "the refusal must be SENT, not merely computed")
        XCTAssertEqual(sent.first?.ok, false)
        let result = try XCTUnwrap(sent.first?.result)
        XCTAssertTrue(result.contains("payment field"), result.prefix(200).description)
        XCTAssertLessThanOrEqual(PanelURLPolicy.wireLength(result),
                                 PanelCommandConsumer.resultMaxLength,
                                 "an over-cap result is REFUSED whole by the daemon — this is the "
                                     + "timeout shape the finding described")
        XCTAssertFalse(methods().contains("Input.insertText"))
    }

    /// The structural half on its own: the send-site cap cuts in the DAEMON's unit, marks the cut,
    /// and the marked result fits. Every message out of the consumer inherits this, including ones
    /// nobody has written yet — which is the whole reason it is at `answer` and not at the two sites
    /// that happened to be found.
    func testTheSendSiteCapCutsInTheWiresUnitAndSaysThatItCut() {
        let short = "refused: that is a password field"
        XCTAssertEqual(PanelCommandConsumer.capped(short), short, "an ordinary message is untouched")

        let huge = String(repeating: "a", count: PanelCommandConsumer.resultMaxLength + 5_000)
        let cut = PanelCommandConsumer.capped(huge)
        XCTAssertLessThanOrEqual(PanelURLPolicy.wireLength(cut), PanelCommandConsumer.resultMaxLength)
        XCTAssertTrue(cut.contains("cut by Norma"), "a silent truncation is a message read to the end")
        XCTAssertTrue(cut.hasPrefix("aaa"), "the head — where the meaning is — survives")

        // The UNIT, again: each emoji is one Character and TWO UTF-16 units, so a cut measured in
        // Characters would leave a result the daemon still refuses.
        let wide = String(repeating: "😀", count: PanelCommandConsumer.resultMaxLength / 2 + 500)
        XCTAssertLessThan(wide.count, PanelCommandConsumer.resultMaxLength)
        let cutWide = PanelCommandConsumer.capped(wide)
        XCTAssertLessThanOrEqual(PanelURLPolicy.wireLength(cutWide),
                                 PanelCommandConsumer.resultMaxLength)
        XCTAssertTrue(cutWide.contains("😀"), "and it must not have cut a surrogate pair in half")
    }

    /// **Review Minor-4's discrimination, measured.** The depth-1 String-only walk this replaced
    /// could not see any of these; the last row is the one that mattered — a string that travels
    /// correctly AND ALSO appears somewhere it must not would have passed it green.
    func testTheDataNotCodeWalkSeesNestedLeavesNotJustTopLevelStrings() {
        // The CDP-sanctioned data slot, which is the shape a future arm will reach for.
        let bound = CDPCall(method: "Runtime.callFunctionOn", params: [
            "functionDeclaration": "function (v) { this.value = v; }",
            "arguments": [["value": "SECRET"]],
        ])
        XCTAssertEqual(Self.scan([bound], for: "SECRET", underKey: "value"),
                       DataNotCodeScan(violations: [], carried: 1))

        // Interpolated into an expression: seen at depth 1, as before.
        let interpolated = CDPCall(method: "Runtime.evaluate",
                                   params: ["expression": "document.querySelector('SECRET')"])
        XCTAssertEqual(Self.scan([interpolated], for: "SECRET", underKey: "selector"),
                       DataNotCodeScan(violations: ["Runtime.evaluate expression"], carried: 0))

        // Interpolated NESTED. Invisible to the old walk.
        let deep = CDPCall(method: "Runtime.callFunctionOn",
                           params: ["arguments": [["expression": "SECRET"]]])
        XCTAssertEqual(Self.scan([deep], for: "SECRET", underKey: "selector"),
                       DataNotCodeScan(violations: ["Runtime.callFunctionOn arguments[0].expression"],
                                       carried: 0))

        // **The silent pass the extension closes**: correct travel AND a nested breakout together.
        // Old walk: carried 1, violations 0 → green. Now: the violation is named.
        let both = [CDPCall(method: "DOM.querySelector", params: ["selector": "SECRET"]), deep]
        let scan = Self.scan(both, for: "SECRET", underKey: "selector")
        XCTAssertEqual(scan.carried, 1)
        XCTAssertEqual(scan.violations,
                       ["Runtime.callFunctionOn arguments[0].expression"])
    }

    // MARK: - The floor as a pure function

    /// The policy directly, without a browser in the way — the table that says what the list catches
    /// AND what it deliberately does not, so "refuses everything" cannot pass for a floor.
    func testTheFloorJudgesAttributesAndLeavesOrdinaryFieldsAlone() {
        func judge(_ attributes: [String: String], tag: String = "input")
            -> SensitiveFieldFloor.Verdict {
            SensitiveFieldFloor.judge(.init(tagName: tag, attributes: attributes))
        }

        XCTAssertEqual(judge(["type": "PASSWORD"]),
                       .refuse(kind: "password field", evidence: "type=\"password\""),
                       "the type test is case-insensitive — HTML attributes are")
        XCTAssertEqual(judge(["autocomplete": "CC-Number"]),
                       .refuse(kind: "payment field", evidence: "autocomplete=\"cc-number\""))
        // The `cc-` test is a PREFIX, so it covers tokens nobody listed.
        if case .refuse(let kind, _) = judge(["autocomplete": "cc-exp-month"]) {
            XCTAssertEqual(kind, "payment field")
        } else {
            XCTFail("an unlisted cc-* token slipped through")
        }

        // Ordinary fields, which must NOT be refused — a floor that refuses everything is not a
        // floor, it is a broken verb.
        for safe in [["type": "search", "name": "q"],
                     ["type": "email", "name": "email", "autocomplete": "email"],
                     ["type": "text", "name": "shipping_address"],   // "pin" would fire inside this
                     ["type": "text", "name": "className"],           // "ssn" would fire inside this
                     ["type": "text", "name": "message", "class": "form-control"],
                     ["type": "tel", "name": "phone", "autocomplete": "tel"]] {
            XCTAssertEqual(judge(safe), .allow, "\(safe) was refused")
        }

        // Normalisation: one needle, four spellings.
        for spelling in ["cardNumber", "card-number", "card_number", "Card Number"] {
            XCTAssertNotEqual(judge(["name": spelling]), .allow, spelling)
        }
    }

    // MARK: - scroll

    func testScrollByDirectionWheelsAtTheViewportCentre() {
        consumer.handle(command("scroll", args: ["direction": "down", "amount": 700]))
        answer([Self.viewport, Self.empty])

        XCTAssertEqual(methods(), ["Page.getLayoutMetrics", "Input.dispatchMouseEvent"])
        let wheel = transcript()[1].params
        XCTAssertEqual(wheel["type"] as? String, "mouseWheel")
        XCTAssertEqual(wheel["x"] as? Double, 400)
        XCTAssertEqual(wheel["y"] as? Double, 300)
        XCTAssertEqual(wheel["deltaY"] as? Double, 700)
        XCTAssertEqual(wheel["deltaX"] as? Double, 0)
        XCTAssertEqual(sent.first?.ok, true)
        XCTAssertTrue(sent.first?.result?.contains("scrolled down 700px") == true, "\(sent)")
    }

    /// Every direction becomes a SIGNED delta chosen in `PanelCommandArguments` — the word itself
    /// never reaches a params dictionary.
    func testEveryScrollDirectionBecomesASignedDelta() {
        let expected: [(String, Double, Double)] = [
            ("down", 0, 250), ("up", 0, -250), ("right", 250, 0), ("left", -250, 0),
        ]
        for (direction, dx, dy) in expected {
            cef.forgetLog()
            sent = []
            consumer.handle(command("scroll", args: ["direction": direction, "amount": 250]))
            answer([Self.viewport, Self.empty])
            let wheel = transcript()[1].params
            XCTAssertEqual(wheel["deltaX"] as? Double, dx, direction)
            XCTAssertEqual(wheel["deltaY"] as? Double, dy, direction)
            XCTAssertNil(wheel["direction"], "the word must not travel; only the delta does")
        }
    }

    func testScrollBySelectorBringsTheElementIntoViewAndNeverWheels() {
        consumer.handle(command("scroll", args: ["selector": "#footer"]))
        answer([Self.document, Self.matched, Self.empty])
        XCTAssertEqual(methods(), ["DOM.getDocument", "DOM.querySelector", "DOM.scrollIntoViewIfNeeded"])
        assertIsDataNotCode("#footer", underKey: "selector")
        XCTAssertEqual(sent.first?.ok, true)
    }

    /// An unreadable viewport is refused rather than defaulted: a guessed centre aims the wheel at a
    /// point that may not be over the content, and "scrolled" would then be a claim this code cannot
    /// make.
    func testAnUnreadableViewportRefusesRatherThanGuessing() {
        consumer.handle(command("scroll", args: ["direction": "down", "amount": 700]))
        answer(["{}"])
        XCTAssertEqual(methods(), ["Page.getLayoutMetrics"])
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("viewport could not be measured") == true, "\(sent)")
    }

    // MARK: - submit

    func testSubmitRunsTheFormLiteralAndReportsANonFormHonestly() {
        consumer.handle(command("submit", args: ["selector": "form#checkout"]))
        answer([Self.document, Self.matched, Self.handle, Self.submitted])
        XCTAssertEqual(methods(),
                       ["DOM.getDocument", "DOM.querySelector", "DOM.resolveNode", "Runtime.callFunctionOn"])
        XCTAssertEqual(transcript().last?.params["objectId"] as? String, "obj-1")
        XCTAssertTrue(PanelCommandConsumer.submitFormFunction.contains("requestSubmit"),
                      "requestSubmit is what validates and fires a cancellable submit event")
        XCTAssertEqual(sent.first?.ok, true)

        cef.forgetLog()
        sent = []
        consumer.handle(command("submit", args: ["selector": "div.card"]))
        answer([Self.document, Self.matched, Self.handle,
                #"{"result":{"type":"string","value":"no-form"}}"#])
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("not inside a <form>") == true, "\(sent)")
    }

    // MARK: - wait

    func testWaitForLoadPollsUntilCompleteAndAnswersExactlyOnce() throws {
        consumer.handle(command("wait", args: ["until": "load", "timeoutMs": 5_000],
                                deadlineMs: 30_000))
        answer([Self.probe("loading", resources: 3)])
        XCTAssertEqual(sent, [], "a page still loading is not an answer")

        // The poll re-arms rather than spinning: fire its timer to take the next look.
        let poll = try XCTUnwrap(clock.liveTimers.last)
        clock.current = clock.current.addingTimeInterval(0.25)
        clock.fire(poll.id)
        answer([Self.probe("complete", resources: 3)])

        XCTAssertEqual(methods(), ["Runtime.evaluate", "Runtime.evaluate"])
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, true)
        XCTAssertTrue(sent.first?.result?.contains("finished loading") == true, "\(sent)")
    }

    /// `idle` needs TWO agreeing polls — the first can never satisfy it, because "nothing new
    /// finished since last time" has no last time.
    func testWaitForIdleNeedsTwoPollsThatAgree() throws {
        consumer.handle(command("wait", args: ["until": "idle", "timeoutMs": 5_000],
                                deadlineMs: 30_000))
        answer([Self.probe("complete", resources: 7)])
        XCTAssertEqual(sent, [], "one poll cannot establish idleness, however complete the page is")

        clock.current = clock.current.addingTimeInterval(0.25)
        clock.fire(try XCTUnwrap(clock.liveTimers.last).id)
        answer([Self.probe("complete", resources: 9)])
        XCTAssertEqual(sent, [], "the count moved — something finished fetching")

        clock.current = clock.current.addingTimeInterval(0.25)
        clock.fire(try XCTUnwrap(clock.liveTimers.last).id)
        answer([Self.probe("complete", resources: 9)])
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, true)
    }

    /// **The bound.** A wait that never comes true stops on its OWN budget and says what it saw —
    /// it does not run to the command deadline, which would be reported to the agent as "the Mac app
    /// did not answer" for a wait that worked perfectly.
    func testWaitStopsOnItsOwnBudgetAndSaysWhatItSaw() throws {
        consumer.handle(command("wait", args: ["until": "load", "timeoutMs": 1_000],
                                deadlineMs: 30_000))
        answer([Self.probe("loading", resources: 1)])

        clock.current = clock.current.addingTimeInterval(0.9)
        clock.fire(try XCTUnwrap(clock.liveTimers.last).id)
        answer([Self.probe("loading", resources: 1)])

        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("within 1000ms") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("still `loading`") == true, "\(sent)")
        XCTAssertTrue(clock.liveTimers.isEmpty,
                      "an answered wait must leave neither its poll nor its deadline armed")
    }

    /// **The clamp, which is the arithmetic made real.** A model asking for a minute gets the
    /// ceiling, and says so — because a wait that outlived its command's `deadlineMs` would answer
    /// into a pending entry the daemon had already timed out.
    func testAnOverLongModelTimeoutIsClampedToTheCeiling() throws {
        consumer.handle(command("wait", args: ["until": "load", "timeoutMs": 60_000],
                                deadlineMs: 30_000))
        answer([Self.probe("loading", resources: 0)])

        clock.current = clock.current
            .addingTimeInterval(Double(PanelCommandArguments.waitTimeoutCeilingMs) / 1000 - 0.1)
        clock.fire(try XCTUnwrap(clock.liveTimers.last).id)
        answer([Self.probe("loading", resources: 0)])

        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("within 20000ms") == true,
                      "unclamped this would still be polling, and would say 60000ms — \(sent)")
    }

    func testWaitForMillisecondsTouchesNoBrowserAtAll() throws {
        consumer.handle(command("wait", args: ["until": "ms", "timeoutMs": 500], deadlineMs: 30_000))
        XCTAssertEqual(cef.log, [], "a sleep must not make a tab's health a precondition")
        // Two clocks: the command deadline and the sleep. The sleep is the later-armed one.
        XCTAssertEqual(clock.liveTimers.count, 2)
        clock.fire(try XCTUnwrap(clock.liveTimers.last).id)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, true)
        XCTAssertTrue(sent.first?.result?.contains("waited 500ms") == true, "\(sent)")
    }

    // MARK: - Operands, app-side

    /// The app validates what arrives even though the daemon validated it first — it is the last
    /// thing before a real browser, and "the sender says it checked" is not a check. Every refusal
    /// is visible and nothing reaches CEF.
    func testMissingOrOversizedOperandsAreRefusedAppSide() {
        let cases: [(action: String, args: [String: Any], expect: String)] = [
            ("click", [:], "click needs a `selector`"),
            ("type", ["selector": "#q"], "type needs non-empty `text`"),
            ("type", ["selector": "#q", "text": ""], "type needs non-empty `text`"),
            ("submit", ["selector": ""], "submit needs a `selector`"),
            ("scroll", [:], "either a `selector` or a `direction`"),
            ("scroll", ["direction": "sideways", "amount": 10], "up, down, left or right"),
            ("scroll", ["direction": "down"], "needs an `amount`"),
            ("scroll", ["direction": "down", "amount": 0], "between 1 and 20000"),
            ("wait", ["until": "forever", "timeoutMs": 10], "load, idle or ms"),
            ("wait", ["until": "load"], "positive `timeoutMs`"),
            ("click", ["selector": String(repeating: "a", count: 1_025)], "past the 1024-character"),
            ("type", ["selector": "#q", "text": String(repeating: "a", count: 4_097)],
             "past the 4096-character"),
        ]
        for row in cases {
            sent = []
            cef.forgetLog()
            consumer.handle(command(row.action, args: row.args))
            XCTAssertEqual(cef.log, [], "\(row.action) \(row.args) reached the browser")
            XCTAssertEqual(sent.count, 1, "\(row.action) \(row.args)")
            XCTAssertEqual(sent.first?.ok, false)
            XCTAssertTrue(sent.first?.result?.contains(row.expect) == true,
                          "\(row.args) → \(sent.first?.result ?? "nothing")")
        }
        XCTAssertTrue(clock.liveTimers.isEmpty, "a refused operand must arm no deadline")
    }

    /// An interaction verb with no `args` at all — the shape every pre-Task-5 producer emitted — is
    /// refused with the operand message rather than crashing or acting on a default.
    func testAnInteractionCommandWithNoArgsIsRefused() {
        for verb in ["click", "type", "scroll", "submit", "wait"] {
            sent = []
            consumer.handle(command(verb))
            XCTAssertEqual(sent.count, 1, verb)
            XCTAssertEqual(sent.first?.ok, false, verb)
        }
        XCTAssertEqual(cef.log, [])
    }

    // MARK: - The deadline, across a chain

    /// **One deadline for the whole chain, and it really stops it.** A seven-hop verb must not get
    /// seven times the patience it was dispatched with, and a chain whose deadline fired must issue
    /// no further CDP work for an answer nobody will accept.
    func testTheDeadlineIsArmedOnceAndStopsAChainMidFlight() {
        consumer.handle(command("click", args: ["selector": "button"], deadlineMs: 8_000))
        XCTAssertEqual(clock.liveTimers.count, 1)
        XCTAssertEqual(clock.liveTimers[0].fireAt, clock.current.addingTimeInterval(8))

        answer([Self.document])                      // hop 1 → hop 2 dispatched
        XCTAssertEqual(clock.liveTimers.count, 1, "each hop must not arm a deadline of its own")

        clock.fire(clock.liveTimers[0].id)
        XCTAssertEqual(sent, [], "the deadline sends nothing — the daemon timed it out first")

        let before = cef.log.count
        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: Self.matched))
        XCTAssertEqual(cef.log.count, before, "an abandoned chain must issue no further CDP calls")
        XCTAssertEqual(sent, [])
    }

    /// A tab with no live browser answers on the FIRST hop rather than timing out — the same promise
    /// the read verbs make.
    func testAnUnknownTabAnswersImmediatelyForEveryInteractionVerb() {
        let args: [String: [String: Any]] = [
            "click": ["selector": "a"],
            "type": ["selector": "a", "text": "x"],
            "scroll": ["direction": "down", "amount": 100],
            "submit": ["selector": "a"],
            "wait": ["until": "load", "timeoutMs": 1_000],
        ]
        for (verb, payload) in args {
            sent = []
            consumer.handle(command(verb, args: payload, tabId: "ghost"))
            XCTAssertEqual(sent.count, 1, verb)
            XCTAssertEqual(sent.first?.ok, false, verb)
            XCTAssertTrue(sent.first?.result?.contains("no live browser") == true,
                          "\(verb) → \(sent.first?.result ?? "nothing")")
        }
        XCTAssertTrue(clock.liveTimers.isEmpty, "an answered command leaves no deadline armed")
    }
}
