// editor-plumbing Task 4 — the page's half of the editor bridge.
//
// Two things live here and nothing else: the WIRE VOCABULARY in both directions, and the one
// function that puts a message on the wire. `Sources/AppShell/EditorBridgeCodec.swift` is the other
// half; the two lists below are hand-mirrored with `EditorBridgeInbound.wireTypes` and
// `EditorBridgeOutbound.wireTypes`, and a Swift test compares them literally, including ORDER
// (`EditorPlumbingTests.testTheJavaScriptSideSpeaksExactlyTheSameWireVocabulary`). That is this
// repo's standing discipline for a vocabulary that exists twice in two languages — the same shape
// `REMOTE_ALLOWED_METHODS` and its parity test hold on the daemon side.
//
// SHAPE CONSTRAINT, not house style: each list must be a PLAIN array literal assigned directly to
// its name. The Swift reader accepts only whitespace and `=` between the name and the opening `[`,
// so wrapping the literal in `Object.freeze(...)` would leave the pin unable to find the
// declaration at all — it would report a drift that does not exist. Freezing happens below, as its
// own statement, which the reader never looks at.

// Page -> Swift. Every name here is one `EditorBridgeInbound` case.
export const INBOUND_MESSAGE_TYPES = ["ready", "modelDirtyChanged", "saveRequested", "contentResponse"];

// Swift -> page. Every name here is one `EditorBridgeOutbound` case, and one arm of the page's
// `dispatch` switch (`editor.js`).
export const OUTBOUND_MESSAGE_TYPES = ["openModel", "activateModel", "closeModel", "pullContent", "applyExternalContent", "setTheme"];

Object.freeze(INBOUND_MESSAGE_TYPES);
Object.freeze(OUTBOUND_MESSAGE_TYPES);

/**
 * Send one message to Swift over CEF's message router.
 *
 * `window.cefQuery` is installed into every V8 context by the renderer-side router
 * (`NormaSubprocessApp`, Task 3), so it exists on any page in any Norma browser — the editor page
 * is simply the one that uses it. One request, one reply: `persistent: false` is not a default
 * being restated, it is the protocol (Task 3's handler refuses a persistent query out loud).
 *
 * Failures are LOGGED rather than swallowed. Task 5's live harness is the first execution of any of
 * this, and a silent -1 (the router's own "canceled" code, e.g. no Swift handler registered yet)
 * would waste that run.
 */
export function sendToSwift(type, payload = {}) {
    if (INBOUND_MESSAGE_TYPES.indexOf(type) < 0) {
        console.error("normaEditor: refusing to send an unknown message type:", type);
        return;
    }
    if (typeof window.cefQuery !== "function") {
        console.error("normaEditor: window.cefQuery is missing — the bridge is not wired; dropped:", type);
        return;
    }
    window.cefQuery({
        // `type` is applied LAST so a payload can never shadow it — Swift's decode switches on that
        // one member, and a message whose type came from a caller's payload is a message this
        // function did not send.
        request: JSON.stringify(Object.assign({}, payload, { type: type })),
        persistent: false,
        onSuccess: function () {},
        onFailure: function (code, message) {
            console.error("normaEditor: " + type + " failed (code " + code + "):", message);
        }
    });
}
