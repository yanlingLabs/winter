import XCTest
import WinterKit
@testable import Winter

/// Phase 5b T5 review: `MemoryPaneModel`'s async correctness fixes — the stale-select-response
/// guard (Important: a slow `memory.read` resolving after a newer selection must never overwrite
/// the newer fact's edit state, or Save would write fact A's body under B's name), the same-shape
/// delete guard, and the `canSave` empty-field gating. Drives a real (actor) `WinterClient` over
/// the SAME scripted-transport double every other async model test in this target uses
/// (`FeedScriptedTransport`/`feedLineJSON`/`feedWaitUntil`, SessionFeedTests.swift) — same posture
/// as `PluginManagerModelAsyncTests`, no new client seam.
@MainActor
final class MemoryPaneModelTests: XCTestCase {
    /// Opens + hellos a scripted `WinterClient`, mirroring `PluginManagerModelAsyncTests.
    /// connectedClient()` exactly (send count 1 == `protocol.hello`).
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "memory-pane-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// THE race the review names: select(A) then select(B) before A's `memory.read` resolves; A's
    /// response landing LAST must be dropped entirely — pre-fix it overwrote
    /// detail/editedBody/editedDescription while `selectedName` showed B, so a Save in that window
    /// wrote A's content under B's name. Post-fix B's content stands and B's already-cleared
    /// loading state is untouched by A's stale defer.
    func testStaleSelectResponseDoesNotOverwriteNewerSelection() async throws {
        let (client, t) = try await connectedClient()
        let model = MemoryPaneModel(client: client)

        async let selectA: Void = model.select("fact-a")
        await feedWaitUntil { t.sent.count >= 2 } // request #2 (after hello): A's memory.read
        let reqA = feedLineJSON(t.sent[1])

        async let selectB: Void = model.select("fact-b")
        await feedWaitUntil { t.sent.count >= 3 } // request #3: B's memory.read
        let reqB = feedLineJSON(t.sent[2])

        // B's response resolves FIRST...
        t.feed(#"{"jsonrpc":"2.0","id":\#(reqB["id"] as! Int),"result":{"fact":{"name":"fact-b","description":"B desc","type":"user","body":"B body"}}}"#)
        await selectB
        XCTAssertEqual(model.detail?.name, "fact-b")

        // ...then A's stale response lands and must be dropped by the guard.
        t.feed(#"{"jsonrpc":"2.0","id":\#(reqA["id"] as! Int),"result":{"fact":{"name":"fact-a","description":"A desc","type":"reference","body":"A body"}}}"#)
        await selectA

        XCTAssertEqual(model.selectedName, "fact-b")
        XCTAssertEqual(model.detail?.name, "fact-b")
        XCTAssertEqual(model.editedBody, "B body")
        XCTAssertEqual(model.editedDescription, "B desc")
        XCTAssertFalse(model.detailLoading)
    }

    /// The same-shape Minor: a delete whose confirmation resolved while the user had ALREADY
    /// selected a different fact must not clear that newer selection — only the deleted fact's own
    /// still-current selection gets cleared (the trailing `refresh()` prunes the deleted row from
    /// the list either way).
    func testDeleteOfNonSelectedFactPreservesTheNewerSelection() async throws {
        let (client, t) = try await connectedClient()
        let model = MemoryPaneModel(client: client)

        // Select B and let it fully resolve.
        async let selectB: Void = model.select("fact-b")
        await feedWaitUntil { t.sent.count >= 2 }
        let readReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(readReq["id"] as! Int),"result":{"fact":{"name":"fact-b","description":"B desc","type":"user","body":"B body"}}}"#)
        await selectB

        // Delete A (a different fact) — as if its confirmation alert resolved after reselection.
        async let deleteA: Void = model.delete("fact-a")
        await feedWaitUntil { t.sent.count >= 3 } // request #3: memory.delete
        let deleteReq = feedLineJSON(t.sent[2])
        XCTAssertEqual(deleteReq["method"] as? String, "memory.delete")
        t.feed(#"{"jsonrpc":"2.0","id":\#(deleteReq["id"] as! Int),"result":{"ok":true}}"#)

        // The delete's trailing refresh() + loadAudit() — the list still contains fact-b, so the
        // selection must survive refresh()'s vanished-fact pruning too.
        await feedWaitUntil { t.sent.count >= 4 } // request #4: memory.list
        let listReq = feedLineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"facts":[{"name":"fact-b","description":"B desc","type":"user"}]}}"#)
        await feedWaitUntil { t.sent.count >= 5 } // request #5: memory.audit
        let auditReq = feedLineJSON(t.sent[4])
        t.feed(#"{"jsonrpc":"2.0","id":\#(auditReq["id"] as! Int),"result":{"lines":[]}}"#)
        await deleteA

        XCTAssertEqual(model.selectedName, "fact-b")
        XCTAssertEqual(model.detail?.name, "fact-b")
        XCTAssertEqual(model.editedBody, "B body")
    }

    /// Minor: Save must disable when either trimmed editable field is empty — `memory.write`'s
    /// schema rejects them (`min(1)`, methods.ts), so an enabled Save could only round-trip to the
    /// generic failure message. `isDirty` semantics are otherwise unchanged (loaded-unmodified
    /// stays un-savable).
    func testCanSaveRequiresDirtyAndNonEmptyTrimmedFields() async throws {
        let (client, t) = try await connectedClient()
        let model = MemoryPaneModel(client: client)

        async let select: Void = model.select("fact-a")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"fact":{"name":"fact-a","description":"desc","type":"user","body":"body"}}}"#)
        await select

        XCTAssertFalse(model.canSave, "loaded but unmodified — not dirty, not savable")

        model.editedBody = "new body"
        XCTAssertTrue(model.canSave)

        model.editedBody = "   \n  "
        XCTAssertFalse(model.canSave, "dirty but whitespace-only body must not be savable")

        model.editedBody = "new body"
        model.editedDescription = ""
        XCTAssertFalse(model.canSave, "dirty but emptied description must not be savable")
    }
}
