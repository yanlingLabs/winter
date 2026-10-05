import XCTest
import AppKit
import SwiftUI
import WinterProtocol
@testable import Winter

/// Offscreen renders of the thinking pill (2026-10-05), for review — NOT a pixel-diff suite. Skipped
/// unless `WINTER_PILL_SNAPSHOT_DIR` names a directory (pass it to the runner as
/// `TEST_RUNNER_WINTER_PILL_SNAPSHOT_DIR=… xcodebuild test …`); each case writes one PNG there. The
/// real `TranscriptView` is rendered with the pill-themed window's environment (`.pill` rows, ruled
/// user bubbles, white markers, a dark backdrop) and with the default line style.
///
/// `WINTER_THINKING_SNAPSHOT_LOG` may name a real session log (`<home>/sessions/…/s_….jsonl`): its
/// events are replayed exactly as the app replays them, so the "done" render shows the titles a live
/// provider produced. Without it a synthetic exchange stands in.
@MainActor
final class ThinkingPillSnapshotTests: XCTestCase {
    private var outputDirectory: URL!

    override func setUpWithError() throws {
        guard let dir = ProcessInfo.processInfo.environment["WINTER_PILL_SNAPSHOT_DIR"], !dir.isEmpty else {
            throw XCTSkip("set WINTER_PILL_SNAPSHOT_DIR to render the thinking pill")
        }
        outputDirectory = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
    }

    private func decode(_ json: String) -> SessionEvent? {
        try? JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
    }

    /// The events of a real session log when one is named, else a synthetic codex-style exchange.
    private func doneEvents() -> [SessionEvent] {
        if let path = ProcessInfo.processInfo.environment["WINTER_THINKING_SNAPSHOT_LOG"], !path.isEmpty,
           let text = try? String(contentsOfFile: path, encoding: .utf8) {
            return text.split(separator: "\n").compactMap { decode(String($0)) }
        }
        return [
            #"{"type":"user_message","seq":1,"sessionId":"s","ts":0,"threadId":"main","text":"Look at div and design a fix","clientName":"cli"}"#,
            #"{"type":"turn_started","seq":2,"sessionId":"s","ts":0,"threadId":"main"}"#,
            #"{"type":"thinking_block","seq":3,"sessionId":"s","ts":0,"threadId":"main","blockId":"b1","kind":"summary","title":"Listing source files for inspection","text":"**Listing source files for inspection**","durationMs":1296}"#,
            #"{"type":"tool_call","seq":4,"sessionId":"s","ts":0,"threadId":"main","callId":"c1","name":"bash","argsJson":"{\"command\":\"ls\"}"}"#,
            #"{"type":"tool_result","seq":5,"sessionId":"s","ts":0,"threadId":"main","callId":"c1","output":"README.md\nsrc","isError":false}"#,
            #"{"type":"thinking_block","seq":6,"sessionId":"s","ts":0,"threadId":"main","blockId":"b2","kind":"hidden","text":"","durationMs":2182}"#,
            #"{"type":"assistant_message","seq":7,"sessionId":"s","ts":0,"threadId":"main","text":"div multiplies instead of dividing."}"#,
            #"{"type":"turn_completed","seq":8,"sessionId":"s","ts":0,"threadId":"main","stopReason":"end_turn","inputTokens":1,"outputTokens":1}"#,
        ].compactMap(decode)
    }

    /// A turn still running: one finished titled block, a read, then a block streaming — first
    /// untitled ("Thinking"), then with its title.
    private func liveEvents(titled: Bool) -> [SessionEvent] {
        var lines = [
            #"{"type":"user_message","seq":1,"sessionId":"s","ts":0,"threadId":"main","text":"Look at div and design a fix","clientName":"cli"}"#,
            #"{"type":"turn_started","seq":2,"sessionId":"s","ts":0,"threadId":"main"}"#,
            #"{"type":"thinking_block","seq":3,"sessionId":"s","ts":0,"threadId":"main","blockId":"b1","kind":"summary","title":"Listing source files for inspection","text":"**Listing source files for inspection**","durationMs":1296}"#,
            #"{"type":"tool_call","seq":4,"sessionId":"s","ts":0,"threadId":"main","callId":"c1","name":"read","argsJson":"{\"file_path\":\"src/calc.js\"}"}"#,
            #"{"type":"tool_result","seq":5,"sessionId":"s","ts":0,"threadId":"main","callId":"c1","output":"export const div = (a, b) => a * b;","isError":false}"#,
            #"{"type":"thinking_delta","seq":5,"sessionId":"s","ts":0,"threadId":"main","blockId":"b2","kind":"summary","phase":"start"}"#,
        ]
        if titled {
            lines.append(#"{"type":"thinking_delta","seq":5,"sessionId":"s","ts":0,"threadId":"main","blockId":"b2","kind":"summary","phase":"delta","text":"**Comparing three design approaches**","title":"Comparing three design approaches"}"#)
        }
        return lines.compactMap(decode)
    }

    private func render(_ events: [SessionEvent], pill: Bool, _ name: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let session = SessionModel()
        session.apply(contentsOf: events)
        let adapter = FieldStateAdapter(session: session)
        let records = pendingInteractionRecords(in: adapter.transcript, live: adapter.pendingInteractions,
                                                inactive: adapter.inactiveElicitations)
        let transcript = TranscriptView(adapter: adapter, tint: pill ? .white : .blue,
                                        cardWiring: dispatchPillCardWiring(adapter: adapter, records: records))
            .padding(16)
        let root: AnyView = pill
            ? AnyView(transcript
                .environment(\.transcriptUserMessageStyle, .ruled)
                .environment(\.transcriptToolRowStyle, .pill)
                .environment(\.transcriptMarkerTint, .white)
                .background(Color(red: 0.07, green: 0.07, blue: 0.08)))
            : AnyView(transcript.background(Color(nsColor: .windowBackgroundColor)))
        let size = CGSize(width: 720, height: 420)
        let host = NSHostingView(rootView: root.frame(width: size.width, height: size.height))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: pill ? .darkAqua : .aqua)
        window.contentView = host
        for _ in 0..<3 {
            host.frame = CGRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        }
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            return XCTFail("no bitmap for \(name)", file: file, line: line)
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            return XCTFail("could not encode \(name)", file: file, line: line)
        }
        try png.write(to: outputDirectory.appendingPathComponent("\(name).png"))
    }

    func test1PillLiveUntitled() throws { try render(liveEvents(titled: false), pill: true, "pill-1-live-thinking") }
    func test2PillLiveTitled() throws { try render(liveEvents(titled: true), pill: true, "pill-2-live-titled") }
    func test3PillDone() throws { try render(doneEvents(), pill: true, "pill-3-done") }
    func test4LineLiveUntitled() throws { try render(liveEvents(titled: false), pill: false, "line-1-live-thinking") }
    func test5LineLiveTitled() throws { try render(liveEvents(titled: true), pill: false, "line-2-live-titled") }
    func test6LineDone() throws { try render(doneEvents(), pill: false, "line-3-done") }
}
