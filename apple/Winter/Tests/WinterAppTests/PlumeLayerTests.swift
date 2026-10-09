import XCTest
import SwiftUI
import AppKit
import Metal
import QuartzCore
@testable import Winter

/// The plume on Core Animation (`PlumeLayerView`): its flights are the pure layout sampled, every live puff gets exactly
/// one, a plume that is not on screen does nothing, and a late tick shows nothing late.
@MainActor
final class PlumeLayerTests: XCTestCase {
    /// Every window a test hosted a plume in: emptied at the end, which stops the plume's timer (a plume left ticking
    /// would cost the next test its main thread).
    private var windows: [NSWindow] = []

    override func setUp() {
        super.setUp()
        PlumeLayerView.runsInUnshownWindows = true
    }

    override func tearDown() {
        for window in windows { window.contentView = NSView() }
        windows.removeAll()
        XCTAssertEqual(PlumeLayerView.tickingCount, 0, "no plume outlives its window")
        PlumeLayerView.runsInUnshownWindows = false
        super.tearDown()
    }

    private let size = CGSize(width: 380, height: 44)

    private func host(model: WorkingAnimationModel = WorkingAnimationModel(seed: 5), frozen: Bool = false,
                      thrown: [PlumeThrow] = [], animates: Bool = true, inWindow: Bool = true) -> (PlumeLayerView, NSWindow) {
        let view = PlumeLayerView(model: model, frozen: frozen)
        view.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: true)
        if inWindow { window.contentView = view }
        windows.append(window)
        view.configure(thrown: thrown, repeating: thrown, emitterInset: nil, palette: .blue, animates: animates)
        view.layoutSubtreeIfNeeded()
        return (view, window)
    }

    private var rect: CGRect { CGRect(origin: .zero, size: size) }
    private var emitterX: CGFloat { size.width - size.height / 2 }
    private var tailX: CGFloat { PropulsionPlume.tailX(height: size.height) }

    // MARK: Flights

    func testAPuffsFlightIsTheLayoutSampledAcrossItsLife() {
        let puff = PropulsionPlume.Puff(age: 0, lifetime: 1.2, lane: 0.7, size: 0.9, spark: false)
        let flight = PlumeFlight.puff(puff, in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertEqual(flight.keyTimes.count, 16)
        XCTAssertEqual(flight.centers.count, 16)
        for (i, p) in flight.keyTimes.enumerated() {
            var at = puff
            at.age = p * puff.lifetime
            let circle = PropulsionPlume.circle(for: at, in: rect, emitterX: emitterX, tailX: tailX)
            XCTAssertEqual(flight.centers[i].x, circle.center.x, accuracy: 0.0001)
            XCTAssertEqual(flight.centers[i].y, circle.center.y, accuracy: 0.0001)
            XCTAssertEqual(flight.scales[i] * PlumeFlight.baseDiameter(spark: false, height: size.height), circle.diameter, accuracy: 0.0001)
            XCTAssertEqual(flight.heats[i], circle.heat, accuracy: 0.0001)
        }
        XCTAssertTrue(flight.scales.allSatisfy { $0 <= 1.0001 }, "no puff is wider than the sprite it flies on")
    }

    /// The straight segments between samples stay within a point of the curve they stand for — the render server
    /// interpolates linearly between keyframes, so this is the most the eye could see of the sampling.
    func testTheSamplesTrackTheCurveBetweenThem() {
        let puff = PropulsionPlume.Puff(age: 0, lifetime: 1.1, lane: -0.8, size: 1, spark: false)
        let flight = PlumeFlight.puff(puff, in: rect, emitterX: emitterX, tailX: tailX)
        var worst: CGFloat = 0
        for segment in 0..<(flight.keyTimes.count - 1) {
            for t in stride(from: 0.1, to: 1.0, by: 0.1) {
                let p = flight.keyTimes[segment] + t * (flight.keyTimes[segment + 1] - flight.keyTimes[segment])
                var at = puff
                at.age = p * puff.lifetime
                let truth = PropulsionPlume.circle(for: at, in: rect, emitterX: emitterX, tailX: tailX).center
                let a = flight.centers[segment], b = flight.centers[segment + 1]
                let x = a.x + (b.x - a.x) * CGFloat(t), y = a.y + (b.y - a.y) * CGFloat(t)
                worst = max(worst, hypot(x - truth.x, y - truth.y))
            }
        }
        XCTAssertLessThan(worst, 1.0, "points between samples are within a point of the true path (the worst is 0.7, where p^1.7 bends hardest)")
    }

    func testATilesFlightGrowsOutOfTheNozzleAndSettles() {
        let token = PropulsionPlume.Token(age: 0, lifetime: 1.8, lane: 0.6, item: PlumeThrow(id: "t", kind: .tool(symbol: "terminal")))
        let flight = PlumeFlight.tile(token, in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertEqual(flight.scales.first!, 0.35, accuracy: 0.001, "it leaves the nozzle at 35% of its size")
        XCTAssertEqual(flight.scales.last!, 1, accuracy: 0.001, "and rides at its settled size")
        XCTAssertEqual(flight.scales[2], 1, accuracy: 0.001, "it has settled by 8% of its life (a sample sits on the kink)")
        XCTAssertLessThan(flight.centers.last!.x, 0, "it ends past the plume's leading edge, where the pill clips it")
    }

    // MARK: What is thrown

    func testAnExchangesThrowsAreWorkedOutOncePerContentAndRecomputedWhenItChanges() {
        func call(_ id: String, _ name: String) -> ActivityItem {
            ActivityItem(kind: .tool(name: name, detail: "", callId: id, output: "done"))
        }
        var exchange = Exchange(prompt: "go", reply: "", activity: [call("a", "bash")])
        let first = plumeThrows(for: exchange)
        XCTAssertEqual(first.map(\.id), ["a"])
        XCTAssertEqual(plumeThrows(for: exchange), first, "asked again, the same answer (from the memo)")
        XCTAssertEqual(plumeThrows(for: exchange), Array(plumeThrows(inActivity: exchange.activity).suffix(plumeThrowWindow)))
        exchange.appendActivityItem(call("b", "read"))
        XCTAssertEqual(plumeThrows(for: exchange).map(\.id), ["a", "b"], "a changed exchange has a new stamp, so the memo cannot answer for it")
        XCTAssertEqual(plumeThrows(for: nil), [])
    }

    // MARK: Binding

    private func visibleSerials(_ view: PlumeLayerView) -> Set<Int> {
        Set(view.model.plume.puffs.filter { PropulsionPlume.circle(for: $0, in: rect, emitterX: emitterX, tailX: tailX).diameter > 0.25 }.map(\.serial))
    }

    func testEveryLivePuffGetsOneFlightAndNeverTwo() {
        let (view, window) = host()
        withExtendedLifetime(window) {
            let start = CACurrentMediaTime()
            view.tick(now: start)
            XCTAssertEqual(Set(view.boundPuffSerialsForTesting), visibleSerials(view), "a plume appears already full")
            XCTAssertGreaterThan(view.activePuffCount, 20)
            for disc in view.discLayersForTesting { XCTAssertNotNil(disc.animation(forKey: PlumeLayerView.flightKey)) }
            XCTAssertEqual(view.glowLayersForTesting.count, view.model.plume.puffs.filter { !$0.spark }.count)

            var now = start
            for _ in 0..<20 {
                now += 0.1
                view.tick(now: now)
                let bound = view.boundPuffSerialsForTesting
                XCTAssertEqual(bound.count, Set(bound).count, "no puff flies twice")
                XCTAssertTrue(visibleSerials(view).isSubset(of: Set(bound)), "and every one that is alive is flying")
            }
        }
    }

    func testAFlightIsBackDatedByTheAgeItAlreadyHas() {
        let (view, window) = host()
        withExtendedLifetime(window) {
            let now = CACurrentMediaTime()
            view.tick(now: now)
            for (puff, disc) in zip(view.model.plume.puffs, view.discLayersForTesting) {
                guard let group = disc.animation(forKey: PlumeLayerView.flightKey) as? CAAnimationGroup else { return XCTFail("no flight") }
                XCTAssertEqual(group.beginTime, now - puff.age, accuracy: 0.0001, "it starts as old as it is, so a late tick shows nothing late")
                XCTAssertEqual(group.duration, puff.lifetime, accuracy: 0.0001)
                XCTAssertEqual(group.animations?.count, 3, "position, size and colour")
            }
        }
    }

    func testFlightsThatHaveLandedAreRetiredAndTheirLayersReused() {
        let (view, window) = host()
        withExtendedLifetime(window) {
            var now = CACurrentMediaTime()
            for _ in 0..<60 { view.tick(now: now); now += 0.1 }
            XCTAssertLessThan(view.activePuffCount, 70, "a puff lives about a second: six seconds of ticks leave about a second's worth")
            XCTAssertGreaterThan(view.pooledLayerCount, 0, "and the layers of the ones that landed wait to be reused")
            let layers = view.discLayersForTesting.count + view.pooledLayerCount
            for _ in 0..<60 { view.tick(now: now); now += 0.1 }
            XCTAssertLessThanOrEqual(view.discLayersForTesting.count + view.pooledLayerCount, layers + 12, "no growth: the pool is the plume's high-water mark")
        }
    }

    func testALateTickCatchesTheModelUpByTheTimeThatPassed() {
        let (view, window) = host()
        withExtendedLifetime(window) {
            let now = CACurrentMediaTime()
            view.tick(now: now)
            let before = view.model.plume.spawnedPuffs
            view.tick(now: now + 0.5)
            XCTAssertEqual(Double(view.model.plume.spawnedPuffs - before), 0.5 * (PropulsionPlume.puffsPerSecond + PropulsionPlume.sparksPerSecond), accuracy: 3,
                           "half a second late is half a second of births, each flying from the age it has")
        }
    }

    // MARK: Tiles

    func testAThrownToolBecomesATileWithItsSymbol() {
        let first = PlumeThrow(id: "1", kind: .tool(symbol: "terminal"))
        let (view, window) = host(thrown: [])
        withExtendedLifetime(window) {
            var now = CACurrentMediaTime()
            view.tick(now: now) // primes: what is there at the start was thrown before the plume appeared
            view.configure(thrown: [first], repeating: [first], emitterInset: nil, palette: .blue, animates: true)
            for _ in 0..<6 { now += 0.1; view.tick(now: now) }
            XCTAssertGreaterThanOrEqual(view.activeTileCount, 1)
            XCTAssertNotNil(view.tileContentsForTesting.first?.contents, "the symbol is drawn once and shared")
            XCTAssertNotNil(view.tileLayersForTesting.first?.animation(forKey: PlumeLayerView.flightKey))
        }
    }

    func testASiteWithNoFaviconYetShowsAGlobe() {
        let site = PlumeThrow(id: "s", kind: .site(host: "no-such-host.invalid", iconURL: nil))
        let (view, window) = host()
        withExtendedLifetime(window) {
            var now = CACurrentMediaTime()
            view.tick(now: now)
            view.configure(thrown: [site], repeating: [site], emitterInset: nil, palette: .blue, animates: true)
            for _ in 0..<6 { now += 0.1; view.tick(now: now) }
            XCTAssertGreaterThanOrEqual(view.activeTileCount, 1)
            XCTAssertNotNil(view.tileContentsForTesting.first?.contents, "a grey globe until the icon arrives")
        }
    }

    // MARK: On screen

    func testAPlumeInAHiddenWindowDoesNothingAndPicksUpFullWhenShown() {
        PlumeLayerView.runsInUnshownWindows = false // a never-shown window is "not on screen"
        let (view, window) = host()
        withExtendedLifetime(window) {
            XCTAssertFalse(view.isTicking, "no timer for a plume nobody can see")
            XCTAssertEqual(view.activePuffCount, 0)
            PlumeLayerView.runsInUnshownWindows = true
            window.contentView = nil
            window.contentView = view // moves it again: now allowed to run
            XCTAssertTrue(view.isTicking)
            XCTAssertGreaterThan(view.activePuffCount, 20, "already full the moment it is shown")
        }
    }

    func testLeavingTheWindowStopsTheTimer() {
        let (view, window) = host()
        withExtendedLifetime(window) {
            XCTAssertTrue(view.isTicking)
            window.contentView = NSView()
            XCTAssertFalse(view.isTicking)
        }
    }

    func testHidingTheViewStopsTheTimer() {
        let (view, window) = host()
        withExtendedLifetime(window) {
            XCTAssertTrue(view.isTicking)
            view.isHidden = true
            XCTAssertFalse(view.isTicking)
            view.isHidden = false
            XCTAssertTrue(view.isTicking)
        }
    }

    // MARK: Still frames

    func testAFrozenPlumeIsPlacedWhereTheLayoutPutsEveryCircle() {
        var model = WorkingAnimationModel(seed: 11)
        model.tick(dt: 1.0 / 60.0)
        let (view, window) = host(model: model, frozen: true)
        withExtendedLifetime(window) {
            XCTAssertFalse(view.isTicking, "a frozen plume never ticks")
            let circles = model.plume.circles(in: rect, emitterX: emitterX, tailX: tailX)
            XCTAssertEqual(view.activePuffCount, circles.count)
            for (circle, disc) in zip(circles, view.discLayersForTesting) {
                XCTAssertEqual(disc.position.x, circle.center.x, accuracy: 0.001)
                XCTAssertEqual(disc.position.y, size.height - circle.center.y, accuracy: 0.001, "y is up in a layer")
                XCTAssertNil(disc.animation(forKey: PlumeLayerView.flightKey))
            }
        }
    }

    func testReduceMotionHoldsTheFirstFrameStill() {
        let (view, window) = host(animates: false)
        withExtendedLifetime(window) {
            XCTAssertFalse(view.isTicking)
            XCTAssertGreaterThan(view.activePuffCount, 20, "a still plume, not an empty one")
            for disc in view.discLayersForTesting { XCTAssertNil(disc.animation(forKey: PlumeLayerView.flightKey)) }
        }
    }

    func testResizingRestartsTheFlightsForTheNewGeometry() {
        let (view, window) = host()
        withExtendedLifetime(window) {
            view.tick(now: CACurrentMediaTime())
            let before = (view.discLayersForTesting.first?.animation(forKey: PlumeLayerView.flightKey) as? CAAnimationGroup)?.animations?.first as? CAKeyframeAnimation
            window.setContentSize(NSSize(width: 500, height: 44))
            view.layoutSubtreeIfNeeded()
            let after = (view.discLayersForTesting.first?.animation(forKey: PlumeLayerView.flightKey) as? CAAnimationGroup)?.animations?.first as? CAKeyframeAnimation
            let a = (before?.values?.first as? NSValue)?.pointValue, b = (after?.values?.first as? NSValue)?.pointValue
            XCTAssertNotNil(a)
            XCTAssertNotNil(b)
            XCTAssertNotEqual(a?.x, b?.x, "the nozzle moved with the trailing edge, so did every flight's start")
        }
    }

    // MARK: What the render server draws

    /// The layer tree drawn by a `CARenderer` (the render server's own renderer, animations and all) at a media time,
    /// as RGBA pixels at 2x — the one way to see what the keyframe animations DO without putting a window on screen.
    private func render(_ root: CALayer, at time: CFTimeInterval, size: CGSize) throws -> (pixels: [UInt8], width: Int, height: Int) {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice(), "a Metal device")
        let width = Int(size.width * 2), height = Int(size.height * 2)
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        let texture = try XCTUnwrap(device.makeTexture(descriptor: descriptor))
        let queue = try XCTUnwrap(device.makeCommandQueue())
        let renderer = CARenderer(mtlTexture: texture, options: [kCARendererMetalCommandQueue: queue])
        root.bounds = CGRect(origin: .zero, size: size) // an unlaid-out view's backing layer has none
        root.transform = CATransform3DMakeScale(2, 2, 1)
        root.anchorPoint = .zero
        root.position = .zero
        renderer.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        renderer.layer = root
        CATransaction.flush()
        renderer.beginFrame(atTime: time, timeStamp: nil)
        renderer.addUpdate(renderer.bounds)
        renderer.render()
        renderer.endFrame()
        // The render is encoded on `queue`: a command buffer behind it that has finished means it has too.
        let fence = try XCTUnwrap(queue.makeCommandBuffer())
        fence.commit()
        fence.waitUntilCompleted()
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        texture.getBytes(&pixels, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        return (pixels, width, height)
    }

    /// The brightness-weighted centre of the picture, x in points (nothing drawn: nil).
    private func centreX(_ image: (pixels: [UInt8], width: Int, height: Int)) -> (x: Double, lit: Int)? {
        var sum = 0.0, weight = 0.0, lit = 0
        for y in 0..<image.height {
            for x in 0..<image.width {
                let i = (y * image.width + x) * 4
                let v = (Double(image.pixels[i]) + Double(image.pixels[i + 1]) + Double(image.pixels[i + 2])) / 3
                if v > 12 { sum += v * Double(x); weight += v; lit += 1 }
            }
        }
        return weight > 0 ? (sum / weight / 2, lit) : nil
    }

    func testTheRendererItselfDrawsALayer() throws {
        let root = CALayer()
        let box = CALayer()
        box.backgroundColor = CGColor(red: 1, green: 0, blue: 0, alpha: 1)
        box.frame = CGRect(x: 10, y: 10, width: 100, height: 20)
        root.addSublayer(box)
        let image = try render(root, at: CACurrentMediaTime(), size: size)
        let lit = image.pixels.filter { $0 != 0 }.count
        XCTAssertGreaterThan(lit, 1_000, "the renderer harness itself draws (so a blank plume below would be the plume's)")
    }

    /// The animations, not just the layers they start from: drawn by the render server at the time the flights were
    /// bound, the plume is the frozen one; a fifth of a second later with no tick between, every puff has moved down
    /// the plume — toward the leading edge, left — by the layout's own `travelExponent` path.
    func testTheRenderServerFliesThePuffsDownThePlume() throws {
        let model = WorkingAnimationModel(seed: 5)
        let (animated, _) = host(model: model, inWindow: false)
        let (frozen, _) = host(model: model, frozen: true, inWindow: false)
        let animatedLayer = try XCTUnwrap(animated.layer)
        let frozenLayer = try XCTUnwrap(frozen.layer)
        for view in [animated, frozen] { view.layoutSubtreeIfNeeded() }
        let t0 = CACurrentMediaTime()
        animated.tick(now: t0)
        XCTAssertGreaterThan(animated.activePuffCount, 20)

        let now = try render(animatedLayer, at: t0, size: size)
        let still = try render(frozenLayer, at: t0, size: size)
        let later = try render(animatedLayer, at: t0 + 0.2, size: size)
        let a = try XCTUnwrap(centreX(now)), f = try XCTUnwrap(centreX(still)), l = try XCTUnwrap(centreX(later))
        print(String(format: "PLUME renderer: animated at bind %.1f pt, frozen %.1f pt, 0.2 s later %.1f pt (lit %d / %d / %d)", a.x, f.x, l.x, a.lit, f.lit, l.lit))
        XCTAssertGreaterThan(a.lit, 4_000, "the animated plume draws something at the time it was bound")
        XCTAssertEqual(a.x, f.x, accuracy: 6, "at that time it is the frozen plume: the animations start where the layout says")
        XCTAssertLessThan(l.x, a.x - 8, "and 0.2 s later it has flown toward the leading edge")
    }

    // MARK: Cost

    /// What one tick costs the main thread, with nothing else in the process to blur it: ten ticks make a second of
    /// plume, so a tick of 2 ms is 2%. (A Debug build; the Canvas this replaced took 8% of the thread.)
    func testATickCostsAMillisecondOrSo() {
        let throwsList = [PlumeThrow(id: "a", kind: .tool(symbol: "terminal")), PlumeThrow(id: "b", kind: .tool(symbol: "doc.text")),
                          PlumeThrow(id: "c", kind: .tool(symbol: "magnifyingglass"))]
        let (view, _) = host(thrown: throwsList, inWindow: false)
        var now = CACurrentMediaTime()
        for _ in 0..<20 { view.tick(now: now); now += 0.1 } // warm: symbols drawn, the pool filled
        let cpu = currentThreadCPUSeconds()
        for _ in 0..<100 { view.tick(now: now); now += 0.1 }
        let perTick = (currentThreadCPUSeconds() - cpu) / 100
        print(String(format: "PLUME tick: %.2f ms (%.2f%% of the main thread at ten a second)", perTick * 1000, perTick * 10 * 100))
        XCTAssertLessThan(perTick, 0.002, "seconds per tick")
    }

    /// One plume, on the real timer, for four seconds: the main thread's share. Skipped when another test left a plume
    /// ticking in this process (its cost would be counted here).
    func testThePlumeCostsTheMainThreadAlmostNothing() async throws {
        try XCTSkipUnless(PlumeLayerView.tickingCount == 0, "another test left a plume ticking")
        let throwsList = [PlumeThrow(id: "a", kind: .tool(symbol: "terminal")), PlumeThrow(id: "b", kind: .tool(symbol: "doc.text")),
                          PlumeThrow(id: "c", kind: .tool(symbol: "magnifyingglass"))]
        let (view, window) = host(thrown: throwsList)
        defer { withExtendedLifetime(window) {} }
        try await Task.sleep(nanoseconds: 1_000_000_000) // warm: symbols drawn, pool filled
        let cpu = currentThreadCPUSeconds()
        let start = DispatchTime.now().uptimeNanoseconds
        try await Task.sleep(nanoseconds: UInt64((Double(ProcessInfo.processInfo.environment["PLUME_SECONDS"] ?? "") ?? 4) * 1_000_000_000))
        let busy = (currentThreadCPUSeconds() - cpu) / (Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000)
        print(String(format: "PLUME layers: main thread busy %.2f%%", busy * 100))
        XCTAssertTrue(view.isTicking)
        XCTAssertLessThan(busy, 0.02, "the plume's share of the main thread")
    }
}
