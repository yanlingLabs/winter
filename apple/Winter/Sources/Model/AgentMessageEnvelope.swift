import WinterSessionKit

/// A message ANOTHER Winter session sent into this one (`clientName: "messaging"`) — the parser now
/// lives in the shared kit (`WinterSessionKit.AgentMessageEnvelope`, 2026-10-02) so the phone renders
/// the same "From session …" header from the same reader. This app-module alias keeps every Mac file
/// that names the type compiling without importing `WinterSessionKit` itself.
typealias AgentMessageEnvelope = WinterSessionKit.AgentMessageEnvelope
