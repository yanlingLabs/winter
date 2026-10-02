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
        // A throwaway suite, never written (no render shows or hides the pill): the test host is
        // the app, and `.standard` is the dev app's real preferences.
        let settings = DispatchPillSettings(defaults: UserDefaults(suiteName: "WinterTests.DispatchPill.snapshots")!)
        let pill = DispatchPillController(session: session, settings: settings)
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

    func test8MidMorphBlurs() throws {
        let p = pill()
        p.adapter.composerDraft = "Summarise what changed in the release branch"
        p.setPresentationForTesting(.expanded)
        p.setAnimatedSizeForTesting(CGSize(width: DispatchPillMetrics.compactWidth + 60,
                                           height: DispatchPillMetrics.pillHeight))
        try render(p, "8-mid-morph")
    }

    func test9WorkingChildren() throws {
        let p = pill { s in
            s.turnRunning = true
            s.status = .thinking
            s.children = [ChildItem(sessionId: "c0", title: "fix auth", status: "running"),
                          ChildItem(sessionId: "c1", title: "docs pass", status: "running"),
                          ChildItem(sessionId: "c2", title: "bump sdk", status: "running")]
        }
        p.setPresentationForTesting(.compact)
        try render(p, "9-working-children")
    }

    func test10PinnedTurnShowsAlone() throws {
        let p = pill { s in
            s.exchanges = [Exchange(prompt: "can you spawn a session in code and tell it to set a sleep 30 in foreground",
                                    reply: "Noted — that one didn't decode into a task. What do you want me to do?"),
                           Exchange(prompt: "summarise the release branch",
                                    reply: "Fourteen commits since Monday: the dispatch pill, the plume, child colours, and the session_spawn rebuild, which is still in review before it merges.")]
        }
        p.setPresentationForTesting(.expanded, historyIndex: 0)
        try render(p, "10-pinned-turn-short")
        p.setPresentationForTesting(.expanded, historyIndex: 1)
        try render(p, "10-pinned-turn-long")
    }

    func test11ToolTilesRideThePlume() throws {
        var model = WorkingAnimationModel(seed: 11)
        model.tick(dt: 1.0 / 60.0)
        let thrown = [PlumeThrow(id: "1", kind: .tool(symbol: "terminal")),
                      PlumeThrow(id: "2", kind: .tool(symbol: "pencil")),
                      PlumeThrow(id: "3", kind: .site(host: "example.invalid")),
                      PlumeThrow(id: "4", kind: .tool(symbol: "doc.text")),
                      PlumeThrow(id: "5", kind: .tool(symbol: "checklist"))]
        for i in 0..<70 { model.tick(dt: 1.0 / 60.0, thrown: Array(thrown.prefix(1 + i / 12))) }
        let size = CGSize(width: DispatchPillMetrics.compactWidth, height: DispatchPillMetrics.pillHeight)
        let view = ZStack(alignment: .trailing) {
            Color.black
            WorkingAnimationView(thrown: thrown,
                                 emitterInset: DispatchPillMetrics.trailingPadding + DispatchPillMetrics.sendCircleSize / 2,
                                 initialModel: model)
            PillSendStopButton(isRunning: true, canSend: false, onSend: {}, onStop: {})
                .padding(.trailing, DispatchPillMetrics.trailingPadding)
        }
        .frame(width: size.width, height: size.height)
        .clipShape(Capsule())
        let host = NSHostingView(rootView: view)
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            .write(to: outputDirectory.appendingPathComponent("11-tool-tiles.png"))
    }

    func test12ErroredChildrenAreFullHeight() throws {
        let p = pill { s in
            s.children = (0..<3).map { ChildItem(sessionId: "e\($0)", title: "Search + 2 reads", status: $0 == 1 ? "completed" : "error") }
        }
        p.setPresentationForTesting(.compact)
        try render(p, "12-errored-children")
    }

    func test13DetachedWindowWearsThePillTheme() throws {
        let session = SessionModel()
        session.applyForTesting { s in
            s.status = .idle
            s.exchanges = [
                Exchange(prompt: "Search the web for the Rosetta Stone and fetch one page", reply: "Done.\n\n- **Stone:** a granodiorite stela from 196 BC\n- **Kept:** the British Museum, since 1802\n\n1. Search\n2. Fetch",
                         activity: [ActivityItem(kind: .tool(name: "Search", detail: "Rosetta Stone", callId: "s1", output: "ok")),
                                    ActivityItem(kind: .tool(name: "WebFetch", detail: "https://www.britishmuseum.org", callId: "f1", output: "ok"))]),
                Exchange(prompt: "Read the config and check the build", reply: "The build reads `project.yml`; one test failed.",
                         activity: [ActivityItem(kind: .tool(name: "read", detail: "project.yml", callId: "r1", output: "name: Winter")),
                                    ActivityItem(kind: .tool(name: "grep", detail: "deploymentTarget", callId: "g1", output: "13:"))  ,
                                    ActivityItem(kind: .tool(name: "bash", detail: "xcodebuild test", callId: "x1", output: "1 failure", isError: true))]),
                Exchange(prompt: "and research rocket engines", reply: "",
                         activity: [ActivityItem(kind: .tool(name: "web_search", detail: "rocket engines", callId: "w1", output: "https://nasa.gov https://spacex.com https://esa.int",
                                                             siteIcons: [SiteIconRef(url: "https://nasa.gov", iconUrl: "https://nasa.gov/favicon.ico"),
                                                                         SiteIconRef(url: "https://spacex.com", iconUrl: "https://spacex.com/favicon.ico")])),
                                    ActivityItem(kind: .tool(name: "web_search", detail: "nozzle design", callId: "w2")),
                                    ActivityItem(kind: .tool(name: "WebFetch", detail: "https://www.nasa.gov/rockets", callId: "f2")),
                                    ActivityItem(kind: .tool(name: "bash", detail: "sleep 24", callId: "b1")),
                                    ActivityItem(kind: .tool(name: "bash", detail: "ls", callId: "b2", output: "a b"))]),
            ]
            s.turnRunning = true
            s.status = .toolRunning(name: "bash")
        }
        let adapter = FieldStateAdapter(session: session)
        let size = CGSize(width: 720, height: 1100)
        let bleed = ProcessInfo.processInfo.environment["WINTER_PILL_SNAPSHOT_BLEED"] != nil
        let view = WindowContentView(adapter: adapter, tint: .white, topInset: bleed ? 8 : 52, sidebars: nil,
                                     topBleed: bleed ? 54 : 0, pillChrome: true) { EmptyView() }
            .environment(\.transcriptUserMessageStyle, .ruled)
            .environment(\.transcriptToolRowStyle, .pill)
            .environment(\.transcriptMarkerTint, .white)
            .environment(\.pillChromePalette, .violet)
            .background(Color.black)
            .environment(\.colorScheme, .dark)
            .frame(width: size.width, height: size.height)
        let host = NSHostingView(rootView: view)
        host.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        for _ in 0..<3 { host.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.3)) }
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            .write(to: outputDirectory.appendingPathComponent("13-detached-window.png"))
    }

    /// The real detached window (its theme frame, traffic lights included), pill-themed, mid-turn —
    /// for the header and the composer. Note: `cacheDisplay` does not capture an ON-SCREEN window's
    /// scroll view, so the transcript renders blank here; test 13 renders the same column offscreen.
    func test14DetachedWindowRealChrome() throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        let controller = DetachedWindowController(feed: feed, session: session, frame: NSRect(x: 100, y: 100, width: 820, height: 620),
                                                  title: "Rosetta research", palette: .violet)
        defer { controller.close() }
        controller.show()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        // After the show: attaching the feed resets the session, so the state goes in once it has.
        session.applyForTesting { s in
            s.exchanges = [
                Exchange(prompt: "Search the web for the Rosetta Stone and fetch one page",
                         reply: "The Rosetta Stone is a granodiorite stela from 196 BC, kept at the British Museum since 1802. Its three scripts — hieroglyphic, Demotic and Greek — let Champollion decipher hieroglyphs in 1822.",
                         activity: [ActivityItem(kind: .tool(name: "Search", detail: "Rosetta Stone", callId: "s1", output: "ok")),
                                    ActivityItem(kind: .tool(name: "WebFetch", detail: "https://www.britishmuseum.org", callId: "f1", output: "ok"))]),
                Exchange(prompt: "now run sleep 24 in the foreground", reply: "",
                         activity: [ActivityItem(kind: .tool(name: "bash", detail: "sleep 24", callId: "b1"))]),
            ]
            s.turnRunning = true
            s.status = .toolRunning(name: "bash")
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(session.state.exchanges.count, 2)
        XCTAssertTrue(session.state.turnRunning)
        let window = try XCTUnwrap(controller.windowForTesting)
        let frameView = try XCTUnwrap(window.contentView?.superview)
        for _ in 0..<4 { frameView.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.3)) }
        let rep = try XCTUnwrap(frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds))
        frameView.cacheDisplay(in: frameView.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            .write(to: outputDirectory.appendingPathComponent("14-detached-window-real.png"))
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
