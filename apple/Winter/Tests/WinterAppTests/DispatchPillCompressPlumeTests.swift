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
/// between frames). These sample a real pill frame by frame through Enter's compress and require: no plume until the
/// shape has stopped moving, and once up, never laid out again.
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
        let blur: CGFloat
        let plume: PlumeLayerView?
        let plumeWidth: CGFloat
        let activePuffs: Int
        /// How many puffs got a NEW flight animation since the previous sample.
        let reflown: Int
    }

    @MainActor private final class Probe {
        var samples: [Sample] = []
        private var lastAnimation: [ObjectIdentifier: ObjectIdentifier] = [:]
        func note(_ pill: DispatchPillController, plume: PlumeLayerView?) {
            var reflown = 0
            for disc in plume?.discLayersForTesting ?? [] {
                guard let animation = disc.animation(forKey: PlumeLayerView.flightKey) else { continue }
                let id = ObjectIdentifier(disc), now = ObjectIdentifier(animation)
                if let before = lastAnimation[id], before != now { reflown += 1 }
                lastAnimation[id] = now
            }
            samples.append(Sample(blur: dispatchPillMorphBlur(size: pill.morph.size, target: pill.morph.target),
                                  plume: plume, plumeWidth: plume?.bounds.width ?? 0,
                                  activePuffs: plume?.activePuffCount ?? 0, reflown: reflown))
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

    /// Typed, Enter: the answer lands (`answerFirst`) or the turn's events do first; recorded from Enter until well
    /// after the compress has settled.
    private func compress(answerFirst: Bool) -> (DispatchPillController, Probe) {
        let session = SessionModel()
        let pill = makePill(session)
        var answered = false
        pill.onSubmit = { _ in
            while !answered { try? await Task.sleep(nanoseconds: 2_000_000) }
            return true
        }
        pill.show()
        pill.adapter.composerDraft = "ship it"
        pump(pill, until: { pill.presentation == .expanded && pill.isSpringIdleForTesting })
        XCTAssertEqual(pill.presentation, .expanded)
        let probe = Probe()
        pill.submit("ship it")
        if answerFirst {
            answered = true
            pump(pill, probe, for: 0.03)
            turnStarts(session)
        } else {
            turnStarts(session)
            pump(pill, probe, for: 0.03)
            answered = true
        }
        pump(pill, probe, for: 1.2)
        return (pill, probe)
    }

    private func assertPlumeWaitsForTheShape(_ probe: Probe, file: StaticString = #filePath, line: UInt = #line) {
        let mounted = probe.mounted
        XCTAssertFalse(mounted.isEmpty, "the plume comes up once the pill has compressed", file: file, line: line)
        XCTAssertEqual(mounted.filter { $0.blur > 0 }.count, 0,
                       "no plume while the shape still moves (blurred): \(mounted.map(\.blur).filter { $0 > 0 })",
                       file: file, line: line)
        XCTAssertEqual(Set(mounted.compactMap { $0.plume.map(ObjectIdentifier.init) }).count, 1, "one plume",
                       file: file, line: line)
        XCTAssertEqual(Set(mounted.map(\.plumeWidth)).count, 1,
                       "laid out once, at the compact width: \(Set(mounted.map(\.plumeWidth)).sorted())",
                       file: file, line: line)
        XCTAssertEqual(probe.massReflies, 0, "no frame re-flies every puff", file: file, line: line)
        // Once up, it stays.
        if let first = probe.samples.firstIndex(where: { $0.plume != nil }) {
            XCTAssertTrue(probe.samples[first...].allSatisfy { $0.plume != nil }, "never taken down again",
                          file: file, line: line)
        }
    }

    func testThePlumeStartsOnlyOnceTheCompressHasSettledWhenTheAnswerLandsFirst() {
        let (pill, probe) = compress(answerFirst: true)
        assertPlumeWaitsForTheShape(probe)
        XCTAssertEqual(probe.mounted.first?.plumeWidth, DispatchPillMetrics.compactWidth)
        XCTAssertEqual(pill.presentation, .compact)
    }

    func testThePlumeStartsOnlyOnceTheCompressHasSettledWhenTheTurnLandsFirst() {
        let (_, probe) = compress(answerFirst: false)
        assertPlumeWaitsForTheShape(probe)
    }

    /// A pill summoned while a turn already runs shows the plume at once — no spring to wait for.
    func testAPillSummonedMidTurnShowsThePlumeAtOnce() {
        let session = SessionModel()
        turnStarts(session)
        let pill = makePill(session)
        pill.show()
        pump(pill, nil, for: 0.1)
        XCTAssertTrue(pill.shapeSharp)
        XCTAssertNotNil(plumes(in: pill.hostingViewForTesting).first)
    }

    /// A steer: the plume goes while the typing pill is open, and comes back only once the pill has compressed again.
    func testASteersCompressAlsoWaitsForTheShape() {
        let session = SessionModel()
        turnStarts(session)
        let pill = makePill(session)
        pill.onSubmit = { _ in true }
        pill.show()
        pump(pill, nil, for: 0.1)
        pill.openComposer()
        pill.adapter.composerDraft = "also this"
        pump(pill, until: { pill.isSpringIdleForTesting })
        XCTAssertNil(plumes(in: pill.hostingViewForTesting).first, "no plume under the typing pill")
        let probe = Probe()
        pill.submit("also this")
        pump(pill, probe, for: 1.2)
        assertPlumeWaitsForTheShape(probe)
    }

    func testThePlumeGate() {
        XCTAssertTrue(DispatchPillPlumeGate(wanted: true, shapeSharp: true).startsPlume)
        XCTAssertFalse(DispatchPillPlumeGate(wanted: true, shapeSharp: false).startsPlume)
        XCTAssertFalse(DispatchPillPlumeGate(wanted: false, shapeSharp: true).startsPlume)
    }
}
