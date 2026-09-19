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
import { createInternalProviderView } from "../../src/providers/internal-view";
import { createInternalRouter, isInternalRefusal, type InternalRouter } from "../../src/providers/internal-router";
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
