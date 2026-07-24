import Foundation
import os
import IrohLib
import NormaKit
import NormaProtocol
import NormaSessionKit

/// SP2b Task 5: the dev fake-phone CLI — closes the pairing loop end-to-end (scan a QR, run the
/// ceremony, optionally attach and stream) without any iOS code. `PhonePairingClient` (this
/// package's own reusable phone-side ceremony) does the real work; this file is just argv
/// parsing + NDJSON printing, matching `norma-probe/main.swift`'s own "Task { } + semaphore"
/// bridge from this synchronous `main.swift` into async `await` calls.
///
/// NEVER prints `qr.pairSecret`, the phone's own generated identity secret, or the raw QR string
/// it was given (echoing input back is pointless and forbidden) — only the QR-DERIVED SAS words,
/// endpoint IDs, and protocol metadata (epoch, granted caps, streamed wire frames) ever reach
/// stdout.
func out(_ s: String) {
    FileHandle.standardOutput.write(Data((s + "\n").utf8))
}

// MARK: - Arg parsing (no dependency — mirrors `norma-probe`'s own hand-rolled `ProbeArgs` posture)

let usage = """
usage: norma-fake-phone pair --qr <base64url|-> [--attach] [--mute]
       norma-fake-phone probe-relay --url <relay-url>

  --attach   after pairing, attach to the live event stream (session.list + NDJSON events)
  --mute     (KA-T3, requires --attach) once live, go silent: swallow every inbound event
             (nothing printed) and send nothing of our own, including no keepalive pings —
             simulates a phone that has gone unresponsive while the connection stays open, for
             manually exercising the counterparty's tolerance of a silent-but-connected peer
"""

let rawArgs = Array(CommandLine.arguments.dropFirst())

// SP2b Task 6: hidden `probe-relay` subcommand -- `health-check.ts`/`bench.ts`'s REAL iroh
// connectivity check (as opposed to a bare HTTPS GET, which only proves the relay's web server
// answers, not that it actually accepts iroh QUIC clients). Binds a throwaway endpoint with
// ONLY the given relay configured (no direct addressing at all — `RelayMode.customFromUrls`,
// the exact same shape `IrohListener`/production dialers use), waits for
// `Endpoint.online()` ("resolves once the endpoint has a usable home relay" — IrohLib's own doc
// comment on that method), then prints `ok` and exits 0. Ten-ish lines per the task brief;
// deliberately NOT wired into the `pair` ceremony above — a fresh, disposable identity per probe.
if rawArgs.first == "probe-relay" {
    guard rawArgs.count == 3, rawArgs[1] == "--url" else {
        out(usage)
        exit(2)
    }
    let relayURL = rawArgs[2]
    let probeSemaphore = DispatchSemaphore(value: 0)
    Task {
        defer { probeSemaphore.signal() }
        do {
            let endpoint = try await Endpoint.bind(options: EndpointOptions(
                preset: presetN0(),
                secretKey: SecretKey.generate().toBytes(),
                relayMode: try RelayMode.customFromUrls(urls: [relayURL])
            ))
            try await withTimeout(20, "probe-relay online") {
                await endpoint.online()
            }
            out("ok")
        } catch {
            out("error: \(error)")
            exit(1)
        }
    }
    probeSemaphore.wait()
    exit(0)
}

guard rawArgs.first == "pair" else { out(usage); exit(2) }

var qrArg: String?
var attach = false
var mute = false
var index = 1
while index < rawArgs.count {
    switch rawArgs[index] {
    case "--qr":
        index += 1
        guard index < rawArgs.count else { out("--qr requires a value\n\(usage)"); exit(2) }
        qrArg = rawArgs[index]
    case "--attach":
        attach = true
    case "--mute":
        mute = true
    default:
        out("unknown argument: \(rawArgs[index])\n\(usage)"); exit(2)
    }
    index += 1
}

guard let qrArg else { out("missing required --qr <base64url|->\n\(usage)"); exit(2) }
guard !mute || attach else { out("--mute requires --attach\n\(usage)"); exit(2) }

let qrString: String
if qrArg == "-" {
    let stdinData = FileHandle.standardInput.readDataToEndOfFile()
    qrString = String(decoding: stdinData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
} else {
    qrString = qrArg
}

struct FakePhoneError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

/// Runs `op` with a hard wall-clock bound — a per-file copy of the same first-wins-race helper
/// `PhonePairingClient.swift`/`IrohE2ETests.swift` carry (this codebase's convention: uniffi's
/// generated async calls ignore Swift task cancellation, so a plain structured timeout would hang
/// right along with a stuck call; on timeout the hung op task is abandoned and this process exits
/// shortly after anyway).
func withTimeout<T>(_ seconds: Double, _ context: String = "", _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    let resumed = OSAllocatedUnfairLock(initialState: false)
    let result: Result<T, Error> = await withCheckedContinuation { cont in
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: .failure(FakePhoneError(message: "timed out: \(context)")))
            }
        }
        Task {
            let r: Result<T, Error>
            do { r = .success(try await op()) } catch { r = .failure(error) }
            timer.cancel()
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: r)
            }
        }
    }
    return try result.get()
}

// MARK: - NDJSON event printing (the `--attach` stream)
//
// SP3 T5: prints `NormaSessionClient`'s already-decoded `SessionEnvelope`/`SessionEvent.JSONValue`
// output — the CLI no longer sees a raw `WireEnvelope` at all (that framing is entirely the
// client's own concern now).

private struct NDJSONLine: Encodable {
    let kind: String
    let seq: Int?
    let sessionID: String?
    let streamID: String?
    let payload: SessionEvent.JSONValue
}

func printEnvelope(_ envelope: SessionEnvelope) {
    let line = NDJSONLine(
        kind: envelope.kind.rawValue, seq: envelope.seq,
        sessionID: envelope.sessionID, streamID: envelope.streamID, payload: envelope.json
    )
    guard let data = try? JSONEncoder().encode(line), let text = String(data: data, encoding: .utf8) else { return }
    out(text)
}

func printJSON(_ value: SessionEvent.JSONValue) {
    guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return }
    out(text)
}

// MARK: - Main

let semaphore = DispatchSemaphore(value: 0)
Task {
    defer { semaphore.signal() }
    do {
        let qr = try QRPayload.decode(base64URL: qrString)

        let (accepted, _, endpointSecret) = try await PhonePairingClient.pair(qr: qr) { words in
            out("words: \(words.joined(separator: " "))")
        }
        out("paired: epoch=\(accepted.epoch) caps=\(accepted.grantedCaps.joined(separator: ","))")

        guard attach else { return }

        // SP3 T5: the reconnect + attach/hello/session.list dance is no longer hand-rolled here —
        // `IrohDialer.dial` (Task 2) resolves the Mac and opens the bidi stream (it has its own
        // internal timeout; no `withTimeout` wrapper needed at this call site), and
        // `NormaSessionClient` (Task 4/4b) drives the ClientHello/resume/idempotency/approval wire
        // protocol. This is the SAME production client the future iOS app links — this file is
        // back to being argv parsing + NDJSON printing, nothing more. Reconnects with the SAME
        // iroh identity (`endpointSecret`) `pair()` just used — a real phone's identity is stable
        // across reconnects, and the ceremony connection above is already closed (single-use).
        let phoneEndpointID = try SecretKey.fromBytes(bytes: endpointSecret).public().description
        // Direct connections only (`relayURLs: []`) — same reasoning as `PhonePairingClient.pair`'s
        // own dial: `qr.relayConfig.config.relays` is cargo for a future real relay fleet (SP2b
        // T6), not necessarily live/dialable today, and actually binding through it can hang.
        let conn = try await IrohDialer.dial(
            secret: endpointSecret, macEndpointID: qr.macEndpointID, alpn: qr.alpn, relayURLs: []
        )

        let client = NormaSessionClient(
            conn: conn, hostID: phoneEndpointID, epoch: accepted.epoch, cursors: InMemoryCursorStore(),
            // CAVEAT: the FIXED clientInstanceID means two concurrently-running fake phones
            // collide in the gateway's per-client state (`sessions`/`revoked` are keyed by this
            // id) — one at a time only. It's also what made the SP2b whole-branch review's
            // revoke-then-re-pair lockout reproducible pre-SP3 (a real phone's id is equally
            // stable across re-pairs).
            clientInstanceID: "norma-fake-phone",
            clock: { Int(Date().timeIntervalSince1970 * 1000) },
            idgen: { UUID().uuidString },
            // KA-T3 `--mute`: an always-false `isActive` means the client's own liveness watchdog
            // never sends a ping either — a truly silent phone, not merely one that stops printing.
            isActive: { !mute }
        )

        let serverHello = try await client.handshake(resumes: [])
        out("helloAck: hostID=\(serverHello.hostID) chosenVersion=\(serverHello.chosenVersion)")

        let list = try await client.send(method: "session.list", params: .object([:]))
        printJSON(list)

        if mute {
            out("muted: swallowing inbound events, sending nothing further (connection stays open)")
        }

        // Keep streaming whatever arrives next (replay-then-live push events) as NDJSON, until the
        // connection closes or this process is killed (Ctrl-C) — a dev observation tool, not a
        // one-shot round trip. Muted: still drain the stream (so replay bookkeeping/cursors keep
        // advancing normally), just swallow every event instead of printing it.
        for await envelope in client.events {
            guard !mute else { continue }
            printEnvelope(envelope)
        }
    } catch {
        out("error: \(error)")
        exit(1)
    }
}
semaphore.wait()
