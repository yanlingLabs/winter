import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// mac-chat-parity T4: `session.list`'s per-row `approvalPolicy` — the READ half of
// `session.setPolicy`, and the prerequisite for any PERSISTENT policy picker.
//
// Three claims:
//   1. The row reports the policy the session actually has — including `bypass`, the one value
//      whose whole point is that it looks different from the rest. Before this, the Mac app's
//      picker was seeded `"auto"` and written only after its own successful `setPolicy`, so a
//      session left at `bypass` by the CLI read "Auto" indefinitely.
//   2. It reads the SAME source `session.setPolicy` writes (the `approval_policy` column), so a
//      set is immediately visible on the next list rather than through a second derivation.
//   3. It rides no participation gate: chat and dispatch rows carry it too, and a chat row carries
//      the INTERNAL `"chat"` policy verbatim rather than a value the setter would accept.
//
// Own harness, this codebase's convention (no shared test-harness module) — the raw NDJSON client
// from session-list-signals.test.ts, trimmed to what these rows need.

/** Minimal raw NDJSON JSON-RPC client. */
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

  /** The one row of `session.list` this file is about. */
  async row(sessionId: string): Promise<any> {
    const res = await this.request(METHODS.sessionList);
    return res.result.sessions.find((s: any) => s.sessionId === sessionId);
  }

  close(): void { this.socket.end(); }
}

describe("session.list approvalPolicy (mac-chat-parity T4)", () => {
  let stop: (() => void) | undefined;

  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{ store: SessionStore; socketPath: string; harnessToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-list-policy-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const engine: any = {
      isRunning: () => false,
      hasBackgroundWork: () => false,
      interrupt: () => ({ wasRunning: false }),
    };
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, engine });
    stop = () => { server.stop(); store.close(); };
    return { store, socketPath, harnessToken: tokens.harness };
  }

  // -----------------------------------------------------------------------------------------
  // Claim 1: the row reports the real policy — bypass included
  // -----------------------------------------------------------------------------------------

  test("a BYPASS session's row reports bypass", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { approvalPolicy: "bypass" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    // The whole point of the field: the one policy a UI must never mis-state.
    expect((await shell.row(sessionId)).approvalPolicy).toBe("bypass");
    shell.close();
  });

  test("the daemon's default reports `ask` — absence is never how a policy is spelled", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global");

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const row = await shell.row(sessionId);
    expect(row.approvalPolicy).toBe("ask");
    shell.close();
  });

  test("every one of the six settable policies round-trips verbatim", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const policies = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"] as const;
    const ids = policies.map((p) => store.createSession("global", { approvalPolicy: p }));

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const res = await shell.request(METHODS.sessionList);
    for (const [i, policy] of policies.entries()) {
      const row = res.result.sessions.find((s: any) => s.sessionId === ids[i]);
      expect(row.approvalPolicy).toBe(policy);
    }
    shell.close();
  });

  // -----------------------------------------------------------------------------------------
  // Claim 2: the SAME source the setter writes
  // -----------------------------------------------------------------------------------------

  test("session.setPolicy is immediately visible on the next list", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { approvalPolicy: "ask" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    expect((await shell.row(sessionId)).approvalPolicy).toBe("ask");

    const set = await shell.request(METHODS.sessionSetPolicy, { sessionId, policy: "bypass" });
    expect(set.error).toBeUndefined();
    // Read back through the LIST, not through the setter's own answer: the claim is that the row
    // reads the column the setter wrote, not that the setter reported success.
    expect((await shell.row(sessionId)).approvalPolicy).toBe("bypass");
    shell.close();
  });

  // -----------------------------------------------------------------------------------------
  // Claim 3: no participation gate — and chat's internal value is reported verbatim
  // -----------------------------------------------------------------------------------------

  test("a CHAT row carries the INTERNAL `chat` policy, verbatim — the value the setter refuses", async () => {
    const { store, socketPath, harnessToken } = await boot();
    // The chat-seam coercion `session.create` applies (ipc/server.ts) persists "chat" itself.
    const sessionId = store.createSession("global", { mode: "chat", approvalPolicy: "chat" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const row = await shell.row(sessionId);
    expect(row.approvalPolicy).toBe("chat");
    // Same row, same call: the LABEL is still withheld from chat. `approvalPolicy` deliberately
    // does NOT ride `participatesInActivity` — a chat session has a real policy even though it has
    // no lifecycle, and a picker that has to hide itself needs to know WHY.
    expect(row.activity).toBeUndefined();
    // And the setter still refuses it, which is exactly why the row's type can't be the setter's.
    const refused = await shell.request(METHODS.sessionSetPolicy, { sessionId, policy: "auto" });
    expect(refused.error).toBeDefined();
    shell.close();
  });

  test("a DISPATCH row carries its policy too", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const sessionId = store.createSession("global", { mode: "dispatch", approvalPolicy: "auto" });

    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    const row = await shell.row(sessionId);
    expect(row.approvalPolicy).toBe("auto");
    expect(row.activity).toBeUndefined();
    shell.close();
  });

  // -----------------------------------------------------------------------------------------
  // The store's own read: one normalization, shared with `meta()`
  // -----------------------------------------------------------------------------------------

  test("store.list() and store.meta() answer identically, including for a junk stored value", async () => {
    const { store, socketPath, harnessToken } = await boot();
    const good = store.createSession("global", { approvalPolicy: "bypass" });
    const junk = store.createSession("global");
    // A hand-edited row / a value written by some future writer this build doesn't know. `meta()`
    // has always degraded that to "ask" (never trusting an unrecognized string as a policy); the
    // list read must not answer differently, or the picker and the gate disagree about one session.
    (store as unknown as { db: { run(sql: string, args: unknown[]): unknown } })
      .db.run("UPDATE sessions SET approval_policy = ? WHERE session_id = ?", ["not-a-policy", junk]);

    for (const id of [good, junk]) {
      expect(store.list().find((r) => r.sessionId === id)!.approvalPolicy).toBe(store.meta(id).approvalPolicy);
    }
    expect(store.list().find((r) => r.sessionId === junk)!.approvalPolicy).toBe("ask");

    // …and the wire says the same thing the store does.
    const shell = await TestClient.connect(socketPath);
    await shell.hello(harnessToken, "shell");
    expect((await shell.row(junk)).approvalPolicy).toBe("ask");
    shell.close();
  });
});
