import XCTest
import AppKit
import SwiftUI
import WinterKit
import WinterProtocol
@testable import Winter

/// The user's report after the send fix (2026-10-20): the pill "somewhat flashes a couple times while the pill is
/// compressing" — "the plume starts before it finishes compressing". Measured: the plume mounted at the FIRST frame
/// of the compress, under the shape's full morph blur, and every frame of the spring laid it out again at the new
/// width, re-flying every puff in the air (40-odd keyframe animations replaced per frame, most puffs jumping 15-45 pt
/// between frames). The user's ruling the same day: the plume may start as soon as Enter is pressed. So it does — laid
/// out ONCE at the compact pill's size and place, under the content and outside the morph's blur, the shrinking
/// shape's clip revealing it. These sample a real pill frame by frame through Enter's compress and require: the plume
/// within a frame of the compress starting, one layout at the compact width, no frame re-flying every puff, every
/// puff continuous on screen, and never a blur over it.
@MainActor
final class DispatchPillCompressPlumeTests: XCTestCase {
    private let visible = CGRect(x: 100, y: 80, width: 1440, height: 820)
    private var controllers: [DispatchPillController] = []
    private var suites: [String] = []

    override func setUp() async throws {
        try await super.setUp()
        PlumeLayerView.runsInUnshownWindows = true
    }

    override func tearDown() async throws {
        controllers.forEach { $0.hide() }
        controllers.removeAll()
        suites.forEach { UserDefaults().removePersistentDomain(forName: $0) }
        suites.removeAll()
        PlumeLayerView.runsInUnshownWindows = false
        try await super.tearDown()
    }

    private func makePill(_ session: SessionModel) -> DispatchPillController {
        let suite = "WinterTests.DispatchPillCompressPlume.\(UUID().uuidString)"
        suites.append(suite)
        let pill = DispatchPillController(session: session,
                                          settings: DispatchPillSettings(defaults: UserDefaults(suiteName: suite)!))
        pill.visibleFrameOverrideForTesting = visible
        controllers.append(pill)
        return pill
    }

    private func event(_ fields: [String: Any]) -> SessionEvent { ReplayBufferTests.event(fields, session: "s_d") }

    private func plumes(in view: NSView?) -> [PlumeLayerView] {
        guard let view else { return [] }
        if let plume = view as? PlumeLayerView { return [plume] }
        return view.subviews.flatMap { plumes(in: $0) }
    }


    private struct Sample {
        /// Seconds since recording began.
        let t: Double
        let compact: Bool
        let plume: PlumeLayerView?
        /// The plume as drawn (its own and every ancestor's opacity, as presented).
        let drawnOpacity: Float
        let plumeWidth: CGFloat
        let activePuffs: Int
        /// How many puffs got a NEW flight animation since the previous sample.
        let reflown: Int
        /// The plume view's rect on SCREEN: pinned, it never moves while the shape springs around it (and with it every
        /// puff, each on its own unbroken flight, stays continuous on screen).
        let screenFrame: CGRect
        /// A blur filter on the plume's view or any layer above it.
        let blurred: Bool
    }

    @MainActor private final class Probe {
        var samples: [Sample] = []
        private let start = CACurrentMediaTime()
        private var lastAnimation: [ObjectIdentifier: ObjectIdentifier] = [:]

        func note(_ pill: DispatchPillController, plume: PlumeLayerView?) {
            let t = CACurrentMediaTime() - start
            var reflown = 0
            for disc in plume?.discLayersForTesting ?? [] {
                let id = ObjectIdentifier(disc)
                guard let animation = disc.animation(forKey: PlumeLayerView.flightKey) else { continue }
                let now = ObjectIdentifier(animation)
                if let before = lastAnimation[id], before != now { reflown += 1 }
                lastAnimation[id] = now
            }
            var opacity: Float = 1
            var blurred = false
            var view: NSView? = plume
            while let v = view {
                opacity *= Float(v.alphaValue) * (v.layer?.presentation()?.opacity ?? v.layer?.opacity ?? 1)
                if !v.contentFilters.isEmpty { blurred = true }
                view = v.superview
            }
            var layer: CALayer? = plume?.layer
            while let l = layer {
                if let filters = l.filters, filters.contains(where: { "\($0)".lowercased().contains("blur") }) { blurred = true }
                if let filters = l.backgroundFilters, !filters.isEmpty { blurred = true }
                layer = l.superlayer
            }
            samples.append(Sample(t: t, compact: pill.presentation == .compact, plume: plume,
                                  drawnOpacity: plume == nil ? 0 : opacity, plumeWidth: plume?.bounds.width ?? 0,
                                  activePuffs: plume?.activePuffCount ?? 0, reflown: reflown,
                                  screenFrame: plume.flatMap { p in p.window.map { $0.convertToScreen(p.convert(p.bounds, to: nil)) } } ?? .zero,
                                  blurred: plume != nil && blurred))
        }
        var mounted: [Sample] { samples.filter { $0.plume != nil } }
        /// A frame where (nearly) every puff in the air was flown again — a re-layout, never a birth.
        var massReflies: Int { samples.filter { $0.activePuffs > 8 && $0.reflown * 2 > $0.activePuffs }.count }
    }

    private func pump(_ pill: DispatchPillController, _ probe: Probe?, for seconds: Double) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            RunLoop.main.run(until: Date().addingTimeInterval(0.004))
            probe?.note(pill, plume: plumes(in: pill.hostingViewForTesting).first)
        }
    }

    private func pump(_ pill: DispatchPillController, until condition: () -> Bool) {
        let end = Date().addingTimeInterval(2)
        while !condition(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.004)) }
    }

    private func turnStarts(_ session: SessionModel, seq: Int = 1) {
        session.apply(event(["type": "user_message", "seq": seq, "ts": 1, "threadId": "main", "text": "ship it",
                             "clientName": "orb"]))
        session.apply(event(["type": "turn_started", "seq": seq + 1, "ts": 2, "threadId": "main"]))
    }

    /// Typed, Enter: the answer lands at once (`answerFirst`, the turn's events 30 ms later) or the turn's events
    /// land first; recorded from Enter until well after the compress has settled.
    private func compress(answerFirst: Bool) -> (DispatchPillController, Probe) {
        let session = SessionModel()
        let pill = makePill(session)
        var answered = false
        pill.onSubmit = { _ in
            while !answered { try? await Task.sleep(nanoseconds: 1_000_000) }
            return true
        }
        pill.show()
        pill.adapter.composerDraft = "ship it"
        pump(pill, until: { pill.presentation == .expanded && pill.isSpringIdleForTesting })
        XCTAssertEqual(pill.presentation, .expanded)
        if !answerFirst { turnStarts(session) }
        let probe = Probe()
        probe.note(pill, plume: plumes(in: pill.hostingViewForTesting).first)
        pill.submit("ship it")
        answered = true
        pump(pill, probe, for: 0.03)
        if answerFirst { turnStarts(session) }
        pump(pill, probe, for: 1.2)
        return (pill, probe)
    }

    private func assertPlumeRidesTheCompress(_ probe: Probe, file: StaticString = #filePath, line: UInt = #line) {
        let samples = probe.samples
        guard let compressed = samples.first(where: \.compact),
              let shown = samples.first(where: { $0.drawnOpacity > 0.01 }) else {
            return XCTFail("the pill never compressed, or the plume never showed", file: file, line: line)
        }
        // Started in the very pass the pill compresses (a frame is 1/60 s; one sample's 4 ms on top), and drawn — the
        // render server's own fade under way — within about two frames of it.
        XCTAssertLessThanOrEqual(shown.t - compressed.t, 0.05,
                                 "the plume shows with the compress (took \(Int((shown.t - compressed.t) * 1000)) ms)",
                                 file: file, line: line)
        let mounted = probe.mounted
        let mountedAt = mounted.first(where: \.compact).map(\.t) ?? .infinity
        XCTAssertLessThanOrEqual(mountedAt - compressed.t, 0.025,
                                 "the plume is up within a frame of the compress (took \(Int((mountedAt - compressed.t) * 1000)) ms)",
                                 file: file, line: line)
        XCTAssertEqual(Set(mounted.compactMap { $0.plume.map(ObjectIdentifier.init) }).count, 1, "one plume",
                       file: file, line: line)
        XCTAssertEqual(Set(mounted.map(\.plumeWidth)), [DispatchPillMetrics.compactWidth],
                       "laid out once, at the compact width", file: file, line: line)
        XCTAssertEqual(probe.massReflies, 0, "no frame re-flies every puff", file: file, line: line)
        let frames = mounted.map(\.screenFrame)
        let drift = frames.map { abs($0.minX - frames[0].minX) + abs($0.minY - frames[0].minY) }.max() ?? 0
        XCTAssertLessThanOrEqual(drift, 0.5,
                                 "pinned on screen through the compress, the panel's shrink included (moved up to \(drift) pt)",
                                 file: file, line: line)
        XCTAssertEqual(mounted.filter(\.blurred).count, 0, "never under the morph's blur", file: file, line: line)
        if let first = samples.firstIndex(where: { $0.plume != nil }) {
            XCTAssertTrue(samples[first...].allSatisfy { $0.plume != nil }, "never taken down again", file: file, line: line)
        }
        // Timings, for the report.
        print("PLUME-TIMING compress=\(Int(compressed.t * 1000))ms mounted=\(Int(mountedAt * 1000))ms shown=\(Int(shown.t * 1000))ms "
              + "full=\(samples.first(where: { $0.drawnOpacity > 0.95 }).map { "\(Int($0.t * 1000))ms" } ?? "-") "
              + "drift=\(drift)pt")
    }

    func testThePlumeStartsWithEntersCompressWhenTheAnswerLandsFirst() {
        let (pill, probe) = compress(answerFirst: true)
        assertPlumeRidesTheCompress(probe)
        XCTAssertEqual(pill.presentation, .compact)
    }

    func testThePlumeStartsWithEntersCompressWhenTheTurnLandsFirst() {
        let (_, probe) = compress(answerFirst: false)
        assertPlumeRidesTheCompress(probe)
    }

    /// A pill summoned while a turn already runs shows the plume at once.
    func testAPillSummonedMidTurnShowsThePlumeAtOnce() {
        let session = SessionModel()
        turnStarts(session)
        let pill = makePill(session)
        pill.show()
        pump(pill, nil, for: 0.1)
        XCTAssertTrue(pill.plumeVisible)
        XCTAssertNotNil(plumes(in: pill.hostingViewForTesting).first)
    }

    /// A steer: the typing pill hides the plume, sending the steer shows the SAME plume again (never a new start), and
    /// it rides that compress like Enter's.
    func testASteerNeverRestartsThePlume() {
        let session = SessionModel()
        turnStarts(session)
        let pill = makePill(session)
        pill.onSubmit = { _ in true }
        pill.show()
        pump(pill, nil, for: 0.1)
        guard let before = plumes(in: pill.hostingViewForTesting).first else { return XCTFail("no plume") }
        pill.openComposer()
        pill.adapter.composerDraft = "also this"
        pump(pill, until: { pill.isSpringIdleForTesting })
        XCTAssertFalse(pill.plumeVisible, "the typing pill shows the composer, not the plume")
        XCTAssertTrue(plumes(in: pill.hostingViewForTesting).first === before, "kept, hidden")
        let probe = Probe()
        pill.submit("also this")
        pump(pill, probe, for: 1.2)
        XCTAssertTrue(plumes(in: pill.hostingViewForTesting).first === before, "the same plume: a steer never restarts it")
        XCTAssertEqual(probe.massReflies, 0)
        XCTAssertEqual(probe.mounted.filter(\.blurred).count, 0)
        let frames = probe.mounted.map(\.screenFrame)
        XCTAssertLessThanOrEqual(frames.map { abs($0.minX - frames[0].minX) + abs($0.minY - frames[0].minY) }.max() ?? 0, 0.5)
        XCTAssertGreaterThan(probe.samples.last?.drawnOpacity ?? 0, 0.95, "shown again")
    }
}
