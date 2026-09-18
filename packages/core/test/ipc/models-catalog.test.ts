// `models.catalog` — catalog family/pricing facts for the Mac app's Roles pane model picker.
// Bare IPC server harness, same shape `settings-model-roles.test.ts`/`versions-get.test.ts` already
// use. The most important test here is the drift tripwire: every tag/providerId
// `settings.modelRoles`'s `permitted` can ever name must resolve in `models.catalog`'s own
// `models`/`providers` — that is the whole guarantee this method exists to give the picker.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, ModelsCatalogResult } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings, MODEL_ROLES } from "../../src/settings";
import { costBasisFor } from "../../src/providers/model-catalog-wire";

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

describe("models.catalog", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  async function boot() {
    const home = mkdtempSync(join(tmpdir(), "winter-models-catalog-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets });
    stop = () => { server.stop(); store.close(); };
    return { home, socketPath, harnessToken: tokens.harness };
  }

  test("shape: parses against the protocol's own ModelsCatalogResult schema", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    expect(result.error).toBeUndefined();
    // Throws on any shape mismatch — this IS the assertion.
    const parsed = ModelsCatalogResult.parse(result.result);
    expect(parsed.ok).toBe(true);
    expect(parsed.families.length).toBeGreaterThan(0);
    expect(parsed.providers.length).toBeGreaterThan(0);
    expect(parsed.models.length).toBeGreaterThan(0);
    c.close();
  });

  test("costBasis: an official-doc price on a real catalog row reports \"list\" with pricing fields intact", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const row = result.result.models.find((m: any) => m.tag === "anthropic/claude-opus-5");
    expect(row).toBeDefined();
    expect(row.pricing).not.toBeNull();
    expect(row.pricing.source).toBe("official-doc");
    expect(row.pricing.inputPerMTokUsd).toBe(5);
    expect(row.pricing.outputPerMTokUsd).toBe(25);
    expect(row.costBasis).toBe("list");
    c.close();
  });

  test("costBasis: no pricing evidence at all reports pricing:null AND costBasis:\"unknown\" (never a zero-filled object)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    // Only 18 of ~618 catalog rows carry pricing at all — any unpriced row proves the null path.
    const unpriced = result.result.models.find((m: any) => m.pricing === null);
    expect(unpriced).toBeDefined();
    expect(unpriced.costBasis).toBe("unknown");
    c.close();
  });

  test("costBasis: an inferred/upstream-sourced price (not \"official-doc\") reports \"unknown\" — unit test on the pure rule", () => {
    // The compiled catalog's 18 priced rows are ALL sourced "official-doc" today (see
    // model-catalog-wire.ts's own doc on `costBasisFor`), so this branch has no real row to go
    // through the RPC with; `costBasisFor` is exported precisely so this rule can still be pinned
    // directly, on the SAME function `modelCatalogWire` calls — not a second, divergent copy of it.
    expect(costBasisFor({ value: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }, source: "upstream-static", confidence: "inferred" })).toBe("unknown");
    expect(costBasisFor({ value: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }, source: "user-override", confidence: "declared" })).toBe("unknown");
    expect(costBasisFor(undefined)).toBe("unknown");
    expect(costBasisFor({ value: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 }, source: "official-doc", confidence: "declared" })).toBe("list");
  });

  test("credentialSlotId: a real eligible provider with NO credential slot (the catalog's own \"console\" provider) reports null", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const consoleProvider = result.result.providers.find((p: any) => p.id === "console");
    // "console" (authKinds: ["console-profile"]) is catalog-eligible (12 servable Claude rows) but
    // is NOT an api-key provider — its one usable slot (`anthropic:console`) is filed under the
    // SEPARATE catalog provider id "anthropic", never under "console" itself.
    expect(consoleProvider).toBeDefined();
    expect(consoleProvider.credentialSlotId).toBeNull();
    expect(consoleProvider.authKinds).toEqual(["console-profile"]);
    // …and `credentialDoor` is what stops a picker reading that `null` as "can never be
    // credentialed": this provider IS reachable, through `winter login --anthropic-console`. A
    // slotless provider with no other door would read `"none"` here instead, which is the whole
    // point of carrying the door rather than leaving the consumer to infer it from `authKinds`.
    expect(consoleProvider.credentialDoor).toBe("console-profile");
    c.close();
  });

  test("credentialSlotId: \"anthropic\" resolves to its own api-key slot, not the console row it also owns", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const anthropic = result.result.providers.find((p: any) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.credentialSlotId).toBe("anthropic:default");
    expect(anthropic.credentialDoor).toBe("keychain");
    c.close();
  });

  test("credentialSlotId: openai/codex-oauth resolve to their own derived slots", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const byId = (id: string) => result.result.providers.find((p: any) => p.id === id);
    expect(byId("openai")?.credentialSlotId).toBe("openai:default");
    expect(byId("codex-oauth")?.credentialSlotId).toBe("codex-oauth:default");
    c.close();
  });

  test("drift tripwire: every tag any role's `permitted` can name resolves in models.catalog, and every providerId resolves in providers", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");

    const rolesResult = await c.request(METHODS.settingsModelRoles, {});
    expect(rolesResult.error).toBeUndefined();
    const catalogResult = await c.request(METHODS.modelsCatalog, {});
    expect(catalogResult.error).toBeUndefined();

    const catalogTags = new Set(catalogResult.result.models.map((m: any) => m.tag));
    const catalogProviderIds = new Set(catalogResult.result.providers.map((p: any) => p.id));

    let checkedAtLeastOneTag = false;
    for (const role of MODEL_ROLES) {
      const permitted = rolesResult.result.roles[role].permitted;
      for (const entry of permitted) {
        expect(catalogProviderIds.has(entry.providerId)).toBe(true);
        for (const tag of entry.models) {
          expect(catalogTags.has(tag)).toBe(true);
          checkedAtLeastOneTag = true;
        }
      }
    }
    // Sanity: the loop actually walked real data (an all-empty `permitted` set would pass vacuously).
    expect(checkedAtLeastOneTag).toBe(true);
    c.close();
  });

  test("drift tripwire (family half): every model's familyId resolves in families", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const familyIds = new Set(result.result.families.map((f: any) => f.id));
    expect(result.result.models.length).toBeGreaterThan(0);
    for (const model of result.result.models) {
      expect(familyIds.has(model.familyId)).toBe(true);
    }
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.modelsCatalog)).toBe(false);
  });
});
