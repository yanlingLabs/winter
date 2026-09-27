// WS-27: `elicitation.respond` — the answer to a URL-mode elicitation card. Local clients only: the phone
// cannot open a link on the Mac, so the remote role is refused, and neither event reaches a remote stream.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, ELICITATION_NOT_ACTIVE, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { ElicitationBroker } from "../../src/runtime-sdk/url-elicitation";
import { HISTORY_EVENT_TYPES } from "../../src/sessions/history";
import { REMOTE_STREAM_EVENT_TYPES } from "../../src/sessions/remote-stream";

/** Minimal raw NDJSON JSON-RPC client — the same per-file copy every test in test/ipc carries. */
class TestClient {
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
            if (msg.id !== undefined && c.pending.has(msg.id)) {
              c.pending.get(msg.id)!(msg);
              c.pending.delete(msg.id);
            }
          }
        },
        drain() { c.writer.onDrain(); },
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

  hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("elicitation.respond (WS-27)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-elicit-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const elicitations = new ElicitationBroker();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, elicitations });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, tokens, elicitations };
  }

  test("a local client answers a pending card; first response wins; the answering client is recorded", async () => {
    const { socketPath, tokens, elicitations } = await boot();
    const outcome = elicitations.wait("s1", "el_1", 60_000, { url: "https://linear.app/oauth?code=OTC", host: "linear.app" });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    const res = await c.request(METHODS.elicitationRespond, { sessionId: "s1", elicitationId: "el_1", action: "accept" });
    expect(res.result).toEqual({ ok: true, alreadyResolved: false });
    expect(await outcome).toEqual({ action: "accept", by: "orb" });
    const again = await c.request(METHODS.elicitationRespond, { sessionId: "s1", elicitationId: "el_1", action: "decline" });
    expect(again.result).toEqual({ ok: true, alreadyResolved: true });
    c.close();
  });

  test("elicitation.url answers a pending card's url to a local client, and refuses once it is no longer active", async () => {
    const { socketPath, tokens, elicitations } = await boot();
    const outcome = elicitations.wait("s1", "el_1", 60_000, { url: "https://linear.app/oauth?code=OTC", host: "linear.app" });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    const res = await c.request(METHODS.elicitationUrl, { sessionId: "s1", elicitationId: "el_1" });
    expect(res.result).toEqual({ url: "https://linear.app/oauth?code=OTC" });
    // Another session's id, or an unknown one, is not active.
    const other = await c.request(METHODS.elicitationUrl, { sessionId: "s2", elicitationId: "el_1" });
    expect(other.error?.code).toBe(ERR.NOT_FOUND);
    expect(other.error?.data).toEqual({ code: ELICITATION_NOT_ACTIVE });
    await c.request(METHODS.elicitationRespond, { sessionId: "s1", elicitationId: "el_1", action: "decline" });
    await outcome;
    const gone = await c.request(METHODS.elicitationUrl, { sessionId: "s1", elicitationId: "el_1" });
    expect(gone.error?.code).toBe(ERR.NOT_FOUND);
    expect(gone.error?.data).toEqual({ code: ELICITATION_NOT_ACTIVE });
    expect(JSON.stringify(gone)).not.toContain("OTC");
    c.close();
  });

  test("a client cannot answer cancel — that is the daemon's own outcome", async () => {
    const { socketPath, tokens } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "orb");
    const res = await c.request(METHODS.elicitationRespond, { sessionId: "s1", elicitationId: "el_1", action: "cancel" });
    expect(res.error?.code).toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("the remote (phone) role is refused both doors, and the card stays pending", async () => {
    const { socketPath, tokens, elicitations } = await boot();
    elicitations.wait("s1", "el_1", 60_000, { url: "https://linear.app/oauth?code=OTC", host: "linear.app" });
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.remote, "iphone-gateway", "remote");
    const res = await c.request(METHODS.elicitationRespond, { sessionId: "s1", elicitationId: "el_1", action: "accept" });
    expect(res.error?.code).toBe(ERR.UNAUTHORIZED);
    const url = await c.request(METHODS.elicitationUrl, { sessionId: "s1", elicitationId: "el_1" });
    expect(url.error?.code).toBe(ERR.UNAUTHORIZED);
    expect(JSON.stringify(url)).not.toContain("OTC");
    expect(elicitations.pendingIds("s1")).toEqual(["el_1"]);
    elicitations.respond("s1", "el_1", "cancel", "test");
    c.close();
  });

  test("local-only by construction: not remote-allowed, and neither event reaches history or a remote stream", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.elicitationRespond)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.elicitationUrl)).toBe(false);
    for (const type of ["elicitation_requested", "elicitation_resolved"] as const) {
      expect(HISTORY_EVENT_TYPES.has(type)).toBe(false);
      expect(REMOTE_STREAM_EVENT_TYPES.has(type)).toBe(false);
    }
  });
});
