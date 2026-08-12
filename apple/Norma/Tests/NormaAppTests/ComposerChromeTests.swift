import XCTest
import SwiftUI
@testable import Norma

/// mac-chat-parity Task 5 — the per-mode composers (spec §3, the user's architecture ruling:
/// *"each mode should have its own dedicated composer which can also have different styling and
/// maybe more features. but yes chat shouldnt show that row"*).
///
/// **What this file covers:** the mode → chrome mapping, each mode's chrome INVENTORY (which
/// blocks it declares), and the card's WIRING to that mapping — driven through `NormaComposerCard`'s
/// real initialiser, not only through the free function, because pinning the mapping alone would
/// survive a card that ignored its own mode entirely (the Task 4 mutation lesson, recorded in this
/// plan's ledger: "the adapter method was pinned, its WIRING was not").
///
/// **Task 6 (spec §4)** then filled code's and dispatch's strip slot with the permissions row, and
/// the same reasoning went one level further out: the row's own tests drive
/// `WindowContentView.composerCard`, so the shell's whole path — adapter → card → per-mode chrome →
/// row — is covered by value assertions rather than by inspection of a call site.
///
/// **What it does NOT cover, and cannot:** rendered pixels. Nothing here proves the strip's band is
/// visible, that the mode segment lands on the right column, or that chat's composer *looks* like a
/// composer with a row removed. Those are the user's live gate. This codebase's convention is that
/// SwiftUI bodies are not exercised in tests (see `DashboardTests`' own file doc); the two
/// source-scan tests at the end are the honest, stated-limits substitute for the one claim that has
/// no value-level form — that the shared parts are written ONCE, outside any mode branch.
@MainActor
final class ComposerChromeTests: XCTestCase {
    /// Every chrome is built from a context; the tests build the same one the card does.
    ///
    /// `policy: nil` by default — a surface that wires no policy control. Task 6's row is *absent*
    /// there rather than dead, the same rule chat's row follows, so the tests that are not about the
    /// permissions row keep describing a card with no band.
    private func chrome(_ mode: SessionMode, announcement: String = "",
                        policy: ComposerPolicyControl? = nil) -> any ComposerChrome {
        composerChrome(ComposerContext(mode: .constant(mode),
                                       modeIsSelectable: true,
                                       policy: policy,
                                       announcement: announcement))
    }

    /// The wiring a live session's surface hands the card (`FieldStateAdapter.composerPolicyControl`
    /// is the real one). `nil` for the policy is mac-chat-parity Task 4's `sessionPolicyKnown ==
    /// false` — the daemon has not said.
    private func wiredPolicy(_ policy: String?, inFlight: Bool = false,
                             onSet: @escaping (String) -> Void = { _ in }) -> ComposerPolicyControl {
        ComposerPolicyControl(policy: policy, changeInFlight: inFlight, onSet: onSet)
    }

    private struct NotAPermissionsStrip: Error {}

    /// The strip's payload, or a failure that names what was found instead. Throws rather than
    /// force-unwrapping: a test whose failure mode is a crash cannot report a mutation count
    /// (this plan's Task 3 lesson, recorded in its ledger).
    private func permissions(_ strip: ComposerStrip?, file: StaticString = #filePath,
                             line: UInt = #line) throws -> ComposerPermissionsRow {
        guard case .permissions(let row)? = strip?.kind else {
            XCTFail("expected a permissions strip, found \(String(describing: strip?.kind))",
                    file: file, line: line)
            throw NotAPermissionsStrip()
        }
        return row
    }

    /// A live session's `WindowContentView`, built exactly as `ShellSessionHost.swift:1800` builds
    /// it (minus the sidebar wiring, which no assertion here reads).
    private func liveView(_ adapter: FieldStateAdapter,
                          mode: SessionMode?) -> WindowContentView<EmptyView> {
        WindowContentView(adapter: adapter, tint: .blue, topInset: 8, sidebars: nil,
                          composerCardMode: mode) { EmptyView() }
    }

    private func shellSource() throws -> String {
        try source("Sources/AppShell/NormaComposerCard.swift")
    }

    private func source(_ relative: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// Comment lines stripped, so a doc comment that NAMES the thing being forbidden is not a false
    /// positive — the same treatment `InteractionCardTests`' scan uses, and for the same reason:
    /// without it the check punishes writing the reason down.
    private func codeOnly(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.drop(while: { $0 == " " }).hasPrefix("//") ? "" : String($0) }
            .joined(separator: "\n")
    }

    // MARK: - The mapping: one dedicated composer per mode

    /// The ruling in one assertion: a mode does not get "the composer with some things switched
    /// off", it gets ITS OWN chrome type. The concrete type name is asserted deliberately — it is
    /// the whole structural claim, and a mapping that quietly returned one shared type for
    /// everything would otherwise still satisfy a `mode`-only check.
    func testEveryModeGetsItsOwnDedicatedChromeType() {
        let expected: [SessionMode: String] = [
            .chat: "ChatComposerChrome",
            .code: "CodeComposerChrome",
            .dispatch: "DispatchComposerChrome",
            .cowork: "CoworkComposerChrome",
        ]
        for mode in SessionMode.allCases {
            let made = chrome(mode)
            XCTAssertEqual(made.mode, mode, "\(mode) was handed \(made.mode)'s composer")
            XCTAssertEqual(String(describing: type(of: made)), expected[mode],
                           "\(mode) must have its own composer type, not a shared one")
        }
        XCTAssertEqual(Set(expected.values).count, SessionMode.allCases.count,
                       "four modes, four distinct types")
    }

    // MARK: - Chat's absent permissions row (the user's ruling, spec §3's table)

    /// **THE pin of this task.** Chat's composer declares NO strip — the band behind the composer is
    /// where spec §4 puts the permissions row, and chat's slot is *absent*, not present-and-disabled.
    /// The daemon refuses `session.setPolicy` for a chat target outright
    /// (`packages/core/src/ipc/server.ts:1525`), so there is no policy for a chat row to show.
    ///
    /// Task 6 hangs its row on `makeStrip()` for code and dispatch; this assertion is what stops it
    /// reaching chat by accident. Mutation-proven: hand `ChatComposerChrome` any non-nil strip and
    /// this reds.
    func testChatCarriesNoStripAndSoCanCarryNoPermissionsRow() {
        XCTAssertNil(chrome(.chat).makeStrip(),
                     "chat must have NO band behind its composer — the permissions row's home")
    }

    /// Code and dispatch carry the row only where there is something to set it on. A surface that
    /// wires no policy control (the new-chat page: no session exists yet) gets **no band**, not a
    /// chip that cannot do anything — the same absent-rather-than-disabled rule chat's row follows.
    ///
    /// (This replaces Task 5's `testCodeAndDispatchHaveAnEmptyStripSlotForTaskSix`, whose claim —
    /// the slot is empty — Task 6 exists to falsify.)
    func testCodeAndDispatchCarryNoRowOnASurfaceThatWiredNoPolicyControl() {
        XCTAssertNil(chrome(.code, policy: nil).makeStrip())
        XCTAssertNil(chrome(.dispatch, policy: nil).makeStrip())
    }

    // MARK: - Each mode's control set

    /// Cowork keeps exactly what it has today: the placeholder band, at its measured height. This is
    /// the "named slot" — the mode has no daemon mode at all (`SessionMode.isAvailable == false`,
    /// `session_spawn` pre-flight-rejects it), so its composer renders the same two unwired chips it
    /// rendered before this task and nothing more.
    func testCoworkCarriesThePlaceholderStripAtItsMeasuredHeight() {
        let strip = chrome(.cowork).makeStrip()
        XCTAssertEqual(strip?.kind, .coworkPlaceholders)
        XCTAssertEqual(strip?.height, newChatCoworkStripHeight)
    }

    /// The Chat/Cowork segment is offered by exactly the two modes that segment contains — today's
    /// behaviour (`newChatModeOptions.contains(mode)`), preserved. A code or dispatch composer has
    /// no business showing a choice between two modes that are neither of them.
    func testOnlyChatAndCoworkOfferTheModeSegment() {
        XCTAssertNotNil(chrome(.chat).makeControlRowAccessory())
        XCTAssertNotNil(chrome(.cowork).makeControlRowAccessory())
        XCTAssertNil(chrome(.code).makeControlRowAccessory())
        XCTAssertNil(chrome(.dispatch).makeControlRowAccessory())
    }

    /// The segment's own options are unchanged and still honest about Cowork — the same pair
    /// `SidebarBrandTests` pins, re-asserted here because the segment now lives in the per-mode
    /// chrome rather than inside the card.
    func testTheSegmentStillOffersChatAndAnUnavailableCowork() {
        XCTAssertEqual(newChatModeOptions, [.chat, .cowork])
        XCTAssertFalse(SessionMode.cowork.isAvailable)
    }

    // MARK: - The WIRING: the card derives its chrome from its own mode

    /// Task 4's lesson applied one task later. The three tests above drive `composerChrome(_:)`
    /// directly, and a card that ignored `mode` and always built chat's chrome would leave every one
    /// of them green. This drives the card's REAL initialiser — the same one both call sites use —
    /// and is the test that reds when the dispatch is collapsed.
    func testTheCardDerivesItsChromeFromItsOwnMode() {
        for mode in SessionMode.allCases {
            let card = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(mode),
                                         policy: nil)
            XCTAssertEqual(card.chrome.mode, mode,
                           "the card rendered \(card.chrome.mode)'s composer for a \(mode) session")
        }
    }

    /// The ruling, through the door the shell actually uses: a live chat session's card
    /// (`WindowContentView.composerCard` passes `mode: .constant(cardMode)`,
    /// `modeIsSelectable: false`) carries no band.
    ///
    /// Task 6 strengthened it: the card is handed a fully wired policy control — the same one a code
    /// session's gets — and chat *still* has no band. Chat's absence is its mode's, not an accident
    /// of what the surface happened to wire.
    func testALiveChatSessionsCardCarriesNoBand() {
        let card = NormaComposerCard(text: .constant("hi"), onSubmit: {},
                                     mode: .constant(.chat), modeIsSelectable: false,
                                     policy: wiredPolicy("bypass"), stripEdge: .above)
        XCTAssertNil(card.chrome.makeStrip())
    }

    /// …and a live code session's card, through the same door, reaches code's chrome — so Task 6's
    /// row actually appears.
    func testALiveCodeSessionsCardReachesCodesChrome() {
        let card = NormaComposerCard(text: .constant("hi"), onSubmit: {},
                                     mode: .constant(.code), modeIsSelectable: false,
                                     policy: wiredPolicy("ask"), stripEdge: .above)
        XCTAssertEqual(String(describing: type(of: card.chrome)), "CodeComposerChrome")
    }

    // MARK: - mac-chat-parity Task 6: the permissions row (spec §4)

    /// Code's row offers **all six** policies — spec §3's table. The daemon settles every one of
    /// them for a code target: `session.setPolicy` refuses only a chat target outright and only
    /// `plan` for a dispatch one (`packages/core/src/ipc/server.ts:1524-1529`).
    func testCodesPermissionsRowOffersAllSixPolicies() throws {
        let row = try permissions(chrome(.code, policy: wiredPolicy("ask")).makeStrip())
        XCTAssertEqual(row.offers, sessionPolicyModes)
        XCTAssertEqual(row.offers.count, 6)
    }

    /// Dispatch's row is code's **minus `plan`**, and minus nothing else — the daemon refuses
    /// exactly that one ("plan policy is not available for dispatch sessions — dispatch never asks
    /// permissions", `ipc/server.ts:1527-1528`) and settles the other five. The opposite shape from
    /// model/effort, which dispatch pins entirely.
    func testDispatchOffersEveryPolicyExceptPlan() throws {
        let row = try permissions(chrome(.dispatch, policy: wiredPolicy("ask")).makeStrip())
        XCTAssertFalse(row.offers.contains("plan"),
                       "the daemon refuses `plan` for a dispatch target — offering it is a row that RPC-errors")
        XCTAssertEqual(row.offers, sessionPolicyModes.filter { $0 != "plan" },
                       "…and refuses nothing else: the other five must all still be offered")
        XCTAssertEqual(row.offers.count, 5)
    }

    /// The row shows the policy **the daemon reported** — the whole point of Task 4's wire field.
    /// A `bypass` session must read Bypass, in its danger treatment, not the "Auto" placeholder the
    /// pre-T4 adapter would have shown for the life of the attachment.
    func testTheRowShowsThePolicyTheDaemonReported() throws {
        let row = try permissions(chrome(.code, policy: wiredPolicy("bypass")).makeStrip())
        XCTAssertEqual(row.showing, "bypass")
        XCTAssertEqual(row.chipTitle, "⚠ Bypass")
    }

    /// **Task 4's binding rule, enforced where it is enforceable.** While `sessionPolicyKnown ==
    /// false` the adapter still holds `"auto"` — a placeholder, not a reading — and this row makes a
    /// STANDING claim, so it must name no policy at all. Rendering "Auto" here is the exact standing
    /// lie Task 4 made the unknown case representable to prevent.
    ///
    /// It still names ITSELF: an unlabelled chip is not the same as a control that admits it does
    /// not know yet.
    func testNoPolicyLabelWhileTheDaemonHasNotSaid() throws {
        let row = try permissions(chrome(.code, policy: wiredPolicy(nil)).makeStrip())
        XCTAssertNil(row.showing)
        for policy in sessionPolicyModes {
            XCTAssertFalse(row.chipTitle.contains(policyDisplayLabel(policy)),
                           "the row claims \(policy) for a session whose policy the daemon never reported")
        }
        XCTAssertFalse(row.isDangerous, "…and claims no danger either way")
        XCTAssertFalse(row.chipTitle.isEmpty, "the control still names itself")
    }

    /// A change in flight is **visible**, not merely refused: the chip dims and its hover line says
    /// what is happening, while the policy it shows stays the old one — that is still the policy in
    /// force until the daemon confirms the new one (`adoptSessionPolicy` is called on success only).
    func testAChangeInFlightIsVisibleOnTheRow() throws {
        let settled = try permissions(chrome(.code, policy: wiredPolicy("ask")).makeStrip())
        XCTAssertTrue(settled.isEnabled)
        XCTAssertEqual(settled.chipOpacity, 1)

        let inFlight = try permissions(chrome(.code, policy: wiredPolicy("ask", inFlight: true)).makeStrip())
        XCTAssertTrue(inFlight.changeInFlight)
        XCTAssertFalse(inFlight.isEnabled, "a second change must not start while one is in flight")
        XCTAssertLessThan(inFlight.chipOpacity, 1, "…and the row must SHOW that, not only refuse the click")
        XCTAssertNotEqual(inFlight.help, settled.help)
        XCTAssertEqual(inFlight.showing, "ask",
                       "the policy in force is still the old one until the daemon confirms")
    }

    /// The dangerous-policy treatment survives the row's arrival — `bypass` and only `bypass`
    /// (`isPolicyDangerous`), carrying the same `⚠` affix the picker rows have always carried.
    func testDangerousPolicyKeepsItsStylingInTheRow() throws {
        for policy in sessionPolicyModes {
            let row = try permissions(chrome(.code, policy: wiredPolicy(policy)).makeStrip())
            XCTAssertEqual(row.isDangerous, policy == "bypass", "\(policy)'s danger flag on the row")
            XCTAssertEqual(row.chipTitle.hasPrefix("⚠ "), policy == "bypass",
                           "\(policy)'s ⚠ affix — the same one `policyPickerRow` has always used")
        }
    }

    /// The band is the measured recipe's 40 pt, and the **composer's own height never changes** —
    /// the standing ruling. The strip surface is exactly the composer plus the band; only which end
    /// of it protrudes depends on the edge.
    func testTheBandIsTheMeasuredHeightAndTheComposerDoesNotGrow() throws {
        let strip = chrome(.code, policy: wiredPolicy("ask")).makeStrip()
        XCTAssertEqual(strip?.height, newChatComposerStripHeight)
        XCTAssertEqual(newChatComposerStripHeight, 40, "spec §4's measured band")
        XCTAssertEqual(composerStripSurfaceHeight(newChatComposerStripHeight),
                       newChatComposerHeight + newChatComposerStripHeight,
                       "the surface grows by the band; the composer box stays newChatComposerHeight")
    }

    /// **The `.above` edge's first production use.** Cowork was the only strip producer until this
    /// task and is unreachable on a live session, so this direction had never rendered anywhere.
    ///
    /// `.above` anchors both surfaces at the BOTTOM, so the taller strip surface protrudes UPWARD
    /// past the composer's top edge, and pins its content to the TOP — the band that protrudes.
    /// `.below` (the new-chat page) is the mirror. Getting either pair backwards puts the row behind
    /// the opaque composer, where it is invisible.
    func testTheBandGrowsUpwardsOnALiveSessionAndDownwardsOnTheNewChatPage() {
        XCTAssertEqual(composerStripStackAlignment(.above), .bottom,
                       "a live session's composer sits at the window's bottom — its band must grow UP")
        XCTAssertEqual(composerStripContentAlignment(.above), .top,
                       "…and the row sits in that protruding band, not under the composer")
        XCTAssertEqual(composerStripStackAlignment(.below), .top)
        XCTAssertEqual(composerStripContentAlignment(.below), .bottom)
    }

    // MARK: - Task 6's WIRING: the shell's live card carries the adapter's own policy

    /// **The wiring pin, end to end through the real view.** Task 4's mutation lesson (recorded in
    /// this plan's ledger: "the adapter method was pinned, its WIRING was not") one task on — every
    /// value assertion above would stay green if `WindowContentView` built its card without a policy
    /// control at all. This drives the shell's actual path: adapter → `composerCard` → the mode's
    /// chrome → the row.
    func testTheLiveCardCarriesTheAdaptersOwnPolicy() throws {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.seedSessionPolicy(for: "s_1", in: [
            SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global",
                           approvalPolicy: "bypass"),
        ])
        let card = try XCTUnwrap(liveView(adapter, mode: .code).composerCard)
        XCTAssertEqual(card.stripEdge, .above, "a live session's band grows up from the composer")
        let row = try permissions(card.chrome.makeStrip())
        XCTAssertEqual(row.showing, "bypass", "the DAEMON's answer, read off session.list's row")
        XCTAssertEqual(row.offers, sessionPolicyModes)
    }

    /// The same path, before the row has loaded (the New-Chat hop always is): the adapter holds its
    /// `"auto"` placeholder and the card must decline to repeat it as an answer.
    func testTheLiveCardNamesNoPolicyUntilTheDaemonHasSaid() throws {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.seedSessionPolicy(for: "s_1", in: []) // attached before its row loaded
        XCTAssertEqual(adapter.sessionPolicy, "auto", "the premise: the placeholder IS there")
        let card = try XCTUnwrap(liveView(adapter, mode: .code).composerCard)
        XCTAssertNil(try permissions(card.chrome.makeStrip()).showing)
    }

    /// The heal reaches the row: once the directory's row lands, the same card names the real
    /// policy. (`healSessionPolicyIfUnknown` is one-way by ruling — a change made on another surface
    /// after this was seeded stays stale until the next session switch.)
    func testTheRowHealsWhenTheDirectoryRowLandsLate() throws {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.seedSessionPolicy(for: "s_1", in: [])
        adapter.healSessionPolicyIfUnknown(for: "s_1", in: [
            SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global",
                           approvalPolicy: "accept-edits"),
        ])
        let card = try XCTUnwrap(liveView(adapter, mode: .code).composerCard)
        XCTAssertEqual(try permissions(card.chrome.makeStrip()).showing, "accept-edits")
    }

    /// Chat's absence, through the shell's real path rather than through a hand-built context.
    func testTheLiveChatCardCarriesNoBandThroughTheRealView() throws {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.seedSessionPolicy(for: "s_chat", in: [
            SessionSummary(sessionId: "s_chat", title: nil, createdAt: 1, scope: "global",
                           mode: "chat", approvalPolicy: "chat"),
        ])
        let card = try XCTUnwrap(liveView(adapter, mode: .chat).composerCard)
        XCTAssertNil(card.chrome.makeStrip(),
                     "a chat session's card has no band even with a fully seeded policy behind it")
    }

    /// A surface that opts into no card at all keeps the bare 88 pt `ComposerTextView` — the
    /// detached window and the orb's morph window, on the 2026-08-07 ruling. The row exists only
    /// where the card exists.
    func testASurfaceWithNoCardModeKeepsItsPlainField() {
        let adapter = FieldStateAdapter(session: SessionModel())
        XCTAssertNil(liveView(adapter, mode: nil).composerCard)
    }

    // MARK: - The shared parts stay shared (source scans, with stated limits)

    /// **Task 5's review rider.** "Task 6 cannot give chat a row without editing `ChatComposerChrome`"
    /// is true only of the chrome path: a row added *unconditionally in the shared shell* would reach
    /// chat with every value-level pin still green (they assert `makeStrip() == nil`, which stays
    /// true). So the strip type may be constructed in exactly one file — the one where a mode's
    /// chrome is decided.
    ///
    /// **Limits:** it reads text. A shell that composed the row's *content view* directly, without
    /// naming `ComposerStrip`, would evade it — that is why the value-level chat pins exist too.
    func testTheStripTypeIsConstructedOnlyWhereChromeIsDecided() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        XCTAssertGreaterThan(files.count, 20, "the sweep must actually have walked the sources")
        for file in files {
            let code = codeOnly(try String(contentsOf: file, encoding: .utf8))
            guard code.contains("ComposerStrip(") else { continue }
            XCTAssertEqual(file.lastPathComponent, "ComposerChrome.swift",
                           "\(file.lastPathComponent) builds a composer strip — a band built anywhere but the per-mode chrome reaches EVERY mode, chat included")
        }
    }

    /// The ruling's other half: the split must be STRUCTURAL, "not a pile of `if mode == …` inside
    /// one view". The shared shell is where that pile would accumulate, so the shell's own source
    /// must contain no mode conditional at all — every mode difference lives in `ComposerChrome.swift`.
    ///
    /// **Limits, all real:** this reads text, so it cannot see a mode conditional expressed some
    /// other way (a dictionary keyed by mode, a helper in another file returning a per-mode bool
    /// the shell then branches on). It is a tripwire for the obvious regression, not a proof.
    func testTheSharedShellHoldsNoModeConditionals() throws {
        let code = codeOnly(try shellSource())
        for forbidden in ["mode ==", "mode !=", "switch mode", "case .chat", "case .code",
                          "case .dispatch", "case .cowork", "contains(mode)"] {
            XCTAssertFalse(code.contains(forbidden),
                           "the shared shell branches on mode (`\(forbidden)`) — per-mode chrome belongs in ComposerChrome.swift")
        }
    }

    /// The text field, the send button and the submit path are written ONCE, in the shared shell,
    /// outside any mode branch — which is what "identical across modes and not regressed" means
    /// structurally. A per-mode chrome that declared its own would be the drift this shape exists to
    /// prevent (the 2026-08-07 extraction's own argument, one level up).
    ///
    /// **Limits:** it proves the declarations' location, not that they render identically; and it
    /// cannot see through composition — a chrome block could in principle compose some other view
    /// that itself contains a text field. The live gate is what confirms one composer, one field.
    func testTheTextFieldAndSendButtonAreWrittenOnceInTheSharedShell() throws {
        let shell = codeOnly(try shellSource())
        XCTAssertEqual(shell.components(separatedBy: "ComposerTextView(").count - 1, 1,
                       "exactly one text field, in the shared shell")
        XCTAssertEqual(shell.components(separatedBy: "private var sendButton").count - 1, 1,
                       "exactly one send button, in the shared shell")

        let chromeSource = codeOnly(try source("Sources/AppShell/ComposerChrome.swift"))
        XCTAssertFalse(chromeSource.contains("ComposerTextView"),
                       "a per-mode chrome declares its own text field — the shared parts must stay shared")
        XCTAssertFalse(chromeSource.contains("sendButton"),
                       "a per-mode chrome declares its own send button — the shared parts must stay shared")
        XCTAssertFalse(chromeSource.contains("onSubmit"),
                       "a per-mode chrome owns a submit path — submit belongs to the shared shell")
    }
}
