import XCTest
import NormaProtocol
@testable import NormaKit

final class MethodWrapperTests: XCTestCase {
    /// Connects a client over a scripted transport, answering hello automatically.
    func connected() async throws -> (NormaClient, ScriptedTransport) {
        let t = ScriptedTransport()
        let client = NormaClient(makeTransport: { t }, token: "tok", clientName: "wrap-test")
        async let c: Void = client.connect()
        let hello = try await waitForSent(t, count: 1)[0]
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(hello)["id"] as! Int),"result":{"ok":true}}"#)
        try await c
        return (client, t)
    }

    /// Runs one wrapper call, answers with `result`, returns the outbound request object.
    func roundTrip<T>(
        _ t: ScriptedTransport, sentIndex: Int, result: String,
        _ call: @escaping () async throws -> T
    ) async throws -> (request: [String: Any], value: T) {
        async let v = call()
        let sent = try await waitForSent(t, count: sentIndex + 1)
        let req = decodeLine(sent[sentIndex])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"result":\#(result)}"#)
        return (req, try await v)
    }

    func testCreateAttachSendEncodeCorrectMethodsAndParams() async throws {
        let (client, t) = try await connected()

        let (req1, created) = try await roundTrip(t, sentIndex: 1, result: #"{"sessionId":"s_9","trusted":true}"#) {
            try await client.createSession(scope: "global", cwd: "/tmp/proj")
        }
        XCTAssertEqual(req1["method"] as? String, "session.create")
        XCTAssertEqual((req1["params"] as? [String: Any])?["scope"] as? String, "global")
        XCTAssertEqual((req1["params"] as? [String: Any])?["cwd"] as? String, "/tmp/proj")
        XCTAssertEqual(created.sessionId, "s_9")
        XCTAssertTrue(created.trusted)

        let (req2, serverLast) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"lastSeq":41}"#) {
            try await client.attach(sessionId: "s_9", fromSeq: 40)
        }
        XCTAssertEqual(req2["method"] as? String, "session.attach")
        XCTAssertEqual((req2["params"] as? [String: Any])?["fromSeq"] as? Int, 40)
        XCTAssertEqual(serverLast, 41)

        let (req3, seq) = try await roundTrip(t, sentIndex: 3, result: #"{"seq":42}"#) {
            try await client.send(sessionId: "s_9", text: "hello")
        }
        XCTAssertEqual(req3["method"] as? String, "session.send")
        XCTAssertEqual(seq, 42)
    }

    /// Chat Mode Slice A (CM-T3): `mode` is additive to `createSession` — omitted (the test above)
    /// leaves the wire params exactly as before; passed, it round-trips onto `session.create`'s
    /// `mode` field verbatim (the daemon's own `SessionCreateParams.mode` accepts "chat").
    func testCreateSessionThreadsModeThrough() async throws {
        let (client, t) = try await connected()

        let (req, created) = try await roundTrip(t, sentIndex: 1, result: #"{"sessionId":"s_chat","trusted":false}"#) {
            try await client.createSession(scope: "global", cwd: "/tmp/proj", approvalPolicy: "auto", mode: "chat")
        }
        XCTAssertEqual(req["method"] as? String, "session.create")
        XCTAssertEqual((req["params"] as? [String: Any])?["mode"] as? String, "chat")
        XCTAssertEqual(created.sessionId, "s_chat")
    }

    func testRespondersAndControls() async throws {
        let (client, t) = try await connected()
        let cases: [(String, String, () async throws -> Void)] = [
            ("approval.respond", #"{"ok":true,"alreadyResolved":false}"#, { _ = try await client.approvalRespond(sessionId: "s", callId: "c1", approved: true) }),
            ("ask_user.respond", #"{"ok":true,"alreadyResolved":false}"#, { _ = try await client.askUserRespond(sessionId: "s", callId: "c1", answers: ["Q": "A"]) }),
            ("plan.respond", #"{"ok":true,"alreadyResolved":false}"#, { _ = try await client.planRespond(sessionId: "s", callId: "c1", approved: true, autoAccept: true) }),
            ("session.setPolicy", #"{"ok":true}"#, { try await client.setPolicy(sessionId: "s", policy: "auto") }),
            ("session.steer", #"{"ok":true,"injected":true}"#, { _ = try await client.steer(sessionId: "s", text: "also do X") }),
            ("session.interrupt", #"{"ok":true,"wasRunning":true}"#, { _ = try await client.interrupt(sessionId: "s") }),
            ("daemon.trustDir", #"{"ok":true,"trusted":true}"#, { _ = try await client.trustDir(path: "/tmp/p") }),
        ]
        var idx = 1
        for (method, result, call) in cases {
            let (req, _) = try await roundTrip(t, sentIndex: idx, result: result) { try await call() }
            XCTAssertEqual(req["method"] as? String, method, "wrong wire method for \(method)")
            idx += 1
        }
    }

    /// child-transcript-view T1: `thread.send`/`agent.stop` wrappers — proves the method/param
    /// names and decodes both outcome shapes (`delivered:"queued"|"resumed"`, plus `agent.stop`'s
    /// status string), mirroring `testRespondersAndControls`'s method/param-shape-only style above
    /// (no typed outcome union here, unlike the plugin-lifecycle wrappers below — see this file's
    /// `sendToThread`/`agentStop` doc comments).
    func testThreadSendAndAgentStopWrappers() async throws {
        let (client, t) = try await connected()

        let (sendReq, queued) = try await roundTrip(t, sentIndex: 1,
            result: #"{"ok":true,"delivered":"queued","agentId":"ag_1"}"#
        ) { try await client.sendToThread(sessionId: "s_1", agent: "worker", text: "keep going") }
        XCTAssertEqual(sendReq["method"] as? String, "thread.send")
        let sendParams = sendReq["params"] as? [String: Any]
        XCTAssertEqual(sendParams?["sessionId"] as? String, "s_1")
        XCTAssertEqual(sendParams?["agent"] as? String, "worker")
        XCTAssertEqual(sendParams?["text"] as? String, "keep going")
        XCTAssertEqual(queued.delivered, "queued")
        XCTAssertEqual(queued.agentId, "ag_1")

        let (_, resumed) = try await roundTrip(t, sentIndex: 2,
            result: #"{"ok":true,"delivered":"resumed","agentId":"ag_2"}"#
        ) { try await client.sendToThread(sessionId: "s_1", agent: "ag_2", text: "one more thing") }
        XCTAssertEqual(resumed.delivered, "resumed")

        let (stopReq, stopped) = try await roundTrip(t, sentIndex: 3,
            result: #"{"ok":true,"status":"stopped"}"#
        ) { try await client.agentStop(sessionId: "s_1", agent: "worker") }
        XCTAssertEqual(stopReq["method"] as? String, "agent.stop")
        let stopParams = stopReq["params"] as? [String: Any]
        XCTAssertEqual(stopParams?["sessionId"] as? String, "s_1")
        XCTAssertEqual(stopParams?["agent"] as? String, "worker")
        XCTAssertEqual(stopped, "stopped")

        let (_, finishedStatus) = try await roundTrip(t, sentIndex: 4,
            result: #"{"ok":true,"status":"completed"}"#
        ) { try await client.agentStop(sessionId: "s_1", agent: "worker") }
        XCTAssertEqual(finishedStatus, "completed")
    }

    func testListDecoders() async throws {
        let (client, t) = try await connected()
        let (_, sessions) = try await roundTrip(t, sentIndex: 1, result: #"{"sessions":[{"sessionId":"s_1","scope":"global","createdAt":5,"lastSeq":9}]}"#) {
            try await client.listSessions()
        }
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].sessionId, "s_1")
        XCTAssertEqual(sessions[0].lastSeq, 9)

        let (_, tasks) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"tasks":[{"id":"1","subject":"do it","status":"pending"}]}"#) {
            try await client.taskList(sessionId: "s_1")
        }
        XCTAssertEqual(tasks[0].subject, "do it")
        XCTAssertNil(tasks[0].activeForm)

        let (_, threads) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true,"threads":[{"threadId":"main","status":"running"}]}"#) {
            try await client.threadList(sessionId: "s_1")
        }
        XCTAssertEqual(threads[0].threadId, "main")
        XCTAssertNil(threads[0].agentType)
    }

    func testPeripheralAndDashboardWrappers() async throws {
        let (client, t) = try await connected()
        let cases: [(String, String, () async throws -> Void)] = [
            ("peripheral.advertise", #"{"ok":true}"#, { try await client.peripheralAdvertise(classes: [(class: "noop", tccGranted: true)]) }),
            ("peripheral.revoke", #"{"ok":true}"#, { try await client.peripheralRevoke(leaseId: "lease_1", reason: "panic") }),
            ("peripheral.revoke", #"{"ok":true}"#, { try await client.peripheralRevoke(leaseId: nil, reason: "panic") }),
            ("peripheral.respond", #"{"ok":true}"#, { try await client.peripheralRespond(requestId: "req_1", resultJson: "{}", error: nil) }),
            ("hardware.respond", #"{"ok":true}"#, { try await client.hardwareRespond(requestId: "req_1", resultJson: "{\"percent\":80}", error: nil) }),
        ]
        var idx = 1
        for (method, result, call) in cases {
            let (req, _) = try await roundTrip(t, sentIndex: idx, result: result) { try await call() }
            XCTAssertEqual(req["method"] as? String, method, "wrong wire method for \(method)")
            idx += 1
        }
    }

    func testPeripheralAdvertiseAndRevokeEncodeParamsCorrectly() async throws {
        let (client, t) = try await connected()

        let (advertiseReq, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.peripheralAdvertise(classes: [(class: "screenshot", tccGranted: true), (class: "noop", tccGranted: false)])
        }
        let advertiseClasses = (advertiseReq["params"] as? [String: Any])?["classes"] as? [[String: Any]]
        XCTAssertEqual(advertiseClasses?[0]["class"] as? String, "screenshot")
        XCTAssertEqual(advertiseClasses?[0]["tccGranted"] as? Bool, true)
        XCTAssertEqual(advertiseClasses?[1]["class"] as? String, "noop")
        XCTAssertEqual(advertiseClasses?[1]["tccGranted"] as? Bool, false)

        let (revokeOneReq, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) {
            try await client.peripheralRevoke(leaseId: "lease_1", reason: "expired")
        }
        let revokeOneParams = revokeOneReq["params"] as? [String: Any]
        XCTAssertEqual(revokeOneParams?["leaseId"] as? String, "lease_1")
        XCTAssertEqual(revokeOneParams?["reason"] as? String, "expired")
        XCTAssertNil(revokeOneParams?["all"])

        let (revokeAllReq, _) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true}"#) {
            try await client.peripheralRevoke(leaseId: nil, reason: "panic")
        }
        let revokeAllParams = revokeAllReq["params"] as? [String: Any]
        XCTAssertEqual(revokeAllParams?["all"] as? Bool, true)
        XCTAssertEqual(revokeAllParams?["reason"] as? String, "panic")
        XCTAssertNil(revokeAllParams?["leaseId"])
    }

    func testDashboardReadWrappers() async throws {
        let (client, t) = try await connected()

        let (statusReq, status) = try await roundTrip(t, sentIndex: 1,
            result: #"{"version":"0.1.0","uptimeMs":42,"socketPath":"/tmp/norma.sock","provider":{"id":"c_1","model":"orb"},"sessionsCount":2,"pluginsCount":0}"#
        ) { try await client.daemonStatus() }
        XCTAssertEqual(statusReq["method"] as? String, "daemon.status")
        XCTAssertEqual(status.version, "0.1.0")
        XCTAssertEqual(status.uptimeMs, 42)
        XCTAssertEqual(status.socketPath, "/tmp/norma.sock")
        XCTAssertEqual(status.providerId, "c_1")
        XCTAssertEqual(status.providerModel, "orb")
        XCTAssertEqual(status.sessionsCount, 2)
        XCTAssertEqual(status.pluginsCount, 0)

        let (quotaReq, quota) = try await roundTrip(t, sentIndex: 2,
            result: #"{"kind":"limited","resumeAt":1700000000000,"inputTokens":10,"outputTokens":5}"#
        ) { try await client.quotaState() }
        XCTAssertEqual(quotaReq["method"] as? String, "quota.state")
        XCTAssertEqual(quota.kind, "limited")
        XCTAssertEqual(quota.resumeAt, 1700000000000)
        XCTAssertEqual(quota.inputTokens, 10)
        XCTAssertEqual(quota.outputTokens, 5)

        let (trustListReq, dirs) = try await roundTrip(t, sentIndex: 3,
            result: #"{"dirs":["/Users/x/proj","/Users/x/other"]}"#
        ) { try await client.trustList() }
        XCTAssertEqual(trustListReq["method"] as? String, "trust.list")
        XCTAssertEqual(dirs, ["/Users/x/proj", "/Users/x/other"])

        let (trustRemoveReq, removed) = try await roundTrip(t, sentIndex: 4,
            result: #"{"removed":true}"#
        ) { try await client.trustRemove(path: "/Users/x/proj") }
        XCTAssertEqual(trustRemoveReq["method"] as? String, "trust.remove")
        XCTAssertEqual((trustRemoveReq["params"] as? [String: Any])?["path"] as? String, "/Users/x/proj")
        XCTAssertTrue(removed)
    }

    /// BYOK T1 (design doc `2026-07-16-byok-provider-setup-design.md` §1): `configureProvider`
    /// always sends `type: "openai-compatible"` and round-trips `model` both present and omitted
    /// (omitted must not send the key at all — same `obj(...)` compactMapValues convention every
    /// other optional param in this file relies on).
    func testConfigureProviderWrapper() async throws {
        let (client, t) = try await connected()

        let (req1, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.configureProvider(baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-123", model: "gpt-4o-mini")
        }
        XCTAssertEqual(req1["method"] as? String, "provider.configure")
        let params1 = req1["params"] as? [String: Any]
        XCTAssertEqual(params1?["type"] as? String, "openai-compatible")
        XCTAssertEqual(params1?["baseUrl"] as? String, "https://api.openai.com/v1")
        XCTAssertEqual(params1?["apiKey"] as? String, "sk-test-123")
        XCTAssertEqual(params1?["model"] as? String, "gpt-4o-mini")

        let (req2, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) {
            try await client.configureProvider(baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-456")
        }
        let params2 = req2["params"] as? [String: Any]
        XCTAssertNil(params2?["model"], "omitted model must not be sent at all")
    }

    func testAttachSeedsDedupeSoReplayIsNotDropped() async throws {
        let (client, t) = try await connected()
        // attach fromSeq 5: events with seq > 5 must flow, seq <= 5 must be dropped
        async let attached = client.attach(sessionId: "s_1", fromSeq: 5)
        let sent = try await waitForSent(t, count: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sent[1])["id"] as! Int),"result":{"ok":true,"lastSeq":8}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()
        // stale duplicate (already seen before disconnect) — dropped
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":5,"sessionId":"s_1","ts":1,"threadId":"main"}}"#)
        // fresh replay — delivered
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_message","seq":6,"sessionId":"s_1","ts":2,"threadId":"main","text":"done"}}"#)
        guard case .session(.assistantMessage(let m)) = await iter.next() else { return XCTFail("stale event not dropped or fresh not delivered") }
        XCTAssertEqual(m.seq, 6)
        // transient delta with seq == lastSeq still flows (dedupe exemption)
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_delta","seq":6,"sessionId":"s_1","ts":3,"threadId":"main","delta":"x"}}"#)
        guard case .session(.assistantDelta) = await iter.next() else { return XCTFail("delta wrongly deduped") }
    }

    /// Phase 2f: lease_granted/lease_lost/peripheral_call_requested are TRANSIENT exactly like
    /// assistant_delta (broadcastTransient stamps them with the store's current lastSeq, not their
    /// own) — they must bypass the seq<=lastSeq dedupe gate too, or they'd be silently dropped.
    func testPeripheralLeaseEventsAreTransientLikeAssistantDelta() async throws {
        let (client, t) = try await connected()
        async let attached = client.attach(sessionId: "s_1", fromSeq: 5)
        let sent = try await waitForSent(t, count: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sent[1])["id"] as! Int),"result":{"ok":true,"lastSeq":8}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()
        let holder = #"{"kind":"session","id":"s_1"}"#
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"lease_granted","seq":8,"sessionId":"s_1","ts":1,"threadId":"main","leaseId":"lease_1","class":"noop","holder":\#(holder),"expiresAt":20,"tokenHash":"\#(String(repeating: "a", count: 64))"}}"#)
        guard case .session(.leaseGranted(let g)) = await iter.next() else { return XCTFail("lease_granted wrongly deduped") }
        XCTAssertEqual(g.leaseId, "lease_1")

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"lease_lost","seq":8,"sessionId":"s_1","ts":2,"threadId":"main","leaseId":"lease_1","class":"noop","holder":\#(holder),"reason":"expired"}}"#)
        guard case .session(.leaseLost(let l)) = await iter.next() else { return XCTFail("lease_lost wrongly deduped") }
        XCTAssertEqual(l.reason, "expired")

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"peripheral_call_requested","seq":8,"sessionId":"s_1","ts":3,"threadId":"main","requestId":"req_1","leaseId":"lease_1","token":"tok_1","class":"noop","payloadJson":"{}"}}"#)
        guard case .session(.peripheralCallRequested(let c)) = await iter.next() else { return XCTFail("peripheral_call_requested wrongly deduped") }
        XCTAssertEqual(c.requestId, "req_1")
    }

    /// G2 live-gate fix: the seq<=lastSeq dedupe/lastSeq bookkeeping is scoped to the attached
    /// session only. A cross-session event (e.g. a fresh `session_created` broadcast for some
    /// OTHER session) must bypass the gate entirely — even while attached elsewhere at a much
    /// higher lastSeq — and must not perturb dedupe for the attached session afterward.
    func testCrossSessionEventBypassesAttachedSessionDedupe() async throws {
        let (client, t) = try await connected()
        // attach to s_1 fromSeq 5, server reports lastSeq 8
        async let attached = client.attach(sessionId: "s_1", fromSeq: 5)
        let sent = try await waitForSent(t, count: 2)
        t.feed(#"{"jsonrpc":"2.0","id":\#(decodeLine(sent[1])["id"] as! Int),"result":{"ok":true,"lastSeq":8}}"#)
        _ = try await attached

        var iter = client.events.makeAsyncIterator()
        // a brand-new OTHER session broadcasts session_created at seq 1 — must NOT be dropped
        // even though 1 <= lastSeq(8) for the attached session.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"session_created","seq":1,"sessionId":"s_2","ts":1,"scope":"global"}}"#)
        guard case .session(.sessionCreated(let created)) = await iter.next() else {
            return XCTFail("cross-session event wrongly dropped by attached-session dedupe")
        }
        XCTAssertEqual(created.sessionId, "s_2")
        XCTAssertEqual(created.seq, 1)

        // dedupe for the ATTACHED session is untouched by the cross-session event: a stale
        // s_1 event (seq 4 <= lastSeq 8) is still dropped.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"turn_started","seq":4,"sessionId":"s_1","ts":2,"threadId":"main"}}"#)
        // fresh s_1 event to prove the iterator moves past the dropped one.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"assistant_message","seq":9,"sessionId":"s_1","ts":3,"threadId":"main","text":"done"}}"#)
        guard case .session(.assistantMessage(let m)) = await iter.next() else {
            return XCTFail("stale attached-session event not dropped, or fresh one not delivered")
        }
        XCTAssertEqual(m.seq, 9)
    }

    // MARK: - Phase 4d-ii Task 3: plugin lifecycle + contrib + shortcut/tile-action wrappers

    func testPluginsInstallOutcomes() async throws {
        let (client, t) = try await connected()

        let (req1, ok) = try await roundTrip(t, sentIndex: 1,
            result: #"{"ok":true,"name":"sample-echo","requiredConsents":["network"],"hasMcp":false,"consentBlock":["plugin sample-echo requests:","- network access"]}"#
        ) { try await client.pluginsInstall(source: "/tmp/sample-echo", name: "sample-echo") }
        XCTAssertEqual(req1["method"] as? String, "plugins.install")
        XCTAssertEqual((req1["params"] as? [String: Any])?["source"] as? String, "/tmp/sample-echo")
        XCTAssertEqual((req1["params"] as? [String: Any])?["name"] as? String, "sample-echo")
        XCTAssertEqual(ok, .ok(name: "sample-echo", requiredConsents: ["network"], hasMcp: false, consentBlock: ["plugin sample-echo requests:", "- network access"]))

        let (req2, invalid) = try await roundTrip(t, sentIndex: 2, result: #"{"code":"invalid_source"}"#) {
            try await client.pluginsInstall(source: "/nonexistent")
        }
        XCTAssertNil((req2["params"] as? [String: Any])?["name"]) // omitted `name` param dropped, not sent as null
        XCTAssertEqual(invalid, .invalidSource)

        let (_, already) = try await roundTrip(t, sentIndex: 3, result: #"{"code":"already_installed","name":"sample-echo"}"#) {
            try await client.pluginsInstall(source: "/tmp/sample-echo")
        }
        XCTAssertEqual(already, .alreadyInstalled(name: "sample-echo"))
    }

    func testPluginEnableOutcomesIncludingNeedsConsent() async throws {
        let (client, t) = try await connected()

        let (req1, needsConsent) = try await roundTrip(t, sentIndex: 1,
            result: #"{"code":"needs_consent","requiredConsents":["network"],"consentBlock":["plugin sample-echo requests:","- network access"]}"#
        ) { try await client.pluginEnable(name: "sample-echo") }
        XCTAssertEqual(req1["method"] as? String, "plugin.enable")
        XCTAssertNil((req1["params"] as? [String: Any])?["consent"])
        XCTAssertEqual(needsConsent, .needsConsent(requiredConsents: ["network"], consentBlock: ["plugin sample-echo requests:", "- network access"]))

        let (req2, ok) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"status":"running"}"#) {
            try await client.pluginEnable(name: "sample-echo", consent: true)
        }
        XCTAssertEqual((req2["params"] as? [String: Any])?["consent"] as? Bool, true)
        XCTAssertEqual(ok, .ok(status: "running"))

        let (_, unknown) = try await roundTrip(t, sentIndex: 3, result: #"{"code":"unknown_plugin"}"#) {
            try await client.pluginEnable(name: "ghost")
        }
        XCTAssertEqual(unknown, .unknownPlugin)
    }

    func testPluginDisableRemoveSetConsentOutcomes() async throws {
        let (client, t) = try await connected()

        let (req1, disableOk) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.pluginDisable(name: "sample-echo")
        }
        XCTAssertEqual(req1["method"] as? String, "plugin.disable")
        XCTAssertEqual(disableOk, .ok)

        let (_, disableUnknown) = try await roundTrip(t, sentIndex: 2, result: #"{"code":"unknown_plugin"}"#) {
            try await client.pluginDisable(name: "ghost")
        }
        XCTAssertEqual(disableUnknown, .unknownPlugin)

        let (req3, removeOk) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true}"#) {
            try await client.pluginRemove(name: "sample-echo")
        }
        XCTAssertEqual(req3["method"] as? String, "plugin.remove")
        XCTAssertEqual(removeOk, .ok)

        let (req4, setConsentOk) = try await roundTrip(t, sentIndex: 4, result: #"{"ok":true}"#) {
            try await client.pluginSetConsent(name: "sample-echo", classes: ["network", "filesystem"])
        }
        XCTAssertEqual(req4["method"] as? String, "plugin.setConsent")
        XCTAssertEqual((req4["params"] as? [String: Any])?["classes"] as? [String], ["network", "filesystem"])
        XCTAssertEqual(setConsentOk, .ok)
    }

    func testShortcutInvokeAndTileActionOutcomes() async throws {
        let (client, t) = try await connected()

        let (req1, ok) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.shortcutInvoke(pluginId: "sample-echo", shortcutId: "toggle")
        }
        XCTAssertEqual(req1["method"] as? String, "shortcut.invoke")
        XCTAssertEqual((req1["params"] as? [String: Any])?["shortcutId"] as? String, "toggle")
        XCTAssertEqual(ok, .ok)

        let (_, notConnected) = try await roundTrip(t, sentIndex: 2, result: #"{"code":"not_connected"}"#) {
            try await client.shortcutInvoke(pluginId: "sample-echo", shortcutId: "toggle")
        }
        XCTAssertEqual(notConnected, .notConnected)

        let (req3, tileOk) = try await roundTrip(t, sentIndex: 3, result: #"{"ok":true}"#) {
            try await client.tileAction(pluginId: "sample-echo", actionId: "refresh")
        }
        XCTAssertEqual(req3["method"] as? String, "tile.action")
        XCTAssertEqual(tileOk, .ok)

        let (_, unknownPlugin) = try await roundTrip(t, sentIndex: 4, result: #"{"code":"unknown_plugin"}"#) {
            try await client.tileAction(pluginId: "ghost", actionId: "refresh")
        }
        XCTAssertEqual(unknownPlugin, .unknownPlugin)
    }

    func testPluginsContribDecodesShortcutsTileAndProvider() async throws {
        let (client, t) = try await connected()
        let (req, entries) = try await roundTrip(t, sentIndex: 1,
            result: #"{"ok":true,"entries":[{"pluginId":"sample-echo","shortcuts":[{"id":"toggle","description":"Toggle","default":"cmd+t"}],"tile":{"title":"Sample","value":"1"}},{"pluginId":"provider-plugin","provider":{"ready":true}}]}"#
        ) { try await client.pluginsContrib() }
        XCTAssertEqual(req["method"] as? String, "plugins.contrib")
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries[0].pluginId, "sample-echo")
        XCTAssertEqual(entries[0].shortcuts.first?.id, "toggle")
        XCTAssertEqual(entries[0].shortcuts.first?.description, "Toggle")
        XCTAssertEqual(entries[0].shortcuts.first?.defaultKeybinding, "cmd+t")
        XCTAssertEqual(entries[0].tile?["title"], .string("Sample"))
        XCTAssertNil(entries[0].provider)
        XCTAssertEqual(entries[1].pluginId, "provider-plugin")
        XCTAssertTrue(entries[1].shortcuts.isEmpty)
        XCTAssertEqual(entries[1].provider?["ready"], .bool(true))
    }

    func testPluginsListDecodesExtendedFields() async throws {
        let (client, t) = try await connected()
        let (req, plugins) = try await roundTrip(t, sentIndex: 1,
            result: #"{"ok":true,"plugins":[{"name":"sample-echo","version":"1.2.0","skills":["echo"],"hasMcp":false,"mcpEnabled":false,"disabled":false,"tier":"platform","requiredConsents":["network"],"consented":["network"],"legacy":false,"status":"running"},{"name":"legacy-plugin","skills":[],"hasMcp":false,"mcpEnabled":false,"disabled":true}]}"#
        ) { try await client.pluginsList() }
        XCTAssertEqual(req["method"] as? String, "plugins.list")
        XCTAssertEqual(plugins.count, 2)
        XCTAssertEqual(plugins[0].name, "sample-echo")
        XCTAssertEqual(plugins[0].version, "1.2.0")
        XCTAssertEqual(plugins[0].tier, "platform")
        XCTAssertEqual(plugins[0].requiredConsents, ["network"])
        XCTAssertEqual(plugins[0].consented, ["network"])
        XCTAssertFalse(plugins[0].legacy)
        XCTAssertEqual(plugins[0].status, "running")

        XCTAssertEqual(plugins[1].name, "legacy-plugin")
        XCTAssertNil(plugins[1].version)
        XCTAssertNil(plugins[1].tier)
        XCTAssertEqual(plugins[1].requiredConsents, [])
        XCTAssertEqual(plugins[1].consented, [])
        XCTAssertFalse(plugins[1].legacy)
        XCTAssertNil(plugins[1].status)
    }

    /// Phase 4d-iii Task 2: `plugin.restart {pluginId}` — no typed outcome (the server throws a
    /// bare `RpcFailure` for an unknown id, which surfaces as a thrown `RpcError` here); the happy
    /// path just needs the right method/param key sent and no throw on `{ok:true}`.
    func testPluginRestartSendsPluginIdAndSucceeds() async throws {
        let (client, t) = try await connected()
        let (req, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.pluginRestart(name: "sample-echo")
        }
        XCTAssertEqual(req["method"] as? String, "plugin.restart")
        XCTAssertEqual((req["params"] as? [String: Any])?["pluginId"] as? String, "sample-echo")
    }

    func testPluginRestartUnknownPluginThrows() async throws {
        let (client, t) = try await connected()
        async let call: Void = client.pluginRestart(name: "ghost")
        let sent = try await waitForSent(t, count: 2)
        let req = decodeLine(sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"error":{"code":-32000,"message":"unknown plugin: ghost"}}"#)
        do {
            try await call
            XCTFail("expected pluginRestart to throw for an unknown plugin")
        } catch let error as RpcError {
            XCTAssertEqual(error.message, "unknown plugin: ghost")
        }
    }

    /// Phase 4d-ii Task 3: `plugin_tile_updated` is transient (bypasses the session-attach dedupe
    /// gate, like assistant_delta/hardwareRequested/etc. above) AND routes into the client's
    /// `tiles` store, keyed by pluginId — set on a non-null `tile`, REMOVED entirely on `tile:null`
    /// (a plugin disconnecting/clearing its tile), never left as a stored `nil`. The store mutation
    /// happens before the event is yielded to `events` (NormaClient.swift's `route()`), so
    /// consuming the event via the iterator first guarantees `tiles` already reflects it — avoids
    /// racing the actor's async pump.
    func testPluginTileUpdatedEventUpdatesAndClearsTilesStore() async throws {
        let (client, t) = try await connected()
        var iter = client.events.makeAsyncIterator()

        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"plugin_tile_updated","sessionId":"$system","seq":1,"ts":1,"pluginId":"sample-echo","tile":{"title":"Sample","value":"1","enabled":true}}}"#)
        guard case .session(.pluginTileUpdated(let v1)) = await iter.next() else {
            return XCTFail("plugin_tile_updated not delivered (transient bypass broken?)")
        }
        XCTAssertEqual(v1.pluginId, "sample-echo")
        var tiles = await client.tiles
        XCTAssertEqual(tiles["sample-echo"]?["title"], .string("Sample"))
        XCTAssertEqual(tiles["sample-echo"]?["enabled"], .bool(true))
        XCTAssertNil(tiles["battery-limiter"])

        // A second plugin's tile merges in alongside the first (doesn't replace the store).
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"plugin_tile_updated","sessionId":"$system","seq":2,"ts":2,"pluginId":"battery-limiter","tile":{"title":"Battery Limiter","value":"80%"}}}"#)
        guard case .session(.pluginTileUpdated) = await iter.next() else {
            return XCTFail("second plugin_tile_updated not delivered")
        }
        tiles = await client.tiles
        XCTAssertEqual(tiles.count, 2)
        XCTAssertEqual(tiles["battery-limiter"]?["value"], .string("80%"))

        // tile:null REMOVES just that plugin's entry from the store, leaving the other untouched.
        t.feed(#"{"jsonrpc":"2.0","method":"event","params":{"type":"plugin_tile_updated","sessionId":"$system","seq":3,"ts":3,"pluginId":"sample-echo","tile":null}}"#)
        guard case .session(.pluginTileUpdated(let cleared)) = await iter.next() else {
            return XCTFail("clearing plugin_tile_updated not delivered")
        }
        XCTAssertNil(cleared.tile)
        tiles = await client.tiles
        XCTAssertNil(tiles["sample-echo"])
        XCTAssertEqual(tiles.count, 1)
        XCTAssertEqual(tiles["battery-limiter"]?["value"], .string("80%"))
    }

    // MARK: - Phase 5b Task 5: memory.* wrappers (Dashboard MemoryPane)

    func testMemoryListAndReadDecodeFacts() async throws {
        let (client, t) = try await connected()

        let (listReq, facts) = try await roundTrip(t, sentIndex: 1,
            result: #"{"ok":true,"facts":[{"name":"likes-dark-mode","description":"UI preference","type":"user"},{"name":"onboarding-note","description":"first-session context","type":"feedback"}]}"#
        ) { try await client.memoryList(scope: "user") }
        XCTAssertEqual(listReq["method"] as? String, "memory.list")
        XCTAssertEqual((listReq["params"] as? [String: Any])?["scope"] as? String, "user")
        XCTAssertNil((listReq["params"] as? [String: Any])?["cwd"]) // omitted cwd dropped, not sent as null
        XCTAssertEqual(facts.count, 2)
        XCTAssertEqual(facts[0].name, "likes-dark-mode")
        XCTAssertEqual(facts[0].type, "user")
        XCTAssertEqual(facts[1].description, "first-session context")

        let (readReq, fact) = try await roundTrip(t, sentIndex: 2,
            result: #"{"ok":true,"fact":{"name":"likes-dark-mode","description":"UI preference","type":"user","body":"Prefers dark mode everywhere."}}"#
        ) { try await client.memoryRead(scope: "user", name: "likes-dark-mode") }
        XCTAssertEqual(readReq["method"] as? String, "memory.read")
        XCTAssertEqual((readReq["params"] as? [String: Any])?["name"] as? String, "likes-dark-mode")
        XCTAssertEqual(fact.body, "Prefers dark mode everywhere.")
        XCTAssertEqual(fact.type, "user")
    }

    func testMemoryWriteAndDeleteEncodeParamsAndSucceedOnEmptyResult() async throws {
        let (client, t) = try await connected()

        let (writeReq, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.memoryWrite(scope: "user", name: "likes-dark-mode", description: "UI preference", type: "user", body: "Prefers dark mode.")
        }
        XCTAssertEqual(writeReq["method"] as? String, "memory.write")
        let writeParams = writeReq["params"] as? [String: Any]
        XCTAssertEqual(writeParams?["scope"] as? String, "user")
        XCTAssertEqual(writeParams?["name"] as? String, "likes-dark-mode")
        XCTAssertEqual(writeParams?["description"] as? String, "UI preference")
        XCTAssertEqual(writeParams?["type"] as? String, "user")
        XCTAssertEqual(writeParams?["body"] as? String, "Prefers dark mode.")
        XCTAssertNil(writeParams?["cwd"])

        let (deleteReq, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) {
            try await client.memoryDelete(scope: "user", name: "likes-dark-mode")
        }
        XCTAssertEqual(deleteReq["method"] as? String, "memory.delete")
        XCTAssertEqual((deleteReq["params"] as? [String: Any])?["name"] as? String, "likes-dark-mode")
    }

    /// `memory.audit`'s wire contract is newest-first; the wrapper decodes the array verbatim
    /// (no client-side reversal) — this fixture's ordering (newest fact write first) round-trips
    /// unchanged.
    func testMemoryAuditDecodesNewestFirstAndOmitsOptionalFields() async throws {
        let (client, t) = try await connected()

        let (req, lines) = try await roundTrip(t, sentIndex: 1,
            result: #"{"ok":true,"lines":[{"ts":2000,"source":"rpc","scope":"user","action":"delete","name":"stale-fact"},{"ts":1000,"sessionId":"s_1","source":"tool","scope":"user","action":"write","name":"likes-dark-mode","description":"UI preference"}]}"#
        ) { try await client.memoryAudit(limit: 10) }
        XCTAssertEqual(req["method"] as? String, "memory.audit")
        XCTAssertEqual((req["params"] as? [String: Any])?["limit"] as? Int, 10)
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[0].ts, 2000)
        XCTAssertEqual(lines[0].action, "delete")
        XCTAssertNil(lines[0].sessionId)
        XCTAssertNil(lines[0].description)
        XCTAssertEqual(lines[1].sessionId, "s_1")
        XCTAssertEqual(lines[1].description, "UI preference")
    }

    /// T3 (file-based memory, task-23): `cwd` is additive/optional on `memory.audit` — omitted
    /// (every pre-T3 call site, e.g. `MemoryPaneModel`) is dropped from the wire params entirely
    /// (not sent as JSON null), same convention every other optional param in this file already
    /// follows; supplied, it's sent verbatim so a project-aware caller can target that project's
    /// own `.audit.jsonl` (see methods.ts's `MemoryAuditParams` doc comment for the server-side
    /// resolution). Decoding is unaffected either way — the wire result shape didn't change.
    func testMemoryAuditCwdParamOmittedByDefaultSentWhenProvided() async throws {
        let (client, t) = try await connected()

        let (reqNoCwd, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true,"lines":[]}"#) {
            try await client.memoryAudit(limit: 5)
        }
        XCTAssertNil((reqNoCwd["params"] as? [String: Any])?["cwd"])

        let (reqWithCwd, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"lines":[]}"#) {
            try await client.memoryAudit(limit: 5, cwd: "/repo/project")
        }
        XCTAssertEqual((reqWithCwd["params"] as? [String: Any])?["cwd"] as? String, "/repo/project")
    }

    // MARK: - Phase 5c Task 4: skills.* wrappers (Dashboard SkillsPane)

    /// `skills.list` now decodes every `SkillMetaSchema` field (methods.ts) — the prior wrapper
    /// dropped `path`/`claudeFormat`/`author` on the floor; this proves all five are round-tripped,
    /// including the "author: norma" self-authored marker and a claude-format plugin skill.
    func testSkillsListDecodesEveryMetaField() async throws {
        let (client, t) = try await connected()

        let (req, skills) = try await roundTrip(t, sentIndex: 1,
            result: #"{"ok":true,"skills":[{"name":"writing-skills","description":"how to write a skill","source":"builtin","path":"/norma/skills/writing-skills"},{"name":"my-note","description":"a self-authored skill","source":"self","path":"/home/u/.norma/skills/self/my-note","author":"norma"},{"name":"pdf-helper","description":"plugin skill","source":"plugin","path":"/plugins/x/skills/pdf","claudeFormat":true}]}"#
        ) { try await client.skillsList() }
        XCTAssertEqual(req["method"] as? String, "skills.list")
        XCTAssertNil((req["params"] as? [String: Any])?["cwd"]) // omitted cwd dropped, not sent as null
        XCTAssertEqual(skills.count, 3)
        XCTAssertEqual(skills[0].source, "builtin")
        XCTAssertNil(skills[0].author)
        XCTAssertNil(skills[0].claudeFormat)
        XCTAssertEqual(skills[1].source, "self")
        XCTAssertEqual(skills[1].author, "norma")
        XCTAssertEqual(skills[2].claudeFormat, true)
    }

    func testSkillsReadDecodesFullBody() async throws {
        let (client, t) = try await connected()

        let (req, skill) = try await roundTrip(t, sentIndex: 1,
            result: ##"{"ok":true,"skill":{"name":"my-note","description":"a self-authored skill","source":"self","path":"/home/u/.norma/skills/self/my-note","author":"norma","body":"# My Note\n\nSome body text."}}"##
        ) { try await client.skillsRead(name: "my-note") }
        XCTAssertEqual(req["method"] as? String, "skills.read")
        XCTAssertEqual((req["params"] as? [String: Any])?["name"] as? String, "my-note")
        XCTAssertNil((req["params"] as? [String: Any])?["cwd"])
        XCTAssertEqual(skill.source, "self")
        XCTAssertEqual(skill.author, "norma")
        XCTAssertEqual(skill.body, "# My Note\n\nSome body text.")
    }

    /// `skills.write`/`skills.delete` take no `scope`/`cwd` param to abuse (methods.ts: always
    /// self-confined server-side) — proves the wrapper sends exactly `{name, description, body}`/
    /// `{name}` and succeeds on the empty result, same posture as `memoryWrite`/`memoryDelete`.
    func testSkillsWriteAndDeleteEncodeParamsAndSucceedOnEmptyResult() async throws {
        let (client, t) = try await connected()

        let (writeReq, _) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true}"#) {
            try await client.skillsWrite(name: "my-note", description: "a self-authored skill", body: "# My Note")
        }
        XCTAssertEqual(writeReq["method"] as? String, "skills.write")
        let writeParams = writeReq["params"] as? [String: Any]
        XCTAssertEqual(writeParams?["name"] as? String, "my-note")
        XCTAssertEqual(writeParams?["description"] as? String, "a self-authored skill")
        XCTAssertEqual(writeParams?["body"] as? String, "# My Note")
        XCTAssertNil(writeParams?["scope"])
        XCTAssertNil(writeParams?["cwd"])

        let (deleteReq, _) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true}"#) {
            try await client.skillsDelete(name: "my-note")
        }
        XCTAssertEqual(deleteReq["method"] as? String, "skills.delete")
        XCTAssertEqual((deleteReq["params"] as? [String: Any])?["name"] as? String, "my-note")
    }

    // MARK: - Workflows (CC-parity phase 3, Track D Task D2): workflow.list/run/stop/get wrappers

    /// `workflow.list {sessionId, cwd?}` — decodes both the `running` array (one entry with every
    /// optional field present, a second with them all absent) and the `saved` array; also proves
    /// the omitted-`cwd` convention (dropped from wire params, not sent as null) and that a
    /// supplied `cwd` is sent verbatim.
    func testWorkflowListDecodesRunningAndSaved() async throws {
        let (client, t) = try await connected()

        let (req, result) = try await roundTrip(t, sentIndex: 1,
            result: #"{"running":[{"runId":"wf_1","sessionId":"s_1","name":"deploy","status":"running","counts":{"running":1,"completed":2,"total":4},"phase":"build","startedAt":1000},{"runId":"wf_2","sessionId":"s_1","status":"failed","counts":{"running":0,"completed":1,"total":2},"error":"boom","startedAt":900}],"saved":[{"name":"deploy","description":"Ship it","source":"/repo/.norma/workflows/deploy.js"}]}"#
        ) { try await client.workflowList(sessionId: "s_1") }
        XCTAssertEqual(req["method"] as? String, "workflow.list")
        XCTAssertEqual((req["params"] as? [String: Any])?["sessionId"] as? String, "s_1")
        XCTAssertNil((req["params"] as? [String: Any])?["cwd"]) // omitted cwd dropped, not sent as null

        XCTAssertEqual(result.running.count, 2)
        XCTAssertEqual(result.running[0].runId, "wf_1")
        XCTAssertEqual(result.running[0].name, "deploy")
        XCTAssertEqual(result.running[0].status, "running")
        XCTAssertEqual(result.running[0].counts.running, 1)
        XCTAssertEqual(result.running[0].counts.completed, 2)
        XCTAssertEqual(result.running[0].counts.total, 4)
        XCTAssertEqual(result.running[0].phase, "build")
        XCTAssertNil(result.running[0].result)
        XCTAssertNil(result.running[0].error)
        XCTAssertEqual(result.running[0].startedAt, 1000)

        XCTAssertNil(result.running[1].name)
        XCTAssertEqual(result.running[1].status, "failed")
        XCTAssertEqual(result.running[1].error, "boom")
        XCTAssertNil(result.running[1].phase)

        XCTAssertEqual(result.saved.count, 1)
        XCTAssertEqual(result.saved[0].name, "deploy")
        XCTAssertEqual(result.saved[0].description, "Ship it")
        XCTAssertEqual(result.saved[0].source, "/repo/.norma/workflows/deploy.js")

        let (reqWithCwd, _) = try await roundTrip(t, sentIndex: 2, result: #"{"running":[],"saved":[]}"#) {
            try await client.workflowList(sessionId: "s_1", cwd: "/repo/proj")
        }
        XCTAssertEqual((reqWithCwd["params"] as? [String: Any])?["cwd"] as? String, "/repo/proj")
    }

    /// `workflow.run {sessionId, name?, script?, args?}` — proves both the by-name and
    /// inline-script call shapes encode correctly (mutually exclusive `name`/`script`, enforced
    /// server-side per methods.ts's own doc comment, not schema-level) and that the result decodes
    /// to just the `runId` — the wire's `status` is always the literal `"running"`
    /// (`WorkflowRunResult`'s own doc comment), nothing else worth surfacing.
    func testWorkflowRunEncodesNameOrScriptAndDecodesRunId() async throws {
        let (client, t) = try await connected()

        let (req1, runId1) = try await roundTrip(t, sentIndex: 1, result: #"{"runId":"wf_1","status":"running"}"#) {
            try await client.workflowRun(sessionId: "s_1", name: "deploy")
        }
        XCTAssertEqual(req1["method"] as? String, "workflow.run")
        let params1 = req1["params"] as? [String: Any]
        XCTAssertEqual(params1?["sessionId"] as? String, "s_1")
        XCTAssertEqual(params1?["name"] as? String, "deploy")
        XCTAssertNil(params1?["script"])
        XCTAssertNil(params1?["args"])
        XCTAssertEqual(runId1, "wf_1")

        let (req2, runId2) = try await roundTrip(t, sentIndex: 2, result: #"{"runId":"wf_2","status":"running"}"#) {
            try await client.workflowRun(sessionId: "s_1", script: "phase('go'); done()", args: .object(["target": .string("prod")]))
        }
        let params2 = req2["params"] as? [String: Any]
        XCTAssertNil(params2?["name"])
        XCTAssertEqual(params2?["script"] as? String, "phase('go'); done()")
        XCTAssertEqual((params2?["args"] as? [String: Any])?["target"] as? String, "prod")
        XCTAssertEqual(runId2, "wf_2")
    }

    /// `workflow.stop {runId}` — a soft boolean, never a thrown error for an unknown or
    /// already-terminal `runId` (methods.ts's own doc comment); proves both outcomes decode and
    /// that the constant `ok:true` wrapper is dropped, same precedent as `trustDir`.
    func testWorkflowStopDecodesStoppedBoolean() async throws {
        let (client, t) = try await connected()

        let (req, stopped) = try await roundTrip(t, sentIndex: 1, result: #"{"ok":true,"stopped":true}"#) {
            try await client.workflowStop(runId: "wf_1")
        }
        XCTAssertEqual(req["method"] as? String, "workflow.stop")
        XCTAssertEqual((req["params"] as? [String: Any])?["runId"] as? String, "wf_1")
        XCTAssertTrue(stopped)

        let (_, notStopped) = try await roundTrip(t, sentIndex: 2, result: #"{"ok":true,"stopped":false}"#) {
            try await client.workflowStop(runId: "ghost")
        }
        XCTAssertFalse(notStopped)
    }

    /// `workflow.get {runId}` — decodes the `{run: WorkflowRunView}` wrapper into a bare
    /// `WorkflowRunView`; an unresolvable runId is a thrown `RpcFailure` server-side (NOT_FOUND, per
    /// the handler), surfaced here as a thrown `RpcError`, same discipline as `pluginRestart`.
    func testWorkflowGetDecodesRunView() async throws {
        let (client, t) = try await connected()

        let (req, run) = try await roundTrip(t, sentIndex: 1,
            result: #"{"run":{"runId":"wf_1","sessionId":"s_1","name":"deploy","status":"completed","counts":{"running":0,"completed":4,"total":4},"result":"ok","startedAt":1000}}"#
        ) { try await client.workflowGet(runId: "wf_1") }
        XCTAssertEqual(req["method"] as? String, "workflow.get")
        XCTAssertEqual((req["params"] as? [String: Any])?["runId"] as? String, "wf_1")
        XCTAssertEqual(run.runId, "wf_1")
        XCTAssertEqual(run.status, "completed")
        XCTAssertEqual(run.counts.completed, 4)
        XCTAssertEqual(run.result, "ok")
        XCTAssertNil(run.error)
    }

    func testWorkflowGetThrowsForUnknownRun() async throws {
        let (client, t) = try await connected()
        async let call = client.workflowGet(runId: "ghost")
        let sent = try await waitForSent(t, count: 2)
        let req = decodeLine(sent[1])
        t.feed(#"{"jsonrpc":"2.0","id":\#(req["id"] as! Int),"error":{"code":-32000,"message":"unknown run: ghost"}}"#)
        do {
            _ = try await call
            XCTFail("expected workflowGet to throw for an unknown run")
        } catch let error as RpcError {
            XCTAssertEqual(error.message, "unknown run: ghost")
        }
    }

    // MARK: - orb-regressions (2026-07-29): the no-argument methods must still carry `params: {}`
    //
    // `request(_:params:)` USED TO OMIT the `params` key entirely when the caller passed `nil`
    // (`if let params { obj["params"] = params }`). That is legal JSON-RPC 2.0 — but the daemon
    // validates these methods with `parseParams(z.object({}), params)`, and
    // `z.object({}).safeParse(undefined)` FAILS, so every one of them came back
    // `-32602 invalid params: (root)` against a REAL daemon. Proven live against the dev daemon
    // (`session.dispatch` with no `params` key → that exact error; with `"params":{}` → success).
    //
    // User-visible blast radius: `AppModel.ensureFocusedSession()` calls `dispatchSession()` on
    // the FIRST orb summon/submit of any Norma home that has no dispatch session yet. The throw
    // made it return `nil`, so `sendOrSteer` returned false (Enter silently did nothing) and
    // `focusedSessionId` stayed nil forever (the yellow-light detach bailed too — see
    // `AppDelegate.handleWindowDetach`). The bug was latent from Phase 7 until the dev/dist split
    // pointed the Debug app at a FRESH `~/.norma-dev` with no pre-existing dispatch session.
    //
    // `session.list` is in this list even though its handler happens not to `parseParams` today —
    // pinning it costs nothing and stops that handler ever growing a schema into a silent break.

    /// `session.dispatch` — the one whose failure the user actually reported.
    func testDispatchSessionSendsAParamsObject() async throws {
        let (client, t) = try await connected()
        let (req, result) = try await roundTrip(t, sentIndex: 1, result: #"{"sessionId":"s_d","created":true}"#) {
            try await client.dispatchSession()
        }
        XCTAssertEqual(req["method"] as? String, "session.dispatch")
        XCTAssertNotNil(
            req["params"] as? [String: Any],
            "session.dispatch must carry a params OBJECT — the daemon parses it with z.object({}), which REJECTS an omitted params key (-32602 invalid params: (root))"
        )
        XCTAssertEqual(result.sessionId, "s_d")
        XCTAssertTrue(result.created)
    }

    /// The other four `z.object({})`-validated no-argument methods, same defect, same fix.
    func testEveryNoArgumentMethodSendsAParamsObject() async throws {
        let (client, t) = try await connected()

        let (listReq, _) = try await roundTrip(t, sentIndex: 1, result: #"{"sessions":[]}"#) {
            try await client.listSessions()
        }
        XCTAssertEqual(listReq["method"] as? String, "session.list")
        XCTAssertNotNil(listReq["params"] as? [String: Any], "session.list must carry a params object")

        let (statusReq, _) = try await roundTrip(
            t, sentIndex: 2,
            result: #"{"version":"0","uptimeMs":1,"socketPath":"/s","sessionsCount":0,"pluginsCount":0}"#
        ) { try await client.daemonStatus() }
        XCTAssertEqual(statusReq["method"] as? String, "daemon.status")
        XCTAssertNotNil(statusReq["params"] as? [String: Any], "daemon.status must carry a params object")

        let (activityReq, turns) = try await roundTrip(t, sentIndex: 3, result: #"{"activeTurns":2}"#) {
            try await client.engineActivity()
        }
        XCTAssertEqual(activityReq["method"] as? String, "engine.activity")
        XCTAssertNotNil(activityReq["params"] as? [String: Any], "engine.activity must carry a params object")
        XCTAssertEqual(turns, 2)

        let (quotaReq, _) = try await roundTrip(
            t, sentIndex: 4, result: #"{"kind":"ok","inputTokens":0,"outputTokens":0}"#
        ) { try await client.quotaState() }
        XCTAssertEqual(quotaReq["method"] as? String, "quota.state")
        XCTAssertNotNil(quotaReq["params"] as? [String: Any], "quota.state must carry a params object")

        let (trustReq, dirs) = try await roundTrip(t, sentIndex: 5, result: #"{"dirs":["/tmp"]}"#) {
            try await client.trustList()
        }
        XCTAssertEqual(trustReq["method"] as? String, "trust.list")
        XCTAssertNotNil(trustReq["params"] as? [String: Any], "trust.list must carry a params object")
        XCTAssertEqual(dirs, ["/tmp"])
    }
}
