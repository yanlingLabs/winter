import Darwin
import Foundation
import WinterComputerUseShell
import WinterCUCore
import XCTest

/// The real server on a real socket in a temp home: the handshake, the peer check's effect on the wire,
/// framing limits, cancellation, and what a closed connection leaves behind. The peer check is a fake here
/// (`FakeAuthenticator`) except where a test says otherwise; nothing touches `~/.winter*`.
final class ServerHandshakeTests: XCTestCase {
    private var home = ""
    private var server: HelperServer?

    override func setUpWithError() throws {
        home = try makeTempHome()
    }

    override func tearDownWithError() throws {
        server?.stop()
        server = nil
        try? FileManager.default.removeItem(atPath: home)
    }

    private var socketPath: String { home + "/run/computer-use.sock" }

    private func start(_ rig: Rig, auth: PeerAuthenticator = FakeAuthenticator(decision: .accept(pid: 1, clients: [.daemon, .app])), maxInFlight: Int = 64) async throws {
        let server = HelperServer(
            configuration: .init(socketPath: socketPath, home: home, helperVersion: "9.876.5",
                                 maxInFlightPerConnection: maxInFlight, socketCheckInterval: 0),
            authenticator: auth, dispatcher: rig.dispatcher, coordinator: rig.coordinator, inFlight: rig.inFlight, log: .silent)
        await MainActor.run {
            rig.coordinator.notify = { [weak server] in server?.broadcast($0) }
            rig.viewHub.sendEvent = { [weak server] connection, line in server?.sendEvent(to: connection, line) }
            rig.viewHub.sendFrame = { [weak server] connection, key, line in server?.sendFrame(to: connection, key: key, line) }
        }
        try server.start()
        self.server = server
    }

    private func eventually(_ timeout: TimeInterval = 5, _ condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return await condition()
    }

    func testHelloAnswersProtocolVersionAndPidAndTheSocketIsPrivate() async throws {
        let rig = await Rig()
        try await start(rig)
        var st = stat()
        XCTAssertEqual(lstat(socketPath, &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o600, "the socket is 0600")
        XCTAssertEqual(lstat(home + "/run", &st), 0)
        XCTAssertEqual(st.st_mode & 0o777, 0o700)

        let client = try LineClient(path: socketPath)
        let reply = try XCTUnwrap(client.hello(home: home))
        XCTAssertEqual(reply["result"], .object(["protocol": .number(1), "helperVersion": .string("9.876.5"), "pid": .number(Double(getpid()))]))

        rig.core.results["status"] = json(#"{"helperVersion":"9.876.5","permissions":{"accessibility":false,"screenRecording":false}}"#)
        client.send(id: 2, method: "status")
        XCTAssertEqual(client.response(id: 2)?["result"]?["helperVersion"], .string("9.876.5"))

        rig.core.results["apps.list"] = json(#"{"apps":[{"name":"Notes","bundleId":"com.apple.Notes","running":false}]}"#)
        client.send(id: 3, method: "apps.list")
        XCTAssertEqual(client.response(id: 3)?["result"], json(#"{"apps":[{"name":"Notes","bundleId":"com.apple.Notes","running":false}]}"#))

        client.send(id: 4, method: "hello", params: "{\"protocol\":1,\"client\":\"daemon\",\"home\":\"\(home)\"}")
        XCTAssertEqual(client.response(id: 4)?["error"]?["data"]?["code"], .string("invalid_params"), "a second hello is refused, the connection stays")
        client.send(id: 5, method: "nope.never")
        XCTAssertEqual(client.response(id: 5)?["error"]?["data"]?["code"], .string("unsupported"))
    }

    func testHelloComparesHomesCanonically() async throws {
        let rig = await Rig()
        try await start(rig)
        let viaLink = home + "-link"
        try FileManager.default.createSymbolicLink(atPath: viaLink, withDestinationPath: home)
        defer { try? FileManager.default.removeItem(atPath: viaLink) }
        let client = try LineClient(path: socketPath)
        XCTAssertNotNil(client.hello(home: viaLink)?["result"])
    }

    func testAProtocolMismatchIsAnsweredAndTheConnectionClosed() async throws {
        let rig = await Rig()
        try await start(rig)
        let client = try LineClient(path: socketPath)
        client.send(id: 1, method: "hello", params: "{\"protocol\":2,\"client\":\"daemon\",\"home\":\"\(home)\"}")
        let reply = try XCTUnwrap(client.response(id: 1))
        XCTAssertEqual(reply["error"]?["data"]?["code"], .string("protocol_mismatch"))
        XCTAssertEqual(reply["error"]?["data"]?["expected"], .number(1))
        XCTAssertEqual(reply["error"]?["data"]?["helperVersion"], .string("9.876.5"), "so the client can say which side is out of date")
        XCTAssertTrue(client.closedWithoutData())
    }

    func testAnOlderClientIsToldTheHelpersProtocolToo() async throws {
        let rig = await Rig()
        try await start(rig)
        let client = try LineClient(path: socketPath)
        client.send(id: 1, method: "hello", params: "{\"protocol\":0,\"client\":\"app\",\"home\":\"\(home)\"}")
        let reply = try XCTUnwrap(client.response(id: 1))
        XCTAssertEqual(reply["error"]?["data"]?["code"], .string("protocol_mismatch"))
        XCTAssertEqual(reply["error"]?["data"]?["expected"], .number(Double(RPCWire.protocolVersion)))
        XCTAssertTrue(client.closedWithoutData())
    }

    func testAHomeMismatchIsAnsweredAndTheConnectionClosed() async throws {
        let rig = await Rig()
        try await start(rig)
        let client = try LineClient(path: socketPath)
        let reply = try XCTUnwrap(client.hello(home: "/tmp"))
        XCTAssertEqual(reply["error"]?["data"]?["code"], .string("home_mismatch"))
        XCTAssertTrue(client.closedWithoutData())
    }

    func testTheFirstRequestMustBeHello() async throws {
        let rig = await Rig()
        try await start(rig)
        let client = try LineClient(path: socketPath)
        client.send(id: 1, method: "apps.list")
        XCTAssertEqual(client.response(id: 1)?["error"]?["data"]?["code"], .string("protocol_mismatch"))
        XCTAssertTrue(client.closedWithoutData())
        XCTAssertTrue(rig.core.calls.isEmpty)

        let garbled = try LineClient(path: socketPath)
        garbled.sendRaw("this is not json\n")
        XCTAssertEqual(garbled.readLine()?["error"]?["data"]?["code"], .string("invalid_params"))
        XCTAssertTrue(garbled.closedWithoutData())
    }

    func testARejectedPeerIsClosedWithNoResponseAtAll() async throws {
        let rig = await Rig()
        try await start(rig, auth: FakeAuthenticator(decision: .reject(reason: "not the daemon")))
        let client = try LineClient(path: socketPath)
        client.send(id: 1, method: "hello", params: "{\"protocol\":1,\"client\":\"daemon\",\"home\":\"\(home)\"}")
        XCTAssertTrue(client.closedWithoutData())
        let open = await rig.coordinator.openConnections
        XCTAssertTrue(open.isEmpty, "a refused peer is never a connection")
    }

    func testTheRealPeerCheckGuardsTheSocket() async throws {
        // This test process is the peer. `always` admits it; the dev daemon's requirement does not.
        let rig = await Rig()
        try await start(rig, auth: try CodeSigningPeerAuthenticator(requirement: "always"))
        let admitted = try LineClient(path: socketPath)
        XCTAssertNotNil(admitted.hello(home: home)?["result"])
        server?.stop()

        let other = await Rig()
        try await start(other, auth: try CodeSigningPeerAuthenticator(requirement: WinterCodeIdentity.requirement(identifier: WinterCodeIdentity.devDaemonIdentifier)))
        let refused = try LineClient(path: socketPath)
        refused.send(id: 1, method: "hello", params: "{\"protocol\":1,\"client\":\"daemon\",\"home\":\"\(home)\"}")
        XCTAssertTrue(refused.closedWithoutData())
    }

    func testARequestLineOverOneMiBClosesTheConnection() async throws {
        let rig = await Rig()
        try await start(rig)
        let client = try LineClient(path: socketPath)
        XCTAssertNotNil(client.hello(home: home)?["result"])
        let huge = String(repeating: "a", count: RPCWire.maxRequestLineBytes + 10)
        client.sendRaw("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"target.bind\",\"params\":{\"app\":\"\(huge)\"}}\n")
        let reply = client.readLine()
        XCTAssertEqual(reply?["error"]?["data"]?["code"], .string("invalid_params"))
        XCTAssertTrue(client.closedWithoutData())
        XCTAssertTrue(rig.core.calls.isEmpty)
    }

    func testCancelAnswersTheCallCancelledAndStopsTheEnginesWork() async throws {
        let rig = await Rig()
        rig.core.blocking = ["target.act"]
        try await start(rig)
        let client = try LineClient(path: socketPath)
        XCTAssertNotNil(client.hello(home: home)?["result"])
        let act = engineSamples.first { $0.method == "target.act" }!.params // callId "c1"
        client.send(id: 7, method: "target.act", params: act)
        let started = await eventually { rig.core.methods().contains("target.act") }
        XCTAssertTrue(started)
        client.send(id: 8, method: "cancel", params: #"{"callId":"c1"}"#)
        var answers: [Double: JSONValue] = [:]
        while answers.count < 2, let line = client.readLine() {
            if case .number(let id) = line["id"] { answers[id] = line }
        }
        XCTAssertEqual(answers[7]?["error"]?["data"]?["code"], .string("cancelled"))
        XCTAssertEqual(answers[8]?["result"], .object([:]))
        XCTAssertTrue(rig.core.methods().contains("cancel"), "the engine is told too")
        let stopped = await eventually { rig.core.cancelledCalls.value == 1 }
        XCTAssertTrue(stopped, "the blocked engine call saw its cancellation")
        XCTAssertNil(client.readLine(timeout: 0.3), "no late second answer for the cancelled call")
    }

    func testAWaitCarryingACallIdIsCancellableToo() async throws {
        let rig = await Rig()
        rig.core.blocking = ["target.waitFor"]
        try await start(rig)
        let client = try LineClient(path: socketPath)
        XCTAssertNotNil(client.hello(home: home)?["result"])
        client.send(id: 2, method: "target.waitFor", params: #"{"targetId":"t1","cond":{"text":"Saved"},"timeoutMs":10000,"callId":"c9"}"#)
        _ = await eventually { rig.core.methods().contains("target.waitFor") }
        XCTAssertEqual(rig.core.calls.first { $0.method == "target.waitFor" }?.params["callId"], .string("c9"), "the callId reaches the engine")
        client.send(id: 3, method: "cancel", params: #"{"callId":"c9"}"#)
        XCTAssertEqual(client.response(id: 2)?["error"]?["data"]?["code"], .string("cancelled"))
    }

    func testTooManyRequestsInFlightAreBusyAndRetryable() async throws {
        let rig = await Rig()
        rig.core.blocking = ["target.waitIdle"]
        try await start(rig, maxInFlight: 1)
        let client = try LineClient(path: socketPath)
        XCTAssertNotNil(client.hello(home: home)?["result"])
        client.send(id: 2, method: "target.waitIdle", params: #"{"targetId":"t1","quietMs":150,"timeoutMs":3000}"#)
        _ = await eventually { rig.core.methods().contains("target.waitIdle") }
        client.send(id: 3, method: "target.waitIdle", params: #"{"targetId":"t1","quietMs":150,"timeoutMs":3000}"#)
        let busy = try XCTUnwrap(client.response(id: 3))
        XCTAssertEqual(busy["error"]?["data"], json(#"{"code":"busy","retryable":true}"#))
    }

    func testEscReachesTheDaemonAsANotification() async throws {
        let rig = await Rig()
        try await start(rig)
        let client = try LineClient(path: socketPath)
        XCTAssertNotNil(client.hello(home: home)?["result"])
        client.send(id: 2, method: "script.active", params: #"{"sessionId":"s_1","active":true}"#)
        XCTAssertNotNil(client.response(id: 2)?["result"])
        await MainActor.run { rig.tap.onEscape?() }
        let note = try XCTUnwrap(client.readLine())
        XCTAssertEqual(note, json(#"{"jsonrpc":"2.0","method":"escPressed","params":{"sessionIds":["s_1"]}}"#))
    }

    func testAClosedConnectionEndsTheSessionsItUsed() async throws {
        let rig = await Rig()
        rig.core.results["target.bind"] = json(engineSamples.first { $0.method == "target.bind" }!.result)
        try await start(rig)
        do {
            let client = try LineClient(path: socketPath)
            XCTAssertNotNil(client.hello(home: home)?["result"])
            client.send(id: 2, method: "target.bind", params: #"{"sessionId":"s_1","app":"Notes","mirror":true}"#)
            XCTAssertNotNil(client.response(id: 2)?["result"])
            client.send(id: 3, method: "script.active", params: #"{"sessionId":"s_2","active":true}"#)
            XCTAssertNotNil(client.response(id: 3)?["result"])
            let open = await rig.coordinator.openConnections
            XCTAssertEqual(open.count, 1)
        } // the client closes here
        let ended = await eventually {
            let sessions = rig.core.calls.filter { $0.method == "session.ended" }.compactMap { $0.params["sessionId"]?.stringValue }
            return Set(sessions) == ["s_1", "s_2"]
        }
        XCTAssertTrue(ended, "every session the connection used is ended in the engine")
        let closed = await eventually { await rig.coordinator.openConnections.isEmpty }
        XCTAssertTrue(closed)
        let active = await rig.coordinator.activeScripts
        XCTAssertTrue(active.isEmpty)
        let armed = await rig.tap.armedCalls
        XCTAssertEqual(armed, [true, false])
    }

    func testASessionSharedByTwoConnectionsSurvivesUntilTheLastCloses() async throws {
        let rig = await Rig()
        try await start(rig)
        let a = try LineClient(path: socketPath)
        XCTAssertNotNil(a.hello(home: home)?["result"])
        a.send(id: 2, method: "script.active", params: #"{"sessionId":"s_1","active":true}"#)
        XCTAssertNotNil(a.response(id: 2))
        var b: LineClient? = try LineClient(path: socketPath)
        XCTAssertNotNil(b?.hello(home: home)?["result"])
        b?.send(id: 2, method: "turn.ended", params: #"{"sessionId":"s_1"}"#)
        XCTAssertNotNil(b?.response(id: 2))
        b = nil
        let oneClosed = await eventually { await rig.coordinator.openConnections.count == 1 }
        XCTAssertTrue(oneClosed)
        XCTAssertFalse(rig.core.methods().contains("session.ended"), "connection a still uses s_1")
    }

    func testAStaleSocketFileIsReplacedButALiveHelperIsNot() async throws {
        try FileManager.default.createDirectory(atPath: home + "/run", withIntermediateDirectories: true)
        // A socket file nobody listens on: what a crashed helper leaves.
        let stale = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in for (i, b) in bytes.enumerated() { raw[i] = b } }
        _ = withUnsafePointer(to: &addr) { ptr in ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(stale, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        close(stale)

        let rig = await Rig()
        try await start(rig)
        XCTAssertNotNil(try LineClient(path: socketPath).hello(home: home)?["result"])

        let second = HelperServer(configuration: .init(socketPath: socketPath, home: home, helperVersion: "x", socketCheckInterval: 0),
                                  authenticator: FakeAuthenticator(decision: .accept(pid: 1, clients: [.daemon])), dispatcher: rig.dispatcher,
                                  coordinator: rig.coordinator, inFlight: rig.inFlight, log: .silent)
        XCTAssertThrowsError(try second.start()) { error in
            guard case HelperServerError.alreadyRunning = error else { return XCTFail("\(error)") }
        }
    }

    func testADeletedSocketFileIsBoundAgain() async throws {
        let rig = await Rig()
        try await start(rig)
        unlink(socketPath)
        XCTAssertThrowsError(try LineClient(path: socketPath))
        server?.ensureListening()
        XCTAssertNotNil(try LineClient(path: socketPath).hello(home: home)?["result"])
    }

    // MARK: Winter.app, the second client

    private func appHello(_ client: LineClient, id: Int = 1) -> JSONValue? {
        client.send(id: id, method: "hello", params: "{\"protocol\":1,\"client\":\"app\",\"home\":\"\(home)\"}")
        return client.response(id: id)
    }

    func testWinterAppMayOnlyReadStatusAndSubscribe() async throws {
        let rig = await Rig()
        rig.core.results["status"] = json(#"{"helperVersion":"9.876.5","permissions":{"accessibility":true,"screenRecording":true}}"#)
        try await start(rig)
        let app = try LineClient(path: socketPath)
        XCTAssertEqual(appHello(app)?["result"]?["pid"], .number(Double(getpid())))
        app.send(id: 2, method: "status")
        XCTAssertEqual(app.response(id: 2)?["result"]?["helperVersion"], .string("9.876.5"))
        app.send(id: 3, method: "view.subscribe", params: #"{"sessionId":"s_1","frames":true}"#)
        XCTAssertEqual(app.response(id: 3)?["result"], json(#"{"targets":[]}"#))
        for (n, method) in ["apps.list", "target.bind", "target.act", "script.active", "session.ended", "cancel", "permissions.request"].enumerated() {
            app.send(id: 10 + n, method: method, params: #"{"sessionId":"s_1","callId":"c"}"#)
            let reply = app.response(id: 10 + n)
            XCTAssertEqual(reply?["error"]?["data"]?["code"], .string("not_allowed"), method)
        }
        app.send(id: 30, method: "view.unsubscribe", params: #"{"sessionId":"s_1"}"#)
        XCTAssertEqual(app.response(id: 30)?["result"], .object([:]))
        XCTAssertEqual(rig.core.methods(), ["status"], "nothing but status reached the engine")
    }

    func testTheDaemonMayNotSubscribeToTheViewStream() async throws {
        let rig = await Rig()
        try await start(rig)
        let daemon = try LineClient(path: socketPath)
        XCTAssertNotNil(daemon.hello(home: home)?["result"])
        daemon.send(id: 2, method: "view.subscribe", params: #"{"sessionId":"s_1","frames":true}"#)
        XCTAssertEqual(daemon.response(id: 2)?["error"]?["data"]?["code"], .string("not_allowed"))
    }

    func testAClaimedClientTheCodeDoesNotProveIsRefusedAndClosed() async throws {
        let rig = await Rig()
        try await start(rig, auth: FakeAuthenticator(decision: .accept(pid: 1, clients: [.app])))
        let impostor = try LineClient(path: socketPath)
        let reply = impostor.hello(home: home)
        XCTAssertEqual(reply?["error"]?["data"], json(#"{"code":"not_allowed","reason":"identity"}"#), "a Winter.app peer cannot say it is the daemon")
        XCTAssertTrue(impostor.closedWithoutData())
        server?.stop()

        let other = await Rig()
        try await start(other, auth: FakeAuthenticator(decision: .accept(pid: 1, clients: [.daemon])))
        let notApp = try LineClient(path: socketPath)
        XCTAssertEqual(appHello(notApp)?["error"]?["data"]?["code"], .string("not_allowed"), "nor the daemon that it is Winter.app")
        XCTAssertTrue(notApp.closedWithoutData())
        let unknown = try LineClient(path: socketPath)
        unknown.send(id: 1, method: "hello", params: "{\"protocol\":1,\"client\":\"phone\",\"home\":\"\(home)\"}")
        XCTAssertEqual(unknown.response(id: 1)?["error"]?["data"]?["code"], .string("protocol_mismatch"))
    }

    func testTheViewStreamFansOutToTheSessionsSubscribersOnly() async throws {
        let rig = await Rig()
        rig.core.results["target.bind"] = json(#"{"targetId":"t1","app":{"name":"Notes","bundleId":"com.apple.Notes","pid":123},"window":{"id":77,"title":"Groceries","frame":[100,50,800,600]}}"#)
        try await start(rig)
        let daemon = try LineClient(path: socketPath)
        XCTAssertNotNil(daemon.hello(home: home)?["result"])
        let app = try LineClient(path: socketPath)
        XCTAssertNotNil(appHello(app)?["result"])
        app.send(id: 2, method: "view.subscribe", params: #"{"sessionId":"s_1","frames":false}"#)
        XCTAssertNotNil(app.response(id: 2)?["result"])
        let other = try LineClient(path: socketPath)
        XCTAssertNotNil(appHello(other)?["result"])
        other.send(id: 2, method: "view.subscribe", params: #"{"sessionId":"s_2","frames":true}"#)
        XCTAssertNotNil(other.response(id: 2)?["result"])

        daemon.send(id: 2, method: "target.bind", params: #"{"sessionId":"s_1","app":"Notes","mirror":true}"#)
        XCTAssertNotNil(daemon.response(id: 2)?["result"])
        XCTAssertEqual(app.readLine(), json(#"{"jsonrpc":"2.0","method":"view.bound","params":{"sessionId":"s_1","targetId":"t1","pid":123,"windowId":77,"appName":"Notes","bundleId":"com.apple.Notes","windowSize":[800,600]}}"#))

        await MainActor.run {
            rig.geometry.frames[77] = CGRect(x: 110, y: 60, width: 800, height: 600) // the window moved since the bind
            rig.coordinator.actionAt(sessionId: "s_1", pid: 123, windowID: 77, point: CGPoint(x: 210, y: 160), kind: "press",
                                     dragTo: nil, frame: nil, text: nil, count: 1, button: "left")
        }
        XCTAssertEqual(app.readLine()?["params"], json(#"{"sessionId":"s_1","targetId":"t1","kind":"press","point":[100,100],"count":1,"button":"left"}"#))

        await MainActor.run { rig.tap.onEscape?() } // no script active: nothing; and never to Winter.app anyway
        daemon.send(id: 3, method: "script.active", params: #"{"sessionId":"s_1","active":true}"#)
        XCTAssertNotNil(daemon.response(id: 3))
        await MainActor.run { rig.tap.onEscape?() }
        XCTAssertEqual(daemon.readLine()?["method"], .string("escPressed"))

        daemon.send(id: 4, method: "target.release", params: #"{"targetId":"t1"}"#)
        XCTAssertNotNil(daemon.response(id: 4)?["result"])
        XCTAssertEqual(app.readLine()?["params"], json(#"{"sessionId":"s_1","targetId":"t1"}"#))
        XCTAssertNil(app.readLine(timeout: 0.3), "no escPressed, no second release for Winter.app")
        XCTAssertNil(other.readLine(timeout: 0.3), "a subscriber of another session hears nothing")
    }

    func testWinterAppNeitherOwnsNorEndsASession() async throws {
        let rig = await Rig()
        rig.core.results["target.bind"] = json(engineSamples.first { $0.method == "target.bind" }!.result)
        try await start(rig)
        var daemon: LineClient? = try LineClient(path: socketPath)
        XCTAssertNotNil(daemon?.hello(home: home)?["result"])
        daemon?.send(id: 2, method: "target.bind", params: #"{"sessionId":"s_1","app":"Notes","mirror":true}"#)
        XCTAssertNotNil(daemon?.response(id: 2)?["result"])
        do {
            let app = try LineClient(path: socketPath)
            XCTAssertNotNil(appHello(app)?["result"])
            app.send(id: 2, method: "view.subscribe", params: #"{"sessionId":"s_1","frames":true}"#)
            XCTAssertEqual(app.response(id: 2)?["result"]?["targets"]?.arrayCount, 1)
            let open = await rig.coordinator.openConnections
            XCTAssertEqual(open.count, 1, "Winter.app is not a daemon connection")
        } // Winter.app goes away
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(rig.core.methods().contains("session.ended"), "the app's close ends nothing")
        await MainActor.run { rig.clock.advance(by: ViewHub.stopGrace) }
        let capturing = await rig.viewHub.capturing
        XCTAssertTrue(capturing.isEmpty, "its frame subscription went with it (after the stop grace)")
        daemon = nil
        let ended = await eventually { rig.core.methods().contains("session.ended") }
        XCTAssertTrue(ended, "the daemon's close does end it")
        let targets = await rig.viewHub.targets
        XCTAssertTrue(targets.isEmpty)
    }

    func testStopRemovesTheSocketFile() async throws {
        let rig = await Rig()
        try await start(rig)
        server?.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: socketPath))
    }

    func testAMissingHomeIsNeverCreated() async throws {
        let rig = await Rig()
        try FileManager.default.removeItem(atPath: home)
        do {
            try await start(rig)
            XCTFail("started without a home")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: home))
    }
}
