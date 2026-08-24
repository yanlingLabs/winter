import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// The socket path was too long for `sockaddr_un.sun_path` (104 bytes on macOS, including the NUL
/// terminator — so 103 usable bytes), or a POSIX call failed. Both are reported with the raw
/// `errno` string rather than a generic message: this runs unattended, spawned by the supervisor,
/// with its stderr the only place a bind/listen failure is ever going to surface.
public enum OfficeHelperServerError: Error, CustomStringConvertible {
    case posix(String)
    public var description: String {
        switch self {
        case .posix(let message): return message
        }
    }
}

/// Task 3 — what `OfficeHelperServer` needs from something that can load/unload documents.
/// `LOKBridge` (the real implementation, `NormaOfficeHelper` only) and `FakeOfficeDocumentBridge`
/// (below, used by `NormaOfficeHelperFixture`'s spy binary) both conform — `OfficeHelperServer`
/// itself never touches a LOK symbol, matching Task 2's own design: `NormaOfficeHelperFixture`
/// links this file UNCHANGED and must keep building without the bridging header / LOK C symbols
/// `LOKBridge.swift` needs (see project.yml: that one file is excluded from the fixture target).
public protocol OfficeDocumentBridge: AnyObject {
    /// A short, honest self-description for `helloOk.lokVersion` — the real LOK `BuildId` for
    /// `LOKBridge`, `officeWireStageALOKVersionPlaceholder` for the fake. Read once, before the
    /// first `hello` ever answers.
    var lokVersionString: String { get }

    /// Loads `path` under `docId`. Throws (never traps/crashes the process) on any failure — a
    /// garbage document, an unreadable path, or any other `documentLoad`-shaped failure.
    /// `OfficeHelperServer` translates a thrown error into `openFailed` and keeps serving —
    /// the helper surviving a bad document is the whole point of this being a thrown Swift error,
    /// not a fatal one.
    func open(docId: String, path: String) throws -> OfficeDocumentMetadata

    /// Destroys `docId`'s handle, if any is tracked. A no-op (not an error) for an untracked
    /// `docId` — matches `close`'s wire-level idempotence (`OfficeHelperServer` itself is the
    /// source of truth for "is this docId open"; a bridge is never asked to close something it
    /// never opened in a well-behaved server, but must not crash if it happens).
    func close(docId: String)

    /// Fires for every asynchronous, unprompted event a still-open document produces (real LOK
    /// callbacks for `LOKBridge`; never for the fake, which has nothing to push). Set ONCE, by
    /// `OfficeHelperServer` at construction, before any document ever opens.
    var onEvent: ((String, OfficeDocumentEvent) -> Void)? { get set }

    /// Task 4 — paints (or returns an already-cached copy of) one tile. Called from a CONNECTION
    /// thread (never from inside a LOK callback) — `LOKBridge`'s implementation marshals onto its
    /// dedicated thread via `thread.sync`, same as `open`/`close`. Throws on any failure (an
    /// unopened `docId`, an out-of-range part, a real LOK paint failure) — the helper always
    /// survives, exactly like a failed `open`; `OfficeHelperServer` translates this into a
    /// `tileFailed` push for the one key that failed, never tearing down the connection or the
    /// document.
    func paintTile(docId: String, key: TileKey) throws -> TilePaintResult

    /// Task 4 — applies an already-parsed invalidation (rects/part, the SAME payload
    /// `OfficeDocumentEvent.invalidated` carries) to `docId`'s tile cache: bumps every affected
    /// cached key's generation and evicts its stale pixels (`TileCache.invalidate`). Returns the
    /// keys actually bumped, for `OfficeHelperServer` to multicast as an `.invalidated` push.
    ///
    /// **Threading contract, the opposite of every other method on this protocol**: called ONLY
    /// from `OfficeHelperServer.routeDocumentEvent`, itself reached SYNCHRONOUSLY from inside
    /// `onEvent`'s own callback — which, for `LOKBridge`, fires while ALREADY running on the LOK
    /// dedicated thread (see `lokBridgeDocumentCallback`'s own guarantee). `LOKBridge`'s
    /// implementation MUST NOT call `thread.sync` here — doing so would be the exact reentrant-
    /// `sync`-from-a-job-already-running-on-`thread` deadlock `LOKDedicatedThread`'s own header
    /// warns against. An empty-`generations` doc (never painted) or an unopened `docId` simply
    /// returns `[]` — never throws (there is no request here whose failure needs reporting; an
    /// invalidation for a document nobody has ever asked to paint has nothing to bump).
    func applyTileInvalidation(docId: String, rectsTwips: [OfficeTwipsRect], part: Int) -> [TileKey]

    /// Office Stage B Task 2 — renders `docId`'s current state to a fresh file UNDER THIS HELPER'S
    /// OWN `--state-path` (never the real document path — the write fence only ever allows
    /// `--state-path`; see `OfficeWireFrame.saved`'s own header for the app-places-it split this
    /// exists to serve), in the document's own format. `seq` is the wire request's own seq, reused
    /// as the destination filename's disambiguator. Called from a CONNECTION thread, never from
    /// inside a LOK callback — `LOKBridge`'s implementation marshals onto its dedicated thread, same
    /// as `open`/`close`/`paintTile`. Throws on any failure (an unopened `docId`, an unsupported
    /// format, a genuine `saveAs` failure) — the helper always survives, exactly like a failed
    /// `open`; `OfficeHelperServer` translates this into a `saveFailed` reply.
    ///
    /// **Fix round 4 (NEW-2) — `part` added**: the part the USER is on, which the real
    /// (`LOKBridge`) conformance asserts onto LOK immediately before writing, so ordinary paint
    /// traffic cannot decide which part the saved view state records. See `OfficeWireFrame.save`'s
    /// own header for why a save needs this even though painting already carries a part of its own.
    func saveAs(docId: String, seq: UInt64, part: Int) throws -> String

    /// Office Stage B Task 7 — the autosave sidecar write: renders `docId`'s CURRENT (possibly
    /// still-dirty) state to `<state-path>/autosave/<docId>.<ext>`, called on
    /// `OfficeAutosaveScheduler`'s own timer queue rather than from a connection thread or a LOK
    /// callback — `LOKBridge`'s implementation marshals onto its dedicated thread, same as
    /// `saveAs`/`open`/`close`/`paintTile`. Returns the extension actually written (native for an
    /// already-ODF document, the ODF sibling for an OOXML one) and whether that is a fallback away
    /// from the document's own real format — `OfficeHelperServer` needs both to push
    /// `.autosaved(ext:isODFFallback:)`. Throws on any failure exactly like `saveAs` — the helper
    /// always survives; there is no reply frame here to fail, so a throw here just means "try again
    /// next interval," logged, not surfaced to the app at all.
    ///
    /// **Deliberately NOT `saveAs` with a flag** — the real (`LOKBridge`) conformance never
    /// dispatches the `.uno:Save` follow-up `saveAs` itself relies on to clear `ModifiedStatus` (see
    /// that conformance's own header for why an autosave that cleared the dirty flag would cancel
    /// its own timer after one fire). `FakeOfficeDocumentBridge`'s conformance is a no-op stub past
    /// the existence check, same reasoning as its `saveAs` stub: wire-level dispatch is what the
    /// fixture-backed tests exercise, never real content or real format selection.
    ///
    /// **No `part` parameter, unlike `saveAs`** — an autosave fire has no wire request to have
    /// carried one at all (see `LOKBridge.OpenDocument.lastKnownPart`'s own header for how the real
    /// conformance answers "which part" without one).
    ///
    /// **Fix round 1 (review I-1) — `isStillArmed` and the `Optional` return.** A bare `saveAs`
    /// (this method's whole point) never clears `ModifiedStatus`, so the ONLY way this document's
    /// own scheduler timer ever disarms is a REAL save's `.uno:Save` follow-up round-tripping
    /// `.modifiedChanged(false)` back through the wire — a later event than that same real save's
    /// own `placeAtomically`/`.clearAutosave` on the app side. A fire that started (the timer
    /// callback ran, `performAutosaveFire` began) before that round-trip lands, but whose call into
    /// this method doesn't actually reach the dedicated thread until after it does, would otherwise
    /// write a sidecar with a newer mtime than the just-saved real file — a spurious "Recovered
    /// unsaved changes" banner on the next open (no data lost, but one click from restaging an
    /// unsaveable tab on an already-OOXML-broken document). `isStillArmed` is called ON the
    /// dedicated thread, as the very first action, by both conformances below — re-checking at
    /// EXECUTION time, not at the moment `performAutosaveFire` was invoked, is what actually closes
    /// this window (a check made before marshaling onto a possibly-busy dedicated thread would not:
    /// arbitrary time can still pass between that check and this method's own real work). Returns
    /// `nil` — not a throw — when the re-check fails: this is not a failure, there is nothing wrong,
    /// there is simply nothing left to do. `OfficeHelperServer.performAutosaveFire` logs the
    /// distinction and does not push `.autosaved` for a `nil` result.
    func saveAsSidecar(docId: String, isStillArmed: @escaping () -> Bool) throws -> (ext: String, isODFFallback: Bool)?

    /// Office Stage B Task 4 — LOK's `postKeyEvent`, unchanged parameter shape. Throws only on a
    /// `docId` this bridge has no handle for — `postKeyEvent` itself is `void` on LOK's own side
    /// (fire-and-forget, no synchronous success/failure to report — the same posture the now-
    /// removed DEBUG-only `debugEdit` door had, replaced by this real verb). `FakeOfficeDocumentBridge`'s
    /// conformance is a no-op past the existence check — same reasoning as its `saveAs` stub:
    /// wire-level dispatch is what the fixture-backed tests exercise, never real content.
    ///
    /// **Fix round 1, F2 — `part` added.** The real (`LOKBridge`) conformance turns this into a
    /// `setPart` call immediately before `postKeyEvent`, on the SAME dedicated-thread job — see
    /// that conformance's own header for why LOK's C API forces this (no part-scoped input call
    /// exists, unlike `paintPartTile`).
    func postKey(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws
    /// Office Stage B Task 4 — LOK's `postMouseEvent`, same posture as `postKey` above.
    func postMouse(docId: String, part: Int, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                   count: Int, buttons: Int, modifiers: Int) throws

    /// Office Stage B Task 5 — LOK's `postWindowExtTextInputEvent`, the IME marked-text/commit door.
    /// Same fire-and-forget, throws-only-on-unopened-docId posture as `postKey`/`postMouse` above.
    /// `FakeOfficeDocumentBridge`'s conformance is an existence-checked no-op, identical reasoning
    /// to its `postKey`/`postMouse` stubs: wire-level dispatch is what the fixture-backed tests
    /// exercise, never real composition. See `OfficeWireFrame.extTextInputEvent`'s own header for
    /// what `type`/`text` mean, and `LOKBridge.postExtTextInputOnDedicatedThread`'s own header for
    /// the real conformance's `setView`/`setPart` prefix.
    func postExtTextInput(docId: String, part: Int, type: OfficeExtTextInputType, text: String) throws

    // MARK: - Office Stage B Task 6: clipboard, undo/redo, the second ("agent") view

    /// Reads the current text selection — `""` for LOK's own `nullptr` "no selection" answer,
    /// never a distinct case. Throws only on a `docId` this bridge has no handle for, matching
    /// `postKey`/`postMouse`'s own posture.
    func clipboardCopy(docId: String, part: Int) throws -> String
    /// Same read as `clipboardCopy`, but ALSO deletes the selection (`.uno:Cut`) — the text
    /// returned is what was selected just BEFORE the cut.
    func clipboardCut(docId: String, part: Int) throws -> String
    /// Writes `text` at the current caret via LOK's own `paste()`. Throws on a `docId` this bridge
    /// has no handle for, OR when `paste()` itself reports failure (`SaveError.pasteFailed`) — the
    /// one clipboard door LOK gives a real synchronous success/failure answer for.
    func clipboardPaste(docId: String, part: Int, text: String) throws
    /// `.uno:Undo` against the document's own primary view. Fire-and-forget on LOK's own side —
    /// throws only on a `docId` this bridge has no handle for.
    func undo(docId: String) throws
    /// `.uno:Redo`, same posture as `undo` above.
    func redo(docId: String) throws
    /// Mints a second ("agent") LOK view for `docId`, returning its view id — `createView()`'s own
    /// return value, never re-derived. Throws `SaveError.agentViewAlreadyExists` if this docId
    /// already has one (a deliberate refusal, not a silent "return the existing id").
    func createAgentView(docId: String) throws -> Int32
    /// Posts a key event through the agent view specifically. Throws `SaveError.noAgentView` if
    /// `createAgentView` was never called for this docId.
    func agentKeyEvent(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws

    // MARK: - office-agent-tools T3: sheets info/read

    /// Sheet names, each one's used range, and the active sheet's name. Read-only. Throws only on a
    /// `docId` this bridge has no handle for, or one that is not a spreadsheet — both composed
    /// entirely from this bridge's own words (never LOK-thrown text), matching `saveAsFailed`'s own
    /// posture where the reason genuinely does come from LOK versus the ones that don't.
    func sheetsInfo(docId: String) throws -> (sheets: [OfficeSheetInfo], activeSheet: String)
    /// A value or formula grid over one already-validated, already-formatted A1 `range` on ONE named
    /// sheet — see `OfficeWireFrame.sheetsRead`'s own header for why `range` arrives pre-formatted
    /// rather than as column/row integers. `sheet` is resolved to a part index HERE. Throws
    /// `SaveError.sheetNotFound` (carrying the real sheet list) for an unknown name, or the same
    /// existence/kind errors `sheetsInfo` throws.
    func sheetsRead(docId: String, sheet: String, range: String, formulas: Bool) throws -> [[String]]

    // MARK: - office-agent-tools T4: sheets write verbs

    /// Writes `cellValues[i]` into `cellAddresses[i]` for every `i`, in order, on `sheet` — real
    /// synthetic text entry, not a paste (`LOKBridge.sheetsSetOnDedicatedThread`'s own header has the
    /// full mechanism and why). `range` is used only for this bridge's own post-write verification
    /// read (defense in depth — see that function's own header), never re-validated against
    /// `cellAddresses`' own shape (the caller already did that). Returns the number of cells written
    /// (`cellAddresses.count`, echoed back rather than silently trusted). Throws the same
    /// existence/kind errors `sheetsRead` throws, plus `SaveError.sheetNotFound`, plus a write-
    /// specific verification failure if the post-write read does not confirm the intended content
    /// landed.
    func sheetsSet(docId: String, sheet: String, range: String, cellAddresses: [String], cellValues: [String]) throws -> Int
    /// Inserts or deletes `count` whole rows/columns starting at `selectionRange`'s own row/column
    /// span (a pre-formatted "R1:R2" or "C1:C2" string — see `OfficeWireFrame.sheetsResize`'s own
    /// header for why the app, not this bridge, computes it). Returns the sheet's own used-range
    /// dimensions AFTER the operation (the same shape `sheetsInfo` reports per sheet). Throws the
    /// same existence/kind errors `sheetsRead` throws, plus `SaveError.sheetNotFound`.
    func sheetsResize(docId: String, sheet: String, dimension: OfficeSheetsResizeDimension,
                      op: OfficeSheetsResizeOp, selectionRange: String) throws -> (usedEndColumn: Int, usedEndRow: Int)
    /// Adds/deletes/renames a sheet. `name` is the NEW sheet's name for `.add`, the EXISTING sheet's
    /// name for `.delete`/`.rename`; `newName` is `.rename`-only. Returns the workbook's full
    /// sheet-name list AFTER the operation, in part order. Throws `SaveError.sheetNotFound` for
    /// `.delete`/`.rename` naming a sheet that does not exist, `SaveError.lastSheet` for a `.delete`
    /// that would leave the workbook with zero sheets, and `SaveError.duplicateSheetName` for an
    /// `.add`/`.rename` whose target name already exists — all three checked BEFORE dispatching any
    /// UNO command (see `LOKBridge.sheetsManageSheetOnDedicatedThread`'s own header for why: Calc's
    /// own slot handlers silently no-op or silently rename-with-a-suffix rather than erroring these
    /// cases, so this bridge would otherwise have no honest signal to report).
    func sheetsManageSheet(docId: String, op: OfficeSheetsManageSheetOp, name: String, newName: String?) throws -> [String]

    /// office-agent-tools T5 — applies `bold`/`italic`/`numberFormat`/`align`/`width` over `range` on
    /// `sheet`, every one optional (`nil` means untouched — see `OfficeWireFrame.sheetsFormat`'s own
    /// header for the full contract). `columnSpan` is `width`'s own separate column-span selection,
    /// non-nil only when `width` itself is. Returns which attribute names were actually applied, a
    /// subset of `["bold","italic","numberFormat","align","width"]` in that order. Throws the same
    /// existence/kind errors `sheetsRead` throws, plus `SaveError.sheetNotFound`.
    func sheetsFormat(docId: String, sheet: String, range: String, columnSpan: String?,
                      bold: Bool?, italic: Bool?, numberFormat: OfficeSheetsNumberFormatPreset?,
                      align: OfficeSheetsAlign?, width: Double?) throws -> [String]

    // MARK: - office-agent-tools T6: slides

    /// Every slide's own PART NAME and, when determinable, its layout name — see `OfficeWireFrame
    /// .slidesInfo`/`OfficeSlideInfo`'s own headers for why this is not a placeholder-text read and
    /// why `layout` is genuinely `nil`-able. Throws only on a `docId` this bridge has no handle for,
    /// or one that is not a presentation.
    func slidesInfo(docId: String) throws -> [OfficeSlideInfo]
    /// ONE slide's title/body placeholder text — `nil` per field when that slide has no such
    /// placeholder at all, `""` when it exists and is empty (see `OfficeWireFrame.slidesReadOk`'s own
    /// header for why the distinction is load-bearing). `slide` is 0-based. Throws the same
    /// existence/kind errors `slidesInfo` throws, plus a slide-index-out-of-range error.
    func slidesRead(docId: String, slide: Int) throws -> (title: String?, body: String?)
    /// Writes `title` and/or `body` onto ONE slide's own placeholder(s), each independently optional
    /// (`nil` means untouched). Returns which of `["title","body"]` actually applied. Throws the same
    /// existence/kind errors `slidesRead` throws, plus a refusal naming which placeholder is missing
    /// when the caller named an attribute this slide has no placeholder for (spec's own "refuses
    /// naming the reason, rather than inventing one" contract).
    func slidesSetText(docId: String, slide: Int, title: String?, body: String?) throws -> [String]
    /// Adds/deletes/reorders a slide (`op`) — `slide`/`at`/`to` are all 0-based, exactly matching
    /// `OfficeWireFrame.slidesManagePage`'s own paired-field contract (that case's own header states
    /// which fields apply to which op; this bridge trusts the wire's own decode guard rather than
    /// re-validating the pairing a second time — the identical "a business rule already enforced
    /// upstream" posture `sheetsManageSheet`'s own conformance already has for ITS op enum). Returns
    /// the presentation's slide count AFTER the operation. Throws `SaveError.lastSlide` for a
    /// `.delete` that would leave zero slides, plus the same existence/kind errors `slidesInfo`
    /// throws.
    func slidesManagePage(docId: String, op: OfficeSlidesManagePageOp, slide: Int?, at: Int?, to: Int?,
                          layout: OfficeSlidesLayoutPreset?) throws -> Int
}

/// The result of a successful `OfficeDocumentBridge.paintTile` call — helper-internal (never
/// crosses the wire directly; `OfficeHelperServer` reads these fields to build a `tile` wire
/// frame). Lives here, not `OfficeWire.swift`, because nothing outside `Sources/OfficeHelper`
/// needs it: the app-side `OfficeHelperClient` decodes the wire frame's own primitive fields
/// directly, never this struct.
public struct TilePaintResult: Equatable, Sendable {
    public let generation: Int
    public let pixels: Data
    public let width: Int
    public let height: Int
    public init(generation: Int, pixels: Data, width: Int, height: Int) {
        self.generation = generation
        self.pixels = pixels
        self.width = width
        self.height = height
    }
}

/// `NormaOfficeHelperFixture`'s bridge — behaves exactly like Task 2's own Stage-A bookkeeping
/// (every `open` "succeeds" with placeholder metadata nobody asserts on; `close` no-ops; nothing is
/// ever pushed). `OfficeSupervisorTests` never calls `open`/`close` at all (its scenarios are
/// handshake/death-detection, not document-shaped) — this exists so the fixture's `main.swift`
/// has SOMETHING to construct `OfficeHelperServer` with, honestly reporting "no real LOK here"
/// via `officeWireStageALOKVersionPlaceholder` for `helloOk.lokVersion`.
/// Task 4 additions: synthetic (never-real-LOK) tile support, so the WIRE-LEVEL tile plumbing
/// (subscribe/request/multicast/invalidate/F7-ownership) is testable fast, over a real socket,
/// without booting real LOK — only pixel CORRECTNESS needs the vendor-gated live tests against
/// `LOKBridge`. Guarded by one `NSLock`: unlike the real bridge (single-threaded by the dedicated-
/// thread discipline), this fake can be reached concurrently from a connection thread
/// (`paintTile`, via `tileRequest`) and from a test's own synthetic-invalidation trigger
/// (`simulateInvalidation`, wired through `OfficeHelperServer.Hooks` — see that type's own header)
/// running on yet another thread.
public final class FakeOfficeDocumentBridge: OfficeDocumentBridge {
    public let lokVersionString = officeWireStageALOKVersionPlaceholder
    public var onEvent: ((String, OfficeDocumentEvent) -> Void)?
    private let lock = NSLock()
    private var caches: [String: TileCache] = [:]
    /// Office Stage B Task 2 — where this fake's own `saveAs` writes its placeholder output.
    /// Defaults to a throwaway temp directory so every pre-Task-2 caller of the parameterless
    /// `init()` (none exist outside this file today, but the default keeps the signature additive)
    /// keeps working; `Tests/OfficeHelperFixtureSources/main.swift` passes the fixture's own real
    /// `--state-path` so its `saves/` subdirectory lands in the SAME place the real helper's would.
    private let statePath: URL

    public init(statePath: URL = FileManager.default.temporaryDirectory) {
        self.statePath = statePath
    }
    public func open(docId: String, path: String) throws -> OfficeDocumentMetadata {
        lock.lock(); caches[docId] = TileCache(capacity: 32); lock.unlock()
        return OfficeDocumentMetadata(type: .other, parts: 1, sizeTwips: OfficeDocumentSize(widthTwips: 0, heightTwips: 0))
    }
    public func close(docId: String) {
        lock.lock(); caches.removeValue(forKey: docId); lock.unlock()
    }

    /// Office Stage B Task 2 — a real (if content-free) `saveAs`: proves the WIRE-LEVEL dispatch
    /// (docId-not-open, seq-in-filename, `saved`/`saveFailed`) end to end, over a real socket,
    /// without needing a LOK boot — only pixel/content CORRECTNESS needs the vendor-gated live
    /// tests against `LOKBridge`, the same split `paintTile` already established for tiles.
    public func saveAs(docId: String, seq: UInt64, part: Int) throws -> String {
        lock.lock()
        let isOpen = caches[docId] != nil
        lock.unlock()
        guard isOpen else {
            throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)")
        }
        let savesDirectory = statePath.appendingPathComponent("saves", isDirectory: true)
        try FileManager.default.createDirectory(at: savesDirectory, withIntermediateDirectories: true)
        let destination = savesDirectory.appendingPathComponent("\(docId)-\(seq).fake")
        try Data("fake saveAs output for \(docId)".utf8).write(to: destination)
        return destination.path
    }

    /// Office Stage B Task 7 — same "real wire dispatch, fake content" split as `saveAs` above:
    /// proves `OfficeHelperServer`'s own scheduler-fires-bridge-pushes-event plumbing end to end,
    /// over a real socket, without any real LOK format/ODF-fallback logic to fake convincingly —
    /// that correctness is `LOKBridge`'s own live-tested job (`OfficeRuntimeLiveTests`' crash
    /// drill). Always reports `ext: "fake", isODFFallback: false` — nothing here needs to vary it.
    ///
    /// **Fix round 1 (review I-1) — `isStillArmed` checked FIRST, mirroring `LOKBridge`'s own
    /// conformance exactly** (see that method's own header, and the protocol requirement's, for the
    /// race this closes). This fake has no real dedicated thread to queue behind, so it cannot
    /// reproduce the RACE itself — that is `OfficeAutosaveSchedulerTests
    /// .testIsArmedReflectsADisarmThatHappensAfterAClosureCapturingItWasBuiltButBeforeThatClosureIsCalled`'s
    /// own job, the one piece of this fix reachable in-process at all (`FakeOfficeDocumentBridge` is
    /// exercised only through a spawned subprocess — see `project.yml`'s `NormaAppTests`
    /// `excludes:` comment). What this conformance DOES guarantee: any caller that hands it an
    /// already-false `isStillArmed` gets `nil` back and no file written, keeping this fake an
    /// honest stand-in for the real contract.
    public func saveAsSidecar(docId: String, isStillArmed: @escaping () -> Bool) throws -> (ext: String, isODFFallback: Bool)? {
        guard isStillArmed() else { return nil }
        lock.lock()
        let isOpen = caches[docId] != nil
        lock.unlock()
        guard isOpen else {
            throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)")
        }
        let autosaveDirectory = statePath.appendingPathComponent("autosave", isDirectory: true)
        try FileManager.default.createDirectory(at: autosaveDirectory, withIntermediateDirectories: true)
        let destination = autosaveDirectory.appendingPathComponent("\(docId).fake")
        try Data("fake autosave sidecar for \(docId)".utf8).write(to: destination)
        return (ext: "fake", isODFFallback: false)
    }

    /// Office Stage B Task 4 — existence-checked no-op, same reasoning as `saveAs` above: this fake
    /// has no real LOK document to post an event to, only wire-level dispatch (docId-not-open, the
    /// `keyEventOk` reply shape) is exercised against it.
    public func postKey(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws {
        lock.lock()
        let isOpen = caches[docId] != nil
        lock.unlock()
        guard isOpen else {
            throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)")
        }
    }
    public func postMouse(docId: String, part: Int, type: OfficeMouseEventType, xTwips: Int64, yTwips: Int64,
                          count: Int, buttons: Int, modifiers: Int) throws {
        lock.lock()
        let isOpen = caches[docId] != nil
        lock.unlock()
        guard isOpen else {
            throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)")
        }
    }
    public func postExtTextInput(docId: String, part: Int, type: OfficeExtTextInputType, text: String) throws {
        lock.lock()
        let isOpen = caches[docId] != nil
        lock.unlock()
        guard isOpen else {
            throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)")
        }
    }

    /// Office Stage B Task 6 — existence-checked no-ops, same reasoning as `postKey`/`postMouse`
    /// above: this fake has no real LOK document, only wire-level dispatch is exercised against
    /// it. `clipboardCopy`/`clipboardCut` answer a fixed, deterministic (never real-selection)
    /// string — enough for a wire-level round-trip test to assert on, never content correctness
    /// (that is `LOKBridge`'s own live-tested job, the same split every other verb here already
    /// has).
    private var agentViewIds: [String: Int32] = [:]

    public func clipboardCopy(docId: String, part: Int) throws -> String {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        return "fake selection for \(docId)"
    }
    public func clipboardCut(docId: String, part: Int) throws -> String {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        return "fake selection for \(docId)"
    }
    public func clipboardPaste(docId: String, part: Int, text: String) throws {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
    }
    public func undo(docId: String) throws {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
    }
    public func redo(docId: String) throws {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
    }
    public func createAgentView(docId: String) throws -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard caches[docId] != nil else {
            throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)")
        }
        guard agentViewIds[docId] == nil else {
            throw OfficeHelperServerError.posix("fake bridge: docId already has an agent view: \(docId)")
        }
        let viewId = Int32(agentViewIds.count + 1000) // arbitrary, distinct from a real primary view's id
        agentViewIds[docId] = viewId
        return viewId
    }
    public func agentKeyEvent(docId: String, part: Int, type: OfficeKeyEventType, charCode: Int, keyCode: Int) throws {
        lock.lock()
        let hasAgentView = agentViewIds[docId] != nil
        lock.unlock()
        guard hasAgentView else {
            throw OfficeHelperServerError.posix("fake bridge: docId has no agent view: \(docId)")
        }
    }

    /// office-agent-tools T3 — wire-level dispatch is what the fixture-backed tests exercise here,
    /// never real sheet content (same reasoning as every other stub above): one synthetic sheet named
    /// "Sheet1", reporting a fixed, non-empty used range so a wire-level test can assert on a REAL
    /// (if fake) value rather than the wholly-empty sentinel by accident.
    public func sheetsInfo(docId: String) throws -> (sheets: [OfficeSheetInfo], activeSheet: String) {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        return ([OfficeSheetInfo(name: "Sheet1", usedEndColumn: 2, usedEndRow: 9)], "Sheet1")
    }
    /// office-agent-tools T3 — same existence-only posture as `sheetsInfo` above. Refuses any sheet
    /// name other than "Sheet1" (mirroring the ONE sheet `sheetsInfo` reports) so a wire-level test
    /// can exercise the `sheetNotFound` refusal path without real LOK. A deterministic, small grid —
    /// never real content — with `formulas` folded into the one cell that differs, so a wire-level
    /// test CAN tell the two request shapes apart without needing real LOK to compute anything.
    public func sheetsRead(docId: String, sheet: String, range: String, formulas: Bool) throws -> [[String]] {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        guard sheet == "Sheet1" else {
            throw OfficeHelperServerError.posix("fake bridge: no sheet named \"\(sheet)\" in \(docId) — this workbook has: Sheet1")
        }
        return [["fake", formulas ? "=FAKE()" : "42"]]
    }

    /// office-agent-tools T4 — wire-level dispatch only, same reasoning as every other fake stub
    /// above: existence/sheet-name checked (real CONTENT correctness is `LOKBridge`'s own live-tested
    /// job), returns `cellAddresses.count` as a deterministic, real (if fake) answer.
    private var fakeSheetNames: [String] = ["Sheet1"]

    public func sheetsSet(docId: String, sheet: String, range: String, cellAddresses: [String], cellValues: [String]) throws -> Int {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        guard sheet == "Sheet1" else {
            throw OfficeHelperServerError.posix("fake bridge: no sheet named \"\(sheet)\" in \(docId) — this workbook has: Sheet1")
        }
        return cellAddresses.count
    }
    public func sheetsResize(docId: String, sheet: String, dimension: OfficeSheetsResizeDimension,
                             op: OfficeSheetsResizeOp, selectionRange: String) throws -> (usedEndColumn: Int, usedEndRow: Int) {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        guard sheet == "Sheet1" else {
            throw OfficeHelperServerError.posix("fake bridge: no sheet named \"\(sheet)\" in \(docId) — this workbook has: Sheet1")
        }
        return (usedEndColumn: 2, usedEndRow: 9)
    }
    public func sheetsManageSheet(docId: String, op: OfficeSheetsManageSheetOp, name: String, newName: String?) throws -> [String] {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        switch op {
        case .add:
            guard !fakeSheetNames.contains(name) else {
                throw OfficeHelperServerError.posix("fake bridge: a sheet named \"\(name)\" already exists in \(docId)")
            }
            fakeSheetNames.append(name)
        case .delete:
            guard fakeSheetNames.contains(name) else {
                throw OfficeHelperServerError.posix("fake bridge: no sheet named \"\(name)\" in \(docId)")
            }
            guard fakeSheetNames.count > 1 else {
                throw OfficeHelperServerError.posix("fake bridge: cannot delete the only sheet in \(docId)")
            }
            fakeSheetNames.removeAll { $0 == name }
        case .rename:
            guard let index = fakeSheetNames.firstIndex(of: name) else {
                throw OfficeHelperServerError.posix("fake bridge: no sheet named \"\(name)\" in \(docId)")
            }
            guard let newName, !fakeSheetNames.contains(newName) else {
                throw OfficeHelperServerError.posix("fake bridge: a sheet named \"\(newName ?? "")\" already exists in \(docId)")
            }
            fakeSheetNames[index] = newName
        }
        return fakeSheetNames
    }

    /// office-agent-tools T5 — wire-level dispatch only, same reasoning as every other fake stub
    /// above: existence/sheet-name checked (real UNO-command correctness is `LOKBridge`'s own
    /// live-tested job), returns the attribute names actually named — a deterministic, real (if fake)
    /// echo of the caller's own request, in the fixed order `sheetsFormatOk`'s own header promises.
    public func sheetsFormat(docId: String, sheet: String, range: String, columnSpan: String?,
                             bold: Bool?, italic: Bool?, numberFormat: OfficeSheetsNumberFormatPreset?,
                             align: OfficeSheetsAlign?, width: Double?) throws -> [String] {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        guard sheet == "Sheet1" else {
            throw OfficeHelperServerError.posix("fake bridge: no sheet named \"\(sheet)\" in \(docId) — this workbook has: Sheet1")
        }
        var applied: [String] = []
        if bold != nil { applied.append("bold") }
        if italic != nil { applied.append("italic") }
        if numberFormat != nil { applied.append("numberFormat") }
        if align != nil { applied.append("align") }
        if width != nil { applied.append("width") }
        return applied
    }

    /// office-agent-tools T6 — wire-level dispatch only, same reasoning as every sheets stub above:
    /// two synthetic slides ("Slide1"/"Slide2"), the first reporting a fixed non-nil layout, the
    /// second `nil` (so a wire-level test can assert on BOTH shapes of the layout field without real
    /// LOK). `fakeSlideCount`/`fakeSlideText` back `slidesRead`/`slidesSetText`/`slidesManagePage`
    /// with real (if fake) per-slide state, deterministic and mutable across calls in one test.
    private var fakeSlideCount = 2
    private var fakeSlideTitles: [Int: String] = [:]
    private var fakeSlideBodies: [Int: String] = [:]

    public func slidesInfo(docId: String) throws -> [OfficeSlideInfo] {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        return (0..<fakeSlideCount).map { OfficeSlideInfo(name: "Slide\($0 + 1)", layout: $0 == 0 ? "title_content" : nil) }
    }
    public func slidesRead(docId: String, slide: Int) throws -> (title: String?, body: String?) {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        guard slide >= 0, slide < fakeSlideCount else {
            throw OfficeHelperServerError.posix("fake bridge: no slide \(slide) in \(docId) — this presentation has \(fakeSlideCount) slides")
        }
        return (title: fakeSlideTitles[slide] ?? "fake title \(slide)", body: fakeSlideBodies[slide])
    }
    public func slidesSetText(docId: String, slide: Int, title: String?, body: String?) throws -> [String] {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        guard slide >= 0, slide < fakeSlideCount else {
            throw OfficeHelperServerError.posix("fake bridge: no slide \(slide) in \(docId) — this presentation has \(fakeSlideCount) slides")
        }
        var applied: [String] = []
        if let title { fakeSlideTitles[slide] = title; applied.append("title") }
        if let body { fakeSlideBodies[slide] = body; applied.append("body") }
        return applied
    }
    public func slidesManagePage(docId: String, op: OfficeSlidesManagePageOp, slide: Int?, at: Int?, to: Int?,
                                 layout: OfficeSlidesLayoutPreset?) throws -> Int {
        lock.lock(); let isOpen = caches[docId] != nil; lock.unlock()
        guard isOpen else { throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)") }
        switch op {
        case .add:
            fakeSlideCount += 1
        case .delete:
            guard fakeSlideCount > 1 else {
                throw OfficeHelperServerError.posix("fake bridge: cannot delete the only slide in \(docId)")
            }
            guard let slide, slide >= 0, slide < fakeSlideCount else {
                throw OfficeHelperServerError.posix("fake bridge: no slide \(slide ?? -1) in \(docId) — this presentation has \(fakeSlideCount) slides")
            }
            fakeSlideCount -= 1
            fakeSlideTitles.removeValue(forKey: slide)
            fakeSlideBodies.removeValue(forKey: slide)
        case .reorder:
            guard let slide, slide >= 0, slide < fakeSlideCount, let to, to >= 0, to < fakeSlideCount else {
                throw OfficeHelperServerError.posix("fake bridge: reorder out of range in \(docId)")
            }
        }
        return fakeSlideCount
    }

    /// A small, deterministic, key-dependent pixel pattern (never blank, never identical across
    /// distinct keys) — enough for a wire-level test to tell two tiles apart without needing real
    /// rendering. Wire-level tests assert on IDENTITY (which key, which generation), never on real
    /// pixel CONTENT — but the SIZE is no longer free to pick arbitrarily (Task 5.5 review carry):
    /// `OfficeWireConnection.ingest`'s exact-size-or-refuse contract closes the connection on any
    /// `.tile` push whose `byteCount` isn't exactly `TileMath.bytesPerTile` (every tile this system
    /// produces today IS that size — see that check's own doc comment), and this fake bridge's
    /// pushes cross the SAME real wire `OfficeSupervisorTests`' multicast test drives end to end.
    /// A pre-Task-5.5 4x4/16-byte fake tile would therefore get its own connection refused the
    /// instant it tried to push one — sized to the real constant instead, even though nothing here
    /// renders real content.
    public func paintTile(docId: String, key: TileKey) throws -> TilePaintResult {
        lock.lock()
        defer { lock.unlock() }
        guard caches[docId] != nil else {
            throw OfficeHelperServerError.posix("fake bridge: docId not open: \(docId)")
        }
        let tag = UInt8(truncatingIfNeeded: key.tileX &* 31 &+ key.tileY &* 7 &+ key.part)
        let pixels = Data(repeating: tag, count: TileMath.bytesPerTile)
        let generation = caches[docId]!.recordPaint(key: key, pixels: pixels)
        return TilePaintResult(generation: generation, pixels: pixels,
                                width: TileMath.tilePixelSize, height: TileMath.tilePixelSize)
    }

    public func applyTileInvalidation(docId: String, rectsTwips: [OfficeTwipsRect], part: Int) -> [TileKey] {
        lock.lock()
        defer { lock.unlock() }
        guard caches[docId] != nil else { return [] }
        return caches[docId]!.invalidate(rectsTwips: rectsTwips, part: part)
    }

    /// Test-only trigger: fires `onEvent` with a raw `.invalidated` event exactly the shape a real
    /// LOK callback would produce, for a doc this fake has open. Never called by production code —
    /// only by `Tests/OfficeHelperFixtureSources/main.swift`'s synthetic modes, wired through
    /// `OfficeHelperServer.Hooks.afterTileRequestAccepted` (see that field's own header for why
    /// THAT is the trigger this repo picked over a timer or a new wire verb).
    public func simulateInvalidation(docId: String, rectsTwips: [OfficeTwipsRect] = [], part: Int = 0) {
        onEvent?(docId, .invalidated(rectsTwips: rectsTwips, part: part))
    }
}

/// Office Stage A Task 2 — the helper's Unix-socket listener plus per-connection protocol
/// handler. Runs identically whether started from `NormaOfficeHelper`'s real `main.swift` or the
/// out-of-process test fixture's (`Tests/OfficeHelperFixtureSources/main.swift`): the fixture
/// exists to drive THIS code's failure paths for real, over a real socket, not to reimplement
/// them — so `OfficeSupervisorTests` proves something about the actual protocol handler, not
/// about a second, hand-rolled stand-in that could drift from it.
///
/// LibreOfficeKit is NOT loaded here — Task 3's job. `open`/`close` are pure bookkeeping against
/// `documents`, which feeds the idle-exit accounting below and nothing else yet.
///
/// **Raw POSIX sockets, not `NWListener`.** The app-side client already has a natural fit in
/// NormaKit's `UnixSocketTransport` (`NWConnection` over `.unix(path:)`, precedented by the
/// daemon connection); the LISTENER side has no equivalent in-repo precedent, and Network.framework's
/// local-endpoint-bind API for a Unix-domain listener is far less travelled than its connect-side
/// API. `socket`/`bind`/`listen`/`accept` is the boring, well-understood way to own the passive
/// side of an AF_UNIX SOCK_STREAM socket, and this helper only ever expects a handful of
/// concurrent connections (the app; later, the daemon) — no need for anything more elaborate than
/// one thread per accepted connection, each doing blocking reads.
public final class OfficeHelperServer {

    /// Test-only behavior injection — see `Tests/OfficeHelperFixtureSources/main.swift`. Every
    /// field defaults to "behave exactly like production," so `NormaOfficeHelper`'s real
    /// `main.swift` never has to construct anything but `Hooks()`.
    public struct Hooks: Sendable {
        /// When true, every connection still reads and decodes frames — so `documents`/connection
        /// bookkeeping and idle-exit accounting stay real — but never WRITES a reply. Simulates a
        /// helper that accepted a connection and then hung, for the supervisor's
        /// handshake-timeout retry path.
        public var suppressReplies: Bool
        /// Called synchronously, on the connection's own thread, immediately after a `helloOk`
        /// reply is written to the socket. The fixture's "die after hello" mode sets this to
        /// `_exit(0)` — simulates a crash immediately after a successful handshake, for the
        /// supervisor's death-detection path.
        public var afterHelloOkWritten: (@Sendable () -> Void)?
        /// Task 4 test seam: called synchronously, on the connection's own thread, immediately
        /// after a `tileRequestAccepted` reply is written — with the `docId` that was requested.
        /// `Tests/OfficeHelperFixtureSources/main.swift`'s multicast-test mode wires this to
        /// `FakeOfficeDocumentBridge.simulateInvalidation`, so a test can provoke a deterministic,
        /// synthetic tile invalidation without depending on whether real LOK ever fires a live
        /// callback for a view-only document (see task-4-report.md's debt-1 finding) and without a
        /// timer-based race or a new, test-only wire verb — `tileRequest` already needs to exist,
        /// including its own explicitly-tested "empty keys list" shape (`OfficeWireCodecTests`),
        /// which doubles as this trigger's payload-free ping.
        public var afterTileRequestAccepted: (@Sendable (String) -> Void)?

        public init(suppressReplies: Bool = false, afterHelloOkWritten: (@Sendable () -> Void)? = nil,
                    afterTileRequestAccepted: (@Sendable (String) -> Void)? = nil) {
            self.suppressReplies = suppressReplies
            self.afterHelloOkWritten = afterHelloOkWritten
            self.afterTileRequestAccepted = afterTileRequestAccepted
        }
    }

    /// Task 3 — one per accepted connection: the raw fd plus a write lock BOTH the reply path
    /// (`writeReply`, called from this connection's own thread) and the async push path (LOK
    /// callbacks, arriving on `LOKBridge`'s dedicated thread — see `OfficeHelperServer`'s own
    /// header below) must hold before writing, so the two streams can never interleave bytes on
    /// the wire. `ownedDocIds` (guarded by `stateQueue`, not `writeLock` — a different concern)
    /// is this connection's own subset of `docOwner`'s keys, so connection teardown can close
    /// exactly the documents IT opened without scanning the whole table.
    private final class ConnectionWriter {
        let fd: Int32
        let writeLock = NSLock()
        var ownedDocIds: Set<String> = []
        /// F8 (Task 4 review carry): PER-CONNECTION, not per-server — was previously a single
        /// `OfficeHelperServer`-wide `pushSeqAllocator` shared by every connection's pushes, which
        /// contradicted this exact field's own doc comment on `OfficeWireFrame.documentEvent`
        /// ("a dedicated per-connection `OfficeWireSeqAllocator`"). Multicast (Task 4) makes the
        /// mismatch concrete: fanning the SAME invalidation out to two subscriber connections from
        /// one shared allocator would burn two seq values for what is, from either connection's
        /// OWN point of view, a single push — leaving gaps in that connection's stream for no
        /// reason. One allocator per connection keeps each connection's own push-seq stream dense,
        /// matching how the client mints request seqs the same way.
        let pushSeqAllocator = OfficeWireSeqAllocator()
        init(fd: Int32) {
            self.fd = fd
        }
    }

    /// Task 4 — the multicast seam (dispatch note: "docOwner: [String: ConnectionWriter] ->
    /// [ConnectionWriter]"). `opener` is the ONE connection that called `open` for this `docId` —
    /// the sole connection allowed to `close` it (F7 below) — kept as a direct reference (not
    /// merely an id) so `routeDocumentEvent` can push the raw `OfficeDocumentEvent` stream to it
    /// without a lookup. `subscribers` is a SEPARATE, independently-growable list of connections
    /// that called `subscribeTiles` against this (already-open) doc — which may or may not include
    /// `opener` itself (opening a doc does not imply wanting its tile pushes; a connection that
    /// wants both calls `subscribeTiles` explicitly after its own `open`) — and is what
    /// `.invalidated` pushes multicast to. A doc with only ever one interested party (every Stage-A
    /// scenario except this task's own multicast test) simply has `subscribers.count <= 1`; the
    /// type does not special-case that, so it costs nothing when unused.
    private final class DocEntry {
        let opener: ConnectionWriter
        var subscribers: [ConnectionWriter] = []
        init(opener: ConnectionWriter) { self.opener = opener }
    }

    private let socketPath: String
    private let statePath: String
    private let expectedToken: String
    private let idleExitSeconds: Double
    private let hooks: Hooks
    private let documentBridge: OfficeDocumentBridge
    private let log: (String) -> Void

    private var listenFD: Int32 = -1

    /// Every mutable field below is touched ONLY from `stateQueue` (accessed via `.sync`, never
    /// `.async`, so idle-exit accounting is never stale by even one connection open/close when a
    /// test inspects timing) — connection threads call in, they never touch these directly.
    ///
    /// **Invariant: no code running under `stateQueue.sync` may call into `documentBridge`.**
    /// `documentBridge.open`/`.close` block on `LOKBridge`'s own dedicated thread, which can
    /// synchronously invoke `pushSeqAllocator`/`docOwner` lookups (via `onEvent`, wired in `init`
    /// below) from INSIDE that same blocked call — calling into the bridge while already holding
    /// `stateQueue` would risk exactly the kind of cross-lock ordering that turns into a deadlock
    /// the moment the two paths ever nest. Every call site below copies what it needs out of
    /// `stateQueue` first, then calls the bridge, then (if necessary) re-enters `stateQueue`
    /// separately for bookkeeping.
    private let stateQueue = DispatchQueue(label: "office-helper.state")
    /// docId -> its `DocEntry` (opener + tile subscribers). Doubles as Task 2's old `documents` set
    /// for idle-exit accounting (`docOwner.isEmpty`) — one table, not two that could drift apart.
    private var docOwner: [String: DocEntry] = [:]
    private var connectionCount = 0
    private var idleTimer: DispatchSourceTimer?
    private var nextConnectionId = 0
    /// Office Stage B Task 7 — owns the per-docId "autosave while dirty" timer; armed/disarmed by
    /// `routeDocumentEvent`'s own `.modifiedChanged` handling and by both close paths below. Never
    /// touched under `stateQueue` — its own internal state is independent of `docOwner`/connection
    /// bookkeeping, so there is no ordering hazard to reason about the way the `documentBridge`
    /// invariant above exists for.
    private let autosaveScheduler: OfficeAutosaveScheduler

    public init(socketPath: String, statePath: String, expectedToken: String,
                idleExitSeconds: Double = 120, hooks: Hooks = Hooks(),
                documentBridge: OfficeDocumentBridge,
                /// Office Stage B Task 7 — the brief's own 60s, overridable so the live crash drill
                /// does not spend a real minute per sample. Mirrors `main.swift`'s own
                /// `idle-exit-seconds` CLI-arg-override idiom exactly (never an environment
                /// variable) — see `OfficeHelperSupervisor.Configuration.autosaveIntervalSeconds`'s
                /// own header for the app-side half of that mirror. Production callers
                /// (`NormaOfficeHelper`'s real `main.swift`, absent an explicit override) never pass
                /// anything but the default.
                autosaveIntervalSeconds: TimeInterval = 60,
                log: @escaping (String) -> Void = { message in
                    FileHandle.standardError.write(Data((message + "\n").utf8))
                }) {
        self.socketPath = socketPath
        self.statePath = statePath
        self.expectedToken = expectedToken
        self.idleExitSeconds = idleExitSeconds
        self.hooks = hooks
        self.documentBridge = documentBridge
        self.log = log
        self.autosaveScheduler = OfficeAutosaveScheduler(interval: autosaveIntervalSeconds)
        documentBridge.onEvent = { [weak self] docId, event in
            self?.routeDocumentEvent(docId: docId, event: event)
        }
        // `onFire` needs `self` (to reach `documentBridge`/`routeDocumentEvent`/`log`) — assigned
        // here, as its OWN statement after every stored property (including `autosaveScheduler`
        // itself) already has a value, which is what makes capturing `[weak self]` legal at this
        // point — the identical reasoning `documentBridge.onEvent`'s own assignment one line up
        // already rests on.
        self.autosaveScheduler.onFire = { [weak self] docId in
            self?.performAutosaveFire(docId: docId)
        }
    }

    /// Office Stage B Task 7 — `autosaveScheduler`'s own fire callback: render the sidecar, then
    /// push `.autosaved` so the app can write its own manifest entry. Runs on WHATEVER queue
    /// `OfficeAutosaveScheduler.Scheduling` fires its timer on (production: `autosaveScheduler`'s
    /// own dedicated `office-helper.autosave` queue) — never `stateQueue`, so calling
    /// `documentBridge`/`routeDocumentEvent` here carries no reentrancy risk against the bridge-call
    /// invariant this file states at `docOwner`'s own header.
    ///
    /// **Throws never propagate anywhere — logged and dropped, exactly "the helper always
    /// survives."** There is no reply frame for an autosave to fail; a write that fails this
    /// interval gets another chance next interval for as long as the document stays dirty.
    ///
    /// **Fix round 1 (review I-1) — the `isStillArmed` closure this hands `saveAsSidecar`.** Built
    /// HERE, at fire time, but — critically — capturing `autosaveScheduler` by reference and calling
    /// `isArmed` only when the CONFORMANCE actually invokes it (on the dedicated thread, as that
    /// method's own header states) rather than being evaluated once right here and passed down as
    /// an already-decided `Bool`. That distinction is the entire fix: `OfficeAutosaveScheduler
    /// .isArmed`'s own header, and `OfficeAutosaveSchedulerTests
    /// .testIsArmedReflectsADisarmThatHappensAfterAClosureCapturingItWasBuiltButBeforeThatClosureIsCalled`,
    /// both spell out why a snapshot taken here would still lose the race the review describes.
    private func performAutosaveFire(docId: String) {
        do {
            guard let (ext, isODFFallback) = try documentBridge.saveAsSidecar(
                docId: docId, isStillArmed: { [autosaveScheduler] in autosaveScheduler.isArmed(docId: docId) }
            ) else {
                log("[OfficeHelperServer] autosave sidecar write skipped for \(docId): no longer "
                    + "armed by the time the dedicated-thread job ran — a real save already landed")
                return
            }
            routeDocumentEvent(docId: docId, event: .autosaved(ext: ext, isODFFallback: isODFFallback))
        } catch {
            log("[OfficeHelperServer] autosave sidecar write failed for \(docId): \(error) — retrying next interval")
        }
    }

    /// The async-push counterpart to `writeReply` — called from whatever thread `documentBridge`
    /// fires its callback on (LOKBridge's dedicated thread, for the real bridge; never, for the
    /// fake). Copies whatever `ConnectionWriter`(s) it needs out of `stateQueue` FIRST, then writes
    /// under only that writer's own lock — never while holding `stateQueue` (a blocking socket
    /// write inside `stateQueue.sync` would wedge idle-exit accounting behind a slow/stuck client
    /// for as long as the write takes). `pushFrame` below is the one place that actually locks+writes.
    ///
    /// Task 4: does TWO jobs now, in sequence. (1) The raw `OfficeDocumentEvent` still goes to the
    /// doc's OPENER only — Task 3's original, unchanged contract. (2) A REAL invalidation
    /// additionally translates into bumped tile keys (`documentBridge.applyTileInvalidation`) and
    /// multicasts a top-level `.invalidated` push to every TILE SUBSCRIBER — a separate list from
    /// "the opener" (see `DocEntry`'s own header). Calling the bridge here, unguarded by
    /// `stateQueue`, follows the same invariant every other bridge call site in this file already
    /// does; for the REAL bridge this call is additionally already running ON `LOKBridge`'s
    /// dedicated thread by construction (this whole function is reached synchronously from inside
    /// a LOK callback) — see `OfficeDocumentBridge.applyTileInvalidation`'s own header for why its
    /// implementation must never re-enter `thread.sync` here.
    private func routeDocumentEvent(docId: String, event: OfficeDocumentEvent) {
        // Office Stage B Task 7 — the autosave timer's own arm/disarm, driven by the SAME
        // `.modifiedChanged` firing that already feeds the app's dirty dot. Unconditional, ahead of
        // the `docOwner` guard below (the scheduler has no concept of "who owns this docId" and
        // never needs one — arming/disarming a timer for a docId nobody currently tracks is inert,
        // never a leak: `markDirty` only ever starts a timer, and every close path this file has
        // separately calls `autosaveScheduler.remove` regardless of whether this arm ever ran).
        if case .modifiedChanged(let modified) = event {
            if modified {
                autosaveScheduler.markDirty(docId: docId)
            } else {
                autosaveScheduler.markClean(docId: docId)
            }
        }
        guard let entry = stateQueue.sync(execute: { docOwner[docId] }) else { return }
        pushFrame(.documentEvent(seq: entry.opener.pushSeqAllocator.nextSeq(), docId: docId, event: event),
                  to: entry.opener)

        guard case .invalidated(let rects, let part) = event else { return }
        let bumpedKeys = documentBridge.applyTileInvalidation(docId: docId, rectsTwips: rects, part: part)
        guard !bumpedKeys.isEmpty else { return }
        let subscribers = stateQueue.sync { entry.subscribers }
        for subscriber in subscribers {
            pushFrame(.invalidated(seq: subscriber.pushSeqAllocator.nextSeq(), docId: docId, keys: bumpedKeys),
                      to: subscriber)
        }
    }

    /// Task 5.5 — writes one frame's full wire envelope: the NDJSON header line, then (for `.tile`
    /// ONLY — every other case's `tilePayload` is `nil`) its raw pixel bytes immediately after,
    /// with no framing between them beyond the header's own `byteCount` field. **Caller must
    /// already hold `writer.writeLock`** — this is the shared body `writeReply`/`pushFrame` call
    /// from inside their own lock hold, so header and payload can never be split by an interleaving
    /// write from the OTHER path (a reply racing a push, or two pushes) landing bytes between them.
    /// A future frame type that ever needs a similar two-part envelope gets it for free by growing
    /// `tilePayload`'s definition rather than by this function changing.
    private func writeFrameLocked(_ frame: OfficeWireFrame, writer: ConnectionWriter) {
        writeAll(frame.encodedLine(), fd: writer.fd)
        if let payload = frame.tilePayload {
            writeAll(payload, fd: writer.fd)
        }
    }

    /// The one place that locks a `ConnectionWriter`'s own write lock and writes a frame (header +
    /// optional payload, via `writeFrameLocked`) to its fd — every async-push call site
    /// (`routeDocumentEvent`, `tileRequest`'s per-key pushes, close-notification pushes to
    /// remaining subscribers) shares this instead of re-deriving the lock/write/unlock sequence
    /// each time.
    ///
    /// **KNOWN HAZARD, named but NOT fixed this round (fix round 1, I2 — bounded on purpose, a real
    /// redesign is deferred to a task scoped against T6's actual client behavior)**: `writeAll`
    /// (inside `writeFrameLocked`) is a BLOCKING socket write under `writer.writeLock`.
    /// `routeDocumentEvent` — this function's own biggest caller — runs on `LOKBridge`'s dedicated
    /// thread (synchronously, reached from inside a real LOK callback; see that function's own
    /// header). Task 4 made this reachable with real, large (up to ~1MiB raw, Task 5.5 deleted the
    /// ~1.4MB base64 inflation) payloads for the first time (`.tile` pushes). A CLIENT that is
    /// suspended, or reading slowly, mid-receive of one such push leaves this `write()` blocked
    /// indefinitely — which blocks `LOKBridge`'s ONE dedicated thread, which is the SOLE executor of
    /// every LOK call for every open document on every connection this helper serves
    /// (`LOKDedicatedThread`'s own single-thread rule). One stalled client can therefore wedge every
    /// open/close/paint for every OTHER connection too, not just its own. The real fix is either a
    /// non-blocking write or a bounded per-connection push queue (decouple "LOK produced this
    /// frame" from "the socket accepted these bytes") — deliberately NOT designed here; carried in
    /// the fix-round ledger (task-4-report.md) for a future round.
    ///
    /// **Office Stage B Task 4 — measured, and this is a DIFFERENT hazard from the one this task's
    /// own transport re-eval found.** This one needs a SLOW/STALLED CLIENT to manifest — a healthy,
    /// fast reader never blocks a socket write for long. Task 4's own measurement (a 6-tile
    /// cold-paint batch queued immediately ahead of one keystroke, both from a perfectly healthy,
    /// synchronous test client) found a real, ~212ms stall with NO slow client anywhere in the
    /// picture.
    ///
    /// **Fix round 1, F4 (IMPORTANT) — the CAUSE Task 4 originally wrote here was wrong; the
    /// numbers, the decision, and "visible-latency, never a freeze" were all correct, only the
    /// mechanism was misattributed.** The original text blamed "ordinary `LOKDedicatedThread` FIFO
    /// contention... regardless of which app-side queue sent it," implying the keyEvent's own
    /// `postKey` call was promptly SUBMITTED to the LOK thread and simply waited its turn behind 6
    /// already-queued paint jobs. That is not what happens in this measured scenario. **The real
    /// mechanism is READER-THREAD serialization**: `handleConnection`'s read loop
    /// (`OfficeHelperServer.swift`, the `while let newlineIndex = buffer.firstIndex(of: 0x0A)` loop)
    /// calls `handlePostAuthLine` INLINE, synchronously, on that one connection's own dedicated
    /// `Thread` (`acceptLoop`'s `connectionThread`) — never dispatched elsewhere. `.tileRequest`'s
    /// case then runs `for key in keys { documentBridge.paintTile(...) }` synchronously, IN THAT
    /// SAME CALL, each iteration itself blocking on `thread.sync` until that one tile's paint
    /// finishes on the LOK thread. So when a `keyEvent` line sits right behind a `tileRequest` line
    /// from the SAME connection (this task's own measured scenario — one synchronous test client
    /// sends both), the reader thread cannot even ATTEMPT to decode and dispatch that `keyEvent`
    /// line — let alone call `documentBridge.postKey`, let alone have that call reach the LOK
    /// thread's own queue — until `handlePostAuthLine`'s entire `.tileRequest` case returns, all 6
    /// paints later. There was never a moment where 6 jobs sat queued in front of the keystroke's
    /// own job on the LOK thread; the keystroke's job simply had not been SUBMITTED yet, because the
    /// one thread that would submit it was still busy running through the prior line's own work,
    /// one paint at a time, itself.
    ///
    /// **The two-connection case is different, and genuinely IS LOK-thread contention**: a `keyEvent`
    /// arriving on a SEPARATE connection (its own reader thread) is attempted promptly — decoded and
    /// dispatched to `documentBridge.postKey` immediately — and THAT call then legitimately queues
    /// behind whichever paint job is currently executing on the one shared `LOKDedicatedThread`
    /// (`thread.sync`, one job at a time, from any calling thread). That secondary hazard is real,
    /// but it is not what Task 4's own single-connection measurement scenario exercised or
    /// attributed its numbers to.
    ///
    /// This is a DIFFERENT hazard, either way, from `pushFrame`'s own write-blocking one two
    /// paragraphs up (the bounded push queue named there would not touch reader-thread serialization
    /// at all — it relieves RECEIVER backpressure on writes, not a reader thread's own inline paint
    /// work) — see `task-4-report.md`'s transport section for the numbers and the full reasoning.
    /// Decided NOT to build a fix for either hazard this round; both stay named, neither is fixed,
    /// and they should not be conflated when a future round picks either back up. A real fix for
    /// THIS hazard would need the reader thread to stop doing paint work inline — e.g. dispatching
    /// `.tileRequest`'s paint loop onto a separate queue so the reader can return to decoding the
    /// next line immediately — not any change to the LOK thread's own scheduling, which was never
    /// actually the bottleneck here.
    private func pushFrame(_ frame: OfficeWireFrame, to writer: ConnectionWriter) {
        writer.writeLock.lock()
        writeFrameLocked(frame, writer: writer)
        writer.writeLock.unlock()
    }

    /// Binds, listens, and starts accepting on a dedicated background thread. Returns once the
    /// socket is bound and listening — the moment a caller (the app-side supervisor, polling for
    /// the socket file) can start connecting.
    public func start() throws {
        try FileManager.default.createDirectory(atPath: statePath, withIntermediateDirectories: true)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw OfficeHelperServerError.posix("socket() failed: \(String(cString: strerror(errno)))")
        }

        // A stale socket file from a previous run that died without cleanup would otherwise fail
        // bind() with EADDRINUSE. Best-effort: ENOENT (nothing there) is not an error worth
        // reporting.
        unlink(socketPath)

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard pathBytes.count < capacity else {
            close(fd)
            throw OfficeHelperServerError.posix(
                "socket path too long for sockaddr_un.sun_path (\(pathBytes.count) bytes, limit "
                + "\(capacity - 1)): \(socketPath)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            let buffer = raw.bindMemory(to: UInt8.self)
            for index in 0..<capacity { buffer[index] = 0 }
            for (index, byte) in pathBytes.enumerated() { buffer[index] = byte }
        }

        let bindResult = withUnsafePointer(to: &addr) { rawAddr -> Int32 in
            rawAddr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
                bind(fd, sockaddrPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw OfficeHelperServerError.posix("bind() failed on \(socketPath): \(message)")
        }

        guard listen(fd, 8) == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw OfficeHelperServerError.posix("listen() failed: \(message)")
        }

        listenFD = fd
        log("[OfficeHelperServer] listening on \(socketPath)")

        let acceptThread = Thread { [weak self] in self?.acceptLoop() }
        acceptThread.name = "office-helper.accept"
        acceptThread.start()

        stateQueue.sync { refreshIdleStateLocked() }
    }

    // MARK: - Accept loop

    private func acceptLoop() {
        while true {
            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 {
                // EBADF/EINVAL: the listening fd was torn down out from under us. There is
                // currently no `stop()` (nothing in Task 2 calls one — every exit path is
                // `_exit(0)`, which takes this thread with it), so in practice this only fires if
                // that ever changes; exiting the loop quietly is still the right shape.
                if errno == EBADF || errno == EINVAL { return }
                log("[OfficeHelperServer] accept() error: \(String(cString: strerror(errno)))")
                continue
            }
            let connectionId = stateQueue.sync { () -> Int in
                nextConnectionId += 1
                connectionCount += 1
                refreshIdleStateLocked()
                return nextConnectionId
            }
            let connectionThread = Thread { [weak self] in
                self?.handleConnection(fd: clientFD)
            }
            connectionThread.name = "office-helper.conn.\(connectionId)"
            connectionThread.start()
        }
    }

    // MARK: - Per-connection handling

    private func handleConnection(fd: Int32) {
        let writer = ConnectionWriter(fd: fd)
        defer {
            close(fd)
            // Task 3: a connection that disconnects without explicitly closing its documents
            // (a crash, a dropped socket) must not leak them — copy the owned set out, close each
            // OUTSIDE stateQueue (the bridge-call invariant above), then remove the bookkeeping in
            // a second, separate stateQueue hop.
            let owned = stateQueue.sync { () -> Set<String> in
                connectionCount -= 1
                return writer.ownedDocIds
            }
            for docId in owned {
                documentBridge.close(docId: docId)
                // Office Stage B Task 7 — a connection dying (not just an explicit `.close` frame)
                // must ALSO stop that docId's own autosave timer; same reasoning as the explicit
                // close handler's identical call.
                autosaveScheduler.remove(docId: docId)
            }
            var closeNotifications: [(subscriber: ConnectionWriter, docId: String)] = []
            stateQueue.sync {
                for docId in owned {
                    if let entry = docOwner.removeValue(forKey: docId) {
                        for subscriber in entry.subscribers where subscriber !== writer {
                            closeNotifications.append((subscriber, docId))
                        }
                    }
                }
                // Task 4: this connection may ALSO be a mere tile SUBSCRIBER (never the opener) of
                // docs it does not own — a dangling entry there would try to write to this now-
                // closing fd on a future invalidation (a stale-fd bug, possibly worse than inert if
                // the fd number is later reassigned by the kernel to an unrelated connection).
                // Swept out of EVERY doc's subscriber list, not just the ones this connection owned.
                for entry in docOwner.values {
                    entry.subscribers.removeAll { $0 === writer }
                }
                refreshIdleStateLocked()
            }
            for (subscriber, docId) in closeNotifications {
                pushFrame(.documentEvent(seq: subscriber.pushSeqAllocator.nextSeq(), docId: docId, event: .closed),
                          to: subscriber)
            }
        }

        var authenticated = false
        var buffer = Data()
        var readBuffer = [UInt8](repeating: 0, count: 64 * 1024)

        while true {
            let bytesRead = readBuffer.withUnsafeMutableBytes { raw -> Int in
                read(fd, raw.baseAddress, raw.count)
            }
            if bytesRead == 0 { return } // peer closed
            if bytesRead < 0 {
                // F6 (T2 review): EINTR — this read() was interrupted by a signal before any data
                // arrived; the CONNECTION is still perfectly valid, only this one call was cut
                // short. Treating it the same as a real error/EOF (the previous `bytesRead <= 0`
                // check did) would drop a healthy connection over nothing more than an interrupted
                // system call. Any other errno IS a real read error — done.
                if errno == EINTR { continue }
                return
            }
            buffer.append(contentsOf: readBuffer[0..<bytesRead])

            while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
                buffer.removeSubrange(buffer.startIndex...newlineIndex)
                guard let line = String(data: lineData, encoding: .utf8) else {
                    // F4 fix (T2 review): this used to `continue` — silently dropping a line that
                    // isn't even valid UTF-8, never answering it. Refuse-never-ignore's whole point
                    // is that EVERY line gets a reply; bytes that can't even become a `String`
                    // still owe one — proven live: without this, whoever sent it starves for its
                    // own full request timeout instead of being told anything. `seq` is
                    // unrecoverable (there is no JSON to read one from), so this is the same
                    // sentinel-seq path `OfficeWireCodec.decodeInbound`'s `.unreadable` case
                    // already uses for a line that IS valid UTF-8 but isn't valid JSON.
                    writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), writer: writer)
                    if !authenticated { return } // same pre-auth rule as every other opening violation
                    continue
                }

                if !authenticated {
                    guard handleOpeningLine(line, writer: writer) else { return } // reply sent; done either way
                    authenticated = true
                    continue
                }
                handlePostAuthLine(line, writer: writer)
            }
        }
    }

    /// The pre-auth gate: the first frame on a connection MUST be a `hello` carrying the token
    /// this helper was launched with. Anything else — wrong type, malformed hello, wrong token —
    /// gets exactly one reply and the connection ends (refuse-never-ignore still means a reply is
    /// always sent; it does not mean the connection survives an auth failure). Returns `true` only
    /// when authentication succeeded, in which case the caller keeps reading on this connection.
    private func handleOpeningLine(_ line: String, writer: ConnectionWriter) -> Bool {
        switch OfficeWireCodec.decodeInbound(line) {
        case .frame(.hello(let seq, _, let token)):
            guard token == expectedToken else {
                writeReply(.refused(seq: seq, reason: "token mismatch"), writer: writer)
                return false
            }
            // `role` is accepted but not yet branched on — Stage A gives app and agent the same
            // credential and the same greeting; Stage C is what gives the daemon its own token and
            // its own verbs.
            writeReply(.helloOk(seq: seq, lokVersion: documentBridge.lokVersionString), writer: writer)
            hooks.afterHelloOkWritten?()
            return true
        case .frame(let frame):
            writeReply(.error(seq: frame.seq, reason: "not authenticated"), writer: writer)
            return false
        case .tilePending(let header):
            // Task 5.5: a `"tile"` line is PUSH-only (helper -> client) — a client sending one
            // pre-auth is exactly as illegal as any other frame here, refused identically. No
            // payload bytes are read off the stream for this — the connection is about to be
            // refused outright, so there is nothing to stay in sync FOR.
            writeReply(.error(seq: header.seq, reason: "not authenticated"), writer: writer)
            return false
        // Wave fix (T5.5 review Minor-B): a `"tile"` line that failed to decode ITS OWN structure —
        // treated identically to `.rejected` right below, same as `.tilePending` right above treats
        // a structurally-VALID tile header identically to any other illegal-from-a-client frame. The
        // desync hazard `.tileHeaderMalformed` exists to name is specific to `OfficeWireConnection`
        // (the CLIENT side, reading a PUSH that raw payload bytes always follow) — this server never
        // enters a payload-accumulation mode for anything a client sends, so it has no equivalent
        // hazard to guard against; answering with an error and surviving is exactly right here.
        case .tileHeaderMalformed(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), writer: writer)
            return false
        case .rejected(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), writer: writer)
            return false
        case .unreadable:
            writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), writer: writer)
            return false
        }
    }

    /// Post-auth: every line gets exactly one reply; nothing here ever closes the connection on
    /// its own initiative (only a read error/EOF does, in `handleConnection`) — a bad frame after
    /// a good handshake is a protocol violation to answer, not a reason to drop a session the
    /// client may recover from.
    private func handlePostAuthLine(_ line: String, writer: ConnectionWriter) {
        switch OfficeWireCodec.decodeInbound(line) {
        case .frame(.ping(let seq)):
            writeReply(.pong(seq: seq), writer: writer)
        case .frame(.open(let seq, let docId, let path)):
            // Task 3: open is REAL now. Double-open ruling (this task's own carry, decided here):
            // a second `open` of an already-tracked `docId` is `error{alreadyOpen}`, checked and
            // answered WITHOUT ever calling the bridge — real LOK document handles are not
            // idempotently re-openable the way Task 2's pure bookkeeping was (a silent re-load
            // would leak or double-own a handle); `close` first is the honest way to reload the
            // same docId. `close` itself stays idempotent (see its own case below) — there is no
            // equivalent double-destruction risk.
            let alreadyOpen = stateQueue.sync { docOwner[docId] != nil }
            if alreadyOpen {
                writeReply(.error(seq: seq, reason: "alreadyOpen"), writer: writer)
                return
            }
            do {
                // Never called while holding stateQueue (the bridge-call invariant above) — this
                // line runs on the connection's own thread with no lock held at all.
                let metadata = try documentBridge.open(docId: docId, path: path)
                stateQueue.sync {
                    docOwner[docId] = DocEntry(opener: writer)
                    writer.ownedDocIds.insert(docId)
                    refreshIdleStateLocked()
                }
                writeReply(.opened(seq: seq, docId: docId, type: metadata.type, parts: metadata.parts,
                                    sizeTwips: metadata.sizeTwips), writer: writer)
            } catch {
                // The helper SURVIVES a failed open (the brief's own garbage-file requirement) —
                // nothing here tears down the bridge or the connection; the next `open` (even of
                // the SAME docId, since it was never tracked) works normally.
                writeReply(.openFailed(seq: seq, docId: docId, reason: "\(error)"), writer: writer)
            }
        case .frame(.close(let seq, let docId)):
            // F7 (Task 4 review carry): only the connection that OPENED a doc may close it. An
            // UNTRACKED docId stays idempotent (Task 2's own precedent, unchanged — there is no
            // "wrong owner" to check against something not tracked at all); a TRACKED docId whose
            // opener is a DIFFERENT connection is refused outright, never silently reassigned.
            let entry = stateQueue.sync { docOwner[docId] }
            if let entry, entry.opener !== writer {
                writeReply(.error(seq: seq, reason: "notOwner"), writer: writer)
                return
            }
            documentBridge.close(docId: docId)
            // Office Stage B Task 7 — the autosave timer goes with the document, the ordinary-close
            // half of `OfficeAutosaveScheduler`'s own contract; see that type's own header for why
            // this cancels the TIMER only, never a sidecar already on disk (the app's own
            // `.clearAutosave` owns that, once it has proof the real path itself is resolved).
            autosaveScheduler.remove(docId: docId)
            let remainingSubscribers = stateQueue.sync { () -> [ConnectionWriter] in
                let subscribers = docOwner[docId]?.subscribers.filter { $0 !== writer } ?? []
                docOwner.removeValue(forKey: docId)
                writer.ownedDocIds.remove(docId)
                refreshIdleStateLocked()
                return subscribers
            }
            // Task 4: any OTHER connection still tile-subscribed to this doc learns it is gone —
            // the one real construction site of OfficeDocumentEvent.closed (declared since Task 3,
            // never built until now). The CLOSING connection gets the direct `.closed` reply below
            // instead; this is only for everyone else.
            for subscriber in remainingSubscribers {
                pushFrame(.documentEvent(seq: subscriber.pushSeqAllocator.nextSeq(), docId: docId, event: .closed),
                          to: subscriber)
            }
            writeReply(.closed(seq: seq, docId: docId), writer: writer)
        case .frame(.save(let seq, let docId, let part)):
            // Office Stage B Task 2 — mirrors `tileRequest`'s own "must already be open — by ANY
            // connection" posture (not `close`'s ownership check): Stage A/B has one client at a
            // time in practice, and there is no destructive "who may save" question the way there
            // is for "who may destroy the handle" on `close`.
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                // Never called while holding stateQueue (the bridge-call invariant above).
                let tempPath = try documentBridge.saveAs(docId: docId, seq: seq, part: part)
                writeReply(.saved(seq: seq, docId: docId, tempPath: tempPath), writer: writer)
            } catch {
                // The helper SURVIVES a failed save — same posture as a failed open.
                writeReply(.saveFailed(seq: seq, docId: docId, reason: "\(error)"), writer: writer)
            }
        case .frame(.keyEvent(let seq, let docId, let part, let type, let charCode, let keyCode)):
            // Office Stage B Task 4 — same existence check as `.save` above (not an ownership check
            // — any connection touching an already-open doc may post input to it, matching
            // `tileRequest`'s own posture, not `close`'s).
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                // Fix round 1, F2 — `part` threaded straight through; see `LOKBridge.postKey`'s own
                // header for what it does with it (a `setPart` immediately before the real post).
                try documentBridge.postKey(docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode)
                writeReply(.keyEventOk(seq: seq, docId: docId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.mouseEvent(let seq, let docId, let part, let type, let xTwips, let yTwips, let count, let buttons, let modifiers)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                try documentBridge.postMouse(docId: docId, part: part, type: type, xTwips: xTwips, yTwips: yTwips,
                                             count: count, buttons: buttons, modifiers: modifiers)
                writeReply(.mouseEventOk(seq: seq, docId: docId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.extTextInputEvent(let seq, let docId, let part, let type, let text)):
            // Office Stage B Task 5 — same existence check and same posture as `.keyEvent`/
            // `.mouseEvent` above: any connection touching an already-open doc may post input to it.
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                try documentBridge.postExtTextInput(docId: docId, part: part, type: type, text: text)
                writeReply(.extTextInputEventOk(seq: seq, docId: docId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.clipboardCopy(let seq, let docId, let part)):
            // Office Stage B Task 6 — same existence-check posture as `.keyEvent`/`.mouseEvent`
            // above (any connection touching an already-open doc may read its selection).
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let text = try documentBridge.clipboardCopy(docId: docId, part: part)
                writeReply(.clipboardCopyOk(seq: seq, docId: docId, text: text), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.clipboardCut(let seq, let docId, let part)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let text = try documentBridge.clipboardCut(docId: docId, part: part)
                writeReply(.clipboardCutOk(seq: seq, docId: docId, text: text), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.clipboardPaste(let seq, let docId, let part, let text)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                try documentBridge.clipboardPaste(docId: docId, part: part, text: text)
                writeReply(.clipboardPasteOk(seq: seq, docId: docId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.undo(let seq, let docId)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                try documentBridge.undo(docId: docId)
                writeReply(.undoOk(seq: seq, docId: docId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.redo(let seq, let docId)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                try documentBridge.redo(docId: docId)
                writeReply(.redoOk(seq: seq, docId: docId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.createView(let seq, let docId)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let viewId = try documentBridge.createAgentView(docId: docId)
                writeReply(.agentViewReady(seq: seq, docId: docId, viewId: viewId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.agentKeyEvent(let seq, let docId, let part, let type, let charCode, let keyCode)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                try documentBridge.agentKeyEvent(docId: docId, part: part, type: type, charCode: charCode, keyCode: keyCode)
                writeReply(.agentKeyEventOk(seq: seq, docId: docId), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.sheetsInfo(let seq, let docId)):
            // office-agent-tools T3 — same existence-check posture as `clipboardCopy`/`undo` above
            // (any connection touching an already-open doc may read it; this is a read, not a
            // destructive operation the way `close` is).
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let result = try documentBridge.sheetsInfo(docId: docId)
                writeReply(.sheetsInfoOk(seq: seq, docId: docId, sheets: result.sheets, activeSheet: result.activeSheet),
                           writer: writer)
            } catch {
                // `SaveError.notSpreadsheet`/`.docNotOpen` are already house-voice, composed entirely
                // from this bridge's own words (see that enum's own doc) — `"\(error)"` carries them
                // through unchanged, the same posture every other verb on this switch already takes.
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.sheetsRead(let seq, let docId, let sheet, let range, let formulas)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let rows = try documentBridge.sheetsRead(docId: docId, sheet: sheet, range: range, formulas: formulas)
                writeReply(.sheetsReadOk(seq: seq, docId: docId, rows: rows), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.sheetsSet(let seq, let docId, let sheet, let range, let cellAddresses, let cellValues)):
            // office-agent-tools T4 — a WRITE, unlike sheetsInfo/sheetsRead above, but the same
            // existence-check posture: any connection touching an already-open doc may write it
            // (the broker's own dirty/fence checks already ran before this frame was ever built —
            // see `OfficeAgentBroker`'s own rules; this bridge has no further consent to withhold).
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let cellsWritten = try documentBridge.sheetsSet(docId: docId, sheet: sheet, range: range,
                                                                 cellAddresses: cellAddresses, cellValues: cellValues)
                writeReply(.sheetsSetOk(seq: seq, docId: docId, cellsWritten: cellsWritten), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.sheetsResize(let seq, let docId, let sheet, let dimension, let op, let selectionRange)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let dims = try documentBridge.sheetsResize(docId: docId, sheet: sheet, dimension: dimension,
                                                            op: op, selectionRange: selectionRange)
                writeReply(.sheetsResizeOk(seq: seq, docId: docId, usedEndColumn: dims.usedEndColumn,
                                           usedEndRow: dims.usedEndRow), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.sheetsManageSheet(let seq, let docId, let op, let name, let newName)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let sheets = try documentBridge.sheetsManageSheet(docId: docId, op: op, name: name, newName: newName)
                writeReply(.sheetsManageSheetOk(seq: seq, docId: docId, sheets: sheets), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.sheetsFormat(let seq, let docId, let sheet, let range, let columnSpan, let bold,
                                  let italic, let numberFormat, let align, let width)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let applied = try documentBridge.sheetsFormat(docId: docId, sheet: sheet, range: range,
                                                               columnSpan: columnSpan, bold: bold, italic: italic,
                                                               numberFormat: numberFormat, align: align, width: width)
                writeReply(.sheetsFormatOk(seq: seq, docId: docId, applied: applied), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.slidesInfo(let seq, let docId)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let slides = try documentBridge.slidesInfo(docId: docId)
                writeReply(.slidesInfoOk(seq: seq, docId: docId, slides: slides), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.slidesRead(let seq, let docId, let slide)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let result = try documentBridge.slidesRead(docId: docId, slide: slide)
                writeReply(.slidesReadOk(seq: seq, docId: docId, title: result.title, body: result.body), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.slidesSetText(let seq, let docId, let slide, let title, let body)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let applied = try documentBridge.slidesSetText(docId: docId, slide: slide, title: title, body: body)
                writeReply(.slidesSetTextOk(seq: seq, docId: docId, applied: applied), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.slidesManagePage(let seq, let docId, let op, let slide, let at, let to, let layout)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            do {
                let slideCount = try documentBridge.slidesManagePage(docId: docId, op: op, slide: slide, at: at,
                                                                      to: to, layout: layout)
                writeReply(.slidesManagePageOk(seq: seq, docId: docId, slideCount: slideCount), writer: writer)
            } catch {
                writeReply(.error(seq: seq, reason: "\(error)"), writer: writer)
            }
        case .frame(.subscribeTiles(let seq, let docId, let part, let zoomPPT, let viewportTwips)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            // Fix round 1, I1 — validated BEFORE the subscriber-list mutation below (a reviewer
            // finding, not just belt-and-suspenders): a refused subscribe must leave no
            // subscription behind. `viewportTwips`/`zoomPPT` arrive over the wire with no magnitude
            // limit; a reviewer transcribed and RAN inputs here that trapped the helper (SIGTRAP)
            // through `TileMath`'s then-unchecked arithmetic, and a separate, non-trapping huge-
            // viewport input that would OOM/stall building one absurd NDJSON reply line. Both
            // checks below are pure and cheap — see their own doc comments in `TileMath.swift` for
            // exactly which traps each one closes.
            guard TileMath.isZoomPPTValid(zoomPPT) else {
                writeReply(.error(seq: seq, reason: "zoomPPTOutOfRange"), writer: writer)
                return
            }
            guard TileMath.estimatedTileCount(rectTwips: viewportTwips, zoomPPT: zoomPPT) != nil else {
                writeReply(.error(seq: seq, reason: "viewportTooLarge"), writer: writer)
                return
            }
            stateQueue.sync {
                guard let entry = docOwner[docId] else { return } // could have raced closed; harmless no-op
                if !entry.subscribers.contains(where: { $0 === writer }) {
                    entry.subscribers.append(writer)
                }
            }
            let keys = TileMath.viewportTileKeys(part: part, zoomPPT: zoomPPT, viewportTwips: viewportTwips)
            writeReply(.subscribed(seq: seq, docId: docId, keys: keys), writer: writer)
        case .frame(.unsubscribe(let seq, let docId)):
            stateQueue.sync {
                docOwner[docId]?.subscribers.removeAll { $0 === writer }
            }
            writeReply(.unsubscribed(seq: seq, docId: docId), writer: writer)
        case .frame(.tileRequest(let seq, let docId, let keys)):
            guard stateQueue.sync(execute: { docOwner[docId] }) != nil else {
                writeReply(.error(seq: seq, reason: "docNotOpen"), writer: writer)
                return
            }
            writeReply(.tileRequestAccepted(seq: seq, docId: docId), writer: writer)
            hooks.afterTileRequestAccepted?(docId)
            // Each key paints (or hits cache) independently and pushes AS SOON AS IT IS READY —
            // never buffered into one giant reply — to THIS connection only (a targeted fetch, not
            // a broadcast; see `OfficeWireFrame.tile`'s own header for why this differs from
            // `.invalidated`'s multicast). Never called while holding stateQueue.
            for key in keys {
                do {
                    let result = try documentBridge.paintTile(docId: docId, key: key)
                    // Task 5.5: no base64 encode — `result.pixels` (raw RGBA) crosses the wire as
                    // the frame's out-of-band payload, written by `pushFrame`/`writeFrameLocked`
                    // immediately after this line's own header. This IS the transport-decision win:
                    // rung 1's `.base64EncodedString()` call here is simply gone.
                    pushFrame(.tile(seq: writer.pushSeqAllocator.nextSeq(), docId: docId, key: key,
                                     generation: result.generation, width: result.width, height: result.height,
                                     pixels: result.pixels),
                              to: writer)
                } catch {
                    pushFrame(.tileFailed(seq: writer.pushSeqAllocator.nextSeq(), docId: docId, key: key,
                                           reason: "\(error)"),
                              to: writer)
                }
            }
        case .frame(.hello(let seq, _, _)):
            writeReply(.error(seq: seq, reason: "already authenticated"), writer: writer)
        case .frame(let frame):
            // helloOk/openFailed/refused/pong/opened/closed/error/documentEvent: structurally
            // valid frames that are never legal for a CLIENT to send — the helper only ever sends
            // these.
            writeReply(.error(seq: frame.seq, reason: "unexpected"), writer: writer)
        case .tilePending(let header):
            // Task 5.5: `tile` joins the same "helper-only, never legal from a client" family as
            // the `.frame(let frame)` arm right above — refused identically (`"unexpected"`), never
            // read as a payload-bearing push. No byteCount bytes are consumed off the stream here:
            // this connection is not a `.tile` PRODUCER, so there is no "next bytes are the
            // payload" state for it to enter — the wire-level malformed-shape tests
            // (`OfficeWireCodecTests`) already cover "client sends a tile-shaped line" at the
            // decode level; this is the server's own behavioral answer to it arriving for real.
            writeReply(.error(seq: header.seq, reason: "unexpected"), writer: writer)
        // Wave fix (T5.5 review Minor-B) — same "not this server's hazard" reasoning as the
        // pre-auth arm above.
        case .tileHeaderMalformed(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), writer: writer)
        case .rejected(let seq, let reason):
            writeReply(.error(seq: seq, reason: reason), writer: writer)
        case .unreadable:
            writeReply(.error(seq: OfficeWireCodec.unreadableSeqSentinel, reason: "malformed"), writer: writer)
        }
    }

    /// Task 3: takes `writer.writeLock` — the SAME lock the async push path
    /// (`routeDocumentEvent`) takes around its own write to this connection's `fd` — so a reply
    /// and a push can never interleave bytes on the wire. `.tile` is never actually sent through
    /// this path in production (it is always a PUSH, via `pushFrame` — see that frame's own doc
    /// comment), but `writeFrameLocked` handles it correctly regardless, so this stays true even if
    /// that ever changes.
    private func writeReply(_ frame: OfficeWireFrame, writer: ConnectionWriter) {
        guard !hooks.suppressReplies else { return }
        writer.writeLock.lock()
        writeFrameLocked(frame, writer: writer)
        writer.writeLock.unlock()
    }

    /// Writes every byte of `data` to `fd`, looping past partial writes and retrying on EINTR (F6,
    /// T2 review). POSIX permits a single `write()` to a blocking socket to accept fewer bytes than
    /// requested even when it isn't full — today's frames are a few dozen bytes and this has never
    /// been observed to matter, but Task 3's real LOK version strings (and later document content)
    /// make a partial write plausible for the first time. A real write ERROR (EPIPE, ECONNRESET,
    /// ...) stops here rather than looping forever — the read loop's next `read()` will observe the
    /// closed connection and return on its own.
    ///
    /// **Corrected, fix round 1, M1**: the previous version of this comment implied `errno ==
    /// EPIPE` handling here was what protected this process from a write to a peer that already
    /// closed its read side. A reviewer traced this precisely: writing to such a socket delivers
    /// `SIGPIPE`, and that signal's DEFAULT disposition TERMINATES the process outright, before
    /// `write()` ever gets a chance to return `-1` to this function at all — a bare Swift process
    /// confirmed to die this way. What ACTUALLY protected every write here, this whole time, is
    /// that the vendored LibreOffice library installs `SIG_IGN` for `SIGPIPE` as an incidental side
    /// effect of its own C++ runtime init (inside `lok_init_2`, `LOKBridge`'s job) — never something
    /// THIS file arranged, and a version bump of that vendored library could silently remove it.
    /// `NormaOfficeHelperFixture` links no LibreOffice code at all and had ZERO such protection.
    /// Both `main.swift` entry points now call `signal(SIGPIPE, SIG_IGN)` explicitly, as the first
    /// thing they do, making this a deliberate guarantee of THIS codebase rather than an accident
    /// of a dependency — see either file's own comment. `EPIPE` is only ever OBSERVABLE by the
    /// `errno == EPIPE` reasoning this function's own error handling already assumed BECAUSE that
    /// signal is now (and was, incidentally, for the real helper) ignored process-wide.
    private func writeAll(_ data: Data, fd: Int32) {
        data.withUnsafeBytes { raw in
            var offset = 0
            let total = raw.count
            while offset < total {
                let n = write(fd, raw.baseAddress!.advanced(by: offset), total - offset)
                if n > 0 {
                    offset += n
                } else if n < 0 && errno == EINTR {
                    continue
                } else {
                    return
                }
            }
        }
    }

    // MARK: - Idle-exit accounting

    /// Must run ON `stateQueue`. "Zero documents AND zero clients" per the brief: re-evaluated
    /// after every connection open/close and every open/close frame, so the 120s (or, in tests, a
    /// far shorter override) countdown always measures from the LAST moment the helper had any
    /// reason to stay alive, not from process launch.
    private func refreshIdleStateLocked() {
        idleTimer?.cancel()
        idleTimer = nil
        guard docOwner.isEmpty && connectionCount == 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: stateQueue)
        timer.schedule(deadline: .now() + idleExitSeconds)
        timer.setEventHandler { [log, idleExitSeconds] in
            log("[OfficeHelperServer] idle \(idleExitSeconds)s with zero documents and zero clients — exiting")
            // Global constraint (plan header, binding on every helper teardown path, not only
            // Task 3's LOK static-destructor crash): _exit(0), never a normal return/exit() that
            // would run atexit/static-destructor cleanup.
            _exit(0)
        }
        timer.resume()
        idleTimer = timer
    }
}
