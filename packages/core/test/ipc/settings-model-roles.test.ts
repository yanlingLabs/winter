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

  async function boot(providerModel = "codex-oauth/gpt-5.6-sol") {
    const home = mkdtempSync(join(tmpdir(), "winter-model-roles-"));
    const settingsPath = join(home, "settings.json");
    saveSettings(settingsPath, Settings.parse({ schemaVersion: 3, provider: { model: providerModel } }));
    const store = new SessionStore(home);
    const socketPath = join(home, "core.sock");
    const secrets = new FileSecretStore(join(home, "secrets"));
    const authority = new TokenAuthority(secrets);
    const tokens = await authority.ensureTokens();
    const server = startIpcServer({ socketPath, serverVersion: "test", tokens: authority, store, winterHome: home, secrets });
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

  test("every pin slot writes and clears", async () => {
    const { settingsPath, socketPath, harnessToken } = await boot();
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    for (const [role, slot] of [
      ["pins.dispatch", "dispatch"], ["pins.dream", "dream"], ["pins.cleaner", "cleaner"],
      ["pins.research", "research"], ["pins.researchFallback", "researchFallback"],
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

  // An "unroutable for that role" tag is REPORTED, not schema-refused: `internalModelFor`'s own
  // design is to accept the write (any real catalog tag is a valid model) and skip the run/log one
  // line when the pin's provider disagrees with the daemon's own internal Provider — so `pins.dream`
  // etc. accept a tag naming a DIFFERENT provider than `ownProviderFor(settings)`, and the choice
  // this item's brief asks to state is: the read (`settings.modelRoles`) is where that mismatch
  // becomes visible — `permitted` never lists that provider's tags for an "internal-provider" role
  // whose own provider does not match, so the UI can flag it, even though the WRITE itself succeeds.
  test("an unroutable-for-that-role tag is accepted by the write (internalModelFor's own runtime gate, not a schema refusal) and reported as not permitted by the read", async () => {
    const { socketPath, harnessToken } = await boot("codex-oauth/gpt-5.6-sol");
    const c = await TestClient.connect(socketPath);
    await c.hello(harnessToken, "cli");
    // anthropic is a real catalog provider but NOT the daemon's own internal provider
    // (ownProviderFor === "codex-oauth" here) and not in INTERNAL_PROVIDER_IDS either way.
    const set = await c.request(METHODS.settingsSetModelRole, { role: "pins.dream", model: "anthropic/claude-opus-5" });
    expect(set.error).toBeUndefined();
    expect(set.result.model).toBe("anthropic/claude-opus-5");
    // But `permitted` for pins.dream (an "internal-provider" role) never lists anthropic — only
    // whatever ownProviderFor(settings) resolves to, when that provider is internal at all.
    const permittedProviderIds = set.result.roles["pins.dream"].permitted.map((p: any) => p.providerId);
    expect(permittedProviderIds).not.toContain("anthropic");
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
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner", "pins.research", "pins.researchFallback"] as const) {
      const providerIds = result.result.roles[role].permitted.map((p: any) => p.providerId);
      expect(providerIds).toEqual(["codex-oauth"]); // the BOUND backend — never settings' "openai"
    }
    // "any"-constraint roles are unaffected — they never narrow to a single provider.
    expect(result.result.roles["provider.model"].permitted.length).toBeGreaterThan(1);
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
    //   `openai/gpt-5.4`        — no `reasoning` block at all
    //   `agnes/agnes-2.0-flash` — a `reasoning` block with `efforts: []`
    for (const model of ["openai/gpt-5.4", "agnes/agnes-2.0-flash"]) {
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
});
