// Winter for Chrome — the one native-messaging port to `winter-browser-host`, kept open while the browser runs (an open
// native port keeps an MV3 service worker alive, Chrome 105+), reconnected with a 1 s → 30 s backoff. The host relays
// to Winter; it tells the extension how that link stands with `host.status`, and on `connected` the extension says
// `hello` (its protocol, version and instance id) and is then driven by the daemon's requests.
import type { ChromeApi, ChromePort, Clock } from "./chrome-api";
import { realClock } from "./chrome-api";
import { ExtensionError, UnknownMethod, type ExtensionController } from "./controller";
import { EXTENSION_PROTOCOL, RPC_ERROR, RPC_METHOD_NOT_FOUND } from "./protocol";
import type { StatusBoard } from "./status";

const INSTANCE_KEY = "instanceId";
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/** After a hello the daemon refused for a reason that may pass (no browser engine yet), say hello again this much later. */
const HELLO_RETRY_MS = 30_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ConnectionOptions {
  hostName: string;
  clock?: Clock;
  log?(line: string): void;
}

export class HostConnection {
  private port: ChromePort | undefined;
  private backoff = BACKOFF_MIN_MS;
  private nextId = 1;
  private helloId: string | undefined;
  private retryTimer: unknown;
  private instanceId: string | undefined;
  private readonly clock: Clock;

  constructor(
    private readonly chrome: ChromeApi,
    private readonly controller: ExtensionController,
    private readonly status: StatusBoard,
    private readonly opts: ConnectionOptions,
  ) {
    this.clock = opts.clock ?? realClock;
  }

  /** The id this browser profile keeps across worker restarts, so Winter gives it the same backend id back. */
  async instance(): Promise<string> {
    if (this.instanceId !== undefined) return this.instanceId;
    const stored = (await this.chrome.storage.get([INSTANCE_KEY]))[INSTANCE_KEY];
    if (typeof stored === "string" && /^[A-Za-z0-9-]{8,64}$/.test(stored)) {
      this.instanceId = stored;
    } else {
      this.instanceId = this.chrome.randomUUID();
      await this.chrome.storage.set({ [INSTANCE_KEY]: this.instanceId });
    }
    return this.instanceId;
  }

  start(): void {
    if (this.port !== undefined) return;
    this.status.set({ state: "connecting" });
    let port: ChromePort;
    try {
      port = this.chrome.runtime.connectNative(this.opts.hostName);
    } catch (err) {
      this.opts.log?.(`connectNative failed: ${err instanceof Error ? err.message : String(err)}`);
      this.status.set({ state: "host-missing" });
      this.schedule();
      return;
    }
    this.port = port;
    port.onMessage.addListener((m) => { void this.onMessage(port, m); });
    port.onDisconnect.addListener(() => this.onDisconnect(port));
  }

  /** Sends one notification to the daemon (dropped while there is no port). */
  notify(method: string, params: Record<string, unknown>): void {
    this.post({ jsonrpc: "2.0", method, params });
  }

  private post(message: Record<string, unknown>): void {
    try {
      this.port?.postMessage(message);
    } catch (err) {
      this.opts.log?.(`postMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onDisconnect(port: ChromePort): void {
    if (this.port !== port) return;
    const reason = this.chrome.lastError();
    this.port = undefined;
    this.helloId = undefined;
    this.status.set({ state: "host-missing", ...(reason === undefined ? {} : { detail: reason }) });
    void this.controller.releaseAll();
    this.schedule();
  }

  private schedule(): void {
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, delay);
  }

  private async onMessage(port: ChromePort, m: unknown): Promise<void> {
    if (this.port !== port || !isRecord(m) || m.jsonrpc !== "2.0") return;
    if (m.method === "host.status") {
      await this.onHostStatus(isRecord(m.params) ? m.params : {});
      return;
    }
    if (typeof m.method === "string") {
      if (m.id === undefined) return; // no daemon notifications are defined
      await this.answer(m.id, m.method, m.params);
      return;
    }
    if (m.id !== undefined && m.id === this.helloId) this.onHelloAnswer(m);
  }

  private async onHostStatus(p: Record<string, unknown>): Promise<void> {
    switch (p.daemon) {
      case "connected":
        await this.hello();
        return;
      case "unavailable":
        this.status.set({ state: "no-daemon" });
        break;
      case "unverified":
        this.status.set({ state: "unverified" });
        break;
      case "refused":
        this.status.set({ state: "refused", message: typeof p.reason === "string" ? p.reason : "Winter refused the connection" });
        break;
      default:
        return;
    }
    this.helloId = undefined;
    await this.controller.releaseAll();
  }

  private async hello(): Promise<void> {
    const id = `e${this.nextId++}`;
    this.helloId = id;
    this.post({
      jsonrpc: "2.0", id, method: "hello",
      params: { protocol: EXTENSION_PROTOCOL, extensionVersion: this.chrome.extensionVersion, instanceId: await this.instance() },
    });
  }

  private onHelloAnswer(m: Record<string, unknown>): void {
    this.helloId = undefined;
    const backend = isRecord(m.result) && isRecord(m.result.backend) ? m.result.backend : undefined;
    if (backend !== undefined && typeof backend.id === "string" && typeof backend.name === "string") {
      this.backoff = BACKOFF_MIN_MS;
      this.status.set({ state: "connected", backend: { id: backend.id, name: backend.name } });
      return;
    }
    const error = isRecord(m.error) ? m.error : {};
    const data = isRecord(error.data) ? error.data : {};
    const message = typeof error.message === "string" ? error.message : "Winter refused Winter for Chrome";
    if (data.code === "protocol_mismatch") {
      this.status.set({ state: "mismatch", message });
      return;
    }
    this.status.set({ state: "unavailable", message });
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.port !== undefined) void this.hello();
    }, HELLO_RETRY_MS);
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.controller.handle(method, params);
      this.post({ jsonrpc: "2.0", id, result });
    } catch (err) {
      if (err instanceof UnknownMethod) {
        this.post({ jsonrpc: "2.0", id, error: { code: RPC_METHOD_NOT_FOUND, message: `Winter for Chrome has no method ${method}`, data: { code: "not_allowed" } } });
        return;
      }
      const e = err instanceof ExtensionError ? err : new ExtensionError("cdp_error", err instanceof Error ? err.message : String(err));
      this.post({ jsonrpc: "2.0", id, error: { code: RPC_ERROR, message: e.message, data: { ...e.data, code: e.code } } });
    }
  }
}
