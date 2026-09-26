// `models.catalog` — catalog family/pricing facts for the Mac app's Roles pane model picker.
// Bare IPC server harness, same shape `settings-model-roles.test.ts`/`versions-get.test.ts` already
// use. The most important test here is the drift tripwire: every tag/providerId
// `settings.modelRoles`'s `permitted` can ever name must resolve in `models.catalog`'s own
// `models`/`providers` — that is the whole guarantee this method exists to give the picker.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket, ModelsCatalogResult } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings, MODEL_ROLES } from "../../src/settings";
import { costBasisFor } from "../../src/providers/model-catalog-wire";
import { writeCredentialMaterial } from "../../src/auth/credential-material";
import { consoleProfileCredentialFile } from "../../src/runtime-sdk/anthropic-paths";

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

  test("credentialSlotId: the catalog's own \"console\" provider names its bearer slot, and its DOOR stays the Console sign-in", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const consoleProvider = result.result.providers.find((p: any) => p.id === "console");
    // WS-23 live-gate fix: the broker's bearer slot is filed under `console` itself now (it used to be
    // filed under "anthropic", which left this `null`).
    expect(consoleProvider).toBeDefined();
    expect(consoleProvider.credentialSlotId).toBe("anthropic:console");
    expect(consoleProvider.authKinds).toEqual(["console-profile"]);
    // …but a slot is NOT a "paste a key" door: the broker fills it from `winter login
    // --anthropic-console`, so a picker offering "add a key" for it would send the user nowhere. The
    // door is decided from `authKinds` BEFORE the slot.
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

  // -----------------------------------------------------------------------------------------------
  // 2026-09-18, item 1: the effort vocabulary. The load-bearing assertion in this block is that
  // `null` and `[]` are DIFFERENT answers on real catalog rows of each kind — a consumer renders
  // "this model has no effort concept" and "this model's reasoning is not adjustable" differently,
  // and `effortsForModel` (ipc/sync.ts), which collapses both to `[]`, cannot serve that.
  // -----------------------------------------------------------------------------------------------
  test("efforts: a real row with NO `reasoning` block at all reports null (never [])", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    // `agentrouter/claude-opus-5` carries no `reasoning` block (472 of 618 rows are shaped like this
    // in catalog v3.8.50+winter.1). `openai/gpt-5.4` is a second one, and the tag the sibling
    // role-write tests already use.
    for (const tag of ["agentrouter/claude-opus-5", "openai/gpt-4.1"]) { // R.1: gpt-5.4 has a vocabulary now
      const row = result.result.models.find((m: any) => m.tag === tag);
      expect(row).toBeDefined();
      expect(row.efforts).toBeNull();
      expect(row.defaultEffort).toBeNull();
    }
    c.close();
  });

  test("efforts: a real row WITH a `reasoning` block whose vocabulary is empty reports [] (never null)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    // `agnes/agnes-2.0-flash` declares `reasoning.supported: true` with `efforts: []` — reasoning is
    // claimed, but no effort level is selectable (98 of 618 rows).
    const row = result.result.models.find((m: any) => m.tag === "agnes/agnes-2.0-flash");
    expect(row).toBeDefined();
    expect(row.efforts).toEqual([]);
    expect(row.defaultEffort).toBeNull();
    // Both shapes really are present in the same payload — the distinction is not theoretical.
    expect(result.result.models.some((m: any) => m.efforts === null)).toBe(true);
    expect(result.result.models.some((m: any) => Array.isArray(m.efforts) && m.efforts.length === 0)).toBe(true);
    c.close();
  });

  test("efforts: a row with a vocabulary carries it in the catalog's own order, with NO \"none\" prepended", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const opus = result.result.models.find((m: any) => m.tag === "anthropic/claude-opus-5");
    expect(opus.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // `"none"` is Winter's own unset, deliberately absent from the catalog — `sync.config`'s picker
    // prepends it as a UI convention; this surface carries catalog truth.
    expect(opus.efforts).not.toContain("none");
    // …and `defaultEffort` is independently optional: SDK 0.0.23 gave Opus 5 its documented default
    // (`high`), so the vocabulary-but-no-default row is now Sonnet 4.5 (a budget ladder, thinking off by default).
    const sonnet45 = result.result.models.find((m: any) => m.tag === "anthropic/claude-sonnet-4.5");
    expect(sonnet45.efforts.length).toBeGreaterThan(0);
    expect(sonnet45.defaultEffort).toBeNull();
    // A row that DOES declare one carries it verbatim, and it is a member of its own vocabulary.
    const terra = result.result.models.find((m: any) => m.tag === "codex-oauth/gpt-5.6-terra");
    expect(terra.defaultEffort).toBe("medium");
    expect(terra.efforts).toContain("medium");
    c.close();
  });

  // -----------------------------------------------------------------------------------------------
  // 2026-09-18, item 2: `credentialPresent` — readiness, answered daemon-side by the SAME rule
  // `pickerModels` filters `sync.config`'s model list on.
  // -----------------------------------------------------------------------------------------------
  test("credentialPresent: false for every provider on a home with no stored credentials at all", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    expect(result.result.providers.length).toBeGreaterThan(0);
    for (const p of result.result.providers) expect(p.credentialPresent).toBe(false);
    c.close();
  });

  test("credentialPresent: true for exactly the provider whose Keychain slot holds material", async () => {
    const { home, socketPath, harnessToken } = await boot();
    // Written through the SAME door the daemon reads (`writeCredentialMaterial` — a JSON
    // `CredentialMaterial` record, never a bare string), into the throwaway FileSecretStore `boot`
    // wired; never the real Keychain.
    await writeCredentialMaterial(new FileSecretStore(join(home, "secrets")), "openai:default", { kind: "api-key", key: "sk-test" });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.modelsCatalog, {});
    const byId = (id: string) => result.result.providers.find((p: any) => p.id === id);
    expect(byId("openai").credentialPresent).toBe(true);
    // Presence is per provider, never daemon-wide: nothing else moved.
    expect(byId("codex-oauth").credentialPresent).toBe(false);
    expect(byId("anthropic").credentialPresent).toBe(false);
    expect(byId("console").credentialPresent).toBe(false);
    c.close();
  });

  test("credentialPresent: `console` is answered from its Keychain BEARER slot — the credential a turn sends — never the on-disk profile (WS-23 live-gate fix)", async () => {
    const { home, socketPath, harnessToken } = await boot();
    // An `ant` profile on disk with NO bearer in the slot yet (its first refresh has not landed, or
    // keeps failing): the router would refuse a `console/*` session on this home, so the listing must
    // not offer one.
    const profile = consoleProfileCredentialFile(home);
    mkdirSync(dirname(profile), { recursive: true });
    writeFileSync(profile, "{}");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const byIdIn = async () => {
      const result = await c.request(METHODS.modelsCatalog, {});
      return (id: string) => result.result.providers.find((p: any) => p.id === id);
    };
    let byId = await byIdIn();
    expect(byId("console").credentialPresent).toBe(false);
    // The broker's bearer lands: `console` is ready…
    await writeCredentialMaterial(new FileSecretStore(join(home, "secrets")), "anthropic:console", { kind: "bearer", token: "console-bearer-test" });
    byId = await byIdIn();
    expect(byId("console").credentialPresent).toBe(true);
    expect(byId("console").credentialDoor).toBe("console-profile");
    // …and `anthropic` must NOT have turned ready off the back of it: its own slot
    // (`anthropic:default`, an API KEY) is still empty. The two accounts are two providers now.
    expect(byId("anthropic").credentialPresent).toBe(false);
    c.close();
  });

  test("not remote-allowed — local role only", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.modelsCatalog)).toBe(false);
  });
});
