import XCTest
import AppKit
import WinterProtocol
import WinterKit
@testable import Winter

/// A session window keeps up with a streaming reply (user, 2026-10-02: the windows fell behind
/// the dispatch pill — the pill showed a child done while its window was still "streaming").
/// Real window, real feed, real transcript: a reply streamed as a model streams it, and the
/// window must have folded all of it soon after the last chunk arrives.
@MainActor
final class StreamingThroughputTests: XCTestCase {
    private func waitUntilSent(_ t: DetachedScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline { try? await Task.sleep(nanoseconds: 20_000_000) }
    }

    /// `DetachedWindowTests.answerHandshake`'s steps: hello, then the pinned attach.
    private func answerHandshake(_ t: DetachedScriptedTransport, sessionId: String) async {
        await waitUntilSent(t, 1)
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let attach = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
    }

    private func event(_ json: String) -> String {
        #"{"jsonrpc":"2.0","method":"event","params":\#(json)}"#
    }

    private func jsonString(_ s: String) -> String {
        String(decoding: try! JSONEncoder().encode(s), as: UTF8.self)
    }

    func testAWindowKeepsUpWithAStreamingReply() async throws {
        try await run(withWindow: true)
    }

    func testTheFeedAloneKeepsUp() async throws {
        try await run(withWindow: false)
    }

    private func run(withWindow: Bool) async throws {
        let t = DetachedScriptedTransport()
        let session = SessionModel()
        let feed = SessionFeed(makeTransport: { t }, token: "tok", clientName: "orb", mode: .pinned(sessionId: "S1"), session: session)
        var controller: DetachedWindowController?
        if withWindow {
            controller = DetachedWindowController(feed: feed, session: session,
                                                  frame: NSRect(x: 200, y: 200, width: 560, height: 640), title: "W")
            controller?.show()
        } else {
            Task { await feed.start() }
        }
        defer { controller?.close(); if !withWindow { feed.stop() } }
        await answerHandshake(t, sessionId: "S1")

        var seq = 0
        func next() -> Int { seq += 1; return seq }
        let paragraph = "**Résumé.** Ice floats because its solid form is less dense than liquid water: hydrogen bonds lock the molecules into an open hexagonal lattice, and *that* lattice takes up about 9% more room. "
        // Five earlier exchanges, each with a long reply — a session a few rounds in.
        for i in 0..<5 {
            t.feed(event(#"{"type":"user_message","seq":\#(next()),"sessionId":"S1","ts":1,"threadId":"main","text":"round \#(i)"}"#))
            t.feed(event(#"{"type":"assistant_message","seq":\#(next()),"sessionId":"S1","ts":1,"threadId":"main","text":\#(jsonString(String(repeating: paragraph + "\n\n", count: 12)))}"#))
        }
        t.feed(event(#"{"type":"user_message","seq":\#(next()),"sessionId":"S1","ts":1,"threadId":"main","text":"go"}"#))
        t.feed(event(#"{"type":"turn_started","seq":\#(next()),"sessionId":"S1","ts":1,"threadId":"main"}"#))

        // ~10 KB streamed in 4-character chunks, as fast as a provider sends them.
        let reply = String(repeating: paragraph + "\n\n", count: 40)
        var chunks: [String] = []
        var i = reply.startIndex
        while i < reply.endIndex {
            let j = reply.index(i, offsetBy: 4, limitedBy: reply.endIndex) ?? reply.endIndex
            chunks.append(String(reply[i..<j])); i = j
        }
        let started = Date()
        for chunk in chunks {
            t.feed(event(#"{"type":"assistant_delta","seq":\#(seq),"sessionId":"S1","ts":1,"threadId":"main","delta":\#(jsonString(chunk))}"#))
        }
        let deadline = Date().addingTimeInterval(60)
        while session.state.streamingText.count < reply.count, Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        let elapsed = Date().timeIntervalSince(started)
        print("STREAMING-THROUGHPUT window=\(withWindow) chunks=\(chunks.count) chars=\(reply.count) elapsed=\(String(format: "%.2f", elapsed))s")
        XCTAssertEqual(session.state.streamingText.count, reply.count, "the whole reply folded")
        XCTAssertLessThan(elapsed, 3, "a window folds a 10 KB reply's \(chunks.count) chunks in well under the time a model takes to write it")
    }
}
