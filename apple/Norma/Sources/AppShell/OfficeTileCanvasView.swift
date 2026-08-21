import AppKit
import Combine
import SwiftUI

// MARK: - Pure geometry (obligation 8: TileMath is authoritative on dimensions)

/// The fixed device-scale pin `TileMath`'s own doc states as the canonical configuration this whole
/// pipeline renders at ("100% zoom, 2x device scale" -> `zoomPPT == 1000`). Stage A has no
/// per-screen `backingScaleFactor` awareness — a deliberate simplification matching `TileMath`'s own
/// fixed pin rather than introducing a THIRD, independently-varying scale on top of it.
let officeFixedDeviceScale: CGFloat = 2

/// view-space POINTS -> the twips rectangle the viewport covers, at `zoomPPT`. The one place
/// `TileMath.pixelsToTwips` is fed pixels derived from points — multiplying by the fixed 2x scale
/// FIRST is load-bearing: `zoomPPT` already embeds that pin, so feeding it raw points would silently
/// ask the helper for a viewport twice the size actually on screen. Round-trip pinned in
/// `OfficeTileCanvasViewTests`: 512pt-wide at `zoomPPT == 1000` is exactly 1024px = 10240 twips = 2
/// tile spans.
func officeViewportTwips(scrollOrigin: CGPoint, visibleSize: CGSize, zoomPPT: Int) -> OfficeTwipsRect {
    let originXPixels = Int((scrollOrigin.x * officeFixedDeviceScale).rounded())
    let originYPixels = Int((scrollOrigin.y * officeFixedDeviceScale).rounded())
    let widthPixels = Int((visibleSize.width * officeFixedDeviceScale).rounded())
    let heightPixels = Int((visibleSize.height * officeFixedDeviceScale).rounded())
    return OfficeTwipsRect(
        x: TileMath.pixelsToTwips(originXPixels, zoomPPT: zoomPPT),
        y: TileMath.pixelsToTwips(originYPixels, zoomPPT: zoomPPT),
        width: TileMath.pixelsToTwips(widthPixels, zoomPPT: zoomPPT),
        height: TileMath.pixelsToTwips(heightPixels, zoomPPT: zoomPPT))
}

/// Office Stage B Task 4 — the INVERSE unit chain from `officeViewportTwips`: a point in this
/// view's own bounds-space (already flipped top-down, matching document space directly — see
/// `OfficeTileCanvasView.isFlipped`) -> the document-space twips coordinate `postMouseEvent` wants.
/// `viewPoint` is offset by `scrollOrigin` FIRST (the view's own content offset), exactly mirroring
/// `officeViewportTwips`'s own origin handling, before the same points -> 2x-scale-pixels -> twips
/// conversion every other coordinate in this file already goes through.
func officePointToTwips(viewPoint: CGPoint, scrollOrigin: CGPoint, zoomPPT: Int) -> (x: Int64, y: Int64) {
    let documentXPixels = Int(((viewPoint.x + scrollOrigin.x) * officeFixedDeviceScale).rounded())
    let documentYPixels = Int(((viewPoint.y + scrollOrigin.y) * officeFixedDeviceScale).rounded())
    return (x: TileMath.pixelsToTwips(documentXPixels, zoomPPT: zoomPPT),
            y: TileMath.pixelsToTwips(documentYPixels, zoomPPT: zoomPPT))
}

/// A `TileKey`'s on-screen rectangle, in view-space POINTS — the inverse unit chain of
/// `officeViewportTwips`. `nil` for a key `TileMath.tileBoundsTwips` itself refuses (a
/// hostile/invalid key; TileMath never traps, and a key this function cannot place is simply not
/// drawn — obligation 8). Always uses the CANVAS's current `zoomPPT`, never `key.zoomPPT`: every key
/// actually asked to be positioned was computed BY `TileMath.viewportTileKeys` at that same
/// `zoomPPT` (the two can never legitimately disagree — `clearVisibleTiles` drops every layer on a
/// zoom change before any new key is ever positioned), so this stays independent of the key's own
/// stamped zoom rather than silently trusting it to match.
func officeTileScreenRect(key: TileKey, zoomPPT: Int, scrollOrigin: CGPoint) -> CGRect? {
    guard let boundsTwips = TileMath.tileBoundsTwips(tileX: key.tileX, tileY: key.tileY, zoomPPT: zoomPPT) else {
        return nil
    }
    let originXPixels = TileMath.twipsToPixels(boundsTwips.x, zoomPPT: zoomPPT)
    let originYPixels = TileMath.twipsToPixels(boundsTwips.y, zoomPPT: zoomPPT)
    let sidePoints = CGFloat(TileMath.tilePixelSize) / officeFixedDeviceScale // 256pt, fixed regardless of zoom
    return CGRect(x: CGFloat(originXPixels) / officeFixedDeviceScale - scrollOrigin.x,
                 y: CGFloat(originYPixels) / officeFixedDeviceScale - scrollOrigin.y,
                 width: sidePoints, height: sidePoints)
}

// MARK: - Office Stage B Task 5: caret/selection/cell-cursor overlay geometry
//
// The SAME unit chain `officeTileScreenRect` already establishes for a `TileKey`'s bounds, applied
// to an ARBITRARY twips rect instead — every overlay this task adds (caret, selection, cell-cursor)
// positions itself through this ONE function, so a tile and the caret sitting on top of it can never
// visually disagree about where the document's own twips-space maps to view-space points.

/// A twips-space rect -> view-space POINTS, the exact inverse chain `officeTileScreenRect` already
/// uses for a tile's own bounds (scroll offset, then zoom, then the fixed 2x device-scale pin) —
/// factored out here because a caret/selection/cell-cursor rect is NOT tile-grid-aligned the way a
/// `TileKey`'s bounds always are. Total: a degenerate (zero-or-negative width/height) input still
/// produces a valid (if empty-looking) `CGRect` rather than `nil` — unlike `officeTileScreenRect`,
/// there is no `TileMath.tileBoundsTwips` sane-bounds refusal in this path, since the input here is
/// never a hostile wire-decoded tile index, only a LOK-reported rect this app already trusts enough
/// to have parsed (Task 5's own probe-verified parsers). A caret rect's own `width == 0` (every real
/// firing observed) is exactly this "degenerate but legitimate" case — a caret is a LINE, not a box,
/// and must still position and size correctly (as a hairline).
func officeTwipsRectToScreenRect(_ rectTwips: OfficeTwipsRect, zoomPPT: Int, scrollOrigin: CGPoint) -> CGRect {
    let originXPixels = TileMath.twipsToPixels(rectTwips.x, zoomPPT: zoomPPT)
    let originYPixels = TileMath.twipsToPixels(rectTwips.y, zoomPPT: zoomPPT)
    let widthPixels = TileMath.twipsToPixels(rectTwips.width, zoomPPT: zoomPPT)
    let heightPixels = TileMath.twipsToPixels(rectTwips.height, zoomPPT: zoomPPT)
    return CGRect(x: CGFloat(originXPixels) / officeFixedDeviceScale - scrollOrigin.x,
                 y: CGFloat(originYPixels) / officeFixedDeviceScale - scrollOrigin.y,
                 width: CGFloat(widthPixels) / officeFixedDeviceScale,
                 height: CGFloat(heightPixels) / officeFixedDeviceScale)
}

/// The caret's own rendered width, in POINTS — a real caret rect's `width` is always `0` twips
/// (every firing this task's own live probe observed), which `officeTwipsRectToScreenRect` alone
/// would draw as an invisible zero-width box. A fixed 1.5pt hairline, matching the house's own
/// "visible but not heavy" caret convention (`EditorTheme`'s Monaco cursor is a comparable
/// thin-line width) — independent of zoom, since a caret's on-screen THICKNESS is a UI affordance,
/// not a document measurement, the same reasoning `Self.subscribeMarginPoints` already applies to a
/// UI-space constant elsewhere in this file.
let officeCaretWidthPoints: CGFloat = 1.5

// MARK: - Pure: the zoom ladder (obligation 9: 50%..400%)

/// Concrete `zoomPPT` steps for the ladder — the canonical "100% zoom, 2x device scale" pin is
/// `zoomPPT == 1000` (`TileMath`'s own doc), and `zoomPPT` scales linearly with UI zoom percent, so
/// "50%..400%" becomes these values directly. The familiar 50/75/100/125/150/200/300/400 progression
/// most macOS zoom UIs already use — not invented here. ⌘±/the strip step through this discrete
/// ladder; pinch (`magnify(with:)`) moves continuously within its own `[first, last]` bounds instead
/// — obligation 9 names both doors, and only one benefits from discrete steps.
let officeZoomLadder: [Int] = [500, 750, 1000, 1250, 1500, 2000, 3000, 4000]

/// The next step UP from `current` — snaps to the nearest ladder value AT OR BELOW `current` first
/// (so a pinch-zoomed 1180 steps to 1250, not 1500 — one real step from wherever the user actually
/// is, not from the nearest official stop), then advances one. Clamped at the ladder's own ceiling.
func officeZoomIn(current: Int) -> Int {
    guard let index = officeZoomLadder.lastIndex(where: { $0 <= current }) else { return officeZoomLadder.first! }
    return officeZoomLadder[min(index + 1, officeZoomLadder.count - 1)]
}

/// The mirror image: snaps to the nearest ladder value AT OR ABOVE `current` first, then retreats
/// one. Clamped at the floor.
func officeZoomOut(current: Int) -> Int {
    guard let index = officeZoomLadder.firstIndex(where: { $0 >= current }) else { return officeZoomLadder.last! }
    return officeZoomLadder[max(index - 1, 0)]
}

// MARK: - Pure: whole-document tile residency (office live-gate fix #3)

/// Is the FULL extent of a document at `zoomPPT` — not merely its current viewport — small enough
/// to fetch as a whole, ahead of the user scrolling there? Pure and total: `TileMath
/// .estimatedTileCount` never traps regardless of how extreme `sizeTwips`/`zoomPPT` are, and this
/// function inherits that. `nil` (from `estimatedTileCount` itself refusing — overflow or past its
/// own `maxTilesPerRectEnumeration` — OR from exceeding `cap`) reads as "ineligible," the safe
/// direction: leave this one in today's viewport+margin lazy mode, never attempt a prefetch anyway.
/// Zero tiles (a degenerate empty document) is trivially eligible — there is nothing to prefetch.
func officeResidencyEligibleTileCount(sizeTwips: OfficeDocumentSize, zoomPPT: Int, cap: Int) -> Int? {
    let fullExtent = OfficeTwipsRect(x: 0, y: 0, width: sizeTwips.widthTwips, height: sizeTwips.heightTwips)
    guard let count = TileMath.estimatedTileCount(rectTwips: fullExtent, zoomPPT: zoomPPT), count <= cap else {
        return nil
    }
    return count
}

/// The whole-document prefetch's own ordering: every key in `fullExtentTwips`, the CURRENT visible
/// viewport's keys FIRST (the user is looking at them right now), then the rest ordered nearest-to-
/// farthest from the visible viewport's own center tile — squared distance in tile-INDEX space
/// (cheap integer arithmetic; the only place this could even disagree with true Euclidean distance
/// is tie-breaking, which the deterministic secondary sort below already fixes regardless). Pure and
/// total: only ever called after `officeResidencyEligibleTileCount` has already proven
/// `fullExtentTwips` safe to enumerate at `zoomPPT`.
func officeResidencyPrefetchOrder(part: Int, zoomPPT: Int, fullExtentTwips: OfficeTwipsRect,
                                   visibleViewportTwips: OfficeTwipsRect) -> [TileKey] {
    let visible = TileMath.viewportTileKeys(part: part, zoomPPT: zoomPPT, viewportTwips: visibleViewportTwips)
    let visibleSet = Set(visible)
    let centerX = TileMath.tileIndex(twip: visibleViewportTwips.x + visibleViewportTwips.width / 2, zoomPPT: zoomPPT)
    let centerY = TileMath.tileIndex(twip: visibleViewportTwips.y + visibleViewportTwips.height / 2, zoomPPT: zoomPPT)

    let rest = TileMath.tileCoordinates(rectTwips: fullExtentTwips, zoomPPT: zoomPPT)
        .map { TileKey(part: part, zoomPPT: zoomPPT, tileX: $0.tileX, tileY: $0.tileY) }
        .filter { !visibleSet.contains($0) }
        .sorted { lhs, rhs in
            let lhsDistance = officeSquaredTileDistance(lhs, centerX: centerX, centerY: centerY)
            let rhsDistance = officeSquaredTileDistance(rhs, centerX: centerX, centerY: centerY)
            if lhsDistance != rhsDistance { return lhsDistance < rhsDistance }
            // Deterministic tie-break — `TileMath.tileCoordinates` enumerates each coordinate
            // exactly once, so this never actually breaks a tie between duplicate keys; it exists so
            // the ORDER among equidistant tiles is exactly reproducible (a table test can assert one
            // exact array), not merely "some near-to-far order."
            return (lhs.tileY, lhs.tileX) < (rhs.tileY, rhs.tileX)
        }
    return visible + rest
}

/// Clips `viewportTwips` to `[0, sizeTwips.widthTwips) x [0, sizeTwips.heightTwips)` — generic over
/// whatever `sizeTwips` its caller passes; it has no opinion on what that extent MEANS. Used ONLY by
/// `performSubscribe`'s churn-audit skip-check (office live-gate fix #3) — the padded/margin
/// viewport (`OfficeTileCanvasView.subscribeMarginPoints`) deliberately overscans PAST a document's
/// true edge by design (fix #2's own "ask slightly wider, harmlessly" reasoning, `performSubscribe`'s
/// own comment). A document small enough to be fully resident is exactly the case where that
/// overscan reaches past its far edge on almost every scroll near it — and, for a NON-spreadsheet,
/// those phantom past-the-edge tiles will NEVER be cached (there is nothing there to paint), so
/// without this clip the skip-check would see them as perpetually "needing request" and never
/// actually skip for a resident document scrolled anywhere near an edge, which defeats the whole
/// point. **As of office live-gate fix #4, its spreadsheet caller passes an ALREADY-WIDENED
/// `effectiveExtentTwips`, not the bare used range** — genuinely paintable infinite-grid margin
/// tiles are deliberately left un-clipped by this same call, so the skip-check can still find real
/// work there (see that property's own header). Deliberately narrow: only the SKIP-CHECK's own key
/// computation is clamped — the ORIGINAL unconditional ask (every discrete call, and the throttled
/// leading-edge call once something genuinely is missing) still asks the full, un-clamped padded
/// viewport, exactly as fix #2 left it, so a document NOT yet fully resident keeps prefetching its
/// own true edge tiles at the same margin it always has. A degenerate (zero- or negative-area)
/// intersection collapses to a zero-size rect at the clamped origin, not a negative width/height —
/// `TileMath.viewportTileKeys` already reads a zero-area rect as "touches nothing," so this never
/// needs its own empty check.
func officeClampViewportToDocumentExtent(_ viewportTwips: OfficeTwipsRect, sizeTwips: OfficeDocumentSize) -> OfficeTwipsRect {
    let minX = max(viewportTwips.x, 0)
    let minY = max(viewportTwips.y, 0)
    let maxX = min(viewportTwips.x + viewportTwips.width, sizeTwips.widthTwips)
    let maxY = min(viewportTwips.y + viewportTwips.height, sizeTwips.heightTwips)
    return OfficeTwipsRect(x: minX, y: minY, width: max(0, maxX - minX), height: max(0, maxY - minY))
}

private func officeSquaredTileDistance(_ key: TileKey, centerX: Int, centerY: Int) -> Int {
    let dx = key.tileX - centerX
    let dy = key.tileY - centerY
    return dx * dx + dy * dy
}

/// Splits `keys` into groups of at most `size`, preserving order — the prefetch's own chunking,
/// pure and trivially testable. `size <= 0` degrades to one chunk per key rather than dividing by
/// zero or looping forever (defensive; every production call site passes a positive constant).
func officeChunked(_ keys: [TileKey], size: Int) -> [[TileKey]] {
    guard size > 0 else { return keys.map { [$0] } }
    var result: [[TileKey]] = []
    var index = 0
    while index < keys.count {
        let end = min(index + size, keys.count)
        result.append(Array(keys[index..<end]))
        index = end
    }
    return result
}

// MARK: - The representable

/// The SwiftUI seam onto the canvas — mirrors `EditorViewportView`'s posture (a viewport onto a
/// resource this struct does not own) at the SHAPE `PanelViewport`/`PanelCEFContainerView` take (the
/// view itself is created once and mutated in place across renders, never recreated by a `.document`
/// -to-`.document` update).
struct OfficeTileCanvasRepresentable: NSViewRepresentable {
    /// Registers/clears `model.canvasHost` — see `OfficeDocumentCanvasHost`'s own header. Not read
    /// for anything else; the canvas never touches `PanelDocumentTabModel`'s published state.
    let model: PanelDocumentTabModel
    let runtime: OfficeRuntime
    let path: String
    let docId: String
    let sizeTwips: OfficeDocumentSize
    /// Carried ONLY so SwiftUI notices a part change and calls `updateNSView` — mirrors
    /// `EditorViewportView.current`/`.hasModel`'s own carried-properties trick. The canvas re-reads
    /// its OWN `part` and compares; nothing here acts on this value directly.
    let activePart: Int

    func makeNSView(context: Context) -> OfficeTileCanvasView {
        let view = OfficeTileCanvasView(runtime: runtime, path: path, docId: docId,
                                        sizeTwips: sizeTwips, initialPart: activePart, model: model)
        view.mount()
        return view
    }

    /// The drift re-assert (mirrors `EditorViewportView.updateNSView`'s own doc on why
    /// `.activateOnly` exists), NOW ALSO the office-plumbing Task 8 (T6 review F4) reload seam:
    /// `documents[path].activePart` is written by ANY `subscribeTiles` call for this doc, including
    /// one the MODEL fired as a nominal placeholder before the canvas's own accurate one lands, and
    /// `docId`/`sizeTwips` change out from under this view exactly once — the moment a reload
    /// replaces the document with a freshly-minted docId. `syncDocumentIdentity` handles both: a
    /// no-op re-assert when nothing changed, and the reload seam when it did. See that method's own
    /// header for why this is NOT `.id(docId)` on the representable.
    func updateNSView(_ nsView: OfficeTileCanvasView, context: Context) {
        nsView.syncDocumentIdentity(docId: docId, sizeTwips: sizeTwips, activePart: activePart)
    }

    /// Obligation 1's own cross-file precedent (`EditorViewportView.dismantleNSView`,
    /// `PanelViewport.dismantleNSView`): explicit teardown, never a hope that deallocation alone is
    /// enough — `unmount` both unsubscribes from tiles and clears `model.canvasHost` if this view is
    /// still the registered one.
    static func dismantleNSView(_ nsView: OfficeTileCanvasView, coordinator: ()) {
        nsView.unmount()
    }
}

// MARK: - office live-gate fix #4: a tile layer that never implicitly animates

/// **The house pattern for a hand-minted `CALayer` an app repositions/recontents on every scroll
/// tick.** `NSView`'s own implicit-action suppression (the reason a layer-backed view's ordinary
/// property changes never visibly animate) is a `CALayerDelegate` relationship AppKit sets up
/// ONLY between the view and its OWN backing layer — it is never propagated to a sublayer the app
/// adds by hand (`relayoutVisibleTiles`'s tile layers, added via `hostLayer.addSublayer`). Such a
/// layer's `delegate` is `nil`, so it falls back to bare `CALayer`'s own default action table —
/// which DOES supply an implicit ~0.25s `CABasicAnimation` for "position"/"bounds" (what
/// `existing.frame = rect` touches on every reposition) once the layer is part of a genuinely
/// PRESENTED tree. Overriding `action(forKey:)` to unconditionally return `NSNull` is the
/// catch-all form — robust against every key this file happens to touch today ("position",
/// "bounds", "contents", "backgroundColor") AND any future one a later change starts touching,
/// unlike a fixed `.actions` dictionary that would silently miss a key nobody thought to list.
///
/// This is what makes `action(forKey:)` genuinely presentation-independent for THIS layer type —
/// see this file's own `subscribeMarginPoints` comment for the corrected account of why measuring
/// a layer that was never part of a live window read clean even before this fix existed.
///
/// **Kills IMPLICIT actions only.** An explicit `add(_:forKey:)` animation (a future deliberate
/// tile fade, say) still runs exactly as requested — `action(forKey:)` is Core Animation's
/// "what would happen automatically" query; it has no say over an animation the app adds by hand.
private final class OfficeTileLayer: CALayer {
    override func action(forKey event: String) -> CAAction? {
        NSNull()
    }
}

// MARK: - The canvas

/// office-plumbing Task 6 — **the tile canvas.** Layer-hosted (`wantsLayer = true`): one `CALayer`
/// per currently-visible tile, `contents` set to a `CGImage` built directly from the store's raw RGBA
/// `Data` (nothing to decode — T5.5's own ruling) or left as a solid `CardSurface`-toned
/// `backgroundColor` placeholder while the pixels are still in flight (obligation 4: never white).
///
/// **No `NSScrollView`** — scroll is driven directly off `scrollWheel(with:)`'s own delta/momentum
/// fields (obligation 9's "native momentum scroll": macOS keeps delivering momentum-phase events
/// after the fingers lift; this view simply keeps responding to them, the same posture
/// `TrackpadHorizontalSwipeRecognizer` takes toward the identical event stream one gesture axis
/// over). `scrollOrigin` is this view's own POINT-space content offset — the one piece of state
/// every other calculation in this file is a function of.
///
/// **Owns viewport math end to end**, including part switches (`OfficeDocumentCanvasHost
/// .setActivePart`) — see that protocol's own header for why the model does not.
final class OfficeTileCanvasView: NSView, OfficeDocumentCanvasHost {
    private let runtime: OfficeRuntime
    private let path: String
    /// **office-plumbing Task 8 (T6 review F4): mutable, not `let`, as of this task.** A reload
    /// replaces the open document with a freshly-minted docId (`OfficeRuntimeReducer.opened`'s own
    /// doc) while this SAME view instance keeps running — `syncDocumentIdentity` is the one place
    /// that updates it. Readable (not writable) from outside this file: `PanelDocumentTabTests`/
    /// `OfficeTileCanvasViewTests` pin that a reload's `.opened` actually reaches here.
    private(set) var docId: String
    /// Weak — registered as `model.canvasHost` in `mount()`, explicitly cleared in `unmount()` (the
    /// SwiftUI dismantle path). See `OfficeDocumentCanvasHost`'s own header for why this lives on
    /// the model rather than the runtime, and `EditorRuntime.viewportHost`'s doc for why the
    /// clearing must be explicit rather than trusted to weak zeroing (which does not run `didSet`
    /// and, here, could not reach the model's stored property from outside it anyway).
    private weak var model: PanelDocumentTabModel?
    /// The document's own USED range — captured at open time (`OfficeRuntimeState
    /// .DocumentEntry.sizeTwips`, itself LOK's `getDocumentSize()` at open) — **disclosed
    /// imprecision, unchanged by Task 8**: a multi-sheet spreadsheet's sheets can have different used
    /// ranges, and Stage A has no per-part size to clamp against instead (`OfficeRuntimeState`
    /// carries exactly one `sizeTwips` per document, not per part). NOT the bound scrolling itself
    /// clamps against for a spreadsheet as of office live-gate fix #4, FIX 2 — see
    /// `effectiveExtentTwips`'s own header for that, and why "scrolling past real content simply
    /// shows placeholders forever" (this comment's own pre-fix-#4 claim) is FALSE for spreadsheets
    /// now: `paintPartTile` genuinely renders empty gridded cells there, and the canvas actively
    /// requests them once scrolled near. Still exactly true for presentations/documents, and for
    /// this raw `sizeTwips` value's every OTHER reader in this file (the residency prefetch, in
    /// particular, deliberately stays scoped to the real content — see `evaluateResidencyIfNeeded`'s
    /// own `fullExtent`). **Mutable as of Task 8**: a reload's fresh `opened{}` carries its own
    /// `sizeTwips` — see `syncDocumentIdentity`'s own header for why this must be re-applied, and
    /// re-clamped against, rather than left at whatever the document held before.
    private var sizeTwips: OfficeDocumentSize

    /// office live-gate fix #4, FIX 2: gates the infinite-grid scroll margin (`effectiveExtentTwips`)
    /// to spreadsheets only. Captured once at open time and re-captured in `syncDocumentIdentity`,
    /// mirroring `sizeTwips`'s own capture pattern — a live `runtime.stateSnapshot.documents[path]?
    /// .type` dictionary lookup on every scroll tick (`clampedOriginX/Y` run at up to ~120Hz) would
    /// work but costs more than reading a bool the same way every other per-tick geometry input here
    /// already is read. `false` (never extend) if the lookup ever comes up empty — the safe direction,
    /// matching this file's own "refuse gracefully, never trap" posture throughout.
    private var isSpreadsheet: Bool

    private(set) var part: Int
    private(set) var zoomPPT: Int = 1000
    private var scrollOrigin: CGPoint = .zero

    private var isMounted = false
    private var tilesArrivedSink: AnyCancellable?
    private var tileLayers: [TileKey: CALayer] = [:]

    // MARK: - Office Stage B Task 5: caret/selection/cell-cursor overlays
    //
    // Reuses `OfficeTileLayer` directly (the SAME null-action CALayer subclass tile layers already
    // use, not a second copy of the identical 5 lines) — nothing about that class is tile-specific,
    // and the "OVERLAYS MUST NEVER ANIMATE" mandate applies with equal force here: a hand-added
    // sublayer's `hidden`/`opacity`/`backgroundColor`/`borderColor`/`frame` changes (every property
    // this section's own code below touches) all fall back to bare CALayer's default implicit-action
    // table once genuinely presented, exactly the mechanism `OfficeTileLayer`'s own header explains.

    /// The blinking text caret — created once in `mount()`, torn down in `unmount()`, repositioned/
    /// shown/hidden by `layoutOverlays()`. `zPosition = 2` — ABOVE both tiles (default 0, unset) and
    /// the selection fill (1): a caret minted before a tile that happens to paint later must not be
    /// silently buried under it (`addSublayer` always appends to the top of z-order at insertion
    /// time — a tile minted by a later `relayoutVisibleTiles` pass would otherwise stack above an
    /// EARLIER-inserted caret layer with no explicit `zPosition` to say otherwise).
    private var caretLayer: OfficeTileLayer?
    /// A pool of selection-fill layers, one per rect in the CURRENT selection — mirrors `tileLayers`'
    /// own reuse discipline, with one deliberate simplification: this pool only ever GROWS, never
    /// shrinks (`layoutSelectionLayers` hides surplus layers past the current rect count rather than
    /// removing them) — selections are bounded in practice (a handful of visual lines), and keeping a
    /// hidden layer around costs far less than the churn of tearing one down and re-minting it the
    /// next time the selection grows back. `zPosition = 1` — above tiles, below the caret.
    private var selectionLayers: [OfficeTileLayer] = []
    /// The Calc active-cell outline — an OUTLINE, not a fill (`borderWidth`/`borderColor`, no
    /// `backgroundColor`), so the cell's own content stays fully legible underneath, matching every
    /// spreadsheet app's own "active cell" convention. **Disclosed scope call, not a brief
    /// requirement**: the brief's own file list requires PARSING `CELL_CURSOR` (`OfficeCursorStore`
    /// already does), not necessarily drawing it — drawn anyway since it reuses this exact same
    /// null-action-layer/twips-transform/part-hide machinery for near-zero extra cost or risk.
    private var cellCursorLayer: OfficeTileLayer?

    private var cursorChangedSink: AnyCancellable?

    /// Caret blink — a plain `Timer`, ~530ms (`NSTextView`'s own long-established default interval;
    /// not pinned to any LOK/AppKit-exposed constant, since neither exposes one). Added to `.common`
    /// run-loop modes, not the timer's own default `.default` mode alone — AppKit suspends `.default`
    /// -mode timers during UI tracking loops (a window resize drag, a menu open), and a caret that
    /// visibly stops blinking mid-resize is exactly the kind of "looks broken" polish gap `.common`
    /// exists to close. **Invalidated in `unmount()`** — a live, un-invalidated repeating `Timer`
    /// keeps firing into a freed view's `[weak self]` closure forever otherwise (a real, if small,
    /// per-tab leak of run-loop wakeups for the rest of the app's life), the same "explicit teardown,
    /// never hope" posture `unmount()`'s own header already takes toward `tilesArrivedSink`.
    private var caretBlinkTimer: Timer?
    private var caretBlinkPhaseVisible = true
    private static let caretBlinkInterval: TimeInterval = 0.53

    /// Leading-edge throttle, obligation 3: the FIRST viewport change in a burst asks immediately,
    /// then at most one more ask per `Self.subscribeThrottleInterval` for as long as more changes
    /// keep arriving, and settles the moment they stop. A plain debounce (delay every ask until
    /// activity stops) was considered and rejected: it would leave a slow, deliberate scroll showing
    /// nothing until the user paused, and this app's own "display cadence" framing calls for tiles
    /// progressively arriving DURING a scroll, not only after one.
    private static let subscribeThrottleInterval: TimeInterval = 1.0 / 60.0
    private var isSubscribeThrottled = false
    private var subscribePendingSinceThrottle = false

    /// office live-gate fix #2 (Bug 2's root cause, and Bug 1's — see this constant's use in
    /// `performSubscribe` for the full mechanism). A more obvious-looking cause was investigated and
    /// falsified by direct measurement first, not by reading alone — `scrollOrigin` quantizing to the
    /// 256pt tile grid; see `OfficeTileCanvasViewTests`' own header comment on the tests below, with
    /// the evidence. `scrollOrigin` accumulation was already exact.
    ///
    /// **A SECOND hypothesis — a tile's `CALayer` implicitly animating on reposition — was also
    /// raised here and dismissed at the time ("measured directly via `animationKeys()`... empty both
    /// times... AppKit disables implicit layer actions by default outside an explicit animation
    /// context"). That dismissal was WRONG, re-verified honestly under office live-gate fix #4 (the
    /// user's own live report: "each moves INDIVIDUALLY and has a lot of SMOOTHING"). The true
    /// mechanism: AppKit's implicit-action suppression is a delegate relationship it sets up ONLY
    /// between an `NSView` and its own backing layer — never propagated to a hand-minted sublayer
    /// (`relayoutVisibleTiles`'s tile layers, added via `addSublayer`), which fall back to bare
    /// CALayer's default action table instead. That table only has something to offer once a layer
    /// is part of a genuinely PRESENTED tree (a live window) — which is exactly why the original
    /// "measured... empty" claim read clean: it was never checked inside one. See
    /// `OfficeTileLayer`'s own header, below, and `OfficeTileCanvasViewTests`' fix-#4 section for the
    /// corrected measurement (a real, presented `NSWindow`, `animationKeys()` genuinely non-empty
    /// pre-fix).** The actual felt cause of fix #2 itself, unaffected by any of this:
    /// `performSubscribe` used to ask the store for EXACTLY the on-screen viewport and nothing more,
    /// so every scroll tick that crossed a 256pt tile line exposed a tile nobody had asked for yet,
    /// visible only as `resolvedPlaceholderColor()` until an async subscribe -> helper-render ->
    /// arrival round trip landed (measured ~26-28ms/tile even warm — `OfficeHarness.performTileCold3`'s
    /// own PERF NOTE — and often longer once queued behind the leading-edge subscribe throttle). One
    /// tile span of overscan on every edge means the next tile out is asked for BEFORE the user
    /// actually scrolls onto it, so ordinary-speed scrolling much more often arrives to already-warm
    /// data. This pads the SUBSCRIBE request only — `relayoutVisibleTiles` keeps rendering exactly the
    /// tight visible rect; nothing renders early, only fetches early.
    private static let subscribeMarginPoints: CGFloat = CGFloat(TileMath.tilePixelSize) / officeFixedDeviceScale

    /// office live-gate fix #2: counts every `applyContents` call — the pin that a mere reposition
    /// (an existing, still-visible tile whose layer is just moving) no longer re-touches
    /// `contents`/`backgroundColor` on every scroll tick the way it did before this fix (see
    /// `relayoutVisibleTiles`'s own comment on its reposition-only branch).
    private(set) var applyContentsCallCountForTesting = 0

    // MARK: - office live-gate fix #3: whole-document tile residency

    /// How many keys one prefetch wire round trip asks for. The helper paints a `tileRequest`'s keys
    /// SERIALLY on the app's ONE shared connection before it can even read the next line off the
    /// wire (`OfficeHelperServer.handlePostAuthLine`'s `.tileRequest` case — a straight `for key in
    /// keys` loop, no concurrency) — a single whole-document request would pin that connection for
    /// the entire fill (measured ~26-28ms/tile even warm, `Self.subscribeMarginPoints`'s own
    /// comment), starving every other tab and the user's own next scroll for however long the fill
    /// takes. Chunking bounds that pin to one chunk's worth at a time; picked at the LOW end of the
    /// live-gate brief's own "~6-8" range, not the high end, to minimize how long a genuinely urgent
    /// request can be stuck behind an in-flight chunk — see `beginPrefetch`'s own header for the
    /// honest latency bound this buys (bounded, not preemptive).
    private static let prefetchChunkSize = 6

    /// Memoizes the last `(part, zoomPPT)` residency was evaluated for, so `evaluateResidencyIfNeeded`
    /// — called from every discrete trigger (part switch, zoom) AND from the scroll throttle's own
    /// trailing settle edge (covers resize and pinch-zoom settling; see `scheduleThrottledSubscribe`)
    /// — is a cheap two-int comparison on the calls that are NOT actually a part/zoom change (the
    /// overwhelming majority: every ordinary scroll/resize tick).
    ///
    /// **`nil` until the FIRST evaluation that genuinely ran against usable bounds.** `mount()` DOES
    /// call `evaluateResidencyIfNeeded()` directly (document-open is one of the brief's own
    /// triggers), but at `makeNSView` return, in ordinary production use, SwiftUI has not sized this
    /// view yet (`bounds` is still zero) — that call finds nothing to do. The load-bearing property
    /// is that it must NOT memoize a zero-bounds no-op as if a real evaluation happened: if it did,
    /// it would permanently suppress the real evaluation once bounds actually arrive (a LIVE-only bug
    /// no test would catch, since every test in this file sets `frame` BEFORE `mount()`, so `mount`'s
    /// own call already IS the real evaluation there). This memo is therefore only ever written from
    /// inside `evaluateResidencyIfNeeded`'s own `bounds > 0` guard, never before it — in production,
    /// the resize this view receives once AppKit actually lays it out (`resizeSubviews` ->
    /// `scheduleThrottledSubscribe` -> the settle edge) is what performs the real first evaluation.
    private var lastResidencyEvaluation: (part: Int, zoomPPT: Int)?

    /// Bumped every time a NEW prefetch sweep starts, and on `unmount()`. The prefetch loop captures
    /// its own value at start and re-checks it before EVERY chunk — mirrors `OfficeRuntime.generation`'s
    /// identical role for a stale open: a part switch, zoom change, reload, or unmount that happens
    /// mid-sweep must stop the OLD sweep from issuing further chunks for a target that is no longer
    /// current, without needing real cancellation — a chunk already in flight when this bumps is left
    /// to complete harmlessly (mirrors `OfficeHelperRequestQueue`'s own "no cancellation semantics,
    /// and none are needed").
    private var prefetchGeneration = 0

    /// Test/debug visibility only — how many chunks of the current (or most recently completed)
    /// sweep have been PROCESSED (offered to `OfficeRuntime.prefetchTilesChunk` and returned).
    /// **Not** a wire-request count: a chunk where every key was already cached or already in
    /// flight is filtered to zero keys inside `prefetchTilesChunk`'s own `requestNeeded` and still
    /// counts here, since from this sweep's point of view the chunk was handled either way. Assert
    /// wire-level traffic on a test double's own `requestCalls`/`subscribeCalls`, never on this.
    private(set) var prefetchChunksIssuedForTesting = 0
    /// Test/debug visibility only. **Means "every chunk of the current sweep was ISSUED," never
    /// "every tile has arrived and is cached."** A chunk's own pixels stream back asynchronously
    /// (`OfficeTileStore.ingest`, off `tilesArrived`) well after its `requestTiles` ack — a test that
    /// wants to assert actual residency must poll `runtime.tileStore.tile(docId:key:)` for every
    /// expected key, the same way every other tile-arrival test in this file already does, not trust
    /// this flag alone.
    private(set) var prefetchSweepIssuedForTesting = false

    /// The live-gate MEASURE step's own instrument: how many times a relayout pass found a VISIBLE
    /// tile with nothing cached for it yet — a placeholder frame the user would actually see
    /// mid-swipe, the "another page comes on top" report this whole fix exists to close. Counted in
    /// `relayoutVisibleTiles` for EVERY currently-visible key, whether its layer is new or a
    /// repositioned survivor — not only at layer creation — so a swipe that re-exposes a key whose
    /// layer was torn down and rebuilt (scrolled away and back within one throttle window) counts too.
    private(set) var visiblePlaceholderDrawCountForTesting = 0

    init(runtime: OfficeRuntime, path: String, docId: String, sizeTwips: OfficeDocumentSize,
         initialPart: Int, model: PanelDocumentTabModel) {
        self.runtime = runtime
        self.path = path
        self.docId = docId
        self.sizeTwips = sizeTwips
        self.isSpreadsheet = runtime.stateSnapshot.documents[path]?.type == .spreadsheet
        self.part = max(0, initialPart)
        self.model = model
        super.init(frame: .zero)
        wantsLayer = true
        // USER LIVE-GATE FIX (tile overdraw): this view manages its OWN pool of raw `CALayer`s
        // (`tileLayers`, added straight onto `hostLayer` in `relayoutVisibleTiles`) rather than
        // hosting a child `NSView` the way `PanelCEFContainerView`/`EditorViewportHostView` do —
        // checked both for precedent, and neither needed this: CEF's own view is always resized to
        // exactly `bounds` (`PanelCEFContainerView.resizeSubviews`: `subview.frame = bounds`), so it
        // has nothing to overflow. A tile grid is different by construction: `relayoutVisibleTiles`
        // asks `TileMath.viewportTileKeys` for every tile the current viewport TOUCHES, and a
        // viewport edge almost never lands on an exact 256pt tile boundary — the tile straddling that
        // edge is legitimately positioned partially outside `bounds` (needed for the sliver of it that
        // IS visible). A freshly-vended `CALayer` (including AppKit's own auto-backing layer) has
        // `masksToBounds == false` by default, so nothing cropped that overflow — it kept compositing
        // into whatever the panel stacks beyond this view's own frame, which is exactly the "leaks
        // outside the sidebar border on scroll" symptom. `true` here crops every sublayer to this
        // view's own bounds at the COMPOSITING level, independent of whatever any ancestor view does
        // or does not clip — the narrowest fix, since it stops the leak at its source rather than
        // hoping something upstream catches it. Safe for the strip/banner overlays
        // (`OfficeSheetTabStrip`/`OfficeSlideRail`/`OfficeDocumentBannerView`): those are separate
        // SwiftUI siblings composed around `OfficeTileCanvasRepresentable` in `OfficeDocumentSurface`/
        // `PanelDocumentContent`, never sublayers of THIS view's own `hostLayer` — masksToBounds here
        // has no reach into them at all. Pinned: `OfficeTileCanvasViewTests
        // .testHostingLayerMasksSublayersToBounds` (Bug 1 of the office live gate).
        layer?.masksToBounds = true
        layer?.backgroundColor = resolvedPlaceholderColor() // obligation 4: never white, from frame 1
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("OfficeTileCanvasView is never unarchived") }

    /// Document space is top-down (twips increase downward, matching every `OfficeTwipsRect` this
    /// file reads) — `NSView` defaults to bottom-up. Without this every tile's `y` is upside down.
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    // MARK: - Lifecycle (subscribe/unsubscribe on mount/dismantle — obligation: resubscribe on
    // mount, matching a hidden-but-still-open tab's tiles not consuming bandwidth while unseen)

    func mount() {
        guard !isMounted else { return }
        isMounted = true
        model?.canvasHost = self
        tilesArrivedSink = runtime.tileStore.tilesArrived.sink { [weak self] arrival in
            guard let self, arrival.docId == self.docId else { return }
            self.handleTilesArrived(arrival.keys)
        }
        relayoutVisibleTiles()
        performSubscribe()
        // office live-gate fix #3: "document open" is one of the brief's own triggers. Safe to call
        // even when `bounds` is still zero at this exact instant (the ordinary production case —
        // SwiftUI has not sized this view yet at `makeNSView` return) because
        // `evaluateResidencyIfNeeded`'s own `bounds > 0` guard makes that a pure no-op that writes
        // NOTHING to `lastResidencyEvaluation` — see that property's own header for why a memo
        // written against zero bounds would be the actual bug. This call is what gives "document
        // open" its own direct, reliably-testable trigger (every test in this file sets `frame`
        // BEFORE `mount()`) rather than depending solely on the indirect resize path below.
        evaluateResidencyIfNeeded()
        mountCursorOverlays() // Office Stage B Task 5
    }

    /// SwiftUI is finished with this view. Unsubscribes (a hidden-but-still-open tab's tiles stop
    /// consuming bandwidth) and clears `model.canvasHost` — **only if this view is still the
    /// registered host** (mirrors `EditorViewportHostView.detachFromRuntime`'s identical guard):
    /// SwiftUI does not promise to dismantle an outgoing view before building an incoming one, so a
    /// later part-strip click reaching a NEWER canvas must not be undone by an OLDER one's delayed
    /// teardown.
    func unmount() {
        guard isMounted else { return }
        isMounted = false
        // office live-gate fix #3: stop any in-flight prefetch sweep from issuing further chunks —
        // belt-and-suspenders alongside `beginPrefetch`'s own `isMounted` check (which `isMounted =
        // false` right above already satisfies on its own; this makes the "why" independently
        // greppable at the actual teardown site).
        prefetchGeneration += 1
        tilesArrivedSink = nil
        runtime.unsubscribeTiles(path: path)
        if model?.canvasHost === self { model?.canvasHost = nil }
        unmountCursorOverlays() // Office Stage B Task 5
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard window != nil else { return }
        window?.makeFirstResponder(self)
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        scrollOrigin = CGPoint(x: clampedOriginX(scrollOrigin.x), y: clampedOriginY(scrollOrigin.y))
        relayoutVisibleTiles()
        scheduleThrottledSubscribe()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = resolvedPlaceholderColor()
        repaintAllVisibleTiles() // repaints every currently-placeholder tile in the new appearance's tone
        // Office Stage B Task 5 — `layoutOverlays()` re-resolves `resolvedAccentColor()` fresh on
        // EVERY call (never cached), so simply calling the standalone wrapper here is enough to pick
        // up the new appearance's own accent rendering — the identical "never resolve once and
        // cache" posture `resolvedPlaceholderColor()` one line up already established.
        refreshOverlays()
    }

    // MARK: - OfficeDocumentCanvasHost (the part-strip's own door)

    /// Discrete user action — resets scroll to the part's origin (mirrors how a spreadsheet/deck
    /// app conventionally lands a sheet/slide switch) and resubscribes IMMEDIATELY, bypassing the
    /// throttle: "part-switch resubscribes" is its own named test, not a continuation of a scroll
    /// burst.
    func setActivePart(_ newPart: Int) {
        guard newPart >= 0, newPart != part else { return }
        part = newPart
        scrollOrigin = .zero
        clearVisibleTiles()
        relayoutVisibleTiles()
        performSubscribe()
        evaluateResidencyIfNeeded() // office live-gate fix #3: a part switch is one of the brief's own triggers
    }

    // MARK: - office-plumbing Task 8 (T6 review F4): the reload seam

    /// **Runs on EVERY `updateNSView`, not only when a reload happened** — this SUBSUMES the old
    /// `setActivePart(activePart)`-only drift re-assert; see that method's own doc for why re-
    /// applying a part that already matches must stay a no-op, which still holds on the `else`
    /// branch below.
    ///
    /// Before this task, `docId`/`sizeTwips` were `let`: nothing ever told this view a RELOAD had
    /// replaced the document underneath it with a freshly-minted docId
    /// (`OfficeRuntimeReducer.opened`'s own doc — a reload IS a new docId, by construction of how
    /// `.reloadDocument` reopens). Without this, `applyContents`'s `runtime.tileStore.tile(docId:
    /// self.docId, ...)` read and `mount()`'s `tilesArrived` filter (`arrival.docId == self.docId`)
    /// would both keep comparing against the OLD, already-evicted docId forever — every tile stays a
    /// placeholder, permanently. That was the T6 review's F4 finding.
    ///
    /// **Deliberately NOT `.id(docId)` on the representable** — the alternative the review named
    /// alongside this one, and the more obvious-looking fix. Rejected because it is wrong for THIS
    /// task specifically: `.id(docId)` forces SwiftUI to tear down and rebuild this whole `NSView` on
    /// every reload (`dismantleNSView` -> `unmount()`, then a fresh `makeNSView`), which would reset
    /// `scrollOrigin` to `.zero` and `zoomPPT` to its 100% default — losing exactly the view state
    /// (`{activePart, scrollTwips, zoomPPT}`) this task exists to PRESERVE. Mutating in place costs
    /// no more code and keeps both untouched for free, since they are this view's own ivars and nei-
    /// ther a reload nor this method ever recreates the view.
    func syncDocumentIdentity(docId newDocId: String, sizeTwips newSizeTwips: OfficeDocumentSize, activePart: Int) {
        guard newDocId != docId else {
            setActivePart(activePart) // the pre-Task-8 drift re-assert, unchanged
            return
        }
        docId = newDocId
        sizeTwips = newSizeTwips
        // office live-gate fix #4, FIX 2: re-captured alongside `sizeTwips` on the same reasoning —
        // a reload cannot actually change a document's KIND, but re-reading costs nothing and keeps
        // this from being the one place `isSpreadsheet` silently drifts from `sizeTwips`'s own
        // freshness guarantee.
        isSpreadsheet = runtime.stateSnapshot.documents[path]?.type == .spreadsheet
        // Never `setActivePart` here — that method zeroes `scrollOrigin` (correct for a discrete
        // part-strip click, wrong for a reload, which must PRESERVE scroll) and would also skip
        // entirely if `activePart` happens to already equal `part`, leaving the stale docId's layers
        // in place. Assigned directly instead; `clearVisibleTiles()` below is what actually matters.
        part = max(0, activePart)
        // N1 (T8 fix-round review, disclosed, one sentence): when a shrunken reload's clamped-down
        // `activePart` (the reducer's own clamp, upstream of this call) lands `part` on a DIFFERENT
        // part than the one last shown, `scrollOrigin` below is still only re-clamped, never reset —
        // deliberate, since preserving scroll is this task's own requirement, but it can leave the
        // view sitting at an arbitrary offset on a sheet the user was never looking at.
        // The old docId's tile-store entries are already gone — `OfficeRuntime`'s `.reloadDocument`
        // effect performer evicts them (`tileStore.evictAll(docId:)`) before the new open even
        // starts — so every currently-laid-out layer would otherwise keep showing the LAST FRAME of
        // a document that no longer exists rather than the placeholder tone obligation 4 requires.
        clearVisibleTiles()
        // T8 interface obligation 3: re-clamp against the FRESH size — a reload can change how much
        // document there is (this view's own disclosed imprecision, above), so the OLD size's clamp
        // could now be wrong in either direction. `scrollOrigin` itself is READ, never reset — this
        // is the actual preservation, not merely the absence of a reset.
        scrollOrigin = CGPoint(x: clampedOriginX(scrollOrigin.x), y: clampedOriginY(scrollOrigin.y))
        relayoutVisibleTiles()
        performSubscribe()
        // office live-gate fix #3: a reload is one of the brief's own triggers, and must be
        // evaluated even when `part`/`zoomPPT` happen to be unchanged — a reload can still carry a
        // different `sizeTwips` (a shrunk or grown document), which changes eligibility on its own.
        // The memo reset forces `evaluateResidencyIfNeeded` past its `(part, zoomPPT)` short-circuit;
        // the direct generation bump is belt-and-suspenders for the (live-only, not exercised by any
        // test here) edge case of a reload landing while `bounds` is still zero, which would
        // otherwise leave a superseded sweep from the OLD document free to keep issuing chunks
        // against the NEW docId under geometry computed for content that no longer applies.
        lastResidencyEvaluation = nil
        prefetchGeneration += 1
        evaluateResidencyIfNeeded()
    }

    // MARK: - Test seams (office-plumbing Task 8)

    /// A synthetic `NSEvent(.scrollWheel)` has no public convenience initializer in AppKit — this
    /// lets a test establish a NONZERO scroll position directly, the same shape
    /// `PanelDocumentTabModel.refreshForTesting()` already uses for an analogous reason. Clamped
    /// through the same path `scrollWheel(with:)` itself uses, so a test cannot accidentally assert
    /// against an out-of-bounds value production code could never actually reach.
    func setScrollOriginForTesting(_ point: CGPoint) {
        scrollOrigin = CGPoint(x: clampedOriginX(point.x), y: clampedOriginY(point.y))
    }
    var scrollOriginForTesting: CGPoint { scrollOrigin }

    /// office live-gate fix #4: the CALayer minted for `key`, if currently in the visible pool — lets
    /// a test inspect a REAL tile layer's implicit-action behavior (`action(forKey:)`, `animationKeys()`,
    /// `presentation()`) through the exact production minting/reposition path (`relayoutVisibleTiles`),
    /// rather than a hand-built `CALayer()` that would only prove the TEST's own layer never animates.
    func tileLayerForTesting(_ key: TileKey) -> CALayer? { tileLayers[key] }

    /// A synthetic `NSEvent(.magnify)` is equally awkward to construct — this reaches the SAME
    /// `applyZoom` a real pinch/⌘± gesture reaches and then subscribes immediately, mirroring
    /// `zoomStep`'s own two-call shape (a test's zoom is a discrete action, like ⌘±, not a continuous
    /// pinch) — so a test establishes a non-default zoom through the identical clamp/resubscribe path
    /// production code uses, not a hand-rolled shortcut.
    @discardableResult
    func setZoomForTesting(_ zoomPPT: Int) -> Bool {
        guard applyZoom(zoomPPT) else { return false }
        performSubscribe()
        evaluateResidencyIfNeeded() // mirrors `zoomStep`'s own two-call shape — see that method's doc
        return true
    }

    // MARK: - Scroll (native momentum, no NSScrollView — obligation 9)

    override func scrollWheel(with event: NSEvent) {
        guard event.type == .scrollWheel else { return super.scrollWheel(with: event) }
        // T6 review F1: `scrollingDeltaX/Y` already carries the user's Natural-Scrolling preference
        // (that's why `NSScrollView` never consults `isDirectionInvertedFromDevice` for content
        // scrolling either) — `TrackpadHorizontalSwipeRecognizer` compensates via that flag because
        // it wants the PHYSICAL finger direction for a gesture, not content motion. Re-inverting here
        // canceled the OS's own inversion, so the canvas scrolled backwards vs. the chat
        // transcript/sidebar/editor in the same window for every default-setting (Natural Scrolling
        // ON) user. `origin -= delta` alone is correct for this view's flipped, top-down origin.
        applyScrollDelta(dx: event.scrollingDeltaX, dy: event.scrollingDeltaY)
    }

    /// office live-gate fix #2 (Bug 2, vertical "glue points"): the real path's own body, split out
    /// of `scrollWheel(with:)` as a thin NSEvent-unwrapping shim over this — a headless test can
    /// drive the EXACT accumulate/clamp/relayout sequence a real trackpad tick drives without
    /// constructing a synthetic `NSEvent(.scrollWheel)` (no public AppKit initializer exists for one
    /// — see `setScrollOriginForTesting`'s own note, immediately below). Unlike that method, THIS one
    /// goes through `relayoutVisibleTiles()`/`scheduleThrottledSubscribe()` exactly as production
    /// scrolling does — it is the free-scroll accumulation itself, not a test-only shortcut around it.
    func applyScrollDelta(dx: CGFloat, dy: CGFloat) {
        scrollOrigin = CGPoint(x: clampedOriginX(scrollOrigin.x - dx), y: clampedOriginY(scrollOrigin.y - dy))
        relayoutVisibleTiles()
        scheduleThrottledSubscribe()
    }

    // MARK: - office live-gate fix #4, FIX 2: the infinite grid (spreadsheets only)

    /// Excel-style "the grid keeps going" — empirically justified, not assumed. `paintPartTile`
    /// genuinely renders empty, gridded cells for twips rects past `sizeTwips` (probed directly
    /// against gate.xlsx on our own vendored LOK pin, well past the used range —
    /// `OfficeHelperLiveTests.testGateXlsxTilesPastTheUsedRangeEmpiricalInfiniteGridProbe`'s own PNG
    /// dump: a clean gridded canvas, not blank white and not garbage, unchanged all the way out to
    /// ~4x the document's own span beyond its edge). Screens, not a fixed twips constant, so the
    /// extra room scales with whatever the panel's own current size/zoom happens to be. A FIXED
    /// margin, not Collabora's own grow-on-approach — the simpler of the two shapes the live-gate
    /// brief names, and sufficient: nothing here claims a TRUE infinite grid, only that the canvas
    /// no longer stops dead exactly at the used range.
    private static let infiniteGridExtraScreens: CGFloat = 2

    /// The extent scrolling AND the subscribe skip-check actually reach — `sizeTwips` (the used
    /// range) plus `Self.infiniteGridExtraScreens` extra screens on each axis, for spreadsheets only
    /// (`isSpreadsheet`'s own header: presentations/documents have genuine fixed page bounds, never
    /// probed for this behavior, and are not assumed to share it). ONE computed property feeding
    /// BOTH `clampedOriginX/Y` (how far scrolling itself may go) AND `performSubscribe`'s skip-check
    /// clamp (`officeClampViewportToDocumentExtent`'s own call site) — a single source of truth so
    /// the two can never disagree. A disagreement in that direction is a real, reachable bug this
    /// property exists to foreclose: if scrolling reached further than the skip-check's own clamp,
    /// the margin would be scrollable but its tiles would never actually get REQUESTED — the
    /// skip-check would see nothing out there as ever "needing" a request and skip forever,
    /// placeholders forever, past the fix's own margin this time rather than past `sizeTwips` the
    /// way an un-widened skip-check would have reintroduced.
    ///
    /// **Interacts with office live-gate fix #3's whole-document residency** at exactly the edge of
    /// a small, fully-resident spreadsheet: the fixed `Self.subscribeMarginPoints` overscan the
    /// throttled skip-check always pads by can now genuinely reach past a small document's own
    /// `sizeTwips` edge into REAL, never-prefetched margin territory (the residency sweep's own
    /// `fullExtent` deliberately stays scoped to `sizeTwips`, never this wider extent — eagerly
    /// prefetching the whole margin would blow the residency cap's own budget for every spreadsheet).
    /// The result is a ONE-TIME warm the first time a resident document's edge is approached, not a
    /// standing chatter leak — proven, not merely asserted, by
    /// `testResidentDocumentIsPrefetchedWholeInVisibleFirstChunksAndPostFillScrollingIssuesNoFurther
    /// Requests`'s own two-phase amendment (office live-gate fix #4's own report has the measurement).
    private var effectiveExtentTwips: OfficeDocumentSize {
        guard isSpreadsheet else { return sizeTwips }
        let marginWidthPixels = Int(Self.infiniteGridExtraScreens * bounds.width * officeFixedDeviceScale)
        let marginHeightPixels = Int(Self.infiniteGridExtraScreens * bounds.height * officeFixedDeviceScale)
        return OfficeDocumentSize(
            widthTwips: sizeTwips.widthTwips + TileMath.pixelsToTwips(marginWidthPixels, zoomPPT: zoomPPT),
            heightTwips: sizeTwips.heightTwips + TileMath.pixelsToTwips(marginHeightPixels, zoomPPT: zoomPPT))
    }

    private func clampedOriginX(_ x: CGFloat) -> CGFloat {
        let widthPixels = TileMath.twipsToPixels(effectiveExtentTwips.widthTwips, zoomPPT: zoomPPT)
        let maxOrigin = max(0, CGFloat(widthPixels) / officeFixedDeviceScale - bounds.width)
        return min(max(0, x), maxOrigin)
    }

    private func clampedOriginY(_ y: CGFloat) -> CGFloat {
        let heightPixels = TileMath.twipsToPixels(effectiveExtentTwips.heightTwips, zoomPPT: zoomPPT)
        let maxOrigin = max(0, CGFloat(heightPixels) / officeFixedDeviceScale - bounds.height)
        return min(max(0, y), maxOrigin)
    }

    // MARK: - Zoom (pinch continuous, ⌘±/⌘0 ladder-stepped — obligation 9)

    override func magnify(with event: NSEvent) {
        let proposed = Int((CGFloat(zoomPPT) * (1 + event.magnification)).rounded())
        guard applyZoom(proposed) else { return }
        scheduleThrottledSubscribe()
    }

    // MARK: - Real input (Office Stage B Task 4 — the edit verbs: keyboard + mouse)

    /// **Scope disclosure**: bound to this view's own `keyDown`, not a main-menu command. The main
    /// menu is shared app-wide state this task did not want to touch mid-panel-work — a menu item
    /// with a key equivalent is the natural follow-up once a second surface needs the same shortcut.
    /// `acceptsFirstResponder`/the window-join `makeFirstResponder` above are what make this reach
    /// the view at all.
    ///
    /// **Office Stage B Task 4 — retires the beep.** The `default: super.keyDown(with: event)` arm
    /// below is UNCHANGED — the ⌘-shortcut policy this task's brief names (app chrome keeps
    /// ⌘S/⌘W/⌘±/⌘Z-family) is exactly "⌘± are the only Cmd-combos this view claims for itself;
    /// everything else Cmd-held falls to `super`, which is how ⌘S/⌘W/⌘Z already reach whatever
    /// ALREADY handles them further up the responder chain / as a main-menu key equivalent (checked
    /// by AppKit's own `performKeyEquivalent:` BEFORE `keyDown:` dispatch ever reaches a first
    /// responder at all, for any Cmd-combo that IS a registered menu item's key equivalent) — this
    /// view was never in that path and this task does not put it there. The NEW behavior is the
    /// `guard` itself: every key WITHOUT `.command` held — which is every printable character, every
    /// arrow (shift-selection included, since Shift's own bit rides along in `modifierFlags`
    /// unconditionally), Return/Tab/Delete/Escape, Option-modified characters, and a bare Control
    /// combo — now reaches `forwardKeyEvent` instead of falling through to `super`'s terminal
    /// `NSBeep()`.
    ///
    /// **Fix round 1, m6 (confirmed brief gap) — the ⌘C/⌘V/⌘X outcome, named explicitly, as the
    /// brief required.** These three are ordinary Cmd-combos under this same policy — not claimed by
    /// this view's own `switch` (only `+`/`=`/`-`/`_`/`0` are) — so they fall to
    /// `super.keyDown(with:)` exactly like ⌘S/⌘W/⌘Z. Unlike those three, though, nothing in this
    /// app's responder chain or main menu currently IMPLEMENTS `copy(_:)`/`cut(_:)`/`paste(_:)` (no
    /// `NSTextInputClient` conformance, no pasteboard wiring — that is Task 5/6 territory, alongside
    /// IME) — so `performKeyEquivalent:` finds no enabled target for the standard Edit-menu items
    /// those combos are normally bound to (a menu item with no live target validates as disabled),
    /// the match fails, and the event falls through to `keyDown:` on this view exactly like any
    /// other unclaimed Cmd-combo. The result, PRE-Task-6, is deliberate and disclosed, not a bug:
    /// **disabled menu items → `super.keyDown(with:)` → `NSView`'s own terminal `NSBeep()`.** Copy/
    /// cut/paste do nothing and beep until a future task gives them a real LOK-backed implementation
    /// (`getTextSelection`/`paste()`/`.uno:Copy` are the likely doors — not built here).
    override func keyDown(with event: NSEvent) {
        guard event.modifierFlags.contains(.command) else {
            forwardKeyEvent(event, type: .keyInput)
            return
        }
        switch event.charactersIgnoringModifiers {
        case "+", "=": zoomStep(officeZoomIn(current: zoomPPT))
        case "-", "_": zoomStep(officeZoomOut(current: zoomPPT))
        case "0": zoomStep(1000)
        default: super.keyDown(with: event)
        }
    }

    /// Office Stage B Task 4 — the `keyDown` mirror LOK's own vocabulary always wanted a second half
    /// for (`LOK_KEYEVENT_KEYUP`) but Stage A never had a door to send it through. Same Cmd-held
    /// gate as `keyDown` — a Cmd-combo's own key-up is exactly as much "app chrome's business, not
    /// LOK's" as its key-down half was.
    override func keyUp(with event: NSEvent) {
        guard !event.modifierFlags.contains(.command) else {
            super.keyUp(with: event)
            return
        }
        forwardKeyEvent(event, type: .keyUp)
    }

    /// **The text-generating/navigation seam Task 5 needs, made explicit rather than fused.** Both
    /// arms call the identical `runtime.postKeyEvent` today — Task 4 has no IME to route through,
    /// and every key this view forwards (printable characters AND navigation) genuinely does belong
    /// on the wire either way. The branch exists anyway because Task 5's own job is to take AWAY the
    /// text-generating arm's direct call here and replace it with `interpretKeyEvents([event])` (an
    /// `NSTextInputClient` conformance this view does not have yet), routing through
    /// `insertText(_:replacementRange:)` instead so dead keys/composition/CJK input methods work —
    /// while the navigation arm (arrows, Delete, Return, Tab, Escape, function keys) must stay
    /// EXACTLY as it is here, since IME has no opinion about a key that produces no text. Deciding
    /// "text-generating" the same way `OfficeInputCodes.charCode` itself does (a non-zero Unicode
    /// scalar from `charactersIgnoringModifiers`) keeps the classification and the wire encoding
    /// using the identical source of truth, so they can never disagree about which arm a given key
    /// falls into.
    private func forwardKeyEvent(_ event: NSEvent, type: OfficeKeyEventType) {
        // Office Stage B Task 5 — "blink pauses while typing": every forwarded key (text-generating
        // OR navigation — an arrow key moving the caret is exactly as much "the user is actively
        // paying attention to the caret right now" as a printed character) snaps the caret solidly
        // visible and restarts the blink-off countdown, the standard macOS caret feel.
        resetCaretBlink()
        let keyCode = OfficeInputCodes.lokKeyCode(appKitKeyCode: event.keyCode, modifierFlags: event.modifierFlags)
        let isTextGenerating = OfficeInputCodes.charCode(for: event.charactersIgnoringModifiers) != 0
        if isTextGenerating {
            // TEXT-GENERATING — Task 5 replaces this call with `interpretKeyEvents([event])`.
            let charCode = OfficeInputCodes.charCode(for: event.characters)
            runtime.postKeyEvent(path: path, type: type, charCode: charCode, keyCode: keyCode)
        } else {
            // NAVIGATION/non-printing — stays exactly this shape after Task 5.
            runtime.postKeyEvent(path: path, type: type, charCode: 0, keyCode: keyCode)
        }
    }

    /// A left-button press — positions LOK's own cursor/selection (there is no other door to do
    /// this now that the DEBUG-only `.uno:GoToCell` is gone; a real click is how a real user, and
    /// this task's own live typing drill, ever tell LOK where to start typing). Also re-asserts
    /// first responder — `viewDidMoveToWindow` only claims it once, at window-join time, and a
    /// click is the ordinary way a user moves keyboard focus BACK to this view after it visited
    /// some other control (a toolbar field, a sibling panel) without this view ever leaving its
    /// window.
    ///
    /// **Scope disclosure**: left button only (`mouseDown`/`mouseDragged`/`mouseUp`, AppKit's own
    /// three-method family for it) — the brief's own file list. Right-click (a context menu) and
    /// other pointing devices are `rightMouseDown`/`otherMouseDown`, neither overridden here; a
    /// future task's scope, not retrofitted silently.
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        resetCaretBlink() // Office Stage B Task 5 — a click repositions the caret; show it solidly
        forwardMouseEvent(event, type: .buttonDown)
    }

    /// LOK's own `LOK_MOUSEEVENT_MOUSEMOVE` doc comment: "The mouse has moved while a button is
    /// pressed" — exactly `mouseDragged`'s own AppKit contract (unlike `mouseMoved`, which requires
    /// opting into `acceptsMouseMovedEvents` and fires with NO button held; this view does neither,
    /// so there is no hover-move door to confuse this with).
    override func mouseDragged(with event: NSEvent) {
        forwardMouseEvent(event, type: .move)
    }

    override func mouseUp(with event: NSEvent) {
        forwardMouseEvent(event, type: .buttonUp)
    }

    private func forwardMouseEvent(_ event: NSEvent, type: OfficeMouseEventType) {
        let viewPoint = convert(event.locationInWindow, from: nil)
        let twips = officePointToTwips(viewPoint: viewPoint, scrollOrigin: scrollOrigin, zoomPPT: zoomPPT)
        let buttons = OfficeInputCodes.mouseButton(appKitButtonNumber: event.buttonNumber)
        let modifiers = OfficeInputCodes.modifierMask(event.modifierFlags)
        runtime.postMouseEvent(path: path, type: type, xTwips: twips.x, yTwips: twips.y,
                               count: event.clickCount, buttons: buttons, modifiers: modifiers)
    }

    private func zoomStep(_ target: Int) {
        guard applyZoom(target) else { return }
        performSubscribe() // a keypress is discrete, like a part switch — no throttle
        evaluateResidencyIfNeeded() // office live-gate fix #3: discrete zoom is one of the brief's own triggers
    }

    /// Common half of both zoom doors: clamp, apply if changed, clear the (now wrong-sized) visible
    /// pool. `true` iff the zoom actually changed — both callers use this to decide whether a
    /// subscribe is owed at all.
    @discardableResult
    private func applyZoom(_ proposed: Int) -> Bool {
        let clamped = min(max(proposed, officeZoomLadder.first!), officeZoomLadder.last!)
        guard clamped != zoomPPT else { return false }
        zoomPPT = clamped
        clearVisibleTiles()
        relayoutVisibleTiles()
        return true
    }

    // MARK: - The tile layer pool

    /// Reconciles the visible `CALayer` set against `TileMath.viewportTileKeys` — adds layers for
    /// newly-visible keys, removes layers for keys scrolled out of view, repositions every survivor.
    /// Incremental rather than a full teardown/rebuild each pass: a rebuild would briefly blank an
    /// already-cached, still-visible tile's layer before immediately refilling it — cheap in CPU
    /// terms but a visible flicker on every scroll tick that this reconciliation avoids for free.
    ///
    /// office live-gate fix #4: the whole mutation pass below runs inside a `CATransaction` with
    /// actions disabled — belt-and-suspenders alongside `OfficeTileLayer`'s own unconditional
    /// `action(forKey:)` override (which alone already covers every tile layer, everywhere it is
    /// touched, not just here). This transaction is what also covers `hostLayer` itself and any
    /// FUTURE sublayer type a later change might add here without remembering to mint it as
    /// `OfficeTileLayer` — see this task's own report for why the override alone was judged
    /// insufficient to trust permanently.
    private func relayoutVisibleTiles() {
        guard bounds.width > 0, bounds.height > 0, let hostLayer = layer else { return }
        let viewport = officeViewportTwips(scrollOrigin: scrollOrigin, visibleSize: bounds.size, zoomPPT: zoomPPT)
        let visibleKeys = Set(TileMath.viewportTileKeys(part: part, zoomPPT: zoomPPT, viewportTwips: viewport))

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }

        for (key, tileLayer) in tileLayers where !visibleKeys.contains(key) {
            tileLayer.removeFromSuperlayer()
            tileLayers.removeValue(forKey: key)
        }

        let placeholder = resolvedPlaceholderColor()
        for key in visibleKeys {
            guard let rect = officeTileScreenRect(key: key, zoomPPT: zoomPPT, scrollOrigin: scrollOrigin) else {
                continue // TileMath refused this key — never trap, simply nothing to draw for it
            }
            // office live-gate fix #3 — the placeholder-at-draw instrument: a VISIBLE tile with
            // nothing cached for it RIGHT NOW is exactly the "another page comes on top" pop-in the
            // user reported. Checked here, once per relayout pass per such key, regardless of
            // whether its layer is new or a repositioned survivor — see the counter's own doc. The
            // counter is always on (cheap, and tests need it); the NSLog is `#if DEBUG`-gated, same
            // idiom `OfficeHarness.swift`/`EditorBridgeHarness.swift` already use for diagnostics —
            // a fast lazy-mode swipe over a large document can hit this dozens of times a second, and
            // a shipped Release build should not pay for that console spam.
            if runtime.tileStore.tile(docId: docId, key: key) == nil {
                visiblePlaceholderDrawCountForTesting += 1
                #if DEBUG
                NSLog("[OfficeTileCanvasView] placeholder visible at draw time: docId=%@ part=%d tileX=%d tileY=%d",
                      docId, key.part, key.tileX, key.tileY)
                #endif
            }
            if let existing = tileLayers[key] {
                // office live-gate fix #2 (Bug 2's contributing cause, not its root cause — see
                // `Self.subscribeMarginPoints`' own comment for that): REPOSITION ONLY. This branch
                // runs on every scroll tick — `relayoutVisibleTiles` has no throttle of its own, by
                // design (free scrolling must track every event) — so before this fix, the
                // unconditional `applyContents` call below used to rebuild a fresh `CGImage` from the
                // SAME bytes and re-hand it to the compositor for every already-correct, unchanged
                // tile, up to ~120x/sec each: nothing about a tile's PIXELS changes just because the
                // viewport moved past it. Content now gets (re)applied only where it can actually be
                // new: once, immediately below, when a layer is first created for a key never seen
                // before; and from `handleTilesArrived`, when the store genuinely receives new bytes
                // for a key already on screen. (`viewDidChangeEffectiveAppearance` needs an honest
                // full repaint too, on every visible tile — that is `repaintAllVisibleTiles()`,
                // deliberately its own small loop rather than routed back through this method.)
                existing.frame = rect
            } else {
                let tileLayer = OfficeTileLayer()
                tileLayer.contentsGravity = .resize
                tileLayer.frame = rect
                hostLayer.addSublayer(tileLayer)
                tileLayers[key] = tileLayer
                applyContents(to: tileLayer, key: key, placeholder: placeholder)
            }
        }
        // Office Stage B Task 5 — INSIDE this same transaction, never a separate one: every
        // scroll/zoom/part-switch/reload call site already routes through this one method, so
        // hooking overlay repositioning in HERE (rather than adding a matching call at each of
        // those call sites separately) is what keeps a caret/selection rect from ever visibly
        // lagging a tile's own reposition by even one committed frame. `refreshOverlays()` (this
        // method's own standalone counterpart, its own transaction) is for the case NOTHING here
        // changed — a cursor event or a blink tick arriving on an otherwise-static viewport.
        layoutOverlays()
    }

    private func clearVisibleTiles() {
        for tileLayer in tileLayers.values { tileLayer.removeFromSuperlayer() }
        tileLayers.removeAll()
    }

    /// Only touches layers ALREADY in the visible pool — a key that arrived while scrolled away
    /// from it is simply not there to update, and the next `relayoutVisibleTiles` (triggered by
    /// whatever scroll/zoom eventually brings it back into view) reads the store fresh regardless.
    ///
    /// **Office Stage B Task 4 — also the door that makes a real edit's invalidation actually
    /// REPAINT, not merely go blank.** `tilesArrived` fires for BOTH a fresh arrival (the store now
    /// has pixels — `applyContents` below finds them) and an eviction (`OfficeTileStore.invalidate`
    /// removed the entry — `applyContents` finds nothing and paints the placeholder tone). On a
    /// STATIC viewport (the typing scenario: nothing scrolled, so `performSubscribe` never fires
    /// again on its own), an evicted-but-still-visible key would otherwise sit at the placeholder
    /// tone forever — nothing else in this file's own trigger list (mount/setActivePart/zoomStep/
    /// the scroll throttle) covers "a push arrived for a key already on screen." Every key this
    /// loop finds STILL uncached after `applyContents` (i.e. evicted, not filled) is collected and
    /// handed to `OfficeRuntime.refetchInvalidatedTiles` — that call's own dedup
    /// (`OfficeTileStore.keysNeedingRequest`) makes this safe to call unconditionally, including for
    /// the ordinary "genuinely fresh pixels arrived" case, where the set is simply empty and the
    /// `Task` below does nothing.
    private func handleTilesArrived(_ keys: Set<TileKey>) {
        let placeholder = resolvedPlaceholderColor()
        var stillUncachedVisibleKeys: [TileKey] = []
        for key in keys {
            guard let tileLayer = tileLayers[key] else { continue }
            applyContents(to: tileLayer, key: key, placeholder: placeholder)
            if runtime.tileStore.tile(docId: docId, key: key) == nil {
                stillUncachedVisibleKeys.append(key)
            }
        }
        guard !stillUncachedVisibleKeys.isEmpty else { return }
        Task { [weak self] in
            guard let self else { return }
            await self.runtime.refetchInvalidatedTiles(path: self.path, keys: stillUncachedVisibleKeys)
        }
    }

    /// `viewDidChangeEffectiveAppearance`'s own repaint, and its only caller — deliberately NOT
    /// `relayoutVisibleTiles()`, which (as of office live-gate fix #2) paints a tile's content only
    /// ONCE, at layer creation, precisely to stay cheap on every scroll tick. An appearance change is
    /// the opposite shape: rare (a light/dark toggle, never a scroll), and needs EVERY currently
    /// visible tile repainted in the new tone regardless of whether its layer is old or new — a
    /// content-bearing tile gets the same image reassigned (harmless; nothing worth optimizing for an
    /// event this infrequent), a placeholder-toned one gets the tone that actually changed.
    private func repaintAllVisibleTiles() {
        let placeholder = resolvedPlaceholderColor()
        for (key, tileLayer) in tileLayers {
            applyContents(to: tileLayer, key: key, placeholder: placeholder)
        }
    }

    private func applyContents(to tileLayer: CALayer, key: TileKey, placeholder: CGColor) {
        applyContentsCallCountForTesting += 1
        if let entry = runtime.tileStore.tile(docId: docId, key: key), let image = Self.makeImage(pixels: entry.pixels) {
            tileLayer.contents = image
            tileLayer.backgroundColor = nil
        } else {
            tileLayer.contents = nil
            tileLayer.backgroundColor = placeholder
        }
    }

    /// Raw RGBA `Data` -> `CGImage`, with NOTHING decoded (T5.5's own ruling: rung 2 delivers exact
    /// pixel bytes, no base64, no compression) — `CGDataProvider(data:)` wraps the buffer directly,
    /// so this is a cheap header-only construction, not a pixel copy. `nil` for anything that is not
    /// EXACTLY one tile's worth of bytes (obligation 8: `TileMath.bytesPerTile`/`.tilePixelSize` are
    /// authoritative — a payload that disagrees is not drawn, never guessed at).
    private static func makeImage(pixels: Data) -> CGImage? {
        guard pixels.count == TileMath.bytesPerTile else { return nil }
        let side = TileMath.tilePixelSize
        guard let provider = CGDataProvider(data: pixels as CFData) else { return nil }
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
        return CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32,
                       bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: bitmapInfo,
                       provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    /// `CardSurface`, resolved against THIS view's own effective appearance — a plain `.cgColor`
    /// read outside `performAsCurrentDrawingAppearance` can resolve against whatever appearance
    /// happens to be current globally at call time, not necessarily this view's, which is how a
    /// CALayer's placeholder tone silently drifts from the rest of the panel's chrome on an
    /// appearance change if nothing ever re-resolves it (obligation 4: the tone must stay
    /// `CardSurface`, in EITHER appearance, never a stale one from the other).
    private func resolvedPlaceholderColor() -> CGColor {
        let color = NSColor(named: "CardSurface") ?? NSColor.windowBackgroundColor
        var resolved = color.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { resolved = color.cgColor }
        return resolved
    }

    // MARK: - The subscribe throttle

    /// `skipIfViewportSatisfied` — office live-gate fix #3 (the request-churn audit): when `true`
    /// AND every key the padded viewport touches is already cached or already in flight, this
    /// returns WITHOUT calling `runtime.subscribeTiles` at all — a resident document's post-fill
    /// scrolling, or a lazy document's scroll back over already-visited territory, has nothing the
    /// server could tell it that would change what happens next, so the round trip is skipped rather
    /// than added to the shared connection's serial paint-loop backlog for zero benefit.
    ///
    /// **Deliberately `false` by default, and never passed `true` from a DISCRETE call site**
    /// (`mount`/`setActivePart`/`zoomStep`/`setZoomForTesting`/`syncDocumentIdentity`) — only from
    /// `scheduleThrottledSubscribe`'s own leading-edge call. Two reasons a discrete call must stay
    /// unconditional: (a) `unmount` always calls `runtime.unsubscribeTiles`, so a later remount of a
    /// STILL-cached document with the skip active would never re-register this connection as the
    /// helper's tile-push subscriber — invisible in Stage A (nothing invalidates yet), but it would
    /// silently break Stage B's edit-invalidation multicast; (b) `OfficeTileCanvasViewTests` pins
    /// "a discrete action resubscribes, unconditionally" as a contract or its own tests would
    /// become dependent on incidental cache state.
    private func performSubscribe(skipIfViewportSatisfied: Bool = false) {
        guard isMounted, bounds.width > 0, bounds.height > 0 else { return }
        // office live-gate fix #2: pad by one tile span on every edge before asking — see
        // `Self.subscribeMarginPoints`'s own comment for why. Clamped to >= 0 only on the near edge
        // (never a NEGATIVE-twips ask); the far edge is left to extend past real content when
        // `scrollOrigin` is already near 0 — TileMath simply returns tile keys the store has nothing
        // to serve for yet for a NON-spreadsheet (the "placeholders forever past real content" case
        // `sizeTwips`'s own doc still accepts there), so a slightly wider ask there is harmless. For
        // a SPREADSHEET, as of office live-gate fix #4, this overscan can genuinely reach real,
        // paintable infinite-grid tiles just past the used range — no longer merely harmless padding,
        // an active (bounded) prefetch of the margin's own leading edge; see `effectiveExtentTwips`'s
        // own header for the full mechanism and its interaction with fix #3's residency sweep.
        let margin = Self.subscribeMarginPoints
        let paddedOrigin = CGPoint(x: max(0, scrollOrigin.x - margin), y: max(0, scrollOrigin.y - margin))
        let paddedSize = CGSize(width: bounds.width + margin * 2, height: bounds.height + margin * 2)
        let viewport = officeViewportTwips(scrollOrigin: paddedOrigin, visibleSize: paddedSize, zoomPPT: zoomPPT)
        if skipIfViewportSatisfied {
            // office live-gate fix #3: clamp to the document's real extent for THIS check only — see
            // `officeClampViewportToDocumentExtent`'s own header for why the un-clamped margin would
            // otherwise never let a resident document's near-edge scrolling skip at all.
            //
            // office live-gate fix #4, FIX 2: clamped to `effectiveExtentTwips`, NOT the bare
            // `sizeTwips` — the SAME extent `clampedOriginX/Y` scroll against (that property's own
            // header spells out why passing the un-widened `sizeTwips` here specifically would have
            // silently reintroduced "placeholders forever," now inside the new infinite-grid margin
            // instead of past the old hard edge.
            let clamped = officeClampViewportToDocumentExtent(viewport, sizeTwips: effectiveExtentTwips)
            let keys = TileMath.viewportTileKeys(part: part, zoomPPT: zoomPPT, viewportTwips: clamped)
            guard !runtime.tileStore.keysNeedingRequest(docId: docId, candidates: keys).isEmpty else {
                return
            }
        }
        runtime.subscribeTiles(path: path, part: part, zoomPPT: zoomPPT, viewportTwips: viewport)
    }

    private func scheduleThrottledSubscribe() {
        guard !isSubscribeThrottled else {
            subscribePendingSinceThrottle = true
            return
        }
        isSubscribeThrottled = true
        // office live-gate fix #3: the churn-audit skip applies HERE — the throttled/continuous path
        // (scroll, resize, pinch) — never to a discrete call; see `performSubscribe`'s own header.
        performSubscribe(skipIfViewportSatisfied: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.subscribeThrottleInterval) { [weak self] in
            guard let self else { return }
            self.isSubscribeThrottled = false
            if self.subscribePendingSinceThrottle {
                self.subscribePendingSinceThrottle = false
                self.scheduleThrottledSubscribe()
            } else {
                // office live-gate fix #3: the trailing settle edge — the one point a CONTINUOUS
                // sequence (scroll, resize, or a pinch gesture's own continuous zoomPPT ticks) has
                // actually stopped changing. See `evaluateResidencyIfNeeded`'s own header for why
                // pinch zoom is deliberately evaluated ONLY here, never from a raw `magnify` tick.
                self.evaluateResidencyIfNeeded()
            }
        }
    }

    // MARK: - office live-gate fix #3: whole-document tile residency

    /// Whole-document tile residency's own trigger: "is the FULL extent of this document, at the
    /// CURRENT part/zoom, small enough to prefetch as a whole — and if so, start (or restart) that
    /// sweep." Called at every point the live-gate brief names as a trigger — document open
    /// (`mount`), part switch (`setActivePart`), discrete zoom (`zoomStep`/`setZoomForTesting`), and
    /// reload (`syncDocumentIdentity`, which resets `lastResidencyEvaluation` FIRST since a reload
    /// can carry a new `sizeTwips` even when part/zoom happen to stay the same) — PLUS the scroll
    /// throttle's own trailing settle edge (`scheduleThrottledSubscribe`), which is what covers
    /// resize (and, in production, the FIRST real layout after `mount`'s own zero-bounds attempt) and,
    /// deliberately, PINCH zoom: `magnify(with:)` itself never calls this directly, because a raw
    /// pinch tick changes `zoomPPT` continuously (dozens of times a second) and each call would bump
    /// `prefetchGeneration`, discarding whatever the previous tick's sweep had barely started before
    /// even its first chunk could land — the settle edge fires once, at the FINAL zoom the gesture
    /// actually lands on.
    ///
    /// Memoized on `(part, zoomPPT)` — see `lastResidencyEvaluation`'s own header for why the memo is
    /// only written from inside the `bounds > 0` guard below, never before it.
    private func evaluateResidencyIfNeeded() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        if let last = lastResidencyEvaluation, last.part == part, last.zoomPPT == zoomPPT { return }
        lastResidencyEvaluation = (part: part, zoomPPT: zoomPPT)
        prefetchGeneration += 1
        let generation = prefetchGeneration
        prefetchChunksIssuedForTesting = 0
        prefetchSweepIssuedForTesting = false

        guard let tileCount = officeResidencyEligibleTileCount(
            sizeTwips: sizeTwips, zoomPPT: zoomPPT, cap: OfficeTileStore.residencyCapTiles) else {
            return // too big (or unrepresentable) — stays in today's viewport+margin lazy mode, unchanged
        }
        guard tileCount > 0 else {
            prefetchSweepIssuedForTesting = true // an empty document is trivially, instantly "resident"
            return
        }
        let fullExtent = OfficeTwipsRect(x: 0, y: 0, width: sizeTwips.widthTwips, height: sizeTwips.heightTwips)
        // Clamped to the document's real extent, same as `performSubscribe`'s skip-check
        // (`officeClampViewportToDocumentExtent`'s own header) — a resident-eligible document is
        // routinely SMALLER than the panel showing it (that's the residency cap's whole point:
        // small docs qualify), so `clampedOriginX/Y` pin `scrollOrigin` at 0 and this raw
        // `bounds.size`-derived viewport extends past the doc's true edge on every axis where that
        // holds. Unclamped, `officeResidencyPrefetchOrder`'s `visible` set would include tile
        // indices outside `fullExtentTwips` — keys that can never be painted (nothing there to
        // request) — contradicting its own "every key in fullExtentTwips" doc and wasting a wire
        // round trip on a phantom ask every time this sweep runs. The skip-check's own clamped
        // computation is unaffected by this (separate call, already correct); this clamp only
        // fixes what the SWEEP itself asks for.
        let visibleViewport = officeClampViewportToDocumentExtent(
            officeViewportTwips(scrollOrigin: scrollOrigin, visibleSize: bounds.size, zoomPPT: zoomPPT),
            sizeTwips: sizeTwips)
        let ordered = officeResidencyPrefetchOrder(part: part, zoomPPT: zoomPPT, fullExtentTwips: fullExtent,
                                                   visibleViewportTwips: visibleViewport)
        beginPrefetch(keys: ordered, generation: generation)
    }

    /// Issues `keys` to the helper in small chunks (`Self.prefetchChunkSize`), visible-first (the
    /// order `officeResidencyPrefetchOrder` already produced), pacing each chunk on the PREVIOUS
    /// one's own wire round trip (`await runtime.prefetchTilesChunk`) rather than firing all chunks
    /// back-to-back — see `OfficeRuntime.prefetchTilesChunk`'s own header for why a synchronous loop
    /// would defeat chunking entirely (every chunk would enqueue on `officeRequestQueue` back-to-
    /// back, with no gap for anything else to slot in).
    ///
    /// **Honest bound, not preemption.** The helper writes a chunk's `tileRequestAccepted` ack BEFORE
    /// it starts painting that chunk's keys (`OfficeHelperServer`'s own handler order), so THIS
    /// loop's pacing keeps it at most one chunk ahead of the wire — but the helper cannot interrupt a
    /// paint loop already in progress, so a genuinely urgent request queued mid-sweep still waits for
    /// the CURRENTLY-PAINTING chunk to finish, on the order of that chunk's own paint time (roughly
    /// `Self.prefetchChunkSize` x ~26-28ms — see that constant's own doc), not zero.
    private func beginPrefetch(keys: [TileKey], generation: Int) {
        guard !keys.isEmpty else { prefetchSweepIssuedForTesting = true; return }
        let chunks = officeChunked(keys, size: Self.prefetchChunkSize)
        Task { [weak self] in
            guard let self else { return }
            for chunk in chunks {
                guard self.isMounted, self.prefetchGeneration == generation else { return }
                await self.runtime.prefetchTilesChunk(path: self.path, keys: chunk)
                // Re-checked, not just checked before the `await` above: a generation bump (a
                // close/part-switch/zoom racing this in-flight chunk) can land WHILE this call is
                // suspended, and `evaluateResidencyIfNeeded` resets `prefetchChunksIssuedForTesting`
                // to 0 the instant it bumps the generation to start the new sweep — without this
                // second guard, a superseded sweep's stale continuation would still bump that
                // freshly-reset counter by 1, corrupting the NEW sweep's own count with a phantom
                // chunk that was never really its own.
                guard self.isMounted, self.prefetchGeneration == generation else { return }
                self.prefetchChunksIssuedForTesting += 1
            }
            guard self.isMounted, self.prefetchGeneration == generation else { return }
            self.prefetchSweepIssuedForTesting = true
        }
    }

    // MARK: - Office Stage B Task 5: caret/selection/cell-cursor overlay lifecycle + layout

    /// `mount()`'s own tail call — mints the two singleton overlay layers (caret, cell-cursor;
    /// selection's own pool starts empty and grows on demand — see `selectionLayers`' header),
    /// subscribes to `runtime.cursorStore.cursorChanged` (mirrors `tilesArrivedSink`'s own docId-
    /// filtered sink one screen up), and starts the blink timer.
    private func mountCursorOverlays() {
        guard let hostLayer = layer else { return }

        let caret = OfficeTileLayer()
        caret.zPosition = 2
        caret.isHidden = true
        hostLayer.addSublayer(caret)
        caretLayer = caret

        let cellCursor = OfficeTileLayer()
        cellCursor.zPosition = 1
        cellCursor.isHidden = true
        cellCursor.backgroundColor = nil // outline only — see this property's own header
        cellCursor.borderWidth = 1.5
        hostLayer.addSublayer(cellCursor)
        cellCursorLayer = cellCursor

        cursorChangedSink = runtime.cursorStore.cursorChanged.sink { [weak self] changedDocId in
            guard let self, changedDocId == self.docId else { return }
            self.refreshOverlays()
        }

        caretBlinkPhaseVisible = true
        let timer = Timer(timeInterval: Self.caretBlinkInterval, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.caretBlinkPhaseVisible.toggle()
            self.refreshOverlays()
        }
        RunLoop.main.add(timer, forMode: .common) // survives UI tracking loops — see the property's own header
        caretBlinkTimer = timer

        refreshOverlays() // an initial layout — harmless no-op if nothing is known yet (every overlay starts hidden)
    }

    /// `unmount()`'s own tail call — explicit teardown for every piece `mountCursorOverlays` created,
    /// matching this file's own established "never hope deallocation alone is enough" posture.
    private func unmountCursorOverlays() {
        caretBlinkTimer?.invalidate()
        caretBlinkTimer = nil
        cursorChangedSink = nil
        caretLayer?.removeFromSuperlayer()
        caretLayer = nil
        cellCursorLayer?.removeFromSuperlayer()
        cellCursorLayer = nil
        for selectionLayer in selectionLayers { selectionLayer.removeFromSuperlayer() }
        selectionLayers = []
    }

    /// The standalone entry point: opens its OWN disabled-actions transaction, then calls
    /// `layoutOverlays()`. Every caller that is NOT already inside `relayoutVisibleTiles`'s own
    /// transaction uses this — the cursor-changed sink, a blink tick, and `viewDidChangeEffective
    /// Appearance`'s own accent-recolor. Guarded on `isMounted`/`layer != nil` the same way
    /// `performSubscribe` guards its own early callers — a blink tick or a cursor push arriving after
    /// `unmount()` (the timer/sink are torn down there, but a already-in-flight Combine delivery or a
    /// timer fire racing `unmount()` by a beat is not impossible) must be a harmless no-op, never a
    /// crash reaching into a torn-down `hostLayer`.
    private func refreshOverlays() {
        guard isMounted, layer != nil else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layoutOverlays()
        CATransaction.commit()
    }

    /// **Must run inside an already-open, disabled-actions `CATransaction`** — never called bare;
    /// see `refreshOverlays()` and `relayoutVisibleTiles()`'s own call site for the two doors, and
    /// `OfficeTileLayer`'s own header for why an undisabled reposition would implicitly animate.
    ///
    /// **Hides every overlay whose STAMPED part disagrees with this canvas's own current `part`** —
    /// `OfficeCursorStore.State`'s own `caretPart`/`selectionPart`/`cellCursorPart` fields exist
    /// PURELY for this check (see that type's own header: none of these three LOK callbacks carry a
    /// part number of their own, so the store stamps one at fold time from whatever `activePart` was
    /// current then) — a rect computed against a page/sheet the user has since navigated away from
    /// must never be drawn as if it were the page/sheet on screen right now.
    private func layoutOverlays() {
        let state = runtime.cursorStore.state(docId: docId)

        if let caretLayer {
            if let rect = state.caretRectTwips, state.caretPart == part, caretBlinkPhaseVisible {
                var screenRect = officeTwipsRectToScreenRect(rect, zoomPPT: zoomPPT, scrollOrigin: scrollOrigin)
                // A real caret rect's own twips WIDTH is always 0 (a caret is a line, not a box —
                // Task 5's own live probe, every firing observed) — `officeCaretWidthPoints` is the
                // rendered hairline thickness a zero-width box would otherwise never show at all.
                screenRect.size.width = officeCaretWidthPoints
                caretLayer.frame = screenRect
                caretLayer.backgroundColor = resolvedAccentColor()
                caretLayer.isHidden = false
            } else {
                caretLayer.isHidden = true
            }
        }

        layoutSelectionLayers(state)

        if let cellCursorLayer {
            if case .at(let rect, _, _) = state.cellCursor, state.cellCursorPart == part {
                cellCursorLayer.frame = officeTwipsRectToScreenRect(rect, zoomPPT: zoomPPT, scrollOrigin: scrollOrigin)
                cellCursorLayer.borderColor = resolvedAccentColor()
                cellCursorLayer.isHidden = false
            } else {
                cellCursorLayer.isHidden = true
            }
        }
    }

    /// `layoutOverlays()`'s own selection half, split out for readability — same "must run inside an
    /// open transaction" contract as its caller.
    private func layoutSelectionLayers(_ state: OfficeCursorStore.State) {
        guard let hostLayer = layer else { return }
        guard state.selectionPart == part else {
            for selectionLayer in selectionLayers { selectionLayer.isHidden = true }
            return
        }
        let rects = state.selectionRectsTwips
        // Grows to fit — never shrinks (see `selectionLayers`' own header on why: hidden surplus
        // layers, below, cost less than the churn of tearing one down and re-minting it the next
        // time the selection grows back to a similar size).
        while selectionLayers.count < rects.count {
            let newLayer = OfficeTileLayer()
            newLayer.zPosition = 1
            hostLayer.addSublayer(newLayer)
            selectionLayers.append(newLayer)
        }
        // office live-gate fix #4, FIX 2's own reasoning, applied here: selection is drawn at LOW
        // opacity (never a solid fill) — a full-opacity accent box would occlude the very text the
        // selection is highlighting, which is the entire reason a user looks at a selection at all.
        let fillColor = resolvedAccentColor(alpha: 0.25)
        for (index, selectionLayer) in selectionLayers.enumerated() {
            guard index < rects.count else {
                selectionLayer.isHidden = true
                continue
            }
            selectionLayer.frame = officeTwipsRectToScreenRect(rects[index], zoomPPT: zoomPPT, scrollOrigin: scrollOrigin)
            selectionLayer.backgroundColor = fillColor
            selectionLayer.isHidden = false
        }
    }

    /// `Theme.accent`'s own `NSColor(named: "AccentColor")` source, resolved against THIS view's own
    /// effective appearance — the identical pattern `resolvedPlaceholderColor()` already establishes
    /// one section up, for the identical reason (a plain `.cgColor` read outside
    /// `performAsCurrentDrawingAppearance` can resolve against whatever appearance happens to be
    /// current globally at call time, not necessarily this view's).
    private func resolvedAccentColor(alpha: CGFloat = 1.0) -> CGColor {
        let base = NSColor(named: "AccentColor") ?? NSColor.controlAccentColor
        let color = alpha < 1.0 ? base.withAlphaComponent(alpha) : base
        var resolved = color.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance { resolved = color.cgColor }
        return resolved
    }

    /// "Blink pauses while typing" — snaps the caret solidly visible and restarts the blink-off
    /// countdown. `.fireDate` reschedules an EXISTING repeating `Timer`'s next fire without
    /// invalidating/re-creating it (cheaper, and avoids ever having a brief window with no timer at
    /// all if this fires in rapid succession, as real typing does).
    private func resetCaretBlink() {
        caretBlinkPhaseVisible = true
        caretBlinkTimer?.fireDate = Date().addingTimeInterval(Self.caretBlinkInterval)
        refreshOverlays()
    }

    // MARK: - Test seams (Office Stage B Task 5)

    /// Mirrors `tileLayerForTesting`'s own precedent exactly: lets a test inspect the REAL overlay
    /// layer's frame/visibility/implicit-action behavior through the exact production mount/layout
    /// path, rather than a hand-built `CALayer()` that would only prove the TEST's own layer never
    /// animates.
    var caretLayerForTesting: CALayer? { caretLayer }
    var cellCursorLayerForTesting: CALayer? { cellCursorLayer }
    var selectionLayersForTesting: [CALayer] { selectionLayers }

    /// A synthetic `Timer` fire has no public, deterministic AppKit door — the same shape
    /// `setScrollOriginForTesting`/`setZoomForTesting` already worked around for scroll/zoom. Toggles
    /// the SAME phase flag and calls the SAME `refreshOverlays()` a real timer tick does, so a test
    /// exercises the production layout path, not a parallel test-only one — the house "no arbitrary
    /// sleeps" rule applied to a UI timer instead of a network/process wait.
    func advanceCaretBlinkForTesting() {
        caretBlinkPhaseVisible.toggle()
        refreshOverlays()
    }
}
