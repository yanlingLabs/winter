// The `usage.*` doors (`docs/claude/usage.md`): local harness clients only (refused for a phone and a plugin), the
// subscriptions CRUD over the socket, and — on a real daemon — the tracking switch reloading live from settings.json.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, ERR, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { UsageDb } from "../../src/usage/db";
import { UsagePricer } from "../../src/usage/pricing";
import { UsageService } from "../../src/usage/service";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import { FakeProvider } from "../../src/agent/fake-provider";
import { codexMeta, codexRolloutPath, codexTokenCount, codexTurnContext, fakeCodex, lines, tempDir, probeRootIn } from "./fixtures";

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
            if (msg.id !== undefined && c.pending.has(msg.id)) { c.pending.get(msg.id)!(msg); c.pending.delete(msg.id); }
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

const USAGE_METHODS = [METHODS.usageSummary, METHODS.usageSeries, METHODS.usageSubscriptionsList, METHODS.usageSubscriptionsSet, METHODS.usageSubscriptionsRemove, METHODS.usageSetTracking];

describe("usage.* over the socket", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = tempDir("rpc");
    const store = new SessionStore(home);
    const hub = new SessionHub(store);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets.json")));
    const tokens = await authority.ensureTokens();
    const db = new UsageDb(join(home, "usage", "usage.db"));
    const usage = new UsageService({
      db, pricer: new UsagePricer(), tracking: () => ({ codex: true, claudeCode: true, antigravity: true, opencode: true }), codexExecutable: () => undefined, claudeExecutable: () => undefined,
      winterCodexWindows: () => [], probeRoot: () => probeRootIn(home),
    });
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, hub, usage, winterHome: home });
    stop = () => { server.stop(); store.close(); db.close(); };
    return { home, store, socketPath, tokens, usage };
  }

  test("local harness clients only: refused for a phone (remote) and a plugin; none is remote-allowlisted", async () => {
    const { store, socketPath, tokens } = await boot();
    const app = await TestClient.connect(socketPath);
    await app.hello(tokens.harness, "orb");
    const summary = (await app.request(METHODS.usageSummary, { range: "24h" })).result;
    expect(summary).toMatchObject({ range: "24h", totals: { costUsd: 0 }, plans: { codex: { source: "not-installed" }, claudeCode: { source: "not-installed" } } });
    expect((await app.request(METHODS.usageSeries, { range: "all", sources: ["codex"] })).result.buckets.length).toBeGreaterThan(0);
    expect((await app.request(METHODS.usageSummary, { range: "forever" })).error?.code).toBe(ERR.INVALID_PARAMS);

    for (const m of USAGE_METHODS) expect(REMOTE_ALLOWED_METHODS.has(m)).toBe(false);
    const remote = await TestClient.connect(socketPath);
    await remote.hello(tokens.remote, "iphone-gateway", {}, "remote");
    const plugin = await TestClient.connect(socketPath);
    await plugin.hello(store.mintPluginToken("example-plugin"), "example-plugin", { pluginId: "example-plugin" }, "plugin");
    for (const m of USAGE_METHODS) {
      expect((await remote.request(m, {})).error?.code).toBe(ERR.UNAUTHORIZED);
      expect((await plugin.request(m, {})).error?.code).toBe(ERR.UNAUTHORIZED);
    }
    app.close(); remote.close(); plugin.close();
  });

  test("subscriptions: set (validated), list with the cycle, update, remove", async () => {
    const { socketPath, tokens } = await boot();
    const app = await TestClient.connect(socketPath);
    await app.hello(tokens.harness, "orb");
    const bad = await app.request(METHODS.usageSubscriptionsSet, { subscription: { name: "", provider: "openai", price: -1, currency: "usd", cadence: "monthly", renewalDay: 40 } });
    expect(bad.error?.code).toBe(ERR.INVALID_PARAMS);
    const set = (await app.request(METHODS.usageSubscriptionsSet, { subscription: { name: "Claude Max", provider: "anthropic", price: 100, currency: "usd", cadence: "monthly", renewalDay: 3, covers: ["claude-code"] } })).result;
    expect(set.subscription).toMatchObject({ name: "Claude Max", currency: "USD", covers: ["claude-code"] });
    expect(set.subscriptions[0]).toMatchObject({ monthlyCost: 100, usageThisCycleUsd: 0 });
    expect(typeof set.subscriptions[0].nextRenewal).toBe("number");
    const upd = (await app.request(METHODS.usageSubscriptionsSet, { subscription: { ...set.subscription, price: 200, cadence: "yearly", renewalMonth: 2 } })).result;
    expect(upd.subscriptions).toHaveLength(1);
    expect(upd.subscriptions[0]).toMatchObject({ price: 200, cadence: "yearly", monthlyCost: 200 / 12 });
    expect((await app.request(METHODS.usageSubscriptionsList, {})).result.subscriptions).toHaveLength(1);
    expect((await app.request(METHODS.usageSubscriptionsRemove, { id: set.subscription.id })).result).toMatchObject({ removed: true, subscriptions: [] });
    app.close();
  });

  test("usage.setTracking writes settings.usage (the one block), keeping the rest of settings.json", async () => {
    const { home, socketPath, tokens } = await boot();
    writeFileSync(join(home, "settings.json"), JSON.stringify({ legacy: { readLegacyProjectFiles: false } }));
    const app = await TestClient.connect(socketPath);
    await app.hello(tokens.harness, "orb");
    const r = (await app.request(METHODS.usageSetTracking, { claudeCode: false, antigravity: false, opencode: false })).result;
    expect(r.tracking).toEqual({ codex: true, claudeCode: false, antigravity: false, opencode: false });
    const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(saved.usage).toEqual({ claudeCode: { enabled: false }, antigravity: { enabled: false }, opencode: { enabled: false } });
    expect(saved.legacy).toEqual({ readLegacyProjectFiles: false });
    app.close();
  });
});

describe("on a real daemon", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => { await daemon?.stop(); daemon = undefined; });

  test("Winter-side: the tracking switch reloads LIVE (no restart) — off: nothing read, nothing spawned; on again: ingested", async () => {
    const home = tempDir("daemon");
    const codexHome = tempDir("codex");
    const at = Date.now() - 60_000;
    writeFileSync(codexRolloutPath(codexHome, at, "live"), lines(codexMeta(at, "sess-live"), codexTurnContext(at, "gpt-5.1"),
      codexTokenCount(at + 1, { input: 100, cached: 0, output: 10, reasoning: 0 }, { input: 100, cached: 0, output: 10, reasoning: 0 })));
    const fake = fakeCodex(tempDir("bin"), "ok");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ usage: { codex: { enabled: false } } }));
    daemon = await startDaemon({
      // A provider-backed daemon: the one shape that runs the settings.json watcher (production always has one).
      home, secrets: new FileSecretStore(join(home, "test-secrets")), agentProvider: { provider: new FakeProvider([]), model: "fake-1" },
      usage: { codexHome, claudeHome: null, claudeJsonPath: null, codexExecutable: fake.path, claudeExecutable: null },
    });
    expect(existsSync(join(home, "usage", "usage.db"))).toBe(true);
    const app = await TestClient.connect(daemon.socketPath);
    await app.hello(daemon.tokens.harness, "orb");
    let s = (await app.request(METHODS.usageSummary, { range: "24h", sources: ["codex"] })).result;
    expect(s.tracking.codex).toBe(false);
    expect(s.plans.codex.source).toBe("disabled");
    expect(s.totals.records).toBe(0);
    expect(existsSync(fake.markerPath)).toBe(false);
    // The switch, through the door (settings.json → the watcher → the live holder).
    await app.request(METHODS.usageSetTracking, { codex: true });
    const end = Date.now() + 5_000;
    do {
      await Bun.sleep(50);
      s = (await app.request(METHODS.usageSummary, { range: "24h", sources: ["codex"] })).result;
    } while (!s.tracking.codex && Date.now() < end);
    expect(s.tracking.codex).toBe(true);
    // The throttle may hold the first pass back; a series call waits for the ingest.
    await app.request(METHODS.usageSeries, { range: "24h" });
    s = (await app.request(METHODS.usageSummary, { range: "24h", sources: ["codex"] })).result;
    expect(s.totals.records).toBe(1);
    expect(s.plans.codex.source).toBe("codex-app-server");
    app.close();
  }, 30_000);
});

void tmpdir;
