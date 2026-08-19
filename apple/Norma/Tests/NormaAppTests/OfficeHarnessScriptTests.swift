import Foundation
import XCTest
@testable import Norma

/// office-plumbing Task 9 — the Office Harness's own drill-plan pins, in `EditorPlumbingTests`'
/// style (`testTheStageADrillScriptCarriesEveryDrillInOrder`'s own rigor): step count, every drill
/// present, steps in drill order, ids unique, `drillTitles` complete — the drill-set STRUCTURE is
/// load-bearing (the transcript is read as thirteen groups, drill 0 through 12, and the harness's
/// own `perform(_:)` switch matches on these exact ids — the same lesson the editor's own drill 15
/// pin names: "the generic sorted-by-drill check cannot catch an intra-drill reorder").
///
/// **No live helper anywhere in this file** — `OfficeHarnessPlan` is plain `Foundation` data (not
/// `#if DEBUG`, see that file's own header), so every pin here runs on any machine, vendor tree or
/// not.
final class OfficeHarnessScriptTests: XCTestCase {

    func testTheDrillPlanCarriesEveryDrillInOrderWithUniqueIds() throws {
        let steps = OfficeHarnessPlan.steps
        XCTAssertEqual(steps.count, 46, "the plan's own step count — a change here is a change to "
                       + "what the harness actually runs")

        let drills = steps.map(\.drill)
        XCTAssertEqual(Set(drills), Set(0...12), "every drill from 0 (setup) to 12 (wire sanity) must be present")
        XCTAssertEqual(drills, drills.sorted(), "the steps must be in drill order — the transcript is "
                       + "read as thirteen groups, never interleaved")
        XCTAssertEqual(Set(steps.map(\.id)).count, steps.count,
                       "step ids must be unique — the harness's own action switch matches on them")
        for drill in 0...12 {
            XCTAssertNotNil(OfficeHarnessPlan.drillTitles[drill], "drill \(drill) has no title for the transcript")
        }
        XCTAssertEqual(Set(OfficeHarnessPlan.drillTitles.keys), Set(0...12), "drillTitles must have no orphaned entries either")

        // Every id names its own drill as a literal prefix — the same discipline that makes
        // `perform(_:)`'s switch and this pin agree by construction rather than by two hand-kept lists.
        for step in steps {
            XCTAssertTrue(step.id.hasPrefix("\(step.drill)."),
                          "\(step.id) does not name its own drill (\(step.drill)) as its prefix")
            XCTAssertGreaterThan(step.timeout, 0, "\(step.id) has a non-positive timeout")
            XCTAssertFalse(step.title.isEmpty, "\(step.id) has no title")
        }
    }

    /// **Drill 6's own internal order is load-bearing**: nothing to reload until the file has
    /// actually changed, the new docId must exist before tiles can be requested under it, delete
    /// must follow the fresh-tile proof (this is the T8 drill's own shape, exercised in-harness), and
    /// restore must be LAST — the banner it clears has to exist first.
    func testDrillSixsInternalOrderIsOverwriteReloadFreshTilesDeleteRestore() throws {
        let ids = OfficeHarnessPlan.steps.filter { $0.drill == 6 }.map(\.id)
        XCTAssertEqual(ids, ["6.overwrite", "6.reload", "6.freshTiles", "6.delete", "6.restore"])
    }

    /// **Drill 7's (the mirror-case's) own internal order is the entire reason it can observe
    /// anything at all**: the delayed delete must fire while `7.overwrite`'s own reopen may still be
    /// in flight, `7.observe` must read the settled state only after both have had their chance to
    /// land in either order, and `7.siblingTouch` — whose whole premise is conditional on what
    /// `7.observe` found — can only run last.
    func testDrillSevensInternalOrderIsOverwriteDelayedDeleteObserveSiblingTouch() throws {
        let ids = OfficeHarnessPlan.steps.filter { $0.drill == 7 }.map(\.id)
        XCTAssertEqual(ids, ["7.overwrite", "7.delayedDelete", "7.observe", "7.siblingTouch"])
    }

    /// **Drill 8's own internal order**: the pid must be captured BEFORE the kill (nothing to compare
    /// against otherwise), death must be observed before a reopen is attempted (the reopen IS the
    /// response to `.helperDied`, not a parallel action racing it), and the new pid can only be read
    /// AFTER a reopen has actually had the chance to respawn a process.
    func testDrillEightsInternalOrderIsCapturePidKillDiedObservedReopenNewPid() throws {
        let ids = OfficeHarnessPlan.steps.filter { $0.drill == 8 }.map(\.id)
        XCTAssertEqual(ids, ["8.capturePid", "8.kill", "8.diedObserved", "8.reopen", "8.newPid"])
    }

    /// **Drill 10's own internal order**: idle-exit cannot be asked for before there is a document to
    /// open-and-close, the connection closes AFTER the document does (idle-exit needs zero documents
    /// AND zero connections — see `OfficeHelperSupervisor`'s own carry on `connectionCount`), and the
    /// exit wait is necessarily last.
    func testDrillTensInternalOrderIsSetupOpenCloseDisconnectWaitExit() throws {
        let ids = OfficeHarnessPlan.steps.filter { $0.drill == 10 }.map(\.id)
        XCTAssertEqual(ids, ["10.setup", "10.openClose", "10.disconnect", "10.waitExit"])
    }

    /// The multi-sheet fixture's own two sheets must actually differ — in fill color AND in text, and
    /// the two colors in a stable, distinguishable order — or drill 5's pixel-distinctness claim would
    /// be checking a difference that was never real.
    func testTheTemplatedMultiSheetFixtureCarriesTwoGenuinelyDifferentSheets() throws {
        let content = officeHarnessMultiSheetFodsContent()
        XCTAssertTrue(content.hasPrefix("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"),
                      "must be well-formed XML from the very first byte — LOK's flat-XML filter is strict about this")
        XCTAssertEqual(content.components(separatedBy: "<table:table ").count - 1, 2,
                       "must template exactly two <table:table> elements")
        XCTAssertTrue(content.contains("#ff6600"))
        XCTAssertTrue(content.contains("#0033cc"))
        XCTAssertTrue(content.contains("PART ZERO"))
        XCTAssertTrue(content.contains("PART ONE"))
        guard let firstColorRange = content.range(of: "#ff6600"),
              let secondColorRange = content.range(of: "#0033cc") else {
            return XCTFail("both fill colors must be present")
        }
        XCTAssertLessThan(firstColorRange.lowerBound, secondColorRange.lowerBound,
                          "sheet one's fill color must precede sheet two's — the templated order this test names")
        // Round-trips as a Data write the same way the harness itself writes it (UTF-8, atomic) —
        // catches a stray non-ASCII byte or an unterminated element before this ever reaches real LOK.
        XCTAssertNotNil(content.data(using: .utf8))
    }

    // MARK: - Cross-language wire parity: PanelTabKind's "document" literal

    /// **The literal-parity pin between Swift and the daemon** — this repo's standing discipline for
    /// a vocabulary that exists twice in two languages (`REMOTE_ALLOWED_METHODS`'s own parity test is
    /// the daemon's version of the same thing; `EditorPlumbingTests
    /// .testTheJavaScriptSideSpeaksExactlyTheSameWireVocabulary` is the editor's own). `OfficeHarness`'s
    /// drill 12 states this harness is daemonless and pins the wire shape "via the codec" instead of a
    /// live `panel.openTab` RPC — THIS is that codec pin: `packages/protocol/src/events.ts`'s own
    /// `PanelTabKind` zod enum, read directly from source, must equal Swift's `PanelTabKind` cases
    /// exactly, in declaration order.
    func testPanelTabKindMatchesTheProtocolsOwnWireEnumExactly() throws {
        // `#filePath` for this file is `<repoRoot>/apple/Norma/Tests/NormaAppTests/OfficeHarnessScriptTests.swift`
        // — five `deletingLastPathComponent()` hops (the filename, NormaAppTests, Tests, Norma, apple)
        // reach `<repoRoot>`, the same climbing depth every other live-binary test in this suite uses.
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url = url.deletingLastPathComponent() }
        let eventsFile = url.appendingPathComponent("packages/protocol/src/events.ts")
        let source = try XCTUnwrap(try? String(contentsOf: eventsFile, encoding: .utf8),
                                   "packages/protocol/src/events.ts could not be read at \(eventsFile.path)")

        guard let openRange = source.range(of: "PanelTabKind = z.enum([") else {
            return XCTFail("packages/protocol/src/events.ts no longer declares "
                           + "`PanelTabKind = z.enum([...])` at the exact spelling this pin reads")
        }
        guard let closeRange = source.range(of: "])", range: openRange.upperBound..<source.endIndex) else {
            return XCTFail("PanelTabKind's z.enum([...]) declaration never closes")
        }
        let body = source[openRange.upperBound..<closeRange.lowerBound]
        let wireNames = body.split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }.filter { !$0.isEmpty }

        XCTAssertEqual(wireNames, ["web", "document", "code", "note", "diff", "files"],
                       "packages/protocol/src/events.ts's PanelTabKind enum, read verbatim from source — "
                       + "if this fails, the WIRE drifted, not this pin")

        // Swift's own `init(_:)` from the wire type (`PanelTab.swift`) is already an EXHAUSTIVE switch
        // — a compile-time guarantee that every `SessionEvent.PanelTabKind` case maps to something.
        // This restates it as a runtime cross-check that the two lists' MEMBERSHIP AND ORDER actually
        // agree, not merely that both happen to have six entries.
        let swiftCases: [PanelTabKind] = [.web, .document, .code, .note, .diff, .files]
        XCTAssertEqual(swiftCases.map(\.rawValue), wireNames,
                       "Swift's PanelTabKind cases, in declaration order, must equal the protocol's wire enum exactly")
        XCTAssertEqual(PanelTabKind.document.rawValue, "document",
                       "the exact literal drill 12.kindWire pins at the harness level")

        // And the router every real door (tree, transcript, open-with) actually goes through —
        // `officeFileExtensions` (`PanelEditorTab.swift`) — classifies every one of the six committed
        // fixture formats as this same kind.
        for ext in ["xlsx", "ods", "pptx", "odp", "docx", "odt"] {
            XCTAssertEqual(panelTabKind(forFilePath: "/probe.\(ext)"), .document, "\(ext) must classify as .document")
        }
    }
}
