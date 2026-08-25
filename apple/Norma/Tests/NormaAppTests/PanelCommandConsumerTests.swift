import AppKit
import NormaProtocol
import XCTest
@testable import Norma

/// b2-agent-browser Task 3 — the `panel_command` consumer.
///
/// **The doubles are `BrowserRuntimeTests`' own**, deliberately: `CEFRecorder` and `FakeScheduler`
/// already model exactly the two things this needs (every CEF call recorded and no CEF touched;
/// timers a test fires by hand), and a second recorder here would be a second thing to keep in step
/// with `CEFDriver`. The recorder HOLDS each CDP completion instead of answering it, which is what
/// makes a deadline exercisable at all.
///
/// What is deliberately NOT covered here, stated rather than implied:
///
///   * **What CDP does with a method** — `Runtime.evaluate` really returning a page's text is
///     unreachable from any test host (spec §9: no CEF under XCTest). The bridge's own contracts are
///     pinned in `CEFRuntimeTests`; this file pins the routing, the policy and the answer.
///   * **The subscription itself** — that `ShellSessionHost`'s pump calls `handle` is
///     `ShellSessionHostTests`' wire pin, not this file's.
@MainActor
final class PanelCommandConsumerTests: XCTestCase {

    // MARK: - Fixtures

    /// What the consumer sent back, in order.
    struct Sent: Equatable {
        var sessionId: String
        var commandId: String
        var ok: Bool
        var result: String?
        var imageBase64: String?
    }

    private var cef = BrowserRuntimeTests.CEFRecorder()
    private var clock = BrowserRuntimeTests.FakeScheduler()
    private var sent: [Sent] = []

    override func setUp() {
        super.setUp()
        cef = BrowserRuntimeTests.CEFRecorder()
        clock = BrowserRuntimeTests.FakeScheduler()
        sent = []
        PanelWebTabModels.removeAllForTesting()
    }

    override func tearDown() {
        PanelWebTabModels.removeAllForTesting()
        super.tearDown()
    }

    /// A runtime with one live browser per named tab, and the consumer wired onto it. Never
    /// `BrowserRuntime.shared` — it is process-global and would carry containers into the next test.
    private func makeWorld(tabs tabIds: [String] = ["t1"])
        -> (runtime: BrowserRuntime, consumer: PanelCommandConsumer) {
        let runtime = BrowserRuntime(driver: cef.driver, scheduler: clock.scheduler)
        if !tabIds.isEmpty {
            let states = tabIds.map { BrowserTabState(tabId: $0, url: nil, isShown: false, title: nil) }
            runtime.apply(tabIds.map { .create(tabId: $0, url: "https://start") },
                          tabs: ["s1": states], sessionOf: { _ in "s1" })
            clock.runPendingWork()
        }
        cef.forgetLog()
        let consumer = PanelCommandConsumer(
            runtime: runtime,
            sendResult: { [unowned self] sessionId, commandId, ok, result, imageBase64 in
                self.sent.append(Sent(sessionId: sessionId, commandId: commandId, ok: ok,
                                      result: result, imageBase64: imageBase64))
            },
            scheduler: clock.scheduler)
        return (runtime, consumer)
    }

    /// Built as WIRE JSON and decoded, never with a memberwise initialiser — `PanelCommand`'s is
    /// internal to NormaProtocol, and going through the real decode is the honest shape anyway: it
    /// is exactly what `parseServerLine` hands the pump, and it keeps a fixture from describing a
    /// payload the daemon could not emit.
    private func command(_ action: String, tabId: String? = "t1", url: String? = nil,
                         commandId: String = "pcmd_1", sessionId: String = "s1",
                         deadlineMs: Int = 15_000) -> SessionEvent.PanelCommand {
        var fields: [String: Any] = [
            "type": "panel_command", "seq": 1, "sessionId": sessionId, "ts": 0,
            "commandId": commandId, "action": action, "deadlineMs": deadlineMs,
        ]
        if let tabId { fields["tabId"] = tabId }
        if let url { fields["url"] = url }
        // swiftlint:disable:next force_try — a dictionary of literals; a throw here is a broken test.
        let data = try! JSONSerialization.data(withJSONObject: fields)
        guard case .panelCommand(let decoded)? = try? JSONDecoder().decode(SessionEvent.self, from: data)
        else {
            XCTFail("the fixture did not decode as a panel_command")
            fatalError("unreachable — XCTFail above")
        }
        return decoded
    }

    // MARK: - Routing

    /// Each verb reaches the right mechanism. `navigate`/`back` go through the SAME two C entry
    /// points the chrome's own buttons use; the two read verbs go over CDP.
    func testEachVerbRoutesToItsOwnMechanism() {
        let world = makeWorld()

        world.consumer.handle(command("navigate", url: "https://example.com"))
        XCTAssertEqual(cef.log, ["c1 load url=https://example.com"])
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, true)

        cef.forgetLog()
        world.consumer.handle(command("back", commandId: "pcmd_2"))
        XCTAssertEqual(cef.log, ["c1 back"])

        cef.forgetLog()
        world.consumer.handle(command("read", commandId: "pcmd_3"))
        XCTAssertEqual(cef.log.count, 1)
        XCTAssertTrue(cef.log.first?.hasPrefix("c1 cdp Runtime.evaluate ") == true, "\(cef.log)")

        cef.forgetLog()
        world.consumer.handle(command("screenshot", commandId: "pcmd_4"))
        XCTAssertEqual(cef.log.count, 1)
        XCTAssertTrue(cef.log.first?.hasPrefix("c1 cdp Page.captureScreenshot ") == true, "\(cef.log)")
    }

    /// The INTERACT set is answered, not ignored. Task 3 shipped this row against a "not
    /// implemented" stub; Task 5 built the arms, so an operand-less interaction command is now
    /// answered by the OPERAND check — which is the same guarantee one layer in, and the one that
    /// matters most: an interaction verb never falls through to a browser without being told what to
    /// act on. Its per-verb mechanics are `PanelCommandInteractionTests`'.
    func testTheInteractionVerbsAnswerRatherThanTimeOutWhenTheyAreGivenNothingToActOn() {
        let world = makeWorld()
        for (index, verb) in ["click", "type", "scroll", "submit", "wait"].enumerated() {
            world.consumer.handle(command(verb, commandId: "pcmd_\(index)"))
        }
        XCTAssertEqual(sent.count, 5)
        XCTAssertTrue(sent.allSatisfy { $0.ok == false })
        XCTAssertTrue(sent.allSatisfy { $0.result?.contains("needs") == true },
                      "\(sent.map { $0.result ?? "" })")
        XCTAssertEqual(cef.log, [], "a verb with no operands must not touch the browser")
        XCTAssertEqual(clock.liveTimers.count, 0, "nor arm a deadline for work it will not do")
    }

    /// A verb from a NEWER daemon. The wire type keeps `action` a plain `String` so it decodes; this
    /// is the other half of that tolerance — refused with an explanation rather than dropped.
    func testAnUnknownVerbIsRefusedWithAnExplanation() {
        let world = makeWorld()
        world.consumer.handle(command("drag"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("drag") == true, "\(sent)")
        XCTAssertEqual(cef.log, [])
    }

    /// office-agent-tools T1 — **the routing proof.** `OfficeCommandConsumerTests` exercises
    /// `OfficeCommandConsumer` directly; this is the one test in THIS file that proves
    /// `PanelCommandConsumer.handle` actually reaches it for an office action, rather than falling
    /// into the `default:` branch just above (which would answer "does not know the browser verb
    /// `office.docs.info`" — a true-sounding but WRONG message, since this build does know the
    /// verb by name, it simply hasn't implemented it yet). The two messages are asserted to differ so
    /// a future edit that accidentally deletes the routing guard reds here even if it still produces
    /// *some* refusal.
    ///
    /// **T3 — `office.sheets.set` chosen deliberately, not `office.sheets.read`; T4 — `office.sheets
    /// .format` chosen in `set`'s place; T5 — `office.slides.info` chosen in `format`'s place; T6 —
    /// `office.docs.info` chosen in `slides.info`'s place, for the identical reason one level later,
    /// again.** T1 picked `read` arbitrarily, back when all 22 verbs answered identically; T3 made
    /// `sheets.info`/`sheets.read` REAL (dispatched onto their own `Task`, answered asynchronously),
    /// so THIS test's own synchronous "exactly one result, sent by the time `handle` returns"
    /// assertion would race a verb that no longer answers synchronously — T3 moved this test to
    /// `sheets.set`, still T1's own refusal shell at the time. T4 then made `sheets.set` (and seven
    /// siblings) real too, async the identical way — this test moved to `sheets.format`, the one
    /// sheets verb still on T1's own synchronous shell at the time. T5 makes `format` real too
    /// (every `sheets` verb now is) — moved to `office.slides.info`. T6 makes every `slides` verb
    /// real too. **T7 makes every `docs` verb real as well, so NO office verb answers synchronously
    /// any more** — this test moves to an UNROUTED `office.`-prefixed action, which is what the
    /// refusal path still answers and which proves the same routing fact: an `office.` action reaches
    /// `OfficeCommandConsumer`, not this file's own unknown-browser-verb branch.
    ///
    /// Also proves the thing `OfficeCommandConsumerTests` cannot: that CEF is never touched and no
    /// deadline timer is armed for an office verb, because routing happens before this file's own
    /// `Call`/`arm` machinery ever sees the command.
    func testOfficeActionsRouteToTheOfficeConsumerRatherThanTheUnknownVerbBranch() {
        let world = makeWorld()
        world.consumer.handle(command("office.docs.frobnicate"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        let result = sent.first?.result ?? ""
        XCTAssertFalse(result.contains("does not know the browser verb"), "\(sent)")
        XCTAssertTrue(result.contains("docs"), "\(sent)")
        XCTAssertTrue(result.contains("frobnicate"), "\(sent)")
        XCTAssertEqual(cef.log, [], "an office verb must never reach CEF")
        XCTAssertEqual(clock.liveTimers.count, 0, "an office verb arms no browser-side deadline")
    }

    /// The quiescent guard is checked BEFORE routing (this file's `handle`), so an office command
    /// arriving during the app's terminal beat is silent, exactly like a browser command — see
    /// `PanelCommandConsumer.swift`'s routing comment for why office does not get its own carve-out
    /// here. `testCommandsArrivingDuringTheQuitBeatDoNothingAtAll` below pins this for browser verbs;
    /// this is the identical pin for an office one, since the two share one guard and this is the
    /// only file positioned to prove they share it.
    func testOfficeCommandsArrivingDuringTheQuitBeatAreSilentTooSameAsBrowserOnes() {
        let world = makeWorld()
        world.runtime.quiesce()
        world.consumer.handle(command("office.sheets.read"))
        XCTAssertEqual(sent.count, 0, "a quiesced app must send nothing, office or browser")
    }

    // MARK: - The fifth door

    /// **THE FIFTH DOOR.** `panel_command.url` is capped on the wire but deliberately not
    /// scheme-refined (spec §3: "the consumer is where policy lands"), so this check is the only
    /// thing between a model-authored `javascript:` url and `NormaCEFLoadURL`.
    ///
    /// Two assertions, and the SECOND is the one that matters: the refusal message is convenience,
    /// **the absence of a load call is the guarantee**. Mutation: delete the
    /// `PanelURLPolicy.normalizeTypedInput` guard in `PanelCommandConsumer.navigate` and this test
    /// reds on `cef.log` — the refused url reaches CEF — as well as on the message.
    func testTheFifthDoorRefusesEveryDisallowedSchemeAndNothingReachesTheBrowser() {
        let world = makeWorld()
        let refused = [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "blob:https://example.com/9d1b",
            "view-source:https://example.com",
            "chrome://settings",
        ]
        for (index, url) in refused.enumerated() {
            world.consumer.handle(command("navigate", url: url, commandId: "pcmd_\(index)"))
        }

        XCTAssertEqual(cef.log, [],
                       "a refused url reached the browser — the fifth door is not closed")
        XCTAssertEqual(sent.count, refused.count)
        XCTAssertTrue(sent.allSatisfy { $0.ok == false })
        // The refusal NAMES itself, so the model can fix its own input rather than retrying blind.
        XCTAssertTrue(sent.allSatisfy { $0.result?.contains("http and https") == true },
                      "\(sent.map { $0.result ?? "" })")
        XCTAssertTrue(sent.first?.result?.contains("`javascript`") == true, "\(sent)")
    }

    /// The door is door 1's function, so the agent gets its normalisation too: a bare host is
    /// completed exactly as it is for a person typing one, and `localhost` keeps its `http`.
    func testTheFifthDoorNormalisesABareHostJustAsTheAddressBarDoes() {
        let world = makeWorld()
        world.consumer.handle(command("navigate", url: "example.com"))
        world.consumer.handle(command("navigate", url: "localhost:3000", commandId: "pcmd_2"))
        XCTAssertEqual(cef.log, ["c1 load url=https://example.com", "c1 load url=http://localhost:3000"])
        XCTAssertTrue(sent.allSatisfy { $0.ok == true })
    }

    /// An over-cap url is refused by the SAME door and named for what it is, so the model does not
    /// read a length problem as a scheme problem.
    func testAnOverLongNavigateUrlIsRefusedAsALengthProblem() {
        let world = makeWorld()
        let long = "https://example.com/" + String(repeating: "a", count: PanelURLPolicy.urlMaxLength)
        world.consumer.handle(command("navigate", url: long))
        XCTAssertEqual(cef.log, [])
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("past the 2048-character limit") == true, "\(sent)")
    }

    // MARK: - Tabs that are not there

    /// An unknown tabId answers rather than timing out — for every verb, including the two that
    /// would otherwise be waiting on a CDP completion that was never even handed over.
    func testAnUnknownTabIdIsAnsweredForEveryVerb() {
        let world = makeWorld()
        for (index, verb) in ["navigate", "back", "read", "screenshot"].enumerated() {
            world.consumer.handle(command(verb, tabId: "ghost", url: "https://example.com",
                                          commandId: "pcmd_\(index)"))
        }
        XCTAssertEqual(sent.count, 4)
        XCTAssertTrue(sent.allSatisfy { $0.ok == false })
        XCTAssertTrue(sent.allSatisfy { $0.result?.contains("no live browser") == true },
                      "\(sent.map { $0.result ?? "" })")
        XCTAssertEqual(cef.log, [])
        XCTAssertEqual(clock.liveTimers.count, 0,
                       "a command that answered must leave no deadline armed")
    }

    /// A command with no `tabId` at all (the field is optional on the wire) is refused rather than
    /// aimed at a tab this consumer picked for itself — which tab a verb applies to is the caller's
    /// decision, not this file's.
    func testACommandWithNoTabIdIsRefusedRatherThanAimedSomewhere() {
        let world = makeWorld()
        world.consumer.handle(command("read", tabId: nil))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("tabId") == true, "\(sent)")
        XCTAssertEqual(cef.log, [])
    }

    // MARK: - Exactly one result

    /// **Exactly one `panel.commandResult` per command.** The daemon dedups, but relying on that
    /// would be relying on a tolerance rather than meeting the contract.
    ///
    /// The reply arrives AFTER the deadline abandoned the call — the sharpest version of the race,
    /// because both racers genuinely run.
    func testExactlyOneResultIsSentEvenWhenTheReplyBeatsTheDeadlineHome() {
        let world = makeWorld()
        world.consumer.handle(command("read"))
        XCTAssertEqual(clock.liveTimers.count, 1)

        clock.fire(clock.liveTimers[0].id)
        XCTAssertEqual(sent, [], "the deadline must send nothing at all")

        // The browser answers anyway — late, but a real answer.
        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: #"{"result":{"value":"hello"}}"#))
        XCTAssertEqual(sent, [], "a reply that lost to the deadline must not be sent")
    }

    /// The other direction: a reply that WINS disarms the deadline, so nothing fires later.
    func testAReplyThatWinsDisarmsTheDeadline() {
        let world = makeWorld()
        world.consumer.handle(command("read"))
        let timer = clock.liveTimers[0].id

        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: #"{"result":{"value":"hello"}}"#))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.result, "hello")
        XCTAssertTrue(clock.cancelled.contains(timer),
                      "an answered command left its deadline armed — it would fire for a call "
                          + "nobody is waiting on")
        XCTAssertEqual(clock.liveTimers.count, 0)
    }

    /// **The deadline sends NOTHING**, and the reasoning is the daemon's clock: its own timer was
    /// armed for the same `deadlineMs` and armed strictly earlier (dispatch arms before it emits,
    /// and the event still has a socket to cross), so a result sent now can only be `dropped` — at
    /// the cost of up to 3 MiB on the wire for a command nobody awaits.
    func testTheDeadlineAbandonsTheVerbAndSendsNoResult() {
        let world = makeWorld()
        world.consumer.handle(command("screenshot", deadlineMs: 8_000))

        XCTAssertEqual(clock.liveTimers.count, 1)
        XCTAssertEqual(clock.liveTimers[0].fireAt, clock.current.addingTimeInterval(8),
                       "the local deadline must be the command's own deadlineMs")

        clock.fire(clock.liveTimers[0].id)
        XCTAssertEqual(sent, [])
    }

    // MARK: - The quit beat

    /// **The quiescent latch: no CDP call, no result.** Silence is right because the app is about to
    /// stop existing — an honest failure and a timeout describe the same fact, and sending would be
    /// a socket write during the beat live-gate fix I exists to keep empty.
    func testCommandsArrivingDuringTheQuitBeatDoNothingAtAll() {
        let world = makeWorld()
        world.runtime.quiesce()

        for (index, verb) in ["navigate", "back", "read", "screenshot"].enumerated() {
            world.consumer.handle(command(verb, url: "https://example.com", commandId: "pcmd_\(index)"))
        }

        XCTAssertEqual(cef.log, [], "the quit latch let a verb through to CEF")
        XCTAssertEqual(sent, [], "a command dropped during the beat must produce no result either")
        XCTAssertEqual(clock.liveTimers.count, 0, "nothing should have been armed")
    }

    // MARK: - read: the cap pre-check

    /// **The cap PRE-CHECK, and it is a refusal rather than a truncation.**
    ///
    /// Sending an over-cap result is not "slightly too much": the daemon refuses the whole RPC at
    /// `parseParams`, the app's `try?` swallows that, and the command expires on its deadline — so
    /// the agent is told "the Mac app never answered" for a page that was read perfectly well.
    ///
    /// Mutation: delete the `length <= Self.resultMaxLength` guard in `PanelCommandConsumer.read`
    /// and this reds — the whole page is handed to a `sendResult` the daemon would reject.
    func testAnOverCapPageTextIsRefusedWithItsSizeRatherThanTruncated() {
        let world = makeWorld()
        world.consumer.handle(command("read"))

        let huge = String(repeating: "a", count: PanelCommandConsumer.resultMaxLength + 1)
        let payload = String(data: try! JSONSerialization.data(
            withJSONObject: ["result": ["value": huge]]), encoding: .utf8)!
        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: payload))

        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("past the") == true, "\(sent)")
        XCTAssertFalse(sent.first?.result?.contains(String(repeating: "a", count: 200)) == true,
                       "the page text must not be sent at all — truncated or otherwise")
    }

    /// **The UNIT the cap is measured in, which is the half that drifts.** Zod's `.max(n)` counts
    /// UTF-16 code units; Swift's `String.count` counts grapheme clusters. This text is UNDER the
    /// cap by `String.count` and OVER it on the wire — so a consumer measuring with `.count` would
    /// send a value the daemon then rejects, and the command would time out with the app believing
    /// it had answered. (`PanelURLPolicy.wireLength`'s own doc records what this cost the first
    /// time, in `panel.reportNavigation`.)
    func testTheCapIsMeasuredInTheDaemonsUnitNotSwiftsCharacters() {
        let world = makeWorld()
        world.consumer.handle(command("read"))

        // Each emoji is ONE Swift Character and TWO UTF-16 units.
        let emoji = String(repeating: "😀", count: PanelCommandConsumer.resultMaxLength / 2 + 1)
        XCTAssertLessThan(emoji.count, PanelCommandConsumer.resultMaxLength,
                          "the fixture must be under the cap by Swift's own measure, or it proves "
                              + "nothing about the unit")
        XCTAssertGreaterThan(PanelURLPolicy.wireLength(emoji), PanelCommandConsumer.resultMaxLength)

        let payload = String(data: try! JSONSerialization.data(
            withJSONObject: ["result": ["value": emoji]]), encoding: .utf8)!
        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: payload))

        XCTAssertEqual(sent.first?.ok, false,
                       "measured with String.count this passes the check and the daemon rejects it")
    }

    /// The caps are the daemon's, mirrored by hand. `PANEL_COMMAND_RESULT_MAX_LENGTH` and
    /// `PANEL_COMMAND_IMAGE_B64_MAX_LENGTH` (`packages/protocol/src/methods.ts`) are the counterparts;
    /// change one and this pin is what says so.
    func testTheCapsAreTheExactValuesTheDaemonEnforces() {
        XCTAssertEqual(PanelCommandConsumer.resultMaxLength, 64 * 1024)
        XCTAssertEqual(PanelCommandConsumer.imageBase64MaxLength, 3 * 1024 * 1024)
    }

    /// An over-cap screenshot gets the same treatment, and here truncation is not even superficially
    /// tempting — half a base64 PNG is a corrupt file, not a smaller picture.
    func testAnOverCapScreenshotIsRefusedRatherThanSentInPart() {
        let world = makeWorld()
        world.consumer.handle(command("screenshot"))

        let huge = String(repeating: "A", count: PanelCommandConsumer.imageBase64MaxLength + 1)
        let payload = String(data: try! JSONSerialization.data(withJSONObject: ["data": huge]),
                             encoding: .utf8)!
        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: payload))

        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertNil(sent.first?.imageBase64, "no part of an over-cap image may be sent")
    }

    /// The happy paths, so the refusals above are not the only shapes pinned.
    func testAReadAndAScreenshotThatFitAreSentThrough() {
        let world = makeWorld()

        world.consumer.handle(command("read"))
        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: #"{"result":{"type":"string","value":"Hello, page"}}"#))
        XCTAssertEqual(sent.first?.ok, true)
        XCTAssertEqual(sent.first?.result, "Hello, page")
        XCTAssertNil(sent.first?.imageBase64)

        world.consumer.handle(command("screenshot", commandId: "pcmd_2"))
        XCTAssertTrue(cef.answerNextCDP(ok: true, payload: #"{"data":"iVBORw0KGgo="}"#))
        XCTAssertEqual(sent.last?.ok, true)
        XCTAssertEqual(sent.last?.imageBase64, "iVBORw0KGgo=")
        XCTAssertEqual(sent.last?.commandId, "pcmd_2")
    }

    /// A CDP failure carries its reason through to the model — the bridge promises a
    /// `{"message": …}` object for every failure, both CEF's and its own.
    func testACDPFailureIsReportedWithTheBrowsersOwnReason() {
        let world = makeWorld()
        world.consumer.handle(command("read"))
        XCTAssertTrue(cef.answerNextCDP(
            ok: false, payload: #"{"code":-32000,"message":"Cannot find context with specified id"}"#))

        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertEqual(sent.first?.result, "Cannot find context with specified id")
    }

    /// A thrown expression comes back from CEF as a SUCCESSFUL method call — the protocol method
    /// worked, the JavaScript did not. Reading that as text would hand the model an empty page.
    func testAThrownEvaluateIsNotReadAsAnEmptyPage() {
        let world = makeWorld()
        world.consumer.handle(command("read"))
        XCTAssertTrue(cef.answerNextCDP(
            ok: true,
            payload: #"{"result":{"type":"object"},"exceptionDetails":{"text":"Uncaught"}}"#))

        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("did not return any text") == true, "\(sent)")
    }

    /// The command's own session travels back with the answer. The daemon checks it against its
    /// pending entry and refuses a mismatch (`PanelCommandRegistry.resolve`), which is what keeps
    /// that field from being decorative — so reading it off the shell's current attachment instead
    /// would break every command served for a session the shell has hopped away from.
    func testTheAnswerCarriesTheCommandsOwnSessionAndId() {
        let world = makeWorld()
        world.consumer.handle(command("back", commandId: "pcmd_xyz", sessionId: "other-session"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.sessionId, "other-session")
        XCTAssertEqual(sent.first?.commandId, "pcmd_xyz")
    }

    // MARK: - The reply parser

    func testTheReplyParserReadsWhatCDPActuallySends() {
        XCTAssertEqual(
            PanelCDPReply.evaluatedString(fromResultJSON: #"{"result":{"type":"string","value":"x"}}"#), "x")
        XCTAssertNil(PanelCDPReply.evaluatedString(fromResultJSON: #"{"result":{"type":"undefined"}}"#))
        XCTAssertNil(PanelCDPReply.evaluatedString(
            fromResultJSON: #"{"result":{"value":"x"},"exceptionDetails":{}}"#),
            "a thrown expression is not a page")
        XCTAssertNil(PanelCDPReply.evaluatedString(fromResultJSON: "not json"))
        XCTAssertNil(PanelCDPReply.evaluatedString(fromResultJSON: "{}"))

        XCTAssertEqual(PanelCDPReply.screenshotBase64(fromResultJSON: #"{"data":"AAA"}"#), "AAA")
        XCTAssertNil(PanelCDPReply.screenshotBase64(fromResultJSON: #"{"data":""}"#))
        XCTAssertNil(PanelCDPReply.screenshotBase64(fromResultJSON: "{}"))

        XCTAssertEqual(PanelCDPReply.failureMessage(fromJSON: #"{"code":-1,"message":"nope"}"#), "nope")
        XCTAssertEqual(PanelCDPReply.failureMessage(fromJSON: #"{"message":"this tab has no live browser"}"#),
                       "this tab has no live browser")
        XCTAssertNil(PanelCDPReply.failureMessage(fromJSON: #"{"message":""}"#))
        XCTAssertNil(PanelCDPReply.failureMessage(fromJSON: "{}"))
    }

    /// The evaluate expression is real JavaScript in real JSON — quotes, newlines and all — which is
    /// why the params are built with `JSONSerialization` rather than string concatenation.
    func testTheReadExpressionIsValidJSONWithTheDOMFallbackInIt() throws {
        let world = makeWorld()
        world.consumer.handle(command("read"))

        let logged = try XCTUnwrap(cef.log.first)
        let json = String(logged.drop(while: { $0 != "{" }))
        let parsed = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let expression = try XCTUnwrap(parsed["expression"] as? String)
        XCTAssertTrue(expression.contains("innerText"))
        XCTAssertTrue(expression.contains("textContent"), "the no-layout fallback is gone")
        XCTAssertEqual(parsed["returnByValue"] as? Bool, true)
        XCTAssertEqual(parsed["awaitPromise"] as? Bool, false,
                       "awaiting a promise would let a page hold the call open past any bound this "
                           + "consumer sets")
    }
}
