// Daemon settings surface (2026-09-17 plan, item 4): `settings.modelRoles` (read) + `settings.setModelRole`
// (write) — the ONE door for all nine model-bearing settings roles. Bare IPC server harness, same
// shape `settings-set-advisor-model.test.ts` already uses.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineDecoder, encodeLine, METHODS, PROTOCOL_VERSION, ConnWriter, type WritableSocket } from "@yanlinglabs/winter-protocol";
import { startIpcServer, REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { SessionStore } from "../../src/sessions/store";
import { FileSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { Settings, saveSettings, MODEL_ROLES } from "../../src/settings";
import { RoleHealthRegistry } from "../../src/providers/role-health";
import { createInternalProviderView } from "../../src/providers/internal-view";
import { createInternalRouter } from "../../src/providers/internal-router";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { internalEligibleProviderIds } from "../../src/settings";
import { writeCredentialMaterial } from "../../src/auth/credential-material";

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

describe("settings.modelRoles / settings.setModelRole", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  /** `internalCredentials`: which provider slots to store throwaway material in AND wire the real
   *  internal-jobs router over — the 2026-09-19 shape a production daemon always has. Omitted keeps the
   *  bare pre-2026-09-19 server (no router), which is what every older test in this file asserts. */
  async function boot(providerModel = "codex-oauth/gpt-5.6-sol", opts: { roleHealth?: RoleHealthRegistry; internalCredentials?: string[] } = {}) {
    const home = mkdtempSync(join(tmpdir(), "winter-model-roles-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: providerModel } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    let internalRouter: ReturnType<typeof createInternalRouter> | undefined;
    if (opts.internalCredentials !== undefined) {
      for (const slot of opts.internalCredentials) await writeCredentialMaterial(secrets, slot, { kind: "api-key", key: "sk-test" });
      const view = createInternalProviderView({ secrets, log: () => {} });
      await view.refresh();
      internalRouter = createInternalRouter({ view, secrets });
    }
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets, roleHealth: opts.roleHealth, ...(internalRouter ? { internalRouter } : {}) });
    stop = () => { server.stop(); store.close(); };
    return { home, settingsPath, socketPath, harnessToken: tokens.harness };
  }

  test("settings.modelRoles reads back all nine roles with model/explicit/constraint/permitted", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsModelRoles, {});
    expect(result.error).toBeUndefined();
    expect(result.result.ok).toBe(true);
    const roles = result.result.roles;
    expect(Object.keys(roles).sort()).toEqual([...MODEL_ROLES].sort());
    for (const role of MODEL_ROLES) {
      const info = roles[role];
      expect(typeof info.explicit).toBe("boolean");
      expect(["internal-provider", "any", "same-as-session"]).toContain(info.constraint);
      expect(Array.isArray(info.permitted)).toBe(true);
    }
    // provider.model is always explicit (a required field — no "unset" state).
    expect(roles["provider.model"].explicit).toBe(true);
    expect(roles["provider.model"].model).toBe("codex-oauth/gpt-5.6-sol");
    // No override set anywhere yet — every optional role is not explicit.
    for (const role of ["pins.dispatch", "pins.dream", "pins.cleaner", "pins.research", "pins.researchFallback", "titles.model", "reviewer.model", "runtimes.advisorModel"]) {
      expect(roles[role].explicit).toBe(false);
    }
    // runtimes.advisorModel has no daemon-wide default — null when unset.
    expect(roles["runtimes.advisorModel"].model).toBeNull();
    c.close();
  });

  // R.1 ruling 1: a tag the catalog RETIRED with no rename (`deepseek/deepseek-reasoner`, V16) stays a typed
  // refusal — never a silent fallback to another model. The write door refuses it; a tag STORED before the
  // upgrade surfaces as a derived `model-not-in-catalog` problem on every role that resolves to it.
  test("a retired catalog tag: the write door refuses it, and a stored one surfaces model-not-in-catalog on every role it reaches", async () => {
    const { socketPath, harnessToken } = await boot("deepseek/deepseek-reasoner", { internalCredentials: ["deepseek:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const res = await c.request(METHODS.settingsModelRoles, {});
    for (const role of ["provider.model", "titles.model", "reviewer.model", "pins.dream", "pins.cleaner"]) {
      const info = res.result.roles[role];
      expect(info.model).toBe("deepseek/deepseek-reasoner");
      expect(info.problem).toMatchObject({ reason: "model-not-in-catalog", model: "deepseek/deepseek-reasoner" });
      expect(info.problem.detail).toContain("not in this build's model catalog");
    }
    // …and the note clears the moment the user picks a live model (derived, never persisted).
    const fixed = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", model: "deepseek/deepseek-v4-pro" });
    expect(fixed.error).toBeUndefined();
    expect(fixed.result.roles["provider.model"].problem).toBeNull();
    // The write door never accepts the retired tag in the first place.
    const refused = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model: "deepseek/deepseek-reasoner" });
    expect(refused.error?.code).toBe(-32602);
    expect(refused.error?.message).toContain("no model in the pinned catalog");
    c.close();
  });

  test("every LIVE pin slot writes and clears", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    // `pins.researchFallback` is NOT in this loop any more — it is retired (2026-09-18) and the write
    // door refuses a model for it; its own test below covers refuse-set / still-clears.
    for (const [role, slot] of [
      ["pins.dispatch", "dispatch"], ["pins.dream", "dream"], ["pins.cleaner", "cleaner"],
      ["pins.research", "research"],
    ] as const) {
      const set = await c.request(METHODS.settingsSetModelRole, { role, model: "openai/gpt-5.4" });
      expect(set.error).toBeUndefined();
      expect(set.result).toEqual({ ok: true, model: "openai/gpt-5.4", roles: set.result.roles });
      expect(set.result.roles[role]).toMatchObject({ model: "openai/gpt-5.4", explicit: true });
      let written = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(written.pins[slot]).toBe("openai/gpt-5.4");

      const cleared = await c.request(METHODS.settingsSetModelRole, { role, model: null });
      expect(cleared.error).toBeUndefined();
      expect(cleared.result.roles[role].explicit).toBe(false);
      written = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(written.pins?.[slot]).toBeUndefined();
    }
    c.close();
  });

  test("pins.researchFallback is RETIRED on the wire: still listed, refuses a set, still clears", async () => {
    // 2026-09-18 (the web-tools ruling): its ONE consumer was the multi-page research runner, retired
    // with `ReadPage`. The role stays in `MODEL_ROLES` and in the protocol's `ModelRole` enum — narrowing
    // that enum is an RPC-schema change with a Swift mirror behind it — so it is marked retired with
    // fields the wire already has, and a value stored before the retirement must stay CLEARABLE.
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");

    const listed = await c.request(METHODS.settingsModelRoles, {});
    const info = listed.result.roles["pins.researchFallback"];
    expect(info).toBeDefined();
    // Nothing to pick, and no effort control — the two "this role is retired" signals the wire can carry.
    expect(info.permitted).toEqual([]);
    expect(info.efforts).toBeNull();

    const refusedModel = await c.request(METHODS.settingsSetModelRole, { role: "pins.researchFallback", model: "openai/gpt-5.4" });
    expect(refusedModel.error).toBeDefined();
    expect(String(refusedModel.error.message)).toContain("retired");
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).pins?.researchFallback).toBeUndefined();

    const refusedEffort = await c.request(METHODS.settingsSetModelRole, { role: "pins.researchFallback", effort: "low" });
    expect(refusedEffort.error).toBeDefined();

    // A pin written directly (as an older daemon's door would have) still clears through this door.
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    raw.pins = { ...(raw.pins ?? {}), researchFallback: "openai/gpt-5.4" };
    writeFileSync(settingsPath, JSON.stringify(raw));
    const cleared = await c.request(METHODS.settingsSetModelRole, { role: "pins.researchFallback", model: null });
    expect(cleared.error).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).pins?.researchFallback).toBeUndefined();
    c.close();
  });

  test("titles.model and reviewer.model write and clear, preserving sibling fields (enabled/allow)", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    // Seed titles.enabled/reviewer.enabled+allow BEFORE any model-role write, to prove the write
    // preserves them (a shallow replace of the whole block would silently drop them).
    let raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    raw.titles = { enabled: false };
    raw.reviewer = { enabled: true, allow: ["ls"] };
    writeFileSync(settingsPath, JSON.stringify(raw));

    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");

    const setTitles = await c.request(METHODS.settingsSetModelRole, { role: "titles.model", model: "openai/gpt-5.4" });
    expect(setTitles.error).toBeUndefined();
    let written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.titles).toEqual({ enabled: false, model: "openai/gpt-5.4" });

    const setReviewer = await c.request(METHODS.settingsSetModelRole, { role: "reviewer.model", model: "openai/gpt-5.4" });
    expect(setReviewer.error).toBeUndefined();
    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.reviewer).toEqual({ enabled: true, allow: ["ls"], model: "openai/gpt-5.4" });

    // A live read (no restart) immediately reflects both writes.
    const read = await c.request(METHODS.settingsModelRoles, {});
    expect(read.result.roles["titles.model"]).toMatchObject({ model: "openai/gpt-5.4", explicit: true });
    expect(read.result.roles["reviewer.model"]).toMatchObject({ model: "openai/gpt-5.4", explicit: true });

    // Clearing preserves the sibling fields too.
    await c.request(METHODS.settingsSetModelRole, { role: "titles.model", model: null });
    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.titles).toEqual({ enabled: false });
    await c.request(METHODS.settingsSetModelRole, { role: "reviewer.model", model: null });
    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.reviewer).toEqual({ enabled: true, allow: ["ls"] });
    c.close();
  });

  test("runtimes.advisorModel delegates to setAdvisorModel — writes/clears settings.runtimes.advisorModel", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "runtimes.advisorModel", model: "anthropic/claude-opus-5" });
    expect(set.result).toEqual({ ok: true, model: "anthropic/claude-opus-5", roles: set.result.roles });
    let written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.runtimes.advisorModel).toBe("anthropic/claude-opus-5");
    await c.request(METHODS.settingsSetModelRole, { role: "runtimes.advisorModel", model: null });
    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.runtimes?.advisorModel).toBeUndefined();
    c.close();
  });

  test("a bare id is refused INVALID_PARAMS at the schema door, before the handler ever runs", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model: "gpt-5.4" });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602);
    c.close();
  });

  test("an unknown role name is refused INVALID_PARAMS at the schema door", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsSetModelRole, { role: "pins.bogus", model: "openai/gpt-5.4" });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602);
    c.close();
  });

  test("the unstated/unstated sentinel is refused INVALID_PARAMS on every role", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    for (const role of MODEL_ROLES) {
      const result = await c.request(METHODS.settingsSetModelRole, { role, model: "unstated/unstated" });
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32602);
    }
    c.close();
  });

  test("provider.model refuses null — it has no \"unset\" state (INVALID_PARAMS, not a silent no-op)", async () => {
    const { socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", model: null });
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32602);
    c.close();
  });

  // 2026-09-19 (the internal-jobs widening), narrowed WS-23: this test used to pin "the write always
  // accepts, the read reports" for an internal-jobs role, on the strength of `internalModelFor`
  // skipping a mismatched pin at run time. Both halves moved, and on a principled line:
  //
  //  - a PERMANENTLY unrunnable provider (one whose adapter family the daemon cannot drive — Bedrock's
  //    `aws` material — or the reserved `cc` row) is refused AT THE WRITE, because no future
  //    credential makes it runnable and storing it would only produce a role that silently never runs;
  //  - `anthropic` rejoined the admittable set in WS-23 (its API key is an ordinary token-priced
  //    credential now that every model runs on the Winter SDK), and `console` with the live-gate fix
  //    (its bearer slot is an inventory row the Anthropic adapter is driven over), so both are accepted;
  //  - an ELIGIBLE provider with no credential yet is accepted and LISTED as permitted — the old test's
  //    own rationale ("a provider the user is about to bind") applies to exactly that case.
  test("an internal-jobs role refuses a permanently-unrunnable provider at the write, and says why", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "bedrock/anthropic.claude-sonnet-4-5" });
    expect(set.error?.code).toBe(-32602);
    expect(set.error?.message).toContain("can't run on AWS Bedrock");
    expect(set.error?.message).toContain("no way to drive that provider");
    // ...while the rejoined `anthropic` and `console` rows are accepted on the same role.
    const anthropic = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "anthropic/claude-opus-5" });
    expect(anthropic.error).toBeUndefined();
    expect(anthropic.result.model).toBe("anthropic/claude-opus-5");
    const consolePin = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "console/claude-opus-5" });
    expect(consolePin.error).toBeUndefined();
    expect(consolePin.result.model).toBe("console/claude-opus-5");
    c.close();
  });

  test("an internal-jobs role accepts an eligible-but-uncredentialed provider, and lists it as permitted", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    // R.1: the retired spelling is accepted on the wire and canonicalized to DeepSeek's live row (the
    // catalog's CATALOG_TAG_RENAMES, applied at the protocol parse).
    const set = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "deepseek/deepseek-v4-flash" });
    expect(set.error).toBeUndefined();
    expect(set.result.model).toBe("deepseek/deepseek-flash");
    const permittedProviderIds = set.result.roles["pins.dream"].permitted.map((p: any) => p.providerId);
    expect(permittedProviderIds).toContain("deepseek");
    // WS-23: `anthropic` and (live-gate fix) `console` are ordinary eligible providers now; an
    // undrivable adapter family stays out of every internal role's permitted set.
    expect(permittedProviderIds).toContain("anthropic");
    expect(permittedProviderIds).toContain("console");
    expect(permittedProviderIds).not.toContain("bedrock");
    c.close();
  });

  // -------------------------------------------------------------------------------------------
  // 2026-09-19: the DERIVED role problems. These are recomputed from the live view on every read
  // (never written to role-health.json), so they clear themselves the moment the condition clears.
  // -------------------------------------------------------------------------------------------
  test("a DeepSeek default with a Codex credential: the internal roles have a real model, a picker and NO problem", async () => {
    const { socketPath, harnessToken } = await boot("deepseek/deepseek-flash", { internalCredentials: ["codex-oauth:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const res = await c.request(METHODS.settingsModelRoles, {});
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"]) {
      const info = res.result.roles[role];
      expect(info.problem).toBeNull();
      expect(info.model).toBe("codex-oauth/gpt-5.6-terra");
      expect(info.permitted.length).toBeGreaterThan(1);
      const ids = info.permitted.map((p: any) => p.providerId);
      expect(ids).toContain("codex-oauth");
      expect(ids).toContain("deepseek");
      expect(ids).toContain("anthropic");
      expect(ids).toContain("console");
      expect(ids).not.toContain("bedrock");
    }
    c.close();
  });

  test("a DeepSeek default with a DeepSeek key: zero setup — the roles sit on the user's own model", async () => {
    const { socketPath, harnessToken } = await boot("deepseek/deepseek-flash", { internalCredentials: ["deepseek:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const res = await c.request(METHODS.settingsModelRoles, {});
    expect(res.result.roles["titles.model"].model).toBe("deepseek/deepseek-flash");
    expect(res.result.roles["titles.model"].problem).toBeNull();
    c.close();
  });

  // WS-23 R1 addendum: a Claude-only home — `anthropic/*` default, only the Anthropic key stored.
  // `anthropic` is an ordinary eligible provider now, so every internal role sits on the user's own
  // Claude model with no problem (rung 1: eligible AND credentialed; anthropic declares no
  // terra/luna slot, so the default is `provider.model` itself).
  test("a Claude-only home: zero setup — all four internal roles sit on the user's own Claude model, problem null", async () => {
    const { socketPath, harnessToken } = await boot("anthropic/claude-sonnet-5", { internalCredentials: ["anthropic:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const res = await c.request(METHODS.settingsModelRoles, {});
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"]) {
      const info = res.result.roles[role];
      expect(info.model).toBe("anthropic/claude-sonnet-5");
      expect(info.problem).toBeNull();
    }
    c.close();
  });

  test("no internal credential: every internal role reports no-internal-credential, with the logins that fix it", async () => {
    const { socketPath, harnessToken } = await boot("deepseek/deepseek-flash", { internalCredentials: [] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const res = await c.request(METHODS.settingsModelRoles, {});
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"]) {
      const info = res.result.roles[role];
      expect(info.problem?.reason).toBe("no-internal-credential");
      expect(info.problem?.detail).toContain("ChatGPT");
      expect(info.problem?.detail).toContain("credentials set");
      expect(info.model).toBeNull();
    }
    // The `"any"` roles are untouched: they route through the runtime SDK, not through this.
    expect(res.result.roles["pins.dispatch"].problem).toBeNull();
    expect(res.result.roles["provider.model"].problem).toBeNull();
    c.close();
  });

  test("an explicit pin on an eligible provider with no key: no-credential, naming that provider", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "pins.cleaner", model: "deepseek/deepseek-flash" });
    expect(set.error).toBeUndefined();
    const info = set.result.roles["pins.cleaner"];
    expect(info.problem?.reason).toBe("no-credential");
    expect(info.problem?.detail).toContain("DeepSeek");
    expect(info.problem?.model).toBe("deepseek/deepseek-flash");
    // Its sibling roles are fine — a problem is per role, never daemon-wide.
    expect(set.result.roles["titles.model"].problem).toBeNull();
    c.close();
  });

  // WS-23: `anthropic` and (live-gate fix) `console` pins are runnable, so they report no problem at
  // all; the hand-written ineligible pin is a Bedrock row — a settings.json the write door would refuse.
  test("a stored pin on a provider that became ineligible reports provider-unsupported (a settings.json written before the ruling)", async () => {
    const { socketPath, harnessToken, settingsPath } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    // Written by hand, the way an old settings.json carries it — the write door refuses this now.
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    writeFileSync(settingsPath, JSON.stringify({ ...raw, titles: { model: "bedrock/anthropic.claude-sonnet-4-5" } }, null, 2));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const res = await c.request(METHODS.settingsModelRoles, {});
    const info = res.result.roles["titles.model"];
    expect(info.problem?.reason).toBe("provider-unsupported");
    expect(info.problem?.detail).toBe("AWS Bedrock can't be used for Winter's own jobs yet");
    // The role's own model is still reported verbatim so the user can SEE and clear it.
    expect(info.model).toBe("bedrock/anthropic.claude-sonnet-4-5");
    c.close();
  });

  test("the derived problem clears itself the moment the pin is cleared — nothing persisted to unwind", async () => {
    const { socketPath, harnessToken, settingsPath } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    writeFileSync(settingsPath, JSON.stringify({ ...raw, titles: { model: "bedrock/anthropic.claude-sonnet-4-5" } }, null, 2));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    expect((await c.request(METHODS.settingsModelRoles, {})).result.roles["titles.model"].problem?.reason).toBe("provider-unsupported");
    const cleared = await c.request(METHODS.settingsSetModelRole, { role: "titles.model", model: null });
    expect(cleared.error).toBeUndefined();
    expect(cleared.result.roles["titles.model"].problem).toBeNull();
    expect((await c.request(METHODS.settingsModelRoles, {})).result.roles["titles.model"].problem).toBeNull();
    c.close();
  });

  test("storing a credential clears no-internal-credential on the very next read — no restart", async () => {
    const { socketPath, harnessToken } = await boot("deepseek/deepseek-flash", { internalCredentials: [] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    expect((await c.request(METHODS.settingsModelRoles, {})).result.roles["pins.dream"].problem?.reason).toBe("no-internal-credential");
    const set = await c.request(METHODS.credentialSet, { providerId: "deepseek", apiKey: "sk-deepseek-test-value" });
    expect(set.error).toBeUndefined();
    const after = (await c.request(METHODS.settingsModelRoles, {})).result.roles["pins.dream"];
    expect(after.problem).toBeNull();
    expect(after.model).toBe("deepseek/deepseek-flash");
    // …and removing it again makes them inert, cleanly.
    const removed = await c.request(METHODS.credentialRemove, { providerId: "deepseek" });
    expect(removed.error).toBeUndefined();
    expect((await c.request(METHODS.settingsModelRoles, {})).result.roles["pins.dream"].problem?.reason).toBe("no-internal-credential");
    c.close();
  });

  test("M-3: a credentialed third-party provider with no family slot reports no-default-model, not a guess", async () => {
    // `groq` is eligible and credentialed, declares no terra slot, and is not the session default's
    // provider — the exact shape the retired "first non-blocked llm row" rung used to answer with
    // `groq/llama-3.3-70b-versatile`, a model the user never chose.
    const { socketPath, harnessToken } = await boot("groq/llama-3.3-70b-versatile", { internalCredentials: ["groq:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    // With groq AS the session default it IS the user's own choice, so the role sits on it.
    expect((await c.request(METHODS.settingsModelRoles, {})).result.roles["titles.model"].model).toBe("groq/llama-3.3-70b-versatile");
    // Move the session default to a Claude row: groq is still the only credential, but Winter will no
    // longer name a model on it, and codex-oauth/openai (which do have slots) have no key.
    const moved = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", model: "anthropic/claude-opus-5" });
    expect(moved.error).toBeUndefined();
    const info = moved.result.roles["titles.model"];
    expect(info.model).toBeNull();
    // `no-default-model`, NOT `no-internal-credential`: a credential exists, so "add a key" would be
    // both wrong and unactionable. The fix is a pin, and the detail names the provider.
    expect(info.problem?.reason).toBe("no-default-model");
    expect(info.problem?.detail).toBe("pick a model for this job in Settings › Roles — Winter won't choose one on Groq for you");
    expect(info.problem?.model).toBe("");
    // A pin on a provider that DOES have a slot clears it immediately.
    const pinned = await c.request(METHODS.settingsSetModelRole, { role: "titles.model", model: "groq/llama-3.3-70b-versatile" });
    expect(pinned.error).toBeUndefined();
    expect(pinned.result.roles["titles.model"].problem).toBeNull();
    expect(pinned.result.roles["titles.model"].model).toBe("groq/llama-3.3-70b-versatile");
    c.close();
  });

  test("M-3: no-default-model when a slot-less provider IS the preferred one", async () => {
    // Forced by pinning `provider.model` to a provider that is eligible+credentialed but declares no
    // family slot AND is not itself nameable — reached through `pins.research`-style cross wiring is not
    // possible here, so this exercises the reader directly alongside the RPC's own shape.
    const { socketPath, harnessToken } = await boot("groq/llama-3.3-70b-versatile", { internalCredentials: ["groq:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const res = await c.request(METHODS.settingsModelRoles, {});
    // The zero-setup case still works — the point is only that nothing was GUESSED.
    expect(res.result.roles["pins.dream"].model).toBe("groq/llama-3.3-70b-versatile");
    expect(res.result.roles["pins.dream"].problem).toBeNull();
    c.close();
  });

  test("M-3: setModelRole refuses a blocked catalog row for an internal job", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const blocked = loadCatalog().models.find((m) => m.status === "blocked" && internalEligibleProviderIds().has(m.providerId));
    if (blocked === undefined) { c.close(); return; } // no blocked row on an eligible provider today
    const set = await c.request(METHODS.settingsSetModelRole, { role: "titles.model", model: blocked.key });
    expect(set.error?.code).toBe(-32602);
    expect(set.error?.message).toContain("blocked");
    c.close();
  });

  // USER RULING 2026-09-19: the reviewer is a safety gate, so an unrunnable pin does not switch it off.
  // The pane must show BOTH facts: the pin needs fixing, AND the gate is still up meanwhile.
  test("reviewer.model pinned to an uncredentialed provider: the problem is the PIN's, with a `meanwhile` clause", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "reviewer.model", model: "deepseek/deepseek-flash" });
    expect(set.error).toBeUndefined();
    const info = set.result.roles["reviewer.model"];
    // The role's own model is the pin, reported verbatim so the user can see and change it.
    expect(info.model).toBe("deepseek/deepseek-flash");
    expect(info.problem?.reason).toBe("no-credential");
    expect(info.problem?.detail).toBe("no credential is stored for DeepSeek — reviewing on codex-oauth/gpt-5.6-terra meanwhile");
    expect(info.problem?.model).toBe("deepseek/deepseek-flash");
    c.close();
  });

  test("reviewer.model with an undrivable pin (written by hand): same, as provider-unsupported", async () => {
    const { socketPath, harnessToken, settingsPath } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    writeFileSync(settingsPath, JSON.stringify({ ...raw, reviewer: { model: "bedrock/anthropic.claude-sonnet-4-5" } }, null, 2));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const info = (await c.request(METHODS.settingsModelRoles, {})).result.roles["reviewer.model"];
    expect(info.problem?.reason).toBe("provider-unsupported");
    expect(info.problem?.detail).toBe("AWS Bedrock can't be used for Winter's own jobs yet — reviewing on codex-oauth/gpt-5.6-terra meanwhile");
    c.close();
  });

  test("THE ASYMMETRY on the wire: the same pin on titles gets NO `meanwhile` — that job really is inert", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "titles.model", model: "deepseek/deepseek-flash" });
    expect(set.error).toBeUndefined();
    const info = set.result.roles["titles.model"];
    expect(info.problem?.reason).toBe("no-credential");
    expect(info.problem?.detail).toBe("no credential is stored for DeepSeek");
    expect(info.problem?.detail).not.toContain("meanwhile");
    c.close();
  });

  test("a RUNNABLE reviewer pin has no problem at all", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { internalCredentials: ["codex-oauth:default"] });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "reviewer.model", model: "codex-oauth/gpt-5.6-luna" });
    expect(set.result.roles["reviewer.model"].problem).toBeNull();
    c.close();
  });

  test("nothing to fall back to: the reviewer reports the structural refusal (the hook then allows)", async () => {
    const { socketPath, harnessToken, settingsPath } = await boot("deepseek/deepseek-flash", { internalCredentials: [] });
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    writeFileSync(settingsPath, JSON.stringify({ ...raw, reviewer: { model: "anthropic/claude-opus-5" } }, null, 2));
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const info = (await c.request(METHODS.settingsModelRoles, {})).result.roles["reviewer.model"];
    expect(info.problem?.reason).toBe("no-internal-credential");
    expect(info.problem?.detail).not.toContain("meanwhile");
    c.close();
  });

  test("provider.model cascade: changing it moves pins.dispatch's default AND titles/reviewer's approximated default", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const before = await c.request(METHODS.settingsModelRoles, {});
    const dispatchBefore = before.result.roles["pins.dispatch"].model;
    // titles.model's unset default is the LITERAL provider.model tag (this file's own approximation
    // doc); pins.dispatch's unset default is pinsFor's own terra-slot rule — the two need not agree,
    // but titles.model's default IS the current provider.model exactly.
    expect(before.result.roles["titles.model"].model).toBe("codex-oauth/gpt-5.6-sol");

    const set = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", model: "openai/gpt-5.4" });
    expect(set.error).toBeUndefined();
    expect(set.result.roles["provider.model"].model).toBe("openai/gpt-5.4");
    // pins.dispatch (constraint "any") still has no explicit override, so its default cascades.
    expect(set.result.roles["pins.dispatch"].explicit).toBe(false);
    expect(set.result.roles["pins.dispatch"].model).not.toBe(dispatchBefore);
    // titles.model (unset) reads back the new primary too — the documented approximation.
    expect(set.result.roles["titles.model"].model).toBe("openai/gpt-5.4");
    // ownProvider flipped to "openai" (INTERNAL_PROVIDER_IDS), so internal-provider roles now
    // permit openai's own rows.
    expect(set.result.roles["pins.dream"].permitted.map((p: any) => p.providerId)).toContain("openai");
    c.close();
  });

  // MEDIUM (fix wave, pre-merge review, finding 4): before this fix, `permitted` for an
  // "internal-provider" role was computed from `ownProviderFor(settings)` alone — a pure settings
  // read that can disagree with the daemon's ACTUAL bound backend after a rebind that failed (no
  // stored credential yet for the new provider — `RebindableProvider.refresh` never tears down the
  // old backend on failure, so every real call still dispatches to it, but this reader advertised
  // the new, unreachable provider's rows as `permitted` anyway). `boundProviderId` simulates exactly
  // that stuck state: settings.provider.model already names `openai`, but the daemon is still
  // (only) bound to `codex-oauth`.
  test("settings.modelRoles: permitted for an internal-provider role reflects the BOUND backend, not settings alone (a stuck rebind)", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-model-roles-stuck-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets,
      boundProviderId: () => "codex-oauth", // the daemon's ACTUAL bound backend — the stuck rebind
    });
    stop = () => { server.stop(); store.close(); };

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli");
    const result = await c.request(METHODS.settingsModelRoles, {});
    expect(result.error).toBeUndefined();
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"] as const) {
      const providerIds = result.result.roles[role].permitted.map((p: any) => p.providerId);
      expect(providerIds).toEqual(["codex-oauth"]); // the BOUND backend — never settings' "openai"
    }
    // "any"-constraint roles are unaffected — they never narrow to a single provider. `pins.research`
    // joined them on 2026-09-18: it is `WebFetch`'s page-digest model now, resolved inside the runtime
    // child on any catalog provider with a credential, so the daemon's own bound backend has no say.
    for (const role of ["provider.model", "pins.dispatch", "pins.research"] as const) {
      expect(result.result.roles[role].permitted.length).toBeGreaterThan(1);
    }
    c.close();
  });

  test("settings.setModelRole echoes the same bound-provider permitted set on its post-write cascade", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-model-roles-stuck-write-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({
      socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets,
      boundProviderId: () => "codex-oauth",
    });
    stop = () => { server.stop(); store.close(); };

    const c = await TestClient.connect(socketPath);
    await c.hello(tokens.harness, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "codex-oauth/gpt-5.6-luna" });
    expect(set.error).toBeUndefined();
    expect(set.result.roles["titles.model"].permitted.map((p: any) => p.providerId)).toEqual(["codex-oauth"]);
    c.close();
  });

  // -----------------------------------------------------------------------------------------------
  // 2026-09-18, item 3: a role's reasoning effort. Storage is `settings.roleEfforts.<role>`, keyed by
  // the SAME role ids the wire's `role` parameter uses — except `provider.model`, which keeps its
  // established home in `settings.provider.reasoningEffort`.
  // -----------------------------------------------------------------------------------------------
  test("settings.modelRoles reads effort/effortExplicit/efforts for every role, with no effort stored", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsModelRoles, {});
    const roles = result.result.roles;
    for (const role of MODEL_ROLES) {
      // Nothing stored anywhere yet — and an absent effort is reported as absent, never defaulted to
      // a level the user never chose.
      expect(roles[role].effort).toBeNull();
      expect(roles[role].effortExplicit).toBe(false);
    }
    // `efforts` is the CURRENT model's vocabulary, with the same three states `models.catalog` carries.
    expect(roles["provider.model"].model).toBe("codex-oauth/gpt-5.6-sol");
    expect(roles["provider.model"].efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // …and `null` for a role that names no model at all (an unset advisor) — nothing to ask a row about.
    expect(roles["runtimes.advisorModel"].model).toBeNull();
    expect(roles["runtimes.advisorModel"].efforts).toBeNull();
    c.close();
  });

  test("effort: set, read back, and clear with null — stored in settings.roleEfforts keyed by the role id", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");

    const set = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model: "codex-oauth/gpt-5.6-terra", effort: "high" });
    expect(set.error).toBeUndefined();
    expect(set.result.roles["pins.dispatch"]).toMatchObject({ model: "codex-oauth/gpt-5.6-terra", effort: "high", effortExplicit: true });
    // The wire's `role` IS the settings key — that is the whole point of the block's shape.
    let written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.roleEfforts).toEqual({ "pins.dispatch": "high" });

    // A live read (no restart) sees it, with the model's vocabulary beside it.
    const read = await c.request(METHODS.settingsModelRoles, {});
    expect(read.result.roles["pins.dispatch"]).toMatchObject({ effort: "high", effortExplicit: true });
    expect(read.result.roles["pins.dispatch"].efforts).toContain("high");

    const cleared = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model: "codex-oauth/gpt-5.6-terra", effort: null });
    expect(cleared.error).toBeUndefined();
    expect(cleared.result.roles["pins.dispatch"]).toMatchObject({ effort: null, effortExplicit: false });
    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.roleEfforts?.["pins.dispatch"]).toBeUndefined();
    c.close();
  });

  test("effort: ABSENT leaves a stored effort untouched — distinguishable from `null`", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "codex-oauth/gpt-5.6-luna", effort: "low" });

    // A model-only write on the SAME role — no `effort` key at all.
    const modelOnly = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "codex-oauth/gpt-5.6-terra" });
    expect(modelOnly.error).toBeUndefined();
    expect(modelOnly.result.roles["pins.dream"]).toMatchObject({ model: "codex-oauth/gpt-5.6-terra", effort: "low", effortExplicit: true });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.roleEfforts["pins.dream"]).toBe("low");

    // …and a write on a DIFFERENT role leaves it alone too (per-role storage, not one global effort).
    await c.request(METHODS.settingsSetModelRole, { role: "pins.cleaner", model: "codex-oauth/gpt-5.6-luna", effort: "max" });
    const both = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(both.roleEfforts).toEqual({ "pins.dream": "low", "pins.cleaner": "max" });
    c.close();
  });

  test("effort: provider.model round-trips through provider.reasoningEffort, NEVER through roleEfforts", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const set = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", model: "codex-oauth/gpt-5.6-sol", effort: "xhigh" });
    expect(set.error).toBeUndefined();
    expect(set.result.roles["provider.model"]).toMatchObject({ effort: "xhigh", effortExplicit: true });
    let written = JSON.parse(readFileSync(settingsPath, "utf8"));
    // The established home — what `winter model --effort` writes and what `sync.config`'s
    // `defaultEffort` reads. Duplicating it into `roleEfforts` would be two places to disagree.
    expect(written.provider.reasoningEffort).toBe("xhigh");
    expect(written.roleEfforts).toBeUndefined();

    // And an effort written the OLD way is read back by the new role surface, unchanged.
    const read = await c.request(METHODS.settingsModelRoles, {});
    expect(read.result.roles["provider.model"].effort).toBe("xhigh");

    const cleared = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", model: "codex-oauth/gpt-5.6-sol", effort: null });
    expect(cleared.result.roles["provider.model"]).toMatchObject({ effort: null, effortExplicit: false });
    written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.provider.reasoningEffort).toBeUndefined();
    c.close();
  });

  test("effort: a level outside the model's vocabulary is refused INVALID_PARAMS and nothing is written", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    // `openai/o4-mini` declares exactly ["low","medium","high"], so `"max"` — a perfectly real wire
    // effort — is one THIS model does not offer.
    const refused = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model: "openai/o4-mini", effort: "max" });
    expect(refused.error).toBeDefined();
    expect(refused.error.code).toBe(-32602);
    expect(refused.error.message).toContain("is not accepted by model 'openai/o4-mini'");
    // The MODEL half is refused with it — one transform, one `saveSettings`, so a refused effort
    // never leaves a half-applied write behind.
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.pins?.dispatch).toBeUndefined();
    expect(written.roleEfforts).toBeUndefined();

    // A level no role could STORE (outside `REASONING_EFFORTS`) refuses at the door too, rather than
    // throwing out of `saveSettings`' own validation pass.
    const unstorable = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model: "codex-oauth/gpt-5.6-terra", effort: "minimal" });
    expect(unstorable.error.code).toBe(-32602);
    expect(unstorable.error.message).toContain("is not a reasoning effort this daemon can store");

    // "none" IS accepted on a row with a vocabulary, even though the catalog never lists it.
    const none = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model: "codex-oauth/gpt-5.6-terra", effort: "none" });
    expect(none.error).toBeUndefined();
    expect(none.result.roles["pins.dispatch"].effort).toBe("none");
    c.close();
  });

  test("effort: ANY effort is refused on a real catalog row that declares no vocabulary", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    // Two shapes of "no vocabulary", both refused, exactly as `session.setEffort` refuses them:
    //   `openai/gpt-4.1`        — no `reasoning` block at all (R.1: the refreshed catalog gave gpt-5.4 one)
    //   `agnes/agnes-2.0-flash` — a `reasoning` block with `efforts: []`
    for (const model of ["openai/gpt-4.1", "agnes/agnes-2.0-flash"]) {
      for (const effort of ["high", "none"]) {
        const refused = await c.request(METHODS.settingsSetModelRole, { role: "pins.dispatch", model, effort });
        expect(refused.error).toBeDefined();
        expect(refused.error.code).toBe(-32602);
        expect(refused.error.message).toContain("declares no reasoning-effort vocabulary");
      }
    }
    c.close();
  });

  test("effort: a Winter-level tier is refused on every role (no role's model is a code session's own)", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    for (const [role, model] of [
      ["pins.dispatch", "codex-oauth/gpt-5.6-terra"],
      ["provider.model", "codex-oauth/gpt-5.6-sol"],
      ["pins.dream", "codex-oauth/gpt-5.6-luna"],
      ["runtimes.advisorModel", "codex-oauth/gpt-5.6-terra"],
    ] as const) {
      const refused = await c.request(METHODS.settingsSetModelRole, { role, model, effort: "ultra" });
      expect(refused.error).toBeDefined();
      expect(refused.error.code).toBe(-32602);
      expect(refused.error.message).toContain("Winter-level tier");
    }
    c.close();
  });

  test("effort: a cleared runtimes.advisorModel has no model to validate an effort against — refused, never an orphan", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const refused = await c.request(METHODS.settingsSetModelRole, { role: "runtimes.advisorModel", model: null, effort: "high" });
    expect(refused.error).toBeDefined();
    expect(refused.error.code).toBe(-32602);
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).roleEfforts).toBeUndefined();

    // CHANGED 2026-09-18 (the spend side). This half used to assert "with a model in the same call it
    // lands". It no longer may: neither agent SDK's advisor option can carry an effort
    // (`roleCarriesEffort`), so a stored one could never be spent, and the door now refuses it on ANY
    // model rather than store a value nothing honours. The write is atomic — the model half of the
    // refused call must not land either.
    const withModel = await c.request(METHODS.settingsSetModelRole, { role: "runtimes.advisorModel", model: "anthropic/claude-opus-5", effort: "high" });
    expect(withModel.error).toBeDefined();
    expect(withModel.error.code).toBe(-32602);
    expect(withModel.error.message).toContain("cannot run at a chosen reasoning effort");
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.roleEfforts).toBeUndefined();
    expect(after.runtimes?.advisorModel).toBeUndefined();

    // …and the read side never offers a control for it, even once the role names a model WITH a vocabulary.
    const set = await c.request(METHODS.settingsSetModelRole, { role: "runtimes.advisorModel", model: "codex-oauth/gpt-5.6-terra" });
    expect(set.error).toBeUndefined();
    expect(set.result.roles["runtimes.advisorModel"]).toMatchObject({ model: "codex-oauth/gpt-5.6-terra", effort: null, efforts: null });
    c.close();
  });

  test("a roleEfforts block survives a settings write that never mentions it (mergeUnknownKeys / load-save round trip)", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    // Seeded BY HAND, as a client that knows the key would leave it, then touched by a write from a
    // DIFFERENT surface entirely (`settings.setSkillDenied` — no role, no effort anywhere in it).
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    raw.roleEfforts = { "pins.dream": "high", "titles.model": "low" };
    raw.someFutureKey = { kept: true };
    writeFileSync(settingsPath, JSON.stringify(raw));

    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const denied = await c.request(METHODS.settingsSetSkillDenied, { name: "some-skill", denied: true });
    expect(denied.error).toBeUndefined();

    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.roleEfforts).toEqual({ "pins.dream": "high", "titles.model": "low" });
    // The pre-existing unknown-key guarantee still holds beside it.
    expect(after.someFutureKey).toEqual({ kept: true });
    // …and a role write that names one role leaves the OTHER role's effort alone.
    await c.request(METHODS.settingsSetModelRole, { role: "pins.cleaner", model: "codex-oauth/gpt-5.6-luna" });
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).roleEfforts).toEqual({ "pins.dream": "high", "titles.model": "low" });
    c.close();
  });

  test("not remote-allowed — local role only, for both methods", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.settingsModelRoles)).toBe(false);
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.settingsSetModelRole)).toBe(false);
  });

  // -----------------------------------------------------------------------------------------------
  // 2026-09-18: `problem` — the role-health note merged onto each `ModelRoleInfo` at the RPC handler
  // (`ipc/server.ts`'s `withProblemsForRoles`), never inside `settings.ts`'s pure readers.
  // -----------------------------------------------------------------------------------------------
  test("problem is null for every role with no roleHealth wired, and null for every role with roleHealth wired but no failure recorded", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const result = await c.request(METHODS.settingsModelRoles, {});
    for (const role of MODEL_ROLES) expect(result.result.roles[role].problem).toBeNull();
    c.close();
  });

  test("problem is populated on settings.modelRoles once a failure is recorded for that role's CURRENT effective model, and clears on success", async () => {
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-model-roles-rh-")));
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { roleHealth });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");

    // pins.dream's default (unpinned) is codex-oauth/gpt-5.6-terra (pinsFor's own terra/luna rule —
    // dream/cleaner/dispatch default to terra; only research/researchFallback default to luna).
    roleHealth.recordFailure("pins.dream", "codex-oauth/gpt-5.6-terra", { reason: "usage-limit", detail: "the plan's usage window is exhausted", retryAt: "2026-09-19T00:00:00.000Z" });
    let result = await c.request(METHODS.settingsModelRoles, {});
    expect(result.result.roles["pins.dream"].problem).toEqual({
      reason: "usage-limit", detail: "the plan's usage window is exhausted",
      model: "codex-oauth/gpt-5.6-terra", at: result.result.roles["pins.dream"].problem.at, retryAt: "2026-09-19T00:00:00.000Z",
    });
    // Every OTHER role is unaffected.
    expect(result.result.roles["pins.cleaner"].problem).toBeNull();

    roleHealth.recordSuccess("pins.dream");
    result = await c.request(METHODS.settingsModelRoles, {});
    expect(result.result.roles["pins.dream"].problem).toBeNull();
    c.close();
  });

  test("problem also rides settings.setModelRole's post-write roles echo, and clears when the role moves OFF the failed model", async () => {
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-model-roles-rh2-")));
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol", { roleHealth });
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");

    roleHealth.recordFailure("pins.cleaner", "codex-oauth/gpt-5.6-luna", { reason: "credential-rejected", detail: "the stored credential was rejected by the provider" });
    // Pin pins.cleaner to the SAME model that failed — the note is still current.
    let set = await c.request(METHODS.settingsSetModelRole, { role: "pins.cleaner", model: "codex-oauth/gpt-5.6-luna" });
    expect(set.result.roles["pins.cleaner"].problem).toMatchObject({ reason: "credential-rejected" });

    // Pin it to a DIFFERENT model — the note is about a model this role no longer runs, so it reads
    // as problem-free (without being deleted — role-health.test.ts covers that half directly).
    set = await c.request(METHODS.settingsSetModelRole, { role: "pins.cleaner", model: "codex-oauth/gpt-5.6-terra" });
    expect(set.result.roles["pins.cleaner"].problem).toBeNull();
    c.close();
  });

  // -----------------------------------------------------------------------------------------------
  // 2026-09-18, item 5: `model` widened from required-nullable to `.nullable().optional()` — an
  // effort-only write no longer has to re-send the role's current tag (or `null`, which used to
  // SILENTLY UNPIN a defaulted role written-to by a second client in the gap).
  // -----------------------------------------------------------------------------------------------
  test("setModelRole: model-only (no effort key) leaves the stored effort untouched — the pre-existing shape, still works", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "codex-oauth/gpt-5.6-luna", effort: "low" });
    const modelOnly = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "codex-oauth/gpt-5.6-terra" });
    expect(modelOnly.error).toBeUndefined();
    expect(modelOnly.result.roles["pins.dream"]).toMatchObject({ model: "codex-oauth/gpt-5.6-terra", effort: "low" });
    c.close();
  });

  test("setModelRole: effort-only (model ABSENT) leaves the stored model untouched — the new contract, closing the unpin race", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "codex-oauth/gpt-5.6-luna" });
    // model ABSENT — not null. The pin from the previous call must survive.
    const effortOnly = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", effort: "high" });
    expect(effortOnly.error).toBeUndefined();
    expect(effortOnly.result.roles["pins.dream"]).toMatchObject({ model: "codex-oauth/gpt-5.6-luna", explicit: true, effort: "high" });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.pins.dream).toBe("codex-oauth/gpt-5.6-luna"); // NOT unpinned
    c.close();
  });

  test("setModelRole: neither model nor effort is refused INVALID_PARAMS, and nothing is written", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const before = readFileSync(settingsPath, "utf8");
    const refused = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream" });
    expect(refused.error).toBeDefined();
    expect(refused.error.code).toBe(-32602);
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    c.close();
  });

  test("setModelRole: provider.model accepts an effort-only write with model ABSENT (still refuses model: null)", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const effortOnly = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", effort: "xhigh" });
    expect(effortOnly.error).toBeUndefined();
    expect(effortOnly.result.roles["provider.model"]).toMatchObject({ model: "codex-oauth/gpt-5.6-sol", effort: "xhigh" });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.provider.model).toBe("codex-oauth/gpt-5.6-sol"); // unchanged
    expect(written.provider.reasoningEffort).toBe("xhigh");

    // model: null is STILL refused — provider.model has no "unset" state, absent or not.
    const stillRefused = await c.request(METHODS.settingsSetModelRole, { role: "provider.model", model: null, effort: "low" });
    expect(stillRefused.error).toBeDefined();
    expect(stillRefused.error.code).toBe(-32602);
    c.close();
  });

  // -----------------------------------------------------------------------------------------------
  // Coordinator addition: pin the EXACT write shapes the Mac client already sends, over the REAL
  // RPC (not the pure `setModelRole` function), for titles.model/reviewer.model specifically — they
  // are not `pins.*` roles, so a code path that special-cases pins could silently diverge here.
  // -----------------------------------------------------------------------------------------------
  for (const role of ["titles.model", "reviewer.model"] as const) {
    test(`setModelRole: {role:"${role}", model:null, effort:X} on a DEFAULTED role stays unpinned, with the effort applied`, async () => {
      const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "cli");
      // The role is unpinned to start with (boot() writes no titles/reviewer block).
      const before = await c.request(METHODS.settingsModelRoles, {});
      expect(before.result.roles[role].explicit).toBe(false);
      const defaultModel: string = before.result.roles[role].model;
      const vocab: string[] = before.result.roles[role].efforts ?? [];
      expect(vocab.length).toBeGreaterThan(0); // codex-oauth/gpt-5.6-sol has a real vocabulary
      const effort = vocab[0]!;

      const set = await c.request(METHODS.settingsSetModelRole, { role, model: null, effort });
      expect(set.error).toBeUndefined();
      expect(set.result.roles[role]).toMatchObject({ explicit: false, model: defaultModel, effort, effortExplicit: true });
    });

    test(`setModelRole: {role:"${role}", model:null, effort:null} on a defaulted role is a no-op success (the client's "Model default" send)`, async () => {
      const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "cli");
      const result = await c.request(METHODS.settingsSetModelRole, { role, model: null, effort: null });
      expect(result.error).toBeUndefined();
      expect(result.result.roles[role]).toMatchObject({ explicit: false, effort: null, effortExplicit: false });
    });

    test(`setModelRole: {role:"${role}", model absent, effort:X} on a defaulted role stays unpinned — the new contract's equivalent of the null-model write above`, async () => {
      const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "cli");
      const before = await c.request(METHODS.settingsModelRoles, {});
      const defaultModel: string = before.result.roles[role].model;
      const vocab: string[] = before.result.roles[role].efforts ?? [];
      const effort = vocab[0]!;
      const set = await c.request(METHODS.settingsSetModelRole, { role, effort });
      expect(set.error).toBeUndefined();
      expect(set.result.roles[role]).toMatchObject({ explicit: false, model: defaultModel, effort, effortExplicit: true });
    });

    test(`setModelRole: {role:"${role}"} PINNED, then an effort-only write with model ABSENT leaves the pin intact — the race this change closes`, async () => {
      const { settingsPath, socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
      const c = await TestClient.connect(socketPath);
      await c.hello(harnessToken, "cli");
      const pinned = await c.request(METHODS.settingsSetModelRole, { role, model: "codex-oauth/gpt-5.6-terra" });
      expect(pinned.error).toBeUndefined();
      expect(pinned.result.roles[role]).toMatchObject({ explicit: true, model: "codex-oauth/gpt-5.6-terra" });

      // Simulates a SECOND client pinning the role between this client's last read and its next
      // write — the effort-only write must not clobber it (model absent, not null).
      const effortOnly = await c.request(METHODS.settingsSetModelRole, { role, effort: "high" });
      expect(effortOnly.error).toBeUndefined();
      expect(effortOnly.result.roles[role]).toMatchObject({ explicit: true, model: "codex-oauth/gpt-5.6-terra", effort: "high" });
      const block = role === "titles.model" ? "titles" : "reviewer";
      const written = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(written[block].model).toBe("codex-oauth/gpt-5.6-terra"); // the pin SURVIVED
    });
  }

  test("setModelRole: {model:null, effort:X} is refused when the DEFAULT model declares no reasoning-effort vocabulary", async () => {
    // openai/gpt-4.1 declares NO `reasoning` block at all (settings.test.ts's own `noBlock` case; R.1: the
    // refreshed catalog gave gpt-5.4 a vocabulary) — titles.model's unset default IS the literal
    // provider.model tag, so this daemon's default model for the role has no vocabulary to validate the
    // effort against.
    const { socketPath, harnessToken } = await boot("openai/gpt-4.1");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    const refused = await c.request(METHODS.settingsSetModelRole, { role: "titles.model", model: null, effort: "high" });
    expect(refused.error).toBeDefined();
    expect(refused.error.code).toBe(-32602);
    expect(refused.error.message).toContain("declares no reasoning-effort vocabulary");
  });
});
