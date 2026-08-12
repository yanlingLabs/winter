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
/// **What it does NOT cover, and cannot:** rendered pixels. Nothing here proves the strip's band is
/// visible, that the mode segment lands on the right column, or that chat's composer *looks* like a
/// composer with a row removed. Those are the user's live gate. This codebase's convention is that
/// SwiftUI bodies are not exercised in tests (see `DashboardTests`' own file doc); the two
/// source-scan tests at the end are the honest, stated-limits substitute for the one claim that has
/// no value-level form — that the shared parts are written ONCE, outside any mode branch.
@MainActor
final class ComposerChromeTests: XCTestCase {
    /// Every chrome is built from a context; the tests build the same one the card does.
    private func chrome(_ mode: SessionMode, announcement: String = "") -> any ComposerChrome {
        composerChrome(ComposerContext(mode: .constant(mode),
                                       modeIsSelectable: true,
                                       announcement: announcement))
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

    /// Code and dispatch have the slot and it is empty **today**: this task adds no features, and
    /// the permissions row is Task 6. Recorded as an assertion rather than a comment so that Task 6
    /// updating it is a deliberate edit with the chat pin sitting immediately above it.
    func testCodeAndDispatchHaveAnEmptyStripSlotForTaskSix() {
        XCTAssertNil(chrome(.code).makeStrip(), "Task 6 fills this; Task 5 adds no features")
        XCTAssertNil(chrome(.dispatch).makeStrip(), "Task 6 fills this; Task 5 adds no features")
    }

    /// Nobody ships a permissions row yet. Task 6 DELETES this test when it builds one — the pin
    /// directly above it (chat has no strip at all) is the one that must survive.
    func testNoModeShipsAPermissionsRowYet() {
        for mode in SessionMode.allCases {
            XCTAssertNotEqual(chrome(mode).makeStrip()?.kind, .permissions,
                              "\(mode) claims a permissions row — Task 5 builds no features")
        }
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
            let card = NormaComposerCard(text: .constant(""), onSubmit: {}, mode: .constant(mode))
            XCTAssertEqual(card.chrome.mode, mode,
                           "the card rendered \(card.chrome.mode)'s composer for a \(mode) session")
        }
    }

    /// The ruling, through the door the shell actually uses: a live chat session's card
    /// (`WindowContentView.swift:190` passes `mode: .constant(cardMode)`,
    /// `modeIsSelectable: false`) carries no band.
    func testALiveChatSessionsCardCarriesNoBand() {
        let card = NormaComposerCard(text: .constant("hi"), onSubmit: {},
                                     mode: .constant(.chat), modeIsSelectable: false,
                                     stripEdge: .above)
        XCTAssertNil(card.chrome.makeStrip())
    }

    /// …and a live code session's card, through the same door, reaches code's chrome — so Task 6's
    /// row will actually appear when it fills the slot.
    func testALiveCodeSessionsCardReachesCodesChrome() {
        let card = NormaComposerCard(text: .constant("hi"), onSubmit: {},
                                     mode: .constant(.code), modeIsSelectable: false,
                                     stripEdge: .above)
        XCTAssertEqual(String(describing: type(of: card.chrome)), "CodeComposerChrome")
    }

    // MARK: - The shared parts stay shared (source scans, with stated limits)

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
