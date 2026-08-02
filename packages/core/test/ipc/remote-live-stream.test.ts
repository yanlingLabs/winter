import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, TRANSIENT_EVENT_TYPES,
  type SessionEvent, type WritableSocket,
} from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { HISTORY_EVENT_TYPES, WHOLE_EVENT_CEILING } from "../../src/sessions/history";
import { REMOTE_STREAM_EVENT_TYPES } from "../../src/sessions/remote-stream";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// ==============================================================================================
// The LIVE + REPLAY event stream of a REMOTE (phone) connection — the half of the phone-facing
// transcript surface that never got `session.history`'s guarantees.
//
// `session.history` has been allowlist-filtered AND size-capped since it shipped. The live/replay
// feed carries the SAME transcript to the SAME phone over the SAME link, and had neither. Two
// concrete holes, both closed daemon-side by `sessions/remote-stream.ts`:
//
//   1. `reasoning_item` — provider-opaque `encrypted_content`, whose only sink is the session
//      JSONL (CLAUDE.md) — was forwarded verbatim on attach replay and live. Nothing in the daemon
//      stopped it. What kept it off the phone in practice was an ACCIDENT: `apple/NormaProtocol`
//      has no `reasoningItem` variant, so `NormaClient` decodes the line as `.unknownEvent` and the
//      Swift `Gateway` drops it for lack of a `.session` case. Mirroring the variant into Swift is
//      exactly what CLAUDE.md's own protocol checklist tells the next person to do — and the day
//      they do, the opaque payload starts flowing, with no test to stop it. It also only ever
//      protected the SWIFT client: any other remote-role consumer of this socket (norma-probe,
//      norma-fake-phone, a non-Mac-mediated client) reads the raw line.
//
//   2. No size ceiling, against a transport whose overflow is a SILENT KILL. The phone de-frames
//      with a hard 1 MiB cap (`LengthPrefix.unwrap` / `IrohConn.readLoop`); an oversize frame is
//      caught, the inbound stream is `finish()`ed, and the phone just reconnects — no error frame,
//      nothing logged on either side. An oversized event sitting in the attach REPLAY window
//      therefore kills the connection on every single attach: reconnect, replay, die, repeat. That
//      is precisely the reported "it reconnects every time I open a chat".
//
// Both are pinned here at the daemon seam (`session.attach`'s HubClient), on BOTH paths, with a
// harness-role CONTROL proving local clients are untouched.
// ==============================================================================================

/** Raw NDJSON JSON-RPC test client — the per-file copy every test/ipc suite carries, extended to
 *  RETAIN `session.event` notifications (this suite is about what does and doesn't reach the wire,
 *  so the events are the assertion surface, not the responses). */
class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();
  private socket!: Awaited<ReturnType<typeof Bun.connect>>;
  private writer!: ConnWriter;
  readonly events: any[] = [];
  readonly rawLines: string[] = [];

  static async connect(socketPath: string): Promise<TestClient> {
    const c = new TestClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_s, chunk) {
          for (const line of c.decoder.push(chunk)) {
            const msg = JSON.parse(line);
            if (msg.method === METHODS.event) {
              c.rawLines.push(line);
              c.events.push(msg.params);
              continue;
            }
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

  types(): string[] { return this.events.map((e) => e.type); }
  ofType(type: string): any[] { return this.events.filter((e) => e.type === type); }
  close(): void { this.socket.end(); }
}

const SECRET = "opaque-provider-encrypted_content-blob";

/** Waits until `predicate` holds, or fails the test. Events arrive as unsolicited notifications, so
 *  there is no response to await — poll instead. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("remote live/replay stream: allowlist + size cap (iOS remote-path T2)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(): Promise<{
    store: SessionStore; hub: SessionHub; socketPath: string; harnessToken: string; remoteToken: string;
  }> {
    const home = mkdtempSync(join(tmpdir(), "norma-remote-live-"));
    const store = new SessionStore(home);
    // Our OWN hub instance, threaded into the server: `broadcastTransient` is the only way to
    // produce a genuine transient (it is deliberately not reachable over any RPC), and the daemon
    // shares exactly this way with the agent engine.
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub });
    stop = () => { server.stop(); store.close(); };
    return { store, hub, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  /** A remote-eligible session (mode "code") carrying a reasoning_item between two ordinary
   *  messages — the exact shape a real turn persists. */
  function seedSessionWithReasoning(store: SessionStore): string {
    const sessionId = store.createSession("global", { mode: "code" });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "think about it", clientName: "cli" });
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: SECRET });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "done" });
    return sessionId;
  }

  // ---------------------------------------------------------------------------------------------
  // Hole 1: the opaque reasoning_item
  // ---------------------------------------------------------------------------------------------

  test("SECURITY (REPLAY): a remote attach never replays reasoning_item, and never its encrypted_content", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = seedSessionWithReasoning(store);

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    const attached = await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    expect(attached.error).toBeUndefined();

    await waitFor(() => phone.types().includes("harness_attached"), "the replay to finish");
    expect(phone.types()).not.toContain("reasoning_item");
    expect(phone.rawLines.join("\n")).not.toContain(SECRET);
    // The events AROUND it still arrive — this is a filter, not an outage.
    expect(phone.types()).toContain("user_message");
    expect(phone.types()).toContain("assistant_message");
    phone.close();
  });

  test("SECURITY (LIVE): a reasoning_item appended while attached never reaches a remote client", async () => {
    const { store, hub, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.types().includes("harness_attached"), "the attach to settle");

    hub.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: SECRET });
    // A barrier the phone IS allowed to see — once it lands, the reasoning_item ahead of it has
    // provably been offered to the same `deliver` and dropped (fan-out is synchronous, in order).
    hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "after" });

    await waitFor(() => phone.types().includes("assistant_message"), "the barrier event");
    expect(phone.types()).not.toContain("reasoning_item");
    expect(phone.rawLines.join("\n")).not.toContain(SECRET);
    phone.close();
  });

  test("CONTROL: a HARNESS client still receives reasoning_item on both paths — the policy is remote-scoped", async () => {
    const { store, hub, socketPath, harnessToken } = await boot();
    const sessionId = seedSessionWithReasoning(store);

    const mac = await TestClient.connect(socketPath);
    await mac.hello(harnessToken, "norma.app", "harness");
    await mac.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => mac.types().includes("harness_attached"), "the replay to finish");
    expect(mac.types()).toContain("reasoning_item"); // replay
    expect(mac.rawLines.join("\n")).toContain(SECRET);

    hub.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: "live-secret" });
    await waitFor(() => mac.ofType("reasoning_item").length === 2, "the live reasoning_item");
    expect(mac.rawLines.join("\n")).toContain("live-secret"); // live
    mac.close();
  });

  // ---------------------------------------------------------------------------------------------
  // Hole 2: the 1 MiB frame cliff
  // ---------------------------------------------------------------------------------------------

  /** A schema-valid `tool_call` far past the phone's 1 MiB frame limit. `argsJson` is the realistic
   *  vector: the tool REGISTRY caps tool OUTPUT at 64 KiB, but nothing caps tool ARGUMENTS — a
   *  `write` of a large file carries the whole body here, and `tool_call` is allowlisted (the phone
   *  renders it). */
  function appendOversizedToolCall(store: SessionStore, sessionId: string): SessionEvent {
    const huge = "x".repeat(2 * 1024 * 1024);
    return store.append(sessionId, {
      type: "tool_call", sessionId, threadId: "main", callId: "call_big", name: "write",
      argsJson: JSON.stringify({ path: "/tmp/big.txt", content: huge }),
    });
  }

  test("an oversized event is CAPPED on REPLAY and the stream keeps flowing (the reconnect loop)", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });
    const raw = appendOversizedToolCall(store, sessionId);
    // The premise: uncapped, this single event is well past the phone's hard frame limit, and its
    // overflow path is a silent `cont.finish()` → reconnect → replay the same event → repeat.
    expect(Buffer.byteLength(JSON.stringify(raw), "utf8")).toBeGreaterThan(1024 * 1024);
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "after the big one" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.types().includes("harness_attached"), "the replay to finish");

    const delivered = phone.ofType("tool_call");
    expect(delivered.length).toBe(1); // capped, NOT dropped — the phone still renders the call
    expect(Buffer.byteLength(JSON.stringify(delivered[0]), "utf8")).toBeLessThanOrEqual(WHOLE_EVENT_CEILING);
    // Every frame this connection was sent stays under the transport's limit, with headroom.
    for (const line of phone.rawLines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1024 * 1024);
    }
    // The connection survives the oversized event: everything after it replays normally.
    expect(phone.types()).toContain("assistant_message");
    phone.close();
  });

  test("an oversized event is CAPPED on the LIVE path too, and later events still arrive", async () => {
    const { store, hub, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.types().includes("harness_attached"), "the attach to settle");

    hub.append(sessionId, {
      type: "tool_call", sessionId, threadId: "main", callId: "call_big", name: "write",
      argsJson: JSON.stringify({ path: "/tmp/big.txt", content: "y".repeat(2 * 1024 * 1024) }),
    });
    hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "still here" });

    await waitFor(() => phone.types().includes("assistant_message"), "the event after the big one");
    const delivered = phone.ofType("tool_call");
    expect(delivered.length).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(delivered[0]), "utf8")).toBeLessThanOrEqual(WHOLE_EVENT_CEILING);
    for (const line of phone.rawLines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1024 * 1024);
    }
    phone.close();
  });

  test("CONTROL: an ordinary event is forwarded byte-identically — the cap is a no-op below the ceiling", async () => {
    const { store, hub, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.types().includes("harness_attached"), "the attach to settle");

    const appended = hub.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "a perfectly ordinary reply" });
    await waitFor(() => phone.types().includes("assistant_message"), "the event");
    expect(phone.ofType("assistant_message")[0]).toEqual(JSON.parse(JSON.stringify(appended)));
    phone.close();
  });

  // ---------------------------------------------------------------------------------------------
  // The correction the plan itself nearly got wrong: transients must SURVIVE this filter
  // ---------------------------------------------------------------------------------------------

  test("all eight TRANSIENT types reach a remote client — the live policy is history's allowlist PLUS these", async () => {
    const { store, hub, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.types().includes("harness_attached"), "the attach to settle");

    const holder = { kind: "session" as const, id: sessionId };
    hub.broadcastTransient(sessionId, { type: "assistant_delta", sessionId, threadId: "main", delta: "chunk-1" });
    hub.broadcastTransient(sessionId, { type: "lease_granted", sessionId, threadId: "main", leaseId: "l1", class: "screenshot", holder, expiresAt: 0, tokenHash: "abc" });
    hub.broadcastTransient(sessionId, { type: "lease_lost", sessionId, threadId: "main", leaseId: "l1", class: "screenshot", holder, reason: "released" });
    hub.broadcastTransient(sessionId, { type: "peripheral_call_requested", sessionId, threadId: "main", requestId: "r1", leaseId: "l1", token: "t", class: "screenshot", payloadJson: "{}" });
    hub.broadcastTransient(sessionId, { type: "plugin_tool_invoke", sessionId, threadId: "main", requestId: "r2", tool: "t", argsJson: "{}" });
    hub.broadcastTransient(sessionId, { type: "hardware_requested", sessionId, threadId: "main", requestId: "r3", verb: "v", argsJson: "{}" });
    hub.broadcastTransient(sessionId, { type: "plugin_tile_updated", sessionId, pluginId: "p1", tile: null });
    hub.broadcastTransient(sessionId, { type: "session_activity", sessionId, activity: "background" });

    // Keyed to this broadcast's own VALUE, not just its type: since T5 the attach above emits a
    // `session_activity` of its own ("active"), so a type-only wait would already be satisfied
    // before any of the eight broadcasts had crossed the socket.
    await waitFor(() => phone.ofType("session_activity").some((e: any) => e.activity === "background"), "the last transient");
    for (const t of TRANSIENT_EVENT_TYPES) {
      expect(phone.types()).toContain(t);
    }
    phone.close();
  });

  test("REGRESSION: a transient at seq == the store's head is still forwarded (its seq is BORROWED, never its own)", async () => {
    const { store, hub, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });
    await waitFor(() => phone.types().includes("harness_attached"), "the attach to settle");

    const persisted = hub.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hi", clientName: "phone" });
    const deltas = ["a", "b", "c", "d"].map((d) =>
      hub.broadcastTransient(sessionId, { type: "assistant_delta", sessionId, threadId: "main", delta: d }));

    await waitFor(() => phone.ofType("assistant_delta").length === 4, "all four deltas");
    // The shape that makes this a real regression test: every delta carries the seq of the
    // PERSISTED event before it, not one of its own. A seq-ordered filter (or a client that
    // deduped on seq) would kill all four.
    for (const d of deltas) expect(d.seq).toBe(persisted.seq);
    expect(phone.ofType("assistant_delta").map((e) => e.delta)).toEqual(["a", "b", "c", "d"]);
    phone.close();
  });

  test("harness_attached still reaches remote — it is the Gateway's REPLAY TERMINATOR, not just noise", async () => {
    const { store, socketPath, remoteToken } = await boot();
    const sessionId = store.createSession("global", { mode: "code" });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hi", clientName: "cli" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    const attached = await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    // `session.attach` returns the seq of the harness_attached it just appended, and the Swift
    // Gateway's `attachAndReplay` waits for an event with THAT seq to arrive before it will flush
    // the replay (`awaitReplayBatch`: `collected.last.seq >= target`). Filter this type here and
    // every attach — every chat open, every reconnect — stalls on that collector's 5s watchdog
    // instead. The Gateway drops it one hop later (`isHarnessNoise`), which is where SP2a gate G1's
    // "no harness_attached leak" is actually enforced.
    await waitFor(() => phone.types().includes("harness_attached"), "the replay terminator");
    const terminator = phone.ofType("harness_attached").at(-1);
    expect(terminator.seq).toBe(attached.result.lastSeq);
    phone.close();
  });

  test("session_created still reaches remote — a fresh session's ONLY replayable event, and the attach-ordering contract's vehicle", async () => {
    const { store, socketPath, remoteToken } = await boot();
    // A brand-new session, exactly as `session.dispatch` mints it: session_created (seq 1) is all
    // there is to replay. `IrohE2ETests` scenarios B and D pin over the REAL transport that this
    // event arrives BEFORE the attach's own rpcResponse ("the attach's own replay must precede its
    // rpcResponse") — filtering it here broke both. It also flips a fresh session's resume verdict:
    // an empty content batch makes the gateway's watermark fall back to `fromSeq`. It carries
    // `{scope, mode}` only — no user text, no filesystem path — so there is nothing to gain by
    // excluding it.
    const sessionId = store.createSession("global", { mode: "dispatch" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");
    await phone.request(METHODS.sessionAttach, { sessionId, fromSeq: 0 });

    await waitFor(() => phone.types().includes("harness_attached"), "the replay to finish");
    expect(phone.types()[0]).toBe("session_created");
    expect(phone.ofType("session_created")[0].seq).toBe(1);
    phone.close();
  });

  // ---------------------------------------------------------------------------------------------
  // The policy itself
  // ---------------------------------------------------------------------------------------------

  test("REMOTE_STREAM_EVENT_TYPES is EXACTLY history's allowlist + the seven transients + the three stream-control types", () => {
    const expected = new Set<string>([
      ...HISTORY_EVENT_TYPES,
      ...TRANSIENT_EVENT_TYPES,
      "harness_attached", "harness_detached", "session_created",
    ]);
    // Widening cast (the idiom test/sessions/history.test.ts already uses on HISTORY_EVENT_TYPES):
    // the set is a ReadonlySet<SessionEvent["type"]>, so the spread is a union-typed array that
    // toEqual won't accept against a plain string[].
    expect([...REMOTE_STREAM_EVENT_TYPES].sort() as string[]).toEqual([...expected].sort());
    // Growth log: 20 → 21 (session-activity-hygiene T4, `session_activity` — via the transients).
    expect(REMOTE_STREAM_EVENT_TYPES.size).toBe(21);
    // The one exclusion the whole first half of this file is about.
    expect(REMOTE_STREAM_EVENT_TYPES.has("reasoning_item" as SessionEvent["type"])).toBe(false);
    // ...and the ones that would have quietly reverted the phone-client streaming fix.
    for (const t of TRANSIENT_EVENT_TYPES) expect(REMOTE_STREAM_EVENT_TYPES.has(t)).toBe(true);
  });

  test("TRANSIENT_EVENT_TYPES is EXACTLY the eight — the Swift mirror pins the same literals", () => {
    // Parity, remote-allowlist style: neither side imports the other, each pins its own copy to
    // these literal strings, so editing one alone fails here or in
    // `apple/NormaProtocol/.../SessionEventTransientTests.swift` (SessionEvent.transientTypes).
    //
    // Growth log: 7 → 8 (session-activity-hygiene T4, `session_activity`).
    expect([...TRANSIENT_EVENT_TYPES].sort()).toEqual([
      "assistant_delta",
      "hardware_requested",
      "lease_granted",
      "lease_lost",
      "peripheral_call_requested",
      "plugin_tile_updated",
      "plugin_tool_invoke",
      "session_activity",
    ]);
    expect(TRANSIENT_EVENT_TYPES.size).toBe(8);
  });

  // ---------------------------------------------------------------------------------------------
  // sync.pull is a DIFFERENT surface and must stay unfiltered
  // ---------------------------------------------------------------------------------------------

  test("sync.pull over a REMOTE connection still replicates reasoning_item verbatim (store replication, not display)", async () => {
    const { store, socketPath, remoteToken } = await boot();
    // sync.* is chat-session-only (its own handler gate) — the phone's standalone-chat replication.
    const sessionId = store.createSession("global", { mode: "chat", approvalPolicy: "chat" as any });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "think about it", clientName: "cli" });
    store.append(sessionId, { type: "reasoning_item", sessionId, threadId: "main", itemJson: SECRET });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "done" });

    const phone = await TestClient.connect(socketPath);
    await phone.hello(remoteToken, "iphone-gateway", "remote");

    // The decision is documented in test/ipc/sync-reasoning-item-decision.test.ts; its two existing
    // cases run over a HARNESS connection, so nothing there would have caught this filter leaking
    // onto the replication path. `sync.pull` is byte-for-byte store replication to an
    // explicitly-paired device — a filtered replica is not a replica, and a push-back would
    // rewrite the Mac's own log with the holes in it.
    const res = await phone.request(METHODS.syncPull, { sessionId, fromSeq: 0 });
    expect(res.error).toBeUndefined();
    const jsonl = Buffer.from(res.result.data, "base64").toString("utf8");
    const types = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
    expect(types).toContain("reasoning_item");
    expect(jsonl).toContain(SECRET);
    phone.close();
  });
});
