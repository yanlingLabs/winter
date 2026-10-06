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

    private func render(_ events: [SessionEvent], pill: Bool, _ name: String, expanded: Set<String> = [],
                        height: CGFloat = 420, appearance: NSAppearance.Name? = nil,
                        file: StaticString = #filePath, line: UInt = #line) throws {
        let session = SessionModel()
        session.apply(contentsOf: events)
        let adapter = FieldStateAdapter(session: session)
        let records = pendingInteractionRecords(in: adapter.transcript, live: adapter.pendingInteractions,
                                                inactive: adapter.inactiveElicitations)
        let transcript = TranscriptView(adapter: adapter, tint: pill ? .white : .blue,
                                        cardWiring: dispatchPillCardWiring(adapter: adapter, records: records))
            .environment(\.transcriptSeededExpansion, expanded)
            .padding(16)
        // The pill-themed window is dark whatever the system's appearance (`DetachedWindowController`
        // forces `.darkAqua` and `colorScheme .dark`), so a "light" pill render puts that window on a
        // light system and checks it still draws as it does on a dark one.
        let root: AnyView = pill
            ? AnyView(transcript
                .environment(\.transcriptUserMessageStyle, .ruled)
                .environment(\.transcriptToolRowStyle, .pill)
                .environment(\.transcriptMarkerTint, .white)
                .background(Color.black)
                .environment(\.colorScheme, .dark))
            : AnyView(transcript.background(Color(nsColor: .windowBackgroundColor)))
        let size = CGSize(width: 720, height: height)
        let host = NSHostingView(rootView: root.frame(width: size.width, height: size.height))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance ?? (pill ? .darkAqua : .aqua))
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

    // MARK: - Opening pills into themselves (2026-10-06)

    /// One event from a dictionary — no hand-escaping of long texts.
    private func event(_ fields: [String: Any]) -> SessionEvent? {
        var all: [String: Any] = ["seq": 1, "sessionId": "s", "ts": 0, "threadId": "main"]
        all.merge(fields) { _, new in new }
        guard let data = try? JSONSerialization.data(withJSONObject: all) else { return nil }
        return try? JSONDecoder().decode(SessionEvent.self, from: data)
    }

    private static let rawReasoning: String = {
        let paragraphs = [
            "Let me read the layout code first. The flow layout places pills left to right and wraps when the column runs out, so an opened pill has to leave that flow and take the whole line.",
            "Okay, so `PillFlowLayout` asks each subview for its ideal size with an unspecified proposal. If the opened pill reports the column's width instead, it lands on a line of its own — but only if the layout knows to break the line before AND after it.",
            "**Option one:** split the row into runs around the opened pill. That changes the view's identity, so SwiftUI cross-fades instead of morphing.",
            "**Option two:** keep the pill where it is and mark it with a layout value. The same view grows; the layout moves its neighbours. That animates as one shape.",
            "I'll go with option two. Next I need the radius: a capsule is a rounded rectangle whose radius is half its height, so animating the radius from 17 to 16 while the height grows reads as the capsule turning into a card.",
            "Then the text. Markdown re-parsed on every delta would be quadratic over a long block, so while it streams it stays plain and it becomes markdown once the block is persisted.",
            "Finally, the scroll box: anything taller than the box scrolls inside a bounded height and, while live, follows the newest line.",
            "Let me double-check the copy button too. It should sit only under the final reply — a message with a tool call after it is a step, not an answer.",
            "Okay, that matches. The last thing is the website pills: flat, grey, no rim, favicon first, host prominent and the path muted and cut in the middle.",
        ]
        return paragraphs.joined(separator: "\n\n")
    }()

    private static let searchSites: [[String: String]] = [
        ["url": "https://developer.apple.com/documentation/swiftui/layout", "iconUrl": "https://developer.apple.com/favicon.ico"],
        ["url": "https://www.hackingwithswift.com/quick-start/swiftui/how-to-create-a-custom-layout-using-the-layout-protocol", "iconUrl": "https://www.hackingwithswift.com/favicon.ico"],
        ["url": "https://swiftwithmajid.com/2022/11/16/building-custom-layout-in-swiftui-basics/", "iconUrl": "https://swiftwithmajid.com/favicon.ico"],
        ["url": "https://www.swiftbysundell.com/articles/swiftui-layout-system-guide-part-1/", "iconUrl": "https://www.swiftbysundell.com/favicon.ico"],
        ["url": "https://stackoverflow.com/questions/73480133/swiftui-flow-layout", "iconUrl": "https://stackoverflow.com/favicon.ico"],
        ["url": "https://github.com/apple/swift", "iconUrl": "https://github.com/favicon.ico"],
    ]

    /// A turn that reasoned at length, searched, summarized its plan and answered — done or live.
    private func expandEvents(live: Bool) -> [SessionEvent] {
        var events: [SessionEvent?] = [
            event(["type": "user_message", "text": "Make the thinking pill expandable", "clientName": "cli"]),
            event(["type": "turn_started"]),
            event(["type": "thinking_block", "blockId": "b1", "kind": "summary", "title": "Planning the layout change",
                   "text": "**Planning the layout change**\n\nThe pill should open *into itself*: the same row on top, the text below, and the whole thing a rounded card.", "durationMs": 1800]),
            event(["type": "assistant_message", "text": "Let me look at how other apps lay this out."]),
            event(["type": "tool_call", "callId": "c1", "name": "WebSearch", "argsJson": #"{"query":"swiftui custom flow layout animation"}"#]),
            event(["type": "tool_call", "callId": "c2", "name": "WebSearch", "argsJson": #"{"query":"swiftui layout protocol line break"}"#]),
            event(["type": "tool_result", "callId": "c1", "output": "6 results", "isError": false,
                   "siteIcons": Array(Self.searchSites.prefix(4))]),
            event(["type": "tool_result", "callId": "c2", "output": "Results: https://stackoverflow.com/questions/73480133/swiftui-flow-layout and https://github.com/apple/swift", "isError": false]),
        ]
        if live {
            events.append(event(["type": "thinking_delta", "blockId": "b2", "kind": "exposed", "phase": "start"]))
            // Streamed in small increments, as a raw-reasoning provider sends them.
            var rest = Substring(Self.rawReasoning)
            while !rest.isEmpty {
                let chunk = rest.prefix(37)
                rest = rest.dropFirst(chunk.count)
                events.append(event(["type": "thinking_delta", "blockId": "b2", "kind": "exposed", "phase": "delta",
                                     "text": String(chunk), "title": "Keeping the pill in the flow"]))
            }
        } else {
            events += [
                event(["type": "thinking_block", "blockId": "b2", "kind": "exposed", "title": "Keeping the pill in the flow",
                       "text": Self.rawReasoning, "durationMs": 9200]),
                event(["type": "thinking_block", "blockId": "b3", "kind": "hidden", "text": "", "durationMs": 400]),
                event(["type": "assistant_message", "text": "Done — **thinking** and **search** pills now open into themselves:\n\n- a chevron on the pill\n- the capsule morphs into a card\n- closing returns the capsule"]),
                event(["type": "turn_completed", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1]),
            ]
        }
        return events.compactMap { $0 }
    }

    func testE1ThinkingCollapsedDone() throws {
        try render(expandEvents(live: false), pill: true, "expand-1-thinking-collapsed-done", height: 560)
    }
    func testE2ThinkingExpandedDone() throws {
        try render(expandEvents(live: false), pill: true, "expand-2-thinking-expanded-done",
                   expanded: ["thinking:b1", "thinking:b2"], height: 860)
    }
    func testE3ThinkingCollapsedLive() throws {
        try render(expandEvents(live: true), pill: true, "expand-3-thinking-collapsed-live", height: 480)
    }
    func testE4ThinkingExpandedLive() throws {
        try render(expandEvents(live: true), pill: true, "expand-4-thinking-expanded-live", expanded: ["thinking:b2"], height: 680)
    }
    func testE5SearchExpandedDone() throws {
        try render(expandEvents(live: false), pill: true, "expand-5-search-expanded-done", expanded: ["call:c1"], height: 640)
    }
    func testE6SearchExpandedLight() throws {
        try render(expandEvents(live: false), pill: true, "expand-6-search-expanded-light-system",
                   expanded: ["call:c1", "thinking:b1"], height: 700, appearance: .aqua)
    }
    func testE7CopyButtonsLineLight() throws {
        try render(expandEvents(live: false), pill: false, "expand-7-copy-line-light", height: 620, appearance: .aqua)
    }
    func testE8CopyButtonsLineDark() throws {
        try render(expandEvents(live: false), pill: false, "expand-8-copy-line-dark", height: 620, appearance: .darkAqua)
    }

    /// A long user message in the pill window: clamped, fading out above the hairline, "Show more" on top.
    func testE9LongUserMessageCollapsed() throws {
        let long = (1...14).map { "Line \($0): the detached window should hide most of a long prompt behind a soft blur, keep the hairline right under it and offer Show more." }
            .joined(separator: "\n\n")
        let events = [
            event(["type": "user_message", "text": long, "clientName": "cli"]),
            event(["type": "turn_started"]),
            event(["type": "assistant_message", "text": "Got it."]),
            event(["type": "turn_completed", "stopReason": "end_turn", "inputTokens": 1, "outputTokens": 1]),
        ].compactMap { $0 }
        try render(events, pill: true, "expand-9-long-user-message", height: 460)
    }

    /// The same block alone through `ImageRenderer` (SwiftUI's own renderer, closest to the window).
    func testE10LongUserMessageBlur() throws {
        let long = (1...14).map { "Line \($0): the detached window should hide most of a long prompt behind a soft blur, keep the hairline right under it and offer Show more." }
            .joined(separator: "\n\n")
        let view = TranscriptUserBubble(text: long, tint: .white)
            .environment(\.transcriptUserMessageStyle, .ruled)
            .environment(\.colorScheme, .dark)
            .frame(width: 688)
            .padding(16)
            .background(Color.black)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.cgImage else { return XCTFail("no image") }
        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else { return XCTFail("no png") }
        try png.write(to: outputDirectory.appendingPathComponent("expand-10-long-user-message-fade.png"))
    }

    func test1PillLiveUntitled() throws { try render(liveEvents(titled: false), pill: true, "pill-1-live-thinking") }
    func test2PillLiveTitled() throws { try render(liveEvents(titled: true), pill: true, "pill-2-live-titled") }
    func test3PillDone() throws { try render(doneEvents(), pill: true, "pill-3-done") }
    func test4LineLiveUntitled() throws { try render(liveEvents(titled: false), pill: false, "line-1-live-thinking") }
    func test5LineLiveTitled() throws { try render(liveEvents(titled: true), pill: false, "line-2-live-titled") }
    func test6LineDone() throws { try render(doneEvents(), pill: false, "line-3-done") }
}
