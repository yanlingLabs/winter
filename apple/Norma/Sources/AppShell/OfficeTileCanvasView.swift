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
    /// `.activateOnly` exists): `documents[path].activePart` is written by ANY `subscribeTiles` call
    /// for this doc, including one the MODEL fired as a nominal placeholder before the canvas's own
    /// accurate one lands. Re-applying here — `setActivePart` itself no-ops when the value already
    /// matches — keeps the canvas honest if something outside it ever moves `activePart` first.
    func updateNSView(_ nsView: OfficeTileCanvasView, context: Context) {
        nsView.setActivePart(activePart)
    }

    /// Obligation 1's own cross-file precedent (`EditorViewportView.dismantleNSView`,
    /// `PanelViewport.dismantleNSView`): explicit teardown, never a hope that deallocation alone is
    /// enough — `unmount` both unsubscribes from tiles and clears `model.canvasHost` if this view is
    /// still the registered one.
    static func dismantleNSView(_ nsView: OfficeTileCanvasView, coordinator: ()) {
        nsView.unmount()
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
    private let docId: String
    /// Weak — registered as `model.canvasHost` in `mount()`, explicitly cleared in `unmount()` (the
    /// SwiftUI dismantle path). See `OfficeDocumentCanvasHost`'s own header for why this lives on
    /// the model rather than the runtime, and `EditorRuntime.viewportHost`'s doc for why the
    /// clearing must be explicit rather than trusted to weak zeroing (which does not run `didSet`
    /// and, here, could not reach the model's stored property from outside it anyway).
    private weak var model: PanelDocumentTabModel?
    /// The size to clamp scrolling against. Captured once at open time (`OfficeRuntimeState
    /// .DocumentEntry.sizeTwips`, itself LOK's `getDocumentSize()` at open) — **disclosed
    /// imprecision**: a multi-sheet spreadsheet's sheets can have different used ranges, and Stage A
    /// has no per-part size to clamp against instead (`OfficeRuntimeState` carries exactly one
    /// `sizeTwips` per document, not per part). A soft UX bound, not a correctness one: scrolling
    /// past real content simply shows placeholders forever (the store has nothing to serve there),
    /// nothing breaks.
    private let sizeTwips: OfficeDocumentSize

    private(set) var part: Int
    private(set) var zoomPPT: Int = 1000
    private var scrollOrigin: CGPoint = .zero

    private var isMounted = false
    private var tilesArrivedSink: AnyCancellable?
    private var tileLayers: [TileKey: CALayer] = [:]

    /// Leading-edge throttle, obligation 3: the FIRST viewport change in a burst asks immediately,
    /// then at most one more ask per `Self.subscribeThrottleInterval` for as long as more changes
    /// keep arriving, and settles the moment they stop. A plain debounce (delay every ask until
    /// activity stops) was considered and rejected: it would leave a slow, deliberate scroll showing
    /// nothing until the user paused, and this app's own "display cadence" framing calls for tiles
    /// progressively arriving DURING a scroll, not only after one.
    private static let subscribeThrottleInterval: TimeInterval = 1.0 / 60.0
    private var isSubscribeThrottled = false
    private var subscribePendingSinceThrottle = false

    init(runtime: OfficeRuntime, path: String, docId: String, sizeTwips: OfficeDocumentSize,
         initialPart: Int, model: PanelDocumentTabModel) {
        self.runtime = runtime
        self.path = path
        self.docId = docId
        self.sizeTwips = sizeTwips
        self.part = max(0, initialPart)
        self.model = model
        super.init(frame: .zero)
        wantsLayer = true
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
        tilesArrivedSink = nil
        runtime.unsubscribeTiles(path: path)
        if model?.canvasHost === self { model?.canvasHost = nil }
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
        relayoutVisibleTiles() // repaints every currently-placeholder tile in the new appearance's tone
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
    }

    // MARK: - Scroll (native momentum, no NSScrollView — obligation 9)

    override func scrollWheel(with event: NSEvent) {
        guard event.type == .scrollWheel else { return super.scrollWheel(with: event) }
        var dx = event.scrollingDeltaX
        var dy = event.scrollingDeltaY
        // Same compensation `TrackpadHorizontalSwipeRecognizer.handle` applies to the identical
        // event fields, one gesture axis over.
        if event.isDirectionInvertedFromDevice { dx *= -1; dy *= -1 }
        scrollOrigin = CGPoint(x: clampedOriginX(scrollOrigin.x - dx), y: clampedOriginY(scrollOrigin.y - dy))
        relayoutVisibleTiles()
        scheduleThrottledSubscribe()
    }

    private func clampedOriginX(_ x: CGFloat) -> CGFloat {
        let widthPixels = TileMath.twipsToPixels(sizeTwips.widthTwips, zoomPPT: zoomPPT)
        let maxOrigin = max(0, CGFloat(widthPixels) / officeFixedDeviceScale - bounds.width)
        return min(max(0, x), maxOrigin)
    }

    private func clampedOriginY(_ y: CGFloat) -> CGFloat {
        let heightPixels = TileMath.twipsToPixels(sizeTwips.heightTwips, zoomPPT: zoomPPT)
        let maxOrigin = max(0, CGFloat(heightPixels) / officeFixedDeviceScale - bounds.height)
        return min(max(0, y), maxOrigin)
    }

    // MARK: - Zoom (pinch continuous, ⌘±/⌘0 ladder-stepped — obligation 9)

    override func magnify(with event: NSEvent) {
        let proposed = Int((CGFloat(zoomPPT) * (1 + event.magnification)).rounded())
        guard applyZoom(proposed) else { return }
        scheduleThrottledSubscribe()
    }

    /// **Scope disclosure**: bound to this view's own `keyDown`, not a main-menu command. The main
    /// menu is shared app-wide state this task did not want to touch mid-panel-work — a menu item
    /// with a key equivalent is the natural follow-up once a second surface needs the same shortcut.
    /// `acceptsFirstResponder`/the window-join `makeFirstResponder` above are what make this reach
    /// the view at all.
    override func keyDown(with event: NSEvent) {
        guard event.modifierFlags.contains(.command) else { return super.keyDown(with: event) }
        switch event.charactersIgnoringModifiers {
        case "+", "=": zoomStep(officeZoomIn(current: zoomPPT))
        case "-", "_": zoomStep(officeZoomOut(current: zoomPPT))
        case "0": zoomStep(1000)
        default: super.keyDown(with: event)
        }
    }

    private func zoomStep(_ target: Int) {
        guard applyZoom(target) else { return }
        performSubscribe() // a keypress is discrete, like a part switch — no throttle
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
    private func relayoutVisibleTiles() {
        guard bounds.width > 0, bounds.height > 0, let hostLayer = layer else { return }
        let viewport = officeViewportTwips(scrollOrigin: scrollOrigin, visibleSize: bounds.size, zoomPPT: zoomPPT)
        let visibleKeys = Set(TileMath.viewportTileKeys(part: part, zoomPPT: zoomPPT, viewportTwips: viewport))

        for (key, tileLayer) in tileLayers where !visibleKeys.contains(key) {
            tileLayer.removeFromSuperlayer()
            tileLayers.removeValue(forKey: key)
        }

        let placeholder = resolvedPlaceholderColor()
        for key in visibleKeys {
            guard let rect = officeTileScreenRect(key: key, zoomPPT: zoomPPT, scrollOrigin: scrollOrigin) else {
                continue // TileMath refused this key — never trap, simply nothing to draw for it
            }
            let tileLayer: CALayer
            if let existing = tileLayers[key] {
                tileLayer = existing
            } else {
                tileLayer = CALayer()
                tileLayer.contentsGravity = .resize
                hostLayer.addSublayer(tileLayer)
                tileLayers[key] = tileLayer
            }
            tileLayer.frame = rect
            applyContents(to: tileLayer, key: key, placeholder: placeholder)
        }
    }

    private func clearVisibleTiles() {
        for tileLayer in tileLayers.values { tileLayer.removeFromSuperlayer() }
        tileLayers.removeAll()
    }

    /// Only touches layers ALREADY in the visible pool — a key that arrived while scrolled away
    /// from it is simply not there to update, and the next `relayoutVisibleTiles` (triggered by
    /// whatever scroll/zoom eventually brings it back into view) reads the store fresh regardless.
    private func handleTilesArrived(_ keys: Set<TileKey>) {
        let placeholder = resolvedPlaceholderColor()
        for key in keys {
            guard let tileLayer = tileLayers[key] else { continue }
            applyContents(to: tileLayer, key: key, placeholder: placeholder)
        }
    }

    private func applyContents(to tileLayer: CALayer, key: TileKey, placeholder: CGColor) {
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

    private func performSubscribe() {
        guard isMounted, bounds.width > 0, bounds.height > 0 else { return }
        let viewport = officeViewportTwips(scrollOrigin: scrollOrigin, visibleSize: bounds.size, zoomPPT: zoomPPT)
        runtime.subscribeTiles(path: path, part: part, zoomPPT: zoomPPT, viewportTwips: viewport)
    }

    private func scheduleThrottledSubscribe() {
        guard !isSubscribeThrottled else {
            subscribePendingSinceThrottle = true
            return
        }
        isSubscribeThrottled = true
        performSubscribe()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.subscribeThrottleInterval) { [weak self] in
            guard let self else { return }
            self.isSubscribeThrottled = false
            if self.subscribePendingSinceThrottle {
                self.subscribePendingSinceThrottle = false
                self.scheduleThrottledSubscribe()
            }
        }
    }
}
