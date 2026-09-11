// THE per-call session identity for capability servers — the host-side answer to a router seam
// that does not exist yet.
//
// ⚠️ ROUTER 0.0.3 CARRY. `WinterMcpServerInstance.callTool(name, args)` takes no session: the SDK's
// `sdk_mcp_call` bridge invokes `cfg.instance.callTool(req.tool ?? "", req.arguments ?? {})` and the
// control request carries `server`/`tool`/`arguments` only. Capability servers are construction-
// time and SHARED across every session on the handle (surface map §1.7), so an in-process server
// genuinely cannot tell who is calling it. The fix belongs upstream — `callTool(name, args, ctx)`
// with the calling session's id and mode — and until it lands the host binds it.
//
// WHAT MAKES THE HOST-SIDE BINDING SOUND TODAY, stated as a precondition rather than assumed: ONE
// daemon process, and at most ONE running turn per session, with the session driver (Task 16)
// binding immediately before it pushes a prompt and unbinding when that turn's `result` arrives.
// Tool calls inside a turn are awaited by the child before the turn ends, so the binding is live
// for every call it can make. What is NOT sound, and is the reason `bind` returns a restoring
// release rather than a clear: two sessions running turns CONCURRENTLY. The stack discipline below
// keeps a nested bind honest, but it cannot make two interleaved async turns correct — which is
// exactly why the last-resort answer is `undefined` (a typed refusal in `server.ts`) and never a
// default session: a capability that guessed would open a browser tab, take a screenshot lease or
// stop a worker against somebody else's transcript.
import type { CapabilitySession } from "./server";

export interface CapabilitySessionBinding {
  /** What `buildCapabilities`' `currentSession` reads. `undefined` ⇒ nothing is bound. */
  current(): CapabilitySession | undefined;
  /** Bind `session` for the duration of a turn. Returns a release that restores the PREVIOUS
   *  binding (not `undefined`), so a nested bind — a capability call that itself drives a turn —
   *  cannot silently unbind its caller. Releasing twice is a no-op. */
  bind(session: CapabilitySession): () => void;
}

export function createCapabilitySessionBinding(): CapabilitySessionBinding {
  let current: CapabilitySession | undefined;
  return {
    current: () => current,
    bind(session: CapabilitySession): () => void {
      const previous = current;
      current = session;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        current = previous;
      };
    },
  };
}
