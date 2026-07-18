import Foundation
import os
import IrohLib
import NormaProtocol

/// Errors `PhonePairingClient` itself can throw — distinct from whatever `Endpoint.bind`/
/// `Endpoint.connect`/`EndpointId.fromString` throw (those propagate unchanged).
public enum PhonePairingError: Error, Equatable {
    /// The peer this phone dialed doesn't hold the identity the QR promised — the SP2b global
    /// rule ("dialer must verify remoteId() == qr.macEndpointID") exists precisely to catch a
    /// MITM/relay mix-up before any secret material is sent.
    case macIdentityMismatch
    /// The Mac refused the pairing request. `code` mirrors `PairRejected.code` — one of
    /// `"expired"`, `"bad_request"`, `"bad_proof"`, `"rate_limited"`, `"cap_reached"`,
    /// `"internal_error"`, `"denied"`, `"timeout"`.
    case rejected(code: String)
    /// The connection closed before a `PairAccepted`/`PairRejected` frame arrived.
    case noResponse
    /// A frame arrived whose `type` field is neither `"pair_accepted"` nor `"pair_rejected"`.
    case malformedResponse
}

/// The phone side of the pairing ceremony (SP2b Task 5 — an SP3 seed for the real iOS app):
/// dials the Mac named in a scanned `QRPayload`, proves possession of the QR's `pairSecret`,
/// surfaces the 4-word SAS for a human to compare, and returns once the Mac answers. Extracted
/// from `PairingE2ETests.pairPhone`'s hand-rolled frames (SP2b Task 4 — see that file's own
/// history) so both that test and `norma-fake-phone` share ONE real implementation of the wire
/// dance instead of two hand-rolled copies drifting apart.
///
/// **Words before the answer.** `onWords` fires the instant this side has computed its own SAS
/// — a real phone never waits on the Mac's human to know its own half of the ceremony; the
/// words are ONLY a function of `qr.pairSecret` and the transcript (`PairingCrypto.sasWords`),
/// both already known to the phone before it even dials.
///
/// **Never logs** `qr.pairSecret`, the request/response payloads, or anything beyond the already
/// -public SAS words (via `onWords`) and the return value — a caller (e.g. `norma-fake-phone`)
/// is on its own recognizance not to print `endpointSecret` (the phone's own identity key, not
/// the Mac's `pairSecret` — still never echoed back over the wire, but sensitive enough that a
/// CLI must not casually print it either).
///
/// **Single-use connection.** Mirrors `PairingE2ETests.pairPhone`'s own documented behavior: the
/// connection this dials is the bare, `WireEnvelope`-less ceremony channel
/// (`PairingManager.handleConnection`'s own contract) — it is closed before `pair` returns
/// (success or failure). Post-pairing traffic (a real `ClientHello`/`WireEnvelope` session) is a
/// FRESH connection, same iroh identity (`endpointSecret`), dialed separately — exactly what
/// `norma-fake-phone --attach` does.
public enum PhonePairingClient {
    /// Bounds the wait for the Mac's answer once the request is sent — comfortably past
    /// `PairingManager`'s own 120s confirm-timeout (SP2b global constraint) so a real human
    /// deciding on the Mac is never cut off early, while still failing loudly (not hanging
    /// forever) against a genuinely wedged connection. iroh-ffi's generated async calls ignore
    /// Swift task cancellation (confirmed empirically in this package's own E2E tests), so the
    /// bound below is a first-wins race between two unstructured tasks — the same `withTimeout`
    /// idiom `IrohE2ETests`/`PairingE2ETests` already use, duplicated per this codebase's own
    /// convention for such test-adjacent helpers.
    private static let responseTimeoutSeconds: Double = 150

    /// Bounds dialing + opening the ceremony's bidi stream — a much shorter bound than
    /// `responseTimeoutSeconds` above, since this is "can we even reach the Mac at all" (network/
    /// discovery), not "is a human still deciding."
    private static let dialTimeoutSeconds: Double = 20

    /// v1 only ever requests this capability (mirrors `PairingManager.sessionCaps`).
    private static let sessionCaps = ["sessions"]

    public static func pair(
        qr: QRPayload,
        bindAddr: String? = nil,
        secret: Data = SecretKey.generate().toBytes(),
        onWords: @escaping @Sendable ([String]) -> Void
    ) async throws -> (accepted: PairAccepted, words: [String], endpointSecret: Data) {
        try await pairInternal(qr: qr, bindAddr: bindAddr, secret: secret, addrOverride: nil, onWords: onWords)
    }

    /// Test-only seam (reachable via `@testable import` — `internal`, no `#if DEBUG` needed since
    /// nothing about this signature is unsafe to compile into a Release build, unlike
    /// `RemoteHost`'s Keychain-avoiding seams): dials `addrOverride` directly instead of deriving
    /// an `EndpointAddr` from `qr.macEndpointID`/`qr.relayConfig` — production has no
    /// relay/discovery wired yet (SP2b T6's own job; see `RemoteHost.Config.relayURLs`'s own
    /// comment), so a hermetic test has nothing else to dial through. Mirrors `RemoteHost`'s own
    /// `#if DEBUG` `makeListener` seam for the identical reason (`task-0-report.md`: in-process
    /// tests always dial via a pinned direct `EndpointAddr`, never discovery).
    static func pairInternal(
        qr: QRPayload,
        bindAddr: String?,
        secret: Data,
        addrOverride: EndpointAddr?,
        relayURLs: [String] = [],
        onWords: @escaping @Sendable ([String]) -> Void
    ) async throws -> (accepted: PairAccepted, words: [String], endpointSecret: Data) {
        let phoneEndpointID = try SecretKey.fromBytes(bytes: secret).public().description
        let phoneInstallNonce = PairingManager.systemRandom(16)

        // Pure crypto — no I/O, no networking — computed BEFORE dialing anything, exactly like a
        // real phone would: both the proof it's about to present and the SAS it's about to show
        // a human are functions only of the QR's own contents.
        let transcript = PairingCrypto.transcript(
            v: qr.v, pairID: qr.pairID, macEndpointID: qr.macEndpointID,
            phoneEndpointID: phoneEndpointID, phoneInstallNonce: phoneInstallNonce, caps: Self.sessionCaps
        )
        let proof = PairingCrypto.proof(pairSecret: qr.pairSecret, transcript: transcript)
        let words = PairingCrypto.sasWords(pairSecret: qr.pairSecret, transcript: transcript)

        // Direct connections only by default — deliberately NOT derived from
        // `qr.relayConfig.config.relays`. `RemoteHost.Config.relayURLs`'s own doc comment is the
        // reason why: a verified `SignedRelayConfig`'s `config.relays` and "what THIS Mac's own
        // listener actually dials through" are allowed to differ. Empirically confirmed while
        // wiring this up (`PairingE2ETests`'s own QR fixture carries a placeholder, non-existent
        // relay hostname purely to exercise the QR's field encoding): actually binding a dialer
        // through `RelayMode.customFromUrls` against an unreachable relay hangs trying to reach
        // it. `relayURLs` (SP2b Task 6, default `[]` — every existing caller is unaffected) is the
        // test-only seam `IrohRelayE2ETests` uses to force a relay-mode dialer against the real
        // production relay fleet instead.
        let dialer = try await Endpoint.bind(options: EndpointOptions(
            preset: presetN0(), bindAddr: bindAddr, secretKey: secret,
            relayMode: relayURLs.isEmpty ? .disabled() : try RelayMode.customFromUrls(urls: relayURLs)
        ))

        let macAddr = try addrOverride ?? EndpointAddr(
            id: EndpointId.fromString(s: qr.macEndpointID),
            relayUrl: nil,
            addresses: []
        )
        let alpnData = Data(qr.alpn.utf8)
        // Bounded — iroh-ffi's generated async calls ignore Swift task cancellation (this
        // codebase's own established, verified finding; every iroh dial/connect call elsewhere
        // wraps this identically — `PhoneConn.dial`'s own `withTimeout(15, ...)`), so an
        // unreachable/misconfigured peer (no relay, no direct route) would otherwise hang this
        // function forever instead of failing loudly.
        let (conn, bi): (Connection, BiStream) = try await withTimeout(Self.dialTimeoutSeconds, "PhonePairingClient.pair dial") {
            let conn = try await dialer.connect(addr: macAddr, alpn: alpnData)
            // SP2b global rule: verify the peer we actually reached is who the QR promised
            // BEFORE sending anything secret-derived over the connection.
            guard conn.remoteId().description == qr.macEndpointID else {
                try? conn.close(errorCode: 0, reason: Data())
                throw PhonePairingError.macIdentityMismatch
            }
            let bi = try await conn.openBi()
            return (conn, bi)
        }
        defer {
            try? conn.close(errorCode: 0, reason: Data())
            Task { try? await dialer.close() }
        }
        let send = bi.send()
        let recv = bi.recv()

        let request = PairRequest(
            type: "pair_request", pairID: qr.pairID, phoneEndpointID: phoneEndpointID,
            phoneInstallNonce: phoneInstallNonce, caps: Self.sessionCaps, proof: proof
        )
        // Raw JSON, `LengthPrefix`-framed WITHOUT a `WireEnvelope` wrapper — the phone hasn't
        // paired yet, so there's no epoch/hostID to validate one against (mirrors
        // `PairingManager.handleConnection`'s own bare decode).
        let requestData = try JSONEncoder().encode(request)
        try await send.writeAll(buf: LengthPrefix.wrap(requestData))

        // The words are ONLY a function of what's already known — surface them for display
        // BEFORE awaiting anything the Mac's human has to act on.
        onWords(words)

        let responseData = try await withTimeout(Self.responseTimeoutSeconds, "PhonePairingClient.pair") {
            var buffer = Data()
            while true {
                if let frame = try LengthPrefix.unwrap(&buffer, maxBytes: 1 << 20) {
                    return frame
                }
                let chunk = try await recv.read(sizeLimit: 4096)
                guard !chunk.isEmpty else { throw PhonePairingError.noResponse }
                buffer.append(chunk)
            }
        }

        struct WireTypeTag: Decodable { let type: String }
        guard let tag = try? JSONDecoder().decode(WireTypeTag.self, from: responseData) else {
            throw PhonePairingError.malformedResponse
        }
        switch tag.type {
        case "pair_accepted":
            let accepted = try JSONDecoder().decode(PairAccepted.self, from: responseData)
            return (accepted: accepted, words: words, endpointSecret: secret)
        case "pair_rejected":
            let rejected = try JSONDecoder().decode(PairRejected.self, from: responseData)
            throw PhonePairingError.rejected(code: rejected.code)
        default:
            throw PhonePairingError.malformedResponse
        }
    }
}

private struct PhonePairingTimeoutError: Error, CustomStringConvertible {
    let context: String
    var description: String { "timed out: \(context)" }
}

/// Runs `op` with a hard wall-clock bound. A per-file copy of `IrohE2ETests`'/`IrohListenerTests`'
/// own `withTimeout` (this codebase's established convention for this exact helper — iroh-ffi's
/// generated async calls ignore Swift task cancellation, so an unbounded await would hang instead
/// of failing loudly on a regression): a first-wins race between two UNSTRUCTURED tasks (not a
/// `withThrowingTaskGroup`, which awaits every child on scope exit and would hang right along with
/// a stuck child).
private func withTimeout<T>(_ seconds: Double, _ context: String = "", _ op: @escaping @Sendable () async throws -> T) async throws -> T {
    let resumed = OSAllocatedUnfairLock(initialState: false)
    let result: Result<T, Error> = await withCheckedContinuation { cont in
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            if resumed.withLock({ let was = $0; $0 = true; return !was }) {
                cont.resume(returning: .failure(PhonePairingTimeoutError(context: context)))
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
