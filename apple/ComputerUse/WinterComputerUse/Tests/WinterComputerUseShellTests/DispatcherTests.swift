import Foundation
import WinterComputerUseShell
import WinterCUCore
import XCTest

final class DispatcherTests: XCTestCase {
    private func encode(_ value: AnyEncodable) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    /// Every engine method: the request's params reach the engine decoded into its own `<Name>Params` (and
    /// re-encode to the same JSON), and its `<Name>Result` comes back encoded as the same JSON.
    func testEveryEngineMethodDecodesParamsStraightIntoTheEngineAndEncodesTheResultBack() async throws {
        let rig = await Rig()
        for sample in engineSamples { rig.core.results[sample.method] = json(sample.result) }
        for sample in engineSamples {
            let result = try await rig.dispatcher.handle(method: sample.method, params: json(sample.params))
            let call = try XCTUnwrap(rig.core.calls.last, sample.method)
            XCTAssertEqual(call.method, sample.method)
            XCTAssertTrue(jsonContains(call.params, json(sample.params)), "\(sample.method) params arrived as \(call.params)")
            XCTAssertTrue(jsonContains(try encode(result), json(sample.result)), "\(sample.method) result")
        }
        XCTAssertEqual(rig.core.methods(), engineSamples.map(\.method))
    }

    func testTheDispatcherAnswersExactlyTheHelperRPCMethodsBesidesHello() async {
        let rig = await Rig()
        let expected = Set(engineSamples.map(\.method) + ["script.active", "view.subscribe", "view.unsubscribe"])
        XCTAssertEqual(Set(rig.dispatcher.methods), expected)
    }

    func testTestActivateExistsOnlyOnALiveTestInstance() async throws {
        let rig = await Rig()
        XCTAssertFalse(rig.dispatcher.methods.contains("test.activate"))
        do {
            _ = try await rig.dispatcher.handle(method: "test.activate", params: .object(["pid": .number(42)]))
            XCTFail("a normal helper must not answer test.activate")
        } catch {}
        let asked = ActivateLog()
        let live = await MainActor.run {
            RPCDispatcher(core: rig.core, coordinator: rig.coordinator, viewHub: rig.viewHub, inFlight: rig.inFlight, liveTest: true,
                          activator: { pid in await asked.add(pid); return TestActivateResult(frontmostSet: true, raised: true, frontmost: true) })
        }
        XCTAssertTrue(live.methods.contains("test.activate"))
        let result = try await live.handle(method: "test.activate", params: .object(["pid": .number(42)]))
        XCTAssertEqual(try JSONDecoder().decode(TestActivateResult.self, from: JSONEncoder().encode(result)), TestActivateResult(frontmostSet: true, raised: true, frontmost: true))
        let pids = await asked.pids
        XCTAssertEqual(pids, [42])
    }

    func testAnUnknownMethodIsUnsupported() async {
        let rig = await Rig()
        do {
            _ = try await rig.dispatcher.handle(method: "target.teleport", params: nil)
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(RPCError.from(error).code, "unsupported")
        }
        XCTAssertTrue(rig.core.calls.isEmpty)
    }

    func testMissingOrMistypedParamsAreInvalidParamsNamingTheField() async {
        let rig = await Rig()
        do {
            _ = try await rig.dispatcher.handle(method: "target.bind", params: json(#"{"sessionId":"s_1","mirror":true}"#))
            XCTFail("expected an error")
        } catch {
            let e = RPCError.from(error)
            XCTAssertEqual(e.code, "invalid_params")
            XCTAssertTrue(e.message.contains("params.app"), e.message)
        }
        do {
            _ = try await rig.dispatcher.handle(method: "target.waitIdle", params: json(#"{"targetId":"t1","quietMs":"soon","timeoutMs":1}"#))
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(RPCError.from(error).code, "invalid_params")
        }
        do {
            _ = try await rig.dispatcher.handle(method: "target.act", params: json(#"{"targetId":"t1","sessionId":"s","callId":"c","action":{"kind":"teleport"},"access":"full","allowForeground":false,"privatePath":true}"#))
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(RPCError.from(error).code, "invalid_params")
        }
        XCTAssertTrue(rig.core.calls.isEmpty, "nothing reaches the engine on bad params")
    }

    func testAnEngineErrorKeepsItsCodeAndData() async {
        let rig = await Rig()
        rig.core.errors["target.act"] = CUError(code: "refused", message: "Typing into a password field is refused.", data: ["reason": .string("secure_field")])
        do {
            _ = try await rig.dispatcher.handle(method: "target.act", params: json(engineSamples.first { $0.method == "target.act" }!.params))
            XCTFail("expected an error")
        } catch {
            let e = RPCError.from(error)
            XCTAssertEqual(e.code, "refused")
            XCTAssertEqual(e.message, "Typing into a password field is refused.")
            XCTAssertEqual(e.data["reason"], .string("secure_field"))
            XCTAssertEqual(e.wireData["code"], .string("refused"))
        }
    }

    func testStatusWithNoParamsReachesTheEngine() async throws {
        let rig = await Rig()
        rig.core.results["status"] = json(#"{"helperVersion":"0.124.0","permissions":{"accessibility":true,"screenRecording":false}}"#)
        let result = try encode(try await rig.dispatcher.handle(method: "status", params: nil))
        XCTAssertEqual(result, json(#"{"helperVersion":"0.124.0","permissions":{"accessibility":true,"screenRecording":false}}"#))
        XCTAssertEqual(rig.core.methods(), ["status"])
    }

    func testAPermissionKindOutsideTheTwoIsInvalidParams() async {
        let rig = await Rig()
        do {
            _ = try await rig.dispatcher.handle(method: "permissions.request", params: json(#"{"kind":"camera"}"#))
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(RPCError.from(error).code, "invalid_params")
        }
        XCTAssertTrue(rig.core.calls.isEmpty)
    }

    func testScriptActiveArmsTheEscTapWhileAnySessionRunsAScript() async throws {
        let rig = await Rig()
        _ = try await rig.dispatcher.handle(method: "script.active", params: json(#"{"sessionId":"s_1","active":true}"#))
        _ = try await rig.dispatcher.handle(method: "script.active", params: json(#"{"sessionId":"s_2","active":true}"#))
        _ = try await rig.dispatcher.handle(method: "script.active", params: json(#"{"sessionId":"s_1","active":false}"#))
        var armed = await rig.tap.armedCalls
        XCTAssertEqual(armed, [true], "one switch, flipped only when the set goes empty ↔ non-empty")
        _ = try await rig.dispatcher.handle(method: "script.active", params: json(#"{"sessionId":"s_2","active":false}"#))
        armed = await rig.tap.armedCalls
        XCTAssertEqual(armed, [true, false])
        XCTAssertTrue(rig.core.calls.isEmpty, "script.active is the shell's alone")
    }

    func testTurnEndedAndSessionEndedReachBothTheEngineAndThePresentation() async throws {
        let rig = await Rig()
        _ = try await rig.dispatcher.handle(method: "script.active", params: json(#"{"sessionId":"s_1","active":true}"#))
        _ = try await rig.dispatcher.handle(method: "turn.ended", params: json(#"{"sessionId":"s_1"}"#))
        _ = try await rig.dispatcher.handle(method: "session.ended", params: json(#"{"sessionId":"s_1"}"#))
        XCTAssertEqual(rig.core.methods(), ["turn.ended", "session.ended"])
        let calls = await rig.presentation.calls
        XCTAssertEqual(calls, [.turnEnded("s_1"), .sessionEnded("s_1")])
        let active = await rig.coordinator.activeScripts
        XCTAssertTrue(active.isEmpty, "an ended session no longer holds the Esc tap")
        let armed = await rig.tap.armedCalls
        XCTAssertEqual(armed, [true, false])
    }

    /// The engine's observed reason reaches the daemon in `data.reason` (PROTOCOL.md §5).
    func testATargetLostErrorCarriesItsReasonOnTheWire() async throws {
        let rig = await Rig()
        rig.core.errors["target.find"] = CUError.targetLost("the Notes window was closed", reason: .windowClosed)
        do {
            _ = try await rig.dispatcher.handle(method: "target.find", params: json(#"{"targetId":"t1","query":"Share"}"#))
            XCTFail("expected target_lost")
        } catch {
            let e = RPCError.from(error)
            XCTAssertEqual(e.code, "target_lost")
            XCTAssertEqual(e.data["reason"], .string("window_closed"))
        }
    }

    func testSessionEndedCleansTheShellsStateEvenWhenTheEngineFails() async throws {
        let rig = await Rig()
        rig.core.errors["session.ended"] = CUError(code: "busy", message: "later")
        _ = try await rig.dispatcher.handle(method: "script.active", params: json(#"{"sessionId":"s_1","active":true}"#))
        do {
            _ = try await rig.dispatcher.handle(method: "session.ended", params: json(#"{"sessionId":"s_1"}"#))
            XCTFail("expected the engine's error")
        } catch {
            XCTAssertEqual(RPCError.from(error).code, "busy")
        }
        let active = await rig.coordinator.activeScripts
        XCTAssertTrue(active.isEmpty)
    }
}

private actor ActivateLog {
    var pids: [Int32] = []
    func add(_ pid: Int32) { pids.append(pid) }
}
