import XCTest
import AppKit
import WinterProtocol
@testable import Winter

/// The user's report (2026-10-20): "the question cards don't let me select an option" — the Dispatch pill's question
/// card. A REAL pill (panel, hosting view, the card's real view tree):
/// - every view a click can land on in the card must act on the FIRST click. The pill is a non-activating panel over
///   another app: AppKit asks the HIT view `acceptsFirstMouse`, and a view that says no turns the click into a mere
///   "make key" — with Winter inactive (a non-activating panel never activates it) every click on it is lost. The pill's
///   own `FirstClickHostingView` says yes; the `NSClipView`/SwiftUI containers of a `ScrollView` inside it do not, and
///   the card's body (the question's options) was inside one even when it had nothing to scroll.
@MainActor
final class DispatchPillQuestionClickTests: XCTestCase {
    private let visible = CGRect(x: 0, y: 0, width: 1440, height: 900)
    private var pills: [DispatchPillController] = []

    override func tearDown() async throws {
        pills.forEach { $0.hide() }
        pills.removeAll()
        try await super.tearDown()
    }

    private func questionItem(_ callId: String) -> ActivityItem {
        let questions = try! JSONDecoder().decode([SessionEvent.Question].self, from: Data(#"""
        [{"question":"Which one?","header":"Pick","options":[{"label":"Alpha"},{"label":"Beta"}],"multiSelect":false}]
        """#.utf8))
        return ActivityItem(kind: .interaction(InteractionRecord(callId: callId, ask: .question(questions: questions))))
    }

    private func run(_ seconds: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    private func pillWithQuestion() -> DispatchPillController {
        let session = SessionModel()
        session.applyForTesting { s in
            s.status = .idle
            s.exchanges = [Exchange(prompt: "ship", reply: "", activity: [self.questionItem("q1")])]
        }
        // A throwaway suite, never written: the test host is the app, and `.standard` is the dev app's preferences.
        let settings = DispatchPillSettings(defaults: UserDefaults(suiteName: "WinterTests.DispatchPill.clicks")!)
        let pill = DispatchPillController(session: session, settings: settings)
        pill.visibleFrameOverrideForTesting = visible
        pills.append(pill)
        pill.show()
        let deadline = Date().addingTimeInterval(4)
        repeat { run(0.05) } while (!pill.isSpringIdleForTesting || !pill.cardShowsOnPill) && Date() < deadline
        run(0.3) // the content swap's fade
        return pill
    }

    /// The card, in WINDOW coordinates (AppKit, origin bottom-left).
    private func cardRect(_ pill: DispatchPillController, panel: NSWindow) -> CGRect {
        let canvas = panel.frame.size
        let main = dispatchPillMainRect(canvasSize: canvas, mainSize: pill.morph.size)
        return CGRect(x: main.minX, y: canvas.height - main.maxY, width: main.width, height: main.height)
    }

    func testEveryViewUnderTheQuestionCardActsOnTheFirstClick() throws {
        let pill = pillWithQuestion()
        XCTAssertTrue(pill.cardShowsOnPill)
        let content = try XCTUnwrap(pill.panelContentViewForTesting)
        let panel = try XCTUnwrap(content.window)
        content.layoutSubtreeIfNeeded()
        let card = cardRect(pill, panel: panel)
        var refusing: Set<String> = []
        var probed = 0
        for y in stride(from: card.minY + 4, to: card.maxY - 4, by: 3) {
            for x in stride(from: card.minX + 24, to: card.maxX - 24, by: 40) {
                guard let hit = content.hitTest(content.convert(CGPoint(x: x, y: y), from: nil)) else { continue }
                probed += 1
                if !hit.acceptsFirstMouse(for: nil) { refusing.insert(String(describing: type(of: hit))) }
            }
        }
        XCTAssertGreaterThan(probed, 50, "the sweep must actually cover the card")
        XCTAssertEqual(refusing, [], "a view in the card that refuses the first mouse swallows the click on a non-key pill")
    }
}
