import AppKit
import Foundation

/// WS-27: what a surface's `elicitation.respond` came back with.
enum ElicitationSendResult: Equatable {
    case sent
    /// `alreadyResolved: true` — the daemon had already stopped waiting on this card.
    case inactive
    case failed
}

/// WS-27: how an Open link / Decline click ended, for the card.
enum ElicitationAnswerResult: Equatable {
    case done
    /// The request is gone (answered elsewhere, cancelled, expired, or the daemon restarted): the card
    /// is resolved locally with "this request is no longer active".
    case inactive
    case error(String)
}

/// The inline note an inactive card shows, and its frozen record's provenance line.
let elicitationInactiveNote = "this request is no longer active"

/// WS-27: whether a card is past its `expiresAt` (epoch ms) — its "Open link" is disabled from then on.
func elicitationIsExpired(expiresAt: Int, now: Date = Date()) -> Bool {
    now.timeIntervalSince1970 * 1000 >= Double(expiresAt)
}

/// WS-27: the link a URL-mode elicitation card may open, or `nil`. The url is fetched from the daemon
/// only when the user clicks "Open link"; this is the client's own check on what came back before
/// anything opens: https only, no credentials before the host, and the host (with its port, if any)
/// is exactly the one the card showed. Pure, so the rule is pinned by tests.
func elicitationURLToOpen(_ raw: String, expectedHost: String) -> URL? {
    guard let parts = URLComponents(string: raw),
          parts.scheme?.lowercased() == "https",
          let host = parts.host, !host.isEmpty,
          parts.user == nil, parts.password == nil,
          let url = parts.url else { return nil }
    let shown = parts.port.map { "\(host):\($0)" } ?? host
    guard shown.lowercased() == expectedHost.lowercased() else { return nil }
    return url
}

/// WS-27: the one answering step every surface shares. "Open link" fetches the url (it is never on the
/// card), checks it against the card's host, opens it — the user's click is the only thing that ever
/// opens it — and only then tells the daemon `accept`; a link that will not open is never reported as
/// accepted. "Decline" only tells the daemon.
@MainActor
func performElicitationAnswer(
    accept: Bool,
    host: String,
    expiresAt: Int,
    now: Date = Date(),
    fetchURL: () async -> String?,
    open: (URL) -> Bool,
    send: (Bool) async -> ElicitationSendResult
) async -> ElicitationAnswerResult {
    if accept {
        if elicitationIsExpired(expiresAt: expiresAt, now: now) { return .inactive }
        guard let raw = await fetchURL() else { return .inactive }
        guard let link = elicitationURLToOpen(raw, expectedHost: host) else {
            return .error("the link doesn't match \(host) — not opened")
        }
        guard open(link) else { return .error("couldn't open the link — try again") }
    }
    switch await send(accept) {
    case .sent: return .done
    case .inactive: return .inactive
    case .failed: return .error("couldn't send — try again")
    }
}

/// The browser opener the live surfaces pass to `performElicitationAnswer`.
@MainActor
func openElicitationLinkInBrowser(_ url: URL) -> Bool {
    NSWorkspace.shared.open(url)
}

extension FieldStateAdapter {
    /// WS-27: the in-flight/error discipline the other respond closures follow — insert and clear
    /// SYNCHRONOUSLY, settle once the answer is sent — around `performElicitationAnswer`. `fetchURL`
    /// and `send` are the surface's own routes to `elicitation.url`/`elicitation.respond`. An inactive
    /// request resolves the card locally (`inactiveElicitations`).
    func answerElicitation(_ elicitationId: String, accept: Bool, host: String, expiresAt: Int,
                           fetchURL: @escaping () async -> String?,
                           send: @escaping (Bool) async -> ElicitationSendResult) {
        interactionInFlight.insert(elicitationId)
        interactionErrors[elicitationId] = nil
        Task { @MainActor [weak self] in
            let result = await performElicitationAnswer(accept: accept, host: host, expiresAt: expiresAt,
                                                        fetchURL: fetchURL, open: openElicitationLinkInBrowser, send: send)
            self?.interactionInFlight.remove(elicitationId)
            switch result {
            case .done: break
            case .inactive: self?.inactiveElicitations.insert(elicitationId)
            case .error(let line): self?.interactionErrors[elicitationId] = line
            }
        }
    }
}

/// WS-27: a WinterKit `elicitation.respond` outcome as a card reads it.
func elicitationSendResult(alreadyResolved: Bool?) -> ElicitationSendResult {
    guard let alreadyResolved else { return .failed }
    return alreadyResolved ? .inactive : .sent
}
