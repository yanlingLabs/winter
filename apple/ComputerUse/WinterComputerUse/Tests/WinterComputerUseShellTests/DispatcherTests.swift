import CoreGraphics
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
        let expected = Set(engineSamples.map(\.method) + ["script.active", "view.subscribe", "view.unsubscribe", "prompt.desktopVisit"])
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

    func testTheFreshnessCapturesExistOnlyOnALiveTestInstanceWithACapturer() async throws {
        let rig = await Rig()
        XCTAssertFalse(rig.dispatcher.methods.contains("test.capture"))
        XCTAssertFalse(rig.dispatcher.methods.contains("test.stream"))
        let live = await MainActor.run {
            RPCDispatcher(core: rig.core, coordinator: rig.coordinator, viewHub: rig.viewHub, inFlight: rig.inFlight, liveTest: true, capturer: FakeCapture())
        }
        XCTAssertTrue(live.methods.contains("test.capture"))
        let shot = try await live.handle(method: "test.capture", params: .object(["windowId": .number(7), "source": .string("stream"), "path": .string("/tmp/x.png")]))
        XCTAssertEqual(try JSONDecoder().decode(TestCaptureResult.self, from: JSONEncoder().encode(shot)), TestCaptureResult(width: 2, height: 1, frameAgeMs: 5))
        let on = try await live.handle(method: "test.stream", params: .object(["windowId": .number(7), "on": .bool(true)]))
        XCTAssertEqual(try JSONDecoder().decode(TestStreamResult.self, from: JSONEncoder().encode(on)), TestStreamResult(running: true))
        // A live-test instance without a capturer (the dispatcher's default) has the activation only.
        let bare = await MainActor.run { RPCDispatcher(core: rig.core, coordinator: rig.coordinator, viewHub: rig.viewHub, inFlight: rig.inFlight, liveTest: true) }
        XCTAssertFalse(bare.methods.contains("test.capture"))
    }

    func testTestCaptureWritesOnlyPNGsInsideTheHome() throws {
        // A real home under the temp dir, named the way a live run names it: `/var/…` while the helper's home is
        // its realpath `/private/var/…` — the spelling that refused every capture of the first freshness run.
        let fm = FileManager.default
        let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("cu-capture-guard-\(UUID().uuidString)")
        let other = base + "-hh"
        try fm.createDirectory(atPath: base + "/run", withIntermediateDirectories: true)
        try fm.createDirectory(atPath: other, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: base); try? fm.removeItem(atPath: other) }
        let home = try XCTUnwrap(HelperIdentity.canonicalPath(base))
        let unresolved = base.hasPrefix("/private/") ? String(base.dropFirst("/private".count)) : base
        XCTAssertEqual(TestCapture.allowedPath(unresolved + "/run/a.png", home: home), home + "/run/a.png")
        XCTAssertEqual(TestCapture.allowedPath(home + "/a.png", home: home), home + "/a.png")
        XCTAssertNil(TestCapture.allowedPath(home + "/../x.png", home: home))
        XCTAssertNil(TestCapture.allowedPath(other + "/a.png", home: home))
        XCTAssertNil(TestCapture.allowedPath(home + "/missing/a.png", home: home))
        XCTAssertNil(TestCapture.allowedPath(home + "/a.txt", home: home))
        XCTAssertNil(TestCapture.allowedPath("relative.png", home: home))
        // A symlink inside the home that points out of it: refused, as is a link planted at the file's own name.
        try fm.createSymbolicLink(atPath: home + "/out", withDestinationPath: other)
        XCTAssertNil(TestCapture.allowedPath(home + "/out/a.png", home: home))
        try fm.createSymbolicLink(atPath: home + "/run/b.png", withDestinationPath: other + "/b.png")
        XCTAssertNil(TestCapture.allowedPath(home + "/run/b.png", home: home))
    }

    func testTestCaptureCropsInWindowPoints() throws {
        let ctx = try XCTUnwrap(CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try XCTUnwrap(ctx.makeImage())
        let cropped = try XCTUnwrap(TestCapture.crop(image, rect: [2, 1, 5, 4], scale: 2))
        XCTAssertEqual(cropped.width, 10)
        XCTAssertEqual(cropped.height, 8)
        XCTAssertEqual(TestCapture.crop(image, rect: nil, scale: 2)?.width, 40)
        XCTAssertNil(TestCapture.crop(image, rect: [100, 100, 5, 5], scale: 2))
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
        XCTAssertTrue(rig.core.calls.isEmpty, "no engine RPC for it")
        // The engine is told too: its Focus Guardian runs only while a script does.
        XCTAssertEqual(rig.core.activity, ["s_1:true", "s_2:true", "s_1:false", "s_2:false"])
        _ = try await rig.dispatcher.handle(method: "session.ended", params: json(#"{"sessionId":"s_3"}"#))
        XCTAssertEqual(rig.core.activity.last, "s_3:false", "an ended session runs no script")
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

private struct FakeCapture: TestCapturing {
    func capture(_ p: TestCaptureParams) async throws -> TestCaptureResult { TestCaptureResult(width: 2, height: 1, frameAgeMs: p.source == "stream" ? 5 : nil) }
    func stream(_ p: TestStreamParams) async throws -> TestStreamResult { TestStreamResult(running: p.on) }
}

private actor ActivateLog {
    var pids: [Int32] = []
    func add(_ pid: Int32) { pids.append(pid) }
}
