import XCTest
import AppKit
@testable import Winter

/// The working animation's model: the plume's flow, what it throws and when it repeats,
/// and the tool→symbol map.
final class WorkingAnimationTests: XCTestCase {
    // MARK: - The plume

    private let rect = CGRect(x: 0, y: 0, width: 300, height: 44)
    private let emitterX: CGFloat = 278
    private let tailX: CGFloat = 50

    private func puff(_ progress: Double, lane: Double = 0, size: Double = 1, spark: Bool = false) -> PropulsionPlume.Puff {
        PropulsionPlume.Puff(age: progress, lifetime: 1, lane: lane, size: size, spark: spark)
    }

    func testAPuffIsBornAtTheNozzleBigHotAndOnTheMidLine() {
        let c = PropulsionPlume.circle(for: puff(0, lane: 1), in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertEqual(c.center.x, emitterX, accuracy: 1e-9)
        XCTAssertEqual(c.center.y, rect.midY, accuracy: 1e-9, "no spread yet at the nozzle")
        XCTAssertEqual(c.diameter, rect.height * PropulsionPlume.nozzleDiameterShare, accuracy: 1e-9)
        XCTAssertEqual(c.heat, 1)
    }

    func testDownThePlumeAPuffTravelsLeftShrinksSpreadsAndCools() {
        var last = PropulsionPlume.circle(for: puff(0, lane: 1), in: rect, emitterX: emitterX, tailX: tailX)
        for p in stride(from: 0.1, through: 0.8, by: 0.1) {
            let c = PropulsionPlume.circle(for: puff(p, lane: 1), in: rect, emitterX: emitterX, tailX: tailX)
            XCTAssertLessThan(c.center.x, last.center.x, "streams toward the leading end")
            XCTAssertLessThan(c.diameter, last.diameter, "shrinks")
            XCTAssertLessThan(c.heat, last.heat, "cools")
            XCTAssertGreaterThanOrEqual(c.center.y, last.center.y, "drifts out to its lane")
            last = c
        }
    }

    func testPuffsBunchAtTheNozzleAndThinOutDownstream() {
        // Equal slices of life cover less ground near the nozzle than near the tail — the clumping
        // that reads as thrust.
        let x = { (p: Double) in PropulsionPlume.circle(for: self.puff(p), in: self.rect,
                                                        emitterX: self.emitterX, tailX: self.tailX).center.x }
        XCTAssertLessThan(x(0) - x(0.2), x(0.6) - x(0.8))
    }

    /// The pill's own tail (`PropulsionPlume.tailX`), its leading edge at x = 0.
    private var realTail: CGFloat { PropulsionPlume.tailX(height: rect.height) }

    func testAPuffHasWhollyLeftThePillBeforeItIsDropped() {
        for size in [PropulsionPlume.puffSize.lowerBound, PropulsionPlume.puffSize.upperBound] {
            for spark in [false, true] {
                let end = PropulsionPlume.circle(for: puff(1, size: size, spark: spark), in: rect,
                                                 emitterX: emitterX, tailX: realTail)
                XCTAssertGreaterThan(end.diameter, 0, "it never shrinks to nothing in view")
                XCTAssertLessThanOrEqual(end.center.x + end.diameter / 2, 0, "out past the leading edge — no pop")
            }
        }
    }

    /// The user's report: puffs collapsed in the last centimetre. The shrink is by DISTANCE now, so
    /// every stretch of the pill takes the same bite out of a puff.
    func testAPuffShrinksAtOneRateAlongThePill() {
        let samples = stride(from: 0.0, through: 1.0, by: 0.05).map {
            PropulsionPlume.circle(for: puff($0), in: rect, emitterX: emitterX, tailX: realTail)
        }
        let rates = zip(samples, samples.dropFirst()).compactMap { a, b -> Double? in
            let dx = Double(a.center.x - b.center.x)
            return dx > 1e-6 ? Double(a.diameter - b.diameter) / dx : nil
        }
        XCTAssertFalse(rates.isEmpty)
        for rate in rates { XCTAssertEqual(rate, rates[0], accuracy: 1e-6, "the same shrink per point travelled") }
    }

    func testEveryCircleStaysInsideThePlumesHeight() {
        for p in stride(from: 0.0, through: 1.0, by: 0.05) {
            for lane in [-1.0, -0.4, 0, 0.7, 1] {
                for spark in [false, true] {
                    let c = PropulsionPlume.circle(for: puff(p, lane: lane, spark: spark), in: rect,
                                                   emitterX: emitterX, tailX: tailX)
                    XCTAssertGreaterThanOrEqual(c.center.y - c.diameter / 2, rect.minY - 1e-9)
                    XCTAssertLessThanOrEqual(c.center.y + c.diameter / 2, rect.maxY + 1e-9)
                }
            }
        }
    }

    func testSparksAreSmallHotAndQuickerThanPuffs() {
        let spark = PropulsionPlume.circle(for: puff(0.5, spark: true), in: rect, emitterX: emitterX, tailX: tailX)
        let puffCircle = PropulsionPlume.circle(for: puff(0.5), in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertLessThan(spark.diameter, puffCircle.diameter / 2)
        XCTAssertEqual(spark.heat, 1)
        XCTAssertLessThan(spark.center.x, puffCircle.center.x, "further down the plume at the same progress")
    }

    func testTheWorkingPlumeStartsFullAndStaysFull() {
        var model = WorkingAnimationModel()
        let initial = model.plume.circles(in: rect, emitterX: emitterX, tailX: tailX)
        XCTAssertGreaterThan(initial.count, 15, "pre-warmed: never visibly fills up")
        XCTAssertTrue(initial.contains { $0.center.x < (emitterX + tailX) / 2 }, "already reaching the tail")
        let cap = Int(PropulsionPlume.puffsPerSecond * PropulsionPlume.puffLifetime.upperBound
                      + PropulsionPlume.sparksPerSecond * PropulsionPlume.sparkLifetime.upperBound) + 2
        for _ in 0..<600 {
            model.tick(dt: 1.0 / 60.0)
            XCTAssertLessThanOrEqual(model.plume.puffs.count, cap)
            XCTAssertGreaterThan(model.plume.puffs.count, 15)
        }
    }

    func testThePlumeFlows() {
        var model = WorkingAnimationModel()
        let before = model.plume.puffs
        model.tick(dt: 1.0 / 60.0)
        let survivors = model.plume.puffs.prefix { p in before.contains { $0.lifetime == p.lifetime && $0.lane == p.lane } }
        XCTAssertFalse(survivors.isEmpty)
        for p in survivors {
            let old = before.first { $0.lifetime == p.lifetime && $0.lane == p.lane }!
            XCTAssertEqual(p.age, old.age + 1.0 / 60.0, accuracy: 1e-9, "every puff ages with the clock")
        }
    }

    func testAStallIsClampedAndReduceMotionHoldsThePlume() {
        var model = WorkingAnimationModel()
        let before = model.plume
        model.tick(dt: 30) // the app was suspended
        XCTAssertFalse(model.plume.puffs.isEmpty, "a long gap never empties the plume")
        var still = WorkingAnimationModel()
        still.tick(dt: 1.0 / 60.0, animatesPlume: false)
        XCTAssertEqual(still.plume, before, "Reduce Motion: the plume holds")
        var frozen = WorkingAnimationModel()
        frozen.tick(dt: -1)
        XCTAssertEqual(frozen.plume, before, "a negative dt is no time at all")
    }

    func testThePlumeIsReproducibleFromItsSeed() {
        var a = WorkingAnimationModel(seed: 42)
        var b = WorkingAnimationModel(seed: 42)
        for _ in 0..<90 { a.tick(dt: 1.0 / 60.0); b.tick(dt: 1.0 / 60.0) }
        XCTAssertEqual(a.plume, b.plume)
        XCTAssertNotEqual(WorkingAnimationModel(seed: 1).plume, WorkingAnimationModel(seed: 2).plume)
    }

    func testThePlumeIsWhiteHotAtTheNozzleAndDeepBlueAtTheTail() {
        let hot = plumeColorComponents(heat: 1)
        let cool = plumeColorComponents(heat: 0)
        XCTAssertGreaterThan(hot.red, 0.7)
        XCTAssertGreaterThan(hot.green, 0.85)
        XCTAssertLessThan(cool.red, 0.15)
        XCTAssertEqual(cool.blue, 1)
        let mid = plumeColorComponents(heat: 0.3)
        XCTAssertGreaterThan(mid.green, cool.green)
        XCTAssertLessThan(mid.green, hot.green)
        XCTAssertEqual(plumeColorComponents(heat: 5).red, hot.red, "clamped")
    }

    func testEveryChildGetsItsOwnColourAndNoneIsDispatchsBlue() {
        let widest = childPillLayout(count: 50, rowWidth: DispatchPillMetrics.expandedWidth).visibleCount
        XCTAssertLessThanOrEqual(widest, PlumePalette.childPalettes.count, "a full wide row never repeats a colour")
        let visible = (0..<widest).map(PlumePalette.child(at:))
        for (i, a) in visible.enumerated() {
            XCTAssertNotEqual(a, .blue, "a child never wears Dispatch's own colour")
            for b in visible[(i + 1)...] { XCTAssertNotEqual(a, b, "the row's pills never share a colour") }
        }
        XCTAssertEqual(PlumePalette.child(at: PlumePalette.childPalettes.count), PlumePalette.child(at: 0), "wraps")
        XCTAssertEqual(PlumePalette.child(at: -1), PlumePalette.childPalettes.last, "never traps on a bad index")
    }

    func testEveryPaletteRunsDeepToWhiteHot() {
        for palette in [PlumePalette.blue] + PlumePalette.childPalettes {
            let hot = plumeColorComponents(heat: 1, palette: palette)
            let cool = plumeColorComponents(heat: 0, palette: palette)
            XCTAssertGreaterThan(hot.red + hot.green + hot.blue, cool.red + cool.green + cool.blue + 0.9,
                                 "the nozzle is far brighter than the tail")
            XCTAssertGreaterThan(min(hot.red, hot.green, hot.blue), 0.7, "near-white at the nozzle")
        }
    }

    // MARK: - The icon

    // MARK: - Throwing tool tiles

    private func toolThrow(_ id: String, _ symbol: String = "terminal") -> PlumeThrow {
        PlumeThrow(id: id, kind: .tool(symbol: symbol))
    }

    func testWhatWasAlreadyDoneWhenThePlumeAppearedIsNotThrown() {
        var model = WorkingAnimationModel()
        model.tick(dt: 1.0 / 60.0, thrown: [toolThrow("a"), toolThrow("b")])
        for _ in 0..<30 { model.tick(dt: 1.0 / 60.0, thrown: [toolThrow("a"), toolThrow("b")]) }
        XCTAssertTrue(model.plume.tokens.isEmpty, "no burst of stale tiles when summoned mid-turn")
    }

    func testEachNewToolUseIsThrownOnceFromTheNozzle() {
        var model = WorkingAnimationModel()
        model.tick(dt: 1.0 / 60.0, thrown: [])
        model.tick(dt: 1.0 / 60.0, thrown: [toolThrow("a")])
        XCTAssertEqual(model.plume.tokens.map(\.item.id), ["a"])
        XCTAssertEqual(model.plume.tokens.first?.age ?? -1, 0, accuracy: 1e-9, "leaves the nozzle now")
        for _ in 0..<20 { model.tick(dt: 1.0 / 60.0, thrown: [toolThrow("a")]) }
        XCTAssertEqual(model.plume.tokens.count, 1, "the same call is never thrown twice")
    }

    func testABurstOfToolUsesLeavesOneByOne() {
        var model = WorkingAnimationModel()
        model.tick(dt: 1.0 / 60.0, thrown: [])
        let burst = (0..<3).map { toolThrow("t\($0)") }
        model.tick(dt: 1.0 / 60.0, thrown: burst)
        XCTAssertEqual(model.plume.tokens.count, 1)
        XCTAssertEqual(model.queued.count, 2)
        var t = 0.0
        while t < WorkingAnimationModel.throwSpacing * 2.5 { model.tick(dt: 1.0 / 60.0, thrown: burst); t += 1.0 / 60.0 }
        XCTAssertEqual(model.plume.tokens.map(\.item.id), ["t0", "t1", "t2"], "in order, spaced out")
        XCTAssertTrue(model.queued.isEmpty)
    }

    func testTheQueueIsBounded() {
        var model = WorkingAnimationModel()
        model.tick(dt: 1.0 / 60.0, thrown: [])
        let flood = (0..<30).map { toolThrow("f\($0)") }
        model.tick(dt: 1.0 / 60.0, thrown: flood)
        XCTAssertLessThanOrEqual(model.queued.count, WorkingAnimationModel.maxQueuedThrows)
        XCTAssertEqual(model.queued.last?.id, "f29", "the newest are kept")
    }

    func testReduceMotionThrowsNothing() {
        var model = WorkingAnimationModel()
        model.tick(dt: 1.0 / 60.0, thrown: [], animatesPlume: false)
        model.tick(dt: 1.0 / 60.0, thrown: [toolThrow("a")], animatesPlume: false)
        XCTAssertTrue(model.plume.tokens.isEmpty)
    }

    private func token(_ age: Double, _ item: PlumeThrow) -> PropulsionPlume.Token {
        PropulsionPlume.Token(age: age, lifetime: 1, lane: 0.6, item: item)
    }

    func testAToolDiscGrowsOutThenKeepsItsSizeAllTheWay() {
        let tile = { (age: Double) in
            PropulsionPlume.tile(for: self.token(age, self.toolThrow("a")), in: self.rect, emitterX: self.emitterX, tailX: self.tailX)
        }
        let full = rect.height * PropulsionPlume.tokenSideShare
        let born = tile(0)
        XCTAssertEqual(born.center.x, emitterX, accuracy: 1e-9)
        XCTAssertLessThan(born.side, full, "grows out of the nozzle")
        for age in stride(from: PropulsionPlume.tokenEmergeShare, through: 1.0, by: 0.1) {
            XCTAssertEqual(tile(age).side, full, accuracy: 1e-6, "one size the whole way (age \(age))")
        }
        XCTAssertLessThan(tile(0.5).center.x, tile(0.1).center.x, "rides toward the tail")
        let leaving = PropulsionPlume.tile(for: token(1, toolThrow("a")), in: rect, emitterX: emitterX, tailX: realTail)
        XCTAssertLessThanOrEqual(leaving.center.x + leaving.side / 2, 0, "out past the leading edge before it is dropped")
        for age in stride(from: 0.0, through: 1.0, by: 0.05) {
            let t = tile(age)
            XCTAssertGreaterThanOrEqual(t.center.y - t.side / 2, rect.minY - 1e-9)
            XCTAssertLessThanOrEqual(t.center.y + t.side / 2, rect.maxY + 1e-9)
        }
    }

    func testASiteKeepsItsSizeAllTheWayAndRidesOutPastTheTail() {
        let site = PlumeThrow(id: "s#a.com", kind: .site(host: "a.com", iconURL: nil))
        let tile = { (age: Double) in
            PropulsionPlume.tile(for: self.token(age, site), in: self.rect, emitterX: self.emitterX, tailX: self.tailX)
        }
        let full = rect.height * PropulsionPlume.tokenSideShare
        XCTAssertLessThan(tile(0).side, full, "grows out of the nozzle")
        for age in stride(from: PropulsionPlume.tokenEmergeShare, through: 1.0, by: 0.1) {
            XCTAssertEqual(tile(age).side, full, accuracy: 1e-6, "one size the whole way (age \(age))")
        }
        XCTAssertEqual(tile(1).center.x, tailX, accuracy: 1e-9, "all the way to the tail")
        let leaving = PropulsionPlume.tile(for: token(1, site), in: rect, emitterX: emitterX, tailX: realTail)
        XCTAssertLessThanOrEqual(leaving.center.x + leaving.side / 2, 0, "wholly out of the pill before it is dropped")
    }

    func testATileOutlivesNoPuffAndIsDroppedAtTheTail() {
        var plume = PropulsionPlume(seed: 7)
        plume.launch(toolThrow("a"))
        for _ in 0..<Int(PropulsionPlume.tokenLifetime.upperBound * 60) + 2 { plume.advance(dt: 1.0 / 60.0) }
        XCTAssertTrue(plume.tokens.isEmpty)
    }

    // MARK: - What a turn throws

    private func tool(_ name: String, detail: String? = nil, callId: String, output: String? = nil,
                      isError: Bool = false, siteIcons: [SiteIconRef] = []) -> ActivityItem {
        ActivityItem(kind: .tool(name: name, detail: detail, callId: callId, output: output, isError: isError,
                                 siteIcons: siteIcons))
    }

    func testEveryToolCallThrowsItsTile() {
        let exchange = Exchange(prompt: "p", reply: "", activity: [
            tool("bash", detail: "ls", callId: "c1"),
            ActivityItem(kind: .task(subject: "x", status: "done")),
            tool("edit", detail: "a.swift", callId: "c2"),
        ])
        XCTAssertEqual(plumeThrows(for: exchange), [
            PlumeThrow(id: "c1", kind: .tool(symbol: "terminal")),
            PlumeThrow(id: "c2", kind: .tool(symbol: "pencil")),
        ])
        XCTAssertEqual(plumeThrows(for: nil), [])
    }

    func testAFetchThrowsItsTileThenItsSiteWhenThePageArrives() {
        let running = Exchange(prompt: "p", reply: "", activity: [
            tool("WebFetch", detail: "https://www.apple.com/newsroom/", callId: "f1"),
        ])
        XCTAssertEqual(plumeThrows(for: running), [PlumeThrow(id: "f1", kind: .tool(symbol: "safari"))],
                       "the site waits for the page — that is when its icon arrives")
        // An older runtime reports no icon: the fetched url's host, with no icon url (favicon.ico).
        let done = Exchange(prompt: "p", reply: "", activity: [
            tool("WebFetch", detail: "https://www.apple.com/newsroom/", callId: "f1", output: "digest"),
        ])
        XCTAssertEqual(plumeThrows(for: done), [
            PlumeThrow(id: "f1", kind: .tool(symbol: "safari")),
            PlumeThrow(id: "f1#www.apple.com", kind: .site(host: "www.apple.com", iconURL: nil)),
        ])
        let failed = Exchange(prompt: "p", reply: "", activity: [
            tool("WebFetch", detail: "https://www.apple.com/newsroom/", callId: "f1", output: "403", isError: true),
        ])
        XCTAssertEqual(plumeThrows(for: failed).map(\.id), ["f1"], "no page came, no site")
    }

    func testAFetchDrawsThePagesOwnReportedIcon() {
        let done = Exchange(prompt: "p", reply: "", activity: [
            tool("WebFetch", detail: "https://www.apple.com/newsroom/", callId: "f1", output: "digest",
                 siteIcons: [SiteIconRef(url: "https://www.apple.com/newsroom/", iconUrl: "https://www.apple.com/favicon-32.png")]),
        ])
        XCTAssertEqual(plumeThrows(for: done).last,
                       PlumeThrow(id: "f1#www.apple.com", kind: .site(host: "www.apple.com", iconURL: "https://www.apple.com/favicon-32.png")))
    }

    func testASearchDrawsEachSourceFromItsReportedIcon() {
        let output = """
        The answer.

        Sources:
        1. A
           https://alpha.example.com/a
        2. G
           https://gamma.example.com/g
        3. B
           https://beta.example.org/b
        """
        let icons = [
            SiteIconRef(url: "https://alpha.example.com/a", iconUrl: "https://alpha.example.com/favicon.ico"),
            SiteIconRef(url: "https://beta.example.org/b", iconUrl: "https://cdn.example.net/beta.png"),
            // A private icon is never drawn from; the source falls back to its own favicon.ico.
            SiteIconRef(url: "https://delta.example.com/d", iconUrl: "https://10.0.0.1/i.png"),
        ]
        let done = Exchange(prompt: "p", reply: "", activity: [
            tool("mcp__winter__research__Search", detail: "q", callId: "s1", output: output, siteIcons: icons),
        ])
        XCTAssertEqual(plumeThrows(for: done), [
            PlumeThrow(id: "s1#alpha.example.com", kind: .site(host: "alpha.example.com", iconURL: "https://alpha.example.com/favicon.ico")),
            PlumeThrow(id: "s1#gamma.example.com", kind: .site(host: "gamma.example.com", iconURL: nil)),
            PlumeThrow(id: "s1#beta.example.org", kind: .site(host: "beta.example.org", iconURL: "https://cdn.example.net/beta.png")),
            PlumeThrow(id: "s1#delta.example.com", kind: .site(host: "delta.example.com", iconURL: nil)),
        ], "every named source in order, each from its reported icon; then a reported site the text did not name")
    }

    func testTwoIconsForOneHostAreFiledApart() {
        let a = plumeFaviconKey(host: "a.example.com", iconURL: "https://a.example.com/one.png")
        let b = plumeFaviconKey(host: "a.example.com", iconURL: "https://cdn.example.net/two.png")
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a, "https://a.example.com/one.png")
        XCTAssertEqual(plumeFaviconKey(host: "a.example.com", iconURL: nil), "https://a.example.com/favicon.ico")
    }

    func testReportedSitesAreOnePerPublicHost() {
        let sites = plumeSites([
            SiteIconRef(url: "https://a.example.com/1", iconUrl: "https://a.example.com/i.png"),
            SiteIconRef(url: "https://A.example.com/2", iconUrl: "https://a.example.com/j.png"),
            SiteIconRef(url: "https://localhost/x", iconUrl: "https://a.example.com/i.png"),
            SiteIconRef(url: "not a url", iconUrl: "https://a.example.com/i.png"),
        ])
        XCTAssertEqual(sites.map(\.host), ["a.example.com"])
        XCTAssertEqual(sites.first?.iconURL, "https://a.example.com/i.png")
    }

    func testASearchThrowsOnlyTheSitesItFound() {
        let pending = Exchange(prompt: "p", reply: "", activity: [tool("WebSearch", detail: "swift", callId: "s1")])
        XCTAssertEqual(plumeThrows(for: pending), [], "a search has no puff of its own — only the sites it finds")
        let output = """
        1. https://swift.org/blog — Swift
        2. https://developer.apple.com/swift/ and again https://swift.org/docs
        3. http://localhost:8080/x (never) 4. https://10.0.0.2/a (never)
        5. https://a.com 6. https://b.com 7. https://c.com
        """
        let done = Exchange(prompt: "p", reply: "", activity: [tool("WebSearch", detail: "swift", callId: "s1", output: output)])
        XCTAssertEqual(plumeThrows(for: done).map(\.id),
                       ["s1#swift.org", "s1#developer.apple.com", "s1#a.com", "s1#b.com", "s1#c.com"],
                       "every distinct public host, in order")
    }

    func testOnlyPublicNamesAreAskedForAFavicon() {
        XCTAssertTrue(plumeFaviconHostAllowed("github.com"))
        XCTAssertTrue(plumeFaviconHostAllowed("docs.swift.org"))
        for host in ["lan.example.com", "myhome.com", "corp.example.org", "private.example.net"] {
            XCTAssertTrue(plumeFaviconHostAllowed(host), "only the suffix counts: \(host)")
        }
        for host in ["localhost", "printer.local", "db.internal", "nas.lan", "router.home", "box.home.arpa", "wiki.corp",
                     "hr.intranet", "x.private", "a.localhost", "10.0.0.1", "192.168.1.1", "intranet", "a..b", "-x.com"] {
            XCTAssertFalse(plumeFaviconHostAllowed(host), host)
        }
    }

    // MARK: - A running round repeats

    /// The user's call (2026-10-02): everything the turn has used keeps streaming until the turn ends —
    /// finished calls included — and new ones join as they are made.
    func testTheWholeTurnRepeatsFinishedCallsIncluded() {
        let earlier = tool("bash", detail: "ls", callId: "b0", output: "ok")
        let doneSearch = tool("WebSearch", detail: "q", callId: "s1", output: "1. https://a.com 2. https://b.com")
        let running = tool("read", detail: "f", callId: "r1")
        let all = Exchange(prompt: "p", reply: "", activity: [earlier, doneSearch, running])
        XCTAssertEqual(plumeRepeatingThrows(for: all).map(\.id), ["b0", "s1#a.com", "s1#b.com", "r1"])
        XCTAssertEqual(plumeRepeatingThrows(for: Exchange(prompt: "p", reply: "", activity: [earlier, doneSearch])).map(\.id),
                       ["b0", "s1#a.com", "s1#b.com"], "nothing running — still the turn's whole set")
        XCTAssertEqual(plumeRepeatingThrows(for: nil), [])
    }

    func testARunningRoundStreamsAgainOnceNothingNewWaits() {
        var model = WorkingAnimationModel()
        let round = [toolThrow("a"), toolThrow("b")]
        model.tick(dt: 1.0 / 60.0, thrown: round, repeating: round) // primed: what was already there is not new
        var t = 0.0
        while t < WorkingAnimationModel.repeatSpacing * 3.5 { model.tick(dt: 1.0 / 60.0, thrown: round, repeating: round); t += 1.0 / 60.0 }
        let launched = model.plume.tokens.map(\.item.id)
        XCTAssertGreaterThanOrEqual(launched.count, 4, "the round keeps leaving the nozzle")
        XCTAssertEqual(Array(launched.prefix(4)), ["a", "b", "a", "b"], "in turn")
        var ended = model
        let before = ended.plume.tokens.count
        for _ in 0..<Int(WorkingAnimationModel.repeatSpacing * 60) + 5 { ended.tick(dt: 1.0 / 60.0, thrown: round, repeating: []) }
        XCTAssertLessThanOrEqual(ended.plume.tokens.count, before, "once the round is over nothing new is thrown")
    }

    func testNewThrowsGoBeforeTheRepeats() {
        var model = WorkingAnimationModel()
        model.tick(dt: 1.0 / 60.0)
        let round = [toolThrow("old")]
        model.tick(dt: 1.0 / 60.0, thrown: [toolThrow("new1"), toolThrow("new2")], repeating: round)
        for _ in 0..<Int(WorkingAnimationModel.throwSpacing * 60 * 2) + 3 {
            model.tick(dt: 1.0 / 60.0, thrown: [toolThrow("new1"), toolThrow("new2")], repeating: round)
        }
        XCTAssertEqual(Array(model.plume.tokens.map(\.item.id).prefix(2)), ["new1", "new2"])
    }

    // MARK: - Tool → symbol

    /// A globe means a website with no favicon — so no TOOL may wear one, or a search's own puff reads
    /// as one of its sites.
    func testNoToolWearsTheMissingFaviconGlobe() {
        for name in ["Search", "WebSearch", "web_search", "WebFetch", "Browser", "browser", "mcp__winter__browser__navigate",
                     "mcp__winter__research__Search", "bash", "Read", "SpawnSession", "Computer", "unknown"] {
            XCTAssertNotEqual(workingToolSymbol(for: name), "globe", name)
        }
    }

    func testToolSymbols() {
        XCTAssertEqual(workingToolSymbol(for: "bash"), "terminal")
        XCTAssertEqual(workingToolSymbol(for: "read"), "doc.text")
        XCTAssertEqual(workingToolSymbol(for: "edit"), "pencil")
        XCTAssertEqual(workingToolSymbol(for: "write"), "pencil")
        XCTAssertEqual(workingToolSymbol(for: "grep"), "text.magnifyingglass")
        XCTAssertEqual(workingToolSymbol(for: "WebFetch"), "safari", "matched case-insensitively")
        XCTAssertEqual(workingToolSymbol(for: "WebSearch"), "magnifyingglass")
        XCTAssertEqual(workingToolSymbol(for: "session_spawn"), "paperplane.fill")
        XCTAssertEqual(workingToolSymbol(for: "task_update"), "checklist")
        XCTAssertEqual(workingToolSymbol(for: "mcp__winter__browser__navigate"), "safari")
        XCTAssertEqual(workingToolSymbol(for: "mcp__winter__computer__click"), "cursorarrow.rays")
        XCTAssertEqual(workingToolSymbol(for: "mcp__github__create_issue"), "shippingbox", "a connector")
        XCTAssertEqual(workingToolSymbol(for: "something_new"), "hammer.fill", "never a blank centre")
    }

    /// The 2026-10-01 tool-surface ruling: the model calls the daemon's tools by plain names. The daemon
    /// still EMITS their host names (`session_spawn`, `browser`, …), but a plain name must draw the same
    /// symbol, and the old MCP spellings (old transcripts) still draw theirs.
    func testPlainToolNamesDrawTheSameSymbolsAsTheirHostNames() {
        XCTAssertEqual(workingToolSymbol(for: "SpawnSession"), workingToolSymbol(for: "session_spawn"))
        XCTAssertEqual(workingToolSymbol(for: "ListSessions"), "person.2.fill")
        XCTAssertEqual(workingToolSymbol(for: "ManageSession"), "person.2.fill")
        XCTAssertEqual(workingToolSymbol(for: "list_sessions"), "person.2.fill")
        XCTAssertEqual(workingToolSymbol(for: "Computer"), workingToolSymbol(for: "computer"))
        XCTAssertEqual(workingToolSymbol(for: "Browser"), workingToolSymbol(for: "browser"))
        XCTAssertEqual(workingToolSymbol(for: "Search"), "magnifyingglass")
        XCTAssertEqual(workingToolSymbol(for: "mcp__winter__sessions__session_spawn"), "person.2.fill", "an old spelling still draws its server's symbol")
        XCTAssertTrue(plumeIsSearchTool("search"), "the SDK's own Search")
        XCTAssertTrue(plumeIsSearchTool("mcp__winter__research__search"), "an old transcript's daemon Search")
    }

    func testEverySymbolTheAnimationCanDrawExists() {
        let names = ["bash", "read", "edit", "glob", "WebFetch", "WebSearch", "computer", "lsp", "task_create",
                     "spawn_agent", "session_spawn", "Workflow", "ask_user", "Skill", "mcp__winter__office__x",
                     "mcp__winter__sessions__x", "mcp__winter__research__x", "mcp__winter__lsp__x",
                     "mcp__winter__other__x", "mcp__x__y", "unknown"]
        for symbol in names.map(workingToolSymbol(for:)) {
            XCTAssertNotNil(NSImage(systemSymbolName: symbol, accessibilityDescription: nil), symbol)
        }
    }

    func testTheRunningToolNameComesOffTheStatus() {
        XCTAssertEqual(workingToolName(.toolRunning(name: "bash")), "bash")
        XCTAssertNil(workingToolName(.thinking))
        XCTAssertNil(workingToolName(.idle))
    }
}
