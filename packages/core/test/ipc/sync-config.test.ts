import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERR, LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, SyncConfigResult, type WritableSocket } from "@norma/protocol";
import { startIpcServer } from "../../src/ipc/server";
import { syncConfig, syncMemory, effortsForModel, clientEfforts, SYNC_PAGE_BYTES, SYNC_MEMORY_TRUNCATION_MARKER } from "../../src/ipc/sync";
import { EXA_API_KEY_SECRET } from "../../src/agent/tools/search";
import { CLIENT_EFFORTS, REASONING_EFFORTS, loadSettings } from "../../src/settings";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";
import { createProvider } from "../../src/providers/manager";
import { startDaemon, type RunningDaemon } from "../../src/daemon";
import type { ModelInfo } from "../../src/providers/types";
import type { SecretStore } from "../../src/auth/secret-store";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";

// Chat Slice D task 3 — the two remaining sync surfaces, for the phone's OWN standalone chat
// rather than log replication:
//
//  - sync.config {}          → { exaKey, dangerousDomains, defaultModel, models, defaultEffort }
//                              (all read HOT, at call time; the last two added by
//                               provider-correctness T3 — see that describe block below)
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

/** A stub engine exposing only what `sync.config`'s catalogue (and `session.setModel`/`sync.push`'s
 *  validation) consult — the SAME shape sync-bounds.test.ts's own `fakeEngine` uses. The catalogue
 *  is deliberately read off `opts.engine`, never a parallel `IpcServerOptions` getter: a second
 *  source could serve the phone a lineup the daemon's own `session.setModel` would then reject. */
function fakeEngine(models: () => ModelInfo[]): any {
  return { knownModels: () => models(), isRunning: () => false };
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
    liveEffort?: () => string;
    liveProvider?: () => string;
    models?: () => ModelInfo[];
  } = {}): Promise<{ home: string; socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-config-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      secrets: over.secrets, dangerousDomainsAdded: over.dangerousDomainsAdded, liveModel: over.liveModel,
      liveEffort: over.liveEffort, liveProvider: over.liveProvider,
      ...(over.models ? { engine: fakeEngine(over.models), hub: new SessionHub(store) } : {}),
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
      // No liveProvider wired on this server -> "none", the honest "this daemon runs no provider"
      // (whole-branch review C1). It is never "" — that field has no empty sentinel.
      provider: "none",
      exaKey: "exa_live_key",
      dangerousDomains: ["evil.example.com", "totally-fine.example"],
      defaultModel: "claude-opus-5",
      // No knownModels/liveEffort wired on this server -> the honest empties (see the catalogue
      // describe-block below for what a real provider serves).
      models: [],
      defaultEffort: "",
      clientEfforts: ["ultra"],
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
    expect(res.result).toEqual({ provider: "none", exaKey: null, dangerousDomains: [], defaultModel: "", models: [], defaultEffort: "", clientEfforts: ["ultra"] });
    c.close();
  });

  test("every field is read HOT, at call time — no daemon restart needed to see a change", async () => {
    let key: string | null = "first-key";
    let domains: string[] = ["first.example"];
    let model = "gpt-5-first";
    let effort = "low";
    let catalogue: ModelInfo[] = [
      { id: "gpt-5-first", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
    ];
    const secrets: SecretStore = {
      get: async (name) => (name === EXA_API_KEY_SECRET ? key : null),
      set: async () => {},
    };
    const { socketPath, harnessToken } = await boot({
      secrets, dangerousDomainsAdded: () => domains, liveModel: () => model,
      liveEffort: () => effort, models: () => catalogue, liveProvider: () => "codex-oauth",
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const before = await c.request(METHODS.syncConfig, {});
    expect(before.result).toEqual({
      provider: "codex-oauth",
      exaKey: "first-key", dangerousDomains: ["first.example"], defaultModel: "gpt-5-first",
      models: [{ id: "gpt-5-first", efforts: [...REASONING_EFFORTS] }], defaultEffort: "low",
      clientEfforts: ["ultra"],
    });

    // Simulate a live settings/keychain change WITHOUT restarting anything — same closures, new
    // values. The MODEL CATALOGUE moves too (a provider swap / a family bump on the Mac): the phone
    // must see the new lineup on its very next connect, with no daemon restart AND no app update —
    // that "no app update" half is the whole reason the catalogue is served rather than derived.
    key = "second-key";
    domains = ["first.example", "second.example"];
    model = "gpt-5-second";
    effort = "xhigh";
    catalogue = [
      { id: "gpt-5-second", family: "gpt-5", contextWindow: 272_000, supportsVision: true },
      { id: "gpt-5-second-mini", family: "gpt-5", contextWindow: 272_000, supportsVision: false },
    ];

    const after = await c.request(METHODS.syncConfig, {});
    expect(after.result).toEqual({
      // NOT hot, unlike everything beside it: the provider TYPE is boot-bound (changing it needs a
      // daemon restart), so this closure keeps answering the running instance's id.
      provider: "codex-oauth",
      exaKey: "second-key", dangerousDomains: ["first.example", "second.example"], defaultModel: "gpt-5-second",
      models: [
        { id: "gpt-5-second", efforts: [...REASONING_EFFORTS] },
        { id: "gpt-5-second-mini", efforts: [...REASONING_EFFORTS] },
      ],
      defaultEffort: "xhigh",
      clientEfforts: ["ultra"],
    });
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
    expect(result).toEqual({ provider: "none", exaKey: null, dangerousDomains: [], defaultModel: "", models: [], defaultEffort: "", clientEfforts: ["ultra"] });
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

// ================================================================================================
// The MODEL CATALOGUE on sync.config (provider-correctness T3).
//
// Before this, the wire carried ONE model string and the phone GUESSED the rest: it split
// `gpt-5.6-terra` into ("gpt-5.6", terra) and synthesized the other two tiers by string
// concatenation (norma-ios `ModelLineup.options`), and its effort control was a pure UI mock whose
// list still carried `ultra` — a slug the backend's GLOBAL enum layer rejects outright, and which
// this daemon deleted from REASONING_EFFORTS on 2026-07-31. A derived lineup cannot be wrong-proof:
// the phone can never prove the tiers it invented exist. The daemon can, because it is the side
// that already validates them (`AgentEngine.knownModels()`, `session.setModel`).
//
// So the catalogue is SERVED, not derived — and per-model, even though all three gpt-5.6 slugs
// accept the identical six efforts today (see `effortsForModel`'s own doc comment).
// ================================================================================================

describe("sync.config model catalogue (provider-correctness T3)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot(over: {
    liveModel?: () => string;
    liveEffort?: () => string;
    liveProvider?: () => string;
    models?: () => ModelInfo[];
  } = {}): Promise<{ socketPath: string; harnessToken: string; remoteToken: string }> {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-catalogue-"));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const authority = new TokenAuthority(new FileSecretStore(join(home, "secrets")));
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store,
      liveModel: over.liveModel, liveEffort: over.liveEffort, liveProvider: over.liveProvider,
      ...(over.models ? { engine: fakeEngine(over.models), hub: new SessionHub(store) } : {}),
    });
    stop = () => { server.stop(); store.close(); };
    return { socketPath, harnessToken: tokens.harness, remoteToken: tokens.remote };
  }

  test("serves the ACTIVE provider's real catalogue — the daemon's own knownModels(), not a mirror", async () => {
    const { socketPath, harnessToken } = await boot({
      models: () => CODEX_MODELS,
      liveModel: () => DEFAULT_CODEX_MODEL,
      liveEffort: () => "high",
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    // Exactly the daemon's own catalogue, in its own order — never a hand-kept second list.
    expect(res.result.models.map((m: { id: string }) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
    expect(res.result.defaultModel).toBe(DEFAULT_CODEX_MODEL);
    expect(res.result.defaultEffort).toBe("high");
    c.close();
  });

  test("efforts ride PER MODEL — uniform today, but a divergence must never need an app update", async () => {
    const { socketPath, harnessToken } = await boot({ models: () => CODEX_MODELS });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    for (const row of res.result.models as Array<{ id: string; efforts: string[] }>) {
      // Every row carries its OWN list — a client reading `models[i].efforts` never has to know
      // that they happen to be identical today.
      expect(row.efforts).toEqual([...REASONING_EFFORTS]);
    }
    // The exact universe the wire accepts: `none` IS honoured, `ultra` is refused by a global enum,
    // `minimal` is refused PER MODEL. The phone's old mock had the first two exactly backwards.
    const flat = new Set((res.result.models as Array<{ efforts: string[] }>).flatMap((m) => m.efforts));
    expect(flat.has("none")).toBe(true);
    expect(flat.has("ultra")).toBe(false);
    expect(flat.has("minimal")).toBe(false);
    c.close();
  });

  test("a provider that cannot enumerate its models serves [] — it never invents a catalogue", async () => {
    // An arbitrary openai-compatible endpoint: `knownModels()` is empty, exactly the case
    // `session.setModel`'s `known.length > 0` guard already skips membership-checking. `[]` is the
    // honest answer, and the never-synced discipline (a phone must WAIT, never guess) is what makes
    // it safe — an invented lineup is what produced the 400-on-first-turn bug once already.
    const { socketPath, harnessToken } = await boot({
      models: () => [],
      liveModel: () => "my-local-llm",
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.result.models).toEqual([]);
    expect(res.result.defaultModel).toBe("my-local-llm"); // still served — the phone can run on it
    c.close();
  });

  test("a daemon with NO agent provider serves an empty catalogue AND an empty effort", async () => {
    // The never-synced shape from the daemon's side: nothing is configured, so nothing is claimed.
    // `defaultModel: ""` already meant this for the model (norma-ios `ChatConfigStore.apply` ignores
    // an empty one rather than storing it); `models: []` / `defaultEffort: ""` are the same
    // statement for the two new fields.
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    // ...and `provider: "none"` is that same statement for the identity (whole-branch review C1) —
    // a stated answer, not a silence, because this is the one field with no empty sentinel.
    expect(res.result).toEqual({ provider: "none", exaKey: null, dangerousDomains: [], defaultModel: "", models: [], defaultEffort: "", clientEfforts: ["ultra"] });
    c.close();
  });

  test("an UNSET reasoning effort is \"\", never \"none\" — they are different states on the wire", async () => {
    // `settings.provider.reasoningEffort` is optional. Unset makes openai-compatible.ts omit the
    // `reasoning` block from the request body ENTIRELY; `"none"` sends `reasoning: {effort:"none"}`
    // and the server echoes it back. Collapsing the two here would make the phone start sending an
    // explicit level to a Mac that deliberately sends none.
    const { socketPath, harnessToken } = await boot({ liveEffort: () => "", models: () => CODEX_MODELS });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.result.defaultEffort).toBe("");
    expect(res.result.models.length).toBeGreaterThan(0); // the catalogue is unaffected by an unset effort
    c.close();
  });

  test("a REMOTE (phone) caller gets the catalogue too — sync.config's allowlisting is unchanged", async () => {
    // Widening a result does NOT touch the four-list remote allowlist: `sync.config` has been
    // REMOTE_ALLOWED_METHODS-listed since Chat Slice D task 3. Only a NEW METHOD would.
    const { socketPath, remoteToken } = await boot({ models: () => CODEX_MODELS, liveEffort: () => "medium" });
    const c = await TestClient.connect(socketPath);
    await c.hello(remoteToken, "iphone-gateway", "remote");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    expect(res.result.models.map((m: { id: string }) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
    expect(res.result.defaultEffort).toBe("medium");
    c.close();
  });

  // provider-correctness T6: the Mac app's pickers now depend on this method, over a HARNESS
  // connection. `sync.config` is on REMOTE_ALLOWED_METHODS because the phone was the only client
  // that had ever needed it, and that list is easy to misread as "remote ONLY" — it is a permission
  // for the remote role, not a restriction to it. Named explicitly here so a future tightening
  // (adding a role check to this handler, say) breaks with a test that says why it may not.
  test("a HARNESS (Mac app) caller gets the identical catalogue — the method is role-AGNOSTIC", async () => {
    const { socketPath, harnessToken, remoteToken } = await boot({ models: () => CODEX_MODELS, liveEffort: () => "medium", liveModel: () => DEFAULT_CODEX_MODEL });

    const harness = await TestClient.connect(socketPath);
    await harness.hello(harnessToken, "norma-app");
    const asHarness = await harness.request(METHODS.syncConfig, {});
    expect(asHarness.error).toBeUndefined();

    const remote = await TestClient.connect(socketPath);
    await remote.hello(remoteToken, "iphone-gateway", "remote");
    const asRemote = await remote.request(METHODS.syncConfig, {});

    // IDENTICAL, not merely both-successful: the Mac's picker and the phone's must be offered the
    // same lineup, or "the daemon never advertises what it refuses" holds for only one of them.
    expect(asHarness.result).toEqual(asRemote.result);
    expect(asHarness.result.clientEfforts).toEqual([...CLIENT_EFFORTS]);
    harness.close();
    remote.close();
  });

  test("the served result validates against SyncConfigResult — the schema is the contract, not prose", async () => {
    const { socketPath, harnessToken } = await boot({
      models: () => CODEX_MODELS, liveModel: () => DEFAULT_CODEX_MODEL, liveEffort: () => "max",
    });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(() => SyncConfigResult.parse(res.result)).not.toThrow();
    // Strict: no extra keys beyond the seven the schema declares. Its cross-language twin is the
    // MIRROR TRIPWIRE in packages/protocol/test/methods.test.ts, which pins the same set on the
    // schema itself and names the two hand-written Swift mirrors; this half pins what the DAEMON
    // actually puts on the wire, so a field declared and never populated still fails here.
    expect(Object.keys(res.result).sort()).toEqual(["clientEfforts", "dangerousDomains", "defaultEffort", "defaultModel", "exaKey", "models", "provider"]);
    c.close();
  });

  // ----------------------------------------------------------------------------------------------
  // Direct unit tests — no server/socket.
  // ----------------------------------------------------------------------------------------------

  test("effortsForModel() returns REASONING_EFFORTS for every model, as a fresh array each call", () => {
    const a = effortsForModel("gpt-5.6-sol");
    const b = effortsForModel("anything-at-all");
    expect(a).toEqual([...REASONING_EFFORTS]);
    expect(b).toEqual([...REASONING_EFFORTS]);
    // A copy, never the shared constant: a caller that mutates its row must not corrupt the source.
    expect(a).not.toBe(b);
    a.push("bogus");
    expect(effortsForModel("gpt-5.6-sol")).toEqual([...REASONING_EFFORTS]);
  });

  // I1 review fix (task-4-review.md lines 394-416): `effortsForModel` is a FUNCTION, not a constant,
  // precisely because a per-model divergence is expected to land one day — and nothing today
  // detects the day it does. `session.setModel` (ipc/server.ts) validates only the NEW model id; it
  // never re-checks a session's already-stored effort against that model's list. That is silently
  // fine while every model's list is identical, and silently WRONG the day it isn't: a session could
  // carry an effort its (new) model no longer accepts, and every subsequent turn would be 400'd by
  // the provider with nothing pointing back at the setting that caused it — the exact silent-brick
  // failure mode this task's OWN set-time validation exists to prevent, reintroduced through the
  // other door.
  //
  // This is the tripwire: it pins uniformity across a representative spread of model ids — real
  // ones this daemon knows about, an arbitrary/BYO one, an empty string, and one that looks
  // plausible but isn't — so that a genuine per-model divergence turns this test red the moment it
  // lands, rather than staying invisible until a user hits it in production.
  //
  // WHEN THIS FAILS: `session.setModel` must re-check-or-clear a stored effort before this
  // divergence can ship. Do not "fix" this test by special-casing the diverging id — that defeats
  // its purpose.
  test("uniformity tripwire — effortsForModel returns the IDENTICAL set for every id, known or not", () => {
    const ids = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5-first", "anything-at-all", "", "unknown-vendor/byo-model-x"];
    const rows = ids.map((id) => effortsForModel(id));
    for (const row of rows) expect(row).toEqual([...REASONING_EFFORTS]);
    // Cross-compare pairwise too, not merely each-against-the-constant — the failure this guards
    // against is divergence BETWEEN models, which "equals REASONING_EFFORTS" alone still catches,
    // but stating the cross-comparison explicitly is what makes this test self-documenting as a
    // UNIFORMITY check rather than a per-id snapshot.
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toEqual(rows[0]);
  });

  // provider-correctness T5 — the OTHER tripwire on this seam, and the one that guards the identity
  // Task 4 hardened. `effortsForModel` is what `session.setEffort` validates a WIRE effort against
  // AND what `sync.config` advertises per model; a Norma-level tier is accepted by the same handler
  // but must never appear in that list, because the daemon would then be advertising a level its own
  // request would be 400'd on — the exact bug (`ultra` offered by a phone-side mock) that the
  // catalogue field was added to fix, arriving through the fix.
  //
  // WHEN THIS FAILS: someone has merged the tier list into the wire list. The fix is never to widen
  // `effortsForModel`; it is to put the tier back in `clientEfforts`, where a client renders it as a
  // separate control.
  test("disjointness tripwire — no client tier ever appears in ANY model's advertised wire efforts", () => {
    const tiers = clientEfforts();
    expect(tiers).toEqual([...CLIENT_EFFORTS]);
    expect(tiers).toContain("ultra");
    const ids = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "anything-at-all", "", "unknown-vendor/byo-model-x"];
    for (const id of ids) {
      for (const tier of tiers) expect(effortsForModel(id)).not.toContain(tier);
    }
    // ...and the converse: a wire effort is never smuggled in as a "tier", which would give the same
    // level two different controls in a picker.
    for (const wire of REASONING_EFFORTS) expect(tiers).not.toContain(wire);
    // A copy, never the shared constant — same discipline as effortsForModel's row.
    expect(clientEfforts()).not.toBe(tiers);
    tiers.push("bogus");
    expect(clientEfforts()).toEqual([...CLIENT_EFFORTS]);
  });

  test("syncConfig() maps knownModels() to {id, efforts} and drops everything else about a model", async () => {
    // `ModelInfo` also carries `family`/`contextWindow`/`supportsVision`. None of it is the phone's
    // business (it does not size its own context window off the Mac's catalogue), and every field on
    // this wire is one more thing to keep true — so the projection is deliberate and pinned here.
    const result = await syncConfig({
      knownModels: () => [{ id: "gpt-5.6-sol", family: "gpt-5", contextWindow: 272_000, supportsVision: true }],
    });
    expect(result.models).toEqual([{ id: "gpt-5.6-sol", efforts: [...REASONING_EFFORTS] }]);
  });
});

// ================================================================================================
// T3 review I1 — the REAL `startDaemon` wiring, driven off a real settings.json.
//
// Every other test in this file constructs `startIpcServer` directly and hands it its own
// `liveModel`/`liveEffort` closures. That proves the handler and skips the thing most likely to
// break: daemon.ts's `liveSelection`/`liveEffort` construction and the one line that passes
// `liveEffort` into the options object.
//
// WHY THAT GAP IS WORSE THAN IT LOOKS. Dropping `liveEffort` from that object does not throw, does
// not warn, and does not fail a type-check — `SyncConfigContext.liveEffort` is optional and
// degrades to `""`. `""` is a MEANINGFUL value on this wire ("the Mac has configured no effort"),
// so the phone would quietly run every turn with no reasoning block while the Mac sends
// `{effort:"high"}`, forever, with nothing anywhere reporting a problem. Contrast the `defaultModel`
// half it sits beside: its failure is LOUD, because an empty model makes the phone refuse the turn
// outright. A silent wrong answer needs the stronger test, so this boots the actual daemon.
//
// It uses `createProvider` to build the SAME live resolver production uses (mtime-cached, re-reads
// settings.json per call) rather than a hand-written closure — the point is to exercise the real
// path end to end. codex-oauth is chosen deliberately: its provider constructs without a
// credential (the token is only read at stream time, and no turn is ever driven here), and its
// `models()` returns the real `CODEX_MODELS`, so one test covers the catalogue AND the effort
// through the genuine wiring. Nothing here touches `~/.norma` — temp home, temp secret store.
// ================================================================================================

describe("sync.config through a real startDaemon (T3 review I1)", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => { await daemon?.stop(); daemon = undefined; });

  function writeProviderSettings(home: string, model: string, effort?: string): void {
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      schemaVersion: 2,
      provider: { type: "codex-oauth", model, ...(effort ? { reasoningEffort: effort } : {}) },
      titles: { enabled: false },
      toolSearch: { enabled: false },
    }, null, 2) + "\n");
  }

  /** Boots a daemon over a real settings.json, wiring `agentProvider` EXACTLY as daemon.ts's own
   *  boot does (`{provider, model: active.liveModel().model, live: active.liveModel}`) — so the
   *  `live()` resolver under test is the production one, not a test closure. */
  async function bootReal(home: string): Promise<RunningDaemon> {
    const settingsPath = join(home, "settings.json");
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    const active = await createProvider(loadSettings(settingsPath), secrets, settingsPath);
    return startDaemon({
      home, secrets,
      agentProvider: { provider: active.provider, model: active.liveModel().model, live: active.liveModel },
    });
  }

  test("a real daemon serves the effort AND the catalogue from settings.json, and re-reads both live", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-config-real-"));
    writeProviderSettings(home, "gpt-5.6-terra", "xhigh");

    daemon = await bootReal(home);
    const daemonRef = daemon; // captured ONCE — the no-restart proof is that this is never re-created
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "phone");

    const before = await c.request(METHODS.syncConfig, {});
    expect(before.error).toBeUndefined();
    expect(before.result.defaultModel).toBe("gpt-5.6-terra");
    // THE ASSERTION I1 IS ABOUT: without `liveEffort` wired in daemon.ts this is `""` — a value
    // that is legal, meaningful, and wrong, which is exactly why it needs pinning here.
    expect(before.result.defaultEffort).toBe("xhigh");
    // The catalogue rides the same real boot: CODEX_MODELS, in order, with the real effort lists.
    expect(before.result.models).toEqual(CODEX_MODELS.map((m) => ({ id: m.id, efforts: [...REASONING_EFFORTS] })));

    // A live `norma model gpt-5.6-luna --effort low` — a plain settings.json rewrite, no restart,
    // no RPC. The provider's resolver is mtime-cached, so poll rather than assuming the first read
    // past the write already sees it.
    writeProviderSettings(home, "gpt-5.6-luna", "low");
    let after: any;
    const deadline = Date.now() + 5000;
    for (;;) {
      after = await c.request(METHODS.syncConfig, {});
      if (after.result.defaultModel === "gpt-5.6-luna" && after.result.defaultEffort === "low") break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after.result.defaultModel).toBe("gpt-5.6-luna");
    expect(after.result.defaultEffort).toBe("low");

    // Same daemon object, same socket — nothing was restarted to make the above true.
    expect(daemon).toBe(daemonRef);
    expect(daemon!.socketPath).toBe(daemonRef.socketPath);
    c.close();
  }, 20_000);

  test("a real daemon whose settings.json sets NO effort reports \"\" — unset, not \"none\"", async () => {
    // `reasoningEffort` is optional in settings, and the difference is not cosmetic: unset makes
    // every request omit the `reasoning` block entirely, while "none" is an explicit level the
    // backend honours. A phone told "none" for an unset Mac would start sending a level the Mac
    // never sends.
    const home = mkdtempSync(join(tmpdir(), "norma-sync-config-real-unset-"));
    writeProviderSettings(home, "gpt-5.6-sol"); // no reasoningEffort key at all

    daemon = await bootReal(home);
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    expect(res.result.defaultEffort).toBe("");
    expect(res.result.defaultModel).toBe("gpt-5.6-sol");
    expect(res.result.models.length).toBe(CODEX_MODELS.length); // the catalogue is unaffected
    c.close();
  }, 20_000);
});

// ================================================================================================
// `provider` — whole-branch review C1: the field that makes this bundle SELF-DESCRIBING.
//
// Every other field says WHAT the Mac runs. Nothing said WHOSE, and that gap has one concrete live
// failure behind it. The phone runs its OWN chat engine on its OWN codex-oauth credentials
// (`phone-always-local`). On an `openai-compatible` Mac the provider is constructed with no
// enumerable catalogue (`ProviderSettings` has no `models` field, settings.ts), so `sync.config`
// honestly serves `models: []` — but `defaultModel` is still a NON-EMPTY foreign slug, and a phone
// that stores any non-empty `defaultModel` then puts a llama/BYOK name on Codex `/responses` and is
// 400'd on its first turn. The "empty catalogue is ignored on apply" rule governs `models` only;
// only the provider identity closes this.
//
// These run against a REAL `startDaemon` over a real settings.json for the same reason the T3
// review's I1 block above does: the wiring (daemon.ts's `liveProvider`, and the one line that
// passes it into the options object) is the part that silently degrades. Dropping it does not throw
// and does not fail a type-check — `SyncConfigContext.liveProvider` is optional — it just makes
// every daemon report `"none"`, which reads as "no provider configured" and would have every phone
// discard a perfectly good codex bundle. Both provider types are booted, because the whole point of
// the field is telling them apart.
// ================================================================================================

describe("sync.config `provider` through a real startDaemon (whole-branch review C1)", () => {
  let daemon: RunningDaemon | undefined;
  afterEach(async () => { await daemon?.stop(); daemon = undefined; });

  async function bootWithSettings(home: string, provider: Record<string, unknown>): Promise<{ daemon: RunningDaemon; secrets: FileSecretStore }> {
    const settingsPath = join(home, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({
      schemaVersion: 2, provider, titles: { enabled: false }, toolSearch: { enabled: false },
    }, null, 2) + "\n");
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    // openai-compatible refuses to construct without a stored key; codex-oauth ignores it (its
    // token is only read at stream time, and no turn is ever driven here).
    await secrets.set("openai-api-key", "sk-test-not-a-real-key");
    const active = await createProvider(loadSettings(settingsPath), secrets, settingsPath);
    const d = await startDaemon({
      home, secrets,
      agentProvider: { provider: active.provider, model: active.liveModel().model, live: active.liveModel },
    });
    return { daemon: d, secrets };
  }

  test("a codex-oauth Mac states `codex-oauth` beside its real catalogue", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-provider-codex-"));
    ({ daemon } = await bootWithSettings(home, { type: "codex-oauth", model: "gpt-5.6-terra", reasoningEffort: "high" }));
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    // THE ASSERTION C1 IS ABOUT: without `liveProvider` wired in daemon.ts this is "none", a value
    // that is legal, meaningful, and wrong — exactly the shape of the `liveEffort` gap above.
    expect(res.result.provider).toBe("codex-oauth");
    // It agrees with the catalogue beside it, which is the property that makes it usable: the
    // identity and the lineup come off the SAME provider instance.
    expect(res.result.models.map((m: any) => m.id)).toEqual(CODEX_MODELS.map((m) => m.id));
    expect(res.result.defaultModel).toBe("gpt-5.6-terra");
    c.close();
  }, 20_000);

  test("a BYOK (openai-compatible) Mac states `openai-compatible` — the empty catalogue alone never could", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-provider-byok-"));
    ({ daemon } = await bootWithSettings(home, {
      type: "openai-compatible", model: "llama-3.3-70b-local", baseUrl: "http://127.0.0.1:11434/v1",
    }));
    const c = await TestClient.connect(daemon.socketPath);
    await c.hello(daemon.tokens.harness, "phone");

    const res = await c.request(METHODS.syncConfig, {});
    expect(res.error).toBeUndefined();
    expect(res.result.provider).toBe("openai-compatible");
    // The exact live shape C1 exists for, asserted TOGETHER so the danger is visible in one place:
    // an empty catalogue AND a non-empty foreign slug. A phone reading only these two would store
    // "llama-3.3-70b-local" and send it to Codex.
    expect(res.result.models).toEqual([]);
    expect(res.result.defaultModel).toBe("llama-3.3-70b-local");
    expect(res.result.provider).not.toBe("codex-oauth"); // …and this is what saves it
    // Not a wire-format accident: the served value is a member of `ProviderSettings.type`'s own
    // vocabulary, which is what lets a client compare it against its own provider at all.
    expect(["codex-oauth", "openai-compatible"]).toContain(res.result.provider);
    c.close();
  }, 20_000);

  test("`Provider.id` IS the `ProviderSettings.type` literal — the identity this field reports", async () => {
    // The one coupling `liveProvider` depends on, pinned so a new provider whose `id` drifts from
    // its settings literal fails here rather than by serving a phone a token it cannot compare.
    const home = mkdtempSync(join(tmpdir(), "norma-sync-provider-ids-"));
    const secrets = new FileSecretStore(join(home, "test-secrets"));
    await secrets.set("openai-api-key", "sk-test-not-a-real-key");
    for (const provider of [
      { type: "codex-oauth" as const, model: "gpt-5.6-sol" },
      { type: "openai-compatible" as const, model: "m", baseUrl: "http://127.0.0.1:11434/v1" },
    ]) {
      const active = await createProvider({ schemaVersion: 2, provider } as any, secrets);
      expect(active.provider.id).toBe(provider.type);
    }
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

  // ----------------------------------------------------------------------------------------------
  // T12 review I-2: an UNREADABLE bucket is an error, not an empty success.
  //
  // The phone replicates this bucket and prunes what it is not sent. "No dream cycle has ever run"
  // and "I could not read the directory" used to be the SAME reply — so one transient EACCES here
  // wiped a device's whole memory replica and every chat turn after it silently ran with no memory
  // section. Only a genuinely MISSING bucket may degrade to empty.
  // ----------------------------------------------------------------------------------------------

  test("syncMemory() -> empty+complete for a bucket that does not exist (ENOENT is the honest empty)", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-unit-"));
    // No assistant dir at all — no dream cycle has ever run.
    expect(syncMemory(home, 0)).toEqual({ files: [], complete: true });
  });

  test("syncMemory() THROWS on an unreadable bucket rather than reporting it empty", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-unit-"));
    const dir = assistantDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- [tea](tea.md)");
    // 0o000: readdir fails EACCES while the contents are very much still there.
    chmodSync(dir, 0o000);
    try {
      // Skip when running as a user that ignores mode bits (root in a container) — the point of the
      // test is the errno branch, and a run that cannot produce EACCES proves nothing either way.
      let readable = true;
      try { readdirSync(dir); } catch { readable = false; }
      if (readable) return;
      expect(() => syncMemory(home, 0)).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("syncMemory() THROWS when a listed file cannot be read (but still skips one that VANISHED)", () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-unit-"));
    const dir = assistantDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- [tea](tea.md)");
    writeFileSync(join(dir, "tea.md"), "oolong");
    chmodSync(join(dir, "tea.md"), 0o000);
    try {
      let readable = true;
      try { readFileSync(join(dir, "tea.md")); } catch { readable = false; }
      if (readable) return; // running as root — see above
      // An EXISTING file we cannot read must not be silently omitted: omitting it is how the phone
      // comes to delete a memory the user still has.
      expect(() => syncMemory(home, 0)).toThrow();
    } finally {
      chmodSync(join(dir, "tea.md"), 0o600);
    }
    // A file that genuinely VANISHED between readdir and read is still skipped, not thrown: it is
    // gone, and the client pruning it is the correct outcome.
    rmSync(join(dir, "tea.md"));
    const result = syncMemory(home, 0);
    expect(result.files.map((f) => f.name)).toEqual(["MEMORY.md"]);
    expect(result.complete).toBe(true);
  });

  /// The throw above has to reach the client as a JSON-RPC error, and that requires the WIRE shape
  /// to be right, not just the throw. Rethrowing the raw `ErrnoException` put `"code":"EACCES"` — a
  /// STRING — on a wire whose `code` is `Int` on both Swift sides, so the line failed to decode, was
  /// dropped as unrecognized, and the request hung to its timeout instead of failing. A read error
  /// became a stalled sync pass. This drives the REAL server, so the assertion depends on the pump's
  /// `e.code ?? ERR.INTERNAL` seeing a number.
  test("an unreadable bucket surfaces as a NUMERIC JSON-RPC error code, not an errno string", async () => {
    const home = mkdtempSync(join(tmpdir(), "norma-sync-memory-"));
    const dir = assistantDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- [tea](tea.md)");
    chmodSync(dir, 0o000);
    let readable = true;
    try { readdirSync(dir); } catch { readable = false; }
    if (!readable) {
      const { socketPath, harnessToken } = await boot(home);
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "phone");
      const res = await c.request(METHODS.syncMemory, {});
      chmodSync(dir, 0o700);
      expect(res.result).toBeUndefined();
      expect(typeof res.error?.code).toBe("number");
      expect(res.error?.code).toBe(ERR.INTERNAL);
      // The errno is diagnosable, but the absolute path it came with is NOT serialized to a phone.
      expect(res.error?.message).toContain("EACCES");
      expect(res.error?.message).not.toContain(home);
      c.close();
    } else {
      chmodSync(dir, 0o700); // running as a user that ignores mode bits (root) — nothing to prove
    }
  });
});
