import AppKit
import QuartzCore
import SwiftUI

// -----------------------------------------------------------------------------------------------
// The working plume on Core Animation.
//
// It used to be a SwiftUI `Canvas` redrawn thirty times a second on the main thread: about fifty puffs, a blurred glow
// and the thrown tiles' symbols resolved afresh every frame — 8% of the main thread for one plume, and the dispatch
// pill and a session window each show one while a turn works. Here every puff and tile is a layer that flies its whole
// trip as ONE keyframe animation, sampled from the same pure layout the Canvas drew (`PropulsionPlume.circle(for:)`,
// `.tile(for:)`), so the render server moves them and the main thread does no per-frame work at all. It wakes ten
// times a second to advance the model, start the animations of what was born since (back-dated by the age it already
// has, so a late tick shows nothing late), and retire the layers whose trip is over. A plume that is not on screen
// (a hidden or occluded window, a view that left its window) has no timer at all and picks up already full.
//
// A flight is sampled for one size of plume: when the view is resized every flight in the air is started again for the
// new one (same birth, so each carries on from where it is) — a morph that animates the plume's frame pays that on
// each layout pass it makes.
// -----------------------------------------------------------------------------------------------

// MARK: - The flights (pure — `PlumeLayerTests`)

/// One puff's or tile's whole trip down the plume, sampled for a keyframe animation.
enum PlumeFlight {
    struct Path: Equatable {
        /// 0…1 across the trip (age / lifetime), one per sample.
        var keyTimes: [Double]
        /// Where it is, in the plume's own coordinates (y DOWN, the layout's).
        var centers: [CGPoint]
        /// Its diameter as a share of the sprite's base diameter (`baseDiameter`).
        var scales: [CGFloat]
        /// How hot it still is (1 at the nozzle, 0 at the tail).
        var heats: [Double]
    }

    /// 16 samples: a puff's lane opens up linearly over its first third (`min(1, 3p)`), so the kink falls on a sample
    /// (index 5 of 15) and the straight segments between samples stay within a point of the curve (0.7 at worst, where
    /// `p^1.7` bends hardest — `PlumeLayerTests`).
    static let puffKeyTimes: [Double] = (0..<16).map { Double($0) / 15 }
    /// A tile grows out of the nozzle over its first 8% and settles into its lane by 40%: samples on both kinks.
    static let tileKeyTimes: [Double] = [0, 0.04, 0.08, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

    /// The diameter a puff's layer is built at: its size at the nozzle at full strength, so every scale is ≤ 1.
    static func baseDiameter(spark: Bool, height: CGFloat) -> CGFloat {
        height * CGFloat(spark ? PropulsionPlume.sparkDiameterShare : PropulsionPlume.nozzleDiameterShare)
    }

    /// The side a tile's layer is built at: its settled size.
    static func baseSide(height: CGFloat) -> CGFloat { height * CGFloat(PropulsionPlume.tokenSideShare) }

    static func puff(_ puff: PropulsionPlume.Puff, in rect: CGRect, emitterX: CGFloat, tailX: CGFloat) -> Path {
        let base = baseDiameter(spark: puff.spark, height: rect.height)
        var path = Path(keyTimes: puffKeyTimes, centers: [], scales: [], heats: [])
        for p in puffKeyTimes {
            var at = puff
            at.age = p * puff.lifetime
            let circle = PropulsionPlume.circle(for: at, in: rect, emitterX: emitterX, tailX: tailX)
            path.centers.append(circle.center)
            path.scales.append(base > 0 ? circle.diameter / base : 0)
            path.heats.append(circle.heat)
        }
        return path
    }

    static func tile(_ token: PropulsionPlume.Token, in rect: CGRect, emitterX: CGFloat, tailX: CGFloat) -> Path {
        let base = baseSide(height: rect.height)
        var path = Path(keyTimes: tileKeyTimes, centers: [], scales: [], heats: [])
        for p in tileKeyTimes {
            var at = token
            at.age = p * token.lifetime
            let tile = PropulsionPlume.tile(for: at, in: rect, emitterX: emitterX, tailX: tailX)
            path.centers.append(tile.center)
            path.scales.append(base > 0 ? tile.side / base : 0)
            path.heats.append(tile.heat)
        }
        return path
    }
}

// MARK: - The glow

/// The soft bloom under the puffs. The Canvas blurred a copy of every puff (radius 22% of the plume's height) and added
/// it at 55%; here each puff carries a radial gradient whose falloff is that blur worked out once, numerically — a disc
/// convolved with a Gaussian — so nothing is filtered at draw time.
enum PlumeGlow {
    /// Where the gradient's stops sit across the glow layer's radius (0 centre, 1 edge).
    static let locations: [Double] = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1]
    /// The glow layer's side, as a multiple of the puff's base diameter: the 1.15-scaled disc plus 2.5 blur deviations.
    static let reach: CGFloat = {
        let height = 1.0
        let radius = PropulsionPlume.nozzleDiameterShare * height / 2 * 1.15
        return CGFloat((radius + 2.5 * blurShare * height) * 2 / (PropulsionPlume.nozzleDiameterShare * height))
    }()
    /// The Canvas's blur radius, as a share of the plume's height.
    static let blurShare = 0.22
    /// What it composites at. The Canvas added its blurred copy at 55% (`plusLighter`), which brightens where glows
    /// overlap more than an ordinary alpha blend does; 0.9 of the blurred disc's alpha is what an alpha blend needs to
    /// stand in for it (`PlumeParityTests` measured 0.62 → 7.5, 0.9 → 6.2, 1.2 → 9.4 per-channel difference from the
    /// Canvas it replaced).
    static let strength = 0.9

    /// The glow's alpha at each of `locations`, 0…1 of `strength`.
    static let alphas: [Double] = {
        let height = 1.0
        let discRadius = PropulsionPlume.nozzleDiameterShare * height / 2 * 1.15
        let sigma = blurShare * height
        let layerRadius = discRadius + 2.5 * sigma
        return locations.map { location in
            blurredDisc(discRadius: discRadius, sigma: sigma, at: location * layerRadius)
        }
    }()

    /// A disc of `discRadius` convolved with a Gaussian of deviation `sigma`, read at distance `r` from its centre.
    static func blurredDisc(discRadius: Double, sigma: Double, at r: Double) -> Double {
        let n = 96
        let step = 2 * discRadius / Double(n)
        var sum = 0.0, weight = 0.0
        var y = -discRadius + step / 2
        for _ in 0..<n {
            var x = -discRadius + step / 2
            for _ in 0..<n {
                if x * x + y * y <= discRadius * discRadius {
                    let dx = r - x, dy = -y
                    sum += exp(-(dx * dx + dy * dy) / (2 * sigma * sigma))
                }
                x += step
            }
            y += step
        }
        weight = 2 * Double.pi * sigma * sigma
        return min(1, sum * step * step / weight)
    }
}

// MARK: - Colours

/// The plume's colours by heat, worked out once per palette (128 steps across heat 0…1 are indistinguishable from the
/// continuous ramp), as `CGColor`s ready for a layer, with the glow's gradient for each step.
final class PlumeColorTable: @unchecked Sendable {
    static let steps = 128
    let cgColors: [CGColor]
    private let lock = NSLock()
    private var glow: [Int: [CGColor]] = [:]

    private init(palette: PlumePalette) {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        cgColors = (0..<Self.steps).map { i in
            let c = plumeColorComponents(heat: Double(i) / Double(Self.steps - 1), palette: palette)
            return CGColor(colorSpace: space, components: [CGFloat(c.red), CGFloat(c.green), CGFloat(c.blue), 1])!
        }
    }

    static func step(heat: Double) -> Int {
        Int((min(max(heat, 0), 1) * Double(steps - 1)).rounded())
    }

    func cgColor(heat: Double) -> CGColor { cgColors[Self.step(heat: heat)] }

    /// The glow gradient's colours at `heat`: the puff's colour at `PlumeGlow.alphas` × `strength`.
    func glowColors(heat: Double) -> [CGColor] {
        let step = Self.step(heat: heat)
        lock.lock(); defer { lock.unlock() }
        if let cached = glow[step] { return cached }
        let made = PlumeGlow.alphas.map { cgColors[step].copy(alpha: CGFloat($0 * PlumeGlow.strength)) ?? cgColors[step] }
        glow[step] = made
        return made
    }

    private static let cacheLock = NSLock()
    nonisolated(unsafe) private static var cache: [[Double]: PlumeColorTable] = [:]

    /// The table for `palette`, made on first use (there are eight palettes).
    static func table(for palette: PlumePalette) -> PlumeColorTable {
        let key = [palette.tail.red, palette.tail.green, palette.tail.blue, palette.body.red, palette.body.green, palette.body.blue,
                   palette.hot.red, palette.hot.green, palette.hot.blue]
        cacheLock.lock(); defer { cacheLock.unlock() }
        if let cached = cache[key] { return cached }
        let made = PlumeColorTable(palette: palette)
        cache[key] = made
        return made
    }
}

// MARK: - Symbols

/// A tool's SF Symbol as an image in one colour, drawn once per (symbol, colour) and shared by every tile that wears it.
@MainActor
enum PlumeSymbolImages {
    private static var cache: [String: CGImage] = [:]
    private static let weight: NSFont.Weight = .medium

    static func image(symbol: String, tint: CGColor) -> CGImage? {
        let key = symbol + "|" + (tint.components?.map { String(format: "%.3f", Double($0)) }.joined(separator: ",") ?? "")
        if let cached = cache[key] { return cached }
        guard let base = NSImage(systemSymbolName: symbol, accessibilityDescription: nil),
              let sized = base.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 64, weight: weight)) else { return nil }
        let scale: CGFloat = 2
        let width = max(1, Int(ceil(sized.size.width * scale))), height = max(1, Int(ceil(sized.size.height * scale)))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let bounds = NSRect(x: 0, y: 0, width: width, height: height)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        sized.draw(in: bounds)
        // The symbol's shape is its alpha; the colour replaces whatever it was drawn in.
        context.setBlendMode(.sourceIn)
        context.setFillColor(tint)
        context.fill(bounds)
        NSGraphicsContext.restoreGraphicsState()
        guard let drawn = context.makeImage() else { return nil }
        // A symbol's image carries margin around its strokes; the tile fits the GLYPH to its box, so crop to it.
        let image = tightlyCropped(drawn, context: context) ?? drawn
        cache[key] = image
        return image
    }

    /// `image` cut to the pixels with any alpha (nil when it has none, or the scan cannot read the bitmap).
    private static func tightlyCropped(_ image: CGImage, context: CGContext) -> CGImage? {
        guard let data = context.data else { return nil }
        let width = context.width, height = context.height, stride = context.bytesPerRow
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        var minX = width, maxX = -1, minY = height, maxY = -1
        for y in 0..<height {
            let row = bytes + y * stride
            for x in 0..<width where row[x * 4 + 3] > 8 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return image.cropping(to: CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))
    }
}

// MARK: - The view

@MainActor
final class PlumeLayerView: NSView {
    /// Tests host plumes in windows that are never shown; a plume there still runs when this is set.
    static var runsInUnshownWindows = false
    /// Offscreen renders (`cacheDisplay` draws a layer's own values, never its animations) set this to get each plume
    /// as one still frame of its model, the way Reduce Motion draws it.
    static var rendersStillFrames = false
    /// How many plumes are ticking right now (tests: none may outlive its window).
    private(set) static var tickingCount = 0
    /// How often the model is advanced and the layers that were born since are started. The render server does the
    /// motion between.
    static let tickInterval: TimeInterval = 0.1
    /// The longest gap one tick closes in a single go: a plume that was paused (hidden) catches up by this much and no more.
    static let maxCatchUp: TimeInterval = 1.5

    private(set) var model: WorkingAnimationModel
    private(set) var palette: PlumePalette = .blue
    private var thrown: [PlumeThrow] = []
    private var repeating: [PlumeThrow] = []
    private var emitterInset: CGFloat?
    private(set) var animates = true
    /// A frame drawn from the model as it is, never advanced (`initialModel`, and Reduce Motion).
    private let frozen: Bool

    private let glowHost = CALayer()
    private let discHost = CALayer()
    private let tileHost = CALayer()

    private var timer: Timer?
    private var lastTick: CFTimeInterval?
    private var nextPuffSerial = 0
    private var nextTokenSerial = 0
    private var laidOutSize: CGSize = .zero
    private var observedWindow: NSWindow?

    private var activePuffs: [PuffSprite] = []
    private var freePuffs: [PuffSprite] = []
    private var activeTiles: [TileSprite] = []
    private var freeTiles: [TileSprite] = []

    init(model: WorkingAnimationModel, frozen: Bool) {
        self.model = model
        self.frozen = frozen
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true
        for host in [glowHost, discHost, tileHost] { layer?.addSublayer(host) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    var isTicking: Bool { timer != nil }
    var activePuffCount: Int { activePuffs.count }
    var activeTileCount: Int { activeTiles.count }
    var pooledLayerCount: Int { freePuffs.count + freeTiles.count }

    // MARK: Configuration

    func configure(thrown: [PlumeThrow], repeating: [PlumeThrow], emitterInset: CGFloat?, palette: PlumePalette, animates: Bool) {
        self.thrown = thrown
        self.repeating = repeating
        var restyle = false
        if palette != self.palette { self.palette = palette; restyle = true }
        if emitterInset != self.emitterInset { self.emitterInset = emitterInset; restyle = true }
        let animatesChanged = animates != self.animates
        self.animates = animates
        if restyle || animatesChanged { resetSprites() }
        updateRunState()
        if !isTicking { renderStatic() }
    }

    // MARK: Geometry

    private var rect: CGRect { CGRect(origin: .zero, size: bounds.size) }
    private var emitterX: CGFloat { bounds.width - (emitterInset ?? bounds.height / 2) }
    private var tailX: CGFloat { PropulsionPlume.tailX(height: bounds.height) }
    private var hasArea: Bool { bounds.width > 0 && bounds.height > 0 }
    /// A point in the plume's coordinates (y down) as a layer position (y up).
    private func flip(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x, y: bounds.height - point.y) }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for host in [glowHost, discHost, tileHost] { host.frame = bounds }
        CATransaction.commit()
        guard bounds.size != laidOutSize else { return }
        laidOutSize = bounds.size
        // Every flight in the air was sampled for the old size: start them again for the new one (same birth, so
        // they carry on from where they are).
        if isTicking { restartFlights(now: CACurrentMediaTime()) } else { resetSprites(); renderStatic() }
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        for sprite in activeTiles + freeTiles { sprite.setContentsScale(scale) }
    }

    // MARK: Running

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if observedWindow !== window {
            if let observedWindow {
                NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: observedWindow)
            }
            observedWindow = window
            if let window {
                NotificationCenter.default.addObserver(self, selector: #selector(windowOcclusionChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
            }
        }
        updateRunState()
    }

    override func viewDidHide() { super.viewDidHide(); updateRunState() }
    override func viewDidUnhide() { super.viewDidUnhide(); updateRunState() }

    @objc private func windowOcclusionChanged(_ note: Notification) { updateRunState() }

    /// On screen: in a window that is visible (or a test window that is allowed to run), and not hidden.
    var isShown: Bool {
        guard let window, !isHiddenOrHasHiddenAncestor else { return false }
        return Self.runsInUnshownWindows || window.occlusionState.contains(.visible)
    }

    private func updateRunState() {
        let shouldRun = !frozen && animates && isShown && !Self.rendersStillFrames
        if shouldRun, timer == nil {
            // Whatever flew while it was away is over: begin again from the model, caught up by the time that passed.
            resetSprites()
            let timer = Timer(timeInterval: Self.tickInterval, repeats: true) { [weak self] timer in
                // A view that was released with its window never reaches `viewDidMoveToWindow(nil)`: its timer ends here.
                guard let self else {
                    timer.invalidate()
                    MainActor.assumeIsolated { Self.tickingCount -= 1 }
                    return
                }
                MainActor.assumeIsolated { self.tick(now: CACurrentMediaTime()) }
            }
            timer.tolerance = Self.tickInterval * 0.3
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            Self.tickingCount += 1
            tick(now: CACurrentMediaTime())
        } else if !shouldRun, let timer {
            timer.invalidate()
            self.timer = nil
            Self.tickingCount -= 1
        }
    }

    // MARK: The tick

    /// Advances the model to `now`, starts the flights of what was born since, and retires the ones that have landed.
    func tick(now: CFTimeInterval) {
        guard !frozen else { return }
        let gap = lastTick.map { min(max(now - $0, 0), Self.maxCatchUp) } ?? 0
        lastTick = now
        let steps = max(1, Int((gap / WorkingAnimationModel.maxStep).rounded(.up)))
        for _ in 0..<steps {
            model.tick(dt: gap / Double(steps), thrown: thrown, repeating: repeating, animatesPlume: animates)
        }
        if hasArea { startNewFlights(now: now) }
        retire(now: now)
        refreshFavicons()
    }

    private func startNewFlights(now: CFTimeInterval) {
        for puff in model.plume.puffs where puff.serial >= nextPuffSerial {
            let circle = PropulsionPlume.circle(for: puff, in: rect, emitterX: emitterX, tailX: tailX)
            guard circle.diameter > 0.25 else { continue }
            fly(dequeuePuff(), puff: puff, begin: now - puff.age)
        }
        nextPuffSerial = model.plume.spawnedPuffs
        for token in model.plume.tokens where token.serial >= nextTokenSerial {
            fly(dequeueTile(), token: token, begin: now - token.age)
        }
        nextTokenSerial = model.plume.launchedTokens
    }

    private func restartFlights(now: CFTimeInterval) {
        guard hasArea else { return }
        for sprite in activePuffs { if let puff = sprite.puff { fly(sprite, puff: puff, begin: sprite.begin) } }
        for sprite in activeTiles { if let token = sprite.token { fly(sprite, token: token, begin: sprite.begin) } }
    }

    private func retire(now: CFTimeInterval) {
        activePuffs.removeAll { sprite in
            guard sprite.expiry <= now else { return false }
            sprite.hide()
            freePuffs.append(sprite)
            return true
        }
        activeTiles.removeAll { sprite in
            guard sprite.expiry <= now else { return false }
            sprite.hide()
            freeTiles.append(sprite)
            return true
        }
    }

    /// Takes every layer out of the air and forgets what was bound, so the next tick starts over from the model.
    private func resetSprites() {
        for sprite in activePuffs { sprite.hide(); freePuffs.append(sprite) }
        for sprite in activeTiles { sprite.hide(); freeTiles.append(sprite) }
        activePuffs.removeAll()
        activeTiles.removeAll()
        nextPuffSerial = 0
        nextTokenSerial = 0
    }

    // MARK: Flights

    private func dequeuePuff() -> PuffSprite {
        let sprite = freePuffs.popLast() ?? PuffSprite(glowHost: glowHost, discHost: discHost)
        activePuffs.append(sprite)
        return sprite
    }

    private func dequeueTile() -> TileSprite {
        let sprite = freeTiles.popLast() ?? TileSprite(host: tileHost)
        sprite.setContentsScale(window?.backingScaleFactor ?? 2)
        activeTiles.append(sprite)
        return sprite
    }

    private func fly(_ sprite: PuffSprite, puff: PropulsionPlume.Puff, begin: CFTimeInterval) {
        let table = PlumeColorTable.table(for: palette)
        let path = PlumeFlight.puff(puff, in: rect, emitterX: emitterX, tailX: tailX)
        sprite.puff = puff
        sprite.begin = begin
        sprite.expiry = begin + puff.lifetime + 0.05
        sprite.build(spark: puff.spark, height: bounds.height, serial: puff.serial)
        let centers = path.centers.map { flip($0) }
        sprite.fly(path: path, centers: centers, colors: path.heats.map { table.cgColor(heat: $0) },
                   glows: puff.spark ? [] : path.heats.map { table.glowColors(heat: $0) },
                   duration: puff.lifetime, begin: begin)
    }

    private func fly(_ sprite: TileSprite, token: PropulsionPlume.Token, begin: CFTimeInterval) {
        let path = PlumeFlight.tile(token, in: rect, emitterX: emitterX, tailX: tailX)
        sprite.token = token
        sprite.begin = begin
        sprite.expiry = begin + token.lifetime + 0.05
        sprite.build(item: token.item, side: PlumeFlight.baseSide(height: bounds.height), palette: palette, serial: token.serial)
        sprite.fly(path: path, centers: path.centers.map { flip($0) }, duration: token.lifetime, begin: begin)
    }

    /// A tile whose site's favicon was still loading when it left the nozzle takes it up as soon as it arrives.
    private func refreshFavicons() {
        for sprite in activeTiles { sprite.refreshFavicon() }
    }

    // MARK: A still frame

    /// The plume as the model stands, nothing moving: a frozen view (`initialModel`) and Reduce Motion.
    private func renderStatic() {
        guard hasArea, frozen || !animates || Self.rendersStillFrames else { return }
        resetSprites()
        let table = PlumeColorTable.table(for: palette)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for puff in model.plume.puffs {
            let circle = PropulsionPlume.circle(for: puff, in: rect, emitterX: emitterX, tailX: tailX)
            guard circle.diameter > 0.25 else { continue }
            let base = PlumeFlight.baseDiameter(spark: puff.spark, height: bounds.height)
            let sprite = dequeuePuff()
            sprite.build(spark: puff.spark, height: bounds.height, serial: puff.serial)
            sprite.place(center: flip(circle.center), scale: circle.diameter / base, color: table.cgColor(heat: circle.heat),
                         glow: puff.spark ? [] : table.glowColors(heat: circle.heat))
        }
        for token in model.plume.tokens {
            let tile = PropulsionPlume.tile(for: token, in: rect, emitterX: emitterX, tailX: tailX)
            guard tile.side > 0.5 else { continue }
            let sprite = dequeueTile()
            sprite.build(item: token.item, side: PlumeFlight.baseSide(height: bounds.height), palette: palette, serial: token.serial)
            sprite.place(center: flip(tile.center), scale: tile.side / PlumeFlight.baseSide(height: bounds.height))
        }
        CATransaction.commit()
    }

    // MARK: Test seams

    /// The layers a test can look at: a puff's disc and its glow, a tile's root.
    var discLayersForTesting: [CALayer] { activePuffs.map(\.disc) }
    /// The birth serial of every puff in the air: no number twice, none missing.
    var boundPuffSerialsForTesting: [Int] { activePuffs.compactMap { $0.puff?.serial } }
    var glowLayersForTesting: [CALayer] { activePuffs.compactMap { $0.puff?.spark == true ? nil : $0.glow } }
    var tileLayersForTesting: [CALayer] { activeTiles.map(\.root) }
    var tileContentsForTesting: [CALayer] { activeTiles.map(\.content) }
    static let flightKey = PuffSprite.flightKey
}

// MARK: - Sprites

/// One puff: its disc, and (for a puff, not a spark) the glow under it. Reused from a pool as flights end.
@MainActor
private final class PuffSprite {
    static let flightKey = "flight"

    let disc = CALayer()
    let glow = CAGradientLayer()
    var puff: PropulsionPlume.Puff?
    var begin: CFTimeInterval = 0
    var expiry: CFTimeInterval = 0

    init(glowHost: CALayer, discHost: CALayer) {
        glow.type = .radial
        glow.startPoint = CGPoint(x: 0.5, y: 0.5)
        glow.endPoint = CGPoint(x: 1, y: 1)
        glow.locations = PlumeGlow.locations.map { NSNumber(value: $0) }
        glow.isHidden = true
        disc.isHidden = true
        glowHost.addSublayer(glow)
        discHost.addSublayer(disc)
    }

    /// Sizes the layers for a puff of this kind in a plume this high; ordering is by birth, sparks over every puff.
    func build(spark: Bool, height: CGFloat, serial: Int) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let base = PlumeFlight.baseDiameter(spark: spark, height: height)
        disc.bounds = CGRect(x: 0, y: 0, width: base, height: base)
        disc.cornerRadius = base / 2
        disc.opacity = spark ? 0.95 : 1
        disc.zPosition = CGFloat(spark ? 1_000_000 + serial : serial)
        disc.isHidden = false
        if spark {
            glow.isHidden = true
        } else {
            let side = base * PlumeGlow.reach
            glow.bounds = CGRect(x: 0, y: 0, width: side, height: side)
            glow.zPosition = CGFloat(serial)
            glow.isHidden = false
        }
        CATransaction.commit()
    }

    func place(center: CGPoint, scale: CGFloat, color: CGColor, glow glowColors: [CGColor]) {
        disc.position = center
        disc.transform = CATransform3DMakeScale(scale, scale, 1)
        disc.backgroundColor = color
        if !glowColors.isEmpty {
            glow.position = center
            glow.transform = CATransform3DMakeScale(scale, scale, 1)
            glow.colors = glowColors
        }
    }

    func fly(path: PlumeFlight.Path, centers: [CGPoint], colors: [CGColor], glows: [[CGColor]],
             duration: CFTimeInterval, begin: CFTimeInterval) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        place(center: centers[0], scale: path.scales[0], color: colors[0], glow: glows.first ?? [])
        CATransaction.commit()
        let times = path.keyTimes.map { NSNumber(value: $0) }
        func animation(_ keyPath: String, _ values: [Any]) -> CAKeyframeAnimation {
            let a = CAKeyframeAnimation(keyPath: keyPath)
            a.values = values
            a.keyTimes = times
            a.calculationMode = .linear
            a.duration = duration
            return a
        }
        let position = animation("position", centers.map { NSValue(point: $0) })
        let scale = animation("transform.scale", path.scales.map { NSNumber(value: Double($0)) })
        let color = animation("backgroundColor", colors)
        disc.add(Self.group([position, scale, color], duration: duration, begin: begin), forKey: Self.flightKey)
        if !glows.isEmpty {
            glow.add(Self.group([animation("position", centers.map { NSValue(point: $0) }),
                                 animation("transform.scale", path.scales.map { NSNumber(value: Double($0)) }),
                                 animation("colors", glows)], duration: duration, begin: begin), forKey: Self.flightKey)
        }
    }

    static func group(_ animations: [CAAnimation], duration: CFTimeInterval, begin: CFTimeInterval) -> CAAnimationGroup {
        let group = CAAnimationGroup()
        group.animations = animations
        group.duration = duration
        group.beginTime = begin
        // Held on its last frame (past the plume's leading edge, which clips it) until it is retired.
        group.fillMode = .forwards
        group.isRemovedOnCompletion = false
        return group
    }

    func hide() {
        disc.removeAllAnimations()
        glow.removeAllAnimations()
        disc.isHidden = true
        glow.isHidden = true
        puff = nil
    }
}

/// One thrown tile: a white disc holding a tool's symbol or a site's favicon, riding the plume.
@MainActor
private final class TileSprite {
    let root = CALayer()
    private let disc = CALayer()
    private let clip = CALayer()
    let content = CALayer()
    var token: PropulsionPlume.Token?
    var begin: CFTimeInterval = 0
    var expiry: CFTimeInterval = 0
    private var awaitingFavicon: (host: String, iconURL: String?)?
    private var side: CGFloat = 0

    init(host: CALayer) {
        root.isHidden = true
        disc.backgroundColor = CGColor(gray: 1, alpha: 1)
        content.contentsGravity = .resizeAspect
        content.minificationFilter = .trilinear
        root.addSublayer(disc)
        root.addSublayer(clip)
        clip.addSublayer(content)
        host.addSublayer(root)
    }

    func setContentsScale(_ scale: CGFloat) {
        for layer in [root, disc, clip, content] { layer.contentsScale = scale }
    }

    func build(item: PlumeThrow, side: CGFloat, palette: PlumePalette, serial: Int) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        self.side = side
        root.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        root.zPosition = CGFloat(serial)
        root.isHidden = false
        disc.frame = root.bounds
        disc.cornerRadius = side / 2
        awaitingFavicon = nil
        switch item.kind {
        case .tool(let symbol):
            showSymbol(symbol, tint: PlumeColorTable.table(for: palette).cgColor(heat: 0), box: 0.5)
        case .site(let host, let iconURL):
            if !showFavicon(host: host, iconURL: iconURL) {
                awaitingFavicon = (host, iconURL)
                showSymbol("globe", tint: CGColor(gray: 0.45, alpha: 1), box: 0.58)
            }
        }
        CATransaction.commit()
    }

    /// A tool's symbol in a `box` (share of the tile's side) square at the centre.
    private func showSymbol(_ symbol: String, tint: CGColor, box: CGFloat) {
        clip.frame = root.bounds
        clip.cornerRadius = 0
        clip.masksToBounds = false
        content.bounds = CGRect(x: 0, y: 0, width: side * box, height: side * box)
        content.position = CGPoint(x: side / 2, y: side / 2)
        content.contentsGravity = .resizeAspect
        content.contents = PlumeSymbolImages.image(symbol: symbol, tint: tint)
    }

    /// A site's favicon in the square the Canvas stretched it into (64% of the tile), cropped to a circle a little wider (72%).
    @discardableResult
    private func showFavicon(host: String, iconURL: String?) -> Bool {
        guard let image = FaviconCache.shared.image(host: host, iconURL: iconURL),
              let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return false }
        let crop = side * 0.72
        clip.bounds = CGRect(x: 0, y: 0, width: crop, height: crop)
        clip.position = CGPoint(x: side / 2, y: side / 2)
        clip.cornerRadius = crop / 2
        clip.masksToBounds = true
        content.bounds = CGRect(x: 0, y: 0, width: side * 0.64, height: side * 0.64)
        content.position = CGPoint(x: crop / 2, y: crop / 2)
        content.contentsGravity = .resize
        content.contents = cg
        return true
    }

    func refreshFavicon() {
        guard let waiting = awaitingFavicon else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if showFavicon(host: waiting.host, iconURL: waiting.iconURL) { awaitingFavicon = nil }
        CATransaction.commit()
    }

    func place(center: CGPoint, scale: CGFloat) {
        root.position = center
        root.transform = CATransform3DMakeScale(scale, scale, 1)
    }

    func fly(path: PlumeFlight.Path, centers: [CGPoint], duration: CFTimeInterval, begin: CFTimeInterval) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        place(center: centers[0], scale: path.scales[0])
        CATransaction.commit()
        let times = path.keyTimes.map { NSNumber(value: $0) }
        let position = CAKeyframeAnimation(keyPath: "position")
        position.values = centers.map { NSValue(point: $0) }
        let scale = CAKeyframeAnimation(keyPath: "transform.scale")
        scale.values = path.scales.map { NSNumber(value: Double($0)) }
        for a in [position, scale] {
            a.keyTimes = times
            a.calculationMode = .linear
            a.duration = duration
        }
        root.add(PuffSprite.group([position, scale], duration: duration, begin: begin), forKey: PuffSprite.flightKey)
    }

    func hide() {
        root.removeAllAnimations()
        root.isHidden = true
        token = nil
        awaitingFavicon = nil
        content.contents = nil
        content.contentsGravity = .resizeAspect
    }
}

// MARK: - In SwiftUI

struct PlumeLayerRepresentable: NSViewRepresentable {
    var thrown: [PlumeThrow]
    var repeating: [PlumeThrow]
    var emitterInset: CGFloat?
    var palette: PlumePalette
    var animates: Bool
    /// A model to draw as it stands, once: offscreen renders. The app never passes one.
    var initialModel: WorkingAnimationModel?

    func makeNSView(context: Context) -> PlumeLayerView {
        let view = PlumeLayerView(model: initialModel ?? WorkingAnimationView.freshModel, frozen: initialModel != nil)
        configure(view)
        return view
    }

    func updateNSView(_ view: PlumeLayerView, context: Context) {
        configure(view)
    }

    private func configure(_ view: PlumeLayerView) {
        view.configure(thrown: thrown, repeating: repeating, emitterInset: emitterInset, palette: palette, animates: animates)
    }
}
