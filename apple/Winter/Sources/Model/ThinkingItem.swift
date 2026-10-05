import WinterSessionKit

/// One reasoning block — the "thinking pill" (2026-10-05). The fold lives in the shared kit
/// (`WinterSessionKit.ThinkingItem`) so the phone folds `thinking_delta`/`thinking_block` exactly as
/// `SessionReducer` does; this app-module alias keeps every Mac file that names the type compiling
/// without importing `WinterSessionKit` itself (the `AgentMessageEnvelope` precedent).
typealias ThinkingItem = WinterSessionKit.ThinkingItem
