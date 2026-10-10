// ComputerV2 Phase 2 — `BrowserHostServer`: the daemon's end of Winter for Chrome. It listens on
// `<home>/run/browser.sock` (mode 0600, a stale file unlinked first) for `winter-browser-host`, one connection per
// browser profile running the extension, and turns each authenticated connection into an `ExtensionTransport`
// registered in the engine's `BackendRegistry`.
//
// The handshake (apple/ComputerUse/WinterBrowserHost/PROTOCOL.md):
//  1. `host.hello` (the host's own request, first): protocol → the caller's origin in this profile's allowlist → the
//     browser app a known Chromium family → the host's code signature, checked BY THE PID IT REPORTS against the host's
//     stated designated requirement → computer use on. Any refusal is answered and the connection closed.
//     What the pid check is, exactly: a check that the process the connection SAYS it is runs Winter's signed host — it
//     catches a host binary that is not Winter's (another build, a stale copy). It is not proof against a process of the
//     same user: such a process can name the real host's pid (Bun's sockets give the daemon no peer pid of its own), or
//     open this 0600 socket itself. Same-user code is OUT of the threat model here — as it is for the helper's socket
//     and for the daemon's own: a process running as the user can already reach everything the user can. The other
//     direction, the host's audit-token check of THIS daemon, is what keeps the host (and so the extension's debugger)
//     from talking to anything but Winter's signed daemon — against code that is not the user's own.
//  2. `hello` (the extension's, relayed): the extension protocol, then registration under its `instanceId`, so a service
//     worker restart (a new connection, the same instance) gets its BackendId back.
//  3. Everything after is the transport's.
import { chmodSync, rmSync } from "node:fs";
import { ConnWriter, encodeLine, LineDecoder } from "@yanlinglabs/winter-protocol";
import type { WinterProfile } from "../../../profile";
import { processSatisfiesRequirement } from "../../helper-verify";
import type { BackendRegistry } from "../transport";
import { ExtensionTransport, type ExtensionTimeouts } from "./extension-transport";
import { browserHostRequirementFor, EXTENSION_IDS, extensionIdFromOrigin } from "./extension-ids";
import { familyForBundleId, type FamilyInfo } from "../families";
import {
  BROWSER_HOST_PROTOCOL, EXTENSION_PROTOCOL, HOST_TO_DAEMON_MAX_LINE, RPC_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND,
  type ExtensionHelloResult, type HostHelloResult,
} from "./protocol";

export type BrowserHostVerifier = (pid: number, requirement: string) => boolean;

export interface BrowserHostServerOptions {
  socketPath: string;
  profile: WinterProfile;
  daemonVersion: string;
  /** The engine's backends, read at each extension hello. Undefined while this daemon has no browser engine: the hello
   *  is then refused (`unavailable`) and the extension says so. */
  registry(): BackendRegistry | undefined;
  /** `computerUse.enabled`, read live at each `host.hello`. */
  enabled(): boolean;
  /** TEST SEAMS. Production: this profile's ids, the host's stated requirement, Security.framework by pid. */
  allowedExtensionIds?: readonly string[];
  hostRequirement?: string;
  verifyHost?: BrowserHostVerifier;
  /** How long a new connection has to send `host.hello` (default 10 s). */
  helloTimeoutMs?: number;
  transportTimeouts?: Partial<ExtensionTimeouts>;
  log?(line: string): void;
}

interface HostFacts {
  app: FamilyInfo;
  bundleId: string;
  extensionId: string;
  hostPid: number;
  browserPid: number;
}

interface Conn {
  readonly n: number;
  decoder: LineDecoder;
  writer: ConnWriter;
  phase: "host-hello" | "extension-hello" | "ready" | "closing";
  host?: HostFacts;
  instanceId?: string;
  transport?: ExtensionTransport;
  registration?: { id: string; unregister(): void };
  helloTimer?: ReturnType<typeof setTimeout>;
  end(): void;
}

type Sock = { data: Conn; write(b: Uint8Array): number; end(): void };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const INSTANCE_ID = /^[A-Za-z0-9-]{8,64}$/;

class Refusal extends Error {
  constructor(readonly rpcCode: number, message: string, readonly data: Record<string, unknown>) {
    super(message);
  }
}

export class BrowserHostServer {
  private server: { stop(closeActive?: boolean): void } | undefined;
  private readonly conns = new Set<Conn>();
  /** The live connection of each registered instance — a second hello from the same instance replaces it. */
  private readonly byInstance = new Map<string, Conn>();
  private nextConn = 1;
  private readonly allowedIds: ReadonlySet<string>;
  private readonly hostRequirement: string;
  private readonly verifyHost: BrowserHostVerifier;

  constructor(private readonly opts: BrowserHostServerOptions) {
    this.allowedIds = new Set(opts.allowedExtensionIds ?? EXTENSION_IDS[opts.profile]);
    this.hostRequirement = opts.hostRequirement ?? browserHostRequirementFor(opts.profile);
    this.verifyHost = opts.verifyHost ?? processSatisfiesRequirement;
  }

  get listening(): boolean { return this.server !== undefined; }

  /** The connected instances (tests, status). */
  connectedBackends(): string[] {
    return [...this.conns].flatMap((c) => (c.registration === undefined ? [] : [c.registration.id]));
  }

  start(): void {
    if (this.server !== undefined) return;
    // The daemon's boot lock makes this home's daemon the only writer of run/: a file here is a previous run's.
    rmSync(this.opts.socketPath, { force: true });
    this.server = Bun.listen<Conn>({
      unix: this.opts.socketPath,
      socket: {
        open: (socket) => this.open(socket as unknown as Sock),
        data: (socket, chunk) => this.data(socket as unknown as Sock, chunk),
        drain: (socket) => socket.data?.writer.onDrain(),
        close: (socket) => { if (socket.data !== undefined) this.closed(socket.data); },
        error: (socket) => { if (socket.data !== undefined) this.closed(socket.data); },
      },
    });
    chmodSync(this.opts.socketPath, 0o600);
    this.log(`listening on ${this.opts.socketPath}`);
  }

  stop(): void {
    const server = this.server;
    this.server = undefined;
    for (const c of [...this.conns]) {
      this.closed(c);
      c.end();
    }
    server?.stop(true);
    rmSync(this.opts.socketPath, { force: true });
  }

  // ── connection lifecycle ───────────────────────────────────────────────────────────────────────────────────────

  private open(socket: Sock): void {
    const conn: Conn = {
      n: this.nextConn++,
      decoder: new LineDecoder(HOST_TO_DAEMON_MAX_LINE),
      writer: new ConnWriter(socket),
      phase: "host-hello",
      end: () => socket.end(),
    };
    conn.helloTimer = setTimeout(() => {
      if (conn.phase === "host-hello") {
        this.log(`connection ${conn.n}: no host.hello in time — closed`);
        socket.end();
      }
    }, this.opts.helloTimeoutMs ?? 10_000);
    socket.data = conn;
    this.conns.add(conn);
  }

  private closed(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    if (conn.helloTimer !== undefined) clearTimeout(conn.helloTimer);
    conn.phase = "closing";
    this.retire(conn, "Winter for Chrome disconnected");
  }

  /** Drops a connection's transport and registration (its connection closed, or another took its instance). */
  private retire(conn: Conn, why: string): void {
    conn.transport?.disconnect(why);
    if (conn.instanceId !== undefined && this.byInstance.get(conn.instanceId) === conn) {
      this.byInstance.delete(conn.instanceId);
      conn.registration?.unregister();
      this.log(`connection ${conn.n}: ${conn.registration?.id ?? "extension"} disconnected`);
    }
    conn.transport = undefined;
    conn.registration = undefined;
  }

  private data(socket: Sock, chunk: Uint8Array): void {
    const conn = socket.data;
    let lines: string[];
    try {
      lines = conn.decoder.push(chunk);
    } catch {
      this.log(`connection ${conn.n}: a line over ${HOST_TO_DAEMON_MAX_LINE} bytes — closed`);
      socket.end();
      return;
    }
    for (const line of lines) {
      if (conn.phase === "closing") return;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { msg = undefined; }
      if (!isRecord(msg) || msg.jsonrpc !== "2.0") {
        this.log(`connection ${conn.n}: a line that is not a JSON-RPC 2.0 object — closed`);
        socket.end();
        return;
      }
      this.message(socket, conn, msg);
    }
  }

  private message(socket: Sock, conn: Conn, msg: Record<string, unknown>): void {
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : undefined;
    if (conn.phase === "host-hello") {
      if (msg.method !== "host.hello" || id === undefined) {
        this.reply(conn, id ?? null, undefined, new Refusal(RPC_ERROR, "the first request must be host.hello", { code: "protocol_mismatch", expected: BROWSER_HOST_PROTOCOL }));
        this.endAfterFlush(socket);
        return;
      }
      try {
        const result = this.hostHello(conn, msg.params);
        if (conn.helloTimer !== undefined) clearTimeout(conn.helloTimer);
        conn.phase = "extension-hello";
        this.reply(conn, id, result);
      } catch (err) {
        const refusal = err instanceof Refusal ? err : new Refusal(RPC_ERROR, "host.hello failed", { code: "not_allowed", reason: "signature" });
        this.log(`connection ${conn.n}: host.hello refused (${String(refusal.data.code)}${refusal.data.reason === undefined ? "" : `/${String(refusal.data.reason)}`})`);
        this.reply(conn, id, undefined, refusal);
        this.endAfterFlush(socket);
      }
      return;
    }
    if (msg.method === "hello" && id !== undefined) {
      try {
        this.reply(conn, id, this.extensionHello(conn, msg.params));
      } catch (err) {
        this.reply(conn, id, undefined, err instanceof Refusal ? err : new Refusal(RPC_ERROR, "hello failed", { code: "unavailable" }));
      }
      return;
    }
    if (conn.phase === "ready" && conn.transport?.handle(msg) === true) return;
    if (typeof msg.method === "string" && id !== undefined) {
      this.reply(conn, id, undefined, new Refusal(RPC_METHOD_NOT_FOUND, `the daemon has no method ${msg.method}`, { code: "method_not_found" }));
    }
    // Anything else (a stray response, a notification before hello) is dropped.
  }

  private hostHello(conn: Conn, params: unknown): HostHelloResult {
    if (!isRecord(params)) throw new Refusal(RPC_INVALID_PARAMS, "host.hello needs params", { code: "protocol_mismatch", expected: BROWSER_HOST_PROTOCOL });
    if (params.protocol !== BROWSER_HOST_PROTOCOL) {
      throw new Refusal(RPC_ERROR, `this Winter speaks browser-host protocol ${BROWSER_HOST_PROTOCOL}`, { code: "protocol_mismatch", expected: BROWSER_HOST_PROTOCOL });
    }
    const { origin, browserBundleId, hostPid, browserPid } = params;
    const extensionId = typeof origin === "string" ? extensionIdFromOrigin(origin) : undefined;
    if (extensionId === undefined || !this.allowedIds.has(extensionId)) {
      throw new Refusal(RPC_ERROR, "that extension is not Winter for Chrome", { code: "not_allowed", reason: "origin" });
    }
    const app = typeof browserBundleId === "string" ? familyForBundleId(browserBundleId) : undefined;
    if (app === undefined || app.family === "winter" || typeof browserBundleId !== "string") {
      throw new Refusal(RPC_ERROR, "Winter for Chrome works in Chrome, Edge, Brave, Vivaldi, Opera, Arc and Chromium only", { code: "not_allowed", reason: "browser" });
    }
    if (typeof hostPid !== "number" || !Number.isInteger(hostPid) || hostPid <= 0 || !this.verifyHost(hostPid, this.hostRequirement)) {
      throw new Refusal(RPC_ERROR, "the native host is not Winter's", { code: "not_allowed", reason: "signature" });
    }
    if (!this.opts.enabled()) throw new Refusal(RPC_ERROR, "Computer Use is turned off in Winter's settings", { code: "disabled" });
    conn.host = { app, bundleId: browserBundleId, extensionId, hostPid, browserPid: typeof browserPid === "number" ? browserPid : 0 };
    this.log(`connection ${conn.n}: host verified (${app.name}, pid ${hostPid})`);
    return { protocol: BROWSER_HOST_PROTOCOL, daemonVersion: this.opts.daemonVersion };
  }

  private extensionHello(conn: Conn, params: unknown): ExtensionHelloResult {
    const host = conn.host;
    if (host === undefined) throw new Refusal(RPC_ERROR, "host.hello first", { code: "protocol_mismatch", expected: BROWSER_HOST_PROTOCOL });
    if (!isRecord(params) || typeof params.protocol !== "number") {
      throw new Refusal(RPC_INVALID_PARAMS, "hello needs { protocol, extensionVersion, instanceId }", { code: "protocol_mismatch", expected: EXTENSION_PROTOCOL });
    }
    const registry = this.opts.registry();
    if (params.protocol !== EXTENSION_PROTOCOL) {
      const older = params.protocol < EXTENSION_PROTOCOL;
      const reason = older
        ? `Winter for Chrome in ${host.app.name} is too old — ask the user to update Winter for Chrome`
        : `Winter for Chrome in ${host.app.name} is newer than this Winter — ask the user to update Winter`;
      registry?.noteUnavailable({ family: host.app.family, name: host.app.name, bundleId: host.bundleId, reason });
      throw new Refusal(RPC_ERROR, older ? "update Winter for Chrome" : "update Winter", { code: "protocol_mismatch", expected: EXTENSION_PROTOCOL });
    }
    const instanceId = params.instanceId;
    if (typeof instanceId !== "string" || !INSTANCE_ID.test(instanceId)) {
      throw new Refusal(RPC_INVALID_PARAMS, "hello's instanceId must be a UUID", { code: "invalid_params" });
    }
    if (registry === undefined) throw new Refusal(RPC_ERROR, "this Winter cannot drive browser tabs yet", { code: "unavailable" });

    // A connection says hello once; a second hello (the extension re-sent it) re-registers cleanly.
    if (conn.transport !== undefined) this.retire(conn, "Winter for Chrome said hello again");
    const previous = this.byInstance.get(instanceId);
    if (previous !== undefined && previous !== conn) {
      // The same browser profile on a new connection (its service worker or the host restarted): the old one is stale.
      this.retire(previous, "replaced by a new connection from the same browser profile");
      previous.phase = "closing";
      previous.end();
    }
    const transport = new ExtensionTransport({
      family: host.app.family,
      write: (message) => conn.phase !== "closing" && conn.writer.enqueue(encodeLine(message)),
      ...(this.opts.transportTimeouts === undefined ? {} : { timeouts: this.opts.transportTimeouts }),
      ...(this.opts.log === undefined ? {} : { log: this.opts.log }),
    });
    const registration = registry.register(transport, { family: host.app.family, name: host.app.name, bundleId: host.bundleId, instanceKey: instanceId });
    transport.bind(registration.id);
    conn.transport = transport;
    conn.registration = registration;
    conn.instanceId = instanceId;
    conn.phase = "ready";
    this.byInstance.set(instanceId, conn);
    const name = registry.list().find((b) => b.id === registration.id)?.name ?? host.app.name;
    this.log(`connection ${conn.n}: Winter for Chrome ${typeof params.extensionVersion === "string" ? params.extensionVersion : "?"} connected as ${registration.id}`);
    return { protocol: EXTENSION_PROTOCOL, backend: { id: registration.id, name } };
  }

  // ── writing ────────────────────────────────────────────────────────────────────────────────────────────────────

  private reply(conn: Conn, id: string | number | null, result: unknown, refusal?: Refusal): void {
    const message = refusal === undefined
      ? { jsonrpc: "2.0", id, result }
      : { jsonrpc: "2.0", id, error: { code: refusal.rpcCode, message: refusal.message, data: refusal.data } };
    conn.writer.enqueue(encodeLine(message));
  }

  /** Ends the connection once what was queued for it has been written (a refusal must reach the host). */
  private endAfterFlush(socket: Sock): void {
    const conn = socket.data;
    conn.phase = "closing";
    if (conn.writer.bufferedBytes === 0) { socket.end(); return; }
    const deadline = Date.now() + 2000;
    const poll = (): void => {
      if (conn.writer.bufferedBytes === 0 || Date.now() > deadline) socket.end();
      else setTimeout(poll, 20);
    };
    setTimeout(poll, 20);
  }

  private log(line: string): void {
    this.opts.log?.(`[browser-host] ${line}`);
  }
}
