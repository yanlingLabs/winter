import Foundation
import IrohLib
import NormaKit
import NormaProtocol

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

let usage = "usage: norma-fake-phone pair --qr <base64url|-> [--attach]"

let rawArgs = Array(CommandLine.arguments.dropFirst())
guard rawArgs.first == "pair" else { out(usage); exit(2) }

var qrArg: String?
var attach = false
var index = 1
while index < rawArgs.count {
    switch rawArgs[index] {
    case "--qr":
        index += 1
        guard index < rawArgs.count else { out("--qr requires a value\n\(usage)"); exit(2) }
        qrArg = rawArgs[index]
    case "--attach":
        attach = true
    default:
        out("unknown argument: \(rawArgs[index])\n\(usage)"); exit(2)
    }
    index += 1
}

guard let qrArg else { out("missing required --qr <base64url|->\n\(usage)"); exit(2) }

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

// MARK: - NDJSON event printing (the `--attach` stream)

private struct NDJSONLine: Encodable {
    let kind: String
    let seq: Int?
    let sessionID: String?
    let streamID: String?
    let payload: JSONValue?
}

func printFrame(_ envelope: WireEnvelope) {
    let payload = try? JSONDecoder().decode(JSONValue.self, from: envelope.payload)
    let line = NDJSONLine(
        kind: envelope.kind.rawValue, seq: envelope.seq,
        sessionID: envelope.sessionID, streamID: envelope.streamID, payload: payload
    )
    guard let data = try? JSONEncoder().encode(line), let text = String(data: data, encoding: .utf8) else { return }
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

        // ClientHello + WireEnvelope attach dance — duplicated (not imported; test targets can't
        // be imported from an executable target) from `PairingE2ETests.swift`/`IrohE2ETests.swift`'s
        // own `PhoneConn` dial/hello/rpcRequest plumbing. Reconnects with the SAME iroh identity
        // (`endpointSecret`) `pair()` just used — a real phone's identity is stable across
        // reconnects, and the ceremony connection above is already closed (single-use).
        let phoneEndpointID = try SecretKey.fromBytes(bytes: endpointSecret).public().description
        // Direct connections only — same reasoning as `PhonePairingClient.pair`'s own dial:
        // `qr.relayConfig.config.relays` is cargo for a future real relay fleet (SP2b T6), not
        // necessarily live/dialable today, and actually binding through it can hang.
        let dialer = try await Endpoint.bind(options: EndpointOptions(
            preset: presetN0(), secretKey: endpointSecret, relayMode: .disabled()
        ))
        let macAddr = try EndpointAddr(
            id: EndpointId.fromString(s: qr.macEndpointID), relayUrl: nil, addresses: []
        )
        let conn = try await dialer.connect(addr: macAddr, alpn: Data(qr.alpn.utf8))
        guard conn.remoteId().description == qr.macEndpointID else {
            throw FakePhoneError(message: "mac identity mismatch on attach reconnect")
        }
        let bi = try await conn.openBi()
        let send = bi.send()
        let recv = bi.recv()
        var buffer = Data()

        func sendEnvelope(kind: WireKind, payload: Data) async throws {
            let envelope = WireEnvelope(
                v: 1, pairingEpoch: accepted.epoch, hostID: phoneEndpointID, sessionID: nil,
                streamID: nil, seq: nil, kind: kind, timestamp: Int(Date().timeIntervalSince1970), payload: payload
            )
            try await send.writeAll(buf: LengthPrefix.wrap(try WireFrame.encode(envelope)))
        }

        func readFrame() async throws -> WireEnvelope {
            while true {
                if let frame = try LengthPrefix.unwrap(&buffer, maxBytes: 1 << 20) {
                    return try WireFrame.decode(frame, expectedEpoch: accepted.epoch)
                }
                let chunk = try await recv.read(sizeLimit: 4096)
                guard !chunk.isEmpty else { throw FakePhoneError(message: "connection closed") }
                buffer.append(chunk)
            }
        }

        let hello = ClientHello(
            protocolVersions: [1], appBuild: "norma-fake-phone",
            clientInstanceID: "norma-fake-phone", pairingEpoch: accepted.epoch, resumes: []
        )
        try await sendEnvelope(kind: .hello, payload: try JSONEncoder().encode(hello))
        printFrame(try await readFrame()) // helloAck

        let listRequest = JSONValue.object([
            "jsonrpc": .string("2.0"), "id": .number(1), "method": .string("session.list"),
        ])
        try await sendEnvelope(kind: .rpcRequest, payload: try JSONEncoder().encode(listRequest))
        printFrame(try await readFrame()) // session.list's rpcResponse

        // Keep streaming whatever arrives next (live push events) as NDJSON, until the
        // connection closes or this process is killed (Ctrl-C) — a dev observation tool, not a
        // one-shot round trip.
        while true {
            printFrame(try await readFrame())
        }
    } catch {
        out("error: \(error)")
        exit(1)
    }
}
semaphore.wait()
