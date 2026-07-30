import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type SessionEvent, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { HISTORY_EVENT_TYPES, readHistoryPage } from "../../src/sessions/history";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// ==============================================================================================
// THE SECURITY DECISION (Chat Slice D task 2, spec §Component 3) — deliberate, pinned here.
//
// `sync.pull` DOES carry `reasoning_item` (and therefore the provider-opaque `itemJson` /
// `encrypted_content` it wraps). `session.history` still REFUSES it. Both halves are asserted in
// this one file on purpose, because the two surfaces look similar and the difference is the whole
// point:
//
//   * `session.history` is a READ-FOR-DISPLAY surface. Its `HISTORY_EVENT_TYPES` is an ALLOWLIST,
//     never a denylist (see sessions/history.ts): it hands the phone a rendered transcript, so
//     opaque provider state has no business crossing it — a security sweep test in
//     test/sessions/history.test.ts pins that, and this task did not touch either the allowlist or
//     that sweep.
//
//   * `sync.pull` is STORE REPLICATION to an already-paired device. Its job is to make the phone's
//     copy of the session log byte-identical to the daemon's, so the phone can (a) survive a Mac
//     wipe as the durable copy and (b) push the log back. A filtered replica is not a replica: a
//     resumed session whose `reasoning_item`s were dropped would silently lose the provider's
//     reasoning chain, and a push-back would rewrite the Mac's log with the holes in it. The
//     transport is the same end-to-end-encrypted, explicitly-paired iroh link the phone already
//     uses; the phone's copy is the same secret as the Mac's copy.
//
// If a future change makes `sync.pull` filter, or makes `session.history` pass `reasoning_item`,
// exactly one of the two halves below fails and the decision gets re-made deliberately.
// ==============================================================================================

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

const SECRET = "opaque-provider-reasoning-blob";

describe("SECURITY DECISION: sync.pull replicates reasoning_item; session.history still refuses it", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function bootWithChatSession(): Promise<{ store: SessionStore; socketPath: string; token: string; sessionId: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-security-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store });
    stop = () => { server.stop(); store.close(); };

    const sessionId = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "think about it", clientName: "cli" });
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: SECRET });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "done" });
    return { store, socketPath, token: tokens.harness, sessionId };
  }

  test("sync.pull's replicated bytes CONTAIN the reasoning_item (deliberate: store replication, not display)", async () => {
    const { socketPath, token, sessionId } = await bootWithChatSession();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync-client");

    const res = await c.request(METHODS.syncPull, { sessionId, fromSeq: 0 });
    expect(res.error).toBeUndefined();
    const jsonl = Buffer.from(res.result.data, "base64").toString("utf8");
    const types = jsonl.split("\n").filter((l) => l).map((l) => JSON.parse(l).type);
    expect(types).toContain("reasoning_item");
    expect(jsonl).toContain(SECRET);
    c.close();
  });

  test("CONTROL: session.history over the SAME session still omits it, and HISTORY_EVENT_TYPES is untouched", async () => {
    const { store, socketPath, token, sessionId } = await bootWithChatSession();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync-client");

    // The allowlist itself — the sweep in test/sessions/history.test.ts pins this too; repeated
    // here so the DECISION and its counterpart live in one readable place.
    expect(HISTORY_EVENT_TYPES.has("reasoning_item" as SessionEvent["type"])).toBe(false);

    const res = await c.request(METHODS.sessionHistory, { sessionId });
    expect(res.error).toBeUndefined();
    expect(res.result.events.some((e: any) => e.type === "reasoning_item")).toBe(false);
    expect(JSON.stringify(res.result)).not.toContain(SECRET);

    // ...and the same at the function seam, independent of the RPC envelope.
    const page = readHistoryPage(store, { sessionId });
    expect(page.events.some((e) => e.type === "reasoning_item")).toBe(false);
    c.close();
  });

  test("a reasoning_item pushed BACK through sync.push is stored verbatim (the replication loop closes)", async () => {
    const { store, socketPath, token, sessionId } = await bootWithChatSession();
    const c = await TestClient.connect(socketPath);
    await c.hello(token, "sync-client");

    const pulled = await c.request(METHODS.syncPull, { sessionId, fromSeq: 0 });
    const bytes = Buffer.from(pulled.result.data, "base64").toString("utf8");

    // Re-target the pulled log at a fresh phone-minted session id and push it back.
    const clone = crypto.randomUUID();
    const relabelled = bytes.replaceAll(sessionId, clone);
    const push = await c.request(METHODS.syncPush, {
      sessionId: clone, baseSeq: 0, data: Buffer.from(relabelled, "utf8").toString("base64"), complete: true,
    });
    expect(push.error).toBeUndefined();

    const restored = store.read(clone, 0);
    const reasoning = restored.find((e) => e.type === "reasoning_item");
    expect(reasoning).toBeTruthy();
    expect((reasoning as any).itemJson).toBe(SECRET);
    c.close();
  });
});
