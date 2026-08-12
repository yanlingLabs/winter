import XCTest
import SwiftUI
import NormaKit
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

    /// mac-chat-parity Task 7: the catalogue the chip's two lists come from — the SAME shape
    /// `ModelPickerTests` drives the header's menus with, so "the chip opens the menu the header
    /// does" is asserted against one vocabulary rather than two fixtures that could drift.
    private func catalogue() -> SyncConfigSnapshot {
        SyncConfigSnapshot(provider: "codex-oauth", defaultModel: "srv-a",
                           models: [SyncConfigModelInfo(id: "srv-a", efforts: ["none", "low", "high"]),
                                    SyncConfigModelInfo(id: "srv-b", efforts: ["high", "max"])],
                           defaultEffort: "high", clientEfforts: ["ultra"])
    }

    /// The model/effort wiring a surface hands the card (`WindowContentView.composerModelControl`
    /// for a live session, `ShellSessionHost.newChatModelControl` for the new-chat page).
    private func wiredModel(model: String? = nil, effort: String? = nil,
                            catalogue: SyncConfigSnapshot? = nil,
                            modelInFlight: Bool = false, effortInFlight: Bool = false,
                            onOpen: @escaping () -> Void = {},
                            onSetModel: @escaping (String?) -> Void = { _ in },
                            onSetEffort: @escaping (String?) -> Void = { _ in }) -> ComposerModelControl {
        ComposerModelControl(model: model, effort: effort, catalogue: catalogue ?? self.catalogue(),
                             modelChangeInFlight: modelInFlight, effortChangeInFlight: effortInFlight,
                             onOpen: onOpen, onSetModel: onSetModel, onSetEffort: onSetEffort)
    }

    /// A directory-backed sidebar wiring, so a live card can be driven against a REAL `session.list`
    /// row (which is where the header's menus read the session's model/effort from).
    private func wiring(_ rows: [SessionSummary], current: String) async -> SidebarWiring {
        let directory = SessionDirectory(lister: { rows })
        await directory.refresh()
        return SidebarWiring(directory: directory, currentSessionId: { current },
                             onSelect: { _ in }, onOpenDetached: { _ in }, onNewSession: {})
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
    private func liveView(_ adapter: FieldStateAdapter, mode: SessionMode?,
                          sidebars: SidebarWiring? = nil) -> WindowContentView<EmptyView> {
        WindowContentView(adapter: adapter, tint: .blue, topInset: 8, sidebars: sidebars,
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
        XCTAssertEqual(strip?.height, newChatComposerStripHeight)
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
                                         policy: nil, model: wiredModel())
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
                                     policy: wiredPolicy("bypass"), model: wiredModel(),
                                     stripEdge: .above)
        XCTAssertNil(card.chrome.makeStrip())
    }

    /// …and a live code session's card, through the same door, reaches code's chrome — so Task 6's
    /// row actually appears.
    func testALiveCodeSessionsCardReachesCodesChrome() {
        let card = NormaComposerCard(text: .constant("hi"), onSubmit: {},
                                     mode: .constant(.code), modeIsSelectable: false,
                                     policy: wiredPolicy("ask"), model: wiredModel(),
                                     stripEdge: .above)
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

    // MARK: - mac-chat-parity Task 7: the model/effort chip (spec §5)

    /// **The one thing about model/effort that is per-mode is exactly one row: `ultra`.**
    ///
    /// `CLIENT_EFFORTS` is a ONE-element list (`packages/core/src/settings.ts:51`) and
    /// `clientEffortEligible` is a fail-closed code-only allowlist (`settings.ts:89-91`). The WIRE
    /// efforts (`none/low/medium/high/xhigh/max`) are not mode-scoped at all — they are validated
    /// against the MODEL (`assertEffortSelectable`, `packages/core/src/ipc/server.ts:476-489`). So
    /// the third `ComposerChrome` member is a BOOLEAN, not a per-mode effort list.
    func testOnlyCodeOffersTheNormaLevelEffortTiers() {
        XCTAssertTrue(chrome(.code).offersClientEffortTiers)
        XCTAssertFalse(chrome(.chat).offersClientEffortTiers,
                       "a tier on chat is a row whose every tap is an INVALID_PARAMS")
        XCTAssertFalse(chrome(.dispatch).offersClientEffortTiers)
        XCTAssertFalse(chrome(.cowork).offersClientEffortTiers)
    }

    /// …and each mode's answer IS the decision the header's menus have used since
    /// provider-correctness T6 (`effortTiersAreOffered`, the Swift mirror of `clientEffortEligible`)
    /// rather than a second copy of the rule that could drift from it. The composer is a second door
    /// onto one machine, which is what spec §5 asked for.
    func testTheChromesTierAnswerIsTheHeadersOwnDecisionFunction() {
        for mode in SessionMode.allCases {
            XCTAssertEqual(chrome(mode).offersClientEffortTiers,
                           effortTiersAreOffered(mode: mode.rawValue),
                           "\(mode)'s composer must answer the tier question the way the header does")
        }
    }

    /// **The WIRING of that answer**, through the card's real initialiser. Both pins above stay green
    /// on a card that asked the catalogue directly (or hardcoded `true`) while shipping an `ultra` row
    /// on chat — the Task 4/Task 6 lesson, twice observed on this plan.
    func testTheCardsChipOffersTiersOnlyOnTheModeThatMaySelectThem() {
        for mode in SessionMode.allCases {
            let card = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(mode),
                                         policy: nil, model: wiredModel(model: "srv-a"))
            XCTAssertEqual(card.modelRow.tiers, mode == .code ? ["ultra"] : [],
                           "\(mode)'s chip offered tiers \(card.modelRow.tiers)")
        }
    }

    /// Everything ELSE the chip offers is mode-independent and comes from the catalogue — including
    /// **dispatch**, whose sets the daemon pins (`DISPATCH_PIN_MESSAGE`, `ipc/server.ts`). The header
    /// has always SHOWN dispatch both menus and let the daemon refuse; spec §3's table says keep that
    /// posture, so this pins shown-but-refused rather than quietly regressing it to absent.
    func testEveryModeIncludingDispatchStillOffersTheCataloguesModelsAndWireEfforts() {
        for mode in SessionMode.allCases {
            let card = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(mode),
                                         policy: nil, model: wiredModel(model: "srv-b"))
            XCTAssertEqual(card.modelRow.options, ["srv-a", "srv-b"], "\(mode) must still offer the models")
            XCTAssertEqual(card.modelRow.wire, ["high", "max"],
                           "\(mode) must still offer the WIRE efforts — they are model-scoped, never mode-scoped")
        }
    }

    /// The wire list follows the MODEL IN FORCE, which pre-session means the HELD model and not the
    /// session row that does not exist yet: a pair built against the daemon's default while the user
    /// has pinned something else is a legal-looking pair the create then throws INVALID_PARAMS on.
    /// Absent a pick, `effortPickerOptions`' own fallback to the catalogue's default model applies.
    func testTheChipsWireEffortsFollowTheModelInForce() {
        let held = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(.chat),
                                     policy: nil, model: wiredModel(model: "srv-b"))
        XCTAssertEqual(held.modelRow.wire, ["high", "max"], "the HELD model's levels, not the default's")

        let unpicked = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(.chat),
                                         policy: nil, model: wiredModel(model: nil))
        XCTAssertEqual(unpicked.modelRow.wire, ["none", "low", "high"],
                       "no pick ⇒ the daemon's live default model decides the levels")
    }

    /// What the chip SAYS. It names the model in force, keeps today's "Default model" text while
    /// nothing is pinned (the string this slot has rendered since it was a placeholder), and names
    /// the effort beside it once one is chosen — a control that shows neither would leave a picked
    /// effort invisible everywhere on the page.
    func testTheChipNamesTheModelInForceAndTheEffortBesideIt() {
        let unset = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(.chat),
                                      policy: nil, model: wiredModel()).modelRow
        XCTAssertEqual(unset.chipTitle, newChatModelPlaceholder)
        XCTAssertEqual(unset.chipTitle, "Default model", "…which is the text this slot already rendered")

        let picked = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(.chat),
                                       policy: nil, model: wiredModel(model: "srv-b", effort: "high")).modelRow
        XCTAssertEqual(picked.chipTitle, "srv-b · high")
        XCTAssertTrue(picked.help.contains("srv-b"))
        XCTAssertTrue(picked.help.contains("high"))
    }

    /// One change at a time, and VISIBLY — the same discipline the permissions row keeps, read off
    /// the two independent flags the header's two menus already disable themselves on (model and
    /// effort are separate affordances; a model change in flight must never disable the effort rows).
    func testAModelOrEffortChangeInFlightIsVisibleOnTheChip() {
        let modelBusy = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(.code),
                                          policy: nil, model: wiredModel(modelInFlight: true)).modelRow
        XCTAssertTrue(modelBusy.modelChangeInFlight)
        XCTAssertFalse(modelBusy.effortChangeInFlight, "…and only that half")

        let effortBusy = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(.code),
                                           policy: nil, model: wiredModel(effortInFlight: true)).modelRow
        XCTAssertTrue(effortBusy.effortChangeInFlight)
        XCTAssertFalse(effortBusy.modelChangeInFlight)
    }

    // MARK: - Task 7's WIRING: the two surfaces that build a card

    /// **The live half, end to end through the real view** (Task 6's own pin, one task on): a card
    /// built with no model wiring — or with a default/empty control — leaves every value pin above
    /// green while the chip on screen offers nothing and sets nothing.
    func testTheLiveCardsChipCarriesTheAdaptersOwnModelWiring() throws {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.modelCatalogue = catalogue()
        adapter.modelChangeInFlight = true
        var refreshes = 0
        adapter.onRefreshModelCatalogue = { refreshes += 1 }
        var setModels: [String?] = []
        adapter.onSetModel = { setModels.append($0) }
        var setEfforts: [String?] = []
        adapter.onSetEffort = { setEfforts.append($0) }

        let card = try XCTUnwrap(liveView(adapter, mode: .code).composerCard)
        XCTAssertEqual(card.modelRow.options, ["srv-a", "srv-b"], "the ADAPTER's catalogue reaches the chip")
        XCTAssertTrue(card.modelRow.modelChangeInFlight, "…and so does its in-flight flag")

        card.model.onOpen()
        XCTAssertEqual(refreshes, 1,
                       "opening the chip refreshes the catalogue, exactly as the header's buttons do")
        card.model.onSetModel("srv-b")
        XCTAssertEqual(setModels, ["srv-b"], "the chip's pick rides the adapter's own setModel wiring")
        XCTAssertEqual(adapter.pendingModel, .value("srv-b"),
                       "…with the same optimistic overlay the header's rows apply")
        card.model.onSetEffort("max")
        XCTAssertEqual(setEfforts, ["max"])
        XCTAssertEqual(adapter.pendingEffort, .value("max"))
    }

    /// The live chip shows what the DAEMON reports for this session — `session.list`'s own row, the
    /// same source the header's menus read (`currentSidebarSessionSummary`), so the two doors can
    /// never disagree about what is currently in force.
    func testTheLiveCardsChipShowsTheSessionRowsModelAndEffort() async throws {
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.modelCatalogue = catalogue()
        let sidebars = await wiring([
            SessionSummary(sessionId: "s_1", title: nil, createdAt: 1, scope: "global",
                           model: "srv-b", effort: "high"),
        ], current: "s_1")
        let card = try XCTUnwrap(liveView(adapter, mode: .code, sidebars: sidebars).composerCard)
        XCTAssertEqual(card.modelRow.model, "srv-b")
        XCTAssertEqual(card.modelRow.effort, "high")

        // …and the optimistic overlay wins over the row until the daemon's answer catches up, which
        // is `effectiveSelection`'s rule and the reason the chip must not read the row alone.
        adapter.pendingModel = .value("srv-a")
        let after = try XCTUnwrap(liveView(adapter, mode: .code, sidebars: sidebars).composerCard)
        XCTAssertEqual(after.modelRow.model, "srv-a")
    }

    /// **The pre-session half (spec §5, the user's ruling: hold and stamp at create).** The new-chat
    /// page has no session and therefore no adapter — its chip runs on the HOST's held choice, and
    /// picking through it writes there rather than firing an RPC at a session that does not exist.
    func testTheNewChatPagesChipHoldsTheChoiceOnTheHostRatherThanASession() {
        let host = newChatHost()
        let page = NewChatPage(nav: ShellNavigationModel(destination: .newChat), host: host)

        page.composerCard.model.onSetModel("srv-b")
        page.composerCard.model.onSetEffort("high")
        XCTAssertEqual(host.newChatModel, "srv-b", "the pick is HELD on the host, beside the draft")
        XCTAssertEqual(host.newChatEffort, "high")
        XCTAssertEqual(page.composerCard.modelRow.model, "srv-b", "…and the chip shows what is held")
        XCTAssertEqual(page.composerCard.modelRow.effort, "high")
        XCTAssertEqual(page.composerCard.model.catalogue, host.newChatCatalogue,
                       "the page's chip reads the host's catalogue, not an adapter that does not exist")
    }

    /// The page's own modes never offer a tier — which is what makes "held `ultra` breaks the create"
    /// structurally impossible rather than merely unlikely: `session.create` validates the effort with
    /// the SAME `assertEffortSelectable` a set uses, every new-chat create passes `mode: "chat"`, and
    /// a refused create takes the whole first send with it.
    func testNeitherModeTheNewChatPageOffersCanHoldATier() {
        for mode in newChatModeOptions {
            let card = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(mode),
                                         policy: nil, model: wiredModel(model: "srv-a"))
            XCTAssertEqual(card.modelRow.tiers, [],
                           "\(mode) is one of the new-chat page's two modes — a tier held there fails the create")
        }
    }

    /// A host with no client, for the pure pre-session pins above.
    private func newChatHost() -> ShellSessionHost {
        ShellSessionHost(directory: SessionDirectory(lister: { [] }), makeFeed: { sessionId in
            let session = SessionModel()
            let feed = SessionFeed(makeTransport: { ShellScriptedTransport() }, token: "tok",
                                   clientName: "orb", mode: .pinned(sessionId: sessionId), session: session)
            return (feed, session)
        })
    }

    // MARK: - The shared parts stay shared (source scans, with stated limits)

    /// **Task 5's review rider.** "Task 6 cannot give chat a row without editing `ChatComposerChrome`"
    /// is true only of the chrome path: a row added *unconditionally in the shared shell* would reach
    /// chat with every value-level pin still green (they assert `makeStrip() == nil`, which stays
    /// true). So the strip type may be constructed in exactly one file — the one where a mode's
    /// chrome is decided.
    ///
    /// **Limits, all real and all narrow.** It reads text, so three things evade it, none present
    /// today: a shell that composed the row's *content view* directly without naming `ComposerStrip`
    /// (which is why the value-level chat pins exist too); `let s: ComposerStrip = .init(…)`, whose
    /// implicit-member form contains no `ComposerStrip(` substring at all; and — in the safe
    /// direction — `codeOnly` strips only whole-line `//`, so a trailing or `/* */` comment naming
    /// the type would false-POSITIVE rather than hide a construction.
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

    /// mac-chat-parity Task 7's counterpart to the strip scan, in the opposite direction. The strip
    /// is per-mode and may be built ONLY where chrome is decided; the model/effort chip is SHARED and
    /// may be built only in the shared shell. A chrome that constructed its own would be four chips
    /// drifting apart — the exact thing the 2026-08-07 extraction exists to prevent — and every value
    /// pin above would stay green, since they all read the card's own row.
    ///
    /// **Same stated limits as the strip scan:** it reads text, so a chip composed by some other view
    /// without naming the type evades it, and `codeOnly` strips only whole-line `//`.
    func testTheChipIsConstructedOnlyInTheSharedShell() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        XCTAssertGreaterThan(files.count, 20, "the sweep must actually have walked the sources")
        var built: Set<String> = []
        for file in files where codeOnly(try String(contentsOf: file, encoding: .utf8)).contains("ComposerModelChip(") {
            built.insert(file.lastPathComponent)
        }
        // A Set, not an array: `FileManager.enumerator`'s order is unspecified, so an array
        // comparison would be a sort-order coin toss the moment a second file ever matched.
        XCTAssertEqual(built, ["NormaComposerCard.swift"],
                       "the model/effort chip is the SHARED shell's — one construction, one file")
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
