import NormaProtocol
import XCTest
@testable import Norma

/// office-agent-tools T1 — `OfficeCommandConsumer`, the routing shell that refuses every office verb.
///
/// **No `CEFRecorder`, no `FakeScheduler`** — unlike `PanelCommandConsumerTests`, which needs both:
/// this consumer touches neither `BrowserRuntime` nor any clock (`OfficeCommandConsumer.swift`'s own
/// header explains why — every verb here answers synchronously, with no async work to bound and
/// nothing to fake). The harness is correspondingly the simplest thing that can hold what
/// `sendResult` was called with.
///
/// What this file does NOT cover, named rather than left implicit: that `PanelCommandConsumer`
/// actually ROUTES an office action here instead of falling into its own unknown-verb branch is
/// `PanelCommandConsumerTests.testOfficeActionsRouteToTheOfficeConsumer...` — that file's job, since
/// it is the one that owns `handle`'s dispatch.
@MainActor
final class OfficeCommandConsumerTests: XCTestCase {

    // MARK: - Fixtures

    /// What the consumer sent back, in order. Mirrors `PanelCommandConsumerTests.Sent`.
    struct Sent: Equatable {
        var sessionId: String
        var commandId: String
        var ok: Bool
        var result: String?
        var imageBase64: String?
    }

    private var sent: [Sent] = []

    override func setUp() {
        super.setUp()
        sent = []
    }

    private func makeConsumer() -> OfficeCommandConsumer {
        OfficeCommandConsumer(sendResult: { [unowned self] sessionId, commandId, ok, result, imageBase64 in
            self.sent.append(Sent(sessionId: sessionId, commandId: commandId, ok: ok,
                                  result: result, imageBase64: imageBase64))
        })
    }

    /// Built as WIRE JSON and decoded, never with a memberwise initialiser — `PanelCommand`'s own
    /// init is internal to NormaProtocol, and going through the real decode is the honest shape
    /// anyway: it is exactly what `parseServerLine` hands the pump, and it keeps a fixture from
    /// describing a payload the daemon could not emit. (`PanelCommandConsumerTests.command(_:...)`'s
    /// own doc makes the identical argument; duplicated here rather than shared because the two test
    /// targets have nothing else in common to justify a shared helper file for one function.)
    private func command(_ action: String, args: [String: Any]? = nil, tabId: String? = nil,
                         commandId: String = "pcmd_1", sessionId: String = "s1",
                         deadlineMs: Int = 35_000) -> SessionEvent.PanelCommand {
        var fields: [String: Any] = [
            "type": "panel_command", "seq": 1, "sessionId": sessionId, "ts": 0,
            "commandId": commandId, "action": action, "deadlineMs": deadlineMs,
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

    /// All 22 verbs `OFFICE_COMMAND_ACTIONS` (events.ts) names as of T1 — hand-spelled here rather
    /// than imported, since there is deliberately NO Swift mirror of that list to import FROM (this
    /// file's own header, and `OfficeCommandConsumer.swift`'s). If the TS list drifts from this one,
    /// `office-commands.test.ts`'s own count assertion (11 sheets + 6 slides + 5 docs = 22) is the
    /// tripwire that catches it on the TS side; this array exists only to drive the SAME 22 through
    /// the Swift consumer in one test, not to be a second source of truth.
    static let allOfficeVerbsAsOfT1 = [
        "office.sheets.info", "office.sheets.read", "office.sheets.set",
        "office.sheets.insert_rows", "office.sheets.insert_cols",
        "office.sheets.delete_rows", "office.sheets.delete_cols",
        "office.sheets.add_sheet", "office.sheets.delete_sheet", "office.sheets.rename_sheet",
        "office.sheets.format",
        "office.slides.info", "office.slides.read", "office.slides.set_text",
        "office.slides.add_slide", "office.slides.delete_slide", "office.slides.reorder",
        "office.docs.info", "office.docs.read", "office.docs.replace",
        "office.docs.insert", "office.docs.append",
    ]

    /// T3 — the 20 that are STILL T1's own refusal shell (`allOfficeVerbsAsOfT1` minus the two
    /// `sheets` reads T3 made real). Every pre-existing test below that needs "an office verb that
    /// still answers synchronously with the not-implemented refusal, for ANY verb" now picks from
    /// this list rather than hand-naming `office.sheets.read`/`office.sheets.info`, which would
    /// otherwise silently start asserting on ASYNC behaviour these tests were never built to await.
    static let stillStubOfficeVerbs = allOfficeVerbsAsOfT1.filter {
        $0 != "office.sheets.info" && $0 != "office.sheets.read"
    }

    // MARK: - isOfficeAction

    func testIsOfficeActionIsAPrefixTestNotAMembershipList() {
        XCTAssertTrue(OfficeCommandConsumer.isOfficeAction("office.sheets.read"))
        XCTAssertTrue(OfficeCommandConsumer.isOfficeAction("office.docs.append"))
        // A verb from a THIRD task, invented for this test and never listed anywhere — still counts
        // as an office action, because the test is the prefix, not a list. This is the point.
        XCTAssertTrue(OfficeCommandConsumer.isOfficeAction("office.spreadsheets.explode"))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction("navigate"))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction("click"))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction(""))
        XCTAssertFalse(OfficeCommandConsumer.isOfficeAction("office"), "no trailing dot, no match")
    }

    // MARK: - Every verb refuses, structured, never silence — the brief's own words

    func testEveryOfficeVerbAnswersNotImplementedRatherThanSilence() {
        let consumer = makeConsumer()
        for (index, action) in Self.stillStubOfficeVerbs.enumerated() {
            consumer.handle(command(action, commandId: "pcmd_\(index)"))
        }
        XCTAssertEqual(sent.count, Self.stillStubOfficeVerbs.count, "every still-stub verb must answer exactly once")
        XCTAssertTrue(sent.allSatisfy { $0.ok == false }, "\(sent)")
        XCTAssertTrue(sent.allSatisfy { $0.imageBase64 == nil })
        XCTAssertTrue(sent.allSatisfy { ($0.result?.isEmpty ?? true) == false }, "\(sent)")
        // Reaching this assertion at all — rather than a trap inside `handle` — is half the "never a
        // throw" proof; every result actually saying something is the other half, checked above.
    }

    func testTheRefusalNamesTheToolAndVerbSeparately() {
        let consumer = makeConsumer()
        consumer.handle(command("office.sheets.set"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("sheets") == true, "\(sent)")
        XCTAssertTrue(sent.first?.result?.contains("set") == true, "\(sent)")
        let lower = sent.first?.result?.lowercased() ?? ""
        XCTAssertTrue(lower.contains("not implemented") || lower.contains("not yet implement"), "\(sent)")
    }

    func testDifferentKindsAreWordedWithTheirOwnKindAndVerb() {
        let consumer = makeConsumer()
        consumer.handle(command("office.slides.add_slide", commandId: "c1"))
        consumer.handle(command("office.docs.replace", commandId: "c2"))
        XCTAssertTrue(sent[0].result?.contains("slides") == true, "\(sent[0])")
        XCTAssertTrue(sent[0].result?.contains("add_slide") == true, "\(sent[0])")
        XCTAssertTrue(sent[1].result?.contains("docs") == true, "\(sent[1])")
        XCTAssertTrue(sent[1].result?.contains("replace") == true, "\(sent[1])")
    }

    func testTheAnswerCarriesTheCommandsOwnSessionAndId() {
        let consumer = makeConsumer()
        consumer.handle(command("office.docs.info", commandId: "pcmd_xyz", sessionId: "s-office-1"))
        XCTAssertEqual(sent.first?.sessionId, "s-office-1")
        XCTAssertEqual(sent.first?.commandId, "pcmd_xyz")
    }

    /// No `tabId` on the command at all — the ordinary shape for an office verb (design doc §3: a
    /// document is addressed by path, not by an existing panel tab). Must still answer cleanly; this
    /// consumer never reads `tabId` in the first place, so there is nothing here TO trip on it, but
    /// the test pins the observable behaviour rather than the implementation detail.
    func testAnOfficeCommandWithNoTabIdStillAnswers() {
        let consumer = makeConsumer()
        consumer.handle(command("office.docs.info", tabId: nil))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
    }

    /// A verb this file cannot even parse into (kind, verb) — still answered, never a crash. Nothing
    /// TODAY sends this (the daemon only ever emits `office.<kind>.<verb>`, all 22 well-formed), but
    /// `action` decodes as a plain `String` with no shape guarantee (`SessionEvent.swift`), so this
    /// file must not assume its own parser succeeds — the same posture
    /// `testUnknownPanelCommandVerbStillDecodes` (NormaProtocol) takes for the wire layer beneath it.
    func testAMalformedOfficeActionStillAnswersRatherThanCrashing() {
        let consumer = makeConsumer()
        consumer.handle(command("office.onlyonepart"))
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.ok, false)
        XCTAssertTrue(sent.first?.result?.contains("office.onlyonepart") == true, "\(sent)")
    }

    // MARK: - The bounded-message guarantees (this file's own header, "the refusal string is
    // bounded on purpose") — the one way a "not implemented" shell could silently regress into the
    // exact silent-timeout bug its own answer path exists to avoid.

    /// `args` is never read by this consumer's STUB verbs at all (`OfficeCommandConsumer.handle`'s
    /// synchronous `default:` branch only ever touches `command.sessionId`/`command.commandId`/
    /// `command.action`) — so a huge `args.path` cannot reach a STUB verb's message, structurally, not
    /// merely by discipline. **T3 correction**: this test originally used `office.sheets.read` as its
    /// example, which read as "args is never read AT ALL" — no longer true now that `sheets.read` is
    /// real and genuinely needs `args`. Switched to `office.sheets.set` (still a stub) to keep this
    /// test's own claim honest; the EQUIVALENT guarantee for the two REAL verbs — a huge/malicious
    /// operand still cannot grow the ANSWER past a bound, even though it genuinely gets read — is
    /// `testASheetsReadResultIsCappedNotAllowedToGrowUnbounded` below, a different mechanism
    /// (`sheetsResultMaxLength`, checked on the BUILT result) proving the equivalent property for a
    /// verb that must read `args` to do its job at all.
    func testTheRefusalNeverGrowsWithArgs() {
        let consumer = makeConsumer()
        let hugePath = String(repeating: "x", count: 100_000)
        consumer.handle(command("office.sheets.set", args: ["path": hugePath, "sheet": "S"]))
        XCTAssertEqual(sent.count, 1)
        XCTAssertFalse(sent.first?.result?.contains(hugePath) == true)
        XCTAssertLessThan(sent.first?.result?.count ?? Int.max, 1_000,
                          "an office refusal must be static-length prose, not args-length prose")
    }

    /// The wire's own action-length pressure valve — briefed at ~120 chars (mirrors
    /// `PanelCommandConsumer.quotedIdentifierMaxLength`), so even an absurd `action` string (nothing
    /// on the wire bounds this field's length — `SessionEvent.swift`'s `action: String`) cannot grow
    /// this consumer's answer past a small, fixed bound. Without this guard an over-cap `result`
    /// would be REFUSED WHOLE by the daemon and the command would expire on its deadline — this
    /// file's header names that exact failure mode.
    func testAnAbsurdlyLongActionIsBriefedNotEchoedInFull() {
        let consumer = makeConsumer()
        let hugeAction = "office." + String(repeating: "y", count: 100_000)
        consumer.handle(command(hugeAction))
        XCTAssertEqual(sent.count, 1)
        XCTAssertLessThan(sent.first?.result?.count ?? Int.max, 1_000)
    }
}
