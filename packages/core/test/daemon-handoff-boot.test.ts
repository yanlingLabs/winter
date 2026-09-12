// P8c integration round 3, item 1 — proves `daemon.ts`'s OWN boot wiring for lane 4's handoff
// door: the ONE `registerHandoffParticipants` call at boot (never inside an RPC case) runs with
// this daemon's REAL objects, and `session.send` on an engine-era fixture session imports it
// through the REAL daemon (not `startIpcServer` with a fake driver table — that RPC-unit proof is
// `test/ipc/session-send-import.test.ts`'s job).
//
// `mock.module` overwrites the export on the (possibly already-loaded) module's own namespace
// object in place — per bun:test's own doc comment, "if the module is already loaded, exports are
// overwritten" — so this works regardless of import order (`official-session.test.ts`'s own
// precedent). Undone in `afterAll` so no other test file sharing this process sees the spy.
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { installMockModuleTripwire } from "./mock-module-tripwire";
// m6: called BEFORE the first `mock.module` below, so it is counted (see that file's own header —
// the check itself still runs LAST, deferred to a microtask past this file's whole synchronous body).
installMockModuleTripwire();
import * as handoffModule from "../src/runtime-sdk/handoff";

let registeredWith: Parameters<typeof handoffModule.registerHandoffParticipants>[0] | undefined;
// The ORIGINAL function is captured into its own binding BEFORE `mock.module` runs: `mock.module`
// overwrites `handoffModule`'s own exports IN PLACE (a live namespace object), so a wrapper that
// called `handoffModule.registerHandoffParticipants(...)` would be calling ITSELF once the mock is
// installed — infinite synchronous self-recursion (measured: a silent hang with zero further
// output, not a stack-overflow throw, because the child socket/event loop never gets a turn).
const originalRegisterHandoffParticipants = handoffModule.registerHandoffParticipants;
mock.module("../src/runtime-sdk/handoff", () => ({
  ...handoffModule,
  registerHandoffParticipants: (deps: Parameters<typeof handoffModule.registerHandoffParticipants>[0]) => {
    registeredWith = deps;
    return originalRegisterHandoffParticipants(deps);
  },
}));
afterAll(() => {
  mock.module("../src/runtime-sdk/handoff", () => handoffModule);
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { FileSecretStore } from "../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { SessionStore } from "../src/sessions/store";
import { sessionLegOf } from "../src/runtime-sdk/leg";
import { describeWithWinterBinary } from "./helpers/winter-binary";
import { withTempHome } from "./runtime-state/support";

class TestClient {
  private decoder = new LineDecoder();
  private nextId = 1;
  private pending = new Map<number, (msg: { result?: unknown; error?: { code: number; message: string } }) => void>();
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
          }
        },
        drain() { c.writer.onDrain(); },
      },
    });
    c.writer = new ConnWriter(c.socket as unknown as WritableSocket);
    return c;
  }
  request(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = this.nextId++;
    this.writer.enqueue(encodeLine({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call<T>(method: string, params?: unknown): Promise<T> {
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { rpc: r.error });
    return r.result as T;
  }
  async hello(token: string, clientName: string): Promise<void> {
    await this.call(METHODS.hello, { protocolVersion: PROTOCOL_VERSION, role: "harness", token, clientName });
  }
  close(): void { this.socket.end(); }
}

let daemon: RunningDaemon | undefined;
afterEach(async () => {
  registeredWith = undefined;
  const stopping = daemon?.stop();
  daemon = undefined;
  await stopping;
});

describeWithWinterBinary("daemon.ts's boot wiring for lane 4's handoff door", (bin) => {
  test("registerHandoffParticipants runs at boot with this daemon's OWN objects, and session.send imports an engine-era fixture end to end", async () => {
    await withTempHome(async (home) => {
      const cwd = home; // no separate workdir needed for this fixture
      // `settings.provider` names a provider so the boot's own §17 backfill runs (wiring.ts skips
      // it otherwise) — the pre-seeded plain-store session below is what it backfills into an
      // "engine"-leg record. `provider.model` is a real winter-test double: the engine-era row
      // itself carries NO model (set below), so `session-driver.ts`'s `optionsFor` falls back to
      // this settings default once the import makes the session resumable.
      writeFileSync(join(home, "settings.json"), JSON.stringify({
        schemaVersion: 2,
        provider: { type: "openai-compatible", model: "winter-test/echo", baseUrl: "http://127.0.0.1:9/v1" },
        runtimes: { winterExecutable: bin, winterLeg: { code: true }, winterIdleTimeoutSec: 10 },
      }, null, 2));

      // The SAME fixture shape `test/e2e/import-legacy-real-child.test.ts` builds (a pre-8b daemon's
      // own log): a plain SessionStore session, no runtime-state record yet — the boot's own
      // backfill (not this test) is what turns it into an "engine"-leg row.
      const seedStore = new SessionStore(home);
      const sid = seedStore.createSession("e2e", { cwd });
      seedStore.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "What is 2+2?", clientName: "cli" });
      seedStore.append(sid, { type: "turn_started", sessionId: sid, threadId: "main" });
      seedStore.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "4" });
      seedStore.append(sid, { type: "turn_completed", sessionId: sid, threadId: "main", stopReason: "end_turn", inputTokens: 5, outputTokens: 1 });

      daemon = await startDaemon({ home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: null });
      if ("unavailable" in daemon.runtimeState) throw daemon.runtimeState.unavailable;

      // ── Evidence 1: the boot wiring ran, with THIS daemon's own objects ──────────────────────
      expect(registeredWith).toBeDefined();
      expect(daemon.runtimeSdk).toBeDefined();
      expect(registeredWith!.winter).toBe(daemon.winter);
      expect(registeredWith!.store).toBe(daemon.sessions);
      expect(registeredWith!.runtime).toBe(daemon.runtimeSdk!);
      expect(registeredWith!.records).toBe(daemon.runtimeState.records);

      // The boot's own §17 backfill (gated on settings naming a provider) turned the pre-seeded
      // session into an engine-era record — confirms the fixture is shaped as intended BEFORE the
      // import door is exercised.
      expect(sessionLegOf(daemon.runtimeState.records.get(sid))).toBe("engine");

      // ── Evidence 2: session.send on that engine-era session imports it, end to end ───────────
      const client = await TestClient.connect(daemon.socketPath);
      await client.hello(daemon.tokens.harness, "e2e");
      await client.call(METHODS.sessionAttach, { sessionId: sid, fromSeq: 0 });
      const { seq } = await client.call<{ seq: number }>(METHODS.sessionSend, { sessionId: sid, text: "and 2+3?" });
      expect(seq).toBeGreaterThan(0);

      // The record now names a resumable leg with a real backend transcript — the import door's
      // whole point (P8c-6): a permanently-refused session is now a live Winter one.
      const after = daemon.runtimeState.records.get(sid);
      expect(sessionLegOf(after)).toBe("winter");
      expect(after?.backendSessionId).toBeDefined();

      client.close();
      // Stopped HERE, before `withTempHome`'s own `finally` removes `home` — that removal races a
      // daemon still holding the SAME `runtime-state.db` file open, which `afterEach` below would
      // otherwise only reach AFTER `withTempHome` already deleted it out from under a live SQLite
      // handle (measured: "disk I/O error" / SQLITE_IOERR_VNODE during the LATE stop's own
      // shutdown-time session detach).
      await daemon.stop();
      daemon = undefined;
    });
  }, 60_000);
});
