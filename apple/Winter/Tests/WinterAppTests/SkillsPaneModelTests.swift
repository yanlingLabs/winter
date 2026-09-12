import XCTest
import WinterKit
@testable import Winter

/// Phase 5c Task 4: `SkillsPaneModel`'s async correctness — copied verbatim (house pattern, brief
/// T4) from `MemoryPaneModelTests`'s stale-select-response guard (a slow `skills.read` resolving
/// after a newer selection must never overwrite the newer skill's edit state, or Save would write
/// skill A's body under B's name), the same-shape delete guard, and the `canSave` gating — PLUS
/// the self-vs-non-self read-only gating this pane adds on top of Memory's shape (`skills.write`/
/// `skills.delete` are server-confined to the self source; this pane must never even offer them
/// for anything else). Drives a real (actor) `WinterClient` over the SAME scripted-transport double
/// every other async model test in this target uses (`FeedScriptedTransport`/`feedLineJSON`/
/// `feedWaitUntil`, SessionFeedTests.swift) — same posture as `MemoryPaneModelTests`, no new client
/// seam.
@MainActor
final class SkillsPaneModelTests: XCTestCase {
    /// Opens + hellos a scripted `WinterClient`, mirroring `MemoryPaneModelTests.connectedClient()`
    /// exactly (send count 1 == `protocol.hello`).
    private func connectedClient() async throws -> (WinterClient, FeedScriptedTransport) {
        let t = FeedScriptedTransport()
        let client = WinterClient(makeTransport: { t }, token: "tok", clientName: "skills-pane-test")
        async let c: Void = client.connect()
        await feedWaitUntil { !t.sent.isEmpty }
        let hello = feedLineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// THE race the review named on `MemoryPaneModel` (same shape here): select(A) then select(B)
    /// before A's `skills.read` resolves; A's response landing LAST must be dropped entirely —
    /// unguarded, it would overwrite detail/editedBody/editedDescription while `selectedName`
    /// showed B, so a Save in that window would write A's content under B's name. Post-fix B's
    /// content stands and B's already-cleared loading state is untouched by A's stale defer.
    func testStaleSelectResponseDoesNotOverwriteNewerSelection() async throws {
        let (client, t) = try await connectedClient()
        let model = SkillsPaneModel(client: client)

        async let selectA: Void = model.select("skill-a")
        await feedWaitUntil { t.sent.count >= 2 } // request #2 (after hello): A's skills.read
        let reqA = feedLineJSON(t.sent[1])

        async let selectB: Void = model.select("skill-b")
        await feedWaitUntil { t.sent.count >= 3 } // request #3: B's skills.read
        let reqB = feedLineJSON(t.sent[2])

        // B's response resolves FIRST...
        t.feed(#"{"jsonrpc":"2.0","id":\#(reqB["id"] as! Int),"result":{"skill":{"name":"skill-b","description":"B desc","source":"self","path":"/self/skill-b","author":"winter","body":"B body"}}}"#)
        await selectB
        XCTAssertEqual(model.detail?.name, "skill-b")

        // ...then A's stale response lands and must be dropped by the guard.
        t.feed(#"{"jsonrpc":"2.0","id":\#(reqA["id"] as! Int),"result":{"skill":{"name":"skill-a","description":"A desc","source":"project","path":"/proj/skill-a","body":"A body"}}}"#)
        await selectA

        XCTAssertEqual(model.selectedName, "skill-b")
        XCTAssertEqual(model.detail?.name, "skill-b")
        XCTAssertEqual(model.editedBody, "B body")
        XCTAssertEqual(model.editedDescription, "B desc")
        XCTAssertFalse(model.detailLoading)
    }

    /// The same-shape guard on delete: a delete whose confirmation resolved while the user had
    /// ALREADY selected a different skill must not clear that newer selection — only the deleted
    /// skill's own still-current selection gets cleared (the trailing `refresh()` prunes the
    /// deleted row from the list either way).
    func testDeleteOfNonSelectedSkillPreservesTheNewerSelection() async throws {
        let (client, t) = try await connectedClient()
        let model = SkillsPaneModel(client: client)

        // Select B (self) and let it fully resolve.
        async let selectB: Void = model.select("skill-b")
        await feedWaitUntil { t.sent.count >= 2 }
        let readReq = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(readReq["id"] as! Int),"result":{"skill":{"name":"skill-b","description":"B desc","source":"self","path":"/self/skill-b","author":"winter","body":"B body"}}}"#)
        await selectB

        // Delete A (a different skill) — as if its confirmation alert resolved after reselection.
        async let deleteA: Void = model.delete("skill-a")
        await feedWaitUntil { t.sent.count >= 3 } // request #3: skills.delete
        let deleteReq = feedLineJSON(t.sent[2])
        XCTAssertEqual(deleteReq["method"] as? String, "skills.delete")
        t.feed(#"{"jsonrpc":"2.0","id":\#(deleteReq["id"] as! Int),"result":{"ok":true}}"#)

        // The delete's trailing refresh() — the list still contains skill-b, so the selection must
        // survive refresh()'s vanished-skill pruning too.
        await feedWaitUntil { t.sent.count >= 4 } // request #4: skills.list
        let listReq = feedLineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"skills":[{"name":"skill-b","description":"B desc","source":"self","path":"/self/skill-b","author":"winter"}]}}"#)
        await deleteA

        XCTAssertEqual(model.selectedName, "skill-b")
        XCTAssertEqual(model.detail?.name, "skill-b")
        XCTAssertEqual(model.editedBody, "B body")
    }

    /// Save must disable when either trimmed editable field is empty — `skills.write`'s schema
    /// rejects them (`min(1)`, methods.ts), so an enabled Save could only round-trip to the generic
    /// failure message. `isDirty` semantics are otherwise unchanged (loaded-unmodified stays
    /// un-savable). Mirrors `MemoryPaneModelTests.testCanSaveRequiresDirtyAndNonEmptyTrimmedFields`.
    func testCanSaveRequiresDirtyAndNonEmptyTrimmedFields() async throws {
        let (client, t) = try await connectedClient()
        let model = SkillsPaneModel(client: client)

        async let select: Void = model.select("skill-a")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"skill":{"name":"skill-a","description":"desc","source":"self","path":"/self/skill-a","author":"winter","body":"body"}}}"#)
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

    /// The read-only gating this pane adds on top of Memory's shape: a NON-self skill must never
    /// be savable, no matter what the (inert) editable fields hold — `skills.write` is
    /// server-confined to self regardless, but the pane must never even OFFER the affordance.
    func testCanSaveIsFalseForNonSelfSkillEvenIfFieldsDiffer() async throws {
        let (client, t) = try await connectedClient()
        let model = SkillsPaneModel(client: client)

        async let select: Void = model.select("builtin-skill")
        await feedWaitUntil { t.sent.count >= 2 }
        let req = feedLineJSON(t.sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"skill":{"name":"builtin-skill","description":"desc","source":"builtin","path":"/winter/skills/builtin-skill","body":"body"}}}"#)
        await select

        XCTAssertFalse(model.isSelectedSelf)
        XCTAssertFalse(model.canSave, "loaded, unmodified — not dirty either way")

        model.editedBody = "tampered body"
        model.editedDescription = "tampered desc"
        XCTAssertFalse(model.isDirty, "isDirty is gated on isSelectedSelf, not just field divergence")
        XCTAssertFalse(model.canSave, "a non-self skill must never become savable")
    }
}
