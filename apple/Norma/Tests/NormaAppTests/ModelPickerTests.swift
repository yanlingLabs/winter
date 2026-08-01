import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// Task 10 (Chat Slice D): the header's model menu (`WindowContentView`'s `modelMenuButton`/
/// `modelMenuContent`, beside the existing ⋯ policy picker). Same PURE-HELPER idiom as
/// `PolicyMenuTests` — nothing here drives the live popover/Button UI (not independently unit
/// testable, see that file's own note); this covers the pure decisions behind it
/// (`modelDisplayLabel`/`sessionModelOptions`/`modelMenuIsVisible`), the adapter's in-flight
/// discipline (a STUBBED `onSetModel`, mirroring `PolicyMenuTests.testSessionPolicyUpdatesOnlyOnSuccess`),
/// `AppModel.setSessionModel`'s real wire shape (mirrors `testAppModelSetSessionPolicyWireShape`),
/// and the T1-deferred `listSessions()` → `SessionSummary.model` threading this task closes.
final class ModelPickerTests: XCTestCase {
    // MARK: - Pure decisions

    /// "model set → shown; model nil → 'default' shown" (brief's own wording for the picker's
    /// current-selection label).
    func testModelDisplayLabelShowsModelOrDefault() {
        XCTAssertEqual(modelDisplayLabel("gpt-5.6-sol"), "gpt-5.6-sol", "a set model is shown verbatim")
        XCTAssertEqual(modelDisplayLabel("gpt-5.6-luna"), "gpt-5.6-luna")
        XCTAssertEqual(modelDisplayLabel(nil), "Default", "no override shows the labeled default, not a blank/misleading value")
    }

    /// provider-correctness T6: the picker's offered slugs come from the SYNCED CATALOGUE. This test
    /// replaced one that pinned a hardcoded three-slug mirror — the mirror is gone, and with it the
    /// class of bug where a picker offers a slug it cannot prove exists.
    func testModelPickerOptionsComeFromTheCatalogue() {
        let catalogue = SyncConfigSnapshot(
            defaultModel: "srv-a",
            models: [SyncConfigModelInfo(id: "srv-a", efforts: ["low", "high"]),
                     SyncConfigModelInfo(id: "srv-b", efforts: ["high"])],
            defaultEffort: "high", clientEfforts: ["ultra"])
        XCTAssertEqual(modelPickerOptions(catalogue), ["srv-a", "srv-b"],
                       "the picker repeats what the daemon said — nothing more, in daemon order")
    }

    /// EMPTY IS A REAL ANSWER. A daemon that cannot enumerate (a BYOK endpoint), or a client that
    /// has not fetched yet, must produce NO rows — never a remembered or derived lineup. Deriving
    /// one is precisely the bug `sync.config.models` was added to kill.
    func testAnEmptyCatalogueOffersNothingRatherThanGuessing() {
        XCTAssertEqual(modelPickerOptions(.empty), [])
        XCTAssertEqual(modelPickerOptions(SyncConfigSnapshot(defaultModel: "gpt-5.6-sol", models: [],
                                                            defaultEffort: "high", clientEfforts: ["ultra"])), [],
                       "a defaultModel is NOT a catalogue — synthesizing siblings from it is the original bug")
    }

    /// THE ASYMMETRY: unlike the policy picker (hidden for chat — plan-immunity), the model menu
    /// must show for EVERY mode, chat included. A test that would fail immediately if someone
    /// "fixed" `modelMenuIsVisible` by copying the policy button's `!isChatSession` predicate.
    func testModelMenuIsVisibleRegardlessOfChatSession() {
        XCTAssertTrue(modelMenuIsVisible(isChatSession: true), "the model menu must show for chat — the deliberate asymmetry vs the policy picker")
        XCTAssertTrue(modelMenuIsVisible(isChatSession: false))
    }

    // MARK: - Adapter in-flight discipline (stubbed onSetModel, mirrors PolicyMenuTests)

    @MainActor
    func testModelChangeInFlightFlipsSynchronouslyAroundOnSetModel() async throws {
        let session = SessionModel()
        let adapter = FieldStateAdapter(session: session)
        XCTAssertFalse(adapter.modelChangeInFlight)

        var receivedModel = "unset"
        var receivedWasNil = false
        adapter.onSetModel = { [adapter] model in
            adapter.modelChangeInFlight = true
            receivedWasNil = model == nil
            receivedModel = model ?? "unset"
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 20_000_000)
                adapter.modelChangeInFlight = false
            }
        }

        adapter.onSetModel("gpt-5.6-luna")
        XCTAssertTrue(adapter.modelChangeInFlight, "must flip in-flight SYNCHRONOUSLY, before the RPC resolves")
        XCTAssertEqual(receivedModel, "gpt-5.6-luna", "selecting a model must pass that exact value through")
        XCTAssertFalse(receivedWasNil)
        await waitUntil { !adapter.modelChangeInFlight }

        adapter.onSetModel(nil)
        XCTAssertTrue(adapter.modelChangeInFlight)
        XCTAssertTrue(receivedWasNil, "selecting \"default\" must pass nil through, clearing the override")
        await waitUntil { !adapter.modelChangeInFlight }
    }

    // MARK: - AppModel → wire shape

    /// Local copy of `AppModelTests`'/`PolicyMenuTests`' scripted-transport handshake helpers — see
    /// `PolicyMenuTests`' identical copy for why each test file keeps its own instance-method
    /// versions (`AppScriptedTransport`/`lineJSON`/`waitUntil` are target-wide free/internal
    /// symbols; `answerHandshake`/`waitUntilSent` are not).
    func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertGreaterThanOrEqual(t.sent.count, n, "timed out waiting for \(n) sent lines: \(t.sent)")
    }

    func answerHandshake(_ t: AppScriptedTransport, sessions: String) async {
        await waitUntilSent(t, 1)
        let hello = lineJSON(t.sent[0])
        t.feed(#"{"jsonrpc":"2.0","id":\#(hello["id"] as! Int),"result":{"ok":true}}"#)
        await waitUntilSent(t, 2)
        let list = lineJSON(t.sent[1])
        XCTAssertEqual(list["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(list["id"] as! Int),"result":{"sessions":\#(sessions)}}"#)
    }

    /// "selecting a model sends setModel with the right value; selecting 'default' sends null" —
    /// the real wire shape, mirroring `PolicyMenuTests.testAppModelSetSessionPolicyWireShape`.
    @MainActor
    func testAppModelSetSessionModelWireShapeSendsStringThenLiteralNull() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let responded = model.setSessionModel("gpt-5.6-luna")
        await waitUntilSent(t, 4)
        let setReq = lineJSON(t.sent[3])
        XCTAssertEqual(setReq["method"] as? String, "session.setModel")
        let setParams = setReq["params"] as? [String: Any]
        XCTAssertEqual(setParams?["sessionId"] as? String, "s_1")
        XCTAssertEqual(setParams?["model"] as? String, "gpt-5.6-luna")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setReq["id"] as! Int),"result":{}}"#)
        let ok = await responded
        XCTAssertTrue(ok)

        async let respondedClear = model.setSessionModel(nil)
        await waitUntilSent(t, 5)
        let clearReq = lineJSON(t.sent[4])
        XCTAssertEqual(clearReq["method"] as? String, "session.setModel")
        XCTAssertTrue(
            (clearReq["params"] as? [String: Any])?["model"] is NSNull,
            "selecting \"default\" must send a literal JSON null, not an omitted key"
        )
        t.feed(#"{"jsonrpc":"2.0","id":\#(clearReq["id"] as! Int),"result":{}}"#)
        let okClear = await respondedClear
        XCTAssertTrue(okClear)
    }

    /// No focused session yet: `setSessionModel` must fail closed (false), never crash / send with
    /// an empty sessionId — mirrors `PolicyMenuTests.testAppModelSetSessionPolicyFailsWithoutFocusedSession`.
    @MainActor
    func testAppModelSetSessionModelFailsWithoutFocusedSession() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let ok = await model.setSessionModel("gpt-5.6-sol")
        XCTAssertFalse(ok)
        XCTAssertTrue(t.sent.isEmpty, "no RPC should go out with no focused session")
    }

    // MARK: - T1 deferred item, closed: listSessions() → SessionSummary.model, end to end

    /// Proves `model` genuinely threads from the wire through `NormaKit.listSessions()` into
    /// `AppModel.directory.rows` — not merely decoded and dropped. Mirrors
    /// `PolicyMenuTests.testOrbUpdateIsChatSessionTracksARealDirectoryRoundTrip`'s "real scripted
    /// round trip, not a hand-fed array" posture, EXCEPT the directory's own boot-time
    /// `startInitialLoad()` reliably races transport-not-yet-connected in a headless test (its
    /// `listSessions()` throws "not connected" immediately, `refresh()`'s `try?` swallows it, and
    /// nothing else retries — the real app's `SessionSidebar.task` is what normally re-triggers
    /// it, and nothing here mounts one). So this drives `directory.refresh()` EXPLICITLY, once the
    /// boot handshake has fully settled, and answers THAT specific `session.list` call.
    @MainActor
    func testAppModelDirectoryThreadsModelFromSessionList() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let refreshed: Void = model.directory.refresh()
        await waitUntilSent(t, 4)
        let listReq = lineJSON(t.sent[3])
        XCTAssertEqual(listReq["method"] as? String, "session.list")
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"sessions":[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch","model":"gpt-5.6-luna"},{"sessionId":"s_2","scope":"global","createdAt":2,"lastSeq":0,"mode":"dispatch"}]}}"#)
        await refreshed

        XCTAssertEqual(model.directory.rows.first { $0.sessionId == "s_1" }?.model, "gpt-5.6-luna")
        XCTAssertNil(model.directory.rows.first { $0.sessionId == "s_2" }?.model, "absent on the wire threads through as nil")
    }

    // MARK: - provider-correctness T6: the effort picker

    /// THE MODE SCOPING, pinned as a test rather than a comment (the brief's own requirement).
    /// `sync.config` advertises `clientEfforts` UNCONDITIONALLY — it cannot know which session a
    /// picker is for — so refusing to offer a tier outside a code session is THIS CLIENT's
    /// obligation. `session.setEffort` refuses one for chat/dispatch, so offering it there would
    /// render rows whose every tap comes back an RPC error.
    func testEffortTiersAreOfferedOnCodeSessionsOnly() {
        XCTAssertTrue(effortTiersAreOffered(mode: "code"))
        XCTAssertTrue(effortTiersAreOffered(mode: nil), "an absent mode IS code — the store-wide convention")
        XCTAssertFalse(effortTiersAreOffered(mode: "chat"))
        XCTAssertFalse(effortTiersAreOffered(mode: "dispatch"))
        XCTAssertFalse(effortTiersAreOffered(mode: "some-future-mode"),
                       "an ALLOWLIST — a mode nobody has written yet gets no tiers for free")
    }

    /// The two sections stay two sections, and the tier section is scoped by mode.
    func testEffortPickerOffersWireLevelsPlusTiersOnlyForCode() {
        let catalogue = SyncConfigSnapshot(
            defaultModel: "srv-a",
            models: [SyncConfigModelInfo(id: "srv-a", efforts: ["none", "low", "high"]),
                     SyncConfigModelInfo(id: "srv-b", efforts: ["high", "max"])],
            defaultEffort: "high", clientEfforts: ["ultra"])

        let code = effortPickerOptions(catalogue: catalogue, model: "srv-b", mode: "code")
        XCTAssertEqual(code.wire, ["high", "max"], "per-model levels, for THIS session's model")
        XCTAssertEqual(code.tiers, ["ultra"])

        let chat = effortPickerOptions(catalogue: catalogue, model: "srv-b", mode: "chat")
        XCTAssertEqual(chat.wire, ["high", "max"], "chat still picks its wire effort — setEffort is mode-agnostic")
        XCTAssertEqual(chat.tiers, [], "…but never a tier")

        // No per-session model override → the daemon's live default decides the level list.
        XCTAssertEqual(effortPickerOptions(catalogue: catalogue, model: nil, mode: "code").wire,
                       ["none", "low", "high"])
        // A model the catalogue does not list contributes NO levels — "not told", not "none exist".
        XCTAssertEqual(effortPickerOptions(catalogue: catalogue, model: "unheard-of", mode: "code").wire, [])
    }

    /// A CURRENT selection may be a TIER reported verbatim (`SessionListResult.effort`'s own rule),
    /// so a picker matching only against the model's `efforts` array shows no checkmark at all.
    func testCurrentSelectionIsMatchedAgainstBOTHLists() {
        let wire = ["none", "low", "high"]
        let tiers = ["ultra"]
        XCTAssertEqual(selectionOrigin("high", wire: wire, tiers: tiers), .wire)
        XCTAssertEqual(selectionOrigin("ultra", wire: wire, tiers: tiers), .tier,
                       "a tier is a real, current selection — matching the wire list alone misses it")
        XCTAssertEqual(selectionOrigin(nil, wire: wire, tiers: tiers), .none)
        XCTAssertEqual(selectionOrigin("minimal", wire: wire, tiers: tiers), .unknown,
                       "a stale value gets its own row — a selection you cannot see is one you cannot clear")
        XCTAssertTrue(selectionIsCurrent("ultra", current: "ultra"))
        XCTAssertFalse(selectionIsCurrent("max", current: "ultra"),
                       "the STORED value is the selection, never its wire translation")
    }

    func testEffortDisplayLabelDistinguishesUnsetFromNone() {
        XCTAssertEqual(effortDisplayLabel(nil), "Default")
        XCTAssertEqual(effortDisplayLabel("none"), "none",
                       #"unset omits the reasoning block entirely; "none" is a real level"#)
        XCTAssertTrue(effortMenuIsVisible(isChatSession: true))
    }

    // MARK: - Optimistic apply + revert

    /// The overlay renders ahead of the RPC, and "optimistically cleared" is a DIFFERENT state from
    /// "no optimistic value" — which is why this is a three-case enum and not `String?`.
    func testOptimisticOverlayRendersAheadOfTheDaemonRow() {
        XCTAssertEqual(effectiveSelection(row: "srv-a", optimistic: .none), "srv-a")
        XCTAssertEqual(effectiveSelection(row: "srv-a", optimistic: .value("srv-b")), "srv-b")
        XCTAssertNil(effectiveSelection(row: "srv-a", optimistic: .clear),
                     "picking Default must READ as cleared immediately, not keep showing the old pin")
        XCTAssertNil(effectiveSelection(row: nil, optimistic: .none))
    }

    /// A REJECTED apply reverts to `.none`, which re-renders whatever the daemon still holds — it
    /// does NOT write the previous value back. Writing the fallback would sever the precedence chain
    /// (session override → daemon default) and silently pin the session past every future change.
    @MainActor
    func testARejectedApplyRevertsTheOverlayAndWritesNothing() async throws {
        let adapter = FieldStateAdapter(session: SessionModel())
        var sent: [String??] = []
        adapter.onSetModel = { model in
            sent.append(model)
            // The wirer's refusal path, verbatim: overlay back to `.none`, NO probation armed.
            adapter.pendingModel = .none
        }

        adapter.pendingModel = .value("srv-b")
        adapter.onSetModel("srv-b")
        XCTAssertEqual(adapter.pendingModel, .none, "a refusal reverts the OVERLAY…")
        XCTAssertEqual(sent.count, 1, "…and sends nothing further — no fallback write")
        XCTAssertNil(adapter.selectionProbation, "a refused selection is never put on probation")
    }

    // MARK: - The one-turn probation

    /// The rule, directly: a probation is resolved by exactly ONE turn and ends either way. The bug
    /// this replaces scanned the whole transcript, which made a model unholdable forever after a
    /// single bad turn — and survived relaunch, because a transcript is durable.
    /// A probation is armed against a session, so an adapter with no bound session is the trivial
    /// no-op case; every test below binds one.
    @MainActor
    private func boundAdapter(_ sessionId: String, session: SessionModel) -> FieldStateAdapter {
        let adapter = FieldStateAdapter(session: session)
        adapter.boundSessionId = { sessionId }
        return adapter
    }

    @MainActor
    func testProbationIsConsumedByTheTurnThatJustRanAndThenEnds() {
        let adapter = boundAdapter("s1", session: SessionModel())
        adapter.armProbation(model: .some("srv-b"))
        XCTAssertEqual(adapter.selectionProbation, SelectionProbation(sessionId: "s1", model: "srv-b", effort: nil))

        XCTAssertEqual(adapter.resolveProbation(turnError: "model 'srv-b' is not available"), .model)
        XCTAssertNil(adapter.selectionProbation, "one turn, one verdict — the probation ALWAYS ends")

        // A SECOND failing turn naming the same model must now do nothing: there is no probation.
        XCTAssertEqual(adapter.resolveProbation(turnError: "model 'srv-b' is not available"), .none,
                       "no probation ⇒ no revert — this is what stops a choice becoming unholdable")
    }

    /// A CLEAN turn also ends the probation — the selection is now simply held.
    @MainActor
    func testACleanTurnEndsTheProbationWithoutReverting() {
        let adapter = boundAdapter("s1", session: SessionModel())
        adapter.armProbation(effort: .some("xhigh"))
        XCTAssertNotNil(adapter.selectionProbation)
        XCTAssertEqual(adapter.resolveProbation(turnError: nil), .none)
        XCTAssertNil(adapter.selectionProbation)
    }

    /// I1 (review): a probation armed for session A must NEVER produce a verdict while the adapter
    /// is bound to session B. The revert goes out through `AppModel.setSessionModel/setSessionEffort`,
    /// which resolve the FOCUSED session at revert time — so acting on a mismatched probation clears
    /// B's override and leaves A's, the one actually on probation, in place.
    ///
    /// The orb reaches this state on the plain path: pick an effort on chat session A (RPC succeeds,
    /// probation armed), A is idle so no turn boundary fires, click session B in the sidebar — the
    /// orb's only session-switch hook (`OrbWindowController.updateIsChatSession`) clears nothing.
    @MainActor
    func testAProbationNeverProducesAVerdictForADifferentSession() {
        var bound = "A"
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.boundSessionId = { bound }
        adapter.armProbation(effort: .some("high"))
        XCTAssertEqual(adapter.selectionProbation?.sessionId, "A")

        bound = "B" // the sidebar switch the orb performs with no probation clear of its own
        XCTAssertEqual(adapter.resolveProbation(turnError: "model 'x' does not support reasoning effort 'high'"), .none,
                       "session B's failing turn must never clear a probation armed for session A")
        XCTAssertNil(adapter.selectionProbation, "…and the stale probation is dropped, not left to fire later")
    }

    /// The same stamp also stops a NEW arm from merging onto a stale probation from another session.
    @MainActor
    func testArmingOnANewSessionDoesNotInheritTheOldSessionsAxes() {
        var bound = "A"
        let adapter = FieldStateAdapter(session: SessionModel())
        adapter.boundSessionId = { bound }
        adapter.armProbation(model: .some("srv-a"))

        bound = "B"
        adapter.armProbation(effort: .some("high"))
        XCTAssertEqual(adapter.selectionProbation, SelectionProbation(sessionId: "B", model: nil, effort: "high"),
                       "session A's model must not ride along into session B's probation")
    }

    /// M2 (review): picking "Default" on ONE axis must disarm only THAT axis. The old flat `String?`
    /// signature made "the user picked Default" indistinguishable from "this axis is not part of
    /// this call", so touching the model menu wiped a live effort probation as a side effect.
    @MainActor
    func testPickingDefaultOnOneAxisLeavesTheOtherAxesProbationAlone() {
        let adapter = boundAdapter("s1", session: SessionModel())
        adapter.armProbation(effort: .some("xhigh"))
        adapter.armProbation(model: .some(nil)) // the user picked "Default" in the MODEL menu
        XCTAssertEqual(adapter.selectionProbation, SelectionProbation(sessionId: "s1", model: nil, effort: "xhigh"),
                       "the effort probation survives a model clear")

        // …and clearing the last live axis does end the probation entirely.
        adapter.armProbation(effort: .some(nil))
        XCTAssertNil(adapter.selectionProbation)
    }

    /// M1 (review): a selection applied MID-TURN cannot have affected the turn already running (the
    /// daemon resolves model/effort at turn start), so that turn's failure says nothing about it.
    /// The in-flight turn's boundary is consumed WITHOUT a verdict; the next one judges.
    @MainActor
    func testAProbationArmedMidTurnSkipsTheAlreadyRunningTurn() {
        let session = SessionModel()
        session.applyForTesting { $0.turnRunning = true }
        let adapter = boundAdapter("s1", session: session)
        adapter.armProbation(effort: .some("high"))
        XCTAssertEqual(adapter.selectionProbation?.skipsInFlightTurn, true)

        // The turn that was ALREADY running dies naming the new selection — not its fault.
        XCTAssertEqual(adapter.resolveProbation(turnError: "reasoning effort 'high' is not supported"), .none)
        XCTAssertNotNil(adapter.selectionProbation, "the probation survives to judge the NEXT turn")
        XCTAssertEqual(adapter.selectionProbation?.skipsInFlightTurn, false)

        // The next turn — the first that actually ran on the new selection — does produce a verdict.
        XCTAssertEqual(adapter.resolveProbation(turnError: "reasoning effort 'high' is not supported"), .effort)
        XCTAssertNil(adapter.selectionProbation)
    }

    /// The control: armed while IDLE, the very next boundary judges immediately.
    @MainActor
    func testAProbationArmedWhileIdleJudgesTheNextTurnImmediately() {
        let adapter = boundAdapter("s1", session: SessionModel())
        adapter.armProbation(effort: .some("high"))
        XCTAssertEqual(adapter.selectionProbation?.skipsInFlightTurn, false)
        XCTAssertEqual(adapter.resolveProbation(turnError: "reasoning effort 'high' is not supported"), .effort)
    }

    /// CONSERVATIVE MATCHING: a revert throws away a deliberate user choice, so the error must name
    /// BOTH the value and the axis. Set-time validation already refuses anything the daemon's own
    /// catalogue rejects, so what reaches here is narrow — and an unrelated failure that happens to
    /// contain the word "high" must not cost the user their effort setting.
    func testSelectionRevertRequiresTheErrorToNameBothValueAndAxis() {
        let p = SelectionProbation(sessionId: "s1", model: "srv-b", effort: "high")
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "unsupported_value: 'reasoning.effort' does not support 'high' with this model"), .effort)
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "the model 'srv-b' does not exist"), .model)
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "bash: exit 1 — the high-water mark file is missing"), .none,
                       "an incidental substring is not a rejection")
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "connection reset"), .none)
        XCTAssertEqual(selectionRevert(nil, turnErrorMessage: "model 'srv-b' rejected"), .none)
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: nil), .none)
        // An effort rejection quotes the model too; checking model FIRST would clear the wrong axis.
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "model 'srv-b' does not support reasoning effort 'high'"), .effort)
    }

    /// I4 (review): SUBSTRING matching silently clears a deliberate choice. `"low"` sits inside
    /// "allowed", `"high"` inside "xhigh", `"max"` inside "maximum", and `"none"` is an ordinary
    /// English word. Matching must respect word boundaries.
    func testSelectionRevertDoesNotMatchAnEffortInsideAnotherWord() {
        // The review's own example: an unrelated refusal that happens to contain "allowed".
        XCTAssertEqual(selectionRevert(SelectionProbation(sessionId: "s1", model: nil, effort: "low"),
                                       turnErrorMessage: "this model is not allowed to use reasoning"), .none,
                       #""low" inside "allowed" must not cost the user their selection"#)
        XCTAssertEqual(selectionRevert(SelectionProbation(sessionId: "s1", model: nil, effort: "max"),
                                       turnErrorMessage: "reasoning effort exceeds the maximum for this account"), .none)
        XCTAssertEqual(selectionRevert(SelectionProbation(sessionId: "s1", model: nil, effort: "none"),
                                       turnErrorMessage: "no reasoning effort was accepted; none of the retries succeeded"), .none,
                       #""none" is an ordinary English word — an incidental use is not a rejection"#)
        // The composing case: a mid-turn change from xhigh to high, where the IN-FLIGHT turn (still
        // on xhigh) errors. `"high"` must not match inside `"xhigh"` or the NEW selection is reverted.
        XCTAssertEqual(selectionRevert(SelectionProbation(sessionId: "s1", model: nil, effort: "high"),
                                       turnErrorMessage: "reasoning effort 'xhigh' is not supported"), .none)
        // …and the same boundary rule must not break the real, quoted rejections.
        XCTAssertEqual(selectionRevert(SelectionProbation(sessionId: "s1", model: nil, effort: "high"),
                                       turnErrorMessage: "reasoning effort 'high' is not supported"), .effort)
        XCTAssertEqual(selectionRevert(SelectionProbation(sessionId: "s1", model: nil, effort: "xhigh"),
                                       turnErrorMessage: "reasoning effort 'xhigh' is not supported"), .effort)
    }

    /// The model half of the same rule — a slug carries `.` and `-`, which are NOT word characters,
    /// so the boundary check has to be about adjacency rather than a naive `\b` on a regex-special
    /// string.
    func testSelectionRevertMatchesAModelSlugExactlyAndNotAsAPrefix() {
        let p = SelectionProbation(sessionId: "s1", model: "gpt-5.6-sol", effort: nil)
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "the model 'gpt-5.6-sol' does not exist"), .model)
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "unknown model gpt-5.6-sol"), .none,
                       """
                       UNQUOTED does not count. The review offered quoting OR a word-boundary regex; \
                       quoting is the stricter and the only one that survives "none", an ordinary \
                       English word with perfectly good boundaries. The bias is deliberate — a false \
                       negative means no auto-revert (passive), a false positive destroys a setting \
                       the user chose on purpose.
                       """)
        XCTAssertEqual(selectionRevert(p, turnErrorMessage: "the model 'gpt-5.6-solaris' does not exist"), .none,
                       "a longer slug that merely STARTS with ours is a different model")
    }

    /// Clearing an override can never be the thing that breaks a turn, so picking "Default" arms
    /// nothing — otherwise the very next failing turn would "revert" a clear by clearing again.
    @MainActor
    func testPickingDefaultArmsNoProbation() {
        let adapter = boundAdapter("s1", session: SessionModel())
        adapter.armProbation(model: .some(nil))
        XCTAssertNil(adapter.selectionProbation)
    }

    // MARK: - I3: the PRODUCTION path (reducer field + turn-boundary edge detector)

    /// I3 (review): `OrbSessionState.lastTurnError` and the `turnRunning` true→false edge detector
    /// in `FieldStateAdapter`'s state sink are the ENTIRE production path for turn-scoped rejection,
    /// and nothing covered either — deleting `s.lastTurnError = v.message` or
    /// `self.previousTurnRunning = newState.turnRunning` killed the whole auto-revert feature and
    /// left the suite green.
    ///
    /// This drives a REAL `SessionModel` through real `SessionEvent`s — the same shape
    /// `StoppedFlashTests` uses for the `lastTurnAborted` edge two lines above in the same sink —
    /// and asserts the revert actually fired, with `nil` (a CLEAR, never the fallback).
    @MainActor
    func testARealAgentErrorTurnEndFiresTheRevertAsAClear() {
        let session = SessionModel()
        let adapter = boundAdapter("s_1", session: session)
        var setModelCalls: [String?] = []
        var setEffortCalls: [String?] = []
        adapter.onSetModel = { setModelCalls.append($0) }
        adapter.onSetEffort = { setEffortCalls.append($0) }

        // A turn starts, then the user pins a model mid-… no: pin FIRST, while idle, so the very
        // next turn is the one under judgement (the mid-turn case has its own test above).
        adapter.armProbation(model: .some("srv-b"))
        session.apply(.turnStarted(.init(seq: 1, sessionId: "s_1", ts: 1, threadId: "main")))
        XCTAssertTrue(session.state.turnRunning)

        // The turn dies naming the pinned model — the real reducer path sets `lastTurnError`, and
        // the real edge detector resolves the probation.
        session.apply(.agentError(.init(seq: 2, sessionId: "s_1", ts: 2, threadId: "main",
                                        message: "the model 'srv-b' does not exist")))
        XCTAssertFalse(session.state.turnRunning)
        XCTAssertEqual(session.state.lastTurnError, "the model 'srv-b' does not exist")
        XCTAssertEqual(setModelCalls.count, 1, "the turn boundary must fire the revert exactly once")
        XCTAssertNil(setModelCalls.first ?? "unset",
                     "the revert CLEARS the override — it never writes the previous value back")
        XCTAssertTrue(setEffortCalls.isEmpty, "only the implicated axis is cleared")
        XCTAssertNil(adapter.selectionProbation, "…and the probation ends")
    }

    /// The control on the same real path: a CLEAN turn end fires nothing, and a CHILD thread's error
    /// is not this session's turn ending at all.
    @MainActor
    func testACleanRealTurnEndFiresNoRevert() {
        let session = SessionModel()
        let adapter = boundAdapter("s_1", session: session)
        var setModelCalls: [String?] = []
        adapter.onSetModel = { setModelCalls.append($0) }

        adapter.armProbation(model: .some("srv-b"))
        session.apply(.turnStarted(.init(seq: 1, sessionId: "s_1", ts: 1, threadId: "main")))
        // A CHILD thread erroring must not end the main turn or consume the probation.
        session.apply(.agentError(.init(seq: 2, sessionId: "s_1", ts: 2, threadId: "child-1",
                                        message: "the model 'srv-b' does not exist")))
        XCTAssertTrue(session.state.turnRunning, "a child's error is not the main turn ending")
        XCTAssertNotNil(adapter.selectionProbation)

        session.apply(.turnCompleted(.init(seq: 3, sessionId: "s_1", ts: 3, threadId: "main", stopReason: "end_turn", inputTokens: 0, outputTokens: 0)))
        XCTAssertFalse(session.state.turnRunning)
        XCTAssertNil(session.state.lastTurnError, "a clean turn clears any prior error")
        XCTAssertTrue(setModelCalls.isEmpty, "a clean turn reverts nothing")
        XCTAssertNil(adapter.selectionProbation, "…but it does end the probation — one turn, one verdict")
    }

    /// A fresh `turn_started` clears a prior turn's error, so a probation armed AFTER a failing turn
    /// is never judged by that stale message.
    @MainActor
    func testAFreshTurnClearsThePriorTurnsError() {
        let session = SessionModel()
        _ = boundAdapter("s_1", session: session)
        session.apply(.turnStarted(.init(seq: 1, sessionId: "s_1", ts: 1, threadId: "main")))
        session.apply(.agentError(.init(seq: 2, sessionId: "s_1", ts: 2, threadId: "main", message: "boom")))
        XCTAssertEqual(session.state.lastTurnError, "boom")
        session.apply(.turnStarted(.init(seq: 3, sessionId: "s_1", ts: 3, threadId: "main")))
        XCTAssertNil(session.state.lastTurnError)
    }

    // MARK: - AppModel → wire shape (the effort half)

    /// `setSessionEffort` sends a string, then a literal JSON null for "Default" — mirroring
    /// `testAppModelSetSessionModelWireShapeSendsStringThenLiteralNull` exactly.
    @MainActor
    func testAppModelSetSessionEffortWireShapeSendsStringThenLiteralNull() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let responded = model.setSessionEffort("ultra")
        await waitUntilSent(t, 4)
        let setReq = lineJSON(t.sent[3])
        XCTAssertEqual(setReq["method"] as? String, "session.setEffort")
        let setParams = setReq["params"] as? [String: Any]
        XCTAssertEqual(setParams?["sessionId"] as? String, "s_1")
        XCTAssertEqual(setParams?["effort"] as? String, "ultra",
                       "the SELECTION goes on the wire — never its translation; the daemon stores it verbatim")
        t.feed(#"{"jsonrpc":"2.0","id":\#(setReq["id"] as! Int),"result":{}}"#)
        let ok = await responded
        XCTAssertTrue(ok)

        async let respondedClear = model.setSessionEffort(nil)
        await waitUntilSent(t, 5)
        let clearReq = lineJSON(t.sent[4])
        XCTAssertTrue((clearReq["params"] as? [String: Any])?["effort"] is NSNull,
                      #"selecting "Default" must send a literal JSON null, not an omitted key"#)
        t.feed(#"{"jsonrpc":"2.0","id":\#(clearReq["id"] as! Int),"result":{}}"#)
        let okClear = await respondedClear
        XCTAssertTrue(okClear)
    }

    /// A REFUSED `session.setEffort` must be observable, not swallowed — the RED this task fixes
    /// ("a rejected setModel/setPolicy is currently a true silent no-op").
    @MainActor
    func testAppModelSetSessionEffortReportsFalseOnAnRpcRefusal() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let responded = model.setSessionEffort("minimal")
        await waitUntilSent(t, 4)
        let req = lineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"error":{"code":-32602,"message":"effort 'minimal' is not accepted by model 'srv-a' — supported: none, low, high"}}"#)
        let refused = await responded
        XCTAssertFalse(refused, "an INVALID_PARAMS refusal must come back as false, so the picker can revert")
    }

    /// `sync.config` reaches the app model — the catalogue the pickers read, over a HARNESS
    /// connection (the method is role-agnostic; NormaKit had no wrapper at all before T6).
    @MainActor
    func testAppModelFetchesTheModelCatalogue() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: "[]")

        async let fetched = model.fetchModelCatalogue()
        await waitUntilSent(t, 3)
        let req = lineJSON(t.sent[2])
        XCTAssertEqual(req["method"] as? String, "sync.config")
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":{"exaKey":null,"dangerousDomains":[],"defaultModel":"srv-a","models":[{"id":"srv-a","efforts":["low","high"]}],"defaultEffort":"high","clientEfforts":["ultra"]}}"#)
        let snapshot = await fetched
        XCTAssertEqual(snapshot?.models, [SyncConfigModelInfo(id: "srv-a", efforts: ["low", "high"])])
        XCTAssertEqual(snapshot?.clientEfforts, ["ultra"])
    }

    /// `session.list` → `SessionSummary.effort`, end to end — the effort picker's only source for
    /// "what is currently pinned", including a TIER threaded through verbatim.
    @MainActor
    func testAppModelDirectoryThreadsEffortFromSessionList() async throws {
        let t = AppScriptedTransport()
        let model = AppModel(makeTransport: { t }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }
        await answerHandshake(t, sessions: #"[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#)
        await waitUntilSent(t, 3)
        let attach = lineJSON(t.sent[2])
        t.feed(#"{"jsonrpc":"2.0","id":\#(attach["id"] as! Int),"result":{"ok":true,"lastSeq":0}}"#)
        await waitUntil { model.session.state.status == .idle }

        async let refreshed: Void = model.directory.refresh()
        await waitUntilSent(t, 4)
        let listReq = lineJSON(t.sent[3])
        t.feed(#"{"jsonrpc":"2.0","id":\#(listReq["id"] as! Int),"result":{"sessions":[{"sessionId":"s_1","scope":"global","createdAt":1,"lastSeq":0,"effort":"ultra"},{"sessionId":"s_2","scope":"global","createdAt":2,"lastSeq":0}]}}"#)
        await refreshed

        XCTAssertEqual(model.directory.rows.first { $0.sessionId == "s_1" }?.effort, "ultra")
        XCTAssertNil(model.directory.rows.first { $0.sessionId == "s_2" }?.effort, "absent = the global default")
    }
}
