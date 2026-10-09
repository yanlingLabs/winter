// A minimal NDJSON JSON-RPC client for the live suite's daemon (the same wire every Winter client speaks): hello as a
// local harness, calls, and every pushed session event kept in order so a scenario can wait for its own.
import { ConnWriter, encodeLine, LineDecoder, METHODS, PROTOCOL_VERSION, type SessionEvent, type WritableSocket } from "../../packages/protocol/src/index";

type Reply = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

export class DaemonClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (r: Reply) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: SessionEvent[] = [];
  closed = false;

  static async connect(socketPath: string): Promise<DaemonClient> {
    const c = new DaemonClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            let msg: { id?: number; method?: string; params?: unknown } & Reply;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else if (msg.method === METHODS.event) c.events.push(msg.params as SessionEvent);
          }
        },
        drain() { c.writer.onDrain(); },
        close() { c.closed = true; },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }

  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<Reply> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
    });
  }

  async call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const r = await this.request(method, params, timeoutMs);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
  }

  async hello(token: string, clientName: string): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }

  /** The first event from index `from` on that `pred` accepts, polling until `ms`. */
  async waitFor(pred: (e: SessionEvent) => boolean, ms: number, from = 0, onTick?: () => void): Promise<SessionEvent> {
    const t0 = Date.now();
    for (;;) {
      for (let i = from; i < this.events.length; i++) if (pred(this.events[i]!)) return this.events[i]!;
      if (this.closed) throw new Error("the daemon closed the connection");
      if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for an event`);
      onTick?.();
      await Bun.sleep(25);
    }
  }

  close(): void {
    try { this.socket.end(); } catch { /* closed */ }
  }
}
