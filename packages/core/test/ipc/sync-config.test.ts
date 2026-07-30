import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { syncConfig, syncMemory, SYNC_PAGE_BYTES, SYNC_MEMORY_TRUNCATION_MARKER } from "../../src/ipc/sync";
import { EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import type { SecretStore } from "../../src/auth/secret-store";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Chat Slice D task 3 — the two remaining sync surfaces, for the phone's OWN standalone chat
// rather than log replication:
//
//  - sync.config {}          → { exaKey, dangerousDomains, defaultModel }  (all read HOT, at call time)
//  - sync.memory { cursor? } → { files: [{name, content}], nextCursor?, complete }
//
// Neither carries a `sessionId` — both stay REMOTE_ALLOWED_METHODS-listed anyway (the phone is the
// only client that has ever needed them). Secrets never touch disk in this file: the fake
// SecretStore below is a plain in-memory object, same "injected fake, not a real Keychain/file
// write" precedent test/agent/chat-search.test.ts's `secret: async () => "exa_test_key"` already
// follows for the Search tool's identical dependency.

/** In-memory-only fake — NEVER writes to disk (unlike `FileSecretStore`, which is disk-backed and
 *  reserved for the allowlist-parity test elsewhere in this suite that needs a real `TokenAuthority`
 *  boot). Constructor seeds it directly; `set()` is unused here but kept for interface conformance. */
class FakeSecretStore implements SecretStore {
  private readonly values = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.values.set(k, v);
  }
  async get(name: string): Promise<string | null> { return this.values.get(name) ?? null; }
  async set(name: string, value: string): Promise<void> { this.values.set(name, value); }
}

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

describe("sync.config (Chat Slice D task 3)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(over: {
    secrets?: SecretStore;
    dangerousDomainsAdded?: (cwd?: string) => string[] | undefined;
    liveModel?: () => string;
  } = {}): Promise<{ home: string; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-config-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      secrets: over.secrets, dangerousDomainsAdded: over.dangerousDomainsAdded, liveModel: over.liveModel,
    });
    stop = () => { server.stop(); store.close(); };
    return { home, socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("returns the stored Exa key, the user-added dangerous domains, and the live default model", async () => {
    const secrets = new FakeSecretStore({ [EXA_API_KEY_SECRET]: "exa_live_key" });
    const { socketPath, harnessToken } = await boot({
      secrets,
      dangerousDomainsAdded: () => ["evil.example.com", "totally-fine.example"],
      liveModel: () => "claude-opus-5",
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      exaKey: "exa_live_key",
      dangerousDomains: ["evil.example.com", "totally-fine.example"],
      defaultModel: "claude-opus-5",
    });
    c.close();
  });

  test("no stored key -> exaKey is null, never an empty string", async () => {
    const { socketPath, harnessToken } = await boot({ secrets: new FakeSecretStore() });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    expect(res.result.exaKey).toBeNull();
    c.close();
  });

  test("no secrets/dangerousDomainsAdded/liveModel wired at all -> safe empty defaults, never a crash", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ exaKey: null, dangerousDomains: [], defaultModel: "" });
    c.close();
  });

  test("every field is read HOT, at call time — no daemon restart needed to see a change", async () => {
    let key: string | null = "first-key";
    let domains: string[] = ["first.example"];
    let model = "gpt-5-first";
    const secrets: SecretStore = {
      get: async (name) => (name === EXA_API_KEY_SECRET ? key : null),
      set: async () => {},
    };
    const { socketPath, harnessToken } = await boot({
      secrets, dangerousDomainsAdded: () => domains, liveModel: () => model,
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const before = await c.request(METHODS.syncConfig, {});
    expect(before.result).toEqual({ exaKey: "first-key", dangerousDomains: ["first.example"], defaultModel: "gpt-5-first" });

    // Simulate a live settings/keychain change WITHOUT restarting anything — same closures, new values.
    key = "second-key";
    domains = ["first.example", "second.example"];
    model = "gpt-5-second";

    const after = await c.request(METHODS.syncConfig, {});
    expect(after.result).toEqual({ exaKey: "second-key", dangerousDomains: ["first.example", "second.example"], defaultModel: "gpt-5-second" });
    c.close();
  });

  test("a REMOTE (phone) caller may call sync.config with no session context at all", async () => {
    const { socketPath, remoteToken } = await boot({
      secrets: new FakeSecretStore({ [EXA_API_KEY_SECRET]: "k" }),
      dangerousDomainsAdded: () => [],
      liveModel: () => "m",
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    expect(res.result.defaultModel).toBe("m");
    c.close();
  });

  // ----------------------------------------------------------------------------------------------
  // Direct unit tests of `syncConfig()` — the secret accessor never touches disk (in-memory closures
  // only), no server/socket involved.
  // ----------------------------------------------------------------------------------------------

  test("syncConfig() drops undefined dangerousDomainsAdded()/absent secret to the safe defaults", async () => {
    const result = await syncConfig({});
    expect(result).toEqual({ exaKey: null, dangerousDomains: [], defaultModel: "" });
  });

  test("syncConfig() reads the secret through EXA_API_KEY_SECRET, the SAME name Search uses", async () => {
    const seen: string[] = [];
    const result = await syncConfig({
      secret: async (name) => { seen.push(name); return "abc"; },
      dangerousDomainsAdded: () => undefined,
      liveModel: () => "m",
    });
    expect(seen).toEqual([EXA_API_KEY_SECRET]);
    expect(result.exaKey).toBe("abc");
    expect(result.dangerousDomains).toEqual([]); // undefined from the getter -> []
  });
});

describe("sync.memory (Chat Slice D task 3)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  function assistantDir(home: string): string {
    return join(home, "projects", "_assistant", "memory");
  }

  async function boot(home: string): Promise<{ socketPath: string; harnessToken: string; remoteToken: string }> {
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, normaHome: home });
    stop = () => { server.stop(); store.close(); };
    return { socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("an empty (never-dreamed) bucket -> {files: [], complete: true}", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    const { socketPath, harnessToken } = await boot(home);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncMemory, {});
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ files: [], complete: true });
    c.close();
  });

  test("a bucket directory that exists but holds nothing -> {files: [], complete: true}", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    mkdirSync(assistantDir(home), { recursive: true });
    const { socketPath, harnessToken } = await boot(home);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncMemory, {});
    expect(res.result).toEqual({ files: [], complete: true });
    c.close();
  });

  test("a no-normaHome server degrades sync.memory to the same empty-bucket shape, never a crash", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store }); // no normaHome
    stop = () => { server.stop(); store.close(); };
    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "phone");

    const res = await c.request(METHODS.syncMemory, {});
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ files: [], complete: true });
    c.close();
  });

  test("a multi-file bucket pages across cursors, in stable name order, byte-identical content", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    const dir = assistantDir(home);
    mkdirSync(dir, { recursive: true });
    const chunk = (label: string) => `${label}-`.repeat(20_480); // 81,920 bytes, well under one page
    const names = ["a.md", "b.md", "c.md", "d.md", "e.md"];
    for (const name of names) writeFileSync(join(dir, name), chunk(name));

    const { socketPath, harnessToken } = await boot(home);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const seenNames: string[] = [];
    const seenContents = new Map<string, string>();
    let cursor: number | undefined;
    let pages = 0;
    for (;;) {
      const res = await c.request(METHODS.syncMemory, cursor === undefined ? {} : { cursor });
      expect(res.error).toBeUndefined();
      pages++;
      for (const f of res.result.files as Array<{ name: string; content: string }>) {
        seenNames.push(f.name);
        seenContents.set(f.name, f.content);
        expect(Buffer.byteLength(f.content, "utf8")).toBeLessThanOrEqual(SYNC_PAGE_BYTES);
      }
      if (res.result.complete) { expect(res.result.nextCursor).toBeUndefined(); break; }
      expect(typeof res.result.nextCursor).toBe("number");
      cursor = res.result.nextCursor;
      if (pages > 50) throw new Error("sync.memory did not terminate");
    }

    expect(pages).toBeGreaterThan(1); // 5 * 81,920 bytes > SYNC_PAGE_BYTES (262,144) -> must split
    expect(seenNames).toEqual(names); // stable, sorted-by-name order preserved across pages
    for (const name of names) expect(seenContents.get(name)).toBe(chunk(name));
    c.close();
  });

  test("a single file larger than the whole budget is truncated with the trailing marker, alone on its page", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    const dir = assistantDir(home);
    mkdirSync(dir, { recursive: true });
    const big = "y".repeat(SYNC_PAGE_BYTES + 4096);
    writeFileSync(join(dir, "big.md"), big);

    const { socketPath, harnessToken } = await boot(home);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncMemory, {});
    expect(res.error).toBeUndefined();
    expect(res.result.complete).toBe(true);
    expect(res.result.nextCursor).toBeUndefined();
    expect(res.result.files.length).toBe(1);
    expect(res.result.files[0].name).toBe("big.md");
    expect(res.result.files[0].content.endsWith(SYNC_MEMORY_TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(res.result.files[0].content, "utf8")).toBeLessThanOrEqual(SYNC_PAGE_BYTES);
    c.close();
  });

  test("hidden/dotfile temp artifacts (the Dreamer's own atomic-write temporaries) are never replicated", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    const dir = assistantDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- topic.md: a real memory\n");
    writeFileSync(join(dir, "topic.md"), "content");
    writeFileSync(join(dir, ".dream-state.json.tmp"), '{"watermarkSeq":0,"lastDreamAt":0}');
    writeFileSync(join(dir, ".MEMORY.md.tmp"), "half-written");

    const { socketPath, harnessToken } = await boot(home);
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncMemory, {});
    expect(res.error).toBeUndefined();
    const names = (res.result.files as Array<{ name: string }>).map((f) => f.name).sort();
    expect(names).toEqual(["MEMORY.md", "topic.md"]);
    c.close();
  });

  test("a REMOTE (phone) caller may call sync.memory with no session context at all", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    mkdirSync(assistantDir(home), { recursive: true });
    writeFileSync(join(assistantDir(home), "topic.md"), "hi");
    const { socketPath, remoteToken } = await boot(home);
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    const res = await c.request(METHODS.syncMemory, {});
    expect(res.error).toBeUndefined();
    expect(res.result.files).toEqual([{ name: "topic.md", content: "hi" }]);
    c.close();
  });

  // ----------------------------------------------------------------------------------------------
  // Direct unit tests of `syncMemory()` — no server/socket involved.
  // ----------------------------------------------------------------------------------------------

  test("syncMemory() with an out-of-range cursor (bucket shrank since the last page) -> empty, complete", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-unit-"));
    mkdirSync(assistantDir(home), { recursive: true });
    writeFileSync(join(assistantDir(home), "only.md"), "x");
    const result = syncMemory(home, 5);
    expect(result).toEqual({ files: [], complete: true });
  });
});
