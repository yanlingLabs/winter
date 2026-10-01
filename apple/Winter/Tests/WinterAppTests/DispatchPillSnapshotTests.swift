import XCTest
import AppKit
import SwiftUI
import WinterProtocol
@testable import Winter

/// Offscreen renders of the dispatch pill's states, for review — NOT a pixel-diff suite. Skipped
/// unless `WINTER_PILL_SNAPSHOT_DIR` names a directory (pass it to the test runner as
/// `TEST_RUNNER_WINTER_PILL_SNAPSHOT_DIR=… xcodebuild test …`); each case writes one PNG there.
/// Offscreen because the states it covers — four children with "+n" overflow, a child's approval
/// floating above a working pill — cannot be staged in the live app without spending a provider's
/// tokens on a real dispatch session.
@MainActor
final class DispatchPillSnapshotTests: XCTestCase {
    private var outputDirectory: URL!

    override func setUpWithError() throws {
        guard let dir = ProcessInfo.processInfo.environment["WINTER_PILL_SNAPSHOT_DIR"], !dir.isEmpty else {
            throw XCTSkip("set WINTER_PILL_SNAPSHOT_DIR to render the pill's checkpoints")
        }
        outputDirectory = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    }

    private let screen = CGRect(x: 0, y: 0, width: 1280, height: 800)

    private func pill(_ seed: (inout OrbSessionState) -> Void = { _ in }) -> DispatchPillController {
        let session = SessionModel()
        session.applyForTesting { s in
            s.status = .idle
            seed(&s)
        }
        let pill = DispatchPillController(session: session)
        pill.visibleFrameOverrideForTesting = screen
        return pill
    }

    /// Renders the pill's view tree at its canvas size, over a desktop-ish backdrop, to `<name>.png`.
    private func render(_ pill: DispatchPillController, _ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let host = NSHostingView(rootView: DispatchPillView(controller: pill))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: pill.canvas.size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = host
        // Two passes: the first lays out and reports the floating layers' size, which can grow the
        // canvas; the second renders at the settled canvas.
        for _ in 0..<3 {
            host.frame = CGRect(origin: .zero, size: pill.canvas.size)
            window.setContentSize(pill.canvas.size)
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        }
        let size = pill.canvas.size
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            return XCTFail("no bitmap for \(name)", file: file, line: line)
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        let pixelSize = CGSize(width: rep.pixelsWide, height: rep.pixelsHigh)

        let backdrop = NSImage(size: size)
        backdrop.lockFocus()
        NSGradient(starting: NSColor(calibratedRed: 0.36, green: 0.42, blue: 0.52, alpha: 1),
                   ending: NSColor(calibratedRed: 0.62, green: 0.56, blue: 0.50, alpha: 1))?
            .draw(in: CGRect(origin: .zero, size: size), angle: 90)
        rep.draw(in: CGRect(origin: .zero, size: size))
        backdrop.unlockFocus()

        guard let tiff = backdrop.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            return XCTFail("could not encode \(name)", file: file, line: line)
        }
        try png.write(to: outputDirectory.appendingPathComponent("\(name).png"))
        XCTAssertGreaterThan(pixelSize.width, 0, file: file, line: line)
    }

    func test1CompactIdle() throws {
        let p = pill()
        p.setPresentationForTesting(.compact)
        try render(p, "1-compact-idle")
    }

    func test2ExpandedWithText() throws {
        let p = pill()
        p.setPresentationForTesting(.expanded)
        p.adapter.composerDraft = "Summarise what changed in the release branch"
        p.setPresentationForTesting(.expanded)
        try render(p, "2-expanded-with-text")
    }

    func test3TextReachesTheButtonsAndTheyVanish() throws {
        let p = pill()
        p.adapter.composerDraft = "Summarise every change on the release branch since Monday, then open a PR with notes"
        p.setPresentationForTesting(.expanded)
        try render(p, "3-text-reaches-buttons")
    }

    func test4FullScreen() throws {
        let p = pill { s in
            s.exchanges = [
                Exchange(prompt: "What's running right now?", reply: "Two sessions: the auth fix and the docs pass. Both are mid-turn."),
                Exchange(prompt: "Start a session to bump the SDK pin", reply: "Started **bump-sdk** in the main checkout. I'll report back when its tests pass."),
            ]
            s.children = [ChildItem(sessionId: "c1", title: "bump-sdk", status: "running")]
        }
        p.visibleFrameOverrideForTesting = CGRect(x: 0, y: 0, width: 1100, height: 720)
        p.setPresentationForTesting(.fullScreen)
        try render(p, "4-full-screen")
    }

    func test5Working() throws {
        let p = pill { s in
            s.turnRunning = true
            s.status = .toolRunning(name: "bash")
            s.workingVerb = "Reticulating"
        }
        p.setPresentationForTesting(.compact)
        try render(p, "5-working")
    }

    func test6ApprovalFloatsAboveThePill() throws {
        let record = InteractionRecord(callId: "a1",
                                       ask: .approval(toolName: "bash", summary: "git push origin release/0.124"),
                                       childSessionId: "c1")
        let p = pill { s in
            s.turnRunning = true
            s.status = .approvalNeeded(count: 1)
            s.workingVerb = "Orchestrating"
            s.exchanges = [Exchange(prompt: "ship the release", reply: "", activity: [ActivityItem(kind: .interaction(record))])]
            s.children = [ChildItem(sessionId: "c1", title: "release", status: "awaiting_approval")]
        }
        p.setPresentationForTesting(.compact)
        try render(p, "6-approval-card")
    }

    func test7ChildPills() throws {
        let titles = ["fix auth", "docs pass", "bump sdk", "flaky test", "perf trace", "triage"]
        let statuses = ["running", "awaiting_approval", "completed", "running", "error", "running"]
        for count in [1, 2, 3, 4, 6] {
            let p = pill { s in
                s.children = (0..<count).map { ChildItem(sessionId: "c\($0)", title: titles[$0], status: statuses[$0]) }
            }
            p.setPresentationForTesting(.compact)
            try render(p, "7-child-pills-\(count)")
        }
    }
}
