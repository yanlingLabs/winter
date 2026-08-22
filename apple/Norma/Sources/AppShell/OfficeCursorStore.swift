import Foundation
import Combine

/// Office Stage B Task 5 — the caret/selection/cell-cursor counterpart to `OfficeTileStore`: state
/// that changes at keystroke/drag frequency and must never ride the `@Published OfficeRuntimeState`
/// graph. **Advisor review, this task**: `TEXT_SELECTION` fires per `mouseDragged` tick and
/// `INVALIDATE_VISIBLE_CURSOR` fires per keystroke — routing either through `dispatch`/`state` would
/// mean a SwiftUI-diffable-state reassignment on every one, the exact class of churn
/// `OfficeTileStore`'s own header already forbids for tile bytes ("the heavy, high-frequency half
/// that must never ride the same invalidation channel"). One per `OfficeRuntime`, keyed by `docId` —
/// a session can hold several open document tabs, and they share this one store, mirroring
/// `OfficeTileStore`'s own `docId`-scoped-entries shape exactly.
///
/// **Threading**: touched only from `OfficeRuntime.handle(documentEvent:docId:)`, which
/// `ShellSessionHost.wireOfficeTileCallbacks` already calls from inside `Task { @MainActor ... }` —
/// the SAME hop `onInvalidated`/`OfficeTileStore.invalidate` already rely on, one `supervisor.client`
/// callback registration below it. No internal locking, by construction, matching `OfficeTileStore`.
final class OfficeCursorStore {
    /// Everything Norma currently knows about ONE document's caret/selection/cell-cursor, folded
    /// from whichever of the five Task 5 `OfficeDocumentEvent` cases most recently arrived for it.
    ///
    /// **`part` fields are stamped at FOLD time from the reducer's own `DocumentEntry.activePart`**
    /// — LOK's own payloads carry no part number for any of these three callback types (unlike
    /// `INVALIDATE_TILES`, which has `LOK_FEATURE_PART_IN_INVALIDATION_CALLBACK`), so "which part was
    /// this rect drawn against" has to come from OUTSIDE the payload. This is the same narrow,
    /// self-limiting staleness window fix round 4's own NEW-2 already accepted for the analogous
    /// paint-part-staleness risk (a stale in-flight paint re-parking LOK's active part after a switch)
    /// — a cursor callback racing a part switch could stamp the NEW part onto a rect actually computed
    /// against the OLD one. Not chased further for the identical reason NEW-2 wasn't: input (unlike a
    /// background prefetch paint) runs synchronously on ONE dedicated thread, so the window is real
    /// but narrow. The canvas is what ACTS on the stamp — see `OfficeTileCanvasView`'s overlay code:
    /// a rect whose stamped part disagrees with the canvas's own current `part` is hidden, never
    /// shown against the wrong page/sheet.
    struct State: Equatable {
        var caretRectTwips: OfficeTwipsRect?
        var caretPart: Int?
        var selectionRectsTwips: [OfficeTwipsRect] = []
        var selectionPart: Int?
        /// Parsed and folded for completeness (Stage 1's own "keep the parse pure and reusable"
        /// spirit) but NOT consumed by this task's own overlay — the brief's own ask is "selection
        /// overlay layers from rect lists" (`selectionRectsTwips` above), never selection HANDLES.
        /// A disclosed, narrow scope decision, the identical shape `cellCursor`'s own col/row fields
        /// take toward T8 (parsed now, drawn/consumed by a later task).
        var selectionStartRectTwips: OfficeTwipsRect?
        var selectionEndRectTwips: OfficeTwipsRect?
        var cellCursor: OfficeCellCursor?
        var cellCursorPart: Int?
        /// Task 8 — the formula bar's own content feed, from `LOK_CALLBACK_CELL_FORMULA`. A
        /// SEPARATE field pair from `cellCursor`/`cellCursorPart`, deliberately not derived from
        /// it — see `OfficeDocumentEvent.cellFormula`'s own header for why the two callbacks'
        /// ordering cannot be assumed to agree. `nil` until the first firing for this docId;
        /// `""` (once set) is a real, meaningful "this cell has no content," never a sentinel for
        /// "unknown."
        var cellFormulaText: String?
        var cellFormulaPart: Int?
    }

    private var states: [String: State] = [:]

    /// Fires whenever ANY field of a docId's own `State` changes — the canvas re-reads `state(docId:)`
    /// fresh off this store rather than trusting the signal's own payload as authoritative, the SAME
    /// posture `OfficeTileStore.tilesArrived` already established (that publisher's own payload is a
    /// `Set<TileKey>` for a similar reason: "go look, don't trust what's attached here").
    let cursorChanged = PassthroughSubject<String, Never>()

    func state(docId: String) -> State { states[docId] ?? State() }

    /// Folds one caret/selection/cell-cursor `OfficeDocumentEvent` into `docId`'s own `State` and
    /// signals `cursorChanged`. A no-op (no signal) for any event kind this store does not own
    /// (`.opened`/`.openFailed`/`.invalidated`/`.modifiedChanged`/`.closed`/`.autosaved` all belong
    /// to the reducer/`tileStore` instead) — callers are expected to route by case already
    /// (`OfficeRuntime.handle(documentEvent:docId:)`'s own switch), this guard is defense-in-depth,
    /// not the primary dispatch mechanism.
    func apply(docId: String, event: OfficeDocumentEvent, activePart: Int) {
        var state = states[docId] ?? State()
        switch event {
        case .caretRect(let rect):
            state.caretRectTwips = rect
            state.caretPart = activePart
        case .textSelection(let rects):
            state.selectionRectsTwips = rects
            state.selectionPart = activePart
        case .textSelectionStart(let rect):
            state.selectionStartRectTwips = rect
        case .textSelectionEnd(let rect):
            state.selectionEndRectTwips = rect
        case .cellCursor(let cell):
            state.cellCursor = cell
            state.cellCursorPart = activePart
        case .cellFormula(let text):
            state.cellFormulaText = text
            state.cellFormulaPart = activePart
        case .opened, .openFailed, .invalidated, .modifiedChanged, .closed, .autosaved:
            return // not this store's concern — no signal, no mutation
        }
        states[docId] = state
        cursorChanged.send(docId)
    }

    /// Mirrors `OfficeTileStore.evictAll(docId:)` — a document close/reload must not leave a stale
    /// caret/selection sitting in the store for a docId nothing will ever update again (the NEXT
    /// document to reuse a `path`, or simply a leaked entry for the store's whole process lifetime).
    func evict(docId: String) {
        states.removeValue(forKey: docId)
    }

    /// Mirrors `OfficeTileStore.evictEverything()` — the helper-died/helper-unavailable sweep.
    func evictEverything() {
        states.removeAll()
    }
}
