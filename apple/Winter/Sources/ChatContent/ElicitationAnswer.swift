import AppKit
import Foundation

/// WS-27: the link a URL-mode elicitation card may open, or `nil`. The daemon already declines
/// anything but a plain https url without a card; this is the client's own second check, because
/// the client is what opens it: https only, a host, no credentials before the host. Pure, so the
/// rule is pinned by tests rather than by reading a view.
func elicitationURLToOpen(_ raw: String) -> URL? {
    guard let parts = URLComponents(string: raw),
          parts.scheme?.lowercased() == "https",
          let host = parts.host, !host.isEmpty,
          parts.user == nil, parts.password == nil,
          let url = parts.url else { return nil }
    return url
}

/// WS-27: the one answering step every surface shares, returning the card's error line (`nil` on
/// success). "Open link" opens the link FIRST — the user's click is the only thing that ever opens
/// it — and only then tells the daemon `accept`; a link that will not open is never reported as
/// accepted, and the card stays live for another try. "Decline" only tells the daemon.
@MainActor
func performElicitationAnswer(
    accept: Bool,
    url: String,
    open: (URL) -> Bool,
    send: (Bool) async -> Bool
) async -> String? {
    if accept {
        guard let link = elicitationURLToOpen(url) else { return "this link can't be opened — decline it" }
        guard open(link) else { return "couldn't open the link — try again" }
    }
    return await send(accept) ? nil : "couldn't send — try again"
}

/// The browser opener the live surfaces pass to `performElicitationAnswer`.
@MainActor
func openElicitationLinkInBrowser(_ url: URL) -> Bool {
    NSWorkspace.shared.open(url)
}

extension FieldStateAdapter {
    /// WS-27: the in-flight/error discipline the other respond closures follow — insert and clear
    /// SYNCHRONOUSLY, settle once the answer is sent — around `performElicitationAnswer`.
    /// `send` is the surface's own route to `elicitation.respond`.
    func answerElicitation(_ elicitationId: String, accept: Bool, url: String, send: @escaping (Bool) async -> Bool) {
        interactionInFlight.insert(elicitationId)
        interactionErrors[elicitationId] = nil
        Task { @MainActor [weak self] in
            let error = await performElicitationAnswer(accept: accept, url: url, open: openElicitationLinkInBrowser, send: send)
            self?.interactionInFlight.remove(elicitationId)
            self?.interactionErrors[elicitationId] = error
        }
    }
}
