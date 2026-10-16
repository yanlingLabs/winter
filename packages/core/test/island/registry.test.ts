// The Winter island's daemon half: the cross-session pending set (`island/registry.ts`), the `island.pending` door, the
// `island.changed` push, the hello's `capabilities`/`tty`, and the desktop-switch prompt going to the helper's panel
// ONLY while no island client is connected.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, CLIENT_CAPABILITY_ISLAND, ISLAND_CHANGED_NOTIFICATION,
  IslandPendingResult, type SessionEvent, type WritableSocket,
} from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { IslandRegistry, type IslandPendingSources } from "../../src/island/registry";
import { islandAwareDesktopPanel } from "../../src/computer-use/wiring";
import type { DesktopVisitPanel } from "../../src/computer-use/policy";

const ev = (e: Record<string, unknown>): SessionEvent => ({ seq: 1, ts: 1, threadId: "main", ...e }) as unknown as SessionEvent;

function sources(pending: Set<string>): IslandPendingSources {
  return {
    approval: (s, id) => pending.has(`a:${s}:${id}`),
    question: (s, id) => pending.has(`q:${s}:${id}`),
    elicitation: (s, id) => pending.has(`e:${s}:${id}`),
  };
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("IslandRegistry", () => {
  test("lists what the brokers still hold, oldest first, with each session's facts and hosts", () => {
    const pending = new Set(["a:s1:c1", "q:s2:q1", "e:s3:el1"]);
    const reg = new IslandRegistry({
      pending: sources(pending),
      facts: (sid) => (sid === "s2" ? { mode: "code", title: "Fix the build" } : {}),
      hosts: (sid) => (sid === "s1" ? [{ clientName: "tui", tty: "/dev/ttys004" }] : []),
    });
    reg.observe(ev({ type: "approval_requested", sessionId: "s1", callId: "c1", toolName: "Bash", summary: "ls" }));
    reg.observe(ev({ type: "question_asked", sessionId: "s2", callId: "q1", questions: [] }));
    reg.observe(ev({ type: "elicitation_requested", sessionId: "s3", elicitationId: "el1" }));
    const items = reg.list();
    expect(items.map((i) => [i.kind, i.answerSessionId])).toEqual([["approval", "s1"], ["question", "s2"], ["elicitation", "s3"]]);
    expect(items[0]!.hosts).toEqual([{ clientName: "tui", tty: "/dev/ttys004" }]);
    expect(items[1]!.session).toEqual({ mode: "code", title: "Fix the build" });
  });

  test("a resolve event removes the card; one the broker no longer holds is pruned at the next list", () => {
    const pending = new Set(["a:s1:c1", "a:s1:c2"]);
    const reg = new IslandRegistry({ pending: sources(pending), facts: () => ({}), hosts: () => [] });
    reg.observe(ev({ type: "approval_requested", sessionId: "s1", callId: "c1", toolName: "Bash", summary: "" }));
    reg.observe(ev({ type: "approval_requested", sessionId: "s1", callId: "c2", toolName: "Bash", summary: "" }));
    reg.observe(ev({ type: "approval_resolved", sessionId: "s1", callId: "c1", approved: true, by: "orb" }));
    expect(reg.list().map((i) => i.event.type === "approval_requested" && i.event.callId)).toEqual(["c2"]);
    pending.delete("a:s1:c2"); // timed out in the broker, no resolve event seen
    expect(reg.list()).toEqual([]);
    expect(reg.size).toBe(0);
  });

  test("a Dispatch child's card mirrored onto the coordinator appears ONCE, as the child's, answered at the child", () => {
    const pending = new Set(["a:child:c1", "q:child:q1"]);
    const reg = new IslandRegistry({ pending: sources(pending), facts: () => ({}), hosts: () => [] });
    // The child's own card, then its mirror on the coordinator…
    reg.observe(ev({ type: "approval_requested", sessionId: "child", callId: "c1", toolName: "Bash", summary: "" }));
    reg.observe(ev({ type: "approval_requested", sessionId: "disp", callId: "c1", toolName: "Bash", summary: "", childSessionId: "child" }));
    // …and the other order: the mirror first, then the child's own (which replaces it).
    reg.observe(ev({ type: "question_asked", sessionId: "disp", callId: "q1", questions: [], childSessionId: "child" }));
    reg.observe(ev({ type: "question_asked", sessionId: "child", callId: "q1", questions: [] }));
    const items = reg.list();
    expect(items.map((i) => [i.kind, i.sessionId, i.answerSessionId])).toEqual([["approval", "child", "child"], ["question", "child", "child"]]);
    // The mirror's resolution (on the coordinator, naming the child) removes it.
    reg.observe(ev({ type: "approval_resolved", sessionId: "disp", callId: "c1", approved: false, by: "orb", childSessionId: "child" }));
    expect(reg.list().map((i) => i.kind)).toEqual(["question"]);
  });

  test("island clients are told once per burst, and when a pending session's hosts change", async () => {
    const pending = new Set(["a:s1:c1", "a:s1:c2"]);
    const reg = new IslandRegistry({ pending: sources(pending), facts: () => ({}), hosts: () => [] });
    let told = 0;
    const client = { notify: () => { told++; } };
    reg.addClient(client);
    expect(reg.hasClient()).toBe(true);
    reg.observe(ev({ type: "approval_requested", sessionId: "s1", callId: "c1", toolName: "Bash", summary: "" }));
    reg.observe(ev({ type: "approval_requested", sessionId: "s1", callId: "c2", toolName: "Bash", summary: "" }));
    await flush();
    expect(told).toBe(1);
    reg.observe(ev({ type: "harness_attached", sessionId: "s1", clientName: "tui" }));
    await flush();
    expect(told).toBe(2);
    // A host change on a session with nothing pending says nothing.
    reg.observe(ev({ type: "harness_detached", sessionId: "other", clientName: "tui" }));
    await flush();
    expect(told).toBe(2);
    reg.removeClient(client);
    expect(reg.hasClient()).toBe(false);
  });

  test("the entries held are bounded, oldest dropped first", () => {
    const pending = new Set(["a:s:c1", "a:s:c2", "a:s:c3"]);
    const reg = new IslandRegistry({ pending: sources(pending), facts: () => ({}), hosts: () => [], maxEntries: 2 });
    for (const id of ["c1", "c2", "c3"]) reg.observe(ev({ type: "approval_requested", sessionId: "s", callId: id, toolName: "Bash", summary: "" }));
    expect(reg.list().map((i) => i.event.type === "approval_requested" && i.event.callId)).toEqual(["c2", "c3"]);
  });
});

describe("the desktop-switch prompt's on-screen half", () => {
  function recordingPanel(): DesktopVisitPanel & { shown: string[] } {
    const shown: string[] = [];
    return {
      shown,
      show(p) { shown.push(p.promptId); return { answer: Promise.resolve("switch" as const), close() {} }; },
    };
  }
  const prompt = { promptId: "cu_1", sessionId: "s1", app: "Safari", bundleId: "com.apple.Safari", reason: "to click", timeoutMs: 60_000, expiresAt: 1 };

  test("goes to the helper's panel only while no island client is connected", async () => {
    const helper = recordingPanel();
    let island = false;
    const panel = islandAwareDesktopPanel(helper, () => island, () => {});
    expect(await panel.show(prompt).answer).toBe("switch");
    expect(helper.shown).toEqual(["cu_1"]);
    island = true;
    const shown = panel.show({ ...prompt, promptId: "cu_2" });
    expect(await shown.answer).toBeUndefined(); // the card (answered in the island) decides
    shown.close();
    expect(helper.shown).toEqual(["cu_1"]);
    island = false; // the app quit: the helper is the fallback again, decided at the prompt
    panel.show({ ...prompt, promptId: "cu_3" });
    expect(helper.shown).toEqual(["cu_1", "cu_3"]);
  });
});

/** Minimal raw NDJSON JSON-RPC client that also records notifications. */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly notifications: string[] = [];

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
            } else if (typeof msg.method === "string" && msg.method !== METHODS.event) {
              c.notifications.push(msg.method);
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

  hello(token: string, clientName: string, extra: Record<string, unknown> = {}, role = "harness"): Promise<any> {
    return this.request(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role, token, clientName, ...extra });
  }

  close(): void { this.socket.end(); }
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("island.pending over the socket", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-island-"));
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const broker = new ApprovalBroker();
    const questions = new QuestionBroker();
    const island = new IslandRegistry({
      pending: {
        approval: (s, id) => broker.pendingMeta(s, id) !== undefined,
        question: (s, id) => questions.isPending(s, id),
        elicitation: () => false,
      },
      facts: (sid) => { const m = store.meta(sid); return { ...(m.mode === undefined ? {} : { mode: m.mode }) }; },
      hosts: (sid) => hub.attachedHarnesses(sid).map((h) => ({ clientName: h.clientName, ...(typeof h.role === "string" ? { role: h.role } : {}), ...(h.tty === undefined ? {} : { tty: h.tty }) })),
    });
    hub.addObserver((e) => island.observe(e));
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, broker, questions, island });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, tokens, broker, island };
  }

  test("an island client is registered by its hello, told on change, and lists cards with their terminal hosts", async () => {
    const { store, hub, socketPath, tokens, broker, island } = await boot();
    const sid = store.createSession("global", { cwd: tmpdir() });
    const app = await TestClient.connect(socketPath);
    expect((await app.hello(tokens.harness, "orb", { capabilities: [CLIENT_CAPABILITY_ISLAND] })).result.ok).toBe(true);
    expect(island.hasClient()).toBe(true);

    // A terminal client attaches with its tty.
    const tui = await TestClient.connect(socketPath);
    expect((await tui.hello(tokens.harness, "tui", { tty: "/dev/ttys007" })).result.ok).toBe(true);
    await tui.request(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });

    void broker.wait(sid, "c1", 60_000, { toolName: "Bash", summary: "rm -rf build" });
    hub.append(sid, { type: "approval_requested", sessionId: sid, threadId: "main", callId: "c1", toolName: "Bash", summary: "rm -rf build" } as never);
    await until(() => app.notifications.includes(ISLAND_CHANGED_NOTIFICATION));

    const res = await app.request(METHODS.islandPending, {});
    const parsed = IslandPendingResult.parse(res.result);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.answerSessionId).toBe(sid);
    expect(parsed.items[0]!.hosts).toEqual([{ clientName: "tui", role: "harness", tty: "/dev/ttys007" }]);

    // Answered elsewhere: gone from the list.
    broker.resolve(sid, "c1", true, "tui");
    hub.append(sid, { type: "approval_resolved", sessionId: sid, threadId: "main", callId: "c1", approved: true, by: "tui" } as never);
    expect(IslandPendingResult.parse((await app.request(METHODS.islandPending, {})).result).items).toEqual([]);

    app.close();
    await until(() => !island.hasClient());
    tui.close();
  });

  test("a client without the capability is no island client; a bad tty is refused; island.pending is local-only", async () => {
    const { socketPath, tokens, island } = await boot();
    const plain = await TestClient.connect(socketPath);
    expect((await plain.hello(tokens.harness, "orb")).result.ok).toBe(true);
    expect(island.hasClient()).toBe(false);
    const bad = await TestClient.connect(socketPath);
    const refused = await bad.hello(tokens.harness, "tui", { tty: "/etc/passwd; rm" });
    expect(refused.error?.code).toBe(ERR.INVALID_PARAMS);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.islandPending)).toBe(false);
    const remote = await TestClient.connect(socketPath);
    await remote.hello(tokens.remote, "iphone-gateway", { capabilities: [CLIENT_CAPABILITY_ISLAND] }, "remote");
    expect(island.hasClient()).toBe(false); // a remote connection never becomes an island client
    expect((await remote.request(METHODS.islandPending, {})).error?.code).toBe(ERR.UNAUTHORIZED);
    plain.close(); bad.close(); remote.close();
  });
});
