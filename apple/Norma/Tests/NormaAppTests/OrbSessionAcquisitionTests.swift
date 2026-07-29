import XCTest
import NormaProtocol
import NormaKit
@testable import Norma

/// orb-regressions (2026-07-29): the two USER-REPORTED live regressions, pinned end-to-end through
/// the wiring `AppDelegate.boot()` actually installs.
///
///   1. "enter is not working in the orb and on the orb expanded mode (enter to send the message)"
///   2. "i cant detach the expanded orb window anymore"
///
/// ROOT CAUSE (one, for both): `NormaClient.request(_:params:)` OMITTED the `params` key entirely
/// when the caller passed `nil`, and `dispatchSession()` is one of five wrappers that do. The
/// daemon validates `session.dispatch` with `parseParams(SessionDispatchParams, params)` where
/// `SessionDispatchParams = z.object({})` — and `z.object({}).safeParse(undefined)` FAILS, so the
/// RPC came back `-32602 invalid params: (root)`. Verified against the live dev daemon: the exact
/// bytes `{"jsonrpc":"2.0","id":2,"method":"session.dispatch"}` are refused, while the same frame
/// with `"params":{}` returns the singleton.
///
/// The throw made `AppModel.ensureFocusedSession()` return `nil`, so:
///   - `sendOrSteer` returned `false` before ever reaching `session.send` — Enter silently did
///     nothing, in BOTH the field and the morph ("expanded") window (they share one adapter and one
///     `OrbWindowController.onSubmit` seam);
///   - `focusedSessionId` stayed `nil` forever, so `AppDelegate.handleWindowDetach` hit its "no
///     focused session" bail and returned `false` — `requestWindowDetach()` gates the exit-to-orb
///     on that return, so the yellow light did nothing either.
///
/// WHY IT SURFACED NOW (latent since Phase 7, `0795a237`): `ensureFocusedSession()` early-outs when
/// a session is already focused, and `focusNewestSession()` (connect-time) attaches to the newest
/// EXISTING dispatch session. `~/.norma` has had one since 2026-07-20, so `dispatchSession()` was
/// never actually invoked there. The dev/dist split's second strand (`04961ee0`/`70737ad1`, merged
/// `ed9c706b`) repointed the Debug app at a FRESH `~/.norma-dev` with no dispatch session — the
/// first Norma home to ever exercise the create path from the Mac app.
///
/// These tests script the DAEMON'S REAL CONTRACT (`respond` below refuses a params-less
/// `session.dispatch` exactly as the server does) rather than asserting on wire bytes, so they fail
/// for the same reason the live app did, and would have passed at `4c0202bb` only because that
/// build never reached this code path — the fix is what makes them meaningful in either build.
@MainActor
final class OrbSessionAcquisitionTests: XCTestCase {
    /// Answers frames the way the real daemon does, including `session.dispatch`'s params
    /// validation. Runs until cancelled; every method the orb's acquisition path can emit is
    /// covered, and `session.list` is answered wherever it lands (the directory's own unawaited
    /// refresh interleaves at unpredictable wire positions — `waitUntilMethod`'s own rationale).
    private func startDaemonDouble(
        _ t: AppScriptedTransport,
        sessions: String = "[]",
        dispatchSessionId: String = "s_disp"
    ) -> Task<Void, Never> {
        Task { @MainActor in
            var answered = 0
            while !Task.isCancelled {
                let pending = t.sent
                while answered < pending.count {
                    let req = lineJSON(pending[answered])
                    answered += 1
                    guard let id = req["id"] as? Int, let method = req["method"] as? String else { continue }
                    switch method {
                    case "protocol.hello":
                        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"ok":true}}"#)
                    case "session.list":
                        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"sessions":\#(sessions)}}"#)
                    case "session.dispatch":
                        // THE CONTRACT UNDER TEST — `parseParams(z.object({}), undefined)` fails.
                        if req["params"] as? [String: Any] == nil {
                            t.feed(#"{"jsonrpc":"2.0","id":\#(id),"error":{"code":-32602,"message":"invalid params: (root)"}}"#)
                        } else {
                            t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"sessionId":"\#(dispatchSessionId)","created":true}}"#)
                        }
                    case "session.attach":
                        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"ok":true,"lastSeq":0}}"#)
                    case "session.send":
                        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{"seq":1}}"#)
                    default:
                        t.feed(#"{"jsonrpc":"2.0","id":\#(id),"result":{}}"#)
                    }
                }
                try? await Task.sleep(nanoseconds: 10_000_000)
            }
        }
    }

    private func waitUntilSent(_ t: AppScriptedTransport, _ n: Int) async {
        let deadline = Date().addingTimeInterval(3)
        while t.sent.count < n && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func methodsSent(_ t: AppScriptedTransport) -> [String] {
        t.sent.compactMap { lineJSON($0)["method"] as? String }
    }

    /// REGRESSION 1 — Enter. A Norma home with NO dispatch session yet (the dev home's exact state):
    /// the orb's submit seam must mint/attach the dispatch singleton and actually send.
    func testOrbSubmitAcquiresTheDispatchSessionAndSendsWhenNoneIsFocusedYet() async throws {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot(), "boot() wires orbController/onSubmit even in the degraded unit-test path")

        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]
        let daemon = startDaemonDouble(t)
        defer { daemon.cancel() }

        await waitUntil { model.session.state.status == .idle }
        XCTAssertNil(model.focusedSessionId, "no dispatch session exists in this home yet")

        delegate.setAppModelForTesting(model)

        let ok = await delegate.orbController?.onSubmit?("hey")
        XCTAssertEqual(
            ok, true,
            "Enter in the orb must reach session.send — a refused session.dispatch made sendOrSteer return false and the keystroke silently vanish"
        )
        XCTAssertEqual(model.focusedSessionId, "s_disp", "the freshly minted dispatch singleton must become the orb's focus")
        XCTAssertTrue(methodsSent(t).contains("session.send"), "no session.send on the wire: \(t.sent)")
    }

    /// REGRESSION 2 — the yellow light. Detach reads `focusedSessionId`; with acquisition broken it
    /// was permanently `nil`, so `handleWindowDetach` returned `false` and `requestWindowDetach()`
    /// never exited window mode. Proven through the SAME first-submit sequence the user performs.
    func testYellowLightDetachSpawnsAWindowAfterTheFirstOrbSubmit() async throws {
        let delegate = AppDelegate()
        XCTAssertTrue(delegate.boot())

        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]
        let daemon = startDaemonDouble(t)
        defer { daemon.cancel() }

        await waitUntil { model.session.state.status == .idle }
        delegate.setAppModelForTesting(model)
        defer { delegate.detachedWindows.forEach { $0.close() } }

        _ = await delegate.orbController?.onSubmit?("hey")

        let spawned = delegate.orbController?.onWindowDetach?(NSRect(x: 0, y: 0, width: 560, height: 640))
        XCTAssertEqual(
            spawned, true,
            "the yellow light must spawn a detached window — it bails (false, window surface kept) whenever focusedSessionId is nil"
        )
        await waitUntil { !delegate.detachedWindows.isEmpty }
        XCTAssertEqual(delegate.detachedWindows.first?.sessionId, "s_disp")
    }

    /// CONTROL: the pre-existing path stays untouched — a home that ALREADY has a dispatch session
    /// focuses it at connect and never calls `session.dispatch` at all. This is exactly why the
    /// defect stayed invisible on `~/.norma` for nine days.
    func testAnExistingDispatchSessionIsStillFocusedAtConnectWithoutCallingDispatch() async throws {
        let factory = RecordingTransportFactory()
        let model = AppModel(makeTransport: { factory.make() }, token: "tok")
        let startTask = Task { await model.start() }
        defer { startTask.cancel(); model.stop() }

        await waitUntil { !factory.made.isEmpty }
        let t = factory.made[0]
        let daemon = startDaemonDouble(
            t, sessions: #"[{"sessionId":"s_existing","scope":"global","createdAt":1,"lastSeq":0,"mode":"dispatch"}]"#
        )
        defer { daemon.cancel() }

        await waitUntil { model.focusedSessionId == "s_existing" }
        XCTAssertEqual(model.focusedSessionId, "s_existing")

        let sent = await model.sendOrSteer("hey")
        XCTAssertTrue(sent)
        await waitUntilSent(t, 4)
        XCTAssertFalse(methodsSent(t).contains("session.dispatch"), "ensureFocusedSession must early-out on an existing focus: \(t.sent)")
    }
}
