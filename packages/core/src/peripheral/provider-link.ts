import { encodeLine, METHODS, SessionEvent, type ConnWriter, type NewSessionEvent } from "@winter/protocol";

/** Bridges `PeripheralBroker`'s `pushToProvider` dependency (a plain data-in/bool-out function,
 *  injected at broker-construction time in daemon.ts, long before any socket connections exist)
 *  to whichever live connection `packages/core/src/ipc/server.ts` currently recognizes as THE
 *  peripheral provider (spec/plan pin: "provider = the connection that most recently sent
 *  peripheral.advertise").
 *
 *  The broker only tracks provider CONNECTION IDENTITY (an opaque `unknown` reference, compared
 *  by `===` via `isProvider()`) — it deliberately never touches raw sockets. Only the ipc server
 *  owns actual `ConnWriter`s. This class is the seam: daemon.ts constructs ONE instance and hands
 *  it to both sides — `broker.pushToProvider = (event) => link.push(event)`, and
 *  `IpcServerOptions.providerLink = link` so the server's `peripheral.advertise` handler and its
 *  socket `close()` handler can call `setWriter()` as the provider connection changes.
 *
 *  `push()` stamps `seq`/`ts` itself (the broker hands over bare `NewSessionEvent`s, exactly like
 *  `hub.broadcastTransient` does for `assistant_delta` — see the Task 2 report's contract notes)
 *  since this event never goes through `SessionStore`/`SessionHub` (it is targeted at a specific
 *  connection, not a session's attachments) and so has no persisted seq of its own. `seq` here is
 *  a locally-monotonic counter — informational only; correlation is by `requestId`, not `seq`. */
export class ProviderLink {
  private writer: ConnWriter | null = null;
  private seq = 0;

  setWriter(writer: ConnWriter | null): void {
    this.writer = writer;
  }

  /** True if a provider connection is currently linked (used by callers that want to short-circuit
   *  before even building an event — the broker itself already treats a `false` return from this
   *  as "no provider", so this is a convenience, not a correctness requirement). */
  get connected(): boolean {
    return this.writer !== null;
  }

  push(event: NewSessionEvent): boolean {
    if (!this.writer) return false;
    const full = SessionEvent.parse({ ...event, seq: this.seq++, ts: Date.now() });
    try {
      return this.writer.enqueue(encodeLine({ jsonrpc: "2.0", method: METHODS.event, params: full }));
    } catch {
      return false;
    }
  }
}
