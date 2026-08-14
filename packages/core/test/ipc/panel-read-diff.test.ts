import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket,
} from "@norma/protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { writeDiff, mintDiffId } from "../../src/diffs/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// diff-tabs Task 7: `panel.readDiff` — the RPC that reads back the patch a `tool_result.fileDiff`
// (Task 5) only summarizes. Harness/admin-only, same rule as every other panel.* method
// (panel-methods.test.ts's "panel methods are NOT remote-allowed" pin covers the original six
// tab methods; this file carries the seventh's own copy so the two files don't have to agree by
// convention alone — and the parity list itself, `remote-allowlist-parity.test.ts`, carries a
// third, independent assertion that the literal string is absent from the mirrored set).
//
// The deletion-sweep pin (`diffs/<sessionId>/` gone after a session is deleted) does NOT live
// here: it belongs beside the existing outputs-dir sweep test, in
// `test/sessions/reaper.test.ts`'s `describe("SessionStore.deleteSession ...")` block — the ONE
// place `packages/core/src/sessions/store.ts`'s `deleteSession` (the actual shared deletion path
// both the reaper and the cleaner call) is already exercised directly.

/** Minimal raw test client speaking NDJSON JSON-RPC — duplicated per this codebase's own
 *  no-shared-test-harness convention (see panel-methods.test.ts's identical copy). */
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

  async hello(token: string, clientName: string, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName });
  }

  close(): void { this.socket.end(); }
}

describe("panel.readDiff (diff-tabs Task 7)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{
    store: SessionStore; home: string; socketPath: string; harnessToken: string; remoteToken: string;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-panel-readdiff-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, hub, normaHome: home,
    });
    stop = () => { server.stop(); store.close(); };
    return { store, home, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  // -------------------------------------------------------------------------------------------
  // Role. Harness/admin only — panel state is Mac-only by construction (design doc §1d).
  // -------------------------------------------------------------------------------------------
  test("panel.readDiff is NOT remote-allowed", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.panelReadDiff)).toBe(false);
  });

  test("a remote connection is role-rejected before it ever reaches the handler", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global");
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    const res = await c.request(METHODS.panelReadDiff, { sessionId, diffId: mintDiffId() });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.UNAUTHORIZED);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // The round trip: write a diff straight through the store (Task 2), read it back over the RPC.
  // -------------------------------------------------------------------------------------------
  test("round-trip: a diff written via the store reads back over the RPC", async () => {
    const { store, home, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const diffId = mintDiffId();
    const patch = "@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n";
    await writeDiff(home, sessionId, diffId, { path: "/Users/me/norma v2/core/x.ts", added: 1, removed: 1 }, patch);

    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const res = await c.request(METHODS.panelReadDiff, { sessionId, diffId });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      path: "/Users/me/norma v2/core/x.ts", added: 1, removed: 1, patch, truncated: false,
    });
    c.close();
  });

  test("a truncated diff echoes truncated:true and the store's own truncated patch bytes", async () => {
    const { store, home, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const diffId = mintDiffId();
    const hunk = "@@ -1,1 +1,1 @@\n-" + "x".repeat(600_000) + "\n+" + "y".repeat(600_000) + "\n";
    const patch = hunk + hunk; // ~2.4 MB, two hunks — forces DIFF_PATCH_MAX_BYTES truncation
    const written = await writeDiff(home, sessionId, diffId, { path: "/p", added: 2, removed: 2 }, patch);
    expect(written.truncated).toBe(true);

    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const res = await c.request(METHODS.panelReadDiff, { sessionId, diffId });
    expect(res.error).toBeUndefined();
    expect(res.result.truncated).toBe(true);
    expect(res.result.patch.endsWith("[patch truncated]\n")).toBe(true);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // Invalid diffId SHAPE is refused by `parseParams` — the zod regex baked into
  // `PanelReadDiffParams.diffId` itself (methods.ts) — which throws INVALID_PARAMS from THIS
  // handler's very first statement, before `readStoredDiff` (and therefore any `fs` read) is ever
  // called. That is the whole proof: a shape-invalid id can ONLY ever reach `readStoredDiff`'s own
  // regex re-check (diffs/store.ts's `DIFF_ID_RE`), which fails soft to `null` and becomes
  // NOT_FOUND, never INVALID_PARAMS — so observing INVALID_PARAMS here is only possible if the
  // params gate rejected the call before the handler body's file-touching code ran at all.
  // -------------------------------------------------------------------------------------------
  for (const bad of [
    "",                       // below the {1,64} minimum
    "a".repeat(65),           // over the 64-char maximum
    "../../etc/passwd",       // traversal characters fail the [A-Za-z0-9_-] class
    "has a space",
    "has/a/slash",
  ]) {
    test(`invalid diffId shape "${bad.slice(0, 24)}" -> INVALID_PARAMS, no file read attempted`, async () => {
      const { store, socketPath, harnessToken } = await boot();
      // A REAL session — isolates the diffId shape as the only bad input, so a NOT_FOUND could
      // only mean the handler ran past the params gate (the failure mode this test rules out).
      const sessionId = store.createSession("global");
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "panel-tester");

      const res = await c.request(METHODS.panelReadDiff, { sessionId, diffId: bad });
      expect(res.error).toBeTruthy();
      expect(res.error.code).toBe(ERR.INVALID_PARAMS);
      c.close();
    });
  }

  // -------------------------------------------------------------------------------------------
  // A well-shaped id with no stored patch: a DIFFERENT, typed error — NOT_FOUND, mirroring
  // `skills.read`'s "not found" convention (ipc/server.ts's `case METHODS.skillsRead`:
  // `throw new RpcFailure(ERR.NOT_FOUND, \`skill not found: "${p.name}"\`)`) — a single-fact read
  // keyed by an id, refused the same way when the id is well-formed but nothing is there.
  // -------------------------------------------------------------------------------------------
  test("a well-shaped diffId with no stored patch -> NOT_FOUND (distinct from the shape refusal above)", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");

    const res = await c.request(METHODS.panelReadDiff, { sessionId, diffId: mintDiffId() });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    expect(res.error.code).not.toBe(ERR.INVALID_PARAMS);
    c.close();
  });

  test("a diffId minted for a DIFFERENT session -> NOT_FOUND, never cross-session (diffs are per-session-scoped)", async () => {
    const { store, home, socketPath, harnessToken } = await boot();
    const ownerSession = store.createSession("global");
    const otherSession = store.createSession("global");
    const diffId = mintDiffId();
    await writeDiff(home, ownerSession, diffId, { path: "/p", added: 1, removed: 0 }, "@@ -0,0 +1,1 @@\n+x\n");

    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "panel-tester");
    const res = await c.request(METHODS.panelReadDiff, { sessionId: otherSession, diffId });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.NOT_FOUND);
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // A server built WITHOUT `normaHome` — the same "typed INTERNAL failure, never a crash"
  // precedent every other normaHome-gated handler in ipc/server.ts follows (provider.configure,
  // plugins.install, plugin.enable/disable/remove/setConsent).
  // -------------------------------------------------------------------------------------------
  test("a server built WITHOUT normaHome fails typed-INTERNAL rather than throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-panel-readdiff-nohome-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub }); // no normaHome
    stop = () => { server.stop(); store.close(); };

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "panel-tester");
    const sessionId = store.createSession("global");
    const res = await c.request(METHODS.panelReadDiff, { sessionId, diffId: mintDiffId() });
    expect(res.error).toBeTruthy();
    expect(res.error.code).toBe(ERR.INTERNAL);
    c.close();
  });
});
