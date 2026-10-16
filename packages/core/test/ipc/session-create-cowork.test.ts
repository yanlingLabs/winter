// Cowork (session door): `cowork` is a RECOGNISED session mode on the wire, and `session.create` REFUSES it —
// for every role, with the Cowork `unsupported_topology` error, before anything exists. Nothing can create or
// run a Cowork session yet (docs/cowork-status.md), so this file pins the refusal's shape AND that it is a
// true no-op: no row, no log, no run folder, no model resolution, no availability probe, no runtime child, no
// `session_created` broadcast. The remote half cites docs/cowork-host-protocol.md ("Add Cowork to the
// separate remote-eligible session-mode set only after its per-record and parameter gates exist").
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, ERR, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { REMOTE_ELIGIBLE_SESSION_MODES, startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import type { WinterSessionDrivers } from "../../src/runtime-sdk/session-driver";

class TestClient {
  readonly notifications: any[] = [];
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
            else c.notifications.push(msg);
          }
        },
        drain(_s) { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async hello(token: string, clientName: string, role: string): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }
  close(): void { this.socket.end(); }
}

/** A driver table that counts every call, so "no child, no probe" is a number. */
function countingTable(): { table: WinterSessionDrivers; calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => { calls.push(name); };
  const table: WinterSessionDrivers = {
    legForNewSession: () => { note("legForNewSession"); return "winter"; },
    legOf: () => { note("legOf"); return "winter"; },
    assertAvailable: () => { note("assertAvailable"); },
    create: async () => { note("create"); return {} as never; },
    get: () => { note("get"); return undefined; },
    runTurn: async () => { note("runTurn"); },
    ensure: async () => { note("ensure"); return undefined; },
    evict: async () => { note("evict"); },
    list: () => [],
    endAll: async () => {},
  };
  return { table, calls };
}

const UNSUPPORTED = { code: ERR.INVALID_PARAMS, message: "Cowork unavailable", data: { code: "unsupported_topology" } };

describe("session.create refuses the recognised cowork mode", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(withWinter: boolean) {
    const home = mkdtempSync(join(tmpdir(), "winter-session-create-cowork-"));
    const store = new SessionStore(home);
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const socketPath = join(home, "core.sock");
    const { table, calls } = countingTable();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, ...(withWinter ? { winter: table } : {}),
    });
    stop = () => { server.stop(); store.close(); };
    const harness = await TestClient.connect(socketPath);
    await harness.hello(tokens.harness, "mac", "harness");
    const observer = await TestClient.connect(socketPath);
    await observer.hello(tokens.harness, "observer", "harness");
    return { home, store, calls, harness, observer, tokens, socketPath };
  }

  /** Everything a create could leave behind: index rows, scope directories, logs. */
  function nothingExists(home: string, store: SessionStore): void {
    expect(store.list()).toEqual([]);
    const sessions = join(home, "sessions");
    // `index.db` (+ its WAL files) is the store's own index; anything else under `sessions/` is a scope dir or a log.
    const leftovers = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).map(String).filter((f) => !f.startsWith("index.db")) : [];
    expect(leftovers).toEqual([]);
  }

  test("a local caller gets INVALID_PARAMS 'Cowork unavailable' with data.code unsupported_topology, and nothing exists", async () => {
    const { home, store, calls, harness, observer } = await boot(true);
    const res = await harness.request(METHODS.sessionCreate, { scope: "global", mode: "cowork" });
    expect(res.result).toBeUndefined();
    expect(res.error).toEqual(UNSUPPORTED);
    nothingExists(home, store);
    expect(calls).toEqual([]); // no leg decision, no availability probe, no creation transaction, no child
    await Bun.sleep(30);
    expect(observer.notifications.filter((n) => n.method === METHODS.event)).toEqual([]); // no session_created broadcast
    harness.close(); observer.close();
  });

  test("the refusal is the same on a bare server with no Winter leg, and every optional param changes nothing", async () => {
    const { home, store, harness } = await boot(false);
    const variants: Array<Record<string, unknown>> = [
      { scope: "global", mode: "cowork" },
      { scope: "global", mode: "cowork", model: "codex-oauth/gpt-5.6-sol", effort: "high" },
      { scope: "global", mode: "cowork", cwd: tmpdir(), approvalPolicy: "bypass", origin: "routine/x" },
      { scope: "global", mode: "cowork", model: "nonexistent/unknown-model", effort: "not-an-effort" }, // refused BEFORE model/effort resolution
    ];
    for (const params of variants) expect((await harness.request(METHODS.sessionCreate, params)).error).toEqual(UNSUPPORTED);
    nothingExists(home, store);
    harness.close();
  });

  test("a REMOTE (paired) caller cannot create one either — the same refusal, with or without the params the SP3.4 rule forbids", async () => {
    const { home, store, calls, tokens, socketPath } = await boot(true);
    const remote = await TestClient.connect(socketPath);
    await remote.hello(tokens.remote, "iphone-gateway", "remote");
    expect((await remote.request(METHODS.sessionCreate, { scope: "global", mode: "cowork" })).error).toEqual(UNSUPPORTED);
    // The cowork refusal precedes the "remote may not set cwd or approvalPolicy" rule: one answer for every caller.
    expect((await remote.request(METHODS.sessionCreate, { scope: "global", mode: "cowork", cwd: tmpdir() })).error).toEqual(UNSUPPORTED);
    expect((await remote.request(METHODS.sessionCreate, { scope: "global", mode: "cowork", approvalPolicy: "auto" })).error).toEqual(UNSUPPORTED);
    nothingExists(home, store);
    expect(calls).toEqual([]);
    remote.close();
  });

  test("cowork stays out of the remote-eligible modes (docs/cowork-host-protocol.md: only after its per-record and parameter gates exist)", () => {
    expect([...REMOTE_ELIGIBLE_SESSION_MODES].sort()).toEqual(["chat", "code", "dispatch"]);
    expect(REMOTE_ELIGIBLE_SESSION_MODES.has("cowork")).toBe(false);
  });

  test("a refused create leaves the daemon able to create: code and chat still mint, dispatch keeps its own refusal, an unknown mode stays a schema error", async () => {
    const { store, calls, harness } = await boot(true);
    expect((await harness.request(METHODS.sessionCreate, { scope: "global", mode: "cowork" })).error).toEqual(UNSUPPORTED);
    const code = await harness.request(METHODS.sessionCreate, { scope: "global" });
    expect(code.error).toBeUndefined();
    const chat = await harness.request(METHODS.sessionCreate, { scope: "global", mode: "chat" });
    expect(chat.error).toBeUndefined();
    expect(store.list().map((s) => s.mode ?? "code").sort()).toEqual(["chat", "code"]);
    expect(calls.filter((c) => c === "create")).toHaveLength(2);

    const dispatch = await harness.request(METHODS.sessionCreate, { scope: "global", mode: "dispatch" });
    expect(dispatch.error?.message).toBe("dispatch sessions are created via session.dispatch, not session.create");
    expect(dispatch.error?.data).toBeUndefined();
    const bogus = await harness.request(METHODS.sessionCreate, { scope: "global", mode: "coworker" });
    expect(bogus.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(bogus.error?.data?.code).toBeUndefined();
    expect(store.list()).toHaveLength(2);
    harness.close();
  });

  test("nothing persisted survives a restart: a fresh store over the same home has no cowork row and its rebuild finds none", async () => {
    const { home, harness } = await boot(true);
    await harness.request(METHODS.sessionCreate, { scope: "global", mode: "cowork" });
    harness.close();
    const reopened = new SessionStore(home);
    try {
      reopened.recoverAll();
      expect(reopened.list()).toEqual([]);
    } finally { reopened.close(); }
  });
});
