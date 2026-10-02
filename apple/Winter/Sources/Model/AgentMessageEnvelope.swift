import Foundation

/// A message ANOTHER Winter session sent into this one. The daemon appends it as a `user_message`
/// with `clientName: "messaging"` whose text is a wrapper the sender built:
///
///     <agent-message from="session:s_1a2b3c4d" message-id="msg-3" sender-permission-class="prompts">
///     <summary>run the tests</summary>
///     please also run the tests
///     </agent-message>
///
/// The `<summary>` line is optional. The sender escaped the text it wrapped — inside the body and
/// summary every `</agent-message` became `&lt;/agent-message` and every `<agent-message` became
/// `&lt;agent-message`; inside attribute values `"` also became `&quot;` — and `parse` reverses
/// exactly those substitutions and no others.
///
/// `parse` is the ONE reader: `SessionReducer` calls it once when it folds the event (the parsed
/// sender rides on the `Exchange`), so no view ever sees raw XML. Anything that is not exactly this
/// shape returns `nil` and the text renders as it always has — never a crash, never dropped text.
struct AgentMessageEnvelope: Equatable {
    /// The `from` attribute, unescaped: `session:<id>` (or, occasionally, `agent:<parent>:<child>`).
    let from: String
    let messageId: String?
    let senderPermissionClass: String?
    /// The optional `<summary>` line, unescaped; `nil` when absent (or empty).
    let summary: String?
    /// What the sender wrote, unescaped — the bubble's ordinary content.
    let body: String

    /// The sender's session id for a `session:<id>` origin; `nil` for any other origin.
    var sessionId: String? {
        guard from.hasPrefix("session:") else { return nil }
        let id = String(from.dropFirst("session:".count))
        return id.isEmpty ? nil : id
    }

    /// The header's label — "From session <title or id>". `titleFor` answers a session's title when
    /// the surface has one cheaply (the sidebar's list); it is never required.
    func senderLabel(titleFor: ((String) -> String?)? = nil) -> String {
        if let id = sessionId {
            let title = titleFor?(id)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return "From session \(title.isEmpty ? id : title)"
        }
        if from.hasPrefix("agent:") {
            // `agent:<parent>:<child>` — the child is the sender.
            let parts = from.split(separator: ":", omittingEmptySubsequences: false)
            if parts.count == 3, !parts[2].isEmpty { return "From agent \(parts[2])" }
        }
        return "From \(from)"
    }

    private static let openTag = "<agent-message"
    private static let closeTag = "</agent-message>"

    /// The wrapper's parsed form, or `nil` when `text` is not exactly one well-formed envelope.
    static func parse(_ text: String) -> AgentMessageEnvelope? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix(#"<agent-message from=""#), t.hasSuffix(closeTag) else { return nil }

        // Attributes: `name="value"` pairs up to the tag's `>`. A value ends at the next `"` (the
        // sender escaped every inner one), so a `>` inside a value cannot end the tag early.
        var i = t.index(t.startIndex, offsetBy: openTag.count)
        var attributes: [String: String] = [:]
        var tagEnd: String.Index?
        scan: while i < t.endIndex {
            while i < t.endIndex, t[i].isWhitespace { i = t.index(after: i) }
            guard i < t.endIndex else { return nil }
            if t[i] == ">" { tagEnd = t.index(after: i); break scan }
            var name = ""
            while i < t.endIndex, t[i].isLetter || t[i] == "-" { name.append(t[i]); i = t.index(after: i) }
            guard !name.isEmpty, i < t.endIndex, t[i] == "=" else { return nil }
            i = t.index(after: i)
            guard i < t.endIndex, t[i] == "\"" else { return nil }
            i = t.index(after: i)
            guard let close = t[i...].firstIndex(of: "\"") else { return nil }
            attributes[name] = unescapeAttribute(String(t[i..<close]))
            i = t.index(after: close)
        }
        guard let tagEnd, let from = attributes["from"], !from.isEmpty else { return nil }

        // Everything between the opening tag and the final closing tag. A RAW closing or opening tag
        // in there means two envelopes (or an unescaped sender): not ours to guess at.
        let closeStart = t.index(t.endIndex, offsetBy: -closeTag.count)
        guard tagEnd <= closeStart else { return nil }
        var inner = String(t[tagEnd..<closeStart])
        if inner.contains("</agent-message") || inner.contains(openTag) { return nil }

        // One newline after the opening tag and one before the closing tag are the wrapper's own.
        if inner.hasPrefix("\r\n") { inner.removeFirst(2) } else if inner.hasPrefix("\n") { inner.removeFirst() }
        if inner.hasSuffix("\r\n") { inner.removeLast(2) } else if inner.hasSuffix("\n") { inner.removeLast() }

        var summary: String?
        if inner.hasPrefix("<summary>"), let end = inner.range(of: "</summary>") {
            let s = String(inner[inner.index(inner.startIndex, offsetBy: "<summary>".count)..<end.lowerBound])
            var rest = String(inner[end.upperBound...])
            if rest.hasPrefix("\r\n") { rest.removeFirst(2) } else if rest.hasPrefix("\n") { rest.removeFirst() }
            let unescaped = unescapeBody(s).trimmingCharacters(in: .whitespacesAndNewlines)
            summary = unescaped.isEmpty ? nil : unescaped
            inner = rest
        }

        return AgentMessageEnvelope(
            from: from,
            messageId: attributes["message-id"],
            senderPermissionClass: attributes["sender-permission-class"],
            summary: summary,
            body: unescapeBody(inner)
        )
    }

    /// Reverses the sender's body escaping — exactly these two substitutions.
    private static func unescapeBody(_ s: String) -> String {
        s.replacingOccurrences(of: "&lt;/agent-message", with: "</agent-message")
            .replacingOccurrences(of: "&lt;agent-message", with: "<agent-message")
    }

    /// Reverses the sender's attribute escaping: the body's two plus `&quot;`.
    private static func unescapeAttribute(_ s: String) -> String {
        unescapeBody(s).replacingOccurrences(of: "&quot;", with: "\"")
    }
}
