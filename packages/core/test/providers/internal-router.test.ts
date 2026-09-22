/**
 * 2026-09-19: the internal-jobs router — Winter's own background calls (titles, the bash reviewer, the
 * dreamer, the session cleaner) no longer depend on `settings.provider.model`'s provider being one of
 * codex-oauth/openai.
 *
 * Every credential here goes through a throwaway `FileSecretStore` and every wire call through a
 * loopback conformance fake — never the real Keychain and never the network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexFake, openaiChatFake, openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial, clearCredentialMaterial } from "../../src/auth/credential-material";
import { createInternalProviderView, staticInternalProviderView, REFRESH_SOON_MIN_MS } from "../../src/providers/internal-view";
import { createInternalRouter, staticInternalRouter, isInternalRefusal, type InternalRouter } from "../../src/providers/internal-router";
import { internalWireEffortFor } from "../../src/providers/internal-provider";
import type { Provider } from "../../src/providers/types";
import { internalEligibleProviderIds, CLAUDE_FIRST_PARTY_PROVIDER_IDS, Settings, setModelRole } from "../../src/settings";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";

function secretsStore(): FileSecretStore {
  return new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-internal-router-secrets-")));
}

function settingsWith(model: string, extra: Record<string, unknown> = {}): Settings {
  return Settings.parse({ schemaVersion: 3, provider: { model }, ...extra });
}

async function routerFor(
  secrets: FileSecretStore,
  opts: { testBackendUrl?: (id: string) => string | undefined; log?: (m: string) => void } = {},
): Promise<InternalRouter> {
  const view = createInternalProviderView({ secrets, ...(opts.log ? { log: opts.log } : { log: () => {} }) });
  await view.refresh();
  return createInternalRouter({ view, secrets, ...(opts.testBackendUrl ? { testBackendUrl: opts.testBackendUrl } : {}) });
}

describe("the eligible set", () => {
  test("excludes every first-party Claude provider and includes ordinary token-priced ones", () => {
    const eligible = internalEligibleProviderIds();
    for (const id of CLAUDE_FIRST_PARTY_PROVIDER_IDS) expect(eligible.has(id)).toBe(false);
    expect(eligible.has("codex-oauth")).toBe(true);
    expect(eligible.has("openai")).toBe(true);
    expect(eligible.has("deepseek")).toBe(true);
  });

  test("excludes the adapter families the daemon cannot drive", () => {
    const eligible = internalEligibleProviderIds();
    // Their credential material is `aws`/`gcp-*`, which `credential-store.ts` refuses typed.
    expect(eligible.has("bedrock")).toBe(false);
    expect(eligible.has("vertex")).toBe(false);
    // No Winter login door and no inventory slot.
    expect(eligible.has("xai-oauth")).toBe(false);
  });
});

describe("a DeepSeek default with only a DeepSeek key", () => {
  test("the titler really calls the DeepSeek adapter on the user's own default model", async () => {
    const fake = await openaiChatFake.startOpenAiChatFake({
      scenarios: { "deepseek-v4-flash": () => openaiChatFake.chatStream({ text: ["Fix Login Flow"], finishReason: "stop", usage: { prompt: 9, completion: 3 } }) },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
      const router = await routerFor(secrets, { testBackendUrl: (id) => (id === "deepseek" ? fake.url : undefined) });
      const settings = settingsWith("deepseek/deepseek-v4-flash");

      const call = router.resolve("titles.model", settings);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) return;
      expect(call.providerId).toBe("deepseek");
      expect(String(call.tag)).toBe("deepseek/deepseek-v4-flash");
      expect(call.model).toBe("deepseek-v4-flash");

      const home = mkdtempSync(join(tmpdir(), "winter-internal-router-home-"));
      const store = new SessionStore(home);
      const hub = new SessionHub(store);
      const titler = new SessionTitler({
        provider: { provider: call.provider, model: call.model },
        store, hub,
      });
      const sessionId = store.createSession("global", { cwd: "/tmp" });
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "how do I fix the login flow?", clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "I fixed it." });

      await titler.maybeTitle(sessionId);

      expect(store.getTitle(sessionId)).toBe("Fix Login Flow");
      expect(fake.requests.length).toBe(1);
      expect(openaiChatFake.chatModelOf(fake.requests[0]!)).toBe("deepseek-v4-flash");
    } finally {
      await fake.close();
    }
  });

  test("every internal role resolves, and the dreamer's `medium` default is dropped rather than refused", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("deepseek/deepseek-v4-flash");
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"] as const) {
      const call = router.resolve(role, settings);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) continue;
      expect(call.providerId).toBe("deepseek");
    }
    // The deepseek row's vocabulary is [none, low, high, max]: `medium` (the dreamer's constant) is not
    // in it and the row declares no default, so the request must carry NO effort. Sending it verbatim
    // is what the pinned runtime refuses `capability` for.
    const dream = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(dream)).toBe(false);
    if (!isInternalRefusal(dream)) expect(dream.effort).toBeUndefined();
    // `low` IS in that vocabulary, so the cleaner's constant survives.
    const cleaner = router.resolve("pins.cleaner", settings);
    if (!isInternalRefusal(cleaner)) expect(cleaner.effort).toBe("low");
  });
});

describe("a DeepSeek default with a Codex OAuth login", () => {
  test("the jobs fall back to codex-oauth on its own terra row", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at", refreshToken: "rt" });
    const router = await routerFor(secrets);
    const call = router.resolve("titles.model", settingsWith("deepseek/deepseek-v4-flash"));
    expect(isInternalRefusal(call)).toBe(false);
    if (isInternalRefusal(call)) return;
    expect(call.providerId).toBe("codex-oauth");
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-terra");
  });
});

describe("a Claude default", () => {
  test("falls back to the credentialed internal provider and never to Claude", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    // An anthropic key is stored too — it must never be chosen.
    await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant" });
    const router = await routerFor(secrets);
    const claudeDefault = settingsWith("anthropic/claude-fable-1");
    for (const role of ["titles.model", "pins.dream"] as const) {
      const call = router.resolve(role, claudeDefault);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) continue;
      expect(CLAUDE_FIRST_PARTY_PROVIDER_IDS).not.toContain(call.providerId);
      expect(call.providerId).toBe("codex-oauth");
    }
  });

  test("an EXPLICIT Claude pin refuses provider-unsupported, naming the provider", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", { titles: { model: "anthropic/claude-fable-1" } });
    const call = router.resolve("titles.model", settings);
    expect(isInternalRefusal(call)).toBe(true);
    if (!isInternalRefusal(call)) return;
    expect(call.reason).toBe("provider-unsupported");
    expect(call.detail).toContain("can't be used for Winter's own jobs yet");
    expect(String(call.tag)).toBe("anthropic/claude-fable-1");
  });
});

describe("roles split across two credentialed providers", () => {
  test("titles on one, the dreamer on the other, each on its own backend", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", {
      titles: { model: "openai/gpt-5.6-luna" },
      pins: { dream: "codex-oauth/gpt-5.6-terra" },
    });
    const titles = router.resolve("titles.model", settings);
    const dream = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(titles) || isInternalRefusal(dream)).toBe(false);
    if (isInternalRefusal(titles) || isInternalRefusal(dream)) return;
    expect(titles.providerId).toBe("openai");
    expect(dream.providerId).toBe("codex-oauth");
    expect(titles.provider).not.toBe(dream.provider);
  });
});

describe("no internal credential at all", () => {
  test("every internal role reports no-internal-credential and nothing throws", async () => {
    const secrets = secretsStore();
    const router = await routerFor(secrets);
    const settings = settingsWith("deepseek/deepseek-v4-flash");
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"] as const) {
      const call = router.resolve(role, settings);
      expect(isInternalRefusal(call)).toBe(true);
      if (!isInternalRefusal(call)) continue;
      expect(call.reason).toBe("no-internal-credential");
      expect(call.detail).toContain("ChatGPT");
      expect(call.tag).toBeNull();
    }
    expect(router.effectiveTag("titles.model", settings)).toBeNull();
  });

  test("an explicit pin on an eligible provider with no key reports no-credential", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", { pins: { dream: "deepseek/deepseek-v4-flash" } });
    const call = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(call)).toBe(true);
    if (!isInternalRefusal(call)) return;
    expect(call.reason).toBe("no-credential");
    expect(String(call.tag)).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("hot transitions", () => {
  test("storing a credential makes the jobs runnable on the next call, with no restart", async () => {
    const secrets = secretsStore();
    const lines: string[] = [];
    const view = createInternalProviderView({ secrets, log: (m) => lines.push(m) });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-v4-flash");

    expect(isInternalRefusal(router.resolve("titles.model", settings))).toBe(true);
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await view.refresh();
    const after = router.resolve("titles.model", settings);
    expect(isInternalRefusal(after)).toBe(false);
    if (!isInternalRefusal(after)) expect(after.providerId).toBe("deepseek");
    // One line for the change, never one per call.
    expect(lines.filter((l) => l.includes("DeepSeek") || l.includes("deepseek")).length).toBe(1);
  });

  test("removing the last credential makes them inert again cleanly, one line per change", async () => {
    const secrets = secretsStore();
    const lines: string[] = [];
    const view = createInternalProviderView({ secrets, log: (m) => lines.push(m) });
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-v4-flash");
    expect(isInternalRefusal(router.resolve("pins.dream", settings))).toBe(false);

    await clearCredentialMaterial(secrets, "deepseek:default");
    await view.refresh();
    for (let i = 0; i < 3; i += 1) {
      const call = router.resolve("pins.dream", settings);
      expect(isInternalRefusal(call)).toBe(true);
      if (isInternalRefusal(call)) expect(call.reason).toBe("no-internal-credential");
    }
    // Two state changes total: absent -> present, present -> absent. Never one per `resolve`.
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("are inert until one is stored");
    // A refresh that changes nothing says nothing.
    await view.refresh();
    expect(lines.length).toBe(2);
  });

  test("changing provider.model moves a defaulted role on the next call", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const first = router.resolve("titles.model", settingsWith("deepseek/deepseek-v4-flash"));
    const second = router.resolve("titles.model", settingsWith("openai/gpt-5.6-luna"));
    if (!isInternalRefusal(first)) expect(first.providerId).toBe("deepseek");
    if (!isInternalRefusal(second)) expect(second.providerId).toBe("openai");
    // `openai`'s terra row, not the user's luna default: the family slot wins when the provider has one.
    if (!isInternalRefusal(second)) expect(String(second.tag)).toBe("openai/gpt-5.6-terra");
  });

  test("changing a role pin moves that role alone on the next call", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const base = settingsWith("deepseek/deepseek-v4-flash");
    const pinned = setModelRole(base, "pins.dream", "openai/gpt-5.6-terra");
    const dream = router.resolve("pins.dream", pinned);
    const titles = router.resolve("titles.model", pinned);
    if (!isInternalRefusal(dream)) expect(dream.providerId).toBe("openai");
    if (!isInternalRefusal(titles)) expect(titles.providerId).toBe("deepseek");
  });

  test("a providers.<id>.baseUrl change rebuilds that provider's instance", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const a = router.resolve("titles.model", settingsWith("deepseek/deepseek-v4-flash"));
    const b = router.resolve("titles.model", settingsWith("deepseek/deepseek-v4-flash"));
    const c = router.resolve("titles.model", settingsWith("deepseek/deepseek-v4-flash", { providers: { deepseek: { baseUrl: "https://proxy.example/v1" } } }));
    if (isInternalRefusal(a) || isInternalRefusal(b) || isInternalRefusal(c)) throw new Error("expected three live calls");
    expect(a.provider).toBe(b.provider); // cached across identical reads
    expect(c.provider).not.toBe(a.provider); // rebuilt on the override
  });

  test("a credential write bumps the generation, so a cached instance is never reused across it", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-1" });
    const view = createInternalProviderView({ secrets, log: () => {} });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-v4-flash");
    const before = router.resolve("titles.model", settings);
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-2" });
    await view.refresh();
    const after = router.resolve("titles.model", settings);
    if (isInternalRefusal(before) || isInternalRefusal(after)) throw new Error("expected two live calls");
    expect(view.generation()).toBe(2);
    expect(after.provider).not.toBe(before.provider);
  });
});

describe("codex-oauth and openai still work over their own loopback fakes", () => {
  test("codex-oauth", async () => {
    const fake = await codexFake.startCodexFake({
      scenarios: { "gpt-5.6-terra": [openaiResponsesFake.responsesStream({ text: ["Codex Title"] })] },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
      const router = await routerFor(secrets, { testBackendUrl: (id) => (id === "codex-oauth" ? fake.url : undefined) });
      const call = router.resolve("titles.model", settingsWith("codex-oauth/gpt-5.6-terra"));
      if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason} ${call.detail}`);
      const out: string[] = [];
      for await (const ev of call.provider.streamTurn({ model: call.model, instructions: "t", input: [{ type: "message", role: "user", content: "hi" }], tools: [], ...(call.effort ? { reasoningEffort: call.effort } : {}) })) {
        if (ev.type === "text_delta") out.push(ev.delta);
        if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
      }
      expect(out.join("")).toBe("Codex Title");
    } finally {
      await fake.close();
    }
  });

  test("openai", async () => {
    const model = "gpt-5.6-terra";
    const fake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: { [model]: [openaiResponsesFake.responsesStream({ text: ["OpenAI Title"] })] },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
      const router = await routerFor(secrets, { testBackendUrl: (id) => (id === "openai" ? fake.url : undefined) });
      const call = router.resolve("titles.model", settingsWith(`openai/${model}`));
      if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason} ${call.detail}`);
      const out: string[] = [];
      for await (const ev of call.provider.streamTurn({ model: call.model, instructions: "t", input: [{ type: "message", role: "user", content: "hi" }], tools: [], ...(call.effort ? { reasoningEffort: call.effort } : {}) })) {
        if (ev.type === "text_delta") out.push(ev.delta);
        if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
      }
      expect(out.join("")).toBe("OpenAI Title");
    } finally {
      await fake.close();
    }
  });
});

describe("a user-entered providers.<id>.baseUrl", () => {
  test("keeps Winter's historically unrestricted BYO-endpoint behaviour — a loopback override streams", async () => {
    const model = "gpt-5.6-terra";
    const fake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: { [model]: [openaiResponsesFake.responsesStream({ text: ["Local Title"] })] },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
      // NO `testBackendUrl`: the loopback url arrives the way a real user's does, through settings.
      const router = await routerFor(secrets);
      const call = router.resolve("titles.model", settingsWith(`openai/${model}`, { providers: { openai: { baseUrl: fake.url } } }));
      if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason} ${call.detail}`);
      const out: string[] = [];
      for await (const ev of call.provider.streamTurn({ model: call.model, instructions: "t", input: [{ type: "message", role: "user", content: "hi" }], tools: [] })) {
        if (ev.type === "text_delta") out.push(ev.delta);
        if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
      }
      expect(out.join("")).toBe("Local Title");
      expect(fake.requests.length).toBe(1);
    } finally {
      await fake.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2026-09-19 review fixes: B-1 (self-heal), M-1 (effort "none"), M-2 (per-provider quota),
// M-3 (no-default-model).
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("B-1: the snapshot self-heals from an out-of-band credential write", () => {
  test("`winter login`'s in-process codex write is picked up without a restart", async () => {
    const secrets = secretsStore();
    let clock = 1_000_000;
    const view = createInternalProviderView({ secrets, log: () => {}, now: () => clock });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-v4-flash");

    // Inert, and the refusal asked for a background probe.
    expect(isInternalRefusal(router.resolve("titles.model", settings))).toBe(true);
    await Bun.sleep(30); // let that first probe settle — `refreshSoon` coalesces while one is in flight
    // …the CLI writes the material itself, exactly as `winter login` does.
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    clock += REFRESH_SOON_MIN_MS + 1; // past the self-heal floor
    router.resolve("titles.model", settings); // fires the probe
    await Bun.sleep(30);
    const healed = router.resolve("titles.model", settings);
    expect(isInternalRefusal(healed)).toBe(false);
    if (!isInternalRefusal(healed)) expect(healed.providerId).toBe("codex-oauth");
  });

  test("`winter logout`'s in-process clear is picked up too — the jobs go inert, not credential-rejected", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const view = createInternalProviderView({ secrets, log: () => {} });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("codex-oauth/gpt-5.6-sol");
    expect(isInternalRefusal(router.resolve("pins.dream", settings))).toBe(false);

    await clearCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth);
    // STATED HONESTLY: the router cannot self-heal from THIS direction on its own. A stale-but-present
    // snapshot makes `resolve()` SUCCEED, so no refusal fires and nothing asks for a probe — the call
    // then fails at the provider as an `auth` error. That is exactly why the logout direction has two
    // other carriers, and both are exercised: the CLI pokes `credential.list` after its in-process clear
    // (`test/ipc/credentials-rpc.test.ts`), and the dreamer asks for a re-probe once per tick AND on any
    // `auth`-classified failure (`test/agent/dreamer-cycle.test.ts`). Either one lands here:
    await view.refresh();
    const after = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(after)).toBe(true);
    if (isInternalRefusal(after)) expect(after.reason).toBe("no-internal-credential");
  });

  test("the self-heal is rate-limited — a hot loop of refusals is not a Keychain probe per call", async () => {
    const secrets = secretsStore();
    let clock = 1_000_000;
    // Counted at the STORE, which is what a probe actually costs — `refreshSoon` closes over the
    // view's own `refresh`, so wrapping the view object could not observe it.
    let reads = 0;
    const counting = { get: (n: string) => { reads += 1; return secrets.get(n); }, set: (n: string, v: string) => secrets.set(n, v), delete: (n: string) => secrets.delete(n) };
    const view = createInternalProviderView({ secrets: counting, log: () => {}, now: () => clock });
    await view.refresh();
    const perProbe = reads;
    expect(perProbe).toBeGreaterThan(0);
    const router = createInternalRouter({ view, secrets: counting });
    const settings = settingsWith("deepseek/deepseek-v4-flash");
    for (let i = 0; i < 50; i += 1) router.resolve("titles.model", settings);
    await Bun.sleep(40);
    // ONE probe for 50 refused calls, not 50.
    expect(reads).toBe(perProbe * 2);
    // …and a second window admits exactly one more.
    clock += REFRESH_SOON_MIN_MS + 1;
    for (let i = 0; i < 50; i += 1) router.resolve("titles.model", settings);
    await Bun.sleep(40);
    expect(reads).toBe(perProbe * 3);
  });

  test("an EXPLICIT pin on an uncredentialed provider does NOT probe (nothing else writes that slot)", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    let reads = 0;
    const counting = { get: (n: string) => { reads += 1; return secrets.get(n); }, set: (n: string, v: string) => secrets.set(n, v), delete: (n: string) => secrets.delete(n) };
    const view = createInternalProviderView({ secrets: counting, log: () => {} });
    await view.refresh();
    const afterSeed = reads;
    const router = createInternalRouter({ view, secrets: counting });
    const pinned = settingsWith("codex-oauth/gpt-5.6-sol", { pins: { dream: "deepseek/deepseek-v4-flash" } });
    const call = router.resolve("pins.dream", pinned);
    await Bun.sleep(40);
    expect(isInternalRefusal(call)).toBe(true);
    if (isInternalRefusal(call)) expect(call.reason).toBe("no-credential");
    expect(reads).toBe(afterSeed); // no probe at all
  });
});

describe("M-1 / D2 follow-up (2026-09-22): an explicit effort of `none`", () => {
  test("is never turned into the row's defaultEffort — it maps to the row's OWN LOWEST declared tier instead", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    // `codex-oauth/gpt-5.6-terra`'s vocabulary is [low, medium, high, xhigh, max] — no `"none"`, so
    // `implicitEffortFor` would MISS and fall through to the row's defaultEffort, `"medium"` — an
    // ESCALATION past what a role asking for `"none"` (for speed) wanted. The rule sends the row's
    // lowest declared tier ("low") instead: less reasoning than the escalation, never more, and never
    // a tier this row does not itself declare.
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", { roleEfforts: { "pins.dream": "none" } });
    const call = router.resolve("pins.dream", settings);
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBe("low");
    expect(call.effort).not.toBe("medium");
  });

  test("a row whose vocabulary already lists \"none\" keeps today's drop — its adapter wire handling of \"none\" is unmeasured, out of scope here", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    // `deepseek/deepseek-v4-flash`'s vocabulary is [none, low, high, max] — `"none"` IS one of its own
    // declared tiers (27 rows in the pinned catalog carry it this way), but the controller's ruling
    // scoped the fix to rows that DON'T declare `"none"`: this case is deliberately UNCHANGED.
    const settings = settingsWith("deepseek/deepseek-v4-flash", { roleEfforts: { "pins.dream": "none" } });
    const call = router.resolve("pins.dream", settings);
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBeUndefined();
  });

  test("the dist case, verbatim: codex-oauth/gpt-5.6-luna with role effort \"none\" sends its lowest declared effort", () => {
    // Direct unit coverage of `internalWireEffortFor` itself, against the REAL pinned catalog row the
    // dist log's cleaner timeout ran on (`[cleaner] judgment failed ... judgment timed out`,
    // `pins.cleaner` pinned to `codex-oauth/gpt-5.6-luna`, `roleEfforts: {"pins.cleaner": "none"}`).
    expect(internalWireEffortFor("codex-oauth/gpt-5.6-luna", "none")).toBe("low");
  });

  test("the dist case through the router: pins.cleaner on gpt-5.6-luna with effort \"none\" resolves to \"low\", never \"medium\"", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", {
      pins: { cleaner: "codex-oauth/gpt-5.6-luna" },
      roleEfforts: { "pins.cleaner": "none" },
    });
    const call = router.resolve("pins.cleaner", settings);
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.tag).toBe("codex-oauth/gpt-5.6-luna" as never);
    expect(call.effort).toBe("low");
    expect(call.effort).not.toBe("medium");
  });

  test("a row with NO declared vocabulary at all still sends nothing", () => {
    const view = staticInternalProviderView(["codex-oauth"]);
    const fake: Provider = { id: "fake", models: () => [], streamTurn: () => (async function* () {})() };
    // `openai/gpt-4o` carries no `reasoning` block at all — nothing to pick a "lowest" tier from.
    const router = staticInternalRouter({ view, provider: fake, model: "gpt-4o", tag: "openai/gpt-4o" as never });
    const call = router.resolve("pins.dream", settingsWith("openai/gpt-4o", { roleEfforts: { "pins.dream": "none" } }));
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBeUndefined();
  });

  test("a stored tier the row DOES list still survives", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const call = router.resolve("pins.dream", settingsWith("codex-oauth/gpt-5.6-sol", { roleEfforts: { "pins.dream": "high" } }));
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBe("high");
  });

  test("the static test double runs the SAME effort rule production does", () => {
    const view = staticInternalProviderView(["codex-oauth"]);
    const fake: Provider = { id: "fake", models: () => [], streamTurn: () => (async function* () {})() };
    const router = staticInternalRouter({ view, provider: fake, model: "gpt-5.6-terra", tag: "codex-oauth/gpt-5.6-terra" as never });
    const none = router.resolve("pins.dream", settingsWith("codex-oauth/gpt-5.6-sol", { roleEfforts: { "pins.dream": "none" } }));
    if (isInternalRefusal(none)) throw new Error("expected a live call");
    expect(none.effort).toBe("low"); // gpt-5.6-terra's own lowest declared tier, not the provider's "medium" default
    // …and the dreamer's own unmappable constant ("medium", not in this row's vocabulary at all) is
    // still dropped on a deepseek row here — unaffected by the `"none"` rule above, since "medium" is
    // never `"none"`.
    const ds = staticInternalRouter({ view, provider: fake, model: "deepseek-v4-flash", tag: "deepseek/deepseek-v4-flash" as never });
    const dream = ds.resolve("pins.dream", settingsWith("deepseek/deepseek-v4-flash"));
    if (isInternalRefusal(dream)) throw new Error("expected a live call");
    expect(dream.effort).toBeUndefined();
  });
});

describe("M-2: one quota ledger per provider", () => {
  test("a Codex usage-limit 429 cannot stall a healthy DeepSeek role", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", {
      titles: { model: "codex-oauth/gpt-5.6-terra" },
      pins: { dream: "deepseek/deepseek-v4-flash" },
    });
    const codex = router.resolve("titles.model", settings);
    const deepseek = router.resolve("pins.dream", settings);
    if (isInternalRefusal(codex) || isInternalRefusal(deepseek)) throw new Error("expected two live calls");
    expect(codex.quota).not.toBe(deepseek.quota);
    const codexLedger = router.quotaFor("codex-oauth");
    const deepseekLedger = router.quotaFor("deepseek");
    expect(codexLedger).toBeDefined();
    expect(deepseekLedger).toBeDefined();
    // An hour-scale rate limit on the codex ledger leaves the deepseek one untouched. Before the split
    // this single `limitedUntil` stalled BOTH roles for the full hour.
    codexLedger!.noteRateLimit(3_600_000);
    expect(codexLedger!.state().kind).toBe("limited");
    expect(deepseekLedger!.state().kind).toBe("ok");
  });

  test("daemon.status still reads the codex-oauth ledger for a codex user", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", { pins: { dream: "deepseek/deepseek-v4-flash" } });
    router.resolve("pins.dream", settings);   // deepseek's ledger exists FIRST
    router.resolve("titles.model", settings); // then codex's
    const codexLedger = router.quotaFor("codex-oauth");
    expect(codexLedger).toBeDefined();
    expect(router.quota).toBe(codexLedger!);
  });
});

describe("M-3: Winter never guesses a model on a provider the user did not choose", () => {
  test("a credentialed provider with no family slot and no session-default claim reports no-default-model", async () => {
    const secrets = secretsStore();
    // `groq` is eligible and credentialed, declares no terra slot, and is NOT provider.model's provider.
    await writeCredentialMaterial(secrets, "groq:default", { kind: "api-key", key: "sk-groq" });
    const router = await routerFor(secrets);
    // A Claude default: rung 1 fails (not eligible), rung 2 fails (no codex/openai key), rung 3 names
    // Groq so the refusal can point at it — but never invents a model on it.
    const call = router.resolve("titles.model", settingsWith("anthropic/claude-fable-1"));
    expect(isInternalRefusal(call)).toBe(true);
    if (!isInternalRefusal(call)) return;
    expect(call.reason).toBe("no-default-model");
    expect(call.detail).toBe("pick a model for this job in Settings › Roles — Winter won't choose one on Groq for you");
    expect(call.tag).toBeNull();
  });

  test("a credentialed OWN provider with no slot still uses the user's own model (the DeepSeek case)", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const call = router.resolve("titles.model", settingsWith("deepseek/deepseek-v4-flash"));
    if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason}`);
    expect(String(call.tag)).toBe("deepseek/deepseek-v4-flash");
  });

  test("the fallback only ever considers codex-oauth/openai — never an alphabetical third party", async () => {
    const secrets = secretsStore();
    // `agentrouter` sorts before `codex-oauth` in inventory order and was what the retired rung picked.
    await writeCredentialMaterial(secrets, "agentrouter:default", { kind: "api-key", key: "sk-ar" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const call = router.resolve("pins.cleaner", settingsWith("anthropic/claude-fable-1"));
    if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason}`);
    expect(call.providerId).toBe("openai");
    expect(String(call.tag)).toBe("openai/gpt-5.6-terra");
  });

  test("no-default-model when a third-party key is the ONLY one and it IS the session default's sibling", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "groq:default", { kind: "api-key", key: "sk-groq" });
    const router = await routerFor(secrets);
    // groq IS provider.model's provider here, so rung 2 of the DEFAULT rule applies: the user's own tag.
    const own = router.resolve("titles.model", settingsWith("groq/llama-3.3-70b-versatile"));
    if (isInternalRefusal(own)) throw new Error(`refused: ${own.reason}`);
    expect(String(own.tag)).toBe("groq/llama-3.3-70b-versatile");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// USER RULING 2026-09-19: `reviewer.model` is a SAFETY gate, so an unrunnable EXPLICIT pin must not
// switch it off — it runs on the answer an unpinned reviewer would get. The other three internal
// roles keep "a refused pin is inert with a note": spending a credential on a provider the user did
// not choose for titles/dreams/cleanup is worse than not running it.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the reviewer's pin fallback", () => {
  async function codexHome(pin: string) {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    return { router, settings: settingsWith("codex-oauth/gpt-5.6-sol", { reviewer: { model: pin } }) };
  }

  test("pinned to an UNCREDENTIALED provider: reviews on the codex default, carrying the pin's own issue", async () => {
    const { router, settings } = await codexHome("deepseek/deepseek-v4-flash");
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    expect(isInternalRefusal(call)).toBe(false);
    if (isInternalRefusal(call)) return;
    expect(call.providerId).toBe("codex-oauth");
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-terra");
    // The pin's issue rides along so the wire can still report it.
    expect(call.pinRefusal?.reason).toBe("no-credential");
    expect(call.pinRefusal?.detail).toBe("no credential is stored for DeepSeek");
    expect(String(call.pinRefusal?.tag)).toBe("deepseek/deepseek-v4-flash");
  });

  test("pinned to anthropic/*: same — reviews on the default, pin reported as provider-unsupported", async () => {
    const { router, settings } = await codexHome("anthropic/claude-opus-5");
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    expect(isInternalRefusal(call)).toBe(false);
    if (isInternalRefusal(call)) return;
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-terra");
    expect(call.pinRefusal?.reason).toBe("provider-unsupported");
    expect(call.pinRefusal?.detail).toBe("Anthropic can't be used for Winter's own jobs yet");
  });

  test("a RUNNABLE pin is untouched — no fallback, no pinRefusal", async () => {
    const { router, settings } = await codexHome("codex-oauth/gpt-5.6-luna");
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-luna");
    expect(call.pinRefusal).toBeUndefined();
  });

  test("no fallback available: the structural refusal stands (this is the hook's allow() path)", async () => {
    const secrets = secretsStore();
    const router = await routerFor(secrets); // nothing credentialed at all
    const settings = settingsWith("deepseek/deepseek-v4-flash", { reviewer: { model: "anthropic/claude-opus-5" } });
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    expect(isInternalRefusal(call)).toBe(true);
    if (isInternalRefusal(call)) expect(call.reason).toBe("no-internal-credential");
  });

  test("THE ASYMMETRY: titles/dreamer/cleaner never fall back, even when asked the same way", async () => {
    const { router, settings } = await codexHome("deepseek/deepseek-v4-flash");
    const pinnedEverywhere = { ...settings, titles: { model: "deepseek/deepseek-v4-flash" as never }, pins: { dream: "deepseek/deepseek-v4-flash" as never, cleaner: "deepseek/deepseek-v4-flash" as never } };
    for (const role of ["titles.model", "pins.dream", "pins.cleaner"] as const) {
      // Even WITH the option set — nothing passes it for these roles, and it would change nothing if it did,
      // because the option is only consulted for a refusal and these stay refused by design.
      const call = router.resolve(role, pinnedEverywhere, { fallbackToDefault: true });
      expect(isInternalRefusal(call)).toBe(true);
      if (isInternalRefusal(call)) expect(call.reason).toBe("no-credential");
    }
  });
});
